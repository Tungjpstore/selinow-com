/**
 * Typed runtime plan snapshots. Commercial prices are normally loaded from
 * D1; the baseline offers below are only the reviewed catalog contract used by
 * validators, seed checks and deterministic tests.
 */

export const PUBLIC_PLAN_CODES = ["starter", "pro"] as const;
export type PublicPlanCode = (typeof PUBLIC_PLAN_CODES)[number];
export const PUBLIC_TRIAL_DAYS = 7 as const;
export const GRACE_PERIOD_DAYS = 3 as const;

export const LEGACY_PLAN_CODES = ["bot", "store", "business"] as const;
export type LegacyPlanCode = (typeof LEGACY_PLAN_CODES)[number];
export type PlanCode = PublicPlanCode | LegacyPlanCode;

export const BILLING_MARKETS = ["vn", "global"] as const;
export type BillingMarketCode = (typeof BILLING_MARKETS)[number];
export type BillingCurrency = "VND" | "USD";
export type BillingInterval = "month";
export type TaxBehavior = "inclusive" | "exclusive" | "unspecified";
export type BillingProviderCode = "payos" | "dodo";

export const PLAN_FEATURES = [
  "storefront",
  "telegram",
  "catalog",
  "inventory",
  "sellerPayments",
  "manualFulfillment",
  "privateDownloads",
  "automation",
  "dataExport",
  "customDomain",
  "api",
  "audit",
  "analytics",
] as const;
export type PlanFeatureName = (typeof PLAN_FEATURES)[number];
export type AnalyticsTier = "none" | "basic" | "advanced";

export const PLAN_FEATURE_ALIASES: Readonly<Record<string, PlanFeatureName>> = {
  apiRead: "api",
  fulfillment: "manualFulfillment",
  payments: "sellerPayments",
  privateDownload: "privateDownloads",
};

export type PlanFeatures = {
  analytics: AnalyticsTier;
  api: boolean;
  audit: boolean;
  automation: boolean;
  catalog: boolean;
  customDomain: boolean;
  dataExport: boolean;
  inventory: boolean;
  manualFulfillment: boolean;
  privateDownloads: boolean;
  sellerPayments: boolean;
  storefront: boolean;
  telegram: boolean;
};

export const PLAN_LIMITS = [
  "products_non_archived",
  "orders_created",
  "customers_total",
  "active_member_seats",
  "active_custom_domains",
  "automation_rules",
  "automation_runs",
  "api_requests",
  "exports_created",
  "downloads_served",
  "storage_bytes",
  "audit_retention_days",
] as const;
export type PlanLimitName = (typeof PLAN_LIMITS)[number];

export type PlanLimits = {
  [key in PlanLimitName]: number;
};

export type PlanSnapshot = {
  code: PlanCode;
  features: PlanFeatures;
  id?: string;
  isActive?: boolean;
  isAssignable?: boolean;
  isPublic?: boolean;
  limits: PlanLimits;
  name?: string;
  version?: number;
};

export type PlanOffer = {
  amountMinor: number;
  currency: BillingCurrency;
  effectiveFrom: string;
  effectiveTo: string | null;
  interval: BillingInterval;
  isActive: boolean;
  marketCode: BillingMarketCode;
  planCode: PlanCode;
  providerCode: BillingProviderCode;
  providerPriceRef: string;
  taxBehavior: TaxBehavior;
  version: number;
};

export type ParseIssue = {
  field: string;
  reason: string;
};

export type ParseResult<T> =
  | { ok: true; value: T }
  | { issues: readonly ParseIssue[]; ok: false };

const FEATURE_DEFAULTS: PlanFeatures = {
  analytics: "none",
  api: false,
  audit: false,
  automation: false,
  catalog: false,
  customDomain: false,
  dataExport: false,
  inventory: false,
  manualFulfillment: false,
  privateDownloads: false,
  sellerPayments: false,
  storefront: false,
  telegram: false,
};

const LIMIT_DEFAULTS: PlanLimits = {
  active_custom_domains: 0,
  active_member_seats: 0,
  api_requests: 0,
  audit_retention_days: 0,
  automation_rules: 0,
  automation_runs: 0,
  customers_total: 0,
  downloads_served: 0,
  exports_created: 0,
  orders_created: 0,
  products_non_archived: 0,
  storage_bytes: 0,
};

