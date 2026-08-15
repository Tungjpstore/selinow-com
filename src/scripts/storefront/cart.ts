import { formatClientMoney, readCart, readCatalog, saveCart, type CartEntry } from "./catalog-dom";
import { classifyCartQuote, type ServerQuoteItem } from "../../lib/storefront/cart-quote";
import { createStorefrontTranslator } from "../../lib/i18n/catalogs/storefront";

const catalog = readCatalog();
const locale = document.documentElement.lang || "en";
const t = createStorefrontTranslator(locale);
type ApiError = { code?: string; requestId?: string };
type CartResponse = { cartId: string; cartToken: string };
type QuoteResponse = { currency: string; expiresAt: string; items: ServerQuoteItem[]; totalMinor: number };

class ApiResponseError extends Error {
  readonly code: string | undefined;
  readonly requestId: string | undefined;

  constructor(code: string | undefined, requestId: string | undefined) {
    super(code ?? "api_response_error");
    this.code = code;
    this.requestId = requestId;
  }
}

let quoteGeneration = 0;
let quoteTimer: number | undefined;
let quoteExpiryTimer: number | undefined;
let quoteController: AbortController | null = null;

function setCheckoutEnabled(enabled: boolean): void {
  const checkout = document.querySelector("#checkout-link");
  if (!(checkout instanceof HTMLAnchorElement)) return;
  checkout.setAttribute("aria-disabled", enabled ? "false" : "true");
  checkout.classList.toggle("is-disabled", !enabled);
}

function setQuoteState(input: {
  detail: string;
  state: "empty" | "item_changed" | "loading" | "out_of_stock" | "price_changed" | "quote_failed" | "ready" | "stock_changed";
  title: string;
}): void {
  const status = document.querySelector("#cart-quote-status");
  if (!(status instanceof HTMLElement)) return;
  status.dataset.state = input.state;
  status.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = input.title;
  const detail = document.createElement("span");
  detail.textContent = input.detail;
  status.appendChild(title);
  status.appendChild(detail);
}

function armQuoteExpiry(expiresAt: string, generation: number): void {
  if (quoteExpiryTimer !== undefined) window.clearTimeout(quoteExpiryTimer);
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    if (generation !== quoteGeneration) return;
    setCheckoutEnabled(false);
    setQuoteState({ detail: t("storefront.cart.quote_expired_detail"), state: "quote_failed", title: t("storefront.cart.quote_expired_title") });
    const retry = document.querySelector("#cart-quote-retry");
    if (retry instanceof HTMLButtonElement) retry.hidden = false;
    return;
  }
  const delay = expiresAtMs - Date.now();
  if (delay > 2_147_483_647) return;
  quoteExpiryTimer = window.setTimeout(() => {
    if (generation !== quoteGeneration) return;
    setCheckoutEnabled(false);
    setQuoteState({ detail: t("storefront.cart.quote_expired_detail"), state: "quote_failed", title: t("storefront.cart.quote_expired_title") });
    const retry = document.querySelector("#cart-quote-retry");
    if (retry instanceof HTMLButtonElement) retry.hidden = false;
  }, delay);
}

function errorState(error: unknown): void {
  if (quoteExpiryTimer !== undefined) window.clearTimeout(quoteExpiryTimer);
  const code = error instanceof ApiResponseError ? error.code : undefined;
  const requestSuffix = error instanceof ApiResponseError && error.requestId !== undefined
    ? t("storefront.support_code", { requestId: error.requestId })
    : "";
  if (code === "quote_expired") {
    setQuoteState({
      detail: t("storefront.cart.quote_expired_detail"),
      state: "quote_failed",
      title: t("storefront.cart.quote_expired_title"),
    });
  } else if (code === "quote_invalid") {
    setQuoteState({
      detail: t("storefront.cart.quote_invalid_detail"),
      state: "quote_failed",
      title: t("storefront.cart.quote_invalid_title"),
    });
  } else if (code === "inventory_unavailable") {
    setQuoteState({
      detail: t("storefront.cart.inventory_detail"),
      state: "out_of_stock",
      title: t("storefront.cart.inventory_title"),
    });
  } else if (code === "quantity_unavailable") {
    setQuoteState({
      detail: t("storefront.cart.quantity_detail"),
      state: "stock_changed",
      title: t("storefront.cart.quantity_title"),
    });
  } else if (code === "catalog_changed") {
    setQuoteState({
      detail: t("storefront.cart.catalog_detail"),
      state: "item_changed",
      title: t("storefront.cart.catalog_title"),
    });
  } else {
    setQuoteState({
      detail: t("storefront.cart.quote_failed_detail", { support: requestSuffix }),
      state: "quote_failed",
      title: code === "rate_limited" ? t("storefront.cart.rate_title") : t("storefront.cart.quote_failed_title"),
    });
  }
  setCheckoutEnabled(false);
  const retry = document.querySelector("#cart-quote-retry");
  if (retry instanceof HTMLButtonElement) retry.hidden = false;
}

