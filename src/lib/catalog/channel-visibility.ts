import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";
import {
  assertChannelProviderExecutionReady,
  isChannelCatalogPublishingAllowed,
  platformChannelRegistry,
} from "../channels/expansion";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;

type VisibilityStatus = "hidden" | "visible";

type VisibilityRow = {
  channelCode: string;
  createdAt: string;
  productId: string;
  productSlug: string;
  productStatus: string;
  productTitle: string;
  shopId: string;
  status: VisibilityStatus;
  updatedAt: string;
  updatedByUserId: string | null;
  version: number;
};

type StoredReplay = {
  request_hash: string;
  response_json: string;
};

export type CatalogChannelVisibility = Omit<VisibilityRow, "shopId">;

function requireIdempotencyKey(value: string | null): string {
  if (value === null || !IDEMPOTENCY_KEY.test(value)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
  }
  return value;
}

function requireChannelCode(value: string): string {
  if (!/^[a-z][a-z0-9._:-]{0,63}$/u.test(value) || platformChannelRegistry.get(value) === null) {
    throw new AppError("validation_failed", 400, ["channel_code_invalid"]);
  }
  return value;
}

function requireProductId(value: string): string {
  if (!/^prd_[0-9a-f-]{36}$/u.test(value)) {
    throw new AppError("validation_failed", 400, ["product_id_invalid"]);
  }
  return value;
}

function requireExpectedVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AppError("validation_failed", 400, ["expected_version_invalid"]);
  }
  return value;
}

function mapRow(row: VisibilityRow): CatalogChannelVisibility {
  return {
    channelCode: row.channelCode,
    createdAt: row.createdAt,
    productId: row.productId,
    productSlug: row.productSlug,
    productStatus: row.productStatus,
    productTitle: row.productTitle,
    status: isChannelCatalogPublishingAllowed(row.channelCode) ? row.status : "hidden",
    updatedAt: row.updatedAt,
    updatedByUserId: row.updatedByUserId,
    version: row.version,
  };
}

function parseReplay(value: string): CatalogChannelVisibility {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
    ) throw new Error("catalog_visibility_replay_invalid");
    const row = parsed as Partial<VisibilityRow>;
    if (
      typeof row.productId !== "string"
      || typeof row.channelCode !== "string"
      || (row.status !== "visible" && row.status !== "hidden")
      || !Number.isSafeInteger(row.version)
    ) throw new Error("catalog_visibility_replay_invalid");
    return mapRow(row as VisibilityRow);
  } catch {
    throw new AppError("catalog_visibility_replay_invalid", 500);
  }
}

async function loadVisibility(input: {
  channelCode: string;
  env: AppBindings;
  productId: string;
  shopId: string;
}): Promise<VisibilityRow | null> {
  return input.env.PLATFORM_DB.prepare(`
    SELECT visibility.shop_id AS shopId,
      visibility.product_id AS productId,
      visibility.channel_code AS channelCode,
      visibility.status,
      visibility.version,
      visibility.updated_by_user_id AS updatedByUserId,
      visibility.created_at AS createdAt,
      visibility.updated_at AS updatedAt,
      products.slug AS productSlug,
      products.status AS productStatus,
      products.title AS productTitle
    FROM catalog_channel_visibility AS visibility
    INNER JOIN products
      ON products.id = visibility.product_id
      AND products.shop_id = visibility.shop_id
    WHERE visibility.shop_id = ?
      AND visibility.product_id = ?
      AND visibility.channel_code = ?
    LIMIT 1
  `).bind(input.shopId, input.productId, input.channelCode).first<VisibilityRow>();
}

