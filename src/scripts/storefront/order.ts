import { fulfillmentStateView, orderStateLabel, paymentStateView, type OrderStateView } from "../../lib/storefront/order-view";
import { formatClientMoney } from "./catalog-dom";
import { createStorefrontTranslator } from "../../lib/i18n/catalogs/storefront";
import { createBrowserOrderAccessStorage } from "./order-access-storage";

type ApiError = { code?: string; requestId?: string };
type OrderItem = { fulfillmentType: string; lineTotalMinor: number; productTitle: string; quantity: number; variantTitle: string };
type ShippingAddress = { addressLine: string; district: string; fullName: string; notes: string | null; phone: string; province: string; ward: string };
type Shipment = { carrier: string | null; shippingState: string; trackingCode: string | null };
type OrderView = {
  currency: string;
  expiresAt: string;
  fulfillmentStatus: string;
  items: OrderItem[];
  orderNumber: string;
  paymentStatus: string;
  shipments?: Shipment[];
  shippingAddress?: ShippingAddress;
  shippingFeeMinor?: number;
  shippingMethodName?: string | null;
  status: string;
  totalMinor: number;
};
type OrderResponse = { order: OrderView } & ApiError;
type PaymentResponse = { paymentLink?: { checkoutUrl: string } } & ApiError;
type KeyResponse = { fulfillment?: { keys: Array<{ productTitle: string; value: string; variantTitle: string }> } } & ApiError;
type PrivateDownload = { assetVersionId: string; downloadCount: number; entitlementExpiresAt: string | null; entitlementStatus: string | null; filename: string; maxDownloads: number; orderItemId: string; remainingDownloads: number };
type DownloadListResponse = { downloads?: PrivateDownload[] } & ApiError;
type DownloadGrantResponse = { grant?: { expiresAt: string; grantId: string; grantToken: string; remainingDownloads: number } } & ApiError;
type RecoveryConsumeResponse = { order?: { orderId: string; orderToken: string } } & ApiError;

const locale = document.documentElement.lang || "en";
const t = createStorefrontTranslator(locale);

const root = document.querySelector("[data-order-id]");
const orderId = root instanceof HTMLElement ? root.dataset.orderId : undefined;
const tokenKey = orderId === undefined ? "" : `selinow-order-token:v1:${window.location.host}:${orderId}`;
const accessStorage = createBrowserOrderAccessStorage();
const fragment = new URLSearchParams(window.location.hash.slice(1));
const fragmentAccessToken = fragment.get("access");
let fragmentRecoveryToken = fragment.get("recovery");
if (fragmentAccessToken !== null || fragmentRecoveryToken !== null) {
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}
if (fragmentAccessToken !== null && tokenKey !== "") accessStorage.set(tokenKey, fragmentAccessToken);

const status = document.querySelector("#order-status");
const actions = document.querySelector("#order-actions");
const actionStatus = document.querySelector("#order-action-status");
const paymentButton = document.querySelector("#payment-button");
const refreshButton = document.querySelector("#refresh-button");
const revealButton = document.querySelector("#reveal-button");
const downloadSection = document.querySelector("#download-section");
const downloadList = document.querySelector("#download-list");
const downloadStatus = document.querySelector("#download-status");
const downloadRetry = document.querySelector("#download-retry");

function orderToken(): string | null {
  return tokenKey === "" ? null : accessStorage.get(tokenKey);
}

async function copyToClipboard(value: string): Promise<void> {
  if (!("clipboard" in navigator)) throw new Error("clipboard_unavailable");
  await navigator.clipboard.writeText(value);
}

function setActionStatus(message: string, error = false): void {
  if (!(actionStatus instanceof HTMLElement)) return;
  actionStatus.textContent = message;
  actionStatus.classList.toggle("error", error);
}

function setDownloadStatus(message: string, error = false): void {
  if (!(downloadStatus instanceof HTMLElement)) return;
  downloadStatus.textContent = message;
  downloadStatus.classList.toggle("error", error);
}