export const PLAN_LIMIT_ALIASES: Readonly<Record<string, PlanLimitName>> = {
  activeCustomDomains: "active_custom_domains",
  activeMemberSeats: "active_member_seats",
  apiRequests: "api_requests",
  auditRetentionDays: "audit_retention_days",
  automationRules: "automation_rules",
  automationRuns: "automation_runs",
  customers: "customers_total",
  customersTotal: "customers_total",
  customDomains: "active_custom_domains",
  downloads: "downloads_served",
  downloadsServed: "downloads_served",
  exports: "exports_created",
  exportsCreated: "exports_created",
  exportsPerMonth: "exports_created",
  ordersPerMonth: "orders_created",
  ordersPerPeriod: "orders_created",
  ordersPerBillingPeriod: "orders_created",
  orders_per_period: "orders_created",
  orders: "orders_created",
  orders_created_per_period: "orders_created",
  products: "products_non_archived",
  productsNonArchived: "products_non_archived",
  staffSeats: "active_member_seats",
  memberSeats: "active_member_seats",
  privateDownloadsPerBillingPeriod: "downloads_served",
  storageBytes: "storage_bytes",
  downloadsPerMonth: "downloads_served",
  automationRunsPerBillingPeriod: "automation_runs",
  automationRunsPerMonth: "automation_runs",
  apiReadRequestsPerMonth: "api_requests",
  apiRequestsPerBillingPeriod: "api_requests",
};

const BOOLEAN_FEATURES = new Set<Exclude<PlanFeatureName, "analytics">>([
  "api",
  "audit",
  "automation",
  "catalog",
  "customDomain",
  "dataExport",
  "inventory",
  "manualFulfillment",
  "privateDownloads",
  "sellerPayments",
  "storefront",
  "telegram",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(value: unknown, field: string): ParseResult<Record<string, unknown>> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!isRecord(parsed)) return { issues: [{ field, reason: "object_required" }], ok: false };
      return { ok: true, value: parsed };
    } catch {
      return { issues: [{ field, reason: "json_invalid" }], ok: false };
    }
  }
  if (!isRecord(value)) return { issues: [{ field, reason: "object_required" }], ok: false };
  return { ok: true, value };
}

function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function mergeIssues(...results: readonly ParseResult<unknown>[]): readonly ParseIssue[] {
  return results.flatMap((result) => (result.ok ? [] : result.issues));
}

export function parsePlanFeatures(input: unknown): ParseResult<PlanFeatures> {
  const objectResult = parseObject(input, "features");
  if (!objectResult.ok) return objectResult;

  const features: PlanFeatures = { ...FEATURE_DEFAULTS };
  const issues: ParseIssue[] = [];
  for (const [key, value] of Object.entries(objectResult.value)) {
    const canonicalKey = PLAN_FEATURE_ALIASES[key] ?? key;
    if (canonicalKey === "analytics") {
      if (value === "none" || value === "basic" || value === "advanced") features.analytics = value;
      else issues.push({ field: `features.${key}`, reason: "analytics_tier_invalid" });
      continue;
    }
    if (!BOOLEAN_FEATURES.has(canonicalKey as Exclude<PlanFeatureName, "analytics">)) continue;
    if (typeof value !== "boolean") issues.push({ field: `features.${key}`, reason: "boolean_required" });
    else features[canonicalKey as Exclude<PlanFeatureName, "analytics">] = value;
  }
  return issues.length > 0 ? { issues, ok: false } : { ok: true, value: features };
}

export function parsePlanLimits(input: unknown): ParseResult<PlanLimits> {
  const objectResult = parseObject(input, "limits");
  if (!objectResult.ok) return objectResult;

  const limits: PlanLimits = { ...LIMIT_DEFAULTS };
  const issues: ParseIssue[] = [];
  for (const [key, value] of Object.entries(objectResult.value)) {
    const metric = PLAN_LIMITS.includes(key as PlanLimitName)
      ? key as PlanLimitName
      : PLAN_LIMIT_ALIASES[key];
    if (metric === undefined) continue;
    if (!safeInteger(value)) issues.push({ field: `limits.${key}`, reason: "non_negative_integer_required" });
    else limits[metric] = value;
  }
  return issues.length > 0 ? { issues, ok: false } : { ok: true, value: limits };
}

