import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { readBoundedBytes } from "../http/request";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";
import {
  createDodoCheckout,
  cancelDodoSubscription,
  changeDodoSubscription,
  getDodoConfig,
  parseDodoEvent,
  retrieveDodoCheckout,
  retrieveDodoSubscription,
  verifyDodoWebhookSignature,
  type DodoBillingEvent,
} from "./dodo";

export const BILLING_GRACE_PERIOD_MS = 3 * 24 * 60 * 60_000;
export const BILLING_STATES = [
  "pending_payment", "trialing", "active", "past_due", "grace_period", "suspended",
  "cancel_scheduled", "upgrade_pending", "downgrade_scheduled", "canceled",
] as const;
export type BillingState = typeof BILLING_STATES[number];

type BillingCheckoutSession = {
  amountMinor: number;
  currency: string;
  id: string;
  marketCode: "global" | "vn" | null;
  planId: string;
  planCode: string;
  priceId: string;
  providerSubscriptionRef: string | null;
  providerCheckoutRef: string | null;
  priceVersion: number;
  providerPriceRef: string;
  requestHash: string;
  shopId: string;
  status: string;
  subscriptionId: string;
};

type SubscriptionRow = {
  amountMinor: number | null;
  currency: string | null;
  currentPeriodEnd: string | null;
  currentPeriodStart: string | null;
  graceEndsAt: string | null;
  id: string;
  marketCode: "global" | "vn" | null;
  planId: string;
  priceId: string | null;
  priceVersion: number | null;
  providerSubscriptionRef: string | null;
  state: BillingState;
  version: number;
};

type PlanPriceRow = {
  amountMinor: number;
  currency: string;
  id: string;
  marketCode: "global" | "vn";
  planId: string;
  providerCode: "dodo" | "payos";
  providerPriceRef: string;
  version: number;
};

type BillingEventRow = {
  id: string;
  payloadHash: string;
  status: "received" | "processed" | "ignored" | "conflict" | "failed";
};

export type CheckoutResult = {
  amountMinor: number;
  checkoutUrl: string;
  currency: string;
  duplicate: boolean;
  planCode: string;
  provider: "dodo";
  providerTransactionId: string;
  sessionId: string;
  subscriptionState: BillingState;
};

export type WebhookResult = {
  duplicate: boolean;
  processed: boolean;
  state: string;
};

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
  return value;
}

function asString(value: unknown, issue: string, maximum = 128): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || Array.from(value).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) throw new AppError("validation_failed", 400, [issue]);
  return value;
}

function customValue(data: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

async function loadSubscription(env: AppBindings, shopId: string): Promise<SubscriptionRow> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, plan_id AS planId, state, version,
      current_period_start AS currentPeriodStart,
      current_period_end AS currentPeriodEnd,
      grace_ends_at AS graceEndsAt,
      market_code AS marketCode,
      price_currency AS currency,
      price_amount_minor AS amountMinor,
      price_id AS priceId,
      price_version AS priceVersion,
      provider_subscription_ref AS providerSubscriptionRef
    FROM shop_subscriptions
    WHERE shop_id = ? AND state != 'canceled'
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).bind(shopId).first<SubscriptionRow>();
  if (row === null || !BILLING_STATES.includes(row.state)) throw new AppError("subscription_required", 409);
  return row;
}

async function loadPlanPrice(env: AppBindings, input: { currency: string; market: "global" | "vn"; nowIso: string; planCode: string }): Promise<PlanPriceRow> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT prices.id, prices.plan_id AS planId,
      prices.currency, prices.amount_minor AS amountMinor,
      prices.market_code AS marketCode,
      prices.provider_code AS providerCode,
      prices.provider_price_ref AS providerPriceRef,
      prices.version
    FROM plan_prices AS prices
    INNER JOIN plans ON plans.id = prices.plan_id
    WHERE plans.code = ?
      AND plans.is_active = 1
      AND plans.is_public = 1
      AND prices.market_code = ?
      AND prices.currency = ?
      AND prices.interval = 'month'
      AND prices.is_active = 1
      AND prices.effective_from <= ?
      AND (prices.effective_to IS NULL OR prices.effective_to > ?)
    ORDER BY prices.effective_from DESC, prices.version DESC, prices.id DESC
    LIMIT 1
  `).bind(input.planCode, input.market, input.currency.toUpperCase(), input.nowIso, input.nowIso).first<PlanPriceRow>();
  if (row === null || !Number.isSafeInteger(row.amountMinor) || row.amountMinor < 0 || row.providerPriceRef.length === 0) throw new AppError("plan_price_unavailable", 409);
  if (row.providerCode !== "dodo" || row.providerPriceRef.startsWith("pending:")) throw new AppError("provider_not_ready", 503);
  return row;
}

type CheckoutReplayRow = {
  amountMinor: number;
  currency: string;
  id: string;
  marketCode: "global" | "vn";
  planCode: string;
  priceId: string;
  providerCheckoutRef: string | null;
  providerPriceRef: string;
  requestHash: string;
  status: string;
  subscriptionId: string;
  subscriptionState: BillingState;
};

async function saveCheckoutProviderReference(input: {
  env: AppBindings;
  nowIso: string;
  providerCheckoutRef: string;
  sessionId: string;
}): Promise<void> {
  const updated = await input.env.PLATFORM_DB.prepare(`
    UPDATE billing_checkout_sessions
    SET provider_checkout_ref = ?, status = 'open', failure_code = NULL,
      updated_at = ?, version = version + 1
    WHERE id = ? AND status = 'pending' AND provider_checkout_ref IS NULL
  `).bind(input.providerCheckoutRef, input.nowIso, input.sessionId).run();
  if (updated.meta.changes === 1) return;
  const current = await input.env.PLATFORM_DB.prepare(`
    SELECT provider_checkout_ref AS providerCheckoutRef, status
    FROM billing_checkout_sessions
    WHERE id = ?
    LIMIT 1
  `).bind(input.sessionId).first<{ providerCheckoutRef: string | null; status: string }>();
  if (current !== null && current.providerCheckoutRef === input.providerCheckoutRef && ["open", "completed"].includes(current.status)) return;
  throw new AppError("billing_checkout_persistence_conflict", 409);
}

async function loadReplay(input: {
  env: AppBindings;
  fetcher?: typeof fetch;
  config: ReturnType<typeof getDodoConfig>;
  shopId: string;
  idempotencyKey: string;
  keyHash: string;
  nowIso: string;
  requestHash: string;
}): Promise<CheckoutResult | null> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT sessions.id, prices.amount_minor AS amountMinor, prices.currency,
      sessions.status,
      sessions.provider_checkout_ref AS providerCheckoutRef,
      sessions.request_hash AS requestHash,
      sessions.subscription_id AS subscriptionId,
      sessions.price_id AS priceId,
      prices.market_code AS marketCode,
      prices.provider_price_ref AS providerPriceRef,
      plans.code AS planCode, subscriptions.state AS subscriptionState
    FROM billing_checkout_sessions AS sessions
    INNER JOIN plans ON plans.id = sessions.plan_id
    INNER JOIN plan_prices AS prices ON prices.id = sessions.price_id
    INNER JOIN shop_subscriptions AS subscriptions ON subscriptions.id = sessions.subscription_id
    WHERE sessions.shop_id = ? AND sessions.idempotency_key_hash = ?
    LIMIT 1
  `).bind(input.shopId, input.keyHash).first<CheckoutReplayRow>();
  if (row === null) return null;
  if (row.requestHash !== input.requestHash) throw new AppError("idempotency_conflict", 409);
  if (row.status === "expired" || row.status === "failed" || row.status === "canceled") throw new AppError("billing_checkout_replay_unavailable", 409);
  let provider: Awaited<ReturnType<typeof retrieveDodoCheckout>>;
  if (row.status === "pending" && row.providerCheckoutRef === null) {
    const providerIdempotencyKey = await hmacToken(input.env.SESSION_SECRET, "dodo-provider-idempotency:v1", `${input.shopId}:${input.idempotencyKey}`);
    provider = await createDodoCheckout({
      config: input.config,
      currency: row.currency,
      customData: { checkoutSessionId: row.id, planCode: row.planCode, shopId: input.shopId, subscriptionId: row.subscriptionId },
      idempotencyKey: providerIdempotencyKey,
      priceId: row.providerPriceRef,
      ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    });
    await saveCheckoutProviderReference({ env: input.env, nowIso: input.nowIso, providerCheckoutRef: provider.providerTransactionId, sessionId: row.id });
  } else {
    if (row.providerCheckoutRef === null) throw new AppError("billing_checkout_replay_unavailable", 409);
    try {
      provider = await retrieveDodoCheckout({
        config: input.config,
        providerTransactionId: row.providerCheckoutRef,
        ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      });
    } catch (error) {
      if (error instanceof AppError && error.code === "billing_provider_unavailable") throw error;
      throw new AppError("billing_checkout_replay_requires_new_session", 409);
    }
  }
  return {
    amountMinor: row.amountMinor,
    checkoutUrl: provider.checkoutUrl,
    currency: row.currency,
    duplicate: true,
    planCode: row.planCode,
    provider: "dodo",
    providerTransactionId: provider.providerTransactionId,
    sessionId: row.id,
    subscriptionState: row.subscriptionState,
  };
}

