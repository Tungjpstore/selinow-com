/**
 * Fire-and-forget rule dispatcher.
 *
 * Hooks call `void fireAutomationTriggers(env, event).catch(() => {})` after
 * their business batch commits. This function NEVER throws: every failure is
 * logged with a safe code and reported as `{ skipped: true }`, so automation
 * can never take down the commerce event path.
 */
import { assertQuotaAvailable, recordUsage } from "../../billing/metering";
import { AppError } from "../../core/errors";
import { sha256Hex } from "../../events/append";
import { loggerFor } from "../../operations/logger";
import type { AppBindings } from "../../platform/bindings";
import { createD1AutomationTaskRepository } from "../d1-repository";
import { createAutomationExecutors } from "../executors";
import { createAutomationOrchestrator } from "../orchestrator";
import { safeEvaluate } from "./evaluator";
import { createD1AutomationRuleRepository } from "./repository";
import type { AutomationRuleRepository } from "./repository";
import type { RuleEventPayload, RuleTriggerEvent, RuleTriggerType } from "./types";

export type AutomationDispatchResult = {
  dispatched: number;
  matched: number;
  skipped: boolean;
};

const MAX_EVENT_PAYLOAD_JSON = 4096;
const MAX_LOW_STOCK_VARIANTS = 20;
const DEFAULT_LOW_STOCK_THRESHOLD = 5;
const encoder = new TextEncoder();

async function sha256Json(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeErrorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  return "automation_dispatch_failed";
}

function isOpenTaskLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("automation_open_task_limit");
}

/** Drops keys until the serialized payload fits the run-row column limit. */
function trimPayload(payload: RuleEventPayload): RuleEventPayload {
  let candidate: Record<string, boolean | number | string> = { ...payload };
  while (JSON.stringify(candidate).length > MAX_EVENT_PAYLOAD_JSON) {
    const keys = Object.keys(candidate);
    if (keys.length === 0) break;
    const dropped = keys[keys.length - 1];
    if (dropped === undefined) break;
    const next: Record<string, boolean | number | string> = {};
    for (const key of Object.keys(candidate)) {
      if (key === dropped) continue;
      const value = candidate[key];
      if (value === undefined) continue;
      next[key] = value;
    }
    candidate = next;
  }
  return candidate;
}

type OrderRow = {
  currency: string;
  customer_id: string | null;
  fulfillment_status: string;
  locale: string;
  order_number: string;
  public_id: string;
  source_channel: string;
  total_minor: number;
};

async function buildOrderPayload(
  database: D1Database,
  event: RuleTriggerEvent,
  includeReason: boolean,
): Promise<RuleEventPayload | null> {
  const orderId = event.refs?.orderId;
  if (orderId === undefined) return null;
  const order = await database
    .prepare(
      `SELECT order_number, public_id, total_minor, currency, locale,
        source_channel, fulfillment_status, customer_id
       FROM orders WHERE id = ? AND shop_id = ? LIMIT 1`,
    )
    .bind(orderId, event.shopId)
    .first<OrderRow>();
  if (order === null) return null;
  const items = await database
    .prepare(
      "SELECT COALESCE(SUM(quantity), 0) AS units FROM order_items WHERE order_id = ? AND shop_id = ?",
    )
    .bind(orderId, event.shopId)
    .first<{ units: number }>();
  const payload: Record<string, boolean | number | string> = {
    "order.number": order.order_number,
    "order.public_id": order.public_id,
    "order.total_minor": order.total_minor,
    "order.currency": order.currency,
    "order.locale": order.locale,
    "order.source_channel": order.source_channel,
    "order.item_count": items?.units ?? 0,
    "order.fulfillment_status": order.fulfillment_status,
  };
  if (order.customer_id !== null) {
    payload["customer.id"] = order.customer_id;
    const customer = await database
      .prepare("SELECT locale FROM shop_customers WHERE id = ? AND shop_id = ? LIMIT 1")
      .bind(order.customer_id, event.shopId)
      .first<{ locale: string }>();
    if (customer !== null) payload["customer.locale"] = customer.locale;
  }
  if (includeReason) {
    payload["payment.reason"] = event.refs?.reason ?? "unknown";
  }
  return payload;
}

async function buildPayload(
  database: D1Database,
  event: RuleTriggerEvent,
): Promise<RuleEventPayload | null> {
  switch (event.triggerType) {
    case "order.paid":
    case "order.fulfilled":
      return buildOrderPayload(database, event, false);
    case "payment.failed":
      return buildOrderPayload(database, event, true);
    case "customer.created": {
      const customerId = event.customerId;
      if (customerId === undefined) return null;
      const customer = await database
        .prepare("SELECT locale FROM shop_customers WHERE id = ? AND shop_id = ? LIMIT 1")
        .bind(customerId, event.shopId)
        .first<{ locale: string }>();
      if (customer === null) return null;
      const payload: Record<string, boolean | number | string> = {
        "customer.id": customerId,
        "customer.locale": customer.locale,
      };
      const channel = event.refs?.channel;
      if (channel !== undefined) payload["customer.channel"] = channel;
      return payload;
    }
    case "inventory.low_stock":
      // Built internally by computeLowStockEvents; never fired from a hook.
      return null;
  }
}