export type PlanSnapshotInput = {
  code?: unknown;
  featureFlagsJson?: unknown;
  feature_flags_json?: unknown;
  features?: unknown;
  id?: unknown;
  isActive?: unknown;
  is_active?: unknown;
  isAssignable?: unknown;
  is_assignable?: unknown;
  isPublic?: unknown;
  is_public?: unknown;
  limits?: unknown;
  limitsJson?: unknown;
  limits_json?: unknown;
  name?: unknown;
  planCode?: unknown;
  plan_code?: unknown;
  version?: unknown;
  planVersion?: unknown;
};

function parsePlanCode(value: unknown): ParseResult<PlanCode> {
  if (typeof value !== "string") return { issues: [{ field: "code", reason: "string_required" }], ok: false };
  if ((PUBLIC_PLAN_CODES as readonly string[]).includes(value) || (LEGACY_PLAN_CODES as readonly string[]).includes(value)) {
    return { ok: true, value: value as PlanCode };
  }
  return { issues: [{ field: "code", reason: "unsupported_plan" }], ok: false };
}

function optionalString(value: unknown, field: string): ParseResult<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === "string" && value.length > 0
    ? { ok: true, value }
    : { issues: [{ field, reason: "non_empty_string_required" }], ok: false };
}

function optionalBoolean(value: unknown, field: string): ParseResult<boolean | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === 0 || value === 1) return { ok: true, value: value === 1 };
  return typeof value === "boolean"
    ? { ok: true, value }
    : { issues: [{ field, reason: "boolean_required" }], ok: false };
}

function optionalPositiveInteger(value: unknown, field: string): ParseResult<number | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? { ok: true, value }
    : { issues: [{ field, reason: "positive_integer_required" }], ok: false };
}

export function parsePlanSnapshot(input: PlanSnapshotInput): ParseResult<PlanSnapshot> {
  const code = parsePlanCode(input.code ?? input.planCode ?? input.plan_code);
  const features = parsePlanFeatures(input.features ?? input.featureFlagsJson ?? input.feature_flags_json);
  const limits = parsePlanLimits(input.limits ?? input.limitsJson ?? input.limits_json);
  const id = optionalString(input.id, "id");
  const name = optionalString(input.name, "name");
  const isActive = optionalBoolean(input.isActive ?? input.is_active, "isActive");
  const isAssignable = optionalBoolean(input.isAssignable ?? input.is_assignable, "isAssignable");
  const isPublic = optionalBoolean(input.isPublic ?? input.is_public, "isPublic");
  const version = optionalPositiveInteger(input.version ?? input.planVersion, "version");
  const issues = mergeIssues(code, features, limits, id, name, isActive, isAssignable, isPublic, version);
  if (issues.length > 0 || !code.ok || !features.ok || !limits.ok || !id.ok || !name.ok || !isActive.ok || !isAssignable.ok || !isPublic.ok || !version.ok) {
    return { issues, ok: false };
  }

  const snapshot: PlanSnapshot = { code: code.value, features: features.value, limits: limits.value };
  if (id.value !== undefined) snapshot.id = id.value;
  if (name.value !== undefined) snapshot.name = name.value;
  if (isActive.value !== undefined) snapshot.isActive = isActive.value;
  if (isAssignable.value !== undefined) snapshot.isAssignable = isAssignable.value;
  if (isPublic.value !== undefined) snapshot.isPublic = isPublic.value;
  if (version.value !== undefined) snapshot.version = version.value;
  return { ok: true, value: snapshot };
}

export const STARTER_PLAN: PlanSnapshot = {
  code: "starter",
  features: {
    analytics: "basic",
    api: false,
    audit: true,
    automation: true,
    catalog: true,
    customDomain: false,
    dataExport: true,
    inventory: true,
    manualFulfillment: true,
    privateDownloads: true,
    sellerPayments: true,
    storefront: true,
    telegram: true,
  },
  isActive: true,
  isAssignable: true,
  isPublic: true,
  limits: {
    active_custom_domains: 0,
    active_member_seats: 1,
    api_requests: 0,
    audit_retention_days: 90,
    automation_rules: 3,
    automation_runs: 1000,
    customers_total: 1000,
    downloads_served: 500,
    exports_created: 2,
    orders_created: 500,
    products_non_archived: 50,
    storage_bytes: 1_073_741_824,
  },
  name: "Starter",
  version: 1,
};

