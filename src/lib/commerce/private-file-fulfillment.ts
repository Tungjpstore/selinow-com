import { constantTimeEqual, hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId, createOpaqueToken, toBase64Url } from "../core/ids";
import { resolveOrderChannelAttribution } from "../channels/attribution";
import { WEBSITE_CHANNEL_CODE } from "../channels/builtins";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";

export const MAX_PRIVATE_FILE_BYTES = 50 * 1024 * 1024;
const TOKEN_KEY_VERSION = "identifier-hmac-v1";
const PRIVATE_DOWNLOAD_CLAIM_TTL_MS = 5 * 60_000;
const WEBSITE_ORDER_ATTRIBUTION = resolveOrderChannelAttribution(WEBSITE_CHANNEL_CODE);
const ALLOWED_CONTENT_TYPES = new Set([
  "application/epub+zip",
  "application/json",
  "application/octet-stream",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/zip",
  "audio/mpeg",
  "image/jpeg",
  "image/png",
  "text/csv",
  "text/plain",
  "video/mp4",
]);

type PrivateFileRuntime = { now?: Date };

type AuthorizedOrderRow = {
  buyerBindingHash: string;
  id: string;
  paymentStatus: string;
  status: string;
};

type RequirementSourceRow = {
  assetStatus: string;
  assetVersionId: string;
  assetVersionStatus: string;
  entitlementTtlSeconds: number | null;
  grantTtlSeconds: number;
  maxDownloads: number;
  orderItemId: string;
  policyId: string;
  policyVersion: number;
};

type RequirementRow = RequirementSourceRow & {
  id: string;
};

type EntitlementRow = {
  accessExpiresAt: string | null;
  assetVersionId: string;
  buyerBindingHash: string;
  downloadCount: number;
  id: string;
  maxDownloads: number;
  orderItemId: string;
  requirementId: string;
  status: string;
};

type GrantRow = {
  assetVersionId: string;
  buyerBindingHash: string;
  entitlementId: string;
  expiresAt: string;
  id: string;
  orderId: string;
  orderItemId: string;
  requestHash: string;
  status: string;
  tokenHash: string;
  tokenKeyVersion: string;
  tokenNonce: string;
};

type DownloadGrantRow = GrantRow & {
  accessExpiresAt: string | null;
  assetStatus: string;
  assetVersionStatus: string;
  byteSize: number;
  contentSha256: string;
  contentType: string;
  downloadCount: number;
  entitlementStatus: string;
  filename: string;
  maxDownloads: number;
  objectEtag: string;
  objectKey: string;
};

type DownloadConsumptionRow = {
  idempotencyKey: string;
};

export type PrivateDigitalAssetView = {
  assetId: string;
  assetVersionId: string;
  byteSize: number;
  contentSha256: string;
  contentType: string;
  filename: string;
  version: number;
};

export type PrivateFilePolicyView = {
  assetVersionId: string;
  entitlementTtlSeconds: number | null;
  grantTtlSeconds: number;
  id: string;
  maxDownloads: number;
  policyVersion: number;
  productId: string;
};

export type PrivateDownloadView = {
  assetVersionId: string;
  downloadCount: number;
  entitlementExpiresAt: string | null;
  entitlementStatus: string | null;
  filename: string;
  maxDownloads: number;
  orderItemId: string;
  remainingDownloads: number;
};

export type PrivateDownloadGrantView = {
  assetVersionId: string;
  expiresAt: string;
  grantId: string;
  grantToken: string;
  remainingDownloads: number;
};

export type PrivateDownloadPayload = {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  filename: string;
};

function mediaBucket(env: AppBindings): R2Bucket {
  const bucket = (env as Partial<AppBindings>).MEDIA;
  if (bucket === undefined) throw new AppError("private_asset_configuration_invalid", 500);
  return bucket;
}

function nowFrom(runtime?: PrivateFileRuntime): Date {
  return runtime?.now ?? new Date();
}

async function sha256Bytes(value: Uint8Array<ArrayBuffer>): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
}

export function sanitizePrivateDownloadFilename(value: string): string {
  const basename = value.trim().replaceAll("\\", "/").split("/").at(-1) ?? "";
  const sanitized = basename
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._ -]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/\.{2,}/gu, ".")
    .replace(/^[ .]+|[ .]+$/gu, "")
    .slice(0, 160);
  if (sanitized.length === 0 || sanitized === "." || sanitized === "..") {
    throw new AppError("validation_failed", 400, ["private_asset_filename_invalid"]);
  }
  return sanitized;
}

function normalizeContentType(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.has(normalized)) {
    throw new AppError("validation_failed", 400, ["private_asset_content_type_invalid"]);
  }
  return normalized;
}

export async function authorizePrivateDigitalAssetUpload(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<string> {
  const member = await getShopForMember({ capability: "catalog:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  if (member.row.shop_status !== "active" && member.row.shop_status !== "draft") {
    throw new AppError("shop_inactive", 409);
  }
  return member.row.shop_id;
}

function assertIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(value)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_invalid"]);
  }
}

async function authorizeWebsiteOrder(input: {
  env: AppBindings;
  orderPublicId: string;
  orderToken: string;
  shopId: string;
}): Promise<AuthorizedOrderRow> {
  const order = await input.env.PLATFORM_DB.prepare(`
    SELECT orders.id, orders.order_token_hash AS buyerBindingHash,
      orders.payment_status AS paymentStatus, orders.status
    FROM orders
    LEFT JOIN order_channel_attributions AS attribution
      ON attribution.shop_id = orders.shop_id AND attribution.order_id = orders.id
    WHERE orders.public_id = ? AND orders.shop_id = ?
      AND orders.source_channel = ?
      AND (
        attribution.order_id IS NULL
        OR (
          attribution.channel_code = ?
          AND attribution.adapter_version = ?
          AND attribution.connection_id IS NULL
        )
      )
    LIMIT 1
  `).bind(
    input.orderPublicId,
    input.shopId,
    WEBSITE_ORDER_ATTRIBUTION.legacySourceChannel,
    WEBSITE_ORDER_ATTRIBUTION.channelCode,
    WEBSITE_ORDER_ATTRIBUTION.adapterVersion,
  ).first<AuthorizedOrderRow>();
  if (order === null) throw new AppError("order_not_found", 404);
  const orderTokenHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "order-access", input.orderToken);
  if (!constantTimeEqual(order.buyerBindingHash, orderTokenHash)) throw new AppError("order_not_found", 404);
  return order;
}

