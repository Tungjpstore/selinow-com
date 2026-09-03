import { formatClientMoney, readCart, readCatalog, saveCart } from "./catalog-dom";
import { createStorefrontTranslator } from "../../lib/i18n/catalogs/storefront";
import { createBrowserOrderAccessStorage } from "./order-access-storage";

const locale = document.documentElement.lang || "en";
const t = createStorefrontTranslator(locale);

type ApiError = { code?: string; requestId?: string };
type CartResponse = { cartId: string; cartToken: string; expiresAt?: string };
type QuoteItem = { productTitle: string; quantity: number; unitPriceMinor: number; variantId: string; variantTitle: string; variantVersion: number };
type ShippingMethod = { feeMinor: number; freeOverMinor: number | null; id: string; name: string };
type QuoteResponse = { currency: string; discountCode?: string | null; discountMinor?: number; expiresAt: string; items: QuoteItem[]; quoteEvidence: string; shipping?: { feeMinor: number; methodId: string | null; methods: ShippingMethod[] }; subtotalMinor?: number; totalMinor: number };
type CheckoutResponse = { order: { orderId: string; orderToken: string } };
type RecoveryAction = "cart" | "quote" | "recover" | "submit";
type CheckoutIntent = {
  cart: CartResponse;
  customerEmail: string;
  expected: QuoteItem[];
  idempotencyKey: string;
  quote: QuoteResponse;
  recoveryEvidence: string;
  recoveryExpiresAt: string;
};

class ApiResponseError extends Error {
  readonly code: string | undefined;
  readonly requestId: string | undefined;
  constructor(code: string | undefined, requestId?: string) {
    super(code ?? "api_response_error");
    this.code = code;
    this.requestId = requestId;
  }
}

const catalog = readCatalog();
const items = readCart(catalog);
const itemsElement = document.querySelector("#checkout-items");
const emptyElement = document.querySelector("#checkout-empty");

if (itemsElement instanceof HTMLElement) {
  for (const item of items) {
    const variant = catalog.get(item.variantId);
    if (variant === undefined) continue;
    const row = document.createElement("article");
    row.className = "cart-item";
    row.dataset.checkoutVariantId = item.variantId;
    const copy = document.createElement("div");
    const title = document.createElement("h2");
    title.dataset.checkoutItemTitle = "";
    title.textContent = variant.productTitle;
    const meta = document.createElement("p");
    meta.dataset.checkoutItemMeta = "";
    meta.textContent = `${variant.variantTitle} · ${t("storefront.checkout.quantity", { count: item.quantity })}`;
    copy.appendChild(title);
    copy.appendChild(meta);
    const price = document.createElement("strong");
    price.dataset.checkoutItemPrice = "";
    price.textContent = formatClientMoney(variant.priceMinor * item.quantity, variant.currency);
    row.appendChild(copy);
    row.appendChild(price);
    itemsElement.appendChild(row);
  }
}
if (emptyElement instanceof HTMLElement) emptyElement.hidden = items.length > 0;

let cart: CartResponse | null = null;
let quote: QuoteResponse | null = null;
let quoteExpiryTimer: number | undefined;
let selectedShippingMethodId: string | null = null;
let selectedBooking: { resourceId: string; startAt: string } | null = null;
let bookingVariantId: string | null = null;
const status = document.querySelector("#checkout-status");
const retry = document.querySelector("#checkout-retry");
const submit = document.querySelector("#checkout-submit");
const total = document.querySelector("#checkout-total");
const shippingFields = document.querySelector("#shipping-fields");
const shippingMethodsElement = document.querySelector("#shipping-methods");
const shippingFeeRow = document.querySelector("#shipping-fee-row");
const shippingFee = document.querySelector("#shipping-fee");
const promoField = document.querySelector<HTMLElement>("#promo-field");
const promoInput = document.querySelector<HTMLInputElement>("[data-promo-input]");
const promoApplyButton = document.querySelector<HTMLButtonElement>("[data-promo-apply]");
const promoAppliedRow = document.querySelector<HTMLElement>("#promo-applied");
const promoCodeChip = document.querySelector<HTMLElement>("[data-promo-code]");
const promoRemoveButton = document.querySelector<HTMLButtonElement>("[data-promo-remove]");
const promoStatus = document.querySelector<HTMLElement>("[data-promo-status]");
const discountRow = document.querySelector<HTMLElement>("#discount-row");
const discountLabel = document.querySelector<HTMLElement>("[data-discount-label]");
const discountValue = document.querySelector<HTMLElement>("#discount-value");
const PROMO_DRAFT_KEY = `selinow-promo-draft:v1:${window.location.host}`;
const bookingFields = document.querySelector("#booking-fields");
const bookingDateInput = document.querySelector("#booking-date");
const bookingSlotsElement = document.querySelector("#booking-slots");
const bookingSlotStatus = document.querySelector("#booking-slot-status");
let recoveryAction: RecoveryAction | null = null;
let pendingIntent: CheckoutIntent | null = null;
const accessStorage = createBrowserOrderAccessStorage();

