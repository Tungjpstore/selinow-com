import type { AppBindings } from "../platform/bindings";
import { createMarketingTranslator } from "../i18n/catalogs/marketing";
import { normalizeSupportedLocale } from "../i18n/locale";

export type MarketingPlan = {
  code: string;
  features: Record<string, unknown>;
  limits: Record<string, unknown>;
  name: string;
};

function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function getMarketingPlans(env: AppBindings): Promise<MarketingPlan[]> {
  const result = await env.PLATFORM_DB.prepare("SELECT code, name, feature_flags_json AS featureFlagsJson, limits_json AS limitsJson FROM plans WHERE is_active = 1 ORDER BY CASE code WHEN 'bot' THEN 1 WHEN 'store' THEN 2 WHEN 'business' THEN 3 ELSE 4 END, code").all<{ code: string; featureFlagsJson: string; limitsJson: string; name: string }>();
  return result.results.map((row) => ({ code: row.code, features: jsonObject(row.featureFlagsJson), limits: jsonObject(row.limitsJson), name: row.name }));
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

  const products = runtimeLimit(plan.limits.products, t, locale, "marketing.pricing.limit.products");
  if (products !== null) features.push(products);
  const orders = runtimeLimit(plan.limits.ordersPerMonth, t, locale, "marketing.pricing.limit.orders");
  if (orders !== null) features.push(orders);
  const staff = runtimeLimit(plan.limits.staffSeats, t, locale, "marketing.pricing.limit.staff");
  if (staff !== null) features.push(staff);
  const domains = runtimeLimit(plan.limits.customDomains, t, locale, "marketing.pricing.limit.domains");
  if (domains !== null && plan.features.customDomain !== false) features.push(domains);

  return features;
}