function assertOrderDownloadEligible(order: AuthorizedOrderRow): void {
  if (order.paymentStatus !== "paid" || (order.status !== "processing" && order.status !== "completed")) {
    throw new AppError("private_download_not_ready", 409);
  }
}

function entitlementExpiry(now: Date, seconds: number | null): string | null {
  return seconds === null ? null : new Date(now.getTime() + seconds * 1_000).toISOString();
}

function grantExpiry(now: Date, ttlSeconds: number, entitlementExpiresAt: string | null): string {
  const ttlExpiry = now.getTime() + ttlSeconds * 1_000;
  const expiresAt = entitlementExpiresAt === null
    ? ttlExpiry
    : Math.min(ttlExpiry, Date.parse(entitlementExpiresAt));
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) throw new AppError("private_download_expired", 404);
  return new Date(expiresAt).toISOString();
}

async function deriveGrantToken(env: AppBindings, grant: Pick<GrantRow, "id" | "tokenNonce">): Promise<string> {
  const secret = await hmacToken(env.IDENTIFIER_HMAC_SECRET, `private-delivery-token:${grant.id}`, grant.tokenNonce);
  return `dgt_v1.${grant.id}.${secret}`;
}

async function hashGrantToken(env: AppBindings, input: {
  assetVersionId: string;
  buyerBindingHash: string;
  grantId: string;
  orderId: string;
  token: string;
}): Promise<string> {
  return hmacToken(
    env.IDENTIFIER_HMAC_SECRET,
    `private-delivery-verifier:${input.grantId}:${input.orderId}:${input.assetVersionId}:${input.buyerBindingHash}`,
    input.token,
  );
}

function assertGrantTokenShape(grantId: string, token: string): void {
  const prefix = `dgt_v1.${grantId}.`;
  if (!token.startsWith(prefix) || token.length !== prefix.length + 43 || !/^[A-Za-z0-9_.-]+$/u.test(token)) {
    throw new AppError("private_download_grant_not_found", 404);
  }
}

async function claimWebsitePrivateDownload(input: {
  env: AppBindings;
  grantId: string;
  now: Date;
  orderId: string;
  row: DownloadGrantRow;
  shopId: string;
}): Promise<string> {
  const claimId = createId("dcl");
  const nowIso = input.now.toISOString();
  const grantExpiresAt = Date.parse(input.row.expiresAt);
  const leaseExpiresAt = new Date(Math.min(
    input.now.getTime() + PRIVATE_DOWNLOAD_CLAIM_TTL_MS,
    grantExpiresAt,
  )).toISOString();
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      DELETE FROM delivery_grant_claims
      WHERE shop_id = ? AND grant_id = ? AND lease_expires_at <= ?
    `).bind(input.shopId, input.grantId, nowIso),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO delivery_grant_claims (
        id, shop_id, grant_id, created_at, lease_expires_at
      ) SELECT ?, grants.shop_id, grants.id, ?, ?
      FROM delivery_grants AS grants
      INNER JOIN digital_entitlements AS entitlements
        ON entitlements.id = grants.entitlement_id
        AND entitlements.shop_id = grants.shop_id
      INNER JOIN orders
        ON orders.id = grants.order_id
        AND orders.shop_id = grants.shop_id
      INNER JOIN digital_asset_versions
        ON digital_asset_versions.id = grants.asset_version_id
        AND digital_asset_versions.shop_id = grants.shop_id
      INNER JOIN digital_assets
        ON digital_assets.id = digital_asset_versions.asset_id
        AND digital_assets.shop_id = digital_asset_versions.shop_id
      WHERE grants.id = ? AND grants.shop_id = ? AND grants.order_id = ?
        AND grants.status = 'active' AND grants.expires_at > ?
        AND entitlements.status = 'active'
        AND entitlements.download_count < entitlements.max_downloads
        AND (entitlements.access_expires_at IS NULL OR entitlements.access_expires_at > ?)
        AND orders.payment_status = 'paid'
        AND orders.status IN ('processing', 'completed')
        AND digital_assets.status = 'active'
        AND digital_asset_versions.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM delivery_grant_consumptions
          WHERE shop_id = grants.shop_id AND grant_id = grants.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM delivery_grant_claims
          WHERE shop_id = grants.shop_id AND grant_id = grants.id
        )
      ON CONFLICT (shop_id, grant_id) DO NOTHING
    `).bind(
      claimId,
      nowIso,
      leaseExpiresAt,
      input.grantId,
      input.shopId,
      input.orderId,
      nowIso,
      nowIso,
    ),
  ]);
  if ((results[1]?.meta.changes ?? 0) !== 1) throw new AppError("private_download_grant_not_found", 404);
  return claimId;
}

async function releaseWebsitePrivateDownloadClaim(input: {
  env: AppBindings;
  claimId: string;
  grantId: string;
  shopId: string;
}): Promise<void> {
  try {
    await input.env.PLATFORM_DB.prepare(`
      DELETE FROM delivery_grant_claims
      WHERE id = ? AND shop_id = ? AND grant_id = ?
    `).bind(input.claimId, input.shopId, input.grantId).run();
  } catch {
    // A bounded lease allows a later request to recover if cleanup races a D1 failure.
  }
}

async function loadWebsitePrivateDownloadConsumption(input: {
  env: AppBindings;
  grantId: string;
  shopId: string;
}): Promise<DownloadConsumptionRow | null> {
  return input.env.PLATFORM_DB.prepare(`
    SELECT request_id AS idempotencyKey
    FROM delivery_grant_consumptions
    WHERE shop_id = ? AND grant_id = ?
    LIMIT 1
  `).bind(input.shopId, input.grantId).first<DownloadConsumptionRow>();
}

