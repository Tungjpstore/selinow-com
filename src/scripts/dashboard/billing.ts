import { isBillingRecentAuthFailure, readBillingApiFailure, type BillingApiFailure } from "../../lib/dashboard/billing-api-error";
import { getBillingCheckoutAdmission } from "../../lib/dashboard/billing-checkout";

type JsonObject = Record<string, unknown>;
type Price = { amountMinor: number; currency: string; displayAmount: string | null; interval: string; marketCode: string };
type Plan = { code: string; name: string; prices: Price[]; version: number };
type BillingOperation = { action: "cancel" | "cancel_scheduled_plan_change" | "change_plan" | "resume"; operationId: string; requestedPlanCode: string | null; status: string };
type BillingOperationAttemptInput = {
  action: BillingOperation["action"];
  expectedSubscriptionVersion: number;
  requestedPlanCode: string | null;
  shopPublicId: string;
};
type BillingOperationAttempt = BillingOperationAttemptInput & { idempotencyKey: string };
type BillingOperationAttemptRecord = BillingOperationAttempt & { expiresAt: number; version: 1 };
type BillingCheckoutAttemptInput = { planCode: string; recovery: boolean; shopPublicId: string };
type BillingCheckoutAttempt = BillingCheckoutAttemptInput & { idempotencyKey: string };
type BillingCheckoutAttemptRecord = BillingCheckoutAttempt & { checkoutSessionId: string | null; expiresAt: number; version: 1 };
type BillingCheckoutAttemptStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;
type BillingPlanChangeDirection = "downgrade" | "unknown" | "upgrade";

const BILLING_CHECKOUT_ATTEMPT_STORAGE_KEY = "selinow.billing.checkout-attempt.v1";
const BILLING_CHECKOUT_ATTEMPT_TTL_MS = 24 * 60 * 60_000 + 5 * 60_000;
const BILLING_OPERATION_ATTEMPT_STORAGE_KEY = "selinow.billing.operation-attempt.v1";
const BILLING_OPERATION_ATTEMPT_TTL_MS = 30 * 60_000;

function createBillingIdempotencyKey(): string {
  try { return `billing_ui_${crypto.randomUUID()}`; }
  catch { return `billing_ui_${String(Date.now())}_${Math.random().toString(36).slice(2)}`; }
}

export class BillingCheckoutAttemptTracker {
  private current: BillingCheckoutAttemptRecord | null;
  private readonly createKey: () => string;
  private readonly now: () => number;
  private readonly storage: BillingCheckoutAttemptStorage | null;
  private readonly ttlMs: number;

  constructor(input: {
    createKey?: () => string;
    now?: () => number;
    storage?: BillingCheckoutAttemptStorage | null;
    ttlMs?: number;
  } = {}) {
    this.createKey = input.createKey ?? createBillingIdempotencyKey;
    this.now = input.now ?? Date.now;
    this.storage = input.storage ?? null;
    this.ttlMs = input.ttlMs ?? BILLING_CHECKOUT_ATTEMPT_TTL_MS;
    this.current = this.load();
  }

  begin(input: BillingCheckoutAttemptInput): BillingCheckoutAttempt {
    if (this.current !== null && this.current.expiresAt <= this.now()) this.clear();
    if (this.current !== null
      && this.current.planCode === input.planCode
      && this.current.recovery === input.recovery
      && this.current.shopPublicId === input.shopPublicId) return this.current;
    this.clear();
    this.current = { ...input, checkoutSessionId: null, expiresAt: this.now() + this.ttlMs, idempotencyKey: this.createKey(), version: 1 };
    this.persist();
    return this.current;
  }

  opened(attempt: Pick<BillingCheckoutAttempt, "idempotencyKey">, checkoutSessionId: string): void {
    if (this.current?.idempotencyKey !== attempt.idempotencyKey) return;
    this.current = { ...this.current, checkoutSessionId };
    this.persist();
  }

  finishSession(checkoutSessionId: string): void {
    if (this.current?.checkoutSessionId === checkoutSessionId) this.clear();
  }

  finish(attempt: Pick<BillingCheckoutAttempt, "idempotencyKey">): void {
    if (this.current?.idempotencyKey === attempt.idempotencyKey) this.clear();
  }

  fail(attempt: Pick<BillingCheckoutAttempt, "idempotencyKey">, terminalResponse: boolean): void {
    if (terminalResponse) this.finish(attempt);
  }

  private clear(): void {
    this.current = null;
    try { this.storage?.removeItem(BILLING_CHECKOUT_ATTEMPT_STORAGE_KEY); } catch { /* Storage denial falls back to memory-only recovery. */ }
  }

