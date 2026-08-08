import { isBillingRecentAuthFailure, readBillingApiFailure, type BillingApiFailure } from "../../lib/dashboard/billing-api-error";
import { getBillingCheckoutAdmission } from "../../lib/dashboard/billing-checkout";

type JsonObject = Record<string, unknown>;
type Price = { amountMinor: number; currency: string; displayAmount: string | null; interval: string; marketCode: string };
type Plan = { code: string; name: string; prices: Price[]; version: number };
type ChangeRequest = { action: string; currentPlanCode: string; requestedPlanCode: string | null; reasonCode: string; requestPublicId: string; status: string; updatedAt: string; version: number };
type BillingCheckoutAttemptInput = { planCode: string; recovery: boolean; shopPublicId: string };
type BillingCheckoutAttempt = BillingCheckoutAttemptInput & { idempotencyKey: string };
type BillingCheckoutAttemptRecord = BillingCheckoutAttempt & { expiresAt: number; version: 1 };
type BillingCheckoutAttemptStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

const BILLING_CHECKOUT_ATTEMPT_STORAGE_KEY = "selinow.billing.checkout-attempt.v1";
const BILLING_CHECKOUT_ATTEMPT_TTL_MS = 30 * 60_000;

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
    this.current = { ...input, expiresAt: this.now() + this.ttlMs, idempotencyKey: this.createKey(), version: 1 };
    this.persist();
    return this.current;
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
      return record as BillingCheckoutAttemptRecord;
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

export function isBillingCheckoutTerminalFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as { code?: unknown; terminalResponse?: unknown };
  if (failure.terminalResponse !== true) return false;
  return failure.code !== "billing_provider_unavailable" && failure.code !== "billing_checkout_pending";
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
  const requestId = typeof payload?.requestId === "string" && /^[A-Za-z0-9._-]{8,128}$/u.test(payload.requestId) ? payload.requestId : null;
  if (provider !== "dodo") throw new BillingApiError({ code: "checkout_provider_invalid", requestId });
  let checkoutUrl: URL;
  try { checkoutUrl = new URL(rawUrl); } catch { throw new BillingApiError({ code: "checkout_url_invalid", requestId }); }
  if (checkoutUrl.protocol !== "https:" || checkoutUrl.username.length > 0 || checkoutUrl.password.length > 0) throw new BillingApiError({ code: "checkout_url_invalid", requestId });
  tracker.finish(attempt);
  return checkoutUrl.toString();
}

const root = document.querySelector<HTMLElement>("[data-billing-root]");

