import { applyCommercePaymentEvent, type CommercePaymentAttempt } from "../commerce/payment-events";
import { applyVerifiedPaymentReversal } from "../commerce/payment-reversal";
import { AppError } from "../core/errors";
import { sha256Json } from "../core/crypto";
import { createId, createOpaqueToken } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { loadCredentialById, loadWebhookCredentials } from "./credentials";
import { decidePayment } from "./decision";
import { verifyPayOSWebhook } from "./payos";

type Attempt = CommercePaymentAttempt & {
  credentialId: string;
  currency: string;
  expectedAmount: number;
  expectedDescription: string;
  expiresAt: string;
  paidEventId: string | null;
  paymentLinkId: string | null;
  providerOrderCode: number;
};

type WebhookEnvelope = { data: Record<string, unknown>; signature: string };

type StoredPaymentEvent = {
  id: string;
  payloadHash: string;
  processedAt: string | null;
  processResult: string;
};

const PAYMENT_EVENT_PROCESSING_TTL_MS = 5 * 60_000;

export type WebhookResult = { duplicate: boolean; processed: boolean; state: string };

function parseWebhook(value: Record<string, unknown>): WebhookEnvelope {
  if (typeof value.signature !== "string" || typeof value.data !== "object" || value.data === null || Array.isArray(value.data)) throw new AppError("webhook_invalid", 400);
  return { data: value.data as Record<string, unknown>, signature: value.signature };
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new AppError("webhook_invalid", 400, [field]);
  return value;
}

function requireString(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) throw new AppError("webhook_invalid", 400, [field]);
  return value;
}

async function findAttempt(env: AppBindings, webhookPublicId: string, orderCode: number): Promise<Attempt | null> {
  return env.PLATFORM_DB.prepare(`SELECT payment_attempts.id, payment_attempts.integration_id AS integrationId, payment_attempts.shop_id AS shopId, payment_attempts.order_id AS orderId, payment_attempts.credential_id AS credentialId, payment_attempts.provider_order_code AS providerOrderCode, payment_attempts.provider_payment_link_id AS paymentLinkId, payment_attempts.paid_event_id AS paidEventId, payment_attempts.state, payment_attempts.expected_amount_minor AS expectedAmount, payment_attempts.currency, payment_attempts.expected_description AS expectedDescription, payment_attempts.expires_at AS expiresAt FROM payment_attempts INNER JOIN payment_integrations ON payment_integrations.id = payment_attempts.integration_id AND payment_integrations.shop_id = payment_attempts.shop_id WHERE payment_integrations.webhook_public_id = ? AND payment_integrations.provider = 'payos' AND payment_attempts.provider_order_code = ? AND payment_attempts.provider = 'payos' LIMIT 1`).bind(webhookPublicId, orderCode).first<Attempt>();
}

type WebhookCredential = Awaited<ReturnType<typeof loadWebhookCredentials>>[number];

async function findVerifyingCredential(
  candidates: readonly WebhookCredential[],
  webhook: WebhookEnvelope,
): Promise<WebhookCredential | null> {
  for (const candidate of candidates) {
    if (await verifyPayOSWebhook(webhook.data, webhook.signature, candidate.credentials.checksumKey)) return candidate;
  }
  return null;
}

async function recordUnmappedEvent(env: AppBindings, integrationId: string, shopId: string, reference: string, payloadHash: string): Promise<{ duplicate: boolean }> {
  const now = new Date().toISOString();
  const inserted = await env.PLATFORM_DB.prepare(`
    INSERT INTO payment_events (
      id, shop_id, payment_attempt_id, integration_id, provider,
      provider_event_reference, payload_hash, signature_verified,
      normalized_state, process_result, received_at, processed_at
    ) VALUES (?, ?, NULL, ?, 'payos', ?, ?, 1, 'identity_mismatch', 'rejected', ?, ?)
    ON CONFLICT(integration_id, provider_event_reference, payload_hash) DO NOTHING
    RETURNING id
  `).bind(createId("pev"), shopId, integrationId, reference, payloadHash, now, now).first<{ id: string }>();
  if (inserted !== null) return { duplicate: false };

  const replay = await env.PLATFORM_DB.prepare(`
    SELECT id FROM payment_events
    WHERE shop_id = ? AND integration_id = ? AND provider = 'payos'
      AND payment_attempt_id IS NULL AND provider_event_reference = ?
      AND payload_hash = ? AND signature_verified = 1
      AND normalized_state = 'identity_mismatch' AND process_result = 'rejected'
    LIMIT 1
  `).bind(shopId, integrationId, reference, payloadHash).first<{ id: string }>();
  if (replay === null) throw new AppError("payment_event_record_failed", 500);
  return { duplicate: true };
}

