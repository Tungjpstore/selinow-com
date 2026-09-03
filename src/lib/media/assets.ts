import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { getPlanLimit } from "../tenants/policy";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";

export const MAX_MEDIA_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PRODUCT_IMAGES_PER_PRODUCT = 12;

export type MediaAssetKind = "product_image" | "shop_logo" | "hero_banner";

const MEDIA_CONTENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/avif"]);

export type MediaAssetView = {
  byteSize: number;
  contentSha256: string;
  contentType: string;
  id: string;
  kind: MediaAssetKind;
  publicId: string;
};

export type ProductImageView = {
  contentType: string;
  imageId: string;
  mediaUrl: string;
  publicId: string;
  sortOrder: number;
};

export function mediaAssetUrl(publicId: string): string {
  return `/media/${publicId}`;
}

/** Magic-byte sniffing keeps the claimed content type honest before storing. */
export function sniffImageContentType(bytes: Uint8Array): string | null {
  const startsWith = (signature: number[], offset = 0): boolean =>
    signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  // RIFF....WEBP
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  // ISO-BMFF: ....ftyp<brand>, brand avif/avis
  if (startsWith([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

async function sha256Hex(value: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function authorizeMediaUpload(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<{ limitsJson: string; shopId: string }> {
  const member = await getShopForMember({ capability: "catalog:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  if (member.row.shop_status !== "active" && member.row.shop_status !== "draft") {
    throw new AppError("shop_inactive", 409);
  }
  return { limitsJson: member.row.limits_json, shopId: member.row.shop_id };
}

async function mediaStorageUsage(database: AppBindings["PLATFORM_DB"], shopId: string): Promise<number> {
  const row = await database.prepare(`
    SELECT COALESCE(SUM(byte_size), 0) AS totalBytes
    FROM media_assets
    WHERE shop_id = ? AND status = 'active'
  `).bind(shopId).first<{ totalBytes: number }>();
  return row?.totalBytes ?? 0;
}

export async function createMediaAsset(input: {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  env: AppBindings;
  kind: MediaAssetKind;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<MediaAssetView> {
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_MEDIA_IMAGE_BYTES) {
    throw new AppError("validation_failed", 400, ["media_asset_size_invalid"]);
  }
  const claimed = input.contentType.trim().toLowerCase();
  const sniffed = sniffImageContentType(input.bytes);
  if (!MEDIA_CONTENT_TYPES.has(claimed) || sniffed === null || sniffed !== claimed) {
    throw new AppError("validation_failed", 400, ["media_asset_content_type_invalid"]);
  }
  const { limitsJson, shopId } = await authorizeMediaUpload(input);
  const storageLimit = getPlanLimit(limitsJson, "storageBytes");
  if (storageLimit !== null && await mediaStorageUsage(input.env.PLATFORM_DB, shopId) + input.bytes.byteLength > storageLimit) {
    throw new AppError("quota_exceeded", 409, ["storage_bytes"]);
  }
  const assetId = createId("mda");
  const publicId = createId("mdp");
  const objectKey = `storefront-media/${shopId}/${assetId}`;
  const contentSha256 = await sha256Hex(input.bytes);
  const nowIso = new Date().toISOString();
  const object = await input.env.MEDIA.put(objectKey, input.bytes, {
    customMetadata: { assetId, shopId },
    httpMetadata: { contentType: claimed, cacheControl: "public, max-age=31536000, immutable" },
  });
  try {
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO media_assets (
          id, shop_id, public_id, kind, object_key, content_type, byte_size,
          content_sha256, object_etag, status, created_by_user_id, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?
        FROM shops WHERE id = ? AND status IN ('draft', 'active')
      `).bind(assetId, shopId, publicId, input.kind, objectKey, claimed, input.bytes.byteLength, contentSha256, object.httpEtag, input.userId, nowIso, nowIso, shopId),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, source_kind,
          retention_class, created_at
        ) SELECT ?, ?, 'user', ?, 'media_asset.created', 'media_asset', ?, ?, ?, 'application', 'standard', ?
        WHERE EXISTS (SELECT 1 FROM media_assets WHERE id = ? AND shop_id = ?)
      `).bind(
        createId("aud"),
        shopId,
        input.userId,
        assetId,
        JSON.stringify({ byteSize: input.bytes.byteLength, contentType: claimed, kind: input.kind }),
        input.requestId,
        nowIso,
        assetId,
        shopId,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) throw new AppError("shop_inactive", 409);
  } catch (error) {
    await input.env.MEDIA.delete(objectKey).catch(() => undefined);
    throw error instanceof AppError ? error : new AppError("media_asset_create_failed", 409);
  }
  return { byteSize: input.bytes.byteLength, contentSha256, contentType: claimed, id: assetId, kind: input.kind, publicId };
}

export type PublicMediaAsset = {
  contentType: string;
  objectKey: string;
  objectEtag: string;
};

/** Public storefront lookup by opaque public id; deleted assets 404. */
export async function getPublicMediaAsset(env: AppBindings, publicId: string): Promise<PublicMediaAsset | null> {
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(publicId)) return null;
  const row = await env.PLATFORM_DB.prepare(`
    SELECT content_type AS contentType, object_etag AS objectEtag, object_key AS objectKey
    FROM media_assets
    WHERE public_id = ? AND status = 'active'
    LIMIT 1
  `).bind(publicId).first<PublicMediaAsset>();
  return row ?? null;
}

export async function attachProductImage(input: {
  env: AppBindings;
  mediaAssetPublicId: string;
  productId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<ProductImageView> {
  const { shopId } = await authorizeMediaUpload(input);
  const countRow = await input.env.PLATFORM_DB.prepare(`
    SELECT COUNT(*) AS total
    FROM product_images
    WHERE shop_id = ? AND product_id = ? AND status = 'active'
  `).bind(shopId, input.productId).first<{ total: number }>();
  if ((countRow?.total ?? 0) >= MAX_PRODUCT_IMAGES_PER_PRODUCT) {
    throw new AppError("validation_failed", 400, ["product_image_limit_reached"]);
  }
  const sortRow = await input.env.PLATFORM_DB.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextSortOrder
    FROM product_images
    WHERE shop_id = ? AND product_id = ? AND status = 'active'
  `).bind(shopId, input.productId).first<{ nextSortOrder: number }>();
  const imageId = createId("pim");
  const nowIso = new Date().toISOString();
  // The composite foreign keys on product_images enforce that the product and
  // the media asset both belong to this shop; a miss surfaces as resource_not_found.
  const inserted = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO product_images (id, shop_id, product_id, media_asset_id, sort_order, status, created_at, updated_at)
    SELECT ?, ?, products.id, media_assets.id, ?, 'active', ?, ?
    FROM products, media_assets
    WHERE products.shop_id = ? AND products.id = ?
      AND media_assets.shop_id = ? AND media_assets.public_id = ? AND media_assets.status = 'active'
    RETURNING sort_order AS sortOrder
  `).bind(imageId, shopId, sortRow?.nextSortOrder ?? 0, nowIso, nowIso, shopId, input.productId, shopId, input.mediaAssetPublicId)
    .first<{ sortOrder: number }>();
  if (inserted === null) throw new AppError("resource_not_found", 404);
  const assetRow = await input.env.PLATFORM_DB.prepare(`
    SELECT media_assets.public_id AS publicId, media_assets.content_type AS contentType
    FROM product_images
    INNER JOIN media_assets ON media_assets.shop_id = product_images.shop_id AND media_assets.id = product_images.media_asset_id
    WHERE product_images.shop_id = ? AND product_images.id = ?
    LIMIT 1
  `).bind(shopId, imageId).first<{ contentType: string; publicId: string }>();
  if (assetRow === null) throw new AppError("resource_not_found", 404);
  return {
    contentType: assetRow.contentType,
    imageId,
    mediaUrl: mediaAssetUrl(assetRow.publicId),
    publicId: assetRow.publicId,
    sortOrder: inserted.sortOrder,
  };
}

export async function detachProductImage(input: {
  env: AppBindings;
  imageId: string;
  productId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<void> {
  const { shopId } = await authorizeMediaUpload(input);
  const nowIso = new Date().toISOString();
  const updated = await input.env.PLATFORM_DB.prepare(`
    UPDATE product_images
    SET status = 'deleted', deleted_at = ?, updated_at = ?
    WHERE shop_id = ? AND id = ? AND product_id = ? AND status = 'active'
    RETURNING id
  `).bind(nowIso, nowIso, shopId, input.imageId, input.productId).first<{ id: string }>();
  if (updated === null) throw new AppError("resource_not_found", 404);
}

export async function listProductImages(input: {
  env: AppBindings;
  productId: string;
  shopPublicId: string;
  userId: string;
}): Promise<ProductImageView[]> {
  const member = await getShopForMember({ capability: "catalog:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT product_images.id AS imageId, product_images.sort_order AS sortOrder,
      media_assets.public_id AS publicId, media_assets.content_type AS contentType
    FROM product_images
    INNER JOIN media_assets
      ON media_assets.shop_id = product_images.shop_id
      AND media_assets.id = product_images.media_asset_id
      AND media_assets.status = 'active'
    WHERE product_images.shop_id = ? AND product_images.product_id = ? AND product_images.status = 'active'
    ORDER BY product_images.sort_order, product_images.id
  `).bind(member.row.shop_id, input.productId).all<{ contentType: string; imageId: string; publicId: string; sortOrder: number }>();
  return rows.results.map((row) => ({
    contentType: row.contentType,
    imageId: row.imageId,
    mediaUrl: mediaAssetUrl(row.publicId),
    publicId: row.publicId,
    sortOrder: row.sortOrder,
  }));
}
