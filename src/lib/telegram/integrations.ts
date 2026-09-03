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
import type { TelegramBotIdentity, TelegramTemplatePreset, TelegramWebhookInfo } from "./types";

type IntegrationRow = {
  activeCredentialId: string | null;
  channelConnectionId: string | null;
  botDisplayName: string | null;
  botId: string | null;
  botUsername: string | null;
  connectedAt: string | null;
  id: string;
  generationState: "active" | "draining";
  integrationGeneration: number;
  lastCheckedAt: string | null;
  lastHealthUpdateAt: string | null;
  lastOutboundAt: string | null;
  lastSafeErrorCode: string | null;
  lastUpdateAt: string | null;
  menuConfigJson: string | null;
  pendingUpdateCount: number;
  publicId: string;
  shopId: string;
  status: string;
  supportHandle: string | null;
  templatePreset: string | null;
  webhookPublicId: string;
  webhookStatus: string;
  welcomeMessageCustom: string | null;
};

type ActivationAuthority = {
  activeCredentialId: string | null;
  activeCredentialVersion: number | null;
  botId: string | null;
  generationState: "active" | "draining";
  integrationGeneration: number;
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
  supportHandle: string | null;
  templatePreset: TelegramTemplatePreset;
  webhookStatus: string;
  welcomeMessageCustom: string | null;
  menuConfigJson: string | null;
};

const INTEGRATION_SELECT = `
  id,
  public_id AS publicId,
  webhook_public_id AS webhookPublicId,
  shop_id AS shopId,
  status,
  generation_state AS generationState,
  integration_generation AS integrationGeneration,
  webhook_status AS webhookStatus,
  active_credential_id AS activeCredentialId,
  channel_connection_id AS channelConnectionId,
  bot_id AS botId,
  bot_username_sanitized AS botUsername,
  bot_display_name_sanitized AS botDisplayName,
  template_preset AS templatePreset,
  welcome_message_custom AS welcomeMessageCustom,
  support_handle AS supportHandle,
  menu_config_json AS menuConfigJson,
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
    menuConfigJson: row.menuConfigJson ?? null,
    pendingUpdateCount: row.pendingUpdateCount,
    provider: "telegram",
    publicId: row.publicId,
    status: row.status,
    supportHandle: row.supportHandle ?? null,
    templatePreset: row.templatePreset === null ? "license_vault" : (row.templatePreset as TelegramTemplatePreset),
    webhookStatus: row.webhookStatus,
    welcomeMessageCustom: row.welcomeMessageCustom ?? null,
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
  const member = await getShopForMember({ capability: "integrations:credentials", env, shopPublicId, subscriptionAction: "provider_setup", userId });
  if (member.row.shop_status !== "active" && member.row.shop_status !== "draft") throw new AppError("tenant_suspended", 403);
  if (member.shop.featureFlags.telegram !== true) throw new AppError("plan_feature_unavailable", 402, ["telegram"]);
  return { defaultLocale: member.shop.defaultLocale, shopId: member.row.shop_id };
}

async function findIntegration(env: AppBindings, shopId: string): Promise<IntegrationRow | null> {
  return env.PLATFORM_DB.prepare(`SELECT ${INTEGRATION_SELECT} FROM telegram_integrations WHERE shop_id = ? LIMIT 1`).bind(shopId).first<IntegrationRow>();
}

async function readActivationAuthority(env: AppBindings, integrationId: string, shopId: string): Promise<ActivationAuthority | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT telegram_integrations.active_credential_id AS activeCredentialId,
      telegram_integrations.bot_id AS botId,
      telegram_integrations.generation_state AS generationState,
      telegram_integrations.integration_generation AS integrationGeneration,
      telegram_credentials.version AS activeCredentialVersion
    FROM telegram_integrations
    LEFT JOIN telegram_credentials
      ON telegram_credentials.id = telegram_integrations.active_credential_id
      AND telegram_credentials.integration_id = telegram_integrations.id
      AND telegram_credentials.shop_id = telegram_integrations.shop_id
    WHERE telegram_integrations.id = ? AND telegram_integrations.shop_id = ?
    LIMIT 1
  `).bind(integrationId, shopId).first<ActivationAuthority>();
}

