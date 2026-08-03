import { describe, expect, it } from "vitest";

import { assertCheckoutAllowed, assertRoleCapability, hasFeature, normalizeSlug } from "../../src/lib/tenants/policy";
import { TenantIsolationHarness } from "../helpers/tenant-harness";

describe("tenant and subscription guards", () => {
  it("rejects reserved and malformed slugs", () => {
    expect(() => normalizeSlug("admin")).toThrow();
    expect(() => normalizeSlug("Bad Slug")).toThrow();
    expect(normalizeSlug("cua-hang-01")).toBe("cua-hang-01");
  });

  it("keeps role capabilities server-owned", () => {
    expect(() => {
      assertRoleCapability("viewer", "shop:update");
    }).toThrow();
    expect(() => {
      assertRoleCapability("manager", "shop:update");
    }).not.toThrow();
    expect(() => {
      assertRoleCapability("manager", "integrations:manage");
    }).not.toThrow();
    expect(() => {
      assertRoleCapability("manager", "integrations:credentials");
    }).toThrow(expect.objectContaining({ code: "authorization_denied" }));
    expect(() => {
      assertRoleCapability("manager", "payments:manage");
    }).toThrow(expect.objectContaining({ code: "authorization_denied" }));
    for (const role of ["owner", "manager"] as const) {
      expect(() => {
        assertRoleCapability(role, "fulfillment:manage");
      }).not.toThrow();
    }
    for (const role of ["support", "viewer"] as const) {
      expect(() => {
        assertRoleCapability(role, "fulfillment:manage");
      }).toThrow(expect.objectContaining({ code: "authorization_denied" }));
    }
    expect(() => {
      assertRoleCapability("owner", "domains:manage");
    }).not.toThrow();
    for (const role of ["manager", "support", "viewer"] as const) {
      expect(() => {
        assertRoleCapability(role, "domains:manage");
      }).toThrow(expect.objectContaining({ code: "authorization_denied" }));
    }
    expect(() => {
      assertRoleCapability("manager", "domains:read");
    }).not.toThrow();
    expect(() => {
      assertRoleCapability("support", "domains:read");
    }).toThrow(expect.objectContaining({ code: "authorization_denied" }));
    for (const role of ["support", "viewer"] as const) {
      expect(() => {
        assertRoleCapability(role, "customers:read");
      }).toThrow(expect.objectContaining({ code: "authorization_denied" }));
    }
    expect(() => {
      assertRoleCapability("support", "customers:read:masked");
    }).not.toThrow();
    expect(() => {
      assertRoleCapability("viewer", "customers:read:summary");
    }).not.toThrow();
  });

  it("requires a literal true feature entitlement", () => {
    expect(hasFeature('{"customDomain":true}', "customDomain")).toBe(true);
    expect(hasFeature('{"customDomain":"addon"}', "customDomain")).toBe(false);
    expect(hasFeature('{"customDomain":1}', "customDomain")).toBe(false);
    expect(hasFeature('{"customDomain":"true"}', "customDomain")).toBe(false);
  });

  it("blocks checkout for a suspended shop", () => {
    expect(() => {
      assertCheckoutAllowed({ shopStatus: "suspended", subscriptionState: "active" });
    }).toThrow(expect.objectContaining({ code: "tenant_suspended" }));
  });

  it("prevents tenant A from reading or mutating tenant B", () => {
    const harness = new TenantIsolationHarness();
    harness.addShop({ id: "shop-a", name: "A", ownerUserId: "user-a" });
    harness.addShop({ id: "shop-b", name: "B", ownerUserId: "user-b" });

    expect(() => harness.readShop("user-a", "shop-b")).toThrow(
      expect.objectContaining({ code: "authorization_denied" }),
    );
    expect(() => harness.updateShopName("user-a", "shop-b", "stolen")).toThrow();
    expect(harness.readShop("user-b", "shop-b").name).toBe("B");
  });
});
