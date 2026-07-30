import { describe, expect, it } from "vitest";

import {
  deriveFallbackProgress,
  hasAuthoritativeTelegramHealth,
  isSafeHttpsUrl,
  mergeServerProgress,
  parseControlledTestOrder,
  parseOnboardingSnapshot,
  parseReadinessChecks,
  progressPercent,
  readableError,
  settingsDraftReady,
  slugifyDraft,
  summarizeInventoryDraft,
  validateProductDraft,
  validateShopDraft,
} from "../../src/lib/dashboard/onboarding-ui";

describe("onboarding UI response guards", () => {
  it("parses only safe onboarding profile, settings and step fields", () => {
    const snapshot = parseOnboardingSnapshot({
      profile: { customDomainPreference: "connect", telegramEnabled: true, websiteEnabled: false },
      settings: {
        attestationAccepted: true,
        privacyUrl: "https://shop.example/privacy",
        refundPolicyUrl: "https://shop.example/refunds",
        supportContact: "support@example.test",
        termsUrl: "https://shop.example/terms",
      },
      steps: [
        { code: "catalog", status: "complete" },
        { stepCode: "inventory", status: "skipped" },
        { code: "telegram_ready", status: "pending" },
        { code: "ignored", status: "unknown" },
      ],
    });

    expect(snapshot.profile).toEqual({ customDomainPreference: "connect", telegramEnabled: true, websiteEnabled: false });
    expect(snapshot.settings?.supportContact).toBe("support@example.test");
    expect(Object.fromEntries(snapshot.steps)).toEqual({ catalog: "ready", inventory: "warning", telegram_ready: "not_started" });
    expect(parseOnboardingSnapshot({ profile: "invalid" }).profile).toBeNull();
  });

  it("parses readiness envelopes and fails unknown check statuses closed", () => {
    const readiness = parseReadinessChecks({
      run: {
        checkedAt: "2026-07-26T00:00:00.000Z",
        checks: [
          { actionUrl: "/onboarding", code: "catalog_active", messageKey: "catalog_active", required: true, status: "pass" },
          { code: "optional_domain", required: false, status: "warning" },
          { code: "unexpected", status: "maybe" },
        ],
        ready: true,
        runId: "ready_123",
      },
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.runId).toBe("ready_123");
    expect(readiness.checks.map((check) => check.status)).toEqual(["pass", "warning", "fail"]);
    expect(readiness.checks[1]?.required).toBe(false);
  });

  it("parses controlled test-order results without retaining provider or inventory secrets", () => {
    const secret = "DO-NOT-RETURN-THIS-KEY";
    const result = parseControlledTestOrder({
      testOrder: {
        checkedAt: "2026-07-26T00:00:00.000Z",
        domainHealth: { hostname: "shop.example", ready: true },
        inventoryDryRun: {
          availableCount: 5,
          code: "test_inventory_available",
          currency: "VND",
          productTitle: "Windows 11 Pro",
          quantity: 1,
          rawKey: secret,
          sufficient: true,
          totalMinor: 199000,
          variantTitle: "Một thiết bị",
        },
        passed: true,
        providerHealth: {
          payos: { apiKey: secret, configured: true, ready: true },
          telegram: { botToken: secret, configured: true, ready: true },
        },
        readiness: { ready: true },
      },
    });

    expect(result).toMatchObject({ domainReady: true, passed: true, payosConfigured: true, payosReady: true, readinessReady: true, telegramConfigured: true, telegramReady: true });
    expect(result?.inventory).toMatchObject({ availableCount: 5, quantity: 1, sufficient: true, totalMinor: 199000 });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(parseControlledTestOrder({ testOrder: { passed: true } })).toBeNull();
  });
});

describe("onboarding progress", () => {
  const completeInput = {
    activeProductCount: 1,
    availableInventoryCount: 3,
    hasManualProduct: false,
    payosReady: true,
    profile: { customDomainPreference: "later" as const, telegramEnabled: false, websiteEnabled: true },
    readinessReady: false,
    settingsReady: true,
    shopExists: true,
    shopPublished: false,
    telegramHealthReady: false,
    telegramReady: false,
  };

  it("derives resumable fallback progress and treats disabled Telegram as optional", () => {
    const progress = deriveFallbackProgress(completeInput);
    expect(progress).toMatchObject({ catalog: "ready", channels: "ready", inventory: "ready", readiness: "in_progress", telegram: "warning" });
    expect(progressPercent(progress)).toBe(88);
  });

  it("keeps the readiness step complete after a shop has already published", () => {
    expect(deriveFallbackProgress({ ...completeInput, shopPublished: true }).readiness).toBe("ready");
  });

  it("uses only the dedicated /start timestamp as Telegram health evidence", () => {
    expect(hasAuthoritativeTelegramHealth(null)).toBe(false);
    expect(hasAuthoritativeTelegramHealth("2026-07-26T00:00:00.000Z")).toBe(true);
    expect(deriveFallbackProgress({
      ...completeInput,
      profile: { customDomainPreference: "later", telegramEnabled: true, websiteEnabled: true },
      telegramHealthReady: hasAuthoritativeTelegramHealth(null),
      telegramReady: true,
    }).telegram).toBe("in_progress");
  });

  it("merges canonical and aliased server progress over local fallbacks", () => {
    const fallback = deriveFallbackProgress({ ...completeInput, activeProductCount: 0, availableInventoryCount: 0 });
    const merged = mergeServerProgress(fallback, new Map([
      ["catalog_ready", "ready" as const],
      ["readiness_passed", "ready" as const],
      ["published", "not_started" as const],
      ["telegram_ready", "in_progress" as const],
    ]));
    expect(merged.catalog).toBe("ready");
    expect(merged.readiness).toBe("ready");
    expect(merged.telegram).toBe("in_progress");
  });
});

describe("onboarding draft validation", () => {
  it("normalizes Vietnamese shop names into safe slugs", () => {
    expect(slugifyDraft("  Mây Phần Mềm Việt  ")).toBe("may-phan-mem-viet");
    expect(validateShopDraft(" Mây Software ", "may-software")).toEqual({ name: "Mây Software", slug: "may-software" });
    expect(validateShopDraft("X", "admin--shop")).toBeNull();
  });

  it("validates product, SKU, fulfillment and integer price together", () => {
    const draft = validateProductDraft({
      description: "Bản quyền chính hãng",
      fulfillmentType: "license_key",
      priceMinor: "199000",
      productSlug: "windows-11-pro",
      sku: "win11-pro",
      title: "Windows 11 Pro",
      variantTitle: "Một thiết bị",
    });
    expect(draft).toMatchObject({ priceMinor: 199000, sku: "WIN11-PRO" });
    expect(validateProductDraft({
      description: "",
      fulfillmentType: "download",
      priceMinor: "1.5",
      productSlug: "bad--slug",
      sku: "bad sku",
      title: "X",
      variantTitle: "Y",
    })).toBeNull();
  });

  it("converts decimal seller prices to the canonical minor-unit contract", () => {
    expect(validateProductDraft({
      currency: "USD",
      description: "Global price",
      fulfillmentType: "manual",
      priceMajor: "12.34",
      productSlug: "global-price",
      sku: "global-usd",
      title: "Global product",
      variantTitle: "Standard",
    })?.priceMinor).toBe(1_234);
    expect(validateProductDraft({
      currency: "JPY",
      description: "",
      fulfillmentType: "manual",
      priceMajor: "12.34",
      productSlug: "invalid-jpy",
      sku: "invalid-jpy",
      title: "Invalid JPY",
      variantTitle: "Standard",
    })).toBeNull();
  });

  it("summarizes inventory without retaining or echoing plaintext keys", () => {
    const secret = "DO-NOT-ECHO-THIS-LICENSE";
    const summary = summarizeInventoryDraft(`${secret}\nSECOND-KEY\n${secret}\n`, "paste");
    expect(summary).toEqual({ acceptedCount: 2, duplicateCount: 1, invalidCount: 0, totalCount: 3 });
    expect(JSON.stringify(summary)).not.toContain(secret);
  });

  it("requires HTTPS policy URLs and rejects insecure, credential or fragment URLs", () => {
    expect(isSafeHttpsUrl("")).toBe(false);
    expect(isSafeHttpsUrl("https://shop.example/terms")).toBe(true);
    expect(isSafeHttpsUrl("http://shop.example/terms")).toBe(false);
    expect(isSafeHttpsUrl("https://user:secret@shop.example/terms")).toBe(false);
    expect(isSafeHttpsUrl("https://shop.example/terms#private")).toBe(false);
    expect(settingsDraftReady({
      attestationAccepted: true,
      privacyUrl: "https://shop.example/privacy",
      refundPolicyUrl: "https://shop.example/refunds",
      supportContact: "support@example.test",
      termsUrl: "https://shop.example/terms",
    })).toBe(true);
  });

  it("maps provider and validation failures to safe Vietnamese guidance", () => {
    expect(readableError("validation_failed", ["bot_token_invalid"])).toContain("BotFather");
    expect(readableError("recent_auth_required")).toContain("dang nhap lai");
    expect(readableError("payment_not_configured")).toContain("PayOS");
    expect(readableError("unknown_error")).not.toContain("unknown_error");
  });
});
