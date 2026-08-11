import { encryptInventoryKey } from "../crypto/inventory";
import { resolveActiveEncryptionKey } from "../crypto/keyring";
import { hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { tryRecordActivationMilestone } from "../analytics/activation";
import { recordUsage } from "../billing/metering";
import { isSupportedCurrency } from "../i18n/currency";
import type { AppBindings } from "../platform/bindings";
import { publishReadyStorefront } from "../tenants/readiness";
import { getShopForMember } from "../tenants/store";
import {
  analyzeInventoryImport,
  createInventoryImportPlan,
  createInventoryPreviewToken,
  type InventoryImportAnalysis,
  type InventoryImportPlan,
  type InventoryImportSource,
  type InventoryImportSummary,
  verifyInventoryPreviewToken,
} from "./import-preview";

type ShopActor = { currency: string; limits: Record<string, unknown>; shopId: string };

async function requireCatalogActor(env: AppBindings, shopPublicId: string, userId: string, subscriptionAction: "draft_setup" | "read" = "draft_setup"): Promise<ShopActor> {
  const member = await getShopForMember({ capability: "catalog:manage", env, shopPublicId, subscriptionAction, userId });
  // Older unit/test adapters only project the membership row; an empty limit
  // map preserves their catalog-currency behavior while live D1 always carries
  // the canonical plan snapshot.
  const projected = member as Omit<typeof member, "shop"> & { shop?: { limits: Record<string, unknown> } };
  return { currency: member.row.currency, limits: projected.shop?.limits ?? {}, shopId: member.row.shop_id };
}

function planLimit(limits: Record<string, unknown>, metric: string): number | null {
  const value = limits[metric];
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AppError("quota_unavailable", 503);
  return value as number;
}

async function meterProductCreate(input: { actor: ShopActor; database: D1Database; limit: number | null; product: ProductView; now: Date }): Promise<void> {
  if (input.product.status === "archived" || input.limit === null) return;
  // Product status is the authoritative quota source. Metering is only a
  // recoverable projection and must never leave a committed catalog write in
  // an error state when its auxiliary tables are unavailable.
  try {
    await recordUsage({
      database: input.database,
      delta: 1,
      metric: "products_non_archived",
      occurredAt: input.product.createdAt,
      shopId: input.actor.shopId,
      sourceId: input.product.id,
      sourceKind: "product",
      now: input.now,
    });
  } catch {
    // A reconciliation/backfill can rebuild this projection from products.
  }
}

async function assertProductCount(input: { database: D1Database; limit: number | null; shopId: string }): Promise<void> {
  if (input.limit === null) return;
  const row = await input.database.prepare(
    "SELECT COUNT(*) AS count FROM products WHERE shop_id = ? AND status != 'archived'",
  ).bind(input.shopId).first<{ count: number }>();
  if (row === null || !Number.isSafeInteger(row.count) || row.count < 0) throw new AppError("quota_unavailable", 503);
  if (row.count >= input.limit) throw new AppError("quota_exceeded", 409, ["products_non_archived"]);
}

function resolveVariantCurrency(currency: string | undefined, shopCurrency: string): string {
  if (currency !== undefined && !isSupportedCurrency(currency)) {
    throw new AppError("validation_failed", 400, ["currency_invalid"]);
  }
  const effectiveCurrency = currency ?? shopCurrency;
  if (!isSupportedCurrency(shopCurrency) || effectiveCurrency !== shopCurrency) {
    throw new AppError("validation_failed", 400, ["currency_mismatch"]);
  }
  return effectiveCurrency;
}

function mapCatalogCurrencyWriteError(error: unknown): AppError | null {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("variant_currency_unsupported")) {
    return new AppError("validation_failed", 400, ["currency_invalid"]);
  }
  if (message.includes("variant_currency_shop_mismatch") || message.includes("shop_currency_variant_mismatch")) {
    return new AppError("validation_failed", 409, ["currency_mismatch"]);
  }
  return null;
}

export type CategoryInput = { description: string; name: string; slug: string; sortOrder: number; status: "active" | "archived" | "draft" };
export type ProductInput = { categoryId: string | null; description: string; fulfillmentType: "license_key" | "manual"; slug: string; status: "active" | "archived" | "draft" | "suspended"; title: string };
export type VariantInput = { compareAtMinor: number | null; currency: string | undefined; maxPerOrder: number; minPerOrder: number; optionsJson: string; priceMinor: number; sku: string; status: "active" | "archived" | "suspended"; title: string };

