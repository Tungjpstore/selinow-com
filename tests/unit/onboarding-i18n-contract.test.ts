import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getCatalogParity } from "../../src/lib/i18n/catalog";
import {
  getOnboardingClientCopy,
  onboardingCatalogs,
} from "../../src/lib/i18n/catalogs/onboarding";
import { WIZARD_STEPS } from "../../src/lib/dashboard/onboarding-ui";

describe("onboarding localization contract", () => {
  it("keeps English and Vietnamese catalogs in exact parity", () => {
    expect(getCatalogParity(onboardingCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
  });

  it("serializes only resolved client copy and keeps English fallback safe", () => {
    const english = getOnboardingClientCopy("en");
    const vietnamese = getOnboardingClientCopy("vi-VN");
    expect(english["onboarding.intro.heading_line1"]).toBe("Open a store,");
    expect(vietnamese["onboarding.intro.heading_line1"]).toBe("Mở cửa hàng,");
    expect(JSON.stringify(english)).not.toContain("Mở cửa hàng");
    expect(JSON.stringify(english)).not.toContain("botToken");
    expect(getOnboardingClientCopy("unsupported")["onboarding.intro.heading_line1"]).toBe("Open a store,");
  });

  it("keeps every wizard step addressable by a translated label key", () => {
    const english = getOnboardingClientCopy("en");
    for (const step of WIZARD_STEPS) {
      expect(english[step.labelKey]).toBeTypeOf("string");
      expect(english[step.labelKey].length).toBeGreaterThan(0);
    }
  });

  it("keeps onboarding price copy and catalog parsing tenant-currency aware", () => {
    const english = getOnboardingClientCopy("en");
    const vietnamese = getOnboardingClientCopy("vi-VN");
    expect(english["onboarding.catalog.price_label"]).toBe("Price ({currency})");
    expect(vietnamese["onboarding.catalog.price_label"]).toBe("Giá bán ({currency})");

    const client = readFileSync("src/scripts/dashboard/onboarding.ts", "utf8");
    expect(client).toContain("parseCatalog(results[1].value, shop.currency)");
    expect(client).toContain("typeof row.currency === \"string\" ? row.currency : fallbackCurrency");
    expect(client).toContain("data-product-price-label");
    expect(client).toContain("currency: shop.currency");
    expect(client).toContain("priceMajor:");
    expect(client).not.toContain('row.currency : "VND"');
  });

  it("exposes authoritative country, currency, and locale settings on create and update", () => {
    const client = readFileSync("src/scripts/dashboard/onboarding.ts", "utf8");

    expect(client).toContain('method: "PATCH"');
    expect(client).toContain("readShopGlobalizationForm");
    expect(client).toContain("Object.assign(shop, profileResponse.shop)");
  });

  it("saves regional settings independently from legal readiness", () => {
    const client = readFileSync("src/scripts/dashboard/onboarding.ts", "utf8");
    expect(client).toContain("changedShopGlobalization(shop, globalization)");
    expect(client).toContain("body: JSON.stringify(patch)");
    expect(client).not.toContain("const globalizationChanged =");
  });

  it("keeps onboarding plan options aligned with the authenticated shop API", () => {
    const client = readFileSync("src/scripts/dashboard/onboarding.ts", "utf8");
    const route = readFileSync("src/pages/api/app/shops/index.ts", "utf8");
    expect(client).toContain("parsePublicPlanCodes(root.dataset.publicPlanCodes)");
    expect(client).toContain("renderPlanOptions(root, plans, planCodes)");
    expect(client).toContain("planFeatureLabel(feature, plan.features[feature])");
    expect(client).not.toContain('shop.planCode === "bot"');
    expect(route).toContain("PUBLIC_PLAN_CODES");
    expect(route).toContain(".bind(...PUBLIC_PLAN_CODES)");
    expect(route).toContain(".bind(...PUBLIC_PLAN_CODES, nowIso, nowIso)");
    expect(route).not.toContain("code IN ('starter', 'pro')");
    expect(route).toContain("is_public = 1 AND is_assignable = 1");
    expect(client).toContain('requestApi(root, "/api/app/shops", { method: "GET" })');
    expect(client).toContain("formatMoney(offer.amountMinor, offer.currency, activeLocale)");
  });

  it("uses server-owned creation admission for new shops and canceled billing recovery", () => {
    const client = readFileSync("src/scripts/dashboard/onboarding.ts", "utf8");
    const page = readFileSync("src/pages/onboarding.astro", "utf8");
    const route = readFileSync("src/pages/api/app/shops/index.ts", "utf8");
    expect(page).toContain("getShopCreationAdmission");
    expect(route).toContain("getShopCreationAdmission");
    expect(route).toContain("creationAdmission");
    expect(client).toContain("parseShopCreationAdmission");
    expect(client).toContain('window.location.assign(`/app/billing?shop=${encodeURIComponent(recoveryShopPublicId)}`)');
    expect(client).toContain('shop.subscriptionState === "pending_payment"');
    expect(client).toContain('error.issues.includes("billing_recovery_required")');
    expect(client).not.toContain('error.issues.includes("trial_already_used")');
    expect(client).toContain("creationMode");
    expect(client).toContain("return crypto.randomUUID()");
  });

  it("binds shop creation abuse admission to the authenticated subject and Cloudflare requester signal", () => {
    const route = readFileSync("src/pages/api/app/shops/index.ts", "utf8");
    const store = readFileSync("src/lib/tenants/store.ts", "utf8");
    expect(route).toContain("cloudflareRequesterAddress(request)");
    expect(route).toContain("requesterAddress:");
    expect(store).toContain("claimShopCreationAdmission");
    expect(route).not.toContain("request.headers.get(\"CF-Connecting-IP\")");
  });

  it("never invents a platform policy attestation version in the browser", () => {
    const client = readFileSync("src/scripts/dashboard/onboarding.ts", "utf8");
    expect(client).toContain("policyAttestationVersion");
    expect(client).not.toContain("attestationVersion: 1");
  });
});