async function claimPaymentEvent(env: AppBindings, event: Pick<StoredPaymentEvent, "id" | "payloadHash">, integrationId: string): Promise<string | null> {
  const token = createOpaqueToken(18);
  const now = new Date();
  const claimed = await env.PLATFORM_DB.prepare("UPDATE payment_events SET process_result = 'processing', processing_token = ?, processing_started_at = ? WHERE id = ? AND integration_id = ? AND payload_hash = ? AND processed_at IS NULL AND (process_result IN ('received', 'retryable_error') OR (process_result = 'processing' AND processing_started_at <= ?))")
    .bind(token, now.toISOString(), event.id, integrationId, event.payloadHash, new Date(now.getTime() - PAYMENT_EVENT_PROCESSING_TTL_MS).toISOString()).run();
  return claimed.meta.changes === 1 ? token : null;
}

async function releasePaymentEventClaim(env: AppBindings, eventId: string, integrationId: string, token: string): Promise<void> {
  await env.PLATFORM_DB.prepare("UPDATE payment_events SET process_result = 'retryable_error', processing_token = NULL, processing_started_at = NULL WHERE id = ? AND integration_id = ? AND processing_token = ? AND processed_at IS NULL")
    .bind(eventId, integrationId, token).run();
}

async function insertOrLoadPaymentEvent(input: {
  attempt: Attempt;
  env: AppBindings;
  integrationId: string;
  payloadHash: string;
  reference: string;
}): Promise<{ event: StoredPaymentEvent; inserted: boolean; referenceConflict: boolean }> {
  const eventId = createId("pev");
  const inserted = await input.env.PLATFORM_DB.prepare(`INSERT OR IGNORE INTO payment_events (id, shop_id, payment_attempt_id, integration_id, provider, provider_event_reference, payload_hash, signature_verified, normalized_state, process_result, received_at) VALUES (?, ?, ?, ?, 'payos', ?, ?, 1, 'pending', 'received', ?)`).bind(eventId, input.attempt.shopId, input.attempt.id, input.integrationId, input.reference, input.payloadHash, new Date().toISOString()).run();
  const rows = await input.env.PLATFORM_DB.prepare("SELECT id, payload_hash AS payloadHash, process_result AS processResult, processed_at AS processedAt FROM payment_events WHERE integration_id = ? AND provider_event_reference = ? ORDER BY received_at, id").bind(input.integrationId, input.reference).all<StoredPaymentEvent>();
  const event = rows.results.find((row) => row.payloadHash === input.payloadHash);
  if (event === undefined) throw new AppError("payment_event_record_failed", 500);
  return {
    event,
    inserted: inserted.meta.changes === 1,
    referenceConflict: rows.results.some((row) => row.payloadHash !== input.payloadHash),
  };
}

