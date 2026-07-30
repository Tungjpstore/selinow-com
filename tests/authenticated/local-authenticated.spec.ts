import AxeBuilder from "@axe-core/playwright";
import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

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
    heading: "Mở cửa hàng,",
    headingLevel: 1,
    path: "/onboarding",
    screenshot: "authenticated-onboarding.png",
  },
  {
    heading: "Tên miền riêng",
    headingLevel: 2,
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

async function authenticateThroughVisibleMagicLink(page: Page, projectName: string): Promise<void> {
  await page.goto("/login");
  await expect(page).toHaveTitle("Đăng nhập — Selinow");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Đăng nhập để tiếp tục");
  await page.getByLabel("Email").fill(`browser-gate-${projectName}@selinow.invalid`);
  await page.getByLabel("Tên hiển thị").fill("Browser Gate");
  const magicLinkResponsePromise = page.waitForResponse((response) => {
    try {
      return new URL(response.url()).pathname === "/api/auth/magic-link/request";
    } catch {
      return false;
    }
  });
  await page.getByRole("button", { name: /Gửi liên kết đăng nhập/u }).click();
  const magicLinkResponse = await magicLinkResponsePromise;
  let magicLinkRequestState = {
    code: "response_unreadable",
    hasDebugLink: false,
    status: magicLinkResponse.status(),
  };
  try {
    const body: unknown = await magicLinkResponse.json();
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    magicLinkRequestState = {
      code: typeof record.code === "string" ? record.code : "none",
      hasDebugLink: typeof record.debugMagicLink === "string",
      status: magicLinkResponse.status(),
    };
  } catch {
    // The diagnostic intentionally records no response values beyond safe status metadata.
  }

  // Poll and activate by visible text inside the page so Playwright never serializes
  // the token-bearing anchor attributes into action failure logs.
  let lastLoginState = { hasVisibleLink: false, statusText: "", tone: "" };
  try {
    await expect.poll(async () => {
      lastLoginState = await page.evaluate(() => {
        const status = document.querySelector<HTMLElement>("[data-login-status]");
        const links = [...document.querySelectorAll("a")];
        const link = links.find((candidate) => candidate.textContent.trim() === "mở liên kết đăng nhập");
        const style = link instanceof HTMLAnchorElement ? getComputedStyle(link) : null;
        const bounds = link instanceof HTMLAnchorElement ? link.getBoundingClientRect() : null;
        return {
          hasVisibleLink: style !== null
          && bounds !== null
          && style.display !== "none"
          && style.visibility !== "hidden"
          && bounds.width > 0
          && bounds.height > 0,
          statusText: status?.textContent.trim() ?? "",
          tone: status?.dataset.tone ?? "",
        };
      });
      return lastLoginState;
    }, {
      message: "local magic-link action did not become visible",
      timeout: 15_000,
    }).toMatchObject({ hasVisibleLink: true });
  } catch {
    throw new Error(`local_magic_link_not_visible status=${JSON.stringify({
      request: magicLinkRequestState,
      statusText: lastLoginState.statusText,
      tone: lastLoginState.tone,
    })}`);
  }
  await page.evaluate(() => {
    const links = [...document.querySelectorAll("a")];
    const link = links.find((candidate) => candidate.textContent.trim() === "mở liên kết đăng nhập");
    if (!(link instanceof HTMLAnchorElement)) throw new Error("local_magic_link_action_missing");
    link.click();
  });

  // Read only the final path so a failed assertion cannot print a magic-link token.
  await expect.poll(async () => {
    try {
      return await page.evaluate(() => location.pathname);
    } catch {
      return "navigation_in_progress";
    }
  }, { message: "local magic-link navigation did not reach the dashboard" }).toBe("/app");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Browser Gate");
}

test.describe.configure({ mode: "serial" });

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
    await expect(page.getByRole("heading", { level: route.headingLevel })).toContainText(heading);
    if (route.expectedSummary !== undefined) {
      const summary = page.locator(".order-status-rail");
      for (const text of route.expectedSummary) await expect(summary).toContainText(text);
    }
    if (path === "/onboarding") {
      await expect(page.locator("[data-global-feedback]")).toBeHidden();
      await expect(page.locator("[data-progress-percent]")).toHaveText("13%");
      await expect(page.locator("[data-progress-copy]")).toHaveText("1/8 nhóm bước đã hoàn tất hoặc được bỏ qua an toàn.");
      if (testInfo.project.name === "mobile") {
        await expect(page.locator("[data-mobile-progress-completed]")).toHaveText("1");
        await expect(page.locator("[data-mobile-step-status]")).toBeVisible();
        await expect(page.locator(".mobile-step-selector summary")).toContainText("Các bước thiết lập cửa hàng");
        await expect(page.locator(".step-rail")).toBeHidden();
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
    } else {
      await expect(page).toHaveScreenshot(route.screenshot, { fullPage: false });
    }
  }

  expectedErrorPath = null;
  expectedErrorStatus = null;

  expect(runtimeIssues, runtimeIssues.join("\n")).toEqual([]);
});