export async function createBillingCheckout(input: {
  currency?: unknown;
  env: AppBindings;
  idempotencyKey: string | null;
  market?: unknown;
  planCode: unknown;
  requestId: string;
  recovery?: boolean;
  shopPublicId: string;
  userId: string;
  fetcher?: typeof fetch;
  now?: Date;
}): Promise<CheckoutResult> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const planCode = asString(input.planCode, "plan_code_invalid", 32).toLowerCase();
  if (planCode !== "starter" && planCode !== "pro") throw new AppError("plan_not_found", 404);
  const actor = await getShopForMember({ capability: "billing:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  if (input.currency !== undefined || input.market !== undefined) throw new AppError("validation_failed", 400, ["market_server_selected"]);
  const merchantCountry = actor.row.merchant_country_code?.trim().toUpperCase();
  if (merchantCountry === undefined || merchantCountry.length !== 2) throw new AppError("billing_market_unavailable", 409);
  const market = merchantCountry === "VN" ? "vn" : "global";
  const currency = market === "vn" ? "VND" : "USD";
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "dodo-checkout-idempotency:v1", idempotencyKey);
  const recovery = input.recovery === true;
  const requestHash = await sha256Json({ currency, market, planCode, recovery, shopId: actor.row.shop_id });
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  await suspendExpiredTrials({ env: input.env, now });
  await expireBillingCheckoutSessions({ env: input.env, now, limit: 100 });
  const dodoConfig = getDodoConfig(input.env);
  const replay = await loadReplay({ config: dodoConfig, env: input.env, idempotencyKey, keyHash, nowIso, requestHash, shopId: actor.row.shop_id, ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }) });
  if (replay !== null) return replay;
  const subscription = await loadSubscription(input.env, actor.row.shop_id);
  if (subscription.state !== "trialing" && subscription.state !== "pending_payment" && subscription.state !== "suspended") {
    throw new AppError("billing_change_requires_request", 409);
  }
  if (subscription.state === "suspended" && !recovery) throw new AppError("subscription_payment_required", 409);
  const price = await loadPlanPrice(input.env, { currency, market, nowIso, planCode });
  if (subscription.state === "suspended" && price.planId !== subscription.planId) throw new AppError("billing_recovery_plan_mismatch", 409);
  const sessionId = createId("bchk");

  // A trial conversion is only a pending payment until Dodo sends a signed
  // payment.succeeded event. The return URL is never used for entitlement.
  let checkoutSetup: D1Result[];
  try {
    checkoutSetup = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
      UPDATE shop_subscriptions
      SET state = 'pending_payment', grace_ends_at = NULL, billing_provider_code = 'dodo',
        market_code = ?, price_currency = ?, price_amount_minor = ?, price_interval = 'month',
        price_version = ?, price_id = ?, updated_at = ?, version = version + 1
      WHERE shop_id = ? AND id = ? AND version = ?
      `).bind(market, currency, price.amountMinor, price.version, price.id, nowIso, actor.row.shop_id, subscription.id, subscription.version),
      input.env.PLATFORM_DB.prepare(`
      INSERT INTO billing_checkout_sessions (
        id, public_id, shop_id, subscription_id, plan_id, price_id, provider_code,
        status, idempotency_key_hash, request_hash, expires_at, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 'dodo', 'pending', ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM shop_subscriptions
        WHERE id = ? AND shop_id = ? AND state = 'pending_payment' AND version = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM billing_checkout_sessions
        WHERE shop_id = ? AND subscription_id = ? AND status IN ('pending', 'open')
      )
      `).bind(
        sessionId, sessionId, actor.row.shop_id, subscription.id, price.planId, price.id, keyHash, requestHash,
        new Date(now.getTime() + 30 * 60_000).toISOString(), nowIso, nowIso,
        subscription.id, actor.row.shop_id, subscription.version + 1,
        actor.row.shop_id, subscription.id,
      ),
      // D1 batches commit when a guarded INSERT affects zero rows. Force a
      // constraint failure in that branch so the preceding state update rolls
      // back instead of leaving a pending subscription without a checkout row.
      input.env.PLATFORM_DB.prepare(`
        UPDATE shop_subscriptions SET version = 0
        WHERE id = ? AND changes() = 0
      `).bind(subscription.id),
    ]);
  } catch (error) {
    if (error instanceof Error && /(?:CHECK constraint failed|version > 0)/u.test(error.message)) {
      throw new AppError("billing_subscription_version_conflict", 409);
    }
    throw error;
  }
  if ((checkoutSetup[0]?.meta.changes ?? 0) !== 1 || (checkoutSetup[1]?.meta.changes ?? 0) !== 1) {
    throw new AppError("billing_subscription_version_conflict", 409);
  }

  // The provider may have accepted the idempotent request before the network
  // response was lost. Keep the local session pending on any thrown response
  // so the same key can safely repeat the exact provider call.
  const providerIdempotencyKey = await hmacToken(input.env.SESSION_SECRET, "dodo-provider-idempotency:v1", `${actor.row.shop_id}:${idempotencyKey}`);
  const provider = await createDodoCheckout({
    config: dodoConfig,
    currency,
    customData: { checkoutSessionId: sessionId, planCode, shopId: actor.row.shop_id, subscriptionId: subscription.id },
    idempotencyKey: providerIdempotencyKey,
    priceId: price.providerPriceRef,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
  });
  await saveCheckoutProviderReference({ env: input.env, nowIso, providerCheckoutRef: provider.providerTransactionId, sessionId });
  return { amountMinor: price.amountMinor, checkoutUrl: provider.checkoutUrl, currency, duplicate: false, planCode, provider: "dodo", providerTransactionId: provider.providerTransactionId, sessionId, subscriptionState: "pending_payment" };
}

/** A suspended shop may only re-subscribe through this explicit owner-authenticated path. */
export async function createBillingRecoveryCheckout(input: Omit<Parameters<typeof createBillingCheckout>[0], "recovery">): Promise<CheckoutResult> {
  return createBillingCheckout({ ...input, recovery: true });
}

/** Expire stale provider sessions before they can be replayed or confirmed. */
export async function expireBillingCheckoutSessions(input: { env: AppBindings; now?: Date; limit?: number }): Promise<number> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? Math.min(input.limit ?? 100, 500) : 100;
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, subscription_id AS subscriptionId
    FROM billing_checkout_sessions
    WHERE status IN ('pending', 'open') AND expires_at IS NOT NULL AND expires_at <= ?
    ORDER BY expires_at, id
    LIMIT ?
  `).bind(nowIso, limit).all<{ id: string; shopId: string; subscriptionId: string }>();
  let expired = 0;
  for (const row of rows.results) {
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        UPDATE billing_checkout_sessions
        SET status = 'expired', expired_at = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND shop_id = ? AND status IN ('pending', 'open') AND expires_at <= ?
      `).bind(nowIso, nowIso, row.id, row.shopId, nowIso),
      input.env.PLATFORM_DB.prepare(`
        UPDATE shop_subscriptions
        SET state = 'suspended', grace_ends_at = NULL, updated_at = ?, version = version + 1
        WHERE id = ? AND shop_id = ? AND state = 'pending_payment'
          AND NOT EXISTS (
            SELECT 1 FROM billing_checkout_sessions
            WHERE shop_id = ? AND subscription_id = ? AND status IN ('pending', 'open')
          )
      `).bind(nowIso, row.subscriptionId, row.shopId, row.shopId, row.subscriptionId),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 1) expired += 1;
  }
  return expired;
}

type SubscriptionChangeExecutionRow = {
  action: "cancel" | "change_plan" | "resume";
  id: string;
  providerActionRef: string | null;
  requestedPlanId: string | null;
  status: "canceled" | "completed" | "provider_pending" | "rejected" | "requested";
  subscriptionId: string;
  version: number;
};

type PendingSubscriptionChange = {
  action: "cancel" | "change_plan" | "resume";
  requestedPlanCode: string | null;
  requestedPlanId: string | null;
};

async function loadPendingSubscriptionChange(env: AppBindings, shopId: string, subscriptionId: string): Promise<PendingSubscriptionChange | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT requests.action, requests.requested_plan_id AS requestedPlanId,
      requested_plan.code AS requestedPlanCode
    FROM subscription_change_requests AS requests
    LEFT JOIN plans AS requested_plan ON requested_plan.id = requests.requested_plan_id
    WHERE requests.shop_id = ? AND requests.subscription_id = ?
      AND requests.status = 'provider_pending'
    ORDER BY requests.created_at, requests.id
    LIMIT 1
  `).bind(shopId, subscriptionId).first<PendingSubscriptionChange>();
}