export const PRO_PLAN: PlanSnapshot = {
  code: "pro",
  features: {
    analytics: "advanced",
    api: true,
    audit: true,
    automation: true,
    catalog: true,
    customDomain: true,
    dataExport: true,
    inventory: true,
    manualFulfillment: true,
    privateDownloads: true,
    sellerPayments: true,
    storefront: true,
    telegram: true,
  },
  isActive: true,
  isAssignable: true,
  isPublic: true,
  limits: {
    active_custom_domains: 1,
    active_member_seats: 5,
    api_requests: 50_000,
    audit_retention_days: 365,
    automation_rules: 20,
    automation_runs: 10_000,
    customers_total: 10_000,
    downloads_served: 10_000,
    exports_created: 10,
    orders_created: 5_000,
    products_non_archived: 500,
    storage_bytes: 10_737_418_240,
  },
  name: "Pro",
  version: 1,
};

export const PUBLIC_PLAN_CATALOG: Readonly<Record<PublicPlanCode, PlanSnapshot>> = {
  pro: PRO_PLAN,
  starter: STARTER_PLAN,
};

export type PlanOfferInput = {
  amountMinor?: unknown;
  amount_minor?: unknown;
  currency?: unknown;
  effectiveFrom?: unknown;
  effective_from?: unknown;
  effectiveTo?: unknown;
  effective_to?: unknown;
  interval?: unknown;
  isActive?: unknown;
  is_active?: unknown;
  marketCode?: unknown;
  market_code?: unknown;
  planCode?: unknown;
  plan_code?: unknown;
  providerCode?: unknown;
  provider_code?: unknown;
  providerPriceRef?: unknown;
  provider_price_ref?: unknown;
  taxBehavior?: unknown;
  tax_behavior?: unknown;
  version?: unknown;
};

function parseIsoDate(value: unknown, field: string): ParseResult<string>;
function parseIsoDate(value: unknown, field: string, nullable: true): ParseResult<string | null>;
function parseIsoDate(value: unknown, field: string, nullable = false): ParseResult<string | null> {
  if ((value === null || value === undefined) && nullable) return { ok: true, value: null };
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return { issues: [{ field, reason: "iso_date_required" }], ok: false };
  return { ok: true, value: new Date(value).toISOString() };
}

function parseRequiredNonEmptyString(value: unknown, field: string): ParseResult<string> {
  return typeof value === "string" && value.trim().length > 0
    ? { ok: true, value: value.trim() }
    : { issues: [{ field, reason: "non_empty_string_required" }], ok: false };
}

