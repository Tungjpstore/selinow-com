import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";

export const MAX_SHIPPING_FEE_MINOR = 1_000_000_000;

export type ShippingAddress = {
  addressLine: string;
  district: string;
  fullName: string;
  notes: string | null;
  phone: string;
  province: string;
  ward: string;
};

export type ShippingMethodSnapshot = {
  feeMinor: number;
  freeOverMinor: number | null;
  id: string;
  name: string;
};

/** Normalize and validate a Vietnamese shipping address for storage. */
export function parseShippingAddress(value: unknown): ShippingAddress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation_failed", 400, ["shipping_address_invalid"]);
  }
  const row = value as Record<string, unknown>;
  const field = (name: string, minimum: number, maximum: number): string => {
    const raw = row[name];
    if (typeof raw !== "string") throw new AppError("validation_failed", 400, ["shipping_address_invalid"]);
    const normalized = raw.trim().replace(/\s+/gu, " ");
    if (normalized.length < minimum || normalized.length > maximum) throw new AppError("validation_failed", 400, ["shipping_address_invalid"]);
    return normalized;
  };
  const phone = normalizeVietnamesePhone(row.phone);
  const notesRaw = row.notes;
  const notes = notesRaw === undefined || notesRaw === null || (typeof notesRaw === "string" && notesRaw.trim().length === 0)
    ? null
    : typeof notesRaw === "string" && notesRaw.trim().length <= 300 ? notesRaw.trim() : null;
  if (notes === null && typeof notesRaw === "string" && notesRaw.trim().length > 300) {
    throw new AppError("validation_failed", 400, ["shipping_address_invalid"]);
  }
  return {
    addressLine: field("addressLine", 4, 300),
    district: field("district", 2, 120),
    fullName: field("fullName", 1, 120),
    notes,
    phone,
    province: field("province", 2, 120),
    ward: field("ward", 2, 120),
  };
}

/** Accept 0xxxxxxxxx / +84xxxxxxxxx / 84xxxxxxxxx and store the 0-prefixed form. */
function normalizeVietnamesePhone(value: unknown): string {
  if (typeof value !== "string") throw new AppError("validation_failed", 400, ["shipping_phone_invalid"]);
  const compact = value.replace(/[\s.\-()]/gu, "");
  let normalized: string;
  if (/^0[0-9]{8,14}$/u.test(compact)) normalized = compact;
  else if (/^\+84[0-9]{8,13}$/u.test(compact)) normalized = `0${compact.slice(3)}`;
  else if (/^84[0-9]{8,13}$/u.test(compact)) normalized = `0${compact.slice(2)}`;
  else throw new AppError("validation_failed", 400, ["shipping_phone_invalid"]);
  if (normalized.length < 9 || normalized.length > 15) throw new AppError("validation_failed", 400, ["shipping_phone_invalid"]);
  return normalized;
}

export async function listStorefrontShippingMethods(env: AppBindings, shopId: string): Promise<ShippingMethodSnapshot[]> {
  const rows = await env.PLATFORM_DB.prepare(`
    SELECT id, name, fee_minor AS feeMinor, free_over_minor AS freeOverMinor
    FROM shop_shipping_methods
    WHERE shop_id = ? AND status = 'active'
    ORDER BY sort_order, id
    LIMIT 20
  `).bind(shopId).all<ShippingMethodSnapshot>();
  return rows.results;
}

/** Resolve one active method; unknown or archived methods 404 like catalog changes. */
export async function resolveShippingMethod(env: AppBindings, shopId: string, methodId: string): Promise<ShippingMethodSnapshot> {
  if (typeof methodId !== "string" || !/^[a-z0-9_:-]{8,64}$/u.test(methodId)) throw new AppError("validation_failed", 400, ["shipping_method_invalid"]);
  const row = await env.PLATFORM_DB.prepare(`
    SELECT id, name, fee_minor AS feeMinor, free_over_minor AS freeOverMinor
    FROM shop_shipping_methods
    WHERE shop_id = ? AND id = ? AND status = 'active'
    LIMIT 1
  `).bind(shopId, methodId).first<ShippingMethodSnapshot>();
  if (row === null) throw new AppError("shipping_method_not_found", 404);
  return row;
}