async function loadBillingPriceById(env: AppBindings, priceId: string): Promise<PlanPriceRow> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, plan_id AS planId, currency, amount_minor AS amountMinor,
      market_code AS marketCode, provider_code AS providerCode,
      provider_price_ref AS providerPriceRef, version
    FROM plan_prices
    WHERE id = ? AND provider_code = 'dodo'
    LIMIT 1
  `).bind(priceId).first<PlanPriceRow>();
  if (row === null) throw new AppError("billing_webhook_price_mismatch", 409);
  return row;
}

async function loadBillingPriceByProviderRef(env: AppBindings, providerPriceRef: string): Promise<PlanPriceRow> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, plan_id AS planId, currency, amount_minor AS amountMinor,
      market_code AS marketCode, provider_code AS providerCode,
      provider_price_ref AS providerPriceRef, version
    FROM plan_prices
    WHERE provider_code = 'dodo' AND provider_price_ref = ?
    LIMIT 1
  `).bind(providerPriceRef).first<PlanPriceRow>();
  if (row === null) throw new AppError("billing_webhook_price_mismatch", 409);
  return row;
}

/** Claim a request only after an operator/provider boundary supplied an action reference. */
export async function claimSubscriptionChangeRequest(input: {
  env: AppBindings;
  providerActionRef: string;
  requestPublicId: string;
  reviewedByUserId: string;
  shopId: string;
  now?: Date;
  requestId?: string;
}): Promise<{ duplicate: boolean; providerActionRef: string; requestId: string; status: string; version: number }> {
  const providerActionRef = asString(input.providerActionRef, "provider_action_ref_invalid", 160);
  const nowIso = (input.now ?? new Date()).toISOString();
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT id, action, requested_plan_id AS requestedPlanId, status, subscription_id AS subscriptionId,
      provider_action_ref AS providerActionRef, version
    FROM subscription_change_requests
    WHERE shop_id = ? AND public_id = ?
    LIMIT 1
  `).bind(input.shopId, input.requestPublicId).first<SubscriptionChangeExecutionRow>();
  if (row === null) throw new AppError("subscription_change_request_not_found", 404);
  if (row.status === "provider_pending") {
    if (row.providerActionRef === providerActionRef) return { duplicate: true, providerActionRef, requestId: row.id, status: row.status, version: row.version };
    throw new AppError("billing_change_pending", 409);
  }
  if (row.status !== "requested") {
    return { duplicate: true, providerActionRef, requestId: row.id, status: row.status, version: row.version };
  }
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE subscription_change_requests
      SET status = 'provider_pending', reviewed_by_user_id = ?, reviewed_at = ?,
        provider_action_ref = ?, failure_code = NULL, execution_attempts = execution_attempts + 1,
        last_attempt_at = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND shop_id = ? AND status = 'requested' AND version = ?
    `).bind(input.reviewedByUserId, nowIso, providerActionRef, nowIso, nowIso, row.id, input.shopId, row.version),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, source_kind, retention_class, created_at
      ) VALUES (?, ?, 'platform_admin', ?, 'billing.change_provider_pending', 'subscription_change_request', ?, ?, ?, 'queue', 'financial', ?)
    `).bind(createId("aud"), input.shopId, input.reviewedByUserId, row.id, JSON.stringify({ action: row.action, providerActionRef }), input.requestId ?? `billing-change:${row.id}`, nowIso),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw new AppError("billing_subscription_version_conflict", 409);
  return { duplicate: false, providerActionRef, requestId: row.id, status: "provider_pending", version: row.version + 1 };
}

/**
 * Durable provider boundary for plan/cancel/resume work. Dodo's operation
 * endpoint is intentionally injected: until its tenant-scoped contract is
 * verified, this function fails closed rather than pretending a local update
 * completed a provider mutation.
 */
export async function executeSubscriptionChangeRequest(input: {
  env: AppBindings;
  requestPublicId: string;
  reviewedByUserId: string;
  shopId: string;
  requestId?: string;
  now?: Date;
  providerExecutor?: (context: {
    action: "cancel" | "change_plan" | "resume";
    requestedPlanId: string | null;
    requestId: string;
    shopId: string;
    subscriptionId: string;
  }) => Promise<{ providerActionRef: string }>;
}): Promise<{ providerActionRef: string; requestId: string; status: string; version: number }> {
  if (input.providerExecutor === undefined) throw new AppError("billing_provider_operation_unavailable", 503);
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT id, action, requested_plan_id AS requestedPlanId, status,
      subscription_id AS subscriptionId, provider_action_ref AS providerActionRef, version
    FROM subscription_change_requests
    WHERE shop_id = ? AND public_id = ?
    LIMIT 1
  `).bind(input.shopId, input.requestPublicId).first<SubscriptionChangeExecutionRow>();
  if (row === null) throw new AppError("subscription_change_request_not_found", 404);
  if (row.status === "completed" || row.status === "canceled" || row.status === "rejected") return { providerActionRef: row.providerActionRef ?? "", requestId: row.id, status: row.status, version: row.version };
  const operationRef = `operation:${await hmacToken(input.env.SESSION_SECRET, "dodo-subscription-operation-ref:v1", `${input.shopId}:${row.id}:${row.action}:${row.requestedPlanId ?? ""}`)}`;
  let claimed: { duplicate: boolean; providerActionRef: string; requestId: string; status: string; version: number };
  if (row.status === "provider_pending" && row.providerActionRef === operationRef) {
    claimed = { duplicate: false, providerActionRef: operationRef, requestId: row.id, status: row.status, version: row.version };
  } else {
    claimed = await claimSubscriptionChangeRequest({
      env: input.env,
      providerActionRef: operationRef,
      requestPublicId: row.id,
      reviewedByUserId: input.reviewedByUserId,
      shopId: input.shopId,
      ...(input.now === undefined ? {} : { now: input.now }),
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    });
    if (claimed.duplicate) return claimed;
  }
  try {
    const provider = await input.providerExecutor({ action: row.action, requestedPlanId: row.requestedPlanId, requestId: row.id, shopId: input.shopId, subscriptionId: row.subscriptionId });
    const providerActionRef = asString(provider.providerActionRef, "provider_action_ref_invalid", 160);
    const nowIso = (input.now ?? new Date()).toISOString();
    const updated = await input.env.PLATFORM_DB.prepare(`
      UPDATE subscription_change_requests
      SET provider_action_ref = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND shop_id = ? AND status = 'provider_pending' AND version = ?
    `).bind(providerActionRef, nowIso, row.id, input.shopId, claimed.version).run();
    if (updated.meta.changes !== 1) throw new AppError("billing_subscription_version_conflict", 409);
    return { providerActionRef, requestId: row.id, status: "provider_pending", version: claimed.version + 1 };
  } catch (error) {
    await retrySubscriptionChangeRequest({ env: input.env, failureCode: error instanceof AppError ? error.code : "provider_unavailable", requestPublicId: row.id, shopId: input.shopId, ...(input.now === undefined ? {} : { now: input.now }) }).catch(() => undefined);
    throw error instanceof AppError ? error : new AppError("billing_provider_unavailable", 503);
  }
}

