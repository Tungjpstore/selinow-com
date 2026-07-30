import { describe, expect, it } from "vitest";

import { assertCsrfRequest } from "../../src/lib/auth/policy";
import { createSessionCredentials } from "../../src/lib/auth/session";
import { hmacToken } from "../../src/lib/core/crypto";

describe("seller session and CSRF policy", () => {
  it("rotates opaque credentials instead of accepting a fixed session", () => {
    const attackerSession = "attacker-controlled-session-token";
    const first = createSessionCredentials();
    const second = createSessionCredentials();

    expect(first.sessionToken).not.toBe(attackerSession);
    expect(second.sessionToken).not.toBe(first.sessionToken);
    expect(second.csrfToken).not.toBe(first.csrfToken);
  });

  it("accepts a session-bound CSRF token from the exact dashboard origin", async () => {
    const secret = "test-session-secret-with-sufficient-entropy";
    const token = "csrf-token-with-more-than-twenty-characters";
    const request = new Request("https://app-staging.selinow.com/api/app/shops", {
      headers: {
        Cookie: `selinow_staging_session_csrf=${token}`,
        Origin: "https://app-staging.selinow.com",
        "X-CSRF-Token": token,
      },
      method: "POST",
    });

    await expect(assertCsrfRequest({
      csrfCookieName: "selinow_staging_session_csrf",
      csrfTokenHash: await hmacToken(secret, "csrf", token),
      dashboardOrigin: "https://app-staging.selinow.com",
      request,
      sessionSecret: secret,
    })).resolves.toBeUndefined();
  });

  it.each([
    ["https://evil.example", "csrf-token-with-more-than-twenty-characters", "csrf-token-with-more-than-twenty-characters"],
    ["https://app-staging.selinow.com", "header-token-with-more-than-twenty", "cookie-token-with-more-than-twenty"],
  ])("rejects invalid origin or double-submit token", async (origin, headerToken, cookieToken) => {
    const secret = "test-session-secret-with-sufficient-entropy";
    const request = new Request("https://app-staging.selinow.com/api/app/shops", {
      headers: {
        Cookie: `selinow_staging_session_csrf=${cookieToken}`,
        Origin: origin,
        "X-CSRF-Token": headerToken,
      },
      method: "POST",
    });

    await expect(assertCsrfRequest({
      csrfCookieName: "selinow_staging_session_csrf",
      csrfTokenHash: await hmacToken(secret, "csrf", cookieToken),
      dashboardOrigin: "https://app-staging.selinow.com",
      request,
      sessionSecret: secret,
    })).rejects.toMatchObject({ code: "csrf_invalid", status: 403 });
  });
});
