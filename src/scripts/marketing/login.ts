import { createSystemTranslator } from "../../lib/i18n";
import { safeRelativeRedirect } from "../../lib/auth/redirect";

const form = document.querySelector<HTMLFormElement>("[data-magic-form]");
const email = document.querySelector<HTMLInputElement>("[data-magic-email]");
const statusElement = document.querySelector<HTMLElement>("[data-magic-status]");
const submit = document.querySelector<HTMLButtonElement>("[data-magic-submit]");
const submitLabel = document.querySelector<HTMLElement>("[data-magic-submit-label]");
const recovery = document.querySelector<HTMLElement>("[data-magic-recovery]");
const resend = document.querySelector<HTMLButtonElement>("[data-magic-resend]");
const restart = document.querySelector<HTMLButtonElement>("[data-magic-restart]");
const challenge = document.querySelector<HTMLElement>("[data-magic-challenge]");
const turnstileContainer = document.querySelector<HTMLElement>("[data-magic-turnstile]");
const confirmation = document.querySelector<HTMLElement>("[data-magic-confirmation]");
const confirmationDestination = document.querySelector<HTMLElement>("[data-magic-confirm-destination]");
const confirmMagicLink = document.querySelector<HTMLButtonElement>("[data-magic-confirm]");
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
type TurnstileApi = {
  render: (container: HTMLElement, options: {
    action: string;
    callback: (token: string) => void;
    "error-callback": () => void;
    "expired-callback": () => void;
    sitekey: string;
  }) => string;
  reset: (widgetId?: string) => void;
};

let challengeRequired = false;
let pendingMagicToken: string | null = null;
let turnstileRenderAttempts = 0;
let turnstileWidgetId: string | null = null;

function turnstileApi(): TurnstileApi | null {
  const candidate = (window as typeof window & { turnstile?: TurnstileApi }).turnstile;
  return candidate ?? null;
}

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

function showLinkRecovery(message: string, requestId: string | null): void {
  pendingMagicToken = null;
  if (form !== null) form.hidden = false;
  if (confirmation !== null) confirmation.hidden = true;
  if (confirmationDestination !== null) confirmationDestination.textContent = "";
  showRecovery();
  setStatus("error", requestId === null ? message : `${message} ${t("auth.login.request_id", { requestId })}`);
  email?.focus();
}

function clearAdaptiveChallenge(): void {
  challengeRequired = false;
  turnstileRenderAttempts = 0;
  if (challenge !== null) challenge.hidden = true;
  const turnstile = turnstileApi();
  if (turnstile !== null && turnstileWidgetId !== null) turnstile.reset(turnstileWidgetId);
}

function renderAdaptiveChallenge(): void {
  if (!challengeRequired || turnstileContainer === null || turnstileWidgetId !== null) return;
  const sitekey = turnstileContainer.dataset.sitekey;
  const turnstile = turnstileApi();
  if (sitekey === undefined || sitekey.length === 0) {
    setStatus("error", t("auth.login.challenge_unavailable"));
    return;
  }
  if (turnstile === null) {
    turnstileRenderAttempts += 1;
    if (turnstileRenderAttempts < 50) window.setTimeout(renderAdaptiveChallenge, 100);
    else setStatus("error", t("auth.login.challenge_unavailable"));
    return;
  }
  turnstileWidgetId = turnstile.render(turnstileContainer, {
    action: "magic_link_request",
    callback: () => { form?.requestSubmit(); },
    "error-callback": () => { setStatus("error", t("auth.login.challenge_unavailable")); },
    "expired-callback": () => {
      setStatus("pending", t("auth.login.challenge_required"));
      if (turnstileWidgetId !== null) turnstile.reset(turnstileWidgetId);
    },
    sitekey,
  });
}

function showAdaptiveChallenge(): void {
  challengeRequired = true;
  if (challenge !== null) challenge.hidden = false;
  setStatus("pending", t("auth.login.challenge_required"));
  renderAdaptiveChallenge();
}

function restartLogin(): void {
  form?.reset();
  if (form !== null) form.hidden = false;
  if (confirmation !== null) confirmation.hidden = true;
  pendingMagicToken = null;
  clearAdaptiveChallenge();
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
    if (linkUrl.origin !== window.location.origin || linkUrl.pathname !== "/login") return false;
    const fragment = new URLSearchParams(linkUrl.hash.slice(1));
    const token = fragment.get("magic");
    const redirect = linkUrl.searchParams.get("redirect");
    if ([...linkUrl.searchParams.keys()].some((key) => key !== "redirect")
      || (redirect !== null && safeRelativeRedirect(redirect, "") !== redirect)
      || token === null || token.length < 32
      || [...fragment.keys()].some((key) => key !== "magic")) return false;

    if (statusElement === null) return false;
    statusElement.replaceChildren(t("auth.login.debug_prefix"));
    const link = document.createElement("a");
    link.href = `${linkUrl.pathname}${linkUrl.search}${linkUrl.hash}`;
    link.textContent = t("auth.login.debug_link");
    statusElement.insertAdjacentElement("beforeend", link);
    return true;
  } catch {
    return false;
  }
}

