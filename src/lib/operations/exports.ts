import { constantTimeEqual, hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId, createOpaqueToken, toBase64Url } from "../core/ids";
import { decryptInventoryKey } from "../crypto/inventory";
import { resolveActiveEncryptionKey, resolveEncryptionKey } from "../crypto/keyring";
import type { AppBindings } from "../platform/bindings";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const STANDARD_EXPORT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const HIGH_RISK_EXPORT_RETENTION_MS = 60 * 60_000;
const DOWNLOAD_TOKEN_TTL_MS = 10 * 60_000;
const DEFAULT_EXPORT_PURGE_LIMIT = 100;
const MAX_EXPORT_PURGE_LIMIT = 500;

export const DATA_EXPORT_KINDS = ["standard", "inventory_keys_plaintext"] as const;
export type DataExportKind = typeof DATA_EXPORT_KINDS[number];

type ExportBindings = AppBindings & {
  PRIVATE_EXPORTS: R2Bucket;
};

type OwnerShop = {
  publicId: string;
  role: string;
  shopId: string;
  slug: string;
  status: string;
};

type ExportJobRow = {
  ciphertextSha256: string | null;
  completedAt: string | null;
  createdAt: string;
  downloadTokenConsumedAt: string | null;
  downloadTokenExpiresAt: string | null;
  downloadTokenHash: string | null;
  encryptionIvB64: string | null;
  encryptionKeyVersion: string;
  id: string;
  includesPlaintextKeys: number;
  kind: DataExportKind;
  lastSafeErrorCode: string | null;
  objectDeletedAt: string | null;
  objectKey: string;
  retainUntil: string;
  shopId: string;
  status: string;
  updatedAt: string;
};

export type DataExportView = {
  completedAt: string | null;
  createdAt: string;
  downloadExpiresAt: string | null;
  downloadedAt: string | null;
  id: string;
  includesPlaintextKeys: boolean;
  kind: DataExportKind;
  lastSafeErrorCode: string | null;
  retainUntil: string;
  status: string;
  updatedAt: string;
};

export type CreateDataExportResult = {
  downloadToken: string;
  export: DataExportView;
};

type ExportRuntime = {
  now?: Date;
};

type ExpiredExportObjectRow = {
  id: string;
  objectKey: string;
  shopId: string;
};

export type DataExportPurgeResult = {
  candidates: number;
  deleted: number;
  failed: number;
  invalidObjectKeys: number;
};

const EXPORT_JOB_SELECT = `
  SELECT id, shop_id AS shopId, kind, status, object_key AS objectKey,
    ciphertext_sha256 AS ciphertextSha256,
    encryption_key_version AS encryptionKeyVersion,
    encryption_iv_b64 AS encryptionIvB64,
    download_token_hash AS downloadTokenHash,
    download_token_expires_at AS downloadTokenExpiresAt,
    download_token_consumed_at AS downloadTokenConsumedAt,
    includes_plaintext_keys AS includesPlaintextKeys,
    retain_until AS retainUntil, object_deleted_at AS objectDeletedAt,
    last_safe_error_code AS lastSafeErrorCode, completed_at AS completedAt,
    created_at AS createdAt, updated_at AS updatedAt
  FROM data_export_jobs
`;

export function exportBindings(env: AppBindings): ExportBindings {
  const bindings = env as Partial<ExportBindings>;
  if (bindings.PRIVATE_EXPORTS === undefined) {
    throw new AppError("export_configuration_invalid", 500);
  }
  return bindings as ExportBindings;
}

export function dataExportObjectKey(exportId: string): string {
  return `exports/${exportId}.bin`;
}

function boundedExportPurgeLimit(limit: number): number {
  return Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, MAX_EXPORT_PURGE_LIMIT)
    : DEFAULT_EXPORT_PURGE_LIMIT;
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new AppError("export_decryption_failed", 500);
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return new Uint8Array(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    throw new AppError("export_decryption_failed", 500);
  }
}

async function importExportKey(kek: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const bytes = fromBase64Url(kek);
  if (bytes.byteLength !== 32) throw new AppError("export_configuration_invalid", 500);
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usage);
}

function exportAad(input: {
  exportId: string;
  keyVersion: string;
  kind: DataExportKind;
  shopId: string;
}): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(
    `data-export\0${input.keyVersion}\0${input.shopId}\0${input.exportId}\0${input.kind}`,
  ));
}

async function sha256Bytes(value: Uint8Array<ArrayBuffer>): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

export async function encryptDataExportPayload(input: {
  exportId: string;
  keyVersion: string;
  kek: string;
  kind: DataExportKind;
  plaintext: Uint8Array<ArrayBuffer>;
  shopId: string;
}): Promise<{ ciphertext: Uint8Array<ArrayBuffer>; ivB64: string; sha256: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({
    additionalData: exportAad(input),
    iv,
    name: "AES-GCM",
    tagLength: 128,
  }, await importExportKey(input.kek, ["encrypt"]), input.plaintext);
  const ciphertext = new Uint8Array(encrypted);
  return { ciphertext, ivB64: toBase64Url(iv), sha256: await sha256Bytes(ciphertext) };
}

export async function decryptDataExportPayload(input: {
  ciphertext: Uint8Array<ArrayBuffer>;
  exportId: string;
  ivB64: string;
  keyVersion: string;
  kek: string;
  kind: DataExportKind;
  shopId: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const plaintext = await crypto.subtle.decrypt({
      additionalData: exportAad(input),
      iv: fromBase64Url(input.ivB64),
      name: "AES-GCM",
      tagLength: 128,
    }, await importExportKey(input.kek, ["decrypt"]), input.ciphertext);
    return new Uint8Array(plaintext);
  } catch (error) {
    if (error instanceof AppError && error.code === "export_configuration_invalid") throw error;
    throw new AppError("export_decryption_failed", 500);
  }
}

export function parseDataExportRequest(value: Record<string, unknown>): DataExportKind {
  const kind = value.kind;
  if (!DATA_EXPORT_KINDS.includes(kind as DataExportKind)) {
    throw new AppError("validation_failed", 400, ["export_kind_invalid"]);
  }
  if (kind === "inventory_keys_plaintext" && value.acknowledgePlaintextRisk !== true) {
    throw new AppError("validation_failed", 400, ["plaintext_key_export_acknowledgement_required"]);
  }
  if (kind === "standard" && value.acknowledgePlaintextRisk !== undefined) {
    throw new AppError("validation_failed", 400, ["plaintext_key_export_acknowledgement_unexpected"]);
  }
  return kind as DataExportKind;
}

