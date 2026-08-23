import { describe, expect, it } from "vitest";

import {
  getDefaultMarketingMarket,
  getMarketingAvailableMarkets,
  getMarketingPlans,
  getMarketingPlanPriceForMarket,
  getMarketingPreviewPlans,
  getMarketingStructuredOffers,
  isMarketingPricingReady,
  type MarketingPlan,
  type MarketingPrice,
} from "../../src/lib/storefront/marketing";
import type { AppBindings } from "../../src/lib/platform/bindings";

function plan(code: string, prices: MarketingPlan["prices"] = []): MarketingPlan {
  return { code, features: {}, limits: {}, name: code, prices };
}

function price(marketCode: "vn" | "global", providerPriceRef: string): MarketingPrice {
  return {
    amountMinor: marketCode === "vn" ? 99_000 : 500,
    currency: marketCode === "vn" ? "VND" : "USD",
    interval: "month",
    marketCode,
    providerPriceRef,
  };
}

describe("marketing pricing runtime truthfulness", () => {
  it("does not expose pending Dodo references as public prices", async () => {
    const calls: string[] = [];
    const env = {
      PLATFORM_DB: {
        prepare(sql: string) {
          calls.push(sql);
          return {
            bind() { return this; },
            all: () => Promise.resolve(sql.includes("plan_prices")
              ? { results: [
                { id: "starter-vn", planCode: "starter", effectiveFrom: "2026-08-01T00:00:00.000Z", version: 1, marketCode: "vn", currency: "VND", amountMinor: 99_000, interval: "month", providerCode: "dodo", providerPriceRef: "pending:dodo:starter:vn:month:v1" },
                { id: "starter-global", planCode: "starter", effectiveFrom: "2026-08-01T00:00:00.000Z", version: 1, marketCode: "global", currency: "USD", amountMinor: 500, interval: "month", providerCode: "dodo", providerPriceRef: "price_starter_global" },
                { id: "pro-vn", planCode: "pro", effectiveFrom: "2026-08-01T00:00:00.000Z", version: 1, marketCode: "vn", currency: "VND", amountMinor: 299_000, interval: "month", providerCode: "dodo", providerPriceRef: "pending:dodo:pro:vn:month:v1" },
                { id: "pro-global", planCode: "pro", effectiveFrom: "2026-08-01T00:00:00.000Z", version: 1, marketCode: "global", currency: "USD", amountMinor: 1_500, interval: "month", providerCode: "dodo", providerPriceRef: "price_pro_global" },
              ] }
              : { results: [
                { code: "starter", name: "Starter", featureFlagsJson: "{}", limitsJson: "{}" },
                { code: "pro", name: "Pro", featureFlagsJson: "{}", limitsJson: "{}" },
              ] }
            ),
          };
        },
      },
    } as unknown as AppBindings;

    const plans = await getMarketingPlans(env);

    expect(calls[1]).toContain("plan_prices.effective_from <= ?");
    expect(plans.flatMap((entry) => entry.prices ?? [])).toEqual([
      expect.objectContaining({ marketCode: "global", currency: "USD" }),
      expect.objectContaining({ marketCode: "global", currency: "USD" }),
    ]);
    expect(plans.flatMap((entry) => entry.prices ?? []).every((entry) => entry.marketCode === "global")).toBe(true);
  });

  it("keeps local preview capabilities non-purchasable until Dodo IDs exist", () => {
    const plans = getMarketingPreviewPlans();

    expect(plans).toHaveLength(2);
    expect(plans.every((entry) => (entry.prices ?? []).length === 0)).toBe(true);
    expect(isMarketingPricingReady(plans)).toBe(false);
    expect(getMarketingStructuredOffers(plans)).toEqual([]);
  });

  it("rejects an in-memory pending provider reference before structured-data generation", () => {
    const plans = [
      plan("starter", [{ ...price("global", "pending:dodo:starter:global"), providerCode: "dodo", providerPriceRef: "pending:dodo:starter:global" }]),
      plan("pro", [{ ...price("global", "pending:dodo:pro:global"), providerCode: "dodo", providerPriceRef: "pending:dodo:pro:global" }]),
    ];

    expect(getMarketingAvailableMarkets(plans)).toEqual([]);
    expect(getMarketingStructuredOffers(plans)).toEqual([]);
  });

  it("falls back from a locale-preferred market to the complete available market", () => {
    const plans = [
      plan("starter", [price("global", "price_starter_global")]),
      plan("pro", [price("global", "price_pro_global")]),
    ];

    expect(getMarketingAvailableMarkets(plans)).toEqual(["global"]);
    expect(getDefaultMarketingMarket(plans, "vi-VN")).toBe("global");
    expect(isMarketingPricingReady(plans)).toBe(true);
    expect(getMarketingStructuredOffers(plans)).toHaveLength(2);
  });

  it("selects exactly one published offer for the server-rendered market", () => {
    const starter = plan("starter", [
      price("vn", "price_starter_vn"),
      price("global", "price_starter_global"),
    ]);

    expect(getMarketingPlanPriceForMarket(starter, "vn")).toMatchObject({ currency: "VND", marketCode: "vn" });
    expect(getMarketingPlanPriceForMarket(starter, "global")).toMatchObject({ currency: "USD", marketCode: "global" });
    expect(getMarketingPlanPriceForMarket(plan("starter", [price("vn", "pending:dodo:starter:vn")]), "vn")).toBeNull();
  });

  it("blocks structured offers when plans do not share a complete market", () => {
    const plans = [
      plan("starter", [price("vn", "price_starter_vn")]),
      plan("pro", [price("global", "price_pro_global")]),
    ];

    expect(getMarketingAvailableMarkets(plans)).toEqual([]);
    expect(isMarketingPricingReady(plans)).toBe(false);
    expect(getMarketingStructuredOffers(plans)).toEqual([]);
  });
});
