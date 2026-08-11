import { sha256Json } from "../core/crypto";
import { createOpaqueToken } from "../core/ids";
import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import { loadCredentialById } from "./credentials";
import { createPayOSObjectSignature, PayOSClient } from "./payos";
import { normalizeReconciliation } from "./store";
import { processPayOSWebhook } from "./webhooks";

type ReconcileAttempt = {
  credentialId: string;
  id: string;
  integrationId: string;
  providerOrderCode: number;
  shopId: string;
  webhookPublicId: string;
};

export type PayOSReconciliationAttempt = Pick<ReconcileAttempt, "credentialId" | "id" | "integrationId" | "providerOrderCode" | "shopId" | "webhookPublicId">;

export type PayOSReconciliationResult = {
  payloadHash: string;
  result: Awaited<ReturnType<typeof processPayOSWebhook>>;
};

/**
 * Reconcile one already-authorized attempt through the same signed response
 * and webhook state machine used by the scheduled worker.
 */
export async function reconcilePayOSAttemptWithProvider(input: {
  env: AppBindings;
  attempt: PayOSReconciliationAttempt;
  fetcher?: typeof fetch;
}): Promise<PayOSReconciliationResult> {
  const credential = await loadCredentialById(input.env, input.attempt.credentialId, input.attempt.shopId);
  const providerStatus = await new PayOSClient(credential.credentials, input.fetcher).getPaymentLink(input.attempt.providerOrderCode);
  if (providerStatus.orderCode !== input.attempt.providerOrderCode) throw new AppError("provider_identity_mismatch", 409);
  const normalized = normalizeReconciliation(providerStatus);
  const data: Record<string, unknown> = {
    amount: normalized.amount,
    code: normalized.success ? "00" : normalized.providerStatus,
    currency: normalized.currency,
    description: normalized.description,
    orderCode: normalized.orderCode,
    paymentLinkId: normalized.paymentLinkId,
    reference: normalized.reference,
    transactionDateTime: normalized.occurredAt,
  };
  const payloadHash = await sha256Json(data);
  const result = await processPayOSWebhook({
    body: {
      code: "00",
      data,
      signature: await createPayOSObjectSignature(data, credential.credentials.checksumKey),
      success: normalized.success,
    },
    env: input.env,
    webhookPublicId: input.attempt.webhookPublicId,
  });
  return { payloadHash, result };
}

export async function reconcilePendingPayments(env: AppBindings, now = new Date()): Promise<{ failed: number; processed: number }> {
  const nowIso = now.toISOString();
  const due = await env.PLATFORM_DB.prepare(`SELECT payment_attempts.id, payment_attempts.shop_id AS shopId, payment_attempts.integration_id AS integrationId, payment_attempts.credential_id AS credentialId, payment_attempts.provider_order_code AS providerOrderCode, payment_integrations.webhook_public_id AS webhookPublicId FROM payment_attempts INNER JOIN payment_integrations ON payment_integrations.id = payment_attempts.integration_id AND payment_integrations.shop_id = payment_attempts.shop_id WHERE payment_attempts.state IN ('creating', 'pending', 'error') AND payment_attempts.next_reconcile_at IS NOT NULL AND payment_attempts.next_reconcile_at <= ? AND (payment_attempts.lease_expires_at IS NULL OR payment_attempts.lease_expires_at <= ?) ORDER BY payment_attempts.next_reconcile_at, payment_attempts.id LIMIT 25`).bind(nowIso, nowIso).all<ReconcileAttempt>();
  let processed = 0;
  let failed = 0;
  for (const attempt of due.results) {
    const leaseToken = createOpaqueToken(18);
    const leaseExpiresAt = new Date(now.getTime() + 60_000).toISOString();
    const claimed = await env.PLATFORM_DB.prepare("UPDATE payment_attempts SET lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND state IN ('creating', 'pending', 'error') AND next_reconcile_at IS NOT NULL AND next_reconcile_at <= ? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)").bind(leaseToken, leaseExpiresAt, nowIso, attempt.id, attempt.shopId, nowIso, nowIso).run();
    if (claimed.meta.changes !== 1) continue;
    try {
      await reconcilePayOSAttemptWithProvider({ env, attempt });
      await env.PLATFORM_DB.prepare("UPDATE payment_attempts SET last_reconciled_at = ?, next_reconcile_at = CASE WHEN state = 'pending' THEN ? ELSE NULL END, reconcile_attempts = reconcile_attempts + 1, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND shop_id = ? AND lease_token = ?").bind(nowIso, new Date(now.getTime() + 5 * 60_000).toISOString(), nowIso, attempt.id, attempt.shopId, leaseToken).run();
      processed += 1;
    } catch {
      const row = await env.PLATFORM_DB.prepare("SELECT reconcile_attempts AS attempts FROM payment_attempts WHERE id = ? AND shop_id = ? LIMIT 1").bind(attempt.id, attempt.shopId).first<{ attempts: number }>();
      const attempts = (row?.attempts ?? 0) + 1;
      const jitter = crypto.getRandomValues(new Uint16Array(1))[0] ?? 0;
      const delaySeconds = Math.min(3_600, 30 * 2 ** Math.min(attempts, 7)) + jitter % 30;
      await env.PLATFORM_DB.prepare("UPDATE payment_attempts SET state = CASE WHEN state = 'creating' THEN 'error' ELSE state END, reconcile_attempts = ?, next_reconcile_at = ?, lease_token = NULL, lease_expires_at = NULL, last_safe_error_code = 'provider_reconcile_failed', updated_at = ? WHERE id = ? AND shop_id = ? AND lease_token = ?").bind(attempts, new Date(now.getTime() + delaySeconds * 1_000).toISOString(), nowIso, attempt.id, attempt.shopId, leaseToken).run();
      failed += 1;
    }
  }
  await env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'revoked', revoked_at = ? WHERE status = 'grace' AND grace_ends_at <= ?").bind(nowIso, nowIso).run();
  return { failed, processed };
}

