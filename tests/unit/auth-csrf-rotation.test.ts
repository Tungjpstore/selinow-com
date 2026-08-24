import { describe, expect, it } from "vitest";

import { appendCsrfCookie, rotateCsrfToken, type AuthContext } from "../../src/lib/auth/session";
import { hmacToken } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";

const auth: AuthContext = {
  authenticatedAt: "2026-08-24T11:29:35.563Z",
  csrfTokenHash: "old-current-csrf-hash",
  displayName: "Seller",
  email: "seller@example.test",
  sessionId: "session-current",
  userId: "user-current",
};

function environment() {
  const rows = new Map([
    [auth.sessionId, {
      csrfTokenHash: auth.csrfTokenHash,
      expiresAt: "2026-09-07T11:29:35.563Z",
      revokedAt: null as string | null,
      status: "active",
      userId: auth.userId,
    }],
    ["session-other", {
      csrfTokenHash: "other-session-csrf-hash",
      expiresAt: "2026-09-07T11:29:35.563Z",
      revokedAt: null as string | null,
      status: "active",
      userId: auth.userId,
    }],
  ]);
  const env = {
    APP_ENV: "staging",
    SESSION_COOKIE_NAME: "selinow_staging_session",
    SESSION_SECRET: "test-session-secret-with-sufficient-entropy",
    PLATFORM_DB: {
      prepare(sql: string) {
        expect(sql).toContain("UPDATE auth_sessions");
        return {
          bind(nextHash: string, sessionId: string, userId: string, now: string, previousHash: string) {
            return {
              run: () => {
                const row = rows.get(sessionId);
                const changes = row !== undefined
                  && row.userId === userId
                  && row.status === "active"
                  && row.revokedAt === null
                  && row.expiresAt > now
                  && row.csrfTokenHash === previousHash
                  ? 1
                  : 0;
                if (changes === 1 && row !== undefined) row.csrfTokenHash = nextHash;
                return { meta: { changes } };
              },
            };
          },
        };
      },
    },
  } as unknown as AppBindings;
  return { env, rows };
}

describe("CSRF token rotation", () => {
  it("atomically rebinds a new token to only the authenticated current session", async () => {
    const { env, rows } = environment();
    const token = await rotateCsrfToken(auth, env);

    expect(token).toHaveLength(43);
    expect(rows.get(auth.sessionId)?.csrfTokenHash).toBe(await hmacToken(env.SESSION_SECRET, "csrf", token));
    expect(rows.get("session-other")?.csrfTokenHash).toBe("other-session-csrf-hash");

    await expect(rotateCsrfToken(auth, env)).rejects.toMatchObject({
      code: "authentication_required",
      status: 401,
    });
  });

  it("sets one host-scoped CSRF cookie without replacing the session cookie", () => {
    const { env } = environment();
    const headers = new Headers();
    appendCsrfCookie(headers, "rotated-csrf-token-with-sufficient-length", env);

    expect(headers.getSetCookie()).toHaveLength(1);
    expect(headers.getSetCookie()[0]).toContain("selinow_staging_session_csrf=");
    expect(headers.getSetCookie()[0]).toContain("Path=/");
    expect(headers.getSetCookie()[0]).toContain("SameSite=Strict");
    expect(headers.getSetCookie()[0]).toContain("Secure");
    expect(headers.getSetCookie()[0]).not.toContain("Domain=");
    expect(headers.getSetCookie()[0]).not.toMatch(/^selinow_staging_session=/u);
  });
});