function resetDownloads(): void {
  if (downloadSection instanceof HTMLElement) downloadSection.hidden = true;
  if (downloadList instanceof HTMLElement) downloadList.replaceChildren();
  if (downloadRetry instanceof HTMLButtonElement) downloadRetry.hidden = true;
  setDownloadStatus("");
}

function showDownloadLoadError(): void {
  if (downloadSection instanceof HTMLElement) downloadSection.hidden = false;
  if (downloadList instanceof HTMLElement) downloadList.replaceChildren();
  if (downloadRetry instanceof HTMLButtonElement) downloadRetry.hidden = false;
  setDownloadStatus(t("storefront.order.downloads.load_failed"), true);
}

function showState(titleText: string, detailText: string, tone: "danger" | "info" | "warning"): void {
  if (!(status instanceof HTMLElement)) return;
  status.replaceChildren();
  const section = document.createElement("section");
  section.className = "order-message";
  section.dataset.tone = tone;
  const title = document.createElement("h2");
  title.textContent = titleText;
  const detail = document.createElement("p");
  detail.textContent = detailText;
  section.appendChild(title);
  section.appendChild(detail);
  status.appendChild(section);
  if (actions instanceof HTMLElement) actions.hidden = false;
  if (paymentButton instanceof HTMLButtonElement) paymentButton.hidden = true;
  if (revealButton instanceof HTMLButtonElement) revealButton.hidden = true;
  resetDownloads();
}

function supportSuffix(requestId?: string): string {
  return requestId === undefined ? "" : t("storefront.support_code", { requestId });
}

function showRecoveryForm(): void {
  if (!(status instanceof HTMLElement) || orderId === undefined) return;
  const form = document.createElement("form");
  form.className = "order-recovery-form";
  form.noValidate = false;
  const heading = document.createElement("h2");
  heading.textContent = t("storefront.order.recovery.form_title");
  const detail = document.createElement("p");
  detail.textContent = t("storefront.order.recovery.form_detail");
  const label = document.createElement("label");
  label.textContent = t("storefront.order.recovery.email_label");
  const email = document.createElement("input");
  email.autocomplete = "email";
  email.maxLength = 254;
  email.name = "email";
  email.placeholder = t("storefront.order.recovery.email_placeholder");
  email.required = true;
  email.type = "email";
  const submit = document.createElement("button");
  submit.className = "store-button";
  submit.type = "submit";
  submit.textContent = t("storefront.order.recovery.submit");
  const result = document.createElement("p");
  result.className = "form-status";
  result.setAttribute("aria-live", "polite");
  label.appendChild(email);
  form.appendChild(heading);
  form.appendChild(detail);
  form.appendChild(label);
  form.appendChild(submit);
  form.appendChild(result);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    submit.disabled = true;
    submit.textContent = t("storefront.order.recovery.submitting");
    result.classList.remove("error");
    result.textContent = t("storefront.order.recovery.requesting");
    void fetch(`/api/store/orders/${encodeURIComponent(orderId)}/recovery`, {
      body: JSON.stringify({ email: email.value }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).then(async (response) => {
      const body: ApiError = await response.json();
      if (response.ok) {
        result.textContent = t("storefront.order.recovery.accepted");
        email.value = "";
        return;
      }
      result.classList.add("error");
      result.textContent = response.status === 429
        ? `${t("storefront.order.recovery.rate_limited")}${supportSuffix(body.requestId)}`
        : `${t("storefront.order.recovery.request_failed")}${supportSuffix(body.requestId)}`;
    }).catch(() => {
      result.classList.add("error");
      result.textContent = t("storefront.order.recovery.network_failed");
    }).finally(() => {
      submit.disabled = false;
      submit.textContent = t("storefront.order.recovery.submit");
    });
  });
  status.appendChild(form);
}

function showAccessRecovery(title: string, detail: string): void {
  showState(title, detail, "warning");
  showRecoveryForm();
}

