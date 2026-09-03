import {
  deriveDomainLifecycle,
  domainStatusLabel,
  domainStatusTone,
  isDomainReady,
  validateHostnameDraft,
} from "../../lib/dashboard/domain-ui";
import { createDashboardTranslator } from "../../lib/i18n/catalogs/dashboard";

export {};

type DomainRecord = {
  dnsInstructions: { name: string; target: string; type: "CNAME" | "TXT" } | null;
  dnsStatus: string | null;
  hostname: string;
  hostnameStatus: string | null;
  id: string;
  isPrimary: boolean;
  lastCheckedAt: string | null;
  lastSafeErrorCode: string | null;
  ownershipStatus: "pending" | "verified" | null;
  sslStatus: string | null;
  status: string;
  turnstileStatus: string | null;
  type: "custom" | "platform_subdomain";
};

type SelectedShop = {
  entitled: boolean;
  id: string;
  name: string;
  role: string;
  status: string;
};

class DomainApiError extends Error {
  code: string;
  issues: string[];
  requestId: string | null;

  constructor(code: string, issues: string[], requestId: string | null) {
    super(code);
    this.name = "DomainApiError";
    this.code = code;
    this.issues = issues;
    this.requestId = requestId;
  }
}

const workspaceElement = document.querySelector<HTMLElement>("[data-domain-workspace]");

