import {
  WIZARD_STEPS,
  deriveFallbackProgress,
  hasAuthoritativeTelegramHealth,
  isSafeHttpsUrl,
  mergeServerProgress,
  parseControlledTestOrder,
  parseOnboardingSnapshot,
  parseReadinessChecks,
  progressPercent,
  readableErrorKey,
  settingsDraftReady,
  slugifyDraft,
  summarizeInventoryDraft,
  validateProductDraft,
  validateShopDraft,
  type ControlledTestOrderView,
  type OnboardingProfileView,
  type OnboardingSettingsView,
  type OnboardingSnapshot,
  type ReadinessCheckView,
  type WizardStepCode,
  type WizardStepStatus,
} from "../../lib/dashboard/onboarding-ui";
import {
  currencyInputStep,
  formatMinorAmountForInput,
  formatMoney,
  normalizeCurrencyCode,
} from "../../lib/i18n/currency";
import { matchSupportedLocale } from "../../lib/i18n/locale";

type CopyParams = Readonly<Record<string, string | number>>;

let activeCopy: Readonly<Record<string, string>> = {};
let activeLocale = "en";

function interpolateCopy(template: string, params: CopyParams | undefined): string {
  if (params === undefined) return template;
  return template.replace(/\{([A-Za-z][A-Za-z0-9_.-]*)\}/gu, (placeholder, key: string) => {
    const value = params[key];
    return value === undefined ? placeholder : String(value);
  });
}

function copy(key: string, paramsOrFallback?: CopyParams | string, fallbackOrParams?: CopyParams | string): string {
  const params = typeof paramsOrFallback === "string"
    ? typeof fallbackOrParams === "object" ? fallbackOrParams : undefined
    : paramsOrFallback;
  const englishFallback = typeof paramsOrFallback === "string"
    ? paramsOrFallback
    : typeof fallbackOrParams === "string" ? fallbackOrParams : "";
  return interpolateCopy(activeCopy[key] ?? englishFallback, params);
}

function configureLocalization(root: HTMLElement): void {
  activeLocale = root.dataset.locale === "vi-VN" ? "vi-VN" : "en";
  try {
    const parsed = JSON.parse(root.dataset.copy ?? "null") as unknown;
    const row = asRecord(parsed);
    activeCopy = row === null
      ? {}
      : Object.fromEntries(Object.entries(row).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    activeCopy = {};
  }
}

type Shop = {
  businessCountry: string | null;
  currency: string;
  defaultLocale: string;
  featureFlags: Record<string, unknown>;
  limits: Record<string, unknown>;
  merchantCountry: string | null;
  name: string;
  planCode: string;
  publicId: string;
  role: string;
  slug: string;
  status: string;
  subscriptionState: string;
  timezone: string;
};

type CatalogProduct = {
  description: string;
  fulfillmentType: "license_key" | "manual";
  id: string;
  slug: string;
  status: string;
  title: string;
};

type CatalogVariant = {
  availableStock: number;
  currency: string;
  id: string;
  priceMinor: number;
  productId: string;
  sku: string;
  status: string;
  title: string;
};

type TelegramIntegration = {
  bot: { displayName: string; id: string; username: string } | null;
  lastHealthUpdateAt: string | null;
  lastSafeErrorCode: string | null;
  status: string;
  webhookStatus: string;
};

type PaymentIntegration = {
  lastCheckedAt: string | null;
  lastSafeErrorCode: string | null;
  lastWebhookVerifiedAt: string | null;
  status: string;
  webhookStatus: string;
};

type DomainRecord = {
  hostname: string;
  isPrimary: boolean;
  status: string;
  type: "custom" | "platform_subdomain";
};

type InventoryPreview = {
  acceptedCount: number;
  duplicateCount: number;
  expiresAt: string | null;
  previewToken: string;
  rejectedCount: number;
  totalCount: number;
};

type ReadinessState = {
  checkedAt: string | null;
  checks: ReadinessCheckView[];
  ready: boolean;
  runId: string | null;
};

type AutomationTaskStatus = "canceled" | "failed" | "pending" | "retryable" | "running" | "succeeded" | "waiting_provider" | "waiting_user";

type AutomationTask = {
  actionUrl: string;
  attemptCount: number;
  capabilityCode: string;
  canCancel: boolean;
  continuation: { kind: "approval_granted" | "provider_check" } | null;
  createdAt: string;
  id: string;
  lastSafeErrorCode: string | null;
  nextAttemptAt: string | null;
  status: AutomationTaskStatus;
  updatedAt: string;
  version: number;
};

class ApiError extends Error {
  readonly code: string;
  readonly issues: string[];
  readonly requestId: string | null;
  readonly status: number;

  constructor(code: string, status: number, issues: string[], requestId: string | null) {
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.issues = issues;
    this.requestId = requestId;
  }
}

type PageState = {
  automationTasks: AutomationTask[];
  catalogProducts: CatalogProduct[];
  catalogVariants: CatalogVariant[];
  domains: DomainRecord[];
  inventoryPreview: InventoryPreview | null;
  onboarding: OnboardingSnapshot;
  payos: PaymentIntegration | null;
  published: boolean;
  readiness: ReadinessState;
  selectedShopId: string | null;
  shopSelectionEpoch: number;
  telegram: TelegramIntegration | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isShop(value: unknown): value is Shop {
  const row = asRecord(value);
  return row !== null
    && typeof row.publicId === "string"
    && typeof row.slug === "string"
    && typeof row.name === "string"
    && (row.businessCountry === null || typeof row.businessCountry === "string")
    && typeof row.currency === "string"
    && typeof row.defaultLocale === "string"
    && (row.merchantCountry === null || typeof row.merchantCountry === "string")
    && typeof row.status === "string"
    && typeof row.planCode === "string";
}

function parseShops(value: string | undefined): Shop[] {
  if (value === undefined) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isShop) : [];
  } catch {
    return [];
  }
}

function parseCatalog(value: unknown, fallbackCurrency: string): { products: CatalogProduct[]; variants: CatalogVariant[] } {
  const root = asRecord(value) ?? {};
  const products: CatalogProduct[] = [];
  const variants: CatalogVariant[] = [];
  if (Array.isArray(root.products)) {
    for (const item of root.products) {
      const row = asRecord(item);
      if (row === null || typeof row.id !== "string" || typeof row.slug !== "string" || typeof row.title !== "string") continue;
      products.push({
        description: typeof row.description === "string" ? row.description : "",
        fulfillmentType: row.fulfillmentType === "manual" ? "manual" : "license_key",
        id: row.id,
        slug: row.slug,
        status: typeof row.status === "string" ? row.status : "draft",
        title: row.title,
      });
    }
  }
  if (Array.isArray(root.variants)) {
    for (const item of root.variants) {
      const row = asRecord(item);
      if (row === null || typeof row.id !== "string" || typeof row.productId !== "string" || typeof row.sku !== "string") continue;
      variants.push({
        availableStock: numberValue(row.availableStock),
        currency: typeof row.currency === "string" ? row.currency : fallbackCurrency,
        id: row.id,
        priceMinor: numberValue(row.priceMinor),
        productId: row.productId,
        sku: row.sku,
        status: typeof row.status === "string" ? row.status : "active",
        title: typeof row.title === "string" ? row.title : row.sku,
      });
    }
  }
  return { products, variants };
}

function parseTelegram(value: unknown): TelegramIntegration | null {
  const root = asRecord(value) ?? {};
  const row = asRecord(root.integration);
  if (row === null) return null;
  const botRow = asRecord(row.bot);
  const bot = botRow !== null && typeof botRow.id === "string" && typeof botRow.username === "string" && typeof botRow.displayName === "string"
    ? { displayName: botRow.displayName, id: botRow.id, username: botRow.username }
    : null;
  return {
    bot,
    lastHealthUpdateAt: stringOrNull(row.lastHealthUpdateAt),
    lastSafeErrorCode: stringOrNull(row.lastSafeErrorCode),
    status: typeof row.status === "string" ? row.status : "pending",
    webhookStatus: typeof row.webhookStatus === "string" ? row.webhookStatus : "pending",
  };
}

function parsePayos(value: unknown): PaymentIntegration | null {
  const root = asRecord(value) ?? {};
  const row = asRecord(root.integration);
  if (row === null) return null;
  return {
    lastCheckedAt: stringOrNull(row.lastCheckedAt),
    lastSafeErrorCode: stringOrNull(row.lastSafeErrorCode),
    lastWebhookVerifiedAt: stringOrNull(row.lastWebhookVerifiedAt),
    status: typeof row.status === "string" ? row.status : "pending",
    webhookStatus: typeof row.webhookStatus === "string" ? row.webhookStatus : "pending",
  };
}

function parseAutomationTasks(value: unknown): AutomationTask[] {
  const root = asRecord(value) ?? {};
  if (!Array.isArray(root.tasks)) return [];
  const tasks: AutomationTask[] = [];
  for (const item of root.tasks) {
    const row = asRecord(item);
    if (row === null
      || typeof row.id !== "string"
      || typeof row.actionUrl !== "string"
      || !row.actionUrl.startsWith("/")
      || typeof row.capabilityCode !== "string"
      || typeof row.status !== "string"
      || !["canceled", "failed", "pending", "retryable", "running", "succeeded", "waiting_provider", "waiting_user"].includes(row.status)
      || typeof row.version !== "number"
      || !Number.isSafeInteger(row.version)
      || row.version < 1
      || typeof row.attemptCount !== "number"
      || !Number.isSafeInteger(row.attemptCount)
      || typeof row.createdAt !== "string"
      || typeof row.updatedAt !== "string") continue;
    const continuationRow = asRecord(row.continuation);
    const continuation: AutomationTask["continuation"] = continuationRow?.kind === "approval_granted"
      ? { kind: "approval_granted" }
      : continuationRow?.kind === "provider_check"
        ? { kind: "provider_check" }
        : null;
    tasks.push({
      actionUrl: row.actionUrl,
      attemptCount: row.attemptCount,
      capabilityCode: row.capabilityCode,
      canCancel: row.canCancel === true,
      continuation,
      createdAt: row.createdAt,
      id: row.id,
      lastSafeErrorCode: stringOrNull(row.lastSafeErrorCode),
      nextAttemptAt: stringOrNull(row.nextAttemptAt),
      status: row.status as AutomationTaskStatus,
      updatedAt: row.updatedAt,
      version: row.version,
    });
  }
  return tasks;
}

function parseDomains(value: unknown): DomainRecord[] {
  const root = asRecord(value) ?? {};
  if (!Array.isArray(root.domains)) return [];
  const domains: DomainRecord[] = [];
  for (const item of root.domains) {
    const row = asRecord(item);
    if (row === null || typeof row.hostname !== "string" || (row.type !== "custom" && row.type !== "platform_subdomain")) continue;
    domains.push({ hostname: row.hostname, isPrimary: row.isPrimary === true, status: typeof row.status === "string" ? row.status : "pending", type: row.type });
  }
  return domains;
}

function parseInventoryPreview(value: unknown): InventoryPreview | null {
  const root = asRecord(value) ?? {};
  const row = asRecord(root.preview);
  if (row === null || typeof row.previewToken !== "string" || row.previewToken.length === 0) return null;
  return {
    acceptedCount: numberValue(row.acceptedCount),
    duplicateCount: numberValue(row.duplicateCount),
    expiresAt: stringOrNull(row.expiresAt),
    previewToken: row.previewToken,
    rejectedCount: numberValue(row.rejectedCount),
    totalCount: numberValue(row.totalCount),
  };
}

