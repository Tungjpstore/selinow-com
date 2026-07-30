export {};

import { createDashboardTranslator } from "../../lib/i18n/catalogs/dashboard";
import { normalizeCurrencyCode, parseMajorAmountToMinor } from "../../lib/i18n/currency";

type JsonObject = Record<string, unknown>;

const t = createDashboardTranslator(document.documentElement.lang || "en");
const editorErrorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) return t("dashboard.products.client.editor_error_generic");
  if (["new_variant_fields_required", "new_variant_price_invalid", "new_variant_quantity_invalid"].includes(error.message)) {
    return t(`dashboard.products.client.validation.${error.message}`);
  }
  return t("dashboard.products.client.editor_error", { code: error.message });
};

const dialog = document.querySelector<HTMLDialogElement>("[data-product-dialog]");
const openButton = document.querySelector<HTMLButtonElement>("[data-open-product-form]");
const form = document.querySelector<HTMLFormElement>("[data-product-form]");
const feedback = document.querySelector<HTMLElement>("[data-form-feedback]");
const createButton = document.querySelector<HTMLButtonElement>("[data-create-product]");
const shopPublicId = dialog?.dataset.shopPublicId;
const csrfCookieName = dialog?.dataset.csrfCookieName;
const defaultCurrency = normalizeCurrencyCode(dialog?.dataset.defaultCurrency);

if (dialog !== null && createButton !== null && defaultCurrency === null) {
  createButton.disabled = true;
  if (feedback !== null) feedback.textContent = t("dashboard.products.client.create_error", { code: "currency_metadata_missing" });
  openButton?.addEventListener("click", () => { dialog.showModal(); });
}

if (dialog !== null && form !== null && createButton !== null && shopPublicId !== undefined && csrfCookieName !== undefined && defaultCurrency !== null) {
  const readCookie = (name: string): string | null => document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const intentStorageKey = `selinow:catalog:create:${shopPublicId}`;
  const productIntentKey = async (payload: string): Promise<string> => {
    const digestBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
    const payloadDigest = Array.from(new Uint8Array(digestBuffer), (value) => value.toString(16).padStart(2, "0")).join("");
    try {
      const stored = JSON.parse(sessionStorage.getItem(intentStorageKey) ?? "null") as unknown;
      if (typeof stored === "object" && stored !== null) {
        const row = stored as JsonObject;
        if (row.payloadDigest === payloadDigest && typeof row.key === "string") return row.key;
      }
      const key = crypto.randomUUID();
      sessionStorage.setItem(intentStorageKey, JSON.stringify({ key, payloadDigest }));
      return key;
    } catch {
      return crypto.randomUUID();
    }
  };
  const request = async (path: string, method: string, body: JsonObject, idempotencyKey?: string): Promise<JsonObject> => {
    const csrf = readCookie(csrfCookieName);
    if (csrf === null) throw new Error("csrf_missing");
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": decodeURIComponent(csrf),
        ...(idempotencyKey === undefined ? {} : { "Idempotency-Key": idempotencyKey }),
      },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const code = typeof payload === "object" && payload !== null && typeof (payload as JsonObject).code === "string" ? (payload as JsonObject).code : "request_failed";
      throw new Error(String(code));
    }
    return typeof payload === "object" && payload !== null ? payload as JsonObject : {};
  };

  openButton?.addEventListener("click", () => { dialog.showModal(); });
  const createProduct = async (): Promise<void> => {
    if (!form.reportValidity()) return;
    createButton.disabled = true;
    if (feedback !== null) feedback.textContent = t("dashboard.products.client.create_pending");
    const data = new FormData(form);
    try {
      const priceValue = data.get("priceMajor");
      const priceMinor = parseMajorAmountToMinor(typeof priceValue === "string" ? priceValue : "", defaultCurrency);
      if (priceMinor === null || priceMinor > 9_000_000_000_000) throw new Error("price_invalid");
      const createPayload = {
        categoryId: data.get("categoryId") || null,
        description: data.get("description") ?? "",
        fulfillmentType: "license_key",
        initialVariant: {
          compareAtMinor: null,
          currency: defaultCurrency,
          maxPerOrder: 1,
          minPerOrder: 1,
          options: {},
          priceMinor,
          sku: data.get("sku"),
          status: "active",
          title: data.get("variantTitle"),
        },
        slug: data.get("slug"),
        status: "draft",
        title: data.get("title"),
      };
      const serializedPayload = JSON.stringify(createPayload);
      const productResponse = await request(
        `/api/app/shops/${shopPublicId}/products`,
        "POST",
        createPayload,
        await productIntentKey(serializedPayload),
      );
      const product = typeof productResponse.product === "object" && productResponse.product !== null ? productResponse.product as JsonObject : null;
      const productId = typeof product?.id === "string" ? product.id : null;
      if (productId === null) throw new Error("product_response_invalid");
      const variant = typeof productResponse.variant === "object" && productResponse.variant !== null ? productResponse.variant as JsonObject : null;
      if (typeof variant?.id !== "string" || variant.productId !== productId) throw new Error("variant_response_invalid");
      try { sessionStorage.removeItem(intentStorageKey); } catch { /* Storage is optional. */ }
      window.location.reload();
    } catch (error) {
      if (feedback !== null) feedback.textContent = error instanceof Error ? t("dashboard.products.client.create_error", { code: error.message }) : t("dashboard.products.client.create_error_generic");
      createButton.disabled = false;
    }
  };
  createButton.addEventListener("click", () => { void createProduct(); });
}