/** Execute a claimed plan/cancel request through the verified Dodo API shape. */
export async function executeDodoSubscriptionChangeRequest(input: {
  env: AppBindings;
  requestPublicId: string;
  reviewedByUserId: string;
  shopId: string;
  requestId?: string;
  fetcher?: typeof fetch;
  now?: Date;
}): Promise<{ providerActionRef: string; requestId: string; status: string; version: number }> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const request = await input.env.PLATFORM_DB.prepare(`
    SELECT requests.id, requests.action, requests.requested_plan_id AS requestedPlanId,
      requests.status, requests.provider_action_ref AS providerActionRef, requests.version,
      subscriptions.id AS subscriptionId, subscriptions.provider_subscription_ref AS providerSubscriptionRef,
      subscriptions.billing_provider_code AS billingProviderCode,
      subscriptions.market_code AS marketCode, subscriptions.price_currency AS currency,
      current_plan.code AS currentPlanCode, requested_plan.code AS requestedPlanCode
    FROM subscription_change_requests AS requests
    INNER JOIN shop_subscriptions AS subscriptions
      ON subscriptions.shop_id = requests.shop_id AND subscriptions.id = requests.subscription_id
    INNER JOIN plans AS current_plan ON current_plan.id = requests.current_plan_id
    LEFT JOIN plans AS requested_plan ON requested_plan.id = requests.requested_plan_id
    WHERE requests.shop_id = ? AND requests.public_id = ?
    LIMIT 1
  `).bind(input.shopId, input.requestPublicId).first<{
    action: "cancel" | "change_plan" | "resume";
    billingProviderCode: string | null;
    currency: string | null;
    currentPlanCode: string;
    id: string;
    marketCode: "global" | "vn" | null;
    providerActionRef: string | null;
    providerSubscriptionRef: string | null;
    requestedPlanId: string | null;
    requestedPlanCode: string | null;
    status: string;
    subscriptionId: string;
    version: number;
  }>();
  if (request === null) throw new AppError("subscription_change_request_not_found", 404);
  if (request.status === "provider_pending" && request.providerActionRef !== null && !request.providerActionRef.startsWith("operation:")) return { providerActionRef: request.providerActionRef, requestId: request.id, status: request.status, version: request.version };
  if (request.billingProviderCode !== "dodo" || request.providerSubscriptionRef === null) throw new AppError("billing_provider_operation_unavailable", 503);
  const config = getDodoConfig(input.env);
  const operation = await executeSubscriptionChangeRequest({
    env: input.env,
    requestPublicId: request.id,
    reviewedByUserId: input.reviewedByUserId,
    shopId: input.shopId,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    now,
    providerExecutor: async (context) => {
      const idempotencyKey = await hmacToken(input.env.SESSION_SECRET, "dodo-subscription-operation:v1", `${context.shopId}:${context.requestId}:${context.action}:${context.requestedPlanId ?? ""}`);
      if (context.action === "cancel") {
        return cancelDodoSubscription({ config, idempotencyKey, providerSubscriptionId: request.providerSubscriptionRef as string, ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }) });
      }
      if (context.action !== "change_plan" || context.requestedPlanId === null || request.marketCode === null || request.currency === null) throw new AppError("billing_provider_operation_unavailable", 503);
      const price = await input.env.PLATFORM_DB.prepare(`
        SELECT provider_price_ref AS providerPriceRef
        FROM plan_prices
        WHERE plan_id = ? AND provider_code = 'dodo' AND market_code = ? AND currency = ?
          AND interval = 'month' AND is_active = 1 AND effective_from <= ?
          AND (effective_to IS NULL OR effective_to > ?)
        ORDER BY effective_from DESC, version DESC, id DESC
        LIMIT 1
      `).bind(context.requestedPlanId, request.marketCode, request.currency, nowIso, nowIso).first<{ providerPriceRef: string }>();
      if (price === null || price.providerPriceRef.startsWith("pending:")) throw new AppError("provider_not_ready", 503);
      const effectiveAt = request.currentPlanCode === "starter" && request.requestedPlanCode === "pro" ? "immediately" : "next_billing_date";
      return changeDodoSubscription({ config, effectiveAt, idempotencyKey, onPaymentFailure: "prevent_change", priceId: price.providerPriceRef, providerSubscriptionId: request.providerSubscriptionRef as string, ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }) });
    },
  });
  return operation;
}

