import type { AppBindings } from "../platform/bindings";

export type CheckoutReservationItem = {
  orderItemId: string;
  quantity: number;
  variantId: string;
};

export type CheckoutReservationPlan = {
  guardBindings: unknown[];
  guardSql: string;
  requiredKeyCount: number;
  statements: D1PreparedStatement[];
};

/**
 * Build reservation writes and an exact-count guard for one D1 batch. The
 * caller must place the writes before its guarded order insert in that batch.
 */
export function prepareCheckoutReservationPlan(input: {
  env: AppBindings;
  expiresAt: string;
  items: CheckoutReservationItem[];
  reservationToken: string;
  shopId: string;
}): CheckoutReservationPlan {
  const statements = input.items.map((item) => input.env.PLATFORM_DB.prepare(`
    UPDATE inventory_keys
    SET status = 'reserved', reservation_token = ?, reserved_order_item_id = ?,
      reserved_until = ?
    WHERE id IN (
      SELECT id FROM inventory_keys
      WHERE shop_id = ? AND variant_id = ? AND status = 'available'
      ORDER BY id LIMIT ?
    )
      AND shop_id = ? AND variant_id = ? AND status = 'available'
  `).bind(
    input.reservationToken,
    item.orderItemId,
    input.expiresAt,
    input.shopId,
    item.variantId,
    item.quantity,
    input.shopId,
    item.variantId,
  ));
  const requiredKeyCount = input.items.reduce((sum, item) => sum + item.quantity, 0);
  // Each update is capped at its line quantity, so an exact aggregate count
  // proves every line reserved its full quantity without exceeding D1 bind
  // variable limits for carts with many variants.
  const guardSql = requiredKeyCount === 0
    ? "1 = 1"
    : "(SELECT COUNT(*) FROM inventory_keys WHERE shop_id = ? AND reservation_token = ? AND status = 'reserved') = ?";
  const guardBindings = requiredKeyCount === 0
    ? []
    : [input.shopId, input.reservationToken, requiredKeyCount];
  return {
    guardBindings,
    guardSql,
    requiredKeyCount,
    statements,
  };
}

/** Insert one ledger row per key while the keys still carry reservation data. */
export function prepareReservedFulfillmentItems(input: {
  createdAt: string;
  deliveredAt: string;
  env: AppBindings;
  fulfillmentId: string;
  reservationToken: string;
  shopId: string;
}): D1PreparedStatement {
  return input.env.PLATFORM_DB.prepare(`
    INSERT INTO fulfillment_items (
      id, shop_id, fulfillment_id, order_item_id, inventory_key_id,
      delivered_at, created_at
    )
    SELECT 'fit_' || lower(hex(randomblob(16))), ?, ?, reserved_order_item_id,
      id, ?, ?
    FROM inventory_keys
    WHERE shop_id = ? AND reservation_token = ? AND status = 'reserved'
    ORDER BY id
  `).bind(
    input.shopId,
    input.fulfillmentId,
    input.deliveredAt,
    input.createdAt,
    input.shopId,
    input.reservationToken,
  );
}
