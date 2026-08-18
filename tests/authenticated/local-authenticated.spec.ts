import AxeBuilder from "@axe-core/playwright";
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

import { authenticateThroughVisibleMagicLink } from "../helpers/magic-link";

type AuthenticatedRoute = {
  heading: string | ((projectName: string) => string);
  headingLevel: 1 | 2;
  path: string | ((projectName: string) => string);
  query?: string;
  screenshot: string;
  expectedStatus?: number;
  expectedSummary?: readonly string[];
};

function orderPath(projectName: string, desktopSuffix: string, mobileSuffix: string): string {
  const suffix = projectName === "mobile" ? mobileSuffix : desktopSuffix;
  return `/app/orders/order_00000000-0000-4000-8000-${suffix}`;
}

function orderHeading(projectName: string, desktopNumber: string, mobileNumber: string): string {
  return `Đơn ${projectName === "mobile" ? mobileNumber : desktopNumber}`;
}

const routeAliases = [
  { path: "/app/telegram", target: "/app/integrations" },
  { path: "/app/store/settings", target: "/app/store" },
] as const;

const routes: readonly AuthenticatedRoute[] = [
  {
    heading: "Browser Gate",
    headingLevel: 1,
    path: "/app",
    screenshot: "authenticated-dashboard.png",
  },
  {
    heading: "Hồ sơ Cửa hàng & Kênh Bán",
    headingLevel: 2,
    path: "/onboarding",
    screenshot: "authenticated-onboarding.png",
  },
  {
    heading: "Tên miền",
    headingLevel: 1,
    path: "/app/domains",
    screenshot: "authenticated-domains.png",
  },
  {
    heading: "Sản phẩm",
    headingLevel: 1,
    path: "/app/products",
    screenshot: "authenticated-products.png",
  },
  {
    heading: "Kho mã",
    headingLevel: 1,
    path: "/app/inventory",
    screenshot: "authenticated-inventory.png",
  },
  {
    heading: "Đơn hàng",
    headingLevel: 1,
    path: "/app/orders",
    screenshot: "authenticated-orders.png",
  },
  {
    heading: (projectName) => orderHeading(projectName, "BR-D-101", "BR-M-201"),
    headingLevel: 1,
    path: (projectName) => orderPath(projectName, "000000000101", "000000000201"),
    screenshot: "authenticated-order-pending.png",
    expectedSummary: ["Chờ thanh toán", "Chưa giao hàng"],
  },
  {
    heading: (projectName) => orderHeading(projectName, "BR-D-102", "BR-M-202"),
    headingLevel: 1,
    path: (projectName) => orderPath(projectName, "000000000102", "000000000202"),
    screenshot: "authenticated-order-paid-processing.png",
    expectedSummary: ["Đang xử lý", "Đã xác nhận thanh toán", "Đã giữ kho"],
  },
  {
    heading: (projectName) => orderHeading(projectName, "BR-D-103", "BR-M-203"),
    headingLevel: 1,
    path: (projectName) => orderPath(projectName, "000000000103", "000000000203"),
    screenshot: "authenticated-order-fulfilled.png",
    expectedSummary: ["Hoàn tất", "Đã xác nhận thanh toán", "Đã giao hàng"],
  },
  {
    heading: (projectName) => orderHeading(projectName, "BR-D-104", "BR-M-204"),
    headingLevel: 1,
    path: (projectName) => orderPath(projectName, "000000000104", "000000000204"),
    screenshot: "authenticated-order-failed.png",
    expectedSummary: ["Cần kiểm tra", "Thanh toán không thành công", "Giao hàng không thành công"],
  },
  {
    heading: "Bạn không có quyền xem đơn này",
    headingLevel: 2,
    path: (projectName) => orderPath(projectName, "000000000101", "000000000201"),
    query: "?shop=shop_00000000-0000-4000-8000-000000000099",
    screenshot: "authenticated-order-forbidden.png",
    expectedStatus: 403,
  },
  {
    heading: "Tự động hóa",
    headingLevel: 1,
    path: "/app/automation",
    screenshot: "authenticated-automation.png",
  },
  {
    heading: "Khách hàng",
    headingLevel: 1,
    path: "/app/customers",
    screenshot: "authenticated-customers.png",
  },
  {
    heading: "Tích hợp",
    headingLevel: 1,
    path: "/app/integrations",
    screenshot: "authenticated-integrations.png",
  },
  {
    heading: "Cửa hàng",
    headingLevel: 1,
    path: "/app/store",
    screenshot: "authenticated-store-builder.png",
  },
  {
    heading: "Audit & dữ liệu",
    headingLevel: 1,
    path: "/app/data",
    screenshot: "authenticated-data-lifecycle.png",
  },
  {
    heading: "Thành viên",
    headingLevel: 1,
    path: "/app/members",
    screenshot: "authenticated-members.png",
  },
  {
    heading: "Gói dịch vụ",
    headingLevel: 1,
    path: "/app/billing",
    screenshot: "authenticated-billing.png",
  },
  {
    heading: "Bảo mật tài khoản",
    headingLevel: 1,
    path: "/app/security",
    screenshot: "authenticated-security.png",
  },
  {
    heading: "Chỉ ghi nhận thanh toán đã xác minh",
    headingLevel: 1,
    path: "/app/payments",
    screenshot: "authenticated-payments.png",
  },
  {
    heading: "Lịch hẹn",
    headingLevel: 1,
    path: "/app/bookings",
    screenshot: "authenticated-bookings.png",
  },
  {
    heading: "API & nhà phát triển",
    headingLevel: 1,
    path: "/app/developer",
    screenshot: "authenticated-developer.png",
  },
  {
    heading: "Bằng chứng đơn hàng, thanh toán và audit",
    headingLevel: 1,
    path: "/admin/investigations",
    screenshot: "authenticated-admin-investigations.png",
  },
  {
    heading: "Khiếu nại và hoàn tiền",
    headingLevel: 1,
    path: "/admin/appeals",
    screenshot: "authenticated-admin-appeals.png",
  },
  {
    heading: "Điều tra nhanh.",
    headingLevel: 1,
    path: "/admin",
    screenshot: "authenticated-admin-operations.png",
  },
  {
    heading: "Lỗi luôn được nhìn thấy.",
    headingLevel: 1,
    path: "/admin/operations",
    screenshot: "authenticated-admin-systems.png",
  },
  {
    heading: "Sellers & Shops",
    headingLevel: 1,
    path: "/admin/shops",
    screenshot: "authenticated-admin-shops.png",
  },
];

