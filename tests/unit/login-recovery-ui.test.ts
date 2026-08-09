import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("magic-link cross-browser recovery UI", () => {
  const page = readFileSync("src/pages/login.astro", "utf8");
  const controller = readFileSync("src/scripts/marketing/login.ts", "utf8");

  it("guides the user back to the requesting browser and offers safe recovery actions", () => {
    expect(page).toContain("data-login-recovery");
    expect(page).toContain("data-login-resend");
    expect(page).toContain("data-login-restart");
    expect(page).toContain('t("auth.login.recovery_same_browser")');
    expect(page).toContain('t("auth.login.recovery_wrong_device")');
    expect(controller).toContain("form?.requestSubmit()");
    expect(controller).toContain("form?.reset()");
  });

  it("does not persist, print, copy, or request a magic-link token", () => {
    expect(controller).not.toContain("localStorage");
    expect(controller).not.toContain("sessionStorage");
    expect(controller).not.toContain("console.");
    expect(controller).not.toContain("clipboard");
    expect(page).toContain('t("auth.login.recovery_privacy")');
  });

  it("keeps local debug navigation origin-bound without rendering token text", () => {
    expect(controller).toContain("linkUrl.origin !== window.location.origin");
    expect(controller).toContain('linkUrl.pathname !== "/login"');
    expect(controller).toContain('link.textContent = t("auth.login.debug_link")');
    expect(controller).not.toContain("link.textContent = token");
  });

  it("redirects login to the canonical dashboard origin before submitting", () => {
    expect(page).toContain("Astro.url.origin !== env.DASHBOARD_ORIGIN");
    expect(page).toContain("return Astro.redirect(canonicalLogin.toString(), 308)");
  });

  it("shows the safe request ID returned by failed login requests", () => {
    expect(controller).toContain('response.headers.get("X-Request-Id")');
    expect(controller).toContain('t("auth.login.request_id", { requestId })');
  });

  it("renders the adaptive challenge only after the server requests it", () => {
    expect(page).toContain("data-login-challenge");
    expect(page).toContain("data-login-turnstile");
    expect(page).toContain('data-action="magic_link_request"');
    expect(controller).toContain("body.challengeRequired === true");
    expect(controller).toContain('data.get("cf-turnstile-response")');
    expect(controller).toContain("turnstile.render");
    expect(controller).not.toContain("challengePassed");
  });

  it("clears fragment tokens before the confirmation flow and keeps them memory-only", () => {
    expect(page).toContain("data-login-confirmation");
    expect(page).toContain("data-login-confirm-destination");
    expect(page).toContain("data-login-confirm");
    expect(controller).toContain('new URLSearchParams(window.location.hash.slice(1)).get("magic")');
    expect(controller).toContain("window.history.replaceState");
    expect(controller).toContain('method: "POST"');
    expect(controller).toContain("body.confirmationRequired === true");
    expect(controller).not.toContain("localStorage");
    expect(controller).not.toContain("sessionStorage");
  });
});
