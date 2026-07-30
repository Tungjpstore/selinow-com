import { constantTimeEqual, hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";
import { resolveEncryptionKey } from "../crypto/keyring";
import type { AppBindings } from "../platform/bindings";
import { decryptTelegramChatId, decryptTelegramCredential, type EncryptedTelegramCredential } from "./crypto";

export type TelegramCredentialRow = EncryptedTelegramCredential & {
  credentialId: string;
  integrationId: string;
  keyVersion: string;
  shopId: string;
  status: string;
  webhookSecretDigest: string;
};

export type TelegramWebhookIntegration = {
  botDisplayName: string | null;
  botUsername: string | null;
  credential: TelegramCredentialRow;
  integrationId: string;
  integrationStatus: string;
  shopId: string;
  shopName: string;
  defaultLocale: string;
  shopStatus: string;
  subscriptionState: string;
};

export type TelegramRecipientEncryptionRow = {
  ciphertextB64: string;
  identityId: string;
  integrationId: string;
  ivB64: string;
  keyVersion: string;
  shopId: string;
};

const CREDENTIAL_SELECT = `
  telegram_credentials.id AS credentialId,
  telegram_credentials.integration_id AS integrationId,
  telegram_credentials.shop_id AS shopId,
  telegram_credentials.status,
  telegram_credentials.key_version AS keyVersion,
  telegram_credentials.bot_token_ciphertext_b64 AS botTokenCiphertextB64,
  telegram_credentials.bot_token_iv_b64 AS botTokenIvB64,
  telegram_credentials.webhook_secret_ciphertext_b64 AS webhookSecretCiphertextB64,
  telegram_credentials.webhook_secret_iv_b64 AS webhookSecretIvB64,
  telegram_credentials.token_fingerprint AS tokenFingerprint,
  telegram_credentials.webhook_secret_digest AS webhookSecretDigest
`;

export async function decryptTelegramCredentialRow(env: AppBindings, row: TelegramCredentialRow): Promise<{ botToken: string; webhookSecret: string }> {
  const key = resolveEncryptionKey(env, "credential", row.keyVersion);
  return decryptTelegramCredential(row, { credentialId: row.credentialId, integrationId: row.integrationId, kek: key.kek, keyVersion: key.version, shopId: row.shopId });
}

export function decryptTelegramRecipientRow(env: AppBindings, row: TelegramRecipientEncryptionRow): Promise<string> {
  const key = resolveEncryptionKey(env, "credential", row.keyVersion);
  return decryptTelegramChatId(row, { identityId: row.identityId, integrationId: row.integrationId, kek: key.kek, keyVersion: key.version, shopId: row.shopId });
}

export async function loadActiveTelegramCredential(env: AppBindings, integrationId: string, shopId: string): Promise<{ credentials: { botToken: string; webhookSecret: string }; row: TelegramCredentialRow }> {
  const row = await env.PLATFORM_DB.prepare(`SELECT ${CREDENTIAL_SELECT} FROM telegram_credentials WHERE integration_id = ? AND shop_id = ? AND status = 'active' LIMIT 1`).bind(integrationId, shopId).first<TelegramCredentialRow>();
  if (row === null) throw new AppError("telegram_not_configured", 409);
  return { credentials: await decryptTelegramCredentialRow(env, row), row };
}

export async function loadTelegramWebhookIntegration(env: AppBindings, webhookPublicId: string): Promise<TelegramWebhookIntegration> {
  const row = await env.PLATFORM_DB.prepare(`
    SELECT ${CREDENTIAL_SELECT},
      telegram_integrations.id AS integrationId,
      telegram_integrations.shop_id AS shopId,
      telegram_integrations.status AS integrationStatus,
      telegram_integrations.bot_username_sanitized AS botUsername,
      telegram_integrations.bot_display_name_sanitized AS botDisplayName,
      shops.name AS shopName,
      shops.default_locale AS defaultLocale,
      shops.status AS shopStatus,
      shop_subscriptions.state AS subscriptionState
    FROM telegram_integrations
    INNER JOIN telegram_credentials
      ON telegram_credentials.id = telegram_integrations.active_credential_id
      AND telegram_credentials.integration_id = telegram_integrations.id
      AND telegram_credentials.shop_id = telegram_integrations.shop_id
      AND telegram_credentials.status = 'active'
    INNER JOIN shops ON shops.id = telegram_integrations.shop_id
    INNER JOIN shop_subscriptions
      ON shop_subscriptions.shop_id = shops.id
      AND shop_subscriptions.state != 'canceled'
    WHERE telegram_integrations.webhook_public_id = ?
      AND telegram_integrations.status IN ('active', 'degraded')
    LIMIT 1
  `).bind(webhookPublicId).first<TelegramCredentialRow & Omit<TelegramWebhookIntegration, "credential">>();
  if (row === null) throw new AppError("webhook_not_found", 404);
  return { ...row, credential: row };
}

export async function verifyTelegramWebhookSecret(env: AppBindings, integration: TelegramWebhookIntegration, candidate: string | null): Promise<boolean> {
  if (candidate === null || candidate.length < 1 || candidate.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(candidate)) return false;
  const digest = await hmacToken(env.IDENTIFIER_HMAC_SECRET, `telegram-webhook:${integration.integrationId}`, candidate);
  return constantTimeEqual(digest, integration.credential.webhookSecretDigest);
}
