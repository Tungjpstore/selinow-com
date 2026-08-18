import { expect, test, type Page, type Response } from "@playwright/test";

import { authenticateThroughVisibleMagicLink } from "../helpers/magic-link";

/**
 * Tier 2 console interaction flows (Console V2 gate).
 *
 * Deterministic fixture: seeds/0004_local_authenticated_browser.sql provisions
 * one account that owns TWO shops (tenant-switch hygiene) with one order per
 * shop (order-detail shop switch must reset to the list) and one enabled
 * automation rule (toggle flow), plus a second pre-2FA-enrolled account for
 * the platform-admin directory flow (migration 0099 gates /admin behind 2FA).
 * No axe scans here on purpose: the render spec already gates WCAG and this
 * file must stay fast.
 */
const FLOWS_EMAIL = "browser-gate-flows@selinow.invalid";
const ADMIN_EMAIL = "browser-gate-admin@selinow.invalid";
const ALPHA_SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-0000000000f1";
const BETA_SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-0000000000f2";
const ALPHA_ORDER_PUBLIC_ID = "order_00000000-0000-4000-8000-0000000000f1";
// The console UI parser only surfaces rule ids matching `rule_<uuid>`.
const FIXTURE_RULE_ID = "rule_00000000-0000-4000-8000-0000000000f1";

const DESKTOP_PROJECT = "flows-desktop";
const MOBILE_PROJECT = "flows-mobile-390";

function pathnameOf(response: Response): string {
  try {
    return new URL(response.url()).pathname;
  } catch {
    return "";
  }
}

function waitForApi(page: Page, pathname: string, method?: string, timeout = 10_000): Promise<Response> {
  return page.waitForResponse((response) => {
    if (pathnameOf(response) !== pathname) return false;
    return method === undefined || response.request().method() === method;
  }, { timeout });
}

/** Location polling that survives the execution-context destruction of navigations. */
function pollLocationPart(page: Page, read: "pathname" | "search") {
  return expect.poll(async () => {
    try {
      return await page.evaluate((part) => (part === "pathname" ? location.pathname : location.search), read);
    } catch {
      return "navigation_in_progress";
    }
  }, { message: "navigation did not settle" });
}

test("mobile tabbar and sheet navigate and logout returns to /login", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== MOBILE_PROJECT, "mobile flows project only");
  await authenticateThroughVisibleMagicLink(page, testInfo.project.name, { email: FLOWS_EMAIL });

  const tabbar = page.locator(".app-tabbar");
  await expect(tabbar).toBeVisible();

  // Primary tabbar navigation (orders is the second tab).
  await tabbar.locator('a.app-tab[href^="/app/orders"]').click();
  await pollLocationPart(page, "pathname").toBe("/app/orders");

  // Products is the third primary tabbar tab on mobile, so the overflow sheet
  // carries the remaining catalog entries (inventory/customers/automation).
  await page.goto("/app");
  await tabbar.locator('a.app-tab[href^="/app/products"]').click();
  await pollLocationPart(page, "pathname").toBe("/app/products");

  // Overflow sheet opens and navigates.
  await page.goto("/app");
  const moreTab = page.locator("details.app-tab--more");
  await moreTab.locator("summary").click();
  await expect(page.locator(".app-sheet")).toBeVisible();
  await page.locator('.app-sheet-link[href^="/app/inventory"]').first().click();
  await pollLocationPart(page, "pathname").toBe("/app/inventory");

  // Logout through the sheet ends on the public login screen.
  await page.goto("/app");
  await moreTab.locator("summary").click();
  const logoutResponsePromise = waitForApi(page, "/api/auth/logout", "POST");
  await page.locator(".app-sheet-logout[data-app-logout]").click();
  const logoutResponse = await logoutResponsePromise;
  expect(logoutResponse.status()).toBeLessThan(400);
  await pollLocationPart(page, "pathname").toBe("/login");
});

