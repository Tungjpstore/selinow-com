import { orderStateLabel } from "../../lib/storefront/order-view";
import { createStorefrontTranslator } from "../../lib/i18n/catalogs/storefront";

/**
 * Order-history lookup: posts the checkout email (+ Turnstile token) to
 * /api/store/orders/lookup and renders masked summaries. Opening an order
 * routes to the order page where the existing recovery flow grants access.
 */
const t = createStorefrontTranslator(document.documentElement.lang);
const locale = document.documentElement.lang;
const form = document.querySelector<HTMLFormElement>("[data-orders-history-form]");
const emailInput = document.querySelector<HTMLInputElement>("[data-orders-history-email]");
const statusElement = document.querySelector<HTMLElement>("[data-orders-history-status]");
const listElement = document.querySelector<HTMLElement>("[data-orders-history-list]");
const submitButton = document.querySelector<HTMLButtonElement>("[data-orders-history-submit]");

type LookupOrder = {
  createdAt: string;
  currency: string;
  orderId: string;
  orderNumber: string;
  paymentStatus: string;
  status: string;
  totalMinor: number;
};

function formatMoney(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(locale, { currency, style: "currency" }).format(minor / 100);
  } catch {
    return `${String(minor / 100)} ${currency}`;
  }
}

function turnstileToken(): string | undefined {
  const widget = document.querySelector<HTMLInputElement>("[name=cf-turnstile-response]");
  return widget instanceof HTMLInputElement && widget.value !== "" ? widget.value : undefined;
}

function renderOrders(orders: LookupOrder[]): void {
  if (listElement === null) return;
  listElement.replaceChildren();
  if (orders.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-cart";
    empty.textContent = t("storefront.orders_history.empty");
    listElement.appendChild(empty);
    return;
  }
  for (const order of orders) {
    const card = document.createElement("article");
    card.className = "orders-history-card";
    const copy = document.createElement("div");
    copy.className = "orders-history-copy";
    const number = document.createElement("strong");
    number.textContent = `#${order.orderNumber}`;
    copy.appendChild(number);
    const meta = document.createElement("small");
    meta.textContent = `${new Date(order.createdAt).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" })} · ${orderStateLabel(order.status, locale)}`;
    copy.appendChild(meta);
    const status = document.createElement("span");
    status.className = "order-timeline-state info";
    status.textContent = orderStateLabel(order.paymentStatus, locale);
    const total = document.createElement("span");
    total.className = "orders-history-total";
    total.textContent = formatMoney(order.totalMinor, order.currency);
    const view = document.createElement("a");
    view.className = "store-button secondary";
    view.href = `/orders/${order.orderId}`;
    view.textContent = t("storefront.orders_history.view");
    card.appendChild(copy);
    card.appendChild(status);
    card.appendChild(total);
    card.appendChild(view);
    listElement.appendChild(card);
  }
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  void handleLookup();
});

async function handleLookup(): Promise<void> {
  if (!(submitButton instanceof HTMLButtonElement) || !(emailInput instanceof HTMLInputElement)) return;
  const email = emailInput.value.trim();
  if (email === "") return;
  submitButton.disabled = true;
  if (statusElement !== null) statusElement.textContent = t("storefront.orders_history.searching");
  try {
    const response = await fetch("/api/store/orders/lookup", {
      body: JSON.stringify({ email, ...(turnstileToken() !== undefined ? { turnstileToken: turnstileToken() } : {}) }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const body: { code?: string; orders?: LookupOrder[] } = await response.json();
    if (!response.ok) {
      if (statusElement !== null) statusElement.textContent = body.code === "rate_limited"
        ? t("storefront.orders_history.rate_limited")
        : t("storefront.orders_history.error");
      return;
    }
    if (statusElement !== null) statusElement.textContent = "";
    renderOrders(Array.isArray(body.orders) ? body.orders : []);
  } catch {
    if (statusElement !== null) statusElement.textContent = t("storefront.orders_history.error");
  } finally {
    submitButton.disabled = false;
    window.turnstile?.reset();
  }
}

declare global {
  interface Window {
    turnstile?: { reset: (widgetId?: string) => void };
  }
}