export function parsePlanOffer(input: PlanOfferInput): ParseResult<PlanOffer> {
  const planCode = parsePlanCode(input.planCode ?? input.plan_code);
  const marketInput = input.marketCode ?? input.market_code;
  const marketCode: ParseResult<BillingMarketCode> = marketInput === "vn" || marketInput === "global"
    ? { ok: true, value: marketInput }
    : { issues: [{ field: "marketCode", reason: "market_invalid" }], ok: false };
  const expectedCurrency: BillingCurrency | undefined = marketCode.ok ? marketCode.value === "vn" ? "VND" : "USD" : undefined;
  const currencyInput = input.currency;
  const currency: ParseResult<BillingCurrency> = currencyInput === "VND" || currencyInput === "USD"
    ? { ok: true, value: currencyInput }
    : { issues: [{ field: "currency", reason: "currency_invalid" }], ok: false };
  const amountInput = input.amountMinor ?? input.amount_minor;
  const amountMinor = safeInteger(amountInput) && amountInput > 0
    ? { ok: true as const, value: amountInput }
    : { issues: [{ field: "amountMinor", reason: "positive_integer_required" }], ok: false as const };
  const interval: ParseResult<BillingInterval> = input.interval === "month"
    ? { ok: true, value: "month" }
    : { issues: [{ field: "interval", reason: "interval_invalid" }], ok: false };
  const taxInput = input.taxBehavior ?? input.tax_behavior;
  const taxBehavior: ParseResult<TaxBehavior> = taxInput === "inclusive" || taxInput === "exclusive" || taxInput === "unspecified"
    ? { ok: true, value: taxInput }
    : { issues: [{ field: "taxBehavior", reason: "tax_behavior_invalid" }], ok: false };
  const providerInput = input.providerCode ?? input.provider_code;
  const providerCode: ParseResult<BillingProviderCode> = providerInput === "payos" || providerInput === "dodo"
    ? { ok: true, value: providerInput }
    : { issues: [{ field: "providerCode", reason: "provider_invalid" }], ok: false };
  const providerPriceRef = parseRequiredNonEmptyString(input.providerPriceRef ?? input.provider_price_ref, "providerPriceRef");
  const effectiveFrom = parseIsoDate(input.effectiveFrom ?? input.effective_from, "effectiveFrom");
  const effectiveTo = parseIsoDate(input.effectiveTo ?? input.effective_to, "effectiveTo", true);
  const activeInput = input.isActive ?? input.is_active;
  const isActive = typeof activeInput === "boolean" || activeInput === 0 || activeInput === 1
    ? { ok: true as const, value: activeInput === true || activeInput === 1 }
    : { issues: [{ field: "isActive", reason: "boolean_required" }], ok: false as const };
  const version = typeof input.version === "number" && Number.isSafeInteger(input.version) && input.version > 0
    ? { ok: true as const, value: input.version }
    : { issues: [{ field: "version", reason: "positive_integer_required" }], ok: false as const };
  const issues: ParseIssue[] = [...mergeIssues(planCode, marketCode, currency, amountMinor, interval, taxBehavior, providerCode, providerPriceRef, effectiveFrom, effectiveTo, isActive, version)];
  if (expectedCurrency !== undefined && currency.ok && currency.value !== expectedCurrency) issues.push({ field: "currency", reason: "market_currency_mismatch" });
  // Platform subscription billing is Dodo in every market. PayOS remains a
  // seller-order payment provider, not a subscription price provider.
  if (providerCode.ok && providerCode.value !== "dodo") issues.push({ field: "providerCode", reason: "platform_provider_mismatch" });
  if (effectiveFrom.ok && effectiveTo.ok && effectiveTo.value !== null && Date.parse(effectiveTo.value) <= Date.parse(effectiveFrom.value)) issues.push({ field: "effectiveTo", reason: "effective_range_invalid" });
  if (issues.length > 0 || !planCode.ok || !marketCode.ok || !currency.ok || !amountMinor.ok || !interval.ok || !taxBehavior.ok || !providerCode.ok || !providerPriceRef.ok || !effectiveFrom.ok || !effectiveTo.ok || !isActive.ok || !version.ok) return { issues, ok: false };
  return {
    ok: true,
    value: {
      amountMinor: amountMinor.value,
      currency: currency.value,
      effectiveFrom: effectiveFrom.value,
      effectiveTo: effectiveTo.value,
      interval: interval.value,
      isActive: isActive.value,
      marketCode: marketCode.value,
      planCode: planCode.value,
      providerCode: providerCode.value,
      providerPriceRef: providerPriceRef.value,
      taxBehavior: taxBehavior.value,
      version: version.value,
    },
  };
}

const BASELINE_OFFER_VALUES: Readonly<Record<PublicPlanCode, Readonly<Record<BillingMarketCode, number>>>> = {
  pro: { global: 1500, vn: 299_000 },
  starter: { global: 500, vn: 99_000 },
};

/** Returns the approved commercial amount; provider references remain D1-owned. */
export function getBaselinePlanOffer(planCode: PublicPlanCode, marketCode: BillingMarketCode): Pick<PlanOffer, "amountMinor" | "currency" | "interval" | "marketCode" | "planCode"> {
  return {
    amountMinor: BASELINE_OFFER_VALUES[planCode][marketCode],
    currency: marketCode === "vn" ? "VND" : "USD",
    interval: "month",
    marketCode,
    planCode,
  };
}

/** Alias used by billing callers that resolve a validated price row. */
export const planOffer = parsePlanOffer;