async function readPrivateDownloadPayload(input: {
  env: AppBindings;
  row: DownloadGrantRow;
}): Promise<PrivateDownloadPayload> {
  // File bytes stay in R2; D1 records the durable serve and request identity,
  // so a lost response can replay without another claim or quota mutation.
  const object = await mediaBucket(input.env).get(input.row.objectKey);
  if (object === null || object.httpEtag !== input.row.objectEtag) {
    throw new AppError("private_download_storage_unavailable", 503);
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== input.row.byteSize || !constantTimeEqual(input.row.contentSha256, await sha256Bytes(bytes))) {
    throw new AppError("private_download_integrity_failed", 500);
  }
  return { bytes, contentType: input.row.contentType, filename: input.row.filename };
}

export async function createPrivateDigitalAsset(input: {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  env: AppBindings;
  filename: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<PrivateDigitalAssetView> {
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_PRIVATE_FILE_BYTES) {
    throw new AppError("validation_failed", 400, ["private_asset_size_invalid"]);
  }
  const filename = sanitizePrivateDownloadFilename(input.filename);
  const contentType = normalizeContentType(input.contentType);
  const shopId = await authorizePrivateDigitalAssetUpload({ env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const assetId = createId("das");
  const assetVersionId = createId("dav");
  const objectKey = `private-digital-assets/${shopId}/${assetId}/${assetVersionId}`;
  const contentSha256 = await sha256Bytes(input.bytes);
  const nowIso = new Date().toISOString();
  const bucket = mediaBucket(input.env);
  const object = await bucket.put(objectKey, input.bytes, {
    customMetadata: { assetId, assetVersionId },
    httpMetadata: { contentType },
  });
  try {
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO digital_assets (
          id, shop_id, kind, status, created_by_user_id, created_at, updated_at
        ) SELECT ?, ?, 'private_file', 'active', ?, ?, ?
        FROM shops WHERE id = ? AND status IN ('draft', 'active')
      `).bind(assetId, shopId, input.userId, nowIso, nowIso, shopId),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO digital_asset_versions (
          id, shop_id, asset_id, version, object_key, filename_sanitized,
          content_type, byte_size, content_sha256, object_etag, status,
          created_by_user_id, created_at, updated_at
        ) SELECT ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?
        FROM digital_assets
        INNER JOIN shops ON shops.id = digital_assets.shop_id
        WHERE digital_assets.id = ? AND digital_assets.shop_id = ?
          AND digital_assets.status = 'active'
          AND shops.status IN ('draft', 'active')
      `).bind(
        assetVersionId,
        shopId,
        assetId,
        objectKey,
        filename,
        contentType,
        input.bytes.byteLength,
        contentSha256,
        object.httpEtag,
        input.userId,
        nowIso,
        nowIso,
        assetId,
        shopId,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, source_kind,
          retention_class, created_at
        ) SELECT ?, ?, 'user', ?, 'digital_asset.created', 'digital_asset', ?, ?, ?, 'application', 'security', ?
        WHERE EXISTS (
          SELECT 1 FROM digital_asset_versions WHERE id = ? AND shop_id = ?
        )
      `).bind(
        createId("aud"),
        shopId,
        input.userId,
        assetId,
        JSON.stringify({ assetVersionId, byteSize: input.bytes.byteLength, contentType }),
        input.requestId,
        nowIso,
        assetVersionId,
        shopId,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) throw new AppError("shop_inactive", 409);
  } catch (error) {
    await bucket.delete(objectKey).catch(() => undefined);
    throw error instanceof AppError ? error : new AppError("private_asset_create_failed", 409);
  }
  return { assetId, assetVersionId, byteSize: input.bytes.byteLength, contentSha256, contentType, filename, version: 1 };
}

export async function configurePrivateFilePolicy(input: {
  assetVersionId: string;
  entitlementTtlSeconds: number | null;
  env: AppBindings;
  grantTtlSeconds: number;
  maxDownloads: number;
  productId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<PrivateFilePolicyView> {
  if (!Number.isSafeInteger(input.maxDownloads) || input.maxDownloads < 1 || input.maxDownloads > 100) {
    throw new AppError("validation_failed", 400, ["private_download_max_invalid"]);
  }
  if (!Number.isSafeInteger(input.grantTtlSeconds) || input.grantTtlSeconds < 60 || input.grantTtlSeconds > 86_400) {
    throw new AppError("validation_failed", 400, ["private_download_grant_ttl_invalid"]);
  }
  if (input.entitlementTtlSeconds !== null && (!Number.isSafeInteger(input.entitlementTtlSeconds) || input.entitlementTtlSeconds < 300 || input.entitlementTtlSeconds > 31_536_000)) {
    throw new AppError("validation_failed", 400, ["private_download_entitlement_ttl_invalid"]);
  }
  const shopId = await authorizePrivateDigitalAssetUpload({ env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const source = await input.env.PLATFORM_DB.prepare(`
    SELECT products.id AS productId, digital_asset_versions.id AS assetVersionId
    FROM products
    INNER JOIN digital_asset_versions
      ON digital_asset_versions.id = ? AND digital_asset_versions.shop_id = products.shop_id
    INNER JOIN digital_assets
      ON digital_assets.id = digital_asset_versions.asset_id
      AND digital_assets.shop_id = digital_asset_versions.shop_id
    WHERE products.id = ? AND products.shop_id = ?
      AND products.fulfillment_type = 'manual'
      AND digital_assets.status = 'active'
      AND digital_asset_versions.status = 'active'
    LIMIT 1
  `).bind(input.assetVersionId, input.productId, shopId).first<{ assetVersionId: string; productId: string }>();
  if (source === null) throw new AppError("resource_not_found", 404);
  const versionRow = await input.env.PLATFORM_DB.prepare(`
    SELECT COALESCE(MAX(policy_version), 0) + 1 AS nextVersion
    FROM product_fulfillment_policies
    WHERE shop_id = ? AND product_id = ? AND capability = 'private_file'
  `).bind(shopId, input.productId).first<{ nextVersion: number }>();
  const policyVersion = versionRow?.nextVersion ?? 1;
  const policyId = createId("pfp");
  const nowIso = new Date().toISOString();
  try {
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        UPDATE product_fulfillment_policies
        SET status = 'retired', retired_at = ?, updated_at = ?
        WHERE shop_id = ? AND product_id = ? AND capability = 'private_file' AND status = 'active'
          AND EXISTS (SELECT 1 FROM shops WHERE id = ? AND status IN ('draft', 'active'))
      `).bind(nowIso, nowIso, shopId, input.productId, shopId),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO product_fulfillment_policies (
          id, shop_id, product_id, capability, policy_version, asset_version_id,
          max_downloads, grant_ttl_seconds, entitlement_ttl_seconds, status,
          created_by_user_id, created_at, updated_at
        ) SELECT ?, ?, ?, 'private_file', ?, ?, ?, ?, ?, 'active', ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM shops WHERE id = ? AND status IN ('draft', 'active'))
      `).bind(
        policyId,
        shopId,
        input.productId,
        policyVersion,
        input.assetVersionId,
        input.maxDownloads,
        input.grantTtlSeconds,
        input.entitlementTtlSeconds,
        input.userId,
        nowIso,
        nowIso,
        shopId,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, source_kind,
          retention_class, created_at
        ) SELECT ?, ?, 'user', ?, 'private_file_policy.configured', 'product_fulfillment_policy', ?, ?, ?, 'application', 'security', ?
        WHERE EXISTS (SELECT 1 FROM product_fulfillment_policies WHERE id = ? AND shop_id = ?)
      `).bind(
        createId("aud"),
        shopId,
        input.userId,
        policyId,
        JSON.stringify({ assetVersionId: input.assetVersionId, maxDownloads: input.maxDownloads, policyVersion, productId: input.productId }),
        input.requestId,
        nowIso,
        policyId,
        shopId,
      ),
    ]);
    if ((results[1]?.meta.changes ?? 0) !== 1) throw new AppError("shop_inactive", 409);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("private_file_policy_conflict", 409);
  }
  return {
    assetVersionId: input.assetVersionId,
    entitlementTtlSeconds: input.entitlementTtlSeconds,
    grantTtlSeconds: input.grantTtlSeconds,
    id: policyId,
    maxDownloads: input.maxDownloads,
    policyVersion,
    productId: input.productId,
  };
}

