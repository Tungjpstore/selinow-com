export {};

import { createDashboardTranslator } from "../../lib/i18n/catalogs/dashboard";

type JsonObject = Record<string, unknown>;
type DisableableControl = Element & { disabled: boolean };
type ValueControl = Element & { value: string };
type ImportCounts = {
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  totalCount: number;
};

const t = createDashboardTranslator(document.documentElement.lang || "en");

class InventoryApiError extends Error {
  readonly requestId: string | null;

  constructor(code: string, requestId: string | null) {
    super(code);
    this.name = "InventoryApiError";
    this.requestId = requestId;
  }
}

const dialog = document.querySelector<HTMLDialogElement>("[data-import-dialog]");
const form = document.querySelector<HTMLFormElement>("[data-import-form]");
const openButton = document.querySelector<HTMLButtonElement>("[data-open-import]");
const closeButton = document.querySelector<HTMLButtonElement>("[data-close-import]");
const previewButton = document.querySelector<HTMLButtonElement>("[data-preview-import]");
const confirmButton = document.querySelector<HTMLButtonElement>("[data-confirm-import]");
const feedback = document.querySelector<HTMLElement>("[data-import-feedback]");
const variantSelectElement = document.querySelector("[data-import-variant-select]");
const variantSelect = variantSelectElement !== null
  && "value" in variantSelectElement
  && typeof variantSelectElement.value === "string"
  ? variantSelectElement as ValueControl
  : null;
const shopPublicId = dialog?.dataset.shopPublicId;
const csrfCookieName = dialog?.dataset.csrfCookieName;

const inventoryRows = [...document.querySelectorAll<HTMLElement>("[data-inventory-health]")];
const inventoryNoResults = document.querySelector<HTMLElement>("[data-inventory-no-results]");
document.querySelectorAll<HTMLButtonElement>("[data-inventory-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.inventoryFilter ?? "all";
    let visibleCount = 0;
    document.querySelectorAll<HTMLButtonElement>("[data-inventory-filter]").forEach((candidate) => {
      candidate.setAttribute("aria-pressed", candidate === button ? "true" : "false");
    });
    for (const row of inventoryRows) {
      const visible = filter === "all" || row.dataset.inventoryHealth === filter;
      row.hidden = !visible;
      if (visible) visibleCount += 1;
    }
    if (inventoryNoResults !== null) inventoryNoResults.hidden = visibleCount > 0;
  });
});

