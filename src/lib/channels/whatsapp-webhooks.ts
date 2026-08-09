import { AppError } from "../core/errors";
import { subscriptionAllows } from "../billing/entitlements";
import { toBase64Url } from "../core/ids";
import { readBoundedBytes } from "../http/request";
import type { AppBindings } from "../platform/bindings";
import type { ProviderReceiptStore } from "./ingress";
import { D1ProviderReceiptStore } from "./provider-event-receipts";
import { assertExpansionProviderPending } from "./expansion";
import { normalizeProviderEvent, verifyProviderWebhook, getProviderRuntimeContract } from "./provider-contracts";
import { verifyWhatsAppWebhookChallenge } from "./provider-routes";
import { decryptWhatsAppCloudCredential, type WhatsAppCloudCredential } from "./whatsapp-credentials";

const PROVIDER_CODE = "whatsapp.cloud";
const SAFE_PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$/u;
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
// These WABA-level subscriptions do not carry phone metadata. Every other
// change must prove the configured phone number before it can be claimed.
const WABA_LEVEL_FIELDS = new Set([
  "account_update",
  "business_capability_update",
  "message_template_quality_update",
  "message_template_status_update",
]);
const encoder = new TextEncoder();

/**
 * WhatsApp is contract-only until provider execution is reviewed and enabled.
 * Keep this guard before every context lookup so pending ingress cannot cause
 * credential decryption, provider verification, or durable receipt writes.
 */
export function assertWhatsAppIngressAdmitted(): void {
  assertExpansionProviderPending(PROVIDER_CODE);
}

type WhatsAppCredentialRow = {
  connectionId: string;
  credentialEnvelopeCiphertextB64: string;
  credentialEnvelopeIvB64: string;
  credentialFingerprint: string;
  credentialId: string;
  keyVersion: string;
  shopId: string;
};

type WhatsAppCredentialContextRow = WhatsAppCredentialRow & {
  credentialStatus: string | null;
  connectionPublicId: string;
  providerCode: string;
  subscriptionState: string;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
};

export type WhatsAppWebhookContext = WhatsAppCredentialRow & WhatsAppCloudCredential & {
  connectionPublicId: string;
  providerCode: typeof PROVIDER_CODE;
};

export type WhatsAppWebhookResult = {
  action: string;
  eventId: string;
  result: "accepted" | "conflict" | "replay";
};

function invalid(issue: string): never {
  throw new AppError("channel_webhook_invalid", 400, [issue]);
}

function publicId(value: string): string {
  if (!SAFE_PUBLIC_ID.test(value)) throw new AppError("webhook_not_found", 404);
  return value;
}

function decodeObject(rawBody: Uint8Array): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    invalid("whatsapp_payload_invalid");
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("whatsapp_payload_invalid");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid("whatsapp_payload_invalid");
  }
}

function safeProviderId(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !SAFE_EVENT_ID.test(value)) return null;
  return value;
}

async function payloadDigest(rawBody: Uint8Array): Promise<string> {
  const owned = new Uint8Array(rawBody.byteLength);
  owned.set(rawBody);
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", owned.buffer)));
}

