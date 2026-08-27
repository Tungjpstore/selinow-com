import { AppError } from "../core/errors";
import { parsePlanFeatures } from "../billing/plan-catalog";
import { getShopForMember } from "../tenants/store";
import type { AppBindings } from "../platform/bindings";

/**
 * EX3.1 — seller metrics range: the real revenue series behind the cockpit
 * sparkline (replacing the fabricated one). Resolves shop membership itself
 * like every seller read model; paid orders are grouped by the shop's own
 * timezone into dense day points; foreign-currency paid orders are counted,
 * never summed across currencies (order-currency invariant, migration 0044).
 */

export type SellerMetricPoint = { date: string; totalMinor: number };

export type SellerMetricsRange = {
  currency: string;
  /** Paid orders in the window whose currency differs from the shop's. */
  foreignCurrencyOrders: number;
  /** Dense, ascending calendar-day series in the shop timezone. */
  points: SellerMetricPoint[];
  totalMinor: number;
};

const METRICS_PAGE_SIZE = 500;
const METRICS_MAX_PAGES = 100;
const METRICS_QUERY_LIMIT = String(METRICS_PAGE_SIZE + 1);

type MetricsOrderRow = { currency: string; id: string; paidAt: string; totalMinor: number };

export type SellerMetricsDays = 7 | 30 | 90;

export function parseMetricsDays(value: string | null): SellerMetricsDays {
  if (value === null || value === "7") return 7;
  if (value === "30") return 30;
  if (value === "90") return 90;
  throw new AppError("validation_failed", 400, ["metrics_days_invalid"]);
}

type CalendarDay = { day: number; month: number; year: number };

function localCalendarDay(date: Date, timeZone: string): CalendarDay {
  const parts = new Intl.DateTimeFormat("en", {
    day: "2-digit",
    hourCycle: "h23",
    month: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? "NaN");
  const day = value("day");
  const month = value("month");
  const year = value("year");
  if (![day, month, year].every(Number.isSafeInteger)) throw new AppError("metrics_timezone_invalid", 500);
  return { day, month, year };
}

function localMidnightUtcForDay(timeZone: string, target: CalendarDay): Date {
  // Find the first instant whose local calendar date is the target. A fixed
  // offset iteration fails when a timezone jumps across midnight and has no
  // representable 00:00:00; binary search still returns the first valid
  // instant of that local day.
  const targetKey = calendarDayKey(target);
  const localNaiveUtc = Date.UTC(target.year, target.month - 1, target.day);
  const dayMs = 86_400_000;
  let low = localNaiveUtc - 3 * dayMs;
  let high = localNaiveUtc + 3 * dayMs;
  const keyAt = (timestamp: number): string => calendarDayKey(localCalendarDay(new Date(timestamp), timeZone));
  if (keyAt(high) < targetKey) throw new AppError("metrics_timezone_invalid", 500);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (keyAt(middle) < targetKey) low = middle;
    else high = middle;
  }
  if (keyAt(high) !== targetKey) throw new AppError("metrics_timezone_invalid", 500);
  return new Date(high);
}

function calendarDayKey(day: CalendarDay): string {
  return `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`;
}

function metricsDayKeys(windowDays: SellerMetricsDays, reference: Date, timeZone: string): string[] {
  const current = localCalendarDay(reference, timeZone);
  return Array.from({ length: windowDays }, (_, index) => {
    const offset = windowDays - index - 1;
    const date = new Date(Date.UTC(current.year, current.month - 1, current.day - offset));
    return date.toISOString().slice(0, 10);
  });
}

export async function getSellerMetricsRange(input: {
  days?: SellerMetricsDays;
  env: AppBindings;
  now?: Date;
  shopPublicId: string;
  userId: string;
}): Promise<SellerMetricsRange> {
  const reference = input.now ?? new Date();
  const member = await getShopForMember({
    capability: "shop:read",
    env: input.env,
    now: reference,
    shopPublicId: input.shopPublicId,
    subscriptionAction: "mutation",
    userId: input.userId,
  });
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
  const current = localCalendarDay(reference, timeZone);
  const firstLocalDay = new Date(Date.UTC(current.year, current.month - 1, current.day - (windowDays - 1)));
  const windowStart = localMidnightUtcForDay(timeZone, {
    day: firstLocalDay.getUTCDate(),
    month: firstLocalDay.getUTCMonth() + 1,
    year: firstLocalDay.getUTCFullYear(),
  });
  const byDay = new Map(metricsDayKeys(windowDays, reference, timeZone).map((key) => [key, 0]));
  let foreignCurrencyOrders = 0;
  let totalMinor = 0;
  let beforeId: string | null = null;
  let beforePaidAt: string | null = null;
  for (let page = 0; page < METRICS_MAX_PAGES; page += 1) {
    let result: { results: MetricsOrderRow[] };
    if (beforePaidAt === null) {
      result = await input.env.PLATFORM_DB.prepare(`
        SELECT orders.id, orders.paid_at AS paidAt, orders.total_minor AS totalMinor, orders.currency
        FROM orders
        WHERE orders.shop_id = ?
          AND orders.payment_status = 'paid'
          AND orders.paid_at IS NOT NULL
          AND julianday(orders.paid_at) >= julianday(?)
          AND julianday(orders.paid_at) <= julianday(?)
        ORDER BY julianday(orders.paid_at) DESC, orders.id DESC
        LIMIT ${METRICS_QUERY_LIMIT}
      `).bind(shopId, windowStart.toISOString(), reference.toISOString()).all<MetricsOrderRow>();
    } else {
      result = await input.env.PLATFORM_DB.prepare(`
        SELECT orders.id, orders.paid_at AS paidAt, orders.total_minor AS totalMinor, orders.currency
        FROM orders
        WHERE orders.shop_id = ?
          AND orders.payment_status = 'paid'
          AND orders.paid_at IS NOT NULL
          AND julianday(orders.paid_at) >= julianday(?)
          AND julianday(orders.paid_at) <= julianday(?)
          AND (julianday(orders.paid_at) < julianday(?)
            OR (julianday(orders.paid_at) = julianday(?) AND orders.id < ?))
        ORDER BY julianday(orders.paid_at) DESC, orders.id DESC
        LIMIT ${METRICS_QUERY_LIMIT}
      `).bind(
        shopId,
        windowStart.toISOString(),
        reference.toISOString(),
        beforePaidAt,
        beforePaidAt,
        beforeId,
      ).all<MetricsOrderRow>();
    }
    const pageRows: MetricsOrderRow[] = result.results.slice(0, METRICS_PAGE_SIZE);
    for (const row of pageRows) {
      if (row.currency !== shopCurrency) {
        foreignCurrencyOrders += 1;
        continue;
      }
      const key = calendarDayKey(localCalendarDay(new Date(row.paidAt), timeZone));
      if (byDay.has(key)) {
        byDay.set(key, (byDay.get(key) ?? 0) + row.totalMinor);
        totalMinor += row.totalMinor;
      }
    }
    if (result.results.length <= METRICS_PAGE_SIZE) break;
    const cursor: MetricsOrderRow | undefined = pageRows.at(-1);
    if (cursor === undefined) break;
    beforePaidAt = cursor.paidAt;
    beforeId = cursor.id;
    if (page === METRICS_MAX_PAGES - 1) throw new AppError("metrics_range_too_large", 503);
  }

  const points = [...byDay.entries()].map(([date, minor]) => ({ date, totalMinor: minor }));
  return { currency: shopCurrency, foreignCurrencyOrders, points, totalMinor };
}