if (dialog !== null && form !== null && shopPublicId !== undefined && csrfCookieName !== undefined) {
  let previewToken: string | null = null;
  let idempotencyKey: string | null = null;
  let pendingAction: "import" | "preview" | null = null;
  const lockState = new Map<DisableableControl, boolean>();
  const controls = [...form.elements].filter((control): control is DisableableControl => (
    "disabled" in control && typeof control.disabled === "boolean"
  ));
  const readCookie = (name: string): string | null => document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const setFeedback = (value: string): void => { if (feedback !== null) feedback.textContent = value; };
  const safeRequestId = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9._-]{8,128}$/u.test(value) ? value : null;
  const safeErrorMessage = (error: InventoryApiError): string => {
    const messages: Record<string, string> = {
      authentication_required: t("dashboard.inventory.client.error.authentication_required"),
      authorization_denied: t("dashboard.inventory.client.error.authorization_denied"),
      csrf_invalid: t("dashboard.inventory.client.error.csrf_invalid"),
      csrf_missing: t("dashboard.inventory.client.error.csrf_missing"),
      idempotency_conflict: t("dashboard.inventory.client.error.idempotency_conflict"),
      internal_error: t("dashboard.inventory.client.error.internal_error"),
      inventory_import_conflict: t("dashboard.inventory.client.error.inventory_import_conflict"),
      inventory_preview_invalid: t("dashboard.inventory.client.error.inventory_preview_invalid"),
      recent_auth_required: t("dashboard.inventory.client.error.recent_auth_required"),
      resource_not_found: t("dashboard.inventory.client.error.resource_not_found"),
      validation_failed: t("dashboard.inventory.client.error.validation_failed"),
    };
    const reference = error.requestId === null ? "" : t("dashboard.inventory.client.request_id", { requestId: error.requestId });
    return `${messages[error.message] ?? t("dashboard.inventory.client.error.generic")}${reference}`;
  };
  const api = async (url: string, method: string, body: JsonObject, headers: Record<string, string> = {}): Promise<JsonObject> => {
    const csrf = readCookie(csrfCookieName);
    const response = await fetch(url, { method, credentials: "same-origin", headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": decodeURIComponent(csrf) } : {}), ...headers }, body: JSON.stringify(body) });
    const payload: unknown = await response.json().catch(() => ({}));
    const object = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload as JsonObject : {};
    if (!response.ok) {
      throw new InventoryApiError(typeof object.code === "string" ? object.code : "request_failed", safeRequestId(object.requestId));
    }
    return object;
  };
  const formValue = (data: FormData, name: string): string => { const value = data.get(name); return typeof value === "string" ? value : ""; };
  const countsFrom = (value: JsonObject): ImportCounts | null => {
    const counts = {
      acceptedCount: value.acceptedCount,
      duplicateCount: value.duplicateCount,
      rejectedCount: value.rejectedCount,
      totalCount: value.totalCount,
    };
    if (Object.values(counts).some((count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) return null;
    return counts as ImportCounts;
  };
  const setPreviewCounts = (counts: ImportCounts | null): void => {
    const values: Record<string, number> = counts === null ? { accepted: 0, duplicate: 0, rejected: 0, total: 0 } : {
      accepted: counts.acceptedCount,
      duplicate: counts.duplicateCount,
      rejected: counts.rejectedCount,
      total: counts.totalCount,
    };
    for (const [key, value] of Object.entries(values)) {
      const target = form.querySelector<HTMLElement>(`[data-preview="${key}"]`);
      if (target !== null) target.textContent = String(value);
    }
  };
  const invalidatePreview = (announce = false): void => {
    const hadPreview = previewToken !== null;
    previewToken = null;
    idempotencyKey = null;
    if (confirmButton !== null) confirmButton.disabled = true;
    setPreviewCounts(null);
    if (announce && hadPreview) setFeedback(t("dashboard.inventory.client.preview.invalidated"));
  };
  const eraseImportForm = (): void => {
    const textarea = form.elements.namedItem("data");
    if (textarea instanceof HTMLTextAreaElement) textarea.value = "";
    form.reset();
  };
  const resetDialogState = (): void => {
    eraseImportForm();
    invalidatePreview();
    setFeedback("");
  };
  const lockDialog = (action: "import" | "preview"): boolean => {
    if (pendingAction !== null) return false;
    pendingAction = action;
    form.setAttribute("aria-busy", "true");
    dialog.dataset.pending = action;
    lockState.clear();
    for (const control of controls) {
      lockState.set(control, control.disabled);
      control.disabled = true;
    }
    return true;
  };
  const unlockDialog = (): void => {
    for (const control of controls) control.disabled = lockState.get(control) ?? false;
    lockState.clear();
    pendingAction = null;
    form.setAttribute("aria-busy", "false");
    delete dialog.dataset.pending;
    if (confirmButton !== null) confirmButton.disabled = previewToken === null;
  };
  const openDialog = (variantId = ""): void => {
    resetDialogState();
    if (variantSelect !== null) variantSelect.value = variantId;
    dialog.showModal();
  };
  openButton?.addEventListener("click", () => { openDialog(); });
  closeButton?.addEventListener("click", () => { if (pendingAction === null) dialog.close(); });
  dialog.addEventListener("cancel", (event) => {
    if (pendingAction !== null) {
      event.preventDefault();
      return;
    }
    resetDialogState();
  });
  dialog.addEventListener("close", resetDialogState);
  document.querySelectorAll<HTMLButtonElement>("[data-import-variant]").forEach((button) => { button.addEventListener("click", () => { openDialog(button.dataset.importVariant ?? ""); }); });
  const handlePreviewContextChange = (event: Event): void => {
    const target = event.target;
    if (target instanceof HTMLTextAreaElement || (target instanceof HTMLSelectElement && (target.name === "variantId" || target.name === "source"))) {
      invalidatePreview(true);
    }
  };
  form.addEventListener("input", handlePreviewContextChange);
  form.addEventListener("change", handlePreviewContextChange);
  const previewImport = async (): Promise<void> => {
    if (pendingAction !== null || !form.reportValidity() || previewButton === null) return;
    const data = new FormData(form);
    if (!lockDialog("preview")) return;
    invalidatePreview();
    setFeedback(t("dashboard.inventory.client.preview.pending"));
    const requestBody: JsonObject = { data: formValue(data, "data"), filename: null, source: formValue(data, "source") };
    data.delete("data");
    try {
      const result = await api(`/api/app/shops/${shopPublicId}/variants/${formValue(data, "variantId")}/inventory/preview`, "POST", requestBody);
      const preview = typeof result.preview === "object" && result.preview !== null ? result.preview as JsonObject : {};
      const counts = countsFrom(preview);
      if (counts === null) throw new InventoryApiError("invalid_response", safeRequestId(result.requestId));
      setPreviewCounts(counts);
      previewToken = typeof preview.previewToken === "string" ? preview.previewToken : null;
      idempotencyKey = `inventory-${crypto.randomUUID()}`;
      if (previewToken === null) throw new InventoryApiError("invalid_response", safeRequestId(result.requestId));
      if (counts.acceptedCount < 1) {
        previewToken = null;
        idempotencyKey = null;
        setFeedback(t("dashboard.inventory.client.preview.summary", { accepted: 0, total: counts.totalCount, duplicate: counts.duplicateCount, rejected: counts.rejectedCount }));
      } else {
        const reference = safeRequestId(result.requestId);
        setFeedback(`${t("dashboard.inventory.client.preview.summary", { accepted: counts.acceptedCount, total: counts.totalCount, duplicate: counts.duplicateCount, rejected: counts.rejectedCount })}${reference === null ? "" : t("dashboard.inventory.client.request_id", { requestId: reference })}`);
      }
    } catch (error) {
      const safeError = error instanceof InventoryApiError ? error : new InventoryApiError("request_failed", null);
      eraseImportForm();
      invalidatePreview();
      setFeedback(safeErrorMessage(safeError));
    } finally {
      requestBody.data = "";
      unlockDialog();
    }
  };
  previewButton?.addEventListener("click", () => { void previewImport(); });
  const confirmImport = async (): Promise<void> => {
    if (pendingAction !== null || previewToken === null || idempotencyKey === null || confirmButton === null) return;
    const data = new FormData(form);
    const tokenForRequest = previewToken;
    const keyForRequest = idempotencyKey;
    if (!lockDialog("import")) return;
    setFeedback(t("dashboard.inventory.client.import.pending"));
    const requestBody: JsonObject = { data: formValue(data, "data"), filename: null, previewToken: tokenForRequest, source: formValue(data, "source") };
    data.delete("data");
    try {
      const result = await api(`/api/app/shops/${shopPublicId}/variants/${formValue(data, "variantId")}/inventory/import`, "POST", requestBody, { "Idempotency-Key": keyForRequest });
      const counts = countsFrom(result);
      if (counts === null) throw new InventoryApiError("invalid_response", safeRequestId(result.requestId));
      const replayed = result.replayed === true;
      eraseImportForm();
      previewToken = null;
      idempotencyKey = null;
      setPreviewCounts(counts);
      const reference = safeRequestId(result.requestId);
      const verb = t(replayed ? "dashboard.inventory.client.import.verb.replayed" : "dashboard.inventory.client.import.verb.imported");
      setFeedback(`${t("dashboard.inventory.client.import.completed", { verb, accepted: counts.acceptedCount, total: counts.totalCount, duplicate: counts.duplicateCount, rejected: counts.rejectedCount })}${reference === null ? "" : t("dashboard.inventory.client.request_id", { requestId: reference })}`);
      window.setTimeout(() => { window.location.reload(); }, 1_500);
    } catch (error) {
      const safeError = error instanceof InventoryApiError ? error : new InventoryApiError("request_failed", null);
      eraseImportForm();
      invalidatePreview();
      setFeedback(safeErrorMessage(safeError));
    } finally {
      requestBody.data = "";
      unlockDialog();
    }
  };
  confirmButton?.addEventListener("click", () => { void confirmImport(); });
}
