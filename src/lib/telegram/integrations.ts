import { AppError } from "../core/errors";
import { hmacToken } from "../core/crypto";
import { createId, createOpaqueToken } from "../core/ids";
import { tryRecordActivationMilestone } from "../analytics/activation";
import { resolveActiveEncryptionKey, resolveEncryptionKey } from "../crypto/keyring";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";
import { TelegramClient } from "./client";
import { loadActiveTelegramCredential } from "./credentials";
import { decryptTelegramCredential, encryptTelegramCredential, type EncryptedTelegramCredential } from "./crypto";
import { telegramCommands } from "./localization";
import type { TelegramBotIdentity, TelegramWebhookInfo } from "./types";

type IntegrationRow = {
  activeCredentialId: string | null;
  channelConnectionId: string | null;
  botDisplayName: string | null;
  botId: string | null;
  botUsername: string | null;
  connectedAt: string | null;
  id: string;
  lastCheckedAt: string | null;
  lastHealthUpdateAt: string | null;
  lastOutboundAt: string | null;
  lastSafeErrorCode: string | null;
  lastUpdateAt: string | null;
  pendingUpdateCount: number;
  publicId: string;
  shopId: string;
  status: string;
  webhookPublicId: string;
  webhookStatus: string;
};

export type TelegramIntegrationView = {
  bot: { displayName: string; id: string; username: string } | null;
  connectedAt: string | null;
  lastCheckedAt: string | null;
  lastHealthUpdateAt: string | null;
  lastOutboundAt: string | null;
  lastSafeErrorCode: string | null;
  lastUpdateAt: string | null;
  pendingUpdateCount: number;
  provider: "telegram";
  publicId: string;
  status: string;
  webhookStatus: string;
};

const INTEGRATION_SELECT = `
  id,
  public_id AS publicId,
  webhook_public_id AS webhookPublicId,
  shop_id AS shopId,
  status,
  webhook_status AS webhookStatus,
  active_credential_id AS activeCredentialId,
  channel_connection_id AS channelConnectionId,
  bot_id AS botId,
  bot_username_sanitized AS botUsername,
  bot_display_name_sanitized AS botDisplayName,
  pending_update_count AS pendingUpdateCount,
  last_safe_error_code AS lastSafeErrorCode,
  last_checked_at AS lastCheckedAt,
  last_health_update_at AS lastHealthUpdateAt,
  last_update_at AS lastUpdateAt,
  last_outbound_at AS lastOutboundAt,
  connected_at AS connectedAt
`;

const TELEGRAM_CONNECTION_GRANTS = [
  "conversation.inbound",
  "conversation.outbound",
  "message.rich_ui",
  "catalog.read",
  "cart.interactive",
  "checkout.external_link",
  "fulfillment.inline_secret",
  "identity.private",
] as const;

