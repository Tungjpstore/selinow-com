import { isBillingRecentAuthFailure, readBillingApiFailure, type BillingApiFailure } from "../../lib/dashboard/billing-api-error";
import { getBillingCheckoutAdmission } from "../../lib/dashboard/billing-checkout";

type JsonObject = Record<string, unknown>;
type Price = { amountMinor: number; currency: string; displayAmount: string | null; interval: string; marketCode: string };
type Plan = { code: string; name: string; prices: Price[]; version: number };
type ChangeRequest = { action: string; currentPlanCode: string; requestedPlanCode: string | null; reasonCode: string; requestPublicId: string; status: string; updatedAt: string; version: number };

class BillingApiError extends Error {
  readonly code: string;
  readonly requestId: string | null;

  constructor(failure: BillingApiFailure) {
    super(failure.code);
    this.name = "BillingApiError";
    this.code = failure.code;
    this.requestId = failure.requestId;
  }
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
  let pending = false;

  const readCookie = (name: string): string | null => document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const key = (): string => {
    try { return `billing_ui_${crypto.randomUUID()}`; }
    catch { return `billing_ui_${String(Date.now())}_${Math.random().toString(36).slice(2)}`; }
  };
  const showFeedback = (message: string, tone: "danger" | "info" | "success" = "info"): void => {
    if (feedback === null) return;
    feedback.textContent = message;
    feedback.dataset.tone = tone;
    feedback.hidden = message.length === 0;
  };
  const requestApi = async (url: string, options: RequestInit = {}): Promise<JsonObject | null> => {
    const headers = new Headers(options.headers);
    const method = options.method?.toUpperCase() ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      const csrf = readCookie(csrfCookieName);
      if (csrf === null) throw new BillingApiError({ code: "csrf_missing", requestId: null });
      headers.set("X-CSRF-Token", decodeURIComponent(csrf));
      headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", key());
    }
    const response = await fetch(url, { ...options, credentials: "same-origin", headers });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      throw new BillingApiError(readBillingApiFailure(payload, response.status));
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
    pending = true;
    checkoutSubmit.disabled = true;
    checkoutSubmit.setAttribute("aria-busy", "true");
    if (checkoutRecentAuthAction !== null) checkoutRecentAuthAction.hidden = true;
    showCheckoutFeedback(text("checkoutOpening"), "info");
    void requestApi(`/api/app/shops/${encodeURIComponent(shopPublicId)}/billing/checkout`, { method: "POST", body: JSON.stringify({ planCode, recovery: billingState === "suspended" }) }).then((payload) => {
      const checkout = payload?.checkout;
      const provider = typeof checkout === "object" && checkout !== null && typeof (checkout as { provider?: unknown }).provider === "string" ? (checkout as { provider: string }).provider : "";
      const url = typeof checkout === "object" && checkout !== null && typeof (checkout as { checkoutUrl?: unknown }).checkoutUrl === "string" ? (checkout as { checkoutUrl: string }).checkoutUrl : "";
      const requestId = typeof payload?.requestId === "string" && /^[A-Za-z0-9._-]{8,128}$/u.test(payload.requestId) ? payload.requestId : null;
      if (provider !== "dodo") throw new BillingApiError({ code: "checkout_provider_invalid", requestId });
      if (!/^https:\/\//u.test(url)) throw new BillingApiError({ code: "checkout_url_invalid", requestId });
      showCheckoutFeedback(text("checkoutOpening"), "success");
      window.location.assign(url);
    }).catch((error: unknown) => {
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
