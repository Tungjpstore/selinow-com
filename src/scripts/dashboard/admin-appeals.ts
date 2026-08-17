export {};

type ApiFailure = { code?: unknown; requestId?: unknown };
type Decision = "provider_pending" | "rejected" | "completed" | "failed";
const DECISIONS: readonly Decision[] = ["provider_pending", "rejected", "completed", "failed"];

function isDecision(value: string | undefined): value is Decision {
  return value !== undefined && (DECISIONS as readonly string[]).includes(value);
}

// Mirrors the authoritative server-side failure-code contract so the client
// rejects unsafe input before it ever leaves the browser.
const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9._:-]{2,63}$/u;

function sanitizeFailureCode(raw: string): string | null {
  const candidate = raw.trim().toLowerCase();
  return FAILURE_CODE_PATTERN.test(candidate) ? candidate : null;
}

type Copy = {
  approve: string;
  reject: string;
  approved: string;
  rejected: string;
  confirmApprove: string;
  confirmReject: string;
  errorGeneric: string;
  errorCsrf: string;
  errorRecentAuth: string;
  errorConflict: string;
  errorReference: string;
  complete: string;
  markFailed: string;
  completing: string;
  failing: string;
  completedFeedback: string;
  failedFeedback: string;
  confirmComplete: string;
  confirmFailed: string;
  failureCodeLabel: string;
  failureCodeRequired: string;
  errorForbidden: string;
  errorRateLimited: string;
  errorTwoFactorRequired: string;
};

class AppealReviewError extends Error {
  readonly requestId: string | null;

  constructor(code: string, requestId: string | null) {
    super(code);
    this.name = "AppealReviewError";
    this.requestId = requestId;
  }
}

function readCookie(name: string): string | null {
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return null;
}

function readCopy(root: HTMLElement): Copy {
  const fallback: Copy = {
    approve: "Approving handoff...",
    reject: "Rejecting request...",
    approved: "Review recorded. Provider execution is still pending.",
    rejected: "Request rejected and audit recorded.",
    confirmApprove: "Approve this request for provider handoff? No refund is executed by this action.",
    confirmReject: "Reject this remediation request? The decision will be audited.",
    errorGeneric: "The review could not be recorded. Reload the authoritative state.",
    errorCsrf: "The action-protection session expired. Reload the page.",
    errorRecentAuth: "Recent authentication is required for this sensitive review. Sign in again, then retry the action.",
    errorConflict: "The request changed in another session. Reload before continuing.",
    errorReference: "Code {code} · Request {requestId}",
    complete: "Confirm reversal",
    markFailed: "Mark failed",
    completing: "Recording completion...",
    failing: "Recording failure...",
    completedFeedback: "Completion recorded. The verified reversal is now authoritative.",
    failedFeedback: "Failure recorded. The order is closed as failed settlement.",
    confirmComplete: "Confirm that the refund or chargeback reversal was verified as applied? This is irreversible: entitlements are revoked and the request is closed as completed.",
    confirmFailed: "Close this order as a terminal settlement failure? This is irreversible: no refund is issued.",
    failureCodeLabel: "Failure code",
    failureCodeRequired: "A failure code is required (3-64 characters: lowercase letters, digits, dot, underscore, colon, hyphen; must start with a letter).",
    errorForbidden: "Your role cannot record terminal decisions. Only owner or risk may complete or fail a request.",
    errorRateLimited: "Too many admin actions were requested. Wait a moment and try again.",
    errorTwoFactorRequired: "Two-factor authentication is required for platform administrators. Enable it in account security (/app/security) to continue managing operations.",
  };
  try {
    const parsed: unknown = JSON.parse(root.dataset.copy ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return fallback;
    return { ...fallback, ...(parsed as Partial<Copy>) };
  } catch {
    return fallback;
  }
}

function setFeedback(root: HTMLElement, message: string, tone: "error" | "neutral" | "success"): void {
  const feedback = root.querySelector<HTMLElement>("[data-appeals-feedback]");
  if (feedback === null) return;
  feedback.hidden = false;
  feedback.textContent = message;
  feedback.dataset.tone = tone;
}

// Caches one idempotency key per row AND decision: retrying the same row with
// a different decision (or failure code) must not replay a consumed key, which
// would surface as a permanent 409 idempotency_conflict.
function keyFor(row: HTMLElement, decision: Decision): string {
  const storageKey = `idempotencyKey_${decision}`;
  const existing = row.dataset[storageKey];
  if (existing !== undefined && existing !== "") return existing;
  const key = `appeal_${decision}_${crypto.randomUUID()}`;
  row.dataset[storageKey] = key;
  return key;
}

async function review(root: HTMLElement, row: HTMLElement, decision: Decision, failureCode: string | null): Promise<void> {
  const requestPublicId = row.dataset.requestPublicId ?? "";
  const expectedVersion = Number(row.dataset.version ?? "0");
  if (requestPublicId === "" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new AppealReviewError("state_invalid", null);
  }
  const csrfCookieName = root.dataset.csrfCookieName ?? "";
  const csrf = readCookie(csrfCookieName);
  if (csrf === null) throw new AppealReviewError("csrf_missing", null);
  const payload = decision === "failed" && failureCode !== null
    ? { decision, expectedVersion, failureCode }
    : { decision, expectedVersion };
  const response = await fetch(`/api/admin/appeals/${encodeURIComponent(requestPublicId)}`, {
    body: JSON.stringify(payload),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": keyFor(row, decision),
      "X-CSRF-Token": csrf,
    },
    method: "PATCH",
  });
  if (response.ok) return;
  let body: ApiFailure = {};
  try { body = await response.json(); } catch { /* Keep the HTTP status as the safe fallback. */ }
  throw new AppealReviewError(
    typeof body.code === "string" ? body.code : `http_${String(response.status)}`,
    typeof body.requestId === "string" ? body.requestId : null,
  );
}