/** Free-shipping threshold applies to the post-discount merchandise amount. */
export function computeShippingFeeMinor(method: ShippingMethodSnapshot, merchandiseMinor: number): number {
  if (method.freeOverMinor !== null && merchandiseMinor >= method.freeOverMinor) return 0;
  return method.feeMinor;
}

export async function setVariantStockLevel(input: {
  env: AppBindings;
  onHand: number;
  requestId: string;
  shopPublicId: string;
  userId: string;
  variantId: string;
}): Promise<{ onHand: number; reserved: number }> {
  const member = await getShopForMember({ capability: "catalog:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  if (!Number.isSafeInteger(input.onHand) || input.onHand < 0 || input.onHand > 100_000_000) {
    throw new AppError("validation_failed", 400, ["variant_stock_invalid"]);
  }
  if (typeof input.variantId !== "string" || !/^var_[0-9a-f-]{36}$/u.test(input.variantId)) {
    throw new AppError("validation_failed", 400, ["variant_stock_invalid"]);
  }
  const nowIso = new Date().toISOString();
  // The shipping stock level only exists for physical (delivery_mode='shipping')
  // variants; the EXISTS guard keeps digital key inventory untouched.
  const updated = await input.env.PLATFORM_DB.prepare(`
    UPDATE variant_stock_levels
    SET on_hand = ?, updated_at = ?
    WHERE shop_id = ? AND variant_id = ?
      AND on_hand >= reserved
      AND EXISTS (
        SELECT 1 FROM product_variants AS variant
        INNER JOIN products AS product
          ON product.shop_id = variant.shop_id AND product.id = variant.product_id
        WHERE variant.shop_id = ? AND variant.id = ?
          AND product.delivery_mode = 'shipping'
      )
    RETURNING on_hand, reserved
  `).bind(input.onHand, nowIso, member.row.shop_id, input.variantId, member.row.shop_id, input.variantId).first<{ onHand: number; reserved: number }>();
  if (updated !== null) return updated;
  const inserted = await input.env.PLATFORM_DB.batch([
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO variant_stock_levels (id, shop_id, variant_id, on_hand, reserved, updated_at)
      SELECT ?, ?, variant.id, ?, 0, ?
      FROM product_variants AS variant
      INNER JOIN products AS product
        ON product.shop_id = variant.shop_id AND product.id = variant.product_id
      WHERE variant.shop_id = ? AND variant.id = ?
        AND product.delivery_mode = 'shipping'
        AND NOT EXISTS (
          SELECT 1 FROM variant_stock_levels
          WHERE shop_id = ? AND variant_id = ?
        )
    `).bind(createId("stk"), member.row.shop_id, input.onHand, nowIso, member.row.shop_id, input.variantId, member.row.shop_id, input.variantId),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, source_kind,
        retention_class, created_at
      ) SELECT ?, ?, 'user', ?, 'variant_stock.set', 'product_variant', ?, ?, ?, 'application', 'standard', ?
      WHERE EXISTS (SELECT 1 FROM variant_stock_levels WHERE shop_id = ? AND variant_id = ?)
    `).bind(createId("aud"), member.row.shop_id, input.userId, input.variantId, JSON.stringify({ onHand: input.onHand }), input.requestId, nowIso, member.row.shop_id, input.variantId),
  ]);
  if ((inserted[0]?.meta.changes ?? 0) !== 1) throw new AppError("resource_not_found", 404);
  return { onHand: input.onHand, reserved: 0 };
}

