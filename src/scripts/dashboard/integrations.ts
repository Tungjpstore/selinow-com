import {
  domainState,
  loadErrorState,
  paymentState,
  safeErrorMessage,
  telegramState,
  type DomainLike,
  type IntegrationState,
  type PaymentIntegrationLike,
  type TelegramIntegrationLike,
} from "../../lib/dashboard/integrations-view";

export {};

type Provider = "telegram" | "payos";
type JsonObject = Record<string, unknown>;
type SafeError = { code: string; requestId: string | null };

class IntegrationApiError extends Error {
  readonly requestId: string | null;

  constructor(code: string, requestId: string | null) {
    super(code);
    this.name = "IntegrationApiError";
    this.requestId = requestId;
  }
}

const root = document.querySelector<HTMLElement>("[data-integrations-workspace]");

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
  const canManageDomains = root.dataset.canManageDomains === "true";
  const canRefreshPayos = root.dataset.canRefreshPayos === "true";
  const feedback = root.querySelector<HTMLElement>("[data-workspace-feedback]");
  const configPanel = root.querySelector<HTMLElement>("[data-config-panel]");
  const configTitle = root.querySelector<HTMLElement>("#config-title");
  const configFeedback = root.querySelector<HTMLElement>("[data-config-feedback]");
  const refreshAll = root.querySelector<HTMLButtonElement>("[data-refresh-all]");
  const credentialForms = [...root.querySelectorAll<HTMLFormElement>("[data-credential-form]")];
  const disconnectPanel = root.querySelector<HTMLElement>("[data-disconnect-panel]");
  const disconnectCopy = root.querySelector<HTMLElement>("[data-disconnect-copy]");
  let disconnectProvider: Provider | null = null;
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

  const safeRequestId = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9._-]{8,128}$/u.test(value) ? value : null;
  const readSafeError = (value: unknown): SafeError => {
    const object = typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : {};
    return { code: typeof object.code === "string" ? object.code : "internal_error", requestId: safeRequestId(object.requestId) };
  };
  const apiErrorMessage = (error: unknown): string => error instanceof IntegrationApiError
    ? safeErrorMessage(error.message, error.requestId, locale)
    : safeErrorMessage(error, undefined, locale);

  const requestApi = async (url: string, options: RequestInit = {}): Promise<JsonObject | null> => {
    const headers = new Headers(options.headers);
    const method = options.method?.toUpperCase() ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      const csrfCookieName = root.dataset.csrfCookieName ?? "";
      const csrf = readCookie(csrfCookieName);
      if (csrf === null) throw new IntegrationApiError("csrf_missing", null);
      headers.set("X-CSRF-Token", decodeURIComponent(csrf));
      headers.set("Content-Type", "application/json");
    }
    const response = await fetch(url, { ...options, credentials: "same-origin", headers });
    const contentType = response.headers.get("Content-Type") ?? "";
    const payload: unknown = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
    if (!response.ok) {
      const safe = readSafeError(payload);
      throw new IntegrationApiError(safe.code, safe.requestId);
    }
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as JsonObject : null;
  };

  const row = (provider: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-provider-row="${provider}"]`);
  const setRowState = (provider: string, state: IntegrationState): void => {
    const item = row(provider);
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
  const configureActions = (provider: Provider, view: { status: string } | null): void => {
    const item = row(provider);
    if (item === null) return;
    const connected = isConnected(view);
    const configure = item.querySelector<HTMLButtonElement>("[data-action=configure]");
    if (configure !== null) configure.textContent = connected ? text("update") : text("connect");
    const health = item.querySelector<HTMLButtonElement>("[data-action=health]");
    if (health !== null) health.hidden = !connected || (provider === "payos" && !canRefreshPayos);
    let disconnect = item.querySelector<HTMLButtonElement>("[data-action=disconnect]");
    if (connected && disconnect === null) {
      disconnect = document.createElement("button");
      disconnect.type = "button";
      disconnect.className = "text-action danger-text";
      disconnect.dataset.action = "disconnect";
      disconnect.textContent = text("disconnect");
      item.querySelector<HTMLElement>(".provider-actions")?.appendChild(disconnect);
    }
    if (disconnect !== null) disconnect.hidden = !connected;
  };

  const integrationFrom = (payload: JsonObject | null): JsonObject | null => {
    const value = payload?.integration;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
  };
  const domainsFrom = (payload: JsonObject | null): DomainLike[] => {
    const value = payload?.domains;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is DomainLike => typeof item === "object" && item !== null);
  };

  const applyTelegram = (view: TelegramIntegrationLike | null): void => {
    setRowState("telegram", telegramState(view, timeZone, locale));
    configureActions("telegram", view);
    row("telegram")?.setAttribute("data-readable", "true");
  };
  const applyPayos = (view: PaymentIntegrationLike | null): void => {
    setRowState("payos", paymentState(view, timeZone, locale));
    configureActions("payos", view);
    row("payos")?.setAttribute("data-readable", "true");
  };
  const applyDomains = (views: readonly DomainLike[]): void => {
    setRowState("domains", domainState(views, timeZone, locale));
    row("domains")?.setAttribute("data-readable", "true");
  };

  const refreshStates = async (): Promise<void> => {
    if (shopPublicId === undefined) return;
    if (refreshAll !== null) {
      refreshAll.disabled = true;
      refreshAll.textContent = text("refreshing");
    }
    setFeedback(feedback, text("reading"), "info");
    let failed = false;
    const base = `/api/app/shops/${encodeURIComponent(shopPublicId)}`;
    if (canManageProviders) {
      const [telegramResult, payosResult] = await Promise.allSettled([
        requestApi(`${base}/integrations/telegram`),
        requestApi(`${base}/payments/payos`),
      ]);
      if (telegramResult.status === "fulfilled") applyTelegram(integrationFrom(telegramResult.value) as TelegramIntegrationLike | null);
      else {
        failed = true;
        setRowState("telegram", loadErrorState("Telegram", telegramResult.reason, locale));
        row("telegram")?.setAttribute("data-readable", "false");
      }
      if (payosResult.status === "fulfilled") applyPayos(integrationFrom(payosResult.value) as PaymentIntegrationLike | null);
      else {
        failed = true;
        setRowState("payos", loadErrorState("PayOS", payosResult.reason, locale));
        row("payos")?.setAttribute("data-readable", "false");
      }
    }
    if (canManageDomains) {
      try { applyDomains(domainsFrom(await requestApi(`${base}/domains`))); }
      catch (error) {
        failed = true;
        setRowState("domains", loadErrorState("domain", error, locale));
        row("domains")?.setAttribute("data-readable", "false");
      }
    }
    setFeedback(feedback, failed ? text("partial") : text("refreshed"), failed ? "warning" : "success");
    if (refreshAll !== null) {
      refreshAll.disabled = false;
      refreshAll.textContent = text("refresh");
    }
  };

  const openConfig = (provider: Provider): void => {
    if (!canManageProviders || configPanel === null || sensitiveActionPending) return;
    for (const form of credentialForms) form.hidden = form.dataset.credentialForm !== provider;
    const form = credentialForms.find((candidate) => candidate.dataset.credentialForm === provider);
    if (form === undefined) return;
    if (disconnectPanel !== null) disconnectPanel.hidden = true;
    if (configTitle !== null) configTitle.textContent = provider === "telegram" ? text("connectTelegram") : text("connectPayos");
    setFeedback(configFeedback, "");
    configPanel.hidden = false;
    configPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    form.querySelector<HTMLInputElement>("input")?.focus();
  };

  const closeConfig = (): void => {
    if (sensitiveActionPending) return;
    if (configPanel !== null) configPanel.hidden = true;
    for (const form of credentialForms) {
      form.hidden = true;
      form.reset();
    }
    disconnectProvider = null;
  };

  const submitCredential = async (form: HTMLFormElement, provider: Provider): Promise<void> => {
    if (shopPublicId === undefined || sensitiveActionPending || !form.reportValidity()) return;
    const formData = new FormData(form);
    const body: JsonObject = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string" && value.trim().length > 0 && key !== "replaceBot") body[key] = value;
    }
    if (provider === "telegram") body.replaceBot = formData.get("replaceBot") === "on";
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (submit === null) return;
    const originalSubmitLabel = submit.textContent;
    sensitiveActionPending = true;
    submit.disabled = true;
    submit.textContent = text("verifying");
    setFeedback(configFeedback, text("sending"), "info");
    try {
      const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/${provider === "telegram" ? "integrations/telegram" : "payments/payos"}`, { method: "PUT", body: JSON.stringify(body) });
      if (provider === "telegram") applyTelegram(integrationFrom(payload) as TelegramIntegrationLike | null);
      else applyPayos(integrationFrom(payload) as PaymentIntegrationLike | null);
      form.reset();
      setFeedback(configFeedback, text("updated"), "success");
    } catch (error) {
      form.reset();
      setFeedback(configFeedback, apiErrorMessage(error), "danger");
    } finally {
      sensitiveActionPending = false;
      submit.disabled = false;
      submit.textContent = originalSubmitLabel;
    }
  };

  const healthCheck = async (provider: Provider): Promise<void> => {
    if (shopPublicId === undefined || sensitiveActionPending || (provider === "payos" && !canRefreshPayos)) return;
    const button = row(provider)?.querySelector<HTMLButtonElement>("[data-action=health]");
    sensitiveActionPending = true;
    if (button !== null && button !== undefined) {
      button.disabled = true;
      button.textContent = text("checking");
    }
    try {
      const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/${provider === "telegram" ? "integrations/telegram/health-checks" : "payments/payos/health-checks"}`, { method: "POST", body: "{}" });
      if (provider === "telegram") applyTelegram(integrationFrom(payload) as TelegramIntegrationLike | null);
      else applyPayos(integrationFrom(payload) as PaymentIntegrationLike | null);
      setFeedback(feedback, text("healthUpdated"), "success");
    } catch (error) {
      setFeedback(feedback, apiErrorMessage(error), "danger");
    } finally {
      sensitiveActionPending = false;
      if (button !== null && button !== undefined) {
        button.disabled = false;
        button.textContent = text("health");
      }
    }
  };

  const openDisconnect = (provider: Provider): void => {
    if (!canManageProviders || sensitiveActionPending) return;
    disconnectProvider = provider;
    for (const form of credentialForms) form.hidden = true;
    if (disconnectPanel !== null) disconnectPanel.hidden = false;
    if (configTitle !== null) configTitle.textContent = text("disconnectTitle");
    if (disconnectCopy !== null) disconnectCopy.textContent = provider === "telegram"
      ? text("disconnectTelegram")
      : text("disconnectPayos");
    if (configPanel !== null) {
      configPanel.hidden = false;
      configPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const confirmDisconnect = async (): Promise<void> => {
    if (shopPublicId === undefined || disconnectProvider === null || sensitiveActionPending) return;
    const provider = disconnectProvider;
    const button = root.querySelector<HTMLButtonElement>("[data-action=confirm-disconnect]");
    sensitiveActionPending = true;
    if (button !== null) {
      button.disabled = true;
      button.textContent = text("disconnecting");
    }
    try {
      await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/${provider === "telegram" ? "integrations/telegram" : "payments/payos"}`, { method: "DELETE" });
      if (provider === "telegram") applyTelegram(null);
      else applyPayos(null);
      sensitiveActionPending = false;
      closeConfig();
      setFeedback(feedback, text("disconnected"), "success");
    } catch (error) {
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
    const providerRow = target.closest<HTMLElement>("[data-provider-row]");
    const provider = providerRow?.dataset.providerRow as Provider | undefined;
    if (action === "configure" && provider !== undefined) openConfig(provider);
    if (action === "health" && provider !== undefined) void healthCheck(provider);
    if (action === "disconnect" && provider !== undefined) openDisconnect(provider);
    if (action === "close-config") closeConfig();
    if (action === "confirm-disconnect") void confirmDisconnect();
  });
  for (const form of credentialForms) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitCredential(form, form.dataset.credentialForm as Provider);
    });
  }
  refreshAll?.addEventListener("click", () => void refreshStates());
}
