import { hmacToken } from "../core/crypto";
import { subscriptionAllows } from "../billing/entitlements";
import { AppError } from "../core/errors";
import { createId, createOpaqueToken } from "../core/ids";
import { requireResourceId } from "../catalog/policy";
import { matchSupportedLocale } from "../i18n/locale";
import type { AppBindings } from "../platform/bindings";
import {
  decryptTelegramCredentialRow,
  type TelegramCredentialRow,
} from "../telegram/credentials";
import { verifyTelegramMiniAppInitData } from "./mini-app";

const SESSION_TTL_SECONDS = 15 * 60;
const INIT_DATA_MAX_AGE_SECONDS = 5 * 60;
const RATE_WINDOW_SECONDS = 60;
const RATE_LIMIT = 12;

type MiniAppContextRow = TelegramCredentialRow & {
  channelConnectionId: string | null;
  connectorRequestId: string;
  connectorStatus: "active";
  credentialVersion: number;
  integrationStatus: string;
  publicShopId: string;
  shopId: string;
  shopStatus: string;
  subscriptionState: string;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
};

type SessionRow = {
  channelConnectionId: string | null;
  credentialId: string;
  credentialVersion: number;
  expiresAt: string;
  integrationId: string;
  issuedAt: string;
  lastSeenAt: string;
  sessionId: string;
  shopId: string;
  subjectHash: string;
  customerId: string;
  identityId: string;
};

export type TelegramMiniAppSession = {
  expiresAt: string;
  sessionId: string;
  sessionToken: string;
  user: {
    languageCode: string | null;
  };
};

export type TelegramMiniAppSessionContext = SessionRow & {
  connectorStatus: "active";
  graceEndsAt?: string | null;
  subscriptionState?: string;
  trialEndsAt?: string | null;
};

function requesterAddress(value: string): string {
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128 ? normalized : "unknown";
}