async function ensureReconnectableGenericConnection(
  env: AppBindings,
  integration: IntegrationRow,
  shopId: string,
): Promise<IntegrationRow> {
  if (typeof integration.channelConnectionId !== "string") return integration;
  const linked = await env.PLATFORM_DB.prepare(`
    SELECT id, status
    FROM channel_connections
    WHERE id = ? AND shop_id = ? AND provider_code = 'telegram'
    LIMIT 1
  `).bind(integration.channelConnectionId, shopId).first<{ id: string; status: string }>();
  if (linked === null || linked.status !== "disconnected") return integration;

  const oldConnectionId = linked.id;
  const connectionId = createId("ccn");
  const publicId = createId("ccpub");
  const now = new Date().toISOString();
  const connectIntentKeyHash = await hmacToken(
    env.IDENTIFIER_HMAC_SECRET,
    "telegram-reconnect-intent",
    `${shopId}:${integration.id}`,
  );
  try {
    await env.PLATFORM_DB.batch([
      env.PLATFORM_DB.prepare(`
        INSERT INTO channel_connections (
          id, public_id, shop_id, shop_channel_id, provider_code,
          connect_intent_key_hash, status, settings_json, version, created_at, updated_at
        ) SELECT ?, ?, ?, shop_channel_id, 'telegram', ?, 'pending', '{}', 1, ?, ?
        FROM channel_connections
        WHERE id = ? AND shop_id = ? AND provider_code = 'telegram' AND status = 'disconnected'
      `).bind(connectionId, publicId, shopId, connectIntentKeyHash, now, now, oldConnectionId, shopId),
      ...TELEGRAM_CONNECTION_GRANTS.map((capability) => env.PLATFORM_DB.prepare(`
        INSERT OR IGNORE INTO channel_connection_grants (shop_id, connection_id, capability_code, granted_at)
        SELECT ?, ?, capability_code, ?
        FROM channel_connection_grants
        WHERE shop_id = ? AND connection_id = ? AND capability_code = ?
      `).bind(shopId, connectionId, now, shopId, oldConnectionId, capability)),
      env.PLATFORM_DB.prepare(`
        UPDATE shop_channels
        SET status = 'pending', version = version + 1, updated_at = ?
        WHERE shop_id = ? AND id = (
          SELECT shop_channel_id FROM channel_connections
          WHERE id = ? AND shop_id = ?
        )
      `).bind(now, shopId, oldConnectionId, shopId),
      env.PLATFORM_DB.prepare(`
        UPDATE telegram_integrations
        SET channel_connection_id = ?, updated_at = ?
        WHERE id = ? AND shop_id = ? AND channel_connection_id = ?
      `).bind(connectionId, now, integration.id, shopId, oldConnectionId),
    ]);
  } catch {
    const replayed = await findIntegration(env, shopId);
    if (replayed !== null && replayed.channelConnectionId !== oldConnectionId) return replayed;
    throw new AppError("telegram_connection_failed", 409);
  }
  return (await findIntegration(env, shopId)) ?? { ...integration, channelConnectionId: connectionId };
}

function mapIntegration(row: IntegrationRow): TelegramIntegrationView {
  return {
    bot: row.botId === null || row.botUsername === null || row.botDisplayName === null ? null : { displayName: row.botDisplayName, id: row.botId, username: row.botUsername },
    connectedAt: row.connectedAt,
    lastCheckedAt: row.lastCheckedAt,
    lastHealthUpdateAt: row.lastHealthUpdateAt,
    lastOutboundAt: row.lastOutboundAt,
    lastSafeErrorCode: row.lastSafeErrorCode,
    lastUpdateAt: row.lastUpdateAt,
    pendingUpdateCount: row.pendingUpdateCount,
    provider: "telegram",
    publicId: row.publicId,
    status: row.status,
    webhookStatus: row.webhookStatus,
  };
}

async function requireIntegrationReader(env: AppBindings, shopPublicId: string, userId: string): Promise<{ defaultLocale: string; shopId: string }> {
  const member = await getShopForMember({ capability: "integrations:read", env, shopPublicId, userId });
  return { defaultLocale: member.shop.defaultLocale, shopId: member.row.shop_id };
}

async function requireIntegrationOperator(env: AppBindings, shopPublicId: string, userId: string): Promise<{ defaultLocale: string; shopId: string }> {
  const member = await getShopForMember({ capability: "integrations:manage", env, shopPublicId, userId });
  return { defaultLocale: member.shop.defaultLocale, shopId: member.row.shop_id };
}

async function requireIntegrationCredential(env: AppBindings, shopPublicId: string, userId: string): Promise<{ defaultLocale: string; shopId: string }> {
  const member = await getShopForMember({ capability: "integrations:credentials", env, shopPublicId, userId });
  return { defaultLocale: member.shop.defaultLocale, shopId: member.row.shop_id };
}

async function findIntegration(env: AppBindings, shopId: string): Promise<IntegrationRow | null> {
  return env.PLATFORM_DB.prepare(`SELECT ${INTEGRATION_SELECT} FROM telegram_integrations WHERE shop_id = ? LIMIT 1`).bind(shopId).first<IntegrationRow>();
}

function webhookMaxConnections(env: AppBindings): number {
  const value = Number(env.TELEGRAM_WEBHOOK_MAX_CONNECTIONS);
  return Number.isSafeInteger(value) && value >= 1 && value <= 100 ? value : 20;
}

function webhookUrl(env: AppBindings, publicId: string): string {
  return `${env.API_ORIGIN}/webhooks/telegram/${publicId}`;
}

function webhookAllowedUpdatesMatch(allowedUpdates: readonly string[]): boolean {
  return allowedUpdates.length === 2
    && allowedUpdates.includes("message")
    && allowedUpdates.includes("callback_query");
}

