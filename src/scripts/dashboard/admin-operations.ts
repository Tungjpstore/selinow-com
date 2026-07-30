export {};

type ApiFailure = { code?: unknown; requestId?: unknown };
type CopyParams = Record<string, string>;

const DEFAULT_COPY = {
  "admin.overview.client.confirm.suspend_target": "Suspend this target now and block related traffic?",
  "admin.overview.client.error.authorization_denied": "Your current role cannot perform this action.",
  "admin.overview.client.error.csrf_missing": "The action-protection session is no longer valid. Reload the page.",
  "admin.overview.client.error.generic": "The action could not be applied. The safe error code was retained for investigation.",
  "admin.overview.client.error.moderation_state_conflict": "The state changed in another session. Reload the page to review it.",
  "admin.overview.client.error.recent_auth_required": "Your authentication is stale. Sign in again before taking this action.",
  "admin.overview.client.feedback.applied": "Applied. Reloading the authoritative state...",
  "admin.overview.client.feedback.applying": "Applying the audited change...",
  "admin.overview.client.manual.confirm": "{action} will change authoritative state and write an audit entry. Continue?",
  "admin.overview.client.manual.error.generic": "The action was rejected or has not been confirmed by the backend.",
  "admin.overview.client.manual.error.moderation_state_conflict": "The action conflicts with newer state. Reload the page.",
  "admin.overview.client.manual.error.recent_auth_required": "Your authentication is stale. Sign in again before this sensitive action.",
  "admin.overview.client.manual.feedback.applied": "The action was recorded and audited.",
  "admin.overview.client.manual.feedback.verifying": "Verifying the tenant and target state...",
  "admin.overview.client.manual.product_id_required": "Product ID is required for product actions.",
  "admin.overview.client.reference.code": "Code {code}",
  "admin.overview.client.reference.request": "Request {requestId}",
} as const;

type CopyKey = keyof typeof DEFAULT_COPY;
type CopyReader = (key: CopyKey, params?: CopyParams) => string;

class AdminOperationError extends Error {
  readonly requestId: string | null;

  constructor(code: string, requestId: string | null) {
    super(code);
    this.name = "AdminOperationError";
    this.requestId = requestId;
  }
}

function cookieValue(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(";")) {
    const normalized = part.trim();
    if (normalized.startsWith(prefix)) return decodeURIComponent(normalized.slice(prefix.length));
  }
  return null;
}

function setStatus(
  root: HTMLElement,
  text: CopyReader,
  message: string,
  tone: "error" | "neutral" | "success",
  error?: AdminOperationError,
): void {
  const status = root.querySelector<HTMLElement>("[data-operations-status]");
  if (status === null) return;
  const referenceParts = error === undefined
    ? []
    : [
      text("admin.overview.client.reference.code", { code: error.message }),
      ...(error.requestId === null
        ? []
        : [text("admin.overview.client.reference.request", { requestId: error.requestId })]),
    ];
  const reference = referenceParts.length === 0 ? "" : ` ${referenceParts.join(" · ")}.`;
  status.textContent = `${message}${reference}`;
  status.dataset.tone = tone;
  status.setAttribute("role", tone === "error" ? "alert" : "status");
}

function createCopyReader(root: HTMLElement): CopyReader {
  let supplied: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(root.dataset.copy ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      supplied = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed optional copy must not prevent guarded admin actions from loading.
  }

  return (key, params = {}) => {
    const candidate = supplied[key];
    let value = typeof candidate === "string" && candidate.length > 0 ? candidate : DEFAULT_COPY[key];
    for (const [name, replacement] of Object.entries(params)) {
      value = value.split(`{${name}}`).join(replacement);
    }
    return value;
  };
}

function operationKey(element: HTMLElement, prefix: string): string {
  const existing = element.dataset.idempotencyKey;
  if (existing !== undefined && existing !== "") return existing;
  const created = `${prefix}_${crypto.randomUUID()}`;
  element.dataset.idempotencyKey = created;
  return created;
}

async function mutate(
  root: HTMLElement,
  endpoint: string,
  payload: Record<string, string>,
  idempotencyKey: string,
): Promise<void> {
  const csrfCookieName = root.dataset.csrfCookieName ?? "";
  const csrf = cookieValue(csrfCookieName);
  if (csrf === null) throw new AdminOperationError("csrf_missing", null);
  const response = await fetch(endpoint, {
    body: JSON.stringify(payload),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
      "X-CSRF-Token": csrf,
    },
    method: "POST",
  });
  if (response.ok) return;
  let body: ApiFailure = {};
  try {
    body = await response.json();
  } catch {
    // Stable HTTP status remains sufficient when an intermediary returns a non-JSON body.
  }
  throw new AdminOperationError(
    typeof body.code === "string" ? body.code : `http_${String(response.status)}`,
    typeof body.requestId === "string" ? body.requestId : null,
  );
}

