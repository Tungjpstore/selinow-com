import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "./store";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
const SAFE_REASON_CODE = /^[a-z][a-z0-9._:-]{2,63}$/u;

type ExistingIdempotency = { request_hash: string; response_json: string };
type PlanRow = { code: string; featuresJson: string; id: string; limitsJson: string; name: string; version: number };
type PlanPriceRow = {
  amountMinor: number;
  currency: string;
  interval: string;
  marketCode: "global" | "vn";
  planCode: string;
};
type RequestRow = {
  action: "cancel" | "cancel_scheduled_plan_change" | "change_plan" | "resume";
  createdAt: string;
  executionAttempts: number;
  failureCode: string | null;
  currentPlanCode: string;
  expectedSubscriptionVersion: number;
  id: string;
  requestedPlanCode: string | null;
  providerActionRef: string | null;
  lastAttemptAt: string | null;
  reasonCode: string;
  status: "canceled" | "completed" | "provider_pending" | "rejected" | "requested";
  updatedAt: string;
  version: number;
};

export type SellerBillingPlan = {
  code: string;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  name: string;
  prices?: Array<Pick<PlanPriceRow, "amountMinor" | "currency" | "interval" | "marketCode">>;
  version: number;
};

export type SubscriptionChangeRequest = RequestRow & { requestPublicId: string };

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function mapPlan(row: PlanRow): SellerBillingPlan {
  return { code: row.code, features: parseObject(row.featuresJson), limits: parseObject(row.limitsJson), name: row.name, version: row.version };
}

function mapRequest(row: RequestRow): SubscriptionChangeRequest {
  return { ...row, requestPublicId: row.id };
}

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9._:-]{8,128}$/u.test(value)) throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
  return value;
}

function requireReasonCode(value: unknown): string {
  if (typeof value !== "string" || !SAFE_REASON_CODE.test(value)) throw new AppError("validation_failed", 400, ["reason_code_invalid"]);
  return value;
}

async function currentSubscription(env: AppBindings, shopId: string): Promise<{ currentPlanCode: string; currentPlanId: string; id: string; state: string; version: number }> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT subscriptions.id, subscriptions.state, subscriptions.version,
      subscriptions.plan_id AS currentPlanId, plans.code AS currentPlanCode
    FROM shop_subscriptions AS subscriptions
    INNER JOIN plans ON plans.id = subscriptions.plan_id
    WHERE subscriptions.shop_id = ? AND subscriptions.state != 'canceled'
    ORDER BY subscriptions.created_at DESC, subscriptions.id DESC
    LIMIT 1
  `).bind(shopId).first<{ currentPlanCode: string; currentPlanId: string; id: string; state: string; version: number }>();
  if (row === null) throw new AppError("subscription_required", 409);
  return row;
}

async function loadRequest(env: AppBindings, shopId: string, requestPublicId: string): Promise<RequestRow> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT requests.id, requests.action, requests.status,
      current_plan.code AS currentPlanCode, requested_plan.code AS requestedPlanCode,
      requests.expected_subscription_version AS expectedSubscriptionVersion,
      requests.reason_code AS reasonCode, requests.created_at AS createdAt,
      requests.updated_at AS updatedAt, requests.version,
      requests.provider_action_ref AS providerActionRef,
      requests.failure_code AS failureCode,
      requests.execution_attempts AS executionAttempts,
      requests.last_attempt_at AS lastAttemptAt
    FROM subscription_change_requests AS requests
    INNER JOIN plans AS current_plan ON current_plan.id = requests.current_plan_id
    LEFT JOIN plans AS requested_plan ON requested_plan.id = requests.requested_plan_id
    WHERE requests.shop_id = ? AND requests.public_id = ?
    LIMIT 1
  `).bind(shopId, requestPublicId).first<RequestRow>();
  if (row === null) throw new AppError("subscription_change_request_not_found", 404);
  return row;
}