async function ensureRequirement(input: {
  assetVersionId: string;
  env: AppBindings;
  orderItemId: string;
  orderId: string;
  shopId: string;
}): Promise<RequirementRow> {
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT requirements.id, requirements.order_item_id AS orderItemId,
      requirements.policy_id AS policyId, requirements.policy_version AS policyVersion,
      requirements.asset_version_id AS assetVersionId,
      requirements.max_downloads AS maxDownloads,
      requirements.grant_ttl_seconds AS grantTtlSeconds,
      requirements.entitlement_ttl_seconds AS entitlementTtlSeconds,
      digital_assets.status AS assetStatus,
      digital_asset_versions.status AS assetVersionStatus
    FROM order_item_fulfillment_requirements AS requirements
    INNER JOIN digital_asset_versions
      ON digital_asset_versions.id = requirements.asset_version_id
      AND digital_asset_versions.shop_id = requirements.shop_id
    INNER JOIN digital_assets
      ON digital_assets.id = digital_asset_versions.asset_id
      AND digital_assets.shop_id = digital_asset_versions.shop_id
    WHERE requirements.shop_id = ? AND requirements.order_id = ?
      AND requirements.order_item_id = ?
      AND requirements.asset_version_id = ? AND requirements.capability = 'private_file'
    LIMIT 1
  `).bind(input.shopId, input.orderId, input.orderItemId, input.assetVersionId).first<RequirementRow>();
  if (existing !== null) return existing;

  const source = await input.env.PLATFORM_DB.prepare(`
    SELECT order_items.id AS orderItemId, policies.id AS policyId,
      policies.policy_version AS policyVersion,
      policies.asset_version_id AS assetVersionId,
      policies.max_downloads AS maxDownloads,
      policies.grant_ttl_seconds AS grantTtlSeconds,
      policies.entitlement_ttl_seconds AS entitlementTtlSeconds,
      digital_assets.status AS assetStatus,
      digital_asset_versions.status AS assetVersionStatus
    FROM order_items
    INNER JOIN product_fulfillment_policies AS policies
      ON policies.shop_id = order_items.shop_id
      AND policies.product_id = order_items.product_id
      AND policies.capability = 'private_file'
      AND policies.created_at <= order_items.created_at
      AND (policies.retired_at IS NULL OR policies.retired_at > order_items.created_at)
      AND NOT EXISTS (
        SELECT 1
        FROM product_fulfillment_policies AS newer_policy
        WHERE newer_policy.shop_id = policies.shop_id
          AND newer_policy.product_id = policies.product_id
          AND newer_policy.capability = policies.capability
          AND newer_policy.created_at <= order_items.created_at
          AND (newer_policy.retired_at IS NULL OR newer_policy.retired_at > order_items.created_at)
          AND newer_policy.policy_version > policies.policy_version
      )
    INNER JOIN digital_asset_versions
      ON digital_asset_versions.id = policies.asset_version_id
      AND digital_asset_versions.shop_id = policies.shop_id
    INNER JOIN digital_assets
      ON digital_assets.id = digital_asset_versions.asset_id
      AND digital_assets.shop_id = digital_asset_versions.shop_id
    WHERE order_items.shop_id = ? AND order_items.order_id = ?
      AND order_items.id = ?
      AND order_items.fulfillment_type = 'manual'
      AND policies.asset_version_id = ?
    LIMIT 1
  `).bind(input.shopId, input.orderId, input.orderItemId, input.assetVersionId).first<RequirementSourceRow>();
  if (source === null || source.assetStatus !== "active" || source.assetVersionStatus !== "active") {
    throw new AppError("private_download_not_found", 404);
  }
  const requirementId = createId("ofr");
  const nowIso = new Date().toISOString();
  await input.env.PLATFORM_DB.prepare(`
    INSERT OR IGNORE INTO order_item_fulfillment_requirements (
      id, shop_id, order_id, order_item_id, capability, policy_id,
      policy_version, asset_version_id, max_downloads, grant_ttl_seconds,
      entitlement_ttl_seconds, created_at
    ) VALUES (?, ?, ?, ?, 'private_file', ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    requirementId,
    input.shopId,
    input.orderId,
    source.orderItemId,
    source.policyId,
    source.policyVersion,
    source.assetVersionId,
    source.maxDownloads,
    source.grantTtlSeconds,
    source.entitlementTtlSeconds,
    nowIso,
  ).run();
  const created = await input.env.PLATFORM_DB.prepare(`
    SELECT requirements.id, requirements.order_item_id AS orderItemId,
      requirements.policy_id AS policyId, requirements.policy_version AS policyVersion,
      requirements.asset_version_id AS assetVersionId,
      requirements.max_downloads AS maxDownloads,
      requirements.grant_ttl_seconds AS grantTtlSeconds,
      requirements.entitlement_ttl_seconds AS entitlementTtlSeconds,
      digital_assets.status AS assetStatus,
      digital_asset_versions.status AS assetVersionStatus
    FROM order_item_fulfillment_requirements AS requirements
    INNER JOIN digital_asset_versions
      ON digital_asset_versions.id = requirements.asset_version_id
      AND digital_asset_versions.shop_id = requirements.shop_id
    INNER JOIN digital_assets
      ON digital_assets.id = digital_asset_versions.asset_id
      AND digital_assets.shop_id = digital_asset_versions.shop_id
    WHERE requirements.shop_id = ? AND requirements.order_id = ?
      AND requirements.order_item_id = ?
      AND requirements.asset_version_id = ? AND requirements.capability = 'private_file'
    LIMIT 1
  `).bind(input.shopId, input.orderId, input.orderItemId, input.assetVersionId).first<RequirementRow>();
  if (created === null) throw new AppError("private_download_not_found", 404);
  return created;
}

