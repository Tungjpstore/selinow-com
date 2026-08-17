import { beforeEach, describe, expect, it, vi } from "vitest";

import { assertCsrfRequest } from "../../src/lib/auth/policy";
import { hmacToken } from "../../src/lib/core/crypto";
import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  env: {
    APP_ENV: "staging",
    SESSION_COOKIE_NAME: "selinow_session",
  },
  list: vi.fn(),
  recent: vi.fn(),
  requireCsrf: vi.fn(),
  revokeAll: vi.fn(),
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal()),
  listSessions: dependencies.list,
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recent,
  revokeAllSessions: dependencies.revokeAll,
}));

import { DELETE, GET } from "../../src/pages/api/auth/sessions";

const auth = {
  authenticatedAt: "2026-08-09T00:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Seller",
  email: "seller@example.test",
  sessionId: "session-current",
  userId: "user-seller",
};

function context(method: "DELETE" | "GET") {
  return {
    locals: { requestId: `request-sessions-${method.toLowerCase()}` },
    request: new Request("https://app.example.test/api/auth/sessions", { method }),
  } as unknown as Parameters<typeof GET>[0];
}

beforeEach(() => {
  dependencies.list.mockReset();
  dependencies.recent.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.revokeAll.mockReset();
  dependencies.requireCsrf.mockResolvedValue(auth);
});

describe("auth sessions route", () => {
  it("returns only safe active-session metadata with private response headers", async () => {
    dependencies.list.mockResolvedValue([{
      authenticatedAt: auth.authenticatedAt,
      createdAt: auth.authenticatedAt,
      expiresAt: "2026-08-23T00:00:00.000Z",
      isCurrent: true,
      lastSeenAt: "2026-08-09T00:05:00.000Z",
      sessionId: auth.sessionId,
    }]);

    const response = await GET(context("GET"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      requestId: "request-sessions-get",
      sessions: [expect.objectContaining({ isCurrent: true, sessionId: auth.sessionId })],
    });
  });

  it("requires recent authentication before revoking every session", async () => {
    dependencies.recent.mockImplementationOnce(() => {
      throw new AppError("recent_auth_required", 403);
    });

    const response = await DELETE(context("DELETE"));

    expect(response.status).toBe(403);
    expect(dependencies.revokeAll).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      code: "recent_auth_required",
      requestId: "request-sessions-delete",
    });
  });

  it("clears the current browser cookies after revoking all sessions", async () => {
    dependencies.revokeAll.mockResolvedValue(3);

    const response = await DELETE(context("DELETE"));

    expect(dependencies.recent).toHaveBeenCalledWith(auth);
    expect(dependencies.revokeAll).toHaveBeenCalledWith(auth, dependencies.env);
    expect(response.status).toBe(200);
    const cookies = response.headers.get("Set-Cookie") ?? "";
    expect(cookies).toContain("selinow_session=");
    expect(cookies).toContain("selinow_session_csrf=");
    expect(cookies).toContain("Max-Age=0");
    expect(cookies).toContain("Secure");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      requestId: "request-sessions-delete",
      revokedCount: 3,
    });
  });

  describe("Origin-less CSRF regression (incident 2026-08-17)", () => {
    const sessionSecret = "route-integration-session-secret-with-entropy";
    const dashboardOrigin = "https://app.example.test";
    const csrfToken = "route-csrf-token-with-more-than-twenty-characters";
    const csrfCookieName = "selinow_session_csrf";

    function requestWithCsrf(method: "DELETE" | "GET", origin?: string) {
      const headers: Record<string, string> = {
        Cookie: `selinow_session=session-token; ${csrfCookieName}=${csrfToken}`,
        "X-CSRF-Token": csrfToken,
      };
      if (origin !== undefined) {
        headers.Origin = origin;
      }
      return {
        locals: { requestId: `request-sessions-${method.toLowerCase()}` },
        request: new Request(`${dashboardOrigin}/api/auth/sessions`, { headers, method }),
      } as unknown as Parameters<typeof GET>[0];
    }

    beforeEach(() => {
      // Minimal stub that still runs the REAL assertCsrfRequest policy (not mocked).
      dependencies.requireCsrf.mockImplementation(async (request: Request) => {
        await assertCsrfRequest({
          csrfCookieName,
          csrfTokenHash: await hmacToken(sessionSecret, "csrf", csrfToken),
          dashboardOrigin,
          request,
          sessionSecret,
        });
        return auth;
      });
    });

    it("serves a same-origin GET with valid CSRF token and no Origin header", async () => {
      dependencies.list.mockResolvedValue([{
        authenticatedAt: auth.authenticatedAt,
        createdAt: auth.authenticatedAt,
        expiresAt: "2026-08-23T00:00:00.000Z",
        isCurrent: true,
        lastSeenAt: "2026-08-09T00:05:00.000Z",
        sessionId: auth.sessionId,
      }]);

      const response = await GET(requestWithCsrf("GET"));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true });
    });

    it("rejects an Origin-less DELETE even with a valid CSRF token (fail-closed)", async () => {
      const response = await DELETE(requestWithCsrf("DELETE"));

      expect(response.status).toBe(403);
      expect(dependencies.revokeAll).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toMatchObject({
        code: "csrf_invalid",
        requestId: "request-sessions-delete",
      });
    });
  });
});
