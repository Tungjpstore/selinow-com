/**
 * Fail-safe condition evaluator for automation rules.
 *
 * Conditions are AND-combined. Any malformed input (missing field, wrong
 * value type, unknown operator, broken JSON) evaluates to `false` instead of
 * throwing, so a broken rule can never take down the commerce event path.
 */
import { AppError } from "../../core/errors";
import type { RuleCondition, RuleConditionOperator, RuleEventPayload, RuleTriggerType } from "./types";
import { RULE_CONDITION_OPERATORS } from "./types";

/**
 * Allow-list of payload fields per trigger. Derived from the event projection
 * the dispatcher builds from Selinow-owned D1 data only.
 */
export const RULE_CONDITION_FIELDS: Record<RuleTriggerType, readonly string[]> = {
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
  "payment.failed": ["payment.reason", "order.total_minor", "order.currency"],
  "inventory.low_stock": ["stock.remaining", "stock.threshold", "stock.sku"],
  "customer.created": ["customer.id", "customer.locale", "customer.channel"],
};

/** Triggers whose payload carries `customer.id` (needed by telegram/tag actions). */
export const CUSTOMER_AWARE_TRIGGER_TYPES: readonly RuleTriggerType[] = [
  "order.paid",
  "order.fulfilled",
  "customer.created",
];

const NUMERIC_OPERATORS = new Set(["gt", "gte", "lt", "lte"]);
const STRING_OPERATORS = new Set(["contains", "not_contains", "starts_with"]);
const MAX_IN_LIST_LENGTH = 20;
const MAX_IN_ITEM_LENGTH = 200;
const MAX_FIELD_LENGTH = 64;
const MAX_STRING_VALUE_LENGTH = 500;

function isOperator(value: unknown): value is RuleConditionOperator {
  return typeof value === "string" && (RULE_CONDITION_OPERATORS as readonly string[]).includes(value);
}

function isScalar(value: unknown): value is boolean | number | string {
  return typeof value === "boolean" || typeof value === "number" || typeof value === "string";
}

function validateConditionValue(operator: RuleConditionOperator, value: unknown, issuePrefix: string): void {
  if (NUMERIC_OPERATORS.has(operator)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new AppError("validation_failed", 400, [`${issuePrefix}_value_number_required`]);
    }
    return;
  }
  if (STRING_OPERATORS.has(operator)) {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING_VALUE_LENGTH) {
      throw new AppError("validation_failed", 400, [`${issuePrefix}_value_string_required`]);
    }
    return;
  }
  if (operator === "in") {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_IN_LIST_LENGTH) {
      throw new AppError("validation_failed", 400, [`${issuePrefix}_value_list_required`]);
    }
    for (const item of value) {
      if (typeof item !== "string" || item.length === 0 || item.length > MAX_IN_ITEM_LENGTH) {
        throw new AppError("validation_failed", 400, [`${issuePrefix}_value_list_item_invalid`]);
      }
    }
    return;
  }
  // eq / ne: scalar only.
  if (!isScalar(value) || (typeof value === "number" && !Number.isFinite(value))) {
    throw new AppError("validation_failed", 400, [`${issuePrefix}_value_scalar_required`]);
  }
  if (typeof value === "string" && (value.length === 0 || value.length > MAX_STRING_VALUE_LENGTH)) {
    throw new AppError("validation_failed", 400, [`${issuePrefix}_value_string_invalid`]);
  }
}

/**
 * Validates a condition draft before persisting a rule. Throws
 * `AppError("validation_failed", 400, [...])` on any problem.
 */
export function validateConditionDraft(triggerType: RuleTriggerType, condition: unknown): RuleCondition {
  if (typeof condition !== "object" || condition === null || Array.isArray(condition)) {
    throw new AppError("validation_failed", 400, ["condition_object_required"]);
  }
  const draft = condition as Record<string, unknown>;
  const keys = Object.keys(draft);
  for (const key of keys) {
    if (key !== "field" && key !== "operator" && key !== "value") {
      throw new AppError("validation_failed", 400, [`unknown_field:${key}`]);
    }
  }
  const field = draft.field;
  if (typeof field !== "string" || field.length === 0 || field.length > MAX_FIELD_LENGTH) {
    throw new AppError("validation_failed", 400, ["condition_field_invalid"]);
  }
  if (!RULE_CONDITION_FIELDS[triggerType].includes(field)) {
    throw new AppError("validation_failed", 400, ["condition_field_not_allowed"]);
  }
  const operator = draft.operator;
  if (!isOperator(operator)) {
    throw new AppError("validation_failed", 400, ["condition_operator_invalid"]);
  }
  validateConditionValue(operator, draft.value, "condition");
  return { field, operator, value: draft.value as RuleCondition["value"] };
}

/**
 * Parses stored `conditions_json`. Broken JSON, non-arrays, or invalid items
 * all return `null` (caller treats the rule as having no valid conditions).
 */
export function parseConditions(json: string): RuleCondition[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const conditions: RuleCondition[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return null;
    const draft = item as Record<string, unknown>;
    if (!isOperator(draft.operator)) return null;
    if (typeof draft.field !== "string" || draft.field.length === 0) return null;
    if (!isScalar(draft.value) && !Array.isArray(draft.value)) return null;
    conditions.push({
      field: draft.field,
      operator: draft.operator,
      value: draft.value as RuleCondition["value"],
    });
  }
  return conditions;
}

function evaluateCondition(condition: RuleCondition, payload: RuleEventPayload): boolean {
  // Unknown operators must fail closed; the eq/ne fall-through below would
  // otherwise treat them as `ne` and silently match.
  if (!isOperator(condition.operator)) return false;
  const actual = payload[condition.field];
  if (actual === undefined) return false;
  const { operator, value } = condition;

  if (NUMERIC_OPERATORS.has(operator)) {
    if (typeof actual !== "number" || typeof value !== "number") return false;
    if (operator === "gt") return actual > value;
    if (operator === "gte") return actual >= value;
    if (operator === "lt") return actual < value;
    return actual <= value;
  }

  if (STRING_OPERATORS.has(operator)) {
    if (typeof actual !== "string" || typeof value !== "string") return false;
    const haystack = actual.toLowerCase();
    const needle = value.toLowerCase();
    if (operator === "contains") return haystack.includes(needle);
    if (operator === "not_contains") return !haystack.includes(needle);
    return haystack.startsWith(needle);
  }

  if (operator === "in") {
    if (!Array.isArray(value) || !isScalar(actual)) return false;
    return value.includes(actual);
  }

  // eq / ne: strict comparison with matching types.
  if (typeof actual !== typeof value) return false;
  if (operator === "eq") return actual === value;
  return actual !== value;
}

/** AND-combined evaluation. `[]` matches everything. */
export function evaluateConditions(conditions: readonly RuleCondition[], payload: RuleEventPayload): boolean {
  for (const condition of conditions) {
    if (!evaluateCondition(condition, payload)) return false;
  }
  return true;
}

/** Try/catch wrapper: any unexpected error evaluates to `false`. */
export function safeEvaluate(conditions: readonly RuleCondition[], payload: RuleEventPayload): boolean {
  try {
    return evaluateConditions(conditions, payload);
  } catch {
    return false;
  }
}