async function ensureEntitlement(input: {
  env: AppBindings;
  now: Date;
  order: AuthorizedOrderRow;
  requirement: RequirementRow;
  shopId: string;
}): Promise<EntitlementRow> {
  const entitlementId = createId("ent");
  const nowIso = input.now.toISOString();
  await input.env.PLATFORM_DB.prepare(`
    INSERT OR IGNORE INTO digital_entitlements (
      id, shop_id, order_id, order_item_id, requirement_id, asset_version_id,
      buyer_binding_hash, status, max_downloads, download_count,
      access_expires_at, version, created_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, 1, ?, ?
    FROM orders
    WHERE id = ? AND shop_id = ? AND payment_status = 'paid'
      AND status IN ('processing', 'completed')
  `).bind(
    entitlementId,
    input.shopId,
    input.order.id,
    input.requirement.orderItemId,
    input.requirement.id,
    input.requirement.assetVersionId,
    input.order.buyerBindingHash,
    input.requirement.maxDownloads,
    entitlementExpiry(input.now, input.requirement.entitlementTtlSeconds),
    nowIso,
    nowIso,
    input.order.id,
    input.shopId,
  ).run();
  const entitlement = await input.env.PLATFORM_DB.prepare(`
    SELECT id, requirement_id AS requirementId, order_item_id AS orderItemId,
      asset_version_id AS assetVersionId, buyer_binding_hash AS buyerBindingHash,
      status, max_downloads AS maxDownloads, download_count AS downloadCount,
      access_expires_at AS accessExpiresAt
    FROM digital_entitlements
    WHERE shop_id = ? AND requirement_id = ?
    LIMIT 1
  `).bind(input.shopId, input.requirement.id).first<EntitlementRow>();
  if (entitlement === null || !constantTimeEqual(entitlement.buyerBindingHash, input.order.buyerBindingHash)) {
    throw new AppError("private_download_not_found", 404);
  }
  return entitlement;
}

function assertEntitlementUsable(entitlement: EntitlementRow, now: Date): void {
  if (entitlement.status !== "active" || entitlement.downloadCount >= entitlement.maxDownloads) {
    throw new AppError("private_download_not_found", 404);
  }
  if (entitlement.accessExpiresAt !== null && Date.parse(entitlement.accessExpiresAt) <= now.getTime()) {
    throw new AppError("private_download_not_found", 404);
  }
}

async function loadGrant(env: AppBindings, shopId: string, entitlementId: string, issuanceKeyHash: string): Promise<GrantRow | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id, entitlement_id AS entitlementId, order_id AS orderId,
      order_item_id AS orderItemId, asset_version_id AS assetVersionId,
      buyer_binding_hash AS buyerBindingHash, token_nonce AS tokenNonce,
      token_hash AS tokenHash, token_key_version AS tokenKeyVersion,
      request_hash AS requestHash, status, expires_at AS expiresAt
    FROM delivery_grants
    WHERE shop_id = ? AND entitlement_id = ? AND issuance_key_hash = ?
    LIMIT 1
  `).bind(shopId, entitlementId, issuanceKeyHash).first<GrantRow>();
}

async function replayGrantView(input: {
  env: AppBindings;
  entitlement: EntitlementRow;
  requestHash: string;
  grant: GrantRow;
}): Promise<PrivateDownloadGrantView> {
  if (!constantTimeEqual(input.grant.requestHash, input.requestHash)) {
    throw new AppError("idempotency_conflict", 409);
  }
  return {
    assetVersionId: input.grant.assetVersionId,
    expiresAt: input.grant.expiresAt,
    grantId: input.grant.id,
    grantToken: await deriveGrantToken(input.env, input.grant),
    remainingDownloads: Math.max(0, input.entitlement.maxDownloads - input.entitlement.downloadCount),
  };
}

export async function listWebsitePrivateDownloads(input: {
  env: AppBindings;
  orderPublicId: string;
  orderToken: string;
  shopId: string;
  runtime?: PrivateFileRuntime;
}): Promise<PrivateDownloadView[]> {
  const order = await authorizeWebsiteOrder(input);
  assertOrderDownloadEligible(order);
  const now = nowFrom(input.runtime);
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT order_items.id AS orderItemId,
      COALESCE(requirements.asset_version_id, policies.asset_version_id) AS assetVersionId,
      digital_asset_versions.filename_sanitized AS filename,
      COALESCE(entitlements.max_downloads, requirements.max_downloads, policies.max_downloads) AS maxDownloads,
      COALESCE(entitlements.download_count, 0) AS downloadCount,
      entitlements.status AS entitlementStatus,
      entitlements.access_expires_at AS entitlementExpiresAt
    FROM order_items
    LEFT JOIN order_item_fulfillment_requirements AS requirements
      ON requirements.shop_id = order_items.shop_id
      AND requirements.order_item_id = order_items.id
      AND requirements.capability = 'private_file'
    LEFT JOIN product_fulfillment_policies AS policies
      ON requirements.id IS NULL
      AND policies.shop_id = order_items.shop_id
      AND policies.product_id = order_items.product_id
      AND policies.capability = 'private_file'
      AND policies.created_at <= order_items.created_at
      AND (policies.retired_at IS NULL OR policies.retired_at > order_items.created_at)
      AND NOT EXISTS (
        SELECT 1
        FROM product_fulfillment_policies AS newer_policy
        WHERE newer_policy.shop_id = policies.shop_id
          AND newer_policy.product_id = policies.product_id
          AND newer_policy.capability = policies.capability
          AND newer_policy.created_at <= order_items.created_at
          AND (newer_policy.retired_at IS NULL OR newer_policy.retired_at > order_items.created_at)
          AND newer_policy.policy_version > policies.policy_version
      )
    INNER JOIN digital_asset_versions
      ON digital_asset_versions.shop_id = order_items.shop_id
      AND digital_asset_versions.id = COALESCE(requirements.asset_version_id, policies.asset_version_id)
    INNER JOIN digital_assets
      ON digital_assets.shop_id = digital_asset_versions.shop_id
      AND digital_assets.id = digital_asset_versions.asset_id
    LEFT JOIN digital_entitlements AS entitlements
      ON entitlements.shop_id = requirements.shop_id
      AND entitlements.requirement_id = requirements.id
    WHERE order_items.shop_id = ? AND order_items.order_id = ?
      AND digital_assets.status = 'active'
      AND digital_asset_versions.status = 'active'
    ORDER BY order_items.id
  `).bind(input.shopId, order.id).all<{
    assetVersionId: string;
    downloadCount: number;
    entitlementExpiresAt: string | null;
    entitlementStatus: string | null;
    filename: string;
    maxDownloads: number;
    orderItemId: string;
  }>();
  return rows.results.map((row) => {
    const expired = row.entitlementExpiresAt !== null && Date.parse(row.entitlementExpiresAt) <= now.getTime();
    const status = expired ? "expired" : row.entitlementStatus;
    const remainingDownloads = status !== null && status !== "active"
      ? 0
      : Math.max(0, row.maxDownloads - row.downloadCount);
    return { ...row, entitlementStatus: status, remainingDownloads };
  });
}

