import { expect, type Page } from "@playwright/test";

export interface MagicLinkLoginOptions {
  beforeOpen?: () => Promise<void>;
  confirmationRequired?: boolean;
  /** Full email override; takes precedence over the composed per-project address. */
  email?: string;
  emailPrefix?: string;
}

/**
 * Shared local-gate login: requests a magic link for a deterministic
 * per-project user, activates the visible debug link, and (optionally)
 * walks the requester-cookie confirmation step. Ends on `/app`.
 */
export async function authenticateThroughVisibleMagicLink(
  page: Page,
  projectName: string,
  options: MagicLinkLoginOptions = {},
): Promise<void> {
  await page.goto("/login");
  await expect(page).toHaveTitle("Đăng nhập — Selinow");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Đăng nhập để tiếp tục");
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill(options.email ?? `${options.emailPrefix ?? "browser-gate"}-${projectName}@selinow.invalid`);
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
  await options.beforeOpen?.();
  const consumeResponsePromise = page.waitForResponse((response) => {
    try {
      return new URL(response.url()).pathname === "/api/auth/magic-link/consume";
    } catch {
      return false;
    }
  });
  await page.evaluate(() => {
    const links = [...document.querySelectorAll("a")];
    const link = links.find((candidate) => candidate.textContent.trim() === "mở liên kết đăng nhập");
    if (!(link instanceof HTMLAnchorElement)) throw new Error("local_magic_link_action_missing");
    link.click();
  });
  const consumeResponse = await consumeResponsePromise;
  const consumeState = await consumeResponse.json().then((body: unknown) => {
    const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    return {
      authenticated: record.authenticated === true,
      code: typeof record.code === "string" ? record.code : "none",
      confirmationRequired: record.confirmationRequired === true,
      requestId: typeof record.requestId === "string" ? record.requestId : "none",
      status: consumeResponse.status(),
    };
  }).catch(() => ({
    authenticated: false,
    code: "response_unreadable",
    confirmationRequired: false,
    requestId: "none",
    status: consumeResponse.status(),
  }));

  if (options.confirmationRequired === true) {
    expect(consumeState).toMatchObject({ confirmationRequired: true, status: 202 });
    await expect(page.locator("[data-login-confirmation]")).toBeVisible();
    await expect(page.locator("[data-login-confirm-destination]")).not.toBeEmpty();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
    await page.locator("[data-login-confirm]").click();
  } else {
    expect(consumeState).toMatchObject({ authenticated: true, status: 200 });
  }

  // Read only the final path so a failed assertion cannot print a magic-link token.
  await expect.poll(async () => {
    try {
      return await page.evaluate(() => location.pathname);
    } catch {
      return "navigation_in_progress";
    }
  }, { message: "local magic-link navigation did not reach the dashboard" }).toBe("/app");
}
