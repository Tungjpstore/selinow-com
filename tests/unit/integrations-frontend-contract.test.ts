import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { domainState, paymentState, telegramState, unavailableState } from "../../src/lib/dashboard/integrations-view";

describe("integrations frontend contract", () => {
  it("uses AppLayout tenant context and server-backed SSR projections", async () => {
    const page = await readFile("src/pages/app/integrations.astro", "utf8");

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
  });

  it("keeps provider views safe and truthful for unavailable access", () => {
    expect(unavailableState("Telegram", "vi-VN")).toMatchObject({ label: "Không có quyền đọc", tone: "warning" });
    expect(telegramState(null, undefined, "vi-VN").summary).toBe("Bot chưa được kết nối.");
    expect(paymentState({ status: "active", webhookStatus: "verified", lastCheckedAt: null, lastSafeErrorCode: null }, undefined, "vi-VN").label).toBe("Đang hoạt động");
    expect(domainState([{ hostname: "shop.example.test", isPrimary: 1, lastCheckedAt: null, status: "active", type: "custom" }], undefined, "vi-VN").summary).toContain("địa chỉ chính");
    expect(unavailableState("Telegram").label).toBe("Cannot read");
  });

  it("keeps credentials out of the progressive enhancement payload", async () => {
    const script = await readFile("src/scripts/dashboard/integrations.ts", "utf8");

    expect(script).toContain("form.reset()");
    expect(script).toContain("credentials: \"same-origin\"");
    expect(script).not.toContain("console.log");
    expect(script).not.toContain("localStorage");
    expect(script).not.toContain("sessionStorage");
  });
});
