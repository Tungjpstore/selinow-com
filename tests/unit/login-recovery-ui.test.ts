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
    expect(controller).toContain('linkUrl.pathname !== "/api/auth/magic-link/consume"');
    expect(controller).toContain('link.textContent = t("auth.login.debug_link")');
    expect(controller).not.toContain("link.textContent = token");
  });
});
