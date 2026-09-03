/**
 * D1 repository for automation rules. Every query is scoped by `shop_id`
 * (tenant isolation); the natural-key dedup on action runs keeps replayed
 * dispatch attempts from creating duplicate rows.
 */
import { parseConditions } from "./evaluator";
import type {
  AutomationRule,
  RuleAction,
  RuleActionRun,
  RuleActionRunView,
  RuleActionType,
  RuleEventPayload,
  RuleTriggerType,
} from "./types";
import { RULE_ACTION_TYPES, RULE_TRIGGER_TYPES } from "./types";

const MAX_LIST_LIMIT = 100;
const MAX_ENABLED_BY_TRIGGER = 50;

type RuleRow = {
  id: string;
  shop_id: string;
  name: string;
  trigger_type: string;
  conditions_json: string;
  actions_json: string;
  enabled: number;
  version: number;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
};

type RunRow = {
  id: string;
  shop_id: string;
  rule_id: string;
  rule_version: number;
  trigger_type: string;
  action_index: number;
  action_type: string;
  action_config_json: string;
  event_payload_json: string;
  aggregate_reference: string;
  task_id: string | null;
  created_at: string;
};

type RunViewRow = {
  action_index: number;
  action_type: string;
  task_status: string | null;
  created_at: string;
};

function parseActions(json: string): readonly RuleAction[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    const actions: RuleAction[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const draft = item as Record<string, unknown>;
      if (typeof draft.type !== "string" || !(RULE_ACTION_TYPES as readonly string[]).includes(draft.type)) continue;
      const config = typeof draft.config === "object" && draft.config !== null && !Array.isArray(draft.config)
        ? (draft.config as Record<string, unknown>)
        : {};
      actions.push({ type: draft.type as RuleActionType, config });
    }
    return actions;
  } catch {
    return [];
  }
}

function parsePayload(json: string): RuleEventPayload {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const payload: Record<string, boolean | number | string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        payload[key] = value;
      }
    }
    return payload;
  } catch {
    return {};
  }
}

