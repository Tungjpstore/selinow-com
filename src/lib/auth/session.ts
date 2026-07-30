import { AppError } from "../core/errors";
import { constantTimeEqual, hmacToken } from "../core/crypto";
import { createId, createOpaqueToken } from "../core/ids";
import { clearCookie, parseCookies, serializeCookie } from "../http/cookies";
import type { AppBindings } from "../platform/bindings";
import { claimMagicLinkAdmission } from "./admission";
import { sendMagicLinkEmail } from "./email";
import { assertCsrfRequest } from "./policy";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const MAGIC_LINK_TTL_MINUTES = 15;
const MAGIC_LINK_INITIATION_TTL_SECONDS = MAGIC_LINK_TTL_MINUTES * 60;

type SessionRow = {
  authenticated_at: string;
  csrf_token_hash: string;
  display_name: string;
  email_normalized: string;
  expires_at: string;
  session_id: string;
  user_id: string;
  user_status: string;
};

type MagicLinkRow = {
  display_name: string;
  email_normalized: string;
  expires_at: string;
  token_id: string;
  user_id: string;
  user_status: string;
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

export type MagicLinkRequestResult = {
  debugMagicLink?: string;
  expiresAt: string;
  initiationBinding: string;
};

export function createSessionCredentials(): SessionCredentials {
  return {
    csrfToken: createOpaqueToken(),
    sessionToken: createOpaqueToken(),
  };
}

export async function requestMagicLink(input: {
  displayName: string;
  email: string;
  env: AppBindings;
  locale?: unknown;
  requesterAddress: string;
  now?: Date;
}): Promise<MagicLinkRequestResult> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_TTL_MINUTES * 60_000).toISOString();
  const rateLimitWindowStart = new Date(now.getTime() - MAGIC_LINK_TTL_MINUTES * 60_000).toISOString();
  await claimMagicLinkAdmission({
    env: input.env,
    now,
    requesterAddress: input.requesterAddress,
  });
  const userId = createId("usr");
  const tokenId = createId("mlt");
  const token = createOpaqueToken();
  const tokenHash = await hmacToken(input.env.MAGIC_LINK_SECRET, "magic-link", token);
  const initiationBinding = await hmacToken(input.env.MAGIC_LINK_SECRET, "magic-link-initiation", token);

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

  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO magic_link_tokens (
        id, user_id, token_hash, purpose, expires_at, created_at
      )
      SELECT ?, ?, ?, 'seller_login', ?, ?
      WHERE (
        SELECT COUNT(*) FROM magic_link_tokens
        WHERE user_id = ? AND created_at >= ?
      ) < 5
    `).bind(tokenId, resolvedUser.id, tokenHash, expiresAt, now.toISOString(), resolvedUser.id, rateLimitWindowStart),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw new AppError("rate_limited", 429);

  if (input.env.APP_ENV === "local") {
    return {
      debugMagicLink: `/api/auth/magic-link/consume?token=${encodeURIComponent(token)}`,
      expiresAt,
      initiationBinding,
    };
  }

  await sendMagicLinkEmail({
    email: input.email,
    env: input.env,
    locale: input.locale,
    token,
  });

  return { expiresAt, initiationBinding };
}

export async function consumeMagicLink(input: {
  env: AppBindings;
  initiationBinding: string;
  token: string;
}): Promise<{ auth: Omit<AuthContext, "csrfTokenHash">; credentials: SessionCredentials }> {
  if (input.token.length < 20 || input.token.length > 256) {
    throw new AppError("authentication_required", 401);
  }

  const expectedInitiationBinding = await hmacToken(
    input.env.MAGIC_LINK_SECRET,
    "magic-link-initiation",
    input.token,
  );
  if (!constantTimeEqual(input.initiationBinding, expectedInitiationBinding)) {
    throw new AppError("authentication_required", 401);
  }

  const now = new Date();
  const tokenHash = await hmacToken(input.env.MAGIC_LINK_SECRET, "magic-link", input.token);
  const magicLink = await input.env.PLATFORM_DB.prepare(`
    SELECT
      magic_link_tokens.id AS token_id,
      magic_link_tokens.user_id,
      magic_link_tokens.expires_at,
      platform_users.email_normalized,
      platform_users.display_name,
      platform_users.status AS user_status
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

  const credentials = createSessionCredentials();
  const sessionId = createId("ses");
  const sessionTokenHash = await hmacToken(input.env.SESSION_SECRET, "session", credentials.sessionToken);
  const csrfTokenHash = await hmacToken(input.env.SESSION_SECRET, "csrf", credentials.csrfToken);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString();

  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO auth_sessions (
        id, user_id, token_hash, csrf_token_hash, status, authenticated_at,
        expires_at, last_seen_at, created_at
      )
      SELECT ?, ?, ?, ?, 'active', ?, ?, ?, ?
      FROM magic_link_tokens
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
    `).bind(
      sessionId,
      magicLink.user_id,
      sessionTokenHash,
      csrfTokenHash,
      now.toISOString(),
      expiresAt,
      now.toISOString(),
      now.toISOString(),
      magicLink.token_id,
      now.toISOString(),
    ),
    input.env.PLATFORM_DB.prepare(`
      UPDATE magic_link_tokens
      SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
    `).bind(now.toISOString(), magicLink.token_id, now.toISOString()),
    input.env.PLATFORM_DB.prepare(`
      UPDATE platform_users
      SET status = 'active', last_login_at = ?, updated_at = ?
      WHERE id = ? AND status != 'suspended'
    `).bind(now.toISOString(), now.toISOString(), magicLink.user_id),
  ]);

  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new AppError("authentication_required", 401);
  }

  return {
    auth: {
      authenticatedAt: now.toISOString(),
      displayName: magicLink.display_name,
      email: magicLink.email_normalized,
      sessionId,
      userId: magicLink.user_id,
    },
    credentials,
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
      platform_users.status AS user_status
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

export function magicLinkInitiationCookieName(env: AppBindings): string {
  return `${env.SESSION_COOKIE_NAME}_magic_link`;
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
