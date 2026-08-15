import { AppError } from "../core/errors";
import { sha256Json } from "../core/crypto";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";

export const ACTIVATION_MILESTONES = [
  "setup_started",
  "shop_created",
  "product_created",
  "inventory_ready",
  "payos_connected",
  "telegram_connected",
  "readiness_passed",
  "safe_test_passed",
  "storefront_published",
  "first_order_created",
  "first_paid_fulfilled",
  "trial_converted",
] as const;

export type ActivationMilestone = (typeof ACTIVATION_MILESTONES)[number];

export const ACTIVATION_SOURCE_KINDS = [
  "onboarding",
  "shop",
  "catalog",
  "inventory",
  "payment",
  "telegram",
  "readiness",
  "safe_test",
  "storefront",
  "commerce",
  "billing",
] as const;

export type ActivationSourceKind = (typeof ACTIVATION_SOURCE_KINDS)[number];

export const ACTIVATION_REASON_CODES = [
  "started",
  "created",
  "ready",
  "connected",
  "passed",
  "published",
  "ordered",
  "fulfilled",
  "converted",
  "manual",
] as const;

export type ActivationReasonCode = (typeof ACTIVATION_REASON_CODES)[number];

// Only enum-like dimensions are accepted. This keeps analytics projections
// free of credentials, customer data, URLs, and opaque provider identifiers.
const PROJECTION_VALUES = {
  channel: ["website", "telegram"],
  currency: ["VND", "USD", "EUR", "JPY"],
  fulfillment_type: ["license_key", "manual"],
  trigger: ["manual", "publish", "test"],
} as const;

export type ActivationProjection = {
  [Key in keyof typeof PROJECTION_VALUES]?: (typeof PROJECTION_VALUES)[Key][number];
};

const EXPECTED_CONTEXT: Record<ActivationMilestone, {
  reason: ActivationReasonCode;
  source: ActivationSourceKind;
}> = {
  setup_started: { reason: "started", source: "onboarding" },
  shop_created: { reason: "created", source: "shop" },
  product_created: { reason: "created", source: "catalog" },
  inventory_ready: { reason: "ready", source: "inventory" },
  payos_connected: { reason: "connected", source: "payment" },
  telegram_connected: { reason: "connected", source: "telegram" },
  readiness_passed: { reason: "passed", source: "readiness" },
  safe_test_passed: { reason: "passed", source: "safe_test" },
  storefront_published: { reason: "published", source: "storefront" },
  first_order_created: { reason: "created", source: "commerce" },
  first_paid_fulfilled: { reason: "fulfilled", source: "commerce" },
  trial_converted: { reason: "converted", source: "billing" },
};

export type ActivationMilestoneEvent = {
  createdAt: string;
  id: string;
  milestone: ActivationMilestone;
  occurredAt: string;
  projection: ActivationProjection;
  reason: ActivationReasonCode;
  shopId: string;
  source: ActivationSourceKind;
};

type ActivationMilestoneRow = {
  created_at: string;
  id: string;
  payload_hash?: string;
  milestone_code: ActivationMilestone;
  occurred_at: string;
  projection_json: string;
  reason_code: ActivationReasonCode;
  shop_id: string;
  source_kind: ActivationSourceKind;
};

function isValue<T extends readonly string[]>(values: T, value: string): value is T[number] {
  return (values as readonly string[]).includes(value);
}

function assertBoundedToken(value: unknown, issue: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value)) {
    throw new AppError("validation_failed", 400, [issue]);
  }
}

function normalizeProjection(value: unknown): ActivationProjection {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation_failed", 400, ["activation_projection_invalid"]);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 8) throw new AppError("validation_failed", 400, ["activation_projection_invalid"]);
  const normalized: Record<string, string> = {};
  for (const [key, item] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!Object.hasOwn(PROJECTION_VALUES, key)) {
      throw new AppError("validation_failed", 400, ["activation_projection_field_invalid"]);
    }
    const allowed = PROJECTION_VALUES[key as keyof typeof PROJECTION_VALUES] as readonly string[];
    if (typeof item !== "string" || !allowed.includes(item)) {
      throw new AppError("validation_failed", 400, ["activation_projection_value_invalid"]);
    }
    normalized[key] = item;
  }
  return normalized;
}

