import { readCart, saveCart } from "./catalog-dom";
import { createStorefrontTranslator } from "../../lib/i18n/catalogs/storefront";

/**
 * Inline booking slot picker on the service detail page. Loads the public
 * slots API for a 7-day window, groups slots by morning/afternoon/evening,
 * and on "book now" stores a draft slot + routes through the standard cart so
 * the checkout money path stays the single source of truth.
 */
const t = createStorefrontTranslator(document.documentElement.lang);
const picker = document.querySelector<HTMLElement>("[data-slot-picker]");
const daysElement = document.querySelector<HTMLElement>("[data-slot-picker-days]");
const slotsElement = document.querySelector<HTMLElement>("[data-slot-picker-slots]");
const statusElement = document.querySelector<HTMLElement>("[data-slot-picker-status]");
const bookButton = document.querySelector<HTMLButtonElement>("[data-slot-picker-book]");

type Slot = { endAt: string; resourceId: string; resourceName: string; startAt: string };

const DRAFT_KEY = `selinow-booking-draft:v1:${window.location.host}`;
const DAY_COUNT = 7;

function localDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sessionOfDay(hour: number): "afternoon" | "evening" | "morning" {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function sessionLabel(session: "afternoon" | "evening" | "morning"): string {
  if (session === "morning") return t("storefront.slot_picker.session.morning");
  if (session === "afternoon") return t("storefront.slot_picker.session.afternoon");
  return t("storefront.slot_picker.session.evening");
}

function renderDayStrip(activeDate: string): void {
  if (daysElement === null) return;
  daysElement.replaceChildren();
  for (let offset = 0; offset < DAY_COUNT; offset += 1) {
    const date = new Date(Date.now() + offset * 86_400_000);
    const key = localDateKey(date);
    const label = document.createElement("label");
    label.className = "slot-picker-day";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "slotPickerDay";
    input.value = key;
    input.checked = key === activeDate;
    const text = document.createElement("span");
    text.textContent = date.toLocaleDateString(document.documentElement.lang, { weekday: "short", day: "numeric", month: "short" });
    label.appendChild(input);
    label.appendChild(text);
    daysElement.appendChild(label);
  }
}

async function loadSlots(dateKey: string, variantId: string): Promise<void> {
  if (slotsElement === null || statusElement === null) return;
  slotsElement.replaceChildren();
  statusElement.textContent = t("storefront.checkout.booking.loading");
  const dateEnd = localDateKey(new Date(Date.parse(dateKey) + 6 * 86_400_000));
  const params = new URLSearchParams({ dateEnd, dateStart: dateKey, variantId });
  try {
    const response = await fetch(`/api/store/booking/slots?${params.toString()}`);
    const body: { slots?: Slot[] } = await response.json();
    if (!response.ok || !Array.isArray(body.slots)) throw new Error("booking_slots_failed");
    const slots = body.slots.filter((slot) => slot.startAt.slice(0, 10) === dateKey);
    statusElement.textContent = slots.length === 0 ? t("storefront.slot_picker.empty_day") : "";
    let currentSession: "afternoon" | "evening" | "morning" | null = null;
    for (const slot of slots) {
      const session = sessionOfDay(new Date(slot.startAt).getHours());
      if (session !== currentSession) {
        currentSession = session;
        const heading = document.createElement("span");
        heading.className = "booking-slot-day";
        heading.textContent = sessionLabel(session);
        slotsElement.appendChild(heading);
      }
      const label = document.createElement("label");
      label.className = "booking-slot";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "inlineBookingSlot";
      input.value = `${slot.resourceId}|${slot.startAt}`;
      const text = document.createElement("span");
      text.textContent = `${new Date(slot.startAt).toLocaleTimeString(document.documentElement.lang, { hour: "2-digit", minute: "2-digit" })} · ${slot.resourceName}`;
      label.appendChild(input);
      label.appendChild(text);
      slotsElement.appendChild(label);
    }
  } catch {
    statusElement.textContent = t("storefront.checkout.booking.empty");
  }
}

function selectedSlot(): { resourceId: string; startAt: string } | null {
  const checked = document.querySelector<HTMLInputElement>('input[name="inlineBookingSlot"]:checked');
  if (checked === null) return null;
  const separator = checked.value.indexOf("|");
  if (separator <= 0) return null;
  return { resourceId: checked.value.slice(0, separator), startAt: checked.value.slice(separator + 1) };
}

function syncBookButton(): void {
  if (bookButton instanceof HTMLButtonElement) bookButton.disabled = selectedSlot() === null;
}

if (picker !== null && daysElement !== null) {
  const variantId = picker.dataset.variantId ?? "";
  const initialDate = localDateKey(new Date(Date.now() + 86_400_000));
  renderDayStrip(initialDate);
  void loadSlots(initialDate, variantId);
  daysElement.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.name !== "slotPickerDay") return;
    syncBookButton();
    void loadSlots(target.value, variantId);
  });
  picker.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.name === "inlineBookingSlot") {
      const slot = selectedSlot();
      if (slot !== null && statusElement !== null) {
        statusElement.textContent = t("storefront.checkout.booking.selected", { time: new Date(slot.startAt).toLocaleString(document.documentElement.lang) });
      }
      syncBookButton();
    }
  });
  bookButton?.addEventListener("click", () => {
    const slot = selectedSlot();
    if (slot === null) return;
    const cart = readCart();
    const existing = cart.find((item) => item.variantId === variantId);
    if (existing === undefined) cart.push({ quantity: 1, variantId });
    else existing.quantity = 1;
    saveCart(cart);
    try {
      window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ resourceId: slot.resourceId, startAt: slot.startAt, variantId }));
    } catch {
      // Draft is an enhancement; checkout still works without it.
    }
    window.location.assign("/checkout");
  });
}
