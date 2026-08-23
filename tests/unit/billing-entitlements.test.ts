import { describe, expect, it } from "vitest";

import { AppError } from "../../src/lib/core/errors";
import {
  assertQuota,
  evaluateFeature,
  evaluateQuota,
  evaluateSubscription,
  parsePlanSnapshot,
  STARTER_PLAN,
  PRO_PLAN,
  subscriptionAllows,
} from "../../src/lib/billing/entitlements";
import { getBaselinePlanOffer, parsePlanOffer } from "../../src/lib/billing/plan-catalog";

const NOW = "2026-08-03T00:00:00.000Z";

describe("paid plan entitlement evaluator", () => {
  it("validates starter/pro snapshots and fails closed on malformed JSON", () => {
    const parsed = parsePlanSnapshot({
      code: "starter",
      featureFlagsJson: JSON.stringify(STARTER_PLAN.features),
      limitsJson: JSON.stringify({ products: 50, ordersPerMonth: 500, staffSeats: 1 }),
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.limits.products_non_archived).toBe(50);
      expect(parsed.value.limits.orders_created).toBe(500);
      expect(parsed.value.limits.active_member_seats).toBe(1);
      expect(parsed.value.features.storefront).toBe(true);
      expect(parsed.value.features.premiumStorefrontTemplates).toBe(false);
    }
    const migrationShape = parsePlanSnapshot({
      code: "pro",
      feature_flags_json: JSON.stringify({ payments: true, fulfillment: true, apiRead: true, analytics: "advanced" }),
      limits_json: JSON.stringify({ ordersPerBillingPeriod: 5000, memberSeats: 5, apiReadRequestsPerMonth: 50000 }),
      is_active: 1,
      is_assignable: 1,
      is_public: 1,
    });
    expect(migrationShape.ok).toBe(true);
    if (migrationShape.ok) {
      expect(migrationShape.value.features.sellerPayments).toBe(true);
      expect(migrationShape.value.features.manualFulfillment).toBe(true);
      expect(migrationShape.value.features.api).toBe(true);
      expect(migrationShape.value.limits.orders_created).toBe(5000);
      expect(migrationShape.value.limits.active_member_seats).toBe(5);
      expect(migrationShape.value.limits.api_requests).toBe(50000);
    }

    expect(parsePlanSnapshot({ code: "pro", featureFlagsJson: "{", limitsJson: "{}" }).ok).toBe(false);
    expect(parsePlanSnapshot({ code: "unknown", featureFlagsJson: "{}", limitsJson: "{}" }).ok).toBe(false);
  });

  it("enforces feature and analytics tier from the plan", () => {
    expect(evaluateFeature({ feature: "storefront", plan: STARTER_PLAN }).allowed).toBe(true);
    expect(evaluateFeature({ feature: "customDomain", plan: STARTER_PLAN }).reasonCode).toBe("plan_feature_unavailable");
    expect(evaluateFeature({ feature: "api", plan: STARTER_PLAN }).allowed).toBe(false);
    expect(evaluateFeature({ feature: "payments", plan: STARTER_PLAN }).allowed).toBe(true);
    expect(evaluateFeature({ feature: "fulfillment", plan: PRO_PLAN }).allowed).toBe(true);
    expect(evaluateFeature({ feature: "analytics", plan: STARTER_PLAN, requiredAnalyticsTier: "advanced" }).reasonCode).toBe("plan_feature_unavailable");
    expect(evaluateFeature({ feature: "analytics", plan: PRO_PLAN, requiredAnalyticsTier: "advanced" }).allowed).toBe(true);
    expect(evaluateFeature({ feature: "premiumStorefrontTemplates", plan: PRO_PLAN }).allowed).toBe(true);
    expect(evaluateFeature({ feature: "premiumStorefrontTemplates", plan: STARTER_PLAN }).allowed).toBe(false);
    expect(evaluateFeature({ feature: "made_up", plan: PRO_PLAN }).reasonCode).toBe("plan_feature_unavailable");
  });

  it("keeps trial and renewal grace time-bound", () => {
    expect(subscriptionAllows({ subscriptionState: "trialing", trialEndsAt: "2026-08-04T00:00:00.000Z", now: NOW })).toBe(true);
    expect(subscriptionAllows({ subscriptionState: "trialing", trialEndsAt: "2026-08-02T00:00:00.000Z", now: NOW })).toBe(false);
    expect(subscriptionAllows({ subscriptionState: "trialing", now: NOW })).toBe(false);
    expect(subscriptionAllows({ subscriptionState: "past_due", graceEndsAt: "2026-08-04T00:00:00.000Z", now: NOW })).toBe(true);
    expect(subscriptionAllows({ subscriptionState: "past_due", graceEndsAt: "2026-08-03T00:00:00.000Z", now: NOW })).toBe(false);
    expect(subscriptionAllows({ subscriptionState: "pending_payment", now: NOW })).toBe(false);

    expect(evaluateSubscription({ action: "provider_setup", subscriptionState: "past_due", graceEndsAt: "2026-08-04T00:00:00.000Z", now: NOW }).reasonCode).toBe("provider_not_ready");
    expect(evaluateSubscription({ action: "checkout", subscriptionState: "grace_period", graceEndsAt: "2026-08-02T00:00:00.000Z", now: NOW }).reasonCode).toBe("subscription_grace_expired");
    expect(evaluateSubscription({ action: "draft_setup", subscriptionState: "pending_payment", now: NOW }).allowed).toBe(true);
    expect(evaluateSubscription({ action: "read", subscriptionState: "suspended", now: NOW }).allowed).toBe(true);
  });

  it.each(["active", "cancel_scheduled", "upgrade_pending", "downgrade_scheduled"])(
    "allows recovery access but blocks mutations after the paid period for %s",
    (subscriptionState) => {
      const subscription = {
        currentPeriodEnd: "2026-08-02T00:00:00.000Z",
        now: NOW,
        subscriptionState,
      };
      expect(evaluateSubscription({ ...subscription, action: "read" }).allowed).toBe(true);
      expect(evaluateSubscription({ ...subscription, action: "billing" }).allowed).toBe(true);
      expect(evaluateSubscription({ ...subscription, action: "mutation" })).toMatchObject({
        allowed: false,
        reasonCode: "subscription_payment_required",
      });
    },
  );

  it("applies subscription state before feature and quota grants", () => {
    const denied = evaluateFeature({
      action: "checkout",
      feature: "storefront",
      plan: PRO_PLAN,
      subscription: { subscriptionState: "pending_payment", now: NOW },
    });
    expect(denied.reasonCode).toBe("subscription_payment_required");

    const allowed = evaluateQuota({
      action: "checkout",
      metric: "ordersPerMonth",
      plan: PRO_PLAN,
      subscription: { currentPeriodEnd: "2026-08-04T00:00:00.000Z", subscriptionState: "active", now: NOW },
      used: 4999,
    });
    expect(allowed.allowed).toBe(true);
    expect(allowed.limit).toBe(5000);

    const exhausted = evaluateQuota({ metric: "orders_created", plan: STARTER_PLAN, used: 500, requested: 1 });
    expect(exhausted.reasonCode).toBe("plan_limit_reached");
    const downgraded = evaluateQuota({ metric: "orders_created", plan: STARTER_PLAN, used: 501, requested: 0 });
    expect(downgraded.reasonCode).toBe("quota_over_limit");
    expect(evaluateQuota({ metric: "orders_created", plan: STARTER_PLAN, used: -1 }).reasonCode).toBe("quota_over_limit");
    expect(evaluateQuota({ metric: "not_a_metric", plan: PRO_PLAN, used: 0 }).reasonCode).toBe("plan_limit_reached");
  });

  it("throws AppError with a stable reason when asserting a quota", () => {
    expect(() => { assertQuota({ metric: "api_requests", plan: STARTER_PLAN, requested: 1, used: 0 }); }).toThrow(AppError);
    try {
      assertQuota({ metric: "api_requests", plan: STARTER_PLAN, requested: 1, used: 0 });
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("plan_limit_reached");
      expect((error as AppError).status).toBe(402);
    }
  });

  it("validates market/currency offers without allowing client-selected mismatches", () => {
    const baseline = getBaselinePlanOffer("starter", "vn");
    expect(baseline).toMatchObject({ amountMinor: 99000, currency: "VND", interval: "month" });
    expect(parsePlanOffer({
      ...baseline,
      effectiveFrom: NOW,
      effectiveTo: null,
      isActive: true,
      providerCode: "dodo",
      providerPriceRef: "pri_test_starter_vn",
      taxBehavior: "inclusive",
      version: 1,
    }).ok).toBe(true);
    const mismatch = parsePlanOffer({
      ...baseline,
      currency: "USD",
      effectiveFrom: NOW,
      effectiveTo: null,
      isActive: true,
      providerCode: "dodo",
      providerPriceRef: "pri_test_starter_vn",
      taxBehavior: "inclusive",
      version: 1,
    });
    expect(mismatch.ok).toBe(false);
  });
});