async function configureProvider(client: TelegramClient, env: AppBindings, integration: IntegrationRow, secret: string, shopDefaultLocale: string): Promise<TelegramWebhookInfo> {
  await client.setMyCommands(telegramCommands(shopDefaultLocale));
  await client.setMyCommands(telegramCommands("en"), "en");
  await client.setMyCommands(telegramCommands("vi-VN"), "vi");
  await client.setChatMenuButton();
  const url = webhookUrl(env, integration.webhookPublicId);
  const maxConnections = webhookMaxConnections(env);
  await client.setWebhook({ allowedUpdates: ["message", "callback_query"], maxConnections, secretToken: secret, url });
  const info = await client.getWebhookInfo();
  if (info.url !== url || info.maxConnections !== maxConnections || !webhookAllowedUpdatesMatch(info.allowedUpdates)) throw new AppError("telegram_webhook_failed", 409);
  return info;
}

async function assertBotAvailable(env: AppBindings, bot: TelegramBotIdentity, integrationId: string): Promise<void> {
  const duplicate = await env.PLATFORM_DB.prepare("SELECT id FROM telegram_integrations WHERE bot_id = ? AND id != ? AND status IN ('pending', 'active', 'degraded') LIMIT 1").bind(bot.id, integrationId).first();
  if (duplicate !== null) throw new AppError("telegram_bot_already_connected", 409);
}

type ResumableTelegramCredential = EncryptedTelegramCredential & {
  credentialId: string;
  keyVersion: string;
  status: "active" | "error" | "pending";
  version: number;
};

type PreparedTelegramCredential = {
  alreadyActive: boolean;
  credentialId: string;
  secret: string;
  version: number;
};

const RESUMABLE_CREDENTIAL_SELECT = `
  id AS credentialId,
  status,
  version,
  key_version AS keyVersion,
  bot_token_ciphertext_b64 AS botTokenCiphertextB64,
  bot_token_iv_b64 AS botTokenIvB64,
  webhook_secret_ciphertext_b64 AS webhookSecretCiphertextB64,
  webhook_secret_iv_b64 AS webhookSecretIvB64,
  token_fingerprint AS tokenFingerprint,
  webhook_secret_digest AS webhookSecretDigest
`;

async function findResumableTelegramCredential(
  env: AppBindings,
  integrationId: string,
  shopId: string,
  tokenFingerprint: string,
): Promise<ResumableTelegramCredential | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT ${RESUMABLE_CREDENTIAL_SELECT}
    FROM telegram_credentials
    WHERE integration_id = ? AND shop_id = ? AND token_fingerprint = ?
      AND status IN ('active', 'pending', 'error')
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, version DESC
    LIMIT 1
  `).bind(integrationId, shopId, tokenFingerprint).first<ResumableTelegramCredential>();
}

async function findRetryableTelegramCredential(env: AppBindings, integrationId: string, shopId: string): Promise<ResumableTelegramCredential | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT ${RESUMABLE_CREDENTIAL_SELECT}
    FROM telegram_credentials
    WHERE integration_id = ? AND shop_id = ? AND status IN ('pending', 'error')
    ORDER BY version DESC
    LIMIT 1
  `).bind(integrationId, shopId).first<ResumableTelegramCredential>();
}

async function resumeTelegramCredential(input: {
  botToken: string;
  env: AppBindings;
  integration: IntegrationRow;
  row: ResumableTelegramCredential;
  shopId: string;
}): Promise<PreparedTelegramCredential> {
  if (input.row.status === "active" && input.integration.activeCredentialId !== input.row.credentialId) {
    throw new AppError("telegram_activation_failed", 409);
  }
  const rowKey = resolveEncryptionKey(input.env, "credential", input.row.keyVersion);
  const credentials = await decryptTelegramCredential(input.row, {
    credentialId: input.row.credentialId,
    integrationId: input.integration.id,
    kek: rowKey.kek,
    keyVersion: rowKey.version,
    shopId: input.shopId,
  });
  if (credentials.botToken !== input.botToken) throw new AppError("telegram_bot_already_connected", 409);
  const now = new Date().toISOString();
  if (input.row.status === "error") {
    await input.env.PLATFORM_DB.prepare("UPDATE telegram_credentials SET status = 'pending' WHERE id = ? AND integration_id = ? AND shop_id = ? AND status = 'error'").bind(input.row.credentialId, input.integration.id, input.shopId).run();
  }
  await input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = CASE WHEN active_credential_id IS NULL THEN 'pending' ELSE status END, webhook_status = CASE WHEN active_credential_id IS NULL THEN 'pending' ELSE webhook_status END, last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ?").bind(now, input.integration.id, input.shopId).run();
  return {
    alreadyActive: input.row.status === "active" && input.integration.status === "active" && input.integration.webhookStatus === "verified",
    credentialId: input.row.credentialId,
    secret: credentials.webhookSecret,
    version: input.row.version,
  };
}