/** @internal Pure parser retained for provider-contract regression tests. */
export async function extractWhatsAppEventDescriptor(
  rawBody: Uint8Array,
  expectedBusinessAccountId: string,
  expectedPhoneNumberId: string,
): Promise<{ action: string; eventId: string }> {
  const payload = decodeObject(rawBody);
  if (payload.object !== "whatsapp_business_account" || !Array.isArray(payload.entry) || payload.entry.length === 0) {
    invalid("whatsapp_payload_invalid");
  }
  const ids: string[] = [];
  let hasMessage = false;
  let hasStatus = false;
  for (const rawEntry of payload.entry) {
    if (typeof rawEntry !== "object" || rawEntry === null || Array.isArray(rawEntry)) invalid("whatsapp_payload_invalid");
    const entry = rawEntry as Record<string, unknown>;
    const entryId = safeProviderId(entry.id);
    if (entryId === null) invalid("whatsapp_business_account_id_missing");
    if (entryId !== expectedBusinessAccountId) throw new AppError("channel_tenant_mismatch", 403);
    const changes = entry.changes;
    if (!Array.isArray(changes) || changes.length === 0) invalid("whatsapp_changes_missing");
    for (const rawChange of changes) {
      if (typeof rawChange !== "object" || rawChange === null || Array.isArray(rawChange)) invalid("whatsapp_payload_invalid");
      const change = rawChange as Record<string, unknown>;
      const field = change.field;
      if (typeof field !== "string" || field.length === 0 || field.length > 128 || !SAFE_EVENT_ID.test(field)) {
        invalid("whatsapp_field_invalid");
      }
      const value = change.value;
      if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("whatsapp_payload_invalid");
      const record = value as Record<string, unknown>;
      const rawMessages = record.messages;
      const rawStatuses = record.statuses;
      if (rawMessages !== undefined && !Array.isArray(rawMessages)) invalid("whatsapp_messages_invalid");
      if (rawStatuses !== undefined && !Array.isArray(rawStatuses)) invalid("whatsapp_statuses_invalid");
      const messages = rawMessages === undefined ? null : rawMessages;
      const statuses = rawStatuses === undefined ? null : rawStatuses;
      const hasMessages = messages !== null;
      const hasStatuses = statuses !== null;
      const metadata = record.metadata;
      if (metadata === undefined) {
        if (hasMessages || hasStatuses || !WABA_LEVEL_FIELDS.has(field)) invalid("whatsapp_phone_number_metadata_missing");
      } else {
        if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
          invalid("whatsapp_phone_number_metadata_invalid");
        }
        const phoneNumberId = safeProviderId((metadata as Record<string, unknown>).phone_number_id);
        if (phoneNumberId === null) invalid("whatsapp_phone_number_id_missing");
        if (phoneNumberId !== expectedPhoneNumberId) throw new AppError("channel_tenant_mismatch", 403);
      }
      if (hasMessages) {
        hasMessage = true;
        for (const rawMessage of messages) {
          if (typeof rawMessage === "object" && rawMessage !== null && !Array.isArray(rawMessage)) {
            const id = safeProviderId((rawMessage as Record<string, unknown>).id);
            if (id !== null) ids.push(id);
          }
        }
      }
      if (hasStatuses) {
        hasStatus = true;
        for (const rawStatus of statuses) {
          if (typeof rawStatus === "object" && rawStatus !== null && !Array.isArray(rawStatus)) {
            const id = safeProviderId((rawStatus as Record<string, unknown>).id);
            if (id !== null) ids.push(id);
          }
        }
      }
    }
  }
  const digest = await payloadDigest(rawBody);
  const uniqueIds = [...new Set(ids)].sort();
  let eventId: string;
  if (uniqueIds.length === 1 && SAFE_EVENT_ID.test(uniqueIds[0] ?? "")) {
    const providerEventId = uniqueIds[0] ?? `batch_${digest}`;
    // Meta uses the message id as the status reference too. Keep a status
    // delivery distinct from the original message receipt or the durable
    // ledger would incorrectly classify the normal lifecycle update as a
    // changed-payload conflict.
    eventId = hasStatus && !hasMessage ? `status:${providerEventId}` : providerEventId;
  } else if (uniqueIds.length > 1) {
    const batchDigest = await crypto.subtle.digest("SHA-256", encoder.encode(uniqueIds.join("\0")));
    eventId = `batch_${toBase64Url(new Uint8Array(batchDigest))}`;
  } else {
    eventId = `batch_${digest}`;
  }
  return { action: hasMessage ? "message.received" : hasStatus ? "message.status" : "event.received", eventId };
}