export type BillingChangeSchedulerMetrics = {
  attempted: number;
  candidates: number;
  failed: number;
  providerPending: number;
};

/** Execute durable seller billing intents from the scheduled Worker runtime. */
export async function processDueDodoSubscriptionChanges(input: {
  env: AppBindings;
  fetcher?: typeof fetch;
  limit?: number;
  now?: Date;
}): Promise<BillingChangeSchedulerMetrics> {
  const now = input.now ?? new Date();
  const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? Math.min(input.limit ?? 25, 100) : 25;
  const retryCutoff = new Date(now.getTime() - 60_000).toISOString();
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, requested_by_user_id AS requestedByUserId
    FROM subscription_change_requests
    WHERE status = 'requested'
      AND (last_attempt_at IS NULL OR last_attempt_at <= ?)
    ORDER BY COALESCE(last_attempt_at, created_at), id
    LIMIT ?
  `).bind(retryCutoff, limit).all<{ id: string; requestedByUserId: string; shopId: string }>();
  const metrics: BillingChangeSchedulerMetrics = { attempted: 0, candidates: rows.results.length, failed: 0, providerPending: 0 };
  for (const row of rows.results) {
    metrics.attempted += 1;
    try {
      const result = await executeDodoSubscriptionChangeRequest({
        env: input.env,
        requestId: `billing-change:${row.id}`,
        requestPublicId: row.id,
        reviewedByUserId: row.requestedByUserId,
        shopId: row.shopId,
        now,
        ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      });
      if (result.status === "provider_pending") metrics.providerPending += 1;
    } catch {
      metrics.failed += 1;
    }
  }
  return metrics;
}

/** Return a provider-pending request to the durable queue after a retryable provider failure. */
export async function retrySubscriptionChangeRequest(input: {
  env: AppBindings;
  failureCode: string;
  requestPublicId: string;
  shopId: string;
  now?: Date;
}): Promise<{ requestId: string; status: string; version: number }> {
  const failureCode = asString(input.failureCode, "failure_code_invalid", 96).toLowerCase();
  const nowIso = (input.now ?? new Date()).toISOString();
  const result = await input.env.PLATFORM_DB.prepare(`
    UPDATE subscription_change_requests
    SET status = 'requested', reviewed_by_user_id = NULL, reviewed_at = NULL,
      failure_code = ?, updated_at = ?, version = version + 1
    WHERE shop_id = ? AND public_id = ? AND status = 'provider_pending'
  `).bind(failureCode, nowIso, input.shopId, input.requestPublicId).run();
  if (result.meta.changes !== 1) throw new AppError("billing_change_pending", 409);
  const row = await input.env.PLATFORM_DB.prepare("SELECT id AS requestId, status, version FROM subscription_change_requests WHERE shop_id = ? AND public_id = ? LIMIT 1").bind(input.shopId, input.requestPublicId).first<{ requestId: string; status: string; version: number }>();
  if (row === null) throw new AppError("subscription_change_request_not_found", 404);
  return row;
}

/** Complete a claimed request only from a tenant-bound, recorded Dodo event. */
export async function completeSubscriptionChangeRequestFromProvider(input: {
  env: AppBindings;
  eventId: string;
  priceId?: string | null;
  shopId: string;
  subscriptionId: string;
  targetState: BillingState;
  now?: Date;
}): Promise<boolean> {
  const event = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, subscription_id AS subscriptionId, status
    FROM billing_provider_events
    WHERE id = ? AND provider_code = 'dodo' AND shop_id = ?
      AND status IN ('received', 'processed')
    LIMIT 1
  `).bind(input.eventId, input.shopId).first<{ id: string; shopId: string; status: string; subscriptionId: string | null }>();
  if (event === null || (event.subscriptionId !== null && event.subscriptionId !== input.subscriptionId)) throw new AppError("billing_webhook_identity_mismatch", 409);
  const request = await input.env.PLATFORM_DB.prepare(`
    SELECT id, action, requested_plan_id AS requestedPlanId, status,
      subscription_id AS subscriptionId, version
    FROM subscription_change_requests
    WHERE shop_id = ? AND subscription_id = ? AND status = 'provider_pending'
    ORDER BY created_at, id
    LIMIT 1
  `).bind(input.shopId, input.subscriptionId).first<SubscriptionChangeExecutionRow>();
  if (request === null) return false;
  if (input.targetState === "canceled" && request.action !== "cancel") return false;
  if (input.targetState === "active" && request.action === "change_plan" && input.priceId === null) throw new AppError("billing_webhook_price_mismatch", 409);
  if (input.targetState === "active" && request.action === "cancel") return false;
  if (input.priceId !== undefined && input.priceId !== null && request.action === "change_plan") {
    const price = await input.env.PLATFORM_DB.prepare("SELECT plan_id AS planId FROM plan_prices WHERE provider_code = 'dodo' AND provider_price_ref = ? LIMIT 1").bind(input.priceId).first<{ planId: string }>();
    if (price === null || price.planId !== request.requestedPlanId) throw new AppError("billing_webhook_price_mismatch", 409);
  }
  const nowIso = (input.now ?? new Date()).toISOString();
  const result = await input.env.PLATFORM_DB.prepare(`
    UPDATE subscription_change_requests
    SET status = 'completed', completed_at = ?, provider_event_id = ?, failure_code = NULL,
      reviewed_by_user_id = NULL, reviewed_at = NULL,
      updated_at = ?, version = version + 1
    WHERE id = ? AND shop_id = ? AND status = 'provider_pending' AND version = ?
  `).bind(nowIso, input.eventId, nowIso, request.id, input.shopId, request.version).run();
  return result.meta.changes === 1;
}

/**
 * Scheduled jobs call this before evaluating commerce entitlement. An expired
 * trial is suspended immediately; it never receives the paid-renewal grace
 * window. The event hash is stable so repeated cron runs are idempotent.
 */
