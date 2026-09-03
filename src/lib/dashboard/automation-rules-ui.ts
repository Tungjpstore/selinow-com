/**
 * Client-safe parsing and presentation helpers for automation rules.
 *
 * Mirrors the defensive projection pattern of `automation-ui.ts`: only the
 * public scalar projection returned by the rules API is accepted — raw DB
 * rows, credentials, or provider payloads never reach this layer.
 */
import {
  RULE_ACTION_TYPES,
  RULE_CONDITION_OPERATORS,
  RULE_TRIGGER_TYPES,
  type RuleActionType,
  type RuleConditionOperator,
  type RuleTriggerType,
} from "../automation/rules/types";
import { createDashboardTranslator, resolvePresentationLocale } from "../i18n";
import type { ShopRole } from "../tenants/policy";

export type RuleConditionValue = boolean | number | string | readonly string[];

export type RuleConditionView = {
  field: string;
  operator: RuleConditionOperator;
  value: RuleConditionValue;
};

export type RuleActionView = {
  type: RuleActionType;
  config: Record<string, unknown>;
};

export type RuleRunView = {
  actionIndex: number;
  actionType: RuleActionType;
  taskStatus: string | null;
  createdAt: string;
};

export type RuleView = {
  actions: readonly RuleActionView[];
  conditions: readonly RuleConditionView[];
  createdAt: string;
  enabled: boolean;
  id: string;
  lastRuns: readonly RuleRunView[];
  lastTriggeredAt: string | null;
  name: string;
  triggerType: RuleTriggerType;
  updatedAt: string;
  version: number;
};

const SAFE_RULE_ID = /^rule_[0-9a-f-]{36}$/u;
const SAFE_FIELD = /^[a-z0-9_.]{1,64}$/u;
const SAFE_CODE = /^[a-z0-9_.:-]{1,96}$/u;
const MAX_CONDITIONS = 10;
const MAX_ACTIONS = 10;
const MAX_IN_VALUES = 20;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseConditionValue(value: unknown): RuleConditionValue | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return value.length <= 512 ? value : null;
  if (Array.isArray(value) && value.length > 0 && value.length <= MAX_IN_VALUES && value.every((item) => typeof item === "string" && item.length <= 512)) {
    return value as string[];
  }
  return null;
}

function parseCondition(value: unknown): RuleConditionView | null {
  const row = recordOf(value);
  if (row === null || typeof row.field !== "string" || !SAFE_FIELD.test(row.field)) return null;
  const parsedValue = parseConditionValue(row.value);
  if (parsedValue === null) return null;
  if (typeof row.operator !== "string" || !RULE_CONDITION_OPERATORS.includes(row.operator as RuleConditionOperator)) return null;
  return { field: row.field, operator: row.operator as RuleConditionOperator, value: parsedValue };
}

function parseAction(value: unknown): RuleActionView | null {
  const row = recordOf(value);
  if (row === null || typeof row.type !== "string" || !RULE_ACTION_TYPES.includes(row.type as RuleActionType)) return null;
  const config = recordOf(row.config);
  if (config === null) return null;
  // Keep the projection bounded; the DB CHECKs enforce the same size caps.
  try {
    if (JSON.stringify(config).length > 16_384) return null;
  } catch {
    return null;
  }
  return { config, type: row.type as RuleActionType };
}

function parseRun(value: unknown): RuleRunView | null {
  const row = recordOf(value);
  if (row === null
    || !Number.isSafeInteger(row.actionIndex)
    || (row.actionIndex as number) < 0
    || typeof row.actionType !== "string"
    || !RULE_ACTION_TYPES.includes(row.actionType as RuleActionType)
    || !(row.taskStatus === null || (typeof row.taskStatus === "string" && SAFE_CODE.test(row.taskStatus)))
    || typeof row.createdAt !== "string") {
    return null;
  }
  return {
    actionIndex: row.actionIndex as number,
    actionType: row.actionType as RuleActionType,
    createdAt: row.createdAt,
    taskStatus: row.taskStatus,
  };
}

