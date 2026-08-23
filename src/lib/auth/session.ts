import { AppError } from "../core/errors";
import { constantTimeEqual, dummyVerifyPassword, hashPassword, hmacToken, verifyPassword } from "../core/crypto";
import { createId, createOpaqueToken } from "../core/ids";

import { clearCookie, parseCookies, serializeCookie } from "../http/cookies";
import type { AppBindings } from "../platform/bindings";
import { claimMagicLinkAdmission } from "./admission";
import { sendMagicLinkEmail, sendPasswordChangedAlertEmail } from "./email";
import { safeRelativeRedirect } from "./redirect";
import { recordLoginHistory } from "./login-history";
import { createAndSendOtp, OTP_TTL_MINUTES, verifyOtp } from "./otp";
import { assertCsrfRequest, validatePasswordStrength } from "./policy";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const SESSION_LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60_000;
const MAGIC_LINK_TTL_MINUTES = 15;
const MAGIC_LINK_INITIATION_TTL_SECONDS = MAGIC_LINK_TTL_MINUTES * 60;
const MAGIC_LINK_CONFIRMATION_TTL_SECONDS = 5 * 60;
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60_000; // 15 minutes

type SessionRow = {
  authenticated_at: string;
  csrf_token_hash: string;
  display_name: string;
  email_normalized: string;
  expires_at: string;
  session_id: string;
  user_id: string;
  user_status: string;
  password_hash: string | null;
};

type MagicLinkRow = {
  display_name: string;
  email_normalized: string;
  expires_at: string;
  token_id: string;
  user_id: string;
  user_status: string;
};

type UserAccountRow = {
  displayName: string;
  emailNormalized: string;
  failedLoginCount: number;
  lockedUntil: string | null;
  passwordHash: string | null;
  status: string;
  twoFactorEnabled: number;
  userId: string;
};

export type AuthContext = {
  authenticatedAt: string;
  csrfTokenHash: string;
  displayName: string;
  email: string;
  sessionId: string;
  userId: string;
};

export type SessionCredentials = {
  csrfToken: string;
  sessionToken: string;
};

export type SessionSummary = {
  authenticatedAt: string;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
  lastSeenAt: string;
  sessionId: string;
};

export type MagicLinkRequestResult = {
  challengeRequired: boolean;
  debugMagicLink?: string;
  expiresAt: string;
  initiationBinding: string;
};

export type PasswordLoginResult = {
  auth: Omit<AuthContext, "csrfTokenHash">;
  credentials: SessionCredentials;
  needsPasswordChange: boolean;
};

export type TwoFactorChallengeResult = {
  challengeToken: string;
  cooldownSeconds: number;
  /** Present only when APP_ENV=local — dev/test parity aid. */
  debugOtp?: string;
  expiresAt: string;
  twoFactorRequired: true;
};

export type PasswordLoginRequest = {
  email: string;
  password: string;
  rememberMe?: boolean;
};

export type BrowserMagicLinkConsumptionResult =
  | {
    confirmationBinding: string;
    confirmationRequired: true;
    maskedDestination: string;
  }
  | {
    auth: Omit<AuthContext, "csrfTokenHash">;
    confirmationRequired: false;
    credentials: SessionCredentials;
  };

export function createSessionCredentials(): SessionCredentials {
  return {
    csrfToken: createOpaqueToken(),
    sessionToken: createOpaqueToken(),
  };
}

