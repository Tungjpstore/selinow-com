import { AppError } from "../core/errors";
import {
  LEGACY_PLAN_CODES,
  PLAN_FEATURE_ALIASES,
  PLAN_FEATURES,
  PLAN_LIMIT_ALIASES,
  PLAN_LIMITS,
  type PlanFeatureName,
  type PlanLimitName,
  type PlanSnapshot,
  parsePlanSnapshot,
  type PlanSnapshotInput,
  parsePlanFeatures,
  parsePlanLimits,
} from "./plan-catalog";
import {
  type SubscriptionAccessInput,
} from "./subscription-access";

export { assertSubscriptionAllows, subscriptionAllows } from "./subscription-access";
export type { SubscriptionAccessInput } from "./subscription-access";
export { GRACE_PERIOD_DAYS, PRO_PLAN, PUBLIC_PLAN_CATALOG, PUBLIC_TRIAL_DAYS, STARTER_PLAN } from "./plan-catalog";
export type { PlanFeatures, PlanLimits, PlanSnapshot } from "./plan-catalog";

export const SUBSCRIPTION_STATES = [
  "pending_payment",
  "trialing",
  "active",
  "past_due",
  "grace_period",
  "suspended",
  "cancel_scheduled",
  "canceled",
  "upgrade_pending",
  "downgrade_scheduled",
] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];
export type SubscriptionPeriodKind = "trial" | "paid";

export function subscriptionPeriodKind(state: string): SubscriptionPeriodKind | null {
  if (state === "trialing") return "trial";
  if (["active", "past_due", "grace_period", "suspended", "cancel_scheduled", "upgrade_pending", "downgrade_scheduled"].includes(state)) return "paid";
  return null;
}

export const ENTITLEMENT_REASON_CODES = [
  "authorization_denied",
  "plan_feature_unavailable",
  "plan_limit_reached",
  "subscription_payment_required",
  "subscription_grace_expired",
  "provider_not_ready",
  "shop_not_publishable",
  "quota_over_limit",
] as const;
export type EntitlementReasonCode = (typeof ENTITLEMENT_REASON_CODES)[number];

export type SubscriptionContext = Omit<SubscriptionAccessInput, "subscriptionState"> & {
  state?: string;
  subscriptionState?: string;
};

export type EntitlementAction =
  | "billing"
  | "checkout"
  | "dashboard"
  | "draft_setup"
  | "mutation"
  | "provider_setup"
  | "publish"
  | "read";

export type EntitlementDecision<TDetails extends object = object> = {
  allowed: boolean;
  reasonCode: EntitlementReasonCode | null;
} & TDetails;

export type FeatureEvaluationInput = {
  action?: EntitlementAction;
  feature: string;
  plan: PlanSnapshot | PlanSnapshotInput;
  requiredAnalyticsTier?: "basic" | "advanced";
  subscription?: SubscriptionContext;
};

export type QuotaEvaluationInput = {
  action?: EntitlementAction;
  metric: string;
  plan: PlanSnapshot | PlanSnapshotInput;
  requested?: number;
  subscription?: SubscriptionContext;
  used: number;
};

type PlanDecisionDetails = {
  planCode: string | null;
  planVersion: number | null;
};

type FeatureDecision = EntitlementDecision<PlanDecisionDetails & {
  feature: string;
  value: boolean | "none" | "basic" | "advanced" | null;
}>;

type QuotaDecision = EntitlementDecision<PlanDecisionDetails & {
  limit: number | null;
  metric: string;
  requested: number;
  used: number;
}>;

const FEATURE_SET = new Set<string>(PLAN_FEATURES);
const LIMIT_SET = new Set<string>(PLAN_LIMITS);
const PROVIDER_SETUP_ACTIONS = new Set<EntitlementAction>(["provider_setup"]);

function validPlan(input: PlanSnapshot | PlanSnapshotInput): PlanSnapshot | null {
  const result = parsePlanSnapshot(input);
  return result.ok ? result.value : null;
}