  private load(): BillingCheckoutAttemptRecord | null {
    let raw: string | null;
    try { raw = this.storage?.getItem(BILLING_CHECKOUT_ATTEMPT_STORAGE_KEY) ?? null; } catch { return null; }
    if (raw === null) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid");
      const record = value as Partial<BillingCheckoutAttemptRecord>;
      const now = this.now();
      if (record.version !== 1
        || typeof record.shopPublicId !== "string" || record.shopPublicId.length === 0
        || (record.planCode !== "starter" && record.planCode !== "pro")
        || typeof record.recovery !== "boolean"
        || typeof record.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/u.test(record.idempotencyKey)
        || typeof record.expiresAt !== "number" || !Number.isSafeInteger(record.expiresAt)
        || record.expiresAt <= now || record.expiresAt > now + this.ttlMs) throw new Error("invalid");
      if (record.checkoutSessionId !== undefined && record.checkoutSessionId !== null
        && !/^bchk_[0-9a-f-]{36}$/u.test(record.checkoutSessionId)) throw new Error("invalid");
      return { ...record, checkoutSessionId: record.checkoutSessionId ?? null } as BillingCheckoutAttemptRecord;
    } catch {
      try { this.storage?.removeItem(BILLING_CHECKOUT_ATTEMPT_STORAGE_KEY); } catch { /* Ignore unavailable storage cleanup. */ }
      return null;
    }
  }

  private persist(): void {
    if (this.current === null) return;
    try { this.storage?.setItem(BILLING_CHECKOUT_ATTEMPT_STORAGE_KEY, JSON.stringify(this.current)); } catch { /* Storage denial keeps the in-memory attempt usable. */ }
  }
}

export class BillingOperationAttemptTracker {
  private current: BillingOperationAttemptRecord | null;
  private readonly createKey: () => string;
  private readonly now: () => number;
  private readonly storage: BillingCheckoutAttemptStorage | null;
  private readonly ttlMs: number;

  constructor(input: {
    createKey?: () => string;
    now?: () => number;
    storage?: BillingCheckoutAttemptStorage | null;
    ttlMs?: number;
  } = {}) {
    this.createKey = input.createKey ?? createBillingIdempotencyKey;
    this.now = input.now ?? Date.now;
    this.storage = input.storage ?? null;
    this.ttlMs = input.ttlMs ?? BILLING_OPERATION_ATTEMPT_TTL_MS;
    this.current = this.load();
  }

  begin(input: BillingOperationAttemptInput): BillingOperationAttempt {
    if (this.current !== null && this.current.expiresAt <= this.now()) this.clear();
    if (this.current !== null
      && this.current.action === input.action
      && this.current.expectedSubscriptionVersion === input.expectedSubscriptionVersion
      && this.current.requestedPlanCode === input.requestedPlanCode
      && this.current.shopPublicId === input.shopPublicId) return this.current;
    this.clear();
    this.current = { ...input, expiresAt: this.now() + this.ttlMs, idempotencyKey: this.createKey(), version: 1 };
    this.persist();
    return this.current;
  }

  finish(attempt: Pick<BillingOperationAttempt, "idempotencyKey">): void {
    if (this.current?.idempotencyKey === attempt.idempotencyKey) this.clear();
  }

  fail(attempt: Pick<BillingOperationAttempt, "idempotencyKey">, terminalResponse: boolean): void {
    if (terminalResponse) this.finish(attempt);
  }

  private clear(): void {
    this.current = null;
    try { this.storage?.removeItem(BILLING_OPERATION_ATTEMPT_STORAGE_KEY); } catch { /* Storage denial falls back to memory-only recovery. */ }
  }

  private load(): BillingOperationAttemptRecord | null {
    let raw: string | null;
    try { raw = this.storage?.getItem(BILLING_OPERATION_ATTEMPT_STORAGE_KEY) ?? null; } catch { return null; }
    if (raw === null) return null;
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid");
      const record = value as Partial<BillingOperationAttemptRecord>;
      const now = this.now();
      if (record.version !== 1
        || (record.action !== "cancel" && record.action !== "cancel_scheduled_plan_change" && record.action !== "change_plan" && record.action !== "resume")
        || !Number.isSafeInteger(record.expectedSubscriptionVersion) || (record.expectedSubscriptionVersion ?? 0) < 1
        || (record.action === "change_plan" && record.requestedPlanCode !== "starter" && record.requestedPlanCode !== "pro")
        || (record.action !== "change_plan" && record.requestedPlanCode !== null)
        || typeof record.shopPublicId !== "string" || record.shopPublicId.length === 0
        || typeof record.idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/u.test(record.idempotencyKey)
        || typeof record.expiresAt !== "number" || !Number.isSafeInteger(record.expiresAt)
        || record.expiresAt <= now || record.expiresAt > now + this.ttlMs) throw new Error("invalid");
      return record as BillingOperationAttemptRecord;
    } catch {
      try { this.storage?.removeItem(BILLING_OPERATION_ATTEMPT_STORAGE_KEY); } catch { /* Ignore unavailable storage cleanup. */ }
      return null;
    }
  }

  private persist(): void {
    if (this.current === null) return;
    try { this.storage?.setItem(BILLING_OPERATION_ATTEMPT_STORAGE_KEY, JSON.stringify(this.current)); } catch { /* Storage denial keeps the in-memory attempt usable. */ }
  }
}

export function isBillingCheckoutTerminalFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as { code?: unknown; terminalResponse?: unknown };
  if (failure.terminalResponse !== true) return false;
  if (typeof failure.code !== "string") return false;
  return ![
    "billing_checkout_pending",
    "billing_checkout_persistence_conflict",
    "billing_provider_invalid",
    "billing_provider_unavailable",
  ].includes(failure.code) && !/^http_5\d\d$/u.test(failure.code);
}

class BillingApiError extends Error {
  readonly code: string;
  readonly requestId: string | null;
  readonly terminalResponse: boolean;

  constructor(failure: BillingApiFailure, terminalResponse = false) {
    super(failure.code);
    this.name = "BillingApiError";
    this.code = failure.code;
    this.requestId = failure.requestId;
    this.terminalResponse = terminalResponse;
  }
}

