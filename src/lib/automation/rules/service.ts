/**
 * CRUD service for seller automation rules, backing the rules API routes.
 *
 * Rules are definitions only; execution always flows through the existing
 * automation task engine. Mutations require `automation:manage`
 * (owner/manager) plus CSRF + recent auth enforced by the API routes.
 */
import { hmacToken } from "../../core/crypto";
import { AppError } from "../../core/errors";
import { createId } from "../../core/ids";
import type { AppBindings } from "../../platform/bindings";
import { getShopForMember } from "../../tenants/store";
import { CUSTOMER_AWARE_TRIGGER_TYPES, validateConditionDraft } from "./evaluator";
import { createD1AutomationRuleRepository } from "./repository";
import type { AutomationRuleRepository } from "./repository";
import type {
  AutomationRule,
  PublicAutomationRule,
  RuleAction,
  RuleActionType,
  RuleCondition,
  RuleTriggerType,
} from "./types";
import { RULE_ACTION_TYPES, RULE_TRIGGER_TYPES } from "./types";
import { assertSafeWebhookUrl } from "./webhook-guard";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;
const RULE_TAG = /^[A-Za-z0-9 ._-]{1,40}$/u;
const MAX_CONDITIONS = 10;
const MAX_ACTIONS = 10;
const MAX_NAME_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_NOTE_LENGTH = 500;
const MAX_CONDITIONS_JSON = 8192;
const MAX_ACTIONS_JSON = 16_384;
const LAST_RUNS_PER_RULE = 5;
const encoder = new TextEncoder();

export type RuleDraft = Record<string, unknown>;

async function sha256TextHex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Json(value: unknown): Promise<string> {
  return sha256TextHex(JSON.stringify(value));
}

function validationError(issue: string): AppError {
  return new AppError("validation_failed", 400, [issue]);
}

function requireExpectedVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AppError("automation_expected_version_invalid", 400);
  }
  return value as number;
}

function parseTriggerType(value: unknown): RuleTriggerType {
  if (typeof value !== "string" || !(RULE_TRIGGER_TYPES as readonly string[]).includes(value)) {
    throw validationError("trigger_type_invalid");
  }
  return value as RuleTriggerType;
}

function parseConditionsDraft(triggerType: RuleTriggerType, value: unknown): RuleCondition[] {
  if (!Array.isArray(value)) throw validationError("conditions_array_required");
  if (value.length > MAX_CONDITIONS) throw validationError("conditions_limit_exceeded");
  return value.map((item) => validateConditionDraft(triggerType, item));
}

function validateActionConfig(triggerType: RuleTriggerType, type: RuleActionType, config: unknown): Record<string, unknown> {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw validationError("action_config_object_required");
  }
  const record = config as Record<string, unknown>;
  if (type === "rule_notify_telegram") {
    if (Object.keys(record).some((key) => key !== "message")) throw validationError("action_config_unknown_field");
    const message = record.message;
    if (typeof message !== "string" || message.trim().length === 0 || message.length > MAX_MESSAGE_LENGTH) {
      throw validationError("action_message_invalid");
    }
    if (!CUSTOMER_AWARE_TRIGGER_TYPES.includes(triggerType)) throw validationError("action_requires_customer_trigger");
    return { message };
  }
  if (type === "rule_call_webhook") {
    if (Object.keys(record).some((key) => key !== "url")) throw validationError("action_config_unknown_field");
    return { url: assertSafeWebhookUrl(record.url) };
  }
  if (type === "rule_tag_customer") {
    if (Object.keys(record).some((key) => key !== "tag")) throw validationError("action_config_unknown_field");
    const tag = record.tag;
    if (typeof tag !== "string" || !RULE_TAG.test(tag)) throw validationError("action_tag_invalid");
    if (!CUSTOMER_AWARE_TRIGGER_TYPES.includes(triggerType)) throw validationError("action_requires_customer_trigger");
    return { tag };
  }
  // rule_create_task: optional note only.
  if (Object.keys(record).some((key) => key !== "note")) throw validationError("action_config_unknown_field");
  const note = record.note;
  if (note !== undefined && (typeof note !== "string" || note.length > MAX_NOTE_LENGTH)) {
    throw validationError("action_note_invalid");
  }
  return note === undefined ? {} : { note };
}