function cookieValue(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

async function payloadDigest(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function intentKey(namespace: string, payload: string): Promise<string> {
  const storageKey = `selinow:onboarding:intent:${namespace}`;
  try {
    const digest = await payloadDigest(payload);
    const existing = JSON.parse(sessionStorage.getItem(storageKey) ?? "null") as unknown;
    const row = asRecord(existing);
    if (row !== null && row.payloadDigest === digest && typeof row.key === "string") return row.key;
    const key = crypto.randomUUID();
    sessionStorage.setItem(storageKey, JSON.stringify({ key, payloadDigest: digest }));
    return key;
  } catch {
    return crypto.randomUUID();
  }
}

function clearLegacyIntentPayloads(): void {
  try {
    const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
      .filter((key): key is string => key?.startsWith("selinow:onboarding:intent:") === true);
    for (const key of keys) {
      const row = asRecord(JSON.parse(sessionStorage.getItem(key) ?? "null") as unknown);
      if (row !== null && typeof row.payload === "string") sessionStorage.removeItem(key);
    }
  } catch {
    // Invalid or unavailable storage must not block onboarding.
  }
}

function clearIntent(namespace: string): void {
  try {
    sessionStorage.removeItem(`selinow:onboarding:intent:${namespace}`);
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }
}

async function requestApi(root: HTMLElement, url: string, options: RequestInit & { idempotencyKey?: string } = {}): Promise<unknown> {
  const headers = new Headers(options.headers);
  const method = options.method?.toUpperCase() ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    const csrfName = root.dataset.csrfCookieName ?? "";
    const csrf = cookieValue(csrfName);
    if (csrf === null) throw new ApiError("csrf_invalid", 403, [], null);
    headers.set("X-CSRF-Token", csrf);
    if (options.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  if (options.idempotencyKey !== undefined) headers.set("Idempotency-Key", options.idempotencyKey);
  const response = await fetch(url, { ...options, credentials: "same-origin", headers });
  const contentType = response.headers.get("Content-Type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const row = asRecord(body) ?? {};
    throw new ApiError(
      typeof row.code === "string" ? row.code : "request_failed",
      response.status,
      Array.isArray(row.issues) ? row.issues.filter((issue): issue is string => typeof issue === "string") : [],
      typeof row.requestId === "string" ? row.requestId : null,
    );
  }
  return body;
}

// Cloudflare's HTMLRewriter Element collides with DOM Element in the shared worker/browser type graph.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function query<T>(root: HTMLElement, selector: string): T | null {
  return root.querySelector(selector) as unknown as T | null;
}

function queryAll<T>(root: HTMLElement, selector: string): T[] {
  return Array.from(root.querySelectorAll(selector)) as unknown as T[];
}

type OnboardingFormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const GLOBAL_FEEDBACK_ID = "onboarding-global-feedback";

function clearFieldError(field: OnboardingFormField): void {
  field.removeAttribute("aria-invalid");
  const describedBy = (field.getAttribute("aria-describedby") ?? "")
    .split(/\s+/u)
    .filter((id) => id.length > 0 && id !== GLOBAL_FEEDBACK_ID);
  if (describedBy.length === 0) field.removeAttribute("aria-describedby");
  else field.setAttribute("aria-describedby", describedBy.join(" "));
}

function clearInvalidFields(root: HTMLElement): void {
  for (const field of queryAll<OnboardingFormField>(root, '[aria-invalid="true"]')) clearFieldError(field);
}

function markFieldInvalid(root: HTMLElement, field: OnboardingFormField | null, message: string): void {
  clearInvalidFields(root);
  setFeedback(root, message, "error");
  if (field === null) return;
  field.setAttribute("aria-invalid", "true");
  const describedBy = new Set((field.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter((id) => id.length > 0));
  describedBy.add(GLOBAL_FEEDBACK_ID);
  field.setAttribute("aria-describedby", Array.from(describedBy).join(" "));
  field.focus();
}

function firstNativeInvalidField(form: HTMLFormElement): OnboardingFormField | null {
  for (const element of Array.from(form.elements)) {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)) continue;
    if (element.willValidate && !element.validity.valid) return element;
  }
  return null;
}

function focusNativeFormError(root: HTMLElement, form: HTMLFormElement, message: string): boolean {
  const field = firstNativeInvalidField(form);
  if (field === null) return false;
  markFieldInvalid(root, field, message);
  return true;
}

function setText(root: HTMLElement, selector: string, value: string): void {
  const element = query<HTMLElement>(root, selector);
  if (element !== null) element.textContent = value;
}

function preferredScrollBehavior(): ScrollBehavior {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  } catch {
    return "auto";
  }
}

function setFeedback(root: HTMLElement, message: string, tone: "error" | "info" | "success" = "info"): void {
  const feedback = query<HTMLElement>(root, "[data-global-feedback]");
  if (feedback === null) return;
  feedback.textContent = message;
  feedback.dataset.tone = tone;
  feedback.setAttribute("role", tone === "error" ? "alert" : "status");
  feedback.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
  feedback.hidden = message.length === 0;
  if (message.length > 0) feedback.scrollIntoView({ behavior: preferredScrollBehavior(), block: "nearest" });
}

function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return copy("onboarding.feedback.server", "The server could not be reached. Check your connection and try again.");
  const message = copy(readableErrorKey(error.code, error.issues), undefined, "The request could not be completed.");
  return error.requestId === null ? message : `${message} ${copy("onboarding.feedback.support_code", { code: error.requestId }, "Support code: {code}.")}`;
}

function setBusy(button: HTMLButtonElement | null, busy: boolean, busyText = "Processing…"): void {
  if (button === null) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent;
    button.dataset.disabledBeforeBusy = button.disabled ? "true" : "false";
    button.textContent = busyText;
    button.dataset.busy = "true";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalLabel ?? button.textContent;
    button.dataset.busy = "false";
    button.disabled = button.dataset.disabledBeforeBusy === "true";
    delete button.dataset.disabledBeforeBusy;
  }
}

function selectedShop(state: PageState, shops: readonly Shop[]): Shop | null {
  return shops.find((shop) => shop.publicId === state.selectedShopId) ?? null;
}

function selectionIsCurrent(state: PageState, shopId: string, epoch: number): boolean {
  return state.selectedShopId === shopId && state.shopSelectionEpoch === epoch;
}

function clearTenantBoundDrafts(root: HTMLElement, state: PageState): void {
  for (const selector of [
    "[data-channels-form]",
    "[data-product-form]",
    "[data-inventory-form]",
    "[data-telegram-form]",
    "[data-payos-form]",
    "[data-settings-form]",
    "[data-test-order-form]",
  ]) {
    query<HTMLFormElement>(root, selector)?.reset();
  }
  state.inventoryPreview = null;
  state.automationTasks = [];
  updateLocalInventoryPreview(root);
  setText(root, "[data-preview-expiry]", copy("onboarding.inventory.preview_not_created", "Preview has not been created."));
  const inventoryConfirm = query<HTMLButtonElement>(root, "[data-inventory-confirm]");
  if (inventoryConfirm !== null) inventoryConfirm.disabled = true;
  clearTestOrderResult(root);
}

function apiBase(shopId: string): string {
  return `/api/app/shops/${encodeURIComponent(shopId)}`;
}

function initialProfile(shop: Shop): OnboardingProfileView {
  return {
    customDomainPreference: "later",
    telegramEnabled: shop.planCode === "bot",
    websiteEnabled: shop.featureFlags.storefront === true,
  };
}

function readinessMessage(check: ReadinessCheckView): string {
  const aliases: Readonly<Record<string, string>> = {
    channels_selected: "channel_selected",
    integration_errors_clear: "integration_health",
    inventory_or_fulfillment_ready: "fulfillment_ready",
    platform_domain_active: "platform_domain_ready",
    shop_state_publishable: "shop_state",
    subscription_publishable: "subscription_publish",
  };
  const sourceKey = check.messageKey || check.code;
  const key = aliases[sourceKey] ?? sourceKey;
  return copy(`onboarding.readiness.check.${key}`, key.replaceAll("_", " "));
}

function showStep(root: HTMLElement, state: PageState, code: WizardStepCode, focus = true): void {
  for (const button of queryAll<HTMLButtonElement>(root, "[data-step-button]")) {
    const active = button.dataset.stepButton === code;
    if (active) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  }
  for (const panel of queryAll<HTMLElement>(root, "[data-step-panel]")) {
    const active = panel.dataset.stepPanel === code;
    panel.hidden = !active;
    if (active && focus) {
      panel.tabIndex = -1;
      panel.focus({ preventScroll: true });
      panel.scrollIntoView({ behavior: preferredScrollBehavior(), block: "start" });
    }
  }
  try {
    sessionStorage.setItem(`selinow:onboarding:step:${state.selectedShopId ?? "new"}`, code);
  } catch {
    // Navigation still works without storage.
  }
}

function renderShopSelection(root: HTMLElement, state: PageState, shops: readonly Shop[]): void {
  const shop = selectedShop(state, shops);
  const block = query<HTMLElement>(root, "[data-existing-shop-block]");
  const select = query<HTMLSelectElement>(root, "[data-shop-select]");
  const renameForm = query<HTMLFormElement>(root, "[data-shop-rename-form]");
  const renameInput = query<HTMLInputElement>(root, "[data-shop-rename-name]");
  if (block !== null) block.hidden = shops.length === 0;
  if (select !== null) {
    for (const option of Array.from(select.options)) {
      const optionShop = shops.find((item) => item.publicId === option.value);
      if (optionShop !== undefined) option.textContent = `${optionShop.name} — ${optionShop.slug}`;
    }
    select.value = shop?.publicId ?? "";
  }
  const baseDomain = root.dataset.platformBaseDomain ?? "selinow.com";
  setText(root, "[data-shop-summary]", shop === null
    ? copy("onboarding.shop.none", "No store selected.")
    : copy("onboarding.shop.summary", "{slug}.{domain} · {plan} · {state}", { domain: baseDomain, plan: shop.planCode, slug: shop.slug, state: shop.subscriptionState }));
  setText(root, "[data-product-price-label]", copy("onboarding.catalog.price_label", { currency: shop?.currency ?? "—" }, "Price ({currency})"));
  const currency = normalizeCurrencyCode(shop?.currency ?? root.dataset.defaultCurrency);
  const priceInput = query<HTMLInputElement>(root, "[data-product-price]");
  if (currency !== null && priceInput !== null) {
    priceInput.step = currencyInputStep(currency);
    priceInput.placeholder = formatMinorAmountForInput(199000, currency);
  }
  for (const [selector, value] of [
    ["[data-settings-merchant-country]", shop?.merchantCountry ?? ""],
    ["[data-settings-business-country]", shop?.businessCountry ?? ""],
  ] as const) {
    const field = query<HTMLInputElement>(root, selector);
    if (field !== null) field.value = value;
  }
  const settingsCurrency = query<HTMLSelectElement>(root, "[data-settings-currency]");
  if (settingsCurrency !== null && currency !== null) settingsCurrency.value = currency;
  const settingsLocale = query<HTMLSelectElement>(root, "[data-settings-default-locale]");
  if (settingsLocale !== null) settingsLocale.value = matchSupportedLocale(shop?.defaultLocale ?? root.dataset.defaultLocale) ?? "en";
  if (renameForm !== null) {
    const canRename = shop !== null && (shop.role === "owner" || shop.role === "manager");
    renameForm.hidden = !canRename;
    renameForm.setAttribute("aria-hidden", canRename ? "false" : "true");
    if (renameInput !== null) renameInput.value = shop?.name ?? "";
  }
  const storefrontLink = query<HTMLAnchorElement>(root, "[data-storefront-link]");
  if (storefrontLink !== null) storefrontLink.href = shop === null ? "#" : `https://${shop.slug}.${baseDomain}`;
  const domainManagementLink = query<HTMLAnchorElement>(root, "[data-domain-management-link]");
  if (domainManagementLink !== null) domainManagementLink.href = shop === null
    ? "/app/domains"
    : `/app/domains?shop=${encodeURIComponent(shop.publicId)}`;
}

