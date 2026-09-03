import { RULE_CONDITION_OPERATORS, RULE_TRIGGER_TYPES, type RuleConditionOperator, type RuleTriggerType } from "../../lib/automation/rules/types";
import {
  canManageRules,
  parseAutomationRules,
  RULE_CONDITION_FIELDS_BY_TRIGGER,
  ruleActionLabel,
  ruleStatusLabel,
  rulesErrorMessage,
  ruleTriggerLabel,
  type RuleConditionView,
  type RuleView,
} from "../../lib/dashboard/automation-rules-ui";
import { automationStatusLabel, automationStatusTone, formatAutomationTime } from "../../lib/dashboard/automation-ui";
import type { ShopRole } from "../../lib/tenants/policy";

type ApiFailure = { code?: unknown; requestId?: unknown };
type ConfirmDetail = { complete: () => void; fail: () => void };

const MAX_CONDITION_ROWS = 10;

class RulesApiError extends Error {
  readonly code: string;
  readonly requestId: string | null;

  constructor(code: string, requestId: string | null) {
    super(code);
    this.name = "RulesApiError";
    this.code = code;
    this.requestId = requestId;
  }
}

function readCookie(name: string): string | null {
  if (name.length === 0) return null;
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (!value.startsWith(prefix)) continue;
    try {
      return decodeURIComponent(value.slice(prefix.length));
    } catch {
      return null;
    }
  }
  return null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function apiBase(shopPublicId: string): string {
  return `/api/app/shops/${encodeURIComponent(shopPublicId)}/automation/rules`;
}

// Stable per draft session: a retried create after a lost response must reuse
// the same key so the server deduplicates instead of creating a twin rule.
let createIdempotencySalt = crypto.randomUUID();

function idempotencyKey(prefix: string): string {
  return prefix === "rule_create"
    ? `${prefix}_${createIdempotencySalt}`
    : `${prefix}_${crypto.randomUUID()}`;
}

function setFeedback(root: HTMLElement, message: string, tone: "danger" | "info" | "success" = "info"): void {
  const feedback = root.querySelector<HTMLElement>("[data-rules-feedback]");
  if (feedback === null) return;
  feedback.textContent = message;
  feedback.hidden = message.length === 0;
  feedback.dataset.tone = tone;
  feedback.setAttribute("role", tone === "danger" ? "alert" : "status");
}

function copy(root: HTMLElement, key: string, params: Readonly<Record<string, string | number>> = {}): string {
  const template = root.dataset[key] ?? "";
  return template.replace(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu, (placeholder, name: string) => {
    const value = params[name];
    return value === undefined ? placeholder : String(value);
  });
}

function errorMessage(error: unknown, root: HTMLElement): string {
  if (!(error instanceof RulesApiError)) return copy(root, "copyConnectionError");
  const base = rulesErrorMessage(error.code, root.dataset.locale);
  return error.requestId === null ? base : `${base} ${copy(root, "copySupportCode", { requestId: error.requestId })}`;
}

function setBusy(root: HTMLElement, busy: boolean): void {
  root.setAttribute("aria-busy", String(busy));
  for (const control of root.querySelectorAll<HTMLButtonElement>("button")) {
    control.disabled = busy;
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failure: ApiFailure | null = recordOf(payload);
    throw new RulesApiError(
      typeof failure?.code === "string" ? failure.code : `http_${String(response.status)}`,
      typeof failure?.requestId === "string" ? failure.requestId : null,
    );
  }
  return payload;
}

function parseSingleRule(payload: unknown): RuleView | null {
  const row = recordOf(payload);
  const parsed = parseAutomationRules({ rules: row === null ? [] : [row.rule] });
  return parsed.length === 1 ? parsed[0] ?? null : null;
}

