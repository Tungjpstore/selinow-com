import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as LoginPOST } from "../../src/pages/api/auth/login";
import { POST as ForgotPasswordPOST } from "../../src/pages/api/auth/forgot-password";
import { POST as ResetPasswordPOST } from "../../src/pages/api/auth/reset-password";
import { POST as OtpVerifyPOST } from "../../src/pages/api/auth/otp/verify";
import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  claimOtpAdmission: vi.fn(),
  completeRegistrationWithOtp: vi.fn(),
  createAndSendOtp: vi.fn(),
  env: {
    APP_ENV: "staging",
    SESSION_COOKIE_NAME: "selinow_session",
  },
  loginWithPassword: vi.fn(),
  requestPasswordResetOtp: vi.fn(),
  resetPasswordWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/auth/admission", async (importOriginal) => ({
  ...(await importOriginal()),
  claimOtpAdmission: dependencies.claimOtpAdmission,
}));

vi.mock("../../src/lib/auth/session", async (importOriginal) => ({
  ...(await importOriginal()),
  completeRegistrationWithOtp: dependencies.completeRegistrationWithOtp,
  loginWithPassword: dependencies.loginWithPassword,
  requestPasswordResetOtp: dependencies.requestPasswordResetOtp,
  resetPasswordWithOtp: dependencies.resetPasswordWithOtp,
}));

vi.mock("../../src/lib/auth/otp", async (importOriginal) => ({
  ...(await importOriginal()),
  createAndSendOtp: dependencies.createAndSendOtp,
  verifyOtp: dependencies.verifyOtp,
}));

function createRequestContext(path: string, body: unknown) {
  return {
    locals: { requestId: "req-test-auth-route" },
    request: new Request(`https://app.selinow.com${path}`, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
  } as unknown as Parameters<typeof LoginPOST>[0];
}

beforeEach(() => {
  dependencies.claimOtpAdmission.mockReset();
  dependencies.claimOtpAdmission.mockResolvedValue(undefined);
  dependencies.loginWithPassword.mockReset();
  dependencies.requestPasswordResetOtp.mockReset();
  dependencies.resetPasswordWithOtp.mockReset();
  dependencies.completeRegistrationWithOtp.mockReset();
  dependencies.createAndSendOtp.mockReset();
  dependencies.verifyOtp.mockReset();
});

describe("auth routes: login, forgot-password, reset-password, otp-verify", () => {
  it("POST /api/auth/login sets session cookies on success", async () => {
    dependencies.loginWithPassword.mockResolvedValue({
      auth: {
        authenticatedAt: "2026-08-15T12:00:00.000Z",
        displayName: "Selinow Seller",
        email: "seller@selinow.com",
        sessionId: "ses_123",
        userId: "usr_123",
      },
      credentials: {
        csrfToken: "csrf-token-secret-1234567890",
        sessionToken: "session-token-secret-1234567890",
      },
      needsPasswordChange: false,
    });

    const response = await LoginPOST(
      createRequestContext("/api/auth/login", {
        email: "seller@selinow.com",
        password: "ValidPassword123!",
        rememberMe: true,
      }),
    );

    expect(response.status).toBe(200);
    const cookies = response.headers.get("Set-Cookie") ?? "";
    expect(cookies).toContain("selinow_session=session-token-secret-1234567890");
    expect(cookies).toContain("selinow_session_csrf=csrf-token-secret-1234567890");
  });

  it("POST /api/auth/login returns 423 when account is locked", async () => {
    dependencies.loginWithPassword.mockRejectedValue(
      new AppError("account_locked", 423, ["retry_after_900s"]),
    );

    const response = await LoginPOST(
      createRequestContext("/api/auth/login", {
        email: "seller@selinow.com",
        password: "WrongPassword123!",
      }),
    );

    expect(response.status).toBe(423);
  });

  it("POST /api/auth/forgot-password returns generic 200 ok", async () => {
    dependencies.requestPasswordResetOtp.mockResolvedValue({
      cooldownSeconds: 60,
      expiresAt: "2026-08-15T12:10:00.000Z",
    });

    const response = await ForgotPasswordPOST(
      createRequestContext("/api/auth/forgot-password", {
        email: "user@example.com",
      }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({ cooldownSeconds: 60, ok: true });
  });

  it("POST /api/auth/reset-password resets password successfully", async () => {
    dependencies.resetPasswordWithOtp.mockResolvedValue(undefined);

    const response = await ResetPasswordPOST(
      createRequestContext("/api/auth/reset-password", {
        email: "user@example.com",
        newPassword: "NewSuperPassword123!",
        otp: "123456",
      }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({ ok: true });
  });

  it("POST /api/auth/otp/verify with register_verify logs in user and sets cookies", async () => {
    dependencies.completeRegistrationWithOtp.mockResolvedValue({
      auth: {
        authenticatedAt: "2026-08-15T12:00:00.000Z",
        displayName: "New Seller",
        email: "new@selinow.com",
        sessionId: "ses_new",
        userId: "usr_new",
      },
      credentials: {
        csrfToken: "csrf-new-token-1234567890",
        sessionToken: "session-new-token-1234567890",
      },
    });

    const response = await OtpVerifyPOST(
      createRequestContext("/api/auth/otp/verify", {
        email: "new@selinow.com",
        otp: "654321",
        purpose: "register_verify",
      }),
    );

    expect(response.status).toBe(200);
    const cookies = response.headers.get("Set-Cookie") ?? "";
    expect(cookies).toContain("selinow_session=session-new-token-1234567890");
    const json = await response.json();
    expect(json).toMatchObject({
      ok: true,
      user: { email: "new@selinow.com" },
    });
  });

  it("rejects unknown OTP purposes before touching the OTP service", async () => {
    const response = await OtpVerifyPOST(
      createRequestContext("/api/auth/otp/verify", {
        email: "user@example.com",
        otp: "123456",
        purpose: "login_2fa_without_challenge",
      }),
    );

    expect(response.status).toBe(400);
    expect(dependencies.verifyOtp).not.toHaveBeenCalled();
  });




});
