import { AppError } from "../core/errors";
import { assertSubscriptionAllows, subscriptionAllows } from "../billing/entitlements";
import { parseCookies } from "../http/cookies";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../i18n/locale";
import type { AppBindings } from "../platform/bindings";
import { assertCheckoutAllowed, hasFeature } from "../tenants/policy";
import { customDomainTurnstileAdmissionSql, hasFreshExactTurnstileAdmission } from "../domains/readiness";
import { classifyPlatformHost, getCanonicalStorefrontUrl, normalizeHostname } from "./routing";
import { parseStorefrontPublicDetails, type StorefrontPublicDetails } from "./public-details";
import { parseStorefrontContent, parseStorefrontTheme, type StorefrontContent, type StorefrontTheme } from "./theme";
import { PREMIUM_STOREFRONT_TEMPLATES_FEATURE, resolveStorefrontTemplate, type StorefrontTemplateDefinition } from "./templates";

type StorefrontShopRow = {
  brandingJson: string;
  canonicalHostname: string | null;
  canonicalDomainType: string | null;
  currency: string;
  currentPeriodEnd: string | null;
  currentDomainType: string;
  currentDomainValidationMetadataJson: string;
  currentHostname: string;
  defaultLocale: string;
  featureFlagsJson: string;
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
  timezone: string;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  subscriptionState: string | null;
  termsUrl: string | null;
};

