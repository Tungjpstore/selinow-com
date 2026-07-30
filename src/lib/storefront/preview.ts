import type { AppBindings } from "../platform/bindings";
import { getShopForMember } from "../tenants/store";
import type { StockState } from "./store";

export type SellerPreviewVariant = {
  availableStock?: number;
  compareAtMinor: number | null;
  currency: string;
  maxPerOrder: number;
  minPerOrder: number;
  priceMinor: number;
  stockState: StockState;
  title: string;
};

export type SellerPreviewProduct = {
  categoryId: string | null;
  description: string;
  fulfillmentType: "license_key" | "manual";
  slug: string;
  title: string;
  variants: SellerPreviewVariant[];
};

export type SellerPreviewCatalog = {
  products: SellerPreviewProduct[];
  truncated: boolean;
};

type PreviewRow = {
  availableStock: number;
  categoryId: string | null;
  compareAtMinor: number | null;
  currency: string;
  description: string;
  fulfillmentType: "license_key" | "manual";
  maxPerOrder: number;
  minPerOrder: number;
  priceMinor: number;
  productId: string;
  productSlug: string;
  productTitle: string;
  variantTitle: string;
};

function stockState(row: PreviewRow, threshold: number): StockState {
  if (row.fulfillmentType === "manual") return "available";
  if (row.availableStock <= 0) return "out_of_stock";
  return row.availableStock <= threshold ? "low_stock" : "available";
}

/**
 * Read only the safe, public-shaped catalog fields needed by the dashboard preview.
 * This intentionally does not use the catalog management projection because support
 * and viewer members can inspect the builder without receiving operational fields.
 */
export async function getSellerStorefrontPreviewCatalog(input: {
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<SellerPreviewCatalog> {
  const member = await getShopForMember({ capability: "shop:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT products.id AS productId,
      products.category_id AS categoryId,
      products.slug AS productSlug,
      products.title AS productTitle,
      products.description,
      products.fulfillment_type AS fulfillmentType,
      product_variants.title AS variantTitle,
      product_variants.price_minor AS priceMinor,
      product_variants.compare_at_minor AS compareAtMinor,
      product_variants.currency,
      product_variants.min_per_order AS minPerOrder,
      product_variants.max_per_order AS maxPerOrder,
      COUNT(CASE WHEN inventory_keys.status = 'available' THEN 1 END) AS availableStock
    FROM products
    INNER JOIN product_variants
      ON product_variants.shop_id = products.shop_id
      AND product_variants.product_id = products.id
      AND product_variants.status = 'active'
    LEFT JOIN inventory_keys
      ON inventory_keys.shop_id = product_variants.shop_id
      AND inventory_keys.variant_id = product_variants.id
    WHERE products.shop_id = ?
      AND products.status = 'active'
      AND product_variants.currency = ?
    GROUP BY product_variants.id
    ORDER BY products.created_at, products.id, product_variants.created_at, product_variants.id
    LIMIT 501
  `).bind(member.row.shop_id, member.row.currency).all<PreviewRow>();
  const thresholdRow = await input.env.PLATFORM_DB.prepare(
    "SELECT low_stock_threshold AS lowStockThreshold FROM shop_settings WHERE shop_id = ? LIMIT 1",
  ).bind(member.row.shop_id).first<{ lowStockThreshold: number }>();
  const threshold = thresholdRow?.lowStockThreshold ?? 5;
  const products = new Map<string, SellerPreviewProduct>();
  for (const row of rows.results.slice(0, 500)) {
    let product = products.get(row.productId);
    if (product === undefined) {
      product = {
        categoryId: row.categoryId,
        description: row.description,
        fulfillmentType: row.fulfillmentType,
        slug: row.productSlug,
        title: row.productTitle,
        variants: [],
      };
      products.set(row.productId, product);
    }
    const variant: SellerPreviewVariant = {
      compareAtMinor: row.compareAtMinor,
      currency: row.currency,
      maxPerOrder: row.maxPerOrder,
      minPerOrder: row.minPerOrder,
      priceMinor: row.priceMinor,
      stockState: stockState(row, threshold),
      title: row.variantTitle,
    };
    if (row.fulfillmentType === "license_key") variant.availableStock = row.availableStock;
    product.variants.push(variant);
  }
  return { products: [...products.values()], truncated: rows.results.length > 500 };
}