export async function listSellerShippingMethods(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<Array<ShippingMethodSnapshot & { sortOrder: number; status: string }>> {
  const member = await getShopForMember({ capability: "catalog:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, name, fee_minor AS feeMinor, free_over_minor AS freeOverMinor,
      sort_order AS sortOrder, status
    FROM shop_shipping_methods
    WHERE shop_id = ?
    ORDER BY sort_order, id
    LIMIT 50
  `).bind(member.row.shop_id).all<ShippingMethodSnapshot & { sortOrder: number; status: string }>();
  return rows.results;
}

export async function createShippingMethod(input: {
  data: Record<string, unknown>;
  env: AppBindings;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<ShippingMethodSnapshot & { sortOrder: number; status: string }> {
  const member = await getShopForMember({ capability: "catalog:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const { feeMinor, freeOverMinor, name, sortOrder } = parseShippingMethodInput(input.data);
  const id = createId("shm");
  const nowIso = new Date().toISOString();
  const inserted = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO shop_shipping_methods (id, shop_id, name, fee_minor, free_over_minor, status, sort_order, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, 'active', ?, ?, ?
    FROM shops WHERE id = ? AND status IN ('draft', 'active')
    RETURNING id, name, fee_minor AS feeMinor, free_over_minor AS freeOverMinor, sort_order AS sortOrder, status
  `).bind(id, member.row.shop_id, name, feeMinor, freeOverMinor, sortOrder, nowIso, nowIso, member.row.shop_id)
    .first<ShippingMethodSnapshot & { sortOrder: number; status: string }>();
  if (inserted === null) throw new AppError("shop_inactive", 409);
  await input.env.PLATFORM_DB.prepare(`
    INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at)
    VALUES (?, ?, 'user', ?, 'shipping_method.created', 'shop_shipping_method', ?, ?, ?, 'application', 'standard', ?)
  `).bind(createId("aud"), member.row.shop_id, input.userId, id, JSON.stringify({ feeMinor, freeOverMinor, name }), input.requestId, nowIso).run();
  return inserted;
}

export async function updateShippingMethod(input: {
  data: Record<string, unknown>;
  env: AppBindings;
  methodId: string;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<ShippingMethodSnapshot & { sortOrder: number; status: string }> {
  const member = await getShopForMember({ capability: "catalog:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const action = input.data.status;
  const nowIso = new Date().toISOString();
  if (action === "archived" && Object.keys(input.data).every((key) => key === "status")) {
    const archived = await input.env.PLATFORM_DB.prepare(`
      UPDATE shop_shipping_methods SET status = 'archived', updated_at = ?
      WHERE shop_id = ? AND id = ? AND status = 'active'
      RETURNING id, name, fee_minor AS feeMinor, free_over_minor AS freeOverMinor, sort_order AS sortOrder, status
    `).bind(nowIso, member.row.shop_id, input.methodId).first<ShippingMethodSnapshot & { sortOrder: number; status: string }>();
    if (archived === null) throw new AppError("resource_not_found", 404);
    return archived;
  }
  const { feeMinor, freeOverMinor, name, sortOrder } = parseShippingMethodInput(input.data, true);
  const updated = await input.env.PLATFORM_DB.prepare(`
    UPDATE shop_shipping_methods
    SET name = ?, fee_minor = ?, free_over_minor = ?, sort_order = ?, updated_at = ?
    WHERE shop_id = ? AND id = ?
    RETURNING id, name, fee_minor AS feeMinor, free_over_minor AS freeOverMinor, sort_order AS sortOrder, status
  `).bind(name, feeMinor, freeOverMinor, sortOrder, nowIso, member.row.shop_id, input.methodId)
    .first<ShippingMethodSnapshot & { sortOrder: number; status: string }>();
  if (updated === null) throw new AppError("resource_not_found", 404);
  await input.env.PLATFORM_DB.prepare(`
    INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at)
    VALUES (?, ?, 'user', ?, 'shipping_method.updated', 'shop_shipping_method', ?, ?, ?, 'application', 'standard', ?)
  `).bind(createId("aud"), member.row.shop_id, input.userId, input.methodId, JSON.stringify({ feeMinor, freeOverMinor, name }), input.requestId, nowIso).run();
  return updated;
}

function parseShippingMethodInput(data: Record<string, unknown>, partial = false): { feeMinor: number; freeOverMinor: number | null; name: string; sortOrder: number } {  const unknown = Object.keys(data).filter((key) => !new Set(["name", "feeMinor", "freeOverMinor", "sortOrder", "status"]).has(key));
  if (unknown.length > 0) throw new AppError("validation_failed", 400, ["shipping_method_field_invalid"]);
  const name = data.name;
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 80) throw new AppError("validation_failed", 400, ["shipping_method_name_invalid"]);
  const feeMinor = data.feeMinor;
  if (typeof feeMinor !== "number" || !Number.isSafeInteger(feeMinor) || feeMinor < 0 || feeMinor > MAX_SHIPPING_FEE_MINOR) throw new AppError("validation_failed", 400, ["shipping_method_fee_invalid"]);
  const freeOverRaw = data.freeOverMinor ?? null;
  if (freeOverRaw !== null && (typeof freeOverRaw !== "number" || !Number.isSafeInteger(freeOverRaw) || freeOverRaw < 0)) {
    throw new AppError("validation_failed", 400, ["shipping_method_free_over_invalid"]);
  }
  const sortOrder = data.sortOrder ?? 0;
  if (typeof sortOrder !== "number" || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 10_000) throw new AppError("validation_failed", 400, ["shipping_method_sort_invalid"]);
  if (partial && freeOverRaw !== null && feeMinor === 0 && freeOverRaw <= 0) {
    throw new AppError("validation_failed", 400, ["shipping_method_free_over_invalid"]);
  }
  return { feeMinor, freeOverMinor: freeOverRaw, name: name.trim(), sortOrder };
}

export type ShippingProgressView = {
  carrier: string | null;
  shippingState: "packing" | "shipped" | "delivered";
  trackingCode: string | null;
};

/**
 * Seller-side dispatch progress for a physical order. Packing opens a
 * 'manual' fulfillment row with shipping_state; shipped attaches carrier and
 * tracking; delivered closes it and marks the order fulfilled.
 */
export async function advanceOrderShipping(input: {
  carrier?: unknown;
  env: AppBindings;
  orderId: string;
  requestId: string;
  shippingState: unknown;
  shopPublicId: string;
  trackingCode?: unknown;
  userId: string;
}): Promise<ShippingProgressView> {
  const member = await getShopForMember({ capability: "fulfillment:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const state = input.shippingState;
  if (state !== "packing" && state !== "shipped" && state !== "delivered") {
    throw new AppError("validation_failed", 400, ["shipping_state_invalid"]);
  }
  const carrier = input.carrier === undefined || input.carrier === null || input.carrier === ""
    ? null
    : typeof input.carrier === "string" && input.carrier.trim().length >= 2 && input.carrier.trim().length <= 80 ? input.carrier.trim() : null;
  if (input.carrier !== undefined && input.carrier !== null && input.carrier !== "" && carrier === null) {
    throw new AppError("validation_failed", 400, ["shipping_carrier_invalid"]);
  }
  const trackingCode = input.trackingCode === undefined || input.trackingCode === null || input.trackingCode === ""
    ? null
    : typeof input.trackingCode === "string" && input.trackingCode.trim().length >= 4 && input.trackingCode.trim().length <= 64 ? input.trackingCode.trim() : null;
  if (input.trackingCode !== undefined && input.trackingCode !== null && input.trackingCode !== "" && trackingCode === null) {
    throw new AppError("validation_failed", 400, ["shipping_tracking_invalid"]);
  }
  if (state === "shipped" && carrier === null) {
    throw new AppError("validation_failed", 400, ["shipping_carrier_required"]);
  }
  const nowIso = new Date().toISOString();
  const order = await input.env.PLATFORM_DB.prepare(`
    SELECT orders.id AS orderId, orders.payment_status AS paymentStatus, orders.status,
      orders.fulfillment_status AS fulfillmentStatus,
      EXISTS (
        SELECT 1 FROM order_items
        INNER JOIN products ON products.shop_id = order_items.shop_id AND products.id = order_items.product_id
        WHERE order_items.shop_id = orders.shop_id AND order_items.order_id = orders.id
          AND products.delivery_mode = 'shipping'
      ) AS hasPhysical
    FROM orders
    WHERE orders.shop_id = ? AND orders.public_id = ?
    LIMIT 1
  `).bind(member.row.shop_id, input.orderId).first<{ fulfillmentStatus: string; hasPhysical: number; orderId: string; paymentStatus: string; status: string }>();
  if (order === null || order.hasPhysical !== 1) throw new AppError("resource_not_found", 404);
  if (order.paymentStatus !== "paid" || (order.status !== "processing" && order.status !== "completed")) {
    throw new AppError("order_not_paid", 409, ["shipping_dispatch_not_ready"]);
  }
  if (order.fulfillmentStatus === "fulfilled" && state !== "delivered") {
    throw new AppError("shipping_already_delivered", 409);
  }
  const existing = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shipping_state AS shippingState FROM fulfillments
    WHERE shop_id = ? AND order_id = ? AND fulfillment_type = 'manual' AND shipping_state IS NOT NULL
    ORDER BY created_at, id LIMIT 1
  `).bind(member.row.shop_id, order.orderId).first<{ id: string; shippingState: string }>();
  const results = await input.env.PLATFORM_DB.batch([
    existing === null
      ? input.env.PLATFORM_DB.prepare(`
          INSERT INTO fulfillments (id, shop_id, order_id, fulfillment_type, state, shipping_state, carrier, tracking_code, idempotency_key, created_at)
          SELECT ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM orders WHERE shop_id = ? AND id = ? AND payment_status = 'paid')
        `).bind(createId("ful"), member.row.shop_id, order.orderId, state === "delivered" ? "fulfilled" : "pending", state, carrier, trackingCode, `shipping:${order.orderId}:${state}`, nowIso, member.row.shop_id, order.orderId)
      : input.env.PLATFORM_DB.prepare(`
          UPDATE fulfillments
          SET state = ?, shipping_state = ?, carrier = COALESCE(?, carrier), tracking_code = COALESCE(?, tracking_code),
            fulfilled_at = CASE WHEN ? = 'delivered' THEN ? ELSE fulfilled_at END
          WHERE shop_id = ? AND id = ?
        `).bind(state === "delivered" ? "fulfilled" : "pending", state, carrier, trackingCode, state, nowIso, member.row.shop_id, existing.id),
    input.env.PLATFORM_DB.prepare(`
      UPDATE orders
      SET fulfillment_status = CASE WHEN ? = 'delivered' THEN 'fulfilled' ELSE 'reserved' END,
        status = CASE WHEN ? = 'delivered' THEN 'completed' ELSE status END,
        fulfilled_at = CASE WHEN ? = 'delivered' THEN COALESCE(fulfilled_at, ?) ELSE fulfilled_at END,
        updated_at = ?
      WHERE shop_id = ? AND id = ?
    `).bind(state, state, state, nowIso, nowIso, member.row.shop_id, order.orderId),
    input.env.PLATFORM_DB.prepare(`
      INSERT INTO audit_logs (id, shop_id, actor_type, actor_id, action, resource_type, resource_id, safe_metadata_json, request_id, source_kind, retention_class, created_at)
      VALUES (?, ?, 'user', ?, 'order.shipping_advanced', 'order', ?, ?, ?, 'application', 'standard', ?)
    `).bind(createId("aud"), member.row.shop_id, input.userId, input.orderId, JSON.stringify({ carrier, shippingState: state, trackingCode }), input.requestId, nowIso),
  ]);
  if ((results[0]?.meta.changes ?? 0) !== 1) throw new AppError("order_not_paid", 409, ["shipping_dispatch_not_ready"]);
  return { carrier, shippingState: state, trackingCode };
}
