import { createStorefrontTranslator } from "../../lib/i18n/catalogs/storefront";

/**
 * One-tap voucher copy for Bustle deal chips. Clipboard write with a spoken
 * confirmation; the code stays selectable text when the API is unavailable.
 */
const t = createStorefrontTranslator(document.documentElement.lang);

async function copyVoucher(chip: HTMLButtonElement): Promise<void> {
  const code = chip.dataset.voucherCode ?? "";
  if (code === "") return;
  try {
    await navigator.clipboard.writeText(code);
    try {
      window.sessionStorage.setItem(`selinow-promo-draft:v1:${window.location.host}`, code);
    } catch {
      // Draft prefill is an enhancement only.
    }
    const original = chip.getAttribute("aria-label") ?? code;
    chip.setAttribute("aria-label", `${original} · ${t("storefront.promo.copied")}`);
    const feedback = chip.querySelector("[data-voucher-feedback]") ?? document.createElement("span");
    feedback.textContent = t("storefront.promo.copied");
    feedback.setAttribute("data-voucher-feedback", "");
    if (!chip.contains(feedback)) chip.appendChild(feedback);
    window.setTimeout(() => { feedback.textContent = ""; }, 2_000);
  } catch {
    // Selection-copy remains available; never block the tap.
  }
}

for (const chip of [...document.querySelectorAll<HTMLButtonElement>("[data-voucher-code]")]) {
  chip.addEventListener("click", () => { void copyVoucher(chip); });
}