if (workspaceElement !== null) {
  const workspace = workspaceElement;
  const t = createDashboardTranslator(workspace.dataset.locale ?? "en");
  const panel = workspace.querySelector<HTMLElement>("[data-domain-panel]");
  const domainList = workspace.querySelector<HTMLElement>("[data-domain-list]");
  const domainTemplate = workspace.querySelector<HTMLTemplateElement>("[data-domain-template]");
  const loadingElement = workspace.querySelector<HTMLElement>("[data-domain-loading]");
  const listError = workspace.querySelector<HTMLElement>("[data-list-error]");
  const listErrorMessage = workspace.querySelector<HTMLElement>("[data-list-error-message]");
  const panelState = workspace.querySelector<HTMLElement>("[data-panel-state]");
  const permissionNote = workspace.querySelector<HTMLElement>("[data-permission-note]");
  const entitlementNote = workspace.querySelector<HTMLElement>("[data-entitlement-note]");
  const suspendedNote = workspace.querySelector<HTMLElement>("[data-suspended-note]");
  const domainContent = Array.from(workspace.querySelectorAll<HTMLElement>("[data-domain-content]"));
  const feedback = workspace.querySelector<HTMLElement>("[data-feedback]");
  const form = workspace.querySelector<HTMLFormElement>("[data-domain-form]");
  const hostnameInput = workspace.querySelector<HTMLInputElement>("[data-hostname-input]");
  const hostnameError = workspace.querySelector<HTMLElement>("[data-hostname-error]");
  const connectButton = workspace.querySelector<HTMLButtonElement>("[data-connect-button]");
  const deleteDialog = workspace.querySelector<HTMLDialogElement>("[data-delete-dialog]");
  const deleteHostname = workspace.querySelector<HTMLElement>("[data-delete-hostname]");
  const deleteImpact = workspace.querySelector<HTMLElement>("[data-delete-impact]");
  const deleteConfirm = workspace.querySelector<HTMLButtonElement>("[data-delete-confirm]");
  const deleteCancel = workspace.querySelector<HTMLButtonElement>("[data-delete-cancel]");
  const initialDomainsSource = workspace.querySelector<HTMLScriptElement>("[data-domain-initial]")?.textContent ?? "[]";
  let domains: DomainRecord[] = parseDomainRecords(initialDomainsSource);
  let hasServerSnapshot = workspace.dataset.initialLoadStatus === "ready";
  let pendingDelete: DomainRecord | null = null;
  let deleteOpener: HTMLButtonElement | null = null;
  let loadSequence = 0;

  function getSelectedShop(): SelectedShop | null {
    const id = workspace.dataset.shopId ?? "";
    if (id.length === 0) return null;
    return {
      entitled: workspace.dataset.domainEntitled === "true",
      id,
      name: workspace.dataset.shopName ?? "",
      role: workspace.dataset.shopRole ?? "viewer",
      status: workspace.dataset.shopStatus ?? "draft",
    };
  }

  function parseDomainRecords(source: string): DomainRecord[] {
    try {
      const value = JSON.parse(source) as unknown;
      return Array.isArray(value) ? value.filter(isDomainRecord) : [];
    } catch {
      return [];
    }
  }

  function mutationsBlocked(shop: SelectedShop): boolean {
    return shop.status === "suspended" || shop.status === "archived";
  }

  function getCookie(name: string): string | null {
    for (const pair of document.cookie.split(";")) {
      const separator = pair.indexOf("=");
      if (separator < 1 || pair.slice(0, separator).trim() !== name) continue;
      const value = pair.slice(separator + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
    return null;
  }

  async function requestApi(url: string, options: RequestInit = {}): Promise<unknown> {
    const headers = new Headers(options.headers);
    const method = options.method?.toUpperCase() ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      const cookieName = workspace.dataset.csrfCookieName ?? "";
      const token = getCookie(cookieName);
      if (token === null) throw new DomainApiError("csrf_missing", [], null);
      headers.set("X-CSRF-Token", token);
    }
    const response = await fetch(url, { ...options, credentials: "same-origin", headers });
    const contentType = response.headers.get("Content-Type") ?? "";
    const body = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const code = typeof record.code === "string" ? record.code : "request_failed";
      const issues = Array.isArray(record.issues) ? record.issues.filter((issue): issue is string => typeof issue === "string") : [];
      const requestId = typeof record.requestId === "string" ? record.requestId : null;
      throw new DomainApiError(code, issues, requestId);
    }
    return body;
  }

  function isDomainRecord(value: unknown): value is DomainRecord {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record.id === "string"
      && typeof record.hostname === "string"
      && typeof record.status === "string"
      && (record.turnstileStatus === null || typeof record.turnstileStatus === "string")
      && (record.type === "custom" || record.type === "platform_subdomain")
      && typeof record.isPrimary === "boolean";
  }

  const errorMessages: Record<string, string> = {
    authorization_denied: t("dashboard.domains.error.authorization_denied"),
    cloudflare_config_invalid: t("dashboard.domains.error.cloudflare_config_invalid"),
    csrf_invalid: t("dashboard.domains.error.csrf_invalid"),
    csrf_missing: t("dashboard.domains.error.csrf_missing"),
    domain_already_claimed: t("dashboard.domains.error.domain_already_claimed"),
    domain_fallback_unavailable: t("dashboard.domains.error.domain_fallback_unavailable"),
    domain_in_use: t("dashboard.domains.error.domain_in_use"),
    domain_not_ready: t("dashboard.domains.error.domain_not_ready"),
    provider_unavailable: t("dashboard.domains.error.provider_unavailable"),
    recent_auth_required: t("dashboard.domains.error.recent_auth_required"),
    request_failed: t("dashboard.domains.error.request_failed"),
    subscription_required: t("dashboard.domains.error.subscription_required"),
    validation_failed: t("dashboard.domains.error.validation_failed"),
  };

  const issueMessages: Record<string, string> = {
    active_payment_attempt: t("dashboard.domains.issue.active_payment_attempt"),
    custom_domain_not_in_plan: t("dashboard.domains.issue.custom_domain_not_in_plan"),
    hostname_apex_unsupported: t("dashboard.domains.issue.hostname_apex_unsupported"),
    hostname_internal_not_allowed: t("dashboard.domains.issue.hostname_internal_not_allowed"),
    hostname_invalid: t("dashboard.domains.issue.hostname_invalid"),
    hostname_ip_not_allowed: t("dashboard.domains.issue.hostname_ip_not_allowed"),
    hostname_platform_not_allowed: t("dashboard.domains.issue.hostname_platform_not_allowed"),
    hostname_required: t("dashboard.domains.issue.hostname_required"),
  };

  function messageForError(error: unknown): string {
    if (!(error instanceof DomainApiError)) return t("dashboard.domains.error.network");
    const issueMessage = error.issues.map((issue) => issueMessages[issue]).find((message) => message !== undefined);
    const message = issueMessage ?? errorMessages[error.code] ?? t("dashboard.domains.error.generic");
    return error.requestId === null ? message : `${message}${t("dashboard.domains.error.support_code", { requestId: error.requestId })}`;
  }

  function setFeedback(message: string, tone: "error" | "success" | "info" = "info"): void {
    if (feedback === null) return;
    feedback.textContent = message;
    feedback.dataset.tone = tone;
    feedback.setAttribute("role", tone === "error" ? "alert" : "status");
    feedback.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
    feedback.hidden = message.length === 0;
  }

  function formatCheckedAt(value: string | null): string {
    if (value === null) return t("dashboard.domains.checked.never");
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return t("dashboard.domains.checked.recent");
    const options: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "short" };
    const timezone = workspace.dataset.shopTimezone ?? "";
    if (timezone.length > 0) options.timeZone = timezone;
    return t("dashboard.domains.checked.at", { time: new Intl.DateTimeFormat(workspace.dataset.locale ?? "en", options).format(new Date(timestamp)) });
  }

  function setLifecycle(card: HTMLElement, domain: DomainRecord): void {
    for (const step of deriveDomainLifecycle(domain, workspace.dataset.locale)) {
      const value = card.querySelector<HTMLElement>(`[data-lifecycle-value="${step.key}"]`);
      const icon = card.querySelector<HTMLElement>(`[data-lifecycle-icon="${step.key}"]`);
      const tone = domainStatusTone(step.status);
      if (value !== null) value.textContent = domainStatusLabel(step.status, workspace.dataset.locale);
      if (icon !== null) {
        icon.dataset.tone = tone;
        icon.textContent = tone === "success" ? "✓" : tone === "error" ? "!" : "·";
      }
    }
  }

  function setButtonBusy(button: HTMLButtonElement, busy: boolean, busyLabel: string): void {
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.textContent = busyLabel;
    } else if (button.dataset.originalLabel !== undefined) {
      button.textContent = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
    button.disabled = busy;
  }

  async function copyText(value: string, button: HTMLButtonElement): Promise<void> {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(value);
      button.textContent = t("dashboard.domains.feedback.copied_button");
      const message = t("dashboard.domains.feedback.copy_success");
      setFeedback(message, "success");
      window.setTimeout(() => {
        button.textContent = original;
        if (feedback?.textContent === message) setFeedback("");
      }, 2_500);
    } catch {
      setFeedback(t("dashboard.domains.feedback.copy_failed"), "error");
    }
  }

  function renderDomains(focusDomainId: string | null = null): void {
    if (domainList === null || domainTemplate === null) return;
    domainList.replaceChildren();
    const shop = getSelectedShop();
    const blocked = shop === null || mutationsBlocked(shop);
    if (domains.length === 0) {
      const empty = document.createElement("div");
      empty.className = "domain-empty compact";
      const strong = document.createElement("strong");
      strong.textContent = t("dashboard.domains.panel.list.empty.title");
      const copy = document.createElement("p");
      copy.textContent = t("dashboard.domains.panel.list.empty.description");
      empty.appendChild(strong);
      empty.appendChild(copy);
      domainList.appendChild(empty);
      return;
    }

    for (const domain of domains) {
      const fragment = domainTemplate.content.cloneNode(true);
      if (!(fragment instanceof DocumentFragment)) continue;
      const card = fragment.querySelector<HTMLElement>("[data-domain-card]");
      if (card === null) continue;
      card.dataset.domainId = domain.id;
      card.dataset.domainType = domain.type;
      card.setAttribute("aria-label", t("dashboard.domains.card.aria", { hostname: domain.hostname }));

      const kind = card.querySelector<HTMLElement>("[data-domain-kind]");
      const hostname = card.querySelector<HTMLElement>("[data-domain-hostname]");
      const status = card.querySelector<HTMLElement>("[data-domain-status]");
      const primaryNote = card.querySelector<HTMLElement>("[data-primary-note]");
      const readiness = card.querySelector<HTMLElement>("[data-custom-readiness]");
      const dnsRecord = card.querySelector<HTMLElement>("[data-dns-record]");
      const dnsName = card.querySelector<HTMLElement>("[data-dns-name]");
      const dnsTarget = card.querySelector<HTMLElement>("[data-dns-target]");
      const dnsTargetLabel = card.querySelector<HTMLElement>("[data-dns-target-label]");
      const dnsType = card.querySelector<HTMLElement>("[data-dns-type]");
      const dnsNote = card.querySelector<HTMLElement>("[data-dns-note]");
      const lastChecked = card.querySelector<HTMLElement>("[data-last-checked]");
      const safeError = card.querySelector<HTMLElement>("[data-safe-error]");
      const turnstileNote = card.querySelector<HTMLElement>("[data-turnstile-note]");
      const checkButton = card.querySelector<HTMLButtonElement>("[data-action=" + '"check"' + "]");
      const primaryButton = card.querySelector<HTMLButtonElement>("[data-action=" + '"primary"' + "]");
      const deleteButton = card.querySelector<HTMLButtonElement>("[data-action=" + '"delete"' + "]");
      const copyName = card.querySelector<HTMLButtonElement>("[data-copy-name]");
      const copyTarget = card.querySelector<HTMLButtonElement>("[data-copy-target]");

      if (kind !== null) kind.textContent = domain.type === "custom" ? t("dashboard.domains.kind.custom") : t("dashboard.domains.kind.platform");
      if (hostname !== null) hostname.textContent = domain.hostname;
      if (status !== null) {
        status.textContent = domainStatusLabel(domain.status, workspace.dataset.locale);
        status.dataset.tone = domainStatusTone(domain.status);
      }
      if (primaryNote !== null) primaryNote.hidden = !domain.isPrimary;
      if (readiness !== null) readiness.hidden = domain.type !== "custom";
      if (lastChecked !== null) lastChecked.textContent = formatCheckedAt(domain.lastCheckedAt);
      if (turnstileNote !== null) {
        turnstileNote.hidden = !(
          domain.type === "custom"
          && domain.turnstileStatus !== "active"
          && domain.ownershipStatus === "verified"
          && domain.hostnameStatus === "active"
          && domain.sslStatus === "active"
          && domain.dnsStatus === "active"
        );
      }
      if (safeError !== null) {
        const expired = domain.status === "ownership_expired";
        safeError.hidden = domain.lastSafeErrorCode === null && !expired;
        safeError.textContent = expired
          ? t("dashboard.domains.card.ownership_expired")
          : domain.lastSafeErrorCode === null
            ? ""
            : t("dashboard.domains.card.safe_error", { status: domainStatusLabel(domain.lastSafeErrorCode, workspace.dataset.locale) });
      }

      if (domain.type === "custom") {
        setLifecycle(card, domain);
      }

      if (dnsRecord !== null && domain.dnsInstructions !== null) {
        dnsRecord.hidden = false;
        if (dnsType !== null) dnsType.textContent = domain.dnsInstructions.type;
        if (dnsName !== null) dnsName.textContent = domain.dnsInstructions.name;
        if (dnsTarget !== null) dnsTarget.textContent = domain.dnsInstructions.target;
        if (dnsTargetLabel !== null) dnsTargetLabel.textContent = domain.dnsInstructions.type === "TXT" ? t("dashboard.domains.card.dns.value") : t("dashboard.domains.card.dns.target");
        if (dnsNote !== null) {
          dnsNote.textContent = domain.dnsInstructions.type === "TXT"
            ? t("dashboard.domains.card.dns.txt_note")
            : t("dashboard.domains.card.dns.cname_note");
        }
        copyName?.addEventListener("click", () => { void copyText(domain.dnsInstructions?.name ?? "", copyName); });
        copyTarget?.addEventListener("click", () => { void copyText(domain.dnsInstructions?.target ?? "", copyTarget); });
      }

      if (checkButton !== null) {
        checkButton.hidden = domain.type !== "custom" || domain.status === "ownership_expired";
        checkButton.disabled = blocked;
        checkButton.setAttribute("aria-label", t("dashboard.domains.card.check.aria", { hostname: domain.hostname }));
        if (!blocked) checkButton.addEventListener("click", () => { void performDomainAction(domain, "check", checkButton); });
      }
      if (primaryButton !== null) {
        const ready = isDomainReady(domain);
        const entitledForPrimary = domain.type !== "custom" || shop?.entitled === true;
        primaryButton.hidden = domain.isPrimary;
        primaryButton.disabled = !ready || !entitledForPrimary || blocked;
        primaryButton.setAttribute("aria-label", t("dashboard.domains.card.primary.aria", { hostname: domain.hostname }));
        primaryButton.title = blocked
          ? t("dashboard.domains.card.primary.title_blocked")
          : !ready
          ? t("dashboard.domains.card.primary.title_not_ready")
          : entitledForPrimary
            ? ""
            : t("dashboard.domains.card.primary.title_not_entitled");
        if (!primaryButton.disabled) primaryButton.addEventListener("click", () => { void performDomainAction(domain, "primary", primaryButton); });
      }
      if (deleteButton !== null) {
        deleteButton.hidden = domain.type !== "custom";
        deleteButton.disabled = blocked;
        deleteButton.setAttribute("aria-label", t("dashboard.domains.card.delete.aria", { hostname: domain.hostname }));
        if (!blocked) deleteButton.addEventListener("click", () => { openDeleteDialog(domain, deleteButton); });
      }

      domainList.appendChild(fragment);
    }

    if (focusDomainId !== null) {
      const card = Array.from(domainList.querySelectorAll<HTMLElement>("[data-domain-card]"))
        .find((item) => item.dataset.domainId === focusDomainId);
      card?.focus();
    }
  }

  async function loadDomains(focusDomainId: string | null = null): Promise<void> {
    const shop = getSelectedShop();
    if (shop === null || shop.id.length === 0) return;
    const sequence = ++loadSequence;
    if (panel !== null) {
      panel.setAttribute("aria-busy", "true");
    }
    if (panelState !== null) panelState.textContent = hasServerSnapshot ? t("dashboard.domains.panel.syncing") : t("dashboard.domains.panel.loading");
    if (feedback !== null) feedback.hidden = true;
    if (permissionNote !== null) permissionNote.hidden = shop.role === "owner";
    if (entitlementNote !== null) entitlementNote.hidden = shop.role !== "owner" || shop.entitled;
    if (suspendedNote !== null) suspendedNote.hidden = !mutationsBlocked(shop);
    for (const item of domainContent) item.hidden = shop.role !== "owner";
    if (shop.role !== "owner") {
      domains = [];
      if (domainList !== null) domainList.replaceChildren();
      if (loadingElement !== null) loadingElement.hidden = true;
      if (listError !== null) listError.hidden = true;
      if (panelState !== null) panelState.textContent = t("dashboard.domains.panel.permission_state");
      panel?.setAttribute("aria-busy", "false");
      return;
    }

    if (loadingElement !== null) loadingElement.hidden = hasServerSnapshot;
    if (listError !== null) listError.hidden = true;
    if (!hasServerSnapshot && domainList !== null) domainList.replaceChildren();
    const blocked = mutationsBlocked(shop);
    if (connectButton !== null) connectButton.disabled = !shop.entitled || blocked;
    if (hostnameInput !== null) hostnameInput.disabled = !shop.entitled || blocked;

    try {
      const body = await requestApi(`/api/app/shops/${encodeURIComponent(shop.id)}/domains`);
      if (sequence !== loadSequence) return;
      const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      domains = Array.isArray(record.domains) ? record.domains.filter(isDomainRecord) : [];
      hasServerSnapshot = true;
      renderDomains(focusDomainId);
      scheduleAutoCheck();
      if (panelState !== null) panelState.textContent = t("dashboard.domains.panel.count", { count: domains.length });
    } catch (error) {
      if (sequence !== loadSequence) return;
      if (listError !== null) listError.hidden = false;
      if (listErrorMessage !== null) listErrorMessage.textContent = messageForError(error);
      if (panelState !== null) panelState.textContent = hasServerSnapshot ? t("dashboard.domains.panel.snapshot") : t("dashboard.domains.panel.unavailable_state");
    } finally {
      if (sequence === loadSequence) {
        if (loadingElement !== null) loadingElement.hidden = true;
        panel?.setAttribute("aria-busy", "false");
      }
    }
  }

  async function performDomainAction(domain: DomainRecord, action: "check" | "primary", button: HTMLButtonElement): Promise<void> {
    const shop = getSelectedShop();
    if (shop === null || mutationsBlocked(shop)) return;
    const endpoint = action === "check" ? "checks" : "primary";
    const method = action === "check" ? "POST" : "PUT";
    setButtonBusy(button, true, action === "check" ? t("dashboard.domains.feedback.check_button") : t("dashboard.domains.feedback.move_button"));
    setFeedback(action === "check" ? t("dashboard.domains.feedback.checking", { hostname: domain.hostname }) : t("dashboard.domains.feedback.primary_changing", { hostname: domain.hostname }));
    try {
      await requestApi(`/api/app/shops/${encodeURIComponent(shop.id)}/domains/${encodeURIComponent(domain.id)}/${endpoint}`, {
        body: "{}",
        headers: { "Content-Type": "application/json" },
        method,
      });
      await loadDomains(domain.id);
      setFeedback(
        action === "check" ? t("dashboard.domains.feedback.checked", { hostname: domain.hostname }) : t("dashboard.domains.feedback.primary", { hostname: domain.hostname }),
        "success",
      );
    } catch (error) {
      setButtonBusy(button, false, "");
      setFeedback(messageForError(error), "error");
    }
  }

  // --- Automatic DNS re-check ---
  // While the page stays open, keep re-checking custom domains whose DNS is
  // not verified yet: a seller who adds the record at Cloudflare and returns
  // to this tab sees the domain confirm itself without pressing Check again.
  const AUTO_CHECK_INTERVAL_MS = 15_000;
  const AUTO_CHECK_MAX_ROUNDS = 8;
  const VISIBLE_RECHECK_MIN_GAP_MS = 30_000;
  let autoCheckTimer: number | null = null;
  let autoCheckRounds = 0;
  let lastAutoCheckAt = 0;

  function stopAutoCheck(): void {
    if (autoCheckTimer !== null) {
      window.clearInterval(autoCheckTimer);
      autoCheckTimer = null;
    }
    autoCheckRounds = 0;
  }

  function pendingCheckDomains(): DomainRecord[] {
    const shop = getSelectedShop();
    if (shop === null || mutationsBlocked(shop)) return [];
    return domains.filter((domain) => domain.type === "custom"
      && domain.status !== "ownership_expired"
      && !isDomainReady(domain));
  }

  async function autoCheckPending(force: boolean): Promise<void> {
    const now = Date.now();
    const minGap = force ? VISIBLE_RECHECK_MIN_GAP_MS : AUTO_CHECK_INTERVAL_MS;
    if (now - lastAutoCheckAt < minGap) return;
    const pending = pendingCheckDomains();
    if (pending.length === 0) {
      stopAutoCheck();
      return;
    }
    lastAutoCheckAt = now;
    const shop = getSelectedShop();
    if (shop === null) return;
    await Promise.allSettled(pending.map((domain) =>
      requestApi(`/api/app/shops/${encodeURIComponent(shop.id)}/domains/${encodeURIComponent(domain.id)}/checks`, {
        body: "{}",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })));
    await loadDomains();
  }

  function scheduleAutoCheck(): void {
    if (pendingCheckDomains().length === 0) {
      stopAutoCheck();
      return;
    }
    if (autoCheckTimer !== null) return;
    autoCheckTimer = window.setInterval(() => {
      autoCheckRounds += 1;
      if (autoCheckRounds > AUTO_CHECK_MAX_ROUNDS) {
        stopAutoCheck();
        return;
      }
      void autoCheckPending(false);
    }, AUTO_CHECK_INTERVAL_MS);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void autoCheckPending(true);
  });

  function openDeleteDialog(domain: DomainRecord, opener: HTMLButtonElement): void {
    if (deleteDialog === null) return;
    pendingDelete = domain;
    deleteOpener = opener;
    if (deleteHostname !== null) deleteHostname.textContent = domain.hostname;
    if (deleteImpact !== null) {
      deleteImpact.textContent = domain.ownershipStatus === "pending"
        ? t("dashboard.domains.dialog.impact.pending")
        : domain.isPrimary
          ? t("dashboard.domains.dialog.impact.primary")
          : t("dashboard.domains.dialog.impact.other");
    }
    deleteDialog.showModal();
    deleteCancel?.focus();
  }

  async function confirmDelete(): Promise<void> {
    const shop = getSelectedShop();
    const domain = pendingDelete;
    if (shop === null || mutationsBlocked(shop) || domain === null || deleteConfirm === null) return;
    setButtonBusy(deleteConfirm, true, t("dashboard.domains.feedback.deleting"));
    if (deleteCancel !== null) deleteCancel.disabled = true;
    try {
      await requestApi(`/api/app/shops/${encodeURIComponent(shop.id)}/domains/${encodeURIComponent(domain.id)}`, {
        body: "{}",
        headers: { "Content-Type": "application/json" },
        method: "DELETE",
      });
      deleteDialog?.close();
      pendingDelete = null;
      await loadDomains();
      setFeedback(
        domain.ownershipStatus === "pending"
          ? t("dashboard.domains.feedback.deleted_pending", { hostname: domain.hostname })
          : t("dashboard.domains.feedback.deleted", { hostname: domain.hostname }),
        "success",
      );
    } catch (error) {
      setButtonBusy(deleteConfirm, false, "");
      if (deleteCancel !== null) deleteCancel.disabled = false;
      setFeedback(messageForError(error), "error");
      deleteDialog?.close();
    }
  }

  function showHostnameValidation(): ReturnType<typeof validateHostnameDraft> {
    const result = validateHostnameDraft(hostnameInput?.value ?? "");
    if (hostnameError !== null) {
      hostnameError.textContent = result.code === null ? "" : issueMessages[result.code] ?? t("dashboard.domains.issue.unknown");
    }
    if (hostnameInput !== null) hostnameInput.setAttribute("aria-invalid", result.code === null ? "false" : "true");
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const shop = getSelectedShop();
    const result = showHostnameValidation();
    if (
      shop === null
      || mutationsBlocked(shop)
      || result.code !== null
      || connectButton === null
      || hostnameInput === null
    ) {
      hostnameInput?.focus();
      return;
    }
    hostnameInput.value = result.hostname;
    setButtonBusy(connectButton, true, t("dashboard.domains.feedback.connect_button"));
    setFeedback(t("dashboard.domains.feedback.connecting", { hostname: result.hostname }));
    try {
      await requestApi(`/api/app/shops/${encodeURIComponent(shop.id)}/domains`, {
        body: JSON.stringify({ hostname: result.hostname }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      form.reset();
      if (hostnameError !== null) hostnameError.textContent = "";
      await loadDomains();
      const created = domains.find((domain) => domain.hostname === result.hostname);
      renderDomains(created?.id ?? null);
      setFeedback(t("dashboard.domains.feedback.connected", { hostname: result.hostname }), "success");
    } catch (error) {
      setFeedback(messageForError(error), "error");
    } finally {
      setButtonBusy(connectButton, false, "");
      connectButton.disabled = !shop.entitled || mutationsBlocked(shop);
    }
  });

  hostnameInput?.addEventListener("input", () => {
    if (hostnameInput.value.trim().length === 0) {
      hostnameInput.setAttribute("aria-invalid", "false");
      if (hostnameError !== null) hostnameError.textContent = "";
      return;
    }
    showHostnameValidation();
  });

  workspace.querySelector<HTMLButtonElement>("[data-refresh-list]")?.addEventListener("click", () => { void loadDomains(); });
  workspace.querySelector<HTMLButtonElement>("[data-list-retry]")?.addEventListener("click", () => { void loadDomains(); });
  deleteCancel?.addEventListener("click", () => {
    if (deleteConfirm?.disabled === true) return;
    pendingDelete = null;
    deleteDialog?.close();
  });
  deleteConfirm?.addEventListener("click", () => { void confirmDelete(); });
  deleteDialog?.addEventListener("cancel", (event) => {
    if (deleteConfirm?.disabled === true) event.preventDefault();
  });
  deleteDialog?.addEventListener("close", () => {
    pendingDelete = null;
    if (deleteConfirm !== null) setButtonBusy(deleteConfirm, false, "");
    if (deleteCancel !== null) deleteCancel.disabled = false;
    if (deleteOpener?.isConnected === true) deleteOpener.focus();
    else workspace.querySelector<HTMLButtonElement>("[data-refresh-list]")?.focus();
    deleteOpener = null;
  });

  const selectedShop = getSelectedShop();
  if (selectedShop?.role === "owner") {
    if (hasServerSnapshot) renderDomains();
    void loadDomains();
  }
}
