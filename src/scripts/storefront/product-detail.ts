import { readCart, saveCart } from "./catalog-dom";
import { createStorefrontTranslator } from "../../lib/i18n/catalogs/storefront";

const t = createStorefrontTranslator(document.documentElement.lang);

const button = document.querySelector("#detail-add");
const quantityInput = document.querySelector("#detail-quantity");
const refreshStatus = document.querySelector("#product-refresh-status");
const selectionStatus = document.querySelector("#variant-selection-status");
const variantInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="variant"]')];
let snapshotFresh = false;

type ProductApiResponse = {
  product?: {
    version: number;
    variants: Array<{ id: string; priceMinor: number; stockState: string; version: number }>;
  };
  requestId?: string;
};

function selectedVariant(): HTMLInputElement | null {
  const selected = document.querySelector('input[name="variant"]:checked');
  return selected instanceof HTMLInputElement ? selected : null;
}

function quantityBounds(selected: HTMLInputElement): { maximum: number; minimum: number } {
  const parsedMinimum = Number.parseInt(selected.dataset.min ?? "1", 10);
  const minimum = Number.isSafeInteger(parsedMinimum) && parsedMinimum > 0 ? parsedMinimum : 1;
  const parsedMaximum = Number.parseInt(selected.dataset.max ?? String(minimum), 10);
  const maximum = Number.isSafeInteger(parsedMaximum) && parsedMaximum >= minimum ? parsedMaximum : minimum;
  return {
    maximum,
    minimum,
  };
}

function syncPurchaseControls(announce = false): void {
  if (!(button instanceof HTMLButtonElement) || !(quantityInput instanceof HTMLInputElement)) return;
  const selected = selectedVariant();
  if (selected === null || selected.disabled || selected.dataset.stockState === "out_of_stock") {
    button.disabled = true;
    button.textContent = t("storefront.product.sold_out");
    return;
  }
  const { maximum, minimum } = quantityBounds(selected);
  quantityInput.min = String(minimum);
  quantityInput.max = String(maximum);
  const requested = Number.parseInt(quantityInput.value, 10);
  const quantity = Number.isSafeInteger(requested) ? Math.min(maximum, Math.max(minimum, requested)) : minimum;
  quantityInput.value = String(quantity);
  button.disabled = !snapshotFresh;
  button.textContent = snapshotFresh ? t("storefront.product.add") : t("storefront.product.refreshing");
  if (announce && selectionStatus instanceof HTMLElement) {
    const labelElement = selected.closest("label")?.querySelector("strong");
    const label = (labelElement?.textContent ?? "").trim() || t("storefront.product.variant_aria");
    selectionStatus.textContent = t("storefront.product.selected", { maximum, minimum, variant: label });
  }
}

async function verifyProductSnapshot(): Promise<void> {
  if (!(refreshStatus instanceof HTMLElement)) return;
  const slug = refreshStatus.dataset.productSlug;
  if (slug === undefined) return;
  snapshotFresh = false;
  syncPurchaseControls();
  try {
    const response = await fetch(`/api/store/products/${encodeURIComponent(slug)}`, { cache: "no-store" });
    const body: ProductApiResponse = await response.json();
    if (!response.ok || body.product === undefined) {
      refreshStatus.hidden = false;
      refreshStatus.dataset.tone = "warning";
      refreshStatus.textContent = body.requestId === undefined
        ? t("storefront.product.refresh_failed")
        : t("storefront.product.refresh_failed_request", { requestId: body.requestId });
      syncPurchaseControls();
      return;
    }
    const serverVariants = new Map(body.product.variants.map((variant) => [variant.id, variant]));
    const localVariantIds = new Set(variantInputs.map((input) => input.value));
    const productChanged = String(body.product.version) !== refreshStatus.dataset.productVersion;
    const variantChanged = serverVariants.size !== localVariantIds.size || [...document.querySelectorAll<HTMLInputElement>('input[name="variant"]')].some((input) => {
      const current = serverVariants.get(input.value);
      return current === undefined
        || String(current.version) !== input.dataset.version
        || String(current.priceMinor) !== input.dataset.priceMinor
        || current.stockState !== input.dataset.stockState;
    });
    if (productChanged || variantChanged) {
      refreshStatus.hidden = false;
      refreshStatus.dataset.tone = "warning";
      refreshStatus.replaceChildren();
      const message = document.createElement("span");
      message.textContent = t("storefront.product.changed");
      const reload = document.createElement("button");
      reload.type = "button";
      reload.textContent = t("storefront.product.reload");
      reload.addEventListener("click", () => { window.location.reload(); });
      refreshStatus.appendChild(message);
      refreshStatus.appendChild(reload);
      syncPurchaseControls();
      return;
    }
    snapshotFresh = true;
    syncPurchaseControls();
  } catch {
    refreshStatus.hidden = false;
    refreshStatus.dataset.tone = "warning";
    refreshStatus.textContent = t("storefront.product.network_error");
    syncPurchaseControls();
  }
}

button?.addEventListener("click", () => {
  if (!(button instanceof HTMLButtonElement) || !(quantityInput instanceof HTMLInputElement) || !snapshotFresh) return;
  const selected = selectedVariant();
  if (selected === null || selected.disabled || selected.dataset.stockState === "out_of_stock") return;
  const { maximum, minimum } = quantityBounds(selected);
  const quantity = Math.min(maximum, Math.max(minimum, Number.parseInt(quantityInput.value, 10) || minimum));
  quantityInput.value = String(quantity);
  const cart = readCart();
  const existing = cart.find((item) => item.variantId === selected.value);
  if (existing === undefined) cart.push({ quantity, variantId: selected.value });
  else existing.quantity = Math.min(maximum, existing.quantity + quantity);
  saveCart(cart);
  button.textContent = t("storefront.product.added");
  if (selectionStatus instanceof HTMLElement) selectionStatus.textContent = t("storefront.product.added_count", { count: quantity });
  window.setTimeout(() => { syncPurchaseControls(); }, 1_200);
});

for (const input of variantInputs) input.addEventListener("change", () => { syncPurchaseControls(true); });
quantityInput?.addEventListener("change", () => { syncPurchaseControls(true); });

void verifyProductSnapshot();
