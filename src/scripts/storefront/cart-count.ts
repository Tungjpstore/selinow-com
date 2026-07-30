const cartKey = `selinow-cart:v1:${window.location.host}`;

function readCart(): Array<{ quantity?: number; variantId?: string }> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(cartKey) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is { quantity?: number; variantId?: string } => typeof item === "object" && item !== null) : [];
  } catch {
    return [];
  }
}

function updateCartCount(): void {
  const count = readCart().reduce((sum, item) => sum + (Number.isInteger(item.quantity) ? item.quantity ?? 0 : 0), 0);
  const countLabelTemplate = document.body.dataset.cartCountTemplate;
  document.querySelectorAll<HTMLElement>("[data-cart-count]").forEach((element) => {
    element.textContent = String(count);
    if (countLabelTemplate !== undefined) element.setAttribute("aria-label", countLabelTemplate.replace("{count}", String(count)));
  });
}

window.addEventListener("selinow:cart-updated", updateCartCount);
updateCartCount();

document.querySelectorAll<HTMLButtonElement>("[data-cart-add]").forEach((button) => {
  const defaultLabel = button.textContent;
  let restoreTimer: number | undefined;
  button.addEventListener("click", () => {
    if (button.disabled) return;
    const variantId = button.dataset.variantId;
    const maximum = Number.parseInt(button.dataset.maxQuantity ?? "1", 10);
    if (variantId === undefined) return;
    const cart = readCart();
    const existing = cart.find((item) => item.variantId === variantId);
    if (existing === undefined) cart.push({ quantity: 1, variantId });
    else existing.quantity = Math.min(maximum, (existing.quantity ?? 0) + 1);
    localStorage.setItem(cartKey, JSON.stringify(cart));
    if (restoreTimer !== undefined) window.clearTimeout(restoreTimer);
    button.textContent = document.body.dataset.cartAddedLabel ?? defaultLabel;
    restoreTimer = window.setTimeout(() => { button.textContent = defaultLabel; }, 1_200);
    window.dispatchEvent(new Event("selinow:cart-updated"));
  });
});
