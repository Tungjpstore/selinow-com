export {};

type JsonObject = Record<string, unknown>;
type Plan = { code: string; name: string; version: number };
type ChangeRequest = { action: string; currentPlanCode: string; requestedPlanCode: string | null; reasonCode: string; requestPublicId: string; status: string; updatedAt: string; version: number };

const root = document.querySelector<HTMLElement>("[data-billing-root]");

if (root !== null && root.dataset.canManage === "true") {
  const shopPublicId = root.dataset.shopPublicId;
  const csrfCookieName = root.dataset.csrfCookieName ?? "";
  const feedback = root.querySelector<HTMLElement>("[data-billing-feedback]");
  const planSelect = root.querySelector<HTMLElement>("[data-billing-plan]") as HTMLSelectElement | null;
  const actionSelect = root.querySelector<HTMLElement>("[data-billing-action]") as HTMLSelectElement | null;
  const form = root.querySelector<HTMLFormElement>("[data-billing-request-form]");
  const ledger = root.querySelector<HTMLElement>("[data-billing-request-ledger]");
  const copy = (() => {
    try {
      const parsed: unknown = JSON.parse(root.dataset.copy ?? "{}");
      return typeof parsed === "object" && parsed !== null ? parsed as Record<string, string> : {};
    } catch { return {}; }
  })();
  const text = (key: string): string => copy[key] ?? "";
  const currentPlanCode = root.dataset.currentPlanCode ?? "";
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
      if (csrf === null) throw new Error(text("error"));
      headers.set("X-CSRF-Token", decodeURIComponent(csrf));
      headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", key());
    }
    const response = await fetch(url, { ...options, credentials: "same-origin", headers });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof payload === "object" && payload !== null && typeof (payload as { code?: unknown }).code === "string" ? (payload as { code: string }).code : text("error");
      throw new Error(code);
    }
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as JsonObject : null;
  };
  const plansFrom = (payload: JsonObject | null): Plan[] => {
    const values = payload?.plans;
    if (!Array.isArray(values)) return [];
    return values.filter((item): item is JsonObject => typeof item === "object" && item !== null && !Array.isArray(item)).map((item) => ({ code: typeof item.code === "string" ? item.code : "", name: typeof item.name === "string" ? item.name : "", version: typeof item.version === "number" ? item.version : 0 })).filter((plan) => plan.code.length > 0 && plan.name.length > 0);
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
      option.textContent = `${plan.name} (${plan.code})`;
      planSelect.appendChild(option);
    }
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
      renderPlans(plansFrom(plans));
      const parsedRequests = requestsFrom(requests);
      renderRequests(parsedRequests);
      const hasPending = parsedRequests.some((request) => request.status === "requested" || request.status === "provider_pending");
      if (form !== null) form.querySelector<HTMLButtonElement>("button[type=submit]")?.toggleAttribute("disabled", hasPending);
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
    if (pending || shopPublicId === undefined || !Number.isSafeInteger(subscriptionVersion) || !form.reportValidity()) return;
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
  void load();
}
