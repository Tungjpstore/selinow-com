import { AppError } from "../core/errors";
import { resolveEncryptionKey } from "../crypto/keyring";
import type { AppBindings } from "../platform/bindings";
import { decryptPayOSCredentials, type EncryptedPayOSCredentials, type PayOSCredentials } from "./crypto";

export type CredentialRow = EncryptedPayOSCredentials & {
  credentialId: string;
  integrationId: string;
  keyVersion: string;
  providerOwnershipFingerprint: string | null;
  shopId: string;
  status: string;
  version: number;
};

const CREDENTIAL_SELECT = `
  payment_credentials.id AS credentialId,
  payment_credentials.integration_id AS integrationId,
  payment_credentials.shop_id AS shopId,
  payment_credentials.status,
  payment_credentials.version AS version,
  payment_credentials.key_version AS keyVersion,
  payment_credentials.client_id_ciphertext_b64 AS clientIdCiphertextB64,
  payment_credentials.client_id_iv_b64 AS clientIdIvB64,
  payment_credentials.api_key_ciphertext_b64 AS apiKeyCiphertextB64,
  payment_credentials.api_key_iv_b64 AS apiKeyIvB64,
  payment_credentials.checksum_key_ciphertext_b64 AS checksumKeyCiphertextB64,
  payment_credentials.checksum_key_iv_b64 AS checksumKeyIvB64,
  payment_credentials.credential_fingerprint AS fingerprint,
  payment_credentials.provider_ownership_fingerprint AS providerOwnershipFingerprint
`;

export async function loadCredentialById(env: AppBindings, credentialId: string, shopId: string): Promise<{ credentials: PayOSCredentials; row: CredentialRow }> {
  const row = await env.PLATFORM_DB.prepare(`SELECT ${CREDENTIAL_SELECT} FROM payment_credentials WHERE id = ? AND shop_id = ? AND provider_ownership_fingerprint IS NOT NULL AND (status = 'active' OR (status = 'grace' AND grace_ends_at > ?)) LIMIT 1`).bind(credentialId, shopId, new Date().toISOString()).first<CredentialRow>();
  if (row === null) throw new AppError("payment_not_configured", 409);
  return { credentials: await decryptCredentialRow(env, row), row };
}

export async function loadWebhookCredentials(env: AppBindings, webhookPublicId: string): Promise<{ credentials: PayOSCredentials; row: CredentialRow; integrationPublicId: string; webhookStatus: string }[]> {
  const rows = await env.PLATFORM_DB.prepare(`SELECT ${CREDENTIAL_SELECT}, payment_integrations.public_id AS integrationPublicId, payment_integrations.webhook_status AS webhookStatus FROM payment_integrations INNER JOIN payment_credentials ON payment_credentials.integration_id = payment_integrations.id AND payment_credentials.shop_id = payment_integrations.shop_id WHERE payment_integrations.webhook_public_id = ? AND payment_integrations.provider = 'payos' AND payment_credentials.provider_ownership_fingerprint IS NOT NULL AND payment_credentials.status IN ('active', 'grace', 'pending') AND (payment_credentials.status IN ('active', 'pending') OR payment_credentials.grace_ends_at > ?) ORDER BY CASE payment_credentials.status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, payment_credentials.version DESC LIMIT 3`).bind(webhookPublicId, new Date().toISOString()).all<CredentialRow & { integrationPublicId: string; webhookStatus: string }>();
  return Promise.all(rows.results.map(async (row) => ({ credentials: await decryptCredentialRow(env, row), integrationPublicId: row.integrationPublicId, row, webhookStatus: row.webhookStatus })));
}

async function decryptCredentialRow(env: AppBindings, row: CredentialRow): Promise<PayOSCredentials> {
  const key = resolveEncryptionKey(env, "credential", row.keyVersion);
  return decryptPayOSCredentials(row, { credentialId: row.credentialId, integrationId: row.integrationId, kek: key.kek, keyVersion: key.version, shopId: row.shopId });
}