async function prepareTelegramCredential(input: {
  botToken: string;
  env: AppBindings;
  integration: IntegrationRow;
  shopId: string;
  userId: string;
}): Promise<PreparedTelegramCredential> {
  const tokenFingerprint = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "telegram-bot-token", input.botToken);
  const resumable = await findResumableTelegramCredential(input.env, input.integration.id, input.shopId, tokenFingerprint);
  if (resumable !== null) return resumeTelegramCredential({ ...input, row: resumable });

  const versionRow = await input.env.PLATFORM_DB.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM telegram_credentials WHERE integration_id = ? AND shop_id = ?").bind(input.integration.id, input.shopId).first<{ version: number }>();
  const version = versionRow?.version ?? 1;
  const credentialId = createId("tcr");
  const secret = createOpaqueToken(32);
  const activeKey = resolveActiveEncryptionKey(input.env, "credential");
  const encrypted = await encryptTelegramCredential({ botToken: input.botToken, credentialId, hmacSecret: input.env.IDENTIFIER_HMAC_SECRET, integrationId: input.integration.id, kek: activeKey.kek, keyVersion: activeKey.version, shopId: input.shopId, webhookSecret: secret });
  const now = new Date().toISOString();
  try {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`INSERT INTO telegram_credentials (id, shop_id, integration_id, status, version, key_version, bot_token_ciphertext_b64, bot_token_iv_b64, webhook_secret_ciphertext_b64, webhook_secret_iv_b64, token_fingerprint, webhook_secret_digest, created_by_user_id, created_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(credentialId, input.shopId, input.integration.id, version, activeKey.version, encrypted.botTokenCiphertextB64, encrypted.botTokenIvB64, encrypted.webhookSecretCiphertextB64, encrypted.webhookSecretIvB64, encrypted.tokenFingerprint, encrypted.webhookSecretDigest, input.userId, now),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = CASE WHEN active_credential_id IS NULL THEN 'pending' ELSE status END, webhook_status = CASE WHEN active_credential_id IS NULL THEN 'pending' ELSE webhook_status END, last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ?").bind(now, input.integration.id, input.shopId),
    ]);
    return { alreadyActive: false, credentialId, secret, version };
  } catch {
    const winner = await findResumableTelegramCredential(input.env, input.integration.id, input.shopId, tokenFingerprint);
    if (winner === null) throw new AppError("telegram_bot_already_connected", 409);
    return resumeTelegramCredential({ ...input, row: winner });
  }
}

export async function getTelegramIntegration(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<TelegramIntegrationView | null> {
  const { shopId } = await requireIntegrationReader(input.env, input.shopPublicId, input.userId);
  const integration = await findIntegration(input.env, shopId);
  return integration === null ? null : mapIntegration(integration);
}

export async function connectTelegram(input: { botToken: string; env: AppBindings; fetcher?: typeof fetch; replaceBot: boolean; requestId: string; shopPublicId: string; userId: string }): Promise<TelegramIntegrationView> {
  const actor = await requireIntegrationCredential(input.env, input.shopPublicId, input.userId);
  const { shopId } = actor;
  const client = new TelegramClient(input.botToken, input.fetcher);
  const bot = await client.getMe();
  let integration = await findIntegration(input.env, shopId);
  const nowIso = new Date().toISOString();
  if (integration === null) {
    const id = createId("tin");
    await input.env.PLATFORM_DB.prepare(`INSERT INTO telegram_integrations (id, public_id, webhook_public_id, shop_id, status, webhook_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', 'pending', ?, ?)`).bind(id, createId("tgint"), createId("tgwh"), shopId, nowIso, nowIso).run();
    integration = await findIntegration(input.env, shopId);
    if (integration === null) throw new AppError("internal_error", 500);
  }
  if (integration.botId !== null && integration.botId !== bot.id && !input.replaceBot) throw new AppError("telegram_bot_mismatch", 409);
  await assertBotAvailable(input.env, bot, integration.id);
  integration = await ensureReconnectableGenericConnection(input.env, integration, shopId);
  const previous = integration.activeCredentialId === null ? null : await loadActiveTelegramCredential(input.env, integration.id, shopId);
  const credential = await prepareTelegramCredential({ botToken: input.botToken, env: input.env, integration, shopId, userId: input.userId });
  if (credential.alreadyActive) {
    await tryRecordActivationMilestone({
      env: input.env,
      idempotencyKey: "telegram_connected",
      milestone: "telegram_connected",
      reason: "connected",
      shopId,
      source: "telegram",
    });
    return mapIntegration(integration);
  }
  let info: TelegramWebhookInfo;
  try {
    info = await configureProvider(client, input.env, integration, credential.secret, actor.defaultLocale);
  } catch (error) {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare("UPDATE telegram_credentials SET status = 'error' WHERE id = ? AND shop_id = ? AND status = 'pending'").bind(credential.credentialId, shopId),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = CASE WHEN active_credential_id IS NULL THEN 'error' ELSE status END, webhook_status = CASE WHEN active_credential_id IS NULL THEN 'error' ELSE webhook_status END, last_safe_error_code = ?, last_checked_at = ?, updated_at = ? WHERE id = ? AND shop_id = ?").bind(error instanceof AppError ? error.code : "telegram_webhook_failed", nowIso, nowIso, integration.id, shopId),
    ]);
    throw error instanceof AppError ? error : new AppError("telegram_webhook_failed", 409);
  }
  const activatedAt = new Date().toISOString();
  const rotated = integration.activeCredentialId !== null && integration.activeCredentialId !== credential.credentialId;
  const botChanged = integration.botId !== null && integration.botId !== bot.id;
  try {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare("UPDATE telegram_credentials SET status = 'revoked', revoked_at = ? WHERE integration_id = ? AND shop_id = ? AND status = 'active' AND id != ?").bind(activatedAt, integration.id, shopId, credential.credentialId),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_credentials SET status = 'active', activated_at = ? WHERE id = ? AND integration_id = ? AND shop_id = ? AND status IN ('pending', 'error')").bind(activatedAt, credential.credentialId, integration.id, shopId),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = ?, webhook_status = 'verified', active_credential_id = ?, last_health_update_at = CASE WHEN ? = 1 THEN NULL ELSE last_health_update_at END, bot_id = ?, bot_username_sanitized = ?, bot_display_name_sanitized = ?, pending_update_count = ?, last_safe_error_code = ?, last_checked_at = ?, connected_at = COALESCE(connected_at, ?), updated_at = ? WHERE id = ? AND shop_id = ?").bind(info.hasDeliveryError ? "degraded" : "active", credential.credentialId, rotated ? 1 : 0, bot.id, bot.username, bot.displayName, info.pendingUpdateCount, info.hasDeliveryError ? "telegram_provider_delivery_error" : null, activatedAt, activatedAt, activatedAt, integration.id, shopId),
      input.env.PLATFORM_DB.prepare(`INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) SELECT ?, ?, 'user', ?, 'telegram.credentials_connected', 'telegram_integration', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM telegram_credentials WHERE id = ? AND integration_id = ? AND shop_id = ? AND activated_at = ?)`).bind(createId("aud"), shopId, input.userId, integration.id, JSON.stringify({ botChanged, credentialVersion: credential.version, rotated }), input.requestId, activatedAt, credential.credentialId, integration.id, shopId, activatedAt),
    ]);
  } catch {
    try { await client.deleteWebhook(false); } catch { /* Best-effort cleanup after an activation race. */ }
    throw new AppError("telegram_activation_failed", 409);
  }
  if (previous !== null && integration.botId !== null && integration.botId !== bot.id) {
    try { await new TelegramClient(previous.credentials.botToken, input.fetcher).deleteWebhook(false); } catch { /* The previous bot may already be revoked. */ }
  }
  const active = await findIntegration(input.env, shopId);
  if (active === null) throw new AppError("internal_error", 500);
  if (active.status === "active" && active.webhookStatus === "verified") {
    await tryRecordActivationMilestone({
      env: input.env,
      idempotencyKey: "telegram_connected",
      milestone: "telegram_connected",
      reason: "connected",
      shopId,
      source: "telegram",
    });
  }
  return mapIntegration(active);
}