function parseProjection(value: string): ActivationProjection {
  try {
    return normalizeProjection(JSON.parse(value) as ActivationProjection);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("data_integrity_error", 500, ["activation_projection_invalid"]);
  }
}

function mapEvent(row: ActivationMilestoneRow): ActivationMilestoneEvent {
  return {
    createdAt: row.created_at,
    id: row.id,
    milestone: row.milestone_code,
    occurredAt: row.occurred_at,
    projection: parseProjection(row.projection_json),
    reason: row.reason_code,
    shopId: row.shop_id,
    source: row.source_kind,
  };
}

function validateOccurredAt(value: string | undefined): string {
  const normalized = value ?? new Date().toISOString();
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== normalized) {
    throw new AppError("validation_failed", 400, ["activation_occurred_at_invalid"]);
  }
  return normalized;
}

async function findByIdempotency(env: AppBindings, shopId: string, idempotencyKeyHash: string): Promise<ActivationMilestoneRow | null> {
  return env.PLATFORM_DB.prepare(`
    SELECT id, shop_id, milestone_code, source_kind, reason_code,
      idempotency_key_hash, payload_hash, projection_json, occurred_at, created_at
    FROM activation_milestones
    WHERE shop_id = ? AND idempotency_key_hash = ?
    LIMIT 1
  `).bind(shopId, idempotencyKeyHash).first<ActivationMilestoneRow>();
}