function intentStorageKey(): string {
  return `selinow-checkout-intent:v1:${window.location.host}`;
}

function readPendingIntent(): CheckoutIntent | null {
  try {
    const value = JSON.parse(accessStorage.get(intentStorageKey()) ?? "null") as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (
      typeof row.cart !== "object" || row.cart === null || Array.isArray(row.cart)
      || typeof row.expected !== "object" || !Array.isArray(row.expected)
      || typeof row.quote !== "object" || row.quote === null || Array.isArray(row.quote)
      || typeof row.customerEmail !== "string"
      || typeof row.idempotencyKey !== "string"
      || typeof row.recoveryEvidence !== "string"
      || typeof row.recoveryExpiresAt !== "string"
    ) return null;
    const cart = row.cart as Record<string, unknown>;
    const quote = row.quote as Record<string, unknown>;
    if (
      typeof cart.cartId !== "string" || typeof cart.cartToken !== "string"
      || typeof quote.currency !== "string" || typeof quote.expiresAt !== "string"
      || typeof quote.quoteEvidence !== "string" || !Array.isArray(quote.items)
      || typeof quote.totalMinor !== "number"
    ) return null;
    return {
      cart: {
        ...(typeof cart.expiresAt === "string" ? { expiresAt: cart.expiresAt } : {}),
        cartId: cart.cartId,
        cartToken: cart.cartToken,
      },
      customerEmail: row.customerEmail,
      expected: row.expected as QuoteItem[],
      idempotencyKey: row.idempotencyKey,
      quote: quote as unknown as QuoteResponse,
      recoveryEvidence: row.recoveryEvidence,
      recoveryExpiresAt: row.recoveryExpiresAt,
    };
  } catch {
    return null;
  }
}

function savePendingIntent(intent: CheckoutIntent): void {
  pendingIntent = intent;
  accessStorage.set(intentStorageKey(), JSON.stringify(intent));
}

function clearPendingIntent(): void {
  pendingIntent = null;
  accessStorage.remove(intentStorageKey());
}

async function requestOrderRecoveryEmail(orderId: string, customerEmail: string): Promise<void> {
  if (customerEmail.trim() === "") return;
  try {
    await fetch(`/api/store/orders/${encodeURIComponent(orderId)}/recovery`, {
      body: JSON.stringify({ email: customerEmail }),
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      method: "POST",
    });
  } catch {
    // The browser session token remains authoritative when email delivery is unavailable.
  }
}

function completeOrder(order: { orderId: string; orderToken: string }, customerEmail: string): void {
  accessStorage.set(`selinow-order-token:v1:${window.location.host}:${order.orderId}`, order.orderToken);
  void requestOrderRecoveryEmail(order.orderId, customerEmail);
  clearPendingIntent();
  saveCart([]);
  window.location.assign(`/orders/${order.orderId}#access=${encodeURIComponent(order.orderToken)}`);
}

function setRecovery(action: RecoveryAction | null): void {
  recoveryAction = action;
  if (!(retry instanceof HTMLButtonElement)) return;
  retry.hidden = action === null;
  if (action === "cart") retry.textContent = t("storefront.checkout.back_cart");
  if (action === "quote") retry.textContent = t("storefront.checkout.recheck");
  if (action === "recover") retry.textContent = t("storefront.checkout.retry_recovery");
  if (action === "submit") retry.textContent = t("storefront.checkout.retry_create");
}

function setError(message: string, recovery: RecoveryAction | null): void {
  if (status instanceof HTMLElement) {
    status.textContent = message;
    status.classList.add("error");
  }
  if (submit instanceof HTMLButtonElement) submit.disabled = true;
  setRecovery(recovery);
}

function armQuoteExpiry(expiresAt: string): boolean {
  if (quoteExpiryTimer !== undefined) window.clearTimeout(quoteExpiryTimer);
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    quote = null;
    setError(t("storefront.checkout.quote_expired"), "quote");
    return false;
  }
  const delay = expiresAtMs - Date.now();
  if (delay <= 2_147_483_647) {
    quoteExpiryTimer = window.setTimeout(() => {
      quote = null;
      setError(t("storefront.checkout.quote_expired"), "quote");
    }, Math.max(0, delay));
  }
  return true;
}

