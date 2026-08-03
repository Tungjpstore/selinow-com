import { AppError } from "../core/errors";
import { subscriptionAllows } from "../billing/entitlements";
import { constantTimeEqual } from "../core/crypto";
import { readBoundedBytes } from "../http/request";
import type { AppBindings } from "../platform/bindings";
import { decryptDiscordBotCredential } from "./discord-credentials";
import { D1ProviderReceiptStore } from "./provider-event-receipts";
import type { ProviderReceiptClaim, ProviderReceiptStore } from "./ingress";
import {
  getProviderRuntimeContract,
  normalizeProviderEvent,
  verifyProviderWebhook,
} from "./provider-contracts";
import { parseDiscordInteraction } from "./provider-routes";

const PROVIDER_CODE = "discord.bot" as const;
const SAFE_PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$/u;
const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/iu;

type DiscordConnectionRow = {
  channelStatus: "disabled" | "enabled" | "pending";
  connectionId: string;
  connectionPublicId: string;
  externalAccountId: string | null;
  connectionStatus: "active" | "degraded" | "disconnected" | "pending";
  credentialEnvelopeCiphertextB64: string | null;
  credentialEnvelopeIvB64: string | null;
  credentialFingerprint: string | null;
  credentialId: string | null;
  credentialStatus: "active" | "error" | "grace" | "pending" | "revoked" | null;
  keyVersion: string | null;
  providerCode: string;
  shopId: string;
  subscriptionState: string;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
};

export type DiscordWebhookContext = DiscordConnectionRow & {
  externalAccountId: string;
  publicKeyHex: string;
  providerCode: typeof PROVIDER_CODE;
};

export type DiscordPublicKeyResolver = (input: {
  connectionId: string;
  connectionPublicId: string;
  credentialEnvelopeCiphertextB64: string;
  credentialEnvelopeIvB64: string;
  credentialFingerprint: string;
  credentialId: string;
  env: AppBindings;
  keyVersion: string;
  providerCode: typeof PROVIDER_CODE;
  shopId: string;
}) => Promise<string>;

export type DiscordWebhookResult = {
  eventId: string | null;
  interactionType: number;
  result: "accepted" | "conflict" | "ping" | "replay";
};

function requirePublicId(value: string): string {
  if (!SAFE_PUBLIC_ID.test(value)) throw new AppError("webhook_not_found", 404);
  return value;
}

function requirePublicKey(value: unknown): string {
  if (typeof value !== "string" || !PUBLIC_KEY_HEX.test(value)) {
    throw new AppError("channel_credential_unavailable", 503);
  }
  return value.toLowerCase();
}

async function resolveDiscordPublicKey(input: Parameters<DiscordPublicKeyResolver>[0]): Promise<string> {
  try {
    const credential = await decryptDiscordBotCredential({
      env: input.env,
      row: {
        connectionId: input.connectionId,
        credentialEnvelopeCiphertextB64: input.credentialEnvelopeCiphertextB64,
        credentialEnvelopeIvB64: input.credentialEnvelopeIvB64,
        credentialFingerprint: input.credentialFingerprint,
        credentialId: input.credentialId,
        keyVersion: input.keyVersion,
        shopId: input.shopId,
      },
    });
    return credential.publicKeyHex;
  } catch {
    throw new AppError("channel_credential_unavailable", 503);
  }
}

