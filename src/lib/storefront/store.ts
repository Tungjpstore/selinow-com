import { AppError } from "../core/errors";
import { parseCookies } from "../http/cookies";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../i18n/locale";
import type { AppBindings } from "../platform/bindings";
import { assertCheckoutAllowed } from "../tenants/policy";
import { classifyPlatformHost, getCanonicalStorefrontUrl, normalizeHostname } from "./routing";
import { parseStorefrontPublicDetails, type StorefrontPublicDetails } from "./public-details";
import { parseStorefrontContent, parseStorefrontTheme, type StorefrontContent, type StorefrontTheme } from "./theme";

type StorefrontShopRow = {
  brandingJson: string;
  canonicalHostname: string | null;
  currency: string;
  currentHostname: string;
  defaultLocale: string;
  id: string;
  lowStockThreshold: number;
  name: string;
  orderExpiryMinutes: number;
  publicId: string;
  privacyUrl: string | null;
  refundPolicyUrl: string | null;
  settingsVersion: number;
  slug: string;
  status: string;
  storefrontJson: string;
  supportContact: string | null;
  subscriptionState: string | null;
  termsUrl: string | null;
};

type CatalogRow = {
  availableStock: number;
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

export type StorefrontAccess = "coming_soon" | "live" | "suspended";
export type StockState = "available" | "low_stock" | "out_of_stock";

export type StorefrontVariant = {
  availableStock?: number;
  compareAtMinor: number | null;
  currency: string;
  id: string;
  maxPerOrder: number;
  minPerOrder: number;
  options: Record<string, unknown>;
  priceMinor: number;
  sku: string;
  stockState: StockState;
  title: string;
  version: number;
};

export type StorefrontProduct = {
  categoryId: string | null;
  description: string;
  fulfillmentType: "license_key" | "manual";
  id: string;
  slug: string;
  title: string;
  variants: StorefrontVariant[];
  version: number;
};

export type StorefrontCategory = { description: string; id: string; name: string; slug: string };

export type StorefrontShop = {
  access: StorefrontAccess;
  canonicalHostname: string | null;
  content: StorefrontContent;
  currency: string;
  currentHostname: string;
  defaultLocale: string;
  id: string;
  lowStockThreshold: number;
  name: string;
  orderExpiryMinutes: number;
  publicId: string;
  publicDetails: StorefrontPublicDetails;
  settingsVersion: number;
  slug: string;
  status: string;
  subscriptionState: string;
  theme: StorefrontTheme;
};

function storefrontAccess(status: string, subscriptionState: string): StorefrontAccess {
  if (status === "draft") return "coming_soon";
  if (status === "active" && new Set(["trialing", "active", "past_due"]).has(subscriptionState)) return "live";
  return "suspended";
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function resolveStorefrontShop(request: Request, env: AppBindings): Promise<StorefrontShop> {
  const hostname = normalizeHostname(new URL(request.url).hostname);
  if (classifyPlatformHost(hostname, env) !== "tenant-candidate") throw new AppError("storefront_not_found", 404);
  const row = await env.PLATFORM_DB.prepare(`
    SELECT shops.id, shops.public_id AS publicId, shops.slug, shops.name, shops.status,
      shops.default_locale AS defaultLocale, shops.currency,
      shop_domains.hostname_normalized AS currentHostname,
      COALESCE(shop_settings.published_branding_json, '{}') AS brandingJson,
      COALESCE(shop_settings.published_storefront_json, '{}') AS storefrontJson,
      shop_settings.support_contact AS supportContact,
      shop_settings.terms_url AS termsUrl,
      shop_settings.privacy_url AS privacyUrl,
      shop_settings.refund_policy_url AS refundPolicyUrl,
      shop_settings.order_expiry_minutes AS orderExpiryMinutes,
      shop_settings.low_stock_threshold AS lowStockThreshold,
      shop_settings.published_version AS settingsVersion,
      (SELECT state FROM shop_subscriptions WHERE shop_id = shops.id ORDER BY created_at DESC LIMIT 1) AS subscriptionState,
      canonical_domain.hostname_normalized AS canonicalHostname
    FROM shop_domains
    INNER JOIN shops ON shops.id = shop_domains.shop_id
    INNER JOIN shop_settings ON shop_settings.shop_id = shops.id
    LEFT JOIN shop_domains AS canonical_domain
      ON canonical_domain.id = shops.canonical_domain_id
      AND canonical_domain.shop_id = shops.id
      AND canonical_domain.status = 'active'
      AND canonical_domain.deleted_at IS NULL
      AND (
        canonical_domain.type = 'platform_subdomain'
        OR canonical_domain.ownership_verified_at IS NOT NULL
      )
    WHERE shop_domains.hostname_normalized = ?
      AND shop_domains.status = 'active'
      AND shop_domains.deleted_at IS NULL
      AND (
        shop_domains.type = 'platform_subdomain'
        OR shop_domains.ownership_verified_at IS NOT NULL
      )
    LIMIT 1
  `).bind(hostname).first<StorefrontShopRow>();
  if (row === null || normalizeHostname(row.currentHostname) !== hostname) throw new AppError("storefront_not_found", 404);
  const subscriptionState = row.subscriptionState ?? "canceled";
  // Resolve the same buyer hint order as middleware so locale-dependent
  // storefront defaults match the rendered document and cache dimension.
  const requestUrl = new URL(request.url);
  const locale = resolveLocale({
    acceptLanguage: request.headers.get("Accept-Language"),
    cookie: parseCookies(request.headers.get("Cookie")).get(LOCALE_COOKIE_NAME),
    explicit: requestUrl.searchParams.get("lang"),
    fallback: row.defaultLocale,
  });
  const content = parseStorefrontContent(row.storefrontJson, row.name, locale);
  return {
    access: storefrontAccess(row.status, subscriptionState),
    canonicalHostname: row.canonicalHostname === null ? null : normalizeHostname(row.canonicalHostname),
    content,
    currency: row.currency,
    currentHostname: hostname,
    defaultLocale: row.defaultLocale,
    id: row.id,
    lowStockThreshold: row.lowStockThreshold,
    name: row.name,
    orderExpiryMinutes: row.orderExpiryMinutes,
    publicId: row.publicId,
    publicDetails: parseStorefrontPublicDetails({
      deliveryText: content.deliveryText,
      privacyUrl: row.privacyUrl,
      refundPolicyUrl: row.refundPolicyUrl,
      locale,
      supportContact: row.supportContact,
      supportFallback: content.supportText,
      termsUrl: row.termsUrl,
    }),
    settingsVersion: row.settingsVersion,
    slug: row.slug,
    status: row.status,
    subscriptionState,
    theme: parseStorefrontTheme(row.brandingJson),
  };
}

export function assertStorefrontLive(shop: StorefrontShop): void {
  if (shop.access === "coming_soon") throw new AppError("tenant_not_ready", 409);
  if (shop.access === "suspended") {
    assertCheckoutAllowed({ shopStatus: shop.status, subscriptionState: shop.subscriptionState });
    throw new AppError("tenant_suspended", 403);
  }
}

export function assertStorefrontCheckout(shop: StorefrontShop): void {
  assertCheckoutAllowed({ shopStatus: shop.status, subscriptionState: shop.subscriptionState });
}

export function canonicalRedirectFor(request: Request, shop: StorefrontShop): URL | null {
  return getCanonicalStorefrontUrl({ canonicalHostname: shop.canonicalHostname, request });
}

function stockState(row: CatalogRow, threshold: number): StockState {
  if (row.fulfillmentType === "manual") return "available";
  if (row.availableStock <= 0) return "out_of_stock";
  return row.availableStock <= threshold ? "low_stock" : "available";
}

export async function getStorefrontCatalog(env: AppBindings, shop: StorefrontShop): Promise<{ categories: StorefrontCategory[]; products: StorefrontProduct[] }> {
  assertStorefrontLive(shop);
  const [categoryResult, productResult] = await Promise.all([
    env.PLATFORM_DB.prepare(`SELECT id, slug, name, description FROM product_categories WHERE shop_id = ? AND status = 'active' ORDER BY sort_order, id LIMIT 200`).bind(shop.id).all<StorefrontCategory>(),
    env.PLATFORM_DB.prepare(`
      SELECT products.id AS productId, products.category_id AS categoryId, products.slug AS productSlug,
        products.title AS productTitle, products.description, products.version AS productVersion,
        products.fulfillment_type AS fulfillmentType,
        product_variants.id AS variantId, product_variants.sku, product_variants.title AS variantTitle,
        product_variants.options_json AS optionsJson, product_variants.price_minor AS priceMinor,
        product_variants.compare_at_minor AS compareAtMinor, product_variants.currency,
        product_variants.min_per_order AS minPerOrder, product_variants.max_per_order AS maxPerOrder,
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
      ORDER BY products.created_at, products.id, product_variants.created_at, product_variants.id
      LIMIT 500
    `).bind(shop.id, shop.currency).all<CatalogRow>(),
  ]);
  const products = new Map<string, StorefrontProduct>();
  for (const row of productResult.results) {
    let product = products.get(row.productId);
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
      products.set(row.productId, product);
    }
    const variant: StorefrontVariant = {
      compareAtMinor: row.compareAtMinor,
      currency: row.currency,
      id: row.variantId,
      maxPerOrder: row.maxPerOrder,
      minPerOrder: row.minPerOrder,
      options: safeJson(row.optionsJson),
      priceMinor: row.priceMinor,
      sku: row.sku,
      stockState: stockState(row, shop.lowStockThreshold),
      title: row.variantTitle,
      version: row.variantVersion,
    };
    if (shop.content.showExactStock && row.fulfillmentType === "license_key") variant.availableStock = row.availableStock;
    product.variants.push(variant);
  }
  return { categories: categoryResult.results, products: [...products.values()] };
}

export async function getStorefrontProduct(env: AppBindings, shop: StorefrontShop, slug: string): Promise<StorefrontProduct> {
  const catalog = await getStorefrontCatalog(env, shop);
  const product = catalog.products.find((candidate) => candidate.slug === slug);
  if (product === undefined) throw new AppError("product_not_found", 404);
  return product;
}
