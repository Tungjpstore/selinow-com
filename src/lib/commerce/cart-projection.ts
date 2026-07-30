import type { AppBindings } from "../platform/bindings";

/**
 * Read-only cart data used by channel renderers. The projection deliberately
 * has no mutation or authorization methods; the caller resolves the principal
 * and tenant before constructing the port.
 */
export type CommerceCartProjection = {
  cartId: string | null;
  discountCode: string | null;
  itemCount: number;
};

export interface CommerceReadOnlyCartProjectionPort {
  readCart(): Promise<CommerceCartProjection>;
}

/**
 * Telegram's renderer-facing cart projection. Unlike the legacy cart loader,
 * this path never creates or expires a cart while rendering an otherwise empty
 * cart.
 */
export class TelegramCartProjectionPort implements CommerceReadOnlyCartProjectionPort {
  constructor(private readonly input: { env: AppBindings; shopId: string; subjectHash: string }) {}

  async readCart(): Promise<CommerceCartProjection> {
    const nowIso = new Date().toISOString();
    const cart = await this.input.env.PLATFORM_DB.prepare(`
      SELECT carts.id AS cartId,
        carts.discount_code_normalized AS discountCode,
        COUNT(cart_items.variant_id) AS itemCount
      FROM carts
      LEFT JOIN cart_items
        ON cart_items.cart_id = carts.id
        AND cart_items.shop_id = carts.shop_id
      WHERE carts.shop_id = ? AND carts.channel = 'telegram' AND carts.subject_hash = ?
        AND carts.state = 'active' AND carts.expires_at > ?
      GROUP BY carts.id
      ORDER BY carts.created_at DESC
      LIMIT 1
    `).bind(this.input.shopId, this.input.subjectHash, nowIso).first<{ cartId: string; discountCode: string | null; itemCount: number }>();
    return cart ?? { cartId: null, discountCode: null, itemCount: 0 };
  }
}

export function createTelegramCartProjectionPort(input: { env: AppBindings; identity: { subjectHash: string }; shop: { id: string } }): CommerceReadOnlyCartProjectionPort {
  return new TelegramCartProjectionPort({ env: input.env, shopId: input.shop.id, subjectHash: input.identity.subjectHash });
}