export async function issueWebsitePrivateDownloadGrant(input: {
  assetVersionId: string;
  env: AppBindings;
  idempotencyKey: string;
  orderItemId: string;
  orderPublicId: string;
  orderToken: string;
  requestId: string;
  runtime?: PrivateFileRuntime;
  shopId: string;
}): Promise<PrivateDownloadGrantView> {
  assertIdempotencyKey(input.idempotencyKey);
  const order = await authorizeWebsiteOrder(input);
  assertOrderDownloadEligible(order);
  const now = nowFrom(input.runtime);
  const requirement = await ensureRequirement({ assetVersionId: input.assetVersionId, env: input.env, orderId: order.id, orderItemId: input.orderItemId, shopId: input.shopId });
  if (requirement.assetStatus !== "active" || requirement.assetVersionStatus !== "active") {
    throw new AppError("private_download_not_found", 404);
  }
  const entitlement = await ensureEntitlement({ env: input.env, now, order, requirement, shopId: input.shopId });
  assertEntitlementUsable(entitlement, now);
  const issuanceKeyHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `private-download-issuance:${entitlement.id}`, input.idempotencyKey);
  const requestHash = await sha256Json({ assetVersionId: input.assetVersionId, orderId: order.id, orderItemId: input.orderItemId, shopId: input.shopId });
  await input.env.PLATFORM_DB.prepare(`
    UPDATE delivery_grants
    SET status = 'expired', version = version + 1, updated_at = ?
    WHERE shop_id = ? AND entitlement_id = ?
      AND status = 'active' AND expires_at <= ?
  `).bind(now.toISOString(), input.shopId, entitlement.id, now.toISOString()).run();
  const replay = await loadGrant(input.env, input.shopId, entitlement.id, issuanceKeyHash);
  if (replay !== null) {
    return replayGrantView({ entitlement, env: input.env, grant: replay, requestHash });
  }
  const active = await input.env.PLATFORM_DB.prepare(`
    SELECT 1 AS active FROM delivery_grants
    WHERE shop_id = ? AND entitlement_id = ? AND status = 'active' AND expires_at > ?
    LIMIT 1
  `).bind(input.shopId, entitlement.id, now.toISOString()).first<{ active: number }>();
  if (active !== null) throw new AppError("private_download_grant_active", 409);

  const grantId = createId("dgr");
  const tokenNonce = createOpaqueToken(32);
  const unsignedGrant: GrantRow = {
    assetVersionId: entitlement.assetVersionId,
    buyerBindingHash: entitlement.buyerBindingHash,
    entitlementId: entitlement.id,
    expiresAt: grantExpiry(now, requirement.grantTtlSeconds, entitlement.accessExpiresAt),
    id: grantId,
    orderId: order.id,
    orderItemId: entitlement.orderItemId,
    requestHash,
    status: "active",
    tokenHash: "",
    tokenKeyVersion: TOKEN_KEY_VERSION,
    tokenNonce,
  };
  const grantToken = await deriveGrantToken(input.env, unsignedGrant);
  const tokenHash = await hashGrantToken(input.env, {
    assetVersionId: unsignedGrant.assetVersionId,
    buyerBindingHash: unsignedGrant.buyerBindingHash,
    grantId,
    orderId: order.id,
    token: grantToken,
  });
  const nowIso = now.toISOString();
  let results: D1Result[];
  try {
    results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO delivery_grants (
          id, shop_id, entitlement_id, order_id, order_item_id,
          asset_version_id, buyer_binding_hash, token_nonce, token_hash,
          token_key_version, issuance_key_hash, request_hash, status,
          expires_at, version, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 1, ?, ?
        FROM digital_entitlements
        INNER JOIN orders
          ON orders.id = digital_entitlements.order_id
          AND orders.shop_id = digital_entitlements.shop_id
        WHERE digital_entitlements.id = ? AND digital_entitlements.shop_id = ? AND digital_entitlements.status = 'active'
          AND download_count < max_downloads
          AND (access_expires_at IS NULL OR access_expires_at > ?)
          AND orders.payment_status = 'paid'
          AND orders.status IN ('processing', 'completed')
          AND NOT EXISTS (
            SELECT 1 FROM delivery_grants
            WHERE shop_id = ? AND entitlement_id = ? AND status = 'active'
          )
      `).bind(
        grantId,
        input.shopId,
        entitlement.id,
        order.id,
        entitlement.orderItemId,
        entitlement.assetVersionId,
        entitlement.buyerBindingHash,
        tokenNonce,
        tokenHash,
        TOKEN_KEY_VERSION,
        issuanceKeyHash,
        requestHash,
        unsignedGrant.expiresAt,
        nowIso,
        nowIso,
        entitlement.id,
        input.shopId,
        nowIso,
        input.shopId,
        entitlement.id,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, source_kind,
          retention_class, created_at
        ) SELECT ?, ?, 'system', NULL, 'delivery_grant.issued', 'delivery_grant', ?, ?, ?, 'http', 'security', ?
        WHERE EXISTS (SELECT 1 FROM delivery_grants WHERE id = ? AND shop_id = ?)
      `).bind(
        createId("aud"),
        input.shopId,
        grantId,
        JSON.stringify({ assetVersionId: entitlement.assetVersionId, entitlementId: entitlement.id, orderId: order.id }),
        input.requestId,
        nowIso,
        grantId,
        input.shopId,
      ),
    ]);
  } catch {
    const raced = await loadGrant(input.env, input.shopId, entitlement.id, issuanceKeyHash);
    if (raced !== null) return replayGrantView({ entitlement, env: input.env, grant: raced, requestHash });
    throw new AppError("private_download_grant_active", 409);
  }
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const raced = await loadGrant(input.env, input.shopId, entitlement.id, issuanceKeyHash);
    if (raced !== null) return replayGrantView({ entitlement, env: input.env, grant: raced, requestHash });
    throw new AppError("private_download_grant_active", 409);
  }
  return {
    assetVersionId: entitlement.assetVersionId,
    expiresAt: unsignedGrant.expiresAt,
    grantId,
    grantToken,
    remainingDownloads: Math.max(0, entitlement.maxDownloads - entitlement.downloadCount),
  };
}

