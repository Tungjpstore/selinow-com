import type { AppBindings } from "../platform/bindings";

type CatalogRow = {
  availableStock: number | string | null;
  categoryId: string | null;
  compareAtMinor: number | null;
  currency: string;
  description: string;
  fulfillmentType: "license_key" | "manual";
  maxPerOrder: number;
  minPerOrder: number;
  optionsJson: string;
  priceMinor: number;
  productId: string;
  productSlug: string;
  productTitle: string;
  productVersion: number;
  sku: string;
  variantId: string;
  variantTitle: string;
  variantVersion: number;
};

type CategoryRow = {
  description: string;
  id: string;
  name: string;
  slug: string;
};

export type PublicApiCatalogVariant = {
  compareAtMinor: number | null;
  currency: string;
  id: string;
  maxPerOrder: number;
  minPerOrder: number;
  options: Record<string, unknown>;
  priceMinor: number;
  sku: string;
  stockState: "available" | "low_stock" | "out_of_stock";
  title: string;
  version: number;
};

export type PublicApiCatalogProduct = {
  categoryId: string | null;
  description: string;
  fulfillmentType: "license_key" | "manual";
  id: string;
  slug: string;
  title: string;
  variants: PublicApiCatalogVariant[];
  version: number;
};

export type PublicApiCatalog = {
  categories: CategoryRow[];
  products: PublicApiCatalogProduct[];
};

function parseOptions(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stockState(row: CatalogRow, lowStockThreshold: number): PublicApiCatalogVariant["stockState"] {
  if (row.fulfillmentType === "manual") return "available";
  const availableStock = Number.isFinite(Number(row.availableStock)) ? Number(row.availableStock) : 0;
  if (availableStock <= 0) return "out_of_stock";
  return availableStock <= lowStockThreshold ? "low_stock" : "available";
}

export async function getPublicApiCatalog(input: {
  currency: string;
  env: AppBindings;
  shopId: string;
}): Promise<PublicApiCatalog> {
  const [settings, categories, products] = await Promise.all([
    input.env.PLATFORM_DB.prepare(`
      SELECT low_stock_threshold AS lowStockThreshold
      FROM shop_settings
      WHERE shop_id = ?
      LIMIT 1
    `).bind(input.shopId).first<{ lowStockThreshold: number }>(),
    input.env.PLATFORM_DB.prepare(`
      SELECT id, slug, name, description
      FROM product_categories
      WHERE shop_id = ? AND status = 'active'
      ORDER BY sort_order, id
      LIMIT 200
    `).bind(input.shopId).all<CategoryRow>(),
    input.env.PLATFORM_DB.prepare(`
      SELECT products.id AS productId,
        products.category_id AS categoryId,
        products.slug AS productSlug,
        products.title AS productTitle,
        products.description,
        products.version AS productVersion,
        products.fulfillment_type AS fulfillmentType,
        product_variants.id AS variantId,
        product_variants.sku,
        product_variants.title AS variantTitle,
        product_variants.options_json AS optionsJson,
        product_variants.price_minor AS priceMinor,
        product_variants.compare_at_minor AS compareAtMinor,
        product_variants.currency,
        product_variants.min_per_order AS minPerOrder,
        product_variants.max_per_order AS maxPerOrder,
        product_variants.version AS variantVersion,
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
      ORDER BY products.created_at, products.id,
        product_variants.created_at, product_variants.id
      LIMIT 500
    `).bind(input.shopId, input.currency).all<CatalogRow>(),
  ]);

  const lowStockThreshold = settings === null || !Number.isSafeInteger(settings.lowStockThreshold)
    ? 0
    : Math.max(0, settings.lowStockThreshold);
  const productMap = new Map<string, PublicApiCatalogProduct>();
  for (const row of products.results) {
    let product = productMap.get(row.productId);
    if (product === undefined) {
      product = {
        categoryId: row.categoryId,
        description: row.description,
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
      stockState: stockState(row, lowStockThreshold),
      title: row.variantTitle,
      version: row.variantVersion,
    });
  }
  return { categories: categories.results, products: [...productMap.values()] };
}
