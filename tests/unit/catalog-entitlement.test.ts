import { describe, expect, it } from "vitest";

import { sellablePublicPlanHasFeature } from "../../src/lib/billing/catalog";
import type { AppBindings } from "../../src/lib/platform/bindings";

function envFor(row: Record<string, unknown> | null): AppBindings {
  return {
    PLATFORM_DB: {
      prepare(sql: string) {
        return {
          bind() { return this; },
          first: () => Promise.resolve(row),
          sql,
        };
      },
    },
  } as unknown as AppBindings;
}

describe("sellable public plan entitlement projection", () => {
  it("fails closed when the Pro catalog migration is absent", async () => {
    const allowed = await sellablePublicPlanHasFeature(envFor({
      code: "pro",
      featureFlagsJson: '{"analytics":"advanced","storefront":true}',
      limitsJson: "{}",
      name: "Pro",
      version: 1,
    }), "pro", "premiumStorefrontTemplates");

    expect(allowed).toBe(false);
  });

  it("reads only the normalized boolean from the active assignable catalog", async () => {
    const allowed = await sellablePublicPlanHasFeature(envFor({
      code: "pro",
      featureFlagsJson: '{"premiumStorefrontTemplates":true}',
      limitsJson: "{}",
      name: "Pro",
      version: 2,
    }), "pro", "premiumStorefrontTemplates");

    expect(allowed).toBe(true);
  });

  it("rejects a missing or non-sellable catalog row", async () => {
    await expect(sellablePublicPlanHasFeature(envFor(null), "pro", "premiumStorefrontTemplates"))
      .resolves.toBe(false);
  });
});