/**
 * Stock is derived: after an order is paid the dispatcher counts remaining
 * available inventory keys per purchased variant against the shop threshold.
 */
async function computeLowStockEvents(
  database: D1Database,
  event: RuleTriggerEvent,
): Promise<Array<{ aggregateReference: string; payload: RuleEventPayload }>> {
  const orderId = event.refs?.orderId;
  if (orderId === undefined) return [];
  const thresholdRow = await database
    .prepare("SELECT low_stock_threshold AS threshold FROM shop_settings WHERE shop_id = ? LIMIT 1")
    .bind(event.shopId)
    .first<{ threshold: number }>();
  const threshold = thresholdRow?.threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
  const variants = await database
    .prepare(
      `SELECT DISTINCT variant_id AS variantId FROM order_items
       WHERE order_id = ? AND shop_id = ? LIMIT ?`,
    )
    .bind(orderId, event.shopId, MAX_LOW_STOCK_VARIANTS)
    .all<{ variantId: string }>();
  const events: Array<{ aggregateReference: string; payload: RuleEventPayload }> = [];
  for (const row of variants.results) {
    const managed = await database
      .prepare("SELECT COUNT(*) AS total FROM inventory_keys WHERE shop_id = ? AND variant_id = ?")
      .bind(event.shopId, row.variantId)
      .first<{ total: number }>();
    // Variants without inventory keys are manually fulfilled; stock does not apply.
    if ((managed?.total ?? 0) === 0) continue;
    const remainingRow = await database
      .prepare(
        "SELECT COUNT(*) AS remaining FROM inventory_keys WHERE shop_id = ? AND variant_id = ? AND status = 'available'",
      )
      .bind(event.shopId, row.variantId)
      .first<{ remaining: number }>();
    const remaining = remainingRow?.remaining ?? 0;
    if (remaining > threshold) continue;
    const skuRow = await database
      .prepare("SELECT sku FROM product_variants WHERE id = ? AND shop_id = ? LIMIT 1")
      .bind(row.variantId, event.shopId)
      .first<{ sku: string }>();
    events.push({
      // Threshold is part of the reference so raising it re-alerts.
      aggregateReference: `stock:${row.variantId}:${String(threshold)}`,
      payload: {
        "stock.remaining": remaining,
        "stock.threshold": threshold,
        "stock.sku": skuRow?.sku ?? "",
      },
    });
  }
  return events;
}

async function loadAutomationRunLimit(database: D1Database, shopId: string): Promise<number | null> {
  const row = await database
    .prepare(
      `SELECT plans.limits_json AS limitsJson
       FROM shop_subscriptions AS subscriptions
       INNER JOIN plans ON plans.id = subscriptions.plan_id
       WHERE subscriptions.shop_id = ?
       ORDER BY subscriptions.created_at DESC, subscriptions.id DESC
       LIMIT 1`,
    )
    .bind(shopId)
    .first<{ limitsJson: string }>();
  if (row === null) return null;
  let limits: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.limitsJson) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    limits = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const value = limits["automation_runs"];
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) return 0; // fail closed
  return value as number;
}

async function dispatchFor(env: AppBindings, event: {
  aggregateReference: string;
  payload: RuleEventPayload;
  shopId: string;
  triggerType: RuleTriggerType;
}): Promise<AutomationDispatchResult> {
  const database = env.PLATFORM_DB;
  const repository = createD1AutomationRuleRepository(database);
  const rules = await repository.listEnabledByTrigger({ shopId: event.shopId, triggerType: event.triggerType });
  if (rules.length === 0) return { dispatched: 0, matched: 0, skipped: false };

  const orchestrator = createAutomationOrchestrator({
    executors: createAutomationExecutors(env),
    repository: createD1AutomationTaskRepository(database),
  });
  const runLimit = await loadAutomationRunLimit(database, event.shopId);
  const now = new Date().toISOString();
  const storedPayload = trimPayload(event.payload);
  let matched = 0;
  let dispatched = 0;

  for (const rule of rules) {
    if (!safeEvaluate(rule.conditions, event.payload)) continue;
    matched += 1;
    await repository.markTriggered({ now, ruleId: rule.id, shopId: event.shopId });
    dispatched += await dispatchActions(env, { event, now, orchestrator, repository, rule, runLimit, storedPayload });
  }
  return { dispatched, matched, skipped: false };
}