function authorityMatches(
  authority: ActivationAuthority | null,
  expected: { botId: string; credentialId: string; credentialVersion?: number; integrationGeneration?: number },
): boolean {
  return authority !== null
    && authority.generationState === "active"
    && authority.activeCredentialId === expected.credentialId
    && authority.botId === expected.botId
    && authority.activeCredentialVersion !== null
    && (expected.integrationGeneration === undefined || authority.integrationGeneration === expected.integrationGeneration)
    && (expected.credentialVersion === undefined || authority.activeCredentialVersion === expected.credentialVersion);
}

async function beginGenerationDrain(env: AppBindings, integration: IntegrationRow): Promise<IntegrationRow> {
  const now = new Date().toISOString();
  const result = await env.PLATFORM_DB.prepare(`
    UPDATE telegram_integrations
    SET generation_state = 'draining', updated_at = ?
    WHERE id = ? AND shop_id = ?
      AND generation_state = 'active'
      AND integration_generation = ?
      AND active_credential_id IS ?
      AND NOT EXISTS (
        SELECT 1 FROM telegram_updates
        WHERE telegram_updates.integration_id = telegram_integrations.id
          AND telegram_updates.shop_id = telegram_integrations.shop_id
          AND telegram_updates.integration_generation = telegram_integrations.integration_generation
          AND telegram_updates.status = 'processing'
      )
  `).bind(now, integration.id, integration.shopId, integration.integrationGeneration, integration.activeCredentialId).run();
  if (result.meta.changes !== 1) throw new AppError("telegram_integration_busy", 409, ["retry"]);
  return { ...integration, generationState: "draining" };
}

async function releaseGenerationDrain(env: AppBindings, integration: IntegrationRow): Promise<void> {
  await env.PLATFORM_DB.prepare(`
    UPDATE telegram_integrations
    SET generation_state = 'active', updated_at = ?
    WHERE id = ? AND shop_id = ? AND generation_state = 'draining'
      AND integration_generation = ? AND active_credential_id IS ?
  `).bind(new Date().toISOString(), integration.id, integration.shopId, integration.integrationGeneration, integration.activeCredentialId).run();
}

