import { AppError } from "../core/errors";
import { hmacToken } from "../core/crypto";
import { createId } from "../core/ids";
import { tryRecordActivationMilestone } from "../analytics/activation";
import { evaluateSubscription, subscriptionAllows } from "../billing/entitlements";
import { resolveActiveEncryptionKey, resolveEncryptionKey } from "../crypto/keyring";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";
import { decryptPayOSCredentials, encryptPayOSCredentials, type EncryptedPayOSCredentials, type PayOSCredentials } from "./crypto";
import { loadCredentialById } from "./credentials";
import { isDefinitivePayOSWebhookRejection, PayOSClient } from "./payos";
import { assertPayOSChannelAdmitted, payOSProviderIdentityFingerprint } from "./payos-admission";

type IntegrationRow = {
  activeCredentialId: string | null;
  connectedAt: string | null;
  id: string;
  lastCheckedAt: string | null;
  lastSafeErrorCode: string | null;
  lastWebhookVerifiedAt: string | null;
  publicId: string;
  providerClaimGeneration: number;
  providerClaimNonce: string | null;
  providerClaimState: "ambiguous" | "idle" | "in_flight" | "quarantined";
  providerClaimTargetFingerprint: string | null;
  providerIdentityFingerprint: string | null;
  status: string;
  webhookPublicId: string;
  webhookStatus: string;
};

type ProviderSetupSubscriptionRow = {
  currentPeriodEnd: string | null;
  graceEndsAt: string | null;
  subscriptionState: string;
  trialEndsAt: string | null;
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

async function requirePaymentReader(env: AppBindings, shopPublicId: string, userId: string): Promise<string> {
  const member = await getShopForMember({ capability: "payments:read", env, shopPublicId, userId });
  return member.row.shop_id;
}

async function requirePaymentManager(env: AppBindings, shopPublicId: string, userId: string): Promise<string> {
  const member = await getShopForMember({ capability: "payments:manage", env, shopPublicId, userId });
  return member.row.shop_id;
}

async function requirePaymentOwner(env: AppBindings, shopPublicId: string, userId: string): Promise<string> {
  const member = await getShopForMember({ capability: "payments:manage", env, shopPublicId, userId });
  if (member.row.role !== "owner") throw new AppError("authorization_denied", 403);
  return member.row.shop_id;
}

async function assertPayOSProviderSetupAllowed(env: AppBindings, shopId: string): Promise<void> {
  const subscription = await env.PLATFORM_DB.prepare(`
    SELECT
      state AS subscriptionState,
      trial_ends_at AS trialEndsAt,
      current_period_end AS currentPeriodEnd,
      grace_ends_at AS graceEndsAt
    FROM shop_subscriptions
    WHERE shop_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).bind(shopId).first<ProviderSetupSubscriptionRow>();
  const decision = evaluateSubscription({
    action: "provider_setup",
    currentPeriodEnd: subscription?.currentPeriodEnd,
    graceEndsAt: subscription?.graceEndsAt,
    subscriptionState: subscription?.subscriptionState ?? "",
    trialEndsAt: subscription?.trialEndsAt,
  });
  if (!decision.allowed) {
    throw new AppError(decision.reasonCode ?? "subscription_payment_required", 402);
  }
  if (!subscriptionAllows({
    currentPeriodEnd: subscription?.currentPeriodEnd,
    graceEndsAt: subscription?.graceEndsAt,
    subscriptionState: subscription?.subscriptionState ?? "",
    trialEndsAt: subscription?.trialEndsAt,
  })) {
    throw new AppError("subscription_payment_required", 402);
  }
}

async function findIntegration(env: AppBindings, shopId: string): Promise<IntegrationRow | null> {
  return env.PLATFORM_DB.prepare(`SELECT id, public_id AS publicId, webhook_public_id AS webhookPublicId, status, webhook_status AS webhookStatus, active_credential_id AS activeCredentialId, connected_at AS connectedAt, last_safe_error_code AS lastSafeErrorCode, last_checked_at AS lastCheckedAt, last_webhook_verified_at AS lastWebhookVerifiedAt, provider_identity_fingerprint AS providerIdentityFingerprint, provider_claim_generation AS providerClaimGeneration, provider_claim_nonce AS providerClaimNonce, provider_claim_state AS providerClaimState, provider_claim_target_fingerprint AS providerClaimTargetFingerprint FROM payment_integrations WHERE shop_id = ? AND provider = 'payos' LIMIT 1`).bind(shopId).first<IntegrationRow>();
}

type PaymentCredentialState = {
  activatedAt: string | null;
  credentialId: string;
  graceEndsAt: string | null;
  providerClaimNonce: string | null;
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

type PaymentProviderOwnershipClaim = {
  generation: number;
  nonce: string;
  targetFingerprint: string;
};

async function paymentCredentialFingerprint(env: AppBindings, shopId: string, credentials: PayOSCredentials): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, `payos-credential:${shopId}`, `${credentials.clientId}\0${credentials.apiKey}\0${credentials.checksumKey}`);
}

async function paymentProviderCredentialFingerprint(env: AppBindings, credentials: PayOSCredentials): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, "payos-provider-credential:v1", `${credentials.clientId.trim()}\0${credentials.apiKey.trim()}\0${credentials.checksumKey.trim()}`);
}

async function paymentProviderWebhookTargetFingerprint(env: AppBindings, webhookUrl: string): Promise<string> {
  return hmacToken(env.IDENTIFIER_HMAC_SECRET, "payos-provider-webhook-target:v1", webhookUrl);
}

async function findHistoricalPaymentIdentityOwner(
  env: AppBindings,
  fingerprint: string,
): Promise<{ shopId: string } | null> {
  const table = await env.PLATFORM_DB.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'payos_provider_identity_history'
    LIMIT 1
  `).first<{ name: string }>();
  if (table === null) return null;
  return env.PLATFORM_DB.prepare(`
    SELECT shop_id AS shopId
    FROM payos_provider_identity_history
    WHERE provider = 'payos' AND provider_identity_fingerprint = ?
    LIMIT 1
  `).bind(fingerprint).first<{ shopId: string }>();
}

async function assertPaymentProviderIdentityOwnership(
  env: AppBindings,
  shopId: string,
  credentials: PayOSCredentials,
  integration: IntegrationRow | null,
): Promise<void> {
  const fingerprint = await payOSProviderIdentityFingerprint(env, credentials);
  // An explicit disconnect opens a controlled replacement window. Keep the
  // old fingerprint for pending webhook verification, but let the owner
  // prove and bind a new PayOS channel before reactivation.
  const existingFingerprint = integration?.status === "disconnected"
    ? null
    : integration?.providerIdentityFingerprint ?? null;
  if (existingFingerprint !== null && existingFingerprint !== fingerprint) {
    throw new AppError("credential_channel_mismatch", 409);
  }
  const owner = await env.PLATFORM_DB.prepare(`
    SELECT shop_id AS shopId
    FROM payment_integrations
    WHERE provider = 'payos' AND provider_identity_fingerprint = ?
    LIMIT 1
  `).bind(fingerprint).first<{ shopId: string }>();
  if (owner !== null && owner.shopId !== shopId) {
    throw new AppError("credential_already_connected", 409);
  }
  const historicalOwner = await findHistoricalPaymentIdentityOwner(env, fingerprint);
  if (historicalOwner !== null && historicalOwner.shopId !== shopId) {
    throw new AppError("credential_already_connected", 409);
  }
}

async function findPaymentCredentialByFingerprint(env: AppBindings, shopId: string, fingerprint: string): Promise<PaymentCredentialState | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id AS credentialId, status, version, activated_at AS activatedAt,
      grace_ends_at AS graceEndsAt,
      provider_claim_nonce AS providerClaimNonce,
      provider_ownership_fingerprint AS providerOwnershipFingerprint
    FROM payment_credentials
    WHERE shop_id = ? AND provider = 'payos' AND credential_fingerprint = ?
    LIMIT 1
  `).bind(shopId, fingerprint).first<PaymentCredentialState>();
}

async function findPaymentCredentialByProviderFingerprint(env: AppBindings, fingerprint: string): Promise<PaymentCredentialState | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id AS credentialId, status, version, activated_at AS activatedAt,
      grace_ends_at AS graceEndsAt, provider_claim_nonce AS providerClaimNonce,
      provider_ownership_fingerprint AS providerOwnershipFingerprint
    FROM payment_credentials
    WHERE provider = 'payos' AND provider_ownership_fingerprint = ?
      AND status IN ('pending', 'active', 'grace', 'error')
    LIMIT 1
  `).bind(fingerprint).first<PaymentCredentialState>();
}

