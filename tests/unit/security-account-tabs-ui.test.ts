import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createDashboardTranslator } from "../../src/lib/i18n/catalogs/dashboard";
import { createSystemTranslator } from "../../src/lib/i18n/catalogs/system";

describe("account security tabs UI", () => {
  const page = readFileSync("src/pages/app/security.astro", "utf8");
  const client = readFileSync("src/scripts/dashboard/security.ts", "utf8");
  const billing = readFileSync("src/pages/app/billing.astro", "utf8");
  const login = readFileSync("src/pages/login.astro", "utf8");
  const loginClient = readFileSync("src/scripts/marketing/auth.ts", "utf8");

  it("renders four account-security tabs wired through ?tab= with an ARIA tablist", () => {
    expect(page).toContain('role="tablist"');
    expect(page).toContain("data-security-tab-list");
    expect(page).toContain('data-active-tab={activeTab}');
    for (const tab of ["sessions", "two_factor", "password", "history"]) {
      expect(page).toContain(`data-security-tab={tab}`);
      expect(page).toContain(`id="security-tabpanel-${tab}"`);
      expect(page).toContain(`hidden={activeTab !== "${tab}"}`);
    }
    expect(page).toContain("t(`dashboard.security.tabs.${tab}`)");
    expect(page).toContain("const tabHref = (tab: SecurityTab): string => workspaceHref(`/app/security?tab=${tab}`);");
    expect(page).toContain('aria-selected={activeTab === tab ? "true" : "false"}');
    expect(page).toContain('aria-controls={`security-tabpanel-${tab}`}');
    // Unknown ?tab= values fall back to the sessions tab.
    expect(page).toContain(': "sessions";');
  });

  it("keeps every data-attribute pinned by the legacy sessions test", () => {
    for (const attribute of [
      "data-account-security-root",
      "data-security-session-list",
      "data-security-revoke-all",
      "data-csrf-cookie-name",
      "data-security-reauth",
      "data-security-refresh",
      "@media (max-width: 680px)",
    ]) {
      expect(page).toContain(attribute);
    }
    expect(page).not.toMatch(/sessionToken|tokenHash|csrfTokenHash/iu);
  });

  it("offers both enrollment and disable flows for email-OTP 2FA using primitives only", () => {
    for (const primitive of [
      'import Button from "../../components/primitives/Button.astro";',
      'import Input from "../../components/primitives/Input.astro";',
      'import SecretField from "../../components/primitives/SecretField.astro";',
      'import StatusBadge from "../../components/primitives/StatusBadge.astro";',
    ]) {
      expect(page).toContain(primitive);
    }
    for (const hook of [
      "data-two-factor-enabled={twoFactor.enabled",
      "data-two-factor-enroll",
      "data-two-factor-enable",
      "data-two-factor-enroll-form",
      'id="two-factor-enroll-otp"',
      "data-two-factor-verify",
      "data-two-factor-resend",
      "data-two-factor-disable",
      'id="two-factor-disable-password"',
      "data-two-factor-disable-otp-request",
      'id="two-factor-disable-otp"',
    ]) {
      expect(page).toContain(hook);
    }
    // OTP fields stay short and numeric; the password proof stays capped.
    expect(page).toContain("maxLength={6}");
    expect(page).toContain('autocomplete="current-password"');
  });

  it("exposes the password and login-history panels", () => {
    expect(page).toContain("data-password-form");
    expect(page).toContain('id="password-current"');
    expect(page).toContain('id="password-new"');
    expect(page).toContain("data-password-submit");
    expect(page).toContain('autocomplete="new-password"');
    expect(page).toContain("data-security-history-list");
    expect(page).toContain("data-security-history-empty");
    expect(page).toContain("data-security-history-refresh");
  });

  it("drives every tab from the account API with CSRF and no secret persistence", () => {
    for (const endpoint of [
      '"/api/app/account/enable-2fa-request"',
      '"/api/app/account/enable-2fa-verify"',
      '"/api/app/account/disable-2fa"',
      '"/api/app/account/change-password"',
      '"/api/app/account/login-history?limit=20"',
    ]) {
      expect(client).toContain(endpoint);
    }
    expect(client).toContain('"X-CSRF-Token": csrfToken()');
    expect(client).toContain("recent_auth_required");
    expect(client).toContain("two_factor_challenge_expired");
    // Outcomes are rendered through a fixed tone map, never raw server text.
    expect(client).toContain("two_factor_failed: \"danger\"");
    expect(client).toContain("history-outcome");
    expect(client).not.toContain("innerHTML");
    expect(client).not.toMatch(/localStorage|sessionStorage|console\./u);
    // OTP codes and passwords are read from inputs and sent, never logged.
    expect(client).not.toMatch(/console\.log\(\s*otp/iu);
  });

  it("renders invoice history with status tones and an accessible usage meter", () => {
    expect(billing).toContain("data-billing-invoices");
    expect(billing).toContain('import { listShopInvoices, type InvoiceStatus, type ShopInvoice } from "../../lib/billing/invoices";');
    // Tenant scoping goes through the billing:manage capability.
    expect(billing).toContain('getShopForMember({ capability: "billing:manage"');
    expect(billing).toContain("listShopInvoices({ env, shopId: member.row.shop_id })");
    // All seven invoice statuses map to a badge tone.
    for (const status of ["draft", "failed", "open", "paid", "past_due", "refunded", "void"]) {
      expect(billing).toMatch(new RegExp(`${status}: "(danger|info|neutral|success|warning)"`, "u"));
    }
    expect(billing).toContain('t(`dashboard.billing.invoices.status.${invoice.status}`)');
    expect(billing).toContain("dashboard.billing.invoices.empty_title");
    // Usage and limit merge into one progress indicator with tone thresholds.
    expect(billing).toContain('role="progressbar"');
    expect(billing).toContain("aria-valuemin={0}");
    expect(billing).toContain("aria-valuemax={limit}");
    expect(billing).toContain('percent >= 100 ? "danger" : percent >= 80 ? "warning" : "success"');
    // Provider transaction references must never reach the UI.
    expect(billing).not.toContain("provider_transaction_ref");
    expect(billing).not.toContain("providerTransactionRef");
  });

  it("adds the minimal 2FA OTP step to the marketing login without storage", () => {
    expect(login).toContain("data-login-2fa");
    expect(login).toContain("data-login-2fa-otp");
    expect(login).toContain("data-login-2fa-email");
    expect(login).toContain("data-login-2fa-submit");
    expect(login).toContain("data-login-2fa-resend");
    expect(login).toContain("data-login-2fa-back");
    expect(login).toContain("data-login-2fa-status");
    // The panel starts hidden; the classic login flow is untouched.
    expect(login).toMatch(/data-login-2fa[^>]*hidden/u);

    expect(loginClient).toContain("data.twoFactorRequired === true");
    expect(loginClient).toContain('fetch("/api/auth/login-2fa"');
    expect(loginClient).toContain("challengeToken: twoFactorChallengeToken");
    // The challenge token lives in a closure variable, never in web storage.
    expect(loginClient).not.toMatch(/localStorage|sessionStorage/u);
    expect(login).not.toMatch(/localStorage|sessionStorage/u);
  });

  it("provides English and Vietnamese copy for every new key", () => {
    const en = createDashboardTranslator("en-US");
    const vi = createDashboardTranslator("vi-VN");
    const dashboardKeys = [
      "dashboard.security.tabs.aria",
      "dashboard.security.tabs.sessions",
      "dashboard.security.tabs.two_factor",
      "dashboard.security.tabs.password",
      "dashboard.security.tabs.history",
      "dashboard.security.two_factor.title",
      "dashboard.security.two_factor.enable_action",
      "dashboard.security.two_factor.verify_submit",
      "dashboard.security.two_factor.resend",
      "dashboard.security.two_factor.send_otp",
      "dashboard.security.two_factor.disable_action",
      "dashboard.security.two_factor.cooldown",
      "dashboard.security.password.title",
      "dashboard.security.password.submit",
      "dashboard.security.history.title",
      "dashboard.security.history.empty_title",
      "dashboard.security.history.outcome.success",
      "dashboard.security.history.outcome.invalid_credentials",
      "dashboard.security.history.outcome.two_factor_failed",
      "dashboard.security.client.error.otp_expired",
      "dashboard.billing.invoices.title",
      "dashboard.billing.invoices.empty_title",
      "dashboard.billing.invoices.reference",
      "dashboard.billing.invoices.status.draft",
      "dashboard.billing.invoices.status.failed",
      "dashboard.billing.invoices.status.open",
      "dashboard.billing.invoices.status.paid",
      "dashboard.billing.invoices.status.past_due",
      "dashboard.billing.invoices.status.refunded",
      "dashboard.billing.invoices.status.void",
      "dashboard.billing.usage.of_limit",
      "dashboard.billing.usage.percent_used",
      "dashboard.billing.usage.no_numeric_limit",
    ];
    for (const key of dashboardKeys) {
      expect(en(key), `missing en copy for ${key}`).not.toBe("");
      expect(vi(key), `missing vi copy for ${key}`).not.toBe("");
    }

    const enSystem = createSystemTranslator("en-US");
    const viSystem = createSystemTranslator("vi-VN");
    for (const key of [
      "auth.login.two_factor.heading",
      "auth.login.two_factor.intro",
      "auth.login.two_factor.otp_label",
      "auth.login.two_factor.submit",
      "auth.login.two_factor.resend",
      "auth.login.two_factor.back",
      "auth.login.two_factor.expired",
    ]) {
      expect(enSystem(key), `missing en copy for ${key}`).not.toBe("");
      expect(viSystem(key), `missing vi copy for ${key}`).not.toBe("");
    }
  });
});