async function readJson<T>(response: Response): Promise<T> {
  return response.json();
}

function quoteMatchesCart(items: CartEntry[], quoteItems: ServerQuoteItem[]): boolean {
  if (items.length !== quoteItems.length) return false;
  const expected = new Map(items.map((item) => [item.variantId, item.quantity]));
  const seen = new Set<string>();
  for (const item of quoteItems) {
    if (seen.has(item.variantId) || expected.get(item.variantId) !== item.quantity) return false;
    seen.add(item.variantId);
  }
  return seen.size === expected.size;
}

async function quoteCart(items: CartEntry[], localItemChanged: boolean, generation: number): Promise<void> {
  quoteController?.abort();
  const controller = new AbortController();
  quoteController = controller;
  setCheckoutEnabled(false);
  const retry = document.querySelector("#cart-quote-retry");
  if (retry instanceof HTMLButtonElement) retry.hidden = true;
  setQuoteState({ detail: t("storefront.cart.quote_loading_detail"), state: "loading", title: t("storefront.cart.quote_loading_title") });
  try {
    const cartResponse = await fetch("/api/store/cart", {
      body: JSON.stringify({ items, locale }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
    const cartBody = await readJson<CartResponse & ApiError>(cartResponse);
    if (!cartResponse.ok) throw new ApiResponseError(cartBody.code, cartBody.requestId);
    const quoteResponse = await fetch("/api/store/quote", {
      body: JSON.stringify({ cartId: cartBody.cartId, cartToken: cartBody.cartToken }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: controller.signal,
    });
    const quoteBody = await readJson<{ quote: QuoteResponse } & ApiError>(quoteResponse);
    if (!quoteResponse.ok) throw new ApiResponseError(quoteBody.code, quoteBody.requestId);
    if (generation !== quoteGeneration) return;
    const quote = quoteBody.quote;
    const expiresAtMs = Date.parse(quote.expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) throw new ApiResponseError("quote_expired", quoteBody.requestId);
    if (!quoteMatchesCart(items, quote.items)) throw new ApiResponseError("quote_invalid", quoteBody.requestId);
    for (const quotedItem of quote.items) {
      const row = [...document.querySelectorAll<HTMLElement>("[data-cart-variant-id]")]
        .find((candidate) => candidate.dataset.cartVariantId === quotedItem.variantId);
      const title = row?.querySelector<HTMLElement>("[data-cart-item-title]");
      const meta = row?.querySelector<HTMLElement>("[data-cart-item-meta]");
      if (title !== null && title !== undefined) title.textContent = quotedItem.productTitle;
      if (meta !== null && meta !== undefined) {
        meta.textContent = `${quotedItem.variantTitle} · ${formatClientMoney(quotedItem.unitPriceMinor, quote.currency)}`;
      }
    }
    const total = document.querySelector("#cart-total");
    if (total !== null) total.textContent = formatClientMoney(quote.totalMinor, quote.currency);
    const localVariants = new Map([...catalog].map(([id, variant]) => [id, {
      priceMinor: variant.priceMinor,
      productTitle: variant.productTitle,
      variantTitle: variant.variantTitle,
      version: variant.version,
    }]));
    const change = classifyCartQuote(localVariants, quote.items);
    const heldUntil = new Date(expiresAtMs).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    if (change === "price_changed") {
      setQuoteState({ detail: t("storefront.cart.price_changed_detail", { time: heldUntil }), state: "price_changed", title: t("storefront.cart.price_changed_title") });
    } else if (change === "item_changed" || localItemChanged) {
      setQuoteState({ detail: t("storefront.cart.item_changed_detail", { time: heldUntil }), state: "item_changed", title: t("storefront.cart.item_changed_title") });
    } else {
      setQuoteState({ detail: t("storefront.cart.ready_detail", { time: heldUntil }), state: "ready", title: t("storefront.cart.ready_title") });
    }
    armQuoteExpiry(quote.expiresAt, generation);
    setCheckoutEnabled(true);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (generation !== quoteGeneration) return;
    errorState(error);
  }
}

function scheduleQuote(items: CartEntry[], localItemChanged: boolean): void {
  quoteGeneration += 1;
  const generation = quoteGeneration;
  if (quoteTimer !== undefined) window.clearTimeout(quoteTimer);
  quoteTimer = window.setTimeout(() => { void quoteCart(items, localItemChanged, generation); }, 120);
}

function normalizeLocalCart(items: CartEntry[]): CartEntry[] {
  const merged = new Map<string, number>();
  for (const item of items) merged.set(item.variantId, (merged.get(item.variantId) ?? 0) + item.quantity);
  return [...merged].map(([variantId, quantity]) => ({ quantity, variantId }));
}

function render(): void {
  const raw = readCart();
  const normalized = normalizeLocalCart(raw);
  const valid = normalized.filter((item) => catalog.has(item.variantId));
  const container = document.querySelector("#cart-items");
  const empty = document.querySelector("#cart-empty");
  if (!(container instanceof HTMLElement) || !(empty instanceof HTMLElement)) return;
  container.replaceChildren();
  let localItemChanged = raw.length !== valid.length || raw.length !== normalized.length;
  for (const item of valid) {
    const variant = catalog.get(item.variantId);
    if (variant === undefined) continue;
    const normalizedQuantity = Math.min(variant.maxQuantity, Math.max(variant.minQuantity, item.quantity));
    if (normalizedQuantity !== item.quantity) localItemChanged = true;
    item.quantity = normalizedQuantity;
    const row = document.createElement("article");
    row.className = "cart-item";
    row.dataset.cartVariantId = item.variantId;
    const copy = document.createElement("div");
    const title = document.createElement("h2");
    title.dataset.cartItemTitle = "";
    title.textContent = variant.productTitle;
    const meta = document.createElement("p");
    meta.dataset.cartItemMeta = "";
    meta.textContent = `${variant.variantTitle} · ${formatClientMoney(variant.priceMinor, variant.currency)}`;
    copy.appendChild(title);
    copy.appendChild(meta);
    const controls = document.createElement("div");
    controls.className = "cart-item-controls";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    minus.setAttribute("aria-label", t("storefront.cart.decrease", { product: variant.productTitle }));
    minus.disabled = item.quantity <= variant.minQuantity;
    const output = document.createElement("output");
    output.textContent = String(item.quantity);
    output.setAttribute("aria-live", "polite");
    output.setAttribute("aria-label", t("storefront.cart.quantity_aria", { product: variant.productTitle }));
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", t("storefront.cart.increase", { product: variant.productTitle }));
    plus.disabled = item.quantity >= variant.maxQuantity;
    minus.addEventListener("click", () => {
      if (item.quantity <= variant.minQuantity) return;
      item.quantity -= 1;
      saveCart(valid.filter((entry: CartEntry) => entry.quantity > 0));
      render();
    });
    plus.addEventListener("click", () => {
      if (item.quantity >= variant.maxQuantity) return;
      item.quantity = Math.min(variant.maxQuantity, item.quantity + 1);
      saveCart(valid);
      render();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cart-remove";
    remove.textContent = t("storefront.cart.remove");
    remove.setAttribute("aria-label", t("storefront.cart.remove_aria", { product: variant.productTitle }));
    remove.addEventListener("click", () => {
      saveCart(valid.filter((entry) => entry.variantId !== item.variantId));
      render();
    });
    controls.appendChild(minus);
    controls.appendChild(output);
    controls.appendChild(plus);
    controls.appendChild(remove);
    row.appendChild(copy);
    row.appendChild(controls);
    container.appendChild(row);
  }
  saveCart(valid);
  empty.hidden = valid.length > 0;
  const checkout = document.querySelector("#checkout-link");
  if (checkout instanceof HTMLAnchorElement) checkout.hidden = valid.length === 0;
  const totalElement = document.querySelector("#cart-total");
  if (totalElement !== null) totalElement.textContent = valid.length === 0 ? "—" : t("storefront.checking");
  if (valid.length === 0) {
    quoteGeneration += 1;
    if (quoteExpiryTimer !== undefined) window.clearTimeout(quoteExpiryTimer);
    quoteController?.abort();
    setCheckoutEnabled(false);
    setQuoteState({ detail: t("storefront.cart.no_items_detail"), state: "empty", title: t("storefront.cart.no_items_title") });
    const retry = document.querySelector("#cart-quote-retry");
    if (retry instanceof HTMLButtonElement) retry.hidden = true;
  } else scheduleQuote(valid, localItemChanged);
}

document.querySelector("#checkout-link")?.addEventListener("click", (event) => {
  const link = event.currentTarget;
  if (link instanceof HTMLAnchorElement && link.getAttribute("aria-disabled") === "true") event.preventDefault();
});

document.querySelector("#cart-quote-retry")?.addEventListener("click", () => { render(); });

render();