async function retryTelegramSetup(input: {
  defaultLocale: string;
  env: AppBindings;
  fetcher?: typeof fetch;
  integration: IntegrationRow;
  requestId: string;
  shopId: string;
  userId: string;
}): Promise<void> {
  const row = await findRetryableTelegramCredential(input.env, input.integration.id, input.shopId);
  if (row === null) throw new AppError("telegram_not_configured", 409);
  const key = resolveEncryptionKey(input.env, "credential", row.keyVersion);
  const credentials = await decryptTelegramCredential(row, {
    credentialId: row.credentialId,
    integrationId: input.integration.id,
    kek: key.kek,
    keyVersion: key.version,
    shopId: input.shopId,
  });
  const checkedAt = new Date().toISOString();
  const client = new TelegramClient(credentials.botToken, input.fetcher);
  let bot: TelegramBotIdentity;
  let info: TelegramWebhookInfo;
  try {
    bot = await client.getMe();
    await assertBotAvailable(input.env, bot, input.integration.id);
    info = await configureProvider(client, input.env, input.integration, credentials.webhookSecret, input.defaultLocale);
  } catch (error) {
    const code = error instanceof AppError ? error.code : "telegram_webhook_failed";
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare("UPDATE telegram_credentials SET status = 'error' WHERE id = ? AND integration_id = ? AND shop_id = ? AND status IN ('pending', 'error')").bind(row.credentialId, input.integration.id, input.shopId),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = 'error', webhook_status = 'error', last_safe_error_code = ?, last_checked_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND active_credential_id IS NULL").bind(code, checkedAt, checkedAt, input.integration.id, input.shopId),
    ]);
    return;
  }
  const activatedAt = new Date().toISOString();
  try {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare("UPDATE telegram_credentials SET status = 'active', activated_at = ? WHERE id = ? AND integration_id = ? AND shop_id = ? AND status IN ('pending', 'error') AND EXISTS (SELECT 1 FROM telegram_integrations WHERE id = ? AND shop_id = ? AND active_credential_id IS NULL)").bind(activatedAt, row.credentialId, input.integration.id, input.shopId, input.integration.id, input.shopId),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = ?, webhook_status = 'verified', active_credential_id = ?, last_health_update_at = CASE WHEN ? = 1 THEN NULL ELSE last_health_update_at END, bot_id = ?, bot_username_sanitized = ?, bot_display_name_sanitized = ?, pending_update_count = ?, last_safe_error_code = ?, last_checked_at = ?, connected_at = COALESCE(connected_at, ?), updated_at = ? WHERE id = ? AND shop_id = ? AND active_credential_id IS NULL AND EXISTS (SELECT 1 FROM telegram_credentials WHERE id = ? AND integration_id = ? AND shop_id = ? AND activated_at = ?)").bind(info.hasDeliveryError ? "degraded" : "active", row.credentialId, 1, bot.id, bot.username, bot.displayName, info.pendingUpdateCount, info.hasDeliveryError ? "telegram_provider_delivery_error" : null, activatedAt, activatedAt, activatedAt, input.integration.id, input.shopId, row.credentialId, input.integration.id, input.shopId, activatedAt),
      input.env.PLATFORM_DB.prepare(`INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) SELECT ?, ?, 'user', ?, 'telegram.credentials_connected', 'telegram_integration', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM telegram_credentials WHERE id = ? AND integration_id = ? AND shop_id = ? AND activated_at = ?)`).bind(createId("aud"), input.shopId, input.userId, input.integration.id, JSON.stringify({ credentialVersion: row.version, retry: true, rotated: false }), input.requestId, activatedAt, row.credentialId, input.integration.id, input.shopId, activatedAt),
    ]);
  } catch {
    try { await client.deleteWebhook(false); } catch { /* Best-effort cleanup after an activation failure. */ }
    throw new AppError("telegram_activation_failed", 409);
  }
  if (!info.hasDeliveryError) {
    await tryRecordActivationMilestone({
      env: input.env,
      idempotencyKey: "telegram_connected",
      milestone: "telegram_connected",
      reason: "connected",
      shopId: input.shopId,
      source: "telegram",
    });
  }
}

