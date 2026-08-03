import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { getCatalogParity } from "../../src/lib/i18n/catalog";
import { createMarketingTranslator, marketingCatalogs } from "../../src/lib/i18n/catalogs/marketing";
import { formatMarketingPrice, planFeatureList, type MarketingPlan } from "../../src/lib/storefront/marketing";

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

  it("keeps public positioning inside the Phase 1 product boundary", async () => {
    const [landing, solutions] = await Promise.all([
      readFile("src/pages/index.astro", "utf8"),
      readFile("src/lib/content/solutions.ts", "utf8"),
    ]);
    const bannedActiveClaims = [
      /global commerce/iu,
      /global-first/iu,
      /omnichannel/iu,
      /every customer channel/iu,
      /every sales channel/iu,
      /support copilot/iu,
      /paid communit(?:y|ies)/iu,
      /AI agent/iu,
      /workflow automation/iu,
      /Mini App/iu,
    ];
    for (const pattern of bannedActiveClaims) {
      expect(landing).not.toMatch(pattern);
      expect(solutions).not.toMatch(pattern);
    }
    expect(landing).toContain('state: "live"');
    expect(landing).toContain('state: "next"');
    expect(landing).toContain('mt("marketing.home.channels.status.next")');
    expect(landing).toContain('<small>{channel[1]}</small>');
    expect(solutions).toContain("future providers remain separately gated until accepted");
  });

  it("keeps public SEO route metadata and manifest claims explicit", async () => {
    const [layout, robots, sitemap, llms, manifest] = await Promise.all([
      readFile("src/layouts/PlatformLayout.astro", "utf8"),
      readFile("src/pages/robots.txt.ts", "utf8"),
      readFile("src/pages/sitemap.xml.ts", "utf8"),
      readFile("src/pages/llms.txt.ts", "utf8"),
      readFile("public/site.webmanifest", "utf8"),
    ]);
    expect(layout).toContain('<link rel="canonical" href={canonicalUrl} />');
    expect(layout).toContain('hreflang={alternate.hreflang}');
    expect(layout).toContain('type="application/ld+json"');
    expect(robots).toContain('"/checkout"');
    expect(robots).toContain("Sitemap: ${SITE_ORIGIN}/sitemap.xml");
    expect(sitemap).toContain("/solutions");
    expect(sitemap).toContain("solutionSlugs.map");
    expect(llms).toContain("Website and Telegram");
    expect(llms).toContain("planned or expanding channels");
    expect(manifest).toContain("Website and Telegram");
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

  it("keeps local pricing CTAs on the active marketing server port", async () => {
    const pricing = await readFile("src/pages/pricing.astro", "utf8");

    expect(pricing).toContain("const dashboardOrigin = (() => {");
    expect(pricing).toContain('configured.hostname = "app.localhost";');
    expect(pricing).toContain("configured.port = requestUrl.port;");
    expect(pricing).not.toContain("<MarketingHeader dashboardOrigin={env.DASHBOARD_ORIGIN}");
    expect(pricing).not.toContain('href={`${env.DASHBOARD_ORIGIN}/login`} data-pricing-cta');
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

  it("projects server-owned market prices without embedding commercial amounts in the UI", async () => {
    const [pricing, landing, billing] = await Promise.all([
      readFile("src/pages/pricing.astro", "utf8"),
      readFile("src/pages/index.astro", "utf8"),
      readFile("src/scripts/dashboard/billing.ts", "utf8"),
    ]);
    expect(formatMarketingPrice({ amountMinor: 99_000, currency: "VND", interval: "month", marketCode: "vn" }, "vi-VN")).toContain("99.000");
    expect(formatMarketingPrice({ amountMinor: 500, currency: "USD", interval: "month", marketCode: "global" }, "en")).toContain("5.00");
    for (const source of [pricing, landing, billing]) {
      expect(source).not.toContain("99.000");
      expect(source).not.toContain("299.000");
      expect(source).not.toContain("$5");
      expect(source).not.toContain("$15");
    }
    expect(pricing).toContain("plan.prices");
    expect(pricing).toContain("data-market={price.marketCode}");
    expect(pricing).toContain("data-pricing-market-root");
    expect(pricing).toContain("data-pricing-offer");
    expect(landing).toContain("formatMarketingPrice(price, locale)");
    expect(billing).toContain("priceFrom");
  });

  it("keeps trial, pending-payment, grace and suspended states visible in billing projection", async () => {
    const [page, controller] = await Promise.all([
      readFile("src/pages/app/billing.astro", "utf8"),
      readFile("src/scripts/dashboard/billing.ts", "utf8"),
    ]);
    expect(page).toContain('data-billing-state={billing.state}');
    expect(page).toContain('billing.state === "trialing"');
    expect(page).toContain('billing.state === "pending_payment"');
    expect(page).toContain('billing.state === "suspended"');
    expect(page).toContain("dashboard.billing.trial_conversion_cta");
    expect(page).toContain("data-billing-checkout");
    expect(controller).toContain("/billing/checkout");
    expect(controller).toContain("checkoutUrl");
    expect(controller).toContain('billingState === "pending_payment"');
    expect(controller).toContain('billingState === "suspended"');
    expect(controller).toContain('recovery: billingState === "suspended"');
  });
});
