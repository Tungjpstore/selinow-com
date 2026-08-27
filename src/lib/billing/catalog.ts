import type { BillingCurrency, BillingInterval, BillingMarketCode } from "./plan-catalog";

export type SellablePlanOffer = {
  amountMinor: number;
  currency: BillingCurrency;
  interval: BillingInterval;
  marketCode: BillingMarketCode;
};

export type SellablePlanOfferCandidate = SellablePlanOffer & {
  providerCode: string;
  providerPriceRef: string;
};

export type PlanOfferRevision = SellablePlanOfferCandidate & {
  effectiveFrom: string;
  id: string;
  planCode: string;
  version: number;
};

export function normalizePlanOfferRevision(value: unknown): PlanOfferRevision | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const planCode = row.planCode ?? row.plan_code;
  const effectiveFrom = row.effectiveFrom ?? row.effective_from;
  const providerCode = row.providerCode ?? row.provider_code;
  const providerPriceRef = row.providerPriceRef ?? row.provider_price_ref;
  const marketCode = row.marketCode ?? row.market_code;
  const amountMinor = row.amountMinor ?? row.amount_minor;
  const interval = row.interval;
  const currency = row.currency;
  const id = row.id;
  const version = row.version;
  if (typeof planCode !== "string" || typeof effectiveFrom !== "string" || typeof providerCode !== "string"
    || typeof providerPriceRef !== "string" || (marketCode !== "vn" && marketCode !== "global")
    || (currency !== "VND" && currency !== "USD") || interval !== "month"
    || !Number.isSafeInteger(amountMinor) || !Number.isSafeInteger(version)
    || typeof id !== "string") return null;
  return {
    amountMinor: amountMinor as number,
    currency,
    effectiveFrom,
    id,
    interval,
    marketCode,
    planCode,
    providerCode,
    providerPriceRef,
    version: version as number,
  };
}

export const SELLABLE_PUBLIC_PLAN_SQL_PREDICATE = `
  plans.is_active = 1
  AND plans.is_public = 1
  AND plans.is_assignable = 1
`;

export const EFFECTIVE_PLAN_OFFER_SQL_PREDICATE = `
  plan_prices.is_active = 1
  AND plan_prices.interval = 'month'
  AND plan_prices.effective_from <= ?
  AND (plan_prices.effective_to IS NULL OR plan_prices.effective_to > ?)
`;

export const SELLABLE_PLAN_OFFER_SQL_PREDICATE = `
  ${EFFECTIVE_PLAN_OFFER_SQL_PREDICATE}
  AND plan_prices.provider_code = 'dodo'
  AND plan_prices.provider_price_ref NOT LIKE 'pending:%'
`;

export function isPublishedProviderPriceReference(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 3
    && value.length <= 160
    && !value.toLowerCase().startsWith("pending:")
    && !/\s/u.test(value);
}

export function isSellablePlanOfferProjection(value: unknown): value is SellablePlanOffer {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const offer = value as Record<string, unknown>;
  const marketCode = offer.marketCode;
  const expectedCurrency = marketCode === "vn" ? "VND" : marketCode === "global" ? "USD" : null;
  return expectedCurrency !== null
    && offer.currency === expectedCurrency
    && offer.interval === "month"
    && Number.isSafeInteger(offer.amountMinor)
    && (offer.amountMinor as number) > 0;
}

export function isSellablePlanOffer(value: unknown): value is SellablePlanOfferCandidate {
  if (!isSellablePlanOfferProjection(value)) return false;
  const offer = value as SellablePlanOffer & Record<string, unknown>;
  return offer.providerCode === "dodo" && isPublishedProviderPriceReference(offer.providerPriceRef);
}

export function projectSellablePlanOffer(value: unknown): SellablePlanOffer | null {
  if (!isSellablePlanOffer(value)) return null;
  return {
    amountMinor: value.amountMinor,
    currency: value.currency,
    interval: value.interval,
    marketCode: value.marketCode,
  };
}

export function sellablePlanOfferKey(planCode: string, offer: SellablePlanOffer): string {
  return `${planCode}:${offer.marketCode}:${offer.currency}:${offer.interval}`;
}

function isNewerRevision(candidate: PlanOfferRevision, current: PlanOfferRevision): boolean {
  return candidate.effectiveFrom > current.effectiveFrom
    || (candidate.effectiveFrom === current.effectiveFrom && candidate.version > current.version)
    || (candidate.effectiveFrom === current.effectiveFrom && candidate.version === current.version && candidate.id > current.id);
}

/** Selects the latest effective revision before deciding whether it is sellable. */
export function projectLatestSellablePlanOffers(rows: readonly unknown[]): Array<SellablePlanOffer & { planCode: string }> {
  const latest = new Map<string, PlanOfferRevision>();
  for (const value of rows) {
    const row = normalizePlanOfferRevision(value);
    if (row === null) continue;
    const key = `${row.planCode}:${row.marketCode}:${row.currency}:${row.interval}`;
    const current = latest.get(key);
    if (current === undefined || isNewerRevision(row, current)) latest.set(key, row);
  }
  return [...latest.values()].flatMap((row) => {
    const offer = projectSellablePlanOffer(row);
    return offer === null ? [] : [{ planCode: row.planCode, ...offer }];
  });
}