const editor = document.querySelector<HTMLDialogElement>("[data-product-editor]");
const editorForm = document.querySelector<HTMLFormElement>("[data-product-editor-form]");
const saveButton = document.querySelector<HTMLButtonElement>("[data-save-product]");
const archiveButton = document.querySelector<HTMLButtonElement>("[data-archive-product]");
const editorFeedback = document.querySelector<HTMLElement>("[data-editor-feedback]");
const editorShopId = editor?.dataset.shopPublicId;
const editorProductId = editor?.dataset.productId;
const editorCsrfCookieName = editor?.dataset.csrfCookieName;
const editorDefaultCurrency = normalizeCurrencyCode(editor?.dataset.defaultCurrency);
const productArchivePanel = editor?.querySelector<HTMLElement>("[data-product-archive-confirm]") ?? null;
const productArchiveCancel = editor?.querySelector<HTMLButtonElement>("[data-cancel-product-archive]") ?? null;
const productArchiveConfirm = editor?.querySelector<HTMLButtonElement>("[data-confirm-product-archive]") ?? null;

if (editor !== null && saveButton !== null && archiveButton !== null && editorDefaultCurrency === null) {
  saveButton.disabled = true;
  archiveButton.disabled = true;
  if (productArchiveConfirm !== null) productArchiveConfirm.disabled = true;
  if (editorFeedback !== null) editorFeedback.textContent = t("dashboard.products.client.editor_error", { code: "currency_metadata_missing" });
}

