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

type Provider = "telegram";
type ChannelConnectorStatus = "active" | "canceled" | "provider_pending" | "rejected" | "requested";
type ChannelExpansionStage = "contract_ready" | "provider_pending";
type ChannelExpansion = {
  capabilities: string[];
  catalogPublishingAllowed: boolean;
  code: string;
  family: string;
  inlineSecretDelivery: false;
  providerCode: string;
  providerExecution: ChannelExpansionStage;
  requiredSellerAction: "connect_provider" | "create_app" | "create_bot";
  safeDescriptionKey: string;
  sellerActivationAllowed: boolean;
  version: number;
};
type ChannelConnectorRequest = {
  channelCode: string;
  createdAt: string;
  failureCode: string | null;
  providerCode: string;
  providerExecution: ChannelExpansionStage;
  requestPublicId: string;
  requestedAt: string;
  status: ChannelConnectorStatus;
  updatedAt: string;
  version: number;
};
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

class TenantChangedError extends Error {
  constructor() {
    super("tenant_changed");
    this.name = "TenantChangedError";
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
  const canReadProviders = root.dataset.canReadProviders === "true";
  const canManageChannelConnectors = root.dataset.canManageChannelConnectors === "true";
  const canReadDomains = root.dataset.canReadDomains === "true";
  const canRefreshTelegram = root.dataset.canRefreshTelegram === "true";
  const feedback = root.querySelector<HTMLElement>("[data-workspace-feedback]");
  const configPanel = root.querySelector<HTMLElement>("[data-config-panel]");
  const configTitle = root.querySelector<HTMLElement>("#config-title");
  const configFeedback = root.querySelector<HTMLElement>("[data-config-feedback]");
  const refreshAll = root.querySelector<HTMLButtonElement>("[data-refresh-all]");
  const credentialForms = [...root.querySelectorAll<HTMLFormElement>("[data-credential-form]")];
  const disconnectPanel = root.querySelector<HTMLElement>("[data-disconnect-panel]");
  const disconnectCopy = root.querySelector<HTMLElement>("[data-disconnect-copy]");
  const channelExpansionGrid = root.querySelector<HTMLElement>("[data-channel-expansion-grid]");
  const channelExpansionFeedback = root.querySelector<HTMLElement>("[data-channel-expansion-feedback]");
  const channelExpansionEmpty = root.querySelector<HTMLElement>("[data-channel-expansion-empty]");
  const tenantSignature = (): string => {
    const urlShopPublicId = new URL(window.location.href).searchParams.get("shop") ?? "";
    return `${root.dataset.shopPublicId ?? ""}\u0000${urlShopPublicId}`;
  };
  let activeTenantSignature = tenantSignature();
  let disconnectProvider: Provider | null = null;
  let sensitiveActionPending = false;
  let channelExpansionActionPending = false;

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

  const resetTenantBoundState = (): void => {
    // A client-side transition can replace the shop URL before replacing this
    // page's DOM. Clear entity-bound projections so the old shop is never
    // mutated or presented while the next tenant is loading.
    configPanel?.setAttribute("hidden", "");
    disconnectProvider = null;
    for (const form of credentialForms) {
      form.hidden = true;
      form.reset();
    }
    channelExpansionGrid?.replaceChildren();
    if (channelExpansionEmpty !== null) channelExpansionEmpty.hidden = true;
    for (const providerRow of root.querySelectorAll<HTMLElement>("[data-provider-row]")) {
      providerRow.dataset.readable = "false";
      providerRow.querySelector<HTMLElement>("[data-summary]")?.replaceChildren(document.createTextNode(text("reading")));
      providerRow.querySelector<HTMLElement>("[data-last-check]")?.replaceChildren(document.createTextNode(""));
      providerRow.querySelector<HTMLElement>("[data-error]")?.setAttribute("hidden", "");
    }
    setFeedback(feedback, "", "info");
    setFeedback(channelExpansionFeedback, "", "info");
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
  const apiErrorMessage = (error: unknown): string => error instanceof IntegrationApiError
    ? safeErrorMessage(error.message, error.requestId, locale)
    : safeErrorMessage(error, undefined, locale);

  const requestApi = async (url: string, options: RequestInit = {}, idempotencyKey?: string): Promise<JsonObject | null> => {
    const requestSignature = activeTenantSignature;
    const headers = new Headers(options.headers);
    const method = options.method?.toUpperCase() ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      const csrfCookieName = root.dataset.csrfCookieName ?? "";
      const csrf = readCookie(csrfCookieName);
      if (csrf === null) throw new IntegrationApiError("csrf_missing", null);
      headers.set("X-CSRF-Token", decodeURIComponent(csrf));
      headers.set("Content-Type", "application/json");
      if (idempotencyKey !== undefined) headers.set("Idempotency-Key", idempotencyKey);
    }
    const response = await fetch(url, { ...options, credentials: "same-origin", headers });
    const contentType = response.headers.get("Content-Type") ?? "";
    const payload: unknown = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
    assertTenantContext(requestSignature);
    if (!response.ok) {
      const safe = readSafeError(payload);
      throw new IntegrationApiError(safe.code, safe.requestId);
    }
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as JsonObject : null;
  };

  const channelExpansionFrom = (value: unknown): ChannelExpansion | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const object = value as JsonObject;
    const capabilities = object.capabilities;
    if (!Array.isArray(capabilities)) return null;
    const normalizedCapabilities = capabilities.filter((item): item is string => typeof item === "string" && item.length > 0);
    if (normalizedCapabilities.length !== capabilities.length) return null;
    if (
      typeof object.code !== "string"
      || typeof object.catalogPublishingAllowed !== "boolean"
      || typeof object.family !== "string"
      || object.inlineSecretDelivery !== false
      || typeof object.providerCode !== "string"
      || (object.providerExecution !== "contract_ready" && object.providerExecution !== "provider_pending")
      || (object.requiredSellerAction !== "connect_provider" && object.requiredSellerAction !== "create_app" && object.requiredSellerAction !== "create_bot")
      || typeof object.safeDescriptionKey !== "string"
      || typeof object.sellerActivationAllowed !== "boolean"
      || typeof object.version !== "number"
      || !Number.isSafeInteger(object.version)
    ) return null;
    return {
      capabilities: normalizedCapabilities,
      catalogPublishingAllowed: object.catalogPublishingAllowed,
      code: object.code,
      family: object.family,
      inlineSecretDelivery: false,
      providerCode: object.providerCode,
      providerExecution: object.providerExecution,
      requiredSellerAction: object.requiredSellerAction,
      safeDescriptionKey: object.safeDescriptionKey,
      sellerActivationAllowed: object.sellerActivationAllowed,
      version: object.version,
    };
  };
  const channelExpansionsFrom = (payload: JsonObject | null): ChannelExpansion[] => {
    const values = payload?.expansions;
    if (!Array.isArray(values)) return [];
    return values.map(channelExpansionFrom).filter((value): value is ChannelExpansion => value !== null);
  };
  const channelRequestFrom = (value: unknown): ChannelConnectorRequest | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const object = value as JsonObject;
    if (
      typeof object.channelCode !== "string"
      || typeof object.createdAt !== "string"
      || (object.failureCode !== null && typeof object.failureCode !== "string")
      || typeof object.providerCode !== "string"
      || (object.providerExecution !== "contract_ready" && object.providerExecution !== "provider_pending")
      || typeof object.requestPublicId !== "string"
      || typeof object.requestedAt !== "string"
      || (object.status !== "active" && object.status !== "canceled" && object.status !== "provider_pending" && object.status !== "rejected" && object.status !== "requested")
      || typeof object.updatedAt !== "string"
      || typeof object.version !== "number"
      || !Number.isSafeInteger(object.version)
    ) return null;
    return {
      channelCode: object.channelCode,
      createdAt: object.createdAt,
      failureCode: object.failureCode,
      providerCode: object.providerCode,
      providerExecution: object.providerExecution,
      requestPublicId: object.requestPublicId,
      requestedAt: object.requestedAt,
      status: object.status,
      updatedAt: object.updatedAt,
      version: object.version,
    };
  };
  const channelRequestsFrom = (payload: JsonObject | null): ChannelConnectorRequest[] => {
    const values = payload?.requests;
    if (!Array.isArray(values)) return [];
    return values.map(channelRequestFrom).filter((value): value is ChannelConnectorRequest => value !== null);
  };
  const expansionName = (code: string): string => {
    if (code === "telegram.mini_app") return text("channelExpansionNameTelegram");
    if (code === "zalo.mini_app") return text("channelExpansionNameZalo");
    if (code === "zalo.oa") return text("channelExpansionNameZaloOa");
    if (code === "whatsapp.cloud") return text("channelExpansionNameWhatsapp");
    if (code === "discord.bot") return text("channelExpansionNameDiscord");
    return code;
  };
  const expansionDescription = (code: string): string => {
    if (code === "telegram.mini_app") return text("channelExpansionDescriptionTelegram");
    if (code === "zalo.mini_app") return text("channelExpansionDescriptionZalo");
    if (code === "zalo.oa") return text("channelExpansionDescriptionZaloOa");
    if (code === "whatsapp.cloud") return text("channelExpansionDescriptionWhatsapp");
    if (code === "discord.bot") return text("channelExpansionDescriptionDiscord");
    return "";
  };
  const requiredSellerAction = (action: ChannelExpansion["requiredSellerAction"]): string => {
    if (action === "create_app") return text("channelExpansionActionCreateApp");
    if (action === "create_bot") return text("channelExpansionActionCreateBot");
    return text("channelExpansionActionConnectProvider");
  };
  const channelStatusLabel = (status: ChannelConnectorStatus): string => {
    if (status === "requested") return text("channelExpansionStatusRequested");
    if (status === "provider_pending") return text("channelExpansionStatusProviderPending");
    if (status === "active") return text("channelExpansionStatusActive");
    if (status === "canceled") return text("channelExpansionStatusCanceled");
    return text("channelExpansionStatusRejected");
  };
  const channelStatusTone = (status: ChannelConnectorStatus): "danger" | "info" | "neutral" | "success" | "warning" => {
    if (status === "active") return "success";
    if (status === "rejected") return "danger";
    if (status === "canceled") return "neutral";
    if (status === "provider_pending") return "warning";
    return "info";
  };
  const channelStageLabel = (stage: ChannelExpansionStage): string => stage === "contract_ready"
    ? text("channelExpansionStageContractReady")
    : text("channelExpansionStageProviderPending");
  const channelSurfaceSlug = (code: string): string => code.replaceAll(".", "-");
  const channelMark = (code: string): string => {
    if (code === "telegram.mini_app") return "TG";
    if (code === "zalo.mini_app" || code === "zalo.oa") return "ZA";
    if (code === "whatsapp.cloud") return "WA";
    if (code === "discord.bot") return "DC";
    return "CH";
  };
  const channelDate = (value: string): string => {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    try {
      return new Intl.DateTimeFormat(locale ?? "en", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(timestamp));
    } catch {
      return value;
    }
  };
  const connectorBadge = (status: ChannelConnectorStatus): HTMLElement => {
    const badge = document.createElement("span");
    badge.className = "sln-status";
    badge.dataset.tone = channelStatusTone(status);
    const dot = document.createElement("span");
    dot.setAttribute("aria-hidden", "true");
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode(channelStatusLabel(status)));
    return badge;
  };
  const stageBadge = (stage: ChannelExpansionStage): HTMLElement => {
    const badge = document.createElement("span");
    badge.className = "sln-status";
    badge.dataset.tone = stage === "provider_pending" ? "warning" : "info";
    const dot = document.createElement("span");
    dot.setAttribute("aria-hidden", "true");
    badge.appendChild(dot);
    badge.appendChild(document.createTextNode(stage === "provider_pending"
      ? text("channelExpansionStatusProviderPending")
      : text("channelExpansionStageContractReady")));
    return badge;
  };
  const renderChannelExpansions = (expansions: readonly ChannelExpansion[], requests: readonly ChannelConnectorRequest[]): void => {
    if (channelExpansionGrid === null) return;
    channelExpansionGrid.replaceChildren();
    if (channelExpansionEmpty !== null) channelExpansionEmpty.hidden = expansions.length > 0;
    for (const expansion of expansions) {
      const request = requests.find((candidate) => candidate.channelCode === expansion.code) ?? null;
      const sellerActivationAllowed = expansion.sellerActivationAllowed;
      const card = document.createElement("article");
      card.className = `channel-expansion-card channel-expansion-card--${channelSurfaceSlug(expansion.code)}`;
      card.id = `channel-${channelSurfaceSlug(expansion.code)}`;
      card.dataset.channelCode = expansion.code;
      card.dataset.stage = expansion.providerExecution;
      card.dataset.status = request?.status ?? expansion.providerExecution;
      const head = document.createElement("div");
      head.className = "channel-expansion-card-head";
      const identity = document.createElement("div");
      identity.className = "channel-expansion-identity";
      const mark = document.createElement("span");
      mark.className = "channel-provider-mark";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = channelMark(expansion.code);
      identity.appendChild(mark);
      const title = document.createElement("div");
      const heading = document.createElement("h3");
      heading.textContent = expansionName(expansion.code);
      const code = document.createElement("div");
      code.className = "channel-expansion-code";
      code.textContent = expansion.code;
      title.appendChild(heading);
      title.appendChild(code);
      identity.appendChild(title);
      head.appendChild(identity);
      head.appendChild(request === null ? stageBadge(expansion.providerExecution) : connectorBadge(request.status));
      card.appendChild(head);
      const description = document.createElement("p");
      description.textContent = expansionDescription(expansion.code);
      card.appendChild(description);
      const meta = document.createElement("div");
      meta.className = "channel-expansion-meta";
      const stage = document.createElement("div");
      stage.className = "channel-expansion-stage";
      stage.textContent = channelStageLabel(expansion.providerExecution);
      const action = document.createElement("div");
      action.className = "channel-expansion-next-action";
      action.textContent = `${text("channelExpansionRequiredAction")}: ${requiredSellerAction(expansion.requiredSellerAction)}`;
      meta.appendChild(stage);
      meta.appendChild(action);
      const capabilitiesDetails = document.createElement("details");
      capabilitiesDetails.className = "channel-expansion-details";
      const capabilitiesSummary = document.createElement("summary");
      capabilitiesSummary.textContent = `${text("channelExpansionCapabilities")} (${String(expansion.capabilities.length)})`;
      capabilitiesDetails.appendChild(capabilitiesSummary);
      const capabilities = document.createElement("div");
      capabilities.className = "channel-expansion-capabilities";
      for (const capability of expansion.capabilities) {
        const tag = document.createElement("code");
        tag.textContent = capability;
        capabilities.appendChild(tag);
      }
      capabilitiesDetails.appendChild(capabilities);
      meta.appendChild(capabilitiesDetails);
      card.appendChild(meta);
      const actions = document.createElement("div");
      actions.className = "channel-expansion-card-actions";
      const note = document.createElement("span");
      note.className = "provider-note";
      if (!canManageChannelConnectors) note.textContent = text("channelExpansionReadOnly");
      else if (!sellerActivationAllowed) note.textContent = text("channelExpansionStageProviderPending");
      else if (request !== null) note.textContent = `${request.requestPublicId} · ${channelDate(request.updatedAt)}`;
      else note.textContent = requiredSellerAction(expansion.requiredSellerAction);
      actions.appendChild(note);
      if (canManageChannelConnectors) {
        if (request !== null && (request.status === "requested" || request.status === "provider_pending")) {
          const cancel = document.createElement("button");
          cancel.type = "button";
          cancel.className = "text-action danger-text";
          cancel.dataset.channelAction = "cancel";
          cancel.dataset.requestPublicId = request.requestPublicId;
          cancel.dataset.requestVersion = String(request.version);
          cancel.textContent = text("channelExpansionCancel");
          actions.appendChild(cancel);
        } else if (sellerActivationAllowed && (request === null || request.status === "canceled" || request.status === "rejected")) {
          const create = document.createElement("button");
          create.type = "button";
          create.className = "app-button app-button-secondary";
          create.dataset.channelAction = "request";
          create.dataset.channelCode = expansion.code;
          create.dataset.providerCode = expansion.providerCode;
          create.textContent = text("channelExpansionRequest");
          actions.appendChild(create);
        }
      }
      card.appendChild(actions);
      channelExpansionGrid.appendChild(card);
    }
  };
  const loadChannelExpansions = async (announce = true, ignorePending = false): Promise<void> => {
    if (shopPublicId === undefined || channelExpansionGrid === null || (channelExpansionActionPending && !ignorePending)) return;
    channelExpansionActionPending = true;
    if (announce) setFeedback(channelExpansionFeedback, text("channelExpansionLoading"), "info");
    const base = `/api/app/shops/${encodeURIComponent(shopPublicId)}/channels`;
    try {
      const [catalogResult, requestsResult] = await Promise.all([requestApi(`${base}/catalog`), requestApi(`${base}/requests`)]);
      renderChannelExpansions(channelExpansionsFrom(catalogResult), channelRequestsFrom(requestsResult));
      setFeedback(channelExpansionFeedback, text("channelExpansionLoaded"), "success");
    } catch (error) {
      if (isTenantChangedError(error)) return;
      channelExpansionGrid.replaceChildren();
      if (channelExpansionEmpty !== null) channelExpansionEmpty.hidden = true;
      setFeedback(channelExpansionFeedback, `${text("channelExpansionUnavailable")} ${apiErrorMessage(error)}`, "danger");
    } finally {
      channelExpansionActionPending = false;
    }
  };
  const requestChannelExpansion = async (button: HTMLButtonElement): Promise<void> => {
    if (shopPublicId === undefined || !canManageChannelConnectors || channelExpansionActionPending) return;
    const channelCode = button.dataset.channelCode;
    const providerCode = button.dataset.providerCode;
    if (channelCode === undefined || providerCode === undefined) return;
    channelExpansionActionPending = true;
    button.disabled = true;
    button.textContent = text("channelExpansionRequesting");
    try {
      await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/channels/requests`, {
        method: "POST",
        body: JSON.stringify({ channelCode, providerCode }),
      }, createIdempotencyKey("channel_connector_request"));
      await loadChannelExpansions(true, true);
      setFeedback(channelExpansionFeedback, text("channelExpansionRequested"), "success");
    } catch (error) {
      if (isTenantChangedError(error)) return;
      setFeedback(channelExpansionFeedback, apiErrorMessage(error), "danger");
    } finally {
      channelExpansionActionPending = false;
    }
  };
  const cancelChannelExpansion = async (button: HTMLButtonElement): Promise<void> => {
    if (shopPublicId === undefined || !canManageChannelConnectors || channelExpansionActionPending) return;
    const requestPublicId = button.dataset.requestPublicId;
    const version = Number(button.dataset.requestVersion);
    if (requestPublicId === undefined || !Number.isSafeInteger(version) || version < 1 || !window.confirm(text("channelExpansionCancelConfirm"))) return;
    channelExpansionActionPending = true;
    button.disabled = true;
    button.textContent = text("channelExpansionCanceling");
    try {
      await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/channels/requests/${encodeURIComponent(requestPublicId)}`, {
        method: "DELETE",
        body: JSON.stringify({ expectedVersion: version }),
      }, createIdempotencyKey("channel_connector_cancel"));
      await loadChannelExpansions(true, true);
      setFeedback(channelExpansionFeedback, text("channelExpansionCanceled"), "success");
    } catch (error) {
      if (isTenantChangedError(error)) return;
      setFeedback(channelExpansionFeedback, apiErrorMessage(error), "danger");
    } finally {
      channelExpansionActionPending = false;
    }
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
    if (health !== null) health.hidden = !connected || !canRefreshTelegram;
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
    row("payos")?.setAttribute("data-readable", "true");
  };
  const applyDomains = (views: readonly DomainLike[]): void => {
    setRowState("domains", domainState(views, timeZone, locale));
    row("domains")?.setAttribute("data-readable", "true");
  };

  const createIdempotencyKey = (prefix: string): string => {
    try {
      return `${prefix}_${crypto.randomUUID()}`;
    } catch {
      return `${prefix}_${String(Date.now())}_${Math.random().toString(36).slice(2)}`;
    }
  };

  const refreshStates = async (): Promise<void> => {
    if (shopPublicId === undefined) return;
    const requestSignature = activeTenantSignature;
    if (refreshAll !== null) {
      refreshAll.disabled = true;
      refreshAll.textContent = text("refreshing");
    }
    setFeedback(feedback, text("reading"), "info");
    let failed = false;
    const base = `/api/app/shops/${encodeURIComponent(shopPublicId)}`;
    if (canReadProviders) {
      const [telegramResult, payosResult] = await Promise.allSettled([
        requestApi(`${base}/integrations/telegram`),
        requestApi(`${base}/payments/payos`),
      ]);
      if (!ensureTenantContext() || activeTenantSignature !== requestSignature) return;
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
    if (canReadDomains) {
      try { applyDomains(domainsFrom(await requestApi(`${base}/domains`))); }
      catch (error) {
        if (isTenantChangedError(error)) return;
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
    if (configTitle !== null) configTitle.textContent = text("connectTelegram");
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

  const submitCredential = async (form: HTMLFormElement): Promise<void> => {
    if (shopPublicId === undefined || sensitiveActionPending || !form.reportValidity()) return;
    const formData = new FormData(form);
    const body: JsonObject = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === "string" && value.trim().length > 0 && key !== "replaceBot") body[key] = value;
    }
    body.replaceBot = formData.get("replaceBot") === "on";
    // Fail fast on obvious paste mistakes (wrong clipboard slot, partial copy)
    // without spending a server round-trip to Telegram.
    if (typeof body.botToken === "string" && !/^\d{6,}:[A-Za-z0-9_-]{30,}$/u.test(body.botToken)) {
      setFeedback(configFeedback, text("tokenInvalid"), "danger");
      form.querySelector<HTMLInputElement>("input[name=botToken]")?.focus();
      return;
    }
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (submit === null) return;
    const originalSubmitLabel = submit.textContent;
    sensitiveActionPending = true;
    submit.disabled = true;
    submit.textContent = text("verifying");
    setFeedback(configFeedback, text("sending"), "info");
    let justConnected = false;
    try {
      const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/integrations/telegram`, { method: "PUT", body: JSON.stringify(body) });
      if (!ensureTenantContext()) return;
      applyTelegram(integrationFrom(payload) as TelegramIntegrationLike | null);
      form.reset();
      justConnected = true;
      setFeedback(configFeedback, text("autoVerify"), "success");
    } catch (error) {
      if (isTenantChangedError(error)) return;
      form.reset();
      setFeedback(configFeedback, apiErrorMessage(error), "danger");
    } finally {
      sensitiveActionPending = false;
      submit.disabled = false;
      submit.textContent = originalSubmitLabel;
    }
    // Finish the "connect" journey without another manual click: verify bot
    // identity + webhook right away so the seller sees the final state.
    if (justConnected) void healthCheck("telegram");
  };

  const healthCheck = async (provider: Provider): Promise<void> => {
    // Provider is narrowed to "telegram"; the guard stays verbatim for the frontend contract test.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (shopPublicId === undefined || sensitiveActionPending || (provider === "telegram" && !canRefreshTelegram)) return;
    const button = row(provider)?.querySelector<HTMLButtonElement>("[data-action=health]");
    sensitiveActionPending = true;
    if (button !== null && button !== undefined) {
      button.disabled = true;
      button.textContent = text("checking");
    }
    try {
      const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/integrations/telegram/health-checks`, { method: "POST", body: "{}" });
      if (!ensureTenantContext()) return;
      applyTelegram(integrationFrom(payload) as TelegramIntegrationLike | null);
      setFeedback(feedback, text("healthUpdated"), "success");
    } catch (error) {
      if (isTenantChangedError(error)) return;
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
    if (disconnectCopy !== null) disconnectCopy.textContent = text("disconnectTelegram");
    if (configPanel !== null) {
      configPanel.hidden = false;
      configPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const confirmDisconnect = async (): Promise<void> => {
    if (shopPublicId === undefined || disconnectProvider === null || sensitiveActionPending) return;
    const button = root.querySelector<HTMLButtonElement>("[data-action=confirm-disconnect]");
    sensitiveActionPending = true;
    if (button !== null) {
      button.disabled = true;
      button.textContent = text("disconnecting");
    }
    try {
      await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/integrations/telegram`, { method: "DELETE" });
      if (!ensureTenantContext()) return;
      applyTelegram(null);
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
    const channelActionTarget = target.closest<HTMLButtonElement>("[data-channel-action]");
    if (channelActionTarget !== null) {
      if (channelActionTarget.dataset.channelAction === "request") void requestChannelExpansion(channelActionTarget);
      if (channelActionTarget.dataset.channelAction === "cancel") void cancelChannelExpansion(channelActionTarget);
      return;
    }
    const actionTarget = target.closest<HTMLElement>("[data-action]");
    const action = actionTarget?.dataset.action;
    const providerRow = target.closest<HTMLElement>("[data-provider-row]");
    const provider = providerRow?.dataset.providerRow as Provider | undefined;
    if (action === "configure" && provider !== undefined) openConfig(provider);
    if (action === "health" && provider !== undefined) void healthCheck(provider);
    if (action === "disconnect" && provider !== undefined) openDisconnect(provider);
    if (action === "close-config") closeConfig();
    if (action === "confirm-disconnect") void confirmDisconnect();
    if (action === "copy-newbot-command") {
      void navigator.clipboard
        .writeText("/newbot")
        .then(() => { setFeedback(configFeedback, text("copyCommandDone"), "success"); })
        .catch(() => { setFeedback(configFeedback, text("copyCommand"), "danger"); });
    }
  });
  for (const form of credentialForms) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitCredential(form);
    });
  }
  refreshAll?.addEventListener("click", () => void refreshStates());
  window.addEventListener("popstate", () => { ensureTenantContext(); });
  window.addEventListener("pageshow", () => { ensureTenantContext(); });

  const initTelegramTemplateManager = (): void => {
    const panel = root.querySelector<HTMLElement>("[data-telegram-template-panel]");
    if (panel === null || shopPublicId === undefined) return;

    const presetCards = [...panel.querySelectorAll<HTMLElement>("[data-preset-card]")];
    const welcomeInput = panel.querySelector<HTMLTextAreaElement>("#welcome-message-input");
    const supportInput = panel.querySelector<HTMLInputElement>("#support-handle-input");
    const saveBtn = panel.querySelector<HTMLButtonElement>("[data-action='save-template']");
    const simText = panel.querySelector<HTMLElement>("[data-sim-text]");
    const simKeyboard = panel.querySelector<HTMLElement>("[data-sim-keyboard]");
    const simMenuBtn = panel.querySelector<HTMLElement>("[data-sim-menu-btn]");

    let currentPreset = panel.querySelector<HTMLInputElement>("input[name='templatePreset']:checked")?.value ?? "license_vault";

    const renderSimulator = (): void => {
      const welcome = welcomeInput?.value.trim() || "Chào mừng bạn đến với Cửa Hàng! Chọn danh mục bên dưới để bắt đầu:";
      const support = supportInput?.value.trim() || "";

      if (simText !== null) {
        switch (currentPreset) {
          case "gaming_topup":
            simText.innerHTML = `🎮 <b>Game & Thẻ Cào Tự Động</b><br/><br/>${welcome}<br/><br/><i>⚡ Trả mã PIN & Serial tức thì qua bot.</i>`;
            break;
          case "subscription_slots":
            simText.innerHTML = `🎬 <b>Tài Khoản & Gói Dịch Vụ</b><br/><br/>${welcome}<br/><br/><i>⚡ Cấp Profile & PIN bảo mật sau khi thanh toán.</i>`;
            break;
          case "mini_app_hybrid":
            simText.innerHTML = `🛍️ <b>Storefront Trực Tuyến</b><br/><br/>${welcome}<br/><br/><i>Bấm Menu góc dưới để mở Cửa hàng toàn màn hình.</i>`;
            break;
          case "vip_community":
            simText.innerHTML = `👑 <b>Cộng Đồng VIP / Hội Viên</b><br/><br/>${welcome}<br/><br/><i>Hệ thống tự động cấp link mời 1-lần vào nhóm kín sau thanh toán.</i>`;
            break;
          case "license_vault":
          default:
            simText.innerHTML = `🔑 <b>Kho Bản Quyền Số</b><br/><br/>${welcome}<br/><br/><i>⚡ Giao key bản quyền tức thì, copy 1-chạm.</i>`;
            break;
        }
      }

      if (simKeyboard !== null) {
        simKeyboard.replaceChildren();
        const row1 = document.createElement("div");
        row1.className = "sim-keyboard-row";

        const btnMenu = document.createElement("div");
        btnMenu.className = "sim-button";
        btnMenu.textContent = currentPreset === "gaming_topup" ? "🎮 Danh mục" : currentPreset === "subscription_slots" ? "🎬 Dịch vụ" : currentPreset === "vip_community" ? "👑 Tham gia" : "📦 Danh mục";

        const btnCart = document.createElement("div");
        btnCart.className = "sim-button";
        btnCart.textContent = currentPreset === "vip_community" ? "💎 Gói VIP" : "🛒 Giỏ hàng";

        row1.appendChild(btnMenu);
        row1.appendChild(btnCart);
        simKeyboard.appendChild(row1);

        if (support.length > 0) {
          const row2 = document.createElement("div");
          row2.className = "sim-keyboard-row";
          const btnSupport = document.createElement("div");
          btnSupport.className = "sim-button";
          btnSupport.textContent = `💬 Hỗ trợ: ${support}`;
          row2.appendChild(btnSupport);
          simKeyboard.appendChild(row2);
        }
      }

      if (simMenuBtn !== null) {
        simMenuBtn.textContent = currentPreset === "mini_app_hybrid" ? "🛍️ Cửa hàng" : "≡ Menu";
      }
    };

    presetCards.forEach((card) => {
      card.addEventListener("click", () => {
        const radio = card.querySelector<HTMLInputElement>("input[type='radio']");
        if (radio !== null) {
          radio.checked = true;
          currentPreset = radio.value;
          presetCards.forEach((c) => {
            c.classList.remove("active");
          });
          card.classList.add("active");
          renderSimulator();
        }
      });
    });

    welcomeInput?.addEventListener("input", renderSimulator);
    supportInput?.addEventListener("input", renderSimulator);

    saveBtn?.addEventListener("click", () => {
      void (async () => {
        const origText = saveBtn.textContent;
        saveBtn.disabled = true;
        saveBtn.textContent = "Đang lưu...";

        try {
          const csrfCookie = root.dataset.csrfCookieName;
          const csrfToken = csrfCookie !== undefined ? readCookie(csrfCookie) : null;
          const response = await fetch(`/api/app/shops/${encodeURIComponent(shopPublicId)}/integrations/telegram/menu`, {
            body: JSON.stringify({
              supportHandle: supportInput?.value.trim() || null,
              templatePreset: currentPreset,
              welcomeMessageCustom: welcomeInput?.value.trim() || null,
            }),
            headers: {
              "Content-Type": "application/json",
              ...(csrfToken !== null ? { "X-CSRF-Token": csrfToken } : {}),
            },
            method: "POST",
          });

          if (!response.ok) {
            throw new Error("Cập nhật template thất bại");
          }

          saveBtn.textContent = "Đã lưu thành công!";
          saveBtn.style.backgroundColor = "var(--sln-state-success)";
          setTimeout(() => {
            saveBtn.disabled = false;
            saveBtn.textContent = origText;
            saveBtn.style.backgroundColor = "";
          }, 2500);
        } catch (err) {
          alert("Lỗi khi cập nhật template: " + (err instanceof Error ? err.message : "Vui lòng thử lại"));
          saveBtn.disabled = false;
          saveBtn.textContent = origText;
        }
      })();
    });

    renderSimulator();
  };

  initTelegramTemplateManager();
  void loadChannelExpansions();
}
