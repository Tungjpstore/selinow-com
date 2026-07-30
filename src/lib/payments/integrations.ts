import { AppError } from "../core/errors";
import { hmacToken } from "../core/crypto";
import { createId } from "../core/ids";
import { resolveActiveEncryptionKey, resolveEncryptionKey } from "../crypto/keyring";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";
import { decryptPayOSCredentials, encryptPayOSCredentials, type EncryptedPayOSCredentials, type PayOSCredentials } from "./crypto";
import { loadCredentialById } from "./credentials";
import { PayOSClient } from "./payos";

type IntegrationRow = {
  activeCredentialId: string | null;
  connectedAt: string | null;
  id: string;
  lastCheckedAt: string | null;
  lastSafeErrorCode: string | null;
  lastWebhookVerifiedAt: string | null;
  publicId: string;
  providerIdentityFingerprint: string | null;
  status: string;
  webhookPublicId: string;
  webhookStatus: string;
};

export type PaymentIntegrationView = {
  connectedAt: string | null;
  lastCheckedAt: string | null;
  lastSafeErrorCode: string | null;
  lastWebhookVerifiedAt: string | null;
  provider: "payos";
  publicId: string;
  status: string;
  webhookStatus: string;
};

function mapIntegration(row: IntegrationRow): PaymentIntegrationView {
  return { connectedAt: row.connectedAt, lastCheckedAt: row.lastCheckedAt, lastSafeErrorCode: row.lastSafeErrorCode, lastWebhookVerifiedAt: row.lastWebhookVerifiedAt, provider: "payos", publicId: row.publicId, status: row.status, webhookStatus: row.webhookStatus };
}

async function requirePaymentActor(env: AppBindings, shopPublicId: string, userId: string): Promise<string> {
  const member = await getShopForMember({ capability: "payments:manage", env, shopPublicId, userId });
  return member.row.shop_id;
}

async function requirePaymentOwner(env: AppBindings, shopPublicId: string, userId: string): Promise<string> {
  const member = await getShopForMember({ capability: "payments:manage", env, shopPublicId, userId });
  if (member.row.role !== "owner") throw new AppError("authorization_denied", 403);
  return member.row.shop_id;
}

async function findIntegration(env: AppBindings, shopId: string): Promise<IntegrationRow | null> {
  return env.PLATFORM_DB.prepare(`SELECT id, public_id AS publicId, webhook_public_id AS webhookPublicId, status, webhook_status AS webhookStatus, active_credential_id AS activeCredentialId, connected_at AS connectedAt, last_safe_error_code AS lastSafeErrorCode, last_checked_at AS lastCheckedAt, last_webhook_verified_at AS lastWebhookVerifiedAt, provider_identity_fingerprint AS providerIdentityFingerprint FROM payment_integrations WHERE shop_id = ? AND provider = 'payos' LIMIT 1`).bind(shopId).first<IntegrationRow>();
}

type PaymentCredentialState = {
  credentialId: string;
  graceEndsAt: string | null;
  providerOwnershipFingerprint: string | null;
  status: "active" | "error" | "grace" | "pending" | "revoked";
  version: number;
};

type PreparedPaymentCredential = PaymentCredentialState & { alreadyActive: boolean };

type RetryablePaymentCredential = EncryptedPayOSCredentials & PaymentCredentialState & {
  integrationId: string;
  keyVersion: string;
  shopId: string;
};

async function paymentCredentialFingerprint(env: AppBindings, shopId: string, credentials: PayOSCredentials): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, `payos-credential:${shopId}`, `${credentials.clientId}\0${credentials.apiKey}\0${credentials.checksumKey}`);
}

async function paymentProviderCredentialFingerprint(env: AppBindings, credentials: PayOSCredentials): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, "payos-provider-credential:v1", `${credentials.clientId.trim()}\0${credentials.apiKey.trim()}\0${credentials.checksumKey.trim()}`);
}