/** Records a durable tenant milestone and returns the prior event on replay. */
export async function recordActivationMilestone(input: {
  env: AppBindings;
  idempotencyKey: string;
  milestone: ActivationMilestone;
  occurredAt?: string;
  projection?: ActivationProjection;
  reason: ActivationReasonCode;
  shopId: string;
  source: ActivationSourceKind;
}): Promise<{ created: boolean; event: ActivationMilestoneEvent }> {
  assertBoundedToken(input.shopId, "shop_id_invalid");
  assertBoundedToken(input.idempotencyKey, "activation_idempotency_key_invalid");
  if (!isValue(ACTIVATION_MILESTONES, input.milestone)) {
    throw new AppError("validation_failed", 400, ["activation_milestone_invalid"]);
  }
  if (!isValue(ACTIVATION_SOURCE_KINDS, input.source)) {
    throw new AppError("validation_failed", 400, ["activation_source_invalid"]);
  }
  if (!isValue(ACTIVATION_REASON_CODES, input.reason)) {
    throw new AppError("validation_failed", 400, ["activation_reason_invalid"]);
  }
  const expected = EXPECTED_CONTEXT[input.milestone];
  if (expected.source !== input.source || expected.reason !== input.reason) {
    throw new AppError("validation_failed", 400, ["activation_context_invalid"]);
  }
  const projection = normalizeProjection(input.projection);
  const occurredAt = validateOccurredAt(input.occurredAt);
  const idempotencyKeyHash = await sha256Json({ idempotencyKey: input.idempotencyKey });
  const payloadHash = await sha256Json({
    milestone: input.milestone,
    projection,
    reason: input.reason,
    source: input.source,
  });
  const existing = await findByIdempotency(input.env, input.shopId, idempotencyKeyHash);
  if (existing !== null) {
    if (existing.payload_hash !== payloadHash) throw new AppError("idempotency_conflict", 409);
    return { created: false, event: mapEvent(existing) };
  }

  const now = new Date().toISOString();
  try {
    await input.env.PLATFORM_DB.prepare(`
      INSERT INTO activation_milestones (
        id, shop_id, milestone_code, source_kind, reason_code,
        idempotency_key_hash, payload_hash, projection_json, occurred_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      createId("act"), input.shopId, input.milestone, input.source, input.reason,
      idempotencyKeyHash, payloadHash, JSON.stringify(projection), occurredAt, now,
    ).run();
  } catch (error) {
    // A concurrent retry may win the unique tenant-scoped insert.
    const raced = await findByIdempotency(input.env, input.shopId, idempotencyKeyHash);
    if (raced === null) throw error;
    if (raced.payload_hash !== payloadHash) throw new AppError("idempotency_conflict", 409);
    return { created: false, event: mapEvent(raced) };
  }
  const inserted = await findByIdempotency(input.env, input.shopId, idempotencyKeyHash);
  if (inserted === null) throw new AppError("data_integrity_error", 500, ["activation_event_missing"]);
  return { created: true, event: mapEvent(inserted) };
}

/** Best-effort emitter for commerce paths; analytics failures never block them. */
export async function tryRecordActivationMilestone(input: Parameters<typeof recordActivationMilestone>[0]): Promise<ActivationMilestoneEvent | null> {
  try {
    return (await recordActivationMilestone(input)).event;
  } catch {
    return null;
  }
}

export async function listActivationMilestones(input: {
  env: AppBindings;
  limit?: number;
  shopId: string;
}): Promise<ActivationMilestoneEvent[]> {
  assertBoundedToken(input.shopId, "shop_id_invalid");
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new AppError("validation_failed", 400, ["activation_limit_invalid"]);
  }
  const rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id, shop_id, milestone_code, source_kind, reason_code,
      projection_json, occurred_at, created_at
    FROM activation_milestones
    WHERE shop_id = ?
    ORDER BY occurred_at ASC, id ASC
    LIMIT ?
  `).bind(input.shopId, limit).all<ActivationMilestoneRow>();
  return rows.results.map(mapEvent);
}

/** Purges only the explicitly supplied tenant and cutoff; callers own retention policy. */
export async function purgeActivationMilestones(input: {
  env: AppBindings;
  olderThan: string;
  shopId: string;
}): Promise<number> {
  assertBoundedToken(input.shopId, "shop_id_invalid");
  const olderThan = validateOccurredAt(input.olderThan);
  const result = await input.env.PLATFORM_DB.prepare(`
    DELETE FROM activation_milestones
    WHERE shop_id = ? AND occurred_at < ?
  `).bind(input.shopId, olderThan).run();
  return result.meta.changes;
}

/** Emits the paid-fulfillment milestone only after the authoritative order row is fulfilled. */
export async function tryRecordFirstPaidFulfilled(input: {
  env: AppBindings;
  orderId: string;
  shopId: string;
}): Promise<ActivationMilestoneEvent | null> {
  try {
    assertBoundedToken(input.shopId, "shop_id_invalid");
    assertBoundedToken(input.orderId, "order_id_invalid");
    const fulfilled = await input.env.PLATFORM_DB.prepare(`
      SELECT 1 AS ready
      FROM orders
      WHERE id = ? AND shop_id = ?
        AND payment_status = 'paid' AND fulfillment_status = 'fulfilled'
      LIMIT 1
    `).bind(input.orderId, input.shopId).first<{ ready: number }>();
    if (fulfilled?.ready !== 1) return null;
    return await tryRecordActivationMilestone({
      env: input.env,
      idempotencyKey: "first_paid_fulfilled",
      milestone: "first_paid_fulfilled",
      reason: "fulfilled",
      shopId: input.shopId,
      source: "commerce",
    });
  } catch {
    // Milestone analytics are best effort and must not block fulfillment.
    return null;
  }
}

type BackfillRow = { occurredAt: string | null };

/**
 * Reconciles milestones from authoritative D1 state after a failed best-effort
 * emit. The deterministic keys make this safe to run repeatedly and ensure a
 * late retry cannot create duplicate tenant milestones.
 */
export async function backfillActivationMilestones(input: {
  env: AppBindings;
  now?: string;
  shopId: string;
}): Promise<{ attempted: number; created: number }> {
  assertBoundedToken(input.shopId, "shop_id_invalid");
  const now = validateOccurredAt(input.now);
  const query = async (sql: string, ...bindings: unknown[]): Promise<string | null> => {
    const row = await input.env.PLATFORM_DB.prepare(sql).bind(...bindings).first<BackfillRow>();
    return row?.occurredAt ?? null;
  };
  const candidates: Array<{
    idempotencyKey: string;
    milestone: ActivationMilestone;
    occurredAt: string | null;
    projection?: ActivationProjection;
  }> = [
    {
      idempotencyKey: "setup_started",
      milestone: "setup_started",
      occurredAt: await query("SELECT created_at AS occurredAt FROM shops WHERE id = ? LIMIT 1", input.shopId),
    },
    {
      idempotencyKey: "shop_created",
      milestone: "shop_created",
      occurredAt: await query("SELECT created_at AS occurredAt FROM shops WHERE id = ? LIMIT 1", input.shopId),
    },
    {
      idempotencyKey: "product_created",
      milestone: "product_created",
      occurredAt: await query("SELECT MIN(created_at) AS occurredAt FROM products WHERE shop_id = ?", input.shopId),
    },
    {
      idempotencyKey: "inventory_ready",
      milestone: "inventory_ready",
      occurredAt: await query(`
        SELECT MIN(occurred_at) AS occurredAt
        FROM (
          SELECT MAX(
            inventory_batches.created_at,
            products.activated_at,
            product_variants.activated_at
          ) AS occurred_at
          FROM inventory_batches
          INNER JOIN product_variants
            ON product_variants.id = inventory_batches.variant_id
            AND product_variants.shop_id = inventory_batches.shop_id
            AND product_variants.status = 'active'
          INNER JOIN products
            ON products.id = product_variants.product_id
            AND products.shop_id = product_variants.shop_id
            AND products.status = 'active'
          WHERE inventory_batches.shop_id = ?
            AND inventory_batches.accepted_count > 0
            AND products.activated_at IS NOT NULL
            AND product_variants.activated_at IS NOT NULL
          UNION ALL
          SELECT MAX(products.activated_at, product_variants.activated_at) AS occurred_at
          FROM products
          INNER JOIN product_variants
            ON product_variants.product_id = products.id
            AND product_variants.shop_id = products.shop_id
            AND product_variants.status = 'active'
          WHERE products.shop_id = ?
            AND products.status = 'active'
            AND products.fulfillment_type = 'manual'
            AND products.activated_at IS NOT NULL
            AND product_variants.activated_at IS NOT NULL
        )
      `, input.shopId, input.shopId),
    },
    {
      idempotencyKey: "payos_connected",
      milestone: "payos_connected",
      occurredAt: await query("SELECT connected_at AS occurredAt FROM payment_integrations WHERE shop_id = ? AND provider = 'payos' AND status = 'active' AND webhook_status = 'verified' AND connected_at IS NOT NULL ORDER BY connected_at LIMIT 1", input.shopId),
    },
    {
      idempotencyKey: "telegram_connected",
      milestone: "telegram_connected",
      occurredAt: await query("SELECT connected_at AS occurredAt FROM telegram_integrations WHERE shop_id = ? AND status = 'active' AND webhook_status = 'verified' AND connected_at IS NOT NULL ORDER BY connected_at LIMIT 1", input.shopId),
    },
    {
      idempotencyKey: "readiness_passed",
      milestone: "readiness_passed",
      occurredAt: await query("SELECT checked_at AS occurredAt FROM shop_readiness_runs WHERE shop_id = ? AND overall_status = 'ready' ORDER BY checked_at LIMIT 1", input.shopId),
    },
    {
      idempotencyKey: "safe_test_passed",
      milestone: "safe_test_passed",
      occurredAt: await query("SELECT checked_at AS occurredAt FROM shop_readiness_runs WHERE shop_id = ? AND trigger_kind = 'test' AND overall_status = 'ready' ORDER BY checked_at LIMIT 1", input.shopId),
      projection: { trigger: "test" },
    },
    {
      idempotencyKey: "storefront_published",
      milestone: "storefront_published",
      occurredAt: await query("SELECT published_at AS occurredAt FROM shop_settings WHERE shop_id = ? AND published_at IS NOT NULL ORDER BY published_at LIMIT 1", input.shopId),
    },
    {
      idempotencyKey: "first_order_created",
      milestone: "first_order_created",
      occurredAt: await query("SELECT created_at AS occurredAt FROM orders WHERE shop_id = ? ORDER BY created_at LIMIT 1", input.shopId),
    },
    {
      idempotencyKey: "first_paid_fulfilled",
      milestone: "first_paid_fulfilled",
      occurredAt: await query("SELECT fulfilled_at AS occurredAt FROM orders WHERE shop_id = ? AND payment_status = 'paid' AND fulfillment_status = 'fulfilled' AND fulfilled_at IS NOT NULL ORDER BY fulfilled_at LIMIT 1", input.shopId),
    },
    {
      idempotencyKey: "trial_converted",
      milestone: "trial_converted",
      occurredAt: await query("SELECT occurred_at AS occurredAt FROM subscription_events WHERE shop_id = ? AND from_state = 'trialing' AND to_state = 'active' ORDER BY occurred_at LIMIT 1", input.shopId),
    },
  ];
  let created = 0;
  for (const candidate of candidates) {
    if (candidate.occurredAt === null) continue;
    const result = await recordActivationMilestone({
      env: input.env,
      idempotencyKey: candidate.idempotencyKey,
      milestone: candidate.milestone,
      occurredAt: candidate.occurredAt,
      ...(candidate.projection === undefined ? {} : { projection: candidate.projection }),
      reason: EXPECTED_CONTEXT[candidate.milestone].reason,
      shopId: input.shopId,
      source: EXPECTED_CONTEXT[candidate.milestone].source,
    });
    if (result.created) created += 1;
  }
  // Keep `now` validated even when the authoritative tenant has no evidence;
  // this makes malformed recovery timestamps fail closed consistently.
  void now;
  return { attempted: candidates.filter((candidate) => candidate.occurredAt !== null).length, created };
}

export type ActivationBackfillMetrics = {
  attempted: number;
  created: number;
  failed: number;
  shops: number;
};

/** Rotate through every tenant so failed best-effort emitters are recoverable. */
export async function processActivationMilestoneBackfill(input: {
  env: AppBindings;
  limit?: number;
  now?: Date;
}): Promise<ActivationBackfillMetrics> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const limit = Number.isSafeInteger(input.limit) && (input.limit ?? 0) > 0 ? Math.min(input.limit ?? 25, 100) : 25;
  const checkpoint = await input.env.PLATFORM_DB.prepare(`
    SELECT last_shop_id AS lastShopId
    FROM activation_backfill_checkpoints
    WHERE id = 'global'
    LIMIT 1
  `).first<{ lastShopId: string | null }>();
  const lastShopId = checkpoint?.lastShopId ?? null;
  let rows = await input.env.PLATFORM_DB.prepare(`
    SELECT id
    FROM shops
    WHERE ? IS NULL OR id > ?
    ORDER BY id
    LIMIT ?
  `).bind(lastShopId, lastShopId, limit).all<{ id: string }>();
  if (rows.results.length === 0 && lastShopId !== null) {
    rows = await input.env.PLATFORM_DB.prepare(`
      SELECT id
      FROM shops
      ORDER BY id
      LIMIT ?
    `).bind(limit).all<{ id: string }>();
  }
  const metrics: ActivationBackfillMetrics = { attempted: 0, created: 0, failed: 0, shops: rows.results.length };
  for (const shop of rows.results) {
    try {
      const result = await backfillActivationMilestones({ env: input.env, now: nowIso, shopId: shop.id });
      metrics.attempted += result.attempted;
      metrics.created += result.created;
    } catch {
      metrics.failed += 1;
    }
  }
  const nextShopId = rows.results.at(-1)?.id ?? null;
  await input.env.PLATFORM_DB.prepare(`
    UPDATE activation_backfill_checkpoints
    SET last_shop_id = ?, updated_at = ?
    WHERE id = 'global'
  `).bind(nextShopId, nowIso).run();
  return metrics;
}
