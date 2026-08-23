import { AppError } from "../core/errors";
import { parsePlanFeatures } from "../billing/plan-catalog";
import { getShopForMember } from "../tenants/store";
import type { AppBindings } from "../platform/bindings";

/**
 * EX3.1 — seller metrics range: the real revenue series behind the cockpit
 * sparkline (replacing the fabricated one). Resolves shop membership itself
 * like every seller read model; paid orders are grouped by the shop's own
 * timezone into sparse day points; foreign-currency paid orders are counted,
 * never summed across currencies (order-currency invariant, migration 0044).
 */

export type SellerMetricPoint = { date: string; totalMinor: number };

export type SellerMetricsRange = {
  currency: string;
  /** Paid orders in the window whose currency differs from the shop's. */
  foreignCurrencyOrders: number;
  /** Sparse, ascending by date; days without paid orders are omitted. */
  points: SellerMetricPoint[];
  totalMinor: number;
};


export type SellerMetricsDays = 7 | 30 | 90;

export function parseMetricsDays(value: string | null): SellerMetricsDays {
  if (value === null || value === "7") return 7;
  if (value === "30") return 30;
  if (value === "90") return 90;
  throw new AppError("validation_failed", 400, ["metrics_days_invalid"]);
}

function timezoneDayKey(iso: string, timeZone: string): string {
  // en-CA yields YYYY-MM-DD; Intl caches formatters internally.
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(iso));
}

function localMidnightUtc(timeZone: string, reference: Date): Date {
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone }).format(reference);
  let candidate = new Date(reference.getTime());
  for (let guard = 0; guard < 48; guard += 1) {
    const previousHour = new Date(candidate.getTime() - 3_600_000);
    if (new Intl.DateTimeFormat("en-CA", { timeZone }).format(previousHour) !== dayKey) return candidate;
    candidate = previousHour;
  }
  return candidate;
}

export async function getSellerMetricsRange(input: {
  days?: SellerMetricsDays;
  env: AppBindings;
  shopPublicId: string;
  userId: string;
}): Promise<SellerMetricsRange> {
  const member = await getShopForMember({ capability: "shop:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const shopId = member.row.shop_id;
  const shopCurrency = member.row.currency;
  const timeZone = member.row.timezone;

  const windowDays = input.days === 90 ? 90 : input.days === 30 ? 30 : 7;
  if (windowDays === 90) {
    const features = parsePlanFeatures(member.row.feature_flags_json);
    if (!features.ok || features.value.analytics !== "advanced") {
      throw new AppError("plan_feature_unavailable", 402, ["analytics"]);
    }
  }
  const windowStart = new Date(localMidnightUtc(timeZone, new Date()).getTime() - (windowDays - 1) * 86_400_000);

  const result = await input.env.PLATFORM_DB.prepare(`
    SELECT orders.paid_at AS paidAt, orders.total_minor AS totalMinor, orders.currency
    FROM orders
    WHERE orders.shop_id = ?
      AND orders.payment_status = 'paid'
      AND orders.paid_at IS NOT NULL
      AND orders.paid_at >= ?
    ORDER BY orders.paid_at DESC
    LIMIT 10000
  `).bind(shopId, windowStart.toISOString()).all<{ currency: string; paidAt: string; totalMinor: number }>();

  const byDay = new Map<string, number>();
  let foreignCurrencyOrders = 0;
  let totalMinor = 0;
  for (const row of result.results) {
    if (row.currency !== shopCurrency) {
      foreignCurrencyOrders += 1;
      continue;
    }
    const key = timezoneDayKey(row.paidAt, timeZone);
    byDay.set(key, (byDay.get(key) ?? 0) + row.totalMinor);
    totalMinor += row.totalMinor;
  }

  const points = [...byDay.entries()].map(([date, minor]) => ({ date, totalMinor: minor })).sort((left, right) => left.date.localeCompare(right.date));
  return { currency: shopCurrency, foreignCurrencyOrders, points, totalMinor };
}