async function paymentProviderIdentityFingerprint(env: AppBindings, credentials: PayOSCredentials): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, "payos-provider-identity:v1", credentials.clientId.trim());
}

async function claimPaymentProviderIdentity(input: {
  credentials: PayOSCredentials;
  env: AppBindings;
  integration: IntegrationRow;
  shopId: string;
}): Promise<void> {
  const fingerprint = await paymentProviderIdentityFingerprint(input.env, input.credentials);
  const existing = input.integration.providerIdentityFingerprint ?? null;
  if (existing !== null && existing !== fingerprint) throw new AppError("credential_channel_mismatch", 409);
  if (existing === fingerprint) return;
  const now = new Date().toISOString();
  try {
    const claimed = await input.env.PLATFORM_DB.prepare(`
      UPDATE payment_integrations
      SET provider_identity_fingerprint = ?, updated_at = ?
      WHERE id = ? AND shop_id = ? AND provider = 'payos'
        AND provider_identity_fingerprint IS NULL
      RETURNING provider_identity_fingerprint AS providerIdentityFingerprint
    `).bind(fingerprint, now, input.integration.id, input.shopId).first<{ providerIdentityFingerprint: string }>();
    if (claimed?.providerIdentityFingerprint === fingerprint) {
      input.integration.providerIdentityFingerprint = fingerprint;
      return;
    }
  } catch {
    const owner = await input.env.PLATFORM_DB.prepare(`
      SELECT shop_id AS shopId
      FROM payment_integrations
      WHERE provider = 'payos' AND provider_identity_fingerprint = ?
      LIMIT 1
    `).bind(fingerprint).first<{ shopId: string }>();
    if (owner !== null && owner.shopId !== input.shopId) throw new AppError("credential_already_connected", 409);
    throw new AppError("payment_integration_conflict", 409);
  }
  const owner = await input.env.PLATFORM_DB.prepare(`
    SELECT shop_id AS shopId
    FROM payment_integrations
    WHERE provider = 'payos' AND provider_identity_fingerprint = ?
    LIMIT 1
  `).bind(fingerprint).first<{ shopId: string }>();
  if (owner !== null && owner.shopId !== input.shopId) throw new AppError("credential_already_connected", 409);
  throw new AppError("payment_integration_conflict", 409);
}

async function findPaymentCredentialByFingerprint(env: AppBindings, shopId: string, fingerprint: string): Promise<PaymentCredentialState | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id AS credentialId, status, version,
      grace_ends_at AS graceEndsAt,
      provider_ownership_fingerprint AS providerOwnershipFingerprint
    FROM payment_credentials
    WHERE shop_id = ? AND provider = 'payos' AND credential_fingerprint = ?
    LIMIT 1
  `).bind(shopId, fingerprint).first<PaymentCredentialState>();
}

async function findPaymentCredentialByProviderFingerprint(env: AppBindings, fingerprint: string): Promise<PaymentCredentialState | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id AS credentialId, status, version, grace_ends_at AS graceEndsAt,
      provider_ownership_fingerprint AS providerOwnershipFingerprint
    FROM payment_credentials
    WHERE provider = 'payos' AND provider_ownership_fingerprint = ?
      AND status IN ('pending', 'active', 'grace', 'error')
    LIMIT 1
  `).bind(fingerprint).first<PaymentCredentialState>();
}

