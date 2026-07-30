import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";

export type SellerOrderSummary = {
  createdAt: string;
  currency: string;
  customerEmail: string | null;
  fulfillmentStatus: string;
  itemCount: number;
  orderId: string;
  orderNumber: string;
  paymentStatus: string;
  primaryItem: string | null;
  sourceChannel: string;
  status: string;
  totalMinor: number;
  updatedAt: string;
};

export type SellerOrderDetail = SellerOrderSummary & {
  audit: Array<{ action: string; createdAt: string }>;
  expiresAt: string;
  fulfilledAt: string | null;
  fulfillment: Array<{ createdAt: string; failedAt: string | null; fulfilledAt: string | null; state: string; type: string }>;
  items: Array<{
    fulfillmentType: string;
    id: string;
    lineTotalMinor: number;
    productTitle: string;
    quantity: number;
    sku: string;
    unitPriceMinor: number;
    variantTitle: string;
    privateDownload: {
      downloadCount: number;
      entitlementExpiresAt: string | null;
      entitlementStatus: string | null;
      filename: string;
      maxDownloads: number;
      remainingDownloads: number;
    } | null;
  }>;
  paidAt: string | null;
  payments: Array<{ createdAt: string; expectedAmountMinor: number; expiresAt: string; lastSafeErrorCode: string | null; provider: string; state: string; updatedAt: string }>;
};

type SellerPrivateDownloadRow = {
  downloadCount: number;
  entitlementExpiresAt: string | null;
  entitlementStatus: string | null;
  filename: string;
  maxDownloads: number;
  orderItemId: string;
};

async function requireOrderActor(env: AppBindings, shopPublicId: string, userId: string): Promise<string> {
  const member = await getShopForMember({ capability: "shop:read", env, shopPublicId, userId });
  return member.row.shop_id;
}

async function listSellerPrivateDownloads(input: { env: AppBindings; orderId: string; shopId: string }): Promise<SellerPrivateDownloadRow[]> {
  const schema = await input.env.PLATFORM_DB.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name IN (
        'digital_assets',
        'digital_asset_versions',
        'digital_entitlements',
        'order_item_fulfillment_requirements'
      )
  `).all<{ name: string }>();
  if (new Set(schema.results.map((row) => row.name)).size !== 4) return [];
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT requirements.order_item_id AS orderItemId,
      digital_asset_versions.filename_sanitized AS filename,
      COALESCE(entitlements.download_count, 0) AS downloadCount,
      entitlements.status AS entitlementStatus,
      entitlements.access_expires_at AS entitlementExpiresAt,
      COALESCE(entitlements.max_downloads, requirements.max_downloads) AS maxDownloads
    FROM order_item_fulfillment_requirements AS requirements
    INNER JOIN digital_asset_versions
      ON digital_asset_versions.shop_id = requirements.shop_id
      AND digital_asset_versions.id = requirements.asset_version_id
    INNER JOIN digital_assets
      ON digital_assets.shop_id = digital_asset_versions.shop_id
      AND digital_assets.id = digital_asset_versions.asset_id
    LEFT JOIN digital_entitlements AS entitlements
      ON entitlements.shop_id = requirements.shop_id
      AND entitlements.requirement_id = requirements.id
    WHERE requirements.shop_id = ?
      AND requirements.order_id = ?
      AND requirements.capability = 'private_file'
      AND digital_assets.status = 'active'
      AND digital_asset_versions.status = 'active'
    ORDER BY requirements.order_item_id, requirements.id
  `).bind(input.shopId, input.orderId).all<SellerPrivateDownloadRow>();
  return rows.results;
}

