/**
 * Seller-defined automation rules ("if this then that").
 *
 * A rule owns only its definition: one trigger + AND-combined conditions +
 * one-or-more actions. Every action still executes through the existing
 * automation_tasks engine (AutomationOrchestrator), so retries, idempotency,
 * optimistic concurrency, and audit linkage are inherited rather than
 * reimplemented.
 */

export const RULE_TRIGGER_TYPES = [
  "order.paid",
  "order.fulfilled",
  "payment.failed",
  "inventory.low_stock",
  "customer.created",
] as const;
export type RuleTriggerType = (typeof RULE_TRIGGER_TYPES)[number];

export const RULE_CONDITION_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "starts_with",
  "in",
] as const;
export type RuleConditionOperator = (typeof RULE_CONDITION_OPERATORS)[number];

export type RuleConditionValue = boolean | number | string | readonly string[];

export type RuleCondition = {
  field: string;
  operator: RuleConditionOperator;
  value: RuleConditionValue;
};

/** 1:1 with registered automation capability codes (and the migration CHECK). */
export const RULE_ACTION_TYPES = [
  "rule_notify_telegram",
  "rule_call_webhook",
  "rule_tag_customer",
  "rule_create_task",
] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];

export type RuleAction = {
  type: RuleActionType;
  config: Record<string, unknown>;
};

export type AutomationRule = {
  id: string;
  shopId: string;
  name: string;
  triggerType: RuleTriggerType;
  conditions: readonly RuleCondition[];
  actions: readonly RuleAction[];
  enabled: boolean;
  version: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
};

/** Flat scalar-only projection of the triggering event; safe to log/store. */
export type RuleEventPayload = Readonly<Record<string, boolean | number | string>>;

export type RuleTriggerEvent = {
  /** ≤128 chars, e.g. `order:{orderId}`, `customer:{customerId}`, `stock:{variantId}:{threshold}`. */
  aggregateReference: string;
  customerId?: string;
  shopId: string;
  triggerType: RuleTriggerType;
  /** The dispatcher reads D1 itself to build the evaluator payload. */
  refs?: { channel?: string; orderId?: string; variantId?: string; reason?: string };
};

export type RuleActionRun = {
  id: string;
  shopId: string;
  ruleId: string;
  ruleVersion: number;
  triggerType: RuleTriggerType;
  actionIndex: number;
  actionType: RuleActionType;
  actionConfig: Record<string, unknown>;
  eventPayload: RuleEventPayload;
  aggregateReference: string;
  taskId: string | null;
  createdAt: string;
};

export type RuleActionRunView = {
  actionIndex: number;
  actionType: RuleActionType;
  taskStatus: string | null;
  createdAt: string;
};

export type PublicAutomationRule = {
  id: string;
  name: string;
  triggerType: RuleTriggerType;
  conditions: readonly RuleCondition[];
  actions: readonly RuleAction[];
  enabled: boolean;
  version: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  lastRuns: readonly RuleActionRunView[];
};