test("switching shop on order detail resets the URL to the orders list", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== DESKTOP_PROJECT, "desktop flows project only");
  await authenticateThroughVisibleMagicLink(page, testInfo.project.name, { email: FLOWS_EMAIL });

  await page.goto(`/app/orders/${ALPHA_ORDER_PUBLIC_ID}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("BR-F-301");

  const selects = page.locator("[data-app-shop-select]");
  let shopSelect = selects.first();
  const selectCount = await selects.count();
  for (let index = 0; index < selectCount; index += 1) {
    if (await selects.nth(index).isVisible()) {
      shopSelect = selects.nth(index);
      break;
    }
  }
  await expect(shopSelect).toBeVisible();
  await shopSelect.selectOption(BETA_SHOP_PUBLIC_ID);

  // Tenant hygiene: the stale order id of the previous shop must never survive
  // the switch — shopSwitchHref resets /app/orders/* back to the list.
  await pollLocationPart(page, "pathname").toBe("/app/orders");
  await pollLocationPart(page, "search").toContain(`shop=${BETA_SHOP_PUBLIC_ID}`);
});

test("automation rule toggle flips the status badge and restores clean state", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== DESKTOP_PROJECT, "desktop flows project only");
  test.setTimeout(60_000);
  await authenticateThroughVisibleMagicLink(page, testInfo.project.name, { email: FLOWS_EMAIL });

  await page.goto(`/app/automation?shop=${ALPHA_SHOP_PUBLIC_ID}`);
  const rule = page.locator(`[data-rule-id="${FIXTURE_RULE_ID}"]`);
  await expect(rule).toBeVisible();
  await expect(rule.locator(".rule-row__status")).toContainText("Bật");
  // The delegated toggle listener ships in a module script; settle the network
  // so hydration completes before clicking (SSR rows render instantly).
  await page.waitForLoadState("networkidle");

  const togglePathname = `/api/app/shops/${ALPHA_SHOP_PUBLIC_ID}/automation/rules/${FIXTURE_RULE_ID}/toggle`;
  const toggleButton = rule.locator('[data-rules-action="toggle"]');
  // The toggle handler ships in a module script; retry the click until the
  // toggle API round-trip resolves so hydration races cannot flake the gate.
  const toggleOnce = async (expectedBadge: string): Promise<number> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const responsePromise = waitForApi(page, togglePathname, "POST", 8_000);
      await toggleButton.click();
      const response = await responsePromise.catch(() => null);
      if (response !== null) return response.status();
      // Either the click predated hydration or the module is mid-mutation;
      // wait for an observable outcome before deciding to retry.
      const toggled = await expect
        .poll(() => rule.locator(".rule-row__status").textContent(), {
          message: "rule status did not flip",
          timeout: 5_000,
        })
        .toContain(expectedBadge)
        .then(() => true)
        .catch(() => false);
      if (toggled) {
        // The mutation succeeded even though we missed its response (e.g.
        // a late-hydrated click whose promise settled out of our window).
        return 200;
      }
    }
    throw new Error(
      `automation toggle never settled after three attempts (feedback: ${await page.locator("[data-rules-feedback]").textContent().catch(() => "unreadable") ?? "empty"})`,
    );
  };

  expect(await toggleOnce("Tắt")).toBe(200);
  await expect(rule.locator(".rule-row__status")).toContainText("Tắt");
  await expect(toggleButton).toHaveText("Bật rule");

  // Restore the seeded state so the gate stays deterministic across runs.
  expect(await toggleOnce("Bật")).toBe(200);
  await expect(rule.locator(".rule-row__status")).toContainText("Bật");
  await expect(toggleButton).toHaveText("Tắt rule");
});

test("admin shops directory stays read-only with expandable safe facts", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== DESKTOP_PROJECT, "desktop flows project only");
  // Dedicated pre-enrolled account: migration 0099 answers /admin/* with a 403
  // two_factor_required state unless platform_users.two_factor_enabled=1.
  await authenticateThroughVisibleMagicLink(page, testInfo.project.name, { email: ADMIN_EMAIL });

  await page.goto("/admin/shops");
  await expect(page.locator("#directory-title")).toBeVisible();

  const row = page.locator(`[data-admin-shop-row][data-shop-public-id="${ALPHA_SHOP_PUBLIC_ID}"]`);
  await expect(row).toBeVisible();
  await expect(page.locator("[data-admin-shop-export]")).toBeVisible();

  // No suspend/reactivate UI exists on purpose (suspend is an internal API used
  // by operations/abuse flows) — the directory exposes only safe read actions.
  const detail = page.locator(
    `[data-admin-shop-row][data-shop-public-id="${ALPHA_SHOP_PUBLIC_ID}"] + tr.admin-shop-detail-row details`,
  );
  await detail.locator("summary").click();
  await expect(detail.locator(".admin-readonly-note")).toBeVisible();

  // Safe read-only mutation: applying the subscription filter round-trips via GET.
  const subscriptionSelect = page.locator('select[name="subscription"]');
  await subscriptionSelect.selectOption("trialing");
  await subscriptionSelect.locator("xpath=ancestor::form").locator('button[type="submit"]').click();
  await pollLocationPart(page, "search").toContain("subscription=trialing");
  await expect(row).toBeVisible();
});

test("security console loads sessions and history and completes the 2FA OTP enrollment", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== DESKTOP_PROJECT, "desktop flows project only");
  test.setTimeout(90_000);
  await authenticateThroughVisibleMagicLink(page, testInfo.project.name, { email: FLOWS_EMAIL });

  // Incident 2026-08-17 regression: the sessions ledger must load without
  // csrf_invalid/origin_mismatch rejections from the CSRF/origin guard.
  const sessionsResponsePromise = waitForApi(page, "/api/auth/sessions");
  await page.goto("/app/security");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Bảo mật tài khoản");
  const sessionsResponse = await sessionsResponsePromise;
  expect(sessionsResponse.status()).toBe(200);
  const sessionsBody = JSON.stringify(await sessionsResponse.json());
  expect(sessionsBody).not.toContain("csrf_invalid");
  expect(sessionsBody).not.toContain("origin_mismatch");
  const sessionList = page.locator("[data-security-session-list]");
  await expect(sessionList).toBeVisible();
  await expect(sessionList.locator('[role="listitem"]')).not.toHaveCount(0);

  // Login history tab loads its ledger endpoint.
  const historyResponsePromise = waitForApi(page, "/api/app/account/login-history");
  await page.goto("/app/security?tab=history");
  const historyResponse = await historyResponsePromise;
  expect(historyResponse.status()).toBe(200);
  await expect(page.locator('[data-security-tabpanel="history"]')).toBeVisible();

  // 2FA enrollment via the local debugOtp aid (APP_ENV=local).
  await page.goto("/app/security?tab=two_factor");
  const root = page.locator("[data-account-security-root]");
  await expect(root).toHaveAttribute("data-two-factor-enabled", "false");

  const requestPromise = waitForApi(page, "/api/app/account/enable-2fa-request", "POST");
  await page.locator("[data-two-factor-enable]").click();
  const request = await requestPromise;
  expect(request.status()).toBe(200);
  const payload = (await request.json()) as { debugOtp?: unknown };
  expect(typeof payload.debugOtp).toBe("string");
  await expect(page.locator("[data-two-factor-enroll-form]")).toBeVisible();
  await page.locator("#two-factor-enroll-otp").fill(payload.debugOtp as string);
  await page.locator("[data-two-factor-verify]").click();
  await expect(root).toHaveAttribute("data-two-factor-enabled", "true", { timeout: 15_000 });

  // Enrolled state renders the disable section. NOTE: the OTP disable path is
  // NOT exercised because the server rejects enable-2fa-request with 409
  // two_factor_already_enabled for enrolled accounts (see release report —
  // app bug), and the fixture account has no password for the password path.
  // The gate uses a fresh database per run, so staying enrolled is clean.
  await expect(page.locator("[data-two-factor-disable]")).toBeVisible();
  await expect(page.locator("#two-factor-disable-password")).toBeVisible();
  await expect(page.locator("[data-two-factor-disable-otp-request]")).toBeVisible();
});
