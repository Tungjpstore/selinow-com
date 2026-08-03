import { AppError } from "../core/errors";
import { createId } from "../core/ids";

/**
 * Usage is deliberately kept independent from a particular billing provider.
 * The event source is the durable application reference (order id, export id,
 * etc.); retries of that reference must never create another counter delta.
 */

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u;
const SAFE_METRIC = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const SAFE_PERIOD_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{1,159}$/u;
const SAFE_SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u;
const SAFE_SOURCE_KIND = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const MAX_DELTA = 9_000_000_000_000_000;

export type BillingPeriodKind = "paid" | "trial";
export type UsageEventSourceKind = string;

function isBillingPeriodKind(value: string): value is BillingPeriodKind {
  return value === "trial" || value === "paid";
}

export type UsageRecordResult = {
  eventId: string;
  metric: string;
  periodKey: string;
  shopId: string;
  status: "applied" | "replayed";
  value: number;
};

export type QuotaResult = {
  allowed: boolean;
  current: number;
  limit: number;
  metric: string;
  periodKey: string;
  remaining: number;
  requested: number;
  shopId: string;
};

type UsageEventRow = {
  delta: number;
  id: string;
  occurredAt: string;
  periodKind: string;
  periodKey: string;
  sourceId: string;
  sourceKind: string;
};

type CounterRow = { updatedAt: string; value: number };
type SubscriptionPeriodRow = {
  createdAt?: string;
  currentPeriodEnd?: string | null;
  currentPeriodStart?: string | null;
  state: string;
  trialEndsAt?: string | null;
};

export type PreparedUsageMutation = {
  eventId: string;
  statements: readonly D1PreparedStatement[];
};

function requireDatabase(database: D1Database | undefined): D1Database {
  if (database === undefined) throw new AppError("usage_unavailable", 503);
  return database;
}

function invalid(field: string): never {
  throw new AppError("usage_event_invalid", 400, [field]);
}

function requireIdentifier(value: string, field: string): string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) invalid(field);
  return value;
}

function requireMetric(value: string): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 96 || !SAFE_METRIC.test(value)) invalid("metric_invalid");
  return value;
}

function requireSourceId(value: string): string {
  if (typeof value !== "string" || !SAFE_SOURCE_ID.test(value)) invalid("source_id_invalid");
  return value;
}

function requireSourceKind(value: string): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 64 || !SAFE_SOURCE_KIND.test(value)) invalid("source_kind_invalid");
  return value;
}

function requireDelta(value: number, field = "delta_invalid"): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DELTA) invalid(field);
  return value;
}

function requirePeriodKey(value: string): string {
  if (typeof value !== "string" || !SAFE_PERIOD_KEY.test(value)) {
    throw new AppError("billing_period_invalid", 400, ["period_key_invalid"]);
  }
  return value;
}

function databasePeriodKind(periodKey: string, periodKind?: BillingPeriodKind): "billing" | "trial" {
  if (periodKind === "trial" || periodKey.startsWith("trial/")) return "trial";
  return "billing";
}

function requireTimestamp(value: string, field: string): string {
  if (typeof value !== "string") invalid(field);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) invalid(field);
  return value;
}

function changed(result: D1Result | undefined): number {
  return result?.meta.changes ?? 0;
}

function appError(error: unknown, fallback = "usage_unavailable"): AppError {
  return error instanceof AppError ? error : new AppError(fallback, 503);
}

async function run<T>(operation: () => Promise<T>, fallback = "usage_unavailable"): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw appError(error, fallback);
  }
}

/** Returns a stable key for one subscription billing window and kind. */
export function billingPeriodKey(start: string, end: string, kind: BillingPeriodKind | (string & {}) = "paid"): string {
  if (!isBillingPeriodKind(kind)) {
    throw new AppError("billing_period_invalid", 400, ["period_kind_invalid"]);
  }
  const periodStart = requireTimestamp(start, "period_start_invalid");
  const periodEnd = requireTimestamp(end, "period_end_invalid");
  if (periodStart >= periodEnd) {
    throw new AppError("billing_period_invalid", 400, ["period_order_invalid"]);
  }
  return `${kind}/${periodStart}/${periodEnd}`;
}