async function findVerifiedPaymentCredentialByProviderFingerprint(env: AppBindings, fingerprint: string): Promise<PaymentCredentialState | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id AS credentialId, status, version, activated_at AS activatedAt,
      grace_ends_at AS graceEndsAt, provider_claim_nonce AS providerClaimNonce,
      provider_ownership_fingerprint AS providerOwnershipFingerprint
    FROM payment_credentials
    WHERE provider = 'payos' AND provider_ownership_fingerprint = ?
      AND status IN ('active', 'grace')
    LIMIT 1
  `).bind(fingerprint).first<PaymentCredentialState>();
}

async function paymentProviderOwnershipConflict(input: {
  credentialId: string;
  env: AppBindings;
  providerCredentialFingerprint: string;
  providerIdentityFingerprint: string;
  shopId: string;
}): Promise<AppError> {
  const identityOwner = await input.env.PLATFORM_DB.prepare(`
    SELECT shop_id AS shopId
    FROM payment_integrations
    WHERE provider = 'payos' AND provider_identity_fingerprint = ?
    LIMIT 1
  `).bind(input.providerIdentityFingerprint).first<{ shopId: string }>();
  if (identityOwner !== null && identityOwner.shopId !== input.shopId) {
    return new AppError("credential_already_connected", 409);
  }
  const historicalOwner = await findHistoricalPaymentIdentityOwner(input.env, input.providerIdentityFingerprint);
  if (historicalOwner !== null && historicalOwner.shopId !== input.shopId) {
    return new AppError("credential_already_connected", 409);
  }
  const credentialOwner = await findPaymentCredentialByProviderFingerprint(input.env, input.providerCredentialFingerprint);
  if (credentialOwner !== null && credentialOwner.credentialId !== input.credentialId) {
    return new AppError("credential_already_connected", 409);
  }
  return new AppError("payment_integration_conflict", 409);
}

async function claimPaymentProviderOwnership(input: {
  credentialId: string;
  credentials: PayOSCredentials;
  env: AppBindings;
  integration: IntegrationRow;
  shopId: string;
  webhookUrl: string;
}): Promise<PaymentProviderOwnershipClaim> {
  const providerIdentityFingerprint = await payOSProviderIdentityFingerprint(input.env, input.credentials);
  const existing = input.integration.status === "disconnected"
    ? null
    : input.integration.providerIdentityFingerprint ?? null;
  if (existing !== null && existing !== providerIdentityFingerprint) throw new AppError("credential_channel_mismatch", 409);
  const credentialFingerprint = await paymentCredentialFingerprint(input.env, input.shopId, input.credentials);
  const providerCredentialFingerprint = await paymentProviderCredentialFingerprint(input.env, input.credentials);
  const targetFingerprint = await paymentProviderWebhookTargetFingerprint(input.env, input.webhookUrl);
  const nonce = createId("pcl");
  const now = new Date().toISOString();
  try {
    const claimed = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        UPDATE payment_integrations
        SET provider_identity_fingerprint = ?,
          provider_claim_generation = provider_claim_generation + 1,
          provider_claim_nonce = ?,
          provider_claim_state = CASE
            WHEN provider_claim_state = 'quarantined' THEN 'quarantined'
            WHEN provider_claim_nonce IS NOT NULL
              AND NOT (
                provider_claim_state IN ('in_flight', 'ambiguous')
                AND active_credential_id = ?
                AND status = 'active'
                AND webhook_status = 'verified'
                AND EXISTS (
                  SELECT 1
                  FROM payment_credentials AS active_claim
                  WHERE active_claim.id = ?
                    AND active_claim.integration_id = payment_integrations.id
                    AND active_claim.shop_id = payment_integrations.shop_id
                    AND active_claim.provider = payment_integrations.provider
                    AND (active_claim.provider_claim_nonce = payment_integrations.provider_claim_nonce
                      OR active_claim.provider_claim_nonce IS NULL)
                    AND active_claim.status = 'active'
                )
              ) THEN 'quarantined'
            ELSE 'in_flight'
          END,
          provider_claim_target_fingerprint = ?,
          updated_at = ?
        WHERE id = ? AND shop_id = ? AND provider = 'payos'
          AND (
            provider_identity_fingerprint IS NULL
            OR provider_identity_fingerprint = ?
            OR (
              status = 'disconnected'
              AND active_credential_id IS NULL
              AND provider_claim_nonce IS NULL
              AND provider_claim_state = 'idle'
              AND provider_claim_target_fingerprint IS NULL
            )
          )
          AND (
            provider_claim_nonce IS NULL
            OR provider_claim_target_fingerprint = ?
            OR (
              provider_claim_state IN ('in_flight', 'ambiguous')
              AND active_credential_id = ?
              AND status = 'active'
              AND webhook_status = 'verified'
              AND EXISTS (
                SELECT 1
                FROM payment_credentials AS active_claim
                WHERE active_claim.id = ?
                  AND active_claim.integration_id = payment_integrations.id
                  AND active_claim.shop_id = payment_integrations.shop_id
                  AND active_claim.provider = payment_integrations.provider
                  AND (active_claim.provider_claim_nonce = payment_integrations.provider_claim_nonce
                    OR active_claim.provider_claim_nonce IS NULL)
                  AND active_claim.status = 'active'
              )
            )
            OR (
              provider_claim_state = 'quarantined'
              AND provider_claim_target_fingerprint IS NULL
              AND active_credential_id IS NULL
              AND status IN ('pending', 'error')
              AND EXISTS (
                SELECT 1
                FROM payment_credentials AS legacy_credential
                WHERE legacy_credential.id = ?
                  AND legacy_credential.integration_id = payment_integrations.id
                  AND legacy_credential.shop_id = payment_integrations.shop_id
                  AND legacy_credential.provider = payment_integrations.provider
                  AND legacy_credential.status IN ('pending', 'error')
                  AND legacy_credential.provider_claim_nonce = payment_integrations.provider_claim_nonce
                  AND legacy_credential.credential_fingerprint = ?
                  AND (
                    legacy_credential.provider_ownership_fingerprint = ?
                    OR legacy_credential.provider_ownership_fingerprint IS NULL
                  )
              )
            )
          )
      `).bind(providerIdentityFingerprint, nonce, input.credentialId, input.credentialId, targetFingerprint, now, input.integration.id, input.shopId, providerIdentityFingerprint, targetFingerprint, input.credentialId, input.credentialId, input.credentialId, credentialFingerprint, providerCredentialFingerprint),
      input.env.PLATFORM_DB.prepare(`
        UPDATE payment_credentials
        SET status = CASE
            WHEN activated_at IS NULL AND status = 'pending' THEN 'error'
            ELSE status
          END,
          provider_claim_nonce = NULL
        WHERE integration_id = ? AND shop_id = ? AND provider = 'payos'
          AND id != ? AND provider_claim_nonce IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM payment_integrations AS integration
            WHERE integration.id = ? AND integration.shop_id = ?
              AND integration.provider = 'payos'
              AND integration.provider_claim_nonce = ?
              AND integration.provider_claim_target_fingerprint = ?
          )
      `).bind(input.integration.id, input.shopId, input.credentialId, input.integration.id, input.shopId, nonce, targetFingerprint),
      input.env.PLATFORM_DB.prepare(`
        UPDATE payment_credentials
        SET provider_ownership_fingerprint = ?, provider_claim_nonce = ?
        WHERE id = ? AND integration_id = ? AND shop_id = ?
          AND provider = 'payos'
          AND status IN ('pending', 'error', 'active', 'grace')
          AND (provider_ownership_fingerprint IS NULL OR provider_ownership_fingerprint = ?)
          AND EXISTS (
            SELECT 1 FROM payment_integrations AS integration
            WHERE integration.id = ? AND integration.shop_id = ?
              AND integration.provider = 'payos'
              AND integration.provider_claim_nonce = ?
              AND integration.provider_claim_target_fingerprint = ?
          )
      `).bind(providerCredentialFingerprint, nonce, input.credentialId, input.integration.id, input.shopId, providerCredentialFingerprint, input.integration.id, input.shopId, nonce, targetFingerprint),
    ]);
    if ((claimed[0]?.meta.changes ?? 0) === 1 && (claimed[2]?.meta.changes ?? 0) === 1) {
      const row = await input.env.PLATFORM_DB.prepare(`
        SELECT provider_claim_generation AS generation
        FROM payment_integrations
        WHERE id = ? AND shop_id = ? AND provider = 'payos'
          AND provider_claim_nonce = ? AND provider_claim_target_fingerprint = ?
      `).bind(input.integration.id, input.shopId, nonce, targetFingerprint).first<{ generation: number }>();
      if (row !== null) {
        input.integration.providerIdentityFingerprint = providerIdentityFingerprint;
        return { generation: row.generation, nonce, targetFingerprint };
      }
    }
  } catch {
    throw await paymentProviderOwnershipConflict({
      credentialId: input.credentialId,
      env: input.env,
      providerCredentialFingerprint,
      providerIdentityFingerprint,
      shopId: input.shopId,
    });
  }
  throw await paymentProviderOwnershipConflict({
    credentialId: input.credentialId,
    env: input.env,
    providerCredentialFingerprint,
    providerIdentityFingerprint,
    shopId: input.shopId,
  });
}

