import type { AppBindings } from "../platform/bindings";
import { BILLING_MARKETS, PUBLIC_PLAN_CATALOG, PUBLIC_PLAN_CODES, type BillingMarketCode, type PublicPlanCode } from "../billing/plan-catalog";
import {
  EFFECTIVE_PLAN_OFFER_SQL_PREDICATE,
  isPublishedProviderPriceReference,
  isSellablePlanOffer,
  isSellablePlanOfferProjection,
  projectLatestSellablePlanOffers,
  SELLABLE_PUBLIC_PLAN_SQL_PREDICATE,
  type PlanOfferRevision,
  type SellablePlanOffer,
} from "../billing/catalog";
import { createMarketingTranslator } from "../i18n/catalogs/marketing";
import { normalizeSupportedLocale } from "../i18n/locale";

export type MarketingPlan = {
  code: string;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  name: string;
  prices?: MarketingPrice[];
  recommended?: boolean;
};

/**
 * Render-only catalog used by local preview when D1 has not received the paid
 * billing migrations yet. It never authorizes checkout or changes server state.
 */
export function getMarketingPreviewPlans(): MarketingPlan[] {
  return PUBLIC_PLAN_CODES.map((code: PublicPlanCode) => {
    const snapshot = PUBLIC_PLAN_CATALOG[code];
    return {
      code,
      features: {
        analytics: snapshot.features.analytics,
        apiRead: snapshot.features.api,
        audit: snapshot.features.audit,
        automation: snapshot.features.automation,
        catalog: snapshot.features.catalog,
        customDomain: snapshot.features.customDomain,
        dataExport: snapshot.features.dataExport,
        inventory: snapshot.features.inventory,
        manualFulfillment: snapshot.features.manualFulfillment,
        privateDownloads: snapshot.features.privateDownloads,
        premiumStorefrontTemplates: snapshot.features.premiumStorefrontTemplates,
        sellerPayments: snapshot.features.sellerPayments,
        storefront: snapshot.features.storefront,
        telegram: snapshot.features.telegram,
      },
      limits: {
        apiReadRequestsPerMonth: snapshot.limits.api_requests,
        apiRequestsPerBillingPeriod: snapshot.limits.api_requests,
        auditRetentionDays: snapshot.limits.audit_retention_days,
        automationRules: snapshot.limits.automation_rules,
        automationRunsPerBillingPeriod: snapshot.limits.automation_runs,
        automationRunsPerMonth: snapshot.limits.automation_runs,
        customers: snapshot.limits.customers_total,
        customDomains: snapshot.limits.active_custom_domains,
        downloadsPerMonth: snapshot.limits.downloads_served,
        exportsPerMonth: snapshot.limits.exports_created,
        ordersPerBillingPeriod: snapshot.limits.orders_created,
        ordersPerMonth: snapshot.limits.orders_created,
        products: snapshot.limits.products_non_archived,
        staffSeats: snapshot.limits.active_member_seats,
        storageBytes: snapshot.limits.storage_bytes,
      },
      name: snapshot.name ?? code,
      // Baseline amounts are a validation contract, not an active commercial
      // offer. Without a real Dodo price reference, keep the preview useful
      // for capability comparison but do not render prices or offers.
      prices: [],
      recommended: code === "pro",
    };
  });
}

export type MarketingPrice = SellablePlanOffer & {
  providerCode?: string;
  providerPriceRef?: string;
};

export type MarketingStructuredOffer = {
  "@type": "Offer";
  category: string;
  name: string;
  price: number;
  priceCurrency: string;
};

function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isRenderableMarketingPrice(price: MarketingPrice): boolean {
  if (!isSellablePlanOfferProjection(price)) return false;
  if (price.providerCode === undefined) return price.providerPriceRef === undefined || isPublishedProviderPriceReference(price.providerPriceRef);
  return isSellablePlanOffer(price);
}

/** Markets with a complete offer for every public plan. */
export function getMarketingAvailableMarkets(plans: readonly MarketingPlan[]): BillingMarketCode[] {
  if (plans.length !== PUBLIC_PLAN_CODES.length || !PUBLIC_PLAN_CODES.every((code) => plans.some((plan) => plan.code === code))) return [];
  return BILLING_MARKETS.filter((market) => plans.every((plan) =>
    (plan.prices ?? []).some((price) => price.marketCode === market && isRenderableMarketingPrice(price))));
}