async function activateMagicLinkReplacement(input: {
  env: AppBindings;
  expiresAt: string;
  now: Date;
  tokenId: string;
  userId: string;
}): Promise<void> {
  const nowIso = input.now.toISOString();
  const expiredIso = new Date(input.now.getTime() - 1).toISOString();
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE magic_link_tokens
      SET expires_at = ?
      WHERE user_id = ? AND purpose = 'seller_login' AND id != ?
        AND consumed_at IS NULL AND expires_at > ?
    `).bind(expiredIso, input.userId, input.tokenId, nowIso),

    input.env.PLATFORM_DB.prepare(`
      UPDATE magic_link_tokens
      SET expires_at = ?
      WHERE id = ? AND user_id = ? AND purpose = 'seller_login' AND consumed_at IS NULL
    `).bind(input.expiresAt, input.tokenId, input.userId),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) throw new AppError("provider_unavailable", 503);
}

export async function requestMagicLink(input: {
  challengePassed?: boolean;
  displayName: string;
  email: string;
  env: AppBindings;
  locale?: unknown;
  redirect?: string;
  requesterAddress: string;
  now?: Date;
}): Promise<MagicLinkRequestResult> {
  const now = input.now ?? new Date();
  const redirect = safeRelativeRedirect(input.redirect ?? null, "");
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MINUTES * 60_000).toISOString();
  const admission = await claimMagicLinkAdmission({
    ...(input.challengePassed === undefined ? {} : { challengePassed: input.challengePassed }),
    email: input.email,
    env: input.env,
    now,
    requesterAddress: input.requesterAddress,
  });
  const token = createOpaqueToken();
  const initiationBinding = await hmacToken(input.env.MAGIC_LINK_SECRET, "magic-link-initiation", token);
  if (!admission.deliveryPermitted) return { challengeRequired: true, expiresAt, initiationBinding };

  const userId = createId("usr");
  const tokenId = createId("mlt");
  const tokenHash = await hmacToken(input.env.MAGIC_LINK_SECRET, "magic-link", token);

  const user = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO platform_users (
      id, email_normalized, display_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'pending', ?, ?)
    ON CONFLICT(email_normalized) DO NOTHING
    RETURNING id
  `).bind(userId, input.email, input.displayName, now.toISOString(), now.toISOString()).first<{ id: string }>();

  const resolvedUser = user ?? await input.env.PLATFORM_DB.prepare(`
    SELECT id FROM platform_users WHERE email_normalized = ? LIMIT 1
  `).bind(input.email).first<{ id: string }>();
  if (resolvedUser === null) throw new AppError("provider_unavailable", 503);

  const inserted = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO magic_link_tokens (
      id, user_id, token_hash, purpose, expires_at, created_at
    )
    VALUES (?, ?, ?, 'seller_login', ?, ?)
  `).bind(tokenId, resolvedUser.id, tokenHash, now.toISOString(), now.toISOString()).run();
  if (inserted.meta.changes !== 1) throw new AppError("provider_unavailable", 503);

  if (input.env.APP_ENV === "local") {
    await activateMagicLinkReplacement({ env: input.env, expiresAt, now, tokenId, userId: resolvedUser.id });
    return {
      challengeRequired: false,
      debugMagicLink: (() => {
        const debugLink = new URL("/login", input.env.DASHBOARD_ORIGIN);
        if (redirect !== "") debugLink.searchParams.set("redirect", redirect);
        debugLink.hash = new URLSearchParams({ magic: token }).toString();
        return `${debugLink.pathname}${debugLink.search}${debugLink.hash}`;
      })(),
      expiresAt,
      initiationBinding,
    };
  }

  await sendMagicLinkEmail({
    email: input.email,
    env: input.env,
    locale: input.locale,
    ...(redirect === "" ? {} : { redirect }),
    token,
  });
  await activateMagicLinkReplacement({ env: input.env, expiresAt, now, tokenId, userId: resolvedUser.id });

  return { challengeRequired: false, expiresAt, initiationBinding };
}

function assertMagicLinkToken(token: string): void {
  if (token.length < 20 || token.length > 256) throw new AppError("authentication_required", 401);
}

async function loadMagicLink(env: AppBindings, token: string, now: Date): Promise<MagicLinkRow> {
  assertMagicLinkToken(token);
  const tokenHash = await hmacToken(env.MAGIC_LINK_SECRET, "magic-link", token);
  const magicLink = await env.PLATFORM_DB.prepare(`
    SELECT
      magic_link_tokens.id AS token_id,
      magic_link_tokens.user_id,
      magic_link_tokens.expires_at,
      platform_users.email_normalized,
      platform_users.display_name,
      platform_users.status AS user_status,
      platform_users.password_hash
    FROM magic_link_tokens
    INNER JOIN platform_users ON platform_users.id = magic_link_tokens.user_id
    WHERE magic_link_tokens.token_hash = ?
      AND magic_link_tokens.consumed_at IS NULL
      AND magic_link_tokens.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, now.toISOString()).first<MagicLinkRow>();

  if (magicLink === null || magicLink.user_status === "suspended") {
    throw new AppError("authentication_required", 401);
  }
  return magicLink;
}

async function loadUserAccountByEmail(env: AppBindings, email: string): Promise<UserAccountRow | null> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT 
      id AS userId, 
      email_normalized AS emailNormalized, 
      display_name AS displayName, 
      status, 
      password_hash AS passwordHash,
      COALESCE(failed_login_count, 0) AS failedLoginCount,
      locked_until AS lockedUntil,
      COALESCE(two_factor_enabled, 0) AS twoFactorEnabled
    FROM platform_users
    WHERE email_normalized = ?
    LIMIT 1
  `).bind(email).first<UserAccountRow>();

  return row ?? null;
}

async function loadUserAccountById(env: AppBindings, userId: string): Promise<UserAccountRow | null> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT 
      id AS userId, 
      email_normalized AS emailNormalized, 
      display_name AS displayName, 
      status, 
      password_hash AS passwordHash,
      COALESCE(failed_login_count, 0) AS failedLoginCount,
      locked_until AS lockedUntil,
      COALESCE(two_factor_enabled, 0) AS twoFactorEnabled
    FROM platform_users
    WHERE id = ?
    LIMIT 1
  `).bind(userId).first<UserAccountRow>();

  return row ?? null;
}

