import {
  loadErrorState,
  paymentState,
  safeErrorMessage,
  type IntegrationState,
  type PaymentIntegrationLike,
} from "../../lib/dashboard/integrations-view";

export {};

type JsonObject = Record<string, unknown>;
type SafeError = { code: string; requestId: string | null };

class PaymentsApiError extends Error {
  readonly requestId: string | null;

  constructor(code: string, requestId: string | null) {
    super(code);
    this.name = "PaymentsApiError";
    this.requestId = requestId;
  }
}

class TenantChangedError extends Error {
  constructor() {
    super("tenant_changed");
    this.name = "TenantChangedError";
  }
}

const root = document.querySelector<HTMLElement>("[data-payments-workspace]");

if (root !== null) {
  const shopPublicId = root.dataset.shopPublicId;
  const timeZone = root.dataset.timeZone ?? "Asia/Ho_Chi_Minh";
  const locale = root.dataset.locale;
  const copy = (() => {
    try {
      const parsed: unknown = JSON.parse(root.dataset.copy ?? "{}");
      return typeof parsed === "object" && parsed !== null ? parsed as Record<string, string> : {};
    } catch {
      return {};
    }
  })();
  const text = (key: string): string => copy[key] ?? "";
  const canManageProviders = root.dataset.canManageProviders === "true";
  const canReadProviders = root.dataset.canReadProviders === "true";
  const canRefreshPayos = root.dataset.canRefreshPayos === "true";
  const feedback = root.querySelector<HTMLElement>("[data-workspace-feedback]");
  const refreshPayos = root.querySelector<HTMLButtonElement>("[data-refresh-payos]");
  const configPanel = root.querySelector<HTMLElement>("[data-config-panel]");
  const configFeedback = root.querySelector<HTMLElement>("[data-config-feedback]");
  const credentialForm = root.querySelector<HTMLFormElement>("[data-credential-form=\"payos\"]");
  const disconnectPanel = root.querySelector<HTMLElement>("[data-disconnect-panel]");
  let sensitiveActionPending = false;

  const readCookie = (name: string): string | null => document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? null;

  const setFeedback = (target: HTMLElement | null, message: string, tone: "danger" | "info" | "success" | "warning" = "info"): void => {
    if (target === null) return;
    target.textContent = message;
    target.dataset.tone = tone;
    target.hidden = message.length === 0;
    target.setAttribute("role", tone === "danger" ? "alert" : "status");
  };

  const row = (): HTMLElement | null => root.querySelector<HTMLElement>("[data-provider-row=\"payos\"]");

  const tenantSignature = (): string => {
    const urlShopPublicId = new URL(window.location.href).searchParams.get("shop") ?? "";
    return `${root.dataset.shopPublicId ?? ""}\u0000${urlShopPublicId}`;
  };
  let activeTenantSignature = tenantSignature();

  const resetTenantBoundState = (): void => {
    // A client-side transition can replace the shop URL before replacing this
    // page's DOM. Clear entity-bound projections so the old shop is never
    // mutated or presented while the next tenant is loading.
    configPanel?.setAttribute("hidden", "");
    if (credentialForm !== null) {
      credentialForm.hidden = true;
      credentialForm.reset();
    }
    disconnectPanel?.setAttribute("hidden", "");
    const providerRow = row();
    if (providerRow !== null) {
      providerRow.dataset.readable = "false";
      providerRow.querySelector<HTMLElement>("[data-summary]")?.replaceChildren(document.createTextNode(text("reading")));
      providerRow.querySelector<HTMLElement>("[data-last-check]")?.replaceChildren(document.createTextNode(""));
      providerRow.querySelector<HTMLElement>("[data-error]")?.setAttribute("hidden", "");
    }
    setFeedback(feedback, "", "info");
  };

  const ensureTenantContext = (): boolean => {
    const currentSignature = tenantSignature();
    if (currentSignature === activeTenantSignature) return true;
    activeTenantSignature = currentSignature;
    resetTenantBoundState();
    return false;
  };

  const assertTenantContext = (requestSignature: string): void => {
    if (!ensureTenantContext() || activeTenantSignature !== requestSignature) throw new TenantChangedError();
  };
  const isTenantChangedError = (error: unknown): error is TenantChangedError => error instanceof TenantChangedError;

  const safeRequestId = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9._-]{8,128}$/u.test(value) ? value : null;
  const readSafeError = (value: unknown): SafeError => {
    const object = typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
    return { code: typeof object.code === "string" ? object.code : "internal_error", requestId: safeRequestId(object.requestId) };
  };
  const apiErrorMessage = (error: unknown): string => error instanceof PaymentsApiError
    ? safeErrorMessage(error.message, error.requestId, locale)
    : safeErrorMessage(error, undefined, locale);

  const requestApi = async (url: string, options: RequestInit = {}): Promise<JsonObject | null> => {
    const requestSignature = activeTenantSignature;
    const headers = new Headers(options.headers);
    const method = options.method?.toUpperCase() ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      const csrfCookieName = root.dataset.csrfCookieName ?? "";
      const csrf = readCookie(csrfCookieName);
      if (csrf === null) throw new PaymentsApiError("csrf_missing", null);
      headers.set("X-CSRF-Token", decodeURIComponent(csrf));
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(url, { ...options, credentials: "same-origin", headers });
    const contentType = response.headers.get("Content-Type") ?? "";
    const payload: unknown = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
    assertTenantContext(requestSignature);
    if (!response.ok) {
      const safe = readSafeError(payload);
      throw new PaymentsApiError(safe.code, safe.requestId);
    }
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as JsonObject : null;
  };

  const setRowState = (state: IntegrationState): void => {
    const item = row();
    if (item === null) return;
    const badge = item.querySelector<HTMLElement>(".sln-status");
    if (badge !== null) {
      badge.textContent = "";
      badge.dataset.tone = state.tone;
      const dot = document.createElement("span");
      dot.setAttribute("aria-hidden", "true");
      badge.appendChild(dot);
      badge.appendChild(document.createTextNode(state.label));
    }
    const summary = item.querySelector<HTMLElement>("[data-summary]");
    if (summary !== null) summary.textContent = state.summary;
    const checked = item.querySelector<HTMLElement>("[data-last-check]");
    if (checked !== null) checked.textContent = state.checked;
    const error = item.querySelector<HTMLElement>("[data-error]");
    if (error !== null) {
      error.textContent = state.error ?? "";
      error.hidden = state.error === null;
    }
  };

  const isConnected = (view: { status: string } | null): boolean => view !== null && view.status !== "disabled" && view.status !== "disconnected";
  const configureActions = (view: { status: string } | null): void => {
    const item = row();
    if (item === null) return;
    const connected = isConnected(view);
    const configure = item.querySelector<HTMLButtonElement>("[data-action=configure]");
    if (configure !== null) configure.textContent = connected ? text("update") : text("connect");
    const health = item.querySelector<HTMLButtonElement>("[data-action=health]");
    if (health !== null) health.hidden = !connected || !canRefreshPayos;
    let disconnect = item.querySelector<HTMLButtonElement>("[data-action=disconnect]");
    if (connected && disconnect === null && canManageProviders) {
      disconnect = document.createElement("button");
      disconnect.type = "button";
      disconnect.className = "text-action danger-text";
      disconnect.dataset.action = "disconnect";
      disconnect.textContent = text("disconnect");
      item.querySelector<HTMLElement>(".provider-actions")?.appendChild(disconnect);
    }
    if (disconnect !== null) disconnect.hidden = !canManageProviders || !connected;
    if (configure !== null) configure.hidden = !canManageProviders;
  };

  const integrationFrom = (payload: JsonObject | null): JsonObject | null => {
    const value = payload?.integration;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
  };
  const applyPayos = (view: PaymentIntegrationLike | null): void => {
    setRowState(paymentState(view, timeZone, locale));
    configureActions(view);
    row()?.setAttribute("data-readable", "true");
  };

  const refreshState = async (): Promise<void> => {
    if (shopPublicId === undefined || !canReadProviders) return;
    if (refreshPayos !== null) {
      refreshPayos.disabled = true;
      refreshPayos.textContent = text("refreshing");
    }
    setFeedback(feedback, text("reading"), "info");
    try {
      const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/payments/payos`);
      applyPayos(integrationFrom(payload) as PaymentIntegrationLike | null);
      setFeedback(feedback, text("refreshed"), "success");
    } catch (error) {
      if (isTenantChangedError(error)) return;
      setRowState(loadErrorState("PayOS", error, locale));
      row()?.setAttribute("data-readable", "false");
      setFeedback(feedback, text("partial"), "warning");
    } finally {
      if (refreshPayos !== null) {
        refreshPayos.disabled = false;
        refreshPayos.textContent = text("refresh");
      }
    }
  };

  const openConfig = (): void => {
    if (!canManageProviders || configPanel === null || credentialForm === null || sensitiveActionPending) return;
    credentialForm.hidden = false;
    if (disconnectPanel !== null) disconnectPanel.hidden = true;
    setFeedback(configFeedback, "");
    configPanel.hidden = false;
    configPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    credentialForm.querySelector<HTMLInputElement>("input")?.focus();
  };

  const closeConfig = (): void => {
    if (sensitiveActionPending) return;
    if (configPanel !== null) configPanel.hidden = true;
    if (credentialForm !== null) {
      credentialForm.hidden = true;
      credentialForm.reset();
    }
    if (disconnectPanel !== null) disconnectPanel.hidden = true;
  };

  const submitCredential = async (): Promise<void> => {
    if (shopPublicId === undefined || credentialForm === null || sensitiveActionPending || !credentialForm.reportValidity()) return;
    const formData = new FormData(credentialForm);
    const body: JsonObject = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string" && value.trim().length > 0) body[key] = value;
    }
    const submit = credentialForm.querySelector<HTMLButtonElement>("button[type=submit]");
    if (submit === null) return;
    const originalSubmitLabel = submit.textContent;
    sensitiveActionPending = true;
    submit.disabled = true;
    submit.textContent = text("verifying");
    setFeedback(configFeedback, text("sending"), "info");
    try {
      const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/payments/payos`, { method: "PUT", body: JSON.stringify(body) });
      if (!ensureTenantContext()) return;
      applyPayos(integrationFrom(payload) as PaymentIntegrationLike | null);
      credentialForm.reset();
      setFeedback(configFeedback, text("updated"), "success");
    } catch (error) {
      if (isTenantChangedError(error)) return;
      credentialForm.reset();
      setFeedback(configFeedback, apiErrorMessage(error), "danger");
    } finally {
      sensitiveActionPending = false;
      submit.disabled = false;
      submit.textContent = originalSubmitLabel;
    }
  };

  const healthCheck = async (): Promise<void> => {
    if (shopPublicId === undefined || sensitiveActionPending || !canRefreshPayos) return;
    const button = row()?.querySelector<HTMLButtonElement>("[data-action=health]") ?? null;
    sensitiveActionPending = true;
    if (button !== null) {
      button.disabled = true;
      button.textContent = text("checking");
    }
    try {
      const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/payments/payos/health-checks`, { method: "POST", body: "{}" });
      if (!ensureTenantContext()) return;
      applyPayos(integrationFrom(payload) as PaymentIntegrationLike | null);
      setFeedback(feedback, text("healthUpdated"), "success");
    } catch (error) {
      if (isTenantChangedError(error)) return;
      setFeedback(feedback, apiErrorMessage(error), "danger");
    } finally {
      sensitiveActionPending = false;
      if (button !== null) {
        button.disabled = false;
        button.textContent = text("health");
      }
    }
  };

  const openDisconnect = (): void => {
    if (!canManageProviders || sensitiveActionPending) return;
    if (credentialForm !== null) credentialForm.hidden = true;
    if (disconnectPanel !== null) disconnectPanel.hidden = false;
    if (configPanel !== null) {
      configPanel.hidden = false;
      configPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const confirmDisconnect = async (): Promise<void> => {
    if (shopPublicId === undefined || sensitiveActionPending) return;
    const button = root.querySelector<HTMLButtonElement>("[data-action=confirm-disconnect]");
    sensitiveActionPending = true;
    if (button !== null) {
      button.disabled = true;
      button.textContent = text("disconnecting");
    }
    try {
      await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/payments/payos`, { method: "DELETE" });
      if (!ensureTenantContext()) return;
      applyPayos(null);
      sensitiveActionPending = false;
      closeConfig();
      setFeedback(feedback, text("disconnected"), "success");
    } catch (error) {
      if (isTenantChangedError(error)) return;
      setFeedback(configFeedback, apiErrorMessage(error), "danger");
    } finally {
      sensitiveActionPending = false;
      if (button !== null) {
        button.disabled = false;
        button.textContent = text("disconnectConfirm");
      }
    }
  };

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionTarget = target.closest<HTMLElement>("[data-action]");
    const action = actionTarget?.dataset.action;
    if (action === "configure") openConfig();
    if (action === "health") void healthCheck();
    if (action === "disconnect") openDisconnect();
    if (action === "close-config") closeConfig();
    if (action === "confirm-disconnect") void confirmDisconnect();
  });
  credentialForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitCredential();
  });
  refreshPayos?.addEventListener("click", () => void refreshState());
  window.addEventListener("popstate", () => { ensureTenantContext(); });
  window.addEventListener("pageshow", () => { ensureTenantContext(); });
}