async function markAmbiguousPaymentProviderOwnership(input: {
  claim: PaymentProviderOwnershipClaim;
  credentialId: string;
  degradeVerifiedIntegration?: boolean;
  env: AppBindings;
  integrationId: string;
  shopId: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_credentials
      SET status = CASE WHEN activated_at IS NULL THEN 'error' ELSE status END
      WHERE id = ? AND integration_id = ? AND shop_id = ? AND provider = 'payos'
        AND provider_claim_nonce = ?
    `).bind(input.credentialId, input.integrationId, input.shopId, input.claim.nonce),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_integrations
      SET status = CASE
          WHEN (? = 1 AND last_webhook_verified_at IS NOT NULL AND active_credential_id IS NOT NULL)
            OR (last_webhook_verified_at IS NULL AND active_credential_id IS NULL) THEN 'error'
          ELSE status
        END,
        webhook_status = CASE
          WHEN (? = 1 AND last_webhook_verified_at IS NOT NULL AND active_credential_id IS NOT NULL)
            OR (last_webhook_verified_at IS NULL AND active_credential_id IS NULL) THEN 'error'
          ELSE webhook_status
        END,
        provider_claim_state = CASE WHEN provider_claim_state = 'quarantined' THEN 'quarantined' ELSE 'ambiguous' END,
        last_safe_error_code = 'provider_verification_unknown',
        last_checked_at = ?, updated_at = ?
      WHERE id = ? AND shop_id = ? AND provider = 'payos'
        AND provider_claim_generation = ? AND provider_claim_nonce = ?
        AND provider_claim_target_fingerprint = ?
    `).bind(input.degradeVerifiedIntegration === true ? 1 : 0, input.degradeVerifiedIntegration === true ? 1 : 0, now, now, input.integrationId, input.shopId, input.claim.generation, input.claim.nonce, input.claim.targetFingerprint),
  ]);
  return (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1;
}