async function claimAdmission(input: { env: AppBindings; now: Date; requesterAddress: string; shopId: string }): Promise<void> {
  const windowStartMs = Math.floor(input.now.getTime() / (RATE_WINDOW_SECONDS * 1_000)) * RATE_WINDOW_SECONDS * 1_000;
  const windowStartedAt = new Date(windowStartMs).toISOString();
  const windowEndsAt = new Date(windowStartMs + RATE_WINDOW_SECONDS * 1_000).toISOString();
  const subjectHash = await hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    `telegram-mini-app-admission:${input.shopId}`,
    requesterAddress(input.requesterAddress),
  );
  const row = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO security_rate_limits (
      id, shop_id, scope_key, action, subject_hash,
      window_started_at, window_ends_at, request_count, blocked_count,
      blocked_until, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'telegram_mini_app_session', ?, ?, ?, 1, 0, NULL, 1, ?, ?)
    ON CONFLICT(scope_key, action, subject_hash, window_started_at)
    DO UPDATE SET
      request_count = security_rate_limits.request_count + 1,
      blocked_count = security_rate_limits.blocked_count + CASE
        WHEN security_rate_limits.request_count + 1 > ? THEN 1 ELSE 0 END,
      blocked_until = CASE
        WHEN security_rate_limits.request_count + 1 > ? THEN excluded.window_ends_at
        ELSE security_rate_limits.blocked_until END,
      version = security_rate_limits.version + 1,
      updated_at = excluded.updated_at
    RETURNING request_count AS requestCount
  `).bind(
    createId("lim"),
    input.shopId,
    `telegram-mini-app:${input.shopId}`,
    subjectHash,
    windowStartedAt,
    windowEndsAt,
    input.now.toISOString(),
    input.now.toISOString(),
    RATE_LIMIT,
    RATE_LIMIT,
  ).first<{ requestCount: number }>();
  if (row === null) throw new AppError("telegram_mini_app_admission_failed", 500);
  if (row.requestCount > RATE_LIMIT) throw new AppError("rate_limited", 429);
}

async function loadContext(env: AppBindings, shopPublicId: string): Promise<MiniAppContextRow> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT
      shops.id AS shopId,
      shops.public_id AS publicShopId,
      shops.status AS shopStatus,
      shop_subscriptions.state AS subscriptionState,
      shop_subscriptions.trial_ends_at AS trialEndsAt,
      shop_subscriptions.grace_ends_at AS graceEndsAt,
      telegram_integrations.id AS integrationId,
      telegram_integrations.channel_connection_id AS linkedConnectionId,
      channel_connections.id AS channelConnectionId,
      telegram_integrations.status AS integrationStatus,
      telegram_credentials.id AS credentialId,
      telegram_credentials.status,
      telegram_credentials.version AS credentialVersion,
      telegram_credentials.key_version AS keyVersion,
      telegram_credentials.bot_token_ciphertext_b64 AS botTokenCiphertextB64,
      telegram_credentials.bot_token_iv_b64 AS botTokenIvB64,
      telegram_credentials.webhook_secret_ciphertext_b64 AS webhookSecretCiphertextB64,
      telegram_credentials.webhook_secret_iv_b64 AS webhookSecretIvB64,
      telegram_credentials.token_fingerprint AS tokenFingerprint,
      telegram_credentials.webhook_secret_digest AS webhookSecretDigest,
      channel_connector_requests.id AS connectorRequestId,
      channel_connector_requests.status AS connectorStatus
    FROM shops
    INNER JOIN shop_subscriptions
      ON shop_subscriptions.shop_id = shops.id
    INNER JOIN plans
      ON plans.id = shop_subscriptions.plan_id
      AND plans.is_active = 1
    INNER JOIN telegram_integrations
      ON telegram_integrations.shop_id = shops.id
      AND telegram_integrations.status IN ('active', 'degraded')
      AND telegram_integrations.webhook_status = 'verified'
    INNER JOIN telegram_credentials
      ON telegram_credentials.id = telegram_integrations.active_credential_id
      AND telegram_credentials.integration_id = telegram_integrations.id
      AND telegram_credentials.shop_id = shops.id
      AND telegram_credentials.status = 'active'
    LEFT JOIN channel_connections
      ON channel_connections.id = telegram_integrations.channel_connection_id
      AND channel_connections.shop_id = shops.id
      AND channel_connections.provider_code = 'telegram'
      AND channel_connections.status IN ('active', 'degraded')
    INNER JOIN channel_connector_requests
      ON channel_connector_requests.shop_id = shops.id
      AND channel_connector_requests.channel_code = 'telegram.mini_app'
      AND channel_connector_requests.provider_code = 'telegram.mini_app'
      AND channel_connector_requests.status = 'active'
    WHERE shops.public_id = ? AND shops.status = 'active'
    ORDER BY channel_connector_requests.created_at DESC, channel_connector_requests.id DESC
    LIMIT 1
  `).bind(requireResourceId(shopPublicId, "shop")).first<MiniAppContextRow>();
  if (row === null) throw new AppError("channel_mini_app_unavailable", 409);
  if (!subscriptionAllows({ graceEndsAt: row.graceEndsAt, subscriptionState: row.subscriptionState, trialEndsAt: row.trialEndsAt })) {
    throw new AppError("channel_mini_app_unavailable", 409);
  }
  return row;
}

function displayHandle(user: { firstName: string; lastName: string | null; username: string | null }): string {
  if (user.username !== null) return `@${user.username}`.slice(0, 128);
  return `${user.firstName}${user.lastName === null ? "" : ` ${user.lastName}`}`.slice(0, 128);
}

async function ensureMiniAppIdentity(input: {
  env: AppBindings;
  now: string;
  context: MiniAppContextRow;
  subjectHash: string;
  userId: string;
  user: { firstName: string; lastName: string | null; languageCode: string | null; username: string | null };
}): Promise<{ customerId: string; identityId: string }> {
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT id AS identityId, customer_id AS customerId
    FROM customer_identities
    WHERE shop_id = ? AND provider = 'telegram' AND external_subject = ?
    LIMIT 1
  `).bind(input.context.shopId, input.subjectHash).first<{ customerId: string; identityId: string }>();
  if (existing !== null) return existing;
  const legacySubjectHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `telegram-user:${input.context.shopId}`, input.userId);
  const legacy = await input.env.PLATFORM_DB.prepare(`
    SELECT customer_id AS customerId
    FROM customer_identities
    WHERE shop_id = ? AND provider = 'telegram' AND external_subject = ?
    LIMIT 1
  `).bind(input.context.shopId, legacySubjectHash).first<{ customerId: string }>();
  const customerId = legacy?.customerId ?? createId("cus");
  const identityId = createId("cid");
  const effectiveLocale = matchSupportedLocale(input.user.languageCode) ?? "en";
  try {
    await input.env.PLATFORM_DB.batch([
      ...(legacy === null ? [input.env.PLATFORM_DB.prepare(`
        INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at)
        VALUES (?, ?, NULL, ?, ?, 'active', ?, ?)
      `).bind(customerId, input.context.shopId, displayHandle(input.user), effectiveLocale, input.now, input.now)] : []),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO customer_identities (id, shop_id, customer_id, provider, external_subject, display_handle_sanitized, language_code, verified_at, created_at, updated_at)
        VALUES (?, ?, ?, 'telegram', ?, ?, ?, ?, ?, ?)
      `).bind(identityId, input.context.shopId, customerId, input.subjectHash, displayHandle(input.user), input.user.languageCode, input.now, input.now, input.now),
    ]);
    return { customerId, identityId };
  } catch {
    const replay = await input.env.PLATFORM_DB.prepare(`
      SELECT id AS identityId, customer_id AS customerId
      FROM customer_identities
      WHERE shop_id = ? AND provider = 'telegram' AND external_subject = ?
      LIMIT 1
    `).bind(input.context.shopId, input.subjectHash).first<{ customerId: string; identityId: string }>();
    if (replay !== null) return replay;
    throw new AppError("telegram_identity_failed", 409);
  }
}