export async function loadWhatsAppWebhookContext(env: AppBindings, connectionPublicId: string): Promise<WhatsAppWebhookContext> {
  assertWhatsAppIngressAdmitted();
  const publicIdValue = publicId(connectionPublicId);
  const row = await env.PLATFORM_DB.prepare(`
    SELECT
      connection.id AS connectionId,
      connection.public_id AS connectionPublicId,
      connection.shop_id AS shopId,
      connection.provider_code AS providerCode,
      credential.id AS credentialId,
      credential.key_version AS keyVersion,
      credential.credential_envelope_ciphertext_b64 AS credentialEnvelopeCiphertextB64,
      credential.credential_envelope_iv_b64 AS credentialEnvelopeIvB64,
      credential.credential_fingerprint AS credentialFingerprint,
      credential.status AS credentialStatus,
      subscription.state AS subscriptionState,
      subscription.trial_ends_at AS trialEndsAt,
      subscription.grace_ends_at AS graceEndsAt
    FROM channel_connections AS connection
    INNER JOIN shop_channels AS shopChannel
      ON shopChannel.shop_id = connection.shop_id
      AND shopChannel.id = connection.shop_channel_id
      AND shopChannel.channel_code = ?
      AND shopChannel.status = 'enabled'
    INNER JOIN shops
      ON shops.id = connection.shop_id
      AND shops.status = 'active'
    INNER JOIN shop_subscriptions AS subscription
      ON subscription.shop_id = connection.shop_id
    LEFT JOIN channel_credentials AS credential
      ON credential.shop_id = connection.shop_id
      AND credential.connection_id = connection.id
      AND credential.provider_code = connection.provider_code
      AND credential.status = 'active'
    WHERE connection.public_id = ?
      AND connection.provider_code = ?
      AND connection.status IN ('active', 'degraded')
    LIMIT 1
  `).bind(PROVIDER_CODE, publicIdValue, PROVIDER_CODE).first<WhatsAppCredentialContextRow>();
  if (row === null || row.providerCode !== PROVIDER_CODE) throw new AppError("webhook_not_found", 404);
  if (!subscriptionAllows({ graceEndsAt: row.graceEndsAt, subscriptionState: row.subscriptionState, trialEndsAt: row.trialEndsAt })) {
    throw new AppError("channel_connection_unavailable", 409);
  }
  if (row.credentialStatus !== "active") throw new AppError("channel_credential_unavailable", 503);
  const credential = await decryptWhatsAppCloudCredential({ env, row });
  return Object.freeze({ ...row, ...credential, providerCode: PROVIDER_CODE });
}

export async function processWhatsAppWebhook(input: {
  env: AppBindings;
  connectionPublicId: string;
  now?: Date;
  receiptStore?: ProviderReceiptStore;
  request: Request;
}): Promise<WhatsAppWebhookResult> {
  assertWhatsAppIngressAdmitted();
  const context = await loadWhatsAppWebhookContext(input.env, input.connectionPublicId);
  const rawBody = await readBoundedBytes(input.request, getProviderRuntimeContract(PROVIDER_CODE).maxInboundBodyBytes);
  await verifyProviderWebhook({
    code: PROVIDER_CODE,
    credentialSecret: context.appSecret,
    rawBody,
    signature: input.request.headers.get("X-Hub-Signature-256"),
  });
  const descriptor = await extractWhatsAppEventDescriptor(rawBody, context.businessAccountId, context.phoneNumberId);
  const event = await normalizeProviderEvent({
    action: descriptor.action,
    connectionId: context.connectionId,
    eventId: descriptor.eventId,
    providerCode: PROVIDER_CODE,
    rawBody,
    shopId: context.shopId,
    ...(input.now === undefined ? {} : { receivedAt: input.now }),
  });
  const claim = await (input.receiptStore ?? new D1ProviderReceiptStore(input.env.PLATFORM_DB)).claim(event);
  if (claim.result === "conflict") {
    throw new AppError("channel_provider_event_conflict", 409);
  }
  return { action: event.action, eventId: event.eventId, result: claim.result };
}

export async function verifyWhatsAppChallengeRequest(input: {
  env: AppBindings;
  connectionPublicId: string;
  request: Request;
}): Promise<string> {
  assertWhatsAppIngressAdmitted();
  const context = await loadWhatsAppWebhookContext(input.env, input.connectionPublicId);
  const query = new URL(input.request.url).searchParams;
  const single = (name: string): string | null => {
    const values = query.getAll(name);
    return values.length === 1 ? values[0] ?? null : null;
  };
  return verifyWhatsAppWebhookChallenge({
    challenge: single("hub.challenge"),
    expectedToken: context.verifyToken,
    mode: single("hub.mode"),
    providedToken: single("hub.verify_token"),
  });
}