async function finalizeDefinitivePaymentProviderRejection(input: {
  claim: PaymentProviderOwnershipClaim;
  credentialId: string;
  degradeVerifiedIntegration?: boolean;
  env: AppBindings;
  integrationId: string;
  shopId: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        UPDATE payment_credentials
        SET status = CASE WHEN activated_at IS NULL THEN 'error' ELSE status END,
          provider_ownership_fingerprint = CASE
            WHEN activated_at IS NULL AND EXISTS (
              SELECT 1 FROM payment_integrations AS integration
              WHERE integration.id = ? AND integration.shop_id = ?
                AND integration.provider_claim_generation = ?
                AND integration.provider_claim_nonce = ?
                AND integration.provider_claim_state = 'in_flight'
            ) THEN NULL
            ELSE provider_ownership_fingerprint
          END,
          provider_claim_nonce = NULL
        WHERE id = ? AND integration_id = ? AND shop_id = ? AND provider = 'payos'
          AND provider_claim_nonce = ?
      `).bind(input.integrationId, input.shopId, input.claim.generation, input.claim.nonce, input.credentialId, input.integrationId, input.shopId, input.claim.nonce),
      input.env.PLATFORM_DB.prepare(`
        UPDATE payment_integrations
        SET status = CASE
            WHEN (? = 1 AND last_webhook_verified_at IS NOT NULL AND active_credential_id IS NOT NULL)
              OR (last_webhook_verified_at IS NULL AND active_credential_id IS NULL) THEN 'error'
            ELSE status
          END,
          webhook_status = CASE
            WHEN (? = 1 AND last_webhook_verified_at IS NOT NULL AND active_credential_id IS NOT NULL)
              OR (last_webhook_verified_at IS NULL AND active_credential_id IS NULL) THEN 'error'
            ELSE webhook_status
          END,
          provider_identity_fingerprint = CASE
            WHEN provider_claim_state = 'in_flight' AND last_webhook_verified_at IS NULL
              THEN NULL
            ELSE provider_identity_fingerprint
          END,
          provider_claim_nonce = NULL,
          provider_claim_state = CASE
            WHEN provider_claim_state = 'in_flight' THEN 'idle'
            ELSE 'quarantined'
          END,
          provider_claim_target_fingerprint = CASE
            WHEN provider_claim_state = 'in_flight' THEN NULL
            ELSE provider_claim_target_fingerprint
          END,
          last_safe_error_code = 'provider_verification_failed',
          last_checked_at = ?, updated_at = ?
        WHERE id = ? AND shop_id = ? AND provider = 'payos'
          AND provider_claim_generation = ? AND provider_claim_nonce = ?
          AND provider_claim_target_fingerprint = ?
      `).bind(input.degradeVerifiedIntegration === true ? 1 : 0, input.degradeVerifiedIntegration === true ? 1 : 0, now, now, input.integrationId, input.shopId, input.claim.generation, input.claim.nonce, input.claim.targetFingerprint),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1 && (results[1]?.meta.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

async function findRetryablePaymentCredential(env: AppBindings, integrationId: string, shopId: string): Promise<RetryablePaymentCredential | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT
      id AS credentialId,
      integration_id AS integrationId,
      shop_id AS shopId,
      status,
      version,
      activated_at AS activatedAt,
      key_version AS keyVersion,
      client_id_ciphertext_b64 AS clientIdCiphertextB64,
      client_id_iv_b64 AS clientIdIvB64,
      api_key_ciphertext_b64 AS apiKeyCiphertextB64,
      api_key_iv_b64 AS apiKeyIvB64,
      checksum_key_ciphertext_b64 AS checksumKeyCiphertextB64,
      checksum_key_iv_b64 AS checksumKeyIvB64,
      credential_fingerprint AS fingerprint,
      provider_claim_nonce AS providerClaimNonce,
      provider_ownership_fingerprint AS providerOwnershipFingerprint
    FROM payment_credentials
    WHERE integration_id = ? AND shop_id = ? AND provider = 'payos'
      AND status IN ('pending', 'error')
    ORDER BY version DESC
    LIMIT 1
  `).bind(integrationId, shopId).first<RetryablePaymentCredential>();
}