/**
 * Resolve the current period from the authoritative subscription row. This
 * intentionally excludes canceled and pending-payment subscriptions.
 */
export async function resolveBillingPeriod(input: { database: D1Database; shopId: string }): Promise<string> {
  const shopId = requireIdentifier(input.shopId, "shop_id_invalid");
  let row: SubscriptionPeriodRow | null;
  try {
    row = await input.database.prepare(`
      SELECT current_period_start AS currentPeriodStart,
        current_period_end AS currentPeriodEnd,
        trial_ends_at AS trialEndsAt,
        created_at AS createdAt,
        state
      FROM shop_subscriptions
      WHERE shop_id = ?
        AND state IN ('trialing', 'active', 'past_due', 'grace_period', 'suspended', 'cancel_scheduled', 'upgrade_pending', 'downgrade_scheduled')
        AND (current_period_start IS NOT NULL AND current_period_end IS NOT NULL
          OR state = 'trialing' AND trial_ends_at IS NOT NULL)
      ORDER BY COALESCE(current_period_end, trial_ends_at) DESC, id DESC
      LIMIT 1
    `).bind(shopId).first<SubscriptionPeriodRow>();
  } catch {
    // Keep local/legacy consumers readable while migration 0073 is being
    // admitted. New D1 schemas always take the branch above.
    row = await run(() => input.database.prepare(`
      SELECT current_period_start AS currentPeriodStart,
        current_period_end AS currentPeriodEnd,
        state
      FROM shop_subscriptions
      WHERE shop_id = ?
        AND state IN ('trialing', 'active', 'past_due', 'grace_period', 'suspended', 'cancel_scheduled', 'upgrade_pending', 'downgrade_scheduled')
        AND current_period_start IS NOT NULL
        AND current_period_end IS NOT NULL
      ORDER BY current_period_end DESC, id DESC
      LIMIT 1
    `).bind(shopId).first<SubscriptionPeriodRow>());
  }
  if (row === null) throw new AppError("billing_period_unavailable", 409);
  if (row.state === "trialing") {
    if (row.currentPeriodStart != null && row.currentPeriodEnd != null) {
      return billingPeriodKey(row.currentPeriodStart, row.currentPeriodEnd, "trial");
    }
    if (row.trialEndsAt == null || row.createdAt == null) throw new AppError("billing_period_unavailable", 409);
    // New trial subscriptions do not have paid period columns yet. Their
    // creation timestamp and explicit seven-day deadline form the stable
    // trial window and keep trial usage separate from the first paid period.
    return billingPeriodKey(row.createdAt, row.trialEndsAt, "trial");
  }
  if (row.currentPeriodStart == null || row.currentPeriodEnd == null) {
    throw new AppError("billing_period_unavailable", 409);
  }
  return billingPeriodKey(row.currentPeriodStart, row.currentPeriodEnd, "paid");
}

async function periodFor(input: { database: D1Database; periodKey?: string | undefined; periodKind?: BillingPeriodKind | undefined; shopId: string }): Promise<string> {
  if (input.periodKey === undefined) return resolveBillingPeriod({ database: input.database, shopId: input.shopId });
  const periodKey = requirePeriodKey(input.periodKey);
  if (input.periodKind !== undefined && !periodKey.startsWith(`${input.periodKind}/`)) {
    throw new AppError("billing_period_invalid", 400, ["period_kind_mismatch"]);
  }
  return periodKey;
}

async function findUsageEvent(input: {
  database: D1Database;
  metric: string;
  periodKey: string;
  shopId: string;
  sourceId: string;
  sourceKind: string;
}): Promise<UsageEventRow | null> {
  return run(() => input.database.prepare(`
    SELECT id, delta, occurred_at AS occurredAt, period_kind AS periodKind,
      period_key AS periodKey,
      source_kind AS sourceKind, source_id AS sourceId
    FROM usage_events
    WHERE shop_id = ? AND metric = ? AND period_key = ?
      AND source_kind = ? AND source_id = ?
    LIMIT 1
  `).bind(input.shopId, input.metric, input.periodKey, input.sourceKind, input.sourceId).first<UsageEventRow>());
}

