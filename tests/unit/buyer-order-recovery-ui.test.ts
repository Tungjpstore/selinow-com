import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("buyer order recovery UI contract", () => {
  it("requires a recovery email before any Website checkout can be submitted", async () => {
    const checkoutPage = await readFile("src/pages/checkout.astro", "utf8");

    expect(checkoutPage).toMatch(/id="customer-email"[^>]*\brequired\b/u);
  });

  it("exchanges a fragment token, clears it immediately, and renders a generic recovery form", async () => {
    const [script, page, catalog] = await Promise.all([
      readFile("src/scripts/storefront/order.ts", "utf8"),
      readFile("src/pages/orders/[orderPublicId].astro", "utf8"),
      readFile("src/lib/i18n/catalogs/storefront.ts", "utf8"),
    ]);

    expect(script).toContain('get("recovery")');
    expect(script).toContain(`/recovery/consume`);
    expect(script).toContain("history.replaceState");
    expect(script.indexOf("history.replaceState")).toBeLessThan(script.indexOf(`/recovery/consume`));
    expect(script).toContain('fetch(`/api/store/orders/${encodeURIComponent(orderId)}/recovery`');
    expect(script).toContain('t("storefront.order.recovery.accepted")');
    expect(script).toContain('type = "email"');
    expect(page).toContain('Astro.response.headers.set("Referrer-Policy", "no-referrer")');
    expect(catalog).toContain('"storefront.order.recovery.email_subject"');
    expect(catalog).toContain('"storefront.order.recovery.accepted"');
  });

  it("requests a non-blocking recovery email after checkout while preserving session access", async () => {
    const checkout = await readFile("src/scripts/storefront/checkout.ts", "utf8");
    expect(checkout).toContain(`/recovery`);
    expect(checkout).toContain("keepalive: true");
    expect(checkout).toContain("accessStorage.set");
    expect(checkout).toContain("#access=");
    expect(checkout).toMatch(/void requestOrderRecoveryEmail\([^)]+\);/u);
  });

  it("keeps all order API responses private and strips referrer data", async () => {
    const route = await readFile("src/pages/api/store/orders/[orderPublicId].ts", "utf8");
    expect(route).toContain('"Referrer-Policy": "no-referrer"');
    expect(route).toContain('response.headers.set("Referrer-Policy", "no-referrer")');
  });

  it("does not make recovered access depend on writable session storage", async () => {
    const [order, checkout] = await Promise.all([
      readFile("src/scripts/storefront/order.ts", "utf8"),
      readFile("src/scripts/storefront/checkout.ts", "utf8"),
    ]);

    expect(order).toContain("createBrowserOrderAccessStorage");
    expect(order).not.toMatch(/sessionStorage\.(?:getItem|setItem|removeItem)/u);
    expect(checkout).toContain("createBrowserOrderAccessStorage");
    expect(checkout).not.toContain("sessionStorage.setItem(`selinow-order-token");
  });
});