async function consumeLoadedMagicLink(input: {
  env: AppBindings;
  magicLink: MagicLinkRow;
  now: Date;
}): Promise<{ auth: Omit<AuthContext, "csrfTokenHash">; credentials: SessionCredentials }> {
  const credentials = createSessionCredentials();
  const sessionId = createId("ses");
  const sessionTokenHash = await hmacToken(input.env.SESSION_SECRET, "session", credentials.sessionToken);
  const csrfTokenHash = await hmacToken(input.env.SESSION_SECRET, "csrf", credentials.csrfToken);
  const expiresAt = new Date(input.now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();
  const nowIso = input.now.toISOString();

  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO auth_sessions (
        id, user_id, token_hash, csrf_token_hash, status, authenticated_at,
        expires_at, last_seen_at, created_at
      )
      SELECT ?, ?, ?, ?, 'active', ?, ?, ?, ?
      FROM magic_link_tokens
      INNER JOIN platform_users ON platform_users.id = magic_link_tokens.user_id
      WHERE magic_link_tokens.id = ? AND magic_link_tokens.consumed_at IS NULL AND magic_link_tokens.expires_at > ?

    `).bind(
      sessionId,
      input.magicLink.user_id,
      sessionTokenHash,
      csrfTokenHash,
      nowIso,
      expiresAt,
      nowIso,
      nowIso,
      input.magicLink.token_id,
      nowIso,
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE magic_link_tokens
      SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
    `).bind(nowIso, input.magicLink.token_id, nowIso),
    input.env.PLATFORM_DB.prepare(`
      UPDATE platform_users
      SET status = 'active', last_login_at = ?, updated_at = ?
      WHERE id = ? AND status != 'suspended'
    `).bind(nowIso, nowIso, input.magicLink.user_id),
  ]);


  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new AppError("authentication_required", 401);
  }

  return {
    auth: {
      authenticatedAt: nowIso,
      displayName: input.magicLink.display_name,
      email: input.magicLink.email_normalized,
      sessionId,
      userId: input.magicLink.user_id,
    },
    credentials,
  };
}

function maskEmailDestination(email: string): string {
  const separator = email.lastIndexOf("@");
  if (separator <= 0 || separator === email.length - 1) return "***";
  const local = email.slice(0, separator);
  const domain = email.slice(separator + 1);
  const labels = domain.split(".");
  const domainName = labels.shift() ?? "";
  const suffix = labels.length > 0 ? `.${labels.join(".")}` : "";
  return `${local.slice(0, 1)}***@${domainName.slice(0, 1)}***${suffix}`;
}

async function createMagicLinkConfirmationBinding(env: AppBindings, token: string, now: Date): Promise<string> {
  const expiresAt = Math.floor(now.getTime() / 1_000) + MAGIC_LINK_CONFIRMATION_TTL_SECONDS;
  const expiresAtText = String(expiresAt);
  const signature = await hmacToken(env.MAGIC_LINK_SECRET, "magic-link-confirmation", `${expiresAtText}:${token}`);
  return `${expiresAtText}.${signature}`;
}

async function confirmationBindingMatches(input: {
  binding: string;
  env: AppBindings;
  now: Date;
  token: string;
}): Promise<boolean> {
  const separator = input.binding.indexOf(".");
  if (separator <= 0) return false;
  const expiresAtText = input.binding.slice(0, separator);
  const providedSignature = input.binding.slice(separator + 1);
  if (!/^\d{10,13}$/u.test(expiresAtText) || providedSignature.length < 32 || providedSignature.length > 128) return false;
  const expiresAt = Number.parseInt(expiresAtText, 10);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(input.now.getTime() / 1_000)) return false;
  const expectedSignature = await hmacToken(
    input.env.MAGIC_LINK_SECRET,
    "magic-link-confirmation",
    `${String(expiresAt)}:${input.token}`,
  );
  return constantTimeEqual(providedSignature, expectedSignature);
}

export async function consumeMagicLink(input: {
  env: AppBindings;
  initiationBinding: string;
  now?: Date;
  token: string;
}): Promise<{ auth: Omit<AuthContext, "csrfTokenHash">; credentials: SessionCredentials }> {
  assertMagicLinkToken(input.token);
  const expectedInitiationBinding = await hmacToken(input.env.MAGIC_LINK_SECRET, "magic-link-initiation", input.token);
  if (!constantTimeEqual(input.initiationBinding, expectedInitiationBinding)) {
    throw new AppError("authentication_required", 401);
  }
  const now = input.now ?? new Date();
  return consumeLoadedMagicLink({ env: input.env, magicLink: await loadMagicLink(input.env, input.token, now), now });
}