async function loadRules(root: HTMLElement, shopPublicId: string): Promise<RuleView[]> {
  const response = await fetch(`${apiBase(shopPublicId)}?limit=50`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const payload = await readResponse(response);
  const rootPayload = recordOf(payload);
  if (rootPayload === null || !Array.isArray(rootPayload.rules)) throw new RulesApiError("rules_projection_invalid", null);
  const rules = parseAutomationRules(payload);
  renderRules(root, rules);
  return rules;
}

function addText(parent: HTMLElement, tag: string, text: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function renderRules(root: HTMLElement, rules: readonly RuleView[]): void {
  const list = root.querySelector<HTMLElement>("[data-rules-list]");
  const count = root.querySelector<HTMLElement>("[data-rules-count]");
  if (list === null) return;
  if (count !== null) count.textContent = copy(root, "copyCount", { count: rules.length });
  list.replaceChildren();
  const locale = root.dataset.locale;
  const timeZone = root.dataset.timeZone;
  const canManage = canManageRules(root.dataset.shopRole as ShopRole | undefined);
  if (rules.length === 0) {
    const empty = document.createElement("div");
    empty.className = "rules-empty";
    empty.dataset.rulesEmpty = "true";
    addText(empty, "strong", copy(root, "copyEmptyTitle"));
    addText(empty, "p", copy(root, "copyEmptyDescription"));
    list.appendChild(empty);
    return;
  }
  for (const rule of rules) {
    const row = document.createElement("article");
    row.className = "rule-row";
    row.dataset.rule = "true";
    row.dataset.ruleId = rule.id;
    row.dataset.ruleVersion = String(rule.version);

    const copyBlock = document.createElement("div");
    copyBlock.className = "rule-row__copy";
    addText(copyBlock, "strong", rule.name);
    addText(copyBlock, "p", [
      ruleTriggerLabel(rule.triggerType, locale),
      copy(root, "copyConditionsCount", { count: rule.conditions.length }),
      copy(root, "copyActionsCount", { count: rule.actions.length }),
    ].join(" · "));
    addText(copyBlock, "small", rule.lastTriggeredAt === null
      ? copy(root, "copyNeverTriggered")
      : copy(root, "copyLastTriggered", { time: formatAutomationTime(rule.lastTriggeredAt, timeZone, locale) }), "rule-row__meta");
    if (rule.lastRuns.length > 0) {
      const runs = document.createElement("span");
      runs.className = "rule-runs";
      for (const run of rule.lastRuns) {
        const chip = document.createElement("span");
        chip.className = "rule-run-chip";
        chip.dataset.tone = run.taskStatus === null ? "neutral" : automationStatusTone(run.taskStatus as never);
        chip.textContent = run.taskStatus === null
          ? ruleActionLabel(run.actionType, locale)
          : `${ruleActionLabel(run.actionType, locale)}: ${automationStatusLabel(run.taskStatus as never, locale)}`;
        runs.appendChild(chip);
      }
      copyBlock.appendChild(runs);
    }
    row.appendChild(copyBlock);

    const status = document.createElement("div");
    status.className = "rule-row__status";
    const badge = document.createElement("span");
    badge.className = "rule-status";
    badge.dataset.tone = rule.enabled ? "success" : "neutral";
    badge.textContent = ruleStatusLabel(rule.enabled, locale);
    status.appendChild(badge);
    row.appendChild(status);

    if (canManage) {
      const actions = document.createElement("div");
      actions.className = "rule-row__actions";
      const edit = document.createElement("button");
      edit.className = "sln-button";
      edit.dataset.rulesAction = "edit";
      edit.dataset.size = "sm";
      edit.dataset.variant = "secondary";
      edit.type = "button";
      edit.textContent = copy(root, "copyEdit");
      actions.appendChild(edit);
      const toggle = document.createElement("button");
      toggle.className = "sln-button";
      toggle.dataset.rulesAction = "toggle";
      toggle.dataset.size = "sm";
      toggle.dataset.variant = "secondary";
      toggle.type = "button";
      toggle.textContent = rule.enabled ? copy(root, "copyToggleOff") : copy(root, "copyToggleOn");
      actions.appendChild(toggle);
      const remove = document.createElement("button");
      remove.className = "sln-button";
      remove.dataset.rulesAction = "delete";
      remove.dataset.size = "sm";
      remove.dataset.variant = "danger";
      remove.type = "button";
      remove.textContent = copy(root, "copyDelete");
      actions.appendChild(remove);
      row.appendChild(actions);
    }
    list.appendChild(row);
  }
}

function conditionValueToString(value: RuleConditionView["value"]): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function parseConditionInput(operator: RuleConditionOperator, raw: string): RuleConditionView["value"] | null {
  const trimmed = raw.trim();
  if (operator === "in") {
    const items = trimmed.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
    return items.length > 0 ? items : null;
  }
  if (trimmed.length === 0) return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?[0-9]+(?:\.[0-9]+)?$/u.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function fieldSelectOptions(select: HTMLSelectElement, triggerType: RuleTriggerType): void {
  const previous = select.value;
  select.replaceChildren();
  for (const field of RULE_CONDITION_FIELDS_BY_TRIGGER[triggerType]) {
    const option = document.createElement("option");
    option.value = field;
    option.textContent = field;
    select.appendChild(option);
  }
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function addConditionRow(form: HTMLFormElement, condition?: RuleConditionView): HTMLElement | null {
  const container = form.querySelector<HTMLElement>("[data-rule-conditions]");
  const prototype = form.querySelector<HTMLElement>("[data-rule-condition-prototype]");
  if (container === null || prototype === null) return null;
  if (container.querySelectorAll("[data-rule-condition-row]").length >= MAX_CONDITION_ROWS) return null;
  const row = prototype.cloneNode(true) as HTMLElement;
  row.hidden = false;
  delete row.dataset.ruleConditionPrototype;
  row.dataset.ruleConditionRow = "true";
  const triggerValue = new FormData(form).get("triggerType");
  const triggerType = RULE_TRIGGER_TYPES.includes(triggerValue as RuleTriggerType) ? triggerValue as RuleTriggerType : "order.paid";
  const field = row.querySelector("select[name=\"conditionField\"]") as HTMLSelectElement | null;
  const operator = row.querySelector("select[name=\"conditionOperator\"]") as HTMLSelectElement | null;
  const value = row.querySelector<HTMLInputElement>("input[name=\"conditionValue\"]");
  if (field !== null) fieldSelectOptions(field, triggerType);
  if (condition !== undefined) {
    if (field !== null && [...field.options].some((option) => option.value === condition.field)) field.value = condition.field;
    if (operator !== null && RULE_CONDITION_OPERATORS.includes(condition.operator)) operator.value = condition.operator;
    if (value !== null) value.value = conditionValueToString(condition.value);
  }
  container.insertBefore(row, prototype);
  return row;
}

function formDataText(data: FormData, key: string): string {
  const value = data.get(key);
  return typeof value === "string" ? value : "";
}

function syncActionConfigVisibility(form: HTMLFormElement): void {
  const actionType = formDataText(new FormData(form), "actionType");
  for (const block of form.querySelectorAll<HTMLElement>("[data-rule-config]")) {
    block.hidden = block.dataset.ruleConfig !== actionType;
  }
}

function wireRuleForm(form: HTMLFormElement): void {
  const trigger = form.querySelector("select[name=\"triggerType\"]") as HTMLSelectElement | null;
  trigger?.addEventListener("change", () => {
    const triggerType = RULE_TRIGGER_TYPES.includes(trigger.value as RuleTriggerType) ? trigger.value as RuleTriggerType : "order.paid";
    for (const select of Array.from(form.querySelectorAll("[data-rule-condition-row] select[name=\"conditionField\"]")).map((element) => element as unknown as HTMLSelectElement)) {
      fieldSelectOptions(select, triggerType);
    }
  });
  const actionType = form.querySelector("select[name=\"actionType\"]") as HTMLSelectElement | null;
  actionType?.addEventListener("change", () => {
    syncActionConfigVisibility(form);
  });
  form.querySelector<HTMLButtonElement>("[data-rule-condition-add]")?.addEventListener("click", () => {
    addConditionRow(form);
  });
  form.addEventListener("click", (event) => {
    const row = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-rule-condition-row]") : null;
    if (row === null || !(event.target instanceof HTMLButtonElement)) return;
    row.remove();
  });
  syncActionConfigVisibility(form);
}

function fillEditForm(root: HTMLElement, rule: RuleView): void {
  const form = root.querySelector<HTMLFormElement>("#rule-edit-form");
  if (form === null) return;
  form.reset();
  const name = form.querySelector<HTMLInputElement>("input[name=\"name\"]");
  const trigger = form.querySelector("select[name=\"triggerType\"]") as HTMLSelectElement | null;
  if (name !== null) name.value = rule.name;
  if (trigger !== null) trigger.value = rule.triggerType;
  for (const row of form.querySelectorAll<HTMLElement>("[data-rule-condition-row]")) row.remove();
  for (const condition of rule.conditions) addConditionRow(form, condition);
  const firstAction = rule.actions[0];
  const actionSelect = form.querySelector("select[name=\"actionType\"]") as HTMLSelectElement | null;
  if (actionSelect !== null && firstAction !== undefined) actionSelect.value = firstAction.type;
  syncActionConfigVisibility(form);
  const config = firstAction?.config ?? {};
  const set = (selector: string, value: unknown): void => {
    const control = form.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (control !== null) control.value = typeof value === "string" ? value : "";
  };
  set("textarea[name=\"actionMessage\"]", firstAction?.type === "rule_notify_telegram" ? config.message : "");
  set("input[name=\"actionUrl\"]", firstAction?.type === "rule_call_webhook" ? config.url : "");
  set("input[name=\"actionTag\"]", firstAction?.type === "rule_tag_customer" ? config.tag : "");
  set("input[name=\"actionNote\"]", firstAction?.type === "rule_create_task" ? config.note : "");
}

type RuleDraft = {
  actions: { config: Record<string, unknown>; type: string }[];
  conditions: { field: string; operator: RuleConditionOperator; value: RuleConditionView["value"] }[];
  name: string;
  triggerType: RuleTriggerType;
};

function collectRuleDraft(form: HTMLFormElement): RuleDraft | null {
  const data = new FormData(form);
  const name = formDataText(data, "name").trim();
  const triggerValue = formDataText(data, "triggerType");
  if (name.length === 0 || name.length > 120) return null;
  if (!RULE_TRIGGER_TYPES.includes(triggerValue as RuleTriggerType)) return null;
  const triggerType = triggerValue as RuleTriggerType;

  const conditions: RuleDraft["conditions"] = [];
  for (const row of form.querySelectorAll<HTMLElement>("[data-rule-condition-row]")) {
    const field = (row.querySelector("select[name=\"conditionField\"]") as HTMLSelectElement | null)?.value ?? "";
    const operatorValue = (row.querySelector("select[name=\"conditionOperator\"]") as HTMLSelectElement | null)?.value ?? "";
    const rawValue = row.querySelector<HTMLInputElement>("input[name=\"conditionValue\"]")?.value ?? "";
    if (!RULE_CONDITION_OPERATORS.includes(operatorValue as RuleConditionOperator)) return null;
    const operator = operatorValue as RuleConditionOperator;
    const value = parseConditionInput(operator, rawValue);
    if (field.length === 0 || value === null) return null;
    conditions.push({ field, operator, value });
  }
  if (conditions.length > MAX_CONDITION_ROWS) return null;

  const actionType = formDataText(data, "actionType");
  let config: Record<string, unknown> | null = null;
  if (actionType === "rule_notify_telegram") {
    const message = formDataText(data, "actionMessage").trim();
    config = message.length > 0 && message.length <= 1000 ? { message } : null;
  } else if (actionType === "rule_call_webhook") {
    const url = formDataText(data, "actionUrl").trim();
    config = url.length > 0 ? { url } : null;
  } else if (actionType === "rule_tag_customer") {
    const tag = formDataText(data, "actionTag").trim();
    config = tag.length > 0 && tag.length <= 40 ? { tag } : null;
  } else if (actionType === "rule_create_task") {
    const note = formDataText(data, "actionNote").trim();
    config = note.length <= 500 ? (note.length > 0 ? { note } : {}) : null;
  }
  if (config === null) return null;
  return { actions: [{ config, type: actionType }], conditions, name, triggerType };
}

async function mutationRequest(root: HTMLElement, shopPublicId: string, input: {
  body?: Record<string, unknown>;
  idempotencyPrefix: string;
  method: "DELETE" | "PATCH" | "POST";
  path: string;
}): Promise<unknown> {
  const csrf = readCookie(root.dataset.csrfCookieName ?? "");
  if (csrf === null) throw new RulesApiError("csrf_missing", null);
  const response = await fetch(`${apiBase(shopPublicId)}${input.path}`, {
    body: input.body === undefined ? null : JSON.stringify(input.body),
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey(input.idempotencyPrefix),
      "X-CSRF-Token": csrf,
    },
    method: input.method,
  });
  return readResponse(response);
}

function ruleFromRow(row: HTMLElement): RuleView | null {
  try {
    const parsed = parseAutomationRules({ rules: [JSON.parse(row.dataset.ruleJson ?? "null")] });
    return parsed.length === 1 ? parsed[0] ?? null : null;
  } catch {
    return null;
  }
}

function wireTabs(): void {
  const nav = document.querySelector<HTMLElement>("[data-automation-tabs]");
  if (nav === null) return;
  const select = (tab: "history" | "rules"): void => {
    for (const link of nav.querySelectorAll<HTMLElement>("[data-automation-tab]")) {
      const active = link.dataset.automationTab === tab;
      link.setAttribute("aria-selected", String(active));
      link.classList.toggle("is-active", active);
    }
    for (const panel of document.querySelectorAll<HTMLElement>("[data-automation-panel]")) {
      panel.hidden = panel.dataset.automationPanel !== tab;
    }
  };
  for (const link of nav.querySelectorAll<HTMLAnchorElement>("[data-automation-tab]")) {
    link.addEventListener("click", (event) => {
      const tab = link.dataset.automationTab;
      if (tab !== "rules" && tab !== "history") return;
      event.preventDefault();
      select(tab);
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      window.history.replaceState(null, "", String(url));
    });
  }
}

wireTabs();

const root = document.querySelector<HTMLElement>("[data-rules-root]");
if (root !== null) {
  const shopPublicId = root.dataset.shopPublicId;
  if (shopPublicId !== undefined && shopPublicId.length > 0) {
    let deletingRule: { id: string; version: number } | null = null;

    for (const form of root.querySelectorAll<HTMLFormElement>("[data-rule-form]")) wireRuleForm(form);

    root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-rules-action]") : null;
      if (target === null || root.getAttribute("aria-busy") === "true") return;
      const row = target.closest<HTMLElement>("[data-rule]");
      if (row === null) return;
      const action = target.dataset.rulesAction;
      const rule = ruleFromRow(row);
      if (rule === null) {
        setFeedback(root, copy(root, "copyInvalidProjection"), "danger");
        return;
      }
      if (action === "edit") {
        const slot = root.querySelector<HTMLElement>("[data-rule-edit-slot]");
        const dialog = document.getElementById("automation-rule-edit-dialog");
        if (slot === null || !(dialog instanceof HTMLDialogElement)) return;
        slot.dataset.ruleEditId = rule.id;
        slot.dataset.ruleEditVersion = String(rule.version);
        fillEditForm(root, rule);
        dialog.showModal();
        return;
      }
      if (action === "delete") {
        const dialog = document.getElementById("automation-rule-delete-dialog");
        if (!(dialog instanceof HTMLDialogElement)) return;
        deletingRule = { id: rule.id, version: rule.version };
        dialog.showModal();
        return;
      }
      if (action !== "toggle") return;
      setBusy(root, true);
      setFeedback(root, copy(root, "copyTogglePending"));
      void mutationRequest(root, shopPublicId, {
        body: { enabled: !rule.enabled, expectedVersion: rule.version },
        idempotencyPrefix: "rule_toggle",
        method: "POST",
        path: `/${encodeURIComponent(rule.id)}/toggle`,
      })
        .then(async (payload) => {
          if (parseSingleRule(payload) === null) throw new RulesApiError("rules_projection_invalid", null);
          await loadRules(root, shopPublicId);
          setFeedback(root, copy(root, "copySaveSuccess"), "success");
        })
        .catch((error: unknown) => { setFeedback(root, errorMessage(error, root), "danger"); })
        .finally(() => { setBusy(root, false); });
    });

    root.addEventListener("sln:confirm", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const detail = (event as CustomEvent<ConfirmDetail>).detail;

      // Shared delete ConfirmDialog.
      if (target.closest("#automation-rule-delete-dialog") !== null) {
        event.preventDefault();
        const pending = deletingRule;
        if (pending === null) { detail.fail(); return; }
        setBusy(root, true);
        setFeedback(root, copy(root, "copyDeletePending"));
        void mutationRequest(root, shopPublicId, {
          body: { expectedVersion: pending.version },
          idempotencyPrefix: "rule_delete",
          method: "DELETE",
          path: `/${encodeURIComponent(pending.id)}`,
        })
          .then(async () => {
            deletingRule = null;
            await loadRules(root, shopPublicId);
            setFeedback(root, copy(root, "copyDeleteSuccess"), "success");
            detail.complete();
          })
          .catch((error: unknown) => { setFeedback(root, errorMessage(error, root), "danger"); detail.fail(); })
          .finally(() => { setBusy(root, false); });
        return;
      }

      // Create/edit rule dialogs.
      if (target.closest("[data-rule-dialog-root]") === null) return;
      event.preventDefault();
      const form = target.querySelector<HTMLFormElement>("[data-rule-form]");
      if (form === null) { detail.fail(); return; }
      const draft = collectRuleDraft(form);
      if (draft === null) {
        setFeedback(root, copy(root, "copyInvalidProjection"), "danger");
        detail.fail();
        return;
      }
      const editSlot = target.closest<HTMLElement>("[data-rule-edit-slot]");
      const isEdit = editSlot !== null && (editSlot.dataset.ruleEditId ?? "").length > 0;
      setBusy(root, true);
      setFeedback(root, copy(root, "copySavePending"));
      const request = isEdit
        ? mutationRequest(root, shopPublicId, {
          body: { ...draft, expectedVersion: Number(editSlot.dataset.ruleEditVersion ?? "0") },
          idempotencyPrefix: "rule_update",
          method: "PATCH",
          path: `/${encodeURIComponent(editSlot.dataset.ruleEditId ?? "")}`,
        })
        : mutationRequest(root, shopPublicId, {
          body: { ...draft },
          idempotencyPrefix: "rule_create",
          method: "POST",
          path: "",
        });
      void request
        .then(async (payload) => {
          if (parseSingleRule(payload) === null) throw new RulesApiError("rules_projection_invalid", null);
          if (!isEdit) createIdempotencySalt = crypto.randomUUID();
          await loadRules(root, shopPublicId);
          setFeedback(root, copy(root, "copySaveSuccess"), "success");
          detail.complete();
        })
        .catch((error: unknown) => { setFeedback(root, errorMessage(error, root), "danger"); detail.fail(); })
        .finally(() => { setBusy(root, false); });
    });
  }
}
