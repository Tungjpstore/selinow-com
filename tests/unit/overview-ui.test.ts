import { describe, expect, it } from "vitest";

import { deriveSellerSellability, hasCompleteActionAuthority } from "../../src/lib/dashboard/overview-ui";

describe("seller overview authority", () => {
  it("does not equate an active shop row with permission to sell", () => {
    expect(deriveSellerSellability({ readinessReady: true, readinessState: "ready", shopStatus: "active" })).toBe("ready");
    expect(deriveSellerSellability({ readinessReady: false, readinessState: "ready", shopStatus: "active" })).toBe("blocked");
    expect(deriveSellerSellability({ readinessReady: false, readinessState: "unavailable", shopStatus: "active" })).toBe("unavailable");
    expect(deriveSellerSellability({ readinessReady: false, readinessState: "forbidden", shopStatus: "active" })).toBe("owner_only");
    expect(deriveSellerSellability({ readinessReady: true, readinessState: "ready", shopStatus: "draft" })).toBe("draft");
    expect(deriveSellerSellability({ readinessReady: true, readinessState: "ready", shopStatus: "suspended" })).toBe("suspended");
  });

  it("renders an all-clear queue only when every required projection loaded", () => {
    expect(hasCompleteActionAuthority({ catalogRequired: true, catalogState: "ready", ordersState: "ready", readinessState: "ready" })).toBe(true);
    expect(hasCompleteActionAuthority({ catalogRequired: true, catalogState: "unavailable", ordersState: "ready", readinessState: "ready" })).toBe(false);
    expect(hasCompleteActionAuthority({ catalogRequired: false, catalogState: "forbidden", ordersState: "ready", readinessState: "forbidden" })).toBe(false);
  });
});