function subscriptionState(input: SubscriptionContext): string {
  return input.subscriptionState ?? input.state ?? "";
}

function isDateInFuture(value: string | null | undefined, now: Date | string | undefined): boolean {
  if (value === null || value === undefined) return false;
  const deadline = Date.parse(value);
  const current = now instanceof Date ? now.getTime() : Date.parse(now ?? new Date().toISOString());
  return Number.isFinite(deadline) && Number.isFinite(current) && deadline > current;
}

function subscriptionDecision(input: SubscriptionContext, action: EntitlementAction): EntitlementDecision {
  const state = subscriptionState(input);
  const now = input.now;
  if (["active", "cancel_scheduled", "upgrade_pending", "downgrade_scheduled"].includes(state)) return { allowed: true, reasonCode: null };
  if (state === "trialing") {
    return isDateInFuture(input.trialEndsAt, now)
      ? { allowed: true, reasonCode: null }
      : { allowed: false, reasonCode: "subscription_payment_required" };
  }
  if (state === "past_due" || state === "grace_period") {
    if (!isDateInFuture(input.graceEndsAt, now)) return { allowed: false, reasonCode: "subscription_grace_expired" };
    if (PROVIDER_SETUP_ACTIONS.has(action)) return { allowed: false, reasonCode: "provider_not_ready" };
    return { allowed: true, reasonCode: null };
  }
  if (state === "pending_payment") {
    return action === "dashboard" || action === "draft_setup"
      ? { allowed: true, reasonCode: null }
      : { allowed: false, reasonCode: "subscription_payment_required" };
  }
  if (state === "suspended" || state === "canceled") {
    return action === "billing" || action === "dashboard" || action === "read"
      ? { allowed: true, reasonCode: null }
      : { allowed: false, reasonCode: "subscription_payment_required" };
  }
  // Legacy state names and future states fail closed until explicitly mapped.
  return { allowed: false, reasonCode: "subscription_payment_required" };
}

/** Evaluates only the time/state side of subscription entitlement. */
export function evaluateSubscription(input: SubscriptionContext & { action?: EntitlementAction }): EntitlementDecision {
  return subscriptionDecision(input, input.action ?? "mutation");
}

/**
 * Evaluate a feature from a server-loaded plan snapshot. Invalid JSON, an
 * unknown plan or an unknown feature never grants access.
 */
export function evaluateFeature(input: FeatureEvaluationInput): FeatureDecision {
  const plan = validPlan(input.plan);
  const feature = input.feature;
  const canonicalFeature = PLAN_FEATURE_ALIASES[feature] ?? feature;
  const details: PlanDecisionDetails = {
    planCode: plan?.code ?? null,
    planVersion: plan?.version ?? null,
  };
  if (plan === null || plan.isActive === false || !FEATURE_SET.has(canonicalFeature)) {
    return { ...details, allowed: false, feature, reasonCode: "plan_feature_unavailable", value: null };
  }

  const value = plan.features[canonicalFeature as PlanFeatureName];
  const enabled = canonicalFeature === "analytics"
    ? value !== "none" && (input.requiredAnalyticsTier !== "advanced" || value === "advanced")
    : value === true;
  if (!enabled) return { ...details, allowed: false, feature, reasonCode: "plan_feature_unavailable", value };

  if (input.subscription !== undefined) {
    const subscription = subscriptionDecision(input.subscription, input.action ?? "mutation");
    if (!subscription.allowed) return { ...details, allowed: false, feature, reasonCode: subscription.reasonCode, value };
  }
  return { ...details, allowed: true, feature, reasonCode: null, value };
}

export function assertFeature(input: FeatureEvaluationInput): void {
  const result = evaluateFeature(input);
  if (!result.allowed) {
    throw new AppError(result.reasonCode ?? "plan_feature_unavailable", 402, [result.feature]);
  }
}

/**
 * Evaluate a quota request against the current period usage. `used` must be a
 * server-authoritative counter; this helper intentionally does not read KV or
 * infer usage from client input.
 */
