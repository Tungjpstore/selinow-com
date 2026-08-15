import { describe, expect, it } from "vitest";

import { subscriptionAllows } from "../../src/lib/billing/subscription-access";

const NOW = "2026-08-03T00:00:00.000Z";

describe("subscription access deadlines", () => {
  it("fails closed when an active subscription has no deadline", () => {
    expect(subscriptionAllows({ subscriptionState: "active", now: NOW })).toBe(false);
  });

  it.each(["active", "cancel_scheduled", "upgrade_pending", "downgrade_scheduled"])(
    "enforces an explicitly loaded paid period deadline for %s",
    (subscriptionState) => {
      expect(subscriptionAllows({ currentPeriodEnd: "2026-08-04T00:00:00.000Z", now: NOW, subscriptionState })).toBe(true);
      expect(subscriptionAllows({ currentPeriodEnd: NOW, now: NOW, subscriptionState })).toBe(false);
      expect(subscriptionAllows({ currentPeriodEnd: "2026-08-02T00:00:00.000Z", now: NOW, subscriptionState })).toBe(false);
      expect(subscriptionAllows({ currentPeriodEnd: null, now: NOW, subscriptionState })).toBe(false);
      expect(subscriptionAllows({ currentPeriodEnd: "not-a-date", now: NOW, subscriptionState })).toBe(false);
    },
  );

  it("allows trialing only before its explicit trial deadline", () => {
    expect(subscriptionAllows({ now: NOW, subscriptionState: "trialing", trialEndsAt: "2026-08-04T00:00:00.000Z" })).toBe(true);
    expect(subscriptionAllows({ now: NOW, subscriptionState: "trialing", trialEndsAt: NOW })).toBe(false);
    expect(subscriptionAllows({ now: NOW, subscriptionState: "trialing" })).toBe(false);
  });

  it("allows past due and grace period only before grace expiry", () => {
    for (const subscriptionState of ["past_due", "grace_period"]) {
      expect(subscriptionAllows({ graceEndsAt: "2026-08-04T00:00:00.000Z", now: NOW, subscriptionState })).toBe(true);
      expect(subscriptionAllows({ graceEndsAt: NOW, now: NOW, subscriptionState })).toBe(false);
      expect(subscriptionAllows({ now: NOW, subscriptionState })).toBe(false);
    }
  });

  it.each(["pending_payment", "suspended", "canceled", "unknown"])("denies %s", (subscriptionState) => {
    expect(subscriptionAllows({ now: NOW, subscriptionState })).toBe(false);
  });
});