export async function suspendExpiredTrials(input: { env: AppBindings; now?: Date; limit?: number }): Promise<number> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? Math.min(input.limit ?? 100, 500) : 100;
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, trial_ends_at AS trialEndsAt, version
    FROM shop_subscriptions
    WHERE state = 'trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at <= ?
    ORDER BY trial_ends_at, id
    LIMIT ?
  `).bind(nowIso, limit).all<{ id: string; shopId: string; trialEndsAt: string; version: number }>();
  let suspended = 0;
  for (const row of rows.results) {
    const eventHash = await sha256Json({ kind: "trial_expired", subscriptionId: row.id, trialEndsAt: row.trialEndsAt });
    try {
      const results = await input.env.PLATFORM_DB.batch([
        input.env.PLATFORM_DB.prepare(`
          INSERT OR IGNORE INTO subscription_events (
            id, shop_id, subscription_id, provider_event_id, source_kind,
            event_type, from_state, to_state, event_hash, safe_metadata_json,
            occurred_at, created_at
          ) VALUES (?, ?, ?, NULL, 'system', 'trial.expired', 'trialing', 'suspended', ?, '{}', ?, ?)
        `).bind(createId("sevt"), row.shopId, row.id, eventHash, nowIso, nowIso),
        input.env.PLATFORM_DB.prepare(`
          UPDATE shop_subscriptions
          SET state = 'suspended', grace_ends_at = NULL, updated_at = ?, version = version + 1
          WHERE id = ? AND state = 'trialing' AND version = ? AND trial_ends_at <= ?
        `).bind(nowIso, row.id, row.version, nowIso),
        // Force the D1 batch to roll back if the guarded state transition lost
        // a race after the event insert.
        input.env.PLATFORM_DB.prepare("UPDATE shop_subscriptions SET version = 0 WHERE id = ? AND changes() = 0").bind(row.id),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1) suspended += 1;
    } catch (error) {
      if (error instanceof Error && /version > 0|CHECK constraint failed/u.test(error.message)) continue;
      throw error;
    }
  }
  return suspended;
}

async function loadCheckoutForEvent(env: AppBindings, event: DodoBillingEvent): Promise<BillingCheckoutSession | null> {
  const sessionId = customValue(event.customData, "checkoutSessionId", "checkout_session_id");
  const shopId = customValue(event.customData, "shopId", "shop_id");
  const providerTransactionId = event.providerTransactionId;
  const select = `
    SELECT sessions.id, sessions.shop_id AS shopId, sessions.subscription_id AS subscriptionId,
      sessions.plan_id AS planId, plans.code AS planCode, sessions.price_id AS priceId,
      subscriptions.market_code AS marketCode,
      prices.amount_minor AS amountMinor, prices.currency,
      prices.version AS priceVersion,
      prices.provider_price_ref AS providerPriceRef,
      sessions.provider_checkout_ref AS providerCheckoutRef,
      subscriptions.provider_subscription_ref AS providerSubscriptionRef,
      sessions.status, sessions.request_hash AS requestHash
    FROM billing_checkout_sessions AS sessions
    INNER JOIN plans ON plans.id = sessions.plan_id
    INNER JOIN plan_prices AS prices ON prices.id = sessions.price_id
    INNER JOIN shop_subscriptions AS subscriptions
      ON subscriptions.shop_id = sessions.shop_id AND subscriptions.id = sessions.subscription_id
  `;
  const candidates: BillingCheckoutSession[] = [];
  const shopPredicate = shopId === null ? "" : "sessions.shop_id = ? AND ";
  const shopValue = shopId === null ? [] : [shopId];
  let sessionLookupFound = sessionId === null;
  // The first payment carries a new subscription/payment reference before
  // D1 has stored either ref; the signed checkout-session identity is the
  // authoritative bridge for that one event.
  let subscriptionLookupFound = event.providerSubscriptionId === null
    || (sessionId !== null && event.eventType === "payment.succeeded");
  let transactionLookupFound = providerTransactionId === null
    || (sessionId !== null && event.eventType === "payment.succeeded");
  if (sessionId !== null) {
    const row = await env.PLATFORM_DB.prepare(`${select} WHERE ${shopPredicate}(sessions.id = ? OR sessions.public_id = ?) LIMIT 1`).bind(...shopValue, sessionId, sessionId).first<BillingCheckoutSession>();
    if (row !== null) {
      sessionLookupFound = true;
      candidates.push(row);
    }
  }
  if (providerTransactionId !== null) {
    const row = await env.PLATFORM_DB.prepare(`${select} WHERE ${shopPredicate}sessions.provider_checkout_ref = ? LIMIT 1`).bind(...shopValue, providerTransactionId).first<BillingCheckoutSession>();
    if (row !== null) {
      transactionLookupFound = true;
      candidates.push(row);
    }
  }
  if (event.providerSubscriptionId !== null) {
    const row = await env.PLATFORM_DB.prepare(`${select} WHERE ${shopPredicate}subscriptions.billing_provider_code = 'dodo' AND subscriptions.provider_subscription_ref = ? LIMIT 1`).bind(...shopValue, event.providerSubscriptionId).first<BillingCheckoutSession>();
    if (row !== null) {
      subscriptionLookupFound = true;
      candidates.push(row);
    }
  }
  if (!sessionLookupFound || !subscriptionLookupFound || !transactionLookupFound) throw new AppError("billing_webhook_identity_mismatch", 409);
  if (candidates.length === 0) return null;
  const winner = candidates[0];
  if (winner === undefined) return null;
  if (candidates.some((candidate) => candidate.id !== winner.id || candidate.shopId !== winner.shopId || candidate.subscriptionId !== winner.subscriptionId || candidate.priceId !== winner.priceId)) throw new AppError("billing_webhook_identity_mismatch", 409);
  return winner;
}

function requiresPaidAmount(eventType: string): boolean {
  return eventType === "payment.succeeded";
}

function targetStateForEvent(event: DodoBillingEvent): BillingState | null {
  if (event.eventType === "payment.succeeded") return "active";
  if (event.eventType === "payment.failed") return "grace_period";
  if (event.eventType === "subscription.on_hold") return "grace_period";
  if (event.eventType === "subscription.failed") return "suspended";
  if (event.eventType === "subscription.expired") return "canceled";
  if (event.eventType === "subscription.cancelled" || event.eventType === "subscription.canceled" || event.eventType === "subscription.terminated") return "canceled";
  if (event.eventType === "subscription.paused") return "suspended";
  if (event.eventType === "subscription.renewed") return "active";
  if (event.eventType === "subscription.active") return "active";
  if (event.eventType === "subscription.updated" && (event.status === "on_hold" || event.status === "past_due")) return "grace_period";
  if (event.eventType === "subscription.updated" && (event.status === "canceled" || event.status === "cancelled" || event.status === "expired")) return "canceled";
  if (event.eventType === "subscription.updated" && event.status === "failed") return "suspended";
  if (event.eventType === "subscription.updated" && event.status === "active") return "active";
  return null;
}

async function loadEvent(env: AppBindings, providerEventId: string): Promise<BillingEventRow | null> {
  return env.PLATFORM_DB.prepare("SELECT id, payload_hash AS payloadHash, status FROM billing_provider_events WHERE provider_code = 'dodo' AND provider_event_id = ? LIMIT 1").bind(providerEventId).first<BillingEventRow>();
}

async function hasLaterProviderEvent(input: {
  env: AppBindings;
  occurredAt: string;
  shopId: string;
  subscriptionId: string;
}): Promise<boolean> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT 1 AS present
    FROM subscription_events
    WHERE shop_id = ?
      AND subscription_id = ?
      AND source_kind = 'provider'
      AND julianday(occurred_at) > julianday(?)
    LIMIT 1
  `).bind(input.shopId, input.subscriptionId, input.occurredAt).first<{ present: number }>();
  return row !== null;
}