export async function processPayOSWebhook(input: { body: Record<string, unknown>; env: AppBindings; webhookPublicId: string }): Promise<WebhookResult> {
  const webhook = parseWebhook(input.body);
  const orderCode = requireNumber(webhook.data.orderCode, "order_code");
  const amount = requireNumber(webhook.data.amount, "amount");
  const currency = requireString(webhook.data.currency, "currency", 16);
  const description = requireString(webhook.data.description, "description", 128);
  const occurredAt = requireString(webhook.data.transactionDateTime, "transaction_datetime", 64);
  const reference = requireString(webhook.data.reference ?? `${String(orderCode)}:${occurredAt}`, "reference", 256);
  const signedTransactionCode = requireString(webhook.data.code, "transaction_code", 64);
  const reversalKind = webhook.data.reversalKind;
  if (reversalKind !== undefined && reversalKind !== "refund" && reversalKind !== "chargeback") {
    throw new AppError("webhook_invalid", 400, ["reversal_kind"]);
  }
  const payloadHash = await sha256Json(webhook.data);
  const attempt = await findAttempt(input.env, input.webhookPublicId, orderCode);
  if (attempt === null) {
    const credentialCandidates = await loadWebhookCredentials(input.env, input.webhookPublicId);
    if (credentialCandidates.length === 0) throw new AppError("webhook_not_found", 404);
    const verified = await findVerifyingCredential(credentialCandidates, webhook);
    if (verified === null) throw new AppError("webhook_signature_invalid", 401);
    // Keep unmapped webhook handling tenant-scoped; a global order-code lookup
    // would disclose whether another shop has a matching payment attempt.
    const recorded = await recordUnmappedEvent(input.env, verified.row.integrationId, verified.row.shopId, reference, payloadHash);
    return { duplicate: recorded.duplicate, processed: false, state: "validation_probe" };
  }

  let verified: Awaited<ReturnType<typeof loadCredentialById>>;
  try {
    verified = await loadCredentialById(input.env, attempt.credentialId, attempt.shopId);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "payment_not_configured") throw error;
    const credentialCandidates = await loadWebhookCredentials(input.env, input.webhookPublicId);
    const mismatched = await findVerifyingCredential(credentialCandidates, webhook);
    if (mismatched === null) throw new AppError("webhook_signature_invalid", 401);
    await recordUnmappedEvent(input.env, attempt.integrationId, attempt.shopId, `identity:${await sha256Json({ attemptId: attempt.id, reference })}`, payloadHash);
    throw new AppError("webhook_identity_mismatch", 400);
  }
  if (verified.row.integrationId !== attempt.integrationId
    || !await verifyPayOSWebhook(webhook.data, webhook.signature, verified.credentials.checksumKey)) {
    const credentialCandidates = await loadWebhookCredentials(input.env, input.webhookPublicId);
    const mismatched = await findVerifyingCredential(credentialCandidates, webhook);
    if (mismatched === null) throw new AppError("webhook_signature_invalid", 401);
    await recordUnmappedEvent(input.env, attempt.integrationId, attempt.shopId, `identity:${await sha256Json({ attemptId: attempt.id, reference })}`, payloadHash);
    throw new AppError("webhook_identity_mismatch", 400);
  }
  if (reversalKind === "refund" || reversalKind === "chargeback") {
    if (attempt.paidEventId === null) throw new AppError("payment_reversal_not_admissible", 409);
    const reversal = await applyVerifiedPaymentReversal({
      amountMinor: amount,
      credentialId: verified.row.credentialId,
      credentialVersion: verified.row.version,
      currency,
      evidenceHash: payloadHash,
      env: input.env,
      idempotencyKey: `payos-reversal:${payloadHash}`,
      integrationId: attempt.integrationId,
      occurredAt,
      orderId: attempt.orderId,
      originalPaymentEventId: attempt.paidEventId,
      paymentAttemptId: attempt.id,
      provider: "payos",
      providerReference: reference,
      requestId: `payos-reversal:${payloadHash}`,
      reversalKind,
      shopId: attempt.shopId,
      verificationMethod: "signed_webhook",
      verified: true,
    });
    return { duplicate: reversal.duplicate, processed: !reversal.duplicate, state: reversal.decision };
  }
  const stored = await insertOrLoadPaymentEvent({
    attempt,
    env: input.env,
    integrationId: verified.row.integrationId,
    payloadHash,
    reference,
  });
  if (stored.event.processedAt !== null) return { duplicate: !stored.inserted, processed: false, state: attempt.state };
  const eventId = stored.event.id;
  const claimToken = await claimPaymentEvent(input.env, stored.event, verified.row.integrationId);
  if (claimToken === null) return { duplicate: true, processed: false, state: attempt.state };

  try {
    // PayOS signs `data`, so payment state must never depend on outer envelope fields.
    const signedSuccess = signedTransactionCode === "00";
    const decision = stored.referenceConflict ? "inconsistent" : decidePayment({ amount, currency, description, expectedAmount: attempt.expectedAmount, expectedCurrency: attempt.currency, expectedDescription: attempt.expectedDescription, expectedPaymentLinkId: attempt.paymentLinkId, occurredAt, orderCode, paymentLinkId: typeof webhook.data.paymentLinkId === "string" ? webhook.data.paymentLinkId : null, providerOrderCode: attempt.providerOrderCode, providerStatus: signedSuccess ? "PAID" : signedTransactionCode, reservationExpiresAt: attempt.expiresAt, success: signedSuccess });
    const outcome = await applyCommercePaymentEvent({
      attempt,
      claimToken,
      decision,
      env: input.env,
      eventId,
      evidence: { amount, expectedAmount: attempt.expectedAmount, occurredAt, reference, ...(stored.referenceConflict ? { referenceConflict: true } : {}) },
      integrationId: verified.row.integrationId,
    });
    return { duplicate: false, ...outcome };
  } catch (error) {
    try {
      await releasePaymentEventClaim(input.env, eventId, verified.row.integrationId, claimToken);
    } catch {
      // The stale-claim timeout keeps a failed worker recoverable if this cleanup fails.
    }
    throw error;
  }
}