function renderCatalog(root: HTMLElement, state: PageState): void {
  const activeProducts = state.catalogProducts.filter((product) => product.status === "active");
  const availableStock = state.catalogVariants.reduce((total, variant) => total + Math.max(0, variant.availableStock), 0);
  const summary = query<HTMLElement>(root, "[data-catalog-summary]");
  if (summary !== null) {
    summary.replaceChildren();
    const line = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = copy("onboarding.catalog.summary", "{products} products · {variants} offers · {stock} keys available", { products: state.catalogProducts.length, stock: availableStock, variants: state.catalogVariants.length });
    line.appendChild(strong);
    summary.appendChild(line);
  }
  const select = query<HTMLSelectElement>(root, "[data-inventory-variant]");
  if (select !== null) {
    const previous = select.value;
    select.replaceChildren(new Option(copy("onboarding.catalog.select_variant", "Select an offer"), ""));
    for (const variant of state.catalogVariants.filter((item) => item.status === "active")) {
      const product = state.catalogProducts.find((item) => item.id === variant.productId);
      select.add(new Option(`${product?.title ?? copy("onboarding.catalog.product_label", "Product")} — ${variant.title} (${variant.sku})`, variant.id));
    }
    if (Array.from(select.options).some((option) => option.value === previous)) select.value = previous;
    else if (select.options.length === 2) select.selectedIndex = 1;
  }
  const testOrderSelect = query<HTMLSelectElement>(root, "[data-test-order-variant]");
  if (testOrderSelect !== null) {
    const previous = testOrderSelect.value;
    testOrderSelect.replaceChildren(new Option(copy("onboarding.catalog.test_variant", "Choose a suitable offer"), ""));
    for (const variant of state.catalogVariants.filter((item) => item.status === "active")) {
      const product = state.catalogProducts.find((item) => item.id === variant.productId);
      testOrderSelect.add(new Option(`${product?.title ?? copy("onboarding.catalog.product_label", "Product")} — ${variant.title} (${variant.sku})`, variant.id));
    }
    if (Array.from(testOrderSelect.options).some((option) => option.value === previous)) testOrderSelect.value = previous;
  }
  if (activeProducts.length > 0) {
    const first = activeProducts[0];
    if (first !== undefined) {
      const title = query<HTMLInputElement>(root, "[data-product-title]");
      if (title !== null && title.value.length === 0) title.placeholder = copy("onboarding.catalog.existing_product", "Already exists: {title}", { title: first.title });
    }
  }
}

function renderTelegram(root: HTMLElement, integration: TelegramIntegration | null): void {
  const element = query<HTMLElement>(root, "[data-telegram-status]");
  if (element === null) return;
  element.replaceChildren();
  const paragraph = document.createElement("p");
  if (integration === null) {
    paragraph.textContent = copy("onboarding.integration.telegram.none", "Telegram bot is not connected.");
  } else {
    const strong = document.createElement("strong");
    strong.textContent = integration.bot === null ? "Telegram" : `${integration.bot.displayName} · @${integration.bot.username}`;
    const healthTime = integration.lastHealthUpdateAt;
    paragraph.appendChild(strong);
    const connectionText = integration.status === "active" && integration.webhookStatus === "verified"
      ? copy("onboarding.integration.telegram.connected", "Connected")
      : copy("onboarding.integration.telegram.pending", "Waiting to finish");
    paragraph.appendChild(document.createTextNode(` — ${connectionText}. ${healthTime === null ? copy("onboarding.integration.telegram.start_required", "Send /start in a private chat.") : copy("onboarding.integration.telegram.start_received", "Received /start.")}`));
  }
  element.appendChild(paragraph);
}

function renderPayos(root: HTMLElement, integration: PaymentIntegration | null): void {
  const element = query<HTMLElement>(root, "[data-payos-status]");
  if (element === null) return;
  element.replaceChildren();
  const paragraph = document.createElement("p");
  if (integration === null) paragraph.textContent = copy("onboarding.integration.payos.none", "PayOS is not connected.");
  else {
    const strong = document.createElement("strong");
    strong.textContent = "PayOS";
    paragraph.appendChild(strong);
    const connectionText = integration.status === "active" && integration.webhookStatus === "verified"
      ? copy("onboarding.integration.telegram.connected", "Connected")
      : copy("onboarding.integration.payos.recheck", "Needs another check");
    const lastCheck = integration.lastCheckedAt === null
      ? copy("onboarding.integration.payos.not_checked", "Connection has not been checked.")
      : copy("onboarding.integration.payos.checked_at", "Checked at {time}.", { time: new Date(integration.lastCheckedAt).toLocaleString(activeLocale) });
    const safeError = integration.lastSafeErrorCode === null ? "" : copy("onboarding.integration.payos.last_failed", " The latest check did not pass.");
    paragraph.appendChild(document.createTextNode(` — ${connectionText}. ${lastCheck}${safeError}`));
  }
  element.appendChild(paragraph);
}

const AUTOMATION_STATUS_COPY: Record<AutomationTaskStatus, { label: string; tone: string }> = {
  canceled: { label: "", tone: "neutral" },
  failed: { label: "", tone: "danger" },
  pending: { label: "", tone: "info" },
  retryable: { label: "", tone: "warning" },
  running: { label: "", tone: "info" },
  succeeded: { label: "", tone: "success" },
  waiting_provider: { label: "", tone: "warning" },
  waiting_user: { label: "", tone: "warning" },
};

const AUTOMATION_CAPABILITY_COPY: Readonly<Record<string, string>> = {
  "domain.custom.domain_connect": "onboarding.automation.capability.domain_connect",
  "domain.custom.manual_dns": "onboarding.automation.capability.manual_dns",
  "domain.platform.provision": "onboarding.automation.capability.platform_provision",
  "payments.payos.channel_create": "onboarding.automation.capability.payos_create",
  "shop.provision": "onboarding.automation.capability.shop_provision",
  "telegram.bot.create": "onboarding.automation.capability.telegram_create",
};

function automationTaskLabel(task: AutomationTask): string {
  const key = AUTOMATION_CAPABILITY_COPY[task.capabilityCode];
  return key === undefined ? copy("onboarding.automation.capability.fallback", "Platform setup task") : copy(key, "Platform setup task");
}

function automationTaskImpact(task: AutomationTask): string {
  if (task.status === "waiting_user") return copy("onboarding.automation.task_waiting_user", "Selinow is waiting for your confirmation before continuing.");
  if (task.status === "waiting_provider") return copy("onboarding.automation.task_waiting_provider", "Selinow will continue after it receives fresh evidence from the provider.");
  if (task.status === "retryable") return task.nextAttemptAt === null
    ? copy("onboarding.automation.task_retryable", "This task can be safely retried.")
    : copy("onboarding.automation.task_retryable_at", "The system can retry after {time}.", { time: new Date(task.nextAttemptAt).toLocaleString(activeLocale) });
  if (task.status === "running" || task.status === "pending") return copy("onboarding.automation.task_pending", "You can leave this page; progress is saved on the server and no duplicate resources are created.");
  if (task.status === "failed") return copy("onboarding.automation.task_failed", "The task stopped safely. Open the related step to check conditions before creating it again.");
  if (task.status === "canceled") return copy("onboarding.automation.task_canceled", "The task was canceled and the scheduler will not continue it.");
  return copy("onboarding.automation.task_done", "The task completed and evidence was saved as a safe reference.");
}

async function mutateAutomationTask(
  root: HTMLElement,
  state: PageState,
  shops: readonly Shop[],
  task: AutomationTask,
  action: "cancel" | "resume",
  button: HTMLButtonElement,
): Promise<void> {
  const shop = selectedShop(state, shops);
  if (shop === null) { showStep(root, state, "shop"); return; }
  if (action === "cancel" && !window.confirm(copy("onboarding.automation.cancel_confirm", "Cancel this task? The scheduler will stop processing it; completed data will not be deleted."))) return;
  const selectionEpoch = state.shopSelectionEpoch;
  const payload = action === "cancel"
    ? JSON.stringify({ expectedVersion: task.version, reasonCode: "seller_onboarding_cancel" })
    : JSON.stringify({ expectedVersion: task.version });
  const namespace = `automation-${action}-${shop.publicId}-${task.id}-${String(task.version)}`;
  setBusy(button, true, action === "resume" ? copy("onboarding.busy.resuming", "Resuming…") : copy("onboarding.busy.canceling", "Canceling…"));
  try {
    const response = asRecord(await requestApi(
      root,
      `${apiBase(shop.publicId)}/automation/${encodeURIComponent(task.id)}/${action}`,
      { body: payload, idempotencyKey: await intentKey(namespace, payload), method: "POST" },
    ));
    if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
    const updated = parseAutomationTasks({ tasks: [response?.task] })[0];
    if (updated === undefined) throw new ApiError("request_failed", 500, [], null);
    state.automationTasks = state.automationTasks.map((item) => item.id === updated.id ? updated : item);
    clearIntent(namespace);
    renderAutomationTasks(root, state, shops);
    setFeedback(root, action === "resume" ? copy("onboarding.feedback.automation_resumed", "The task received fresh evidence and resumed safely.") : copy("onboarding.feedback.automation_canceled", "The task was canceled."), "success");
  } catch (error) {
    if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
    if (error instanceof ApiError && error.code === "automation_provider_evidence_pending") {
      setFeedback(root, copy("onboarding.feedback.provider_pending", "The provider has not returned fresh evidence. Finish the external step and check again."), "info");
    } else {
      setFeedback(root, errorMessage(error), "error");
    }
    await loadAutomationTasks(root, state, shops);
  } finally {
    setBusy(button, false);
  }
}