function appendTimeline(parent: HTMLElement, title: string, view: OrderStateView): void {
  const section = document.createElement("section");
  section.className = "order-timeline";
  const heading = document.createElement("div");
  heading.className = "order-timeline-heading";
  const label = document.createElement("h2");
  label.textContent = title;
  const badge = document.createElement("span");
  badge.className = `order-timeline-state ${view.tone}`;
  badge.textContent = view.label;
  heading.appendChild(label);
  heading.appendChild(badge);
  const copy = document.createElement("p");
  copy.textContent = view.detail;
  section.appendChild(heading);
  section.appendChild(copy);
  parent.appendChild(section);
}

function renderOrder(order: OrderView): void {
  if (!(status instanceof HTMLElement)) return;
  status.replaceChildren();
  const details = document.createElement("dl");
  const fields: Array<[string, string]> = [
    [t("storefront.order.field.number"), order.orderNumber],
    [t("storefront.order.field.status"), orderStateLabel(order.status, locale)],
    [t("storefront.order.field.payment"), orderStateLabel(order.paymentStatus, locale)],
    [t("storefront.order.field.fulfillment"), orderStateLabel(order.fulfillmentStatus, locale)],
    [t("storefront.order.field.total"), formatClientMoney(order.totalMinor, order.currency)],
    [t("storefront.order.field.expires"), new Date(order.expiresAt).toLocaleString(locale)],
  ];
  for (const [term, value] of fields) {
    const wrapper = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    wrapper.appendChild(dt);
    wrapper.appendChild(dd);
    details.appendChild(wrapper);
  }
  status.appendChild(details);
  const lines = document.createElement("div");
  lines.className = "order-lines";
  for (const item of order.items) {
    const line = document.createElement("div");
    line.className = "order-line";
    const name = document.createElement("span");
    name.textContent = `${item.productTitle} · ${item.variantTitle} × ${String(item.quantity)}`;
    const amount = document.createElement("strong");
    amount.textContent = formatClientMoney(item.lineTotalMinor, order.currency);
    line.appendChild(name);
    line.appendChild(amount);
    lines.appendChild(line);
  }
  status.appendChild(lines);
  appendTimeline(status, t("storefront.order.timeline.payment"), paymentStateView(order.paymentStatus, order.status, locale));
  appendTimeline(status, t("storefront.order.timeline.fulfillment"), fulfillmentStateView(order.fulfillmentStatus, order.status, locale));
  renderShipping(order);
  const hasKeyDelivery = order.items.some((item) => item.fulfillmentType === "license_key");
  if (actions instanceof HTMLElement) actions.hidden = false;
  if (paymentButton instanceof HTMLButtonElement) {
    paymentButton.hidden = !(order.status === "pending_payment" && order.paymentStatus === "unpaid");
  }
  if (revealButton instanceof HTMLButtonElement) {
    revealButton.hidden = !hasKeyDelivery || !(order.status === "completed" && order.paymentStatus === "paid" && order.fulfillmentStatus === "fulfilled");
  }
}

function shippingStateLabel(state: string): string {
  if (state === "packing") return t("storefront.order.shipping.state.packing");
  if (state === "shipped") return t("storefront.order.shipping.state.shipped");
  if (state === "delivered") return t("storefront.order.shipping.state.delivered");
  return state;
}

