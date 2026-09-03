import { safeRelativeRedirect } from "../../lib/auth/redirect";
import { createSystemTranslator } from "../../lib/i18n";

const t = createSystemTranslator(document.documentElement.lang || "vi-VN");
const query = new URLSearchParams(window.location.search);
const statusEl = document.querySelector<HTMLElement>("[data-google-status]");
const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-google-oauth]")];

const setStatus = (message: string): void => {
  if (statusEl === null) return;
  statusEl.textContent = message;
  statusEl.hidden = message === "";
};

const removeGoogleQuery = (): void => {
  const next = new URL(window.location.href);
  next.searchParams.delete("google_error");
  next.searchParams.delete("google");
  window.history.replaceState({}, "", `${next.pathname}${next.search}${next.hash}`);
};

const googleErrorMessage = (code: string | null): string => {
  switch (code) {
    case "access_denied": return t("auth.google.error.access_denied");
    case "account_linking_required":
    case "google_account_link_required": return t("auth.google.error.account_linking_required");
    case "email_not_verified":
    case "google_email_mismatch": return t("auth.google.error.email_not_verified");
    case "provider_error":
    case "provider_unavailable": return t("auth.google.error.provider_unavailable");
    case "state_invalid": return t("auth.google.error.state_invalid");
    case "google_failed": return t("auth.google.error.generic");
    case "google_account_not_found": return t("auth.google.error.account_not_found");
    default: return t("auth.google.error.generic");
  }
};

const callbackError = query.get("google_error") ?? query.get("google");
if (query.has("google_error")) {
  setStatus(googleErrorMessage(callbackError));
  removeGoogleQuery();
} else if (callbackError === "access_denied" || callbackError === "provider_unavailable" || callbackError === "provider_error") {
  setStatus(googleErrorMessage(callbackError));
  removeGoogleQuery();
}

for (const button of buttons) {
  button.addEventListener("click", () => {
    const flow = button.dataset.googleFlow === "register" ? "register" : "login";
    const redirect = safeRelativeRedirect(
      button.dataset.googleRedirect ?? query.get("redirect"),
      flow === "register" ? "/onboarding" : "",
    );
    const start = new URL("/api/auth/google/start", window.location.origin);
    start.searchParams.set("flow", flow);
    if (redirect !== "") start.searchParams.set("redirect", redirect);
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    setStatus(t("auth.google.pending"));
    window.location.assign(`${start.pathname}${start.search}`);
  });
}