function parseActionsDraft(triggerType: RuleTriggerType, value: unknown): RuleAction[] {
  if (!Array.isArray(value) || value.length === 0) throw validationError("actions_array_required");
  if (value.length > MAX_ACTIONS) throw validationError("actions_limit_exceeded");
  return value.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw validationError("action_object_required");
    }
    const draft = item as Record<string, unknown>;
    if (Object.keys(draft).some((key) => key !== "type" && key !== "config")) {
      throw validationError("action_unknown_field");
    }
    if (typeof draft.type !== "string" || !(RULE_ACTION_TYPES as readonly string[]).includes(draft.type)) {
      throw validationError("action_type_invalid");
    }
    return { type: draft.type as RuleActionType, config: validateActionConfig(triggerType, draft.type as RuleActionType, draft.config) };
  });
}

export type ValidatedRuleDraft = {
  actions: RuleAction[];
  conditions: RuleCondition[];
  enabled: boolean;
  name: string;
  triggerType: RuleTriggerType;
};

export function validateRuleDraft(draft: RuleDraft): ValidatedRuleDraft {
  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) throw validationError("rule_name_invalid");
  const triggerType = parseTriggerType(draft.triggerType);
  const conditions = parseConditionsDraft(triggerType, draft.conditions);
  const actions = parseActionsDraft(triggerType, draft.actions);
  const enabled = draft.enabled === undefined ? true : draft.enabled;
  if (typeof enabled !== "boolean") throw validationError("rule_enabled_invalid");
  if (JSON.stringify(conditions).length > MAX_CONDITIONS_JSON || JSON.stringify(actions).length > MAX_ACTIONS_JSON) {
    throw validationError("rule_payload_too_large");
  }
  return { actions, conditions, enabled, name, triggerType };
}

function planLimit(limits: Record<string, unknown>, metric: string): number | null {
  const value = limits[metric];
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new AppError("quota_unavailable", 503);
  return value as number;
}

async function publicRule(repository: AutomationRuleRepository, rule: AutomationRule): Promise<PublicAutomationRule> {
  const lastRuns = await repository.listRecentRuns({ limit: LAST_RUNS_PER_RULE, ruleId: rule.id, shopId: rule.shopId });
  return {
    id: rule.id,
    name: rule.name,
    triggerType: rule.triggerType,
    conditions: rule.conditions,
    actions: rule.actions,
    enabled: rule.enabled,
    version: rule.version,
    lastTriggeredAt: rule.lastTriggeredAt,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
    createdBy: rule.createdBy,
    updatedBy: rule.updatedBy,
    lastRuns,
  };
}

async function insertRuleAudit(input: {
  action: string;
  env: AppBindings;
  metadata: Readonly<Record<string, boolean | number | string>>;
  now: Date;
  requestId: string;
  ruleId: string;
  shopId: string;
  userId: string;
}): Promise<void> {
  await input.env.PLATFORM_DB.prepare(`
    INSERT OR IGNORE INTO audit_logs (
      id, shop_id, actor_type, actor_id, action, resource_type,
      resource_id, safe_metadata_json, request_id, created_at
    ) VALUES (?, ?, 'user', ?, ?, 'automation_rule', ?, ?, ?, ?)
  `).bind(
    createId("aud"),
    input.shopId,
    input.userId,
    input.action,
    input.ruleId,
    JSON.stringify(input.metadata),
    input.requestId,
    input.now.toISOString(),
  ).run();
}