export function parseDownloadToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 32 || value.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new AppError("export_download_not_found", 404);
  }
  return value;
}

async function requireOwnerShop(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<OwnerShop> {
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT shops.id AS shopId, shops.public_id AS publicId, shops.slug,
      shops.status, shop_members.role
    FROM shops
    INNER JOIN shop_members
      ON shop_members.shop_id = shops.id
      AND shop_members.user_id = ?
      AND shop_members.status = 'active'
    WHERE shops.public_id = ?
    LIMIT 1
  `).bind(input.userId, input.shopPublicId).first<OwnerShop>();
  if (row === null || row.role !== "owner") throw new AppError("authorization_denied", 403);
  return row;
}

function mapJob(row: ExportJobRow): DataExportView {
  return {
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    downloadExpiresAt: row.downloadTokenExpiresAt,
    downloadedAt: row.downloadTokenConsumedAt,
    id: row.id,
    includesPlaintextKeys: row.includesPlaintextKeys === 1,
    kind: row.kind,
    lastSafeErrorCode: row.lastSafeErrorCode,
    retainUntil: row.retainUntil,
    status: row.status,
    updatedAt: row.updatedAt,
  };
}

async function queryRows<T>(env: AppBindings, sql: string, shopId: string): Promise<T[]> {
  return (await env.PLATFORM_DB.prepare(sql).bind(shopId).all<T>()).results;
}

export async function buildStandardExportPayload(input: {
  env: AppBindings;
  exportedAt: string;
  shop: OwnerShop;
}): Promise<Record<string, unknown>> {
  const shopId = input.shop.shopId;
  const [
    shop,
    members,
    apiCredentials,
    categories,
    products,
    variants,
    inventoryBatches,
    inventoryKeys,
    customers,
    orders,
    orderItems,
    paymentIntegrations,
    paymentAttempts,
    paymentEvents,
    paymentExceptions,
    paymentReversalEvents,
    paymentProviderConnections,
    paymentProviderConnectionCapabilities,
    paymentProviderConnectionCurrencies,
    paymentProviderConnectionMethods,
    fulfillments,
    fulfillmentItems,
    manualFulfillmentExecutions,
    externalFulfillmentReferences,
    digitalAssets,
    digitalAssetVersions,
    fulfillmentPolicies,
    fulfillmentRequirements,
    digitalEntitlements,
    deliveryGrants,
    deliveryGrantConsumptions,
    entitlementResources,
    entitlementPolicies,
    entitlementRequirements,
    genericEntitlements,
    entitlementGrants,
    entitlementTransitions,
    generatedLicenseProviderConnections,
    generatedLicenseProviderCredentials,
    generatedLicenseResourceBindings,
    generatedLicenseRequirementSnapshots,
    generatedLicenseRequests,
    generatedLicenseAttempts,
    generatedLicenseArtifacts,
    generatedLicenseDeadLetters,
    telegramIntegrations,
    customerIdentities,
    telegramRecipients,
    telegramUpdates,
    telegramActions,
    domains,
    auditLogs,
  ] = await Promise.all([
    input.env.PLATFORM_DB.prepare(`
      SELECT shops.public_id AS publicId, shops.slug, shops.name, shops.status,
        shops.default_locale AS defaultLocale, shops.currency, shops.timezone,
        shops.created_at AS createdAt, shops.updated_at AS updatedAt,
        shop_settings.branding_json AS brandingJson,
        shop_settings.storefront_json AS storefrontJson,
        shop_settings.support_contact AS supportContact,
        shop_settings.terms_url AS termsUrl,
        shop_settings.privacy_url AS privacyUrl,
        shop_settings.refund_policy_url AS refundPolicyUrl,
        (SELECT state FROM shop_subscriptions WHERE shop_id = shops.id ORDER BY created_at DESC LIMIT 1) AS subscriptionState
      FROM shops
      INNER JOIN shop_settings ON shop_settings.shop_id = shops.id
      WHERE shops.id = ?
      LIMIT 1
    `).bind(shopId).first(),
    queryRows(input.env, `SELECT shop_members.user_id AS userId, platform_users.email_normalized AS email,
      platform_users.display_name AS displayName, shop_members.role, shop_members.status,
      shop_members.created_at AS createdAt, shop_members.updated_at AS updatedAt
      FROM shop_members INNER JOIN platform_users ON platform_users.id = shop_members.user_id
      WHERE shop_members.shop_id = ? ORDER BY shop_members.created_at, shop_members.user_id`, shopId),
    queryRows<{
      createdAt: string;
      expiresAt: string | null;
      lastUsedAt: string | null;
      name: string;
      publicId: string;
      revokedAt: string | null;
      scopeJson: string;
      status: string;
      updatedAt: string;
      version: number;
    }>(input.env, `SELECT public_id AS publicId, name, scope_json AS scopeJson,
      status, expires_at AS expiresAt, last_used_at AS lastUsedAt,
      revoked_at AS revokedAt, version, created_at AS createdAt,
      updated_at AS updatedAt
      FROM api_credentials WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, slug, name, description, sort_order AS sortOrder, status,
      created_at AS createdAt, updated_at AS updatedAt FROM product_categories
      WHERE shop_id = ? ORDER BY sort_order, id`, shopId),
    queryRows(input.env, `SELECT id, category_id AS categoryId, slug, title, description, status,
      fulfillment_type AS fulfillmentType, version, created_at AS createdAt, updated_at AS updatedAt
      FROM products WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, product_id AS productId, sku, title, options_json AS optionsJson,
      price_minor AS priceMinor, compare_at_minor AS compareAtMinor, currency,
      min_per_order AS minPerOrder, max_per_order AS maxPerOrder, status, version,
      created_at AS createdAt, updated_at AS updatedAt
      FROM product_variants WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, variant_id AS variantId, source,
      filename_sanitized AS filename, total_count AS totalCount,
      accepted_count AS acceptedCount, rejected_count AS rejectedCount,
      created_by_user_id AS createdByUserId, created_at AS createdAt
      FROM inventory_batches WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, variant_id AS variantId, batch_id AS batchId, status,
      reserved_order_item_id AS reservedOrderItemId, reserved_until AS reservedUntil,
      sold_order_item_id AS soldOrderItemId, sold_at AS soldAt, revoked_at AS revokedAt,
      created_at AS createdAt
      FROM inventory_keys WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, email_normalized AS email, display_name AS displayName,
      locale, preferred_locale AS preferredLocale, status,
      created_at AS createdAt, updated_at AS updatedAt
      FROM shop_customers WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT public_id AS publicId, customer_id AS customerId,
      order_number AS orderNumber, source_channel AS sourceChannel, status,
      payment_status AS paymentStatus, fulfillment_status AS fulfillmentStatus,
      subtotal_minor AS subtotalMinor, discount_minor AS discountMinor,
      total_minor AS totalMinor, currency, locale, customer_email_masked AS customerEmailMasked,
      expires_at AS expiresAt, paid_at AS paidAt, fulfilled_at AS fulfilledAt,
      created_at AS createdAt, updated_at AS updatedAt
      FROM orders WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, order_id AS orderId, product_id AS productId,
      variant_id AS variantId, product_title AS productTitle, variant_title AS variantTitle,
      sku, unit_price_minor AS unitPriceMinor, quantity, line_total_minor AS lineTotalMinor,
      fulfillment_type AS fulfillmentType, created_at AS createdAt
      FROM order_items WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT public_id AS publicId, provider, status, webhook_status AS webhookStatus,
      account_bin AS accountBin, account_number_masked AS accountNumberMasked,
      account_name_sanitized AS accountName, last_safe_error_code AS lastSafeErrorCode,
      connected_at AS connectedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM payment_integrations WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT public_id AS publicId, order_id AS orderId, provider,
      provider_order_code AS providerOrderCode, provider_payment_link_id AS providerPaymentLinkId,
      provider_status AS providerStatus, state, expected_amount_minor AS expectedAmountMinor,
      currency, account_bin AS accountBin, account_number_masked AS accountNumberMasked,
      account_name_sanitized AS accountName, expires_at AS expiresAt,
      last_reconciled_at AS lastReconciledAt, reconcile_attempts AS reconcileAttempts,
      last_safe_error_code AS lastSafeErrorCode, created_at AS createdAt, updated_at AS updatedAt
      FROM payment_attempts WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT provider, provider_event_reference AS providerEventReference,
      payload_hash AS payloadHash, signature_verified AS signatureVerified,
      normalized_state AS normalizedState, process_result AS processResult,
      received_at AS receivedAt, processed_at AS processedAt
      FROM payment_events WHERE shop_id = ? ORDER BY received_at, id`, shopId),
    queryRows(input.env, `SELECT type, status, safe_evidence_json AS safeEvidenceJson,
      resolution_reason AS resolutionReason, resolved_at AS resolvedAt, created_at AS createdAt
      FROM payment_exceptions WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT reversals.id,
      orders.public_id AS orderPublicId,
      attempts.public_id AS paymentAttemptPublicId,
      reversals.provider, reversals.reversal_kind AS reversalKind,
      reversals.decision, reversals.verification_method AS verificationMethod,
      reversals.amount_minor AS amountMinor,
      reversals.expected_amount_minor AS expectedAmountMinor,
      reversals.currency, reversals.expected_currency AS expectedCurrency,
      reversals.reason_code AS reasonCode,
      reversals.occurred_at AS occurredAt, reversals.created_at AS createdAt
      FROM payment_reversal_events AS reversals
      INNER JOIN orders
        ON orders.id = reversals.order_id AND orders.shop_id = reversals.shop_id
      INNER JOIN payment_attempts AS attempts
        ON attempts.id = reversals.payment_attempt_id
        AND attempts.shop_id = reversals.shop_id
      WHERE reversals.shop_id = ? ORDER BY reversals.created_at, reversals.id`, shopId),
    queryRows(input.env, `SELECT public_id AS publicId, provider_code AS providerCode,
      provider_environment AS providerEnvironment,
      provider_descriptor_version AS providerDescriptorVersion,
      capability_policy_version AS capabilityPolicyVersion,
      connection_mode AS connectionMode, settlement_mode AS settlementMode,
      credential_ownership AS credentialOwnership,
      merchant_country_code AS merchantCountryCode,
      provider_attested_country_code AS providerAttestedCountryCode,
      provider_country_attested_at AS providerCountryAttestedAt,
      status,
      webhook_status AS webhookStatus, last_safe_error_code AS lastSafeErrorCode,
      last_checked_at AS lastCheckedAt,
      last_webhook_verified_at AS lastWebhookVerifiedAt,
      provider_account_verified_at AS providerAccountVerifiedAt,
      connected_at AS connectedAt, disconnected_at AS disconnectedAt,
      version, created_at AS createdAt, updated_at AS updatedAt
      FROM payment_provider_connections
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT connections.public_id AS connectionPublicId,
      capabilities.capability_code AS capabilityCode,
      capabilities.provider_granted AS providerGranted,
      capabilities.effective_enabled AS effectiveEnabled,
      capabilities.provider_descriptor_version AS providerDescriptorVersion,
      capabilities.capability_policy_version AS capabilityPolicyVersion,
      capabilities.granted_at AS grantedAt, capabilities.expires_at AS expiresAt,
      capabilities.revoked_at AS revokedAt,
      capabilities.evaluated_at AS evaluatedAt
      FROM payment_provider_connection_capabilities AS capabilities
      INNER JOIN payment_provider_connections AS connections
        ON connections.shop_id = capabilities.shop_id
        AND connections.id = capabilities.connection_id
      WHERE capabilities.shop_id = ?
      ORDER BY connections.created_at, capabilities.connection_id,
        capabilities.capability_code`, shopId),
    queryRows(input.env, `SELECT connections.public_id AS connectionPublicId,
      currencies.currency_code AS currencyCode,
      currencies.provider_supported AS providerSupported,
      currencies.effective_enabled AS effectiveEnabled,
      currencies.provider_descriptor_version AS providerDescriptorVersion,
      currencies.capability_policy_version AS capabilityPolicyVersion,
      currencies.evaluated_at AS evaluatedAt
      FROM payment_provider_connection_currencies AS currencies
      INNER JOIN payment_provider_connections AS connections
        ON connections.shop_id = currencies.shop_id
        AND connections.id = currencies.connection_id
      WHERE currencies.shop_id = ?
      ORDER BY connections.created_at, currencies.connection_id,
        currencies.currency_code`, shopId),
    queryRows(input.env, `SELECT connections.public_id AS connectionPublicId,
      methods.method_code AS methodCode,
      methods.provider_supported AS providerSupported,
      methods.effective_enabled AS effectiveEnabled,
      methods.provider_descriptor_version AS providerDescriptorVersion,
      methods.capability_policy_version AS capabilityPolicyVersion,
      methods.evaluated_at AS evaluatedAt
      FROM payment_provider_connection_methods AS methods
      INNER JOIN payment_provider_connections AS connections
        ON connections.shop_id = methods.shop_id
        AND connections.id = methods.connection_id
      WHERE methods.shop_id = ?
      ORDER BY connections.created_at, methods.connection_id,
        methods.method_code`, shopId),
    queryRows(input.env, `SELECT id, order_id AS orderId,
      fulfillment_type AS fulfillmentType, state, fulfilled_at AS fulfilledAt,
      failed_at AS failedAt, created_at AS createdAt
      FROM fulfillments WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, fulfillment_id AS fulfillmentId, order_item_id AS orderItemId,
      inventory_key_id AS inventoryKeyId, delivered_at AS deliveredAt, created_at AS createdAt
      FROM fulfillment_items WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, order_id AS orderId, order_item_id AS orderItemId,
      fulfillment_id AS fulfillmentId, execution_type AS executionType, state,
      completed_quantity AS completedQuantity, actor_user_id AS actorUserId,
      request_id AS requestId, completed_at AS completedAt, created_at AS createdAt
      FROM manual_fulfillment_executions
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, execution_id AS executionId,
      reference_type AS referenceType, hash_key_version AS hashKeyVersion,
      created_at AS createdAt
      FROM external_fulfillment_references
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, kind, status,
      created_by_user_id AS createdByUserId, created_at AS createdAt,
      updated_at AS updatedAt, deleted_at AS deletedAt
      FROM digital_assets WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, asset_id AS assetId, version,
      filename_sanitized AS filename, content_type AS contentType,
      byte_size AS byteSize, content_sha256 AS contentSha256,
      object_etag AS objectEtag, status,
      created_by_user_id AS createdByUserId, created_at AS createdAt,
      updated_at AS updatedAt, deleted_at AS deletedAt
      FROM digital_asset_versions WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, product_id AS productId, capability,
      policy_version AS policyVersion, asset_version_id AS assetVersionId,
      max_downloads AS maxDownloads, grant_ttl_seconds AS grantTtlSeconds,
      entitlement_ttl_seconds AS entitlementTtlSeconds, status,
      created_by_user_id AS createdByUserId, created_at AS createdAt,
      updated_at AS updatedAt, retired_at AS retiredAt
      FROM product_fulfillment_policies WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, order_id AS orderId, order_item_id AS orderItemId,
      capability, policy_id AS policyId, policy_version AS policyVersion,
      asset_version_id AS assetVersionId, max_downloads AS maxDownloads,
      grant_ttl_seconds AS grantTtlSeconds,
      entitlement_ttl_seconds AS entitlementTtlSeconds, created_at AS createdAt
      FROM order_item_fulfillment_requirements
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, order_id AS orderId, order_item_id AS orderItemId,
      requirement_id AS requirementId, asset_version_id AS assetVersionId,
      status, max_downloads AS maxDownloads, download_count AS downloadCount,
      access_expires_at AS accessExpiresAt, revoked_at AS revokedAt,
      exhausted_at AS exhaustedAt, version, created_at AS createdAt,
      updated_at AS updatedAt
      FROM digital_entitlements WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, entitlement_id AS entitlementId,
      order_id AS orderId, order_item_id AS orderItemId,
      asset_version_id AS assetVersionId, token_key_version AS tokenKeyVersion,
      status, expires_at AS expiresAt, consumed_at AS consumedAt,
      revoked_at AS revokedAt, version, created_at AS createdAt,
      updated_at AS updatedAt
      FROM delivery_grants WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, entitlement_id AS entitlementId,
      grant_id AS grantId, order_id AS orderId,
      asset_version_id AS assetVersionId, request_id AS requestId,
      outcome, created_at AS createdAt
      FROM delivery_grant_consumptions
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, resource_key AS resourceKey,
      resource_type AS resourceType, status,
      created_by_user_id AS createdByUserId, retired_at AS retiredAt,
      version, created_at AS createdAt, updated_at AS updatedAt
      FROM entitlement_resources WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, product_id AS productId, resource_id AS resourceId,
      policy_version AS policyVersion, activation_condition AS activationCondition,
      grant_quantity_per_unit AS grantQuantityPerUnit,
      entitlement_ttl_seconds AS entitlementTtlSeconds, status,
      created_by_user_id AS createdByUserId, retired_at AS retiredAt,
      created_at AS createdAt, updated_at AS updatedAt
      FROM product_entitlement_policies WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, order_id AS orderId, order_item_id AS orderItemId,
      policy_id AS policyId, resource_id AS resourceId,
      policy_version AS policyVersion, activation_condition AS activationCondition,
      item_quantity AS itemQuantity, grant_quantity AS grantQuantity,
      entitlement_ttl_seconds AS entitlementTtlSeconds, created_at AS createdAt
      FROM order_item_entitlement_requirements
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, order_id AS orderId, order_item_id AS orderItemId,
      requirement_id AS requirementId, resource_id AS resourceId,
      customer_id AS customerId, status, grant_quantity AS grantQuantity,
      entitlement_ttl_seconds AS entitlementTtlSeconds,
      access_expires_at AS accessExpiresAt, activated_at AS activatedAt,
      suspended_at AS suspendedAt, expired_at AS expiredAt, revoked_at AS revokedAt,
      version, created_at AS createdAt, updated_at AS updatedAt
      FROM entitlements WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, entitlement_id AS entitlementId,
      requirement_id AS requirementId, order_id AS orderId, resource_id AS resourceId,
      source_kind AS sourceKind, source_payment_event_id AS sourcePaymentEventId,
      granted_quantity AS grantedQuantity, created_at AS createdAt
      FROM entitlement_grants WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, entitlement_id AS entitlementId,
      requirement_id AS requirementId, resource_id AS resourceId,
      entitlement_version AS entitlementVersion, from_status AS fromStatus,
      to_status AS toStatus, source_grant_id AS sourceGrantId,
      reason_code AS reasonCode, actor_kind AS actorKind,
      actor_user_id AS actorUserId, occurred_at AS occurredAt, created_at AS createdAt
      FROM entitlement_transitions WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, provider_code AS providerCode,
      provider_environment AS providerEnvironment,
      descriptor_version AS descriptorVersion, status,
      last_health_at AS lastHealthAt, last_safe_error_code AS lastSafeErrorCode,
      created_by_user_id AS createdByUserId, version,
      created_at AS createdAt, updated_at AS updatedAt, retired_at AS retiredAt
      FROM generated_license_provider_connections
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, connection_id AS connectionId,
      provider_code AS providerCode, credential_version AS credentialVersion,
      status, created_by_user_id AS createdByUserId,
      activated_at AS activatedAt, revoked_at AS revokedAt,
      created_at AS createdAt, updated_at AS updatedAt, version
      FROM generated_license_provider_credentials
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, resource_id AS resourceId,
      connection_id AS connectionId, provider_code AS providerCode,
      generation_template_version AS generationTemplateVersion, status,
      created_by_user_id AS createdByUserId, created_at AS createdAt,
      updated_at AS updatedAt, retired_at AS retiredAt, version
      FROM generated_license_resource_bindings
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id,
      entitlement_requirement_id AS entitlementRequirementId,
      entitlement_id AS entitlementId, order_id AS orderId,
      order_item_id AS orderItemId, resource_id AS resourceId,
      binding_id AS bindingId, connection_id AS connectionId,
      provider_code AS providerCode,
      generation_template_version AS generationTemplateVersion,
      requested_quantity AS requestedQuantity, created_at AS createdAt
      FROM generated_license_requirement_snapshots
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id,
      requirement_snapshot_id AS requirementSnapshotId,
      entitlement_id AS entitlementId, entitlement_grant_id AS entitlementGrantId,
      order_id AS orderId, resource_id AS resourceId,
      connection_id AS connectionId, provider_code AS providerCode,
      unit_ordinal AS unitOrdinal, credential_version AS credentialVersion,
      status, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt,
      last_safe_error_code AS lastSafeErrorCode,
      succeeded_at AS succeededAt, canceled_at AS canceledAt, version,
      created_at AS createdAt, updated_at AS updatedAt
      FROM generated_license_requests
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, request_id AS requestId,
      attempt_no AS attemptNo, action_kind AS actionKind,
      credential_version AS credentialVersion, outcome,
      safe_error_code AS safeErrorCode, occurred_at AS occurredAt,
      created_at AS createdAt
      FROM generated_license_attempts
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, request_id AS requestId,
      entitlement_id AS entitlementId, ordinal, format, status,
      created_at AS createdAt, revoked_at AS revokedAt
      FROM generated_license_artifacts
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, request_id AS requestId,
      failure_code AS failureCode, safe_context_json AS safeContextJson,
      status, provider_attempts AS providerAttempts,
      occurrence_count AS occurrenceCount, resolution_code AS resolutionCode,
      created_at AS createdAt, updated_at AS updatedAt,
      resolved_at AS resolvedAt
      FROM generated_license_dead_letters
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT public_id AS publicId, status, webhook_status AS webhookStatus,
      bot_id AS botId, bot_username_sanitized AS botUsername,
      bot_display_name_sanitized AS botDisplayName,
      pending_update_count AS pendingUpdateCount, last_safe_error_code AS lastSafeErrorCode,
      last_checked_at AS lastCheckedAt, connected_at AS connectedAt,
      created_at AS createdAt, updated_at AS updatedAt
      FROM telegram_integrations WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, customer_id AS customerId, provider, external_subject AS externalSubject,
      display_handle_sanitized AS displayHandle, language_code AS languageCode,
      verified_at AS verifiedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM customer_identities WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT id, integration_id AS integrationId,
      customer_identity_id AS customerIdentityId, status,
      last_safe_error_code AS lastSafeErrorCode, last_seen_at AS lastSeenAt,
      last_outbound_at AS lastOutboundAt, created_at AS createdAt, updated_at AS updatedAt
      FROM telegram_recipients WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT update_id AS updateId, payload_hash AS payloadHash, update_kind AS updateKind,
      status, attempts, safe_result_code AS safeResultCode, received_at AS receivedAt,
      processed_at AS processedAt, updated_at AS updatedAt
      FROM telegram_updates WHERE shop_id = ? ORDER BY received_at, id`, shopId),
    queryRows(input.env, `SELECT update_id AS updateId, action_kind AS actionKind,
      result_reference AS resultReference, created_at AS createdAt
      FROM telegram_actions WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT hostname_normalized AS hostname, type, status,
      is_primary AS isPrimary, hostname_status AS hostnameStatus, ssl_status AS sslStatus,
      dns_status AS dnsStatus, activated_at AS activatedAt, deleted_at AS deletedAt,
      created_at AS createdAt, updated_at AS updatedAt
      FROM shop_domains WHERE shop_id = ? ORDER BY created_at, id`, shopId),
    queryRows(input.env, `SELECT actor_type AS actorType, actor_id AS actorId, action,
      resource_type AS resourceType, resource_id AS resourceId,
      safe_metadata_json AS safeMetadataJson, request_id AS requestId,
      source_kind AS sourceKind, correlation_id AS correlationId,
      operation_id AS operationId, retention_class AS retentionClass,
      created_at AS createdAt FROM audit_logs
      WHERE shop_id = ? ORDER BY created_at, id`, shopId),
  ]);

  if (shop === null) throw new AppError("authorization_denied", 403);
  const exportedApiCredentials = apiCredentials.map(({ scopeJson, ...credential }) => ({
    ...credential,
    scopes: JSON.parse(scopeJson) as unknown,
  }));
  return {
    exportedAt: input.exportedAt,
    exportKind: "standard",
    schemaVersion: 5,
    shop,
    data: {
      apiCredentials: exportedApiCredentials,
      auditLogs,
      catalog: { categories, products, variants },
      customers: { customerIdentities, shopCustomers: customers, telegramRecipients },
      domains,
      fulfillment: {
        assets: digitalAssets,
        assetVersions: digitalAssetVersions,
        deliveryGrants,
        grantConsumptions: deliveryGrantConsumptions,
        entitlements: digitalEntitlements,
        fulfillmentItems,
        fulfillments,
        manualFulfillmentExecutions,
        externalFulfillmentReferences,
        genericEntitlements: {
          entitlements: genericEntitlements,
          grants: entitlementGrants,
          policies: entitlementPolicies,
          requirements: entitlementRequirements,
          resources: entitlementResources,
          transitions: entitlementTransitions,
        },
        generatedLicenses: {
          artifacts: generatedLicenseArtifacts,
          attempts: generatedLicenseAttempts,
          deadLetters: generatedLicenseDeadLetters,
          providerConnections: generatedLicenseProviderConnections,
          providerCredentials: generatedLicenseProviderCredentials,
          requests: generatedLicenseRequests,
          requirementSnapshots: generatedLicenseRequirementSnapshots,
          resourceBindings: generatedLicenseResourceBindings,
        },
        policies: fulfillmentPolicies,
        requirements: fulfillmentRequirements,
      },
      inventory: { batches: inventoryBatches, keys: inventoryKeys },
      members,
      orders: { items: orderItems, orders },
      payments: {
        attempts: paymentAttempts,
        events: paymentEvents,
        exceptions: paymentExceptions,
        integrations: paymentIntegrations,
        reversals: paymentReversalEvents,
        providerConnectionCapabilities: paymentProviderConnectionCapabilities,
        providerConnectionCurrencies: paymentProviderConnectionCurrencies,
        providerConnectionMethods: paymentProviderConnectionMethods,
        providerConnections: paymentProviderConnections,
      },
      telegram: { actions: telegramActions, integrations: telegramIntegrations, updates: telegramUpdates },
    },
  };
}

async function buildPlaintextKeyExportPayload(input: {
  env: AppBindings;
  exportedAt: string;
  shop: OwnerShop;
}): Promise<Record<string, unknown>> {
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT inventory_keys.id, inventory_keys.variant_id AS variantId,
      inventory_keys.batch_id AS batchId, inventory_keys.status,
      inventory_keys.ciphertext_b64 AS ciphertextB64,
      inventory_keys.iv_b64 AS ivB64, inventory_keys.key_version AS keyVersion,
      product_variants.sku, products.title AS productTitle,
      product_variants.title AS variantTitle, inventory_keys.created_at AS createdAt
    FROM inventory_keys
    INNER JOIN product_variants
      ON product_variants.id = inventory_keys.variant_id
      AND product_variants.shop_id = inventory_keys.shop_id
    INNER JOIN products
      ON products.id = product_variants.product_id
      AND products.shop_id = inventory_keys.shop_id
    WHERE inventory_keys.shop_id = ?
    ORDER BY inventory_keys.created_at, inventory_keys.id
  `).bind(input.shop.shopId).all<{
    batchId: string;
    ciphertextB64: string;
    createdAt: string;
    id: string;
    ivB64: string;
    keyVersion: string;
    productTitle: string;
    sku: string;
    status: string;
    variantId: string;
    variantTitle: string;
  }>();
  const keys = await Promise.all(rows.results.map(async (row) => {
    const encryptionKey = resolveEncryptionKey(input.env, "inventory", row.keyVersion);
    return {
      batchId: row.batchId,
      createdAt: row.createdAt,
      id: row.id,
      productTitle: row.productTitle,
      sku: row.sku,
      status: row.status,
      value: await decryptInventoryKey({
        ciphertextB64: row.ciphertextB64,
        ivB64: row.ivB64,
        kek: encryptionKey.kek,
        keyVersion: encryptionKey.version,
        shopId: input.shop.shopId,
        variantId: row.variantId,
      }),
      variantId: row.variantId,
      variantTitle: row.variantTitle,
    };
  }));
  return {
    exportedAt: input.exportedAt,
    exportKind: "inventory_keys_plaintext",
    schemaVersion: 1,
    shop: { publicId: input.shop.publicId, slug: input.shop.slug },
    keys,
  };
}

