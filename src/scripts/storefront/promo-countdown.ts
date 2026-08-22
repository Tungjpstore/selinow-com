import { createStorefrontTranslator } from "../../lib/i18n/catalogs/storefront";

/**
 * Live countdown upgrade for [data-countdown-until]. The server-rendered
 * static deadline line stays visible without JS and under reduced motion.
 */
const t = createStorefrontTranslator(document.documentElement.lang);
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function formatClock(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function tick(clock: HTMLElement, endsAtMs: number): void {
  const remaining = endsAtMs - Date.now();
  if (remaining <= 0) {
    clock.closest("[data-countdown-until]")?.remove();
    return;
  }
  clock.textContent = formatClock(remaining);
}

const clocks = [...document.querySelectorAll<HTMLElement>("[data-countdown-until]")];
for (const container of clocks) {
  const endsAt = Date.parse(container.dataset.countdownUntil ?? "");
  const clock = container.querySelector<HTMLElement>("[data-countdown-clock]");
  if (!Number.isFinite(endsAt) || clock === null) continue;
  if (reducedMotion) {
    clock.remove();
    continue;
  }
  tick(clock, endsAt);
  window.setInterval(() => { tick(clock, endsAt); }, 1_000);
  container.title = t("storefront.promo.sr_deadline");
}