function redactRuntimeMessage(value: string): string {
  return value.replace(/([?&](?:code|csrf|session|token)=)[^&\s]+/giu, "$1[redacted]");
}

function recordConsoleIssue(issues: string[], message: ConsoleMessage): void {
  if (message.type() !== "error" && message.type() !== "warning") return;
  issues.push(`${message.type()}: ${redactRuntimeMessage(message.text())}`);
}

async function expectNoWcagViolations(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const summary = result.violations.map((violation) => ({
    help: violation.help,
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  }));

  expect(summary, JSON.stringify(summary, null, 2)).toEqual([]);
}

async function expectStablePage(page: Page): Promise<void> {
  await page.evaluate(async () => document.fonts.ready);
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
}

function expectPrivateHeaders(headers: Record<string, string>): void {
  expect(headers["cache-control"]).toContain("private");
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["x-robots-tag"]).toContain("noindex");
}


test.describe.configure({ mode: "serial" });

test("local magic link confirms safely when the requester cookie is unavailable", async ({ page }, testInfo) => {
  await authenticateThroughVisibleMagicLink(page, testInfo.project.name, {
    beforeOpen: () => page.context().clearCookies(),
    confirmationRequired: true,
    emailPrefix: "cross-browser-gate",
  });
});

test("local magic link opens deterministic authenticated seller surfaces", async ({ page }, testInfo) => {
  const runtimeIssues: string[] = [];
  let expectedErrorPath: string | null = null;
  let expectedErrorStatus: number | null = null;
  page.on("console", (message) => {
    if (
      expectedErrorStatus !== null
      && message.type() === "error"
      && message.text().includes("Failed to load resource")
      && message.text().includes(String(expectedErrorStatus))
    ) return;
    recordConsoleIssue(runtimeIssues, message);
  });
  page.on("pageerror", (error) => {
    runtimeIssues.push(`pageerror: ${redactRuntimeMessage(error.message)}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    let pathname = response.url();
    try {
      pathname = new URL(response.url()).pathname;
    } catch {
      // Keep the raw URL only when Playwright returns an invalid response URL.
    }
    if (response.status() === expectedErrorStatus && pathname === expectedErrorPath) return;
    runtimeIssues.push(`response_${String(response.status())}: ${pathname}`);
  });

  await authenticateThroughVisibleMagicLink(page, testInfo.project.name);
  // V2 topbar chrome: the workspace context block carries the display name.
  await expect(page.locator("[data-app-shell] .app-topbar-context > strong")).toHaveText("Browser Gate");

  for (const alias of routeAliases) {
    const response = await page.goto(alias.path);
    expect(response).not.toBeNull();
    expectPrivateHeaders(response?.headers() ?? {});
    expect(await page.evaluate(() => location.pathname)).toBe(alias.target);
  }

  for (const route of routes) {
    const path = typeof route.path === "function" ? route.path(testInfo.project.name) : route.path;
    const heading = typeof route.heading === "function" ? route.heading(testInfo.project.name) : route.heading;
    expectedErrorPath = route.expectedStatus !== undefined && route.expectedStatus >= 400 ? path : null;
    expectedErrorStatus = route.expectedStatus !== undefined && route.expectedStatus >= 400 ? route.expectedStatus : null;
    const response = await page.goto(`${path}${route.query ?? ""}`);
    expect(response).not.toBeNull();
    expect(response?.status()).toBe(route.expectedStatus ?? 200);
    expectPrivateHeaders(response?.headers() ?? {});
    const pathname = await page.evaluate(() => location.pathname);
    expect(pathname).toBe(path);
    // Name-scoped: /onboarding renders several section headings at once.
    await expect(page.getByRole("heading", { level: route.headingLevel, name: heading })).toContainText(heading);
    if (route.expectedSummary !== undefined) {
      const summary = page.locator(".order-status-rail");
      for (const text of route.expectedSummary) await expect(summary).toContainText(text);
    }
    if (path === "/onboarding") {
      // Quickstart shell (Console v2): single progress topbar + step panes.
      await expect(page.locator("[data-quickstart-root]")).toBeVisible();
      await expect(page.locator('.topbar-progress-section [role="progressbar"]')).toHaveAttribute("aria-valuenow", "0");
      if (testInfo.project.name === "mobile") {
        // Step labels collapse below 900px.
        await expect(page.locator(".progress-step-labels")).toBeHidden();
      } else {
        await expect(page.locator('[data-progress-label="store"]')).toBeVisible();
        await expect(page.locator('[data-progress-label="launch"]')).toBeVisible();
      }
    }
    if (path === "/app/domains") {
      await expect(page.locator("[data-domain-panel]")).toHaveAttribute("aria-busy", "false");
      await expect(page.locator("[data-domain-hostname]")).toHaveText(
        `browser-gate-${testInfo.project.name}.localhost`,
      );
    }
    await expectStablePage(page);
    expect(runtimeIssues, runtimeIssues.join("\n")).toEqual([]);
    await expectNoWcagViolations(page);
    if (path === "/app") {
      await expect(page).toHaveScreenshot(route.screenshot, {
        fullPage: false,
        mask: [
          page.locator("#dashboard-overview-date"),
          page.locator("[data-visual-dynamic]"),
        ],
        maskColor: "#E2E8F0",
      });
    } else if (path === "/app/security") {
      // Session/history ledgers and the feedback line carry run-specific
      // timestamps and request ids; mask them like the overview clock.
      await expect(page).toHaveScreenshot(route.screenshot, {
        fullPage: false,
        mask: [
          page.locator("[data-security-feedback]"),
          page.locator("[data-security-session-list]"),
          page.locator("[data-security-history-list]"),
        ],
        maskColor: "#E2E8F0",
      });
    } else {
      await expect(page).toHaveScreenshot(route.screenshot, { fullPage: false });
    }
  }

  expectedErrorPath = null;
  expectedErrorStatus = null;

  expect(runtimeIssues, runtimeIssues.join("\n")).toEqual([]);
});