export function acceptBillingCheckoutResponse(payload: JsonObject | null, attempt: BillingCheckoutAttempt, tracker: BillingCheckoutAttemptTracker): string {
  const checkout = payload?.checkout;
  const provider = typeof checkout === "object" && checkout !== null && typeof (checkout as { provider?: unknown }).provider === "string" ? (checkout as { provider: string }).provider : "";
  const rawUrl = typeof checkout === "object" && checkout !== null && typeof (checkout as { checkoutUrl?: unknown }).checkoutUrl === "string" ? (checkout as { checkoutUrl: string }).checkoutUrl : "";
  const checkoutSessionId = typeof checkout === "object" && checkout !== null && typeof (checkout as { sessionId?: unknown }).sessionId === "string" ? (checkout as { sessionId: string }).sessionId : "";
  const requestId = typeof payload?.requestId === "string" && /^[A-Za-z0-9._-]{8,128}$/u.test(payload.requestId) ? payload.requestId : null;
  if (provider !== "dodo") throw new BillingApiError({ code: "checkout_provider_invalid", requestId });
  let checkoutUrl: URL;
  try { checkoutUrl = new URL(rawUrl); } catch { throw new BillingApiError({ code: "checkout_url_invalid", requestId }); }
  if (checkoutUrl.protocol !== "https:" || checkoutUrl.username.length > 0 || checkoutUrl.password.length > 0) throw new BillingApiError({ code: "checkout_url_invalid", requestId });
  if (!/^bchk_[0-9a-f-]{36}$/u.test(checkoutSessionId)) throw new BillingApiError({ code: "checkout_session_invalid", requestId });
  tracker.opened(attempt, checkoutSessionId);
  return checkoutUrl.toString();
}

export function acceptBillingPortalResponse(payload: JsonObject | null): string {
  const portal = payload?.portal;
  const provider = typeof portal === "object" && portal !== null && typeof (portal as { provider?: unknown }).provider === "string" ? (portal as { provider: string }).provider : "";
  const rawUrl = typeof portal === "object" && portal !== null && typeof (portal as { portalUrl?: unknown }).portalUrl === "string" ? (portal as { portalUrl: string }).portalUrl : "";
  const requestId = typeof payload?.requestId === "string" && /^[A-Za-z0-9._-]{8,128}$/u.test(payload.requestId) ? payload.requestId : null;
  if (provider !== "dodo") throw new BillingApiError({ code: "billing_portal_provider_invalid", requestId });
  let portalUrl: URL;
  try { portalUrl = new URL(rawUrl); } catch { throw new BillingApiError({ code: "billing_portal_url_invalid", requestId }); }
  const hostname = portalUrl.hostname.toLowerCase();
  if (portalUrl.protocol !== "https:"
    || portalUrl.username.length > 0
    || portalUrl.password.length > 0
    || portalUrl.port.length > 0
    || portalUrl.pathname.length < 2
    || (hostname !== "dodopayments.com" && !hostname.endsWith(".dodopayments.com"))) {
    throw new BillingApiError({ code: "billing_portal_url_invalid", requestId });
  }
  return portalUrl.toString();
}

export function billingPlanChangeDirection(current: Price | null, target: Price | undefined): BillingPlanChangeDirection {
  if (current === null || target === undefined
    || current.currency !== target.currency
    || current.interval !== target.interval
    || current.marketCode !== target.marketCode
    || current.amountMinor === target.amountMinor) return "unknown";
  return target.amountMinor > current.amountMinor ? "upgrade" : "downgrade";
}

const root = document.querySelector<HTMLElement>("[data-billing-root]");

