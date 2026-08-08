import { createSystemTranslator } from "../../lib/i18n";

const form = document.querySelector<HTMLFormElement>("[data-login-form]");
const email = document.querySelector<HTMLInputElement>("[data-login-email]");
const statusElement = document.querySelector<HTMLElement>("[data-login-status]");
const submit = document.querySelector<HTMLButtonElement>("[data-login-submit]");
const submitLabel = document.querySelector<HTMLElement>("[data-login-submit-label]");
const recovery = document.querySelector<HTMLElement>("[data-login-recovery]");
const resend = document.querySelector<HTMLButtonElement>("[data-login-resend]");
const restart = document.querySelector<HTMLButtonElement>("[data-login-restart]");
const t = createSystemTranslator(document.documentElement.lang);

const messageKeys: Readonly<Record<string, string>> = {
  validation_failed: "auth.login.validation_failed",
  rate_limited: "auth.login.rate_limited",
  provider_unavailable: "auth.login.provider_unavailable",
};
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/u;

function setStatus(tone: "error" | "pending" | "success" | "", message: string): void {
  if (statusElement === null) return;
  if (tone === "") statusElement.removeAttribute("data-tone");
  else statusElement.dataset.tone = tone;
  statusElement.replaceChildren(message);
}

function setBusy(busy: boolean): void {
  if (submit === null) return;
  submit.disabled = busy;
  submit.setAttribute("aria-busy", String(busy));
  if (submitLabel !== null) submitLabel.textContent = t(busy ? "auth.login.submitting" : "auth.login.submit");
}

function showRecovery(): void {
  if (recovery !== null) recovery.hidden = false;
}

function restartLogin(): void {
  form?.reset();
  if (recovery !== null) recovery.hidden = true;
  setStatus("", "");
  email?.removeAttribute("aria-invalid");
  email?.focus();
}

function isLocalDebugOrigin(): boolean {
  const hostname = window.location.hostname.toLowerCase();
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "127.0.0.1"
    || hostname === "[::1]";
}

function appendLocalDebugLink(value: string): boolean {
  if (!isLocalDebugOrigin()) return false;
  try {
    const linkUrl = new URL(value, window.location.origin);
    if (linkUrl.origin !== window.location.origin || linkUrl.pathname !== "/api/auth/magic-link/consume") return false;
    const token = linkUrl.searchParams.get("token");
    if (token === null || token.length < 32 || [...linkUrl.searchParams.keys()].some((key) => key !== "token")) return false;

    if (statusElement === null) return false;
    statusElement.replaceChildren(t("auth.login.debug_prefix"));
    const link = document.createElement("a");
    link.href = `${linkUrl.pathname}${linkUrl.search}`;
    link.textContent = t("auth.login.debug_link");
    statusElement.insertAdjacentElement("beforeend", link);
    return true;
  } catch {
    return false;
  }
}

email?.addEventListener("input", () => {
  email.removeAttribute("aria-invalid");
  if (statusElement?.dataset.tone === "error") setStatus("", "");
});

async function submitLogin(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (form === null || email === null || statusElement === null) return;

  if (!email.checkValidity()) {
    email.setAttribute("aria-invalid", "true");
    setStatus("error", t("auth.login.validation_failed"));
    email.focus();
    return;
  }

  setBusy(true);
  setStatus("pending", t("auth.login.pending"));
  const data = new FormData(form);
  try {
    const localeQuery = new URLSearchParams({ lang: document.documentElement.lang });
    const response = await fetch(`/api/auth/magic-link/request?${localeQuery.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: data.get("email"),
        displayName: data.get("displayName") || undefined,
      }),
    });

    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      // A provider failure may return an empty or non-JSON response.
    }

    if (!response.ok) {
      const code = typeof body.code === "string" ? body.code : "unknown_error";
      const bodyRequestId = typeof body.requestId === "string" && REQUEST_ID.test(body.requestId) ? body.requestId : null;
      const headerRequestId = response.headers.get("X-Request-Id");
      const requestId = bodyRequestId ?? (headerRequestId !== null && REQUEST_ID.test(headerRequestId) ? headerRequestId : null);
      const message = t(messageKeys[code] ?? "auth.login.generic_error");
      setStatus("error", requestId === null ? message : `${message} ${t("auth.login.request_id", { requestId })}`);
      return;
    }

    if (typeof body.debugMagicLink === "string" && appendLocalDebugLink(body.debugMagicLink)) {
      statusElement.dataset.tone = "success";
      showRecovery();
      return;
    }

    setStatus("success", t("auth.login.success"));
    showRecovery();
  } catch {
    setStatus("error", t("auth.login.provider_unavailable"));
  } finally {
    setBusy(false);
  }
}

form?.addEventListener("submit", (event) => {
  void submitLogin(event);
});
resend?.addEventListener("click", () => { form?.requestSubmit(); });
restart?.addEventListener("click", restartLogin);

export {};