async function dispatchActions(env: AppBindings, input: {
  event: { aggregateReference: string; shopId: string; triggerType: RuleTriggerType };
  now: string;
  orchestrator: ReturnType<typeof createAutomationOrchestrator>;
  repository: AutomationRuleRepository;
  rule: Awaited<ReturnType<AutomationRuleRepository["listEnabledByTrigger"]>>[number];
  runLimit: number | null;
  storedPayload: RuleEventPayload;
}): Promise<number> {
  const database = env.PLATFORM_DB;
  const logger = loggerFor(env);
  const { event, now, orchestrator, repository, rule, runLimit, storedPayload } = input;
  let dispatched = 0;

  for (const [index, action] of rule.actions.entries()) {
    // Deterministic id: replays/retries converge on the same run row.
    const runId = `arun_${(
      await sha256Hex(`${event.shopId}|${rule.id}|${event.triggerType}|${event.aggregateReference}|${String(index)}`)
    ).slice(0, 48)}`;

    if (runLimit !== null) {
      try {
        await assertQuotaAvailable({
          database,
          limit: runLimit,
          metric: "automation_runs",
          requested: 1,
          shopId: event.shopId,
        });
      } catch {
        // Exhausted: skip without creating a run row.
        logger.warn({ errorCode: "automation.rule_quota_exhausted", event: "automation.rule_quota_exhausted" });
        continue;
      }
    }

    const inserted = await repository.insertRun({
      run: {
        id: runId,
        shopId: event.shopId,
        ruleId: rule.id,
        ruleVersion: rule.version,
        triggerType: event.triggerType,
        actionIndex: index,
        actionType: action.type,
        actionConfig: action.config,
        eventPayload: storedPayload,
        aggregateReference: event.aggregateReference,
        taskId: null,
        createdAt: now,
      },
    });
    // Natural-key dedup: this (rule, event, action) was already dispatched.
    if (!inserted) continue;

    try {
      const task = await orchestrator.start(
        { actorId: rule.id, actorRole: "system", shopId: event.shopId },
        {
          capabilityCode: action.type,
          idempotencyKeyHash: await sha256Hex(`rule-run:${runId}`),
          inputReference: `action:rule-run/${runId}`,
          requestHash: await sha256Json({ capabilityCode: action.type, runId, shopId: event.shopId }),
          shopId: event.shopId,
        },
      );
      await database
        .prepare("UPDATE automation_tasks SET rule_id = ? WHERE id = ? AND shop_id = ?")
        .bind(rule.id, task.id, event.shopId)
        .run();
      await repository.linkTask({ runId, shopId: event.shopId, taskId: task.id });
      if (runLimit !== null) {
        await recordUsage({
          database,
          delta: 1,
          limit: runLimit,
          metric: "automation_runs",
          occurredAt: now,
          shopId: event.shopId,
          sourceId: task.id,
          sourceKind: "automation",
        });
      }
      dispatched += 1;
    } catch (error) {
      if (isOpenTaskLimitError(error)) {
        logger.warn({ errorCode: "automation_open_task_limit", event: "automation.rule_task_limit" });
        continue;
      }
      logger.error({ errorCode: safeErrorCode(error), event: "automation.rule_action_failed" });
    }
  }
  return dispatched;
}

async function dispatchEvent(env: AppBindings, event: RuleTriggerEvent): Promise<AutomationDispatchResult> {
  const database = env.PLATFORM_DB;
  const payload = await buildPayload(database, event);
  if (payload === null) return { dispatched: 0, matched: 0, skipped: true };
  // Only alert on fulfillment when the order is fully fulfilled.
  if (event.triggerType === "order.fulfilled" && payload["order.fulfillment_status"] !== "fulfilled") {
    return { dispatched: 0, matched: 0, skipped: true };
  }
  const primary = await dispatchFor(env, {
    aggregateReference: event.aggregateReference,
    payload,
    shopId: event.shopId,
    triggerType: event.triggerType,
  });

  let totals = primary;
  // Stock alerts are derived from paid orders; no separate hook exists.
  if (event.triggerType === "order.paid") {
    const lowStockEvents = await computeLowStockEvents(database, event);
    for (const lowStock of lowStockEvents) {
      const result = await dispatchFor(env, {
        aggregateReference: lowStock.aggregateReference,
        payload: lowStock.payload,
        shopId: event.shopId,
        triggerType: "inventory.low_stock",
      });
      totals = {
        dispatched: totals.dispatched + result.dispatched,
        matched: totals.matched + result.matched,
        skipped: totals.skipped || result.skipped,
      };
    }
  }
  return totals;
}

/**
 * Entry point for commerce hooks. Never throws; failures are logged and
 * reported as skipped so the caller's critical path is never affected.
 */
export async function fireAutomationTriggers(
  env: AppBindings,
  event: RuleTriggerEvent,
): Promise<AutomationDispatchResult> {
  try {
    return await dispatchEvent(env, event);
  } catch (error) {
    try {
      loggerFor(env).error({ errorCode: safeErrorCode(error), event: "automation.rule_dispatch_failed" });
    } catch {
      // Logging must never break the fail-safe contract.
    }
    return { dispatched: 0, matched: 0, skipped: true };
  }
}