export type ProductView = ProductInput & { createdAt: string; id: string; updatedAt: string; version: number };
export type VariantView = Omit<VariantInput, "currency" | "optionsJson"> & { createdAt: string; currency: string; id: string; optionsJson: string; productId: string; updatedAt: string; version: number };

type StoredCatalogCreate = {
  request_hash: string;
  response_json: string;
};

type ProductWithInitialVariantResult = {
  created: boolean;
  product: ProductView;
  variant: VariantView;
};

export async function listSellerCatalog(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<{ categories: unknown[]; products: unknown[]; variants: unknown[] }> {
  const actor = await requireCatalogActor(input.env, input.shopPublicId, input.userId, "read");
  const [categories, products, variants] = await Promise.all([
    input.env.PLATFORM_DB.prepare(`SELECT id, slug, name, description, sort_order AS sortOrder, status, created_at AS createdAt, updated_at AS updatedAt FROM product_categories WHERE shop_id = ? ORDER BY sort_order, id LIMIT 500`).bind(actor.shopId).all(),
    input.env.PLATFORM_DB.prepare(`SELECT id, category_id AS categoryId, slug, title, description, status, fulfillment_type AS fulfillmentType, version, created_at AS createdAt, updated_at AS updatedAt FROM products WHERE shop_id = ? ORDER BY created_at, id LIMIT 500`).bind(actor.shopId).all(),
    input.env.PLATFORM_DB.prepare(`
      SELECT product_variants.id, product_variants.product_id AS productId,
        product_variants.sku, product_variants.title,
        product_variants.options_json AS optionsJson,
        product_variants.price_minor AS priceMinor,
        product_variants.compare_at_minor AS compareAtMinor,
        product_variants.currency,
        product_variants.min_per_order AS minPerOrder,
        product_variants.max_per_order AS maxPerOrder,
        product_variants.status, product_variants.version,
        COUNT(CASE WHEN inventory_keys.status = 'available' THEN 1 END) AS availableStock,
        COUNT(CASE WHEN inventory_keys.status = 'reserved' THEN 1 END) AS reservedStock,
        COUNT(CASE WHEN inventory_keys.status = 'sold' THEN 1 END) AS deliveredStock,
        (SELECT MAX(inventory_batches.created_at)
          FROM inventory_batches
          WHERE inventory_batches.shop_id = product_variants.shop_id
            AND inventory_batches.variant_id = product_variants.id) AS lastImportAt,
        (SELECT shop_settings.low_stock_threshold
          FROM shop_settings
          WHERE shop_settings.shop_id = product_variants.shop_id
          LIMIT 1) AS lowStockThreshold
      FROM product_variants
      LEFT JOIN inventory_keys
        ON inventory_keys.shop_id = product_variants.shop_id
        AND inventory_keys.variant_id = product_variants.id
      WHERE product_variants.shop_id = ?
      GROUP BY product_variants.id
      ORDER BY product_variants.created_at, product_variants.id
      LIMIT 1000
    `).bind(actor.shopId).all(),
  ]);
  return { categories: categories.results, products: products.results, variants: variants.results };
}

export async function createCategory(input: { data: CategoryInput; env: AppBindings; shopPublicId: string; userId: string }): Promise<unknown> {
  const actor = await requireCatalogActor(input.env, input.shopPublicId, input.userId);
  const id = createId("cat");
  const now = new Date().toISOString();
  try {
    return await input.env.PLATFORM_DB.prepare(`INSERT INTO product_categories (id, shop_id, slug, name, description, sort_order, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, slug, name, description, sort_order AS sortOrder, status, created_at AS createdAt, updated_at AS updatedAt`).bind(id, actor.shopId, input.data.slug, input.data.name, input.data.description, input.data.sortOrder, input.data.status, now, now).first();
  } catch {
    throw new AppError("catalog_conflict", 409);
  }
}

export async function updateCategory(input: { categoryId: string; data: CategoryInput; env: AppBindings; shopPublicId: string; userId: string }): Promise<unknown> {
  const actor = await requireCatalogActor(input.env, input.shopPublicId, input.userId);
  try {
    const row = await input.env.PLATFORM_DB.prepare(`UPDATE product_categories SET slug = ?, name = ?, description = ?, sort_order = ?, status = ?, updated_at = ? WHERE id = ? AND shop_id = ? RETURNING id, slug, name, description, sort_order AS sortOrder, status, created_at AS createdAt, updated_at AS updatedAt`).bind(input.data.slug, input.data.name, input.data.description, input.data.sortOrder, input.data.status, new Date().toISOString(), input.categoryId, actor.shopId).first();
    if (row === null) throw new AppError("resource_not_found", 404);
    return row;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("catalog_conflict", 409);
  }
}

async function assertCategory(env: AppBindings, shopId: string, categoryId: string | null): Promise<void> {
  if (categoryId === null) return;
  const row = await env.PLATFORM_DB.prepare("SELECT id FROM product_categories WHERE id = ? AND shop_id = ? LIMIT 1").bind(categoryId, shopId).first();
  if (row === null) throw new AppError("resource_not_found", 404);
}

export async function createProduct(input: { data: ProductInput; env: AppBindings; shopPublicId: string; userId: string }): Promise<unknown> {
  if (input.data.status === "active") {
    throw new AppError("validation_failed", 409, ["active_variant_required"]);
  }
  const actor = await requireCatalogActor(input.env, input.shopPublicId, input.userId);
  await assertCategory(input.env, actor.shopId, input.data.categoryId);
  if (input.data.status !== "archived") {
    const limit = planLimit(actor.limits, "products_non_archived");
    await assertProductCount({ database: input.env.PLATFORM_DB, limit, shopId: actor.shopId });
  }
  const id = createId("prd");
  const now = new Date().toISOString();
  try {
    const limit = planLimit(actor.limits, "products_non_archived");
    const product = await input.env.PLATFORM_DB.prepare(`
      INSERT INTO products (id, shop_id, category_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
      WHERE ? = 'archived' OR ? IS NULL OR (SELECT COUNT(*) FROM products WHERE shop_id = ? AND status != 'archived') < ?
      RETURNING id, category_id AS categoryId, slug, title, description, status, fulfillment_type AS fulfillmentType, version, created_at AS createdAt, updated_at AS updatedAt
    `).bind(id, actor.shopId, input.data.categoryId, input.data.slug, input.data.title, input.data.description, input.data.status, input.data.fulfillmentType, now, now, input.data.status, limit, actor.shopId, limit).first<ProductView>();
    if (product === null && input.data.status !== "archived") throw new AppError("quota_exceeded", 409, ["products_non_archived"]);
    if (product === null) throw new AppError("catalog_conflict", 409);
    await meterProductCreate({ actor, database: input.env.PLATFORM_DB, limit, now: new Date(now), product });
    await tryRecordActivationMilestone({
      env: input.env,
      idempotencyKey: "product_created",
      milestone: "product_created",
      reason: "created",
      shopId: actor.shopId,
      source: "catalog",
    });
    return product;
  } catch (error) {
    if (error instanceof AppError && (error.code.startsWith("usage_") || error.code.startsWith("quota_") || error.code === "billing_period_unavailable")) throw error;
    throw new AppError("catalog_conflict", 409);
  }
}

function parseStoredProductWithInitialVariant(value: string): Omit<ProductWithInitialVariantResult, "created"> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("catalog_create_response_invalid");
    }
    const root = parsed as Record<string, unknown>;
    const product = root.product;
    const variant = root.variant;
    if (
      typeof product !== "object"
      || product === null
      || Array.isArray(product)
      || typeof variant !== "object"
      || variant === null
      || Array.isArray(variant)
    ) {
      throw new Error("catalog_create_response_invalid");
    }
    const productRow = product as Record<string, unknown>;
    const variantRow = variant as Record<string, unknown>;
    if (
      typeof productRow.id !== "string"
      || typeof variantRow.id !== "string"
      || variantRow.productId !== productRow.id
    ) throw new Error("catalog_create_response_invalid");
    return parsed as Omit<ProductWithInitialVariantResult, "created">;
  } catch {
    throw new AppError("internal_error", 500);
  }
}