export async function consumeWebsitePrivateDownloadGrant(input: {
  env: AppBindings;
  grantId: string;
  grantToken: string;
  idempotencyKey: string;
  orderPublicId: string;
  orderToken: string;
  requestId: string;
  runtime?: PrivateFileRuntime;
  shopId: string;
}): Promise<PrivateDownloadPayload> {
  assertIdempotencyKey(input.idempotencyKey);
  assertGrantTokenShape(input.grantId, input.grantToken);
  const order = await authorizeWebsiteOrder(input);
  assertOrderDownloadEligible(order);
  const now = nowFrom(input.runtime);
  const nowIso = now.toISOString();
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT grants.id, grants.entitlement_id AS entitlementId,
      grants.order_id AS orderId, grants.order_item_id AS orderItemId,
      grants.asset_version_id AS assetVersionId,
      grants.buyer_binding_hash AS buyerBindingHash,
      grants.token_nonce AS tokenNonce, grants.token_hash AS tokenHash,
      grants.token_key_version AS tokenKeyVersion,
      grants.request_hash AS requestHash, grants.status,
      grants.expires_at AS expiresAt,
      entitlements.status AS entitlementStatus,
      entitlements.download_count AS downloadCount,
      entitlements.max_downloads AS maxDownloads,
      entitlements.access_expires_at AS accessExpiresAt,
      digital_assets.status AS assetStatus,
      digital_asset_versions.status AS assetVersionStatus,
      digital_asset_versions.object_key AS objectKey,
      digital_asset_versions.object_etag AS objectEtag,
      digital_asset_versions.filename_sanitized AS filename,
      digital_asset_versions.content_type AS contentType,
      digital_asset_versions.byte_size AS byteSize,
      digital_asset_versions.content_sha256 AS contentSha256
    FROM delivery_grants AS grants
    INNER JOIN digital_entitlements AS entitlements
      ON entitlements.id = grants.entitlement_id
      AND entitlements.shop_id = grants.shop_id
    INNER JOIN digital_asset_versions
      ON digital_asset_versions.id = grants.asset_version_id
      AND digital_asset_versions.shop_id = grants.shop_id
    INNER JOIN digital_assets
      ON digital_assets.id = digital_asset_versions.asset_id
      AND digital_assets.shop_id = digital_asset_versions.shop_id
    WHERE grants.id = ? AND grants.shop_id = ? AND grants.order_id = ?
    LIMIT 1
  `).bind(input.grantId, input.shopId, order.id).first<DownloadGrantRow>();
  if (row === null
    || row.assetStatus !== "active"
    || row.assetVersionStatus !== "active"
    || !constantTimeEqual(row.buyerBindingHash, order.buyerBindingHash)
    || row.tokenKeyVersion !== TOKEN_KEY_VERSION) {
    throw new AppError("private_download_grant_not_found", 404);
  }
  const tokenHash = await hashGrantToken(input.env, {
    assetVersionId: row.assetVersionId,
    buyerBindingHash: row.buyerBindingHash,
    grantId: row.id,
    orderId: row.orderId,
    token: input.grantToken,
  });
  if (!constantTimeEqual(row.tokenHash, tokenHash)) throw new AppError("private_download_grant_not_found", 404);

  if (row.status === "consumed") {
    if (row.expiresAt <= nowIso || (row.accessExpiresAt !== null && row.accessExpiresAt <= nowIso)) {
      throw new AppError("private_download_grant_not_found", 404);
    }
    const consumption = await loadWebsitePrivateDownloadConsumption({ env: input.env, grantId: row.id, shopId: input.shopId });
    if (consumption === null || consumption.idempotencyKey !== input.idempotencyKey) {
      throw new AppError("private_download_grant_not_found", 404);
    }
    return readPrivateDownloadPayload({ env: input.env, row });
  }

  if (row.status !== "active"
    || row.entitlementStatus !== "active"
    || row.expiresAt <= nowIso
    || row.downloadCount >= row.maxDownloads
    || (row.accessExpiresAt !== null && row.accessExpiresAt <= nowIso)) {
    throw new AppError("private_download_grant_not_found", 404);
  }

  let claimId: string | null = null;
  try {
    claimId = await claimWebsitePrivateDownload({
      env: input.env,
      grantId: row.id,
      now,
      orderId: order.id,
      row,
      shopId: input.shopId,
    });

    const payload = await readPrivateDownloadPayload({ env: input.env, row });

    const finalizedIso = nowFrom(input.runtime).toISOString();
    const consumptionId = createId("dgc");
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO delivery_grant_consumptions (
          id, shop_id, entitlement_id, grant_id, order_id,
          asset_version_id, request_id, outcome, created_at
        ) SELECT ?, grants.shop_id, grants.entitlement_id, grants.id,
          grants.order_id, grants.asset_version_id, ?, 'served', ?
        FROM delivery_grants AS grants
        INNER JOIN delivery_grant_claims AS claims
          ON claims.id = ?
          AND claims.shop_id = grants.shop_id
          AND claims.grant_id = grants.id
          AND claims.lease_expires_at > ?
        INNER JOIN digital_entitlements AS entitlements
          ON entitlements.id = grants.entitlement_id
          AND entitlements.shop_id = grants.shop_id
        INNER JOIN orders
          ON orders.id = grants.order_id
          AND orders.shop_id = grants.shop_id
        INNER JOIN digital_asset_versions
          ON digital_asset_versions.id = grants.asset_version_id
          AND digital_asset_versions.shop_id = grants.shop_id
        INNER JOIN digital_assets
          ON digital_assets.id = digital_asset_versions.asset_id
          AND digital_assets.shop_id = digital_asset_versions.shop_id
        WHERE grants.id = ? AND grants.shop_id = ? AND grants.order_id = ?
          AND grants.status = 'active' AND grants.expires_at > ?
          AND entitlements.status = 'active'
          AND entitlements.download_count < entitlements.max_downloads
          AND (entitlements.access_expires_at IS NULL OR entitlements.access_expires_at > ?)
          AND orders.payment_status = 'paid'
          AND orders.status IN ('processing', 'completed')
          AND digital_assets.status = 'active'
          AND digital_asset_versions.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM delivery_grant_consumptions
            WHERE shop_id = grants.shop_id AND grant_id = grants.id
          )
      `).bind(
        consumptionId,
        input.idempotencyKey,
        finalizedIso,
        claimId,
        finalizedIso,
        row.id,
        input.shopId,
        order.id,
        finalizedIso,
        finalizedIso,
      ),
      input.env.PLATFORM_DB.prepare(`
        UPDATE delivery_grants
        SET status = 'consumed', consumed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND shop_id = ? AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM delivery_grant_consumptions
            WHERE id = ? AND shop_id = delivery_grants.shop_id
              AND grant_id = delivery_grants.id
          )
      `).bind(finalizedIso, finalizedIso, row.id, input.shopId, consumptionId),
      input.env.PLATFORM_DB.prepare(`
        UPDATE digital_entitlements
        SET download_count = download_count + 1,
          status = CASE WHEN download_count + 1 >= max_downloads THEN 'exhausted' ELSE status END,
          exhausted_at = CASE WHEN download_count + 1 >= max_downloads THEN ? ELSE exhausted_at END,
          version = version + 1, updated_at = ?
        WHERE id = ? AND shop_id = ? AND status = 'active'
          AND download_count < max_downloads
          AND EXISTS (
            SELECT 1 FROM delivery_grant_consumptions
            WHERE id = ? AND shop_id = digital_entitlements.shop_id
              AND entitlement_id = digital_entitlements.id
          )
      `).bind(finalizedIso, finalizedIso, row.entitlementId, input.shopId, consumptionId),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, source_kind,
          retention_class, created_at
        ) SELECT ?, ?, 'system', NULL, 'delivery_grant.consumed', 'delivery_grant', ?, ?, ?, 'http', 'security', ?
        WHERE EXISTS (
          SELECT 1 FROM delivery_grant_consumptions
          WHERE id = ? AND shop_id = ? AND grant_id = ?
        )
      `).bind(
        createId("aud"),
        input.shopId,
        row.id,
        JSON.stringify({ assetVersionId: row.assetVersionId, entitlementId: row.entitlementId, orderId: order.id }),
        input.requestId,
        finalizedIso,
        consumptionId,
        input.shopId,
        row.id,
      ),
      input.env.PLATFORM_DB.prepare(`
        DELETE FROM delivery_grant_claims
        WHERE id = ? AND shop_id = ? AND grant_id = ?
          AND EXISTS (
            SELECT 1 FROM delivery_grant_consumptions
            WHERE id = ? AND shop_id = delivery_grant_claims.shop_id
              AND grant_id = delivery_grant_claims.grant_id
          )
      `).bind(claimId, input.shopId, row.id, consumptionId),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) throw new AppError("private_download_grant_not_found", 404);
    claimId = null;
    return payload;
  } catch (error) {
    if (claimId !== null) {
      await releaseWebsitePrivateDownloadClaim({ env: input.env, claimId, grantId: row.id, shopId: input.shopId });
    }
    throw error;
  }
}

export async function revokePrivateDownloadEntitlement(input: {
  entitlementId: string;
  env: AppBindings;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<void> {
  const member = await getShopForMember({ capability: "catalog:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const nowIso = new Date().toISOString();
  const results = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      UPDATE digital_entitlements
      SET status = 'revoked', revoked_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND status IN ('active', 'suspended')
    `).bind(nowIso, nowIso, input.entitlementId, member.row.shop_id),
    input.env.PLATFORM_DB.prepare(`
      UPDATE delivery_grants
      SET status = 'revoked', revoked_at = ?, version = version + 1, updated_at = ?
      WHERE entitlement_id = ? AND shop_id = ? AND status = 'active'
    `).bind(nowIso, nowIso, input.entitlementId, member.row.shop_id),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, source_kind,
        retention_class, created_at
      ) SELECT ?, ?, 'user', ?, 'digital_entitlement.revoked', 'digital_entitlement', ?, '{}', ?, 'application', 'security', ?
      WHERE EXISTS (
        SELECT 1 FROM digital_entitlements WHERE id = ? AND shop_id = ? AND status = 'revoked'
      )
    `).bind(
      createId("aud"),
      member.row.shop_id,
      input.userId,
      input.entitlementId,
      input.requestId,
      nowIso,
      input.entitlementId,
      member.row.shop_id,
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw new AppError("resource_not_found", 404);
}
