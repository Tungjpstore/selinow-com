import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const storefrontOrigin = process.env.SELINOW_PUBLIC_BROWSER_STOREFRONT_ORIGIN ?? "http://signal.localhost:4321";
const orderPublicId = "order_00000000-0000-4000-8000-000000000099";
const variantId = "var_61000000-0000-4000-8000-000000000001";
const expiresAt = "2030-01-01T00:00:00.000Z";

type SafeRouteHandler = (route: Route) => Promise<void>;

async function installSafeRoutes(page: Page, handlers: ReadonlyMap<string, SafeRouteHandler>) {
  const externalRequests: string[] = [];
  const unmockedMutations: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    const handler = handlers.get(key);
    if (handler !== undefined) {
      await handler(route);
      return;
    }
    if (!new Set(["localhost", "app.localhost", "signal.localhost", "api.localhost"]).has(url.hostname)) {
      externalRequests.push(url.origin);
      await route.abort("blockedbyclient");
      return;
    }
    if (request.method() !== "GET" && request.method() !== "HEAD") {
      unmockedMutations.push(key);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return { externalRequests, unmockedMutations };
}

async function seedBrowserCart(page: Page): Promise<void> {
  await page.goto(storefrontOrigin);
  await page.evaluate((id) => {
    localStorage.setItem(`selinow-cart:v1:${window.location.host}`, JSON.stringify([{ quantity: 1, variantId: id }]));
  }, variantId);
}

async function seedOrderToken(page: Page): Promise<void> {
  await page.goto(storefrontOrigin);
  await page.evaluate(({ id, token }) => {
    sessionStorage.setItem(`selinow-order-token:v1:${window.location.host}:${id}`, token);
  }, { id: orderPublicId, token: "local-visual-order-access-token" });
}

async function expectStableState(page: Page, externalRequests: string[], unmockedMutations: string[]): Promise<void> {
  await page.evaluate(async () => document.fonts.ready);
  const geometry = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    client: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(geometry.body).toBeLessThanOrEqual(geometry.client);
  expect(geometry.document).toBeLessThanOrEqual(geometry.client);
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(axe.violations.map(({ help, id, impact }) => ({ help, id, impact }))).toEqual([]);
  expect(externalRequests, externalRequests.join("\n")).toEqual([]);
  expect(unmockedMutations, unmockedMutations.join("\n")).toEqual([]);
}

function cartResponse(): SafeRouteHandler {
  return async (route) => route.fulfill({
    body: JSON.stringify({ cartId: "local-visual-cart", cartToken: "local-visual-cart-token" }),
    contentType: "application/json",
    status: 200,
  });
}

test("cart renders the server-confirmed price-changed state", async ({ page }) => {
  const routes = await installSafeRoutes(page, new Map([
    ["POST /api/store/cart", cartResponse()],
    ["POST /api/store/quote", async (route) => route.fulfill({
      body: JSON.stringify({
        quote: {
          currency: "VND",
          expiresAt,
          items: [{
            productTitle: "Signal Editor Lifetime",
            quantity: 1,
            unitPriceMinor: 259_000,
            variantId,
            variantTitle: "Lifetime",
            variantVersion: 1,
          }],
          totalMinor: 259_000,
        },
      }),
      contentType: "application/json",
      status: 200,
    })],
  ]));
  await seedBrowserCart(page);
  await page.goto(`${storefrontOrigin}/cart`);
  await expect(page.locator("#cart-quote-status")).toHaveAttribute("data-state", "price_changed");
  await expectStableState(page, routes.externalRequests, routes.unmockedMutations);
  await expect(page).toHaveScreenshot("public-cart-price-changed.png", { fullPage: false });
});

test("checkout renders an expired authoritative quote", async ({ page }) => {
  const routes = await installSafeRoutes(page, new Map([
    ["POST /api/store/cart", cartResponse()],
    ["POST /api/store/quote", async (route) => route.fulfill({
      body: JSON.stringify({
        quote: {
          currency: "VND",
          expiresAt: "2026-01-01T00:00:00.000Z",
          items: [{
            productTitle: "Signal Editor Lifetime",
            quantity: 1,
            unitPriceMinor: 249_000,
            variantId,
            variantTitle: "Lifetime",
            variantVersion: 1,
          }],
          quoteEvidence: "local-visual-expired-quote-evidence-0000000000000000000000",
          totalMinor: 249_000,
        },
      }),
      contentType: "application/json",
      status: 200,
    })],
  ]));
  await seedBrowserCart(page);
  await page.goto(`${storefrontOrigin}/checkout`);
  await expect(page.locator("#checkout-status")).toHaveClass(/error/u);
  await expect(page.locator("#checkout-retry")).toBeVisible();
  await expectStableState(page, routes.externalRequests, routes.unmockedMutations);
  await expect(page).toHaveScreenshot("public-checkout-expired.png", { fullPage: false });
});

test("checkout renders provider unavailable without reaching a mutation sink", async ({ page }) => {
  const routes = await installSafeRoutes(page, new Map([
    ["POST /api/store/cart", async (route) => route.fulfill({
      body: JSON.stringify({ code: "provider_unavailable", requestId: "local-visual-provider" }),
      contentType: "application/json",
      status: 503,
    })],
  ]));
  await seedBrowserCart(page);
  await page.goto(`${storefrontOrigin}/checkout`);
  await expect(page.locator("#checkout-status")).toHaveClass(/error/u);
  await expect(page.locator("#checkout-retry")).toBeVisible();
  await expectStableState(page, routes.externalRequests, routes.unmockedMutations);
  await expect(page).toHaveScreenshot("public-checkout-provider-unavailable.png", { fullPage: false });
});

for (const order of [
  {
    fulfillmentStatus: "unfulfilled",
    paymentStatus: "unpaid",
    screenshot: "public-order-pending.png",
    status: "pending_payment",
  },
  {
    fulfillmentStatus: "fulfilled",
    paymentStatus: "paid",
    screenshot: "public-order-fulfilled.png",
    status: "completed",
  },
] as const) {
  test(`order status renders ${order.status} as separate payment and fulfillment timelines`, async ({ page }) => {
    const handlers = new Map<string, SafeRouteHandler>([
      [`GET /api/store/orders/${orderPublicId}`, async (route) => route.fulfill({
        body: JSON.stringify({
          order: {
            currency: "VND",
            expiresAt,
            fulfillmentStatus: order.fulfillmentStatus,
            items: [{
              fulfillmentType: "manual",
              lineTotalMinor: 249_000,
              productTitle: "Signal Editor Lifetime",
              quantity: 1,
              variantTitle: "Lifetime",
            }],
            orderNumber: "SLN-LOCAL-0099",
            paymentStatus: order.paymentStatus,
            status: order.status,
            totalMinor: 249_000,
          },
        }),
        contentType: "application/json",
        status: 200,
      })],
      [`GET /api/store/orders/${orderPublicId}/downloads`, async (route) => route.fulfill({
        body: JSON.stringify({ downloads: [] }),
        contentType: "application/json",
        status: 200,
      })],
    ]);
    const routes = await installSafeRoutes(page, handlers);
    await seedOrderToken(page);
    await page.goto(`${storefrontOrigin}/orders/${orderPublicId}`);
    await expect(page.locator("#order-status .order-timeline")).toHaveCount(2);
    await expectStableState(page, routes.externalRequests, routes.unmockedMutations);
    await expect(page).toHaveScreenshot(order.screenshot, { fullPage: false });
  });
}