export async function createProductWithInitialVariant(input: {
  data: ProductInput;
  env: AppBindings;
  idempotencyKey: string;
  initialVariant: VariantInput;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<ProductWithInitialVariantResult> {
  if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_invalid"]);
  }
  if (input.data.status === "active" && input.initialVariant.status !== "active") {
    throw new AppError("validation_failed", 409, ["active_variant_required"]);
  }

  const actor = await requireCatalogActor(input.env, input.shopPublicId, input.userId);
  const variantCurrency = resolveVariantCurrency(input.initialVariant.currency, actor.currency);
  await assertCategory(input.env, actor.shopId, input.data.categoryId);
  const namespace = `catalog.product.create-with-variant.v1:${actor.shopId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "idempotency", input.idempotencyKey);
  const requestHash = await sha256Json({
    product: input.data,
    shopId: actor.shopId,
    variant: { ...input.initialVariant, currency: variantCurrency },
  });
  const now = new Date();
  const nowIso = now.toISOString();
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash, response_json
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(input.userId, namespace, keyHash, nowIso).first<StoredCatalogCreate>();
  if (existing !== null) {
    if (existing.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    const replay = parseStoredProductWithInitialVariant(existing.response_json);
    await meterProductCreate({ actor, database: input.env.PLATFORM_DB, limit: planLimit(actor.limits, "products_non_archived"), now, product: replay.product });
    await tryRecordActivationMilestone({
      env: input.env,
      idempotencyKey: "product_created",
      milestone: "product_created",
      reason: "created",
      shopId: actor.shopId,
      source: "catalog",
    });
    if (replay.product.status === "active" && replay.product.fulfillmentType === "manual" && replay.variant.status === "active") {
      await tryRecordActivationMilestone({
        env: input.env,
        idempotencyKey: "inventory_ready",
        milestone: "inventory_ready",
        occurredAt: replay.product.updatedAt,
        reason: "ready",
        shopId: actor.shopId,
        source: "inventory",
      });
    }
    return { ...replay, created: false };
  }

  if (input.data.status !== "archived") {
    const limit = planLimit(actor.limits, "products_non_archived");
    await assertProductCount({ database: input.env.PLATFORM_DB, limit, shopId: actor.shopId });
  }

  const productId = createId("prd");
  const variantId = createId("var");
  const product: ProductView = {
    ...input.data,
    createdAt: nowIso,
    id: productId,
    updatedAt: nowIso,
    version: 1,
  };
  const variant: VariantView = {
    ...input.initialVariant,
    currency: variantCurrency,
    createdAt: nowIso,
    id: variantId,
    productId,
    updatedAt: nowIso,
    version: 1,
  };
  const responseJson = JSON.stringify({ product, variant });
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
  const productLimit = planLimit(actor.limits, "products_non_archived");

  try {
    const results = await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare(`
        DELETE FROM idempotency_records
        WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at <= ?
      `).bind(input.userId, namespace, keyHash, nowIso),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO products (
          id, shop_id, category_id, slug, title, description, status,
          fulfillment_type, version, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
        WHERE ? = 'archived' OR ? IS NULL OR (
          SELECT COUNT(*) FROM products WHERE shop_id = ? AND status != 'archived'
        ) < ?
      `).bind(
        productId,
        actor.shopId,
        input.data.categoryId,
        input.data.slug,
        input.data.title,
        input.data.description,
        input.data.status,
        input.data.fulfillmentType,
        nowIso,
        nowIso,
        input.data.status,
        productLimit,
        actor.shopId,
        productLimit,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO product_variants (
          id, shop_id, product_id, sku, title, options_json, price_minor,
          compare_at_minor, currency, min_per_order, max_per_order, status,
          version, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
        WHERE EXISTS (SELECT 1 FROM products WHERE id = ? AND shop_id = ?)
      `).bind(
        variantId,
        actor.shopId,
        productId,
        input.initialVariant.sku,
        input.initialVariant.title,
        input.initialVariant.optionsJson,
        input.initialVariant.priceMinor,
        input.initialVariant.compareAtMinor,
        variantCurrency,
        input.initialVariant.minPerOrder,
        input.initialVariant.maxPerOrder,
        input.initialVariant.status,
        nowIso,
        nowIso,
        productId,
        actor.shopId,
      ),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO idempotency_records (
          actor_user_id, namespace, key_hash, request_hash, response_json,
          created_at, expires_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM products WHERE id = ? AND shop_id = ?)
      `).bind(input.userId, namespace, keyHash, requestHash, responseJson, nowIso, expiresAt, productId, actor.shopId),
      input.env.PLATFORM_DB.prepare(`
        INSERT INTO audit_logs (
          id, shop_id, actor_type, actor_id, action, resource_type,
          resource_id, safe_metadata_json, request_id, created_at
        )
        SELECT ?, ?, 'user', ?, 'catalog.product_with_variant.created',
          'product', ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM products WHERE id = ? AND shop_id = ?)
      `).bind(
        createId("aud"),
        actor.shopId,
        input.userId,
        productId,
        JSON.stringify({
          fulfillmentType: input.data.fulfillmentType,
          productStatus: input.data.status,
          variantId,
          variantStatus: input.initialVariant.status,
        }),
        input.requestId,
        nowIso,
        productId,
        actor.shopId,
      ),
    ]);
    if ((results[1]?.meta.changes ?? 0) === 0 && input.data.status !== "archived") {
      throw new AppError("quota_exceeded", 409, ["products_non_archived"]);
    }
  } catch (error) {
    const replay = await input.env.PLATFORM_DB.prepare(`
      SELECT request_hash, response_json
      FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      LIMIT 1
    `).bind(input.userId, namespace, keyHash).first<StoredCatalogCreate>();
    if (replay !== null) {
      if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
      const replayed = parseStoredProductWithInitialVariant(replay.response_json);
      await meterProductCreate({ actor, database: input.env.PLATFORM_DB, limit: planLimit(actor.limits, "products_non_archived"), now, product: replayed.product });
      await tryRecordActivationMilestone({
        env: input.env,
        idempotencyKey: "product_created",
        milestone: "product_created",
        reason: "created",
        shopId: actor.shopId,
        source: "catalog",
      });
      return { ...replayed, created: false };
    }
    if (error instanceof AppError) throw error;
    throw mapCatalogCurrencyWriteError(error) ?? new AppError("catalog_conflict", 409);
  }

  await meterProductCreate({ actor, database: input.env.PLATFORM_DB, limit: productLimit, now, product });
  await tryRecordActivationMilestone({
    env: input.env,
    idempotencyKey: "product_created",
    milestone: "product_created",
    reason: "created",
    shopId: actor.shopId,
    source: "catalog",
  });
  if (product.status === "active" && product.fulfillmentType === "manual" && variant.status === "active") {
    await tryRecordActivationMilestone({
      env: input.env,
      idempotencyKey: "inventory_ready",
      milestone: "inventory_ready",
      occurredAt: nowIso,
      reason: "ready",
      shopId: actor.shopId,
      source: "inventory",
    });
  }
  return { created: true, product, variant };
}

