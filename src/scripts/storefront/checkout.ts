import { formatClientMoney, readCart, readCatalog, saveCart } from "./catalog-dom";
import { createStorefrontTranslator } from "../../lib/i18n/catalogs/storefront";

const locale = document.documentElement.lang || "en";
const t = createStorefrontTranslator(locale);

type ApiError = { code?: string; requestId?: string };
type CartResponse = { cartId: string; cartToken: string; expiresAt?: string };
type QuoteItem = { productTitle: string; quantity: number; unitPriceMinor: number; variantId: string; variantTitle: string; variantVersion: number };
type QuoteResponse = { currency: string; expiresAt: string; items: QuoteItem[]; quoteEvidence: string; totalMinor: number };
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
const status = document.querySelector("#checkout-status");
const retry = document.querySelector("#checkout-retry");
const submit = document.querySelector("#checkout-submit");
const total = document.querySelector("#checkout-total");
let recoveryAction: RecoveryAction | null = null;
let pendingIntent: CheckoutIntent | null = null;

function intentStorageKey(): string {
  return `selinow-checkout-intent:v1:${window.location.host}`;
}

function readPendingIntent(): CheckoutIntent | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(intentStorageKey()) ?? "null") as unknown;
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
  sessionStorage.setItem(intentStorageKey(), JSON.stringify(intent));
}

function clearPendingIntent(): void {
  pendingIntent = null;
  sessionStorage.removeItem(intentStorageKey());
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
  sessionStorage.setItem(`selinow-order-token:v1:${window.location.host}:${order.orderId}`, order.orderToken);
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
  quoteExpiryTimer = window.setTimeout(() => {
    quote = null;
    setError(t("storefront.checkout.quote_expired"), "quote");
  }, Math.max(0, expiresAtMs - Date.now()));
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
    body: JSON.stringify({ cartId: cart.cartId, cartToken: cart.cartToken }),
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
    const response = await fetch("/api/store/checkout", {
      body: JSON.stringify({
        cartId: intent.cart.cartId,
        cartToken: intent.cart.cartToken,
        customerEmail: intent.customerEmail,
        expected: intent.expected.map(({ quantity, unitPriceMinor, variantId, variantVersion }) => ({ quantity, unitPriceMinor, variantId, variantVersion })),
        quoteEvidence: intent.quote.quoteEvidence,
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
    const turnstileWindow = window as typeof window & { turnstile?: { reset: () => void } };
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