const root = document.querySelector<HTMLElement>("[data-admin-appeals]");
if (root !== null) {
  const copy = readCopy(root);
  const dialog = root.querySelector<HTMLDialogElement>("[data-appeal-confirm-dialog]");
  const dialogForm = root.querySelector<HTMLFormElement>("[data-appeal-confirm-form]");
  const dialogTitle = root.querySelector<HTMLElement>("[data-appeal-confirm-title]");
  const dialogImpact = root.querySelector<HTMLElement>("[data-appeal-confirm-impact]");
  const dialogConfirm = root.querySelector<HTMLButtonElement>("[data-appeal-confirm-action]");
  const failureField = root.querySelector<HTMLElement>("[data-appeal-failure-code-field]");
  const failureLabel = root.querySelector<HTMLElement>("[data-appeal-failure-code-label]");
  const failureInput = root.querySelector<HTMLInputElement>("[data-appeal-failure-code-input]");
  const failureError = root.querySelector<HTMLElement>("[data-appeal-failure-code-error]");
  if (failureLabel !== null) failureLabel.textContent = copy.failureCodeLabel;
  type PendingReview = { button: HTMLButtonElement; decision: Decision; failureCode: string | null; row: HTMLElement };
  let pendingReview: PendingReview | null = null;

  const busyLabels: Readonly<Record<Decision, string>> = {
    provider_pending: copy.approve,
    rejected: copy.reject,
    completed: copy.completing,
    failed: copy.failing,
  };
  const successLabels: Readonly<Record<Decision, string>> = {
    provider_pending: copy.approved,
    rejected: copy.rejected,
    completed: copy.completedFeedback,
    failed: copy.failedFeedback,
  };
  const impactCopy: Readonly<Record<Decision, string>> = {
    provider_pending: copy.confirmApprove,
    rejected: copy.confirmReject,
    completed: copy.confirmComplete,
    failed: copy.confirmFailed,
  };

  const startReview = ({ button, decision, failureCode, row }: PendingReview): void => {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = busyLabels[decision];
    root.setAttribute("aria-busy", "true");
    void review(root, row, decision, failureCode)
      .then(() => {
        setFeedback(root, successLabels[decision], "success");
        window.location.reload();
      })
      .catch((error: unknown) => {
        const safe = error instanceof AppealReviewError ? error : new AppealReviewError("internal_error", null);
        const message = safe.message === "csrf_missing" || safe.message === "csrf_invalid"
          ? copy.errorCsrf
          : safe.message === "recent_auth_required"
            ? copy.errorRecentAuth
            : safe.message === "rate_limited" || safe.message === "http_429"
              ? copy.errorRateLimited
              : safe.message === "admin_two_factor_required"
                ? copy.errorTwoFactorRequired
                : safe.message === "version_conflict" || safe.message === "payment_remediation_state_conflict"
                  ? copy.errorConflict
                  : safe.message === "authorization_denied" || safe.message === "http_403"
                    ? copy.errorForbidden
                    : copy.errorGeneric;
        const reference = safe.requestId === null
          ? ""
          : ` ${copy.errorReference.replace("{code}", safe.message).replace("{requestId}", safe.requestId)}.`;
        setFeedback(root, `${message}${reference}`, "error");
        button.disabled = false;
        button.textContent = original;
        root.setAttribute("aria-busy", "false");
      });
  };

  root.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-appeal-decision]") : null;
    if (button === null) return;
    const row = button.closest<HTMLElement>("[data-appeal-row]");
    if (row === null) return;
    const decision = button.dataset.appealDecision;
    if (!isDecision(decision)) return;
    if (dialog === null || dialogTitle === null || dialogImpact === null || dialogConfirm === null) return;
    if (decision === "failed" && (failureField === null || failureInput === null || failureError === null)) return;
    pendingReview = { button, decision, failureCode: null, row };
    const label = button.textContent.trim();
    dialogTitle.textContent = label;
    dialogImpact.textContent = impactCopy[decision];
    dialogConfirm.textContent = label;
    dialogConfirm.dataset.variant = decision === "provider_pending" ? "primary" : "danger";
    if (failureField !== null && failureInput !== null && failureError !== null) {
      failureField.hidden = decision !== "failed";
      if (decision === "failed") {
        failureInput.value = "";
        failureError.hidden = true;
      }
    }
    dialog.showModal();
  });
  dialogForm?.addEventListener("submit", (event) => {
    const submitter = event.submitter;
    const pending = pendingReview;
    if (!(submitter instanceof HTMLButtonElement) || submitter.value !== "confirm" || pending === null) {
      pendingReview = null;
      return;
    }
    event.preventDefault();
    let confirmed: PendingReview = pending;
    if (pending.decision === "failed") {
      const failureCode = failureInput === null ? null : sanitizeFailureCode(failureInput.value);
      if (failureCode === null || failureError === null) {
        if (failureError !== null) {
          failureError.textContent = copy.failureCodeRequired;
          failureError.hidden = false;
        }
        failureInput?.focus();
        return;
      }
      confirmed = { ...pending, failureCode };
    }
    pendingReview = null;
    dialog?.close();
    startReview(confirmed);
  });
  dialog?.addEventListener("close", () => { pendingReview = null; });
}