export async function updateProduct(input: { data: ProductInput; env: AppBindings; productId: string; shopPublicId: string; userId: string }): Promise<unknown> {
  const actor = await requireCatalogActor(input.env, input.shopPublicId, input.userId);
  const productLimit = planLimit(actor.limits, "products_non_archived");
  await assertCategory(input.env, actor.shopId, input.data.categoryId);
  if (input.data.status === "active") {
    const variant = await input.env.PLATFORM_DB.prepare("SELECT id FROM product_variants WHERE shop_id = ? AND product_id = ? AND status = 'active' LIMIT 1").bind(actor.shopId, input.productId).first();
    if (variant === null) throw new AppError("validation_failed", 409, ["active_variant_required"]);
  }
  try {
    const row = await input.env.PLATFORM_DB.prepare(`
      UPDATE products AS target
      SET category_id = ?, slug = ?, title = ?, description = ?, status = ?,
        fulfillment_type = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ?
        AND (
          ? = 'archived'
          OR target.status != 'archived'
          OR ? IS NULL
          OR (SELECT COUNT(*) FROM products AS quota_products
              WHERE quota_products.shop_id = ? AND quota_products.status != 'archived') < ?
        )
        AND (
          ? = 'suspended'
          OR target.status != 'suspended'
          OR COALESCE((
            SELECT CASE
              WHEN latest.action_kind = 'product_suspend'
              THEN 1 ELSE 0
            END
            FROM moderation_actions AS latest
            WHERE latest.target_kind = 'product'
              AND latest.target_ref = target.id
              AND latest.status = 'applied'
            ORDER BY latest.created_at DESC, latest.rowid DESC
            LIMIT 1
          ), 0) = 0
        )
      RETURNING id, category_id AS categoryId, slug, title, description, status,
        fulfillment_type AS fulfillmentType, version, created_at AS createdAt, updated_at AS updatedAt
    `).bind(
      input.data.categoryId,
      input.data.slug,
      input.data.title,
      input.data.description,
      input.data.status,
      input.data.fulfillmentType,
      new Date().toISOString(),
      input.productId,
      actor.shopId,
      input.data.status,
      productLimit,
      actor.shopId,
      productLimit,
      input.data.status,
    ).first<ProductView>();
    if (row === null) {
      const product = await input.env.PLATFORM_DB.prepare(
        "SELECT id, status FROM products WHERE id = ? AND shop_id = ? LIMIT 1",
      ).bind(input.productId, actor.shopId).first<{ id: string; status: string }>();
      if (product !== null && product.status === "archived" && input.data.status !== "archived" && productLimit !== null) {
        await assertProductCount({ database: input.env.PLATFORM_DB, limit: productLimit, shopId: actor.shopId });
      }
      if (product !== null) throw new AppError("moderation_state_conflict", 409);
      throw new AppError("resource_not_found", 404);
    }
    await meterProductCreate({ actor, database: input.env.PLATFORM_DB, limit: productLimit, now: new Date(row.updatedAt), product: row });
    if (row.status === "active" && row.fulfillmentType === "manual") {
      await tryRecordActivationMilestone({
        env: input.env,
        idempotencyKey: "inventory_ready",
        milestone: "inventory_ready",
        occurredAt: row.updatedAt,
        reason: "ready",
        shopId: actor.shopId,
        source: "inventory",
      });
    }
    return row;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("catalog_conflict", 409);
  }
}