function parseConfig(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isTriggerType(value: string): value is RuleTriggerType {
  return (RULE_TRIGGER_TYPES as readonly string[]).includes(value);
}

function isActionType(value: string): value is RuleActionType {
  return (RULE_ACTION_TYPES as readonly string[]).includes(value);
}

function mapRule(row: RuleRow): AutomationRule {
  return {
    id: row.id,
    shopId: row.shop_id,
    name: row.name,
    triggerType: isTriggerType(row.trigger_type) ? row.trigger_type : "order.paid",
    conditions: parseConditions(row.conditions_json) ?? [],
    actions: parseActions(row.actions_json),
    enabled: row.enabled === 1,
    version: row.version,
    lastTriggeredAt: row.last_triggered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

function mapRun(row: RunRow): RuleActionRun {
  return {
    id: row.id,
    shopId: row.shop_id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    triggerType: isTriggerType(row.trigger_type) ? row.trigger_type : "order.paid",
    actionIndex: row.action_index,
    actionType: isActionType(row.action_type) ? row.action_type : "rule_create_task",
    actionConfig: parseConfig(row.action_config_json),
    eventPayload: parsePayload(row.event_payload_json),
    aggregateReference: row.aggregate_reference,
    taskId: row.task_id,
    createdAt: row.created_at,
  };
}

const RULE_COLUMNS = `
  id, shop_id, name, trigger_type, conditions_json, actions_json, enabled,
  version, last_triggered_at, created_at, updated_at, created_by, updated_by
`;

export type AutomationRuleRepository = {
  list(input: { enabled?: boolean; limit: number; shopId: string; triggerType?: RuleTriggerType }): Promise<AutomationRule[]>;
  listEnabledByTrigger(input: { shopId: string; triggerType: RuleTriggerType }): Promise<AutomationRule[]>;
  get(input: { ruleId: string; shopId: string }): Promise<AutomationRule | null>;
  count(input: { shopId: string }): Promise<number>;
  create(input: {
    rule: AutomationRule;
    createIdempotencyKeyHash: string;
    createRequestHash: string;
  }): Promise<{ created: boolean }>;
  findByCreateIdempotency(input: { createIdempotencyKeyHash: string; shopId: string }): Promise<AutomationRule | null>;
  update(input: {
    expectedVersion: number;
    patch: {
      name?: string;
      triggerType?: RuleTriggerType;
      conditionsJson?: string;
      actionsJson?: string;
      enabled?: boolean;
    };
    now: string;
    ruleId: string;
    shopId: string;
    updatedBy: string;
  }): Promise<AutomationRule | null>;
  exists(input: { ruleId: string; shopId: string }): Promise<boolean>;
  delete(input: { expectedVersion: number; ruleId: string; shopId: string }): Promise<boolean>;
  markTriggered(input: { now: string; ruleId: string; shopId: string }): Promise<void>;
  insertRun(input: { run: RuleActionRun }): Promise<boolean>;
  getRun(input: { runId: string; shopId: string }): Promise<RuleActionRun | null>;
  linkTask(input: { runId: string; shopId: string; taskId: string }): Promise<void>;
  listRecentRuns(input: { limit: number; ruleId: string; shopId: string }): Promise<RuleActionRunView[]>;
};

export function createD1AutomationRuleRepository(database: D1Database): AutomationRuleRepository {
  async function fetchRule(ruleId: string, shopId: string): Promise<AutomationRule | null> {
    const result = await database
      .prepare(`SELECT ${RULE_COLUMNS} FROM automation_rules WHERE id = ? AND shop_id = ? LIMIT 1`)
      .bind(ruleId, shopId)
      .all<RuleRow>();
    const row = result.results[0];
    return row === undefined ? null : mapRule(row);
  }

  return {
    async list(input) {
      const limit = Math.min(Math.max(input.limit, 1), MAX_LIST_LIMIT);
      const clauses: string[] = ["shop_id = ?"];
      const values: (number | string)[] = [input.shopId];
      if (input.triggerType !== undefined) {
        clauses.push("trigger_type = ?");
        values.push(input.triggerType);
      }
      if (input.enabled !== undefined) {
        clauses.push("enabled = ?");
        values.push(input.enabled ? 1 : 0);
      }
      const result = await database
        .prepare(
          `SELECT ${RULE_COLUMNS} FROM automation_rules WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .bind(...values, limit)
        .all<RuleRow>();
      return result.results.map(mapRule);
    },

    async listEnabledByTrigger(input) {
      // Sole query on idx_automation_rules_shop_trigger_enabled; hard-capped.
      const result = await database
        .prepare(
          `SELECT ${RULE_COLUMNS} FROM automation_rules
           WHERE shop_id = ? AND trigger_type = ? AND enabled = 1
           ORDER BY id LIMIT ?`,
        )
        .bind(input.shopId, input.triggerType, MAX_ENABLED_BY_TRIGGER)
        .all<RuleRow>();
      return result.results.map(mapRule);
    },

    get: (input) => fetchRule(input.ruleId, input.shopId),

    async count(input) {
      const result = await database
        .prepare("SELECT COUNT(*) AS total FROM automation_rules WHERE shop_id = ?")
        .bind(input.shopId)
        .first<{ total: number }>();
      return result?.total ?? 0;
    },

    async create(input) {
      const rule = input.rule;
      const result = await database
        .prepare(
          `INSERT INTO automation_rules (
            id, shop_id, name, trigger_type, conditions_json, actions_json,
            enabled, version, create_idempotency_key_hash, create_request_hash,
            created_by, updated_by, last_triggered_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
        )
        .bind(
          rule.id,
          rule.shopId,
          rule.name,
          rule.triggerType,
          JSON.stringify(rule.conditions),
          JSON.stringify(rule.actions),
          rule.enabled ? 1 : 0,
          rule.version,
          input.createIdempotencyKeyHash,
          input.createRequestHash,
          rule.createdBy,
          rule.updatedBy,
          rule.lastTriggeredAt,
          rule.createdAt,
          rule.updatedAt,
        )
        .run();
      return { created: result.meta.changes === 1 };
    },

    async findByCreateIdempotency(input) {
      const result = await database
        .prepare(
          `SELECT ${RULE_COLUMNS} FROM automation_rules
           WHERE shop_id = ? AND create_idempotency_key_hash = ? LIMIT 1`,
        )
        .bind(input.shopId, input.createIdempotencyKeyHash)
        .all<RuleRow>();
      const row = result.results[0];
      return row === undefined ? null : mapRule(row);
    },

    async update(input) {
      const sets: string[] = ["version = version + 1", "updated_at = ?", "updated_by = ?"];
      const values: (number | string)[] = [input.now, input.updatedBy];
      if (input.patch.name !== undefined) {
        sets.push("name = ?");
        values.push(input.patch.name);
      }
      if (input.patch.triggerType !== undefined) {
        sets.push("trigger_type = ?");
        values.push(input.patch.triggerType);
      }
      if (input.patch.conditionsJson !== undefined) {
        sets.push("conditions_json = ?");
        values.push(input.patch.conditionsJson);
      }
      if (input.patch.actionsJson !== undefined) {
        sets.push("actions_json = ?");
        values.push(input.patch.actionsJson);
      }
      if (input.patch.enabled !== undefined) {
        sets.push("enabled = ?");
        values.push(input.patch.enabled ? 1 : 0);
      }
      const result = await database
        .prepare(
          `UPDATE automation_rules SET ${sets.join(", ")}
           WHERE id = ? AND shop_id = ? AND version = ?`,
        )
        .bind(...values, input.ruleId, input.shopId, input.expectedVersion)
        .run();
      if (result.meta.changes !== 1) return null;
      return fetchRule(input.ruleId, input.shopId);
    },

    async exists(input) {
      const result = await database
        .prepare("SELECT 1 AS found FROM automation_rules WHERE id = ? AND shop_id = ? LIMIT 1")
        .bind(input.ruleId, input.shopId)
        .first<{ found: number }>();
      return result !== null;
    },

    async delete(input) {
      const result = await database
        .prepare("DELETE FROM automation_rules WHERE id = ? AND shop_id = ? AND version = ?")
        .bind(input.ruleId, input.shopId, input.expectedVersion)
        .run();
      return result.meta.changes === 1;
    },

    async markTriggered(input) {
      await database
        .prepare("UPDATE automation_rules SET last_triggered_at = ? WHERE id = ? AND shop_id = ?")
        .bind(input.now, input.ruleId, input.shopId)
        .run();
    },

    async insertRun(input) {
      const run = input.run;
      const result = await database
        .prepare(
          `INSERT OR IGNORE INTO automation_rule_action_runs (
            id, shop_id, rule_id, rule_version, trigger_type, action_index,
            action_type, action_config_json, event_payload_json,
            aggregate_reference, task_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          run.id,
          run.shopId,
          run.ruleId,
          run.ruleVersion,
          run.triggerType,
          run.actionIndex,
          run.actionType,
          JSON.stringify(run.actionConfig),
          JSON.stringify(run.eventPayload),
          run.aggregateReference,
          run.taskId,
          run.createdAt,
        )
        .run();
      return result.meta.changes === 1;
    },

    async getRun(input) {
      const result = await database
        .prepare(
          `SELECT id, shop_id, rule_id, rule_version, trigger_type, action_index,
            action_type, action_config_json, event_payload_json,
            aggregate_reference, task_id, created_at
           FROM automation_rule_action_runs WHERE id = ? AND shop_id = ? LIMIT 1`,
        )
        .bind(input.runId, input.shopId)
        .all<RunRow>();
      const row = result.results[0];
      return row === undefined ? null : mapRun(row);
    },

    async linkTask(input) {
      await database
        .prepare(
          "UPDATE automation_rule_action_runs SET task_id = ? WHERE id = ? AND shop_id = ?",
        )
        .bind(input.taskId, input.runId, input.shopId)
        .run();
    },

    async listRecentRuns(input) {
      const limit = Math.min(Math.max(input.limit, 1), MAX_LIST_LIMIT);
      const result = await database
        .prepare(
          `SELECT r.action_index, r.action_type, t.status AS task_status, r.created_at
           FROM automation_rule_action_runs AS r
           LEFT JOIN automation_tasks AS t
             ON t.id = r.task_id AND t.shop_id = r.shop_id
           WHERE r.shop_id = ? AND r.rule_id = ?
           ORDER BY r.created_at DESC, r.id DESC
           LIMIT ?`,
        )
        .bind(input.shopId, input.ruleId, limit)
        .all<RunViewRow>();
      return result.results.map((row) => ({
        actionIndex: row.action_index,
        actionType: isActionType(row.action_type) ? row.action_type : "rule_create_task",
        taskStatus: row.task_status,
        createdAt: row.created_at,
      }));
    },
  };
}
