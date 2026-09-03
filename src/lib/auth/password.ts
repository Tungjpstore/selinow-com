import { AppError } from "../core/errors";
import { hashPassword, verifyPassword } from "../core/crypto";
import type { AppBindings } from "../platform/bindings";
import { sendPasswordChangedAlertEmail } from "./email";
import { validatePasswordStrength } from "./policy";
import type { AuthContext } from "./session";

type PasswordAccountRow = {
  passwordHash: string | null;
  status: string;
};

async function loadPasswordAccount(env: AppBindings, userId: string): Promise<PasswordAccountRow | null> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT password_hash AS passwordHash, status
    FROM platform_users
    WHERE id = ?
    LIMIT 1
  `).bind(userId).first<PasswordAccountRow>();
  return row ?? null;
}

/**
 * Changes the authenticated user's password. Requires the current password
 * (reusing the existing WebCrypto verify/hash pair from core/crypto), then
 * revokes every other active session while keeping the current one alive,
 * matching the "Session Revocation on password change" pattern already used
 * by resetPasswordWithOtp.
 */
export async function changePassword(input: {
  auth: AuthContext;
  currentPassword: string;
  env: AppBindings;
  locale?: unknown;
  newPassword: string;
  now?: Date;
}): Promise<{ revokedSessionCount: number }> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  const account = await loadPasswordAccount(input.env, input.auth.userId);
  if (account === null || account.status === "suspended") {
    throw new AppError("authentication_required", 401);
  }

  const isCurrentPasswordValid = await verifyPassword(input.currentPassword, account.passwordHash);
  if (!isCurrentPasswordValid) {
    throw new AppError("validation_failed", 400, ["current_password_invalid"]);
  }

  const validatedNewPassword = validatePasswordStrength(input.newPassword);
  const isSameAsCurrent = await verifyPassword(validatedNewPassword, account.passwordHash);
  if (isSameAsCurrent) {
    throw new AppError("validation_failed", 400, ["password_same_as_current"]);
  }

  const newHash = await hashPassword(validatedNewPassword);

  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE platform_users SET password_hash = ?, updated_at = ? WHERE id = ?
    `).bind(newHash, nowIso, input.auth.userId),
    input.env.PLATFORM_DB.prepare(`
      UPDATE auth_sessions
      SET status = 'revoked', revoked_at = ?
      WHERE user_id = ? AND status = 'active' AND id != ?
    `).bind(nowIso, input.auth.userId, input.auth.sessionId),
  ]);

  await sendPasswordChangedAlertEmail({
    email: input.auth.email,
    env: input.env,
    locale: input.locale,
  });

  return { revokedSessionCount: results[1]?.meta.changes ?? 0 };
}