export type PaymentExceptionView = {
  createdAt: string;
  currency: string;
  id: string;
  orderId: string;
  orderPublicId: string | null;
  paymentAttemptId: string;
  safeEvidenceJson: string;
  status: string;
  type: string;
};

/**
 * Keep the seller ledger limited to evidence fields that are safe to explain
 * operationally. Provider references and payload fields are intentionally
 * ignored even when they appear in the stored JSON.
 */
export type PaymentExceptionEvidence = {
  expectedAmount: number | null;
  expectedKeys: number | null;
  occurredAt: string | null;
  receivedAmount: number | null;
  reservedKeys: number | null;
};

function safeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeOccurredAt(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 64
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(value)
    || Number.isNaN(Date.parse(value))
  ) return null;
  return value;
}

export function parsePaymentExceptionEvidence(value: string): PaymentExceptionEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    parsed = null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { expectedAmount: null, expectedKeys: null, occurredAt: null, receivedAmount: null, reservedKeys: null };
  }
  const evidence = parsed as Record<string, unknown>;
  return {
    expectedAmount: safeNonNegativeInteger(evidence.expectedAmount),
    expectedKeys: safeNonNegativeInteger(evidence.expectedKeys),
    occurredAt: safeOccurredAt(evidence.occurredAt),
    receivedAmount: safeNonNegativeInteger(evidence.amount),
    reservedKeys: safeNonNegativeInteger(evidence.reservedKeys),
  };
}

export async function listPaymentExceptions(input: { env: AppBindings; shopId: string }): Promise<PaymentExceptionView[]> {
  const result = await input.env.PLATFORM_DB.prepare(`SELECT payment_exceptions.id, payment_exceptions.type, payment_exceptions.status, payment_exceptions.safe_evidence_json AS safeEvidenceJson, payment_exceptions.created_at AS createdAt, payment_attempts.currency, orders.public_id AS orderId, orders.public_id AS orderPublicId, payment_attempts.public_id AS paymentAttemptId FROM payment_exceptions INNER JOIN orders ON orders.id = payment_exceptions.order_id AND orders.shop_id = payment_exceptions.shop_id INNER JOIN payment_attempts ON payment_attempts.id = payment_exceptions.payment_attempt_id AND payment_attempts.shop_id = payment_exceptions.shop_id WHERE payment_exceptions.shop_id = ? ORDER BY payment_exceptions.created_at DESC, payment_exceptions.id DESC LIMIT 100`).bind(input.shopId).all<PaymentExceptionView>();
  return result.results;
}
