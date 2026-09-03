export {};

type JsonObject = Record<string, unknown>;
type CustomerPointer = { publicId: string; version: number };

class CustomerApiError extends Error {
  constructor(readonly code: string, readonly requestId: string | null = null) {
    super(code);
    this.name = "CustomerApiError";
  }
}

const root = document.querySelector<HTMLElement>("[data-customers-root]");

if (root !== null && root.dataset.canManage === "true") {
  const shopPublicId = root.dataset.shopPublicId;
  const csrfCookieName = root.dataset.csrfCookieName ?? "";
  const detail = root.querySelector<HTMLElement>("[data-customer-detail]");
  const email = root.querySelector<HTMLElement>("[data-customer-email]");
  const feedback = root.querySelector<HTMLElement>("[data-customer-feedback]");
  const form = root.querySelector<HTMLFormElement>("[data-customer-form]");
  const noteForm = root.querySelector<HTMLFormElement>("[data-customer-note-form]");
  const notes = root.querySelector<HTMLElement>("[data-customer-notes]");
  const redactDialog = root.querySelector<HTMLDialogElement>("[data-note-redact-dialog]");
  const redactForm = root.querySelector<HTMLFormElement>("[data-note-redact-form]");
  let redactTarget: { notePublicId: string; version: number } | null = null;
  const privacyStatus = root.querySelector<HTMLElement>("[data-customer-privacy-status]");
  const anonymizeForm = root.querySelector<HTMLFormElement>("[data-customer-anonymize-form]");
  const copy = (() => {
    try { const parsed: unknown = JSON.parse(root.dataset.copy ?? "{}"); return typeof parsed === "object" && parsed !== null ? parsed as Record<string, string> : {}; }
    catch { return {}; }
  })();
  const text = (key: string): string => copy[key] ?? "";
  let current: CustomerPointer | null = null;
  let pending = false;
  let loading = false;
  let loadSequence = 0;

  const readCookie = (name: string): string | null => {
    const encoded = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
    if (encoded === undefined) return null;
    try { return decodeURIComponent(encoded); } catch { return null; }
  };
  const key = (prefix: string): string => {
    try { return `${prefix}_${crypto.randomUUID()}`; }
    catch { return `${prefix}_${String(Date.now())}_${Math.random().toString(36).slice(2)}`; }
  };
  const showFeedback = (message: string, tone: "danger" | "info" | "success" = "info"): void => {
    if (feedback === null) return;
    feedback.textContent = message;
    feedback.dataset.tone = tone;
    feedback.hidden = message.length === 0;
  };
  const showPrivacyStatus = (message: string, tone: "danger" | "info" | "success" = "info"): void => {
    if (privacyStatus === null) return;
    privacyStatus.textContent = message;
    privacyStatus.dataset.tone = tone;
    privacyStatus.hidden = message.length === 0;
  };
  const request = async (url: string, options: RequestInit = {}, idempotent = false): Promise<JsonObject | null> => {
    const headers = new Headers(options.headers);
    headers.set("Accept", "application/json");
    const method = options.method?.toUpperCase() ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      const csrf = readCookie(csrfCookieName);
      if (csrf === null) throw new Error(text("error"));
      headers.set("X-CSRF-Token", csrf);
      headers.set("Content-Type", "application/json");
      if (idempotent) headers.set("Idempotency-Key", key("customer_ui"));
    }
    const response = await fetch(url, { ...options, credentials: "same-origin", headers });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof payload === "object" && payload !== null && typeof (payload as { code?: unknown }).code === "string" ? (payload as { code: string }).code : "request_failed";
      const requestId = typeof payload === "object" && payload !== null && typeof (payload as { requestId?: unknown }).requestId === "string" ? (payload as { requestId: string }).requestId : null;
      throw new CustomerApiError(code, requestId);
    }
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as JsonObject : null;
  };
  const customerFrom = (payload: JsonObject | null): JsonObject | null => typeof payload?.customer === "object" && payload.customer !== null && !Array.isArray(payload.customer) ? payload.customer as JsonObject : null;
  const privacyFrom = (payload: JsonObject | null): JsonObject | null => typeof payload?.privacy === "object" && payload.privacy !== null && !Array.isArray(payload.privacy) ? payload.privacy as JsonObject : null;
  const requestIdFrom = (payload: JsonObject | null): string | null => typeof payload?.requestId === "string" ? payload.requestId : null;
  const requestReference = (requestId: string | null): string => requestId === null ? "" : ` ${text("requestId").replace("{requestId}", requestId)}`;
  const errorMessage = (error: unknown): string => {
    const code = error instanceof CustomerApiError ? error.code : error instanceof Error ? error.message : "";
    let message = text("error");
    if (code === "recent_auth_required") message = text("errorRecentAuth") || message;
    else if (code === "version_conflict" || code === "idempotency_conflict" || code === "privacy_request_conflict") message = text("errorConflict") || message;
    else if (code === "forbidden" || code === "authorization_denied") message = text("errorForbidden") || message;
    else if (code === "customer_not_found") message = text("errorNotFound") || text("unavailable");
    else if (code === "customer_anonymized") message = text("errorAnonymized") || message;
    return `${message}${requestReference(error instanceof CustomerApiError ? error.requestId : null)}`;
  };
  const setMutationControlsDisabled = (disabled: boolean): void => {
    for (const control of [...(form?.elements ?? []), ...(noteForm?.elements ?? []), ...(anonymizeForm?.elements ?? [])]) {
      if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement) control.disabled = disabled;
    }
  };
  const clearDetail = (): void => {
    form?.reset();
    noteForm?.reset();
    anonymizeForm?.reset();
    if (email !== null) email.textContent = "";
    notes?.replaceChildren();
    showPrivacyStatus("");
    setMutationControlsDisabled(false);
  };
  const syncLedgerRow = (customer: JsonObject): void => {
    const publicId = typeof customer.publicId === "string" ? customer.publicId : null;
    const version = typeof customer.version === "number" && Number.isSafeInteger(customer.version) ? customer.version : null;
    if (publicId === null || version === null) return;
    const row = [...root.querySelectorAll<HTMLElement>("[data-customer-row]")].find((candidate) => candidate.dataset.customerPublicId === publicId);
    if (row === undefined) return;
    row.dataset.customerVersion = String(version);
    const displayName = typeof customer.displayName === "string" && customer.displayName.length > 0 ? customer.displayName : text("unnamed");
    const name = row.querySelector<HTMLElement>("[data-customer-name]");
    if (name !== null) name.textContent = displayName;
    const status = customer.status === "blocked" ? "blocked" : "active";
    const statusChip = row.querySelector<HTMLElement>("[data-customer-status]");
    if (statusChip !== null) {
      statusChip.classList.remove("status-active", "status-blocked");
      statusChip.classList.add(`status-${status}`);
      statusChip.textContent = status === "blocked" ? text("statusBlocked") : text("statusActive");
    }
    row.dataset.search = `${typeof customer.emailMasked === "string" ? customer.emailMasked : text("noEmail")} ${displayName}`.toLocaleLowerCase(root.dataset.locale ?? "en");
  };
  const render = (customer: JsonObject): void => {
    const publicId = typeof customer.publicId === "string" ? customer.publicId : null;
    const version = typeof customer.version === "number" && Number.isSafeInteger(customer.version) ? customer.version : null;
    if (publicId === null || version === null || form === null) return;
    current = { publicId, version };
    if (detail !== null) detail.hidden = false;
    if (email !== null) email.textContent = typeof customer.emailMasked === "string" ? customer.emailMasked : text("noEmail");
    const name = form.elements.namedItem("displayName");
    const locale = form.elements.namedItem("locale");
    const status = form.elements.namedItem("status");
    if (name instanceof HTMLInputElement) name.value = typeof customer.displayName === "string" ? customer.displayName : "";
    if (locale instanceof HTMLSelectElement) locale.value = typeof customer.locale === "string" ? customer.locale : "en";
    if (status instanceof HTMLSelectElement) status.value = customer.status === "blocked" ? "blocked" : "active";
    const anonymized = typeof customer.anonymizedAt === "string";
    setMutationControlsDisabled(anonymized);
    if (anonymized) showPrivacyStatus(text("privacyAnonymized"), "success");
    if (notes === null) return;
    notes.replaceChildren();
    const values = Array.isArray(customer.notes) ? customer.notes : [];
    if (values.length === 0) { const empty = document.createElement("p"); empty.textContent = text("emptyNotes"); notes.appendChild(empty); return; }
    for (const value of values) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const note = value as JsonObject;
      const article = document.createElement("article"); article.className = "customer-note";
      article.dataset.notePublicId = typeof note.notePublicId === "string" ? note.notePublicId : "";
      article.dataset.noteVersion = typeof note.version === "number" ? String(note.version) : "";
      const head = document.createElement("header");
      const author = document.createElement("strong"); author.textContent = typeof note.authorDisplayName === "string" ? note.authorDisplayName : "";
      head.appendChild(author);
      if (note.status === "active") { const redact = document.createElement("button"); redact.type = "button"; redact.className = "text-action danger-text"; redact.dataset.noteRedact = "true"; redact.textContent = text("redact"); head.appendChild(redact); }
      article.appendChild(head);
      const body = document.createElement("p"); body.textContent = note.status === "redacted" ? "" : typeof note.body === "string" ? note.body : ""; article.appendChild(body);
      if (note.status === "redacted") body.textContent = text("redacted");
      notes.appendChild(article);
    }
  };
  const downloadPrivacyExport = (privacy: JsonObject, customerPublicId: string): void => {
    const projection = privacy.projection;
    const privacyRequestPublicId = privacy.privacyRequestPublicId;
    if (typeof projection !== "object" || projection === null || Array.isArray(projection) || typeof privacyRequestPublicId !== "string") {
      throw new CustomerApiError("invalid_response");
    }
    const blob = new Blob([JSON.stringify({ privacyRequestPublicId, projection, schemaVersion: 1 }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `selinow-customer-${customerPublicId}-export.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const load = async (publicId: string): Promise<void> => {
    if (shopPublicId === undefined || loading) return;
    const sequence = ++loadSequence;
    loading = true;
    current = null;
    clearDetail();
    if (detail !== null) detail.hidden = false;
    showFeedback(text("loading"), "info");
    try {
      const customer = customerFrom(await request(`/api/app/shops/${encodeURIComponent(shopPublicId)}/customers/${encodeURIComponent(publicId)}`));
      if (sequence !== loadSequence) return;
      if (customer === null) { showFeedback(text("unavailable"), "danger"); return; }
      render(customer); syncLedgerRow(customer); showFeedback(text("loaded"), "success");
      detail?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      if (sequence === loadSequence) showFeedback(errorMessage(error), "danger");
    } finally {
      if (sequence === loadSequence) loading = false;
    }
  };
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const open = target.closest<HTMLElement>("[data-customer-open]");
    if (open !== null) { const row = open.closest<HTMLElement>("[data-customer-row]"); const id = row?.dataset.customerPublicId; if (id !== undefined) void load(id); return; }
    if (target.closest("[data-customer-close]") !== null) { loadSequence += 1; if (detail !== null) detail.hidden = true; current = null; clearDetail(); return; }
    if (target.closest("[data-customer-export]") !== null) {
      if (current === null || pending || loading || shopPublicId === undefined) return;
      const customerPublicId = current.publicId;
      pending = true; showPrivacyStatus(text("privacyExporting"), "info");
      void request(`/api/app/shops/${encodeURIComponent(shopPublicId)}/customers/${encodeURIComponent(customerPublicId)}/privacy`, { method: "POST", body: JSON.stringify({ kind: "export" }) }, true).then((payload) => {
        const privacy = privacyFrom(payload);
        if (privacy === null || privacy.safeResultCode !== "export_ready") throw new CustomerApiError("invalid_response", requestIdFrom(payload));
        downloadPrivacyExport(privacy, customerPublicId);
        showPrivacyStatus(`${text("privacyExported")}${requestReference(requestIdFrom(payload))}`, "success");
      }).catch((error: unknown) => { showPrivacyStatus(errorMessage(error), "danger"); }).finally(() => { pending = false; });
      return;
    }
    const redact = target.closest<HTMLButtonElement>("[data-note-redact]");
    if (redact === null || current === null || pending || loading) return;
    const note = redact.closest<HTMLElement>("[data-note-public-id]");
    const notePublicId = note?.dataset.notePublicId; const version = Number(note?.dataset.noteVersion);
    if (notePublicId === undefined || !Number.isSafeInteger(version) || redactDialog === null) return;
    redactTarget = { notePublicId, version };
    redactDialog.showModal();
  });
  redactForm?.addEventListener("submit", (event) => {
    const submitter = event.submitter;
    if (!(submitter instanceof HTMLButtonElement) || submitter.value !== "confirm") return;
    event.preventDefault();
    if (redactTarget === null || current === null || pending || loading) return;
    const { notePublicId, version } = redactTarget;
    const customerPublicId = current.publicId;
    redactTarget = null;
    redactDialog?.close();
    pending = true; showFeedback(text("redacting"), "info");
    void request(`/api/app/shops/${encodeURIComponent(shopPublicId ?? "")}/customers/${encodeURIComponent(customerPublicId)}/notes/${encodeURIComponent(notePublicId)}`, { method: "DELETE", body: JSON.stringify({ expectedVersion: version }) }, true).then(() => { void load(customerPublicId); }).catch((error: unknown) => { showFeedback(errorMessage(error), "danger"); }).finally(() => { pending = false; });
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault(); if (current === null || pending || loading || shopPublicId === undefined || !form.reportValidity()) return;
    const values = new FormData(form); pending = true; showFeedback(text("saving"), "info");
    const customer = current;
    void request(`/api/app/shops/${encodeURIComponent(shopPublicId)}/customers/${encodeURIComponent(customer.publicId)}`, { method: "PATCH", body: JSON.stringify({ displayName: values.get("displayName"), expectedVersion: customer.version, locale: values.get("locale"), status: values.get("status") }) }, true).then((payload) => { const updated = customerFrom(payload); if (updated === null) throw new CustomerApiError("invalid_response"); render(updated); syncLedgerRow(updated); showFeedback(text("saved"), "success"); }).catch((error: unknown) => { showFeedback(errorMessage(error), "danger"); }).finally(() => { pending = false; });
  });
  noteForm?.addEventListener("submit", (event) => {
    event.preventDefault(); if (current === null || pending || loading || shopPublicId === undefined || !noteForm.reportValidity()) return;
    const values = new FormData(noteForm); const body = values.get("body");
    if (typeof body !== "string") { showFeedback(text("error"), "danger"); return; }
    const customerPublicId = current.publicId;
    pending = true; showFeedback(text("addingNote"), "info");
    void request(`/api/app/shops/${encodeURIComponent(shopPublicId)}/customers/${encodeURIComponent(customerPublicId)}/notes`, { method: "POST", body: JSON.stringify({ body }) }, true).then(() => { noteForm.reset(); showFeedback(text("noteAdded"), "success"); void load(customerPublicId); }).catch((error: unknown) => { showFeedback(errorMessage(error), "danger"); }).finally(() => { pending = false; });
  });
  anonymizeForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (current === null || pending || loading || shopPublicId === undefined || !anonymizeForm.reportValidity()) return;
    const confirmation = new FormData(anonymizeForm).get("confirmation");
    if (confirmation !== "ANONYMIZE") return;
    const customerPublicId = current.publicId;
    pending = true; showPrivacyStatus(text("privacyAnonymizing"), "info");
    void request(`/api/app/shops/${encodeURIComponent(shopPublicId)}/customers/${encodeURIComponent(customerPublicId)}/privacy`, { method: "POST", body: JSON.stringify({ confirmation, kind: "anonymize" }) }, true).then(async (payload) => {
      const privacy = privacyFrom(payload);
      if (privacy === null) throw new CustomerApiError("invalid_response", requestIdFrom(payload));
      if (privacy.safeResultCode === "active_records_blocked") {
        showPrivacyStatus(`${text("errorPrivacyBlocked")}${requestReference(requestIdFrom(payload))}`, "danger");
        return;
      }
      if (privacy.safeResultCode !== "anonymized_financial_audit_retained") throw new CustomerApiError("invalid_response", requestIdFrom(payload));
      await load(customerPublicId);
      showPrivacyStatus(`${text("privacyAnonymized")}${requestReference(requestIdFrom(payload))}`, "success");
    }).catch((error: unknown) => { showPrivacyStatus(errorMessage(error), "danger"); }).finally(() => { pending = false; });
  });
}
