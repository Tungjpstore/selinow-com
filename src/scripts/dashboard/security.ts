import { createDashboardTranslator } from "../../lib/i18n/catalogs/dashboard";

type SafeSession = {
  authenticatedAt: string;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
  lastSeenAt: string;
};

type ApiPayload = {
  code?: unknown;
  requestId?: unknown;
  revokedCount?: unknown;
  sessions?: unknown;
};

class SecurityApiError extends Error {
  readonly payload: ApiPayload;

  constructor(payload: ApiPayload) {
    super(typeof payload.code === "string" ? payload.code : "invalid_response");
    this.name = "SecurityApiError";
    this.payload = payload;
  }
}

const root = document.querySelector<HTMLElement>("[data-account-security-root]");

if (root !== null) {
  const t = createDashboardTranslator(root.dataset.locale ?? "en");
  const feedback = root.querySelector<HTMLElement>("[data-security-feedback]");
  const list = root.querySelector<HTMLElement>("[data-security-session-list]");
  const refresh = root.querySelector<HTMLButtonElement>("[data-security-refresh]");
  const revokeAll = root.querySelector<HTMLButtonElement>("[data-security-revoke-all]");
  const reauthenticate = root.querySelector<HTMLButtonElement>("[data-security-reauth]");
  const csrfCookieName = root.dataset.csrfCookieName ?? "";
  const requestIdPattern = /^[A-Za-z0-9._:-]{8,128}$/u;
  const dateFormatter = new Intl.DateTimeFormat(root.dataset.locale ?? "en", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const csrfToken = (): string => {
    const prefix = `${encodeURIComponent(csrfCookieName)}=`;
    const pair = document.cookie.split(";").map((value) => value.trim()).find((value) => value.startsWith(prefix));
    if (pair === undefined) return "";
    try {
      return decodeURIComponent(pair.slice(prefix.length));
    } catch {
      return "";
    }
  };

  const safeRequestId = (value: unknown): string | null => typeof value === "string" && requestIdPattern.test(value)
    ? value
    : null;

  const setFeedback = (message: string, tone: "danger" | "info" | "success" = "info"): void => {
    if (feedback === null) return;
    feedback.dataset.tone = tone;
    feedback.textContent = message;
    feedback.focus({ preventScroll: true });
  };

  const errorMessage = (payload: ApiPayload): string => {
    const code = typeof payload.code === "string" ? payload.code : "invalid_response";
    const messages: Readonly<Record<string, string>> = {
      authentication_required: t("dashboard.security.client.error.authentication_required"),
      csrf_invalid: t("dashboard.security.client.error.csrf_invalid"),
      csrf_missing: t("dashboard.security.client.error.csrf_missing"),
      invalid_response: t("dashboard.security.client.error.invalid_response"),
      recent_auth_required: t("dashboard.security.client.error.recent_auth_required"),
    };
    const requestId = safeRequestId(payload.requestId);
    return `${messages[code] ?? t("dashboard.security.client.error.generic")}${requestId === null
      ? ""
      : t("dashboard.security.client.request_id", { requestId })}`;
  };

  const parseSession = (value: unknown): SafeSession | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const dates = [candidate.authenticatedAt, candidate.createdAt, candidate.expiresAt, candidate.lastSeenAt];
    if (typeof candidate.isCurrent !== "boolean"
      || dates.some((date) => typeof date !== "string" || date.length > 64 || !Number.isFinite(Date.parse(date)))) return null;
    return {
      authenticatedAt: candidate.authenticatedAt as string,
      createdAt: candidate.createdAt as string,
      expiresAt: candidate.expiresAt as string,
      isCurrent: candidate.isCurrent,
      lastSeenAt: candidate.lastSeenAt as string,
    };
  };

  const requestSessions = async (method: "DELETE" | "GET"): Promise<ApiPayload> => {
    const response = await fetch("/api/auth/sessions", {
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        "X-CSRF-Token": csrfToken(),
      },
      method,
    });
    const payload = await response.json().catch(() => ({ code: "invalid_response" })) as ApiPayload;
    if (!response.ok) throw new SecurityApiError(payload);
    return payload;
  };

  const formatDate = (value: string): string => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? dateFormatter.format(new Date(timestamp)) : t("dashboard.security.sessions.unknown_time");
  };

  const appendMetadata = (article: HTMLElement, label: string, value: string): void => {
    const metadata = document.createElement("div");
    metadata.className = "session-meta";
    const caption = document.createElement("span");
    caption.textContent = label;
    const time = document.createElement("time");
    time.dateTime = value;
    time.textContent = formatDate(value);
    metadata.appendChild(caption);
    metadata.appendChild(time);
    article.appendChild(metadata);
  };

  const renderSessions = (sessions: SafeSession[]): void => {
    if (list === null) return;
    list.replaceChildren();
    if (sessions.length === 0) {
      const empty = document.createElement("article");
      empty.setAttribute("role", "listitem");
      empty.className = "session-loading";
      const mark = document.createElement("span");
      mark.className = "session-mark";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = "—";
      const copy = document.createElement("p");
      copy.textContent = t("dashboard.security.sessions.empty");
      empty.appendChild(mark);
      empty.appendChild(copy);
      list.appendChild(empty);
      return;
    }

    sessions.sort((left, right) => Number(right.isCurrent) - Number(left.isCurrent)
      || Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));
    for (const session of sessions) {
      const article = document.createElement("article");
      article.setAttribute("role", "listitem");
      const mark = document.createElement("span");
      mark.className = "session-mark";
      mark.setAttribute("aria-hidden", "true");
      mark.textContent = session.isCurrent ? "●" : "○";
      const copy = document.createElement("div");
      copy.className = "session-copy";
      const name = document.createElement("strong");
      name.textContent = session.isCurrent
        ? t("dashboard.security.sessions.current")
        : t("dashboard.security.sessions.other");
      copy.appendChild(name);
      if (session.isCurrent) {
        const badge = document.createElement("span");
        badge.textContent = t("dashboard.security.sessions.current");
        copy.appendChild(badge);
      }
      article.appendChild(mark);
      article.appendChild(copy);
      appendMetadata(article, t("dashboard.security.sessions.authenticated"), session.authenticatedAt);
      appendMetadata(article, t("dashboard.security.sessions.created"), session.createdAt);
      appendMetadata(article, t("dashboard.security.sessions.last_seen"), session.lastSeenAt);
      appendMetadata(article, t("dashboard.security.sessions.expires"), session.expiresAt);
      list.appendChild(article);
    }
  };

  const loadSessions = async (refreshing = false): Promise<void> => {
    refresh?.setAttribute("disabled", "true");
    setFeedback(refreshing
      ? t("dashboard.security.client.refreshing")
      : t("dashboard.security.client.loading"));
    if (reauthenticate !== null) reauthenticate.hidden = true;
    try {
      const payload = await requestSessions("GET");
      if (!Array.isArray(payload.sessions)) throw new SecurityApiError({ code: "invalid_response", requestId: payload.requestId });
      const sessions = payload.sessions.map(parseSession);
      if (sessions.some((session) => session === null)) {
        throw new SecurityApiError({ code: "invalid_response", requestId: payload.requestId });
      }
      renderSessions(sessions as SafeSession[]);
      const requestId = safeRequestId(payload.requestId);
      setFeedback(`${t("dashboard.security.client.loaded")}${requestId === null
        ? ""
        : t("dashboard.security.client.request_id", { requestId })}`, "success");
    } catch (error) {
      const payload = error instanceof SecurityApiError ? error.payload : { code: "invalid_response" };
      setFeedback(errorMessage(payload), "danger");
      if (reauthenticate !== null && payload.code === "authentication_required") reauthenticate.hidden = false;
    } finally {
      refresh?.removeAttribute("disabled");
    }
  };

  refresh?.addEventListener("click", () => { void loadSessions(true); });
  revokeAll?.addEventListener("click", () => {
    if (!window.confirm(t("dashboard.security.revoke.confirm"))) return;
    void (async () => {
      revokeAll.disabled = true;
      if (reauthenticate !== null) reauthenticate.hidden = true;
      setFeedback(t("dashboard.security.client.revoking"));
      try {
        const payload = await requestSessions("DELETE");
        const requestId = safeRequestId(payload.requestId);
        renderSessions([]);
        setFeedback(`${t("dashboard.security.client.revoked")}${requestId === null
          ? ""
          : t("dashboard.security.client.request_id", { requestId })}`, "success");
        window.setTimeout(() => { window.location.assign("/login"); }, 900);
      } catch (error) {
        const payload = error instanceof SecurityApiError ? error.payload : { code: "invalid_response" };
        setFeedback(errorMessage(payload), "danger");
        if (reauthenticate !== null && payload.code === "recent_auth_required") reauthenticate.hidden = false;
        revokeAll.disabled = false;
      }
    })();
  });
  reauthenticate?.addEventListener("click", () => {
    const logout = document.querySelector<HTMLButtonElement>("[data-app-logout]");
    if (logout !== null) logout.click();
    else window.location.assign("/login");
  });

  void loadSessions();
}

export {};