export async function refreshTelegramHealth(input: { env: AppBindings; fetcher?: typeof fetch; requestId: string; shopPublicId: string; userId: string }): Promise<TelegramIntegrationView> {
  const actor = await requireIntegrationOperator(input.env, input.shopPublicId, input.userId);
  const { shopId } = actor;
  const integration = await findIntegration(input.env, shopId);
  if (integration === null || integration.status === "disabled") throw new AppError("telegram_not_configured", 409);
  if (integration.activeCredentialId === null) {
    await retryTelegramSetup({ ...input, defaultLocale: actor.defaultLocale, integration, shopId });
    const retried = await findIntegration(input.env, shopId);
    if (retried === null) throw new AppError("internal_error", 500);
    return mapIntegration(retried);
  }
  const credential = await loadActiveTelegramCredential(input.env, integration.id, shopId);
  const now = new Date().toISOString();
  try {
    const client = new TelegramClient(credential.credentials.botToken, input.fetcher);
    const [bot, info] = await Promise.all([client.getMe(), client.getWebhookInfo()]);
    const expectedUrl = webhookUrl(input.env, integration.webhookPublicId);
    const identityMatches = integration.botId === bot.id;
    const webhookMatches = info.url === expectedUrl
      && info.maxConnections === webhookMaxConnections(input.env)
      && webhookAllowedUpdatesMatch(info.allowedUpdates);
    const healthy = identityMatches && webhookMatches && !info.hasDeliveryError;
    const errorCode = !identityMatches ? "telegram_bot_mismatch" : !webhookMatches ? "telegram_webhook_mismatch" : info.hasDeliveryError ? "telegram_provider_delivery_error" : null;
    await input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = ?, webhook_status = ?, pending_update_count = ?, last_safe_error_code = ?, last_checked_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND status != 'disabled'").bind(healthy ? "active" : "degraded", webhookMatches ? "verified" : "mismatch", info.pendingUpdateCount, errorCode, now, now, integration.id, shopId).run();
  } catch (error) {
    const code = error instanceof AppError ? error.code : "provider_unavailable";
    await input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = 'degraded', last_safe_error_code = ?, last_checked_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND status != 'disabled'").bind(code, now, now, integration.id, shopId).run();
  }
  const refreshed = await findIntegration(input.env, shopId);
  if (refreshed === null) throw new AppError("internal_error", 500);
  if (refreshed.status === "active" && refreshed.webhookStatus === "verified") {
    await tryRecordActivationMilestone({
      env: input.env,
      idempotencyKey: "telegram_connected",
      milestone: "telegram_connected",
      reason: "connected",
      shopId,
      source: "telegram",
    });
  }
  return mapIntegration(refreshed);
}