export async function listCatalogChannelVisibility(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<readonly CatalogChannelVisibility[]> {
  // Channel visibility is draft-stage catalog setup; pending-payment shops may
  // configure it before checkout. Publishing is gated separately by readiness.
  const actor = await getShopForMember({
    capability: "catalog:manage",
    env: input.env,
    shopPublicId: input.shopPublicId,
    subscriptionAction: "draft_setup",
    userId: input.userId,
  });
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT visibility.shop_id AS shopId,
      visibility.product_id AS productId,
      visibility.channel_code AS channelCode,
      visibility.status,
      visibility.version,
      visibility.updated_by_user_id AS updatedByUserId,
      visibility.created_at AS createdAt,
      visibility.updated_at AS updatedAt,
      products.slug AS productSlug,
      products.status AS productStatus,
      products.title AS productTitle
    FROM catalog_channel_visibility AS visibility
    INNER JOIN products
      ON products.id = visibility.product_id
      AND products.shop_id = visibility.shop_id
    WHERE visibility.shop_id = ?
    ORDER BY products.created_at, products.id, visibility.channel_code
    LIMIT 5000
  `).bind(actor.row.shop_id).all<VisibilityRow>();
  return rows.results.map(mapRow);
}

export async function setCatalogChannelVisibility(input: {
  channelCode: string;
  env: AppBindings;
  expectedVersion: number;
  idempotencyKey: string | null;
  productId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
  visible: boolean;
}): Promise<{ projection: CatalogChannelVisibility; replayed: boolean }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const channelCode = requireChannelCode(input.channelCode);
  const productId = requireProductId(input.productId);
  const expectedVersion = requireExpectedVersion(input.expectedVersion);
  if (typeof input.visible !== "boolean") {
    throw new AppError("validation_failed", 400, ["visible_invalid"]);
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(input.requestId)) {
    throw new AppError("validation_failed", 400, ["request_id_invalid"]);
  }

  const actor = await getShopForMember({
    capability: "catalog:manage",
    env: input.env,
    shopPublicId: input.shopPublicId,
    subscriptionAction: "draft_setup",
    userId: input.userId,
  });
  const product = await input.env.PLATFORM_DB.prepare(`
    SELECT id, slug AS productSlug, status AS productStatus, title AS productTitle
    FROM products
    WHERE id = ? AND shop_id = ?
    LIMIT 1
  `).bind(productId, actor.row.shop_id).first<{ id: string; productSlug: string; productStatus: string; productTitle: string }>();
  if (product === null) throw new AppError("resource_not_found", 404);
  if (input.visible) assertChannelProviderExecutionReady(channelCode);

  const namespace = `catalog-channel-visibility.set.v1:${actor.row.shop_id}:${productId}:${channelCode}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "catalog-channel-visibility-idempotency:v1", idempotencyKey);
  const requestHash = await sha256Json({
    channelCode,
    expectedVersion,
    productId,
    shopId: actor.row.shop_id,
    visible: input.visible,
  });
  const now = new Date();
  const nowIso = now.toISOString();
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash, response_json
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(input.userId, namespace, keyHash, nowIso).first<StoredReplay>();
  if (existing !== null) {
    if (existing.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    return { projection: parseReplay(existing.response_json), replayed: true };
  }

  const current = await loadVisibility({ channelCode, env: input.env, productId, shopId: actor.row.shop_id });
  if (current === null && expectedVersion !== 0) throw new AppError("version_conflict", 409);
  if (current !== null && expectedVersion !== current.version) throw new AppError("version_conflict", 409);
  const nextVersion = expectedVersion === 0 ? 1 : expectedVersion + 1;
  const projection: VisibilityRow = {
    channelCode,
    createdAt: current?.createdAt ?? nowIso,
    productId,
    productSlug: current?.productSlug ?? product.productSlug,
    productStatus: current?.productStatus ?? product.productStatus,
    productTitle: current?.productTitle ?? product.productTitle,
    shopId: actor.row.shop_id,
    status: input.visible ? "visible" : "hidden",
    updatedAt: nowIso,
    updatedByUserId: input.userId,
    version: nextVersion,
  };
  const responseJson = JSON.stringify(projection);
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();

  try {
    const mutation = await input.env.PLATFORM_DB.batch([
      expectedVersion === 0
        ? input.env.PLATFORM_DB.prepare(`
            INSERT INTO catalog_channel_visibility (
              shop_id, product_id, channel_code, status, version,
              updated_by_user_id, created_at, updated_at
            ) SELECT ?, ?, ?, ?, 1, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM catalog_channel_visibility
              WHERE shop_id = ? AND product_id = ? AND channel_code = ?
            )
          `).bind(actor.row.shop_id, productId, channelCode, projection.status, input.userId, nowIso, nowIso, actor.row.shop_id, productId, channelCode)
        : input.env.PLATFORM_DB.prepare(`
            UPDATE catalog_channel_visibility
            SET status = ?, version = version + 1,
              updated_by_user_id = ?, updated_at = ?
            WHERE shop_id = ? AND product_id = ? AND channel_code = ?
              AND version = ?
          `).bind(projection.status, input.userId, nowIso, actor.row.shop_id, productId, channelCode, expectedVersion),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, created_at
        ) SELECT ?, ?, 'user', ?, 'catalog.channel_visibility.updated',
          'catalog_channel_visibility', ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM catalog_channel_visibility
          WHERE shop_id = ? AND product_id = ? AND channel_code = ?
            AND version = ? AND status = ?
        )
      `).bind(createId("aud"), actor.row.shop_id, input.userId, productId, JSON.stringify({ channelCode, status: projection.status, version: nextVersion }), input.requestId, nowIso, actor.row.shop_id, productId, channelCode, nextVersion, projection.status),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO idempotency_records (
          actor_user_id, namespace, key_hash, request_hash, response_json,
          created_at, expires_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM catalog_channel_visibility
          WHERE shop_id = ? AND product_id = ? AND channel_code = ?
            AND version = ? AND status = ?
        )
      `).bind(input.userId, namespace, keyHash, requestHash, responseJson, nowIso, expiresAt, actor.row.shop_id, productId, channelCode, nextVersion, projection.status),
    ]);
    if ((mutation[0]?.meta.changes ?? 0) !== 1 || (mutation[1]?.meta.changes ?? 0) !== 1 || (mutation[2]?.meta.changes ?? 0) !== 1) {
      throw new AppError("version_conflict", 409);
    }
  } catch (error) {
    const replay = await input.env.PLATFORM_DB.prepare(`
      SELECT request_hash, response_json
      FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      LIMIT 1
    `).bind(input.userId, namespace, keyHash).first<StoredReplay>();
    if (replay !== null) {
      if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
      return { projection: parseReplay(replay.response_json), replayed: true };
    }
    if (error instanceof AppError) throw error;
    throw new AppError("catalog_visibility_conflict", 409);
  }
  return { projection: mapRow(projection), replayed: false };
}
