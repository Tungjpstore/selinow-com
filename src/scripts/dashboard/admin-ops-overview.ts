export {};

type ApiFailure = { code?: unknown; requestId?: unknown };
type CopyParams = Record<string, string>;
type Tone = "danger" | "neutral" | "success" | "warning";

/**
 * Mirrors GET /api/admin/operations/overview. Every section is optional: the
 * backend omits a section when its bounded query fails, so the island renders
 * "—" for omitted state instead of failing the whole grid.
 */
type OpsOverviewBody = {
  ok?: unknown;
  requestId?: unknown;
  deadLetters?: { open?: unknown; retryRequested?: unknown };
  paymentExceptions?: { open?: unknown };
  remediationRequests?: { providerPending?: unknown; requested?: unknown };
  incidents?: { acknowledged?: unknown; open?: unknown };
  deliveryJobs?: { deadLetter?: unknown; failed?: unknown };
  subscriptions?: { byState?: unknown };
  providerHealth?: { payosActive?: unknown; telegramActive?: unknown; telegramRecentlyChecked?: unknown };
};

const OVERVIEW_ENDPOINT = "/api/admin/operations/overview";
const REFRESH_INTERVAL_MS = 30_000;
const FETCH_TIMEOUT_MS = 15_000;
// Backend subscription states are a small lowercase enum; anything else is
// dropped instead of rendered so the grid never mirrors unsafe strings.
const SAFE_STATE_PATTERN = /^[a-z0-9_]{1,32}$/u;

const DEFAULT_COPY = {
  "admin.ops.client.updated": "Updated {time}",
  "admin.ops.client.loading": "Loading operations signals…",
  "admin.ops.client.refreshed": "Operations signals are current.",
  "admin.ops.client.paused": "Auto-refresh is paused while this tab is hidden.",
  "admin.ops.client.error.generic": "The operations overview could not be refreshed. Showing the last known values.",
  "admin.overview.unavailable": "The operations overview is temporarily unavailable.",
  "admin.ops.client.error.two_factor_required": "Two-factor authentication is required for live operations data.",
  "admin.ops.client.error.two_factor_hint": "Enable two-factor authentication in account security to resume the operations feed.",
  "admin.ops.client.error.two_factor_link": "Open account security",
  "admin.ops.client.state.unknown": "—",
  "admin.ops.tone.attention": "Needs attention",
  "admin.ops.tone.watch": "Watch",
  "admin.ops.tone.nominal": "Nominal",
  "admin.ops.tone.unknown": "Unknown",
  "admin.ops.subscriptions.state_other": "{state}",
} as const;

type CopyKey = keyof typeof DEFAULT_COPY;
type CopyReader = (key: CopyKey, params?: CopyParams) => string;

class OpsOverviewError extends Error {
  readonly requestId: string | null;

  constructor(code: string, requestId: string | null) {
    super(code);
    this.name = "OpsOverviewError";
    this.requestId = requestId;
  }
}

function createCopyReader(root: HTMLElement): CopyReader {
  let supplied: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(root.dataset.copy ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      supplied = parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed optional copy must not prevent the overview grid from loading.
  }
  return (key, params = {}) => {
    const candidate = supplied[key];
    let value = typeof candidate === "string" && candidate.length > 0 ? candidate : DEFAULT_COPY[key];
    for (const [name, replacement] of Object.entries(params)) {
      value = value.split(`{${name}}`).join(replacement);
    }
    return value;
  };
}

function presentationLocale(): string | undefined {
  const lang = document.documentElement.lang;
  return typeof lang === "string" && lang.length > 0 ? lang : undefined;
}

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

