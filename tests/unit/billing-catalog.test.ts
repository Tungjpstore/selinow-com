import { describe, expect, it } from "vitest";

import {
  isPublishedProviderPriceReference,
  isSellablePlanOffer,
  projectLatestSellablePlanOffers,
  projectSellablePlanOffer,
  SELLABLE_PLAN_OFFER_SQL_PREDICATE,
  SELLABLE_PUBLIC_PLAN_SQL_PREDICATE,
} from "../../src/lib/billing/catalog";

describe("sellable billing catalog contract", () => {
  it("recognizes provider references as published independently of provider identity", () => {
    expect(isPublishedProviderPriceReference("dodo_pri_starter_vn_v1")).toBe(true);
    expect(isPublishedProviderPriceReference("pending:dodo:starter:vn:month:v1")).toBe(false);
    expect(isPublishedProviderPriceReference("payos_price_starter_vn")).toBe(true);
    expect(isPublishedProviderPriceReference("provider reference with spaces")).toBe(false);
  });

  it("does not fall back to an older published offer when the newest revision is pending", () => {
    expect(projectLatestSellablePlanOffers([
      {
        amountMinor: 500,
        currency: "USD",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        id: "price-starter-v1",
        interval: "month",
        marketCode: "global",
        planCode: "starter",
        providerCode: "dodo",
        providerPriceRef: "dodo_pri_starter_global_v1",
        version: 1,
      },
      {
        amountMinor: 700,
        currency: "USD",
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        id: "price-starter-v2",
        interval: "month",
        marketCode: "global",
        planCode: "starter",
        providerCode: "dodo",
        providerPriceRef: "pending:dodo:starter:global:month:v2",
        version: 2,
      },
    ])).toEqual([]);
  });

  it("projects a canonical offer only from a sellable Dodo row", () => {
    expect(projectSellablePlanOffer({
      amountMinor: 99_000,
      currency: "VND",
      interval: "month",
      marketCode: "vn",
      providerCode: "dodo",
      providerPriceRef: "dodo_pri_starter_vn_v1",
    })).toEqual({ amountMinor: 99_000, currency: "VND", interval: "month", marketCode: "vn" });
    expect(isSellablePlanOffer({
      amountMinor: 99_000,
      currency: "VND",
      interval: "month",
      marketCode: "vn",
      providerCode: "payos",
      providerPriceRef: "payos_price_starter_vn",
    })).toBe(false);
  });

  it("keeps SQL selection semantics provider- and time-bound", () => {
    expect(SELLABLE_PUBLIC_PLAN_SQL_PREDICATE).toContain("plans.is_assignable = 1");
    expect(SELLABLE_PLAN_OFFER_SQL_PREDICATE).toContain("provider_code = 'dodo'");
    expect(SELLABLE_PLAN_OFFER_SQL_PREDICATE).toContain("provider_price_ref NOT LIKE 'pending:%'");
    expect(SELLABLE_PLAN_OFFER_SQL_PREDICATE).toContain("effective_from <= ?");
    expect(SELLABLE_PLAN_OFFER_SQL_PREDICATE).toContain("effective_to IS NULL OR plan_prices.effective_to > ?");
  });
});
