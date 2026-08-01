import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const marketingOrigin = process.env.SELINOW_PUBLIC_BROWSER_MARKETING_ORIGIN ?? "http://localhost:4321";
const dashboardOrigin = process.env.SELINOW_PUBLIC_BROWSER_DASHBOARD_ORIGIN ?? "http://app.localhost:4321";
const storefrontOrigin = process.env.SELINOW_PUBLIC_BROWSER_STOREFRONT_ORIGIN ?? "http://signal.localhost:4321";

const routes = [
  `${marketingOrigin}/`,
  `${marketingOrigin}/pricing`,
  `${dashboardOrigin}/login`,
  `${storefrontOrigin}/`,
  `${storefrontOrigin}/products/signal-editor-lifetime`,
  `${storefrontOrigin}/cart`,
  `${storefrontOrigin}/checkout`,
  `${storefrontOrigin}/orders/order_00000000-0000-4000-8000-000000000099`,
] as const;

test("public surfaces reflow at the effective 200 percent CSS viewport", async ({ page }, testInfo) => {
  expect(testInfo.project.use.viewport).toEqual({ height: 512, width: 720 });
  const externalRequests: string[] = [];
  const mutationRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!new Set(["localhost", "app.localhost", "signal.localhost", "api.localhost"]).has(url.hostname)) {
      externalRequests.push(url.origin);
      await route.abort("blockedbyclient");
      return;
    }
    if (request.method() !== "GET" && request.method() !== "HEAD") {
      mutationRequests.push(`${request.method()} ${url.pathname}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  for (const url of routes) {
    const response = await page.goto(url);
    expect(response).not.toBeNull();
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    if (url.endsWith("/products/signal-editor-lifetime")) {
      await expect(page.locator("#detail-add")).toBeEnabled();
    }
    await page.evaluate(async () => document.fonts.ready);
    const geometry = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      client: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(geometry.client).toBe(720);
    expect(geometry.body, url).toBeLessThanOrEqual(geometry.client);
    expect(geometry.document, url).toBeLessThanOrEqual(geometry.client);

    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) return null;
      const rect = active.getBoundingClientRect();
      return { bottom: rect.bottom, left: rect.left, right: rect.right, top: rect.top };
    });
    expect(focus, `${url} must expose a keyboard focus target`).not.toBeNull();
    if (focus !== null) {
      expect(focus.right).toBeGreaterThan(0);
      expect(focus.left).toBeLessThanOrEqual(720);
    }

    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const violations = axe.violations.map(({ help, id, impact, nodes }) => ({
      help,
      id,
      impact,
      nodes: nodes.map(({ failureSummary, html, target }) => ({ failureSummary, html, target })),
    }));
    expect(violations, `${url}\n${JSON.stringify(violations, null, 2)}`).toEqual([]);
  }

  expect(externalRequests, externalRequests.join("\n")).toEqual([]);
  expect(mutationRequests, mutationRequests.join("\n")).toEqual([]);
});