export async function createVariant(input: { data: VariantInput; env: AppBindings; productId: string; shopPublicId: string; userId: string }): Promise<unknown> {
  const actor = await requireCatalogActor(input.env, input.shopPublicId, input.userId);
  const variantCurrency = resolveVariantCurrency(input.data.currency, actor.currency);
  const product = await input.env.PLATFORM_DB.prepare("SELECT id FROM products WHERE id = ? AND shop_id = ? LIMIT 1").bind(input.productId, actor.shopId).first();
  if (product === null) throw new AppError("resource_not_found", 404);
  const id = createId("var");
  const now = new Date().toISOString();
  try {
    const row = await input.env.PLATFORM_DB.prepare(`
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        compare_at_minor, currency, min_per_order, max_per_order, status,
        version, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
      FROM shops
      WHERE shops.id = ?
        AND shops.currency = ?
        AND EXISTS (
          SELECT 1 FROM products
          WHERE products.id = ? AND products.shop_id = shops.id
        )
      RETURNING id, product_id AS productId, sku, title,
        options_json AS optionsJson, price_minor AS priceMinor,
        compare_at_minor AS compareAtMinor, currency,
        min_per_order AS minPerOrder, max_per_order AS maxPerOrder,
        status, version, created_at AS createdAt, updated_at AS updatedAt
    `).bind(
      id, actor.shopId, input.productId, input.data.sku, input.data.title,
      input.data.optionsJson, input.data.priceMinor, input.data.compareAtMinor,
      variantCurrency, input.data.minPerOrder, input.data.maxPerOrder,
      input.data.status, now, now, actor.shopId, variantCurrency, input.productId,
    ).first();
    if (row !== null) return row;
    throw new AppError("validation_failed", 409, ["currency_mismatch"]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw mapCatalogCurrencyWriteError(error) ?? new AppError("catalog_conflict", 409);
  }
}

export async function updateVariant(input: { data: VariantInput; env: AppBindings; shopPublicId: string; userId: string; variantId: string }): Promise<unknown> {
  const actor = await requireCatalogActor(input.env, input.shopPublicId, input.userId);
  const variantCurrency = resolveVariantCurrency(input.data.currency, actor.currency);
  try {
    const row = await input.env.PLATFORM_DB.prepare(`
      UPDATE product_variants
      SET sku = ?, title = ?, options_json = ?, price_minor = ?,
        compare_at_minor = ?, currency = ?, min_per_order = ?,
        max_per_order = ?, status = ?, version = version + 1,
        updated_at = ?
      WHERE id = ? AND shop_id = ?
        AND EXISTS (
          SELECT 1 FROM shops
          WHERE shops.id = product_variants.shop_id
            AND shops.currency = ?
        )
      RETURNING id, product_id AS productId, sku, title,
        options_json AS optionsJson, price_minor AS priceMinor,
        compare_at_minor AS compareAtMinor, currency,
        min_per_order AS minPerOrder, max_per_order AS maxPerOrder,
        status, version, created_at AS createdAt, updated_at AS updatedAt
    `).bind(
      input.data.sku, input.data.title, input.data.optionsJson,
      input.data.priceMinor, input.data.compareAtMinor, variantCurrency,
      input.data.minPerOrder, input.data.maxPerOrder, input.data.status,
      new Date().toISOString(), input.variantId, actor.shopId, variantCurrency,
    ).first();
    if (row === null) {
      const existing = await input.env.PLATFORM_DB.prepare(
        "SELECT id FROM product_variants WHERE id = ? AND shop_id = ? LIMIT 1",
      ).bind(input.variantId, actor.shopId).first();
      if (existing !== null) throw new AppError("validation_failed", 409, ["currency_mismatch"]);
      throw new AppError("resource_not_found", 404);
    }
    return row;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw mapCatalogCurrencyWriteError(error) ?? new AppError("catalog_conflict", 409);
  }
}

type PreparedInventoryImport = {
  actor: ShopActor;
  analysis: InventoryImportAnalysis;
  plan: InventoryImportPlan;
};

type InventoryImportResult = InventoryImportSummary & {
  batchId: string;
};

type StoredIdempotency = {
  request_hash: string;
  response_json: string;
};

async function assertInventoryVariant(env: AppBindings, shopId: string, variantId: string): Promise<void> {
  const variant = await env.PLATFORM_DB.prepare(
    "SELECT id FROM product_variants WHERE id = ? AND shop_id = ? LIMIT 1",
  ).bind(variantId, shopId).first();
  if (variant === null) throw new AppError("resource_not_found", 404);
}

async function findExistingInventoryFingerprints(
  env: AppBindings,
  shopId: string,
  variantId: string,
  fingerprints: readonly string[],
): Promise<Set<string>> {
  const existing = new Set<string>();
  const chunkSize = 80;
  for (let offset = 0; offset < fingerprints.length; offset += chunkSize) {
    const chunk = fingerprints.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await env.PLATFORM_DB.prepare(`
      SELECT key_fingerprint
      FROM inventory_keys
      WHERE shop_id = ? AND variant_id = ? AND key_fingerprint IN (${placeholders})
    `).bind(shopId, variantId, ...chunk).all<{ key_fingerprint: string }>();
    for (const row of rows.results) existing.add(row.key_fingerprint);
  }
  return existing;
}

async function prepareInventoryImport(input: {
  data: unknown;
  env: AppBindings;
  filename: string | null;
  shopPublicId: string;
  source: InventoryImportSource;
  userId: string;
  variantId: string;
}): Promise<PreparedInventoryImport> {
  const actor = await requireCatalogActor(input.env, input.shopPublicId, input.userId);
  await assertInventoryVariant(input.env, actor.shopId, input.variantId);
  const analysis = await analyzeInventoryImport({
    data: input.data,
    filename: input.filename,
    hmacSecret: input.env.IDENTIFIER_HMAC_SECRET,
    shopId: actor.shopId,
    source: input.source,
    variantId: input.variantId,
  });
  const existingFingerprints = await findExistingInventoryFingerprints(
    input.env,
    actor.shopId,
    input.variantId,
    analysis.entries.map((entry) => entry.fingerprint),
  );
  return { actor, analysis, plan: createInventoryImportPlan(analysis, existingFingerprints) };
}

export async function previewInventoryImport(input: {
  data: unknown;
  env: AppBindings;
  filename: string | null;
  shopPublicId: string;
  source: InventoryImportSource;
  userId: string;
  variantId: string;
}): Promise<InventoryImportSummary & { expiresAt: string; previewToken: string }> {
  const prepared = await prepareInventoryImport(input);
  const token = await createInventoryPreviewToken({
    analysis: prepared.analysis,
    plan: prepared.plan,
    sessionSecret: input.env.SESSION_SECRET,
    shopId: prepared.actor.shopId,
    source: input.source,
    userId: input.userId,
    variantId: input.variantId,
  });
  return { ...prepared.plan.summary, ...token };
}

function parseStoredInventoryImport(value: string): InventoryImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new AppError("internal_error", 500);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError("internal_error", 500);
  }
  const row = parsed as Partial<InventoryImportResult>;
  const counts = [row.acceptedCount, row.duplicateCount, row.rejectedCount, row.totalCount];
  if (
    typeof row.batchId !== "string"
    || counts.some((count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
  ) {
    throw new AppError("internal_error", 500);
  }
  return row as InventoryImportResult;
}

export async function confirmInventoryImport(input: {
  data: unknown;
  env: AppBindings;
  filename: string | null;
  idempotencyKey: string;
  previewToken: string;
  requestId: string;
  shopPublicId: string;
  source: InventoryImportSource;
  userId: string;
  variantId: string;
}): Promise<InventoryImportResult & { created: boolean }> {
  if (!/^[A-Za-z0-9._:-]{16,128}$/u.test(input.idempotencyKey)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_invalid"]);
  }
  const prepared = await prepareInventoryImport(input);
  await verifyInventoryPreviewToken({
    analysis: prepared.analysis,
    enforcePlan: false,
    plan: prepared.plan,
    previewToken: input.previewToken,
    sessionSecret: input.env.SESSION_SECRET,
    shopId: prepared.actor.shopId,
    source: input.source,
    userId: input.userId,
    variantId: input.variantId,
  });

  const namespace = `inventory.import.confirm.v1:${prepared.actor.shopId}:${input.variantId}`;
  const keyHash = await hmacToken(input.env.SESSION_SECRET, "idempotency", input.idempotencyKey);
  const requestHash = await sha256Json({
    filename: input.filename,
    payloadHash: prepared.analysis.payloadHash,
    shopId: prepared.actor.shopId,
    source: input.source,
    variantId: input.variantId,
  });
  const now = new Date();
  const nowIso = now.toISOString();
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT request_hash, response_json
    FROM idempotency_records
    WHERE actor_user_id = ? AND namespace = ? AND key_hash = ? AND expires_at > ?
    LIMIT 1
  `).bind(input.userId, namespace, keyHash, nowIso).first<StoredIdempotency>();
  if (existing !== null) {
    if (existing.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
    await tryRecordActivationMilestone({
      env: input.env,
      idempotencyKey: "inventory_ready",
      milestone: "inventory_ready",
      reason: "ready",
      shopId: prepared.actor.shopId,
      source: "inventory",
    });
    return { ...parseStoredInventoryImport(existing.response_json), created: false };
  }
  await verifyInventoryPreviewToken({
    analysis: prepared.analysis,
    plan: prepared.plan,
    previewToken: input.previewToken,
    sessionSecret: input.env.SESSION_SECRET,
    shopId: prepared.actor.shopId,
    source: input.source,
    userId: input.userId,
    variantId: input.variantId,
  });
  if (prepared.plan.summary.acceptedCount === 0) {
    throw new AppError("validation_failed", 409, ["inventory_no_acceptable_keys"]);
  }

  const activeKey = resolveActiveEncryptionKey(input.env, "inventory");
  const encrypted = await Promise.all(prepared.plan.acceptedEntries.map((entry) => encryptInventoryKey({
    hmacSecret: input.env.IDENTIFIER_HMAC_SECRET,
    keyVersion: activeKey.version,
    kek: activeKey.kek,
    plaintext: entry.plaintext,
    shopId: prepared.actor.shopId,
    variantId: input.variantId,
  })));
  const batchId = createId("bat");
  const result: InventoryImportResult = { ...prepared.plan.summary, batchId };
  const responseJson = JSON.stringify(result);
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
  const rejectedCount = result.rejectedCount + result.duplicateCount;
  const statements = [
    input.env.PLATFORM_DB.prepare(`INSERT INTO inventory_batches (id, shop_id, variant_id, source, filename_sanitized, total_count, accepted_count, rejected_count, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(batchId, prepared.actor.shopId, input.variantId, input.source, input.filename, result.totalCount, result.acceptedCount, rejectedCount, input.userId, nowIso),
    ...encrypted.map((item) => input.env.PLATFORM_DB.prepare(`INSERT INTO inventory_keys (id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64, key_version, key_fingerprint, created_at) VALUES (?, ?, ?, ?, 'available', ?, ?, ?, ?, ?)`).bind(createId("key"), prepared.actor.shopId, input.variantId, batchId, item.ciphertextB64, item.ivB64, item.keyVersion, item.fingerprint, nowIso)),
    input.env.PLATFORM_DB.prepare("UPDATE shops SET readiness_version = readiness_version + 1, updated_at = ? WHERE id = ?").bind(nowIso, prepared.actor.shopId),
    input.env.PLATFORM_DB.prepare(`INSERT INTO idempotency_records (actor_user_id, namespace, key_hash, request_hash, response_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(input.userId, namespace, keyHash, requestHash, responseJson, nowIso, expiresAt),
    input.env.PLATFORM_DB.prepare(`INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, created_at) VALUES (?, ?, 'user', ?, 'inventory.imported', 'inventory_batch', ?, ?, ?, ?)`).bind(createId("aud"), prepared.actor.shopId, input.userId, batchId, JSON.stringify({ acceptedCount: result.acceptedCount, duplicateCount: result.duplicateCount, rejectedCount: result.rejectedCount, source: input.source, variantId: input.variantId }), input.requestId, nowIso),
  ];
  try {
    await input.env.PLATFORM_DB.batch(statements);
  } catch {
    const replay = await input.env.PLATFORM_DB.prepare(`
      SELECT request_hash, response_json
      FROM idempotency_records
      WHERE actor_user_id = ? AND namespace = ? AND key_hash = ?
      LIMIT 1
    `).bind(input.userId, namespace, keyHash).first<StoredIdempotency>();
    if (replay !== null) {
      if (replay.request_hash !== requestHash) throw new AppError("idempotency_conflict", 409);
      await tryRecordActivationMilestone({
        env: input.env,
        idempotencyKey: "inventory_ready",
        milestone: "inventory_ready",
        reason: "ready",
        shopId: prepared.actor.shopId,
        source: "inventory",
      });
      return { ...parseStoredInventoryImport(replay.response_json), created: false };
    }
    throw new AppError("inventory_import_conflict", 409);
  }
  await tryRecordActivationMilestone({
    env: input.env,
    idempotencyKey: "inventory_ready",
    milestone: "inventory_ready",
    reason: "ready",
    shopId: prepared.actor.shopId,
    source: "inventory",
  });
  return { ...result, created: true };
}

export async function publishStorefront(input: { env: AppBindings; expectedStorefrontVersion: number; requestId: string; shopPublicId: string; userId: string }): Promise<void> {
  await publishReadyStorefront(input);
}