export async function loadDiscordWebhookContext(
  env: AppBindings,
  connectionPublicId: string,
  resolvePublicKey: DiscordPublicKeyResolver = resolveDiscordPublicKey,
): Promise<DiscordWebhookContext> {
  const publicId = requirePublicId(connectionPublicId);
  const row = await env.PLATFORM_DB.prepare(`
    SELECT
      connection.id AS connectionId,
      connection.public_id AS connectionPublicId,
      connection.shop_id AS shopId,
      connection.provider_code AS providerCode,
      connection.status AS connectionStatus,
      connection.external_account_id AS externalAccountId,
      shopChannel.status AS channelStatus,
      credential.id AS credentialId,
      credential.key_version AS keyVersion,
      credential.credential_envelope_ciphertext_b64 AS credentialEnvelopeCiphertextB64,
      credential.credential_envelope_iv_b64 AS credentialEnvelopeIvB64,
      credential.credential_fingerprint AS credentialFingerprint,
      credential.status AS credentialStatus
      ,subscription.state AS subscriptionState
      ,subscription.trial_ends_at AS trialEndsAt
      ,subscription.grace_ends_at AS graceEndsAt
    FROM channel_connections AS connection
    INNER JOIN shop_channels AS shopChannel
      ON shopChannel.shop_id = connection.shop_id
      AND shopChannel.id = connection.shop_channel_id
      AND shopChannel.channel_code = ?
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
  `).bind(PROVIDER_CODE, publicId, PROVIDER_CODE).first<DiscordConnectionRow>();

  if (row === null || row.providerCode !== PROVIDER_CODE
    || row.connectionStatus !== "active" && row.connectionStatus !== "degraded"
    || row.channelStatus !== "enabled") {
    throw new AppError("webhook_not_found", 404);
  }
  if (!subscriptionAllows({ graceEndsAt: row.graceEndsAt, subscriptionState: row.subscriptionState, trialEndsAt: row.trialEndsAt })) {
    throw new AppError("channel_connection_unavailable", 409);
  }
  const externalAccountId = row.externalAccountId;
  if (externalAccountId === null) {
    throw new AppError("channel_provider_identity_unverified", 409);
  }
  if (row.credentialStatus !== "active") {
    throw new AppError("channel_credential_unavailable", 503);
  }
  if (row.credentialId === null || row.keyVersion === null || row.credentialEnvelopeCiphertextB64 === null
    || row.credentialEnvelopeIvB64 === null || row.credentialFingerprint === null) {
    throw new AppError("channel_credential_unavailable", 503);
  }
  const publicKeyHex = requirePublicKey(await resolvePublicKey({
    connectionId: row.connectionId,
    connectionPublicId: row.connectionPublicId,
    credentialEnvelopeCiphertextB64: row.credentialEnvelopeCiphertextB64,
    credentialEnvelopeIvB64: row.credentialEnvelopeIvB64,
    credentialFingerprint: row.credentialFingerprint,
    credentialId: row.credentialId,
    env,
    keyVersion: row.keyVersion,
    providerCode: PROVIDER_CODE,
    shopId: row.shopId,
  }));
  return Object.freeze({ ...row, externalAccountId, publicKeyHex, providerCode: PROVIDER_CODE });
}

export async function processDiscordWebhook(input: {
  env: AppBindings;
  connectionPublicId: string;
  now?: Date;
  publicKeyResolver?: DiscordPublicKeyResolver;
  receiptStore?: ProviderReceiptStore;
  request: Request;
}): Promise<DiscordWebhookResult> {
  const context = await loadDiscordWebhookContext(
    input.env,
    input.connectionPublicId,
    input.publicKeyResolver ?? resolveDiscordPublicKey,
  );
  const contract = getProviderRuntimeContract(PROVIDER_CODE);
  const rawBody = await readBoundedBytes(input.request, contract.maxInboundBodyBytes);
  await verifyProviderWebhook({
    code: PROVIDER_CODE,
    publicKeyHex: context.publicKeyHex,
    rawBody,
    signature: input.request.headers.get("X-Signature-Ed25519"),
    timestamp: input.request.headers.get("X-Signature-Timestamp"),
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  const envelope = parseDiscordInteraction(rawBody);
  if (envelope.applicationId !== null && !constantTimeEqual(envelope.applicationId, context.externalAccountId)) {
    throw new AppError("channel_tenant_mismatch", 403);
  }
  if (envelope.kind === "ping") {
    return { eventId: null, interactionType: envelope.type, result: "ping" };
  }
  if (envelope.id === null) {
    throw new AppError("channel_route_invalid", 400, ["discord_id_required"]);
  }

  const event = await normalizeProviderEvent({
    action: "interaction.received",
    connectionId: context.connectionId,
    eventId: envelope.id,
    providerCode: PROVIDER_CODE,
    rawBody,
    shopId: context.shopId,
    ...(input.now === undefined ? {} : { receivedAt: input.now }),
  });
  let claim: ProviderReceiptClaim;
  try {
    claim = await (input.receiptStore ?? new D1ProviderReceiptStore(input.env.PLATFORM_DB)).claim(event);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("channel_provider_event_claim_failed", 500);
  }
  if (claim.result === "conflict") {
    throw new AppError("channel_provider_event_conflict", 409);
  }
  return { eventId: event.eventId, interactionType: envelope.type, result: claim.result };
}
