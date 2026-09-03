import { AppError } from "../core/errors";
import { constantTimeEqual, generateSecureOtp, hashOtp } from "../core/crypto";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { sendOtpEmail } from "./email";
import { normalizeOtp } from "./policy";

export type OtpPurpose = "register_verify" | "password_reset" | "login_2fa";

export const OTP_TTL_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_COOLDOWN_SECONDS = 60;

type OtpRow = {
  attempts_count: number;
  consumed_at: string | null;
  created_at: string;
  expires_at: string;
  id: string;
  max_attempts: number;
  otp_hash: string;
  purpose: string;
  user_id: string | null;
};

export async function createAndSendOtp(input: {
  email: string;
  env: AppBindings;
  locale?: unknown;
  now?: Date;
  purpose: OtpPurpose;
  userId?: string | null;
}): Promise<{ cooldownSeconds: number; debugOtp?: string; expiresAt: string }> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MINUTES * 60_000).toISOString();
  const cooldownCutoffIso = new Date(now.getTime() - OTP_COOLDOWN_SECONDS * 1_000).toISOString();
  const secret = input.env.SESSION_SECRET;

  // Check recent OTP to enforce cooldown (anti-spam)
  const recentOtp = await input.env.PLATFORM_DB.prepare(`
    SELECT created_at FROM auth_email_otps
    WHERE email_normalized = ? AND purpose = ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(input.email, input.purpose).first<{ created_at: string }>();

  if (recentOtp) {
    const elapsedSeconds = Math.floor((now.getTime() - Date.parse(recentOtp.created_at)) / 1000);
    if (elapsedSeconds < OTP_COOLDOWN_SECONDS) {
      throw new AppError("rate_limited", 429, [`cooldown_${String(OTP_COOLDOWN_SECONDS - elapsedSeconds)}s`]);
    }

  }

  // Generate secure 6-digit OTP
  const otp = generateSecureOtp(6);
  const otpHash = await hashOtp(secret, input.purpose, input.email, otp);
  const otpId = createId("otp");

  // The insert guard makes the cooldown atomic with issuance under concurrent requests.
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO auth_email_otps (
        id, user_id, email_normalized, purpose, otp_hash,
        attempts_count, max_attempts, expires_at, created_at
      )
      SELECT ?, ?, ?, ?, ?, 0, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM auth_email_otps
        WHERE email_normalized = ? AND purpose = ? AND created_at > ?
      )
    `).bind(
      otpId,
      input.userId ?? null,
      input.email,
      input.purpose,
      otpHash,
      OTP_MAX_ATTEMPTS,
      expiresAt,
      nowIso,
      input.email,
      input.purpose,
      cooldownCutoffIso,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE auth_email_otps
      SET expires_at = ?
      WHERE email_normalized = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ? AND id != ?
    `).bind(nowIso, input.email, input.purpose, nowIso, otpId),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    throw new AppError("rate_limited", 429, [`cooldown_${String(OTP_COOLDOWN_SECONDS)}s`]);
  }

  if (input.env.APP_ENV === "local") {
    return {
      cooldownSeconds: OTP_COOLDOWN_SECONDS,
      debugOtp: otp,
      expiresAt,
    };
  }

  await sendOtpEmail({
    email: input.email,
    env: input.env,
    locale: input.locale,
    otp,
    purpose: input.purpose,
    ttlMinutes: OTP_TTL_MINUTES,
  });

  return {
    cooldownSeconds: OTP_COOLDOWN_SECONDS,
    expiresAt,
  };
}

export async function verifyOtp(input: {
  email: string;
  env: AppBindings;
  now?: Date;
  otp: string;
  purpose: OtpPurpose;
}): Promise<{ email: string; userId: string | null }> {
  const normalizedCode = normalizeOtp(input.otp);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const secret = input.env.SESSION_SECRET;

  const otpRow = await input.env.PLATFORM_DB.prepare(`
    SELECT id, user_id, otp_hash, attempts_count, max_attempts, expires_at, created_at
    FROM auth_email_otps
    WHERE email_normalized = ? AND purpose = ?
      AND consumed_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(input.email, input.purpose, nowIso).first<OtpRow>();

  if (!otpRow) {
    throw new AppError("validation_failed", 400, ["otp_expired_or_invalid"]);
  }

  const expectedHash = await hashOtp(secret, input.purpose, input.email, normalizedCode);
  const isMatch = constantTimeEqual(otpRow.otp_hash, expectedHash);

  if (!isMatch) {
    const nextAttempts = otpRow.attempts_count + 1;
    if (nextAttempts >= otpRow.max_attempts) {
      // Burn this OTP after max attempts reached
      const burned = await input.env.PLATFORM_DB.prepare(`
        UPDATE auth_email_otps
        SET attempts_count = ?, consumed_at = ?
        WHERE id = ? AND attempts_count = ? AND consumed_at IS NULL
      `).bind(nextAttempts, nowIso, otpRow.id, otpRow.attempts_count).run();
      if (burned.meta.changes !== 1) throw new AppError("validation_failed", 400, ["otp_expired_or_invalid"]);
      throw new AppError("validation_failed", 400, ["otp_max_attempts_exceeded"]);
    }

    const incremented = await input.env.PLATFORM_DB.prepare(`
      UPDATE auth_email_otps
      SET attempts_count = ?
      WHERE id = ? AND attempts_count = ? AND consumed_at IS NULL
    `).bind(nextAttempts, otpRow.id, otpRow.attempts_count).run();
    if (incremented.meta.changes !== 1) throw new AppError("validation_failed", 400, ["otp_expired_or_invalid"]);

    const remaining = otpRow.max_attempts - nextAttempts;
    throw new AppError("validation_failed", 400, [`otp_incorrect_${String(remaining)}_left`]);

  }

  // Correct OTP - mark consumed
  const consumed = await input.env.PLATFORM_DB.prepare(`
    UPDATE auth_email_otps
    SET consumed_at = ?
    WHERE id = ? AND consumed_at IS NULL
  `).bind(nowIso, otpRow.id).run();
  if (consumed.meta.changes !== 1) {
    throw new AppError("validation_failed", 400, ["otp_expired_or_invalid"]);
  }

  return {
    email: input.email,
    userId: otpRow.user_id,
  };
}
