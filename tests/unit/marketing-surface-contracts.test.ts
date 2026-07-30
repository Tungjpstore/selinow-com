import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getCatalogParity } from "../../src/lib/i18n/catalog";
import { createMarketingTranslator, marketingCatalogs } from "../../src/lib/i18n/catalogs/marketing";
import { planFeatureList, type MarketingPlan } from "../../src/lib/storefront/marketing";

describe("PromptOS marketing surfaces", () => {
  it("keeps the landing hierarchy, runtime pricing fallback and product-owned recommendation", async () => {
    const [landing, header] = await Promise.all([
      readFile("src/pages/index.astro", "utf8"),
      readFile("src/components/marketing/MarketingHeader.astro", "utf8"),
    ]);

    expect(landing).toContain('mt("marketing.home.hero.title")');
    expect(landing).toContain('mt("marketing.home.hero.secondary")');
    expect(landing).toContain('mt("marketing.home.flow.payment")');
    expect(landing).toContain('mt("marketing.home.flow.payment_detail")');
    expect(landing).toContain('mt("marketing.home.flow.delivery_detail")');
    expect(landing).toContain('data-pricing-state={pricingState}');
    expect(landing).toContain("marketing.pricing_unavailable");
    expect(landing).not.toContain('plan.code === "store"');
    expect(header).toContain('class="platform-nav-mobile-login"');
    expect(header).toContain('data-marketing-menu-trigger');
    expect(header).toContain('aria-expanded="false"');
    expect(header).toContain('t("marketing.header.cta")');
  });

  it("renders pricing comparison groups without inventing absent runtime entitlements", async () => {
    const pricing = await readFile("src/pages/pricing.astro", "utf8");

    for (const group of ["store", "orders", "domains", "telegram", "team", "automation", "audit"]) {
      expect(pricing).toContain(`t("marketing.pricing.group.${group}")`);
    }
    expect(pricing).toContain('t("marketing.pricing.capability.no")');
    expect(pricing).toContain('t("marketing.pricing.capability.unpublished")');
    expect(pricing).not.toContain('plan.code === "store"');
  });

  it("covers passwordless login feedback and local-only debug navigation", async () => {
    const [page, controller] = await Promise.all([
      readFile("src/pages/login.astro", "utf8"),
      readFile("src/scripts/marketing/login.ts", "utf8"),
    ]);

    expect(page).toContain('type="email"');
    expect(page).not.toContain('type="password"');
    expect(page).toContain('aria-live="polite" aria-atomic="true"');
    expect(page).toContain('Astro.response.headers.set("X-Robots-Tag", "noindex, nofollow")');
    expect(controller).toContain('hostname.endsWith(".localhost")');
    expect(controller).toContain('linkUrl.pathname !== "/api/auth/magic-link/consume"');
    expect(controller).toContain('link.textContent = t("auth.login.debug_link")');
    expect(controller).toContain("rate_limited");
    expect(controller).toContain("provider_unavailable");
    expect(controller).not.toContain("console.");
  });

  it("formats all available runtime limits with their units and reset period", () => {
    const plan: MarketingPlan = {
      code: "runtime",
      features: { customDomain: true, storefront: true, telegram: true },
      limits: { customDomains: 2, ordersPerMonth: 1500, products: 120, staffSeats: 4 },
      name: "Runtime",
    };

    expect(planFeatureList(plan, "vi-VN")).toEqual([
      "Telegram bot riêng cho cửa hàng",
      "Storefront theo subdomain",
      "Tên miền riêng trong gói",
      "120 sản phẩm / cửa hàng",
      "1.500 đơn / tháng",
      "4 tài khoản / cửa hàng",
      "2 tên miền / cửa hàng",
    ]);
    expect(planFeatureList(plan, "en")).toEqual([
      "A dedicated Telegram bot for the store",
      "Storefront on a subdomain",
      "Custom domain included",
      "120 products / store",
      "1,500 orders / month",
      "4 accounts / store",
      "2 domains / store",
    ]);
  });

  it("keeps marketing catalogs in parity and falls back to English safely", () => {
    expect(getCatalogParity(marketingCatalogs)).toEqual({
      extra: { en: [], "vi-VN": [] },
      missing: { en: [], "vi-VN": [] },
    });
    expect(createMarketingTranslator("vi-VN")("marketing.header.pricing")).toBe("Bảng giá");
    expect(createMarketingTranslator("fr-FR")("marketing.header.pricing")).toBe("Pricing");
    expect(createMarketingTranslator("en")("marketing.unknown")).toBe("");
  });
});