async function issueSessionForUser(input: {
  env: AppBindings;
  now: Date;
  rememberMe?: boolean;
  user: UserAccountRow;
}): Promise<PasswordLoginResult> {
  const nowIso = input.now.toISOString();
  const credentials = createSessionCredentials();
  const sessionId = createId("ses");
  const sessionTokenHash = await hmacToken(input.env.SESSION_SECRET, "session", credentials.sessionToken);
  const csrfTokenHash = await hmacToken(input.env.SESSION_SECRET, "csrf", credentials.csrfToken);
  const ttlSeconds = input.rememberMe ? 30 * 24 * 60 * 60 : SESSION_TTL_SECONDS;
  const expiresAt = new Date(input.now.getTime() + ttlSeconds * 1000).toISOString();

  const result = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO auth_sessions (
      id, user_id, token_hash, csrf_token_hash, status, authenticated_at,
      expires_at, last_seen_at, created_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
    RETURNING id
  `).bind(
    sessionId,
    input.user.userId,
    sessionTokenHash,
    csrfTokenHash,
    nowIso,
    expiresAt,
    nowIso,
    nowIso,
  ).first();

  if (!result) throw new AppError("provider_unavailable", 503);

  return {
    auth: {
      authenticatedAt: nowIso,
      displayName: input.user.displayName,
      email: input.user.emailNormalized,
      sessionId,
      userId: input.user.userId,
    },
    credentials,
    needsPasswordChange: false,
  };
}

export async function issueSessionForUserId(input: {
  env: AppBindings;
  now?: Date;
  rememberMe?: boolean;
  userId: string;
}): Promise<PasswordLoginResult> {
  const user = await loadUserAccountById(input.env, input.userId);
  if (user === null || user.status !== "active") throw new AppError("authentication_required", 401);
  return issueSessionForUser({
    env: input.env,
    now: input.now ?? new Date(),
    ...(input.rememberMe === undefined ? {} : { rememberMe: input.rememberMe }),
    user,
  });
}

export async function issueTwoFactorChallengeForUser(input: {
  env: AppBindings;
  now?: Date;
  rememberMe?: boolean;
  userId: string;
}): Promise<TwoFactorChallengeResult> {
  const now = input.now ?? new Date();
  const user = await loadUserAccountById(input.env, input.userId);
  if (user === null || user.status !== "active") throw new AppError("authentication_required", 401);
  const challenge = await createAndSendOtp({
    email: user.emailNormalized,
    env: input.env,
    now,
    purpose: "login_2fa",
    userId: user.userId,
  });
  const challengeToken = await createTwoFactorChallengeToken(
    input.env.SESSION_SECRET,
    user.emailNormalized,
    user.userId,
    input.rememberMe === true,
  );
  return {
    challengeToken,
    cooldownSeconds: challenge.cooldownSeconds,
    ...(challenge.debugOtp === undefined ? {} : { debugOtp: challenge.debugOtp }),
    expiresAt: challenge.expiresAt,
    twoFactorRequired: true,
  };
}

async function createTwoFactorChallengeToken(secret: string, email: string, userId: string, rememberMe: boolean): Promise<string> {
  const expiresAt = Date.now() + OTP_TTL_MINUTES * 60_000;
  const payload = `${email}:${String(expiresAt)}:${userId}:${rememberMe ? "1" : "0"}`;
  const signature = await hmacToken(secret, "login-2fa-challenge", payload);
  return `${btoa(payload)}.${signature}`;
}

async function verifyTwoFactorChallengeToken(secret: string, token: string): Promise<{ email: string; rememberMe: boolean; userId: string }> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError("authentication_required", 401);
  }
  const [encodedPayload, signature] = parts;
  let payload: string;
  try {
    payload = atob(encodedPayload);
  } catch {
    throw new AppError("authentication_required", 401);
  }
  const [email, expiresAtStr, userId, rememberMeFlag] = payload.split(":");
  if (!email || !expiresAtStr || !userId) {
    throw new AppError("authentication_required", 401);
  }
  const expiresAt = Number(expiresAtStr);
  if (isNaN(expiresAt) || Date.now() > expiresAt) {
    throw new AppError("validation_failed", 400, ["two_factor_challenge_expired"]);
  }
  const expectedSignature = await hmacToken(secret, "login-2fa-challenge", payload);
  if (!constantTimeEqual(signature, expectedSignature)) {
    throw new AppError("authentication_required", 401);
  }
  return { email, rememberMe: rememberMeFlag === "1", userId };
}

export async function loginWithPassword(input: {
  env: AppBindings;
  email: string;
  password: string;
  now?: Date;
  rememberMe?: boolean;
  requesterAddress?: string;
}): Promise<PasswordLoginResult | TwoFactorChallengeResult> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const requesterAddress = input.requesterAddress ?? "unknown";
  const user = await loadUserAccountByEmail(input.env, input.email);

  if (!user) {
    // Mitigate timing attack. No login history is recorded: an unresolved
    // email never has an account_id to attach the record to, and recording
    // arbitrary attacker-supplied emails would only add new PII exposure.
    await dummyVerifyPassword(input.password);
    throw new AppError("authentication_required", 401, ["invalid_credentials"]);
  }

  if (user.status === "suspended") {
    await recordLoginHistory({ env: input.env, now, outcome: "account_suspended", requesterAddress, userId: user.userId });
    throw new AppError("authentication_required", 401, ["account_suspended"]);
  }

  // Check account lockout
  if (user.lockedUntil && Date.parse(user.lockedUntil) > now.getTime()) {
    await recordLoginHistory({ env: input.env, now, outcome: "account_locked", requesterAddress, userId: user.userId });
    const remainingSeconds = Math.ceil((Date.parse(user.lockedUntil) - now.getTime()) / 1000);
    throw new AppError("account_locked", 423, [`retry_after_${String(remainingSeconds)}s`]);
  }


  if (!user.passwordHash) {
    await recordLoginHistory({ env: input.env, now, outcome: "invalid_credentials", requesterAddress, userId: user.userId });
    throw new AppError("authentication_required", 401, ["password_not_set"]);
  }

  const isValid = await verifyPassword(input.password, user.passwordHash);

  if (!isValid) {
    const nextFailed = user.failedLoginCount + 1;
    let lockedUntil: string | null = null;
    if (nextFailed >= MAX_FAILED_LOGIN_ATTEMPTS) {
      lockedUntil = new Date(now.getTime() + LOCKOUT_DURATION_MS).toISOString();
    }

    await input.env.PLATFORM_DB.prepare(`
      UPDATE platform_users
      SET failed_login_count = ?, locked_until = ?, updated_at = ?
      WHERE id = ?
    `).bind(nextFailed, lockedUntil, nowIso, user.userId).run();

    if (lockedUntil) {
      await recordLoginHistory({ env: input.env, now, outcome: "account_locked", requesterAddress, userId: user.userId });
      throw new AppError("account_locked", 423, ["too_many_attempts_account_locked"]);
    }
    await recordLoginHistory({ env: input.env, now, outcome: "invalid_credentials", requesterAddress, userId: user.userId });
    throw new AppError("authentication_required", 401, ["invalid_credentials"]);
  }

  // Password is valid - check user verification status
  if (user.status === "pending" || user.status === "unverified") {
    await recordLoginHistory({ env: input.env, now, outcome: "email_unverified", requesterAddress, userId: user.userId });
    throw new AppError("email_unverified", 403, ["email_verification_required"]);
  }

  // Reset failed login counter and clear lock
  await input.env.PLATFORM_DB.prepare(`
    UPDATE platform_users
    SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, updated_at = ?
    WHERE id = ?
  `).bind(nowIso, nowIso, user.userId).run();

  if (user.twoFactorEnabled === 1) {
    const challenge = await createAndSendOtp({
      email: user.emailNormalized,
      env: input.env,
      now,
      purpose: "login_2fa",
      userId: user.userId,
    });
    const challengeToken = await createTwoFactorChallengeToken(
      input.env.SESSION_SECRET,
      user.emailNormalized,
      user.userId,
      input.rememberMe === true,
    );
    await recordLoginHistory({ env: input.env, now, outcome: "two_factor_required", requesterAddress, userId: user.userId });
    return {
      challengeToken,
      cooldownSeconds: challenge.cooldownSeconds,
      // Local/test aid only; createAndSendOtp attaches this when APP_ENV=local.
      ...(challenge.debugOtp === undefined ? {} : { debugOtp: challenge.debugOtp }),
      expiresAt: challenge.expiresAt,
      twoFactorRequired: true,
    };
  }

  const result = await issueSessionForUser({ env: input.env, now, ...(input.rememberMe === undefined ? {} : { rememberMe: input.rememberMe }), user });
  await recordLoginHistory({ env: input.env, now, outcome: "success", requesterAddress, userId: user.userId });
  return result;
}

/**
 * Completes an email-OTP two-factor login challenge issued by
 * loginWithPassword. Verifying the OTP reuses otp.ts's existing
 * attempts/cooldown enforcement, so this endpoint cannot become a new
 * brute-force vector beyond what already protects purpose "login_2fa".
 */
export async function completeTwoFactorLogin(input: {
  challengeToken: string;
  env: AppBindings;
  now?: Date;
  otp: string;
  requesterAddress?: string;
}): Promise<PasswordLoginResult> {
  const now = input.now ?? new Date();
  const requesterAddress = input.requesterAddress ?? "unknown";
  const { email, rememberMe, userId } = await verifyTwoFactorChallengeToken(input.env.SESSION_SECRET, input.challengeToken);

  try {
    await verifyOtp({ email, env: input.env, now, otp: input.otp, purpose: "login_2fa" });
  } catch (error) {
    await recordLoginHistory({ env: input.env, now, outcome: "two_factor_failed", requesterAddress, userId });
    throw error;
  }

  const user = await loadUserAccountById(input.env, userId);
  if (!user || user.status === "suspended") {
    throw new AppError("authentication_required", 401);
  }
  if (user.lockedUntil && Date.parse(user.lockedUntil) > now.getTime()) {
    throw new AppError("account_locked", 423, ["account_locked_during_two_factor"]);
  }

  const result = await issueSessionForUser({ env: input.env, now, rememberMe, user });
  await recordLoginHistory({ env: input.env, now, outcome: "success", requesterAddress, userId });
  return result;
}

export async function completeRegistrationWithOtp(input: {
  email: string;
  env: AppBindings;
  now?: Date;
  otp: string;
}): Promise<{ auth: Omit<AuthContext, "csrfTokenHash">; credentials: SessionCredentials }> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  // Verify OTP
  await verifyOtp({
    email: input.email,
    env: input.env,
    now,
    otp: input.otp,
    purpose: "register_verify",
  });

  const user = await loadUserAccountByEmail(input.env, input.email);
  if (!user) throw new AppError("authentication_required", 401);

  // Activate user account
  await input.env.PLATFORM_DB.prepare(`
    UPDATE platform_users
    SET status = 'active', email_verified_at = ?, updated_at = ?, last_login_at = ?
    WHERE id = ? AND status != 'suspended'
  `).bind(nowIso, nowIso, nowIso, user.userId).run();

  const credentials = createSessionCredentials();
  const sessionId = createId("ses");
  const sessionTokenHash = await hmacToken(input.env.SESSION_SECRET, "session", credentials.sessionToken);
  const csrfTokenHash = await hmacToken(input.env.SESSION_SECRET, "csrf", credentials.csrfToken);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();

  await input.env.PLATFORM_DB.prepare(`
    INSERT INTO auth_sessions (
      id, user_id, token_hash, csrf_token_hash, status, authenticated_at,
      expires_at, last_seen_at, created_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
  `).bind(
    sessionId,
    user.userId,
    sessionTokenHash,
    csrfTokenHash,
    nowIso,
    expiresAt,
    nowIso,
    nowIso,
  ).run();


  return {
    auth: {
      authenticatedAt: nowIso,
      displayName: user.displayName,
      email: user.emailNormalized,
      sessionId,
      userId: user.userId,
    },
    credentials,
  };
}

export async function requestPasswordResetOtp(input: {
  email: string;
  env: AppBindings;
  locale?: unknown;
  now?: Date;
}): Promise<{ cooldownSeconds: number; debugOtp?: string; expiresAt: string }> {
  const user = await loadUserAccountByEmail(input.env, input.email);
  if (!user || user.status === "suspended") {
    // Generic simulated return to avoid account enumeration
    return {
      cooldownSeconds: 60,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
  }

  return createAndSendOtp({
    ...(input.locale === undefined ? {} : { locale: input.locale }),
    ...(input.now === undefined ? {} : { now: input.now }),
    email: input.email,
    env: input.env,
    purpose: "password_reset",
    userId: user.userId,
  });
}

export async function createPasswordResetToken(secret: string, email: string, userId?: string | null): Promise<string> {
  const expiresAt = Date.now() + 15 * 60 * 1000;
  const payload = `${email}:${String(expiresAt)}:${userId ?? ""}`;
  const signature = await hmacToken(secret, "password-reset-token", payload);
  const encodedPayload = btoa(payload);
  return `${encodedPayload}.${signature}`;
}

export async function verifyPasswordResetToken(secret: string, email: string, token: string): Promise<void> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError("authentication_required", 401);
  }
  const [encodedPayload, signature] = parts;
  let payload: string;
  try {
    payload = atob(encodedPayload);
  } catch {
    throw new AppError("authentication_required", 401);
  }
  const [tokenEmail, expiresAtStr] = payload.split(":");
  if (tokenEmail !== email || !expiresAtStr) {
    throw new AppError("authentication_required", 401);
  }
  const expiresAt = Number(expiresAtStr);
  if (isNaN(expiresAt) || Date.now() > expiresAt) {
    throw new AppError("validation_failed", 400, ["reset_token_expired"]);
  }
  const expectedSig = await hmacToken(secret, "password-reset-token", payload);
  if (!constantTimeEqual(signature, expectedSig)) {
    throw new AppError("authentication_required", 401);
  }
}

export async function resetPasswordWithOtp(input: {
  email: string;
  env: AppBindings;
  locale?: unknown;
  newPassword: string;
  now?: Date;
  otp?: string;
  resetToken?: string;
}): Promise<void> {
  const validatedPassword = validatePasswordStrength(input.newPassword);
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  if (input.resetToken) {
    await verifyPasswordResetToken(input.env.SESSION_SECRET, input.email, input.resetToken);
  } else if (input.otp) {
    await verifyOtp({
      ...(input.now === undefined ? {} : { now }),
      email: input.email,
      env: input.env,
      otp: input.otp,
      purpose: "password_reset",
    });
  } else {
    throw new AppError("validation_failed", 400, ["otp_or_token_required"]);
  }


  const user = await loadUserAccountByEmail(input.env, input.email);
  if (!user || user.status === "suspended") {
    throw new AppError("authentication_required", 401);
  }

  const newHash = await hashPassword(validatedPassword);

  // Update password, clear lockouts, and revoke ALL active sessions
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE platform_users
      SET password_hash = ?, failed_login_count = 0, locked_until = NULL,
          status = 'active', updated_at = ?
      WHERE id = ?
    `).bind(newHash, nowIso, user.userId),
    input.env.PLATFORM_DB.prepare(`
      UPDATE auth_sessions
      SET status = 'revoked', revoked_at = ?
      WHERE user_id = ? AND status = 'active'
    `).bind(nowIso, user.userId),
  ]);

  // Send security alert email
  await sendPasswordChangedAlertEmail({
    email: input.email,
    env: input.env,
    locale: input.locale,
  });
}

