import { createSystemTranslator, resolvePresentationLocale } from "../i18n";
import type { ShopRole } from "../tenants/policy";

export const AUTOMATION_TASK_STATUSES = [
  "pending",
  "waiting_user",
  "waiting_provider",
  "running",
  "retryable",
  "succeeded",
  "failed",
  "canceled",
] as const;

export type AutomationTaskStatus = typeof AUTOMATION_TASK_STATUSES[number];

export type AutomationContinuationKind = "approval_granted" | "provider_check";

export type AutomationTaskView = {
  actionUrl: string;
  attemptCount: number;
  capabilityCode: string;
  canCancel: boolean;
  continuation: { kind: AutomationContinuationKind } | null;
  createdAt: string;
  id: string;
  lastSafeErrorCode: string | null;
  nextAttemptAt: string | null;
  status: AutomationTaskStatus;
  updatedAt: string;
  version: number;
};

export type AutomationStatusTone = "danger" | "info" | "neutral" | "success" | "warning";

const AUTOMATION_STATUS_TONES: Readonly<Record<AutomationTaskStatus, AutomationStatusTone>> = {
  canceled: "neutral",
  failed: "danger",
  pending: "info",
  retryable: "warning",
  running: "info",
  succeeded: "success",
  waiting_provider: "warning",
  waiting_user: "warning",
};

const AUTOMATION_CAPABILITIES = new Set([
  "domain.custom.domain_connect",
  "domain.custom.manual_dns",
  "domain.platform.provision",
  "payments.payos.channel_create",
  "shop.provision",
  "telegram.bot.create",
]);

const TERMINAL_STATUSES = new Set<AutomationTaskStatus>(["canceled", "failed", "succeeded"]);
const SAFE_PUBLIC_CODE = /^[a-z0-9_.:-]{1,96}$/u;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSafeActionUrl(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\");
}

function isContinuation(value: unknown): value is { kind: AutomationContinuationKind } {
  const row = recordOf(value);
  return row !== null && (row.kind === "approval_granted" || row.kind === "provider_check");
}

function parseTask(value: unknown): AutomationTaskView | null {
  const row = recordOf(value);
  if (row === null
    || !isSafeActionUrl(row.actionUrl)
    || !Number.isSafeInteger(row.attemptCount)
    || (row.attemptCount as number) < 0
    || typeof row.capabilityCode !== "string"
    || !SAFE_PUBLIC_CODE.test(row.capabilityCode)
    || typeof row.canCancel !== "boolean"
    || !(row.continuation === null || isContinuation(row.continuation))
    || typeof row.createdAt !== "string"
    || typeof row.id !== "string"
    || !SAFE_PUBLIC_CODE.test(row.id)
    || !(row.lastSafeErrorCode === null || (typeof row.lastSafeErrorCode === "string" && SAFE_PUBLIC_CODE.test(row.lastSafeErrorCode)))
    || !(row.nextAttemptAt === null || typeof row.nextAttemptAt === "string")
    || typeof row.status !== "string"
    || !AUTOMATION_TASK_STATUSES.includes(row.status as AutomationTaskStatus)
    || typeof row.updatedAt !== "string"
    || !Number.isSafeInteger(row.version)
    || (row.version as number) < 1) {
    return null;
  }
  const continuation = row.continuation === null ? null : row.continuation;
  return {
    actionUrl: row.actionUrl,
    attemptCount: row.attemptCount as number,
    capabilityCode: row.capabilityCode,
    canCancel: row.canCancel,
    continuation: continuation === null ? null : { kind: continuation.kind },
    createdAt: row.createdAt,
    id: row.id,
    lastSafeErrorCode: row.lastSafeErrorCode,
    nextAttemptAt: row.nextAttemptAt,
    status: row.status as AutomationTaskStatus,
    updatedAt: row.updatedAt,
    version: row.version as number,
  };
}

/** Parse only the public projection; raw references and provider payloads are never accepted. */
export function parseAutomationTasks(value: unknown): AutomationTaskView[] {
  const root = recordOf(value);
  if (root === null || !Array.isArray(root.tasks)) return [];
  return root.tasks.map(parseTask).filter((task): task is AutomationTaskView => task !== null);
}

export function automationTaskLabel(task: Pick<AutomationTaskView, "capabilityCode">, locale?: unknown): string {
  const t = createSystemTranslator(locale);
  const key = AUTOMATION_CAPABILITIES.has(task.capabilityCode)
    ? `automation.capability.${task.capabilityCode}`
    : "automation.capability.generic";
  return t(key);
}

export function automationTaskImpact(task: Pick<AutomationTaskView, "nextAttemptAt" | "status">, locale?: unknown): string {
  const t = createSystemTranslator(locale);
  if (task.status === "waiting_user") return t("automation.impact.waiting_user");
  if (task.status === "waiting_provider") return t("automation.impact.waiting_provider");
  if (task.status === "retryable") {
    const time = task.nextAttemptAt === null ? "" : ` ${formatAutomationTime(task.nextAttemptAt, "Asia/Ho_Chi_Minh", locale)}`;
    return t("automation.impact.retryable", { time });
  }
  if (task.status === "running" || task.status === "pending") return t("automation.impact.active");
  if (task.status === "failed") return t("automation.impact.failed");
  if (task.status === "canceled") return t("automation.impact.canceled");
  return t("automation.impact.succeeded");
}

export function canResumeAutomationTask(task: Pick<AutomationTaskView, "continuation" | "status">): boolean {
  return !TERMINAL_STATUSES.has(task.status) && task.continuation !== null;
}

/** Match mutation capabilities without treating a visible button as authorization. */
export function canManageAutomationTask(task: Pick<AutomationTaskView, "capabilityCode">, role: ShopRole | undefined): boolean {
  if (role !== "owner" && role !== "manager") return false;
  if (task.capabilityCode.startsWith("domain.")) return role === "owner";
  return true;
}

export function formatAutomationTime(value: string | null, timeZone = "Asia/Ho_Chi_Minh", locale?: unknown): string {
  const resolvedLocale = resolvePresentationLocale(locale);
  const t = createSystemTranslator(resolvedLocale);
  if (value === null) return t("automation.time.none");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return t("automation.time.invalid");
  try {
    return new Intl.DateTimeFormat(resolvedLocale, { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(timestamp));
  } catch {
    return t("automation.time.recent");
  }
}

export function automationErrorMessage(code: string, locale?: unknown): string {
  const keys: Readonly<Record<string, string>> = {
    authentication_required: "automation.error.authentication_required",
    authorization_denied: "automation.error.authorization_denied",
    automation_continuation_invalid: "automation.error.automation_continuation_invalid",
    automation_idempotency_busy: "automation.error.automation_idempotency_busy",
    automation_provider_evidence_pending: "automation.error.automation_provider_evidence_pending",
    automation_task_not_found: "automation.error.automation_task_not_found",
    automation_version_conflict: "automation.error.automation_version_conflict",
    csrf_invalid: "automation.error.csrf_invalid",
    csrf_missing: "automation.error.csrf_missing",
    recent_auth_required: "automation.error.recent_auth_required",
    tenant_suspended: "automation.error.tenant_suspended",
  };
  return createSystemTranslator(locale)(keys[code] ?? "automation.error.generic");
}

export function automationStatusLabel(status: AutomationTaskStatus, locale?: unknown): string {
  return createSystemTranslator(locale)(`automation.status.${status}`);
}

export function automationStatusTone(status: AutomationTaskStatus): AutomationStatusTone {
  return AUTOMATION_STATUS_TONES[status];
}