export async function disconnectTelegram(input: { env: AppBindings; fetcher?: typeof fetch; requestId: string; shopPublicId: string; userId: string }): Promise<void> {
  const { shopId } = await requireIntegrationCredential(input.env, input.shopPublicId, input.userId);
  const integration = await findIntegration(input.env, shopId);
  if (integration === null || integration.activeCredentialId === null) throw new AppError("telegram_not_configured", 409);
  try {
    const credential = await loadActiveTelegramCredential(input.env, integration.id, shopId);
    await new TelegramClient(credential.credentials.botToken, input.fetcher).deleteWebhook(false);
  } catch {
    // Disconnect remains authoritative even when the provider token was revoked.
  }
  const now = new Date().toISOString();
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = 'disabled', webhook_status = 'disabled', active_credential_id = NULL, last_health_update_at = NULL, last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ?").bind(now, integration.id, shopId),
    input.env.PLATFORM_DB.prepare("UPDATE telegram_credentials SET status = 'revoked', revoked_at = ? WHERE integration_id = ? AND shop_id = ? AND status IN ('active', 'pending')").bind(now, integration.id, shopId),
    input.env.PLATFORM_DB.prepare(`INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) VALUES (?, ?, 'user', ?, 'telegram.disconnected', 'telegram_integration', ?, '{}', ?, ?)`).bind(createId("aud"), shopId, input.userId, integration.id, input.requestId, now),
  ]);
}