function resolveSection(body: OpsOverviewBody, section: string): Record<string, unknown> | null {
  const candidate: unknown = section === "deadLetters"
    ? body.deadLetters
    : section === "paymentExceptions"
      ? body.paymentExceptions
      : section === "remediationRequests"
        ? body.remediationRequests
        : section === "incidents"
          ? body.incidents
          : section === "deliveryJobs"
            ? body.deliveryJobs
            : section === "providerHealth"
              ? body.providerHealth
              : undefined;
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function toneLabel(text: CopyReader, tone: Tone | null): string {
  if (tone === "danger") return text("admin.ops.tone.attention");
  if (tone === "warning") return text("admin.ops.tone.watch");
  if (tone === "success") return text("admin.ops.tone.nominal");
  return text("admin.ops.tone.unknown");
}

function cardTone(name: string, body: OpsOverviewBody): Tone | null {
  const counts = (section: Record<string, unknown> | null, field: string): number => safeCount(section?.[field]) ?? 0;
  switch (name) {
    case "deadLetters": {
      const section = body.deadLetters === undefined ? null : resolveSection(body, "deadLetters");
      if (body.deadLetters === undefined || section === null) return null;
      if (counts(section, "open") > 0) return "danger";
      return counts(section, "retryRequested") > 0 ? "warning" : "success";
    }
    case "paymentExceptions": {
      const section = body.paymentExceptions === undefined ? null : resolveSection(body, "paymentExceptions");
      if (body.paymentExceptions === undefined || section === null) return null;
      return counts(section, "open") > 0 ? "danger" : "success";
    }
    case "remediationRequests": {
      const section = body.remediationRequests === undefined ? null : resolveSection(body, "remediationRequests");
      if (body.remediationRequests === undefined || section === null) return null;
      return counts(section, "requested") > 0 || counts(section, "providerPending") > 0 ? "warning" : "success";
    }
    case "incidents": {
      const section = body.incidents === undefined ? null : resolveSection(body, "incidents");
      if (body.incidents === undefined || section === null) return null;
      if (counts(section, "open") > 0) return "danger";
      return counts(section, "acknowledged") > 0 ? "warning" : "success";
    }
    case "deliveryJobs": {
      const section = body.deliveryJobs === undefined ? null : resolveSection(body, "deliveryJobs");
      if (body.deliveryJobs === undefined || section === null) return null;
      return counts(section, "failed") > 0 || counts(section, "deadLetter") > 0 ? "danger" : "success";
    }
    case "providers": {
      const section = body.providerHealth === undefined ? null : resolveSection(body, "providerHealth");
      if (body.providerHealth === undefined || section === null) return null;
      return counts(section, "payosActive") > 0 && counts(section, "telegramActive") > 0 ? "success" : "warning";
    }
    default:
      // Subscription distribution is informational; it never raises an alarm by itself.
      return body.subscriptions === undefined ? null : "neutral";
  }
}

async function fetchOverview(): Promise<OpsOverviewBody> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(OVERVIEW_ENDPOINT, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      let body: ApiFailure = {};
      try {
        body = await response.json();
      } catch {
        // The stable HTTP status stays sufficient when an intermediary returns a non-JSON body.
      }
      throw new OpsOverviewError(
        typeof body.code === "string" ? body.code : `http_${String(response.status)}`,
        typeof body.requestId === "string" ? body.requestId : null,
      );
    }
    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || (parsed as OpsOverviewBody).ok !== true) {
      throw new OpsOverviewError("overview_invalid", null);
    }
    return parsed;
  } finally {
    window.clearTimeout(timeout);
  }
}