function parseRule(value: unknown): RuleView | null {
  const row = recordOf(value);
  if (row === null
    || typeof row.id !== "string"
    || !SAFE_RULE_ID.test(row.id)
    || typeof row.name !== "string"
    || row.name.length === 0
    || row.name.length > 120
    || typeof row.triggerType !== "string"
    || !RULE_TRIGGER_TYPES.includes(row.triggerType as RuleTriggerType)
    || typeof row.enabled !== "boolean"
    || !Number.isSafeInteger(row.version)
    || (row.version as number) < 1
    || !(row.lastTriggeredAt === null || typeof row.lastTriggeredAt === "string")
    || typeof row.createdAt !== "string"
    || typeof row.updatedAt !== "string"
    || !Array.isArray(row.conditions)
    || row.conditions.length > MAX_CONDITIONS
    || !Array.isArray(row.actions)
    || row.actions.length === 0
    || row.actions.length > MAX_ACTIONS
    || !Array.isArray(row.lastRuns)
    || row.lastRuns.length > 5) {
    return null;
  }
  const conditions = row.conditions.map(parseCondition);
  if (conditions.some((condition) => condition === null)) return null;
  const actions = row.actions.map(parseAction);
  if (actions.some((action) => action === null)) return null;
  const lastRuns = row.lastRuns.map(parseRun);
  if (lastRuns.some((run) => run === null)) return null;
  return {
    actions: actions as RuleActionView[],
    conditions: conditions as RuleConditionView[],
    createdAt: row.createdAt,
    enabled: row.enabled,
    id: row.id,
    lastRuns: lastRuns as RuleRunView[],
    lastTriggeredAt: row.lastTriggeredAt,
    name: row.name,
    triggerType: row.triggerType as RuleTriggerType,
    updatedAt: row.updatedAt,
    version: row.version as number,
  };
}

/** Parse only the public projection; anything malformed is dropped, never surfaced raw. */
export function parseAutomationRules(payload: unknown): RuleView[] {
  const root = recordOf(payload);
  if (root === null || !Array.isArray(root.rules)) return [];
  return root.rules.map(parseRule).filter((rule): rule is RuleView => rule !== null);
}

/** Rule mutations require the same role as other automation mutations. */
export function canManageRules(role: ShopRole | undefined): boolean {
  return role === "owner" || role === "manager";
}

export function ruleTriggerLabel(triggerType: RuleTriggerType, locale?: unknown): string {
  const t = createDashboardTranslator(resolvePresentationLocale(locale));
  return t(`dashboard.automation.rules.trigger.${triggerType.replace(".", "_")}`);
}

export function ruleActionLabel(actionType: RuleActionType, locale?: unknown): string {
  const t = createDashboardTranslator(resolvePresentationLocale(locale));
  return t(`dashboard.automation.rules.action.${actionType.replace("rule_", "")}`);
}

export function ruleOperatorLabel(operator: RuleConditionOperator, locale?: unknown): string {
  const t = createDashboardTranslator(resolvePresentationLocale(locale));
  return t(`dashboard.automation.rules.operator.${operator}`);
}

export function ruleStatusLabel(enabled: boolean, locale?: unknown): string {
  const t = createDashboardTranslator(resolvePresentationLocale(locale));
  return t(enabled ? "dashboard.automation.rules.status.enabled" : "dashboard.automation.rules.status.disabled");
}

export function rulesErrorMessage(code: string, locale?: unknown): string {
  const t = createDashboardTranslator(resolvePresentationLocale(locale));
  const keys: Readonly<Record<string, string>> = {
    automation_rule_limit_reached: "dashboard.automation.rules.client.quota_exceeded",
    automation_rule_not_found: "dashboard.automation.rules.client.not_found",
    automation_version_conflict: "dashboard.automation.rules.client.version_conflict",
    idempotency_conflict: "dashboard.automation.rules.client.conflict",
    idempotency_key_invalid: "dashboard.automation.rules.client.validation_failed",
    quota_unavailable: "dashboard.automation.rules.client.quota_unavailable",
    validation_failed: "dashboard.automation.rules.client.validation_failed",
  };
  return t(keys[code] ?? "dashboard.automation.rules.client.generic_error");
}

/** Condition fields allowed per trigger (mirror of `rules/evaluator.ts` allow-list). */
export const RULE_CONDITION_FIELDS_BY_TRIGGER: Readonly<Record<RuleTriggerType, readonly string[]>> = {
  "customer.created": ["customer.id", "customer.locale", "customer.channel"],
  "inventory.low_stock": ["stock.remaining", "stock.threshold", "stock.sku"],
  "order.fulfilled": [
    "order.total_minor",
    "order.currency",
    "order.locale",
    "order.source_channel",
    "order.item_count",
    "order.fulfillment_status",
    "customer.id",
    "customer.locale",
  ],
  "order.paid": [
    "order.total_minor",
    "order.currency",
    "order.locale",
    "order.source_channel",
    "order.item_count",
    "order.fulfillment_status",
    "customer.id",
    "customer.locale",
  ],
  "payment.failed": ["payment.reason", "order.total_minor", "order.currency"],
};