function resumePaymentCredential(input: {
  env: AppBindings;
  integration: IntegrationRow;
  row: PaymentCredentialState;
  shopId: string;
}): PreparedPaymentCredential {
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
  }
  if (input.row.status === "active" && input.integration.activeCredentialId !== input.row.credentialId) throw new AppError("credential_duplicate", 409);
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
      input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = CASE WHEN last_webhook_verified_at IS NULL THEN 'pending' ELSE status END, webhook_status = CASE WHEN last_webhook_verified_at IS NULL THEN 'pending' ELSE webhook_status END, last_safe_error_code = NULL, updated_at = ? WHERE id = ? AND shop_id = ?").bind(now, input.integration.id, input.shopId),
    ]);
    return { activatedAt: null, alreadyActive: false, credentialId, graceEndsAt: null, providerClaimNonce: null, providerOwnershipFingerprint: null, status: "pending", version };
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

async function activatePaymentProviderOwnership(input: {
  claim: PaymentProviderOwnershipClaim;
  credentialId: string;
  credentialVersion: number;
  env: AppBindings;
  integration: IntegrationRow;
  requestId: string;
  rotated: boolean;
  shopId: string;
  userId: string;
}): Promise<void> {
  const activatedAt = new Date().toISOString();
  const graceEndsAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_credentials
      SET status = 'revoked', revoked_at = ?, provider_ownership_fingerprint = NULL,
        provider_claim_nonce = NULL
      WHERE integration_id = ? AND shop_id = ? AND provider = 'payos'
        AND id != ? AND activated_at IS NULL AND status IN ('pending', 'error')
        AND EXISTS (
          SELECT 1 FROM payment_integrations AS integration
          WHERE integration.id = ? AND integration.shop_id = ?
            AND integration.provider_claim_generation = ?
            AND integration.provider_claim_nonce = ?
            AND integration.provider_claim_target_fingerprint = ?
        )
    `).bind(activatedAt, input.integration.id, input.shopId, input.credentialId, input.integration.id, input.shopId, input.claim.generation, input.claim.nonce, input.claim.targetFingerprint),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_credentials
      SET status = 'grace', grace_ends_at = ?
      WHERE integration_id = ? AND shop_id = ? AND status = 'active' AND id != ?
        AND EXISTS (
          SELECT 1 FROM payment_integrations AS integration
          WHERE integration.id = ? AND integration.shop_id = ?
            AND integration.provider_claim_generation = ?
            AND integration.provider_claim_nonce = ?
            AND integration.provider_claim_target_fingerprint = ?
        )
    `).bind(graceEndsAt, input.integration.id, input.shopId, input.credentialId, input.integration.id, input.shopId, input.claim.generation, input.claim.nonce, input.claim.targetFingerprint),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_credentials
      SET status = 'active', activated_at = COALESCE(activated_at, ?),
        grace_ends_at = NULL, provider_claim_nonce = NULL
      WHERE id = ? AND integration_id = ? AND shop_id = ? AND provider = 'payos'
        AND status IN ('pending', 'error', 'grace', 'active')
        AND provider_ownership_fingerprint IS NOT NULL
        AND provider_claim_nonce = ?
        AND EXISTS (
          SELECT 1 FROM payment_integrations AS integration
          WHERE integration.id = ? AND integration.shop_id = ?
            AND integration.provider_claim_generation = ?
            AND integration.provider_claim_nonce = ?
            AND integration.provider_claim_target_fingerprint = ?
        )
    `).bind(activatedAt, input.credentialId, input.integration.id, input.shopId, input.claim.nonce, input.integration.id, input.shopId, input.claim.generation, input.claim.nonce, input.claim.targetFingerprint),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_integrations
      SET status = 'active', webhook_status = 'verified', active_credential_id = ?,
        connected_at = COALESCE(connected_at, ?), last_safe_error_code = NULL,
        last_checked_at = ?, last_webhook_verified_at = ?, updated_at = ?,
        provider_claim_nonce = NULL, provider_claim_state = 'idle',
        provider_claim_target_fingerprint = NULL
      WHERE id = ? AND shop_id = ? AND provider = 'payos'
        AND provider_identity_fingerprint IS NOT NULL
        AND provider_claim_generation = ? AND provider_claim_nonce = ?
        AND provider_claim_target_fingerprint = ?
        AND EXISTS (
          SELECT 1 FROM payment_credentials AS credential
          WHERE credential.id = ? AND credential.integration_id = ?
            AND credential.shop_id = ? AND credential.provider = 'payos'
            AND credential.status = 'active'
            AND credential.provider_ownership_fingerprint IS NOT NULL
            AND credential.provider_claim_nonce IS NULL
        )
    `).bind(input.credentialId, activatedAt, activatedAt, activatedAt, activatedAt, input.integration.id, input.shopId, input.claim.generation, input.claim.nonce, input.claim.targetFingerprint, input.credentialId, input.integration.id, input.shopId),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type, resource_id,
        safe_metadata_json, request_id, created_at
      )
      SELECT ?, ?, 'user', ?, 'payos.credentials_connected',
        'payment_integration', ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM payment_integrations AS integration
        INNER JOIN payment_credentials AS credential
          ON credential.id = integration.active_credential_id
          AND credential.integration_id = integration.id
          AND credential.shop_id = integration.shop_id
        WHERE integration.id = ? AND integration.shop_id = ?
          AND integration.status = 'active' AND integration.webhook_status = 'verified'
          AND integration.provider_claim_nonce IS NULL
          AND integration.provider_claim_generation = ?
          AND integration.last_webhook_verified_at = ? AND integration.updated_at = ?
          AND credential.id = ? AND credential.status = 'active'
          AND credential.provider_ownership_fingerprint IS NOT NULL
      )
    `).bind(createId("aud"), input.shopId, input.userId, input.integration.id, JSON.stringify({ credentialVersion: input.credentialVersion, rotated: input.rotated }), input.requestId, activatedAt, input.integration.id, input.shopId, input.claim.generation, activatedAt, activatedAt, input.credentialId),
  ]);
  if ((results[2]?.meta.changes ?? 0) !== 1 || (results[3]?.meta.changes ?? 0) !== 1) {
    throw new AppError("payment_integration_conflict", 409);
  }
}

export async function getPaymentIntegration(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<PaymentIntegrationView | null> {
  const shopId = await requirePaymentReader(input.env, input.shopPublicId, input.userId);
  const row = await findIntegration(input.env, shopId);
  return row === null ? null : mapIntegration(row);
}

export async function connectPayOS(input: { credentials: PayOSCredentials; env: AppBindings; fetcher?: typeof fetch; requestId: string; shopPublicId: string; userId: string }): Promise<PaymentIntegrationView> {
  const shopId = await requirePaymentManager(input.env, input.shopPublicId, input.userId);
  await assertPayOSProviderSetupAllowed(input.env, shopId);
  let integration = await findIntegration(input.env, shopId);
  await assertPayOSChannelAdmitted(input.env, input.credentials);
  await assertPaymentProviderIdentityOwnership(input.env, shopId, input.credentials, integration);
  const now = new Date();
  const nowIso = now.toISOString();
  if (integration === null) {
    const id = createId("pin");
    const publicId = createId("payint");
    const webhookPublicId = createId("paywh");
    await input.env.PLATFORM_DB.prepare(`INSERT INTO payment_integrations (id, public_id, webhook_public_id, shop_id, provider, status, webhook_status, created_at, updated_at) VALUES (?, ?, ?, ?, 'payos', 'pending', 'pending', ?, ?)`).bind(id, publicId, webhookPublicId, shopId, nowIso, nowIso).run();
    integration = { activeCredentialId: null, connectedAt: null, id, lastCheckedAt: null, lastSafeErrorCode: null, lastWebhookVerifiedAt: null, providerClaimGeneration: 0, providerClaimNonce: null, providerClaimState: "idle", providerClaimTargetFingerprint: null, providerIdentityFingerprint: null, publicId, status: "pending", webhookPublicId, webhookStatus: "pending" };
  }
  const credential = await preparePaymentCredential({ credentials: input.credentials, env: input.env, integration, shopId, userId: input.userId });
  if (credential.alreadyActive) {
    await tryRecordActivationMilestone({
      env: input.env,
      idempotencyKey: "payos_connected",
      milestone: "payos_connected",
      reason: "connected",
      shopId,
      source: "payment",
    });
    return mapIntegration(integration);
  }
  const webhookUrl = `${input.env.API_ORIGIN}/webhooks/payos/${integration.webhookPublicId}`;
  const claim = await claimPaymentProviderOwnership({
    credentialId: credential.credentialId,
    credentials: input.credentials,
    env: input.env,
    integration,
    shopId,
    webhookUrl,
  });
  try {
    await new PayOSClient(input.credentials, input.fetcher).confirmWebhook(webhookUrl);
  } catch (error) {
    const definitiveRejection = isDefinitivePayOSWebhookRejection(error);
    if (definitiveRejection) {
      await finalizeDefinitivePaymentProviderRejection({ claim, credentialId: credential.credentialId, env: input.env, integrationId: integration.id, shopId });
    } else {
      await markAmbiguousPaymentProviderOwnership({ claim, credentialId: credential.credentialId, env: input.env, integrationId: integration.id, shopId });
    }
    throw new AppError("provider_verification_failed", definitiveRejection ? 409 : 503);
  }
  const rotated = integration.activeCredentialId !== null && integration.activeCredentialId !== credential.credentialId;
  await activatePaymentProviderOwnership({ claim, credentialId: credential.credentialId, credentialVersion: credential.version, env: input.env, integration, requestId: input.requestId, rotated, shopId, userId: input.userId });
  const active = await findIntegration(input.env, shopId);
  if (active === null) throw new AppError("internal_error", 500);
  await tryRecordActivationMilestone({
    env: input.env,
    idempotencyKey: "payos_connected",
    milestone: "payos_connected",
    reason: "connected",
    shopId,
    source: "payment",
  });
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
  await assertPayOSProviderSetupAllowed(input.env, input.shopId);
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
  await assertPayOSChannelAdmitted(input.env, credentials);
  await assertPaymentProviderIdentityOwnership(input.env, input.shopId, credentials, input.integration);
  const webhookUrl = `${input.env.API_ORIGIN}/webhooks/payos/${input.integration.webhookPublicId}`;
  let claim: PaymentProviderOwnershipClaim;
  try {
    claim = await claimPaymentProviderOwnership({
      credentialId: row.credentialId,
      credentials,
      env: input.env,
      integration: input.integration,
      shopId: input.shopId,
      webhookUrl,
    });
  } catch {
    return;
  }
  try {
    await new PayOSClient(credentials, input.fetcher).confirmWebhook(webhookUrl);
  } catch (error) {
    if (isDefinitivePayOSWebhookRejection(error)) {
      await finalizeDefinitivePaymentProviderRejection({ claim, credentialId: row.credentialId, env: input.env, integrationId: input.integration.id, shopId: input.shopId });
    } else {
      await markAmbiguousPaymentProviderOwnership({ claim, credentialId: row.credentialId, env: input.env, integrationId: input.integration.id, shopId: input.shopId });
    }
    return;
  }
  await activatePaymentProviderOwnership({ claim, credentialId: row.credentialId, credentialVersion: row.version, env: input.env, integration: input.integration, requestId: input.requestId, rotated: false, shopId: input.shopId, userId: input.userId });
  await tryRecordActivationMilestone({
    env: input.env,
    idempotencyKey: "payos_connected",
    milestone: "payos_connected",
    reason: "connected",
    shopId: input.shopId,
    source: "payment",
  });
}

async function verifyActivePaymentProviderOwnership(input: {
  claim: PaymentProviderOwnershipClaim;
  credentialId: string;
  env: AppBindings;
  integrationId: string;
  shopId: string;
}): Promise<void> {
  const verifiedAt = new Date().toISOString();
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_credentials
      SET provider_claim_nonce = NULL
      WHERE id = ? AND integration_id = ? AND shop_id = ? AND provider = 'payos'
        AND status = 'active' AND provider_ownership_fingerprint IS NOT NULL
        AND provider_claim_nonce = ?
    `).bind(input.credentialId, input.integrationId, input.shopId, input.claim.nonce),
    input.env.PLATFORM_DB.prepare(`
      UPDATE payment_integrations
      SET status = 'active', webhook_status = 'verified', last_safe_error_code = NULL,
        last_checked_at = ?, last_webhook_verified_at = ?, updated_at = ?,
        provider_claim_nonce = NULL, provider_claim_state = 'idle',
        provider_claim_target_fingerprint = NULL
      WHERE id = ? AND shop_id = ? AND provider = 'payos'
        AND active_credential_id = ? AND provider_identity_fingerprint IS NOT NULL
        AND provider_claim_generation = ? AND provider_claim_nonce = ?
        AND provider_claim_target_fingerprint = ?
        AND EXISTS (
          SELECT 1 FROM payment_credentials AS credential
          WHERE credential.id = ? AND credential.integration_id = ?
            AND credential.shop_id = ? AND credential.status = 'active'
            AND credential.provider_ownership_fingerprint IS NOT NULL
            AND credential.provider_claim_nonce IS NULL
        )
    `).bind(verifiedAt, verifiedAt, verifiedAt, input.integrationId, input.shopId, input.credentialId, input.claim.generation, input.claim.nonce, input.claim.targetFingerprint, input.credentialId, input.integrationId, input.shopId),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    throw new AppError("payment_integration_conflict", 409);
  }
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
  await assertPayOSProviderSetupAllowed(input.env, shopId);
  const credential = await loadCredentialById(input.env, integration.activeCredentialId, shopId);
  const webhookUrl = `${input.env.API_ORIGIN}/webhooks/payos/${integration.webhookPublicId}`;
  const claim = await claimPaymentProviderOwnership({
    credentialId: credential.row.credentialId,
    credentials: credential.credentials,
    env: input.env,
    integration,
    shopId,
    webhookUrl,
  });
  let providerFailure = false;
  try {
    await new PayOSClient(credential.credentials, input.fetcher).confirmWebhook(webhookUrl);
  } catch (error) {
    const persisted = isDefinitivePayOSWebhookRejection(error)
      ? await finalizeDefinitivePaymentProviderRejection({ claim, credentialId: credential.row.credentialId, degradeVerifiedIntegration: true, env: input.env, integrationId: integration.id, shopId })
      : await markAmbiguousPaymentProviderOwnership({ claim, credentialId: credential.row.credentialId, degradeVerifiedIntegration: true, env: input.env, integrationId: integration.id, shopId });
    if (!persisted) throw new AppError("payment_integration_conflict", 409);
    providerFailure = true;
  }
  if (!providerFailure) {
    await verifyActivePaymentProviderOwnership({ claim, credentialId: credential.row.credentialId, env: input.env, integrationId: integration.id, shopId });
  }
  const refreshed = await findIntegration(input.env, shopId);
  if (refreshed === null) throw new AppError("internal_error", 500);
  if (refreshed.status === "active" && refreshed.webhookStatus === "verified") {
    await tryRecordActivationMilestone({
      env: input.env,
      idempotencyKey: "payos_connected",
      milestone: "payos_connected",
      reason: "connected",
      shopId,
      source: "payment",
    });
  }
  return mapIntegration(refreshed);
}