if (editor !== null && editorForm !== null && saveButton !== null && archiveButton !== null && productArchivePanel !== null && productArchiveCancel !== null && productArchiveConfirm !== null && editorShopId !== undefined && editorProductId !== undefined && editorCsrfCookieName !== undefined && editorDefaultCurrency !== null) {
  const archiveInitiallyDisabled = archiveButton.disabled;
  const readEditorCookie = (name: string): string | null => document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const editorRequest = async (path: string, method: string, body: JsonObject): Promise<void> => {
    const csrf = readEditorCookie(editorCsrfCookieName);
    if (csrf === null) throw new Error("csrf_missing");
    const response = await fetch(path, { method, credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent(csrf) }, body: JSON.stringify(body) });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const code = typeof payload === "object" && payload !== null && typeof (payload as JsonObject).code === "string" ? (payload as JsonObject).code : "request_failed";
      throw new Error(String(code));
    }
  };
  const privateFileControls = editor.querySelector<HTMLElement>("[data-private-file-controls]");
  const privateFileInput = privateFileControls?.querySelector<HTMLInputElement>("[data-private-file-input]") ?? null;
  const privateFileMaxDownloads = privateFileControls?.querySelector<HTMLInputElement>("[data-private-file-max-downloads]") ?? null;
  const privateFileGrantTtl = privateFileControls?.querySelector<HTMLInputElement>("[data-private-file-grant-ttl]") ?? null;
  const privateFileEntitlementTtl = privateFileControls?.querySelector<HTMLInputElement>("[data-private-file-entitlement-ttl]") ?? null;
  const privateFileUpload = privateFileControls?.querySelector<HTMLButtonElement>("[data-upload-private-file]") ?? null;
  const privateFileActivate = privateFileControls?.querySelector<HTMLButtonElement>("[data-save-private-file-policy]") ?? null;
  const privateFileMetadata = privateFileControls?.querySelector<HTMLElement>("[data-private-file-metadata]") ?? null;
  const privateFileFeedback = privateFileControls?.querySelector<HTMLElement>("[data-private-file-feedback]") ?? null;
  let privateAssetVersionId: string | null = null;
  const safeFilename = (value: string): string => value.trim().replaceAll("\\", "/").split("/").at(-1)?.normalize("NFKD").replace(/[^A-Za-z0-9._ -]/gu, "-").replace(/\s+/gu, " ").replace(/\.{2,}/gu, ".").replace(/^[ .]+|[ .]+$/gu, "").slice(0, 160) ?? "";
  const privateFileSetBusy = (busy: boolean): void => {
    if (privateFileUpload !== null) privateFileUpload.disabled = busy;
    if (privateFileActivate !== null) privateFileActivate.disabled = busy || privateAssetVersionId === null;
  };
  const privateFilePayload = (value: unknown): JsonObject => typeof value === "object" && value !== null ? value as JsonObject : {};
  const uploadPrivateFile = async (): Promise<void> => {
    if (privateFileInput === null || privateFileUpload === null || privateFileControls === null) return;
    const file = privateFileInput.files?.[0];
    if (file === undefined) {
      if (privateFileFeedback !== null) privateFileFeedback.textContent = t("dashboard.products.client.private_file_missing");
      return;
    }
    const filename = safeFilename(file.name);
    if (filename === "") {
      if (privateFileFeedback !== null) privateFileFeedback.textContent = t("dashboard.products.client.private_file_invalid");
      return;
    }
    privateFileSetBusy(true);
    if (privateFileFeedback !== null) privateFileFeedback.textContent = t("dashboard.products.client.private_file_upload_pending");
    try {
      const csrf = readEditorCookie(editorCsrfCookieName);
      if (csrf === null) throw new Error("csrf_missing");
      const response = await fetch(`/api/app/shops/${editorShopId}/assets/private-files`, {
        body: file,
        credentials: "same-origin",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-CSRF-Token": decodeURIComponent(csrf),
          "X-File-Name": filename,
        },
        method: "POST",
      });
      const payload = privateFilePayload(await response.json());
      if (!response.ok) {
        const code = typeof payload.code === "string" ? payload.code : "request_failed";
        throw new Error(code);
      }
      const asset = privateFilePayload(payload.asset);
      if (typeof asset.assetVersionId !== "string" || typeof asset.filename !== "string" || typeof asset.byteSize !== "number") throw new Error("private_asset_response_invalid");
      privateAssetVersionId = asset.assetVersionId;
      if (privateFileMetadata !== null) {
        privateFileMetadata.hidden = false;
        privateFileMetadata.textContent = t("dashboard.products.client.private_file_uploaded", { filename: asset.filename, size: asset.byteSize });
      }
      if (privateFileFeedback !== null) privateFileFeedback.textContent = t("dashboard.products.client.private_file_upload_ready");
    } catch (error) {
      privateAssetVersionId = null;
      if (privateFileMetadata !== null) privateFileMetadata.hidden = true;
      if (privateFileFeedback !== null) privateFileFeedback.textContent = error instanceof Error ? t("dashboard.products.client.private_file_error", { code: error.message }) : t("dashboard.products.client.private_file_error_generic");
    } finally {
      privateFileSetBusy(false);
    }
  };
  const savePrivateFilePolicy = async (): Promise<void> => {
    if (privateFileControls === null || privateFileActivate === null || privateAssetVersionId === null) return;
    const maxDownloads = Number(privateFileMaxDownloads?.value ?? "");
    const grantTtlSeconds = Number(privateFileGrantTtl?.value ?? "");
    const entitlementRaw = privateFileEntitlementTtl?.value.trim() ?? "";
    const entitlementTtlSeconds = entitlementRaw === "" ? null : Number(entitlementRaw);
    if (!Number.isSafeInteger(maxDownloads) || !Number.isSafeInteger(grantTtlSeconds) || (entitlementTtlSeconds !== null && !Number.isSafeInteger(entitlementTtlSeconds))) {
      if (privateFileFeedback !== null) privateFileFeedback.textContent = t("dashboard.products.client.private_file_invalid");
      return;
    }
    privateFileSetBusy(true);
    if (privateFileFeedback !== null) privateFileFeedback.textContent = t("dashboard.products.client.private_file_policy_pending");
    try {
      await editorRequest(`/api/app/shops/${editorShopId}/products/${editorProductId}/private-file-policy`, "POST", { assetVersionId: privateAssetVersionId, entitlementTtlSeconds, grantTtlSeconds, maxDownloads });
      if (privateFileFeedback !== null) privateFileFeedback.textContent = t("dashboard.products.client.private_file_policy_saved");
    } catch (error) {
      if (privateFileFeedback !== null) privateFileFeedback.textContent = error instanceof Error ? t("dashboard.products.client.private_file_error", { code: error.message }) : t("dashboard.products.client.private_file_error_generic");
    } finally {
      privateFileSetBusy(false);
    }
  };
  privateFileInput?.addEventListener("change", () => {
    privateAssetVersionId = null;
    if (privateFileActivate !== null) privateFileActivate.disabled = true;
    if (privateFileMetadata !== null) privateFileMetadata.hidden = true;
    if (privateFileFeedback !== null) privateFileFeedback.textContent = "";
  });
  privateFileUpload?.addEventListener("click", () => { void uploadPrivateFile(); });
  privateFileActivate?.addEventListener("click", () => { void savePrivateFilePolicy(); });
  const editorPayload = (): JsonObject => {
    const data = new FormData(editorForm);
    return {
      categoryId: data.get("categoryId") || null,
      description: data.get("description") ?? "",
      fulfillmentType: data.get("fulfillmentType") ?? "license_key",
      slug: data.get("slug") ?? "",
      status: data.get("status") ?? "draft",
      title: data.get("title") ?? "",
    };
  };
  const setEditorBusy = (busy: boolean, message: string): void => {
    saveButton.disabled = busy;
    archiveButton.disabled = busy || archiveInitiallyDisabled;
    productArchiveCancel.disabled = busy;
    productArchiveConfirm.disabled = busy;
    if (editorFeedback !== null) editorFeedback.textContent = message;
  };
  const parseOptions = (value: FormDataEntryValue | null): Record<string, unknown> => {
    if (typeof value !== "string" || value.trim() === "") return {};
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };
  const newVariantPayload = (): JsonObject | null => {
    const sku = editorForm.querySelector<HTMLInputElement>("[name='newVariantSku']")?.value.trim() ?? "";
    const title = editorForm.querySelector<HTMLInputElement>("[name='newVariantTitle']")?.value.trim() ?? "";
    const price = editorForm.querySelector<HTMLInputElement>("[name='newVariantPriceMajor']")?.value.trim() ?? "";
    if (sku === "" && title === "" && price === "") return null;
    if (sku === "" || title === "" || price === "") throw new Error("new_variant_fields_required");
    const priceMinor = parseMajorAmountToMinor(price, editorDefaultCurrency);
    const minPerOrder = Number(editorForm.querySelector<HTMLInputElement>("[name='newVariantMinPerOrder']")?.value ?? 1);
    const maxPerOrder = Number(editorForm.querySelector<HTMLInputElement>("[name='newVariantMaxPerOrder']")?.value ?? 10);
    if (priceMinor === null || priceMinor > 9_000_000_000_000) throw new Error("new_variant_price_invalid");
    if (!Number.isSafeInteger(minPerOrder) || !Number.isSafeInteger(maxPerOrder) || minPerOrder < 1 || maxPerOrder < minPerOrder) {
      throw new Error("new_variant_quantity_invalid");
    }
    const statusInput = editorForm.querySelector("[name='newVariantStatus']");
    return {
      compareAtMinor: null,
      currency: editorDefaultCurrency,
      maxPerOrder,
      minPerOrder,
      options: {},
      priceMinor,
      sku,
      status: statusInput instanceof HTMLSelectElement ? statusInput.value : "active",
      title,
    };
  };
  const saveProduct = async (statusOverride?: string): Promise<void> => {
    if (!editorForm.reportValidity()) return;
    setEditorBusy(true, t("dashboard.products.client.editor_pending"));
    try {
      const nextVariant = statusOverride === undefined ? newVariantPayload() : null;
      const product = editorPayload();
      if (statusOverride !== undefined) product.status = statusOverride;
      await editorRequest(`/api/app/shops/${editorShopId}/products/${editorProductId}`, "PUT", product);
      if (statusOverride === undefined) {
        for (const row of editorForm.querySelectorAll<HTMLElement>("[data-variant-editor]")) {
          const variantId = row.dataset.variantId;
          if (variantId === undefined) continue;
          const fields = new FormData();
          for (const field of row.querySelectorAll("input, select")) {
            if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) fields.append(field.name, field.value);
          }
          const compareAtRaw = fields.get("compareAtMinor");
          const priceValue = fields.get("priceMajor");
          const priceMinor = parseMajorAmountToMinor(typeof priceValue === "string" ? priceValue : "", editorDefaultCurrency);
          if (priceMinor === null || priceMinor > 9_000_000_000_000) throw new Error("new_variant_price_invalid");
          await editorRequest(`/api/app/shops/${editorShopId}/variants/${variantId}`, "PUT", {
            compareAtMinor: compareAtRaw === null || compareAtRaw === "" ? null : Number(compareAtRaw),
            currency: editorDefaultCurrency,
            maxPerOrder: Number(fields.get("maxPerOrder") ?? 10),
            minPerOrder: Number(fields.get("minPerOrder") ?? 1),
            options: parseOptions(fields.get("optionsJson")),
            priceMinor,
            sku: fields.get("sku") ?? "",
            status: fields.get("status") ?? "active",
            title: fields.get("title") ?? "",
          });
        }
        if (nextVariant !== null) {
          await editorRequest(`/api/app/shops/${editorShopId}/products/${editorProductId}/variants`, "POST", nextVariant);
        }
      }
      window.location.assign(`/app/products?shop=${encodeURIComponent(editorShopId)}`);
    } catch (error) {
      setEditorBusy(false, editorErrorMessage(error));
    }
  };
  saveButton.addEventListener("click", () => { void saveProduct(); });
  archiveButton.addEventListener("click", () => {
    productArchivePanel.hidden = false;
    archiveButton.setAttribute("aria-expanded", "true");
    productArchiveConfirm.focus();
  });
  productArchiveCancel.addEventListener("click", () => {
    productArchivePanel.hidden = true;
    archiveButton.setAttribute("aria-expanded", "false");
    archiveButton.focus();
  });
  productArchiveConfirm.addEventListener("click", () => { void saveProduct("archived"); });
}