function renderShipping(order: OrderView): void {
  const section = document.querySelector("#shipping-section");
  const address = document.querySelector("#shipping-address");
  const shipments = document.querySelector("#shipment-list");
  if (!(section instanceof HTMLElement) || !(address instanceof HTMLElement) || !(shipments instanceof HTMLElement)) return;
  const shippingAddress = order.shippingAddress;
  if (shippingAddress === undefined) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  address.replaceChildren();
  const lines = [
    `${shippingAddress.fullName} · ${shippingAddress.phone}`,
    shippingAddress.addressLine,
    `${shippingAddress.ward}, ${shippingAddress.district}, ${shippingAddress.province}`,
    ...(order.shippingMethodName === null || order.shippingMethodName === undefined ? [] : [
      `${t("storefront.order.shipping.method")}: ${order.shippingMethodName}`
        + (typeof order.shippingFeeMinor === "number" ? ` · ${formatClientMoney(order.shippingFeeMinor, order.currency)}` : ""),
    ]),
    ...(typeof shippingAddress.notes === "string" && shippingAddress.notes.length > 0 ? [shippingAddress.notes] : []),
  ];
  for (const line of lines) {
    const paragraph = document.createElement("p");
    paragraph.textContent = line;
    address.appendChild(paragraph);
  }
  shipments.replaceChildren();
  const rows = Array.isArray(order.shipments) ? order.shipments : [];
  for (const shipment of rows) {
    const item = document.createElement("p");
    const carrier = typeof shipment.carrier === "string" && shipment.carrier.length > 0 ? shipment.carrier : t("storefront.order.shipping.state.packing");
    const tracking = typeof shipment.trackingCode === "string" && shipment.trackingCode.length > 0 ? ` · ${shipment.trackingCode}` : "";
    item.textContent = `${shippingStateLabel(typeof shipment.shippingState === "string" ? shipment.shippingState : "")} · ${carrier}${tracking}`;
    shipments.appendChild(item);
  }
  if (rows.length === 0) {
    const pending = document.createElement("p");
    pending.textContent = t("storefront.order.shipping.state.packing");
    shipments.appendChild(pending);
  }
}

function downloadIntentStorageKey(download: PrivateDownload): string {
  return `selinow-private-download-intent:v1:${window.location.host}:${orderId ?? "unknown"}:${download.orderItemId}:${download.assetVersionId}`;
}

function downloadIntentKey(download: PrivateDownload): string {
  const storageKey = downloadIntentStorageKey(download);
  const stored = accessStorage.get(storageKey);
  if (stored !== null && /^[A-Za-z0-9._:-]{16,128}$/u.test(stored)) return stored;
  const next = `private-download:${crypto.randomUUID()}`;
  accessStorage.set(storageKey, next);
  return next;
}

function clearDownloadIntent(download: PrivateDownload): void {
  accessStorage.remove(downloadIntentStorageKey(download));
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    const payload: unknown = await response.json();
    if (typeof payload === "object" && payload !== null && typeof (payload as ApiError).code === "string") return String((payload as ApiError).code);
  } catch {
    // Binary download failures may not contain JSON.
  }
  return "request_failed";
}

function downloadErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    idempotency_conflict: t("storefront.order.downloads.error.idempotency_conflict"),
    private_download_grant_active: t("storefront.order.downloads.error.grant_active"),
    private_download_grant_not_found: t("storefront.order.downloads.error.not_available"),
    private_download_integrity_failed: t("storefront.order.downloads.error.integrity"),
    private_download_not_found: t("storefront.order.downloads.error.not_available"),
    private_download_storage_unavailable: t("storefront.order.downloads.error.storage"),
    rate_limited: t("storefront.order.downloads.error.rate_limited"),
  };
  return messages[code] ?? t("storefront.order.downloads.error.generic");
}

