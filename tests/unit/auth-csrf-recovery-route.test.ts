import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  appendCookie: vi.fn(),
  authenticate: vi.fn(),
  env: {
    APP_ENV: "staging",
    DASHBOARD_ORIGIN: "https://app-staging.selinow.com",
    SESSION_COOKIE_NAME: "selinow_staging_session",
  },
  rotate: vi.fn(),
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal()),
  appendCsrfCookie: dependencies.appendCookie,
  authenticateRequest: dependencies.authenticate,
  rotateCsrfToken: dependencies.rotate,
}));

import { POST } from "../../src/pages/api/auth/csrf/refresh";

const auth = {
  authenticatedAt: "2026-08-24T11:29:35.563Z",
  csrfTokenHash: "old-csrf-hash",
  displayName: "Seller",
  email: "seller@example.test",
  sessionId: "session-current",
  userId: "user-current",
};

function context(origin = dependencies.env.DASHBOARD_ORIGIN) {
  return {
    locals: { requestId: "request-csrf-recovery" },
    request: new Request(`${dependencies.env.DASHBOARD_ORIGIN}/api/auth/csrf/refresh`, {
      headers: { Origin: origin },
      method: "POST",
    }),
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  dependencies.appendCookie.mockReset();
  dependencies.authenticate.mockReset();
  dependencies.rotate.mockReset();
  dependencies.authenticate.mockResolvedValue(auth);
  dependencies.rotate.mockResolvedValue("rotated-csrf-token-with-sufficient-length");
});

describe("CSRF recovery route", () => {
  it("authenticates and rotates only the current session from the exact dashboard origin", async () => {
    const response = await POST(context());

    expect(dependencies.authenticate).toHaveBeenCalledOnce();
    expect(dependencies.rotate).toHaveBeenCalledWith(auth, dependencies.env);
    expect(dependencies.appendCookie).toHaveBeenCalledWith(
      response.headers,
      "rotated-csrf-token-with-sufficient-length",
      dependencies.env,
      expect.any(Number),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({ ok: true, requestId: "request-csrf-recovery" });
  });

  it("rejects cross-origin and unauthenticated recovery without rotating", async () => {
    const crossOrigin = await POST(context("https://evil.example"));
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toMatchObject({ code: "csrf_invalid", issues: ["origin_mismatch"] });
    expect(dependencies.authenticate).not.toHaveBeenCalled();
    expect(dependencies.rotate).not.toHaveBeenCalled();

    dependencies.authenticate.mockRejectedValueOnce(new AppError("authentication_required", 401));
    const unauthenticated = await POST(context());
    expect(unauthenticated.status).toBe(401);
    expect(dependencies.rotate).not.toHaveBeenCalled();
    expect(dependencies.appendCookie).not.toHaveBeenCalled();
  });
});