if (root !== null && root.dataset.canManage === "true") {
  const shopPublicId = root.dataset.shopPublicId;
  const csrfCookieName = root.dataset.csrfCookieName ?? "";
  const feedback = root.querySelector<HTMLElement>("[data-billing-feedback]");
  const planSelect = root.querySelector<HTMLElement>("[data-billing-plan]") as HTMLSelectElement | null;
  const actionSelect = root.querySelector<HTMLElement>("[data-billing-action]") as HTMLSelectElement | null;
  const form = root.querySelector<HTMLFormElement>("[data-billing-request-form]");
  const ledger = root.querySelector<HTMLElement>("[data-billing-request-ledger]");
  const checkoutForm = root.querySelector<HTMLFormElement>("[data-billing-checkout-form]");
  const checkoutPlanSelect = root.querySelector<HTMLElement>("[data-billing-checkout-plan]") as HTMLSelectElement | null;
  const checkoutSubmit = root.querySelector<HTMLElement>("[data-billing-checkout-submit]") as HTMLButtonElement | null;
  const checkoutFeedback = root.querySelector<HTMLElement>("[data-billing-checkout-feedback]");
  const checkoutRecentAuthAction = root.querySelector<HTMLButtonElement>("[data-billing-recent-auth-action]");
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
  const checkoutAttemptStorage = (() => {
    try { return window.sessionStorage; } catch { return null; }
  })();
  const checkoutAttempts = new BillingCheckoutAttemptTracker({ storage: checkoutAttemptStorage });
  let pending = false;

  const readCookie = (name: string): string | null => document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const showFeedback = (message: string, tone: "danger" | "info" | "success" = "info"): void => {
    if (feedback === null) return;
    feedback.textContent = message;
    feedback.dataset.tone = tone;
    feedback.hidden = message.length === 0;
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
    try {
      payload = await response.json();
    } catch {
      if (response.ok && method !== "GET" && method !== "HEAD") throw new BillingApiError({ code: "billing_response_unavailable", requestId: null });
      payload = null;
    }
    if (!response.ok) {
      throw new BillingApiError(readBillingApiFailure(payload, response.status), true);
    }
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as JsonObject : null;
  };
  const priceFrom = (value: unknown): Price | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const item = value as JsonObject;
    if (!Number.isSafeInteger(item.amountMinor) || typeof item.currency !== "string" || typeof item.interval !== "string" || typeof item.marketCode !== "string") return null;
    return { amountMinor: item.amountMinor as number, currency: item.currency, displayAmount: typeof item.displayAmount === "string" ? item.displayAmount : null, interval: item.interval, marketCode: item.marketCode };
  };
  const plansFrom = (payload: JsonObject | null): Plan[] => {
    const values = payload?.plans;
    if (!Array.isArray(values)) return [];
    return values.filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item)).map((item) => {
      const rawPrices = Array.isArray(item.prices) ? item.prices : Array.isArray(item.offers) ? item.offers : [];
      return { code: typeof item.code === "string" ? item.code : "", name: typeof item.name === "string" ? item.name : "", prices: rawPrices.map(priceFrom).filter((price): price is Price => price !== null), version: typeof item.version === "number" ? item.version : 0 };
    }).filter((plan) => plan.code.length > 0 && plan.name.length > 0);
  };
  const requestsFrom = (payload: JsonObject | null): ChangeRequest[] => {
    const values = payload?.requests;
    if (!Array.isArray(values)) return [];
    return values.filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item)).map((item) => ({ action: typeof item.action === "string" ? item.action : "unknown", currentPlanCode: typeof item.currentPlanCode === "string" ? item.currentPlanCode : "", requestedPlanCode: item.requestedPlanCode === null || typeof item.requestedPlanCode === "string" ? item.requestedPlanCode : null, reasonCode: typeof item.reasonCode === "string" ? item.reasonCode : "", requestPublicId: typeof item.requestPublicId === "string" ? item.requestPublicId : "", status: typeof item.status === "string" ? item.status : "unknown", updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "", version: typeof item.version === "number" ? item.version : 0 })).filter((request) => request.requestPublicId.length > 0);
  };
  const statusLabel = (status: string): string => status === "requested" ? text("statusRequested") : status === "provider_pending" ? text("statusProviderPending") : status === "completed" ? text("statusCompleted") : status === "canceled" ? text("statusCanceled") : status === "rejected" ? text("statusRejected") : status;
  const renderPlans = (plans: readonly Plan[]): void => {
    if (planSelect === null) return;
    planSelect.replaceChildren();
    for (const plan of plans) {
      if (plan.code === currentPlanCode) continue;
      const option = document.createElement("option");
      option.value = plan.code;
      const price = plan.prices[0];
      const priceLabel = price === undefined ? "" : ` · ${price.displayAmount ?? new Intl.NumberFormat(document.documentElement.lang || "en", { style: "currency", currency: price.currency, maximumFractionDigits: price.currency === "VND" ? 0 : 2 }).format(price.amountMinor / (price.currency === "VND" ? 1 : 100))} / ${price.interval}`;
      option.textContent = `${plan.name} (${plan.code})${priceLabel}`;
      planSelect.appendChild(option);
    }
  };
  const renderCheckoutPlans = (plans: readonly Plan[]): void => {
    if (checkoutPlanSelect === null) return;
    checkoutPlanSelect.replaceChildren();
    const admission = getBillingCheckoutAdmission({ billingState, currentPlanCode, marketReady: billingMarketReady, plans });
    const eligible = admission.eligible;
    for (const plan of eligible) {
      const option = document.createElement("option");
      option.value = plan.code;
      const price = plan.prices[0];
      const priceLabel = price === undefined ? "" : ` · ${price.displayAmount ?? new Intl.NumberFormat(document.documentElement.lang || "en", { style: "currency", currency: price.currency, maximumFractionDigits: price.currency === "VND" ? 0 : 2 }).format(price.amountMinor / (price.currency === "VND" ? 1 : 100))} / ${price.interval}`;
      option.textContent = `${plan.name}${priceLabel}`;
      checkoutPlanSelect.appendChild(option);
    }
    if (checkoutSubmit !== null) checkoutSubmit.disabled = eligible.length === 0;
    if (checkoutRecentAuthAction !== null) checkoutRecentAuthAction.hidden = true;
    if (admission.reasonCode === "billing_market_unavailable") showCheckoutFeedback(text("checkoutMarketRequired"), "danger");
    else if (admission.reasonCode === "plan_price_unavailable") showCheckoutFeedback(text("checkoutUnavailable"), "danger");
    else showCheckoutFeedback("");
  };
  const showCheckoutFeedback = (message: string, tone: "danger" | "info" | "success" = "info"): void => {
    if (checkoutFeedback === null) return;
    checkoutFeedback.textContent = message;
    checkoutFeedback.dataset.tone = tone;
    checkoutFeedback.hidden = message.length === 0;
  };
  const billingFailure = (error: unknown): BillingApiFailure => error instanceof BillingApiError
    ? { code: error.code, requestId: error.requestId }
    : { code: error instanceof Error ? error.message : "internal_error", requestId: null };
  const checkoutErrorMessage = (error: unknown): string => {
    const failure = billingFailure(error);
    const message = isBillingRecentAuthFailure(failure.code)
      ? text("checkoutRecentAuthRequired")
      : ["billing_market_unavailable", "plan_price_unavailable", "provider_not_ready", "billing_provider_unavailable", "billing_checkout_pending", "billing_recovery_plan_mismatch", "checkout_provider_invalid"].includes(failure.code)
        ? text("checkoutUnavailable")
        : text("error");
    const references = [text("checkoutErrorCode").replace("{code}", failure.code)];
    if (failure.requestId !== null) references.push(text("checkoutRequestId").replace("{requestId}", failure.requestId));
    return `${message} ${references.join(" · ")}`;
  };
  const renderRequests = (requests: readonly ChangeRequest[]): void => {
    if (ledger === null) return;
    ledger.replaceChildren();
    if (requests.length === 0) {
      const empty = document.createElement("div");
      empty.setAttribute("role", "listitem");
      empty.textContent = text("loaded");
      ledger.appendChild(empty);
      return;
    }
    for (const request of requests) {
      const row = document.createElement("article");
      row.className = "billing-request-row";
      row.setAttribute("role", "listitem");
      const summary = document.createElement("div");
      const heading = document.createElement("strong");
      heading.textContent = request.action === "change_plan" ? `${request.currentPlanCode} → ${request.requestedPlanCode ?? "?"}` : request.action;
      const details = document.createElement("span");
      details.textContent = `${request.requestPublicId} · ${request.reasonCode}`;
      summary.appendChild(heading);
      summary.appendChild(details);
      const status = document.createElement("span");
      status.textContent = statusLabel(request.status);
      row.appendChild(summary);
      row.appendChild(status);
      ledger.appendChild(row);
    }
  };
  const load = async (): Promise<void> => {
    if (shopPublicId === undefined) return;
    showFeedback(text("loading"), "info");
    try {
      const [plans, requests] = await Promise.all([requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/billing/plans`), requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/billing/requests`)]);
      const parsedPlans = plansFrom(plans);
      renderPlans(parsedPlans);
      renderCheckoutPlans(parsedPlans);
      const parsedRequests = requestsFrom(requests);
      renderRequests(parsedRequests);
      const hasPending = parsedRequests.some((request) => request.status === "requested" || request.status === "provider_pending");
      const stateBlocksMutation = billingState === "pending_payment" || billingState === "suspended" || billingState === "canceled";
      if (form !== null) form.querySelector<HTMLButtonElement>("button[type=submit]")?.toggleAttribute("disabled", hasPending || stateBlocksMutation);
      if (planSelect !== null) planSelect.disabled = stateBlocksMutation;
      if (actionSelect !== null) actionSelect.disabled = stateBlocksMutation;
      showFeedback(text("loaded"), "success");
    } catch (error) {
      showFeedback(`${text("unavailable")} ${error instanceof Error ? error.message : text("error")}`, "danger");
    }
  };
  actionSelect?.addEventListener("change", () => {
    const field = root.querySelector<HTMLElement>("[data-billing-plan-field]");
    if (field !== null) field.hidden = actionSelect.value !== "change_plan";
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pending || billingState === "pending_payment" || billingState === "suspended" || billingState === "canceled" || shopPublicId === undefined || !Number.isSafeInteger(subscriptionVersion) || !form.reportValidity()) return;
    const values = new FormData(form);
    const action = values.get("action");
    const reasonCode = values.get("reasonCode");
    const requestedPlanCode = values.get("requestedPlanCode");
    if (action !== "cancel" && action !== "change_plan") return;
    if (action === "cancel" && !window.confirm(text("cancelConfirm"))) return;
    pending = true;
    showFeedback(text("requesting"), "info");
    const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
    if (submit !== null) submit.disabled = true;
    void requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/billing/requests`, { method: "POST", body: JSON.stringify({ action, expectedSubscriptionVersion: subscriptionVersion, reasonCode, requestedPlanCode: action === "change_plan" ? requestedPlanCode : undefined }) }).then(() => { showFeedback(text("requested"), "success"); return load(); }).catch((error: unknown) => { showFeedback(error instanceof Error ? error.message : text("error"), "danger"); }).finally(() => { pending = false; if (submit !== null) submit.disabled = false; });
  });
  checkoutForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (pending || shopPublicId === undefined || checkoutPlanSelect === null || checkoutSubmit === null || billingState === "canceled") return;
    const planCode = checkoutPlanSelect.value;
    if (planCode !== "starter" && planCode !== "pro") return;
    const checkoutAttempt = checkoutAttempts.begin({ planCode, recovery: billingState === "suspended", shopPublicId });
    pending = true;
    checkoutSubmit.disabled = true;
    checkoutSubmit.setAttribute("aria-busy", "true");
    if (checkoutRecentAuthAction !== null) checkoutRecentAuthAction.hidden = true;
    showCheckoutFeedback(text("checkoutOpening"), "info");
    void requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/billing/checkout`, { method: "POST", body: JSON.stringify({ planCode, recovery: billingState === "suspended" }) }, checkoutAttempt.idempotencyKey).then((payload) => {
      const url = acceptBillingCheckoutResponse(payload, checkoutAttempt, checkoutAttempts);
      showCheckoutFeedback(text("checkoutOpening"), "success");
      window.location.assign(url);
    }).catch((error: unknown) => {
      checkoutAttempts.fail(checkoutAttempt, isBillingCheckoutTerminalFailure(error));
      const failure = billingFailure(error);
      if (checkoutRecentAuthAction !== null) checkoutRecentAuthAction.hidden = !isBillingRecentAuthFailure(failure.code);
      showCheckoutFeedback(checkoutErrorMessage(error), "danger");
      checkoutSubmit.disabled = false;
    }).finally(() => {
      pending = false;
      checkoutSubmit.removeAttribute("aria-busy");
    });
  });
  checkoutRecentAuthAction?.addEventListener("click", () => {
    document.querySelector<HTMLButtonElement>("[data-app-logout]")?.click();
  });
  void load();
}