async function consumePrivateDownload(download: PrivateDownload, button: HTMLButtonElement): Promise<void> {
  const token = orderToken();
  if (orderId === undefined || token === null) return;
  button.disabled = true;
  button.textContent = t("storefront.order.downloads.preparing");
  setDownloadStatus(t("storefront.order.downloads.requesting"));
  try {
    const idempotencyKey = downloadIntentKey(download);
    const grantResponse = await fetch(`/api/store/orders/${encodeURIComponent(orderId)}/downloads/${encodeURIComponent(download.assetVersionId)}/grant`, {
      headers: {
        "Idempotency-Key": idempotencyKey,
        "X-Order-Access-Token": token,
        "X-Order-Item-Id": download.orderItemId,
      },
      method: "POST",
    });
    if (!grantResponse.ok) throw new Error(await readErrorCode(grantResponse));
    const grantBody: DownloadGrantResponse = await grantResponse.json();
    const grant = grantBody.grant;
    if (grant === undefined || typeof grant.grantId !== "string" || typeof grant.grantToken !== "string") throw new Error("private_download_grant_invalid");
    const consumeResponse = await fetch(`/api/store/orders/${encodeURIComponent(orderId)}/downloads/grants/${encodeURIComponent(grant.grantId)}/consume`, {
      headers: {
        "Idempotency-Key": idempotencyKey,
        "X-Delivery-Grant-Token": grant.grantToken,
        "X-Order-Access-Token": token,
      },
      method: "POST",
    });
    if (!consumeResponse.ok) throw new Error(await readErrorCode(consumeResponse));
    const blob = await consumeResponse.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = download.filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => { URL.revokeObjectURL(objectUrl); }, 1_000);
    clearDownloadIntent(download);
    setDownloadStatus(t("storefront.order.downloads.started", { filename: download.filename }));
    await loadDownloads();
  } catch (error) {
    const code = error instanceof Error ? error.message : "request_failed";
    setDownloadStatus(downloadErrorMessage(code), true);
  } finally {
    button.disabled = false;
    button.textContent = t("storefront.order.downloads.action");
  }
}

function renderDownloads(downloads: PrivateDownload[]): void {
  if (!(downloadSection instanceof HTMLElement) || !(downloadList instanceof HTMLElement)) return;
  downloadList.replaceChildren();
  downloadSection.hidden = downloads.length === 0;
  if (downloadRetry instanceof HTMLButtonElement) downloadRetry.hidden = true;
  if (downloads.length === 0) {
    setDownloadStatus("");
    return;
  }
  for (const download of downloads) {
    const card = document.createElement("article");
    card.className = "download-card";
    const copy = document.createElement("div");
    copy.className = "download-card-copy";
    const filename = document.createElement("strong");
    filename.textContent = download.filename;
    const allowance = document.createElement("span");
    allowance.textContent = t("storefront.order.downloads.remaining", { count: download.remainingDownloads, max: download.maxDownloads });
    const state = document.createElement("small");
    const usable = (download.entitlementStatus === null || download.entitlementStatus === "active") && download.remainingDownloads > 0;
    state.textContent = download.entitlementStatus === "expired"
      ? t("storefront.order.downloads.state.expired")
      : download.entitlementStatus === "exhausted" || download.remainingDownloads === 0
        ? t("storefront.order.downloads.state.exhausted")
        : download.entitlementExpiresAt === null
          ? t("storefront.order.downloads.state.ready")
          : t("storefront.order.downloads.state.expires", { time: new Date(download.entitlementExpiresAt).toLocaleString(locale) });
    copy.appendChild(filename);
    copy.appendChild(allowance);
    copy.appendChild(state);
    const button = document.createElement("button");
    button.className = "store-button";
    button.type = "button";
    button.disabled = !usable;
    button.textContent = usable ? t("storefront.order.downloads.action") : t("storefront.order.downloads.unavailable");
    button.addEventListener("click", () => { void consumePrivateDownload(download, button); });
    card.appendChild(copy);
    card.appendChild(button);
    downloadList.appendChild(card);
  }
}

async function loadDownloads(): Promise<void> {
  const token = orderToken();
  if (orderId === undefined || token === null) {
    resetDownloads();
    return;
  }
  try {
    const response = await fetch(`/api/store/orders/${encodeURIComponent(orderId)}/downloads`, {
      headers: { "X-Order-Access-Token": token },
    });
    if (!response.ok) {
      if (response.status === 404) resetDownloads();
      else showDownloadLoadError();
      return;
    }
    const body: DownloadListResponse = await response.json();
    renderDownloads(Array.isArray(body.downloads) ? body.downloads : []);
  } catch {
    showDownloadLoadError();
  }
}

