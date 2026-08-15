import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { domainState, paymentState, telegramState, unavailableState } from "../../src/lib/dashboard/integrations-view";

describe("integrations frontend contract", () => {
  it("uses AppLayout tenant context and server-backed SSR projections", async () => {
    const [page, developer] = await Promise.all([
      readFile("src/pages/app/integrations.astro", "utf8"),
      readFile("src/pages/app/developer.astro", "utf8"),
    ]);

    expect(page).toContain("selectShopForMember");
    expect(page).toContain("getTelegramIntegration");
    expect(page).toContain("getPaymentIntegration");
    expect(page).toContain("listShopDomains");
    expect(page).not.toContain("data-shop-tab");
    expect(page).not.toContain("data-shop-rail");
    expect(page).not.toContain("initialShopId");
    expect(page).not.toContain('data-provider-row="webhooks"');
    expect(page).not.toContain('data-provider-row="email"');
    expect(page).toContain("unavailableState");
    expect(page).toContain("data-can-read-providers");
    expect(page).toContain("data-can-refresh-telegram");
    expect(page).toContain("data-can-read-domains");
    expect(page).toContain("const canManageProviders = shop?.role === \"owner\";");
    expect(page).toContain("const canManageChannelConnectors = shop?.role === \"owner\" || shop?.role === \"manager\";");
    expect(page).toContain("data-channel-expansion-section");
    expect(page).toContain("data-can-manage-channel-connectors");
    expect(developer).toContain("data-can-manage-api-credentials");
    expect(developer).toContain("data-api-credentials-section");
    expect(developer).toContain("dashboard.integrations.api_credentials");
    expect(developer).toContain('value="inventory:read"');
    expect(developer).toContain('value="orders:read"');
  });

  it("keeps provider views safe and truthful for unavailable access", () => {
    expect(unavailableState("Telegram", "vi-VN")).toMatchObject({ label: "Không có quyền đọc", tone: "warning" });
    expect(telegramState(null, undefined, "vi-VN").summary).toBe("Bot chưa được kết nối.");
    expect(paymentState({ status: "active", webhookStatus: "verified", lastCheckedAt: null, lastSafeErrorCode: null }, undefined, "vi-VN").label).toBe("Đang hoạt động");
    expect(domainState([{ hostname: "shop.example.test", isPrimary: 1, lastCheckedAt: null, status: "active", type: "custom" }], undefined, "vi-VN").summary).toContain("địa chỉ chính");
    expect(unavailableState("Telegram").label).toBe("Cannot read");
  });

  it("keeps credentials out of the progressive enhancement payload", async () => {
    const [script, developerScript] = await Promise.all([
      readFile("src/scripts/dashboard/integrations.ts", "utf8"),
      readFile("src/scripts/dashboard/developer.ts", "utf8"),
    ]);

    expect(script).toContain("form.reset()");
    expect(script).toContain("credentials: \"same-origin\"");
    expect(developerScript).toContain("/api-credentials");
    expect(developerScript).toContain("Idempotency-Key");
    expect(developerScript).toContain("tokenAvailable");
    expect(script).toContain("/channels");
    expect(script).toContain("/catalog");
    expect(script).toContain("/requests");
    expect(script).toContain("inlineSecretDelivery");
    expect(script).not.toContain("console.log");
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("sessionStorage");
  });

  it("keeps provider credentials owner-only while exposing safe manager read/health controls", async () => {
    const [page, script] = await Promise.all([
      readFile("src/pages/app/integrations.astro", "utf8"),
      readFile("src/scripts/dashboard/integrations.ts", "utf8"),
    ]);
    expect(page).toContain("canReadProviders ? telegramView.summary : unavailableTelegram.summary");
    expect(page).toContain("canRefreshTelegram && telegram !== null");
    expect(page).toContain("canManageProviders && telegramConnected");
    expect(page).toContain('data-reason-code={canReadProviders ? "owner_required" : "permission_unavailable"}');
    expect(page).toContain("canReadDomains ? domainsView.summary : unavailableDomains.summary");
    expect(script).toContain("const canReadProviders = root.dataset.canReadProviders === \"true\";");
    expect(script).toContain("provider === \"telegram\" && !canRefreshTelegram");
    expect(script).toContain("disconnect.hidden = !canManageProviders || !connected");
    expect(script).toContain("if (canReadProviders)");
    expect(script).toContain("if (canReadDomains)");
  });

  it("drops stale tenant responses when a shop switch races an integration request", async () => {
    const [script, developerScript] = await Promise.all([
      readFile("src/scripts/dashboard/integrations.ts", "utf8"),
      readFile("src/scripts/dashboard/developer.ts", "utf8"),
    ]);

    expect(script).toContain("class TenantChangedError extends Error");
    expect(script).toContain("const tenantSignature = (): string");
    expect(script).toContain("const resetTenantBoundState = (): void");
    expect(script).toContain("const assertTenantContext = (requestSignature: string)");
    expect(script).toContain("assertTenantContext(requestSignature);");
    expect(script).toContain("window.addEventListener(\"popstate\", () => { ensureTenantContext(); });");
    expect(script).toContain("channelExpansionGrid?.replaceChildren();");
    expect(developerScript).toContain("apiCredentialList?.replaceChildren();");
    expect(script).toContain("if (isTenantChangedError(error)) return;");
  });
});
