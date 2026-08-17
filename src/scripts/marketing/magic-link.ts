/**
 * Minimal local magic-link flow for the redesigned login page.
 *
 * The password form ([data-login-form]) is handled by ./auth; this module owns
 * the separate [data-magic-link-form] block. It reuses the shared visible
 * email input ([data-login-email]) so visitors keep a single Email field, and
 * restores the debug-link sign-in path that local browser gates depend on:
 * request -> debug link -> fragment consume -> optional cross-browser
 * confirmation ([data-login-confirmation]).
 */
import { createSystemTranslator } from "../../lib/i18n";

const form = document.querySelector<HTMLFormElement>("[data-magic-link-form]");
const emailInput = document.querySelector<HTMLInputElement>("[data-login-email]");
const displayNameInput = document.querySelector<HTMLInputElement>("[data-magic-display-name]");
const statusElement = document.querySelector<HTMLElement>("[data-magic-status]");
const submitButton = document.querySelector<HTMLButtonElement>("[data-magic-submit]");
const confirmation = document.querySelector<HTMLElement>("[data-login-confirmation]");
const confirmationDestination = document.querySelector<HTMLElement>("[data-login-confirm-destination]");
const confirmButton = document.querySelector<HTMLButtonElement>("[data-login-confirm]");
const t = createSystemTranslator(document.documentElement.lang);

const messageKeys: Readonly<Record<string, string>> = {
  authentication_required: "auth.login.link_invalid",
  validation_failed: "auth.login.validation_failed",
  rate_limited: "auth.login.rate_limited",
  provider_unavailable: "auth.login.provider_unavailable",
  turnstile_invalid: "auth.login.challenge_invalid",
  turnstile_required: "auth.login.challenge_required",
  turnstile_unavailable: "auth.login.challenge_unavailable",
};
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/u;

let pendingMagicToken: string | null = null;

function setStatus(tone: "error" | "pending" | "success" | "", message: string): void {
  if (statusElement === null) return;
  if (tone === "") statusElement.removeAttribute("data-tone");
  else statusElement.dataset.tone = tone;
  statusElement.replaceChildren(message);
}

function setBusy(busy: boolean): void {
  if (submitButton === null) return;
  submitButton.disabled = busy;
  submitButton.setAttribute("aria-busy", String(busy));
}

function requestIdFrom(body: Record<string, unknown>, response: Response): string | null {
  const bodyRequestId = typeof body.requestId === "string" && REQUEST_ID.test(body.requestId) ? body.requestId : null;
  const headerRequestId = response.headers.get("X-Request-Id");
  return bodyRequestId ?? (headerRequestId !== null && REQUEST_ID.test(headerRequestId) ? headerRequestId : null);
}

function showRecovery(message: string, requestId: string | null): void {
  pendingMagicToken = null;
  if (form !== null) form.hidden = false;
  if (confirmation !== null) confirmation.hidden = true;
  if (confirmationDestination !== null) confirmationDestination.textContent = "";
  setStatus("error", requestId === null ? message : `${message} ${t("auth.login.request_id", { requestId })}`);
  emailInput?.focus();
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
    if (linkUrl.origin !== window.location.origin || linkUrl.pathname !== "/login") return false;
    const fragment = new URLSearchParams(linkUrl.hash.slice(1));
    const token = fragment.get("magic");
    if (linkUrl.search !== "" || token === null || token.length < 32
      || [...fragment.keys()].some((key) => key !== "magic")) return false;

    if (statusElement === null) return false;
    statusElement.replaceChildren(t("auth.login.debug_prefix"));
    const link = document.createElement("a");
    link.href = `${linkUrl.pathname}${linkUrl.hash}`;
    link.textContent = t("auth.login.debug_link");
    statusElement.insertAdjacentElement("beforeend", link);
    return true;
  } catch {
    return false;
  }
}