async function findVerifiedPaymentCredentialByProviderFingerprint(env: AppBindings, fingerprint: string): Promise<PaymentCredentialState | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id AS credentialId, status, version, grace_ends_at AS graceEndsAt,
      provider_ownership_fingerprint AS providerOwnershipFingerprint
    FROM payment_credentials
    WHERE provider = 'payos' AND provider_ownership_fingerprint = ?
      AND status IN ('active', 'grace')
    LIMIT 1
  `).bind(fingerprint).first<PaymentCredentialState>();
}

async function claimPaymentProviderCredential(input: {
  env: AppBindings;
  fingerprint: string;
  credentialId: string;
  integrationId: string;
  shopId: string;
}): Promise<void> {
  try {
    await input.env.PLATFORM_DB.prepare(`
      UPDATE payment_credentials
      SET provider_ownership_fingerprint = ?
      WHERE id = ? AND integration_id = ? AND shop_id = ?
        AND provider = 'payos'
        AND provider_ownership_fingerprint IS NULL
    `).bind(input.fingerprint, input.credentialId, input.integrationId, input.shopId).run();
    const claimed = await input.env.PLATFORM_DB.prepare(`
      SELECT provider_ownership_fingerprint AS providerOwnershipFingerprint
      FROM payment_credentials
      WHERE id = ? AND integration_id = ? AND shop_id = ? AND provider = 'payos'
    `).bind(input.credentialId, input.integrationId, input.shopId)
      .first<{ providerOwnershipFingerprint: string | null }>();
    if (claimed?.providerOwnershipFingerprint === input.fingerprint) return;
  } catch {
    const owner = await findPaymentCredentialByProviderFingerprint(input.env, input.fingerprint);
    if (owner !== null && owner.credentialId !== input.credentialId) {
      throw new AppError("credential_already_connected", 409);
    }
    throw new AppError("payment_integration_conflict", 409);
  }
  const owner = await findPaymentCredentialByProviderFingerprint(input.env, input.fingerprint);
  if (owner !== null && owner.credentialId !== input.credentialId) {
    throw new AppError("credential_already_connected", 409);
  }
  throw new AppError("payment_integration_conflict", 409);
}

async function findRetryablePaymentCredential(env: AppBindings, integrationId: string, shopId: string): Promise<RetryablePaymentCredential | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT
      id AS credentialId,
      integration_id AS integrationId,
      shop_id AS shopId,
      status,
      version,
      key_version AS keyVersion,
      client_id_ciphertext_b64 AS clientIdCiphertextB64,
      client_id_iv_b64 AS clientIdIvB64,
      api_key_ciphertext_b64 AS apiKeyCiphertextB64,
      api_key_iv_b64 AS apiKeyIvB64,
      checksum_key_ciphertext_b64 AS checksumKeyCiphertextB64,
      checksum_key_iv_b64 AS checksumKeyIvB64,
      credential_fingerprint AS fingerprint,
      provider_ownership_fingerprint AS providerOwnershipFingerprint
    FROM payment_credentials
    WHERE integration_id = ? AND shop_id = ? AND provider = 'payos'
      AND status IN ('pending', 'error')
    ORDER BY version DESC
    LIMIT 1
  `).bind(integrationId, shopId).first<RetryablePaymentCredential>();
}

async function resumePaymentCredential(input: {
  env: AppBindings;
  integration: IntegrationRow;
  row: PaymentCredentialState;
  shopId: string;
}): Promise<PreparedPaymentCredential> {
  if ((input.row.status !== "pending" && input.row.status !== "error")
    && (typeof input.row.providerOwnershipFingerprint !== "string" || input.row.providerOwnershipFingerprint.length === 0)) {
    throw new AppError("payment_not_configured", 409);
  }
  if (input.row.status === "revoked") throw new AppError("credential_duplicate", 409);
  if (input.row.status === "grace") {
    if (input.integration.status !== "disconnected" || input.integration.activeCredentialId !== null
      || (input.row.graceEndsAt !== null && input.row.graceEndsAt <= new Date().toISOString())) {
      throw new AppError("credential_duplicate", 409);
    }
    await input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'pending', grace_ends_at = NULL WHERE id = ? AND integration_id = ? AND shop_id = ? AND status = 'grace'").bind(input.row.credentialId, input.integration.id, input.shopId).run();
  }
  if (input.row.status === "active" && input.integration.activeCredentialId !== input.row.credentialId) throw new AppError("credential_duplicate", 409);
  const now = new Date().toISOString();
  if (input.row.status === "error") {
    await input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'pending' WHERE id = ? AND integration_id = ? AND shop_id = ? AND status = 'error'").bind(input.row.credentialId, input.integration.id, input.shopId).run();
  }
  await input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = CASE WHEN active_credential_id IS NULL THEN 'pending' ELSE status END, webhook_status = CASE WHEN active_credential_id IS NULL THEN 'pending' ELSE webhook_status END, last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ?").bind(now, input.integration.id, input.shopId).run();
  return {
    ...input.row,
    alreadyActive: input.row.status === "active" && input.integration.status === "active" && input.integration.webhookStatus === "verified",
  };
}

