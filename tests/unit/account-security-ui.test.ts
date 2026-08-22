import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createDashboardTranslator } from "../../src/lib/i18n/catalogs/dashboard";

describe("seller account security UI", () => {
  const layout = readFileSync("src/layouts/AppLayout.astro", "utf8");
  const page = readFileSync("src/pages/app/security.astro", "utf8");
  const client = readFileSync("src/scripts/dashboard/security.ts", "utf8");

  it("exposes account security navigation independently of shop ownership", () => {
    expect(layout).toContain('label: t("dashboard.console.nav.security")');
    expect(layout).toContain('path: "/app/security"');
    expect(layout).not.toContain('path: "/app/security", roles:');
    expect(page).toContain('activePath="/app/security"');
  });

  it("renders a responsive session-management surface without token fields", () => {
    expect(page).toContain("data-account-security-root");
    expect(page).toContain("data-security-session-list");
    expect(page).toContain("data-security-revoke-all");
    expect(page).toContain("data-csrf-cookie-name");
    expect(page).toContain("@media (max-width: 680px)");
    expect(page).not.toMatch(/sessionToken|tokenHash|csrfTokenHash/iu);
  });

  it("loads only safe metadata and marks the current session", () => {
    for (const field of ["authenticatedAt", "createdAt", "expiresAt", "isCurrent", "lastSeenAt"]) {
      expect(client).toContain(field);
    }
    expect(client).toContain('fetch("/api/auth/sessions"');
    expect(client).toContain('requestSessions("GET")');
    expect(client).toContain('t("dashboard.security.sessions.current")');
    expect(client).toContain("document.createElement");
    expect(client).not.toContain("innerHTML");
    expect(client).not.toMatch(/localStorage|sessionStorage|console\./u);
  });

  it("revokes all sessions with CSRF, recent-auth guidance, and safe request references", () => {
    expect(client).toContain('requestSessions("DELETE")');
    expect(client).toContain('"X-CSRF-Token": csrfToken()');
    expect(client).toContain("window.confirm");
    expect(client).toContain("recent_auth_required");
    expect(client).toContain("data-security-reauth");
    expect(client).toContain('t("dashboard.security.client.request_id", { requestId })');
    expect(client).toContain('window.location.assign("/login")');
  });

  it("links Google through a CSRF-protected request and validates the provider URL", () => {
    expect(page).toContain("data-google-link");
    expect(page).toContain("data-google-link-status");
    expect(client).toContain('fetch("/api/auth/google/start?flow=link"');
    expect(client).toContain('returnTo: "/app/security?tab=sessions"');
    expect(client).toContain('authorizationUrl.hostname !== "accounts.google.com"');
    expect(client).toContain('"X-CSRF-Token": csrfToken()');
    expect(client).toContain('next.searchParams.delete("google_error")');
  });

  it("provides complete English and Vietnamese copy", () => {
    const en = createDashboardTranslator("en-US");
    const vi = createDashboardTranslator("vi-VN");
    expect(en("dashboard.nav.security")).toBe("Account security");
    expect(vi("dashboard.nav.security")).toBe("Bảo mật tài khoản");
    expect(en("dashboard.security.sessions.current")).toBe("Current session");
    expect(vi("dashboard.security.sessions.current")).toBe("Phiên hiện tại");
  });
});