async function readCounter(input: { database: D1Database; metric: string; periodKey: string; shopId: string }): Promise<CounterRow | null> {
  const row = await run(() => input.database.prepare(`
    SELECT value, updated_at AS updatedAt
    FROM usage_counters
    WHERE shop_id = ? AND metric = ? AND period_key = ?
    LIMIT 1
  `).bind(input.shopId, input.metric, input.periodKey).first<CounterRow>());
  return row;
}

function sameEvent(row: UsageEventRow, input: { delta: number; occurredAt: string }): boolean {
  return row.delta === input.delta && row.occurredAt === input.occurredAt;
}

function conflict(): never {
  throw new AppError("usage_event_conflict", 409);
}

/**
 * Prepare the two statements needed to append usage inside another D1 batch.
 * The caller must have already resolved the period and performed any plan
 * admission check; `changes()` keeps retries from incrementing the counter.
 */
export function prepareUsageStatements(input: {
  database: D1Database;
  delta: number;
  limit?: number;
  metric: string;
  occurredAt: string;
  periodKey: string;
  periodKind?: BillingPeriodKind | undefined;
  shopId: string;
  sourceId: string;
  sourceKind: UsageEventSourceKind;
  now?: Date;
}): PreparedUsageMutation {
  const shopId = requireIdentifier(input.shopId, "shop_id_invalid");
  const metric = requireMetric(input.metric);
  const sourceKind = requireSourceKind(input.sourceKind);
  const sourceId = requireSourceId(input.sourceId);
  const delta = requireDelta(input.delta);
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > MAX_DELTA)) {
    throw new AppError("quota_unavailable", 503);
  }
  const occurredAt = requireTimestamp(input.occurredAt, "occurred_at_invalid");
  const periodKey = requirePeriodKey(input.periodKey);
  const periodKind = databasePeriodKind(periodKey, input.periodKind);
  const nowIso = requireTimestamp((input.now ?? new Date(occurredAt)).toISOString(), "created_at_invalid");
  const eventId = createId("use");
  return {
    eventId,
    statements: [
      input.database.prepare(`
        INSERT OR IGNORE INTO usage_events (
          id, shop_id, metric, period_kind, period_key, source_kind, source_id,
          delta, occurred_at, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ? IS NULL OR COALESCE((
          SELECT value FROM usage_counters
          WHERE shop_id = ? AND metric = ? AND period_key = ?
          LIMIT 1
        ), 0) + ? <= ?
      `).bind(
        eventId, shopId, metric, periodKind, periodKey, sourceKind, sourceId, delta, occurredAt, nowIso,
        input.limit ?? null, shopId, metric, periodKey, delta, input.limit ?? null,
      ),
      input.database.prepare(`
        INSERT INTO usage_counters (shop_id, metric, period_kind, period_key, value, updated_at)
        SELECT ?, ?, ?, ?, ?, ?
        WHERE changes() = 1
        ON CONFLICT(shop_id, metric, period_key) DO UPDATE SET
          value = usage_counters.value + excluded.value,
          updated_at = excluded.updated_at
      `).bind(shopId, metric, periodKind, periodKey, delta, nowIso),
    ],
  };
}

/**
 * Record one usage event and update its counter atomically. `periodKey` is
 * optional so normal runtime calls can derive it from the current subscription;
 * import/reconciliation jobs may provide an already-authorized historical key.
 */