function errorMessage(code: unknown, requestId?: string): string {
  const messages: Record<string, string> = {
    cart_not_found: t("storefront.checkout.error.cart_not_found"),
    catalog_changed: t("storefront.checkout.error.catalog_changed"),
    checkout_changed: t("storefront.checkout.error.checkout_changed"),
    inventory_unavailable: t("storefront.checkout.error.inventory_unavailable"),
    payment_currency_unsupported: t("storefront.checkout.error.payment_currency_unsupported"),
    provider_unavailable: t("storefront.checkout.error.provider_unavailable"),
    quantity_unavailable: t("storefront.checkout.error.quantity_unavailable"),
    quote_expired: t("storefront.checkout.error.quote_expired"),
    quote_invalid: t("storefront.checkout.error.quote_invalid"),
    shipping_method_unavailable: t("storefront.checkout.error.shipping_method_unavailable"),
    shipping_method_not_found: t("storefront.checkout.error.shipping_method_not_found"),
    shipping_address_invalid: t("storefront.checkout.error.shipping_address_invalid"),
    shipping_phone_invalid: t("storefront.checkout.error.shipping_phone_invalid"),
    booking_slot_taken: t("storefront.checkout.error.booking_slot_taken"),
    booking_slot_required: t("storefront.checkout.error.booking_slot_required"),
    checkout_recovery_expired: t("storefront.checkout.error.checkout_recovery_expired"),
    idempotency_conflict: t("storefront.checkout.error.idempotency_conflict"),
    rate_limited: t("storefront.checkout.error.rate_limited"),
    turnstile_invalid: t("storefront.checkout.error.turnstile_invalid"),
    turnstile_required: t("storefront.checkout.error.turnstile_required"),
  };
  const message = typeof code === "string" && messages[code] !== undefined ? messages[code] : t("storefront.checkout.error.generic");
  return requestId === undefined ? message : `${message}${t("storefront.support_code", { requestId })}`;
}

async function readJson<T>(response: Response): Promise<T> {
  return response.json();
}

function errorCode(error: unknown): string | undefined {
  return error instanceof ApiResponseError ? error.code : undefined;
}

function errorRequestId(error: unknown): string | undefined {
  return error instanceof ApiResponseError ? error.requestId : undefined;
}

function recoveryForPrepare(code: string | undefined): RecoveryAction {
  return code === "cart_not_found" || code === "catalog_changed" || code === "inventory_unavailable" || code === "quantity_unavailable" ? "cart" : "quote";
}

function recoveryForCheckout(code: string | undefined): RecoveryAction | null {
  if (code === "payment_currency_unsupported") return null;
  if (code === "idempotency_conflict" || code === "checkout_recovery_expired") return "recover";
  if (code === "cart_not_found" || code === "catalog_changed" || code === "inventory_unavailable" || code === "quantity_unavailable") return "cart";
  return code === "checkout_changed" || code === "quote_expired" || code === "quote_invalid" ? "quote" : "submit";
}

function quoteMatchesCart(quoteItems: QuoteItem[]): boolean {
  if (quoteItems.length !== items.length) return false;
  const expected = new Map(items.map((item) => [item.variantId, item.quantity]));
  const seen = new Set<string>();
  for (const item of quoteItems) {
    if (seen.has(item.variantId) || expected.get(item.variantId) !== item.quantity) return false;
    seen.add(item.variantId);
  }
  return seen.size === expected.size;
}

function expectedSnapshot(itemsToCompare: QuoteItem[]): string {
  return JSON.stringify(itemsToCompare
    .map(({ quantity, unitPriceMinor, variantId, variantVersion }) => ({ quantity, unitPriceMinor, variantId, variantVersion }))
    .sort((left, right) => left.variantId.localeCompare(right.variantId)));
}