const root = document.querySelector<HTMLElement>("[data-admin-operations]");
if (root !== null) {
  const text = createCopyReader(root);

  root.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("button[data-report-status], button[data-action-kind]")
      : null;
    if (button === null) return;
    const report = button.closest<HTMLElement>("[data-report-public-id]");
    if (report === null) return;
    const reportPublicId = report.dataset.reportPublicId ?? "";
    const status = button.dataset.reportStatus;
    const actionKind = button.dataset.actionKind;
    const endpoint = status === undefined
      ? "/api/admin/moderation/actions"
      : `/api/admin/abuse-reports/${encodeURIComponent(reportPublicId)}`;
    const payload: Record<string, string> = status === undefined
      ? {
        abuseReportPublicId: reportPublicId,
        actionKind: actionKind ?? "",
        reasonCode: "reported_abuse",
        shopPublicId: report.dataset.shopPublicId ?? "",
      }
      : { status };
    if (status === undefined && report.dataset.targetKind === "product") {
      payload.targetId = report.dataset.targetRef ?? "";
    }
    if (payload.actionKind?.endsWith("_suspend") === true
      && !window.confirm(text("admin.overview.client.confirm.suspend_target"))) return;
    button.disabled = true;
    setStatus(root, text, text("admin.overview.client.feedback.applying"), "neutral");
    root.setAttribute("aria-busy", "true");
    void mutate(root, endpoint, payload, operationKey(button, "moderation"))
      .then(() => {
        setStatus(root, text, text("admin.overview.client.feedback.applied"), "success");
        window.location.reload();
      })
      .catch((error: unknown) => {
        const safeError = error instanceof AdminOperationError
          ? error
          : new AdminOperationError("internal_error", null);
        const code = safeError.message;
        const message = code === "recent_auth_required"
          ? text("admin.overview.client.error.recent_auth_required")
          : code === "authorization_denied"
            ? text("admin.overview.client.error.authorization_denied")
            : code === "csrf_missing"
              ? text("admin.overview.client.error.csrf_missing")
              : code === "moderation_state_conflict"
                ? text("admin.overview.client.error.moderation_state_conflict")
                : text("admin.overview.client.error.generic");
        setStatus(root, text, message, "error", safeError);
        button.disabled = false;
        root.setAttribute("aria-busy", "false");
      });
  });

  const form = root.querySelector<HTMLFormElement>("[data-manual-action-form]");
  form?.addEventListener("input", () => {
    delete form.dataset.idempotencyKey;
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const field = (name: string): string => {
      const value = data.get(name);
      return typeof value === "string" ? value : "";
    };
    const actionKind = field("actionKind");
    const payload: Record<string, string> = {
      actionKind,
      reasonCode: field("reasonCode"),
      shopPublicId: field("shopPublicId"),
    };
    const targetId = field("targetId");
    if (targetId !== "") payload.targetId = targetId;
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (actionKind.startsWith("product_") && targetId === "") {
      setStatus(root, text, text("admin.overview.client.manual.product_id_required"), "error");
      form.querySelector<HTMLInputElement>("[name=targetId]")?.focus();
      return;
    }
    const selectedOption = form.querySelector<HTMLOptionElement>("select[name=actionKind] option:checked");
    const actionLabel = (selectedOption?.textContent ?? actionKind).trim();
    if (!window.confirm(text("admin.overview.client.manual.confirm", { action: actionLabel }))) return;
    if (submit !== null) submit.disabled = true;
    setStatus(root, text, text("admin.overview.client.manual.feedback.verifying"), "neutral");
    root.setAttribute("aria-busy", "true");
    void mutate(root, "/api/admin/moderation/actions", payload, operationKey(form, "manual_moderation"))
      .then(() => {
        setStatus(root, text, text("admin.overview.client.manual.feedback.applied"), "success");
        window.location.reload();
      })
      .catch((error: unknown) => {
        const safeError = error instanceof AdminOperationError
          ? error
          : new AdminOperationError("moderation_update_failed", null);
        const message = safeError.message === "recent_auth_required"
          ? text("admin.overview.client.manual.error.recent_auth_required")
          : safeError.message === "moderation_state_conflict"
            ? text("admin.overview.client.manual.error.moderation_state_conflict")
            : text("admin.overview.client.manual.error.generic");
        setStatus(root, text, message, "error", safeError);
        if (submit !== null) submit.disabled = false;
        root.setAttribute("aria-busy", "false");
      });
  });
}
