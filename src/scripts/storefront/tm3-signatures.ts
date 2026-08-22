/**
 * TM3 signature moments — one bundle, loaded per-surface by template id:
 *  - Swift: instant-search dropdown over the existing client filter.
 *  - Pulse: flash-rail per-card countdowns from active promotions.
 *  - Aurora: quick-add size popover on product cards (options swatches).
 *  - Metro: spec-peek hover overlay (first attributes from CatalogData).
 *  - Bustle: stock progress bars when exact stock is available.
 *  - Booking (serenity/craft/clinic): next-open-slot chip from the public
 *    slots API on the first bookable service.
 * Every behavior is inert under prefers-reduced-motion and degrades to a
 * no-op when its data attributes are absent.
 */
import { readCart, saveCart } from "./catalog-dom";

const template = document.documentElement.dataset.storefrontTemplate ?? "";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── Swift: instant-search dropdown ──────────────────────────────────────── */
function bindInstantSearch(): void {
  const form = document.querySelector<HTMLFormElement>("[data-store-search-form]");
  const input = document.querySelector<HTMLInputElement>("[data-store-search-input]");
  if (form === null || input === null) return;
  const existing = document.querySelector<HTMLElement>("[data-search-instant-results]");
  if (existing !== null) return;
  const list = document.createElement("ul");
  list.className = "instant-search-results";
  list.setAttribute("data-search-instant-results", "");
  list.setAttribute("role", "listbox");
  list.hidden = true;
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-autocomplete", "list");
  input.insertAdjacentElement("afterend", list);

  const cards = [...document.querySelectorAll<HTMLElement>("[data-product-card]")];
  const render = (): void => {
    const query = input.value.trim().toLocaleLowerCase();
    list.replaceChildren();
    if (query === "") {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      return;
    }
    const matches = cards
      .filter((card) => (card.dataset.searchText ?? "").toLocaleLowerCase().includes(query))
      .slice(0, 5);
    for (const card of matches) {
      const link = card.querySelector<HTMLAnchorElement>(".product-copy h2 a");
      if (link === null) continue;
      const title = link.textContent;
      const price = card.querySelector<HTMLElement>(".product-buy-row strong");
      const item = document.createElement("li");
      item.setAttribute("role", "option");
      const anchor = document.createElement("a");
      anchor.href = link.href;
      const thumb = document.createElement("span");
      thumb.className = "instant-search-thumb";
      thumb.textContent = title.slice(0, 1).toUpperCase();
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = title;
      copy.appendChild(name);
      if (price !== null) {
        const priceLine = document.createElement("small");
        priceLine.textContent = price.textContent;
        copy.appendChild(priceLine);
      }
      anchor.appendChild(thumb);
      anchor.appendChild(copy);
      anchor.addEventListener("click", () => {
        list.hidden = true;
        input.setAttribute("aria-expanded", "false");
      });
      item.appendChild(anchor);
      list.appendChild(item);
    }
    list.hidden = matches.length === 0;
    input.setAttribute("aria-expanded", String(matches.length > 0));
  };
  input.addEventListener("input", render);
  input.addEventListener("focus", render);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("click", (event) => {
    if (list.hidden) return;
    if (event.target instanceof Node && list.contains(event.target)) return;
    if (event.target === input) return;
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
  });
}

/* ── Pulse: flash-rail per-card countdowns ───────────────────────────────── */
function bindFlashCountdowns(): void {
  const clocks = [...document.querySelectorAll<HTMLElement>("[data-flash-countdown]")];
  if (clocks.length === 0) return;
  const update = (): void => {
    const now = Date.now();
    for (const clock of clocks) {
      const endsAt = Date.parse(clock.dataset.flashCountdown ?? "");
      if (!Number.isFinite(endsAt)) {
        clock.closest("[data-flash-card]")?.remove();
        continue;
      }
      const remaining = endsAt - now;
      if (remaining <= 0) {
        clock.closest("[data-flash-card]")?.remove();
        continue;
      }
      const totalSeconds = Math.floor(remaining / 1_000);
      const hours = String(Math.floor(totalSeconds / 3_600)).padStart(2, "0");
      const minutes = String(Math.floor((totalSeconds % 3_600) / 60)).padStart(2, "0");
      const seconds = String(totalSeconds % 60).padStart(2, "0");
      clock.textContent = `${hours}:${minutes}:${seconds}`;
    }
  };
  update();
  if (!reducedMotion) window.setInterval(update, 1_000);
}