function renderAuthoritativeQuote(input: QuoteResponse): boolean {
  let changed = false;
  for (const item of input.items) {
    const variant = catalog.get(item.variantId);
    const row = [...document.querySelectorAll<HTMLElement>("[data-checkout-variant-id]")]
      .find((candidate) => candidate.dataset.checkoutVariantId === item.variantId);
    const title = row?.querySelector<HTMLElement>("[data-checkout-item-title]");
    const meta = row?.querySelector<HTMLElement>("[data-checkout-item-meta]");
    const price = row?.querySelector<HTMLElement>("[data-checkout-item-price]");
    if (title !== null && title !== undefined) title.textContent = item.productTitle;
    if (meta !== null && meta !== undefined) meta.textContent = `${item.variantTitle} · ${t("storefront.checkout.quantity", { count: item.quantity })}`;
    if (price !== null && price !== undefined) price.textContent = formatClientMoney(item.unitPriceMinor * item.quantity, input.currency);
    if (variant === undefined
      || variant.productTitle !== item.productTitle
      || variant.variantTitle !== item.variantTitle
      || variant.priceMinor !== item.unitPriceMinor
      || variant.version !== item.variantVersion) changed = true;
  }
  return changed;
}

function isPhysicalCart(): boolean {
  return items.some((item) => catalog.get(item.variantId)?.deliveryMode === "shipping");
}

function readShippingAddress(): Record<string, string> | null {
  const value = (id: string): string => {
    const input = document.querySelector(id);
    return input instanceof HTMLInputElement ? input.value.trim() : "";
  };
  const address = {
    addressLine: value("#ship-address"),
    district: value("#ship-district"),
    fullName: value("#ship-full-name"),
    notes: value("#ship-notes"),
    phone: value("#ship-phone"),
    province: value("#ship-province"),
    ward: value("#ship-ward"),
  };
  return address;
}

function renderPromo(currentQuote: QuoteResponse): void {
  const code = typeof currentQuote.discountCode === "string" && currentQuote.discountCode.length > 0
    ? currentQuote.discountCode
    : null;
  if (promoAppliedRow !== null) promoAppliedRow.hidden = code === null;
  if (promoField !== null) promoField.hidden = code !== null;
  if (code !== null && promoCodeChip !== null) promoCodeChip.textContent = t("storefront.checkout.promo.applied", { code });
  const discountMinor = typeof currentQuote.discountMinor === "number" ? currentQuote.discountMinor : 0;
  if (discountRow !== null) {
    discountRow.hidden = code === null || discountMinor <= 0;
    if (discountLabel !== null && code !== null) discountLabel.textContent = t("storefront.checkout.promo.discount_row", { code });
    if (discountValue !== null && discountMinor > 0) discountValue.textContent = `-${formatClientMoney(discountMinor, currentQuote.currency)}`;
  }
}

async function runPromoMutation(mutation: { kind: "discount.apply"; code: string } | { kind: "discount.remove" }): Promise<boolean> {
  if (cart === null) return false;
  const response = await fetch("/api/store/cart", {
    body: JSON.stringify({ cartId: cart.cartId, cartToken: cart.cartToken, mutation }),
    headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    method: "POST",
  });
  if (response.ok) return true;
  const body = (await response.json().catch(() => ({}))) as { code?: string };
  if (promoStatus !== null) {
    promoStatus.textContent = body.code === "discount_invalid"
      ? t("storefront.checkout.promo.invalid")
      : t("storefront.checkout.error.quote_failed");
  }
  return false;
}

function prefillPromoDraft(): void {
  if (promoInput === null) return;
  try {
    const draft = window.sessionStorage.getItem(PROMO_DRAFT_KEY);
    if (draft !== null && promoInput.value === "") promoInput.value = draft;
  } catch {
    // Draft is an enhancement only.
  }
}

function clearPromoDraft(): void {
  try {
    window.sessionStorage.removeItem(PROMO_DRAFT_KEY);
  } catch {
    // Best effort.
  }
}

function renderShipping(currentQuote: QuoteResponse): void {
  if (currentQuote.shipping === undefined) {
    if (shippingFields instanceof HTMLFieldSetElement) shippingFields.hidden = true;
    if (shippingFeeRow instanceof HTMLElement) shippingFeeRow.hidden = true;
    selectedShippingMethodId = null;
    return;
  }
  if (shippingFields instanceof HTMLFieldSetElement) shippingFields.hidden = false;
  selectedShippingMethodId = currentQuote.shipping.methodId;
  if (shippingMethodsElement instanceof HTMLElement) {
    shippingMethodsElement.replaceChildren();
    for (const method of currentQuote.shipping.methods) {
      const label = document.createElement("label");
      label.className = "shipping-method";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "shippingMethodId";
      input.value = method.id;
      input.required = true;
      input.checked = method.id === currentQuote.shipping.methodId;
      const copy = document.createElement("span");
      copy.className = "shipping-method-copy";
      const name = document.createElement("strong");
      name.textContent = method.name;
      copy.appendChild(name);
      if (method.freeOverMinor !== null) {
        const hint = document.createElement("small");
        hint.textContent = t("storefront.checkout.shipping.free_over", { amount: formatClientMoney(method.freeOverMinor, currentQuote.currency) });
        copy.appendChild(hint);
      }
      const fee = document.createElement("span");
      fee.className = "shipping-method-fee";
      fee.textContent = method.feeMinor === 0 ? t("storefront.checkout.shipping.free") : formatClientMoney(method.feeMinor, currentQuote.currency);
      label.appendChild(input);
      label.appendChild(copy);
      label.appendChild(fee);
      shippingMethodsElement.appendChild(label);
    }
  }
  if (shippingFeeRow instanceof HTMLElement) shippingFeeRow.hidden = false;
  if (shippingFee instanceof HTMLElement) {
    shippingFee.textContent = currentQuote.shipping.feeMinor === 0
      ? t("storefront.checkout.shipping.free")
      : formatClientMoney(currentQuote.shipping.feeMinor, currentQuote.currency);
  }
}