function renderAutomationTasks(root: HTMLElement, state: PageState, shops: readonly Shop[]): void {
  const list = query<HTMLElement>(root, "[data-automation-list]");
  if (list === null) return;
  list.replaceChildren();
  list.setAttribute("aria-busy", "false");
  if (state.automationTasks.length === 0) {
    const empty = document.createElement("div");
    empty.className = "automation-empty";
    const title = document.createElement("strong");
    title.textContent = copy("onboarding.automation.empty", "No automation tasks yet");
    const copyBlock = document.createElement("p");
    copyBlock.textContent = copy("onboarding.automation.empty_copy", "Provisioning, Telegram, PayOS, or domain tasks appear here when the backend creates them.");
    empty.appendChild(title);
    empty.appendChild(copyBlock);
    list.appendChild(empty);
    return;
  }
  for (const task of state.automationTasks) {
    const row = document.createElement("article");
    row.className = "automation-task";
    row.dataset.status = task.status;

    const status = document.createElement("span");
    status.className = "automation-status";
    status.dataset.tone = AUTOMATION_STATUS_COPY[task.status].tone;
    status.textContent = copy(`onboarding.status.automation.${task.status}`, "Processing");

    const copyBlock = document.createElement("div");
    copyBlock.className = "automation-copy";
    const title = document.createElement("strong");
    title.textContent = automationTaskLabel(task);
    const impact = document.createElement("p");
    impact.textContent = automationTaskImpact(task);
    const meta = document.createElement("small");
    meta.textContent = copy("onboarding.automation.updated", "Updated {time} · {count} attempts", { count: task.attemptCount, time: new Date(task.updatedAt).toLocaleString(activeLocale) });
    copyBlock.appendChild(title);
    copyBlock.appendChild(impact);
    copyBlock.appendChild(meta);
    if (task.lastSafeErrorCode !== null) {
      const code = document.createElement("code");
      code.textContent = task.lastSafeErrorCode;
      code.setAttribute("aria-label", copy("onboarding.automation.safe_error", "Safe status code {code}", { code: task.lastSafeErrorCode }));
      copyBlock.appendChild(code);
    }

    const actions = document.createElement("div");
    actions.className = "automation-actions";
    const actionLink = document.createElement("a");
    actionLink.href = task.actionUrl;
    actionLink.textContent = copy("onboarding.automation.open_step", "Open related step");
    actions.appendChild(actionLink);
    if (task.continuation !== null) {
      const resume = document.createElement("button");
      resume.type = "button";
      resume.className = "secondary-action";
      resume.textContent = task.continuation.kind === "provider_check" ? copy("onboarding.button.check_connection", "Check connection") : copy("onboarding.automation.resume", "Resume");
      resume.addEventListener("click", () => { void mutateAutomationTask(root, state, shops, task, "resume", resume); });
      actions.appendChild(resume);
    }
    if (task.canCancel) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "automation-cancel";
      cancel.textContent = copy("onboarding.automation.cancel", "Cancel");
      cancel.addEventListener("click", () => { void mutateAutomationTask(root, state, shops, task, "cancel", cancel); });
      actions.appendChild(cancel);
    }

    row.appendChild(status);
    row.appendChild(copyBlock);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

async function loadAutomationTasks(root: HTMLElement, state: PageState, shops: readonly Shop[]): Promise<void> {
  const shop = selectedShop(state, shops);
  const list = query<HTMLElement>(root, "[data-automation-list]");
  if (list !== null) list.setAttribute("aria-busy", "true");
  if (shop === null) {
    state.automationTasks = [];
    renderAutomationTasks(root, state, shops);
    return;
  }
  const selectionEpoch = state.shopSelectionEpoch;
  try {
    const response = await requestApi(root, `${apiBase(shop.publicId)}/automation?limit=20`);
    if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
    state.automationTasks = parseAutomationTasks(response);
    renderAutomationTasks(root, state, shops);
  } catch (error) {
    if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
    state.automationTasks = [];
    if (list !== null) {
      list.replaceChildren();
      list.setAttribute("aria-busy", "false");
      const failure = document.createElement("div");
      failure.className = "automation-empty automation-error";
      const title = document.createElement("strong");
      title.textContent = copy("onboarding.automation.empty", "Could not read automation tasks");
      const copyBlock = document.createElement("p");
      copyBlock.textContent = errorMessage(error);
      failure.appendChild(title);
      failure.appendChild(copyBlock);
      list.appendChild(failure);
    }
  }
}

function formatTestMoney(totalMinor: number | null, currency: string | null): string {
  if (totalMinor === null || currency === null) return copy("onboarding.test.na", "Not applicable");
  try {
    return formatMoney(totalMinor, currency, document.documentElement.lang || "en");
  } catch {
    return `${String(totalMinor)} ${currency}`;
  }
}

function renderTestOrderNotice(root: HTMLElement, tone: "error" | "info" | "success", titleText: string, copyText: string): void {
  const element = query<HTMLElement>(root, "[data-test-order-result]");
  if (element === null) return;
  element.replaceChildren();
  element.dataset.tone = tone;
  element.hidden = false;
  const title = document.createElement("h4");
  title.textContent = titleText;
  const copyBlock = document.createElement("p");
  copyBlock.textContent = copyText;
  element.appendChild(title);
  element.appendChild(copyBlock);
}

function renderTestOrderResult(root: HTMLElement, result: ControlledTestOrderView): void {
  const inventoryMessages: Record<string, string> = {
    test_currency_mismatch: copy("onboarding.test.inventory.currency_mismatch", "Offer currency does not match the store"),
    test_inventory_available: copy("onboarding.test.inventory.available", "Enough license keys are available"),
    test_inventory_unavailable: copy("onboarding.test.inventory.unavailable", "Not enough license keys are available"),
    test_manual_fulfillment_ready: copy("onboarding.test.inventory.manual", "Manual fulfillment offer is ready"),
    test_quantity_out_of_range: copy("onboarding.test.inventory.quantity", "Quantity is outside the offer limits"),
    test_variant_unavailable: copy("onboarding.test.inventory.variant", "No suitable active offer is available"),
  };
  renderTestOrderNotice(
    root,
    result.passed ? "success" : "error",
    result.passed ? copy("onboarding.test.passed", "The safe test order passed.") : copy("onboarding.test.failed", "The safe test order did not pass."),
    copy("onboarding.test.read_only", "This is a read-only test: no order, payment, reservation, or license key is created or used."),
  );
  const element = query<HTMLElement>(root, "[data-test-order-result]");
  if (element === null) return;
  const stockText = result.inventory.availableCount === null
    ? copy("onboarding.test.na", "Not applicable")
    : copy("onboarding.test.stock", "{available} available / {quantity} needed", { available: result.inventory.availableCount, quantity: result.inventory.quantity });
  const telegramText = !result.telegramConfigured
    ? copy("onboarding.test.telegram_disabled", "Not enabled for this store")
    : result.telegramReady ? copy("onboarding.test.ready", "Ready") : copy("onboarding.test.recheck", "Needs another check");
  const details: Array<[string, string]> = [
    [copy("onboarding.test.product", "Product"), [result.inventory.productTitle, result.inventory.variantTitle].filter((value) => value !== null).join(" — ") || copy("onboarding.test.product_missing", "No suitable offer selected")],
    [copy("onboarding.test.inventory", "License inventory"), `${inventoryMessages[result.inventory.code] ?? copy("onboarding.test.inventory_recheck", "Inventory needs another check")} · ${stockText}`],
    [copy("onboarding.test.value", "Simulated value"), formatTestMoney(result.inventory.totalMinor, result.inventory.currency)],
    [copy("onboarding.test.overall", "Overall checks"), result.readinessReady ? copy("onboarding.test.overall_pass", "Pass") : copy("onboarding.test.overall_pending", "Required items remain")],
    ["PayOS", result.payosReady ? copy("onboarding.test.ready", "Ready") : copy("onboarding.test.recheck", "Needs another check")],
    ["Telegram", telegramText],
    [copy("onboarding.test.domain", "Domain"), result.domainReady ? copy("onboarding.test.ready", "Ready") : copy("onboarding.test.domain_pending", "Not ready")],
    [copy("onboarding.test.time", "Time"), result.checkedAt === null ? copy("onboarding.test.no_time", "Unavailable") : new Date(result.checkedAt).toLocaleString(activeLocale)],
  ];
  const list = document.createElement("dl");
  for (const [label, value] of details) {
    const term = document.createElement("dt");
    term.textContent = label;
    const description = document.createElement("dd");
    description.textContent = value;
    list.appendChild(term);
    list.appendChild(description);
  }
  element.appendChild(list);
}

function clearTestOrderResult(root: HTMLElement): void {
  const element = query<HTMLElement>(root, "[data-test-order-result]");
  if (element === null) return;
  element.replaceChildren();
  element.hidden = true;
  delete element.dataset.tone;
}

function renderReadiness(root: HTMLElement, state: PageState): void {
  const list = query<HTMLElement>(root, "[data-readiness-list]");
  if (list !== null) {
    list.replaceChildren();
    if (state.readiness.checks.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = copy("onboarding.readiness.empty", "No overall result yet. Run checks to receive specific guidance.");
      empty.className = "readiness-empty";
      list.appendChild(empty);
    } else {
      for (const check of state.readiness.checks) {
        const row = document.createElement("div");
        row.className = "readiness-check";
        row.dataset.tone = check.status;
        const icon = document.createElement("i");
        icon.textContent = check.status === "pass" ? "✓" : check.status === "warning" ? "!" : "×";
        icon.setAttribute("aria-hidden", "true");
        const copyBlock = document.createElement("span");
        const title = document.createElement("strong");
        title.textContent = readinessMessage(check);
        const meta = document.createElement("small");
        const statusLabel = check.status === "pass"
          ? copy("onboarding.readiness.pass", "Pass")
          : check.status === "warning" ? copy("onboarding.readiness.warning", "Needs attention") : copy("onboarding.readiness.fail", "Not passed");
        meta.textContent = `${statusLabel} · ${check.required ? copy("onboarding.readiness.required", "Required") : copy("onboarding.readiness.optional", "Optional")}`;
        copyBlock.appendChild(title);
        copyBlock.appendChild(meta);
        row.appendChild(icon);
        row.appendChild(copyBlock);
        if (check.actionUrl !== null && check.actionUrl.startsWith("/")) {
          const action = document.createElement("a");
          action.href = check.actionUrl;
          action.textContent = copy("onboarding.readiness.action", "Resolve");
          row.appendChild(action);
        }
        list.appendChild(row);
      }
    }
  }
  setText(root, "[data-readiness-title]", state.readiness.ready ? copy("onboarding.readiness.all_passed", "All required checks passed") : copy("onboarding.readiness.has_work", "Store has items to resolve"));
  setText(root, "[data-readiness-meta]", state.readiness.checkedAt === null
    ? copy("onboarding.readiness.no_time", "No check time is available.")
    : copy("onboarding.readiness.checked_at", "Checked at {time}.", { time: new Date(state.readiness.checkedAt).toLocaleString(activeLocale) }));
  setText(root, "[data-publish-title]", state.published
    ? copy("onboarding.readiness.store_live", "Store is open for sales.")
    : state.readiness.ready ? copy("onboarding.readiness.store_ready", "Store is ready to launch.") : copy("onboarding.readiness.store_pending", "Store is not ready to open for sales."));
  setText(root, "[data-publish-copy]", state.published
    ? copy("onboarding.readiness.live_copy", "The website is active; Selinow keeps safety checks running for later updates.")
    : state.readiness.ready ? copy("onboarding.readiness.ready_copy", "Selinow runs one final check immediately before changing status.") : copy("onboarding.readiness.publish_copy", "Complete required steps; optional warnings do not block launch."));
  const publish = query<HTMLButtonElement>(root, "[data-publish-button]");
  if (publish !== null) publish.disabled = !state.readiness.ready || state.published;
  const publishedResult = query<HTMLElement>(root, "[data-published-result]");
  if (publishedResult !== null) publishedResult.hidden = !state.published;
}

function stepFromHash(hash: string): WizardStepCode | null {
  const aliases: Record<string, WizardStepCode> = {
    catalog: "catalog",
    channels: "channels",
    domain: "settings",
    inventory: "inventory",
    payos: "payos",
    policies: "settings",
    readiness: "readiness",
    settings: "settings",
    shop: "shop",
    storefront: "channels",
    telegram: "telegram",
  };
  return aliases[hash.replace(/^#/u, "")] ?? null;
}

function renderProgress(root: HTMLElement, state: PageState, shops: readonly Shop[]): void {
  const shop = selectedShop(state, shops);
  const profile = state.onboarding.profile;
  const settingsReady = state.onboarding.settings !== null && settingsDraftReady(state.onboarding.settings);
  const fallback = deriveFallbackProgress({
    activeProductCount: state.catalogProducts.filter((product) => product.status === "active").length,
    availableInventoryCount: state.catalogVariants.reduce((total, variant) => total + Math.max(0, variant.availableStock), 0),
    hasManualProduct: state.catalogProducts.some((product) => product.status === "active" && product.fulfillmentType === "manual"),
    payosReady: state.payos?.status === "active" && state.payos.webhookStatus === "verified",
    profile,
    readinessReady: state.readiness.ready,
    settingsReady,
    shopExists: shop !== null,
    shopPublished: shop?.status === "active",
    telegramHealthReady: state.telegram !== null && hasAuthoritativeTelegramHealth(state.telegram.lastHealthUpdateAt),
    telegramReady: state.telegram?.status === "active" && state.telegram.webhookStatus === "verified",
  });
  const progress = mergeServerProgress(fallback, state.onboarding.steps);
  const percent = progressPercent(progress);
  const statusLabels: Record<WizardStepStatus, string> = {
    blocked: copy("onboarding.progress.blocked", undefined, "Blocked"),
    in_progress: copy("onboarding.progress.in_progress", undefined, "In progress"),
    not_started: copy("onboarding.progress.not_started", undefined, "Not started"),
    ready: copy("onboarding.progress.ready", undefined, "Complete"),
    warning: copy("onboarding.progress.warning", undefined, "Safely skipped"),
  };
  for (const step of WIZARD_STEPS) {
    const button = query<HTMLButtonElement>(root, `[data-step-button="${step.code}"]`);
    if (button !== null) {
      button.dataset.status = progress[step.code];
      button.setAttribute("aria-label", `${copy(step.labelKey, undefined, step.label)}: ${statusLabels[progress[step.code]]}`);
    }
  }
  const completed = WIZARD_STEPS.filter((step) => progress[step.code] === "ready" || progress[step.code] === "warning").length;
  setText(root, "[data-progress-percent]", `${String(percent)}%`);
  const poster = query<HTMLElement>(root, "[data-progress-poster]");
  if (poster !== null) {
    poster.setAttribute("aria-valuenow", String(percent));
    poster.setAttribute("aria-valuetext", copy("onboarding.progress.aria_value", { percent, completed, total: WIZARD_STEPS.length }, `${String(percent)}% — ${String(completed)}/${String(WIZARD_STEPS.length)} step groups`));
  }
  const bar = query<HTMLElement>(root, "[data-progress-bar]");
  if (bar !== null) bar.style.width = `${String(percent)}%`;
  setText(root, "[data-progress-copy]", copy("onboarding.progress.completed", { completed, total: WIZARD_STEPS.length }, `${String(completed)}/${String(WIZARD_STEPS.length)} step groups completed or safely skipped.`));
}

function prefillProfile(root: HTMLElement, profile: OnboardingProfileView): void {
  const website = query<HTMLInputElement>(root, "[data-channel-website]");
  const telegram = query<HTMLInputElement>(root, "[data-channel-telegram]");
  const domain = query<HTMLSelectElement>(root, "[data-domain-preference]");
  if (website !== null) website.checked = profile.websiteEnabled;
  if (telegram !== null) telegram.checked = profile.telegramEnabled;
  if (domain !== null) domain.value = profile.customDomainPreference;
}

function prefillSettings(root: HTMLElement, settings: OnboardingSettingsView): void {
  const values: Array<[string, string]> = [
    ["[data-support-contact]", settings.supportContact],
    ["[data-terms-url]", settings.termsUrl],
    ["[data-privacy-url]", settings.privacyUrl],
    ["[data-refund-url]", settings.refundPolicyUrl],
  ];
  for (const [selector, value] of values) {
    const input = query<HTMLInputElement>(root, selector);
    if (input !== null) input.value = value;
  }
  const attestation = query<HTMLInputElement>(root, "[data-attestation]");
  if (attestation !== null) attestation.checked = settings.attestationAccepted;
}

async function optionalRequest(root: HTMLElement, url: string): Promise<unknown> {
  try {
    return await requestApi(root, url);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

async function loadShopState(root: HTMLElement, state: PageState, shops: Shop[]): Promise<void> {
  const shop = selectedShop(state, shops);
  if (shop === null) {
    state.automationTasks = [];
    state.onboarding = { profile: null, settings: null, steps: new Map() };
    state.catalogProducts = [];
    state.catalogVariants = [];
    state.telegram = null;
    state.payos = null;
    state.published = false;
    state.domains = [];
    state.readiness = { checkedAt: null, checks: [], ready: false, runId: null };
    renderShopSelection(root, state, shops);
    renderCatalog(root, state);
    renderTelegram(root, null);
    renderPayos(root, null);
    renderAutomationTasks(root, state, shops);
    renderReadiness(root, state);
    renderProgress(root, state, shops);
    return;
  }
  const currentShopId = shop.publicId;
  const selectionEpoch = state.shopSelectionEpoch;
  state.catalogProducts = [];
  state.automationTasks = [];
  state.catalogVariants = [];
  state.domains = [];
  state.inventoryPreview = null;
  state.onboarding = { profile: initialProfile(shop), settings: null, steps: new Map() };
  state.payos = null;
  state.published = shop.status === "active";
  state.readiness = { checkedAt: null, checks: [], ready: false, runId: null };
  state.telegram = null;
  setFeedback(root, copy("onboarding.feedback.loading", "Syncing progress from the server…"));
  const base = apiBase(shop.publicId);
  const results = await Promise.allSettled([
    optionalRequest(root, `${base}/onboarding`),
    requestApi(root, `${base}/catalog`),
    requestApi(root, `${base}/integrations/telegram`),
    requestApi(root, `${base}/payments/payos`),
    requestApi(root, `${base}/domains`),
    optionalRequest(root, `${base}/readiness`),
  ]);
  if (!selectionIsCurrent(state, currentShopId, selectionEpoch)) return;
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) setFeedback(root, errorMessage(failures[0]?.reason), "error");
  else setFeedback(root, "");

  const onboardingValue = results[0].status === "fulfilled" ? results[0].value : null;
  state.onboarding = onboardingValue === null
    ? { profile: initialProfile(shop), settings: null, steps: new Map() }
    : parseOnboardingSnapshot(onboardingValue);
  if (state.onboarding.profile === null) state.onboarding.profile = initialProfile(shop);
  if (state.onboarding.steps.get("published") === "ready") state.published = true;
  if (results[1].status === "fulfilled") {
    const catalog = parseCatalog(results[1].value, shop.currency);
    state.catalogProducts = catalog.products;
    state.catalogVariants = catalog.variants;
  }
  if (results[2].status === "fulfilled") state.telegram = parseTelegram(results[2].value);
  if (results[3].status === "fulfilled") state.payos = parsePayos(results[3].value);
  if (results[4].status === "fulfilled") state.domains = parseDomains(results[4].value);
  const readinessValue = results[5].status === "fulfilled" ? results[5].value : null;
  state.readiness = readinessValue === null
    ? { checkedAt: null, checks: [], ready: false, runId: null }
    : parseReadinessChecks(readinessValue);

  renderShopSelection(root, state, shops);
  prefillProfile(root, state.onboarding.profile);
  if (state.onboarding.settings !== null) prefillSettings(root, state.onboarding.settings);
  renderCatalog(root, state);
  renderTelegram(root, state.telegram);
  renderPayos(root, state.payos);
  renderReadiness(root, state);
  renderProgress(root, state, shops);
  await loadAutomationTasks(root, state, shops);
}

function readSettingsForm(root: HTMLElement): OnboardingSettingsView {
  return {
    attestationAccepted: query<HTMLInputElement>(root, "[data-attestation]")?.checked === true,
    privacyUrl: query<HTMLInputElement>(root, "[data-privacy-url]")?.value.trim() ?? "",
    refundPolicyUrl: query<HTMLInputElement>(root, "[data-refund-url]")?.value.trim() ?? "",
    supportContact: query<HTMLInputElement>(root, "[data-support-contact]")?.value.trim() ?? "",
    termsUrl: query<HTMLInputElement>(root, "[data-terms-url]")?.value.trim() ?? "",
  };
}

type ShopGlobalizationDraft = {
  businessCountry: string | null;
  currency: string;
  defaultLocale: string;
  merchantCountry: string | null;
};

function readShopGlobalizationForm(root: HTMLElement): ShopGlobalizationDraft | null {
  const currency = normalizeCurrencyCode(query<HTMLSelectElement>(root, "[data-settings-currency]")?.value);
  const defaultLocale = matchSupportedLocale(query<HTMLSelectElement>(root, "[data-settings-default-locale]")?.value);
  if (currency === null || defaultLocale === null) return null;
  const countryValue = (selector: string): string | null => {
    const value = query<HTMLInputElement>(root, selector)?.value.trim().toUpperCase() ?? "";
    return value.length === 0 ? null : value;
  };
  return {
    businessCountry: countryValue("[data-settings-business-country]"),
    currency,
    defaultLocale,
    merchantCountry: countryValue("[data-settings-merchant-country]"),
  };
}

function updateLocalInventoryPreview(root: HTMLElement): void {
  const source = query<HTMLSelectElement>(root, "[data-inventory-source]")?.value === "csv" ? "csv" : "paste";
  const data = query<HTMLTextAreaElement>(root, "[data-inventory-data]")?.value ?? "";
  const summary = summarizeInventoryDraft(data, source);
  setText(root, "[data-preview-total]", String(summary.totalCount));
  setText(root, "[data-preview-accepted]", String(summary.acceptedCount));
  setText(root, "[data-preview-duplicate]", String(summary.duplicateCount));
  setText(root, "[data-preview-rejected]", String(summary.invalidCount));
}

function invalidateInventoryPreview(root: HTMLElement, state: PageState, message: string): void {
  state.inventoryPreview = null;
  const confirm = query<HTMLButtonElement>(root, "[data-inventory-confirm]");
  if (confirm !== null) confirm.disabled = true;
  setText(root, "[data-preview-expiry]", message);
}

function addShopOption(root: HTMLElement, shop: Shop): void {
  const select = query<HTMLSelectElement>(root, "[data-shop-select]");
  if (select === null) return;
  if (!Array.from(select.options).some((option) => option.value === shop.publicId)) select.add(new Option(`${shop.name} — ${shop.slug}`, shop.publicId));
  select.value = shop.publicId;
}

async function initialize(root: HTMLElement): Promise<void> {
  configureLocalization(root);
  const shops = parseShops(root.dataset.shops);
  const state: PageState = {
    automationTasks: [],
    catalogProducts: [],
    catalogVariants: [],
    domains: [],
    inventoryPreview: null,
    onboarding: { profile: null, settings: null, steps: new Map() },
    payos: null,
    published: false,
    readiness: { checkedAt: null, checks: [], ready: false, runId: null },
    selectedShopId: shops[0]?.publicId ?? null,
    shopSelectionEpoch: 0,
    telegram: null,
  };

  clearLegacyIntentPayloads();
  const clearEditedFieldError = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement) {
      clearFieldError(target);
    }
  };
  root.addEventListener("input", clearEditedFieldError);
  root.addEventListener("change", clearEditedFieldError);

  for (const button of queryAll<HTMLButtonElement>(root, "[data-step-button]")) {
    button.addEventListener("click", () => {
      const code = button.dataset.stepButton;
      if (WIZARD_STEPS.some((step) => step.code === code)) showStep(root, state, code as WizardStepCode);
    });
  }
  for (const button of queryAll<HTMLButtonElement>(root, "[data-next-step]")) {
    button.addEventListener("click", () => {
      const code = button.dataset.nextStep;
      if (WIZARD_STEPS.some((step) => step.code === code)) showStep(root, state, code as WizardStepCode);
    });
  }

  const shopSelect = query<HTMLSelectElement>(root, "[data-shop-select]");
  let productSlugEdited = false;
  shopSelect?.addEventListener("change", () => {
    state.shopSelectionEpoch += 1;
    state.selectedShopId = shopSelect.value || null;
    clearTenantBoundDrafts(root, state);
    productSlugEdited = false;
    void loadShopState(root, state, shops);
  });
  query<HTMLButtonElement>(root, "[data-refresh-shop]")?.addEventListener("click", () => { void loadShopState(root, state, shops); });
  query<HTMLButtonElement>(root, "[data-automation-refresh]")?.addEventListener("click", () => { void loadAutomationTasks(root, state, shops); });

  query<HTMLFormElement>(root, "[data-shop-rename-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const form = event.currentTarget as HTMLFormElement;
      const shop = selectedShop(state, shops);
      const input = query<HTMLInputElement>(root, "[data-shop-rename-name]");
      const submit = query<HTMLButtonElement>(root, "[data-shop-rename-submit]");
      if (shop === null || (shop.role !== "owner" && shop.role !== "manager") || input === null || submit === null) return;
      if (!form.reportValidity()) return;
      const name = input.value.trim().replace(/\s+/gu, " ");
      if (name.length < 2 || name.length > 80) {
        markFieldInvalid(root, input, copy("onboarding.feedback.name_length", "Store name must be between 2 and 80 characters."));
        return;
      }
      if (name === shop.name) {
        setFeedback(root, copy("onboarding.feedback.rename_unchanged", "The store name has not changed."), "info");
        return;
      }

      const selectionEpoch = state.shopSelectionEpoch;
      const payload = JSON.stringify({ name });
      clearFieldError(input);
      setBusy(submit, true, copy("onboarding.busy.saving", "Saving…"));
      setFeedback(root, copy("onboarding.feedback.rename_loading", "Updating store name…"), "info");
      try {
        const response = asRecord(await requestApi(root, apiBase(shop.publicId), { body: payload, method: "PATCH" })) ?? {};
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        const updated = response.shop;
        if (!isShop(updated)) throw new ApiError("request_failed", 500, [], stringOrNull(response.requestId));
        const index = shops.findIndex((item) => item.publicId === updated.publicId);
        if (index >= 0) shops[index] = updated;
        renderShopSelection(root, state, shops);
        setFeedback(root, copy("onboarding.feedback.renamed", "Store name updated."), "success");
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        setFeedback(root, errorMessage(error), "error");
      } finally {
        if (selectionIsCurrent(state, shop.publicId, selectionEpoch)) setBusy(submit, false);
      }
    })();
  });

  const shopName = query<HTMLInputElement>(root, "[data-shop-name]");
  const shopSlug = query<HTMLInputElement>(root, "[data-shop-slug]");
  let slugWasEdited = false;
  shopSlug?.addEventListener("input", () => {
    slugWasEdited = shopSlug.value.length > 0;
    setText(root, "[data-slug-preview]", `${shopSlug.value || "slug"}.${root.dataset.platformBaseDomain ?? "selinow.com"}`);
  });
  shopName?.addEventListener("input", () => {
    if (shopSlug === null || slugWasEdited) return;
    shopSlug.value = slugifyDraft(shopName.value);
    setText(root, "[data-slug-preview]", `${shopSlug.value || "slug"}.${root.dataset.platformBaseDomain ?? "selinow.com"}`);
  });

  query<HTMLFormElement>(root, "[data-shop-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const form = event.currentTarget as HTMLFormElement;
      const button = query<HTMLButtonElement>(root, "[data-shop-submit]");
      clearInvalidFields(root);
      if (focusNativeFormError(root, form, copy("onboarding.feedback.form_invalid_shop", "Check the highlighted fields before creating the store."))) return;
      const draft = validateShopDraft(shopName?.value ?? "", shopSlug?.value ?? "");
      const planCode = query<HTMLSelectElement>(root, "[data-shop-plan]")?.value ?? "store";
      const merchantCountry = query<HTMLInputElement>(root, "[data-shop-merchant-country]")?.value.trim().toUpperCase() ?? "";
      const businessCountry = query<HTMLInputElement>(root, "[data-shop-business-country]")?.value.trim().toUpperCase() ?? "";
      const currency = normalizeCurrencyCode(query<HTMLSelectElement>(root, "[data-shop-currency]")?.value);
      const defaultLocale = matchSupportedLocale(query<HTMLSelectElement>(root, "[data-shop-default-locale]")?.value);
      if (draft === null) {
        const name = shopName?.value.trim() ?? "";
        markFieldInvalid(root, name.length < 2 || name.length > 80 ? shopName : shopSlug, copy("onboarding.feedback.invalid_shop", "Store name or slug is invalid."));
        return;
      }
      if (currency === null || defaultLocale === null) {
        markFieldInvalid(root, currency === null ? query<HTMLSelectElement>(root, "[data-shop-currency]") : query<HTMLSelectElement>(root, "[data-shop-default-locale]"), copy("onboarding.feedback.invalid_shop_globalization", "Choose a supported currency and locale."));
        return;
      }
      const payload = JSON.stringify({
        ...draft,
        businessCountry: businessCountry.length === 0 ? null : businessCountry,
        currency,
        defaultLocale,
        merchantCountry: merchantCountry.length === 0 ? null : merchantCountry,
        planCode,
      });
      setBusy(button, true, copy("onboarding.busy.creating_shop", "Creating store…"));
      try {
        const response = asRecord(await requestApi(root, "/api/app/shops", { body: payload, idempotencyKey: await intentKey("shop", payload), method: "POST" })) ?? {};
        if (!isShop(response.shop)) throw new ApiError("request_failed", 500, [], stringOrNull(response.requestId));
        const shop = response.shop;
        if (!shops.some((item) => item.publicId === shop.publicId)) shops.push(shop);
        addShopOption(root, shop);
        state.shopSelectionEpoch += 1;
        state.selectedShopId = shop.publicId;
        clearTenantBoundDrafts(root, state);
        clearIntent("shop");
        query<HTMLFormElement>(root, "[data-shop-form]")?.reset();
        const details = query<HTMLDetailsElement>(root, "[data-create-shop-box]");
        if (details !== null) details.open = false;
        setFeedback(root, copy("onboarding.feedback.created", "{name} created. The {host} subdomain is ready.", { host: `${shop.slug}.${root.dataset.platformBaseDomain ?? "selinow.com"}`, name: shop.name }), "success");
        await loadShopState(root, state, shops);
        showStep(root, state, "channels");
      } catch (error) {
        setFeedback(root, errorMessage(error), "error");
      } finally {
        setBusy(button, false);
      }
    })();
  });

  query<HTMLFormElement>(root, "[data-channels-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      clearInvalidFields(root);
      const shop = selectedShop(state, shops);
      if (shop === null) { showStep(root, state, "shop"); return; }
      const selectionEpoch = state.shopSelectionEpoch;
      const websiteEnabled = query<HTMLInputElement>(root, "[data-channel-website]")?.checked === true;
      const telegramEnabled = query<HTMLInputElement>(root, "[data-channel-telegram]")?.checked === true;
      const preferenceValue = query<HTMLSelectElement>(root, "[data-domain-preference]")?.value;
      const customDomainPreference = preferenceValue === "connect" || preferenceValue === "skip" ? preferenceValue : "later";
      if (!websiteEnabled && !telegramEnabled) { markFieldInvalid(root, query<HTMLInputElement>(root, "[data-channel-website]"), copy("onboarding.channels.no_channel", "Choose at least the website or Telegram.")); return; }
      if (customDomainPreference === "connect" && !websiteEnabled) { markFieldInvalid(root, query<HTMLSelectElement>(root, "[data-domain-preference]"), copy("onboarding.channels.domain_requires_website", "A custom domain requires the storefront website.")); return; }
      if (websiteEnabled && shop.featureFlags.storefront !== true) { markFieldInvalid(root, query<HTMLInputElement>(root, "[data-channel-website]"), copy("onboarding.channels.plan_website", "Your current plan does not include the storefront website.")); return; }
      if (telegramEnabled && shop.featureFlags.telegram !== true) { markFieldInvalid(root, query<HTMLInputElement>(root, "[data-channel-telegram]"), copy("onboarding.channels.plan_telegram", "Your current plan does not include Telegram.")); return; }
      if (customDomainPreference === "connect" && shop.featureFlags.customDomain !== true) { markFieldInvalid(root, query<HTMLSelectElement>(root, "[data-domain-preference]"), copy("onboarding.channels.plan_domain", "Your current plan does not include custom domains.")); return; }
      const button = query<HTMLButtonElement>(root, "[data-channels-submit]");
      setBusy(button, true, copy("onboarding.busy.saving", "Saving…"));
      try {
        const body = JSON.stringify({ customDomainPreference, telegramEnabled, websiteEnabled });
        const response = await requestApi(root, `${apiBase(shop.publicId)}/onboarding/channels`, { body, method: "PUT" });
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        state.onboarding = parseOnboardingSnapshot(response);
        if (state.onboarding.profile === null) state.onboarding.profile = { customDomainPreference, telegramEnabled, websiteEnabled };
        prefillProfile(root, state.onboarding.profile);
        setFeedback(root, copy("onboarding.feedback.channels_saved", "Sales channels and progress updated."), "success");
        renderProgress(root, state, shops);
        showStep(root, state, "catalog");
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        setFeedback(root, errorMessage(error), "error");
      } finally {
        setBusy(button, false);
      }
    })();
  });

  const productTitle = query<HTMLInputElement>(root, "[data-product-title]");
  const productSlug = query<HTMLInputElement>(root, "[data-product-slug]");
  const productSku = query<HTMLInputElement>(root, "[data-product-sku]");
  productSlug?.addEventListener("input", () => { productSlugEdited = productSlug.value.length > 0; });
  productTitle?.addEventListener("input", () => {
    const slug = slugifyDraft(productTitle.value);
    if (productSlug !== null && !productSlugEdited) productSlug.value = slug;
    if (productSku !== null && productSku.value.length === 0) productSku.value = slug.replaceAll("-", "_").toUpperCase().slice(0, 64);
  });

  query<HTMLFormElement>(root, "[data-product-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const form = event.currentTarget as HTMLFormElement;
      clearInvalidFields(root);
      const shop = selectedShop(state, shops);
      if (shop === null) { showStep(root, state, "shop"); return; }
      const selectionEpoch = state.shopSelectionEpoch;
      if (focusNativeFormError(root, form, copy("onboarding.feedback.form_invalid_product", "Check the highlighted fields before creating the product."))) return;
      const draft = validateProductDraft({
        currency: shop.currency,
        description: query<HTMLTextAreaElement>(root, "[data-product-description]")?.value ?? "",
        fulfillmentType: query<HTMLSelectElement>(root, "[data-fulfillment-type]")?.value ?? "",
        priceMajor: query<HTMLInputElement>(root, "[data-product-price]")?.value ?? "",
        productSlug: productSlug?.value ?? "",
        sku: productSku?.value ?? "",
        title: productTitle?.value ?? "",
        variantTitle: query<HTMLInputElement>(root, "[data-variant-title]")?.value ?? "",
      });
      if (draft === null) {
        const invalidSlug = (productSlug?.value ?? "").includes("--") || (productSlug?.value.trim().length ?? 0) < 2;
        markFieldInvalid(root, invalidSlug ? productSlug : productSku, copy("onboarding.feedback.invalid_product", "Check the name, slug, SKU, offer, and price."));
        return;
      }
      const button = query<HTMLButtonElement>(root, "[data-product-submit]");
      setBusy(button, true, copy("onboarding.busy.creating_product", "Creating product…"));
      try {
        let product = state.catalogProducts.find((item) => item.slug === draft.productSlug);
        const conflictingSku = state.catalogVariants.find((item) => item.sku === draft.sku && item.productId !== product?.id);
        if (conflictingSku !== undefined) throw new ApiError("catalog_conflict", 409, [], null);
        let variant: CatalogVariant | undefined;
        if (product !== undefined) {
          const currentProductId = product.id;
          variant = state.catalogVariants.find((item) => item.sku === draft.sku && item.productId === currentProductId);
        }
        if (product !== undefined && (product.title !== draft.title || product.fulfillmentType !== draft.fulfillmentType)) throw new ApiError("catalog_conflict", 409, [], null);
        if (product === undefined) {
          const namespace = `catalog-product:${shop.publicId}`;
          const payload = JSON.stringify({
            categoryId: null,
            description: draft.description,
            fulfillmentType: draft.fulfillmentType,
            initialVariant: {
              compareAtMinor: null,
              currency: shop.currency,
              maxPerOrder: 10,
              minPerOrder: 1,
              options: {},
              priceMinor: draft.priceMinor,
              sku: draft.sku,
              status: "active",
              title: draft.variantTitle,
            },
            slug: draft.productSlug,
            status: "active",
            title: draft.title,
          });
          const response = asRecord(await requestApi(root, `${apiBase(shop.publicId)}/products`, {
            body: payload,
            idempotencyKey: await intentKey(namespace, payload),
            method: "POST",
          })) ?? {};
          if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
          const productRow = asRecord(response.product);
          const variantRow = asRecord(response.variant);
          if (
            productRow === null
            || typeof productRow.id !== "string"
            || variantRow === null
            || typeof variantRow.id !== "string"
            || variantRow.productId !== productRow.id
          ) {
            throw new ApiError("request_failed", 500, [], stringOrNull(response.requestId));
          }
          product = { description: draft.description, fulfillmentType: draft.fulfillmentType, id: productRow.id, slug: draft.productSlug, status: "active", title: draft.title };
          variant = { availableStock: 0, currency: shop.currency, id: variantRow.id, priceMinor: draft.priceMinor, productId: productRow.id, sku: draft.sku, status: "active", title: draft.variantTitle };
          clearIntent(namespace);
        } else if (variant === undefined) {
          const response = asRecord(await requestApi(root, `${apiBase(shop.publicId)}/products/${encodeURIComponent(product.id)}/variants`, {
            body: JSON.stringify({ compareAtMinor: null, currency: shop.currency, maxPerOrder: 10, minPerOrder: 1, options: {}, priceMinor: draft.priceMinor, sku: draft.sku, status: "active", title: draft.variantTitle }),
            method: "POST",
          })) ?? {};
          if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
          const row = asRecord(response.variant);
          if (row === null || typeof row.id !== "string") throw new ApiError("request_failed", 500, [], stringOrNull(response.requestId));
          variant = { availableStock: 0, currency: shop.currency, id: row.id, priceMinor: draft.priceMinor, productId: product.id, sku: draft.sku, status: "active", title: draft.variantTitle };
        }
        if (product.status !== "active") {
          await requestApi(root, `${apiBase(shop.publicId)}/products/${encodeURIComponent(product.id)}`, {
            body: JSON.stringify({ categoryId: null, description: draft.description, fulfillmentType: draft.fulfillmentType, slug: draft.productSlug, status: "active", title: draft.title }),
            method: "PUT",
          });
        }
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        setFeedback(root, copy("onboarding.feedback.product_ready", "{product} / {variant} is ready.", { product: draft.title, variant: variant.title }), "success");
        await loadShopState(root, state, shops);
        const inventorySelect = query<HTMLSelectElement>(root, "[data-inventory-variant]");
        if (inventorySelect !== null) inventorySelect.value = variant.id;
        showStep(root, state, draft.fulfillmentType === "manual" ? "telegram" : "inventory");
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        if (selectionIsCurrent(state, shop.publicId, selectionEpoch) && error instanceof ApiError && error.code === "catalog_conflict") {
          await loadShopState(root, state, shops);
        }
        setFeedback(root, errorMessage(error), "error");
      } finally {
        setBusy(button, false);
      }
    })();
  });

  const inventoryData = query<HTMLTextAreaElement>(root, "[data-inventory-data]");
  inventoryData?.addEventListener("input", () => {
    invalidateInventoryPreview(root, state, copy("onboarding.feedback.inventory_changed", "The content changed; create a new preview."));
    updateLocalInventoryPreview(root);
  });
  query<HTMLSelectElement>(root, "[data-inventory-source]")?.addEventListener("change", () => {
    invalidateInventoryPreview(root, state, copy("onboarding.feedback.format_changed", "The format changed; create a new preview."));
    updateLocalInventoryPreview(root);
  });
  query<HTMLSelectElement>(root, "[data-inventory-variant]")?.addEventListener("change", () => {
    invalidateInventoryPreview(root, state, copy("onboarding.feedback.variant_changed", "The offer changed; create a new preview."));
  });

  query<HTMLButtonElement>(root, "[data-inventory-preview-button]")?.addEventListener("click", () => {
    void (async () => {
      clearInvalidFields(root);
      const shop = selectedShop(state, shops);
      const variantId = query<HTMLSelectElement>(root, "[data-inventory-variant]")?.value ?? "";
      const source = query<HTMLSelectElement>(root, "[data-inventory-source]")?.value === "csv" ? "csv" : "paste";
      const data = inventoryData?.value ?? "";
      if (shop === null) { showStep(root, state, "shop"); return; }
      const selectionEpoch = state.shopSelectionEpoch;
      if (variantId.length === 0) { markFieldInvalid(root, query<HTMLSelectElement>(root, "[data-inventory-variant]"), copy("onboarding.feedback.inventory_variant_required", "Choose an offer to receive keys.")); return; }
      const local = summarizeInventoryDraft(data, source);
      updateLocalInventoryPreview(root);
      if (local.acceptedCount === 0 || local.duplicateCount > 0 || local.invalidCount > 0 || local.totalCount > 1_000) { markFieldInvalid(root, inventoryData, copy("onboarding.feedback.inventory_rows_invalid", "Remove duplicate or invalid lines before creating a preview.")); return; }
      const button = query<HTMLButtonElement>(root, "[data-inventory-preview-button]");
      invalidateInventoryPreview(root, state, copy("onboarding.inventory.preview_safe", "Creating a safe preview…"));
      setBusy(button, true, copy("onboarding.busy.previewing", "Creating preview…"));
      try {
        const response = await requestApi(root, `${apiBase(shop.publicId)}/variants/${encodeURIComponent(variantId)}/inventory/preview`, {
          body: JSON.stringify({ data, source }),
          method: "POST",
        });
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        const preview = parseInventoryPreview(response);
        if (preview === null) throw new ApiError("request_failed", 500, [], null);
        state.inventoryPreview = preview;
        setText(root, "[data-preview-total]", String(preview.totalCount));
        setText(root, "[data-preview-accepted]", String(preview.acceptedCount));
        setText(root, "[data-preview-duplicate]", String(preview.duplicateCount));
        setText(root, "[data-preview-rejected]", String(preview.rejectedCount));
        setText(root, "[data-preview-expiry]", preview.expiresAt === null
          ? copy("onboarding.feedback.preview_ready", "Preview is ready to confirm.")
          : copy("onboarding.feedback.preview_expired", "Preview expired at {time}.", { time: new Date(preview.expiresAt).toLocaleTimeString(activeLocale) }));
        const confirm = query<HTMLButtonElement>(root, "[data-inventory-confirm]");
        if (confirm !== null) confirm.disabled = preview.acceptedCount === 0 || preview.rejectedCount > 0 || preview.duplicateCount > 0;
        setFeedback(root, copy("onboarding.feedback.inventory_preview", "Preview complete. Key contents are never returned to the browser."), "success");
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        if (inventoryData !== null) inventoryData.value = "";
        updateLocalInventoryPreview(root);
        invalidateInventoryPreview(root, state, copy("onboarding.feedback.inventory_preview_failed", "Could not create the preview. Check your session and try again; no keys were imported."));
        setFeedback(root, errorMessage(error), "error");
      } finally {
        setBusy(button, false);
      }
    })();
  });

  query<HTMLFormElement>(root, "[data-inventory-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      clearInvalidFields(root);
      const shop = selectedShop(state, shops);
      const variantId = query<HTMLSelectElement>(root, "[data-inventory-variant]")?.value ?? "";
      const source = query<HTMLSelectElement>(root, "[data-inventory-source]")?.value === "csv" ? "csv" : "paste";
      const data = inventoryData?.value ?? "";
      if (shop === null) { showStep(root, state, "shop"); return; }
      const selectionEpoch = state.shopSelectionEpoch;
      if (variantId.length === 0) { markFieldInvalid(root, query<HTMLSelectElement>(root, "[data-inventory-variant]"), copy("onboarding.feedback.inventory_variant_required", "Choose an offer to receive keys.")); return; }
      if (state.inventoryPreview === null) { markFieldInvalid(root, inventoryData, copy("onboarding.feedback.inventory_preview_required", "Create a preview before confirming the import.")); return; }
      const bodyValue: Record<string, unknown> = { data, filename: null, previewToken: state.inventoryPreview.previewToken, source };
      const payload = JSON.stringify(bodyValue);
      const namespace = `inventory:${shop.publicId}:${variantId}`;
      const button = query<HTMLButtonElement>(root, "[data-inventory-confirm]");
      setBusy(button, true, copy("onboarding.busy.encrypting", "Encrypting…"));
      try {
        await requestApi(root, `${apiBase(shop.publicId)}/variants/${encodeURIComponent(variantId)}/inventory/import`, {
          body: payload,
          idempotencyKey: await intentKey(namespace, payload),
          method: "POST",
        });
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        clearIntent(namespace);
        if (inventoryData !== null) inventoryData.value = "";
        state.inventoryPreview = null;
        updateLocalInventoryPreview(root);
        setText(root, "[data-preview-expiry]", copy("onboarding.inventory.import_done", "Import complete; contents were removed from the form."));
        setFeedback(root, copy("onboarding.feedback.inventory_imported", "License inventory was encrypted and imported successfully."), "success");
        await loadShopState(root, state, shops);
        showStep(root, state, "telegram");
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        if (inventoryData !== null) inventoryData.value = "";
        updateLocalInventoryPreview(root);
        invalidateInventoryPreview(root, state, copy("onboarding.feedback.import_expired", "Preview is no longer valid. Create a new preview before importing."));
        setFeedback(root, errorMessage(error), "error");
      } finally {
        setBusy(button, false);
        if (button !== null && state.inventoryPreview === null) button.disabled = true;
      }
    })();
  });

  query<HTMLFormElement>(root, "[data-telegram-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const form = event.currentTarget as HTMLFormElement;
      clearInvalidFields(root);
      const shop = selectedShop(state, shops);
      const token = query<HTMLInputElement>(root, "[data-telegram-token]");
      if (shop === null) { showStep(root, state, "shop"); return; }
      const selectionEpoch = state.shopSelectionEpoch;
      if (focusNativeFormError(root, form, copy("onboarding.feedback.telegram_token_required", "Enter the Telegram token before connecting."))) return;
      const submittedToken = token?.value ?? "";
      const button = query<HTMLButtonElement>(root, "[data-telegram-submit]");
      setBusy(button, true, copy("onboarding.busy.connecting", "Connecting…"));
      try {
        const response = await requestApi(root, `${apiBase(shop.publicId)}/integrations/telegram`, {
          body: JSON.stringify({ botToken: submittedToken, replaceBot: false }),
          method: "PUT",
        });
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        state.telegram = parseTelegram(response);
        renderTelegram(root, state.telegram);
        renderProgress(root, state, shops);
        setFeedback(root, copy("onboarding.feedback.telegram_connected", "Bot connected. Open it and send /start in a private chat."), "success");
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        setFeedback(root, errorMessage(error), "error");
      } finally {
        if (token !== null && token.value === submittedToken) token.value = "";
        setBusy(button, false);
      }
    })();
  });

  query<HTMLButtonElement>(root, "[data-telegram-health]")?.addEventListener("click", () => {
    void (async () => {
      const shop = selectedShop(state, shops);
      if (shop === null) { showStep(root, state, "shop"); return; }
      const selectionEpoch = state.shopSelectionEpoch;
      const button = query<HTMLButtonElement>(root, "[data-telegram-health]");
      setBusy(button, true, copy("onboarding.busy.checking", "Checking…"));
      try {
        const response = await requestApi(root, `${apiBase(shop.publicId)}/integrations/telegram/health-checks`, { body: "{}", method: "POST" });
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        state.telegram = parseTelegram(response);
        renderTelegram(root, state.telegram);
        renderProgress(root, state, shops);
        const healthReady = state.telegram !== null && hasAuthoritativeTelegramHealth(state.telegram.lastHealthUpdateAt);
        setFeedback(root, healthReady ? copy("onboarding.feedback.telegram_health_ok", "The Telegram bot received the health-check message.") : copy("onboarding.feedback.telegram_health_wait", "The connection is active; send /start in a private chat and check again."), healthReady ? "success" : "info");
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        setFeedback(root, errorMessage(error), "error");
      } finally {
        setBusy(button, false);
      }
    })();
  });

  query<HTMLFormElement>(root, "[data-payos-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const form = event.currentTarget as HTMLFormElement;
      clearInvalidFields(root);
      const shop = selectedShop(state, shops);
      if (shop === null) { showStep(root, state, "shop"); return; }
      const clientId = query<HTMLInputElement>(root, "[data-payos-client-id]");
      const apiKey = query<HTMLInputElement>(root, "[data-payos-api-key]");
      const checksumKey = query<HTMLInputElement>(root, "[data-payos-checksum-key]");
      const selectionEpoch = state.shopSelectionEpoch;
      if (focusNativeFormError(root, form, copy("onboarding.feedback.payos_credentials_required", "Enter all three PayOS credentials before verification."))) return;
      const submittedCredentials = {
        apiKey: apiKey?.value ?? "",
        checksumKey: checksumKey?.value ?? "",
        clientId: clientId?.value ?? "",
      };
      const button = query<HTMLButtonElement>(root, "[data-payos-submit]");
      setBusy(button, true, copy("onboarding.busy.verifying", "Verifying…"));
      try {
        const response = await requestApi(root, `${apiBase(shop.publicId)}/payments/payos`, {
          body: JSON.stringify(submittedCredentials),
          method: "PUT",
        });
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        state.payos = parsePayos(response);
        renderPayos(root, state.payos);
        renderProgress(root, state, shops);
        setFeedback(root, copy("onboarding.feedback.payos_verified", "PayOS verified. Selinow registered the payment webhook."), "success");
        showStep(root, state, "settings");
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        setFeedback(root, errorMessage(error), "error");
      } finally {
        if (clientId !== null && clientId.value === submittedCredentials.clientId) clientId.value = "";
        if (apiKey !== null && apiKey.value === submittedCredentials.apiKey) apiKey.value = "";
        if (checksumKey !== null && checksumKey.value === submittedCredentials.checksumKey) checksumKey.value = "";
        setBusy(button, false);
      }
    })();
  });

  query<HTMLButtonElement>(root, "[data-payos-health]")?.addEventListener("click", () => {
    void (async () => {
      const shop = selectedShop(state, shops);
      if (shop === null) { showStep(root, state, "shop"); return; }
      const selectionEpoch = state.shopSelectionEpoch;
      const button = query<HTMLButtonElement>(root, "[data-payos-health]");
      const healthCopy = query<HTMLElement>(root, "[data-payos-health-copy]");
      if (healthCopy !== null) healthCopy.textContent = copy("onboarding.feedback.payos_checking", "Asking PayOS to recheck the connection…");
      setBusy(button, true, copy("onboarding.busy.refreshing", "Refreshing…"));
      try {
        const response = await requestApi(root, `${apiBase(shop.publicId)}/payments/payos/health-checks`, { method: "POST" });
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        state.payos = parsePayos(response);
        if (state.payos === null) throw new ApiError("request_failed", 500, [], null);
        renderPayos(root, state.payos);
        renderProgress(root, state, shops);
        const ready = state.payos.status === "active" && state.payos.webhookStatus === "verified";
        if (healthCopy !== null) healthCopy.textContent = ready
          ? copy("onboarding.feedback.payos_health_ready", "The PayOS payment webhook was reverified using stored information.")
          : copy("onboarding.feedback.payos_health_pending", "PayOS could not verify the connection. Stored secrets were not changed; check the channel and try again.");
        setFeedback(root, ready ? copy("onboarding.feedback.payos_refreshed", "PayOS connection refreshed.") : copy("onboarding.feedback.payos_not_ready", "PayOS payment connection is not verified. Check the channel and try again."), ready ? "success" : "error");
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        if (healthCopy !== null) healthCopy.textContent = copy("onboarding.feedback.payos_health_failed", "Could not refresh the connection. Stored secrets were not changed; sign in again or retry.");
        setFeedback(root, errorMessage(error), "error");
      } finally {
        setBusy(button, false);
      }
    })();
  });

  query<HTMLFormElement>(root, "[data-settings-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const form = event.currentTarget as HTMLFormElement;
      clearInvalidFields(root);
      const shop = selectedShop(state, shops);
      if (shop === null) { showStep(root, state, "shop"); return; }
      const selectionEpoch = state.shopSelectionEpoch;
      const settings = readSettingsForm(root);
      const globalization = readShopGlobalizationForm(root);
      if (focusNativeFormError(root, form, copy("onboarding.feedback.form_invalid_settings", "Complete the required fields before saving."))) return;
      if (globalization === null) {
        markFieldInvalid(root, query<HTMLSelectElement>(root, "[data-settings-currency]"), copy("onboarding.feedback.invalid_shop_globalization", "Choose a supported currency and locale."));
        return;
      }
      if (!settingsDraftReady(settings)) {
        const invalidUrlField = [
          [settings.termsUrl, query<HTMLInputElement>(root, "[data-terms-url]")],
          [settings.privacyUrl, query<HTMLInputElement>(root, "[data-privacy-url]")],
          [settings.refundPolicyUrl, query<HTMLInputElement>(root, "[data-refund-url]")],
        ].find(([value]) => !isSafeHttpsUrl(value as string))?.[1] as HTMLInputElement | undefined;
        if (invalidUrlField !== undefined) {
          markFieldInvalid(root, invalidUrlField, copy("onboarding.feedback.policy_url", "Use an HTTPS policy URL without credentials or a fragment."));
        } else if (settings.supportContact.trim().length < 3 || settings.supportContact.trim().length > 180) {
          markFieldInvalid(root, query<HTMLInputElement>(root, "[data-support-contact]"), copy("onboarding.feedback.support_length", "Enter a support contact between 3 and 180 characters."));
        } else {
          markFieldInvalid(root, query<HTMLInputElement>(root, "[data-attestation]"), copy("onboarding.feedback.attestation_required", "Confirm your right to sell and comply with Selinow policy."));
        }
        return;
      }
      const button = query<HTMLButtonElement>(root, "[data-settings-submit]");
      setBusy(button, true, copy("onboarding.busy.saving", "Saving…"));
      try {
        const globalizationChanged = globalization.businessCountry !== shop.businessCountry
          || globalization.currency !== shop.currency
          || globalization.defaultLocale !== shop.defaultLocale
          || globalization.merchantCountry !== shop.merchantCountry;
        if (globalizationChanged) {
          const profileResponse = asRecord(await requestApi(root, apiBase(shop.publicId), {
            body: JSON.stringify(globalization),
            method: "PATCH",
          }));
          if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
          if (!isShop(profileResponse?.shop)) throw new ApiError("request_failed", 500, [], stringOrNull(profileResponse?.requestId));
          Object.assign(shop, profileResponse.shop);
          renderShopSelection(root, state, shops);
        }
        const response = await requestApi(root, `${apiBase(shop.publicId)}/onboarding/settings`, {
          body: JSON.stringify({ ...settings, attestationVersion: 1 }),
          method: "PUT",
        });
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        state.onboarding = parseOnboardingSnapshot(response);
        if (state.onboarding.settings === null) state.onboarding.settings = settings;
        renderProgress(root, state, shops);
        setFeedback(root, copy("onboarding.feedback.settings_saved", "Store locale, currency, support information, policies, and seller attestation saved."), "success");
        showStep(root, state, "readiness");
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        setFeedback(root, errorMessage(error), "error");
      } finally {
        setBusy(button, false);
      }
    })();
  });

  query<HTMLButtonElement>(root, "[data-readiness-run]")?.addEventListener("click", () => {
    void (async () => {
      const shop = selectedShop(state, shops);
      if (shop === null) { showStep(root, state, "shop"); return; }
      const selectionEpoch = state.shopSelectionEpoch;
      const button = query<HTMLButtonElement>(root, "[data-readiness-run]");
      setBusy(button, true, copy("onboarding.busy.checking", "Checking…"));
      try {
        const response = await requestApi(root, `${apiBase(shop.publicId)}/readiness/checks`, { body: "{}", method: "POST" });
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        state.readiness = parseReadinessChecks(response);
        renderReadiness(root, state);
        renderProgress(root, state, shops);
        setFeedback(root, state.readiness.ready ? copy("onboarding.feedback.readiness_pass", "All required checks passed. The store can open for sales.") : copy("onboarding.feedback.readiness_pending", "Checks complete; resolve the remaining required items."), state.readiness.ready ? "success" : "info");
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        setFeedback(root, errorMessage(error), "error");
      } finally {
        setBusy(button, false);
      }
    })();
  });

  query<HTMLSelectElement>(root, "[data-test-order-variant]")?.addEventListener("change", () => { clearTestOrderResult(root); });
  query<HTMLInputElement>(root, "[data-test-order-quantity]")?.addEventListener("input", () => { clearTestOrderResult(root); });
  query<HTMLFormElement>(root, "[data-test-order-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const form = event.currentTarget as HTMLFormElement;
      clearInvalidFields(root);
      const shop = selectedShop(state, shops);
      if (shop === null) { showStep(root, state, "shop"); return; }
      const selectionEpoch = state.shopSelectionEpoch;
      if (focusNativeFormError(root, form, copy("onboarding.feedback.form_invalid_test", "Check the test-order quantity before running it."))) return;
      const quantityValue = query<HTMLInputElement>(root, "[data-test-order-quantity]")?.value ?? "1";
      const quantity = Number(quantityValue);
      if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
        markFieldInvalid(root, query<HTMLInputElement>(root, "[data-test-order-quantity]"), copy("onboarding.feedback.invalid_quantity", "Enter an integer from 1 to 100 for the test order."));
        renderTestOrderNotice(root, "error", copy("onboarding.feedback.invalid_quantity_title", "Invalid quantity."), copy("onboarding.feedback.invalid_quantity_copy", "Enter an integer from 1 to 100. No data was changed."));
        return;
      }
      const variantId = query<HTMLSelectElement>(root, "[data-test-order-variant]")?.value ?? "";
      const body: Record<string, unknown> = { quantity };
      if (variantId.length > 0) body.variantId = variantId;
      const button = query<HTMLButtonElement>(root, "[data-test-order-submit]");
      renderTestOrderNotice(root, "info", copy("onboarding.feedback.test_running", "Running safe test order…"), copy("onboarding.feedback.test_running_copy", "Selinow is reading products, inventory, domains, and connections; it creates no transaction and reserves no keys."));
      setBusy(button, true, copy("onboarding.busy.testing", "Running test…"));
      try {
        const response = await requestApi(root, `${apiBase(shop.publicId)}/onboarding/test-order`, {
          body: JSON.stringify(body),
          method: "POST",
        });
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        const result = parseControlledTestOrder(response);
        if (result === null) throw new ApiError("request_failed", 500, [], null);
        const responseRoot = asRecord(response);
        const testOrder = asRecord(responseRoot?.testOrder);
        if (testOrder !== null) state.readiness = parseReadinessChecks(testOrder.readiness);
        renderTestOrderResult(root, result);
        renderReadiness(root, state);
        renderProgress(root, state, shops);
        setFeedback(root, result.passed ? copy("onboarding.feedback.test_pass", "The test order passed without creating a real transaction.") : copy("onboarding.feedback.test_pending", "The safe test finished; review the items that did not pass."), result.passed ? "success" : "info");
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        const message = errorMessage(error);
        renderTestOrderNotice(root, "error", copy("onboarding.feedback.test_failed", "Could not run the safe test order."), `${message} ${copy("onboarding.feedback.test_failed_copy", "No order, payment, or inventory reservation was created.")}`);
        setFeedback(root, message, "error");
      } finally {
        setBusy(button, false);
      }
    })();
  });

  query<HTMLButtonElement>(root, "[data-publish-button]")?.addEventListener("click", () => {
    void (async () => {
      const shop = selectedShop(state, shops);
      if (shop === null) { showStep(root, state, "shop"); return; }
      const selectionEpoch = state.shopSelectionEpoch;
      if (!state.readiness.ready) { setFeedback(root, copy("onboarding.feedback.publish_blocked", "Run all checks and complete required items before opening for sales."), "error"); return; }
      const button = query<HTMLButtonElement>(root, "[data-publish-button]");
      setBusy(button, true, copy("onboarding.busy.publishing", "Opening sales…"));
      try {
        const expectedVersion = state.onboarding.settings?.version;
        if (expectedVersion === undefined) {
          setFeedback(root, copy("onboarding.feedback.publish_version", "Store information has no safe version. Reload progress and try again before opening for sales."), "error");
          return;
        }
        await requestApi(root, `${apiBase(shop.publicId)}/catalog/publish`, { body: JSON.stringify({ expectedVersion }), method: "POST" });
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        shop.status = "active";
        state.published = true;
        setFeedback(root, copy("onboarding.feedback.published", "{name} is now open for sales.", { name: shop.name }), "success");
        await loadShopState(root, state, shops);
      } catch (error) {
        if (!selectionIsCurrent(state, shop.publicId, selectionEpoch)) return;
        state.readiness.ready = false;
        renderReadiness(root, state);
        setFeedback(root, errorMessage(error), "error");
      } finally {
        setBusy(button, false);
        if (button !== null) button.disabled = !state.readiness.ready || state.published;
      }
    })();
  });

  renderShopSelection(root, state, shops);
  updateLocalInventoryPreview(root);
  await loadShopState(root, state, shops);
  let initialStep: WizardStepCode = shops.length === 0 ? "shop" : "channels";
  const hashStep = stepFromHash(location.hash);
  try {
    const stored = sessionStorage.getItem(`selinow:onboarding:step:${state.selectedShopId ?? "new"}`);
    if (WIZARD_STEPS.some((step) => step.code === stored)) initialStep = stored as WizardStepCode;
  } catch {
    // Use the first actionable step.
  }
  showStep(root, state, hashStep ?? initialStep, false);
  window.addEventListener("hashchange", () => {
    const nextStep = stepFromHash(location.hash);
    if (nextStep !== null) showStep(root, state, nextStep);
  });
}

const root = document.querySelector("[data-onboarding-root]") as unknown as HTMLElement | null;
if (root !== null) void initialize(root);
