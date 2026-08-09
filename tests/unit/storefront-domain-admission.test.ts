import { describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { resolveStorefrontShop } from "../../src/lib/storefront/store";

type StorefrontRow = {
  brandingJson: string;
  canonicalHostname: string | null;
  currency: string;
  currentDomainType: "custom" | "platform_subdomain";
  currentHostname: string;
  defaultLocale: string;
  graceEndsAt: string | null;
  id: string;
  lowStockThreshold: number;
  name: string;
  orderExpiryMinutes: number;
  privacyUrl: string | null;
  publicId: string;
  refundPolicyUrl: string | null;
  settingsVersion: number;
  slug: string;
  status: string;
  storefrontJson: string;
  subscriptionState: string;
  supportContact: string | null;
  termsUrl: string | null;
  trialEndsAt: string | null;
  turnstileHostname: string | null;
  turnstileStatus: string | null;
};

function row(overrides: Partial<StorefrontRow> = {}): StorefrontRow {
  return {
    brandingJson: "{}",
    canonicalHostname: "shop.customer.com",
    currency: "VND",
    currentDomainType: "custom",
    currentHostname: "shop.customer.com",
    defaultLocale: "vi",
    graceEndsAt: null,
    id: "shop-a",
    lowStockThreshold: 2,
    name: "Seller A",
    orderExpiryMinutes: 30,
    privacyUrl: null,
    publicId: "shop_public_a",
    refundPolicyUrl: null,
    settingsVersion: 1,
    slug: "seller-a",
    status: "active",
    storefrontJson: "{}",
    subscriptionState: "active",
    supportContact: null,
    termsUrl: null,
    trialEndsAt: null,
    turnstileHostname: "shop.customer.com",
    turnstileStatus: "active",
    ...overrides,
  };
}

function environment(result: StorefrontRow): { env: AppBindings; sql: () => string } {
  let query = "";
  const env = {
    API_ORIGIN: "https://api.selinow.com",
    DASHBOARD_ORIGIN: "https://app.selinow.com",
    PLATFORM_BASE_DOMAIN: "selinow.com",
    PLATFORM_DB: {
      prepare(sql: string) {
        query = sql;
        return { bind: () => ({ first: () => Promise.resolve(result) }) };
      },
    },
    PLATFORM_ORIGIN: "https://selinow.com",
  } as unknown as AppBindings;
  return { env, sql: () => query };
}

describe("storefront custom-domain Turnstile admission", () => {
  it("serves only an exact admitted custom hostname and keeps the SQL boundary fail-closed", async () => {
    const runtime = environment(row());
    await expect(resolveStorefrontShop(new Request("https://shop.customer.com/"), runtime.env)).resolves.toMatchObject({
      currentHostname: "shop.customer.com",
      id: "shop-a",
    });
    expect(runtime.sql()).toContain("$.turnstile.status");
    expect(runtime.sql()).toContain("$.turnstile.hostname");
    expect(runtime.sql()).toContain("hostname_status = 'active'");
    expect(runtime.sql()).toContain("ssl_status = 'active'");
    expect(runtime.sql()).toContain("dns_status = 'active'");
  });

  it.each([
    ["missing evidence", { turnstileHostname: null, turnstileStatus: null }],
    ["pending admission", { turnstileStatus: "pending" }],
    ["other hostname evidence", { turnstileHostname: "other.customer.com" }],
  ])("rejects a legacy or mismatched custom domain with %s", async (_label, overrides) => {
    const runtime = environment(row(overrides));
    await expect(resolveStorefrontShop(new Request("https://shop.customer.com/"), runtime.env))
      .rejects.toMatchObject({ code: "storefront_not_found", status: 404 });
  });

  it("keeps platform subdomains independent from custom-host admission", async () => {
    const runtime = environment(row({
      canonicalHostname: "seller.selinow.com",
      currentDomainType: "platform_subdomain",
      currentHostname: "seller.selinow.com",
      turnstileHostname: null,
      turnstileStatus: null,
    }));
    await expect(resolveStorefrontShop(new Request("https://seller.selinow.com/"), runtime.env)).resolves.toMatchObject({
      currentHostname: "seller.selinow.com",
    });
  });
});