function showMagicLinkConfirmation(maskedDestination: string): void {
  if (form !== null) form.hidden = true;
  if (confirmationDestination !== null) confirmationDestination.textContent = maskedDestination;
  if (confirmation !== null) confirmation.hidden = false;
  confirmButton?.focus();
}

async function consumePendingMagicLink(confirm: boolean): Promise<void> {
  const token = pendingMagicToken;
  if (token === null) return;
  if (confirmButton !== null) confirmButton.disabled = true;
  if (!confirm) setStatus("pending", t("auth.login.pending"));
  try {
    const response = await fetch("/api/auth/magic-link/consume", {
      body: JSON.stringify({ confirm, token }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = await response.json();
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      // Safe generic handling below covers an empty provider response.
    }

    if (!response.ok) {
      const code = typeof body.code === "string" ? body.code : "unknown_error";
      const message = t(messageKeys[code] ?? "auth.login.generic_error");
      showRecovery(message, requestIdFrom(body, response));
      return;
    }

    if (body.confirmationRequired === true && typeof body.maskedDestination === "string") {
      showMagicLinkConfirmation(body.maskedDestination);
      return;
    }
    if (body.authenticated === true && body.redirectTo === "/app") {
      pendingMagicToken = null;
      // Give observers a beat to read the consume response body before the
      // navigation tears the page down.
      window.setTimeout(() => { window.location.assign("/app"); }, 120);
      return;
    }
    showRecovery(t("auth.login.generic_error"), requestIdFrom(body, response));
  } catch {
    showRecovery(t("auth.login.generic_error"), null);
  } finally {
    if (confirmButton !== null) confirmButton.disabled = false;
  }
}

function takeMagicTokenFromFragment(): string | null {
  if (window.location.hash.length === 0) return null;
  const magic = new URLSearchParams(window.location.hash.slice(1)).get("magic");
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return magic !== null && magic.length >= 20 && magic.length <= 256 ? magic : null;
}

function consumeMagicTokenFromFragment(): boolean {
  const fragmentToken = takeMagicTokenFromFragment();
  if (fragmentToken === null) return false;
  pendingMagicToken = fragmentToken;
  void consumePendingMagicLink(false);
  return true;
}

async function submitMagicLinkRequest(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (form === null || emailInput === null || statusElement === null) return;

  if (!emailInput.checkValidity()) {
    emailInput.setAttribute("aria-invalid", "true");
    setStatus("error", t("auth.login.validation_failed"));
    emailInput.focus();
    return;
  }
  emailInput.removeAttribute("aria-invalid");

  setBusy(true);
  setStatus("pending", t("auth.login.pending"));
  try {
    const localeQuery = new URLSearchParams({ lang: document.documentElement.lang });
    const displayName = displayNameInput?.value.trim() ?? "";
    const response = await fetch(`/api/auth/magic-link/request?${localeQuery.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: emailInput.value.trim(),
        ...(displayName.length > 0 ? { displayName } : {}),
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
      const message = t(messageKeys[code] ?? "auth.login.generic_error");
      const requestId = requestIdFrom(body, response);
      setStatus("error", requestId === null ? message : `${message} ${t("auth.login.request_id", { requestId })}`);
      return;
    }

    if (typeof body.debugMagicLink === "string" && appendLocalDebugLink(body.debugMagicLink)) {
      statusElement.dataset.tone = "success";
      return;
    }

    setStatus("success", t("auth.login.success"));
  } catch {
    setStatus("error", t("auth.login.provider_unavailable"));
  } finally {
    setBusy(false);
  }
}

form?.addEventListener("submit", (event) => {
  void submitMagicLinkRequest(event);
});
emailInput?.addEventListener("input", () => {
  emailInput.removeAttribute("aria-invalid");
  if (statusElement?.dataset.tone === "error") setStatus("", "");
});
confirmButton?.addEventListener("click", () => { void consumePendingMagicLink(true); });
window.addEventListener("hashchange", () => { consumeMagicTokenFromFragment(); });

void consumeMagicTokenFromFragment();

export {};
