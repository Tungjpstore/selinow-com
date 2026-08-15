import { AppError } from "../core/errors";
import { verifyPassword } from "../core/crypto";
import type { AppBindings } from "../platform/bindings";
import { createAndSendOtp, verifyOtp } from "./otp";
import type { AuthContext } from "./session";

type TwoFactorAccountRow = {
  passwordHash: string | null;
  status: string;
  twoFactorEnabled: number;
};

export type TwoFactorStatus = {
  enabled: boolean;
  enabledAt: string | null;
};

async function loadTwoFactorAccount(env: AppBindings, userId: string): Promise<TwoFactorAccountRow | null> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT password_hash AS passwordHash, status, COALESCE(two_factor_enabled, 0) AS twoFactorEnabled
    FROM platform_users
    WHERE id = ?
    LIMIT 1
  `).bind(userId).first<TwoFactorAccountRow>();
  return row ?? null;
}

/**
 * Read-only enrollment status for server-rendered account-security views.
 * Never mutates state; enrollment itself only changes through the OTP-confirmed
 * helpers below.
 */
export async function getTwoFactorStatus(input: { env: AppBindings; userId: string }): Promise<TwoFactorStatus> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT COALESCE(two_factor_enabled, 0) AS twoFactorEnabled, two_factor_enabled_at AS twoFactorEnabledAt
    FROM platform_users
    WHERE id = ?
    LIMIT 1
  `).bind(input.userId).first<{ twoFactorEnabled: number; twoFactorEnabledAt: string | null }>();
  return {
    enabled: row?.twoFactorEnabled === 1,
    enabledAt: row?.twoFactorEnabledAt ?? null,
  };
}

/**
 * Starts email-OTP two-factor enrollment by sending an OTP (purpose
 * "login_2fa") to the account's own email. Reuses the existing
 * createAndSendOtp cooldown/anti-spam guard from otp.ts.
 */
export async function requestTwoFactorEnrollmentOtp(input: {
  auth: AuthContext;
  env: AppBindings;
  locale?: unknown;
  now?: Date;
}): Promise<{ cooldownSeconds: number; debugOtp?: string; expiresAt: string }> {
  const account = await loadTwoFactorAccount(input.env, input.auth.userId);
  if (account === null || account.status === "suspended") {
    throw new AppError("authentication_required", 401);
  }
  if (account.twoFactorEnabled === 1) {
    throw new AppError("validation_failed", 409, ["two_factor_already_enabled"]);
  }

  return createAndSendOtp({
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(input.now === undefined ? {} : { now: input.now }),
    email: input.auth.email,
    env: input.env,
    purpose: "login_2fa",
    userId: input.auth.userId,
  });
}

/**
 * Confirms enrollment: verifying one OTP (reusing otp.ts's existing
 * attempts/expiry enforcement) is required before two_factor_enabled is
 * ever set. A bare toggle is never sufficient.
 */
export async function confirmTwoFactorEnrollment(input: {
  auth: AuthContext;
  env: AppBindings;
  now?: Date;
  otp: string;
}): Promise<{ enabledAt: string }> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  const account = await loadTwoFactorAccount(input.env, input.auth.userId);
  if (account === null || account.status === "suspended") {
    throw new AppError("authentication_required", 401);
  }
  if (account.twoFactorEnabled === 1) {
    throw new AppError("validation_failed", 409, ["two_factor_already_enabled"]);
  }

  await verifyOtp({
    email: input.auth.email,
    env: input.env,
    now,
    otp: input.otp,
    purpose: "login_2fa",
  });

  await input.env.PLATFORM_DB.prepare(`
    UPDATE platform_users
    SET two_factor_enabled = 1, two_factor_enabled_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(nowIso, nowIso, input.auth.userId).run();

  return { enabledAt: nowIso };
}

/**
 * Disables two-factor authentication. This is never a bare toggle: the
 * caller must re-prove account control with either the current password or
 * a fresh OTP (purpose "login_2fa"), both reusing existing verification
 * primitives from core/crypto and otp.ts.
 */
export async function disableTwoFactor(input: {
  auth: AuthContext;
  env: AppBindings;
  now?: Date;
  otp?: string;
  password?: string;
}): Promise<void> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  const account = await loadTwoFactorAccount(input.env, input.auth.userId);
  if (account === null || account.status === "suspended") {
    throw new AppError("authentication_required", 401);
  }
  if (account.twoFactorEnabled !== 1) {
    throw new AppError("validation_failed", 409, ["two_factor_not_enabled"]);
  }

  if (typeof input.password === "string" && input.password.length > 0) {
    const isValid = await verifyPassword(input.password, account.passwordHash);
    if (!isValid) throw new AppError("validation_failed", 400, ["current_password_invalid"]);
  } else if (typeof input.otp === "string" && input.otp.length > 0) {
    await verifyOtp({ email: input.auth.email, env: input.env, now, otp: input.otp, purpose: "login_2fa" });
  } else {
    throw new AppError("validation_failed", 400, ["reauthentication_required"]);
  }

  await input.env.PLATFORM_DB.prepare(`
    UPDATE platform_users
    SET two_factor_enabled = 0, two_factor_enabled_at = NULL, updated_at = ?
    WHERE id = ?
  `).bind(nowIso, input.auth.userId).run();
}
