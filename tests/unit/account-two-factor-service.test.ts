import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  confirmTwoFactorEnrollment,
  disableTwoFactor,
  getTwoFactorStatus,
  requestTwoFactorEnrollmentOtp,
} from "../../src/lib/auth/two-factor";
import type { AuthContext } from "../../src/lib/auth/session";
import { hashPassword } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";

type MockOtpRow = {
  attempts_count: number;
  consumed_at: string | null;
  created_at: string;
  email_normalized: string;
  expires_at: string;
  id: string;
  max_attempts: number;
  otp_hash: string;
  purpose: string;
  user_id: string | null;
};

type MockUserRow = {
  passwordHash: string;
  status: string;
  twoFactorEnabled: number;
  twoFactorEnabledAt: string | null;
};

const USER_ID = "usr_2fa_test";
const EMAIL = "seller@selinow.com";
const CURRENT_PASSWORD = "CurrentPassword123!";

describe("account two-factor service", () => {
  let otpDatabase: Map<string, MockOtpRow>;
  let user: MockUserRow;
  let env: AppBindings;
  let auth: AuthContext;

  beforeEach(async () => {
    otpDatabase = new Map();
    user = {
      passwordHash: await hashPassword(CURRENT_PASSWORD),
      status: "active",
      twoFactorEnabled: 0,
      twoFactorEnabledAt: null,
    };
    auth = {
      authenticatedAt: "2026-08-15T10:00:00.000Z",
      csrfTokenHash: "csrf-hash",
      displayName: "Seller",
      email: EMAIL,
      sessionId: "session-current",
      userId: USER_ID,
    };

    const makeStatement = (query: string, boundArgs: readonly unknown[] = []) => ({
      all: () => Promise.resolve({ results: [] }),
      bind: (...args: readonly unknown[]) => makeStatement(query, args),
      first: <T>() => {
        if (query.includes("FROM platform_users") && query.includes("twoFactorEnabledAt")) {
          return Promise.resolve({
            twoFactorEnabled: user.twoFactorEnabled,
            twoFactorEnabledAt: user.twoFactorEnabledAt,
          } as T);
        }
        if (query.includes("FROM platform_users") && query.includes("passwordHash")) {
          return Promise.resolve({
            passwordHash: user.passwordHash,
            status: user.status,
            twoFactorEnabled: user.twoFactorEnabled,
          } as T);
        }
        if (query.includes("SELECT created_at FROM auth_email_otps")) {
          const [email, purpose] = boundArgs as [string, string];
          const rows = Array.from(otpDatabase.values())
            .filter((r) => r.email_normalized === email && r.purpose === purpose)
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
          return Promise.resolve((rows[0] ?? null) as T);
        }
        if (query.includes("SELECT id, user_id, otp_hash")) {
          const [email, purpose, nowIso] = boundArgs as [string, string, string];
          const rows = Array.from(otpDatabase.values())
            .filter(
              (r) =>
                r.email_normalized === email &&
                r.purpose === purpose &&
                r.consumed_at === null &&
                r.expires_at > nowIso,
            )
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
          return Promise.resolve((rows[0] ?? null) as T);
        }
        return Promise.resolve(null as T);
      },
      run: () => {
        if (query.includes("INSERT INTO auth_email_otps")) {
          const [id, user_id, email_normalized, purpose, otp_hash, max_attempts, expires_at, created_at] = boundArgs as [
            string,
            string | null,
            string,
            string,
            string,
            number,
            string,
            string,
          ];
          otpDatabase.set(id, {
            attempts_count: 0,
            consumed_at: null,
            created_at,
            email_normalized,
            expires_at,
            id,
            max_attempts,
            otp_hash,
            purpose,
            user_id,
          });
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (query.includes("SET attempts_count = ?, consumed_at = ?")) {
          const [attempts, consumedAt, id] = boundArgs as [number, string, string];
          const existing = otpDatabase.get(id);
          if (existing) {
            existing.attempts_count = attempts;
            existing.consumed_at = consumedAt;
          }
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (query.includes("SET attempts_count = ?")) {
          const [attempts, id] = boundArgs as [number, string];
          const existing = otpDatabase.get(id);
          if (existing) existing.attempts_count = attempts;
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (query.includes("SET consumed_at = ?")) {
          const [consumedAt, id] = boundArgs as [string, string];
          const existing = otpDatabase.get(id);
          if (existing) existing.consumed_at = consumedAt;
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (query.includes("SET expires_at = ?")) {
          const [expiresAt, email, purpose] = boundArgs as [string, string, string];
          for (const row of otpDatabase.values()) {
            if (row.email_normalized === email && row.purpose === purpose && !row.consumed_at) {
              row.expires_at = expiresAt;
            }
          }
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (query.includes("SET two_factor_enabled = 1")) {
          const [enabledAt] = boundArgs as [string];
          user.twoFactorEnabled = 1;
          user.twoFactorEnabledAt = enabledAt;
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (query.includes("SET two_factor_enabled = 0")) {
          user.twoFactorEnabled = 0;
          user.twoFactorEnabledAt = null;
          return Promise.resolve({ meta: { changes: 1 } });
        }
        return Promise.resolve({ meta: { changes: 0 } });
      },
    });

    env = {
      APP_ENV: "local",
      EMAIL: { send: vi.fn().mockResolvedValue(undefined) },
      EMAIL_FROM_ADDRESS: "noreply@selinow.com",
      EMAIL_FROM_NAME: "Selinow Security",
      IDENTIFIER_HMAC_SECRET: "test-identifier-hmac-secret",
      PLATFORM_DB: {
        batch: vi.fn(async (statements: readonly { run: () => Promise<{ meta: { changes: number } }> }[]) => {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          return results;
        }),
        prepare: vi.fn((query: string) => makeStatement(query)),
      },
      SESSION_SECRET: "test-session-secret-entropy-123456789",
    } as unknown as AppBindings;
  });

  it("reports disabled status before enrollment", async () => {
    await expect(getTwoFactorStatus({ env, userId: USER_ID })).resolves.toEqual({
      enabled: false,
      enabledAt: null,
    });
  });

  it("sends a login_2fa OTP when enrollment starts and enforces the cooldown", async () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const result = await requestTwoFactorEnrollmentOtp({ auth, env, now });

    expect(result.cooldownSeconds).toBe(60);
    expect(result.debugOtp).toHaveLength(6);
    expect(user.twoFactorEnabled).toBe(0);

    await expect(requestTwoFactorEnrollmentOtp({
      auth,
      env,
      now: new Date("2026-08-15T12:00:30.000Z"),
    })).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  });

  it("rejects enrollment requests when two-factor is already enabled", async () => {
    user.twoFactorEnabled = 1;
    user.twoFactorEnabledAt = "2026-08-01T00:00:00.000Z";

    await expect(requestTwoFactorEnrollmentOtp({ auth, env })).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["two_factor_already_enabled"],
      status: 409,
    });
  });

  it("enables two-factor only after the correct OTP is verified", async () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const requested = await requestTwoFactorEnrollmentOtp({ auth, env, now });

    const confirmed = await confirmTwoFactorEnrollment({
      auth,
      env,
      now,
      otp: requested.debugOtp ?? "",
    });

    expect(confirmed.enabledAt).toBe(now.toISOString());
    expect(user.twoFactorEnabled).toBe(1);
    expect(user.twoFactorEnabledAt).toBe(now.toISOString());
    await expect(getTwoFactorStatus({ env, userId: USER_ID })).resolves.toEqual({
      enabled: true,
      enabledAt: now.toISOString(),
    });
  });

  it("does not enable two-factor when the OTP is wrong", async () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    await requestTwoFactorEnrollmentOtp({ auth, env, now });

    await expect(confirmTwoFactorEnrollment({ auth, env, now, otp: "000000" })).rejects.toMatchObject({
      code: "validation_failed",
    });
    expect(user.twoFactorEnabled).toBe(0);
    expect(user.twoFactorEnabledAt).toBeNull();
  });

  it("refuses to confirm enrollment twice", async () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const requested = await requestTwoFactorEnrollmentOtp({ auth, env, now });
    await confirmTwoFactorEnrollment({ auth, env, now, otp: requested.debugOtp ?? "" });

    await expect(confirmTwoFactorEnrollment({ auth, env, now, otp: requested.debugOtp ?? "" })).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["two_factor_already_enabled"],
      status: 409,
    });
  });

  it("disables two-factor with the correct current password", async () => {
    user.twoFactorEnabled = 1;
    user.twoFactorEnabledAt = "2026-08-01T00:00:00.000Z";

    await disableTwoFactor({ auth, env, password: CURRENT_PASSWORD });

    expect(user.twoFactorEnabled).toBe(0);
    expect(user.twoFactorEnabledAt).toBeNull();
  });

  it("rejects disabling two-factor with a wrong password", async () => {
    user.twoFactorEnabled = 1;

    await expect(disableTwoFactor({ auth, env, password: "WrongPassword123!" })).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["current_password_invalid"],
      status: 400,
    });
    expect(user.twoFactorEnabled).toBe(1);
  });

  it("disables two-factor with a fresh OTP instead of the password", async () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const requested = await requestTwoFactorEnrollmentOtp({ auth, env, now });
    user.twoFactorEnabled = 1;

    await disableTwoFactor({ auth, env, now, otp: requested.debugOtp ?? "" });

    expect(user.twoFactorEnabled).toBe(0);
  });

  it("requires re-authentication before disabling two-factor", async () => {
    user.twoFactorEnabled = 1;

    await expect(disableTwoFactor({ auth, env })).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["reauthentication_required"],
      status: 400,
    });
    expect(user.twoFactorEnabled).toBe(1);
  });

  it("refuses to disable two-factor that is not enabled", async () => {
    await expect(disableTwoFactor({ auth, env, password: CURRENT_PASSWORD })).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["two_factor_not_enabled"],
      status: 409,
    });
  });

  it("blocks suspended accounts from every two-factor operation", async () => {
    user.status = "suspended";

    await expect(requestTwoFactorEnrollmentOtp({ auth, env })).rejects.toMatchObject({
      code: "authentication_required",
      status: 401,
    });
    await expect(confirmTwoFactorEnrollment({ auth, env, otp: "123456" })).rejects.toMatchObject({
      code: "authentication_required",
      status: 401,
    });
    await expect(disableTwoFactor({ auth, env, password: CURRENT_PASSWORD })).rejects.toMatchObject({
      code: "authentication_required",
      status: 401,
    });
  });
});