async function recordEvent(env: AppBindings, event: DodoBillingEvent, payloadHash: string, nowIso: string, shopId: string | null, subscriptionId: string | null): Promise<{ event: BillingEventRow; duplicate: boolean; retryable: boolean }> {
  const id = createId("bevt");
  const inserted = await env.PLATFORM_DB.prepare(`
    INSERT OR IGNORE INTO billing_provider_events (
      id, provider_code, provider_event_id, provider_object_ref, shop_id, event_type,
      payload_hash, status, safe_metadata_json, occurred_at, created_at, subscription_id
    ) VALUES (?, 'dodo', ?, ?, ?, ?, ?, 'received', '{}', ?, ?, ?)
  `).bind(id, event.eventId, event.providerTransactionId ?? event.providerSubscriptionId, shopId, event.eventType, payloadHash, event.occurredAt, nowIso, subscriptionId).run();
  if (inserted.meta.changes === 1) return { duplicate: false, event: { id, payloadHash, status: "received" }, retryable: true };

  // INSERT OR IGNORE makes concurrent deliveries converge on one durable row.
  // Reload the winner so the losing request can still validate its payload hash.
  const existing = await loadEvent(env, event.eventId);
  if (existing === null) throw new AppError("billing_event_record_failed", 503);
  if (existing.payloadHash !== payloadHash) throw new AppError("billing_webhook_conflict", 409);
  // A failed delivery may be retried with the same signed payload. Move it
  // back to the processable state before applying the idempotent transition;
  // terminal event states remain immutable and are returned as duplicates.
  if (existing.status === "failed") {
    const reset = await env.PLATFORM_DB.prepare("UPDATE billing_provider_events SET status = 'received', processed_at = NULL WHERE id = ? AND status = 'failed'").bind(existing.id).run();
    if (reset.meta.changes === 1) return { duplicate: true, event: { ...existing, status: "received" }, retryable: true };
    const current = await loadEvent(env, event.eventId);
    if (current === null) throw new AppError("billing_event_record_failed", 503);
    return { duplicate: true, event: current, retryable: false };
  }
  return { duplicate: true, event: existing, retryable: false };
}

async function markEvent(env: AppBindings, eventId: string, result: "processed" | "ignored" | "conflict" | "failed", nowIso: string): Promise<void> {
  await env.PLATFORM_DB.prepare("UPDATE billing_provider_events SET status = ?, processed_at = ? WHERE id = ? AND status = 'received'").bind(result, nowIso, eventId).run();
}

