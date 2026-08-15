export {};

type ApiFailure = { code?: unknown; requestId?: unknown };
type Decision = "provider_pending" | "rejected";
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
    errorRecentAuth: "Recent authentication is required for this sensitive review.",
    errorConflict: "The request changed in another session. Reload before continuing.",
    errorReference: "Code {code} · Request {requestId}",
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

function keyFor(row: HTMLElement, decision: Decision): string {
  const existing = row.dataset.idempotencyKey;
  if (existing !== undefined && existing !== "") return existing;
  const key = `appeal_${decision}_${crypto.randomUUID()}`;
  row.dataset.idempotencyKey = key;
  return key;
}

async function review(root: HTMLElement, row: HTMLElement, decision: Decision): Promise<void> {
  const requestPublicId = row.dataset.requestPublicId ?? "";
  const expectedVersion = Number(row.dataset.version ?? "0");
  if (requestPublicId === "" || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new AppealReviewError("state_invalid", null);
  }
  const csrfCookieName = root.dataset.csrfCookieName ?? "";
  const csrf = readCookie(csrfCookieName);
  if (csrf === null) throw new AppealReviewError("csrf_missing", null);
  const response = await fetch(`/api/admin/appeals/${encodeURIComponent(requestPublicId)}`, {
    body: JSON.stringify({ decision, expectedVersion }),
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
  type PendingReview = { button: HTMLButtonElement; decision: Decision; row: HTMLElement };
  let pendingReview: PendingReview | null = null;

  const startReview = ({ button, decision, row }: PendingReview): void => {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = decision === "provider_pending" ? copy.approve : copy.reject;
    root.setAttribute("aria-busy", "true");
    void review(root, row, decision)
      .then(() => {
        setFeedback(root, decision === "provider_pending" ? copy.approved : copy.rejected, "success");
        window.location.reload();
      })
      .catch((error: unknown) => {
        const safe = error instanceof AppealReviewError ? error : new AppealReviewError("internal_error", null);
        const message = safe.message === "csrf_missing" || safe.message === "csrf_invalid"
          ? copy.errorCsrf
          : safe.message === "recent_auth_required"
            ? copy.errorRecentAuth
            : safe.message === "version_conflict" || safe.message === "payment_remediation_state_conflict"
              ? copy.errorConflict
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
    if (decision !== "provider_pending" && decision !== "rejected") return;
    if (dialog === null || dialogTitle === null || dialogImpact === null || dialogConfirm === null) return;
    pendingReview = { button, decision, row };
    const label = button.textContent.trim();
    dialogTitle.textContent = label;
    dialogImpact.textContent = decision === "provider_pending" ? copy.confirmApprove : copy.confirmReject;
    dialogConfirm.textContent = label;
    dialogConfirm.dataset.variant = decision === "provider_pending" ? "primary" : "danger";
    dialog.showModal();
  });
  dialogForm?.addEventListener("submit", (event) => {
    const submitter = event.submitter;
    const pending = pendingReview;
    pendingReview = null;
    if (!(submitter instanceof HTMLButtonElement) || submitter.value !== "confirm" || pending === null) return;
    event.preventDefault();
    dialog?.close();
    startReview(pending);
  });
  dialog?.addEventListener("close", () => { pendingReview = null; });
}