async function launchHash(env: AppBindings, context: MiniAppContextRow, dataCheckString: string): Promise<string> {
  return hmacToken(env.SESSION_SECRET, `telegram-mini-app-launch:${context.shopId}:${context.integrationId}`, dataCheckString);
}

async function subjectHash(env: AppBindings, context: MiniAppContextRow, subject: string): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, `telegram-mini-app-subject:${context.shopId}:${context.integrationId}`, subject);
}

export async function issueTelegramMiniAppSession(input: {
  env: AppBindings;
  initData: string;
  now?: Date;
  requesterAddress: string;
  requestId: string;
  shopPublicId: string;
}): Promise<TelegramMiniAppSession> {
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new AppError("validation_failed", 400, ["session_time_invalid"]);
  const context = await loadContext(input.env, input.shopPublicId);
  await claimAdmission({ env: input.env, now, requesterAddress: input.requesterAddress, shopId: context.shopId });
  const credentials = await decryptTelegramCredentialRow(input.env, context);
  const launch = await verifyTelegramMiniAppInitData({
    botToken: credentials.botToken,
    initData: input.initData,
    maxAgeSeconds: INIT_DATA_MAX_AGE_SECONDS,
    now,
  });
  const launchDigest = await launchHash(input.env, context, launch.dataCheckString);
  const subjectDigest = await subjectHash(input.env, context, launch.user.id);
  await ensureMiniAppIdentity({ context, env: input.env, now: now.toISOString(), subjectHash: subjectDigest, user: launch.user, userId: launch.user.id });
  const sessionToken = createOpaqueToken();
  const tokenDigest = await hmacToken(input.env.SESSION_SECRET, "telegram-mini-app-session", sessionToken);
  const sessionId = createId("tmas");
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1_000).toISOString();
  try {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO telegram_mini_app_sessions (
          id, shop_id, integration_id, credential_id, credential_version, connector_request_id,
          subject_hash, launch_hash, token_hash, status,
          issued_at, expires_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).bind(
        sessionId,
        context.shopId,
        context.integrationId,
        context.credentialId,
        context.credentialVersion,
        context.connectorRequestId,
        subjectDigest,
        launchDigest,
        tokenDigest,
        issuedAt,
        expiresAt,
        issuedAt,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
          safe_metadata_json, request_id, created_at
        ) VALUES (?, ?, 'system', NULL, 'telegram.mini_app_session_issued', 'telegram_mini_app_session', ?, ?, ?, ?)
      `).bind(
        createId("aud"),
        context.shopId,
        sessionId,
        JSON.stringify({ channelCode: "telegram.mini_app", credentialVersion: context.credentialVersion, connectorStatus: context.connectorStatus }),
        input.requestId,
        issuedAt,
      ),
    ]);
  } catch {
    const existing = await input.env.PLATFORM_DB.prepare(`
      SELECT id FROM telegram_mini_app_sessions
      WHERE integration_id = ? AND launch_hash = ?
      LIMIT 1
    `).bind(context.integrationId, launchDigest).first<{ id: string }>();
    if (existing !== null) throw new AppError("telegram_mini_app_replay", 409);
    throw new AppError("telegram_mini_app_session_failed", 500);
  }
  return {
    expiresAt,
    sessionId,
    sessionToken,
    user: { languageCode: launch.user.languageCode },
  };
}

export async function authenticateTelegramMiniAppSession(input: {
  env: AppBindings;
  now?: Date;
  sessionToken: string;
  shopPublicId: string;
}): Promise<TelegramMiniAppSessionContext> {
  if (input.sessionToken.length < 40 || input.sessionToken.length > 180 || input.sessionToken.trim() !== input.sessionToken) {
    throw new AppError("authentication_required", 401);
  }
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new AppError("authentication_required", 401);
  const tokenDigest = await hmacToken(input.env.SESSION_SECRET, "telegram-mini-app-session", input.sessionToken);
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT
      sessions.id AS sessionId,
      sessions.shop_id AS shopId,
      sessions.integration_id AS integrationId,
      sessions.credential_id AS credentialId,
      sessions.credential_version AS credentialVersion,
      sessions.subject_hash AS subjectHash,
      customer_identities.customer_id AS customerId,
      customer_identities.id AS identityId,
      channel_connections.id AS channelConnectionId,
      sessions.issued_at AS issuedAt,
      sessions.expires_at AS expiresAt,
      sessions.last_seen_at AS lastSeenAt,
      shop_subscriptions.state AS subscriptionState,
      shop_subscriptions.trial_ends_at AS trialEndsAt,
      shop_subscriptions.grace_ends_at AS graceEndsAt,
      channel_connector_requests.status AS connectorStatus
    FROM telegram_mini_app_sessions AS sessions
    INNER JOIN shops ON shops.id = sessions.shop_id
    INNER JOIN telegram_integrations
      ON telegram_integrations.id = sessions.integration_id
      AND telegram_integrations.shop_id = sessions.shop_id
      AND telegram_integrations.status IN ('active', 'degraded')
      AND telegram_integrations.webhook_status = 'verified'
      AND telegram_integrations.active_credential_id = sessions.credential_id
    INNER JOIN telegram_credentials
      ON telegram_credentials.id = sessions.credential_id
      AND telegram_credentials.integration_id = sessions.integration_id
      AND telegram_credentials.shop_id = sessions.shop_id
      AND telegram_credentials.status = 'active'
      AND telegram_credentials.version = sessions.credential_version
    INNER JOIN customer_identities
      ON customer_identities.shop_id = sessions.shop_id
      AND customer_identities.provider = 'telegram'
      AND customer_identities.external_subject = sessions.subject_hash
    LEFT JOIN channel_connections
      ON channel_connections.id = telegram_integrations.channel_connection_id
      AND channel_connections.shop_id = sessions.shop_id
      AND channel_connections.provider_code = 'telegram'
      AND channel_connections.status IN ('active', 'degraded')
    INNER JOIN shop_subscriptions
      ON shop_subscriptions.shop_id = sessions.shop_id
    INNER JOIN plans
      ON plans.id = shop_subscriptions.plan_id
      AND plans.is_active = 1
    INNER JOIN channel_connector_requests
      ON channel_connector_requests.id = sessions.connector_request_id
      AND channel_connector_requests.shop_id = sessions.shop_id
      AND channel_connector_requests.status = 'active'
    WHERE sessions.token_hash = ?
      AND sessions.status = 'active'
      AND sessions.expires_at > ?
      AND shops.public_id = ?
      AND shops.status = 'active'
    LIMIT 1
  `).bind(tokenDigest, now.toISOString(), requireResourceId(input.shopPublicId, "shop")).first<TelegramMiniAppSessionContext>();
  if (row === null) throw new AppError("authentication_required", 401);
  if (!subscriptionAllows({ graceEndsAt: row.graceEndsAt, subscriptionState: row.subscriptionState ?? "canceled", trialEndsAt: row.trialEndsAt })) {
    throw new AppError("authentication_required", 401);
  }
  await input.env.PLATFORM_DB.prepare(`
    UPDATE telegram_mini_app_sessions
    SET last_seen_at = ?
    WHERE id = ? AND status = 'active' AND expires_at > ?
  `).bind(now.toISOString(), row.sessionId, now.toISOString()).run();
  return row;
}

export function telegramMiniAppLaunchPolicy(): { initDataMaxAgeSeconds: number; sessionTtlSeconds: number } {
  return { initDataMaxAgeSeconds: INIT_DATA_MAX_AGE_SECONDS, sessionTtlSeconds: SESSION_TTL_SECONDS };
}

export function readTelegramMiniAppBearerToken(request: Request): string {
  const value = request.headers.get("Authorization");
  if (value === null) throw new AppError("authentication_required", 401);
  const match = /^Bearer ([A-Za-z0-9_-]{40,180})$/u.exec(value);
  if (match === null || match[1] === undefined) throw new AppError("authentication_required", 401);
  return match[1];
}