export async function listSellerOrders(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<SellerOrderSummary[]> {
  const shopId = await requireOrderActor(input.env, input.shopPublicId, input.userId);
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT
      orders.public_id AS orderId,
      orders.order_number AS orderNumber,
      orders.customer_email_masked AS customerEmail,
      orders.status,
      orders.payment_status AS paymentStatus,
      orders.fulfillment_status AS fulfillmentStatus,
      orders.source_channel AS sourceChannel,
      orders.total_minor AS totalMinor,
      orders.currency,
      orders.created_at AS createdAt,
      orders.updated_at AS updatedAt,
      COUNT(order_items.id) AS itemCount,
      MIN(order_items.product_title) AS primaryItem
    FROM orders
    LEFT JOIN order_items
      ON order_items.order_id = orders.id
      AND order_items.shop_id = orders.shop_id
    WHERE orders.shop_id = ?
    GROUP BY orders.id
    ORDER BY orders.created_at DESC, orders.id DESC
    LIMIT 200
  `).bind(shopId).all<SellerOrderSummary>();
  return rows.results;
}

export async function getSellerOrder(input: { env: AppBindings; orderPublicId: string; shopPublicId: string; userId: string }): Promise<SellerOrderDetail> {
  const shopId = await requireOrderActor(input.env, input.shopPublicId, input.userId);
  const row = await input.env.PLATFORM_DB.prepare(`
    SELECT
      orders.id AS internalId,
      orders.public_id AS orderId,
      orders.order_number AS orderNumber,
      orders.customer_email_masked AS customerEmail,
      orders.status,
      orders.payment_status AS paymentStatus,
      orders.fulfillment_status AS fulfillmentStatus,
      orders.source_channel AS sourceChannel,
      orders.total_minor AS totalMinor,
      orders.currency,
      orders.expires_at AS expiresAt,
      orders.paid_at AS paidAt,
      orders.fulfilled_at AS fulfilledAt,
      orders.created_at AS createdAt,
      orders.updated_at AS updatedAt,
      COUNT(order_items.id) AS itemCount,
      MIN(order_items.product_title) AS primaryItem
    FROM orders
    LEFT JOIN order_items
      ON order_items.order_id = orders.id
      AND order_items.shop_id = orders.shop_id
    WHERE orders.shop_id = ? AND orders.public_id = ?
    GROUP BY orders.id
    LIMIT 1
  `).bind(shopId, input.orderPublicId).first<SellerOrderSummary & { expiresAt: string; fulfilledAt: string | null; internalId: string; paidAt: string | null }>();
  if (row === null) throw new AppError("order_not_found", 404);

  const [items, payments, fulfillment, audit, privateDownloads] = await Promise.all([
    input.env.PLATFORM_DB.prepare(`
      SELECT id, product_title AS productTitle, variant_title AS variantTitle, sku,
        unit_price_minor AS unitPriceMinor, quantity, line_total_minor AS lineTotalMinor,
        fulfillment_type AS fulfillmentType
      FROM order_items
      WHERE shop_id = ? AND order_id = ?
      ORDER BY id
    `).bind(shopId, row.internalId).all<SellerOrderDetail["items"][number]>(),
    input.env.PLATFORM_DB.prepare(`
      SELECT provider, state, expected_amount_minor AS expectedAmountMinor,
        expires_at AS expiresAt, last_safe_error_code AS lastSafeErrorCode,
        created_at AS createdAt, updated_at AS updatedAt
      FROM payment_attempts
      WHERE shop_id = ? AND order_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `).bind(shopId, row.internalId).all<SellerOrderDetail["payments"][number]>(),
    input.env.PLATFORM_DB.prepare(`
      SELECT fulfillment_type AS type, state, created_at AS createdAt,
        fulfilled_at AS fulfilledAt, failed_at AS failedAt
      FROM fulfillments
      WHERE shop_id = ? AND order_id = ?
      ORDER BY created_at, id
    `).bind(shopId, row.internalId).all<SellerOrderDetail["fulfillment"][number]>(),
    input.env.PLATFORM_DB.prepare(`
      SELECT action, created_at AS createdAt
      FROM audit_logs
      WHERE shop_id = ? AND resource_type = 'order' AND resource_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 30
    `).bind(shopId, row.internalId).all<SellerOrderDetail["audit"][number]>(),
    listSellerPrivateDownloads({ env: input.env, orderId: row.internalId, shopId }),
  ]);

  const { internalId, ...safe } = row;
  void internalId;
  const privateDownloadByItem = new Map(privateDownloads.map((download) => [download.orderItemId, {
    downloadCount: download.downloadCount,
    entitlementExpiresAt: download.entitlementExpiresAt,
    entitlementStatus: download.entitlementStatus,
    filename: download.filename,
    maxDownloads: download.maxDownloads,
    remainingDownloads: download.entitlementStatus !== "active"
      ? 0
      : Math.max(0, download.maxDownloads - download.downloadCount),
  }]));
  return {
    ...safe,
    audit: audit.results,
    fulfillment: fulfillment.results,
    items: items.results.map((item) => ({ ...item, privateDownload: privateDownloadByItem.get(item.id) ?? null })),
    payments: payments.results,
  };
}
