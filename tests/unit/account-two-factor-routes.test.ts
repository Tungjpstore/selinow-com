import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  confirm: vi.fn(),
  disable: vi.fn(),
  env: {
    APP_ENV: "staging",
    SESSION_COOKIE_NAME: "selinow_session",
  },
  recent: vi.fn(),
  requestOtp: vi.fn(),
  requireCsrf: vi.fn(),
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal()),
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recent,
}));

vi.mock("../../src/lib/auth/two-factor", () => ({
  confirmTwoFactorEnrollment: dependencies.confirm,
  disableTwoFactor: dependencies.disable,
  requestTwoFactorEnrollmentOtp: dependencies.requestOtp,
}));

import { POST as EnableRequestPOST } from "../../src/pages/api/app/account/enable-2fa-request";
import { POST as EnableVerifyPOST } from "../../src/pages/api/app/account/enable-2fa-verify";
import { POST as DisablePOST } from "../../src/pages/api/app/account/disable-2fa";

const auth = {
  authenticatedAt: "2026-08-15T11:55:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Seller",
  email: "seller@selinow.com",
  sessionId: "session-current",
  userId: "usr-seller",
};

function context(path: string, body?: unknown) {
  return {
    locals: { locale: "en-US", requestId: "request-account-2fa" },
    request: new Request(`https://app.example.test${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  } as unknown as Parameters<typeof EnableRequestPOST>[0];
}

beforeEach(() => {
  dependencies.confirm.mockReset();
  dependencies.disable.mockReset();
  dependencies.recent.mockReset();
  dependencies.requestOtp.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.requireCsrf.mockResolvedValue(auth);
});

describe("account two-factor routes", () => {
  it("POST enable-2fa-request requires CSRF + recent auth and returns cooldown metadata", async () => {
    dependencies.requestOtp.mockResolvedValue({
      cooldownSeconds: 60,
      expiresAt: "2026-08-15T12:10:00.000Z",
    });

    const response = await EnableRequestPOST(context("/api/app/account/enable-2fa-request"));

    expect(dependencies.recent).toHaveBeenCalledWith(auth);
    expect(dependencies.requestOtp).toHaveBeenCalledWith(expect.objectContaining({ auth, locale: "en-US" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      cooldownSeconds: 60,
      expiresAt: "2026-08-15T12:10:00.000Z",
      ok: true,
      requestId: "request-account-2fa",
    });
  });

  it("POST enable-2fa-request never fabricates a debug OTP outside local mode", async () => {
    dependencies.requestOtp.mockResolvedValue({ cooldownSeconds: 60, expiresAt: "2026-08-15T12:10:00.000Z" });

    const response = await EnableRequestPOST(context("/api/app/account/enable-2fa-request"));
    const json = await response.json();
    expect(json).not.toHaveProperty("debugOtp");
  });

  it("POST enable-2fa-request stops before the service when recent auth fails", async () => {
    dependencies.recent.mockImplementationOnce(() => {
      throw new AppError("recent_auth_required", 403);
    });

    const response = await EnableRequestPOST(context("/api/app/account/enable-2fa-request"));

    expect(response.status).toBe(403);
    expect(dependencies.requestOtp).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: "recent_auth_required" });
  });

  it("POST enable-2fa-request rejects unauthenticated callers", async () => {
    dependencies.requireCsrf.mockRejectedValueOnce(new AppError("csrf_invalid", 403));

    const response = await EnableRequestPOST(context("/api/app/account/enable-2fa-request"));

    expect(response.status).toBe(403);
    expect(dependencies.recent).not.toHaveBeenCalled();
    expect(dependencies.requestOtp).not.toHaveBeenCalled();
  });

  it("POST enable-2fa-verify confirms enrollment with the submitted OTP", async () => {
    dependencies.confirm.mockResolvedValue({ enabledAt: "2026-08-15T12:01:00.000Z" });

    const response = await EnableVerifyPOST(context("/api/app/account/enable-2fa-verify", { otp: "123456" }));

    expect(dependencies.confirm).toHaveBeenCalledWith(expect.objectContaining({ auth, otp: "123456" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      enabledAt: "2026-08-15T12:01:00.000Z",
      ok: true,
      requestId: "request-account-2fa",
    });
  });

  it("POST enable-2fa-verify rejects missing, oversized and unknown fields", async () => {
    for (const body of [{}, { otp: "" }, { otp: "1".repeat(17) }, { otp: "123456", remember: true }]) {
      const response = await EnableVerifyPOST(context("/api/app/account/enable-2fa-verify", body));
      expect(response.status).toBe(400);
      expect(dependencies.confirm).not.toHaveBeenCalled();
    }
  });

  it("POST disable-2fa accepts exactly one re-authentication proof", async () => {
    dependencies.disable.mockResolvedValue(undefined);

    const byPassword = await DisablePOST(context("/api/app/account/disable-2fa", { password: "CurrentPassword123!" }));
    expect(byPassword.status).toBe(200);
    expect(dependencies.disable).toHaveBeenLastCalledWith(expect.objectContaining({ password: "CurrentPassword123!" }));

    const byOtp = await DisablePOST(context("/api/app/account/disable-2fa", { otp: "654321" }));
    expect(byOtp.status).toBe(200);
    expect(dependencies.disable).toHaveBeenLastCalledWith(expect.objectContaining({ otp: "654321" }));
    await expect(byOtp.json()).resolves.toEqual({ ok: true, requestId: "request-account-2fa" });
  });

  it("POST disable-2fa rejects ambiguous or invalid payloads without touching the service", async () => {
    const ambiguous = await DisablePOST(context("/api/app/account/disable-2fa", { otp: "123456", password: "x" }));
    expect(ambiguous.status).toBe(400);
    await expect(ambiguous.json()).resolves.toMatchObject({ issues: ["reauthentication_ambiguous"] });

    const oversized = await DisablePOST(context("/api/app/account/disable-2fa", { password: "x".repeat(129) }));
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toMatchObject({ issues: ["reauthentication_invalid"] });

    const unknownField = await DisablePOST(context("/api/app/account/disable-2fa", { password: "x", token: "y" }));
    expect(unknownField.status).toBe(400);

    expect(dependencies.disable).not.toHaveBeenCalled();
  });

  it("POST disable-2fa forwards service failures such as two_factor_not_enabled", async () => {
    dependencies.disable.mockRejectedValue(new AppError("validation_failed", 409, ["two_factor_not_enabled"]));

    const response = await DisablePOST(context("/api/app/account/disable-2fa", { password: "CurrentPassword123!" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation_failed",
      issues: ["two_factor_not_enabled"],
    });
  });
});