/* ── Aurora: quick-add size popover ──────────────────────────────────────── */
function bindQuickAdd(): void {
  for (const card of [...document.querySelectorAll<HTMLElement>("[data-product-card]")]) {
    const variantsJson = card.dataset.quickAddVariants;
    if (variantsJson === undefined) continue;
    let variants: Array<{ id: string; label: string; max: number }>;
    try {
      variants = JSON.parse(variantsJson) as Array<{ id: string; label: string; max: number }>;
    } catch {
      continue;
    }
    if (!Array.isArray(variants) || variants.length === 0) continue;
    const buyRow = card.querySelector<HTMLElement>(".product-buy-row");
    if (buyRow === null) continue;
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "quick-add-trigger";
    trigger.textContent = "＋";
    trigger.setAttribute("aria-haspopup", "true");
    trigger.setAttribute("aria-expanded", "false");
    const pop = document.createElement("div");
    pop.className = "quick-add-pop";
    pop.setAttribute("role", "menu");
    pop.hidden = true;
    for (const variant of variants) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "quick-add-option";
      option.setAttribute("role", "menuitem");
      option.textContent = variant.label;
      option.addEventListener("click", () => {
        const cart: Array<{ quantity: number; variantId: string }> = readCart();
        const existing = cart.find((entry) => entry.variantId === variant.id);
        if (existing === undefined) cart.push({ quantity: 1, variantId: variant.id });
        else existing.quantity = Math.min(variant.max, existing.quantity + 1);
        saveCart(cart);
        pop.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        trigger.textContent = "✓";
        window.setTimeout(() => { trigger.textContent = "＋"; }, 1_200);
      });
      pop.appendChild(option);
    }
    trigger.addEventListener("click", () => {
      pop.hidden = !pop.hidden;
      trigger.setAttribute("aria-expanded", String(!pop.hidden));
    });
    buyRow.appendChild(trigger);
    buyRow.appendChild(pop);
  }
  document.addEventListener("click", (event) => {
    for (const pop of [...document.querySelectorAll<HTMLElement>(".quick-add-pop")]) {
      if (pop.hidden) continue;
      if (event.target instanceof Node && pop.contains(event.target)) continue;
      if (event.target instanceof Node && pop.previousElementSibling?.contains(event.target)) continue;
      pop.hidden = true;
      pop.previousElementSibling?.setAttribute("aria-expanded", "false");
    }
  });
}

/* ── Metro: spec-peek hover overlay ──────────────────────────────────────── */
function bindSpecPeek(): void {
  for (const card of [...document.querySelectorAll<HTMLElement>("[data-spec-peek]")]) {
    const lines = card.dataset.specPeek ?? "";
    if (lines.length === 0) continue;
    const overlay = document.createElement("div");
    overlay.className = "spec-peek-overlay";
    overlay.setAttribute("aria-hidden", "true");
    for (const line of lines.split("|").slice(0, 3)) {
      const row = document.createElement("span");
      row.textContent = line;
      overlay.appendChild(row);
    }
    card.appendChild(overlay);
  }
}

/* ── Bustle: stock progress bars ─────────────────────────────────────────── */
function bindStockBars(): void {
  for (const card of [...document.querySelectorAll<HTMLElement>("[data-stock-total]")]) {
    const total = Number.parseInt(card.dataset.stockTotal ?? "0", 10);
    if (!Number.isSafeInteger(total) || total <= 0) continue;
    const available = Number.parseInt(card.dataset.stockAvailable ?? "0", 10);
    if (!Number.isSafeInteger(available) || available < 0) continue;
    const visual = card.querySelector<HTMLElement>(".product-visual");
    if (visual === null) continue;
    const bar = document.createElement("div");
    bar.className = "stock-progress";
    bar.setAttribute("role", "img");
    const fill = document.createElement("span");
    const ratio = Math.max(0.04, Math.min(1, available / total));
    fill.style.width = `${String(Math.round(ratio * 100))}%`;
    if (ratio <= 0.25) fill.classList.add("is-low");
    bar.appendChild(fill);
    visual.appendChild(bar);
  }
}

/* ── Booking: next-open-slot chip ────────────────────────────────────────── */
async function bindNextSlotChip(): Promise<void> {
  const anchor = document.querySelector<HTMLElement>("[data-next-slot-chip]");
  const variantId = anchor?.dataset.nextSlotVariant;
  if (anchor === null || variantId === undefined) return;
  const label = anchor.querySelector<HTMLElement>("[data-next-slot-label]");
  try {
      const dateStart = new Date().toISOString().slice(0, 10);
      const dateEnd = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      const params = new URLSearchParams({ dateEnd, dateStart, variantId });
      const response = await fetch(`/api/store/booking/slots?${params.toString()}`);
      if (!response.ok) return;
      const body: { slots?: Array<{ startAt: string }> } = await response.json();
      const first = body.slots?.[0];
      if (first === undefined) {
        if (label !== null) label.textContent = anchor.dataset.nextSlotEmpty ?? "";
        return;
      }
      const when = new Intl.DateTimeFormat(document.documentElement.lang, { day: "numeric", hour: "2-digit", minute: "2-digit", month: "short" }).format(new Date(first.startAt));
      if (label !== null) label.textContent = `${anchor.dataset.nextSlotPrefix ?? ""} ${when}`;
      anchor.classList.add("has-slot");
  } catch {
    // Network failures leave the chip hidden — never a fake slot.
  }
}

const behaviors: Record<string, Array<() => void>> = {
  aurora: [bindQuickAdd],
  booking: [bindNextSlotChip],
  bustle: [bindStockBars],
  metro: [bindSpecPeek],
  pulse: [bindFlashCountdowns],
  swift: [bindInstantSearch],
};
const vertical = document.documentElement.dataset.storefrontVertical ?? "";
if (vertical === "booking") {
  void bindNextSlotChip();
} else {
  for (const behavior of behaviors[template] ?? []) behavior();
}