async function loadExportPayload(input: {
  env: AppBindings;
  exportedAt: string;
  kind: DataExportKind;
  shop: OwnerShop;
}): Promise<Record<string, unknown>> {
  return input.kind === "standard"
    ? buildStandardExportPayload(input)
    : buildPlaintextKeyExportPayload(input);
}

async function persistExportFailure(input: {
  env: AppBindings;
  exportId: string;
  objectKey: string;
  requestId: string;
  shopId: string;
  userId: string;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE data_export_jobs
      SET status = 'failed', last_safe_error_code = 'export_generation_failed', updated_at = ?
      WHERE id = ? AND shop_id = ? AND status = 'processing'
    `).bind(nowIso, input.exportId, input.shopId),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, source_kind,
        retention_class, created_at
      ) VALUES (?, ?, 'user', ?, 'data_export.failed', 'data_export_job', ?, '{}', ?, 'application', 'security', ?)
    `).bind(createId("aud"), input.shopId, input.userId, input.exportId, input.requestId, nowIso),
  ]).catch(() => undefined);
  const bindings = exportBindings(input.env);
  await bindings.PRIVATE_EXPORTS.delete(input.objectKey).catch(() => undefined);
}

/** Revoke expired exports before deleting their exact private object in bounded batches. */
export async function purgeExpiredDataExports(
  env: AppBindings,
  now = new Date(),
  limit = DEFAULT_EXPORT_PURGE_LIMIT,
): Promise<DataExportPurgeResult> {
  const bindings = exportBindings(env);
  const nowIso = now.toISOString();
  const rows = await env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId, object_key AS objectKey
    FROM data_export_jobs
    WHERE object_deleted_at IS NULL AND retain_until <= ?
    ORDER BY retain_until, shop_id, id
    LIMIT ?
  `).bind(nowIso, boundedExportPurgeLimit(limit)).all<ExpiredExportObjectRow>();
  const result: DataExportPurgeResult = {
    candidates: rows.results.length,
    deleted: 0,
    failed: 0,
    invalidObjectKeys: 0,
  };

  for (const row of rows.results) {
    const revoked = await env.PLATFORM_DB.prepare(`
      UPDATE data_export_jobs
      SET status = CASE WHEN status = 'downloaded' THEN status ELSE 'expired' END,
        download_token_hash = CASE WHEN status = 'downloaded' THEN download_token_hash ELSE NULL END,
        download_token_expires_at = CASE WHEN status = 'downloaded' THEN download_token_expires_at ELSE NULL END,
        last_safe_error_code = NULL, updated_at = ?
      WHERE id = ? AND shop_id = ? AND object_key = ?
        AND object_deleted_at IS NULL AND retain_until <= ?
    `).bind(nowIso, row.id, row.shopId, row.objectKey, nowIso).run();
    if (revoked.meta.changes !== 1) continue;

    if (row.objectKey !== dataExportObjectKey(row.id)) {
      result.invalidObjectKeys += 1;
      await env.PLATFORM_DB.prepare(`
        UPDATE data_export_jobs
        SET last_safe_error_code = 'export_object_key_invalid', updated_at = ?
        WHERE id = ? AND shop_id = ? AND object_key = ? AND object_deleted_at IS NULL
      `).bind(nowIso, row.id, row.shopId, row.objectKey).run();
      continue;
    }

    try {
      await bindings.PRIVATE_EXPORTS.delete(row.objectKey);
    } catch {
      result.failed += 1;
      await env.PLATFORM_DB.prepare(`
        UPDATE data_export_jobs
        SET last_safe_error_code = 'export_object_delete_failed', updated_at = ?
        WHERE id = ? AND shop_id = ? AND object_key = ? AND object_deleted_at IS NULL
      `).bind(nowIso, row.id, row.shopId, row.objectKey).run();
      continue;
    }

    const marked = await env.PLATFORM_DB.prepare(`
      UPDATE data_export_jobs
      SET object_deleted_at = ?, last_safe_error_code = NULL, updated_at = ?
      WHERE id = ? AND shop_id = ? AND object_key = ?
        AND object_deleted_at IS NULL AND retain_until <= ?
    `).bind(nowIso, nowIso, row.id, row.shopId, row.objectKey, nowIso).run();
    result.deleted += marked.meta.changes;
  }
  return result;
}

export async function createDataExport(input: {
  acknowledgePlaintextRisk?: boolean;
  env: AppBindings;
  kind: DataExportKind;
  requestId: string;
  runtime?: ExportRuntime;
  shopPublicId: string;
  userId: string;
}): Promise<CreateDataExportResult> {
  if (input.kind === "inventory_keys_plaintext" && input.acknowledgePlaintextRisk !== true) {
    throw new AppError("validation_failed", 400, ["plaintext_key_export_acknowledgement_required"]);
  }
  const bindings = exportBindings(input.env);
  const exportKey = resolveActiveEncryptionKey(input.env, "export");
  const shop = await requireOwnerShop(input);
  const now = input.runtime?.now ?? new Date();
  const nowIso = now.toISOString();
  const active = await input.env.PLATFORM_DB.prepare(`
    SELECT id FROM data_export_jobs
    WHERE shop_id = ? AND kind = ? AND status IN ('processing', 'available')
    LIMIT 1
  `).bind(shop.shopId, input.kind).first<{ id: string }>();
  if (active !== null) throw new AppError("export_already_active", 409);

  const exportId = createId("exp");
  const objectKey = dataExportObjectKey(exportId);
  const highRisk = input.kind === "inventory_keys_plaintext";
  const retainUntil = new Date(now.getTime() + (highRisk ? HIGH_RISK_EXPORT_RETENTION_MS : STANDARD_EXPORT_RETENTION_MS)).toISOString();
  try {
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO data_export_jobs (
          id, shop_id, kind, status, requested_by_user_id, request_id,
          object_key, encryption_key_version, includes_plaintext_keys,
          retention_class, retain_until, started_at, created_at, updated_at
        )
        SELECT ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM shops
          WHERE shops.id = ? AND shops.status != 'archived'
            AND NOT EXISTS (
              SELECT 1 FROM shop_deletion_requests AS deletion_request
              WHERE deletion_request.shop_id = shops.id
                AND deletion_request.status IN ('processing', 'blocked', 'retention_hold', 'failed')
                AND (
                  deletion_request.secret_material_destroyed_at IS NOT NULL
                  OR deletion_request.completed_at IS NOT NULL
                  OR EXISTS (
                    SELECT 1 FROM shop_deletion_steps AS destructive_step
                    WHERE destructive_step.request_id = deletion_request.id
                      AND destructive_step.shop_id = deletion_request.shop_id
                      AND destructive_step.step_code = 'crypto_shred'
                      AND (
                        destructive_step.status = 'processing'
                        OR destructive_step.last_safe_error_code = 'crypto_shred_destructive_in_flight'
                      )
                  )
                )
            )
        )
      `).bind(
        exportId,
        shop.shopId,
        input.kind,
        input.userId,
        input.requestId,
        objectKey,
        exportKey.version,
        highRisk ? 1 : 0,
        highRisk ? "high_risk" : "standard",
        retainUntil,
        nowIso,
        nowIso,
        nowIso,
        shop.shopId,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, source_kind,
          retention_class, created_at
        )
        SELECT ?, ?, 'user', ?, 'data_export.requested', 'data_export_job', ?, ?, ?, 'application', 'security', ?
        WHERE EXISTS (
          SELECT 1 FROM data_export_jobs
          WHERE id = ? AND shop_id = ? AND status = 'processing'
        )
      `).bind(
        createId("aud"),
        shop.shopId,
        input.userId,
        exportId,
        JSON.stringify({ includesPlaintextKeys: highRisk, kind: input.kind }),
        input.requestId,
        nowIso,
        exportId,
        shop.shopId,
      ),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      throw new AppError("export_state_conflict", 409);
    }
  } catch (error) {
    if (error instanceof AppError && error.code === "export_state_conflict") throw error;
    throw new AppError("export_already_active", 409);
  }

  try {
    const payload = await loadExportPayload({ env: input.env, exportedAt: nowIso, kind: input.kind, shop });
    const encrypted = await encryptDataExportPayload({
      exportId,
      keyVersion: exportKey.version,
      kek: exportKey.kek,
      kind: input.kind,
      plaintext: new Uint8Array(encoder.encode(JSON.stringify(payload))),
      shopId: shop.shopId,
    });
    const object = await bindings.PRIVATE_EXPORTS.put(objectKey, encrypted.ciphertext, {
      customMetadata: { exportId, keyVersion: exportKey.version },
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const downloadToken = createOpaqueToken(32);
    const tokenHash = await hmacToken(input.env.SESSION_SECRET, `data-export-download:${exportId}`, downloadToken);
    const downloadExpiresAt = new Date(now.getTime() + DOWNLOAD_TOKEN_TTL_MS).toISOString();
    const completedAt = new Date().toISOString();
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        UPDATE data_export_jobs
        SET status = 'available', object_etag = ?, ciphertext_sha256 = ?,
          ciphertext_size_bytes = ?, encryption_iv_b64 = ?, download_token_hash = ?,
          download_token_expires_at = ?, completed_at = ?, last_safe_error_code = NULL,
          updated_at = ?
        WHERE id = ? AND shop_id = ? AND status = 'processing'
      `).bind(
        object.httpEtag,
        encrypted.sha256,
        encrypted.ciphertext.byteLength,
        encrypted.ivB64,
        tokenHash,
        downloadExpiresAt,
        completedAt,
        completedAt,
        exportId,
        shop.shopId,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, source_kind,
          retention_class, created_at
        ) VALUES (?, ?, 'user', ?, 'data_export.available', 'data_export_job', ?, ?, ?, 'application', 'security', ?)
      `).bind(
        createId("aud"),
        shop.shopId,
        input.userId,
        exportId,
        JSON.stringify({ includesPlaintextKeys: highRisk, kind: input.kind }),
        input.requestId,
        completedAt,
      ),
    ]);
    if (results[0]?.meta.changes !== 1) throw new AppError("export_state_conflict", 409);
    const row = await input.env.PLATFORM_DB.prepare(`${EXPORT_JOB_SELECT} WHERE id = ? AND shop_id = ? LIMIT 1`)
      .bind(exportId, shop.shopId).first<ExportJobRow>();
    if (row === null) throw new AppError("export_state_conflict", 409);
    return { downloadToken, export: mapJob(row) };
  } catch (error) {
    await persistExportFailure({
      env: input.env,
      exportId,
      objectKey,
      requestId: input.requestId,
      shopId: shop.shopId,
      userId: input.userId,
    });
    throw error instanceof AppError ? error : new AppError("export_generation_failed", 500);
  }
}

export async function listDataExports(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<DataExportView[]> {
  const shop = await requireOwnerShop(input);
  const rows = await input.env.PLATFORM_DB.prepare(`
    ${EXPORT_JOB_SELECT}
    WHERE shop_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 50
  `).bind(shop.shopId).all<ExportJobRow>();
  return rows.results.map(mapJob);
}

export async function consumeDataExportDownload(input: {
  env: AppBindings;
  exportId: string;
  requestId: string;
  runtime?: ExportRuntime;
  shopPublicId: string;
  token: string;
  userId: string;
}): Promise<{ bytes: Uint8Array<ArrayBuffer>; filename: string; kind: DataExportKind }> {
  const bindings = exportBindings(input.env);
  const shop = await requireOwnerShop(input);
  const now = input.runtime?.now ?? new Date();
  const nowIso = now.toISOString();
  const row = await input.env.PLATFORM_DB.prepare(`
    ${EXPORT_JOB_SELECT}
    WHERE id = ? AND shop_id = ? AND status = 'available'
      AND download_token_consumed_at IS NULL
      AND download_token_expires_at > ?
      AND retain_until > ?
    LIMIT 1
  `).bind(input.exportId, shop.shopId, nowIso, nowIso).first<ExportJobRow>();
  if (
    row === null
    || row.downloadTokenHash === null
    || row.downloadTokenExpiresAt === null
    || row.encryptionIvB64 === null
    || row.ciphertextSha256 === null
  ) {
    throw new AppError("export_download_not_found", 404);
  }
  const tokenHash = await hmacToken(input.env.SESSION_SECRET, `data-export-download:${row.id}`, input.token);
  if (!constantTimeEqual(row.downloadTokenHash, tokenHash)) {
    throw new AppError("export_download_not_found", 404);
  }

  const object = await bindings.PRIVATE_EXPORTS.get(row.objectKey);
  if (object === null) throw new AppError("export_download_not_found", 404);
  const ciphertext = new Uint8Array(await object.arrayBuffer());
  if (!constantTimeEqual(row.ciphertextSha256, await sha256Bytes(ciphertext))) {
    throw new AppError("export_integrity_failed", 500);
  }

  const plaintext = await decryptDataExportPayload({
    ciphertext,
    exportId: row.id,
    ivB64: row.encryptionIvB64,
    keyVersion: row.encryptionKeyVersion,
    kek: resolveEncryptionKey(input.env, "export", row.encryptionKeyVersion).kek,
    kind: row.kind,
    shopId: shop.shopId,
  });
  const consumedAt = new Date().toISOString();
  const consumed = await input.env.PLATFORM_DB.prepare(`
    UPDATE data_export_jobs
    SET status = 'downloaded', download_token_consumed_at = ?, updated_at = ?
    WHERE id = ? AND shop_id = ? AND status = 'available'
      AND download_token_hash = ? AND download_token_consumed_at IS NULL
      AND download_token_expires_at > ?
      AND retain_until > ?
  `).bind(consumedAt, consumedAt, row.id, shop.shopId, row.downloadTokenHash, nowIso, nowIso).run();
  if (consumed.meta.changes !== 1) throw new AppError("export_download_not_found", 404);
  let deletedAt: string | null = null;
  try {
    await bindings.PRIVATE_EXPORTS.delete(row.objectKey);
    deletedAt = new Date().toISOString();
  } catch {
    // Retention cleanup can retry deletion of the still-encrypted object.
  }
  await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE data_export_jobs SET object_deleted_at = COALESCE(object_deleted_at, ?), updated_at = ?
      WHERE id = ? AND shop_id = ? AND status = 'downloaded'
    `).bind(deletedAt, consumedAt, row.id, shop.shopId),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, source_kind,
        retention_class, created_at
      ) VALUES (?, ?, 'user', ?, 'data_export.downloaded', 'data_export_job', ?, ?, ?, 'http', 'security', ?)
    `).bind(
      createId("aud"),
      shop.shopId,
      input.userId,
      row.id,
      JSON.stringify({ includesPlaintextKeys: row.includesPlaintextKeys === 1, kind: row.kind }),
      input.requestId,
      consumedAt,
    ),
  ]);
  return {
    bytes: plaintext,
    filename: `${shop.slug}-${row.kind}-${row.id.slice(-8)}.json`,
    kind: row.kind,
  };
}

export function decodeExportJson(bytes: Uint8Array<ArrayBuffer>): unknown {
  return JSON.parse(decoder.decode(bytes)) as unknown;
}
