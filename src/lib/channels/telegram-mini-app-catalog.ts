import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";

export type TelegramMiniAppCatalog = {
  categories: { description: string; id: string; name: string; slug: string }[];
  products: {
    categoryId: string | null;
    description: string;
    fulfillmentType: "license_key" | "manual";
    id: string;
    slug: string;
    title: string;
    variants: {
      compareAtMinor: number | null;
      currency: string;
      id: string;
      maxPerOrder: number;
      minPerOrder: number;
      options: Record<string, unknown>;
      priceMinor: number;
      sku: string;
      stockState: "available" | "out_of_stock";
      title: string;
      version: number;
    }[];
    version: number;
  }[];
};

type CategoryRow = { description: string; id: string; name: string; slug: string };
type VariantRow = {
  availableStock: number;
  compareAtMinor: number | null;
  currency: string;
  fulfillmentType: "license_key" | "manual";
  maxPerOrder: number;
  minPerOrder: number;
  optionsJson: string;
  priceMinor: number;
  productId: string;
  productSlug: string;
  productTitle: string;
  productDescription: string;
  productCategoryId: string | null;
  productVersion: number;
  sku: string;
  variantId: string;
  variantTitle: string;
  variantVersion: number;
};

function parseOptions(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    throw new AppError("catalog_unavailable", 503);
  }
}

export async function getTelegramMiniAppCatalog(input: {
  env: AppBindings;
  shopId: string;
}): Promise<TelegramMiniAppCatalog> {
  const categories = await input.env.PLATFORM_DB.prepare(`
    SELECT categories.id, categories.slug, categories.name, categories.description
    FROM product_categories AS categories
    WHERE categories.shop_id = ?
      AND categories.status = 'active'
      AND EXISTS (
        SELECT 1
        FROM products AS category_products
        INNER JOIN catalog_channel_visibility AS category_visibility
          ON category_visibility.shop_id = category_products.shop_id
          AND category_visibility.product_id = category_products.id
          AND category_visibility.channel_code = 'telegram.mini_app'
          AND category_visibility.status = 'visible'
        INNER JOIN product_variants AS category_variants
          ON category_variants.shop_id = category_products.shop_id
          AND category_variants.product_id = category_products.id
          AND category_variants.status = 'active'
        WHERE category_products.shop_id = categories.shop_id
          AND category_products.category_id = categories.id
          AND category_products.status = 'active'
      )
    ORDER BY categories.sort_order, categories.id
    LIMIT 500
  `).bind(input.shopId).all<CategoryRow>();

  const variants = await input.env.PLATFORM_DB.prepare(`
    SELECT product_variants.id AS variantId,
      product_variants.product_id AS productId,
      product_variants.sku,
      product_variants.title AS variantTitle,
      product_variants.options_json AS optionsJson,
      product_variants.price_minor AS priceMinor,
      product_variants.compare_at_minor AS compareAtMinor,
      product_variants.currency,
      product_variants.min_per_order AS minPerOrder,
      product_variants.max_per_order AS maxPerOrder,
      product_variants.version AS variantVersion,
      products.slug AS productSlug,
      products.title AS productTitle,
      products.description AS productDescription,
      products.category_id AS productCategoryId,
      products.fulfillment_type AS fulfillmentType,
      products.version AS productVersion,
      COUNT(CASE WHEN inventory_keys.status = 'available' THEN 1 END) AS availableStock
    FROM product_variants
    INNER JOIN products
      ON products.id = product_variants.product_id
      AND products.shop_id = product_variants.shop_id
      AND products.status = 'active'
    INNER JOIN catalog_channel_visibility
      ON catalog_channel_visibility.shop_id = products.shop_id
      AND catalog_channel_visibility.product_id = products.id
      AND catalog_channel_visibility.channel_code = 'telegram.mini_app'
      AND catalog_channel_visibility.status = 'visible'
    LEFT JOIN product_categories
      ON product_categories.id = products.category_id
      AND product_categories.shop_id = products.shop_id
      AND product_categories.status = 'active'
    LEFT JOIN inventory_keys
      ON inventory_keys.variant_id = product_variants.id
      AND inventory_keys.shop_id = product_variants.shop_id
    WHERE product_variants.shop_id = ?
      AND product_variants.status = 'active'
      AND (products.category_id IS NULL OR product_categories.id IS NOT NULL)
    GROUP BY product_variants.id
    ORDER BY products.created_at, products.id, product_variants.created_at, product_variants.id
    LIMIT 2000
  `).bind(input.shopId).all<VariantRow>();

  const productMap = new Map<string, TelegramMiniAppCatalog["products"][number]>();
  for (const row of variants.results) {
    let product = productMap.get(row.productId);
    if (product === undefined) {
      product = {
        categoryId: row.productCategoryId,
        description: row.productDescription,
        fulfillmentType: row.fulfillmentType,
        id: row.productId,
        slug: row.productSlug,
        title: row.productTitle,
        variants: [],
        version: row.productVersion,
      };
      productMap.set(row.productId, product);
    }
    product.variants.push({
      compareAtMinor: row.compareAtMinor,
      currency: row.currency,
      id: row.variantId,
      maxPerOrder: row.maxPerOrder,
      minPerOrder: row.minPerOrder,
      options: parseOptions(row.optionsJson),
      priceMinor: row.priceMinor,
      sku: row.sku,
      stockState: row.fulfillmentType === "manual" || row.availableStock > 0 ? "available" : "out_of_stock",
      title: row.variantTitle,
      version: row.variantVersion,
    });
  }

  return {
    categories: categories.results,
    products: [...productMap.values()],
  };
}