function setAuthMode(mode: string): void {
  document.querySelectorAll<HTMLElement>("[data-mode-tab]").forEach((tab) => {
    const active = tab.dataset.modeTab === mode;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll<HTMLElement>("[data-mode-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.modePanel !== mode;
  });
}

function setupModeToggle(): void {
  document.querySelectorAll<HTMLElement>("[data-mode-tab]").forEach((tab) => {
    tab.addEventListener("click", () => { setAuthMode(tab.dataset.modeTab ?? "password"); });
  });
}

function activateMagicMode(): void {
  setAuthMode("magic");
}

function showMagicLinkConfirmation(maskedDestination: string): void {
  activateMagicMode();
  if (form !== null) form.hidden = true;
  if (recovery !== null) recovery.hidden = true;
  if (confirmationDestination !== null) confirmationDestination.textContent = maskedDestination;
  if (confirmation !== null) confirmation.hidden = false;
  confirmMagicLink?.focus();
}

async function consumePendingMagicLink(confirm: boolean): Promise<void> {
  const token = pendingMagicToken;
  if (token === null) return;
  if (confirmMagicLink !== null) confirmMagicLink.disabled = true;
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
      const bodyRequestId = typeof body.requestId === "string" && REQUEST_ID.test(body.requestId) ? body.requestId : null;
      const headerRequestId = response.headers.get("X-Request-Id");
      const requestId = bodyRequestId ?? (headerRequestId !== null && REQUEST_ID.test(headerRequestId) ? headerRequestId : null);
      const message = t(messageKeys[code] ?? "auth.login.generic_error");
      showLinkRecovery(message, requestId);
      return;
    }

    if (body.confirmationRequired === true && typeof body.maskedDestination === "string") {
      showMagicLinkConfirmation(body.maskedDestination);
      return;
    }
    if (body.authenticated === true && body.redirectTo === "/app") {
      pendingMagicToken = null;
      window.location.assign(safeRelativeRedirect(new URLSearchParams(window.location.search).get("redirect")));
      return;
    }
    throw new Error("magic_link_response_invalid");
  } catch {
    showLinkRecovery(t("auth.login.generic_error"), null);
  } finally {
    if (confirmMagicLink !== null) confirmMagicLink.disabled = false;
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

email?.addEventListener("input", () => {
  email.removeAttribute("aria-invalid");
  if (challengeRequired) clearAdaptiveChallenge();
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
  const turnstileToken = data.get("cf-turnstile-response");
  if (challengeRequired && (typeof turnstileToken !== "string" || turnstileToken.length === 0)) {
    setBusy(false);
    showAdaptiveChallenge();
    return;
  }
  try {
    const localeQuery = new URLSearchParams({ lang: document.documentElement.lang });
    const redirect = safeRelativeRedirect(new URLSearchParams(window.location.search).get("redirect"), "");
    const response = await fetch(`/api/auth/magic-link/request?${localeQuery.toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: data.get("email"),
        displayName: data.get("displayName") || undefined,
        ...(redirect === "" ? {} : { redirect }),
        ...(typeof turnstileToken === "string" && turnstileToken.length > 0 ? { turnstileToken } : {}),
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
      if (code === "turnstile_invalid" || code === "turnstile_required") {
        showAdaptiveChallenge();
        const turnstile = turnstileApi();
        if (turnstile !== null && turnstileWidgetId !== null) turnstile.reset(turnstileWidgetId);
      }
      return;
    }

    if (body.challengeRequired === true) {
      showAdaptiveChallenge();
      return;
    }

    clearAdaptiveChallenge();
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
confirmMagicLink?.addEventListener("click", () => { void consumePendingMagicLink(true); });
window.addEventListener("hashchange", () => { consumeMagicTokenFromFragment(); });
setupModeToggle();

if (!consumeMagicTokenFromFragment() && form?.dataset.authenticatedSession === "true") {
  window.location.replace(safeRelativeRedirect(new URLSearchParams(window.location.search).get("redirect")));
}

export {};