/** A locale preference is only used when that market has a complete catalog. */
export function getDefaultMarketingMarket(plans: readonly MarketingPlan[], locale: unknown = "en"): BillingMarketCode {
  const preferred: BillingMarketCode = normalizeSupportedLocale(locale).toLowerCase().startsWith("vi") ? "vn" : "global";
  const available = getMarketingAvailableMarkets(plans);
  return available.includes(preferred) ? preferred : available[0] ?? preferred;
}

/** Returns the single public offer for a market, failing closed on ambiguity. */
export function getMarketingPlanPriceForMarket(plan: MarketingPlan, market: BillingMarketCode): MarketingPrice | null {
  const matches = (plan.prices ?? []).filter((price) => price.marketCode === market && isRenderableMarketingPrice(price));
  return matches.length === 1 ? matches[0] ?? null : null;
}

/** Pricing is ready only when both public plans share at least one active market. */
export function isMarketingPricingReady(plans: readonly MarketingPlan[]): boolean {
  return plans.length === PUBLIC_PLAN_CODES.length
    && PUBLIC_PLAN_CODES.every((code) => plans.some((plan) => plan.code === code))
    && getMarketingAvailableMarkets(plans).length > 0;
}

/** Structured pricing is omitted entirely until checkout can resolve every offer. */
export function getMarketingStructuredOffers(plans: readonly MarketingPlan[]): MarketingStructuredOffer[] {
  if (!isMarketingPricingReady(plans)) return [];
  const available = new Set(getMarketingAvailableMarkets(plans));
  return plans.flatMap((plan) => (plan.prices ?? [])
    .filter((price) => available.has(price.marketCode) && isRenderableMarketingPrice(price))
    .map((price) => ({
      "@type": "Offer" as const,
      category: price.interval,
      name: `${plan.name} · ${price.marketCode}`,
      price: price.amountMinor / (price.currency.toUpperCase() === "VND" ? 1 : 100),
      priceCurrency: price.currency.toUpperCase(),
    })));
}

export async function getMarketingPlans(env: AppBindings): Promise<MarketingPlan[]> {
  // The public catalog is intentionally limited to the paid plans. Legacy
  // plan rows remain readable for existing subscriptions but are not offers.
  const result = await env.PLATFORM_DB.prepare(`
    SELECT code, name, feature_flags_json AS featureFlagsJson, limits_json AS limitsJson
    FROM plans
    WHERE ${SELLABLE_PUBLIC_PLAN_SQL_PREDICATE}
      AND code IN ('starter', 'pro')
    ORDER BY CASE code WHEN 'starter' THEN 1 WHEN 'pro' THEN 2 ELSE 3 END, code
  `).all<{ code: string; featureFlagsJson: string; limitsJson: string; name: string }>();
  const plans = result.results.map((row) => ({
    code: row.code,
    features: jsonObject(row.featureFlagsJson),
    limits: jsonObject(row.limitsJson),
    name: row.name,
    // Pro is the higher-capacity default recommendation; commercial amounts
    // remain entirely server-owned in plan_prices.
    recommended: row.code === "pro",
    prices: [] as MarketingPrice[],
  }));
  if (plans.length === 0) return plans;

  // `plan_prices` is introduced by the paid-plan migration. Keep the public
  // catalog fail-closed while that migration is unavailable locally: a plan
  // without a server price is never presented as a purchasable offer.
  try {
    const nowIso = new Date().toISOString();
    const prices = await env.PLATFORM_DB.prepare(`
      SELECT plan_prices.id, plans.code AS planCode,
        plan_prices.effective_from AS effectiveFrom, plan_prices.version,
        plan_prices.market_code AS marketCode,
        plan_prices.currency, plan_prices.amount_minor AS amountMinor,
        plan_prices.interval, plan_prices.provider_code AS providerCode,
        plan_prices.provider_price_ref AS providerPriceRef
      FROM plan_prices
      INNER JOIN plans ON plans.id = plan_prices.plan_id
      WHERE ${SELLABLE_PUBLIC_PLAN_SQL_PREDICATE}
        AND plans.code IN ('starter', 'pro')
        AND plan_prices.market_code IN ('vn', 'global')
        AND plan_prices.currency IN ('VND', 'USD')
        AND ${EFFECTIVE_PLAN_OFFER_SQL_PREDICATE}
      ORDER BY plans.code, plan_prices.market_code, plan_prices.currency,
        plan_prices.effective_from DESC, plan_prices.version DESC, plan_prices.id DESC
    `).bind(nowIso, nowIso).all<PlanOfferRevision>();
    const byCode = new Map(plans.map((plan) => [plan.code, [] as MarketingPrice[]]));
    for (const { planCode, ...offer } of projectLatestSellablePlanOffers(prices.results)) {
      byCode.get(planCode)?.push(offer);
    }
    return plans.map((plan) => ({ ...plan, prices: byCode.get(plan.code) ?? [] }));
  } catch {
    return plans;
  }
}