export async function listSellerBillingPlans(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<SellerBillingPlan[]> {
  const actor = await getShopForMember({ capability: "billing:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT code, name, version, feature_flags_json AS featuresJson, limits_json AS limitsJson
    FROM plans
    WHERE is_active = 1 AND is_public = 1 AND is_assignable = 1
    ORDER BY code, id
    LIMIT 50
  `).all<PlanRow>();
  const plans = rows.results.map(mapPlan);
  // Prices are projected for the authenticated shop's server-selected market
  // only. The client never chooses currency or provider references.
  const market = actor.row.merchant_country_code?.trim().toUpperCase() === "VN"
    ? "vn"
    : actor.row.merchant_country_code === null || actor.row.merchant_country_code.trim().length === 0
      ? null
      : "global";
  if (market === null || plans.length === 0) return plans;
  try {
    const nowIso = new Date().toISOString();
    const prices = await input.env.PLATFORM_DB.prepare(`
      SELECT plans.code AS planCode, plan_prices.market_code AS marketCode,
        plan_prices.currency, plan_prices.amount_minor AS amountMinor,
        plan_prices.interval
      FROM plan_prices
      INNER JOIN plans ON plans.id = plan_prices.plan_id
      WHERE plan_prices.market_code = ?
        AND plan_prices.is_active = 1
        AND plan_prices.interval = 'month'
        AND plans.is_active = 1
        AND plan_prices.effective_from <= ?
        AND (plan_prices.effective_to IS NULL OR plan_prices.effective_to > ?)
      ORDER BY plans.code, plan_prices.effective_from DESC, plan_prices.version DESC
    `).bind(market, nowIso, nowIso).all<PlanPriceRow>();
    const byCode = new Map<string, SellerBillingPlan["prices"]>();
    for (const price of prices.results) {
      if (!Number.isSafeInteger(price.amountMinor) || price.amountMinor <= 0 || price.currency.length === 0) continue;
      const list = byCode.get(price.planCode) ?? [];
      if (list.some((item) => item.currency === price.currency && item.interval === price.interval)) continue;
      list.push({ amountMinor: price.amountMinor, currency: price.currency, interval: price.interval, marketCode: price.marketCode });
      byCode.set(price.planCode, list);
    }
    return plans.map((plan) => ({ ...plan, prices: byCode.get(plan.code) ?? [] }));
  } catch {
    // Keep the existing plan projection available when the additive pricing
    // migration has not been applied locally. Checkout still fails closed.
    return plans;
  }
}

export async function listSubscriptionChangeRequests(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<SubscriptionChangeRequest[]> {
  const actor = await getShopForMember({ capability: "billing:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT requests.id, requests.action, requests.status,
      current_plan.code AS currentPlanCode, requested_plan.code AS requestedPlanCode,
      requests.expected_subscription_version AS expectedSubscriptionVersion,
      requests.reason_code AS reasonCode, requests.created_at AS createdAt,
      requests.updated_at AS updatedAt, requests.version,
      requests.provider_action_ref AS providerActionRef,
      requests.failure_code AS failureCode,
      requests.execution_attempts AS executionAttempts,
      requests.last_attempt_at AS lastAttemptAt
    FROM subscription_change_requests AS requests
    INNER JOIN plans AS current_plan ON current_plan.id = requests.current_plan_id
    LEFT JOIN plans AS requested_plan ON requested_plan.id = requests.requested_plan_id
    WHERE requests.shop_id = ?
    ORDER BY requests.created_at DESC, requests.id DESC
    LIMIT 100
  `).bind(actor.row.shop_id).all<RequestRow>();
  return rows.results.map(mapRequest);
}

export async function createSubscriptionChangeRequest(input: {
  action: "cancel" | "cancel_scheduled_plan_change" | "change_plan" | "resume";
  env: AppBindings;
  expectedSubscriptionVersion: number;
  idempotencyKey: string | null;
  requestedPlanCode?: unknown;
  reasonCode: unknown;
  requestId: string;
  shopPublicId: string;
  userId: string;
  now?: Date;
}): Promise<SubscriptionChangeRequest> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  if (!Number.isSafeInteger(input.expectedSubscriptionVersion) || input.expectedSubscriptionVersion < 1) throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  if (!["cancel", "cancel_scheduled_plan_change", "change_plan", "resume"].includes(input.action)) throw new AppError("validation_failed", 400, ["billing_action_invalid"]);
  const reasonCode = requireReasonCode(input.reasonCode);
  const actor = await getShopForMember({ capability: "billing:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  let requestedPlanCode: string | null = null;
  if (input.action === "change_plan") {
    if (typeof input.requestedPlanCode !== "string" || !/^[a-z][a-z0-9._-]{1,31}$/u.test(input.requestedPlanCode)) throw new AppError("validation_failed", 400, ["plan_code_invalid"]);
    requestedPlanCode = input.requestedPlanCode;
  }
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const namespace = `subscription-change.create.v1:${actor.row.shop_id}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "subscription-change-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({ action: input.action, expectedSubscriptionVersion: input.expectedSubscriptionVersion, requestedPlanCode, reasonCode, shopId: actor.row.shop_id });
  const replay = await input.env.PLATFORM_DB.prepare("SELECT request_hash, response_json FROM idempotency_records WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ? LIMIT 1").bind(input.userId, namespace, keyHash, nowIso).first<ExistingIdempotency>();
  if (replay !== null) {
    if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const reference = JSON.parse(replay.response_json) as { requestPublicId?: string };
    if (typeof reference.requestPublicId !== "string") throw new AppError("billing_request_replay_invalid", 500);
    return mapRequest(await loadRequest(input.env, actor.row.shop_id, reference.requestPublicId));
  }
  // Resolve authoritative subscription state only after replay lookup so a
  // retry remains deterministic when the subscription version changes.
  const subscription = await currentSubscription(input.env, actor.row.shop_id);
  if (input.action === "resume" && subscription.state !== "cancel_scheduled") throw new AppError("billing_resume_provider_required", 409);
  if (input.action === "cancel_scheduled_plan_change" && subscription.state !== "downgrade_scheduled") {
    throw new AppError("billing_scheduled_plan_change_required", 409);
  }
  if (!new Set(["trialing", "active", "past_due", "grace_period", "cancel_scheduled", "upgrade_pending", "downgrade_scheduled"]).has(subscription.state)) {
    throw new AppError("billing_change_requires_request", 409);
  }
  const active = await input.env.PLATFORM_DB.prepare("SELECT id FROM subscription_change_requests WHERE shop_id = ? AND status IN ('requested', 'provider_pending') LIMIT 1").bind(actor.row.shop_id).first<{ id: string }>();
  if (active !== null) throw new AppError("billing_change_pending", 409);
  if (subscription.version !== input.expectedSubscriptionVersion) throw new AppError("version_conflict", 409);
  let requestedPlan: PlanRow | null = null;
  if (input.action === "change_plan") {
    requestedPlan = await input.env.PLATFORM_DB.prepare("SELECT id, code, name, version, feature_flags_json AS featuresJson, limits_json AS limitsJson FROM plans WHERE code = ? AND is_active = 1 AND is_public = 1 AND is_assignable = 1 LIMIT 1").bind(requestedPlanCode).first<PlanRow>();
    if (requestedPlan === null) throw new AppError("plan_not_found", 404);
    if (requestedPlan.id === subscription.currentPlanId) throw new AppError("billing_plan_unchanged", 409);
  }
  if (input.action === "cancel" && subscription.state === "canceled") throw new AppError("billing_already_canceled", 409);
  const requestId = createId("sreq");
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO subscription_change_requests (
        id, public_id, shop_id, subscription_id, current_plan_id,
        requested_plan_id, action, status, expected_subscription_version,
        reason_code, requested_by_user_id, idempotency_key_hash, request_hash,
        created_at, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?, 1)
    `).bind(requestId, requestId, actor.row.shop_id, subscription.id, subscription.currentPlanId, requestedPlan?.id ?? null, input.action, input.expectedSubscriptionVersion, reasonCode, input.userId, keyHash, requestHash, nowIso, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, source_kind, retention_class, created_at
      ) VALUES (?, ?, 'user', ?, 'billing.change_requested', 'subscription_change_request', ?, ?, ?, 'http', 'financial', ?)
    `).bind(createId("aud"), actor.row.shop_id, input.userId, requestId, JSON.stringify({ action: input.action, currentPlanCode: subscription.currentPlanCode, requestedPlanCode: requestedPlan?.code ?? null, reasonCode }), input.requestId, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO idempotency_records (actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(input.userId, namespace, keyHash, requestHash, JSON.stringify({ requestPublicId: requestId }), nowIso, new Date(now.getTime() + IDEMPOTENCY_TTL_MS).toISOString()),
  ]);
  return mapRequest(await loadRequest(input.env, actor.row.shop_id, requestId));
}
