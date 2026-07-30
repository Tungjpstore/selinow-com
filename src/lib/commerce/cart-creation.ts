import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { loadCanonicalCartVariant } from "./cart-mutation";
import type { CommerceCartItem } from "./contracts";

type CanonicalCartChannel = "telegram" | "web";

export type CanonicalCartCreationShop = { currency: string; id: string };

export async function findCanonicalActiveCart(input: {
  channel: CanonicalCartChannel;
  env: AppBindings;
  shopId: string;
  subjectHash: string;
}): Promise<{ cartId: string; expiresAt: string } | null> {
  const nowIso = new Date().toISOString();
  await input.env.PLATFORM_DB.prepare("UPDATE carts SET state = 'expired', updated_at = ? WHERE shop_id = ? AND channel = ? AND subject_hash = ? AND state = 'active' AND expires_at <= ?").bind(nowIso, input.shopId, input.channel, input.subjectHash, nowIso).run();
  return input.env.PLATFORM_DB.prepare("SELECT id AS cartId, expires_at AS expiresAt FROM carts WHERE shop_id = ? AND channel = ? AND subject_hash = ? AND state = 'active' AND expires_at > ? LIMIT 1").bind(input.shopId, input.channel, input.subjectHash, nowIso).first<{ cartId: string; expiresAt: string }>();
}

async function assertCartItems(input: { env: AppBindings; items: readonly CommerceCartItem[]; shop: CanonicalCartCreationShop }): Promise<void> {
  for (const item of input.items) {
    const variant = await loadCanonicalCartVariant(input.env, input.shop.id, item.variantId);
    if (variant.currency !== input.shop.currency) throw new AppError("catalog_changed", 409);
    if (item.quantity < variant.minPerOrder || item.quantity > variant.maxPerOrder) throw new AppError("quantity_unavailable", 409);
    if (variant.fulfillmentType === "license_key" && variant.availableStock < item.quantity) throw new AppError("inventory_unavailable", 409);
  }
}

/** Create the authoritative cart row, optionally reusing a principal cart. */
export async function createCanonicalCart(input: {
  channel: CanonicalCartChannel;
  env: AppBindings;
  items: readonly CommerceCartItem[];
  locale: string;
  additionalStatements?: (cart: { cartId: string; expiresAt: string; nowIso: string }) => readonly D1PreparedStatement[];
  reuseActiveSubject?: boolean;
  shop: CanonicalCartCreationShop;
  subjectHash: string;
}): Promise<{ cartId: string; expiresAt: string; replayed: boolean }> {
  const now = new Date();
  const nowIso = now.toISOString();
  if (input.reuseActiveSubject === true) {
    const existing = await findCanonicalActiveCart({ channel: input.channel, env: input.env, shopId: input.shop.id, subjectHash: input.subjectHash });
    if (existing !== null) return { ...existing, replayed: true };
  }
  await assertCartItems(input);
  const cartId = createId("cart");
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
  try {
    await input.env.PLATFORM_DB.batch([
      input.env.PLATFORM_DB.prepare("INSERT INTO carts (id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)").bind(cartId, input.shop.id, input.channel, input.subjectHash, input.locale, expiresAt, nowIso, nowIso),
      ...input.items.map((item) => input.env.PLATFORM_DB.prepare("INSERT INTO cart_items (cart_id, shop_id, variant_id, quantity) VALUES (?, ?, ?, ?)").bind(cartId, input.shop.id, item.variantId, item.quantity)),
      ...(input.additionalStatements?.({ cartId, expiresAt, nowIso }) ?? []),
    ]);
    return { cartId, expiresAt, replayed: false };
  } catch {
    if (input.reuseActiveSubject === true) {
      const replay = await input.env.PLATFORM_DB.prepare("SELECT id AS cartId, expires_at AS expiresAt FROM carts WHERE shop_id = ? AND channel = ? AND subject_hash = ? AND state = 'active' AND expires_at > ? LIMIT 1").bind(input.shop.id, input.channel, input.subjectHash, nowIso).first<{ cartId: string; expiresAt: string }>();
      if (replay !== null) return { ...replay, replayed: true };
    }
    throw new AppError("cart_failed", 409);
  }
}