export function formatMarketingPrice(price: MarketingPrice, locale: unknown = "en"): string | null {
  if (!isRenderableMarketingPrice(price)) return null;
  try {
    return new Intl.NumberFormat(normalizeSupportedLocale(locale), {
      style: "currency",
      currency: price.currency,
      currencyDisplay: "symbol",
      maximumFractionDigits: price.currency === "VND" ? 0 : 2,
    }).format(price.amountMinor / (price.currency === "VND" ? 1 : 100));
  } catch {
    return null;
  }
}

function runtimeLimit(value: unknown, translator: ReturnType<typeof createMarketingTranslator>, locale: unknown, key: string): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return translator(key, { value: value.toLocaleString(normalizeSupportedLocale(locale)) });
}

export function planFeatureList(plan: MarketingPlan, locale: unknown = "en"): string[] {
  const t = createMarketingTranslator(locale);
  const features: string[] = [];
  if (plan.features.telegram === true) features.push(t("marketing.plan.feature.telegram"));
  if (plan.features.storefront === true) features.push(t("marketing.plan.feature.storefront"));
  if (plan.features.customDomain === true) features.push(t("marketing.plan.feature.custom_domain"));
  if (plan.features.customDomain === "addon") features.push(t("marketing.plan.feature.custom_domain_addon"));
  if (plan.features.automation === true) features.push(t("marketing.plan.feature.automation"));
  if (plan.features.privateDownloads === true) features.push(t("marketing.plan.feature.private_downloads"));
  if (plan.features.premiumStorefrontTemplates === true) features.push(t("marketing.plan.feature.premium_storefront_templates"));
  if (plan.features.apiRead === true) features.push(t("marketing.plan.feature.api_read"));

  const products = runtimeLimit(plan.limits.products, t, locale, "marketing.pricing.limit.products");
  if (products !== null) features.push(products);
  const orders = runtimeLimit(plan.limits.ordersPerMonth, t, locale, "marketing.pricing.limit.orders");
  if (orders !== null) features.push(orders);
  const staff = runtimeLimit(plan.limits.staffSeats, t, locale, "marketing.pricing.limit.staff");
  if (staff !== null) features.push(staff);
  const domains = runtimeLimit(plan.limits.customDomains, t, locale, "marketing.pricing.limit.domains");
  if (domains !== null && plan.features.customDomain !== false) features.push(domains);

  const customers = runtimeLimit(plan.limits.customers, t, locale, "marketing.pricing.limit.customers");
  if (customers !== null) features.push(customers);
  const automationRules = runtimeLimit(plan.limits.automationRules, t, locale, "marketing.pricing.limit.automation_rules");
  if (automationRules !== null) features.push(automationRules);
  const automationRuns = runtimeLimit(plan.limits.automationRunsPerBillingPeriod ?? plan.limits.automationRunsPerMonth, t, locale, "marketing.pricing.limit.automation_runs");
  if (automationRuns !== null) features.push(automationRuns);
  const apiRequests = runtimeLimit(plan.limits.apiRequestsPerBillingPeriod ?? plan.limits.apiReadRequestsPerMonth, t, locale, "marketing.pricing.limit.api_requests");
  if (apiRequests !== null) features.push(apiRequests);
  const exports = runtimeLimit(plan.limits.exportsPerMonth, t, locale, "marketing.pricing.limit.exports");
  if (exports !== null) features.push(exports);
  const downloads = runtimeLimit(plan.limits.privateDownloadsPerBillingPeriod ?? plan.limits.downloadsPerMonth, t, locale, "marketing.pricing.limit.downloads");
  if (downloads !== null) features.push(downloads);
  const storageBytes = plan.limits.storageBytes;
  if (typeof storageBytes === "number" && Number.isSafeInteger(storageBytes) && storageBytes >= 0) {
    features.push(t("marketing.pricing.limit.storage", { value: (storageBytes / (1024 ** 3)).toLocaleString(normalizeSupportedLocale(locale), { maximumFractionDigits: 2 }) }));
  }
  const auditRetention = runtimeLimit(plan.limits.auditRetentionDays, t, locale, "marketing.pricing.limit.audit_retention");
  if (auditRetention !== null) features.push(auditRetention);
  if (plan.features.analytics === "basic" || plan.features.analytics === "advanced") {
    features.push(plan.features.analytics === "basic"
      ? t("marketing.plan.feature.analytics_basic")
      : t("marketing.plan.feature.analytics_advanced"));
  }

  return features;
}