if (root !== null && root.dataset.canManage === "true") {
  const shopPublicId = root.dataset.shopPublicId;
  const csrfCookieName = root.dataset.csrfCookieName ?? "";
  const feedback = root.querySelector<HTMLElement>("[data-billing-feedback]");
  const planDialogFeedback = root.querySelector<HTMLElement>("[data-dialog-feedback]");
  const cancelDialogFeedback = root.querySelector<HTMLElement>("[data-cancel-feedback]");
  const supportReference = root.querySelector<HTMLElement>("[data-billing-support-reference]");
  const recentAuthActions = root.querySelectorAll<HTMLButtonElement>("[data-billing-recent-auth-action]");
  const marketForm = root.querySelector<HTMLFormElement>("[data-billing-market-form]");
  const merchantCountryInput = root.querySelector<HTMLInputElement>("#billing-merchant-country");
  const planDialog = root.querySelector<HTMLDialogElement>("[data-plan-dialog]");
  const cancelDialog = root.querySelector<HTMLDialogElement>("[data-cancel-dialog]");
  const planOptions = root.querySelector<HTMLElement>("[data-plan-options]");
  const selectStage = root.querySelector<HTMLElement>('[data-plan-stage="select"]');
  const reviewStage = root.querySelector<HTMLElement>('[data-plan-stage="review"]');
  const reviewTitle = root.querySelector<HTMLElement>("[data-review-title]");
  const reviewAnnouncement = root.querySelector<HTMLElement>("[data-review-announcement]");
  const reviewProviderNote = root.querySelector<HTMLElement>("[data-review-provider-note]");
  const planBack = root.querySelector<HTMLButtonElement>("[data-plan-back]");
  const planConfirm = root.querySelector<HTMLButtonElement>("[data-plan-confirm]");
  const cancelConfirm = root.querySelector<HTMLButtonElement>("[data-cancel-confirm]");
  const operationBanner = root.querySelector<HTMLElement>("[data-billing-operation]");
  const operationTitle = root.querySelector<HTMLElement>("[data-operation-title]");
  const copy = (() => {
    try {
      const parsed: unknown = JSON.parse(root.dataset.copy ?? "{}");
      return typeof parsed === "object" && parsed !== null ? parsed as Record<string, string> : {};
    } catch { return {}; }
  })();
  const text = (key: string): string => copy[key] ?? "";
  const currentPlanCode = root.dataset.currentPlanCode ?? "";
  const billingState = root.dataset.billingState ?? "";
  const billingMarketReady = root.dataset.billingMarketReady === "true";
  const subscriptionVersion = Number(root.dataset.subscriptionVersion);
  const currentPeriodEnd = root.dataset.currentPeriodEnd ?? "";
  const locale = document.documentElement.lang || "en";
  const targetPlanCode = new URL(window.location.href).searchParams.get("target");
  const checkoutAttemptStorage = (() => {
    try { return window.sessionStorage; } catch { return null; }
  })();
  const checkoutAttempts = new BillingCheckoutAttemptTracker({ storage: checkoutAttemptStorage });
  const operationAttempts = new BillingOperationAttemptTracker({ storage: checkoutAttemptStorage });
  let plans: Plan[] = [];
  let selectedPlan: Plan | null = null;
  let pending = false;
  let activeOperationId: string | null = null;
  let previewSequence = 0;
  let previewReady = false;

  const readCookie = (name: string): string | null => document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const setUrlState = (key: "action" | "billing_return" | "manage", value: string | null): void => {
    const url = new URL(window.location.href);
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };
  const showFeedback = (message: string, tone: "danger" | "info" | "success" = "info"): void => {
    for (const target of [feedback, planDialogFeedback, cancelDialogFeedback]) {
      if (target === null) continue;
      target.textContent = message;
      target.dataset.tone = tone;
      target.hidden = message.length === 0 || (target === planDialogFeedback && planDialog?.open !== true) || (target === cancelDialogFeedback && cancelDialog?.open !== true);
    }
  };
  const clearFeedback = (target: HTMLElement | null): void => {
    if (target === null) return;
    target.textContent = "";
    target.hidden = true;
    delete target.dataset.tone;
  };
  const showSupportReference = (failure: BillingApiFailure): void => {
    if (supportReference === null) return;
    const values = [text("checkoutErrorCode").replace("{code}", failure.code)];
    if (failure.requestId !== null) values.push(text("checkoutRequestId").replace("{requestId}", failure.requestId));
    supportReference.textContent = values.join(" · ");
    supportReference.hidden = false;
  };
  const requestApi = async (url: string, options: RequestInit = {}, idempotencyKey?: string): Promise<JsonObject | null> => {
    const headers = new Headers(options.headers);
    const method = options.method?.toUpperCase() ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      const csrf = readCookie(csrfCookieName);
      if (csrf === null) throw new BillingApiError({ code: "csrf_missing", requestId: null });
      headers.set("X-CSRF-Token", decodeURIComponent(csrf));
      headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", idempotencyKey ?? createBillingIdempotencyKey());
    }
    const response = await fetch(url, { ...options, credentials: "same-origin", headers });
    let payload: unknown;
    try { payload = await response.json(); }
    catch {
      if (response.ok && method !== "GET" && method !== "HEAD") throw new BillingApiError({ code: "billing_response_unavailable", requestId: null });
      payload = null;
    }
    if (!response.ok) throw new BillingApiError(readBillingApiFailure(payload, response.status), true);
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as JsonObject : null;
  };
  const priceFrom = (value: unknown): Price | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const item = value as JsonObject;
    if (!Number.isSafeInteger(item.amountMinor) || typeof item.currency !== "string" || typeof item.interval !== "string" || typeof item.marketCode !== "string") return null;
    return { amountMinor: item.amountMinor as number, currency: item.currency, displayAmount: typeof item.displayAmount === "string" ? item.displayAmount : null, interval: item.interval, marketCode: item.marketCode };
  };
  const currentPrice = (() => {
    try { return priceFrom(JSON.parse(root.dataset.currentPrice ?? "null")); }
    catch { return null; }
  })();
  const plansFrom = (payload: JsonObject | null): Plan[] => {
    const values = payload?.plans;
    if (!Array.isArray(values)) return [];
    return values.filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item)).map((item) => {
      const rawPrices = Array.isArray(item.prices) ? item.prices : Array.isArray(item.offers) ? item.offers : [];
      return { code: typeof item.code === "string" ? item.code : "", name: typeof item.name === "string" ? item.name : "", prices: rawPrices.map(priceFrom).filter((price): price is Price => price !== null), version: typeof item.version === "number" ? item.version : 0 };
    }).filter((plan) => (plan.code === "starter" || plan.code === "pro") && plan.name.length > 0);
  };
  const formatPrice = (price: Price | undefined): string => {
    if (price === undefined) return text("checkoutUnavailable");
    if (price.displayAmount !== null) return `${price.displayAmount} / ${price.interval}`;
    const divisor = ["JPY", "KRW", "VND"].includes(price.currency) ? 1 : 100;
    return `${new Intl.NumberFormat(locale, { currency: price.currency, style: "currency" }).format(price.amountMinor / divisor)} / ${text("perMonth")}`;
  };
  const eligiblePlans = (): Plan[] => {
    if (["trialing", "pending_payment", "suspended", "canceled"].includes(billingState)) {
      return getBillingCheckoutAdmission({ billingState, currentPlanCode, marketReady: billingMarketReady, plans }).eligible;
    }
    return plans.filter((plan) => plan.code !== currentPlanCode && plan.prices.length > 0);
  };
  const visiblePlans = (): Plan[] => {
    const eligible = eligiblePlans();
    if (billingState !== "active") return eligible;
    const current = plans.find((plan) => plan.code === currentPlanCode && plan.prices.length > 0);
    return current === undefined ? eligible : [current, ...eligible];
  };
  const resetDialog = (): void => {
    previewSequence += 1;
    previewReady = false;
    selectedPlan = null;
    clearFeedback(planDialogFeedback);
    if (selectStage !== null) selectStage.hidden = false;
    if (reviewStage !== null) {
      reviewStage.hidden = true;
      reviewStage.removeAttribute("aria-busy");
    }
    if (planConfirm !== null) {
      planConfirm.disabled = true;
      planConfirm.removeAttribute("aria-busy");
      planConfirm.textContent = text("confirmChange");
    }
    if (reviewAnnouncement !== null) reviewAnnouncement.textContent = "";
    if (reviewProviderNote !== null) reviewProviderNote.textContent = "";
    root.querySelector<HTMLElement>("[data-review-today]")?.replaceChildren();
    for (const choice of root.querySelectorAll<HTMLElement>("[data-plan-choice]")) choice.setAttribute("aria-pressed", "false");
  };
  const isReviewHidden = (): boolean => reviewStage === null || reviewStage.hidden === true;
  const renderPlans = (): void => {
    if (planOptions === null) return;
    planOptions.replaceChildren();
    const visible = visiblePlans();
    if (visible.length === 0) {
      const empty = document.createElement("p");
      empty.textContent = billingMarketReady ? text("checkoutUnavailable") : text("marketDescription");
      planOptions.appendChild(empty);
      return;
    }
    for (const plan of visible) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "plan-choice";
      button.dataset.planChoice = plan.code;
      button.setAttribute("aria-pressed", "false");
      const isCurrent = billingState === "active" && plan.code === currentPlanCode;
      if (isCurrent) {
        button.dataset.currentPlan = "true";
        button.setAttribute("aria-disabled", "true");
      }
      const name = document.createElement("strong");
      name.textContent = plan.name;
      const price = document.createElement("span");
      price.textContent = formatPrice(plan.prices[0]);
      const effect = document.createElement("small");
      const checkout = ["trialing", "pending_payment", "suspended", "canceled"].includes(billingState);
      const direction = billingPlanChangeDirection(currentPrice, plan.prices[0]);
      effect.textContent = isCurrent
        ? text("plansCurrentHint")
        : checkout || direction === "upgrade"
        ? text("effectiveNow")
        : direction === "downgrade" ? text("effectiveRenewal") : text("continue");
      button.appendChild(name);
      button.appendChild(price);
      button.appendChild(effect);
      button.addEventListener("click", () => {
        if (isCurrent) return;
        selectedPlan = plan;
        for (const choice of root.querySelectorAll<HTMLElement>("[data-plan-choice]")) choice.setAttribute("aria-pressed", String(choice === button));
        void reviewPlan();
      });
      planOptions.appendChild(button);
    }
  };
  const openPlanDialog = (): void => {
    resetDialog();
    renderPlans();
    setUrlState("manage", "plan");
    planDialog?.showModal();
  };
  const reviewPlan = async (): Promise<void> => {
    if (selectedPlan === null || shopPublicId === undefined) return;
    const plan = selectedPlan;
    const sequence = ++previewSequence;
    previewReady = false;
    if (selectStage !== null) selectStage.hidden = true;
    if (reviewStage !== null) {
      reviewStage.hidden = false;
      reviewStage.setAttribute("aria-busy", "true");
    }
    const checkout = ["trialing", "pending_payment", "suspended", "canceled"].includes(billingState);
    if (planConfirm !== null) {
      planConfirm.disabled = true;
      planConfirm.setAttribute("aria-busy", "true");
      planConfirm.textContent = checkout ? text("continueToDodo") : text("confirmChange");
    }
    if (reviewAnnouncement !== null) reviewAnnouncement.textContent = text("reviewLoading");
    reviewTitle?.focus();
    root.querySelector<HTMLElement>("[data-review-current]")?.replaceChildren(document.createTextNode(text(`plan_${currentPlanCode}`) || currentPlanCode));
    root.querySelector<HTMLElement>("[data-review-target]")?.replaceChildren(document.createTextNode(`${plan.name} · ${formatPrice(plan.prices[0])}`));
    const effective = root.querySelector<HTMLElement>("[data-review-effective]");
    effective?.replaceChildren(document.createTextNode(checkout ? text("effectiveNow") : text("previewLoading")));
    const today = root.querySelector<HTMLElement>("[data-review-today]");
    today?.replaceChildren(document.createTextNode(text("previewLoading")));
    if (planConfirm !== null) planConfirm.textContent = checkout ? text("continueToDodo") : text("confirmChange");
    if (!checkout) {
      try {
        const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/billing/preview`, {
          body: JSON.stringify({ planCode: plan.code }),
          method: "POST",
        });
        if (sequence !== previewSequence || selectedPlan !== plan || isReviewHidden()) return;
        const preview = typeof payload?.preview === "object" && payload.preview !== null ? payload.preview as JsonObject : null;
        const amountMinor = preview?.amountMinor;
        const currency = preview?.currency;
        const effectiveAt = preview?.effectiveAt;
        if (!Number.isSafeInteger(amountMinor)
          || typeof currency !== "string"
          || (effectiveAt !== "immediately" && effectiveAt !== "next_billing_date")) throw new Error("billing_preview_invalid");
        const divisor = ["JPY", "KRW", "VND"].includes(currency) ? 1 : 100;
        const renewalDate = currentPeriodEnd === "" ? "" : ` · ${new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(currentPeriodEnd))}`;
        effective?.replaceChildren(document.createTextNode(effectiveAt === "immediately" ? text("effectiveNow") : `${text("effectiveRenewal")}${renewalDate}`));
        today?.replaceChildren(document.createTextNode((amountMinor as number) === 0
          ? text("nothingDueToday")
          : new Intl.NumberFormat(locale, { currency, style: "currency" }).format((amountMinor as number) / divisor)));
        if (reviewProviderNote !== null) reviewProviderNote.textContent = effectiveAt === "immediately" ? text("upgradeProviderNote") : text("downgradeProviderNote");
        if (planConfirm !== null) planConfirm.textContent = effectiveAt === "immediately" ? text("confirmUpgrade") : text("confirmDowngrade");
      } catch (error) {
        if (sequence !== previewSequence || selectedPlan !== plan || isReviewHidden()) return;
        if (reviewStage !== null) reviewStage.removeAttribute("aria-busy");
        if (planConfirm !== null) planConfirm.removeAttribute("aria-busy");
        today?.replaceChildren(document.createTextNode(text("previewUnavailable")));
        if (reviewAnnouncement !== null) reviewAnnouncement.textContent = text("reviewFailed");
        handleFailure(error);
        return;
      }
    } else {
      today?.replaceChildren(document.createTextNode(text("providerConfirms")));
      if (reviewProviderNote !== null) reviewProviderNote.textContent = text("checkoutProviderNote");
    }
    if (sequence !== previewSequence || selectedPlan !== plan || isReviewHidden()) return;
    previewReady = true;
    if (reviewStage !== null) reviewStage.removeAttribute("aria-busy");
    if (planConfirm !== null) {
      planConfirm.disabled = false;
      planConfirm.removeAttribute("aria-busy");
    }
    if (reviewAnnouncement !== null) reviewAnnouncement.textContent = text("reviewReady");
  };
  const billingFailure = (error: unknown): BillingApiFailure => error instanceof BillingApiError
    ? { code: error.code, requestId: error.requestId }
    : { code: error instanceof Error ? error.message : "internal_error", requestId: null };
  const handleFailure = (error: unknown): void => {
    const failure = billingFailure(error);
    for (const action of recentAuthActions) action.toggleAttribute("hidden", !isBillingRecentAuthFailure(failure.code));
    showSupportReference(failure);
    const message = isBillingRecentAuthFailure(failure.code)
      ? text("checkoutRecentAuthRequired")
      : failure.code === "billing_market_unavailable"
        ? text("marketUnavailable")
        : failure.code === "plan_price_unavailable"
          ? text("planUnavailable")
          : failure.code === "provider_not_ready"
            ? text("providerNotReady")
            : failure.code === "billing_provider_request_rejected"
              ? text("providerRequestRejected")
        : ["billing_change_pending", "billing_provider_unavailable", "billing_provider_operation_unavailable", "billing_operation_response_invalid"].includes(failure.code)
          ? text("operationUnavailable")
          : text("errorRetry");
    showFeedback(message, "danger");
  };
  const setBusy = (button: HTMLButtonElement | null, busy: boolean): void => {
    if (button === null) return;
    button.disabled = busy;
    button.toggleAttribute("aria-busy", busy);
  };
  const parseOperation = (payload: JsonObject | null): BillingOperation | null => {
    const value = payload?.operation;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const operation = value as JsonObject;
    if ((operation.action !== "cancel" && operation.action !== "cancel_scheduled_plan_change" && operation.action !== "change_plan" && operation.action !== "resume") || typeof operation.operationId !== "string" || typeof operation.status !== "string") return null;
    return { action: operation.action, operationId: operation.operationId, requestedPlanCode: typeof operation.requestedPlanCode === "string" ? operation.requestedPlanCode : null, status: operation.status };
  };
  const pollOperation = async (operationId: string, attempts = 15): Promise<void> => {
    if (shopPublicId === undefined) return;
    activeOperationId = operationId;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      try {
        const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/billing/operations?operation=${encodeURIComponent(operationId)}`);
        if (activeOperationId !== operationId) return;
        const operation = parseOperation(payload);
        const subscription = typeof payload?.subscription === "object" && payload.subscription !== null ? payload.subscription as JsonObject : null;
        if (operation?.status === "rejected") {
          showFeedback(text("operationRejected"), "danger");
          operationBanner?.setAttribute("hidden", "");
          return;
        }
        if (operation === null) {
          if (attempt < attempts - 1) {
            operationBanner?.removeAttribute("hidden");
            continue;
          }
          showFeedback(text("operationUnavailable"), "danger");
          operationBanner?.setAttribute("hidden", "");
          return;
        }
        if (operation.status === "completed" || operation.status === "canceled") {
          const subscriptionChanged = subscription !== null && (
            (typeof subscription.state === "string" && subscription.state !== billingState)
            || (typeof subscription.planCode === "string" && subscription.planCode !== currentPlanCode)
            || (Number.isSafeInteger(subscription.version) && subscription.version !== subscriptionVersion)
          );
          if (subscriptionChanged || operation.operationId === operationId) window.location.reload();
          return;
        }
        if (operation.status !== "requested" && operation.status !== "provider_pending") {
          operationBanner?.setAttribute("hidden", "");
          window.location.reload();
          return;
        }
        operationBanner?.removeAttribute("hidden");
      } catch (error) {
        if (attempt === attempts - 1) {
          handleFailure(error);
          return;
        }
      }
    }
    showFeedback(text("operationDescription"), "info");
  };
  const pollBillingReturn = async (checkoutSessionId: string, attempts = 15): Promise<void> => {
    if (shopPublicId === undefined) return;
    if (operationTitle !== null) operationTitle.textContent = text("returnOperationTitle");
    operationBanner?.removeAttribute("hidden");
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => window.setTimeout(resolve, 2_000));
      try {
        const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/billing/checkouts/${encodeURIComponent(checkoutSessionId)}`);
        const checkout = typeof payload?.checkout === "object" && payload.checkout !== null ? payload.checkout as JsonObject : null;
        const status = typeof checkout?.status === "string" ? checkout.status : null;
        if (status === "completed") {
          checkoutAttempts.finishSession(checkoutSessionId);
          setUrlState("billing_return", null);
          const url = new URL(window.location.href);
          url.searchParams.delete("checkout");
          window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
          window.location.reload();
          return;
        }
        if (status === "failed" || status === "expired" || status === "canceled") {
          checkoutAttempts.finishSession(checkoutSessionId);
          setUrlState("billing_return", null);
          const url = new URL(window.location.href);
          url.searchParams.delete("checkout");
          window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
          operationBanner?.setAttribute("hidden", "");
          showFeedback(text("checkoutUnavailable"), "danger");
          return;
        }
      } catch (error) {
        if (attempt === attempts - 1) {
          handleFailure(error);
          return;
        }
      }
    }
    showFeedback(text("operationDescription"), "info");
  };
  const startOperation = async (action: BillingOperation["action"], requestedPlanCode?: string): Promise<void> => {
    if (pending || shopPublicId === undefined || !Number.isSafeInteger(subscriptionVersion)) return;
    if (action === "change_plan" && requestedPlanCode !== "starter" && requestedPlanCode !== "pro") return;
    const attempt = operationAttempts.begin({
      action,
      expectedSubscriptionVersion: subscriptionVersion,
      requestedPlanCode: action === "change_plan" ? requestedPlanCode ?? null : null,
      shopPublicId,
    });
    pending = true;
    const button = action === "cancel"
      ? cancelConfirm
      : action === "change_plan"
        ? planConfirm
        : action === "cancel_scheduled_plan_change"
          ? root.querySelector<HTMLButtonElement>("[data-billing-cancel-scheduled-plan-change]")
          : root.querySelector<HTMLButtonElement>("[data-billing-resume]");
    const buttonLabel = button?.textContent ?? null;
    setBusy(button, true);
    if (action === "cancel_scheduled_plan_change" && button !== null) button.textContent = text("cancelScheduledPlanChangePending");
    showFeedback(text("operationDescription"), "info");
    try {
      const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/billing/operations`, {
        body: JSON.stringify({ action, expectedSubscriptionVersion: subscriptionVersion, ...(requestedPlanCode === undefined ? {} : { requestedPlanCode }) }),
        method: "POST",
      }, attempt.idempotencyKey);
      const operation = parseOperation(payload);
      if (operation === null) throw new BillingApiError({ code: "billing_operation_response_invalid", requestId: null });
      operationAttempts.finish(attempt);
      planDialog?.close();
      cancelDialog?.close();
      setUrlState("manage", null);
      setUrlState("action", null);
      await pollOperation(operation.operationId);
    } catch (error) {
      operationAttempts.fail(attempt, isBillingCheckoutTerminalFailure(error));
      handleFailure(error);
    } finally {
      pending = false;
      setBusy(button, false);
      if (button !== null && buttonLabel !== null) button.textContent = buttonLabel;
    }
  };
  const startCheckout = async (plan: Plan): Promise<void> => {
    if (pending || shopPublicId === undefined) return;
    const recovery = billingState === "suspended" || billingState === "canceled";
    const attempt = checkoutAttempts.begin({ planCode: plan.code, recovery, shopPublicId });
    pending = true;
    setBusy(planConfirm, true);
    showFeedback(text("checkoutOpening"), "info");
    try {
      const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/billing/checkout`, { body: JSON.stringify({ planCode: plan.code, recovery }), method: "POST" }, attempt.idempotencyKey);
      const url = acceptBillingCheckoutResponse(payload, attempt, checkoutAttempts);
      window.location.assign(url);
    } catch (error) {
      checkoutAttempts.fail(attempt, isBillingCheckoutTerminalFailure(error));
      handleFailure(error);
      setBusy(planConfirm, false);
      pending = false;
    }
  };
  const openBillingPortal = async (button: HTMLButtonElement | null): Promise<void> => {
    if (pending || shopPublicId === undefined) return;
    pending = true;
    setBusy(button, true);
    showFeedback(text("portalOpening"), "info");
    try {
      const payload = await requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/billing/portal`, { method: "POST" });
      window.location.assign(acceptBillingPortalResponse(payload));
    } catch (error) {
      const failure = billingFailure(error);
      if (isBillingRecentAuthFailure(failure.code)) handleFailure(error);
      else {
        showSupportReference(failure);
        showFeedback(text("portalUnavailable"), "danger");
      }
      pending = false;
      setBusy(button, false);
    }
  };

  marketForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pending || shopPublicId === undefined || !marketForm.reportValidity()) return;
    const value = new FormData(marketForm).get("merchantCountry");
    if (typeof value !== "string" || !/^[A-Za-z]{2}$/u.test(value.trim())) return;
    const button = marketForm.querySelector<HTMLButtonElement>('button[type="submit"]');
    pending = true;
    setBusy(button, true);
    void requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}`, { body: JSON.stringify({ merchantCountry: value.trim().toUpperCase() }), method: "PATCH" })
      .then(() => { showFeedback(text("checkoutMarketSaved"), "success"); window.location.reload(); })
      .catch(handleFailure)
      .finally(() => { pending = false; setBusy(button, false); });
  });
  for (const trigger of root.querySelectorAll<HTMLButtonElement>("[data-open-plan-dialog]")) trigger.addEventListener("click", openPlanDialog);
  root.querySelector<HTMLButtonElement>("[data-focus-billing-market]")?.addEventListener("click", () => {
    merchantCountryInput?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
    merchantCountryInput?.focus({ preventScroll: true });
  });
  root.querySelector<HTMLButtonElement>("[data-open-cancel-dialog]")?.addEventListener("click", () => {
    planDialog?.close();
    setUrlState("manage", null);
    setUrlState("action", "cancel");
    clearFeedback(cancelDialogFeedback);
    cancelDialog?.showModal();
  });
  root.querySelector<HTMLButtonElement>("[data-billing-resume]")?.addEventListener("click", () => { void startOperation("resume"); });
  root.querySelector<HTMLButtonElement>("[data-billing-cancel-scheduled-plan-change]")?.addEventListener("click", () => { void startOperation("cancel_scheduled_plan_change"); });
  for (const trigger of root.querySelectorAll<HTMLButtonElement>("[data-billing-portal]")) trigger.addEventListener("click", () => { void openBillingPortal(trigger); });
  planBack?.addEventListener("click", () => {
    previewSequence += 1;
    previewReady = false;
    if (selectStage !== null) selectStage.hidden = false;
    if (reviewStage !== null) reviewStage.hidden = true;
    if (planConfirm !== null) {
      planConfirm.disabled = true;
      planConfirm.removeAttribute("aria-busy");
      planConfirm.textContent = text("confirmChange");
    }
    if (reviewAnnouncement !== null) reviewAnnouncement.textContent = text("selectPlanAnnouncement");
    root.querySelector<HTMLButtonElement>(`[data-plan-choice="${selectedPlan?.code ?? ""}"]`)?.focus();
  });
  planConfirm?.addEventListener("click", () => {
    if (selectedPlan === null || !previewReady || pending) return;
    if (["trialing", "pending_payment", "suspended", "canceled"].includes(billingState)) void startCheckout(selectedPlan);
    else void startOperation("change_plan", selectedPlan.code);
  });
  cancelConfirm?.addEventListener("click", () => { void startOperation("cancel"); });
  planDialog?.addEventListener("close", () => { setUrlState("manage", null); resetDialog(); });
  cancelDialog?.addEventListener("close", () => { setUrlState("action", null); clearFeedback(cancelDialogFeedback); });
  for (const action of recentAuthActions) action.addEventListener("click", () => { document.querySelector<HTMLButtonElement>("[data-app-logout]")?.click(); });

  if (shopPublicId !== undefined) {
    void requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/billing/plans`)
      .then((payload) => {
        plans = plansFrom(payload);
        renderPlans();
        if (targetPlanCode === "starter" || targetPlanCode === "pro") {
          const target = root.querySelector<HTMLButtonElement>(`[data-plan-choice="${targetPlanCode}"]`);
          if (target?.dataset.currentPlan === "true") target.focus();
          else target?.click();
        }
      })
      .catch(handleFailure);
  }
  const urlState = new URL(window.location.href).searchParams;
  if (urlState.get("manage") === "plan") openPlanDialog();
  if (urlState.get("action") === "cancel") cancelDialog?.showModal();
  const hasBillingReturn = urlState.has("billing_return");
  const checkoutSessionId = urlState.get("checkout");
  if (hasBillingReturn && checkoutSessionId !== null && /^bchk_[0-9a-f-]{36}$/u.test(checkoutSessionId)) void pollBillingReturn(checkoutSessionId);
  else if (hasBillingReturn) {
    setUrlState("billing_return", null);
    const url = new URL(window.location.href);
    url.searchParams.delete("checkout");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  else {
    const operationId = urlState.get("operation");
    if (operationId !== null && /^[A-Za-z0-9._:-]{3,160}$/u.test(operationId)) void pollOperation(operationId);
  }
}