export async function processDodoWebhook(input: {
  env: AppBindings;
  fetcher?: typeof fetch;
  rawBody: string;
  signature: string | null;
  webhookId: string | null;
  webhookTimestamp: string | null;
  webhookPublicId: string;
  now?: Date;
}): Promise<WebhookResult> {
  if (!/^(?:ddowh|dodow)_[0-9a-f-]{36}$/u.test(input.webhookPublicId)) throw new AppError("webhook_not_found", 404);
  const config = getDodoConfig(input.env);
  if (!await verifyDodoWebhookSignature({
    body: input.rawBody,
    header: input.signature,
    secret: config.webhookSecret,
    webhookId: input.webhookId,
    timestamp: input.webhookTimestamp,
    now: Math.floor((input.now ?? new Date()).getTime() / 1000),
  })) throw new AppError("webhook_signature_invalid", 401);
  let payload: unknown;
  try { payload = JSON.parse(input.rawBody) as unknown; } catch { throw new AppError("billing_webhook_invalid", 400, ["json_invalid"]); }
  const event = parseDodoEvent(payload, input.webhookId);
  const payloadHash = await sha256Json(payload);
  const nowIso = (input.now ?? new Date()).toISOString();
  const session = await loadCheckoutForEvent(input.env, event);
  const recorded = await recordEvent(input.env, event, payloadHash, nowIso, session?.shopId ?? null, session?.subscriptionId ?? null);
  if (recorded.duplicate && !recorded.retryable) return { duplicate: true, processed: false, state: recorded.event.status };
  try {
    if (session === null) {
      await markEvent(input.env, recorded.event.id, "ignored", nowIso);
      return { duplicate: false, processed: false, state: "unmapped" };
    }
    const subscription = await loadSubscription(input.env, session.shopId);
    const pendingChange = await loadPendingSubscriptionChange(input.env, session.shopId, session.subscriptionId);
    const customShopId = customValue(event.customData, "shopId", "shop_id");
    const customPlanCode = customValue(event.customData, "planCode", "plan_code");
    const customMarketCode = customValue(event.customData, "marketCode", "market_code");
    if ((customShopId !== null && customShopId !== session.shopId)
      || (customPlanCode !== null && customPlanCode !== session.planCode && customPlanCode !== pendingChange?.requestedPlanCode)
      || (customMarketCode !== null && customMarketCode !== session.marketCode)) throw new AppError("billing_webhook_identity_mismatch", 409);
    // Dodo emits subscription.active when the mandate is authorized. That
    // event can precede the actual charge, so it is intentionally informational
    // until a signed payment.succeeded event confirms the first payment.
    if (event.eventType === "subscription.active" && session.status !== "completed") {
      await markEvent(input.env, recorded.event.id, "ignored", nowIso);
      return { duplicate: false, processed: false, state: "pending_payment" };
    }
    const customSubscriptionId = customValue(event.customData, "subscriptionId", "subscription_id");
    if (customSubscriptionId !== null && customSubscriptionId !== session.subscriptionId) throw new AppError("billing_webhook_identity_mismatch", 409);
    let target = targetStateForEvent(event);
    let providerPriceRef = event.priceId;
    if (target === "active" && pendingChange?.action === "change_plan" && providerPriceRef === null) {
      if (event.providerSubscriptionId === null) throw new AppError("billing_webhook_subscription_missing", 409);
      const providerSubscription = await retrieveDodoSubscription({
        config,
        providerSubscriptionId: event.providerSubscriptionId,
        ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      });
      if (providerSubscription.status !== null && providerSubscription.status !== "active") throw new AppError("billing_webhook_price_mismatch", 409);
      providerPriceRef = providerSubscription.priceId;
      if (providerPriceRef === null) throw new AppError("billing_webhook_price_mismatch", 409);
    }
    const checkoutPrice = await loadBillingPriceById(input.env, session.priceId);
    const currentPrice = subscription.priceId === null
      ? (subscription.planId === checkoutPrice.planId ? checkoutPrice : null)
      : await loadBillingPriceById(input.env, subscription.priceId);
    const eventPrice = providerPriceRef === null ? null : await loadBillingPriceByProviderRef(input.env, providerPriceRef);
    let verifiedPrice = session.status === "completed" ? currentPrice ?? checkoutPrice : checkoutPrice;
    if (session.status === "completed" && target === "active" && pendingChange?.action === "change_plan") {
      if (eventPrice === null || eventPrice.planId !== pendingChange.requestedPlanId) throw new AppError("billing_webhook_price_mismatch", 409);
      verifiedPrice = eventPrice;
    } else if (eventPrice !== null && eventPrice.id !== verifiedPrice.id) {
      throw new AppError("billing_webhook_price_mismatch", 409);
    }
    if (requiresPaidAmount(event.eventType)) {
      if (["expired", "failed", "canceled"].includes(session.status)) throw new AppError("billing_webhook_checkout_expired", 409);
      if (event.providerSubscriptionId === null) throw new AppError("billing_webhook_subscription_missing", 409);
      if (event.amountMinor === null || event.currency === null || providerPriceRef === null || event.amountMinor !== verifiedPrice.amountMinor || event.currency !== verifiedPrice.currency.toUpperCase() || providerPriceRef !== verifiedPrice.providerPriceRef) throw new AppError("billing_webhook_amount_mismatch", 409);
    }
    // Subscription events may omit product/amount fields. Validate any fields
    // supplied by Dodo, while requiring all price evidence on first payment.
    if (event.eventType.startsWith("subscription.")) {
      if (event.currency !== null && event.currency !== verifiedPrice.currency.toUpperCase()) throw new AppError("billing_webhook_price_mismatch", 409);
    } else if (event.eventType === "payment.failed") {
      if (event.currency !== null && event.currency !== verifiedPrice.currency.toUpperCase()) throw new AppError("billing_webhook_price_mismatch", 409);
    }
    if (event.eventType.startsWith("subscription.") && session.providerSubscriptionRef !== null && event.providerSubscriptionId !== session.providerSubscriptionRef) throw new AppError("billing_webhook_identity_mismatch", 409);
    if (event.eventType === "payment.failed" && session.providerSubscriptionRef !== null && event.providerSubscriptionId !== session.providerSubscriptionRef) throw new AppError("billing_webhook_identity_mismatch", 409);
    // A failed initial mandate/payment cannot receive the paid grace window;
    // leave it suspended until the customer starts a new checkout.
    if ((event.eventType === "payment.failed" || event.eventType === "subscription.failed") && session.status !== "completed") target = "suspended";
    if (target === "active" && event.eventType !== "payment.succeeded" && session.status !== "completed") throw new AppError("billing_webhook_activation_unverified", 409);
    if (target === "grace_period" && session.status !== "completed") throw new AppError("billing_webhook_grace_invalid", 409);
    if (target === "grace_period" && subscription.state !== "active") throw new AppError("billing_webhook_grace_invalid", 409);
    if (target !== null && await hasLaterProviderEvent({
      env: input.env,
      occurredAt: event.occurredAt,
      shopId: session.shopId,
      subscriptionId: session.subscriptionId,
    })) {
      await markEvent(input.env, recorded.event.id, "ignored", nowIso);
      return { duplicate: false, processed: false, state: "stale" };
    }
    if (target !== null) {
      await input.env.PLATFORM_DB.prepare(`
        INSERT OR IGNORE INTO subscription_events (
          id, shop_id, subscription_id, provider_event_id, source_kind,
          event_type, from_state, to_state, event_hash, safe_metadata_json,
          occurred_at, created_at
        ) VALUES (?, ?, ?, ?, 'provider', ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        createId("sevt"), session.shopId, session.subscriptionId, recorded.event.id,
        event.eventType, subscription.state, target, payloadHash,
        JSON.stringify({ amountMinor: event.amountMinor, currency: event.currency, priceId: providerPriceRef }),
        event.occurredAt, nowIso,
      ).run();
    }
    const periodChanged = event.periodStart !== null || event.periodEnd !== null;
    const providerRefChanged = event.providerSubscriptionId !== null && event.providerSubscriptionId !== subscription.providerSubscriptionRef;
    const priceChanged = target === "active" && (subscription.planId !== verifiedPrice.planId || subscription.priceId !== verifiedPrice.id);
    if (target !== null && (subscription.state !== target || periodChanged || providerRefChanged || priceChanged)) {
      const graceEndsAt = target === "grace_period" ? new Date((input.now ?? new Date()).getTime() + BILLING_GRACE_PERIOD_MS).toISOString() : null;
      const transition = await input.env.PLATFORM_DB.prepare(`
        UPDATE shop_subscriptions
        SET state = ?, plan_id = CASE WHEN ? = 'active' THEN ? ELSE plan_id END,
          market_code = CASE WHEN ? = 'active' THEN ? ELSE market_code END,
          price_currency = CASE WHEN ? = 'active' THEN ? ELSE price_currency END,
          price_amount_minor = CASE WHEN ? = 'active' THEN ? ELSE price_amount_minor END,
          price_interval = CASE WHEN ? = 'active' THEN 'month' ELSE price_interval END,
          price_version = CASE WHEN ? = 'active' THEN ? ELSE price_version END,
          price_id = CASE WHEN ? = 'active' THEN ? ELSE price_id END,
          grace_ends_at = ?, canceled_at = CASE WHEN ? = 'canceled' THEN ? ELSE canceled_at END,
          trial_ends_at = CASE WHEN ? = 'active' THEN NULL ELSE trial_ends_at END,
          current_period_start = CASE WHEN ? = 'active' THEN COALESCE(current_period_start, ?) ELSE current_period_start END,
          current_period_end = CASE WHEN ? = 'active' THEN COALESCE(?, current_period_end) ELSE current_period_end END,
          provider_subscription_ref = COALESCE(?, provider_subscription_ref),
          version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).bind(
        target, target, verifiedPrice.planId,
        target, verifiedPrice.marketCode,
        target, verifiedPrice.currency,
        target, verifiedPrice.amountMinor,
        target,
        target, verifiedPrice.version,
        target, verifiedPrice.id,
        graceEndsAt, target, target === "canceled" ? nowIso : null,
        target, target, event.periodStart ?? nowIso, target, event.periodEnd,
        event.providerSubscriptionId, nowIso, subscription.id, subscription.version,
      ).run();
      if (transition.meta.changes !== 1) throw new AppError("billing_subscription_version_conflict", 409);
    }
    if ((event.eventType === "payment.failed" || event.eventType === "subscription.failed") && session.status !== "completed") {
      await input.env.PLATFORM_DB.prepare(`
        UPDATE billing_checkout_sessions
        SET status = 'failed', failure_code = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND status IN ('pending', 'open')
      `).bind(event.eventType.replaceAll(".", "_"), nowIso, session.id).run();
    }
    if (event.eventType === "payment.succeeded") {
      await input.env.PLATFORM_DB.prepare(`
        UPDATE billing_checkout_sessions
        SET status = 'completed', provider_checkout_ref = COALESCE(provider_checkout_ref, ?),
          completed_at = ?, updated_at = ?, version = version + 1
        WHERE id = ?
      `).bind(event.providerTransactionId, nowIso, nowIso, session.id).run();
    }
    if (target !== null) {
      await completeSubscriptionChangeRequestFromProvider({
        env: input.env,
        eventId: recorded.event.id,
        ...(providerPriceRef === null ? {} : { priceId: providerPriceRef }),
        shopId: session.shopId,
        subscriptionId: session.subscriptionId,
        targetState: target,
        ...(input.now === undefined ? {} : { now: input.now }),
      });
    }
    await markEvent(input.env, recorded.event.id, target === null ? "ignored" : "processed", nowIso);
    return { duplicate: false, processed: target !== null, state: target ?? "ignored" };
  } catch (error) {
    const result = error instanceof AppError && error.code.startsWith("billing_webhook_") ? "conflict" : "failed";
    await markEvent(input.env, recorded.event.id, result, nowIso).catch(() => undefined);
    throw error;
  }
}

export async function processDodoWebhookRequest(input: {
  env: AppBindings;
  fetcher?: typeof fetch;
  request: Request;
  webhookPublicId: string;
  now?: Date;
}): Promise<WebhookResult> {
  const bytes = await readBoundedBytes(input.request, 128 * 1024);
  let rawBody: string;
  try { rawBody = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new AppError("billing_webhook_invalid", 400, ["body_encoding"]); }
  return processDodoWebhook({
    env: input.env,
    rawBody,
    signature: input.request.headers.get("webhook-signature"),
    webhookId: input.request.headers.get("webhook-id"),
    webhookTimestamp: input.request.headers.get("webhook-timestamp"),
    webhookPublicId: input.webhookPublicId,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}
