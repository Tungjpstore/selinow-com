import {
  automationErrorMessage,
  automationStatusLabel,
  automationStatusTone,
  automationTaskImpact,
  automationTaskLabel,
  canManageAutomationTask,
  canResumeAutomationTask,
  formatAutomationTime,
  parseAutomationTasks,
  type AutomationTaskView,
} from "../../lib/dashboard/automation-ui";
import type { ShopRole } from "../../lib/tenants/policy";

type ApiFailure = { code?: unknown; requestId?: unknown };

class AutomationApiError extends Error {
  readonly code: string;
  readonly requestId: string | null;

  constructor(code: string, requestId: string | null) {
    super(code);
    this.name = "AutomationApiError";
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
  return `/api/app/shops/${encodeURIComponent(shopPublicId)}/automation`;
}

function actionHref(task: AutomationTaskView, shopPublicId: string): string | null {
  try {
    const target = new URL(task.actionUrl, window.location.origin);
    if (target.origin !== window.location.origin || target.pathname.startsWith("//")) return null;
    target.searchParams.set("shop", shopPublicId);
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

function idempotencyKey(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function setFeedback(root: HTMLElement, message: string, tone: "danger" | "info" | "success" = "info"): void {
  const feedback = root.querySelector<HTMLElement>("[data-automation-feedback]");
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
  if (!(error instanceof AutomationApiError)) return copy(root, "copyConnectionError");
  const base = automationErrorMessage(error.code, root.dataset.locale);
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
    throw new AutomationApiError(
      typeof failure?.code === "string" ? failure.code : `http_${String(response.status)}`,
      typeof failure?.requestId === "string" ? failure.requestId : null,
    );
  }
  return payload;
}

async function loadTasks(root: HTMLElement, shopPublicId: string): Promise<AutomationTaskView[]> {
  const response = await fetch(`${apiBase(shopPublicId)}?limit=20`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  const payload = await readResponse(response);
  const rootPayload = recordOf(payload);
  if (rootPayload === null || !Array.isArray(rootPayload.tasks)) throw new AutomationApiError("automation_projection_invalid", null);
  const tasks = parseAutomationTasks(payload);
  renderTasks(root, tasks, shopPublicId);
  return tasks;
}

async function mutateTask(root: HTMLElement, shopPublicId: string, taskId: string, action: "cancel" | "resume", version: number): Promise<void> {
  const csrf = readCookie(root.dataset.csrfCookieName ?? "");
  if (csrf === null) throw new AutomationApiError("csrf_missing", null);
  const endpoint = `${apiBase(shopPublicId)}/${encodeURIComponent(taskId)}/${action}`;
  const body = action === "cancel"
    ? { expectedVersion: version, reasonCode: "seller_automation_cancel" }
    : { expectedVersion: version };
  const response = await fetch(endpoint, {
    body: JSON.stringify(body),
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey(`automation_${action}`),
      "X-CSRF-Token": csrf,
    },
    method: "POST",
  });
  const payload = await readResponse(response);
  const row = recordOf(payload);
  if (row === null || parseAutomationTasks({ tasks: [row.task] }).length !== 1) {
    throw new AutomationApiError("automation_projection_invalid", null);
  }
}

function addText(parent: HTMLElement, tag: string, text: string, className?: string): HTMLElement {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function renderTasks(root: HTMLElement, tasks: readonly AutomationTaskView[], shopPublicId: string): void {
  const list = root.querySelector<HTMLElement>("[data-automation-list]");
  const count = root.querySelector<HTMLElement>("[data-automation-count]");
  if (list === null) return;
  if (count !== null) count.textContent = copy(root, "copyCount", { count: tasks.length });
  list.replaceChildren();
  const role = root.dataset.shopRole as ShopRole | undefined;
  const locale = root.dataset.locale;
  if (tasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "automation-empty";
    empty.dataset.automationEmpty = "true";
    addText(empty, "strong", copy(root, "copyEmptyTitle"));
    addText(empty, "p", copy(root, "copyEmptyDescription"));
    list.appendChild(empty);
    return;
  }
  for (const task of tasks) {
    const row = document.createElement("article");
    row.className = "automation-task";
    row.dataset.automationTask = "true";
    row.dataset.taskId = task.id;
    row.dataset.taskVersion = String(task.version);

    const status = document.createElement("div");
    status.className = "automation-task__status";
    const badge = addText(status, "span", automationStatusLabel(task.status, locale), "automation-status");
    badge.dataset.tone = automationStatusTone(task.status);
    badge.dataset.taskStatus = "true";
    const updated = document.createElement("time");
    updated.textContent = formatAutomationTime(task.updatedAt, root.dataset.timeZone, locale);
    status.appendChild(updated);
    updated.dataset.taskUpdated = "true";
    updated.dateTime = task.updatedAt;
    row.appendChild(status);

    const copyBlock = document.createElement("div");
    copyBlock.className = "automation-task__copy";
    addText(copyBlock, "strong", automationTaskLabel(task, locale));
    addText(copyBlock, "p", automationTaskImpact(task, locale));
    addText(copyBlock, "code", task.capabilityCode);
    if (task.lastSafeErrorCode !== null) addText(copyBlock, "small", copy(root, "copySafeError", { code: task.lastSafeErrorCode }), "automation-safe-error");
    row.appendChild(copyBlock);

    const actions = document.createElement("div");
    actions.className = "automation-actions";
    const href = actionHref(task, shopPublicId);
    if (href !== null) {
      const link = document.createElement("a");
      link.className = "automation-action-link";
      link.href = href;
      link.dataset.taskActionLink = "true";
      link.textContent = `${copy(root, "copyOpenRelated")} ↗`;
      actions.appendChild(link);
    }
    const canManage = canManageAutomationTask(task, role);
    if (canManage && canResumeAutomationTask(task)) {
      const button = document.createElement("button");
      button.className = "sln-button sln-button-primary automation-control";
      button.type = "button";
      button.dataset.automationAction = "resume";
      button.dataset.taskVersion = String(task.version);
      button.textContent = task.continuation?.kind === "provider_check" ? copy(root, "copyResumeProvider") : copy(root, "copyResume");
      actions.appendChild(button);
    }
    if (canManage && task.canCancel) {
      const button = document.createElement("button");
      button.className = "sln-button sln-button-danger automation-control";
      button.type = "button";
      button.dataset.automationAction = "cancel";
      button.dataset.taskVersion = String(task.version);
      button.textContent = copy(root, "copyCancel");
      actions.appendChild(button);
    }
    row.appendChild(actions);
    list.appendChild(row);
  }
}

const root = document.querySelector<HTMLElement>("[data-automation-root]");
if (root !== null) {
  const shopPublicId = root.dataset.shopPublicId;
  if (shopPublicId !== undefined && shopPublicId.length > 0) {
    const refresh = root.querySelector<HTMLButtonElement>("[data-automation-refresh]");
    refresh?.addEventListener("click", () => {
      if (root.getAttribute("aria-busy") === "true") return;
      setBusy(root, true);
      setFeedback(root, copy(root, "copyRefreshPending"));
      void loadTasks(root, shopPublicId)
        .then(() => { setFeedback(root, copy(root, "copyRefreshSuccess"), "success"); })
        .catch((error: unknown) => { setFeedback(root, errorMessage(error, root), "danger"); })
        .finally(() => { setBusy(root, false); });
    });

    root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-automation-action]") : null;
      if (target === null || root.getAttribute("aria-busy") === "true") return;
      const row = target.closest<HTMLElement>("[data-automation-task]");
      const taskId = row?.dataset.taskId;
      const version = Number(target.dataset.taskVersion ?? row?.dataset.taskVersion ?? "");
      const action = target.dataset.automationAction;
      if (taskId === undefined || !Number.isSafeInteger(version) || version < 1 || (action !== "cancel" && action !== "resume")) {
        setFeedback(root, copy(root, "copyInvalidProjection"), "danger");
        return;
      }
      if (action === "cancel" && !window.confirm(copy(root, "copyCancelConfirm"))) return;
      setBusy(root, true);
      setFeedback(root, action === "cancel" ? copy(root, "copyCancelPending") : copy(root, "copyResumePending"));
      void mutateTask(root, shopPublicId, taskId, action, version)
        .then(() => loadTasks(root, shopPublicId))
        .then(() => { setFeedback(root, copy(root, "copyMutationSuccess"), "success"); })
        .catch((error: unknown) => { setFeedback(root, errorMessage(error, root), "danger"); })
        .finally(() => { setBusy(root, false); });
    });
  }
}