async function degradeOwnedIntegration(env: AppBindings, input: { credentialId: string; integrationId: string; shopId: string }): Promise<void> {
  try {
    await env.PLATFORM_DB.prepare(`
      UPDATE telegram_integrations
      SET status = 'degraded', webhook_status = 'error',
        last_safe_error_code = 'telegram_webhook_failed', updated_at = ?
      WHERE id = ? AND shop_id = ? AND active_credential_id = ?
        AND status IN ('active', 'degraded')
    `).bind(new Date().toISOString(), input.integrationId, input.shopId, input.credentialId).run();
  } catch {
    // The provider failure can coincide with D1 unavailability.
  }
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
  await client.setWebhook({ allowedUpdates: ["message", "callback_query"], dropPendingUpdates: true, maxConnections, secretToken: secret, url });
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
  const rotated = integration.activeCredentialId !== null && integration.activeCredentialId !== credential.credentialId;
  const botChanged = integration.botId !== null && integration.botId !== bot.id;
  integration = await beginGenerationDrain(input.env, integration);
  let info: TelegramWebhookInfo;
  try {
    info = await configureProvider(client, input.env, integration, credential.secret, actor.defaultLocale);
  } catch (error) {
    await releaseGenerationDrain(input.env, integration).catch(() => undefined);
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare("UPDATE telegram_credentials SET status = 'error' WHERE id = ? AND shop_id = ? AND status = 'pending'").bind(credential.credentialId, shopId),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = CASE WHEN active_credential_id IS NULL THEN 'error' ELSE status END, webhook_status = CASE WHEN active_credential_id IS NULL THEN 'error' ELSE webhook_status END, last_safe_error_code = ?, last_checked_at = ?, updated_at = ? WHERE id = ? AND shop_id = ?").bind(error instanceof AppError ? error.code : "telegram_webhook_failed", nowIso, nowIso, integration.id, shopId),
    ]);
    throw error instanceof AppError ? error : new AppError("telegram_webhook_failed", 409);
  }
  const activatedAt = new Date().toISOString();
  const replacement = previous !== null && integration.botId !== null && integration.botId !== bot.id
    ? { botId: integration.botId, previous }
    : null;
  if (replacement !== null) {
    try {
      await new TelegramClient(replacement.previous.credentials.botToken, input.fetcher).deleteWebhook(true);
    } catch {
      await releaseGenerationDrain(input.env, integration).catch(() => undefined);
      let authority: ActivationAuthority | null;
      try {
        authority = await readActivationAuthority(input.env, integration.id, shopId);
      } catch {
        // Provider rollback is unsafe until D1 ownership can be confirmed.
        await degradeOwnedIntegration(input.env, { credentialId: replacement.previous.row.credentialId, integrationId: integration.id, shopId });
        throw new AppError("telegram_webhook_failed", 409);
      }
      if (authorityMatches(authority, { botId: replacement.botId, credentialId: replacement.previous.row.credentialId })) {
        let restored = false;
        try {
          await configureProvider(
            new TelegramClient(replacement.previous.credentials.botToken, input.fetcher),
            input.env,
            integration,
            replacement.previous.credentials.webhookSecret,
            actor.defaultLocale,
          );
          restored = true;
        } catch {
          await degradeOwnedIntegration(input.env, { credentialId: replacement.previous.row.credentialId, integrationId: integration.id, shopId });
        }
        if (restored) {
          try {
            const confirmed = await readActivationAuthority(input.env, integration.id, shopId);
            if (authorityMatches(confirmed, { botId: replacement.botId, credentialId: replacement.previous.row.credentialId })) {
              try { await client.deleteWebhook(true); } catch { /* The pending replacement remains safely unclaimed in D1. */ }
            }
          } catch { /* Do not mutate the replacement provider without fresh ownership evidence. */ }
        }
      }
      throw new AppError("telegram_webhook_failed", 409);
    }
  }
  try {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = ?, webhook_status = 'verified', active_credential_id = ?, integration_generation = integration_generation + 1, generation_state = 'active', last_health_update_at = CASE WHEN ? = 1 THEN NULL ELSE last_health_update_at END, bot_id = ?, bot_username_sanitized = ?, bot_display_name_sanitized = ?, pending_update_count = ?, last_safe_error_code = ?, last_checked_at = ?, connected_at = COALESCE(connected_at, ?), updated_at = ? WHERE id = ? AND shop_id = ? AND generation_state = 'draining' AND integration_generation = ? AND active_credential_id IS ?").bind(info.hasDeliveryError ? "degraded" : "active", credential.credentialId, rotated ? 1 : 0, bot.id, bot.username, bot.displayName, info.pendingUpdateCount, info.hasDeliveryError ? "telegram_provider_delivery_error" : null, activatedAt, activatedAt, activatedAt, integration.id, shopId, integration.integrationGeneration, integration.activeCredentialId),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_credentials SET status = 'revoked', revoked_at = ? WHERE integration_id = ? AND shop_id = ? AND status = 'active' AND id != ? AND EXISTS (SELECT 1 FROM telegram_integrations WHERE id = ? AND shop_id = ? AND active_credential_id = ? AND integration_generation = ?)").bind(activatedAt, integration.id, shopId, credential.credentialId, integration.id, shopId, credential.credentialId, integration.integrationGeneration + 1),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_credentials SET status = 'active', activated_at = ? WHERE id = ? AND integration_id = ? AND shop_id = ? AND status IN ('pending', 'error') AND EXISTS (SELECT 1 FROM telegram_integrations WHERE id = ? AND shop_id = ? AND active_credential_id = ? AND integration_generation = ?)").bind(activatedAt, credential.credentialId, integration.id, shopId, integration.id, shopId, credential.credentialId, integration.integrationGeneration + 1),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_updates SET status = 'rejected', safe_result_code = 'telegram_update_stale_generation', processed_at = ?, updated_at = ? WHERE integration_id = ? AND shop_id = ? AND integration_generation = ? AND status IN ('accepted', 'failed')").bind(activatedAt, activatedAt, integration.id, shopId, integration.integrationGeneration),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_recipients SET status = 'unavailable', last_safe_error_code = 'telegram_bot_generation_replaced', updated_at = ? WHERE integration_id = ? AND shop_id = ? AND status = 'active' AND ? = 1").bind(activatedAt, integration.id, shopId, botChanged ? 1 : 0),
      input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) SELECT ?, ?, 'system', NULL, 'telegram.update_generation_fenced', 'telegram_integration', ?, ?, ?, ? WHERE ? = 1").bind(createId("aud"), shopId, integration.id, JSON.stringify({ credentialVersion: credential.version }), input.requestId, activatedAt, rotated ? 1 : 0),
      input.env.PLATFORM_DB.prepare(`INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) SELECT ?, ?, 'user', ?, 'telegram.credentials_connected', 'telegram_integration', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM telegram_credentials WHERE id = ? AND integration_id = ? AND shop_id = ? AND activated_at = ?)`).bind(createId("aud"), shopId, input.userId, integration.id, JSON.stringify({ botChanged, credentialVersion: credential.version, rotated }), input.requestId, activatedAt, credential.credentialId, integration.id, shopId, activatedAt),
    ]);
  } catch {
    await releaseGenerationDrain(input.env, integration).catch(() => undefined);
    let authority: ActivationAuthority | null;
    try {
      authority = await readActivationAuthority(input.env, integration.id, shopId);
    } catch {
      // The activation result is unknown. Preserve provider state until D1 can
      // authoritatively identify the active credential generation.
      if (previous !== null) {
        await degradeOwnedIntegration(input.env, { credentialId: previous.row.credentialId, integrationId: integration.id, shopId });
      }
      throw new AppError("telegram_activation_failed", 409);
    }
    if (authorityMatches(authority, { botId: bot.id, credentialId: credential.credentialId, credentialVersion: credential.version, integrationGeneration: integration.integrationGeneration + 1 })) {
      // D1 committed and only the response was lost. The configured replacement
      // remains authoritative, so continue through the normal success readback.
    } else if (replacement !== null && authorityMatches(authority, { botId: replacement.botId, credentialId: replacement.previous.row.credentialId })) {
      let restored = false;
      try {
        await configureProvider(
          new TelegramClient(replacement.previous.credentials.botToken, input.fetcher),
          input.env,
          integration,
          replacement.previous.credentials.webhookSecret,
          actor.defaultLocale,
        );
        restored = true;
      } catch {
        await degradeOwnedIntegration(input.env, { credentialId: replacement.previous.row.credentialId, integrationId: integration.id, shopId });
      }
      if (restored) {
        try {
          const confirmed = await readActivationAuthority(input.env, integration.id, shopId);
          if (authorityMatches(confirmed, { botId: replacement.botId, credentialId: replacement.previous.row.credentialId })) {
            try { await client.deleteWebhook(true); } catch { /* Best-effort cleanup while the replacement credential remains pending. */ }
          }
        } catch { /* Do not mutate provider state after an unavailable ownership readback. */ }
      }
      throw new AppError("telegram_activation_failed", 409);
    } else {
      // Another credential generation won the race; its provider state is not
      // owned by this activation attempt and must remain untouched.
      throw new AppError("telegram_activation_failed", 409);
    }
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
  const drainingIntegration = await beginGenerationDrain(input.env, input.integration);
  let bot: TelegramBotIdentity;
  let info: TelegramWebhookInfo;
  try {
    bot = await client.getMe();
    await assertBotAvailable(input.env, bot, input.integration.id);
    info = await configureProvider(client, input.env, drainingIntegration, credentials.webhookSecret, input.defaultLocale);
  } catch (error) {
    await releaseGenerationDrain(input.env, drainingIntegration).catch(() => undefined);
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
      input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = ?, webhook_status = 'verified', active_credential_id = ?, integration_generation = integration_generation + 1, generation_state = 'active', last_health_update_at = NULL, bot_id = ?, bot_username_sanitized = ?, bot_display_name_sanitized = ?, pending_update_count = ?, last_safe_error_code = ?, last_checked_at = ?, connected_at = COALESCE(connected_at, ?), updated_at = ? WHERE id = ? AND shop_id = ? AND active_credential_id IS NULL AND generation_state = 'draining' AND integration_generation = ?").bind(info.hasDeliveryError ? "degraded" : "active", row.credentialId, bot.id, bot.username, bot.displayName, info.pendingUpdateCount, info.hasDeliveryError ? "telegram_provider_delivery_error" : null, activatedAt, activatedAt, activatedAt, input.integration.id, input.shopId, input.integration.integrationGeneration),
      input.env.PLATFORM_DB.prepare("UPDATE telegram_credentials SET status = 'active', activated_at = ? WHERE id = ? AND integration_id = ? AND shop_id = ? AND status IN ('pending', 'error') AND EXISTS (SELECT 1 FROM telegram_integrations WHERE id = ? AND shop_id = ? AND active_credential_id = ? AND integration_generation = ?)").bind(activatedAt, row.credentialId, input.integration.id, input.shopId, input.integration.id, input.shopId, row.credentialId, input.integration.integrationGeneration + 1),
      input.env.PLATFORM_DB.prepare(`INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) SELECT ?, ?, 'user', ?, 'telegram.credentials_connected', 'telegram_integration', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM telegram_credentials WHERE id = ? AND integration_id = ? AND shop_id = ? AND activated_at = ?)`).bind(createId("aud"), input.shopId, input.userId, input.integration.id, JSON.stringify({ credentialVersion: row.version, retry: true, rotated: false }), input.requestId, activatedAt, row.credentialId, input.integration.id, input.shopId, activatedAt),
    ]);
  } catch {
    let authority: ActivationAuthority | null;
    try {
      authority = await readActivationAuthority(input.env, input.integration.id, input.shopId);
    } catch {
      throw new AppError("telegram_activation_failed", 409);
    }
    if (!authorityMatches(authority, { botId: bot.id, credentialId: row.credentialId, credentialVersion: row.version, integrationGeneration: input.integration.integrationGeneration + 1 })) {
      // Preserve provider state when D1 did not commit or another generation won.
      // A later retry can safely reconfigure the still-owned pending credential.
      throw new AppError("telegram_activation_failed", 409);
    }
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
  if (integration === null) throw new AppError("telegram_not_configured", 409);
  if (integration.activeCredentialId === null) {
    if (integration.status === "disabled" && integration.webhookStatus === "disabled") return;
    throw new AppError("telegram_not_configured", 409);
  }
  const drainingIntegration = await beginGenerationDrain(input.env, integration);
  try {
    const credential = await loadActiveTelegramCredential(input.env, drainingIntegration.id, shopId);
    await new TelegramClient(credential.credentials.botToken, input.fetcher).deleteWebhook(true);
  } catch {
    // Disconnect remains authoritative even when the provider token was revoked.
  }
  const now = new Date().toISOString();
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE telegram_integrations SET status = 'disabled', webhook_status = 'disabled', active_credential_id = NULL, integration_generation = integration_generation + 1, generation_state = 'active', last_health_update_at = NULL, last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ? AND generation_state = 'draining' AND integration_generation = ? AND active_credential_id = ?").bind(now, integration.id, shopId, integration.integrationGeneration, integration.activeCredentialId),
    input.env.PLATFORM_DB.prepare("UPDATE telegram_credentials SET status = 'revoked', revoked_at = ? WHERE integration_id = ? AND shop_id = ? AND status IN ('active', 'pending') AND EXISTS (SELECT 1 FROM telegram_integrations WHERE id = ? AND shop_id = ? AND active_credential_id IS NULL AND integration_generation = ?)").bind(now, integration.id, shopId, integration.id, shopId, integration.integrationGeneration + 1),
    input.env.PLATFORM_DB.prepare("UPDATE telegram_updates SET status = 'rejected', safe_result_code = 'telegram_update_stale_generation', processed_at = ?, updated_at = ? WHERE integration_id = ? AND shop_id = ? AND integration_generation = ? AND status IN ('accepted', 'failed')").bind(now, now, integration.id, shopId, integration.integrationGeneration),
    input.env.PLATFORM_DB.prepare("UPDATE telegram_recipients SET status = 'unavailable', last_safe_error_code = 'telegram_integration_disconnected', updated_at = ? WHERE integration_id = ? AND shop_id = ? AND status = 'active'").bind(now, integration.id, shopId),
    input.env.PLATFORM_DB.prepare("INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) VALUES (?, ?, 'system', NULL, 'telegram.update_generation_fenced', 'telegram_integration', ?, '{\"reason\":\"disconnect\"}', ?, ?)").bind(createId("aud"), shopId, integration.id, input.requestId, now),
    input.env.PLATFORM_DB.prepare(`INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) VALUES (?, ?, 'user', ?, 'telegram.disconnected', 'telegram_integration', ?, '{}', ?, ?)`).bind(createId("aud"), shopId, input.userId, integration.id, input.requestId, now),
  ]);
}