export async function recordUsage(input: {
  database: D1Database;
  delta: number;
  limit?: number;
  metric: string;
  occurredAt?: string;
  periodKey?: string;
  periodKind?: BillingPeriodKind | undefined;
  shopId: string;
  sourceId: string;
  sourceKind: UsageEventSourceKind;
  now?: Date;
}): Promise<UsageRecordResult> {
  const database = requireDatabase(input.database);
  const shopId = requireIdentifier(input.shopId, "shop_id_invalid");
  const metric = requireMetric(input.metric);
  const sourceKind = requireSourceKind(input.sourceKind);
  const sourceId = requireSourceId(input.sourceId);
  const delta = requireDelta(input.delta);
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > MAX_DELTA)) {
    throw new AppError("quota_unavailable", 503);
  }
  const occurredAt = requireTimestamp(input.occurredAt ?? (input.now ?? new Date()).toISOString(), "occurred_at_invalid");
  const now = input.now ?? new Date(occurredAt);
  const periodKey = await periodFor({ database, periodKey: input.periodKey, periodKind: input.periodKind, shopId });

  const existing = await findUsageEvent({ database, metric, periodKey, shopId, sourceId, sourceKind });
  if (existing !== null) {
    if (!sameEvent(existing, { delta, occurredAt })) conflict();
    const counter = await readCounter({ database, metric, periodKey, shopId });
    if (counter === null) throw new AppError("usage_counter_missing", 503);
    return { eventId: existing.id, metric, periodKey, shopId, status: "replayed", value: counter.value };
  }

  const prepared = prepareUsageStatements({
    database,
    delta,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    metric,
    occurredAt,
    now,
    periodKey,
    ...(input.periodKind === undefined ? {} : { periodKind: input.periodKind }),
    shopId,
    sourceId,
    sourceKind,
  });
  const eventId = prepared.eventId;
  let results: D1Result[];
  try {
    results = await database.batch([...prepared.statements]);
  } catch (error) {
    throw appError(error);
  }

  if (changed(results[0]) === 0) {
    // A concurrent insert won the unique key. Re-read the scoped row and
    // compare immutable event fields before treating the call as a replay.
    const raced = await findUsageEvent({ database, metric, periodKey, shopId, sourceId, sourceKind });
    if (raced === null) {
      if (input.limit !== undefined) throw new AppError("quota_exceeded", 409, [metric]);
      throw new AppError("usage_event_record_failed", 503);
    }
    if (!sameEvent(raced, { delta, occurredAt })) conflict();
    const counter = await readCounter({ database, metric, periodKey, shopId });
    if (counter === null) throw new AppError("usage_counter_missing", 503);
    return { eventId: raced.id, metric, periodKey, shopId, status: "replayed", value: counter.value };
  }

  const counter = await readCounter({ database, metric, periodKey, shopId });
  if (counter === null) throw new AppError("usage_counter_missing", 503);
  return { eventId, metric, periodKey, shopId, status: "applied", value: counter.value };
}

/** Explicit alias for callers that prefer the event-oriented name. */
export const recordUsageEvent = recordUsage;

export async function getUsage(input: { database: D1Database; metric: string; periodKey?: string; periodKind?: BillingPeriodKind; shopId: string }): Promise<{ metric: string; periodKey: string; shopId: string; updatedAt: string; value: number }> {
  const database = requireDatabase(input.database);
  const shopId = requireIdentifier(input.shopId, "shop_id_invalid");
  const metric = requireMetric(input.metric);
  const periodKey = await periodFor({ database, periodKey: input.periodKey, periodKind: input.periodKind, shopId });
  const counter = await readCounter({ database, metric, periodKey, shopId });
  return { metric, periodKey, shopId, updatedAt: counter?.updatedAt ?? "", value: counter?.value ?? 0 };
}

export async function checkQuota(input: {
  database: D1Database;
  limit: number;
  metric: string;
  periodKey?: string;
  periodKind?: BillingPeriodKind;
  requested?: number;
  shopId: string;
}): Promise<QuotaResult> {
  const database = requireDatabase(input.database);
  const shopId = requireIdentifier(input.shopId, "shop_id_invalid");
  const metric = requireMetric(input.metric);
  if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > MAX_DELTA) {
    throw new AppError("quota_unavailable", 503);
  }
  const requested = requireDelta(input.requested ?? 1, "requested_invalid");
  const periodKey = await periodFor({ database, periodKey: input.periodKey, periodKind: input.periodKind, shopId });
  const counter = await readCounter({ database, metric, periodKey, shopId });
  const current = counter?.value ?? 0;
  const allowed = current <= input.limit && requested <= input.limit - current;
  return {
    allowed,
    current,
    limit: input.limit,
    metric,
    periodKey,
    remaining: Math.max(0, input.limit - current),
    requested,
    shopId,
  };
}

/** Fail closed: unavailable state is an error, and an exhausted quota is not. */
export async function assertQuotaAvailable(input: Parameters<typeof checkQuota>[0]): Promise<QuotaResult> {
  const quota = await checkQuota(input);
  if (!quota.allowed) throw new AppError("quota_exceeded", 409, [quota.metric]);
  return quota;
}

/** Short alias for policy code that reads as a guard. */
export const assertQuota = assertQuotaAvailable;
