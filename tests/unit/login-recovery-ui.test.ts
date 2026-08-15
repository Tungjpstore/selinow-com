import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("auth account & password UI contracts", () => {
  const loginPage = readFileSync("src/pages/login.astro", "utf8");
  const registerPage = readFileSync("src/pages/register.astro", "utf8");
  const forgotPage = readFileSync("src/pages/forgot-password.astro", "utf8");
  const controller = readFileSync("src/scripts/marketing/auth.ts", "utf8");
  const catalog = readFileSync("src/lib/i18n/catalogs/system.ts", "utf8");

  it("offers password login with remember me and navigation to register / forgot-password", () => {
    expect(loginPage).toContain("data-login-form");
    expect(loginPage).toContain("data-login-email");
    expect(loginPage).toContain("data-login-password");
    expect(loginPage).toContain("data-login-remember");
    expect(loginPage).toContain('href="/forgot-password"');
    expect(loginPage).toContain('href="/register"');
    expect(controller).toContain('fetch("/api/auth/login"');
  });

  it("provides user registration with 6-digit email OTP verification step", () => {
    expect(registerPage).toContain("data-register-form");
    expect(registerPage).toContain("data-otp-section");
    expect(registerPage).toContain("data-otp-container");
    expect(registerPage).toContain("data-otp-digit");
    expect(registerPage).toContain("data-otp-verify-submit");
    expect(registerPage).toContain("data-otp-resend");
    expect(controller).toContain('fetch("/api/auth/register"');
    expect(controller).toContain('fetch("/api/auth/otp/verify"');
    expect(controller).toContain('fetch("/api/auth/otp/resend"');
  });

  it("provides password reset with email OTP confirmation", () => {
    expect(forgotPage).toContain("data-forgot-form");
    expect(forgotPage).toContain("data-reset-section");
    expect(forgotPage).toContain("data-reset-otp-container");
    expect(forgotPage).toContain("data-reset-new-password");
    expect(forgotPage).toContain("data-reset-confirm-new-password");
    expect(forgotPage).toContain("data-reset-submit");
    expect(controller).toContain('fetch("/api/auth/forgot-password"');
    expect(controller).toContain('fetch("/api/auth/reset-password"');
  });

  it("does not persist plain credentials in browser storage", () => {
    expect(controller).not.toContain("localStorage");
    expect(controller).not.toContain("sessionStorage");
    expect(controller).not.toContain("console.");
  });

  it("redirects login to the canonical dashboard origin before submitting", () => {
    expect(loginPage).toContain("Astro.url.origin !== env.DASHBOARD_ORIGIN");
    expect(loginPage).toContain("return Astro.redirect(canonicalLogin.toString(), 308)");
  });

  it("includes all necessary security i18n messages", () => {
    expect(catalog).toContain('"auth.login.account_locked"');
    expect(catalog).toContain('"auth.register.password_weak"');
    expect(catalog).toContain('"auth.register.password_mismatch"');
    expect(catalog).toContain('"auth.otp.invalid"');
    expect(catalog).toContain('"auth.otp.cooldown"');
  });
});
