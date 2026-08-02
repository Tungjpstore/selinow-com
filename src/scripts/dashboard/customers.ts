export {};

type JsonObject = Record<string, unknown>;
type CustomerPointer = { publicId: string; version: number };

class CustomerApiError extends Error {
  constructor(readonly code: string) {
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
      throw new CustomerApiError(code);
    }
    return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as JsonObject : null;
  };
  const customerFrom = (payload: JsonObject | null): JsonObject | null => typeof payload?.customer === "object" && payload.customer !== null && !Array.isArray(payload.customer) ? payload.customer as JsonObject : null;
  const errorMessage = (error: unknown): string => {
    const code = error instanceof CustomerApiError ? error.code : error instanceof Error ? error.message : "";
    if (code === "recent_auth_required") return text("errorRecentAuth") || text("error");
    if (code === "version_conflict" || code === "idempotency_conflict") return text("errorConflict") || text("error");
    if (code === "forbidden" || code === "authorization_denied") return text("errorForbidden") || text("error");
    if (code === "customer_not_found") return text("errorNotFound") || text("unavailable");
    return text("error");
  };
  const clearDetail = (): void => {
    form?.reset();
    noteForm?.reset();
    if (email !== null) email.textContent = "";
    notes?.replaceChildren();
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
    const redact = target.closest<HTMLButtonElement>("[data-note-redact]");
    if (redact === null || current === null || pending || loading) return;
    const note = redact.closest<HTMLElement>("[data-note-public-id]");
    const notePublicId = note?.dataset.notePublicId; const version = Number(note?.dataset.noteVersion);
    if (notePublicId === undefined || !Number.isSafeInteger(version) || !window.confirm(text("redactConfirm"))) return;
    const customerPublicId = current.publicId;
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
}