export async function disconnectPayOS(input: { env: AppBindings; requestId: string; shopPublicId: string; userId: string }): Promise<void> {
  const shopId = await requirePaymentManager(input.env, input.shopPublicId, input.userId);
  const integration = await findIntegration(input.env, shopId);
  if (integration === null) throw new AppError("payment_not_configured", 409);
  if (integration.status === "disconnected"
    && integration.webhookStatus === "disconnected"
    && integration.activeCredentialId === null
    && integration.providerClaimNonce === null
    && integration.providerClaimState === "idle"
    && integration.providerClaimTargetFingerprint === null) {
    return;
  }
  const now = new Date().toISOString();
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare("UPDATE payment_integrations SET status = 'disconnected', webhook_status = 'disconnected', active_credential_id = NULL, provider_claim_generation = provider_claim_generation + 1, provider_claim_nonce = NULL, provider_claim_state = 'idle', provider_claim_target_fingerprint = NULL, updated_at = ? WHERE id = ? AND shop_id = ?").bind(now, integration.id, shopId),
    input.env.PLATFORM_DB.prepare("UPDATE payment_provider_connections SET provider_account_fingerprint = NULL, provider_account_verified_at = NULL, updated_at = ?, version = version + 1 WHERE id = ? AND shop_id = ? AND legacy_payos_integration_id = ? AND status = 'disconnected' AND webhook_status = 'disconnected'").bind(now, integration.id, shopId, integration.id),
    input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'grace', grace_ends_at = ?, provider_claim_nonce = NULL WHERE integration_id = ? AND shop_id = ? AND status = 'active'").bind(new Date(Date.now() + 24 * 60 * 60_000).toISOString(), integration.id, shopId),
    input.env.PLATFORM_DB.prepare("UPDATE payment_credentials SET status = 'revoked', revoked_at = ?, provider_claim_nonce = NULL WHERE integration_id = ? AND shop_id = ? AND status IN ('pending', 'error')").bind(now, integration.id, shopId),
    input.env.PLATFORM_DB.prepare(`INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) VALUES (?, ?, 'user', ?, 'payos.disconnected', 'payment_integration', ?, '{}', ?, ?)`).bind(createId("aud"), shopId, input.userId, integration.id, input.requestId, now),
  ]);
}