function isBookingCart(): boolean {
  const entry = catalog.get(items[0]?.variantId ?? "");
  return items.length === 1 && entry !== undefined && entry.durationMinutes !== null;
}

/**
 * Restore a slot drafted on the service detail page: set the date input and
 * pre-check the matching radio when it is still offered. The draft only
 * preselects UI; the guarded checkout still proves the slot atomically.
 */
function readBookingDraft(): { resourceId: string; startAt: string; variantId: string } | null {
  try {
    const raw = window.sessionStorage.getItem(`selinow-booking-draft:v1:${window.location.host}`);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.variantId !== "string" || typeof record.startAt !== "string" || typeof record.resourceId !== "string") return null;
    return { resourceId: record.resourceId, startAt: record.startAt, variantId: record.variantId };
  } catch {
    return null;
  }
}

function applyBookingDraft(): void {
  if (!(bookingDateInput instanceof HTMLInputElement) || bookingVariantId === null) return;
  const draft = readBookingDraft();
  if (draft === null || draft.variantId !== bookingVariantId) return;
  bookingDateInput.value = draft.startAt.slice(0, 10);
  const wanted = `${draft.resourceId}|${draft.startAt}`;
  const match = [...document.querySelectorAll<HTMLInputElement>('input[name="bookingSlot"]')].find((input) => input.value === wanted);
  if (match === undefined || match.disabled) return;
  match.checked = true;
  match.dispatchEvent(new Event("change", { bubbles: true }));
  try {
    window.sessionStorage.removeItem(`selinow-booking-draft:v1:${window.location.host}`);
  } catch {
    // Leaving the draft behind only means the next visit may preselect again.
  }
}

function localDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function loadBookingSlots(): Promise<void> {
  if (!(bookingSlotsElement instanceof HTMLElement) || !(bookingSlotStatus instanceof HTMLElement)) return;
  if (!(bookingDateInput instanceof HTMLInputElement) || bookingVariantId === null) return;
  bookingSlotsElement.replaceChildren();
  bookingSlotStatus.textContent = t("storefront.checkout.booking.loading");
  const fallbackDate = localDateKey(new Date(Date.now() + 86_400_000));
  const date = bookingDateInput.value !== "" ? bookingDateInput.value : fallbackDate;
  bookingDateInput.value = date;
  const dateStart = date;
  const dateEnd = localDateKey(new Date(Date.parse(date) + 6 * 86_400_000));
  try {
    const params = new URLSearchParams({ dateEnd, dateStart, variantId: bookingVariantId });
    const response = await fetch(`/api/store/booking/slots?${params.toString()}`);
    const body = await readJson<{ slots?: Array<{ endAt: string; resourceId: string; resourceName: string; startAt: string }> }>(response);
    if (!response.ok || !Array.isArray(body.slots)) throw new Error("booking_slots_failed");
    const slots = body.slots;
    bookingSlotStatus.textContent = slots.length === 0 ? t("storefront.checkout.booking.empty") : "";
    let currentDay = "";
    for (const slot of slots) {
      const day = slot.startAt.slice(0, 10);
      if (day !== currentDay) {
        currentDay = day;
        const heading = document.createElement("span");
        heading.className = "booking-slot-day";
        heading.textContent = new Date(slot.startAt).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "short" });
        bookingSlotsElement.appendChild(heading);
      }
      const label = document.createElement("label");
      label.className = "booking-slot";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "bookingSlot";
      input.value = `${slot.resourceId}|${slot.startAt}`;
      input.required = true;
      const text = document.createElement("span");
      text.textContent = `${new Date(slot.startAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })} · ${slot.resourceName}`;
      label.appendChild(input);
      label.appendChild(text);
      bookingSlotsElement.appendChild(label);
    }
    applyBookingDraft();
  } catch {
    bookingSlotStatus.textContent = t("storefront.checkout.booking.empty");
  }
}