export async function listAutomationRules(input: {
  enabled?: boolean;
  env: AppBindings;
  limit?: number;
  shopPublicId: string;
  triggerType?: RuleTriggerType;
  userId: string;
}): Promise<{ rules: PublicAutomationRule[] }> {
  const member = await getShopForMember({ capability: "automation:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const repository = createD1AutomationRuleRepository(input.env.PLATFORM_DB);
  const rules = await repository.list({
    limit: input.limit ?? 50,
    shopId: member.row.shop_id,
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.triggerType === undefined ? {} : { triggerType: input.triggerType }),
  });
  return { rules: await Promise.all(rules.map((rule) => publicRule(repository, rule))) };
}

export async function getAutomationRule(input: {
  env: AppBindings;
  ruleId: string;
  shopPublicId: string;
  userId: string;
}): Promise<{ rule: PublicAutomationRule }> {
  const member = await getShopForMember({ capability: "automation:read", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const repository = createD1AutomationRuleRepository(input.env.PLATFORM_DB);
  const rule = await repository.get({ ruleId: input.ruleId, shopId: member.row.shop_id });
  // Cross-tenant lookups always 404: never reveal existence to other shops.
  if (rule === null) throw new AppError("automation_rule_not_found", 404);
  return { rule: await publicRule(repository, rule) };
}

export async function createAutomationRule(input: {
  body: RuleDraft;
  env: AppBindings;
  idempotencyKey: string | null;
  requestId: string;
  shopPublicId: string;
  userId: string;
}): Promise<{ replayed: boolean; rule: PublicAutomationRule }> {
  if (input.idempotencyKey === null || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw validationError("idempotency_key_invalid");
  }
  const member = await getShopForMember({ capability: "automation:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const shopId = member.row.shop_id;
  const repository = createD1AutomationRuleRepository(input.env.PLATFORM_DB);
  const limit = planLimit(member.shop.limits, "automation_rules");
  if (limit === null) throw new AppError("quota_unavailable", 503);
  const existingCount = await repository.count({ shopId });
  if (existingCount >= limit) throw new AppError("automation_rule_limit_reached", 429);
  const draft = validateRuleDraft(input.body);
  const now = new Date();
  const createIdempotencyKeyHash = await sha256TextHex(await hmacToken(
    input.env.SESSION_SECRET,
    "automation-rule-create-idempotency-v1",
    JSON.stringify({ idempotencyKey: input.idempotencyKey, shopId }),
  ));
  const createRequestHash = await sha256Json({
    actions: draft.actions,
    conditions: draft.conditions,
    name: draft.name,
    shopId,
    triggerType: draft.triggerType,
  });
  const replayed = await repository.findByCreateIdempotency({ createIdempotencyKeyHash, shopId });
  if (replayed !== null) {
    // The rule projection does not carry the stored request hash; re-read it.
    const storedHash = await readCreateRequestHash(input.env.PLATFORM_DB, replayed.id, shopId);
    if (storedHash !== createRequestHash) throw new AppError("idempotency_conflict", 409);
    return { replayed: true, rule: await publicRule(repository, replayed) };
  }
  const rule: AutomationRule = {
    id: createId("rule"),
    shopId,
    name: draft.name,
    triggerType: draft.triggerType,
    conditions: draft.conditions,
    actions: draft.actions,
    enabled: draft.enabled,
    version: 1,
    lastTriggeredAt: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    createdBy: input.userId,
    updatedBy: input.userId,
  };
  const created = await repository.create({ rule, createIdempotencyKeyHash, createRequestHash });
  if (!created.created) {
    // Primary-key race: another request won; replay through the idempotency index.
    const raced = await repository.findByCreateIdempotency({ createIdempotencyKeyHash, shopId });
    if (raced === null) throw new AppError("automation_rule_create_failed", 500);
    const storedHash = await readCreateRequestHash(input.env.PLATFORM_DB, raced.id, shopId);
    if (storedHash !== createRequestHash) throw new AppError("idempotency_conflict", 409);
    return { replayed: true, rule: await publicRule(repository, raced) };
  }
  await insertRuleAudit({
    action: "automation.rule_created",
    env: input.env,
    metadata: { enabled: draft.enabled ? 1 : 0, triggerType: draft.triggerType, version: 1 },
    now,
    requestId: input.requestId,
    ruleId: rule.id,
    shopId,
    userId: input.userId,
  });
  return { replayed: false, rule: await publicRule(repository, rule) };
}

async function readCreateRequestHash(database: D1Database, ruleId: string, shopId: string): Promise<string> {
  const row = await database
    .prepare("SELECT create_request_hash AS hash FROM automation_rules WHERE id = ? AND shop_id = ? LIMIT 1")
    .bind(ruleId, shopId)
    .first<{ hash: string }>();
  return row?.hash ?? "";
}

async function loadOwnedRule(input: {
  env: AppBindings;
  ruleId: string;
  shopId: string;
}): Promise<AutomationRule> {
  const repository = createD1AutomationRuleRepository(input.env.PLATFORM_DB);
  const rule = await repository.get({ ruleId: input.ruleId, shopId: input.shopId });
  if (rule === null) throw new AppError("automation_rule_not_found", 404);
  return rule;
}

export async function updateAutomationRule(input: {
  body: Record<string, unknown>;
  env: AppBindings;
  expectedVersion: unknown;
  requestId: string;
  ruleId: string;
  shopPublicId: string;
  userId: string;
}): Promise<{ rule: PublicAutomationRule }> {
  const expectedVersion = requireExpectedVersion(input.expectedVersion);
  const member = await getShopForMember({ capability: "automation:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const shopId = member.row.shop_id;
  const repository = createD1AutomationRuleRepository(input.env.PLATFORM_DB);
  const existing = await loadOwnedRule({ env: input.env, ruleId: input.ruleId, shopId });

  const hasName = input.body.name !== undefined;
  const hasTrigger = input.body.triggerType !== undefined;
  const hasConditions = input.body.conditions !== undefined;
  const hasActions = input.body.actions !== undefined;
  if (!hasName && !hasTrigger && !hasConditions && !hasActions) throw validationError("rule_patch_empty");

  const triggerType = hasTrigger ? parseTriggerType(input.body.triggerType) : existing.triggerType;
  const triggerChanged = triggerType !== existing.triggerType;
  // Re-validate whatever is kept from the existing rule under the NEW trigger:
  // silently keeping legacy conditions/actions would produce a rule the create
  // path would have rejected (e.g. a customer-aware action on a trigger with
  // no customer payload) — it would then never match at runtime.
  const conditions = hasConditions
    ? parseConditionsDraft(triggerType, input.body.conditions)
    : triggerChanged
      ? parseConditionsDraft(triggerType, existing.conditions)
      : [...existing.conditions];
  const actions = hasActions
    ? parseActionsDraft(triggerType, input.body.actions)
    : triggerChanged
      ? parseActionsDraft(triggerType, existing.actions)
      : [...existing.actions];
  let name = existing.name;
  if (hasName) {
    const candidate = typeof input.body.name === "string" ? input.body.name.trim() : "";
    if (candidate.length === 0 || candidate.length > MAX_NAME_LENGTH) throw validationError("rule_name_invalid");
    name = candidate;
  }
  if (JSON.stringify(conditions).length > MAX_CONDITIONS_JSON || JSON.stringify(actions).length > MAX_ACTIONS_JSON) {
    throw validationError("rule_payload_too_large");
  }

  const now = new Date().toISOString();
  const updated = await repository.update({
    expectedVersion,
    patch: {
      name,
      triggerType,
      conditionsJson: JSON.stringify(conditions),
      actionsJson: JSON.stringify(actions),
    },
    now,
    ruleId: input.ruleId,
    shopId,
    updatedBy: input.userId,
  });
  if (updated === null) throw new AppError("automation_version_conflict", 409);
  await insertRuleAudit({
    action: "automation.rule_updated",
    env: input.env,
    metadata: { triggerType: updated.triggerType, version: updated.version },
    now: new Date(now),
    requestId: input.requestId,
    ruleId: updated.id,
    shopId,
    userId: input.userId,
  });
  return { rule: await publicRule(repository, updated) };
}

export async function toggleAutomationRule(input: {
  enabled: unknown;
  env: AppBindings;
  expectedVersion: unknown;
  requestId: string;
  ruleId: string;
  shopPublicId: string;
  userId: string;
}): Promise<{ rule: PublicAutomationRule }> {
  const expectedVersion = requireExpectedVersion(input.expectedVersion);
  if (typeof input.enabled !== "boolean") throw validationError("rule_enabled_invalid");
  const member = await getShopForMember({ capability: "automation:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const shopId = member.row.shop_id;
  const repository = createD1AutomationRuleRepository(input.env.PLATFORM_DB);
  await loadOwnedRule({ env: input.env, ruleId: input.ruleId, shopId });
  const now = new Date().toISOString();
  const updated = await repository.update({
    expectedVersion,
    patch: { enabled: input.enabled },
    now,
    ruleId: input.ruleId,
    shopId,
    updatedBy: input.userId,
  });
  if (updated === null) throw new AppError("automation_version_conflict", 409);
  await insertRuleAudit({
    action: "automation.rule_toggled",
    env: input.env,
    metadata: { enabled: updated.enabled ? 1 : 0, version: updated.version },
    now: new Date(now),
    requestId: input.requestId,
    ruleId: updated.id,
    shopId,
    userId: input.userId,
  });
  return { rule: await publicRule(repository, updated) };
}

export async function deleteAutomationRule(input: {
  env: AppBindings;
  expectedVersion: unknown;
  requestId: string;
  ruleId: string;
  shopPublicId: string;
  userId: string;
}): Promise<void> {
  const expectedVersion = requireExpectedVersion(input.expectedVersion);
  const member = await getShopForMember({ capability: "automation:manage", env: input.env, shopPublicId: input.shopPublicId, userId: input.userId });
  const shopId = member.row.shop_id;
  const repository = createD1AutomationRuleRepository(input.env.PLATFORM_DB);
  const existing = await loadOwnedRule({ env: input.env, ruleId: input.ruleId, shopId });
  const deleted = await repository.delete({ expectedVersion, ruleId: input.ruleId, shopId });
  if (!deleted) throw new AppError("automation_version_conflict", 409);
  await insertRuleAudit({
    action: "automation.rule_deleted",
    env: input.env,
    metadata: { version: existing.version },
    now: new Date(),
    requestId: input.requestId,
    ruleId: input.ruleId,
    shopId,
    userId: input.userId,
  });
}