export function evaluateQuota(input: QuotaEvaluationInput): QuotaDecision {
  const plan = validPlan(input.plan);
  const metric = input.metric;
  const canonicalMetric = PLAN_LIMIT_ALIASES[metric] ?? metric;
  const requested = input.requested ?? 1;
  const details: PlanDecisionDetails = {
    planCode: plan?.code ?? null,
    planVersion: plan?.version ?? null,
  };
  if (!Number.isSafeInteger(input.used) || input.used < 0 || !Number.isSafeInteger(requested) || requested < 0) {
    return { ...details, allowed: false, limit: null, metric, reasonCode: "quota_over_limit", requested, used: input.used };
  }
  if (plan === null || !LIMIT_SET.has(canonicalMetric)) {
    return { ...details, allowed: false, limit: null, metric, reasonCode: "plan_limit_reached", requested, used: input.used };
  }

  const limit = plan.limits[canonicalMetric as PlanLimitName];
  if (input.used > limit) return { ...details, allowed: false, limit, metric, reasonCode: "quota_over_limit", requested, used: input.used };
  if (input.used + requested > limit) return { ...details, allowed: false, limit, metric, reasonCode: "plan_limit_reached", requested, used: input.used };
  if (input.subscription !== undefined) {
    const subscription = subscriptionDecision(input.subscription, input.action ?? "mutation");
    if (!subscription.allowed) return { ...details, allowed: false, limit, metric, reasonCode: subscription.reasonCode, requested, used: input.used };
  }
  return { ...details, allowed: true, limit, metric, reasonCode: null, requested, used: input.used };
}

export function assertQuota(input: QuotaEvaluationInput): void {
  const result = evaluateQuota(input);
  if (!result.allowed) throw new AppError(result.reasonCode ?? "quota_over_limit", 402, [result.metric]);
}

/**
 * Convenience intersection for routes that need both a feature and a quota.
 * The quota is evaluated only after the feature and subscription gates pass.
 */
export function evaluateEntitlement(input: {
  action?: EntitlementAction;
  feature?: FeatureEvaluationInput["feature"];
  metric?: QuotaEvaluationInput["metric"];
  plan: PlanSnapshot | PlanSnapshotInput;
  requested?: number;
  requiredAnalyticsTier?: FeatureEvaluationInput["requiredAnalyticsTier"];
  subscription?: SubscriptionContext;
  used?: number;
}): EntitlementDecision {
  if (input.feature !== undefined) {
    const featureInput: FeatureEvaluationInput = { feature: input.feature, plan: input.plan };
    if (input.action !== undefined) featureInput.action = input.action;
    if (input.requiredAnalyticsTier !== undefined) featureInput.requiredAnalyticsTier = input.requiredAnalyticsTier;
    if (input.subscription !== undefined) featureInput.subscription = input.subscription;
    const feature = evaluateFeature(featureInput);
    if (!feature.allowed) return feature;
  }
  if (input.metric !== undefined) {
    const quotaInput: QuotaEvaluationInput = { metric: input.metric, plan: input.plan, used: input.used ?? 0 };
    if (input.action !== undefined) quotaInput.action = input.action;
    if (input.requested !== undefined) quotaInput.requested = input.requested;
    if (input.subscription !== undefined) quotaInput.subscription = input.subscription;
    const quota = evaluateQuota(quotaInput);
    if (!quota.allowed) return quota;
  } else if (input.subscription !== undefined) {
    const subscriptionInput: SubscriptionContext & { action?: EntitlementAction } = { ...input.subscription };
    if (input.action !== undefined) subscriptionInput.action = input.action;
    return evaluateSubscription(subscriptionInput);
  }
  return { allowed: true, reasonCode: null };
}

/** Used by callers migrating legacy plan rows without granting unknown codes. */
export function isLegacyPlanCode(value: string): value is (typeof LEGACY_PLAN_CODES)[number] {
  return (LEGACY_PLAN_CODES as readonly string[]).includes(value);
}

/** Safe parsers are re-exported at the billing boundary for route validators. */
export { parsePlanFeatures, parsePlanLimits, parsePlanSnapshot };
