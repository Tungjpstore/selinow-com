import { expect, test, type ConsoleMessage, type Page } from "@playwright/test";

const routes = [
  { heading: "Browser Gate", headingLevel: 1, path: "/app" },
  { heading: "Mở cửa hàng,", headingLevel: 1, path: "/onboarding" },
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

async function authenticateThroughVisibleMagicLink(page: Page): Promise<void> {
  await page.goto("/login");
  await expect(page).toHaveTitle("Đăng nhập — Selinow");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Đăng nhập để tiếp tục");
  await page.getByLabel("Email").fill("browser-gate-desktop@selinow.invalid");
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
    // Diagnostics retain only safe response metadata.
  }

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

  await expect.poll(async () => {
    try {
      return await page.evaluate(() => location.pathname);
    } catch {
      return "navigation_in_progress";
    }
  }, { message: "local magic-link navigation did not reach the dashboard" }).toBe("/app");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Browser Gate");
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

  await authenticateThroughVisibleMagicLink(page);

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
    await expect(page.getByRole("heading", { level: route.headingLevel })).toContainText(route.heading);
    if (route.path === "/onboarding" && expectedWidth <= 390) {
      await expect(page.locator("[data-mobile-progress-completed]")).toHaveText("1");
      await expect(page.locator("[data-mobile-step-status]")).toBeVisible();
      await expect(page.locator(".mobile-step-selector summary")).toContainText("Các bước thiết lập cửa hàng");
      await expect(page.locator(".step-rail")).toBeHidden();
    }
    await expectStablePage(page, expectedWidth);
    expect(runtimeIssues, runtimeIssues.join("\n")).toEqual([]);
  }

  await expectSyntheticRtlRender(page, expectedWidth);

  expect(nonReadOnlyRequests).toEqual([]);
  expect(runtimeIssues, runtimeIssues.join("\n")).toEqual([]);
});