async function loadOrder(): Promise<void> {
  const token = orderToken();
  if (orderId === undefined || token === null) {
    showAccessRecovery(
      t("storefront.order.access_title"),
      t("storefront.order.access_detail"),
    );
    if (refreshButton instanceof HTMLButtonElement) refreshButton.hidden = true;
    return;
  }
  if (refreshButton instanceof HTMLButtonElement) {
    refreshButton.disabled = true;
    refreshButton.textContent = t("storefront.order.checking");
    refreshButton.hidden = false;
  }
  setActionStatus(t("storefront.order.loading_latest"));
  try {
    const response = await fetch(`/api/store/orders/${encodeURIComponent(orderId)}`, {
      headers: { "X-Order-Access-Token": token },
    });
    const body: OrderResponse = await response.json();
    if (!response.ok) {
      if (response.status === 404) {
        if (tokenKey !== "") accessStorage.remove(tokenKey);
        if (refreshButton instanceof HTMLButtonElement) refreshButton.hidden = true;
        showAccessRecovery(
          t("storefront.order.open_failed_title"),
          t("storefront.order.open_failed_detail"),
        );
      } else {
        const suffix = body.requestId === undefined ? "" : t("storefront.support_code", { requestId: body.requestId });
        showState(t("storefront.order.load_failed_title"), t("storefront.order.load_failed_detail", { support: suffix }), "danger");
      }
      setActionStatus("", true);
      return;
    }
    renderOrder(body.order);
    if (body.order.paymentStatus === "paid" && (body.order.status === "processing" || body.order.status === "completed")) await loadDownloads();
    else resetDownloads();
    setActionStatus(t("storefront.order.updated"));
  } catch {
    showState(t("storefront.order.network_title"), t("storefront.order.network_detail"), "danger");
    setActionStatus(t("storefront.order.update_failed"), true);
  } finally {
    if (refreshButton instanceof HTMLButtonElement) {
      refreshButton.disabled = false;
      refreshButton.textContent = t("storefront.order.refresh");
    }
  }
}

