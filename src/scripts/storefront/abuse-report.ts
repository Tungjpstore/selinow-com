export {};

type ApiPayload = {
  code?: string;
  report?: { publicId?: string; status?: string };
  requestId?: string;
};

const dialog = document.querySelector<HTMLDialogElement>("[data-abuse-report-dialog]");
const form = document.querySelector<HTMLFormElement>("[data-abuse-report-form]");
const feedback = document.querySelector<HTMLElement>("[data-abuse-report-feedback]");
const submit = document.querySelector<HTMLButtonElement>("[data-abuse-report-submit]");
let idempotencyKey: string | null = null;
const copy = {
  genericError: form?.dataset.genericError ?? "The report could not be sent right now. Try again.",
  networkError: form?.dataset.networkError ?? "The connection was interrupted. The report was not confirmed; you can safely try again.",
  received: form?.dataset.receivedMessage ?? "Report received for review.",
  receivedTracking: form?.dataset.receivedTrackingMessage ?? "Report received. Tracking code: {id}.",
  receiving: form?.dataset.receivingMessage ?? "Selinow is receiving your report.",
  sent: form?.dataset.sentLabel ?? "Sent",
  submit: form?.dataset.submitLabel ?? "Send report",
  submitting: form?.dataset.submittingLabel ?? "Sending…",
  supportCode: form?.dataset.supportCode ?? " Support code: {requestId}.",
};

function setFeedback(message: string, state: "error" | "idle" | "success" = "idle"): void {
  if (feedback === null) return;
  feedback.textContent = message;
  feedback.dataset.state = state;
}

function readableError(payload: ApiPayload): string {
  const messages: Record<string, string | undefined> = {
    idempotency_conflict: form?.dataset.errorIdempotencyConflict,
    rate_limited: form?.dataset.errorRateLimited,
    resource_not_found: form?.dataset.errorResourceNotFound,
    turnstile_invalid: form?.dataset.errorTurnstileInvalid,
    turnstile_required: form?.dataset.errorTurnstileRequired,
    turnstile_unavailable: form?.dataset.errorTurnstileUnavailable,
    validation_failed: form?.dataset.errorValidationFailed,
  };
  const mapped = payload.code === undefined ? undefined : messages[payload.code];
  const base = mapped ?? copy.genericError;
  const requestId = payload.requestId;
  return requestId === undefined ? base : `${base}${copy.supportCode.replace("{requestId}", requestId)}`;
}

function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

function resetTurnstile(): void {
  const turnstileWindow = window as typeof window & { turnstile?: { reset: () => void } };
  turnstileWindow.turnstile?.reset();
}

document.querySelectorAll<HTMLButtonElement>("[data-abuse-report-open]").forEach((button) => {
  button.addEventListener("click", () => {
    if (dialog === null) return;
    if (feedback?.dataset.state === "success") {
      form?.reset();
      form?.querySelectorAll("input, select, textarea").forEach((control) => {
        if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) control.disabled = false;
      });
      if (submit !== null) {
        submit.disabled = false;
        submit.textContent = copy.submit;
      }
      idempotencyKey = null;
      resetTurnstile();
    }
    setFeedback("");
    dialog.showModal();
    form?.querySelector<HTMLElement>("select, textarea, input")?.focus();
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-abuse-report-close]").forEach((button) => {
  button.addEventListener("click", () => dialog?.close());
});

form?.addEventListener("input", () => {
  idempotencyKey = null;
  setFeedback("");
});

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!form.reportValidity() || submit === null) return;
  void (async () => {
    submit.disabled = true;
    submit.textContent = copy.submitting;
    setFeedback(copy.receiving);
    const data = new FormData(form);
    const targetKind = formText(data, "targetKind") || "shop";
    const productSlug = form.dataset.productSlug;
    const turnstileToken = form.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]')?.value;
    idempotencyKey ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/store/abuse-reports", {
        body: JSON.stringify({
          category: formText(data, "category") || "other",
          ...(targetKind === "product" && productSlug !== undefined ? { productSlug } : {}),
          reporterContact: formText(data, "reporterContact"),
          summary: formText(data, "summary"),
          targetKind,
          ...(turnstileToken === undefined ? {} : { turnstileToken }),
        }),
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        method: "POST",
      });
      const payload: ApiPayload = await response.json();
      if (!response.ok) {
        setFeedback(readableError(payload), "error");
        resetTurnstile();
        return;
      }
      const reportId = payload.report?.publicId;
      form.querySelectorAll("input, select, textarea").forEach((control) => {
        if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) control.disabled = true;
      });
      setFeedback(reportId === undefined ? copy.received : copy.receivedTracking.replace("{id}", reportId), "success");
      idempotencyKey = null;
    } catch {
      setFeedback(copy.networkError, "error");
      resetTurnstile();
    } finally {
      submit.disabled = feedback?.dataset.state === "success";
      submit.textContent = feedback?.dataset.state === "success" ? copy.sent : copy.submit;
    }
  })();
});
