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
  cooldownSeconds?: unknown;
  debugOtp?: unknown;
  enabledAt?: unknown;
  entries?: unknown;
  issues?: unknown;
  requestId?: unknown;
  revokedSessionCount?: unknown;
  revokedCount?: unknown;
  sessions?: unknown;
};

type AccountRequestOptions = {
  body?: Record<string, unknown>;
  method: "DELETE" | "GET" | "POST";
};

type HistoryEntry = {
  id: string;
  occurredAt: string;
  outcome: string;
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

  let csrfRecoveryPromise: Promise<void> | null = null;

  const isCsrfTokenInvalid = (payload: ApiPayload): boolean => payload.code === "csrf_invalid"
    && Array.isArray(payload.issues)
    && (payload.issues[0] === "token_invalid" || payload.issues[0] === "token_mismatch");

  const recoverCsrf = async (): Promise<void> => {
    if (csrfRecoveryPromise !== null) return csrfRecoveryPromise;
    csrfRecoveryPromise = (async () => {
      const response = await fetch("/api/auth/csrf/refresh", {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({ code: "invalid_response" })) as ApiPayload;
      if (!response.ok) throw new SecurityApiError(payload);
    })().finally(() => { csrfRecoveryPromise = null; });
    return csrfRecoveryPromise;
  };

  const requestAccountApi = async (
    path: string,
    options: AccountRequestOptions,
    allowCsrfRecovery = true,
  ): Promise<ApiPayload> => {
    const response = await fetch(path, {
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      credentials: "same-origin",
      headers: {
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        Accept: "application/json",
        "X-CSRF-Token": csrfToken(),
      },
      method: options.method,
    });
    const payload = await response.json().catch(() => ({ code: "invalid_response" })) as ApiPayload;
    if (!response.ok) {
      if (allowCsrfRecovery && isCsrfTokenInvalid(payload)) {
        await recoverCsrf();
        return requestAccountApi(path, options, false);
      }
      throw new SecurityApiError(payload);
    }
    return payload;
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

  const issueMessage = (issue: string): string => {
    if (issue.startsWith("otp_incorrect_")) return t("dashboard.security.client.error.otp_incorrect");
    const issueMessages: Readonly<Record<string, string>> = {
      current_password_invalid: t("dashboard.security.client.error.current_password_invalid"),
      otp_expired_or_invalid: t("dashboard.security.client.error.otp_expired"),
      otp_max_attempts_exceeded: t("dashboard.security.client.error.otp_max_attempts"),
      password_complexity_failed: t("dashboard.security.client.error.password_policy"),
      password_same_as_current: t("dashboard.security.client.error.password_same_as_current"),
      password_too_long: t("dashboard.security.client.error.password_policy"),
      password_too_short: t("dashboard.security.client.error.password_policy"),
      password_too_weak: t("dashboard.security.client.error.password_policy"),
      reauthentication_required: t("dashboard.security.client.error.reauthentication_required"),
      two_factor_challenge_expired: t("dashboard.security.client.error.otp_expired"),
    };
    return issueMessages[issue] ?? t("dashboard.security.client.error.generic");
  };

  const errorMessage = (payload: ApiPayload): string => {
    const code = typeof payload.code === "string" ? payload.code : "invalid_response";
    const issue = Array.isArray(payload.issues) && typeof payload.issues[0] === "string" ? payload.issues[0] : "";
    const messages: Readonly<Record<string, string>> = {
      account_locked: t("dashboard.security.client.error.account_locked"),
      authentication_required: t("dashboard.security.client.error.authentication_required"),
      csrf_invalid: t("dashboard.security.client.error.csrf_invalid"),
      csrf_missing: t("dashboard.security.client.error.csrf_missing"),
      invalid_response: t("dashboard.security.client.error.invalid_response"),
      rate_limited: t("dashboard.security.client.error.rate_limited"),
      recent_auth_required: t("dashboard.security.client.error.recent_auth_required"),
      validation_failed: issueMessage(issue),
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
    return requestAccountApi("/api/auth/sessions", { method });
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

  // --------------------------------------------------
  // Account tabs: 2FA enrollment, password, login history
  // --------------------------------------------------
  const activeTab = root.dataset.activeTab ?? "sessions";

  const googleLinkButton = root.querySelector<HTMLButtonElement>("[data-google-link]");
  const googleLinkStatus = root.querySelector<HTMLElement>("[data-google-link-status]");
  const googleCallback = new URLSearchParams(window.location.search);
  const googleError = googleCallback.get("google_error");
  const googleLinked = googleCallback.get("google") === "linked" || googleError === "google_already_linked";
  const googleCallbackMessage = googleLinked
    ? t("dashboard.security.google.linked")
    : googleError === "google_identity_in_use"
      ? t("dashboard.security.google.identity_in_use")
      : googleError === "google_account_link_required" || googleError === "google_link_required"
        ? t("dashboard.security.google.link_required")
        : googleError !== null
          ? t("dashboard.security.google.error.generic")
          : null;
  if (googleCallbackMessage !== null && googleLinkStatus !== null) {
    googleLinkStatus.hidden = false;
    googleLinkStatus.dataset.tone = googleLinked ? "success" : "danger";
    googleLinkStatus.textContent = googleCallbackMessage;
    const next = new URL(window.location.href);
    next.searchParams.delete("google");
    next.searchParams.delete("google_error");
    window.history.replaceState({}, "", `${next.pathname}${next.search}${next.hash}`);
  }

  const postAccount = async (path: string, body: Record<string, unknown>): Promise<ApiPayload> => {
    return requestAccountApi(path, { body, method: "POST" });
  };

  googleLinkButton?.addEventListener("click", () => {
    void (async () => {
      googleLinkButton.disabled = true;
      setFeedback(t("dashboard.security.google.linking"));
      try {
        const payload = await requestAccountApi("/api/auth/google/start?flow=link", {
          body: { returnTo: "/app/security?tab=sessions" },
          method: "POST",
        }) as ApiPayload & { authorizationUrl?: unknown };
        if (typeof payload.authorizationUrl !== "string"
          || payload.authorizationUrl.length > 2048) throw new SecurityApiError(payload);
        const authorizationUrl = new URL(payload.authorizationUrl);
        if (authorizationUrl.protocol !== "https:" || authorizationUrl.hostname !== "accounts.google.com"
          || authorizationUrl.username !== "" || authorizationUrl.password !== "" || authorizationUrl.port !== ""
          || authorizationUrl.hash !== "") {
          throw new SecurityApiError({ code: "invalid_response" });
        }
        window.location.assign(authorizationUrl.toString());
      } catch (error) {
        handleAccountError(error);
        googleLinkButton.disabled = false;
      }
    })();
  });

  const getAccount = async (path: string): Promise<ApiPayload> => {
    return requestAccountApi(path, { method: "GET" });
  };

  const startCooldown = (button: HTMLButtonElement | null, seconds: unknown, restingLabel: string): void => {
    if (button === null) return;
    let remaining = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? Math.min(Math.ceil(seconds), 3600)
      : 60;
    button.disabled = true;
    const tick = (): void => {
      button.textContent = t("dashboard.security.two_factor.cooldown", { seconds: String(remaining) });
    };
    tick();
    const intervalId = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        window.clearInterval(intervalId);
        button.disabled = false;
        button.textContent = restingLabel;
      } else {
        tick();
      }
    }, 1000);
  };

  const handleAccountError = (error: unknown): void => {
    const payload = error instanceof SecurityApiError ? error.payload : { code: "invalid_response" };
    setFeedback(errorMessage(payload), "danger");
    if (reauthenticate !== null && payload.code === "recent_auth_required") reauthenticate.hidden = false;
  };

  const runGuarded = (button: HTMLButtonElement | null, action: () => Promise<void>): void => {
    void (async () => {
      if (button !== null) button.disabled = true;
      try {
        await action();
      } catch (error) {
        handleAccountError(error);
      } finally {
        if (button !== null) button.disabled = false;
      }
    })();
  };

  const inputValue = (selector: string): string =>
    root.querySelector<HTMLInputElement>(selector)?.value.trim() ?? "";

  // 2FA enrollment (two_factor_enabled = 0)
  const enrollButton = root.querySelector<HTMLButtonElement>("[data-two-factor-enable]");
  const enrollForm = root.querySelector<HTMLElement>("[data-two-factor-enroll-form]");
  const enrollVerify = root.querySelector<HTMLButtonElement>("[data-two-factor-verify]");
  const enrollResend = root.querySelector<HTMLButtonElement>("[data-two-factor-resend]");

  const requestEnrollmentOtp = async (cooldownButton: HTMLButtonElement | null): Promise<void> => {
    const payload = await postAccount("/api/app/account/enable-2fa-request", {});
    if (enrollForm !== null) enrollForm.hidden = false;
    // The server only attaches debugOtp when APP_ENV=local (dev/test aid);
    // surfacing it here keeps local flows usable without a mail provider.
    const debugSuffix = typeof payload.debugOtp === "string" ? ` [local] ${payload.debugOtp}` : "";
    setFeedback(`${t("dashboard.security.two_factor.otp_sent")}${debugSuffix}`, "success");
    startCooldown(cooldownButton, payload.cooldownSeconds, t("dashboard.security.two_factor.resend"));
  };

  enrollButton?.addEventListener("click", () => {
    runGuarded(enrollButton, () => requestEnrollmentOtp(enrollResend));
  });
  enrollResend?.addEventListener("click", () => {
    runGuarded(enrollResend, () => requestEnrollmentOtp(enrollResend));
  });
  enrollVerify?.addEventListener("click", () => {
    runGuarded(enrollVerify, async () => {
      const otp = inputValue("#two-factor-enroll-otp");
      setFeedback(t("dashboard.security.two_factor.verifying"));
      const payload = await postAccount("/api/app/account/enable-2fa-verify", { otp });
      const requestId = safeRequestId(payload.requestId);
      setFeedback(`${t("dashboard.security.two_factor.enabled_success")}${requestId === null
        ? ""
        : t("dashboard.security.client.request_id", { requestId })}`, "success");
      window.setTimeout(() => { window.location.assign("/app/security?tab=two_factor"); }, 900);
    });
  });

  // 2FA disable (two_factor_enabled = 1)
  const disableBlock = root.querySelector<HTMLElement>("[data-two-factor-disable]");
  if (disableBlock !== null) {
    const disableByPassword = disableBlock.querySelector<HTMLButtonElement>("[data-action='two-factor-disable']");
    const disableOtpRequest = disableBlock.querySelector<HTMLButtonElement>("[data-two-factor-disable-otp-request]");
    const disableOtpSubmit = disableBlock.querySelector<HTMLButtonElement>("[data-action='two-factor-disable-otp-submit']");

    const finishDisable = (payload: ApiPayload): void => {
      const requestId = safeRequestId(payload.requestId);
      setFeedback(`${t("dashboard.security.two_factor.disabled_success")}${requestId === null
        ? ""
        : t("dashboard.security.client.request_id", { requestId })}`, "success");
      window.setTimeout(() => { window.location.assign("/app/security?tab=two_factor"); }, 900);
    };

    disableByPassword?.addEventListener("click", () => {
      runGuarded(disableByPassword, async () => {
        const password = inputValue("#two-factor-disable-password");
        setFeedback(t("dashboard.security.two_factor.disabling"));
        finishDisable(await postAccount("/api/app/account/disable-2fa", { password }));
      });
    });
    disableOtpRequest?.addEventListener("click", () => {
      runGuarded(disableOtpRequest, async () => {
        const payload = await postAccount("/api/app/account/disable-2fa-request", {});
        setFeedback(t("dashboard.security.two_factor.otp_sent"), "success");
        startCooldown(disableOtpRequest, payload.cooldownSeconds, t("dashboard.security.two_factor.send_otp"));
      });
    });
    disableOtpSubmit?.addEventListener("click", () => {
      runGuarded(disableOtpSubmit, async () => {
        const otp = inputValue("#two-factor-disable-otp");
        setFeedback(t("dashboard.security.two_factor.disabling"));
        finishDisable(await postAccount("/api/app/account/disable-2fa", { otp }));
      });
    });
  }

  // Password change
  const passwordSubmit = root.querySelector<HTMLButtonElement>("[data-password-submit]");
  passwordSubmit?.addEventListener("click", () => {
    runGuarded(passwordSubmit, async () => {
      const currentPassword = inputValue("#password-current");
      const newPassword = inputValue("#password-new");
      setFeedback(t("dashboard.security.password.submitting"));
      const payload = await postAccount("/api/app/account/change-password", { currentPassword, newPassword });
      const count = typeof payload.revokedSessionCount === "number" && Number.isSafeInteger(payload.revokedSessionCount)
        ? payload.revokedSessionCount
        : 0;
      const requestId = safeRequestId(payload.requestId);
      setFeedback(`${t("dashboard.security.password.success", { count: String(count) })}${requestId === null
        ? ""
        : t("dashboard.security.client.request_id", { requestId })}`, "success");
      const currentField = root.querySelector<HTMLInputElement>("#password-current");
      const newField = root.querySelector<HTMLInputElement>("#password-new");
      if (currentField !== null) currentField.value = "";
      if (newField !== null) newField.value = "";
    });
  });

  // Login history
  const historyList = root.querySelector<HTMLElement>("[data-security-history-list]");
  const historyRefresh = root.querySelector<HTMLButtonElement>("[data-security-history-refresh]");

  const parseHistoryEntry = (value: unknown): HistoryEntry | null => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.id !== "string" || candidate.id.length > 64
      || typeof candidate.occurredAt !== "string" || !Number.isFinite(Date.parse(candidate.occurredAt))
      || typeof candidate.outcome !== "string" || candidate.outcome.length > 32) return null;
    return { id: candidate.id, occurredAt: candidate.occurredAt, outcome: candidate.outcome };
  };

  const outcomeTones: Readonly<Record<string, "danger" | "neutral" | "success" | "warning">> = {
    account_locked: "danger",
    account_suspended: "danger",
    email_unverified: "warning",
    invalid_credentials: "warning",
    success: "success",
    two_factor_failed: "danger",
    two_factor_required: "neutral",
  };

  const renderHistory = (entries: HistoryEntry[]): void => {
    if (historyList === null) return;
    for (const child of Array.from(historyList.children)) {
      if (!(child instanceof HTMLElement) || child.dataset.securityHistoryEmpty === undefined) child.remove();
    }
    const emptyState = historyList.querySelector<HTMLElement>("[data-security-history-empty]");
    if (emptyState !== null) emptyState.hidden = entries.length > 0;
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "history-row";
      row.setAttribute("role", "listitem");
      const time = document.createElement("time");
      time.dateTime = entry.occurredAt;
      time.textContent = formatDate(entry.occurredAt);
      const badge = document.createElement("span");
      badge.className = "history-outcome";
      badge.dataset.tone = outcomeTones[entry.outcome] ?? "neutral";
      badge.textContent = t(`dashboard.security.history.outcome.${entry.outcome}`);
      row.appendChild(time);
      row.appendChild(badge);
      historyList.appendChild(row);
    }
  };

  const loadHistory = (): void => {
    historyRefresh?.setAttribute("disabled", "true");
    setFeedback(t("dashboard.security.history.loading"));
    void (async () => {
      try {
        const payload = await getAccount("/api/app/account/login-history?limit=20");
        if (!Array.isArray(payload.entries)) throw new SecurityApiError({ code: "invalid_response", requestId: payload.requestId });
        const entries = payload.entries.map(parseHistoryEntry);
        if (entries.some((entry) => entry === null)) {
          throw new SecurityApiError({ code: "invalid_response", requestId: payload.requestId });
        }
        renderHistory(entries as HistoryEntry[]);
        setFeedback(t("dashboard.security.history.loaded"), "success");
      } catch (error) {
        handleAccountError(error);
      } finally {
        historyRefresh?.removeAttribute("disabled");
      }
    })();
  };

  historyRefresh?.addEventListener("click", loadHistory);

  void loadSessions();
  if (activeTab === "history") loadHistory();
}

export {};