async function consumeRecoveryFragment(): Promise<void> {
  if (fragmentRecoveryToken === null || orderId === undefined || tokenKey === "") return;
  const token = fragmentRecoveryToken;
  fragmentRecoveryToken = null;
  showState(
    t("storefront.order.recovery.opening_title"),
    t("storefront.order.recovery.opening_detail"),
    "info",
  );
  try {
    const response = await fetch(`/api/store/orders/${encodeURIComponent(orderId)}/recovery/consume`, {
      body: JSON.stringify({ token }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body: RecoveryConsumeResponse = await response.json();
    if (!response.ok || body.order === undefined) {
      showAccessRecovery(
        t("storefront.order.recovery.invalid_title"),
        `${t("storefront.order.recovery.invalid_detail")}${supportSuffix(body.requestId)}`,
      );
      return;
    }
    accessStorage.set(tokenKey, body.order.orderToken);
    await loadOrder();
  } catch {
    showAccessRecovery(
      t("storefront.order.recovery.network_title"),
      t("storefront.order.recovery.network_detail"),
    );
  }
}

async function openPaymentLink(): Promise<void> {
  const token = orderToken();
  if (!(paymentButton instanceof HTMLButtonElement) || orderId === undefined || token === null) return;
  paymentButton.disabled = true;
  paymentButton.textContent = t("storefront.order.opening_payment");
  setActionStatus(t("storefront.order.loading_payment"));
  try {
    const response = await fetch(`/api/store/orders/${encodeURIComponent(orderId)}/payment-link`, {
      headers: { "X-Order-Access-Token": token },
      method: "POST",
    });
    const body: PaymentResponse = await response.json();
    if (response.ok && body.paymentLink !== undefined) {
      window.location.assign(body.paymentLink.checkoutUrl);
      return;
    }
    const messages: Record<string, string> = {
      payment_already_completed: t("storefront.order.payment.payment_already_completed"),
      payment_currency_unsupported: t("storefront.order.payment.payment_currency_unsupported"),
      payment_not_available: t("storefront.order.payment.payment_not_available"),
      payment_not_configured: t("storefront.order.payment.payment_not_configured"),
      payment_origin_invalid: t("storefront.order.payment.payment_origin_invalid"),
      payment_pending: t("storefront.order.payment.payment_pending"),
      rate_limited: t("storefront.order.payment.rate_limited"),
      tenant_suspended: t("storefront.order.payment.tenant_suspended"),
      provider_unavailable: t("storefront.order.payment.provider_unavailable"),
    };
    const message = body.code === undefined
      ? t("storefront.order.payment.generic")
      : messages[body.code] ?? t("storefront.order.payment.generic");
    setActionStatus(message, true);
  } catch {
    setActionStatus(t("storefront.order.payment.network"), true);
  } finally {
    paymentButton.disabled = false;
    paymentButton.textContent = t("storefront.order.open_payment");
  }
}

async function revealKeys(): Promise<void> {
  const token = orderToken();
  if (!(revealButton instanceof HTMLButtonElement) || orderId === undefined || token === null) return;
  revealButton.disabled = true;
  revealButton.textContent = t("storefront.order.delivery_loading");
  const list = document.querySelector("#key-list");
  if (!(list instanceof HTMLElement)) return;
  list.replaceChildren();
  try {
    const response = await fetch(`/api/store/orders/${encodeURIComponent(orderId)}/keys`, {
      headers: { "X-Order-Access-Token": token },
    });
    const body: KeyResponse = await response.json();
    if (!response.ok || body.fulfillment === undefined) {
      const paragraph = document.createElement("p");
      paragraph.textContent = response.status === 404
        ? t("storefront.order.delivery_access_invalid")
        : t("storefront.order.delivery_not_ready");
      list.appendChild(paragraph);
      setActionStatus(paragraph.textContent, true);
      return;
    }
    if (body.fulfillment.keys.length === 0) {
      const paragraph = document.createElement("p");
      paragraph.textContent = t("storefront.order.delivery_empty");
      list.appendChild(paragraph);
      setActionStatus(paragraph.textContent, true);
      return;
    }
    for (const key of body.fulfillment.keys) {
      const card = document.createElement("article");
      card.className = "key-card";
      const title = document.createElement("strong");
      title.textContent = `${key.productTitle} · ${key.variantTitle}`;
      const code = document.createElement("code");
      code.textContent = key.value;
      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = t("storefront.order.copy");
      copy.addEventListener("click", () => {
        void copyToClipboard(key.value).then(() => {
          copy.textContent = t("storefront.order.copied");
          window.setTimeout(() => { copy.textContent = t("storefront.order.copy"); }, 2_000);
        }).catch(() => { copy.textContent = t("storefront.order.copy_failed"); });
      });
      card.appendChild(title);
      card.appendChild(code);
      card.appendChild(copy);
      list.appendChild(card);
    }
    revealButton.hidden = true;
    setActionStatus(t("storefront.order.delivery_opened"));
  } catch {
    const paragraph = document.createElement("p");
    paragraph.textContent = t("storefront.order.delivery_network");
    list.appendChild(paragraph);
    setActionStatus(paragraph.textContent, true);
  } finally {
    revealButton.disabled = false;
    if (!revealButton.hidden) revealButton.textContent = t("storefront.order.reveal");
  }
}

refreshButton?.addEventListener("click", () => { void loadOrder(); });
paymentButton?.addEventListener("click", () => { void openPaymentLink(); });
revealButton?.addEventListener("click", () => { void revealKeys(); });
downloadRetry?.addEventListener("click", () => { void loadDownloads(); });

if (fragmentRecoveryToken === null) void loadOrder();
else void consumeRecoveryFragment();