const productSearch = document.querySelector<HTMLInputElement>("[data-product-search]");
const productStatus = document.querySelector("[data-product-status]");
const productRows = [...document.querySelectorAll<HTMLElement>("[data-product-row]")];
const productNoResults = document.querySelector<HTMLElement>("[data-product-no-results]");
const filterProductRows = (): void => {
  const query = productSearch?.value.trim().toLocaleLowerCase() ?? "";
  const status = productStatus instanceof HTMLSelectElement ? productStatus.value : "";
  let visible = 0;
  for (const row of productRows) {
    const textMatch = query === "" || (row.dataset.productSearchText ?? "").toLocaleLowerCase().includes(query);
    const statusMatch = status === ""
      || (status === "out_of_stock" ? row.dataset.productStock === "out_of_stock" : row.dataset.productStatus === status);
    const match = textMatch && statusMatch;
    row.hidden = !match;
    if (match) visible += 1;
  }
  if (productNoResults !== null) productNoResults.hidden = visible > 0 || productRows.length === 0;
};
productSearch?.addEventListener("input", filterProductRows);
productStatus?.addEventListener("change", filterProductRows);

const categoryDialog = document.querySelector<HTMLDialogElement>("[data-category-dialog]");
const categoryOpenButton = document.querySelector<HTMLButtonElement>("[data-open-category-form]");
const categoryForm = document.querySelector<HTMLFormElement>("[data-category-form]");
const categoryCreateButton = document.querySelector<HTMLButtonElement>("[data-create-category]");
const categoryFeedback = document.querySelector<HTMLElement>("[data-category-feedback]");
const categoryShopId = categoryDialog?.dataset.shopPublicId;
const categoryCsrfCookieName = categoryDialog?.dataset.csrfCookieName;
if (categoryDialog !== null && categoryForm !== null && categoryCreateButton !== null && categoryShopId !== undefined && categoryCsrfCookieName !== undefined) {
  const readCategoryCookie = (name: string): string | null => document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  categoryOpenButton?.addEventListener("click", () => { categoryDialog.showModal(); });
  const createCategory = async (): Promise<void> => {
    if (!categoryForm.reportValidity()) return;
    const csrf = readCategoryCookie(categoryCsrfCookieName);
    if (csrf === null) return;
    categoryCreateButton.disabled = true;
    if (categoryFeedback !== null) categoryFeedback.textContent = t("dashboard.products.client.category_create_pending");
    const data = new FormData(categoryForm);
    try {
      const response = await fetch(`/api/app/shops/${categoryShopId}/categories`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent(csrf) }, body: JSON.stringify({ description: data.get("description") ?? "", name: data.get("name") ?? "", slug: data.get("slug") ?? "", sortOrder: 0, status: data.get("status") ?? "draft" }) });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const code = typeof payload === "object" && payload !== null && typeof (payload as JsonObject).code === "string" ? (payload as JsonObject).code : "request_failed";
        throw new Error(String(code));
      }
      window.location.reload();
    } catch (error) {
      categoryCreateButton.disabled = false;
      if (categoryFeedback !== null) categoryFeedback.textContent = error instanceof Error ? t("dashboard.products.client.category_create_error", { code: error.message }) : t("dashboard.products.client.category_create_error_generic");
    }
  };
  categoryCreateButton.addEventListener("click", () => { void createCategory(); });
}