const root = document.querySelector<HTMLElement>("[data-ops-overview]");
if (root !== null) {
  const text = createCopyReader(root);
  const status = root.querySelector<HTMLElement>("[data-ops-status]");
  const refreshButton = root.querySelector<HTMLButtonElement>("[data-ops-refresh]");
  const twoFactorBanner = root.querySelector<HTMLElement>("[data-ops-2fa]");
  const subscriptionsList = root.querySelector<HTMLElement>("[data-ops-subscriptions]");
  const subscriptionLabels: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(root.dataset.subscriptionLabels ?? "{}");
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const [state, label] of Object.entries(parsed as Record<string, unknown>)) {
        if (SAFE_STATE_PATTERN.test(state) && typeof label === "string" && label.length > 0) {
          subscriptionLabels[state] = label;
        }
      }
    }
  } catch {
    // Labels fall back to the sanitized raw state name.
  }

  let formatter: Intl.NumberFormat;
  let timeFormatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.NumberFormat(presentationLocale(), { maximumFractionDigits: 0 });
    timeFormatter = new Intl.DateTimeFormat(presentationLocale(), { dateStyle: "short", timeStyle: "short" });
  } catch {
    formatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    timeFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });
  }

  const unknown = text("admin.ops.client.state.unknown");
  let timer: number | null = null;
  let inFlight = false;
  let lastSuccessAt = 0;
  let twoFactorBlocked = false;

  const setStatus = (message: string, tone: "error" | "neutral" | "success"): void => {
    if (status === null) return;
    status.textContent = message;
    status.dataset.tone = tone;
  };

  const renderValue = (element: HTMLElement, body: OpsOverviewBody): void => {
    const [section, field] = (element.dataset.opsValue ?? "").split(".");
    if (section === undefined || field === undefined) {
      element.textContent = unknown;
      return;
    }
    const resolved = body[section as keyof OpsOverviewBody] === undefined ? null : resolveSection(body, section);
    const value = resolved === null ? null : safeCount(resolved[field]);
    element.textContent = value === null ? unknown : formatter.format(value);
    const metricTone = element.dataset.opsTone;
    if (value !== null && value > 0 && (metricTone === "danger" || metricTone === "warning")) {
      element.dataset.level = metricTone === "danger" ? "alert" : "watch";
    } else {
      delete element.dataset.level;
    }
  };

  const renderSubscriptions = (body: OpsOverviewBody): void => {
    if (subscriptionsList === null) return;
    subscriptionsList.replaceChildren();
    const byState = body.subscriptions?.byState;
    if (body.subscriptions === undefined || typeof byState !== "object" || byState === null || Array.isArray(byState)) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = text("admin.ops.tone.unknown");
      const detail = document.createElement("dd");
      detail.className = "ops-num";
      detail.textContent = unknown;
      row.appendChild(term);
      row.appendChild(detail);
      subscriptionsList.appendChild(row);
      return;
    }
    const states = Object.keys(byState as Record<string, unknown>)
      .filter((state) => SAFE_STATE_PATTERN.test(state))
      .sort();
    if (states.length === 0) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = text("admin.ops.tone.unknown");
      const detail = document.createElement("dd");
      detail.className = "ops-num";
      detail.textContent = unknown;
      row.appendChild(term);
      row.appendChild(detail);
      subscriptionsList.appendChild(row);
      return;
    }
    for (const state of states) {
      const value = safeCount((byState as Record<string, unknown>)[state]);
      const row = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = subscriptionLabels[state]
        ?? text("admin.ops.subscriptions.state_other", { state });
      const detail = document.createElement("dd");
      detail.className = "ops-num";
      detail.textContent = value === null ? unknown : formatter.format(value);
      row.appendChild(term);
      row.appendChild(detail);
      subscriptionsList.appendChild(row);
    }
  };

  const renderCards = (body: OpsOverviewBody): void => {
    for (const card of Array.from(root.querySelectorAll<HTMLElement>("[data-ops-card]"))) {
      const tone = cardTone(card.dataset.opsCard ?? "", body);
      const toneAttribute = tone === null ? "neutral" : tone;
      card.dataset.tone = toneAttribute;
      card.dataset.state = tone === null ? "unknown" : "ready";
      const badge = card.querySelector<HTMLElement>("[data-ops-badge]");
      if (badge !== null) {
        badge.dataset.tone = toneAttribute === "neutral" ? "info" : toneAttribute;
        badge.textContent = toneLabel(text, tone);
      }
    }
    for (const element of Array.from(root.querySelectorAll<HTMLElement>("[data-ops-value]"))) {
      renderValue(element, body);
    }
    renderSubscriptions(body);
  };

  const setTwoFactorBanner = (visible: boolean): void => {
    if (twoFactorBanner === null) return;
    twoFactorBanner.hidden = !visible;
    if (!visible) return;
    const title = twoFactorBanner.querySelector<HTMLElement>("[data-ops-2fa-title]");
    const hint = twoFactorBanner.querySelector<HTMLElement>("[data-ops-2fa-hint]");
    const link = twoFactorBanner.querySelector<HTMLAnchorElement>("[data-ops-2fa-link]");
    if (title !== null) title.textContent = text("admin.ops.client.error.two_factor_required");
    if (hint !== null) hint.textContent = text("admin.ops.client.error.two_factor_hint");
    if (link !== null) link.textContent = text("admin.ops.client.error.two_factor_link");
  };

  const stopTimer = (): void => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  const startTimer = (): void => {
    if (timer === null && !twoFactorBlocked && !document.hidden) {
      timer = window.setInterval(() => {
        void refresh();
      }, REFRESH_INTERVAL_MS);
    }
  };

  const refresh = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    if (refreshButton !== null) {
      refreshButton.disabled = true;
      refreshButton.textContent = refreshButton.dataset.busyLabel ?? text("admin.ops.client.loading");
    }
    root.setAttribute("aria-busy", "true");
    try {
      const body = await fetchOverview();
      lastSuccessAt = Date.now();
      twoFactorBlocked = false;
      setTwoFactorBanner(false);
      renderCards(body);
      let stamp: string;
      try {
        stamp = timeFormatter.format(new Date());
      } catch {
        stamp = new Date().toISOString();
      }
      setStatus(`${text("admin.ops.client.refreshed")} ${text("admin.ops.client.updated", { time: stamp })}`, "success");
      startTimer();
    } catch (error) {
      const safeError = error instanceof OpsOverviewError
        ? error
        : new OpsOverviewError("overview_refresh_failed", null);
      if (safeError.message === "admin_two_factor_required") {
        twoFactorBlocked = true;
        stopTimer();
        setTwoFactorBanner(true);
        setStatus(text("admin.ops.client.error.two_factor_required"), "error");
      } else {
        setStatus(text("admin.overview.unavailable"), "error");
        if (!document.hidden) startTimer();
      }
    } finally {
      inFlight = false;
      if (refreshButton !== null) {
        refreshButton.disabled = false;
        if (refreshButton.dataset.label !== undefined) {
          refreshButton.textContent = refreshButton.dataset.label;
        }
      }
      root.setAttribute("aria-busy", "false");
    }
  };

  refreshButton?.addEventListener("click", () => {
    void refresh();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopTimer();
      setStatus(text("admin.ops.client.paused"), "neutral");
      return;
    }
    if (Date.now() - lastSuccessAt >= REFRESH_INTERVAL_MS) {
      void refresh();
    }
    startTimer();
  });

  void refresh();
}