async function preparePaymentCredential(input: {
  credentials: PayOSCredentials;
  env: AppBindings;
  integration: IntegrationRow;
  shopId: string;
  userId: string;
}): Promise<PreparedPaymentCredential> {
  const fingerprint = await paymentCredentialFingerprint(input.env, input.shopId, input.credentials);
  const existing = await findPaymentCredentialByFingerprint(input.env, input.shopId, fingerprint);
  if (existing !== null) return resumePaymentCredential({ env: input.env, integration: input.integration, row: existing, shopId: input.shopId });
  const providerFingerprint = await paymentProviderCredentialFingerprint(input.env, input.credentials);
  const providerOwner = await findVerifiedPaymentCredentialByProviderFingerprint(input.env, providerFingerprint);
  if (providerOwner !== null) {
    throw new AppError(providerOwner.credentialId === input.integration.activeCredentialId ? "credential_duplicate" : "credential_already_connected", 409);
  }

  const versionRow = await input.env.PLATFORM_DB.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM payment_credentials WHERE integration_id = ? AND shop_id = ?").bind(input.integration.id, input.shopId).first<{ version: number }>();
  const version = versionRow?.version ?? 1;
  const credentialId = createId("pcr");
  const activeKey = resolveActiveEncryptionKey(input.env, "credential");
  const encrypted = await encryptPayOSCredentials(input.credentials, { credentialId, hmacSecret: input.env.IDENTIFIER_HMAC_SECRET, integrationId: input.integration.id, kek: activeKey.kek, keyVersion: activeKey.version, shopId: input.shopId });
  const now = new Date().toISOString();
  try {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`INSERT INTO payment_credentials (id, shop_id, integration_id, provider, status, version, key_version, client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64, api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64, credential_fingerprint, provider_ownership_fingerprint, created_by_user_id, created_at) VALUES (?, ?, ?, 'payos', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(credentialId, input.shopId, input.integration.id, version, activeKey.version, encrypted.clientIdCiphertextB64, encrypted.clientIdIvB64, encrypted.apiKeyCiphertextB64, encrypted.apiKeyIvB64, encrypted.checksumKeyCiphertextB64, encrypted.checksumKeyIvB64, encrypted.fingerprint, null, input.userId, now),
      input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = 'pending', webhook_status = 'pending', last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ?").bind(now, input.integration.id, input.shopId),
    ]);
    return { alreadyActive: false, credentialId, graceEndsAt: null, providerOwnershipFingerprint: null, status: "pending", version };
  } catch {
    const winner = await findPaymentCredentialByFingerprint(input.env, input.shopId, fingerprint);
    if (winner === null) {
      const owner = await findPaymentCredentialByProviderFingerprint(input.env, providerFingerprint);
      if (owner !== null && owner.credentialId !== credentialId) throw new AppError("credential_already_connected", 409);
      throw new AppError("credential_duplicate", 409);
    }
    return resumePaymentCredential({ env: input.env, integration: input.integration, row: winner, shopId: input.shopId });
  }
}

export async function getPaymentIntegration(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<PaymentIntegrationView | null> {
  const shopId = await requirePaymentActor(input.env, input.shopPublicId, input.userId);
  const row = await findIntegration(input.env, shopId);
  return row === null ? null : mapIntegration(row);
}

export async function connectPayOS(input: { credentials: PayOSCredentials; env: AppBindings; fetcher?: typeof fetch; requestId: string; shopPublicId: string; userId: string }): Promise<PaymentIntegrationView> {
  const shopId = await requirePaymentActor(input.env, input.shopPublicId, input.userId);
  let integration = await findIntegration(input.env, shopId);
  const now = new Date();
  const nowIso = now.toISOString();
  if (integration === null) {
    const id = createId("pin");
    const publicId = createId("payint");
    const webhookPublicId = createId("paywh");
    await input.env.PLATFORM_DB.prepare(`INSERT INTO payment_integrations (id, public_id, webhook_public_id, shop_id, provider, status, webhook_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'payos', 'pending', 'pending', ?, ?)`).bind(id, publicId, webhookPublicId, shopId, nowIso, nowIso).run();
    integration = { activeCredentialId: null, connectedAt: null, id, lastCheckedAt: null, lastSafeErrorCode: null, lastWebhookVerifiedAt: null, providerIdentityFingerprint: null, publicId, status: "pending", webhookPublicId, webhookStatus: "pending" };
  }
  const credential = await preparePaymentCredential({ credentials: input.credentials, env: input.env, integration, shopId, userId: input.userId });
  if (credential.alreadyActive) return mapIntegration(integration);
  const webhookUrl = `${input.env.API_ORIGIN}/webhooks/payos/${integration.webhookPublicId}`;
  try {
    await new PayOSClient(input.credentials, input.fetcher).confirmWebhook(webhookUrl);
  } catch {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'error' WHERE id = ? AND shop_id = ? AND status = 'pending'").bind(credential.credentialId, shopId),
      input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = CASE WHEN active_credential_id IS NULL THEN 'error' ELSE status END, webhook_status = CASE WHEN active_credential_id IS NULL THEN 'error' ELSE webhook_status END, last_safe_error_code = 'provider_verification_failed', last_checked_at = ?, updated_at = ? WHERE id = ? AND shop_id = ?").bind(new Date().toISOString(), new Date().toISOString(), integration.id, shopId),
    ]);
    throw new AppError("provider_verification_failed", 409);
  }
  try {
    await claimPaymentProviderIdentity({ credentials: input.credentials, env: input.env, integration, shopId });
    await claimPaymentProviderCredential({
      env: input.env,
      fingerprint: await paymentProviderCredentialFingerprint(input.env, input.credentials),
      credentialId: credential.credentialId,
      integrationId: integration.id,
      shopId,
    });
  } catch (error) {
    const failedAt = new Date().toISOString();
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'revoked', revoked_at = ? WHERE id = ? AND shop_id = ? AND status IN ('pending', 'error')").bind(failedAt, credential.credentialId, shopId),
      input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = CASE WHEN active_credential_id IS NULL THEN 'error' ELSE status END, webhook_status = CASE WHEN active_credential_id IS NULL THEN 'error' ELSE webhook_status END, last_safe_error_code = 'credential_channel_mismatch', last_checked_at = ?, updated_at = ? WHERE id = ? AND shop_id = ?").bind(failedAt, failedAt, integration.id, shopId),
    ]);
    throw error;
  }
  const activatedAt = new Date().toISOString();
  const graceEndsAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const rotated = integration.activeCredentialId !== null && integration.activeCredentialId !== credential.credentialId;
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'grace', grace_ends_at = ? WHERE integration_id = ? AND shop_id = ? AND status = 'active' AND id != ?").bind(graceEndsAt, integration.id, shopId, credential.credentialId),
    input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'active', activated_at = ? WHERE id = ? AND integration_id = ? AND shop_id = ? AND status IN ('pending', 'error')").bind(activatedAt, credential.credentialId, integration.id, shopId),
    input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = 'active', webhook_status = 'verified', active_credential_id = ?, connected_at = COALESCE(connected_at, ?), last_safe_error_code = NULL, last_checked_at = ?, last_webhook_verified_at = ?, updated_at = ? WHERE id = ? AND shop_id = ?").bind(credential.credentialId, activatedAt, activatedAt, activatedAt, activatedAt, integration.id, shopId),
    input.env.PLATFORM_DB.prepare(`INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) SELECT ?, ?, 'user', ?, 'payos.credentials_connected', 'payment_integration', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM payment_credentials WHERE id = ? AND integration_id = ? AND shop_id = ? AND activated_at = ?)`).bind(createId("aud"), shopId, input.userId, integration.id, JSON.stringify({ credentialVersion: credential.version, rotated }), input.requestId, activatedAt, credential.credentialId, integration.id, shopId, activatedAt),
  ]);
  const active = await findIntegration(input.env, shopId);
  if (active === null) throw new AppError("internal_error", 500);
  return mapIntegration(active);
}

async function retryPayOSSetup(input: {
  env: AppBindings;
  fetcher?: typeof fetch;
  integration: IntegrationRow;
  requestId: string;
  shopId: string;
  userId: string;
}): Promise<void> {
  const row = await findRetryablePaymentCredential(input.env, input.integration.id, input.shopId);
  if (row === null) throw new AppError("payment_not_configured", 409);
  const key = resolveEncryptionKey(input.env, "credential", row.keyVersion);
  const credentials = await decryptPayOSCredentials(row, {
    credentialId: row.credentialId,
    integrationId: input.integration.id,
    kek: key.kek,
    keyVersion: key.version,
    shopId: input.shopId,
  });
  const checkedAt = new Date().toISOString();
  try {
    await new PayOSClient(credentials, input.fetcher).confirmWebhook(`${input.env.API_ORIGIN}/webhooks/payos/${input.integration.webhookPublicId}`);
  } catch (error) {
    const code = error instanceof AppError ? error.code : "provider_unavailable";
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'error' WHERE id = ? AND integration_id = ? AND shop_id = ? AND status IN ('pending', 'error')").bind(row.credentialId, input.integration.id, input.shopId),
      input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = 'error', webhook_status = 'error', last_safe_error_code = ?, last_checked_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND active_credential_id IS NULL").bind(code, checkedAt, checkedAt, input.integration.id, input.shopId),
    ]);
    return;
  }
  try {
    await claimPaymentProviderIdentity({ credentials, env: input.env, integration: input.integration, shopId: input.shopId });
    await claimPaymentProviderCredential({
      env: input.env,
      fingerprint: await paymentProviderCredentialFingerprint(input.env, credentials),
      credentialId: row.credentialId,
      integrationId: input.integration.id,
      shopId: input.shopId,
    });
  } catch {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'revoked', revoked_at = ? WHERE id = ? AND integration_id = ? AND shop_id = ? AND status IN ('pending', 'error')").bind(checkedAt, row.credentialId, input.integration.id, input.shopId),
      input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = 'error', webhook_status = 'error', last_safe_error_code = 'credential_channel_mismatch', last_checked_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND active_credential_id IS NULL").bind(checkedAt, checkedAt, input.integration.id, input.shopId),
    ]);
    return;
  }
  const activatedAt = new Date().toISOString();
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'active', activated_at = ? WHERE id = ? AND integration_id = ? AND shop_id = ? AND status IN ('pending', 'error') AND EXISTS (SELECT 1 FROM payment_integrations WHERE id = ? AND shop_id = ? AND active_credential_id IS NULL)").bind(activatedAt, row.credentialId, input.integration.id, input.shopId, input.integration.id, input.shopId),
    input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = 'active', webhook_status = 'verified', active_credential_id = ?, connected_at = COALESCE(connected_at, ?), last_safe_error_code = NULL, last_checked_at = ?, last_webhook_verified_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND active_credential_id IS NULL AND EXISTS (SELECT 1 FROM payment_credentials WHERE id = ? AND integration_id = ? AND shop_id = ? AND activated_at = ?)").bind(row.credentialId, activatedAt, activatedAt, activatedAt, activatedAt, input.integration.id, input.shopId, row.credentialId, input.integration.id, input.shopId, activatedAt),
    input.env.PLATFORM_DB.prepare(`INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) SELECT ?, ?, 'user', ?, 'payos.credentials_connected', 'payment_integration', ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM payment_credentials WHERE id = ? AND integration_id = ? AND shop_id = ? AND activated_at = ?)`).bind(createId("aud"), input.shopId, input.userId, input.integration.id, JSON.stringify({ credentialVersion: row.version, retry: true, rotated: false }), input.requestId, activatedAt, row.credentialId, input.integration.id, input.shopId, activatedAt),
  ]);
}

export async function refreshPayOSHealth(input: { env: AppBindings; fetcher?: typeof fetch; requestId: string; shopPublicId: string; userId: string }): Promise<PaymentIntegrationView> {
  const shopId = await requirePaymentOwner(input.env, input.shopPublicId, input.userId);
  const integration = await findIntegration(input.env, shopId);
  if (integration === null || integration.status === "disconnected") throw new AppError("payment_not_configured", 409);
  if (integration.activeCredentialId === null) {
    await retryPayOSSetup({ ...input, integration, shopId });
    const retried = await findIntegration(input.env, shopId);
    if (retried === null) throw new AppError("internal_error", 500);
    return mapIntegration(retried);
  }
  const credential = await loadCredentialById(input.env, integration.activeCredentialId, shopId);
  const now = new Date().toISOString();
  try {
    await new PayOSClient(credential.credentials, input.fetcher).confirmWebhook(`${input.env.API_ORIGIN}/webhooks/payos/${integration.webhookPublicId}`);
    await claimPaymentProviderIdentity({ credentials: credential.credentials, env: input.env, integration, shopId });
    await claimPaymentProviderCredential({
      env: input.env,
      fingerprint: await paymentProviderCredentialFingerprint(input.env, credential.credentials),
      credentialId: credential.row.credentialId,
      integrationId: integration.id,
      shopId,
    });
    await input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = 'active', webhook_status = 'verified', last_safe_error_code = NULL, last_checked_at = ?, last_webhook_verified_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND active_credential_id = ?").bind(now, now, now, integration.id, shopId, credential.row.credentialId).run();
  } catch (error) {
    const code = error instanceof AppError ? error.code : "provider_unavailable";
    await input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = 'error', webhook_status = 'error', last_safe_error_code = ?, last_checked_at = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND active_credential_id = ?").bind(code, now, now, integration.id, shopId, credential.row.credentialId).run();
  }
  const refreshed = await findIntegration(input.env, shopId);
  if (refreshed === null) throw new AppError("internal_error", 500);
  return mapIntegration(refreshed);
}

export async function disconnectPayOS(input: { env: AppBindings; requestId: string; shopPublicId: string; userId: string }): Promise<void> {
  const shopId = await requirePaymentActor(input.env, input.shopPublicId, input.userId);
  const integration = await findIntegration(input.env, shopId);
  if (integration === null) throw new AppError("payment_not_configured", 409);
  const now = new Date().toISOString();
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = 'disconnected', webhook_status = 'disconnected', active_credential_id = NULL, updated_at = ? WHERE id = ? AND shop_id = ?").bind(now, integration.id, shopId),
    input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'grace', grace_ends_at = ? WHERE integration_id = ? AND shop_id = ? AND status = 'active'").bind(new Date(Date.now() + 24 * 60 * 60_000).toISOString(), integration.id, shopId),
    input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'revoked', revoked_at = ? WHERE integration_id = ? AND shop_id = ? AND status IN ('pending', 'error')").bind(now, integration.id, shopId),
    input.env.PLATFORM_DB.prepare(`INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) VALUES (?, ?, 'user', ?, 'payos.disconnected', 'payment_integration', ?, '{}', ?, ?)`).bind(createId("aud"), shopId, input.userId, integration.id, input.requestId, now),
  ]);
}