export async function consumeMagicLinkFromBrowser(input: {
  confirmationBinding: string;
  confirm: boolean;
  env: AppBindings;
  existingSession: boolean;
  initiationBinding: string;
  token: string;
}): Promise<BrowserMagicLinkConsumptionResult> {
  const now = new Date();
  const magicLink = await loadMagicLink(input.env, input.token, now);
  const expectedInitiationBinding = await hmacToken(input.env.MAGIC_LINK_SECRET, "magic-link-initiation", input.token);
  const initiationMatches = constantTimeEqual(input.initiationBinding, expectedInitiationBinding);

  if (input.confirm) {
    if (!await confirmationBindingMatches({
      binding: input.confirmationBinding,
      env: input.env,
      now,
      token: input.token,
    })) throw new AppError("authentication_required", 401);
    return {
      confirmationRequired: false,
      ...await consumeLoadedMagicLink({ env: input.env, magicLink, now }),
    };
  }

  if (input.existingSession || !initiationMatches) {
    return {
      confirmationBinding: await createMagicLinkConfirmationBinding(input.env, input.token, now),
      confirmationRequired: true,
      maskedDestination: maskEmailDestination(magicLink.email_normalized),
    };
  }

  return {
    confirmationRequired: false,
    ...await consumeLoadedMagicLink({ env: input.env, magicLink, now }),
  };
}

