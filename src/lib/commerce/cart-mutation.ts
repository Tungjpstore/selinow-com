import { constantTimeEqual, hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import type { CommerceCartMutation } from "./contracts";

export type CanonicalCartShop = {
  currency: string;
  id: string;
};

export type CanonicalCartVariant = {
  availableStock: number;
  currency: string;
  deliveryMode: "digital" | "shipping";
  fulfillmentType: "license_key" | "manual";
  maxPerOrder: number;
  minPerOrder: number;
  priceMinor: number;
  productId: string;
  productStatus: string;
  productTitle: string;
  productVersion: number;
  sku: string;
  status: string;
  title: string;
  variantId: string;
  version: number;
};

export type CartMutationReplay = {
  cartId: string;
  requestHash: string | null;
};

export async function loadCanonicalCartVariant(env: AppBindings, shopId: string, variantId: string): Promise<CanonicalCartVariant> {
  const row = await env.PLATFORM_DB.prepare(`SELECT product_variants.id AS variantId, product_variants.product_id AS productId, product_variants.sku, product_variants.title, product_variants.price_minor AS priceMinor, product_variants.currency, product_variants.min_per_order AS minPerOrder, product_variants.max_per_order AS maxPerOrder, product_variants.status, product_variants.version, products.title AS productTitle, products.status AS productStatus, products.version AS productVersion, products.fulfillment_type AS fulfillmentType, products.delivery_mode AS deliveryMode, CASE WHEN products.delivery_mode = 'shipping' THEN COALESCE((SELECT variant_stock_levels.on_hand - variant_stock_levels.reserved FROM variant_stock_levels WHERE variant_stock_levels.shop_id = product_variants.shop_id AND variant_stock_levels.variant_id = product_variants.id), 0) ELSE COUNT(CASE WHEN inventory_keys.status = 'available' THEN 1 END) END AS availableStock FROM product_variants INNER JOIN products ON products.id = product_variants.product_id AND products.shop_id = product_variants.shop_id LEFT JOIN inventory_keys ON inventory_keys.shop_id = product_variants.shop_id AND inventory_keys.variant_id = product_variants.id WHERE product_variants.shop_id = ? AND product_variants.id = ? GROUP BY product_variants.id LIMIT 1`).bind(shopId, variantId).first<CanonicalCartVariant>();
  if (row === null || row.status !== "active" || row.productStatus !== "active") throw new AppError("catalog_changed", 409);
  return row;
}

/**
 * Execute the channel-neutral cart mutation transaction. The channel adapter
 * supplies cart identity and its replay ledger; this function owns catalog,
 * quantity, discount and cart-item invariants for every channel.
 */
export async function applyCanonicalCartMutation(input: {
  env: AppBindings;
  mutation: CommerceCartMutation;
  shop: CanonicalCartShop;
  resolveCart: () => Promise<{ cartId: string; expiresAt: string; subjectHash: string }>;
  findReplay: (requestHash: string) => Promise<CartMutationReplay | null>;
  recordReplay: (value: { cartId: string; requestHash: string; nowIso: string; expiresAt: string; subjectHash: string }) => D1PreparedStatement;
}): Promise<{ cartId: string; replayed: boolean }> {
  const requestHash = await sha256Json(input.mutation);
  const initialReplay = await input.findReplay(requestHash);
  if (initialReplay !== null) return { cartId: initialReplay.cartId, replayed: true };
  const cart = await input.resolveCart();
  const now = new Date();
  const nowIso = now.toISOString();
  const statements: D1PreparedStatement[] = [];
  if (input.mutation.kind === "item.increment") {
    const variant = await loadCanonicalCartVariant(input.env, input.shop.id, input.mutation.variantId);
    if (variant.currency !== input.shop.currency) throw new AppError("catalog_changed", 409);
    const existing = await input.env.PLATFORM_DB.prepare("SELECT quantity FROM cart_items WHERE cart_id = ? AND shop_id = ? AND variant_id = ? LIMIT 1").bind(cart.cartId, input.shop.id, input.mutation.variantId).first<{ quantity: number }>();
    const quantity = (existing?.quantity ?? 0) + input.mutation.quantity;
    if (quantity < variant.minPerOrder || quantity > variant.maxPerOrder) throw new AppError("quantity_unavailable", 409);
    if ((variant.fulfillmentType === "license_key" || variant.deliveryMode === "shipping") && variant.availableStock < quantity) throw new AppError("inventory_unavailable", 409);
    statements.push(input.env.PLATFORM_DB.prepare(`
      INSERT INTO cart_items (cart_id, shop_id, variant_id, quantity)
      SELECT ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM carts
        WHERE id = ? AND shop_id = ? AND state = 'active' AND expires_at > ?
      ) AND EXISTS (
        SELECT 1
        FROM product_variants AS variant
        INNER JOIN products AS product
          ON product.id = variant.product_id AND product.shop_id = variant.shop_id
        WHERE variant.id = ? AND variant.shop_id = ?
          AND variant.status = 'active' AND product.status = 'active'
          AND variant.currency = ?
          AND ? BETWEEN variant.min_per_order AND variant.max_per_order
          AND (
            product.fulfillment_type != 'license_key'
            OR (
              SELECT COUNT(*) FROM inventory_keys
              WHERE shop_id = variant.shop_id AND variant_id = variant.id
                AND status = 'available'
            ) >= ?
          )
          AND (
            product.delivery_mode != 'shipping'
            OR (
              SELECT COALESCE(variant_stock_levels.on_hand - variant_stock_levels.reserved, 0)
              FROM variant_stock_levels
              WHERE variant_stock_levels.shop_id = variant.shop_id
                AND variant_stock_levels.variant_id = variant.id
            ) >= ?
          )
      )
      ON CONFLICT(cart_id, variant_id) DO UPDATE SET
        quantity = cart_items.quantity + excluded.quantity
      WHERE cart_items.shop_id = excluded.shop_id
        AND EXISTS (
          SELECT 1
          FROM product_variants AS variant
          INNER JOIN products AS product
            ON product.id = variant.product_id AND product.shop_id = variant.shop_id
          WHERE variant.id = excluded.variant_id
            AND variant.shop_id = excluded.shop_id
            AND variant.status = 'active' AND product.status = 'active'
            AND variant.currency = ?
              AND cart_items.quantity + excluded.quantity
              BETWEEN variant.min_per_order AND variant.max_per_order
            AND (
              product.fulfillment_type != 'license_key'
              OR (
                SELECT COUNT(*) FROM inventory_keys
                WHERE shop_id = variant.shop_id AND variant_id = variant.id
                  AND status = 'available'
              ) >= cart_items.quantity + excluded.quantity
            )
            AND (
              product.delivery_mode != 'shipping'
              OR (
                SELECT COALESCE(variant_stock_levels.on_hand - variant_stock_levels.reserved, 0)
                FROM variant_stock_levels
                WHERE variant_stock_levels.shop_id = variant.shop_id
                  AND variant_stock_levels.variant_id = variant.id
              ) >= cart_items.quantity + excluded.quantity
            )
        )
    `).bind(
      cart.cartId,
      input.shop.id,
      input.mutation.variantId,
      input.mutation.quantity,
      cart.cartId,
      input.shop.id,
      nowIso,
      input.mutation.variantId,
      input.shop.id,
      input.shop.currency,
      input.mutation.quantity,
      input.mutation.quantity,
      input.mutation.quantity,
      input.shop.currency,
    ));
  } else {
    const discount = await input.env.PLATFORM_DB.prepare("SELECT id FROM discounts WHERE shop_id = ? AND code_normalized = ? AND status = 'active' AND (starts_at IS NULL OR starts_at <= ?) AND (ends_at IS NULL OR ends_at > ?) LIMIT 1").bind(input.shop.id, input.mutation.code, nowIso, nowIso).first();
    if (discount === null) throw new AppError("discount_invalid", 409);
    statements.push(input.env.PLATFORM_DB.prepare("UPDATE carts SET discount_code_normalized = ?, updated_at = ? WHERE id = ? AND shop_id = ? AND state = 'active' AND expires_at > ?").bind(input.mutation.code, nowIso, cart.cartId, input.shop.id, nowIso));
  }
  // Keep replay immediately after the mutation: SQLite changes() makes a
  // same-key conflict roll back the authoritative write in the same D1 batch.
  statements.push(input.recordReplay({ cartId: cart.cartId, expiresAt: cart.expiresAt, nowIso, requestHash, subjectHash: cart.subjectHash }));
  statements.push(input.env.PLATFORM_DB.prepare("UPDATE carts SET updated_at = ? WHERE id = ? AND shop_id = ? AND state = 'active' AND expires_at > ? AND changes() = 1").bind(nowIso, cart.cartId, input.shop.id, nowIso));
  let results: D1Result[];
  try {
    results = await input.env.PLATFORM_DB.batch(statements);
  } catch {
    const replay = await input.findReplay(requestHash);
    if (replay === null) throw new AppError("cart_failed", 409);
    if (replay.requestHash !== null && replay.requestHash !== requestHash) throw new AppError("idempotency_conflict", 409);
    return { cartId: replay.cartId, replayed: true };
  }
  if ((results[0]?.meta.changes ?? 0) !== 1 || (results[1]?.meta.changes ?? 0) !== 1) {
    if (input.mutation.kind === "item.increment") {
      const variant = await loadCanonicalCartVariant(input.env, input.shop.id, input.mutation.variantId);
      if (variant.currency !== input.shop.currency) throw new AppError("catalog_changed", 409);
      const current = await input.env.PLATFORM_DB.prepare("SELECT quantity FROM cart_items WHERE cart_id = ? AND shop_id = ? AND variant_id = ? LIMIT 1").bind(cart.cartId, input.shop.id, input.mutation.variantId).first<{ quantity: number }>();
      const quantity = (current?.quantity ?? 0) + input.mutation.quantity;
      if (quantity < variant.minPerOrder || quantity > variant.maxPerOrder) throw new AppError("quantity_unavailable", 409);
      if ((variant.fulfillmentType === "license_key" || variant.deliveryMode === "shipping") && variant.availableStock < quantity) throw new AppError("inventory_unavailable", 409);
    }
    throw new AppError("cart_failed", 409);
  }
  return { cartId: cart.cartId, replayed: false };
}

export function createCartMutationId(): string {
  return createId("cmr");
}

/** Remove replay records after their cart mutation window has closed. */
export async function purgeCartMutationReplays(env: AppBindings, now = new Date()): Promise<number> {
  const result = await env.PLATFORM_DB.prepare(
    "DELETE FROM cart_mutations WHERE expires_at <= ?",
  ).bind(now.toISOString()).run();
  return result.meta.changes;
}

/** Anonymous website adapter for the canonical mutation transaction. */
export async function applyWebsiteCartMutation(input: {
  cartId: string;
  cartToken: string;
  env: AppBindings;
  idempotencyKey: string;
  mutation: CommerceCartMutation;
  shop: CanonicalCartShop;
}): Promise<{ cartId: string; replayed: boolean }> {
  const row = await input.env.PLATFORM_DB.prepare("SELECT id AS cartId, subject_hash AS subjectHash, state, expires_at AS expiresAt FROM carts WHERE id = ? AND shop_id = ? AND channel = 'web' LIMIT 1").bind(input.cartId, input.shop.id).first<{ cartId: string; expiresAt: string; state: string; subjectHash: string }>();
  if (row === null) throw new AppError("cart_not_found", 404);
  const subjectHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `cart:${input.shop.id}`, input.cartToken);
  if (!constantTimeEqual(row.subjectHash, subjectHash)) throw new AppError("cart_not_found", 404);
  const idempotencyKeyHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, `cart-mutation:${input.shop.id}`, input.idempotencyKey);
  const findReplay = async (requestHash: string): Promise<CartMutationReplay | null> => {
    const nowIso = new Date().toISOString();
    const replay = await input.env.PLATFORM_DB.prepare(`
      SELECT cart_mutations.cart_id AS cartId, cart_mutations.request_hash AS requestHash
      FROM cart_mutations
      INNER JOIN carts
        ON carts.id = cart_mutations.cart_id
       AND carts.shop_id = cart_mutations.shop_id
      WHERE cart_mutations.shop_id = ?
        AND cart_mutations.subject_hash = ?
        AND cart_mutations.idempotency_key_hash = ?
        AND cart_mutations.expires_at > ?
        AND carts.channel = 'web'
        AND carts.subject_hash = ?
        AND carts.state = 'active'
        AND carts.expires_at > ?
      LIMIT 1
    `).bind(
      input.shop.id,
      row.subjectHash,
      idempotencyKeyHash,
      nowIso,
      row.subjectHash,
      nowIso,
    ).first<{ cartId: string; requestHash: string }>();
    if (replay === null) return null;
    if (replay.cartId !== input.cartId || replay.requestHash !== requestHash) throw new AppError("idempotency_conflict", 409);
    return replay;
  };
  return applyCanonicalCartMutation({
    env: input.env,
    findReplay,
    mutation: input.mutation,
    recordReplay: ({ cartId, expiresAt, nowIso, requestHash }) => input.env.PLATFORM_DB.prepare("INSERT INTO cart_mutations (id, shop_id, cart_id, subject_hash, idempotency_key_hash, request_hash, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM carts WHERE id = ? AND shop_id = ? AND channel = 'web' AND state = 'active' AND expires_at > ?) AND changes() = 1").bind(createCartMutationId(), input.shop.id, cartId, row.subjectHash, idempotencyKeyHash, requestHash, nowIso, expiresAt, cartId, input.shop.id, nowIso),
    resolveCart: () => {
      if (row.state !== "active" || row.expiresAt <= new Date().toISOString()) throw new AppError("cart_not_found", 404);
      return Promise.resolve({ cartId: row.cartId, expiresAt: row.expiresAt, subjectHash: row.subjectHash });
    },
    shop: input.shop,
  });
}
