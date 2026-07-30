import AxeBuilder from "@axe-core/playwright";
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

const marketingOrigin = process.env.SELINOW_PUBLIC_BROWSER_MARKETING_ORIGIN ?? "http://localhost:4321";
const dashboardOrigin = process.env.SELINOW_PUBLIC_BROWSER_DASHBOARD_ORIGIN ?? "http://app.localhost:4321";
const storefrontOrigin = process.env.SELINOW_PUBLIC_BROWSER_STOREFRONT_ORIGIN ?? "http://signal.localhost:4321";

type PublicRoute = {
  heading: string;
  id: string;
  origin: string;
  path: string;
  screenshot: string;
  title: string;
};

const routes: readonly PublicRoute[] = [
  {
    heading: "Bán sản phẩm số ngay trong cuộc trò chuyện.",
    id: "marketing-home",
    origin: marketingOrigin,
    path: "/",
    screenshot: "public-marketing-home.png",
    title: "Selinow - Bán sản phẩm số ngay trong cuộc trò chuyện",
  },
  {
    heading: "Một gói phù hợp với nhịp vận hành của bạn.",
    id: "pricing",
    origin: marketingOrigin,
    path: "/pricing",
    screenshot: "public-pricing.png",
    title: "Bảng giá Selinow - Chọn mức vận hành phù hợp",
  },
  {
    heading: "Đăng nhập để tiếp tục",
    id: "login",
    origin: dashboardOrigin,
    path: "/login",
    screenshot: "public-login.png",
    title: "Đăng nhập — Selinow",
  },
  {
    heading: "Sản phẩm số, sẵn sàng khi bạn cần.",
    id: "storefront-home",
    origin: storefrontOrigin,
    path: "/",
    screenshot: "public-storefront-home.png",
    title: "Signal Supply — Cửa hàng sản phẩm số",
  },
  {
    heading: "Signal Editor Lifetime",
    id: "storefront-product-detail",
    origin: storefrontOrigin,
    path: "/products/signal-editor-lifetime",
    screenshot: "public-storefront-product-detail.png",
    title: "Signal Editor Lifetime — Signal Supply",
  },
  {
    heading: "Kiểm tra trước khi đặt hàng.",
    id: "storefront-cart",
    origin: storefrontOrigin,
    path: "/cart",
    screenshot: "public-storefront-cart.png",
    title: "Giỏ hàng — Signal Supply",
  },
  {
    heading: "Hoàn tất thông tin đơn hàng.",
    id: "storefront-checkout",
    origin: storefrontOrigin,
    path: "/checkout",
    screenshot: "public-storefront-checkout.png",
    title: "Thanh toán — Signal Supply",
  },
  {
    heading: "Thanh toán và giao hàng, rõ từng trạng thái.",
    id: "storefront-order-status",
    origin: storefrontOrigin,
    path: "/orders/order_00000000-0000-4000-8000-000000000099",
    screenshot: "public-storefront-order-status.png",
    title: "Đơn hàng — Signal Supply",
  },
];

function redactRuntimeMessage(value: string): string {
  return value.replace(/([?&](?:code|csrf|session|token)=)[^&\s]+/giu, "$1[redacted]");
}

function recordConsoleIssue(issues: string[], message: ConsoleMessage): void {
  if (message.type() !== "error" && message.type() !== "warning") return;
  issues.push(`${message.type()}: ${redactRuntimeMessage(message.text())}`);
}

async function expectStablePage(page: Page, expectedWidth: number): Promise<void> {
  await page.evaluate(async () => document.fonts.ready);
  const geometry = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.innerWidth).toBe(expectedWidth);
  expect(geometry.clientWidth).toBeLessThanOrEqual(expectedWidth);
  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(expectedWidth);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(expectedWidth);
}

async function expectNoWcagViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const summary = result.violations.map((violation) => ({
    help: violation.help,
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => ({
      failureSummary: node.failureSummary,
      html: node.html,
      target: node.target,
    })),
  }));
  expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
}

function expectNoPrivateLeakage(route: PublicRoute, headers: Record<string, string>): void {
  if (route.id === "login") {
    expect(headers["cache-control"]).toContain("private");
    expect(headers["cache-control"]).toContain("no-store");
    expect(headers["x-robots-tag"]).toContain("noindex");
  }
}

function expectNoFrameworkOverlay(page: Page): Promise<void> {
  return expect(page.locator("vite-error-overlay, astro-dev-toolbar, nextjs-portal")).toHaveCount(0);
}

for (const route of routes) {
  test(`${route.id} remains deterministic at the PromptOS public viewport`, async ({ page }, testInfo) => {
    const expectedWidth = testInfo.project.use.viewport?.width;
    if (typeof expectedWidth !== "number") throw new Error("public_local_viewport_missing");
    const runtimeIssues: string[] = [];
    const nonReadOnlyRequests: string[] = [];
    const externalRequests: string[] = [];
    page.on("console", (message) => {
      recordConsoleIssue(runtimeIssues, message);
    });
    page.on("pageerror", (error) => {
      runtimeIssues.push(`pageerror: ${redactRuntimeMessage(error.message)}`);
    });
    await page.route("**/*", async (routeHandle) => {
      const request = routeHandle.request();
      const requestUrl = new URL(request.url());
      if (!new Set(["localhost", "app.localhost", "signal.localhost", "api.localhost"]).has(requestUrl.hostname)) {
        externalRequests.push(requestUrl.origin);
        await routeHandle.abort("blockedbyclient");
        return;
      }
      if (request.method() !== "GET" && request.method() !== "HEAD") {
        nonReadOnlyRequests.push(`${request.method()} ${requestUrl.pathname}`);
        await routeHandle.abort("blockedbyclient");
        return;
      }
      await routeHandle.continue();
    });

    const response = await page.goto(`${route.origin}${route.path}`);
    expect(response).not.toBeNull();
    expect(response?.ok()).toBe(true);
    expect(await page.title()).toBe(route.title);
    expect(await page.evaluate(() => location.origin)).toBe(route.origin);
    expect(await page.evaluate(() => location.pathname)).toBe(route.path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(route.heading);
    if (route.id === "storefront-product-detail") {
      await expect(page.locator("#detail-add")).toBeEnabled();
    }
    await expectNoFrameworkOverlay(page);
    await expectStablePage(page, expectedWidth);
    expectNoPrivateLeakage(route, response?.headers() ?? {});
    await expectNoWcagViolations(page);
    expect(externalRequests, externalRequests.join("\n")).toEqual([]);
    expect(nonReadOnlyRequests, nonReadOnlyRequests.join("\n")).toEqual([]);
    expect(runtimeIssues, runtimeIssues.join("\n")).toEqual([]);

    await expect(page).toHaveScreenshot(route.screenshot, { fullPage: route.id === "marketing-home" });
    if (route.id === "marketing-home") {
      const faq = page.locator(".faq-list details").first();
      await faq.locator("summary").click();
      await expect(faq).toHaveAttribute("open", "");
      await faq.locator("summary").click();
      await expect(faq).not.toHaveAttribute("open", "");
    }
  });
}