export async function authenticateRequest(request: Request, env: AppBindings): Promise<AuthContext> {
  const sessionToken = parseCookies(request.headers.get("Cookie")).get(env.SESSION_COOKIE_NAME);
  if (sessionToken === undefined || sessionToken.length < 20) {
    throw new AppError("authentication_required", 401);
  }

  const tokenHash = await hmacToken(env.SESSION_SECRET, "session", sessionToken);
  const now = new Date().toISOString();
  const session = await env.PLATFORM_DB.prepare(`
    SELECT
      auth_sessions.id AS session_id,
      auth_sessions.authenticated_at,
      auth_sessions.user_id,
      auth_sessions.csrf_token_hash,
      auth_sessions.expires_at,
      platform_users.email_normalized,
      platform_users.display_name,
      platform_users.status AS user_status,
      platform_users.password_hash
    FROM auth_sessions
    INNER JOIN platform_users ON platform_users.id = auth_sessions.user_id
    WHERE auth_sessions.token_hash = ?
      AND auth_sessions.status = 'active'
      AND auth_sessions.revoked_at IS NULL
      AND auth_sessions.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, now).first<SessionRow>();

  if (session === null || session.user_status !== "active") {
    throw new AppError("authentication_required", 401);
  }

  const lastSeenCutoff = new Date(Date.parse(now) - SESSION_LAST_SEEN_WRITE_INTERVAL_MS).toISOString();
  try {
    await env.PLATFORM_DB.prepare(`
      UPDATE auth_sessions SET last_seen_at = ?
      WHERE id = ? AND user_id = ? AND status = 'active' AND revoked_at IS NULL
        AND last_seen_at < ?
    `).bind(now, session.session_id, session.user_id, lastSeenCutoff).run();
  } catch {
    // Activity metadata must not turn a valid session into an availability failure.
  }

  return {
    authenticatedAt: session.authenticated_at,
    csrfTokenHash: session.csrf_token_hash,
    displayName: session.display_name,
    email: session.email_normalized,
    sessionId: session.session_id,
    userId: session.user_id,
  };
}

export function requireRecentAuth(auth: AuthContext, maximumAgeMinutes = 15): void {
  // Seller mutations no longer need a 15-minute step-up, but platform-risk
  // operations keep their explicitly tighter authentication-age policy.
  if (maximumAgeMinutes >= 15) return;
  const authenticatedAt = Date.parse(auth.authenticatedAt);
  if (!Number.isFinite(authenticatedAt) || Date.now() - authenticatedAt > maximumAgeMinutes * 60_000) {
    throw new AppError("recent_auth_required", 403);
  }
}

export async function requireCsrfSession(request: Request, env: AppBindings): Promise<AuthContext> {
  const auth = await authenticateRequest(request, env);
  await assertCsrfRequest({
    csrfCookieName: `${env.SESSION_COOKIE_NAME}_csrf`,
    csrfTokenHash: auth.csrfTokenHash,
    dashboardOrigin: env.DASHBOARD_ORIGIN,
    request,
    sessionSecret: env.SESSION_SECRET,
  });
  return auth;
}

export async function revokeSession(auth: AuthContext, env: AppBindings): Promise<void> {
  const now = new Date().toISOString();
  await env.PLATFORM_DB.prepare(`
    UPDATE auth_sessions
    SET status = 'revoked', revoked_at = ?
    WHERE id = ? AND user_id = ? AND status = 'active'
  `).bind(now, auth.sessionId, auth.userId).run();
}

export async function listSessions(auth: AuthContext, env: AppBindings): Promise<SessionSummary[]> {
  const rows = await env.PLATFORM_DB.prepare(`
    SELECT id AS sessionId, authenticated_at AS authenticatedAt,
      created_at AS createdAt, expires_at AS expiresAt, last_seen_at AS lastSeenAt
    FROM auth_sessions
    WHERE user_id = ? AND status = 'active' AND revoked_at IS NULL AND expires_at > ?
    ORDER BY last_seen_at DESC, id
  `).bind(auth.userId, new Date().toISOString()).all<SessionSummary>();
  return rows.results.map((row) => ({ ...row, isCurrent: row.sessionId === auth.sessionId }));
}

export async function revokeAllSessions(auth: AuthContext, env: AppBindings): Promise<number> {
  const result = await env.PLATFORM_DB.prepare(`
    UPDATE auth_sessions SET status = 'revoked', revoked_at = ?
    WHERE user_id = ? AND status = 'active' AND revoked_at IS NULL
  `).bind(new Date().toISOString(), auth.userId).run();
  return result.meta.changes;
}

export function magicLinkInitiationCookieName(env: AppBindings): string {
  return `${env.SESSION_COOKIE_NAME}_magic_link`;
}

export function magicLinkConfirmationCookieName(env: AppBindings): string {
  return `${env.SESSION_COOKIE_NAME}_magic_link_confirm`;
}

export function appendMagicLinkInitiationCookie(headers: Headers, binding: string, env: AppBindings): void {
  headers.append("Set-Cookie", serializeCookie(magicLinkInitiationCookieName(env), binding, {
    httpOnly: true,
    maxAge: MAGIC_LINK_INITIATION_TTL_SECONDS,
    sameSite: "Lax",
    secure: env.APP_ENV !== "local",
  }));
}

export function appendClearedMagicLinkInitiationCookie(headers: Headers, env: AppBindings): void {
  headers.append("Set-Cookie", clearCookie(magicLinkInitiationCookieName(env), env.APP_ENV !== "local", true));
}

export function appendMagicLinkConfirmationCookie(headers: Headers, binding: string, env: AppBindings): void {
  headers.append("Set-Cookie", serializeCookie(magicLinkConfirmationCookieName(env), binding, {
    httpOnly: true,
    maxAge: MAGIC_LINK_CONFIRMATION_TTL_SECONDS,
    sameSite: "Lax",
    secure: env.APP_ENV !== "local",
  }));
}

export function appendClearedMagicLinkConfirmationCookie(headers: Headers, env: AppBindings): void {
  headers.append("Set-Cookie", clearCookie(magicLinkConfirmationCookieName(env), env.APP_ENV !== "local", true));
}

export function appendSessionCookies(headers: Headers, credentials: SessionCredentials, env: AppBindings): void {
  const secure = env.APP_ENV !== "local";
  headers.append("Set-Cookie", serializeCookie(env.SESSION_COOKIE_NAME, credentials.sessionToken, {
    httpOnly: true,
    maxAge: SESSION_TTL_SECONDS,
    sameSite: "Lax",
    secure,
  }));
  headers.append("Set-Cookie", serializeCookie(`${env.SESSION_COOKIE_NAME}_csrf`, credentials.csrfToken, {
    httpOnly: false,
    maxAge: SESSION_TTL_SECONDS,
    sameSite: "Strict",
    secure,
  }));
}

export function appendClearedSessionCookies(headers: Headers, env: AppBindings): void {
  const secure = env.APP_ENV !== "local";
  headers.append("Set-Cookie", clearCookie(env.SESSION_COOKIE_NAME, secure, true));
  headers.append("Set-Cookie", clearCookie(`${env.SESSION_COOKIE_NAME}_csrf`, secure, false));
}
