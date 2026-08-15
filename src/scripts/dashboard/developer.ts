import { safeErrorMessage } from "../../lib/dashboard/integrations-view";

export {};

type JsonObject = Record<string, unknown>;
type SafeError = { code: string; requestId: string | null };
type ApiCredential = {
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  name: string;
  publicId: string;
  revokedAt: string | null;
  scopes: string[];
  status: "active" | "revoked";
  version: number;
};

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

const root = document.querySelector<HTMLElement>("[data-developer-workspace]");

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
  const canManageApiCredentials = root.dataset.canManageApiCredentials === "true";
  const apiCredentialLoad = root.querySelector<HTMLButtonElement>("[data-api-credentials-load]");
  const apiCredentialFeedback = root.querySelector<HTMLElement>("[data-api-credentials-feedback]");
  const apiCredentialTokenFeedback = root.querySelector<HTMLElement>("[data-api-credentials-token-feedback]");
  const apiCredentialForm = root.querySelector<HTMLFormElement>("[data-api-credential-form]");
  const apiCredentialList = root.querySelector<HTMLElement>("[data-api-credentials-list]");
  const apiCredentialTokenPanel = root.querySelector<HTMLElement>("[data-api-credentials-token]");
  const apiCredentialTokenValue = root.querySelector<HTMLInputElement>("[data-api-credentials-token-value]");
  const tenantSignature = (): string => {
    const urlShopPublicId = new URL(window.location.href).searchParams.get("shop") ?? "";
    return `${root.dataset.shopPublicId ?? ""}\u0000${urlShopPublicId}`;
  };
  let activeTenantSignature = tenantSignature();
  let sensitiveActionPending = false;
  let apiCredentialActionPending = false;

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
    apiCredentialList?.replaceChildren();
    if (apiCredentialTokenValue !== null) apiCredentialTokenValue.value = "";
    apiCredentialTokenPanel?.setAttribute("hidden", "");
    setFeedback(apiCredentialFeedback, "", "info");
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

  const createIdempotencyKey = (prefix: string): string => {
    try {
      return `${prefix}_${crypto.randomUUID()}`;
    } catch {
      return `${prefix}_${String(Date.now())}_${Math.random().toString(36).slice(2)}`;
    }
  };

  const credentialDateFormatter = new Intl.DateTimeFormat(locale ?? "en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  const formatCredentialDate = (value: string | null): string => {
    if (value === null) return text("apiCredentialsNever");
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? text("apiCredentialsNever") : credentialDateFormatter.format(date);
  };
  const apiCredentialFrom = (value: unknown): ApiCredential | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const object = value as JsonObject;
    const expiresAt = object.expiresAt;
    const lastUsedAt = object.lastUsedAt;
    const revokedAt = object.revokedAt;
    const scopesValue = object.scopes;
    const versionValue = object.version;
    if (!Array.isArray(scopesValue)) return null;
    const scopes = scopesValue.filter((scope): scope is string => typeof scope === "string");
    if (typeof versionValue !== "number" || !Number.isSafeInteger(versionValue)) return null;
    if (
      typeof object.createdAt !== "string"
      || (expiresAt !== null && typeof expiresAt !== "string")
      || (lastUsedAt !== null && typeof lastUsedAt !== "string")
      || typeof object.name !== "string"
      || typeof object.publicId !== "string"
      || (revokedAt !== null && typeof revokedAt !== "string")
      || scopes.length !== scopesValue.length
      || (object.status !== "active" && object.status !== "revoked")
    ) return null;
    return {
      createdAt: object.createdAt,
      expiresAt,
      lastUsedAt,
      name: object.name,
      publicId: object.publicId,
      revokedAt,
      scopes,
      status: object.status,
      version: versionValue,
    };
  };
  const apiCredentialsFrom = (payload: JsonObject | null): ApiCredential[] => {
    const values = payload?.credentials;
    if (!Array.isArray(values)) return [];
    return values.map(apiCredentialFrom).filter((value): value is ApiCredential => value !== null);
  };
  const setApiCredentialFeedback = (message: string, tone: "danger" | "info" | "success" | "warning" = "info"): void => {
    setFeedback(apiCredentialFeedback, message, tone);
  };
  const apiCredentialScopeLabel = (scope: string): string => ({
    "catalog:read": text("apiCredentialsCatalogScope"),
    "inventory:read": text("apiCredentialsInventoryScope"),
    "orders:read": text("apiCredentialsOrdersScope"),
    "shop:read": text("apiCredentialsShopScope"),
  })[scope] ?? scope;
  const renderApiCredentials = (credentials: readonly ApiCredential[]): void => {
    if (apiCredentialList === null) return;
    apiCredentialList.replaceChildren();
    if (credentials.length === 0) {
      const empty = document.createElement("p");
      empty.className = "provider-note";
      empty.setAttribute("role", "listitem");
      empty.textContent = text("apiCredentialsNoCredentials");
      apiCredentialList.appendChild(empty);
      return;
    }
    for (const credential of credentials) {
      const article = document.createElement("article");
      article.className = "api-credential-row";
      article.setAttribute("role", "listitem");

      const identity = document.createElement("div");
      const title = document.createElement("h3");
      title.textContent = credential.name;
      const details = document.createElement("p");
      details.textContent = `${credential.publicId} · ${credential.scopes.map(apiCredentialScopeLabel).join(", ")}`;
      identity.appendChild(title);
      identity.appendChild(details);

      const metadata = document.createElement("div");
      metadata.className = "api-credential-meta";
      const created = document.createElement("div");
      created.textContent = `${text("apiCredentialsCreated")}: ${formatCredentialDate(credential.createdAt)}`;
      const lastUsed = document.createElement("div");
      lastUsed.textContent = `${text("apiCredentialsLastUsed")}: ${formatCredentialDate(credential.lastUsedAt)}`;
      const expiry = document.createElement("div");
      expiry.textContent = `${text("apiCredentialsExpiry")}: ${formatCredentialDate(credential.expiresAt)}`;
      metadata.appendChild(created);
      metadata.appendChild(lastUsed);
      metadata.appendChild(expiry);

      const status = document.createElement("span");
      status.className = "api-credential-status";
      status.dataset.status = credential.status;
      status.textContent = credential.status === "active" ? text("apiCredentialsStatusActive") : text("apiCredentialsStatusRevoked");

      article.appendChild(identity);
      article.appendChild(metadata);
      article.appendChild(status);
      if (credential.status === "active") {
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.className = "text-action danger-text";
        revoke.dataset.apiCredentialsRevoke = "true";
        revoke.dataset.credentialId = credential.publicId;
        revoke.dataset.credentialVersion = String(credential.version);
        revoke.textContent = text("apiCredentialsRevoke");
        article.appendChild(revoke);
      }
      apiCredentialList.appendChild(article);
    }
  };
  const loadApiCredentials = async (announce = true, ignorePending = false): Promise<void> => {
    if (!canManageApiCredentials || shopPublicId === undefined || (apiCredentialActionPending && !ignorePending)) return;
    apiCredentialActionPending = true;
    if (apiCredentialLoad !== null) {
      apiCredentialLoad.disabled = true;
      apiCredentialLoad.textContent = text("apiCredentialsLoading");
    }
    if (announce) setApiCredentialFeedback(text("apiCredentialsLoading"), "info");
    try {
      const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/api-credentials`);
      renderApiCredentials(apiCredentialsFrom(payload));
      if (apiCredentialForm !== null) apiCredentialForm.hidden = false;
      setApiCredentialFeedback(text("apiCredentialsLoaded"), "success");
    } catch (error) {
      if (isTenantChangedError(error)) return;
      if (apiCredentialForm !== null) apiCredentialForm.hidden = true;
      setApiCredentialFeedback(apiErrorMessage(error), "danger");
    } finally {
      apiCredentialActionPending = false;
      if (apiCredentialLoad !== null) {
        apiCredentialLoad.disabled = false;
        apiCredentialLoad.textContent = text("apiCredentialsLoad");
      }
    }
  };
  const clearApiCredentialToken = (): void => {
    if (apiCredentialTokenValue !== null) apiCredentialTokenValue.value = "";
    if (apiCredentialTokenPanel !== null) apiCredentialTokenPanel.hidden = true;
  };
  const showApiCredentialToken = (token: string): void => {
    if (apiCredentialTokenValue === null || apiCredentialTokenPanel === null) return;
    apiCredentialTokenValue.value = token;
    apiCredentialTokenPanel.hidden = false;
    apiCredentialTokenValue.focus({ preventScroll: true });
    apiCredentialTokenValue.select();
  };
  const submitApiCredential = async (): Promise<void> => {
    if (shopPublicId === undefined || apiCredentialForm === null || sensitiveActionPending || apiCredentialActionPending || !apiCredentialForm.reportValidity()) return;
    const formData = new FormData(apiCredentialForm);
    const scopes = formData.getAll("scope").filter((value): value is string => typeof value === "string" && value.length > 0);
    if (scopes.length === 0) {
      setApiCredentialFeedback(text("apiCredentialsScopes"), "warning");
      return;
    }
    const expiresAtValue = formData.get("expiresAt");
    let expiresAt: string | null = null;
    if (typeof expiresAtValue === "string" && expiresAtValue.length > 0) {
      const timestamp = Date.parse(expiresAtValue);
      expiresAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : expiresAtValue;
    }
    const submit = apiCredentialForm.querySelector<HTMLButtonElement>("button[type=submit]");
    if (submit === null) return;
    const originalLabel = submit.textContent;
    sensitiveActionPending = true;
    apiCredentialActionPending = true;
    submit.disabled = true;
    submit.textContent = text("apiCredentialsIssuing");
    clearApiCredentialToken();
    setApiCredentialFeedback(text("apiCredentialsIssuing"), "info");
    try {
      const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/api-credentials`, {
        method: "POST",
        body: JSON.stringify({ expiresAt, name: formData.get("name"), scopes }),
      }, createIdempotencyKey("api_credential_issue"));
      await loadApiCredentials(false, true);
      const token = typeof payload?.token === "string" && payload.tokenAvailable === true ? payload.token : null;
      if (token !== null) {
        showApiCredentialToken(token);
        setFeedback(apiCredentialTokenFeedback, text("apiCredentialsIssued"), "success");
      } else {
        setApiCredentialFeedback(text("apiCredentialsIssued"), "success");
      }
      apiCredentialForm.reset();
    } catch (error) {
      if (isTenantChangedError(error)) return;
      apiCredentialForm.reset();
      setApiCredentialFeedback(`${apiErrorMessage(error)}${(error instanceof IntegrationApiError && error.requestId !== null) ? ` (${text("apiCredentialsRequestId")}: ${error.requestId})` : ""}`, "danger");
    } finally {
      apiCredentialActionPending = false;
      sensitiveActionPending = false;
      submit.disabled = false;
      submit.textContent = originalLabel;
    }
  };
  const revokeApiCredential = async (button: HTMLButtonElement): Promise<void> => {
    if (shopPublicId === undefined || sensitiveActionPending || apiCredentialActionPending) return;
    const credentialId = button.dataset.credentialId;
    const version = Number(button.dataset.credentialVersion);
    if (credentialId === undefined || !Number.isSafeInteger(version) || version < 1) return;
    if (!window.confirm(text("apiCredentialsRevokeConfirm"))) return;
    sensitiveActionPending = true;
    apiCredentialActionPending = true;
    button.disabled = true;
    button.textContent = text("apiCredentialsRevoking");
    try {
      await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/api-credentials/${encodeURIComponent(credentialId)}`, {
        method: "DELETE",
        body: JSON.stringify({ expectedVersion: version, reasonCode: "seller_revoked" }),
      }, createIdempotencyKey("api_credential_revoke"));
      await loadApiCredentials(false, true);
      setApiCredentialFeedback(text("apiCredentialsRevoked"), "success");
    } catch (error) {
      if (isTenantChangedError(error)) return;
      setApiCredentialFeedback(apiErrorMessage(error), "danger");
    } finally {
      apiCredentialActionPending = false;
      sensitiveActionPending = false;
      button.disabled = false;
      button.textContent = text("apiCredentialsRevoke");
    }
  };

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const apiRevokeTarget = target.closest<HTMLButtonElement>("[data-api-credentials-revoke]");
    if (apiRevokeTarget !== null) {
      void revokeApiCredential(apiRevokeTarget);
      return;
    }
    if (target.closest("[data-api-credentials-load]") !== null) {
      void loadApiCredentials();
      return;
    }
    if (target.closest("[data-api-credentials-copy]") !== null) {
      const token = apiCredentialTokenValue?.value ?? "";
      if (token.length > 0) {
        const clipboard = navigator.clipboard;
        const fallback = (): void => {
          if (apiCredentialTokenValue !== null) {
            apiCredentialTokenValue.focus();
            apiCredentialTokenValue.select();
          }
          setFeedback(apiCredentialTokenFeedback, text("apiCredentialsCopyFailed"), "warning");
        };
        void clipboard.writeText(token).then(() => {
          setFeedback(apiCredentialTokenFeedback, text("apiCredentialsCopied"), "success");
        }).catch(fallback);
      }
      return;
    }
  });
  apiCredentialForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitApiCredential();
  });
  apiCredentialLoad?.addEventListener("click", () => void loadApiCredentials());
  window.addEventListener("popstate", () => { ensureTenantContext(); });
  window.addEventListener("pageshow", () => { ensureTenantContext(); });
  if (canManageApiCredentials) void loadApiCredentials();
}
