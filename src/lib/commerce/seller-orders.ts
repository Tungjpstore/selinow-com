import { AppError } from "../core/errors";
import { encodePublicApiCursor, parsePublicApiPage, type PublicApiPage } from "../api/pagination";
import type { AppBindings } from "../platform/bindings";
import { assertRoleCapability } from "../tenants/policy";
import { getShopForMember } from "../tenants/store";
import type { SellerOrderNote } from "./order-notes";

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

export type SellerOrderPage = { nextCursor: string | null; orders: SellerOrderSummary[] };

type SellerManualFulfillmentView = {
  completedAt: string | null;
  status: "completed" | "pending" | "unsupported";
  unsupportedReason: "entitlement_policy" | "private_file" | null;
};

function sellerPage(input: { cursor?: string | null; limit?: number }): PublicApiPage {
  const url = new URL("https://seller.selinow.invalid/");
  if (input.cursor !== undefined && input.cursor !== null) url.searchParams.set("cursor", input.cursor);
  if (input.limit !== undefined) url.searchParams.set("limit", String(input.limit));
  return parsePublicApiPage(url);
}

export type SellerOrderDetail = SellerOrderSummary & {
  audit: Array<{ action: string; createdAt: string }>;
  expiresAt: string;
  fulfilledAt: string | null;
  fulfillment: Array<{ createdAt: string; failedAt: string | null; fulfilledAt: string | null; state: string; type: string }>;
  items: Array<{
    fulfillmentType: string;
    id: string;
    lineTotalMinor: number;
    manualFulfillment: SellerManualFulfillmentView | null;
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
  notes: SellerOrderNote[];
  paidAt: string | null;
  paymentExceptions: Array<{
    createdAt: string;
    currency: string;
    id: string;
    paymentAttemptId: string;
    status: string;
    type: string;
  }>;
  payments: Array<{ createdAt: string; expectedAmountMinor: number; expiresAt: string; lastSafeErrorCode: string | null; provider: string; state: string; updatedAt: string }>;
  remediationRequests: Array<{
    amountMinor: number;
    createdAt: string;
    currency: string;
    exceptionId: string;
    failureCode: string | null;
    kind: "manual_review" | "partial_refund" | "refund";
    reasonCode: string;
    requestPublicId: string;
    reviewedAt: string | null;
    status: "canceled" | "completed" | "failed" | "provider_pending" | "rejected" | "requested";
    updatedAt: string;
    version: number;
  }>;
};

type SellerPrivateDownloadRow = {
  downloadCount: number;
  entitlementExpiresAt: string | null;
  entitlementStatus: string | null;
  filename: string;
  maxDownloads: number;
  orderItemId: string;
};

type SellerManualFulfillmentRow = {
  completedAt: string | null;
  hasGenericRequirement: number;
  hasPrivateFileRequirement: number;
  orderItemId: string;
};

type OrderVisibility = "full" | "masked" | "summary";

async function requireOrderActor(env: AppBindings, shopPublicId: string, userId: string): Promise<{ canReadNotes: boolean; shopId: string; visibility: OrderVisibility }> {
  const member = await getShopForMember({ capability: "shop:read", env, shopPublicId, userId });
  if (member.row.role === "owner" || member.row.role === "manager") {
    assertRoleCapability(member.row.role, "orders:read");
    return { canReadNotes: true, shopId: member.row.shop_id, visibility: "full" };
  }
  if (member.row.role === "support") {
    assertRoleCapability(member.row.role, "orders:read:masked");
    return { canReadNotes: false, shopId: member.row.shop_id, visibility: "masked" };
  }
  assertRoleCapability(member.row.role, "orders:read:summary");
  return { canReadNotes: false, shopId: member.row.shop_id, visibility: "summary" };
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

export async function listSellerOrdersPage(input: { cursor?: string | null; env: AppBindings; limit?: number; shopPublicId: string; userId: string }): Promise<SellerOrderPage> {
  const { shopId, visibility } = await requireOrderActor(input.env, input.shopPublicId, input.userId);
  const page = sellerPage(input);
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
      AND (? IS NULL OR orders.created_at < ?
        OR (orders.created_at = ? AND orders.public_id < ?))
    GROUP BY orders.id
    ORDER BY orders.created_at DESC, orders.public_id DESC
    LIMIT ?
  `).bind(
    shopId,
    page.cursor?.createdAt ?? null,
    page.cursor?.createdAt ?? null,
    page.cursor?.createdAt ?? null,
    page.cursor?.id ?? null,
    page.limit + 1,
  ).all<SellerOrderSummary>();
  const hasNext = rows.results.length > page.limit;
  const visibleRows = rows.results.slice(0, page.limit);
  const orders = visibility !== "summary" ? visibleRows : visibleRows.map((row) => ({
    ...row,
    customerEmail: null,
    primaryItem: null,
  }));
  const last = visibleRows.at(-1);
  return {
    nextCursor: hasNext && last !== undefined
      ? encodePublicApiCursor({ createdAt: last.createdAt, id: last.orderId })
      : null,
    orders,
  };
}

export async function listSellerOrders(input: { env: AppBindings; shopPublicId: string; userId: string }): Promise<SellerOrderSummary[]> {
  return (await listSellerOrdersPage({ ...input, limit: 100 })).orders;
}

export async function getSellerOrder(input: { env: AppBindings; orderPublicId: string; shopPublicId: string; userId: string }): Promise<SellerOrderDetail> {
  const { canReadNotes, shopId, visibility } = await requireOrderActor(input.env, input.shopPublicId, input.userId);
  if (visibility === "summary") throw new AppError("authorization_denied", 403);
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

  const [items, payments, paymentExceptions, remediationRequests, fulfillment, audit, notes, privateDownloads, manualFulfillments] = await Promise.all([
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
    visibility === "full" ? input.env.PLATFORM_DB.prepare(`
      SELECT exceptions.id, exceptions.type, exceptions.status,
        exceptions.created_at AS createdAt, attempts.currency,
        attempts.public_id AS paymentAttemptId
      FROM payment_exceptions AS exceptions
      INNER JOIN payment_attempts AS attempts
        ON attempts.id = exceptions.payment_attempt_id
        AND attempts.shop_id = exceptions.shop_id
      WHERE exceptions.shop_id = ? AND exceptions.order_id = ?
      ORDER BY exceptions.created_at DESC, exceptions.id DESC
      LIMIT 50
    `).bind(shopId, row.internalId).all<SellerOrderDetail["paymentExceptions"][number]>() : Promise.resolve({ results: [] as SellerOrderDetail["paymentExceptions"] }),
    visibility === "full" ? input.env.PLATFORM_DB.prepare(`
      SELECT requests.public_id AS requestPublicId,
        requests.payment_exception_id AS exceptionId,
        requests.kind, requests.status, requests.amount_minor AS amountMinor,
        requests.currency, requests.reason_code AS reasonCode,
        requests.failure_code AS failureCode, requests.reviewed_at AS reviewedAt,
        requests.created_at AS createdAt, requests.updated_at AS updatedAt,
        requests.version
      FROM payment_remediation_requests AS requests
      WHERE requests.shop_id = ? AND requests.order_id = ?
      ORDER BY requests.created_at DESC, requests.id DESC
      LIMIT 50
    `).bind(shopId, row.internalId).all<SellerOrderDetail["remediationRequests"][number]>() : Promise.resolve({ results: [] as SellerOrderDetail["remediationRequests"] }),
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
    canReadNotes ? input.env.PLATFORM_DB.prepare(`
      SELECT order_notes.id, order_notes.body, order_notes.status,
        order_notes.redacted_at AS redactedAt, order_notes.created_at AS createdAt,
        order_notes.updated_at AS updatedAt, order_notes.version,
        platform_users.display_name AS authorDisplayName
      FROM order_notes
      INNER JOIN platform_users ON platform_users.id = order_notes.author_user_id
      WHERE order_notes.shop_id = ? AND order_notes.order_id = ?
      ORDER BY order_notes.created_at DESC, order_notes.id DESC
      LIMIT 100
    `).bind(shopId, row.internalId).all<SellerOrderNote & { id: string; authorDisplayName: string }>() : Promise.resolve({ results: [] as Array<SellerOrderNote & { id: string; authorDisplayName: string }> }),
    listSellerPrivateDownloads({ env: input.env, orderId: row.internalId, shopId }),
    input.env.PLATFORM_DB.prepare(`
      SELECT order_items.id AS orderItemId,
        executions.completed_at AS completedAt,
        EXISTS (
          SELECT 1
          FROM order_item_fulfillment_requirements AS private_requirement
          WHERE private_requirement.shop_id = order_items.shop_id
            AND private_requirement.order_id = order_items.order_id
            AND private_requirement.order_item_id = order_items.id
            AND private_requirement.capability = 'private_file'
        ) AS hasPrivateFileRequirement,
        EXISTS (
          SELECT 1
          FROM order_item_entitlement_requirements AS generic_requirement
          WHERE generic_requirement.shop_id = order_items.shop_id
            AND generic_requirement.order_id = order_items.order_id
            AND generic_requirement.order_item_id = order_items.id
        ) AS hasGenericRequirement
      FROM order_items
      LEFT JOIN manual_fulfillment_executions AS executions
        ON executions.shop_id = order_items.shop_id
        AND executions.order_id = order_items.order_id
        AND executions.order_item_id = order_items.id
        AND executions.state = 'completed'
      WHERE order_items.shop_id = ? AND order_items.order_id = ?
      ORDER BY order_items.id
    `).bind(shopId, row.internalId).all<SellerManualFulfillmentRow>(),
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
  const manualFulfillmentByItem = new Map<string, SellerManualFulfillmentView>(manualFulfillments.results.map((projection): [string, SellerManualFulfillmentView] => {
    if (projection.completedAt !== null) {
      return [projection.orderItemId, { completedAt: projection.completedAt, status: "completed", unsupportedReason: null }];
    }
    if (projection.hasPrivateFileRequirement === 1) {
      return [projection.orderItemId, { completedAt: null, status: "unsupported", unsupportedReason: "private_file" }];
    }
    if (projection.hasGenericRequirement === 1) {
      return [projection.orderItemId, { completedAt: null, status: "unsupported", unsupportedReason: "entitlement_policy" }];
    }
    return [projection.orderItemId, { completedAt: null, status: "pending", unsupportedReason: null }];
  }));
  return {
    ...safe,
    audit: audit.results,
    fulfillment: fulfillment.results,
    items: items.results.map((item) => ({
      ...item,
      manualFulfillment: item.fulfillmentType === "manual" ? manualFulfillmentByItem.get(item.id) ?? null : null,
      privateDownload: visibility === "full" ? privateDownloadByItem.get(item.id) ?? null : null,
    })),
    notes: notes.results.map((note) => ({
      authorDisplayName: note.authorDisplayName,
      body: note.status === "redacted" ? "" : note.body,
      createdAt: note.createdAt,
      notePublicId: note.id,
      redactedAt: note.redactedAt,
      status: note.status,
      updatedAt: note.updatedAt,
      version: note.version,
    })),
    paymentExceptions: paymentExceptions.results,
    payments: visibility === "full" ? payments.results : [],
    remediationRequests: remediationRequests.results,
  };
}
