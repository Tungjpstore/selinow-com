import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const commerceDirectory = join(process.cwd(), "src/lib/commerce");
const storeApiDirectory = join(process.cwd(), "src/pages/api/store");

function source(filename: string): string {
  return readFileSync(join(commerceDirectory, filename), "utf8");
}

function importsFrom(value: string, path: string): boolean {
  return new RegExp(`from\\s+["']${path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}["']`, "u").test(value);
}

function routeFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) return routeFiles(join(directory, entry.name), relative);
    return entry.name.endsWith(".ts") ? [relative] : [];
  });
}

function commerceRouteFiles(): string[] {
  return routeFiles(storeApiDirectory)
    .filter((route) => (
      route === "cart.ts"
      || route === "checkout.ts"
      || route.startsWith("checkout/")
      || route === "quote.ts"
      || route === "orders/[orderPublicId].ts"
      || route.startsWith("orders/[orderPublicId]/")
    ))
    .sort();
}

describe("canonical checkout transaction boundary", () => {
  it("routes Website and Telegram through the same canonical transaction implementation", () => {
    const transaction = source("checkout-transaction.ts");
    const store = source("store.ts");
    const website = source("website-port.ts");
    const telegram = source("telegram-port.ts");
    const principal = source("principal-channel-port.ts");

    expect(transaction).toMatch(/export\s+async\s+function\s+executeCanonicalCheckoutTransaction\b/u);

    const storeDelegates = importsFrom(store, "./checkout-transaction")
      && /\bexecuteCanonicalCheckoutTransaction\s*\(/u.test(store);
    const websiteDelegates = importsFrom(website, "./checkout-transaction")
      && /\bexecuteCanonicalCheckoutTransaction\s*\(/u.test(website);
    const telegramDelegates = importsFrom(telegram, "./checkout-transaction")
      && /\bexecuteCanonicalCheckoutTransaction\s*\(/u.test(telegram);

    // Website may retain the public store facade, but that facade must be a
    // thin delegate to the same transaction used by Telegram.
    expect(websiteDelegates || (importsFrom(website, "./store") && storeDelegates)).toBe(true);
    expect(telegramDelegates || (importsFrom(telegram, "./store") && storeDelegates)).toBe(true);
    expect(importsFrom(principal, "./checkout-transaction")).toBe(true);
    expect(principal).toContain("executeCanonicalCheckoutTransaction");
    expect(principal).not.toMatch(/from\s+["'][^"']*\/(?:payments|telegram)\/(?:client|store|commerce)["']/u);
    expect(principal).toContain("getProviderRuntimeContract");
    expect(principal).toContain("channel_provider_pending");
  });

  it("keeps order, reservation, and fulfillment writes out of channel ports and the store facade", () => {
    const adapterSources = [source("website-port.ts"), source("telegram-port.ts"), source("store.ts")];
    const duplicatedTransactionMarkers = [
      /INSERT\s+INTO\s+orders\b/iu,
      /INSERT\s+INTO\s+order_items\b/iu,
      /\bprepareCheckoutReservationPlan\b/u,
      /\bprepareReservedFulfillmentItems\b/u,
      /INSERT\s+INTO\s+fulfillments\b/iu,
    ];

    for (const adapterSource of adapterSources) {
      for (const marker of duplicatedTransactionMarkers) expect(adapterSource).not.toMatch(marker);
    }
  });

  it("keeps the website commerce route inventory explicit", () => {
    const expectedRoutes = [
      "cart.ts",
      "checkout.ts",
      "checkout/intent.ts",
      "checkout/recover.ts",
      "orders/[orderPublicId].ts",
      "orders/[orderPublicId]/downloads/[assetVersionId]/grant.ts",
      "orders/[orderPublicId]/downloads.ts",
      "orders/[orderPublicId]/downloads/grants/[grantId]/consume.ts",
      "orders/[orderPublicId]/keys.ts",
      "orders/[orderPublicId]/payment-link.ts",
      "quote.ts",
    ].sort();
    const actualRoutes = commerceRouteFiles();
    expect(actualRoutes).toEqual(expectedRoutes);

    const applicationRoutes = [
      "cart.ts",
      "checkout.ts",
      "checkout/intent.ts",
      "checkout/recover.ts",
      "orders/[orderPublicId].ts",
      "orders/[orderPublicId]/downloads.ts",
      "orders/[orderPublicId]/downloads/[assetVersionId]/grant.ts",
      "orders/[orderPublicId]/downloads/grants/[grantId]/consume.ts",
      "orders/[orderPublicId]/keys.ts",
      "orders/[orderPublicId]/payment-link.ts",
      "quote.ts",
    ];
    for (const route of applicationRoutes) {
      const routeSource = readFileSync(join(storeApiDirectory, route), "utf8");
      expect(routeSource).toMatch(/createWebsiteCommerceApplication/u);
    }

    // Domain stores and bounded recovery/private-download services remain
    // behind the Website application port rather than route handlers.
    for (const route of actualRoutes) {
      const routeSource = readFileSync(join(storeApiDirectory, route), "utf8");
      expect(routeSource).not.toMatch(/from\s+["'][^"']*\/commerce\/(?:store|checkout-transaction|digital-fulfillment|private-file-fulfillment|website-checkout-recovery)["']/u);
      expect(routeSource).not.toMatch(/from\s+["'][^"']*\/payments\/store["']/u);
    }
  });

  it("keeps storefront commerce handlers free of direct D1 access", () => {
    for (const route of commerceRouteFiles()) {
      const routeSource = readFileSync(join(storeApiDirectory, route), "utf8");

      // Route handlers translate HTTP input only; canonical application ports
      // own every D1 read/write so a new route cannot bypass tenant checks.
      expect(routeSource).not.toMatch(/\b(?:D1Database|PLATFORM_DB)\b/u);
      expect(routeSource).not.toMatch(/\.(?:prepare|batch)\s*\(/u);
      expect(routeSource).not.toMatch(/\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\b/iu);
    }
  });
});
