import type { AppBindings } from "../platform/bindings";
import { encodePublicApiCursor, type PublicApiPage } from "./pagination";

type InventoryRow = {
  availableCount: number;
  createdAt: string;
  productId: string;
  productSlug: string;
  productTitle: string;
  reservedCount: number;
  revokedCount: number;
  soldCount: number;
  sku: string;
  variantId: string;
  variantTitle: string;
  variantVersion: number;
};

export type PublicApiInventoryItem = InventoryRow & {
  stockState: "available" | "low_stock" | "out_of_stock";
};

export type PublicApiInventory = {
  items: PublicApiInventoryItem[];
  limit: number;
  nextCursor: string | null;
};

function integer(value: number | string | null): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
export async function getPublicApiInventory(input: {
  env: AppBindings;
  lowStockThreshold: number;
  page: PublicApiPage;
  shopId: string;
}): Promise<PublicApiInventory> {
  const cursor = input.page.cursor;
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT product_variants.id AS variantId,
      product_variants.sku,
      product_variants.title AS variantTitle,
      product_variants.version AS variantVersion,
      product_variants.created_at AS createdAt,
      products.id AS productId,
      products.slug AS productSlug,
      products.title AS productTitle,
      COUNT(CASE WHEN inventory_keys.status = 'available' THEN 1 END) AS availableCount,
      COUNT(CASE WHEN inventory_keys.status = 'reserved' THEN 1 END) AS reservedCount,
      COUNT(CASE WHEN inventory_keys.status = 'sold' THEN 1 END) AS soldCount,
      COUNT(CASE WHEN inventory_keys.status = 'revoked' THEN 1 END) AS revokedCount
    FROM product_variants
    INNER JOIN products
      ON products.shop_id = product_variants.shop_id
      AND products.id = product_variants.product_id
      AND products.status = 'active'
    LEFT JOIN inventory_keys
      ON inventory_keys.shop_id = product_variants.shop_id
      AND inventory_keys.variant_id = product_variants.id
    WHERE product_variants.shop_id = ?
      AND product_variants.status = 'active'
      AND (? IS NULL OR product_variants.created_at < ?
        OR (product_variants.created_at = ? AND product_variants.id < ?))
    GROUP BY product_variants.id
    ORDER BY product_variants.created_at DESC, product_variants.id DESC
    LIMIT ?
  `).bind(
    input.shopId,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.createdAt ?? null,
    cursor?.id ?? null,
    input.page.limit + 1,
  ).all<InventoryRow>();
  const hasMore = rows.results.length > input.page.limit;
  const visibleRows = hasMore ? rows.results.slice(0, input.page.limit) : rows.results;
  const items = visibleRows.map((row) => {
    const availableCount = integer(row.availableCount);
    const lowStockThreshold = Number.isSafeInteger(input.lowStockThreshold) && input.lowStockThreshold >= 0
      ? input.lowStockThreshold
      : 0;
    return {
      ...row,
      availableCount,
      reservedCount: integer(row.reservedCount),
      revokedCount: integer(row.revokedCount),
      soldCount: integer(row.soldCount),
      stockState: availableCount === 0
        ? "out_of_stock" as const
        : availableCount <= lowStockThreshold ? "low_stock" as const : "available" as const,
    };
  });
  const last = visibleRows.at(-1);
  return {
    items,
    limit: input.page.limit,
    nextCursor: hasMore && last !== undefined
      ? encodePublicApiCursor({ createdAt: last.createdAt, id: last.variantId })
      : null,
  };
}