bookingSlotsElement?.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.name !== "bookingSlot") return;
  const separator = target.value.indexOf("|");
  if (separator <= 0) return;
  const resourceId = target.value.slice(0, separator);
  const startAt = target.value.slice(separator + 1);
  selectedBooking = { resourceId, startAt };
  if (bookingSlotStatus instanceof HTMLElement) {
    bookingSlotStatus.textContent = t("storefront.checkout.booking.selected", { time: new Date(startAt).toLocaleString(locale) });
  }
});

bookingDateInput?.addEventListener("change", () => {
  selectedBooking = null;
  void loadBookingSlots();
});

shippingMethodsElement?.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.name !== "shippingMethodId") return;
  selectedShippingMethodId = target.value;
  void prepareWithRecovery(cart ?? undefined);
});

async function prepare(existingCart?: CartResponse, expectedItems?: QuoteItem[]): Promise<{ cart: CartResponse; quote: QuoteResponse } | null> {
  setRecovery(null);
  cart = existingCart ?? null;
  quote = null;
  if (submit instanceof HTMLButtonElement) submit.disabled = true;
  if (status instanceof HTMLElement) {
    status.textContent = t("storefront.checkout.confirming");
    status.classList.remove("error");
  }
  if (items.length === 0 && existingCart === undefined) {
    setError(t("storefront.cart.empty"), "cart");
    return null;
  }
  if (cart === null) {
    const cartResponse = await fetch("/api/store/cart", {
      body: JSON.stringify({ items, locale }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const cartBody = await readJson<CartResponse & ApiError>(cartResponse);
    if (!cartResponse.ok) throw new ApiResponseError(cartBody.code, cartBody.requestId);
    cart = cartBody;
  }
  const quoteResponse = await fetch("/api/store/quote", {
    body: JSON.stringify({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      ...(isPhysicalCart() && selectedShippingMethodId !== null ? { shippingMethodId: selectedShippingMethodId } : {}),
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const quoteBody = await readJson<{ quote: QuoteResponse } & ApiError>(quoteResponse);
  if (!quoteResponse.ok) throw new ApiResponseError(quoteBody.code, quoteBody.requestId);
  quote = quoteBody.quote;
  if (typeof quote.quoteEvidence !== "string" || quote.quoteEvidence.length < 40) throw new ApiResponseError("quote_invalid", quoteBody.requestId);
  if (expectedItems === undefined ? !quoteMatchesCart(quote.items) : expectedSnapshot(quote.items) !== expectedSnapshot(expectedItems)) {
    throw new ApiResponseError("quote_invalid", quoteBody.requestId);
  }
  const expiresAtMs = Date.parse(quote.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    quote = null;
    setError(t("storefront.checkout.quote_expired"), "quote");
    return null;
  }
  const quoteChanged = renderAuthoritativeQuote(quote);
  renderShipping(quote);
  renderPromo(quote);
  if (isBookingCart()) {
    if (bookingFields instanceof HTMLFieldSetElement) bookingFields.hidden = false;
    if (bookingVariantId === null) {
      bookingVariantId = items[0]?.variantId ?? null;
      void loadBookingSlots();
    }
  } else if (bookingFields instanceof HTMLFieldSetElement) {
    bookingFields.hidden = true;
  }
  if (total !== null) total.textContent = formatClientMoney(quote.totalMinor, quote.currency);
  if (status instanceof HTMLElement) {
    const heldUntil = new Date(expiresAtMs).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    status.textContent = quoteChanged
      ? t("storefront.checkout.quote_changed", { time: heldUntil })
      : t("storefront.checkout.quote_ready", { time: heldUntil });
    status.classList.remove("error");
  }
  setRecovery(null);
  if (!armQuoteExpiry(quote.expiresAt)) return null;
  if (submit instanceof HTMLButtonElement) submit.disabled = false;
  return { cart, quote };
}

async function prepareWithRecovery(existingCart?: CartResponse): Promise<void> {
  try {
    await prepare(existingCart);
  } catch (error: unknown) {
    const code = errorCode(error);
    setError(errorMessage(code, errorRequestId(error)), recoveryForPrepare(code));
  }
}

async function createCheckoutIntent(): Promise<CheckoutIntent> {
  if (cart === null || quote === null) throw new ApiResponseError("quote_invalid");
  const expected = quote.items.map((item) => ({ ...item }));
  const email = document.querySelector("#customer-email");
  const existingIntent = pendingIntent;
  const reusableIntent = existingIntent !== null && existingIntent.cart.cartId === cart.cartId
    ? existingIntent
    : null;
  const customerEmail = reusableIntent?.customerEmail ?? (email instanceof HTMLInputElement ? email.value : "");
  const idempotencyKey = reusableIntent?.idempotencyKey ?? crypto.randomUUID();
  const response = await fetch("/api/store/checkout/intent", {
    body: JSON.stringify({
      cartId: cart.cartId,
      cartToken: cart.cartToken,
      customerEmail,
      expected: expected.map(({ quantity, unitPriceMinor, variantId, variantVersion }) => ({ quantity, unitPriceMinor, variantId, variantVersion })),
      idempotencyKey,
      quoteEvidence: quote.quoteEvidence,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const body = await readJson<{ recovery?: { evidence?: string; expiresAt?: string } } & ApiError>(response);
  if (!response.ok || typeof body.recovery?.evidence !== "string" || typeof body.recovery.expiresAt !== "string") {
    throw new ApiResponseError(body.code ?? "checkout_recovery_invalid", body.requestId);
  }
  const intent: CheckoutIntent = { cart, customerEmail, expected, idempotencyKey, quote, recoveryEvidence: body.recovery.evidence, recoveryExpiresAt: body.recovery.expiresAt };
  savePendingIntent(intent);
  return intent;
}

function renderIntent(intent: CheckoutIntent): void {
  cart = intent.cart;
  quote = intent.quote;
  pendingIntent = intent;
  const email = document.querySelector("#customer-email");
  if (email instanceof HTMLInputElement) email.value = intent.customerEmail;
  const quoteChanged = renderAuthoritativeQuote(intent.quote);
  renderShipping(intent.quote);
  renderPromo(intent.quote);
  if (total !== null) total.textContent = formatClientMoney(intent.quote.totalMinor, intent.quote.currency);
  const expiresAtMs = Date.parse(intent.quote.expiresAt);
  if (Number.isFinite(expiresAtMs) && status instanceof HTMLElement) {
    const heldUntil = new Date(expiresAtMs).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    status.textContent = quoteChanged
      ? t("storefront.checkout.quote_changed", { time: heldUntil })
      : t("storefront.checkout.quote_ready", { time: heldUntil });
    status.classList.remove("error");
  }
  if (armQuoteExpiry(intent.quote.expiresAt) && submit instanceof HTMLButtonElement) submit.disabled = false;
}

async function recoverPendingCheckout(): Promise<boolean> {
  const intent = pendingIntent ?? readPendingIntent();
  if (intent === null) return false;
  pendingIntent = intent;
  cart = intent.cart;
  quote = intent.quote;
  if (status instanceof HTMLElement) {
    status.textContent = t("storefront.checkout.recovering");
    status.classList.remove("error");
  }
  try {
    const response = await fetch("/api/store/checkout/recover", {
      body: JSON.stringify({
        cartId: intent.cart.cartId,
        cartToken: intent.cart.cartToken,
        customerEmail: intent.customerEmail,
        expected: intent.expected.map(({ quantity, unitPriceMinor, variantId, variantVersion }) => ({ quantity, unitPriceMinor, variantId, variantVersion })),
        idempotencyKey: intent.idempotencyKey,
        recoveryEvidence: intent.recoveryEvidence,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body = await readJson<{ order?: { orderId: string; orderToken: string } } & ApiError>(response);
    if (response.ok) {
      if (body.order === undefined) throw new ApiResponseError("checkout_recovery_invalid");
      completeOrder(body.order, intent.customerEmail);
      return true;
    }
    if (body.code !== "checkout_not_found") throw new ApiResponseError(body.code, body.requestId);
    const quoteExpiry = Date.parse(intent.quote.expiresAt);
    if (!Number.isFinite(quoteExpiry) || quoteExpiry <= Date.now()) {
      const refreshedState = await prepare(intent.cart, intent.expected);
      if (refreshedState === null) throw new ApiResponseError("checkout_recovery_expired", body.requestId);
      const refreshedExpected = refreshedState.quote.items.map((item) => ({ ...item }));
      const sameSnapshot = expectedSnapshot(refreshedExpected) === expectedSnapshot(intent.expected);
      if (!sameSnapshot) throw new ApiResponseError("checkout_changed", body.requestId);
      const refreshed = { ...intent, cart: refreshedState.cart, quote: refreshedState.quote, expected: refreshedExpected };
      savePendingIntent(refreshed);
      renderIntent(refreshed);
      return true;
    }
    renderIntent(intent);
    return true;
  } catch (error: unknown) {
    const code = errorCode(error);
    setError(errorMessage(code, errorRequestId(error)), "recover");
    return true;
  }
}

async function initialize(): Promise<void> {
  pendingIntent = readPendingIntent();
  if (pendingIntent !== null && await recoverPendingCheckout()) return;
  await prepareWithRecovery();
}

void initialize();

async function submitCheckout(event: Event): Promise<void> {
  event.preventDefault();
  if (cart === null || quote === null || !(submit instanceof HTMLButtonElement)) return;
  setRecovery(null);
  submit.disabled = true;
  submit.textContent = t("storefront.checkout.creating");
  if (status instanceof HTMLElement) {
    status.textContent = t("storefront.checkout.reserving");
    status.classList.remove("error");
  }
  const tokenInput = document.querySelector('input[name="cf-turnstile-response"]');
  try {
    const intent = await createCheckoutIntent();
    const physical = isPhysicalCart() && selectedShippingMethodId !== null;
    const response = await fetch("/api/store/checkout", {
      body: JSON.stringify({
        cartId: intent.cart.cartId,
        cartToken: intent.cart.cartToken,
        customerEmail: intent.customerEmail,
        expected: intent.expected.map(({ quantity, unitPriceMinor, variantId, variantVersion }) => ({ quantity, unitPriceMinor, variantId, variantVersion })),
        quoteEvidence: intent.quote.quoteEvidence,
        ...(physical ? { shipping: { address: readShippingAddress(), methodId: selectedShippingMethodId } } : {}),
        ...(isBookingCart() && selectedBooking !== null ? { booking: selectedBooking } : {}),
        turnstileToken: tokenInput instanceof HTMLInputElement ? tokenInput.value : undefined,
      }),
      headers: { "Content-Type": "application/json", "Idempotency-Key": intent.idempotencyKey },
      method: "POST",
    });
    const body = await readJson<CheckoutResponse & ApiError>(response);
    if (!response.ok) throw new ApiResponseError(body.code, body.requestId);
    const order = body.order;
    completeOrder(order, intent.customerEmail);
  } catch (error: unknown) {
    const code = errorCode(error);
    setError(errorMessage(code, errorRequestId(error)), recoveryForCheckout(code));
    submit.textContent = t("storefront.checkout.submit");
    const turnstileWindow = window;
    turnstileWindow.turnstile?.reset();
    if (code === "turnstile_invalid" || code === "turnstile_required") {
      setRecovery(null);
      submit.disabled = false;
    }
  }
}

document.querySelector("#checkout-form")?.addEventListener("submit", (event) => {
  void submitCheckout(event);
});

retry?.addEventListener("click", () => {
  if (recoveryAction === "cart") {
    window.location.assign("/cart");
    return;
  }
  if (recoveryAction === "quote") {
    void prepareWithRecovery(cart ?? undefined);
    return;
  }
  if (recoveryAction === "recover") {
    void recoverPendingCheckout();
    return;
  }
  if (recoveryAction === "submit") document.querySelector<HTMLFormElement>("#checkout-form")?.requestSubmit();
});

// ── EX4.1 promo code wiring ──────────────────────────────────────────────
prefillPromoDraft();
promoApplyButton?.addEventListener("click", () => {
  const code = promoInput === null ? "" : promoInput.value.trim().toUpperCase();
  if (code === "" || cart === null) return;
  void (async () => {
    promoApplyButton.disabled = true;
    if (promoStatus !== null) promoStatus.textContent = "";
    const ok = await runPromoMutation({ code, kind: "discount.apply" });
    if (ok) {
      clearPromoDraft();
      if (promoInput !== null) promoInput.value = "";
      await prepareWithRecovery(cart);
    }
    promoApplyButton.disabled = false;
  })();
});
promoInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    promoApplyButton?.click();
  }
});
promoRemoveButton?.addEventListener("click", () => {
  if (cart === null) return;
  void (async () => {
    promoRemoveButton.disabled = true;
    if (promoStatus !== null) promoStatus.textContent = t("storefront.checkout.promo.removing");
    const ok = await runPromoMutation({ kind: "discount.remove" });
    if (ok) {
      clearPromoDraft();
      if (promoStatus !== null) promoStatus.textContent = t("storefront.checkout.promo.removed");
      await prepareWithRecovery(cart);
    }
    promoRemoveButton.disabled = false;
  })();
});
