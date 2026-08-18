import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

import { authenticateThroughVisibleMagicLink } from "../helpers/magic-link";

const routes = [
  { heading: "Browser Gate", headingLevel: 1, path: "/app" },
  { heading: "Hồ sơ Cửa hàng & Kênh Bán", headingLevel: 2, path: "/onboarding" },
  { heading: "Sản phẩm", headingLevel: 1, path: "/app/products" },
  { heading: "Lỗi luôn được nhìn thấy.", headingLevel: 1, path: "/admin/operations" },
] as const;

function redactRuntimeMessage(value: string): string {
  return value.replace(/([?&](?:code|csrf|session|token)=)[^&\s]+/giu, "$1[redacted]");
}

function recordConsoleIssue(issues: string[], message: ConsoleMessage): void {
  if (message.type() !== "error" && message.type() !== "warning") return;
  issues.push(`${message.type()}: ${redactRuntimeMessage(message.text())}`);
}

function expectPrivateHeaders(headers: Record<string, string>): void {
  expect(headers["cache-control"]).toContain("private");
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["x-robots-tag"]).toContain("noindex");
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
  expect(geometry.clientWidth).toBeLessThanOrEqual(geometry.innerWidth);
  expect(geometry.bodyScrollWidth).toBeLessThanOrEqual(geometry.innerWidth);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.innerWidth);
}

async function expectSyntheticRtlRender(page: Page, expectedWidth: number): Promise<void> {
  await page.goto("/app");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Browser Gate");
  const state = await page.evaluate(() => {
    document.documentElement.dir = "rtl";
    const alert = document.createElement("aside");
    alert.className = "sln-alert";
    alert.dataset.tone = "danger";
    alert.textContent = "RTL alert fixture";
    document.body.appendChild(alert);
    const toast = document.createElement("div");
    toast.className = "sln-toast-region";
    document.body.appendChild(toast);

    const activeNav = document.querySelector<HTMLElement>('.app-nav-item[aria-current="page"]');
    const indicator = activeNav === null ? null : getComputedStyle(activeNav, "::before");
    const alertStyle = getComputedStyle(alert);
    const toastStyle = getComputedStyle(toast);
    return {
      alertBorderInlineStart: alertStyle.borderRightWidth,
      alertBorderInlineEnd: alertStyle.borderLeftWidth,
      direction: getComputedStyle(document.documentElement).direction,
      indicatorInlineStart: indicator?.right ?? null,
      toastInlineEnd: toastStyle.left,
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });

  expect(state.direction).toBe("rtl");
  expect(state.width).toBe(expectedWidth);
  expect(state.scrollWidth).toBeLessThanOrEqual(state.width);
  expect(state.alertBorderInlineStart).toBe("3px");
  expect(state.alertBorderInlineEnd).toBe("1px");
  expect(state.toastInlineEnd).toBe("16px");
  expect(state.indicatorInlineStart).toBe("-14px");
}

test("authenticated representative surfaces remain stable across the PromptOS viewport matrix", async ({ page }, testInfo) => {
  const expectedWidth = testInfo.project.use.viewport?.width;
  if (typeof expectedWidth !== "number") throw new Error("authenticated_viewport_matrix_width_missing");

  const runtimeIssues: string[] = [];
  page.on("console", (message) => {
    recordConsoleIssue(runtimeIssues, message);
  });
  page.on("pageerror", (error) => {
    runtimeIssues.push(`pageerror: ${redactRuntimeMessage(error.message)}`);
  });

  await authenticateThroughVisibleMagicLink(page, testInfo.project.name);

  const nonReadOnlyRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.method() === "GET" || request.method() === "HEAD") {
      await route.continue();
      return;
    }
    nonReadOnlyRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
    await route.abort("blockedbyclient");
  });

  for (const route of routes) {
    const response = await page.goto(route.path);
    expect(response).not.toBeNull();
    expectPrivateHeaders(response?.headers() ?? {});
    expect(await page.evaluate(() => location.pathname)).toBe(route.path);
    // Name-scoped: /onboarding renders several section headings at once.
    await expect(page.getByRole("heading", { level: route.headingLevel, name: route.heading })).toContainText(route.heading);
    if (route.path === "/onboarding") {
      // Quickstart shell (Console v2): sticky progress topbar replaces the old
      // wizard rail; step labels collapse below 900px.
      await expect(page.locator("[data-quickstart-root]")).toBeVisible();
      await expect(page.locator('.topbar-progress-section [role="progressbar"]')).toHaveAttribute("aria-valuenow", "0");
      if (expectedWidth <= 900) {
        await expect(page.locator(".progress-step-labels")).toBeHidden();
      } else {
        await expect(page.locator('[data-progress-label="store"]')).toBeVisible();
      }
    }
    await expectStablePage(page, expectedWidth);
    expect(runtimeIssues, runtimeIssues.join("\n")).toEqual([]);
  }

  await expectSyntheticRtlRender(page, expectedWidth);

  expect(nonReadOnlyRequests).toEqual([]);
  expect(runtimeIssues, runtimeIssues.join("\n")).toEqual([]);
});