const categoryManager = document.querySelector<HTMLElement>("[data-category-manager]");
const managerShopId = categoryManager?.dataset.shopPublicId;
const managerCsrfCookieName = categoryManager?.dataset.csrfCookieName;
if (categoryManager !== null && managerShopId !== undefined && managerCsrfCookieName !== undefined) {
  const readManagerCookie = (name: string): string | null => document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const updateCategory = async (row: HTMLElement, statusOverride?: "archived"): Promise<void> => {
    const categoryId = row.dataset.categoryId;
    const feedback = row.querySelector<HTMLElement>("[data-category-editor-feedback]");
    const buttons = [...row.querySelectorAll<HTMLButtonElement>("button")];
    const initialButtonStates = new Map(buttons.map((button) => [button, button.disabled]));
    for (const control of row.querySelectorAll("input, select, textarea")) {
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
        if (!control.checkValidity()) {
          control.reportValidity();
          return;
        }
      } else if (control instanceof HTMLSelectElement && !control.checkValidity()) {
        control.reportValidity();
        return;
      }
    }
    const csrf = readManagerCookie(managerCsrfCookieName);
    if (categoryId === undefined || csrf === null) {
      if (feedback !== null) feedback.textContent = t("dashboard.products.client.session_invalid");
      return;
    }
    const value = (name: string): string => {
      const control = row.querySelector(`[name="${name}"]`);
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) return control.value;
      return "";
    };
    const sortOrder = Number(value("sortOrder"));
    if (!Number.isSafeInteger(sortOrder)) {
      if (feedback !== null) feedback.textContent = t("dashboard.products.client.sort_order_integer");
      return;
    }
    for (const button of buttons) button.disabled = true;
    if (feedback !== null) feedback.textContent = statusOverride === "archived" ? t("dashboard.products.client.category_archive_pending") : t("dashboard.products.client.category_save_pending");
    try {
      const response = await fetch(`/api/app/shops/${managerShopId}/categories/${categoryId}`, {
        body: JSON.stringify({
          description: value("description"),
          name: value("name"),
          slug: value("slug"),
          sortOrder,
          status: statusOverride ?? value("status"),
        }),
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent(csrf) },
        method: "PUT",
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const code = typeof payload === "object" && payload !== null && typeof (payload as JsonObject).code === "string" ? (payload as JsonObject).code : "request_failed";
        throw new Error(String(code));
      }
      window.location.reload();
    } catch (error) {
      for (const button of buttons) button.disabled = initialButtonStates.get(button) ?? false;
      if (feedback !== null) feedback.textContent = error instanceof Error ? t("dashboard.products.client.category_update_error", { code: error.message }) : t("dashboard.products.client.category_update_error_generic");
    }
  };

  for (const row of categoryManager.querySelectorAll<HTMLElement>("[data-category-editor]")) {
    const save = row.querySelector<HTMLButtonElement>("[data-save-category]");
    const requestArchive = row.querySelector<HTMLButtonElement>("[data-request-category-archive]");
    const archivePanel = row.querySelector<HTMLElement>("[data-category-archive-confirm]");
    const cancelArchive = row.querySelector<HTMLButtonElement>("[data-cancel-category-archive]");
    const confirmArchive = row.querySelector<HTMLButtonElement>("[data-confirm-category-archive]");
    save?.addEventListener("click", () => { void updateCategory(row); });
    requestArchive?.addEventListener("click", () => {
      if (archivePanel === null || confirmArchive === null) return;
      archivePanel.hidden = false;
      requestArchive.setAttribute("aria-expanded", "true");
      confirmArchive.focus();
    });
    cancelArchive?.addEventListener("click", () => {
      if (archivePanel === null || requestArchive === null) return;
      archivePanel.hidden = true;
      requestArchive.setAttribute("aria-expanded", "false");
      requestArchive.focus();
    });
    confirmArchive?.addEventListener("click", () => { void updateCategory(row, "archived"); });
  }
}