export async function updateTelegramMenuConfig(input: {
  env: AppBindings;
  fetcher?: typeof fetch;
  menuConfigJson?: string | null;
  shopPublicId: string;
  supportHandle?: string | null;
  templatePreset: TelegramTemplatePreset;
  userId: string;
  welcomeMessageCustom?: string | null;
}): Promise<TelegramIntegrationView> {
  const actor = await requireIntegrationCredential(input.env, input.shopPublicId, input.userId);
  const { shopId } = actor;
  const integration = await findIntegration(input.env, shopId);
  if (integration === null) throw new AppError("telegram_not_configured", 404);

  const allowedPresets: TelegramTemplatePreset[] = [
    "license_vault",
    "gaming_topup",
    "subscription_slots",
    "mini_app_hybrid",
    "vip_community",
  ];
  if (!allowedPresets.includes(input.templatePreset)) {
    throw new AppError("telegram_template_preset_invalid", 400);
  }

  const nowIso = new Date().toISOString();
  await input.env.PLATFORM_DB.prepare(`
    UPDATE telegram_integrations
    SET template_preset = ?,
        welcome_message_custom = ?,
        support_handle = ?,
        menu_config_json = ?,
        updated_at = ?
    WHERE id = ? AND shop_id = ?
  `).bind(
    input.templatePreset,
    input.welcomeMessageCustom ?? null,
    input.supportHandle ?? null,
    input.menuConfigJson ?? null,
    nowIso,
    integration.id,
    shopId
  ).run();

  // If the integration is active, update commands/menu button with Telegram API
  if (integration.activeCredentialId !== null && integration.status === "active") {
    try {
      const credential = await loadActiveTelegramCredential(input.env, integration.id, shopId);
      const client = new TelegramClient(credential.credentials.botToken, input.fetcher);
      if (input.templatePreset === "mini_app_hybrid") {
        const miniAppUrl = `https://${actor.defaultLocale === "vi-VN" || actor.defaultLocale === "vi" ? "selinow.com" : "selinow.com"}/api/channels/telegram-mini-app/launch`;
        await client.setChatMenuButton({
          text: actor.defaultLocale === "vi-VN" || actor.defaultLocale === "vi" ? "Cửa hàng" : "Store",
          type: "web_app",
          web_app: { url: miniAppUrl },
        }).catch(() => undefined);
      } else {
        await client.setChatMenuButton().catch(() => undefined);
      }
    } catch {
      // Best-effort remote menu update; local DB update is authoritative
    }
  }

  const updated = await findIntegration(input.env, shopId);
  if (updated === null) throw new AppError("internal_error", 500);
  return mapIntegration(updated);
}
