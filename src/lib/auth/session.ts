import { AppError } from "../core/errors";
import { constantTimeEqual, hmacToken } from "../core/crypto";
import { createId, createOpaqueToken } from "../core/ids";
import { clearCookie, parseCookies, serializeCookie } from "../http/cookies";
import type { AppBindings } from "../platform/bindings";
import { claimMagicLinkAdmission } from "./admission";
import { sendMagicLinkEmail } from "./email";
import { assertCsrfRequest } from "./policy";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;
const SESSION_LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60_000;
const MAGIC_LINK_TTL_MINUTES = 15;
const MAGIC_LINK_INITIATION_TTL_SECONDS = MAGIC_LINK_TTL_MINUTES * 60;
const MAGIC_LINK_CONFIRMATION_TTL_SECONDS = 5 * 60;

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

export async function requestMagicLink(input: {
  challengePassed?: boolean;
  displayName: string;
  email: string;
  env: AppBindings;
  locale?: unknown;
  requesterAddress: string;
  now?: Date;
}): Promise<MagicLinkRequestResult> {
  const now = input.now ?? new Date();
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

  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO magic_link_tokens (
        id, user_id, token_hash, purpose, expires_at, created_at
      )
      VALUES (?, ?, ?, 'seller_login', ?, ?)
    `).bind(tokenId, resolvedUser.id, tokenHash, expiresAt, now.toISOString()),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw new AppError("provider_unavailable", 503);

  if (input.env.APP_ENV === "local") {
    return {
      challengeRequired: false,
      debugMagicLink: `/login#${new URLSearchParams({ magic: token }).toString()}`,
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
  return magicLink;
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
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
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
  token: string;
}): Promise<{ auth: Omit<AuthContext, "csrfTokenHash">; credentials: SessionCredentials }> {
  assertMagicLinkToken(input.token);
  const expectedInitiationBinding = await hmacToken(input.env.MAGIC_LINK_SECRET, "magic-link-initiation", input.token);
  if (!constantTimeEqual(input.initiationBinding, expectedInitiationBinding)) {
    throw new AppError("authentication_required", 401);
  }
  const now = new Date();
  return consumeLoadedMagicLink({ env: input.env, magicLink: await loadMagicLink(input.env, input.token, now), now });
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