type CatalogRow = {
  attributesJson: string | null;
  availableStock: number;
  categoryId: string | null;
  compareAtMinor: number | null;
  currency: string;
  deliveryMode: "digital" | "shipping";
  description: string;
  durationMinutes: number | null;
  fulfillmentType: "license_key" | "manual";
  productCreatedIso: string;
  maxPerOrder: number;
  minPerOrder: number;
  optionsJson: string;
  priceMinor: number;
  productId: string;
  productSlug: string;
  productTitle: string;
  productVersion: number;
  sku: string;
  soldCount: number;
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
  durationMinutes?: number;
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

/** Seller-authored spec row (products.attributes_json, migration 0107). */
export type StorefrontProductAttribute = { label: string; value: string };

export type StorefrontProduct = {
  attributes: StorefrontProductAttribute[];
  categoryId: string | null;
  deliveryMode: "digital" | "shipping";
  description: string;
  fulfillmentType: "license_key" | "manual";
  createdAt: string;
  id: string;
  imageUrl: string | null;
  images: string[];
  slug: string;
  /** TM4: real paid-order count (order_items joined on paid orders). */
  soldCount: number;
  title: string;
  variants: StorefrontVariant[];
  version: number;
};

/** TM4: auto badge kinds derived from real catalog signals. */
export type StorefrontBadge = "best" | "hot" | "new";

/** Detail-page product: the catalog product plus neighbors and shop promos. */
export type StorefrontProductDetail = {
  product: StorefrontProduct;
  promotions: StorefrontPromotion[];
  related: StorefrontProduct[];
};

/** Active shop discount window surfaced as urgency/voucher data (display-only). */
export type StorefrontPromotion = {
  code: string;
  endsAt: string | null;
  minimumMinor: number;
  type: "percentage" | "fixed";
  value: number;
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
  timezone: string;
  currentPeriodEnd?: string | null;
  trialEndsAt?: string | null;
  graceEndsAt?: string | null;
  template: StorefrontTemplateDefinition;
  theme: StorefrontTheme;
};

function storefrontAccess(status: string, subscriptionState: string, trialEndsAt: string | null, graceEndsAt: string | null, currentPeriodEnd: string | null, publishedVersion: number): StorefrontAccess {
  if (status === "draft" && publishedVersion < 1) return "coming_soon";
  if ((status === "active" || (status === "draft" && publishedVersion >= 1)) && subscriptionAllows({ currentPeriodEnd, graceEndsAt, subscriptionState, trialEndsAt })) return "live";
  return status === "draft" ? "coming_soon" : "suspended";
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
      shops.default_locale AS defaultLocale, shops.currency, shops.timezone,
      shop_domains.hostname_normalized AS currentHostname,
      shop_domains.type AS currentDomainType,
      shop_domains.validation_metadata_json AS currentDomainValidationMetadataJson,
      COALESCE(shop_settings.published_branding_json, '{}') AS brandingJson,
      COALESCE(shop_settings.published_storefront_json, '{}') AS storefrontJson,
      shop_settings.support_contact AS supportContact,
      shop_settings.terms_url AS termsUrl,
      shop_settings.privacy_url AS privacyUrl,
      shop_settings.refund_policy_url AS refundPolicyUrl,
      shop_settings.order_expiry_minutes AS orderExpiryMinutes,
      shop_settings.low_stock_threshold AS lowStockThreshold,
      shop_settings.published_version AS settingsVersion,
      (SELECT state FROM shop_subscriptions WHERE shop_id = shops.id ORDER BY created_at DESC, id DESC LIMIT 1) AS subscriptionState,
      (SELECT current_period_end FROM shop_subscriptions WHERE shop_id = shops.id ORDER BY created_at DESC, id DESC LIMIT 1) AS currentPeriodEnd,
      (SELECT trial_ends_at FROM shop_subscriptions WHERE shop_id = shops.id ORDER BY created_at DESC, id DESC LIMIT 1) AS trialEndsAt,
      (SELECT grace_ends_at FROM shop_subscriptions WHERE shop_id = shops.id ORDER BY created_at DESC, id DESC LIMIT 1) AS graceEndsAt,
      (SELECT plans.feature_flags_json
        FROM shop_subscriptions AS entitlement_subscription
        INNER JOIN plans ON plans.id = entitlement_subscription.plan_id
        WHERE entitlement_subscription.shop_id = shops.id
        ORDER BY entitlement_subscription.created_at DESC, entitlement_subscription.id DESC
        LIMIT 1) AS featureFlagsJson,
      canonical_domain.hostname_normalized AS canonicalHostname,
      canonical_domain.type AS canonicalDomainType
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
        OR (
          canonical_domain.ownership_verified_at IS NOT NULL
          AND canonical_domain.hostname_status = 'active'
          AND canonical_domain.ssl_status = 'active'
          AND canonical_domain.dns_status = 'active'
          AND ${customDomainTurnstileAdmissionSql("canonical_domain")}
          AND EXISTS (
            SELECT 1
            FROM shop_subscriptions AS canonical_subscription
            INNER JOIN plans ON plans.id = canonical_subscription.plan_id
            WHERE canonical_subscription.id = (
              SELECT latest_subscription.id
              FROM shop_subscriptions AS latest_subscription
              WHERE latest_subscription.shop_id = shops.id
              ORDER BY latest_subscription.created_at DESC, latest_subscription.id DESC
              LIMIT 1
            )
              AND json_extract(plans.feature_flags_json, '$.customDomain') = 1
          )
        )
      )
    WHERE shop_domains.hostname_normalized = ?
      AND shop_domains.status = 'active'
      AND shop_domains.deleted_at IS NULL
      AND (
        shop_domains.type = 'platform_subdomain'
        OR (
          shop_domains.ownership_verified_at IS NOT NULL
          AND shop_domains.hostname_status = 'active'
          AND shop_domains.ssl_status = 'active'
          AND shop_domains.dns_status = 'active'
          AND ${customDomainTurnstileAdmissionSql("shop_domains")}
          AND EXISTS (
            SELECT 1
            FROM shop_subscriptions AS current_domain_subscription
            INNER JOIN plans ON plans.id = current_domain_subscription.plan_id
            WHERE current_domain_subscription.id = (
              SELECT latest_subscription.id
              FROM shop_subscriptions AS latest_subscription
              WHERE latest_subscription.shop_id = shops.id
              ORDER BY latest_subscription.created_at DESC, latest_subscription.id DESC
              LIMIT 1
            )
              AND json_extract(plans.feature_flags_json, '$.customDomain') = 1
          )
        )
      )
    LIMIT 1
  `).bind(hostname).first<StorefrontShopRow>();
  if (row === null) throw new AppError("storefront_not_found", 404);
  const customDomainEntitled = hasFeature(row.featureFlagsJson, "customDomain");
  const currentDomainReady = (
    row.currentDomainType === "platform_subdomain"
    || (
      row.currentDomainType === "custom"
      && customDomainEntitled
      && hasFreshExactTurnstileAdmission({
        hostname,
        validationMetadataJson: row.currentDomainValidationMetadataJson,
      })
    )
  );
  if (!currentDomainReady || normalizeHostname(row.currentHostname) !== hostname) throw new AppError("storefront_not_found", 404);
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
  // Render-time safe fallback: an unknown, unavailable, or premium template on
  // a plan that lost the entitlement must degrade to the default, never break
  // the storefront.
  const template = resolveStorefrontTemplate({
    premiumEntitled: hasFeature(row.featureFlagsJson, PREMIUM_STOREFRONT_TEMPLATES_FEATURE),
    templateId: content.templateId,
  });
  return {
    access: storefrontAccess(row.status, subscriptionState, row.trialEndsAt, row.graceEndsAt, row.currentPeriodEnd, row.settingsVersion),
    canonicalHostname: row.canonicalHostname === null || (row.canonicalDomainType === "custom" && !customDomainEntitled)
      ? null
      : normalizeHostname(row.canonicalHostname),
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
    timezone: row.timezone,
    currentPeriodEnd: row.currentPeriodEnd,
    trialEndsAt: row.trialEndsAt,
    graceEndsAt: row.graceEndsAt,
    template,
    theme: parseStorefrontTheme(row.brandingJson),
  };
}

export function assertStorefrontLive(shop: StorefrontShop): void {
  if (shop.access === "coming_soon") throw new AppError("tenant_not_ready", 409);
  if (shop.access === "suspended") {
    if (shop.status === "active") {
      assertSubscriptionAllows({ currentPeriodEnd: shop.currentPeriodEnd, graceEndsAt: shop.graceEndsAt, subscriptionState: shop.subscriptionState, trialEndsAt: shop.trialEndsAt });
    }
    assertCheckoutAllowed({ shopStatus: shop.status, subscriptionState: shop.subscriptionState });
    throw new AppError("tenant_suspended", 403);
  }
}

export function assertStorefrontCheckout(shop: StorefrontShop): void {
  assertSubscriptionAllows({ currentPeriodEnd: shop.currentPeriodEnd, graceEndsAt: shop.graceEndsAt, subscriptionState: shop.subscriptionState, trialEndsAt: shop.trialEndsAt });
  assertCheckoutAllowed({ shopStatus: shop.status, subscriptionState: shop.subscriptionState });
}

export function canonicalRedirectFor(request: Request, shop: StorefrontShop): URL | null {
  return getCanonicalStorefrontUrl({ canonicalHostname: shop.canonicalHostname, request });
}

function stockState(row: CatalogRow, threshold: number): StockState {
  // Plain manual digital products are unbounded; keys and physical variants
  // both report a server-confirmed availability count.
  if (row.fulfillmentType === "manual" && row.deliveryMode !== "shipping") return "available";
  if (row.availableStock <= 0) return "out_of_stock";
  return row.availableStock <= threshold ? "low_stock" : "available";
}

const MAX_PRODUCT_ATTRIBUTES = 20;
const MAX_ATTRIBUTE_LABEL_LENGTH = 40;
const MAX_ATTRIBUTE_VALUE_LENGTH = 120;

/**
 * Parse products.attributes_json into bounded display rows. Malformed input
 * degrades to an empty list (the spec block simply does not render) instead
 * of failing the storefront.
 */
function parseProductAttributes(raw: string | null): StorefrontProductAttribute[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows: StorefrontProductAttribute[] = [];
  for (const entry of parsed.slice(0, MAX_PRODUCT_ATTRIBUTES)) {
    if (typeof entry !== "object" || entry === null) continue;
    const label = (entry as Record<string, unknown>).label;
    const value = (entry as Record<string, unknown>).value;
    if (typeof label !== "string" || typeof value !== "string") continue;
    const trimmedLabel = label.trim().slice(0, MAX_ATTRIBUTE_LABEL_LENGTH);
    const trimmedValue = value.trim().slice(0, MAX_ATTRIBUTE_VALUE_LENGTH);
    if (trimmedLabel === "" || trimmedValue === "") continue;
    rows.push({ label: trimmedLabel, value: trimmedValue });
  }
  return rows;
}

const MAX_PROMOTIONS = 3;

async function getStorefrontPromotions(env: AppBindings, shop: StorefrontShop): Promise<StorefrontPromotion[]> {
  const result = await env.PLATFORM_DB.prepare(`
    SELECT code_normalized AS code, type, value, minimum_minor AS minimumMinor, ends_at AS endsAt
    FROM discounts
    WHERE shop_id = ?
      AND status = 'active'
      AND (starts_at IS NULL OR starts_at <= ?)
      AND (ends_at IS NULL OR ends_at > ?)
    ORDER BY ends_at IS NULL, ends_at, created_at
    LIMIT 4
  `).bind(shop.id, new Date().toISOString(), new Date().toISOString()).all<{
    code: string;
    endsAt: string | null;
    minimumMinor: number;
    type: "percentage" | "fixed";
    value: number;
  }>();
  return result.results
    .slice(0, MAX_PROMOTIONS)
    .map((row) => ({ code: row.code, endsAt: row.endsAt, minimumMinor: row.minimumMinor, type: row.type, value: row.value }));
}

export async function getStorefrontCatalog(env: AppBindings, shop: StorefrontShop): Promise<{ categories: StorefrontCategory[]; products: StorefrontProduct[]; promotions: StorefrontPromotion[] }> {
  assertStorefrontLive(shop);
  const [categoryResult, productResult, imageResult, promotionResult] = await Promise.all([
    env.PLATFORM_DB.prepare(`
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
            AND category_visibility.channel_code = 'website'
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
      LIMIT 200
    `).bind(shop.id).all<StorefrontCategory>(),
    env.PLATFORM_DB.prepare(`
      SELECT products.id AS productId, products.category_id AS categoryId, products.slug AS productSlug,
        products.title AS productTitle, products.description, products.version AS productVersion,
        products.fulfillment_type AS fulfillmentType, products.delivery_mode AS deliveryMode,
        products.attributes_json AS attributesJson,
        products.created_at AS productCreatedIso,
        product_variants.id AS variantId, product_variants.sku, product_variants.title AS variantTitle,
        product_variants.options_json AS optionsJson, product_variants.price_minor AS priceMinor,
        product_variants.compare_at_minor AS compareAtMinor, product_variants.currency,
        product_variants.min_per_order AS minPerOrder, product_variants.max_per_order AS maxPerOrder,
        product_variants.version AS variantVersion, product_variants.duration_minutes AS durationMinutes,
        (SELECT COUNT(*) FROM order_items AS sold_items
          INNER JOIN orders AS sold_orders ON sold_orders.id = sold_items.order_id
            AND sold_orders.shop_id = sold_items.shop_id
            AND sold_orders.payment_status = 'paid'
          WHERE sold_items.shop_id = products.shop_id
            AND sold_items.product_id = products.id) AS soldCount,
        CASE WHEN products.delivery_mode = 'shipping' THEN COALESCE((
          SELECT variant_stock_levels.on_hand - variant_stock_levels.reserved
          FROM variant_stock_levels
          WHERE variant_stock_levels.shop_id = product_variants.shop_id
            AND variant_stock_levels.variant_id = product_variants.id
        ), 0) ELSE COUNT(CASE WHEN inventory_keys.status = 'available' THEN 1 END) END AS availableStock
      FROM products
      INNER JOIN catalog_channel_visibility
        ON catalog_channel_visibility.shop_id = products.shop_id
        AND catalog_channel_visibility.product_id = products.id
        AND catalog_channel_visibility.channel_code = 'website'
        AND catalog_channel_visibility.status = 'visible'
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
    env.PLATFORM_DB.prepare(`
      SELECT product_images.product_id AS productId, media_assets.public_id AS mediaPublicId
      FROM product_images
      INNER JOIN media_assets
        ON media_assets.shop_id = product_images.shop_id
        AND media_assets.id = product_images.media_asset_id
        AND media_assets.status = 'active'
      WHERE product_images.shop_id = ? AND product_images.status = 'active'
      ORDER BY product_images.sort_order, product_images.id
    `).bind(shop.id).all<{ mediaPublicId: string; productId: string }>(),
    getStorefrontPromotions(env, shop),
  ]);
  const imagesByProduct = new Map<string, string[]>();
  for (const row of imageResult.results) {
    const list = imagesByProduct.get(row.productId) ?? [];
    if (list.length < 8) list.push(`/media/${row.mediaPublicId}`);
    imagesByProduct.set(row.productId, list);
  }
  const products = new Map<string, StorefrontProduct>();
  for (const row of productResult.results) {
    let product = products.get(row.productId);
    if (product === undefined) {
      const images = imagesByProduct.get(row.productId) ?? [];
      product = {
        attributes: parseProductAttributes(row.attributesJson),
        categoryId: row.categoryId,
        deliveryMode: row.deliveryMode,
        description: row.description,
        fulfillmentType: row.fulfillmentType,
        id: row.productId,
        imageUrl: images[0] ?? null,
        images,
        createdAt: row.productCreatedIso,
        slug: row.productSlug,
        soldCount: row.soldCount,
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
    if (typeof row.durationMinutes === "number" && row.durationMinutes >= 5 && row.durationMinutes <= 720) variant.durationMinutes = row.durationMinutes;
    if (shop.content.showExactStock && (row.fulfillmentType === "license_key" || row.deliveryMode === "shipping")) variant.availableStock = row.availableStock;
    product.variants.push(variant);
  }
  return { categories: categoryResult.results, products: [...products.values()], promotions: promotionResult };
}

export async function getStorefrontProduct(env: AppBindings, shop: StorefrontShop, slug: string): Promise<StorefrontProductDetail> {
  const catalog = await getStorefrontCatalog(env, shop);
  const product = catalog.products.find((candidate) => candidate.slug === slug);
  if (product === undefined) throw new AppError("product_not_found", 404);
  const related = product.categoryId === null
    ? []
    : catalog.products
      .filter((candidate) => candidate.categoryId === product.categoryId && candidate.id !== product.id)
      .slice(0, 4);
  return { product, promotions: catalog.promotions, related };
}
