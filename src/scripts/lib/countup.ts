/**
 * countup.ts — tabular number ticker (EX6 table): animates a numeric text
 * node from 0 (or its data-count-from) to data-count-to over 400ms with
 * 8 frames; under prefers-reduced-motion the final value lands immediately.
 * The element keeps `font-variant-numeric: tabular-nums` (CSS side).
 */

const DURATION_MS = 400;

function format(value: number, decimals: number, locale: string): string {
  return value.toLocaleString(locale, { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

export function countUp(element: HTMLElement, locale = document.documentElement.lang): void {
  const to = Number.parseFloat(element.dataset.countTo ?? "");
  if (!Number.isFinite(to)) return;
  const from = Number.parseFloat(element.dataset.countFrom ?? "0");
  if (!Number.isFinite(from)) return;
  const decimals = Number.parseInt(element.dataset.countDecimals ?? "0", 10) || 0;
  const suffix = element.dataset.countSuffix ?? "";
  const prefix = element.dataset.countPrefix ?? "";
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.textContent = `${prefix}${format(to, decimals, locale)}${suffix}`;
    return;
  }
  const startedAt = performance.now();
  const step = (): void => {
    const progress = Math.min(1, (performance.now() - startedAt) / DURATION_MS);
    const eased = 1 - (1 - progress) ** 3;
    const value = from + (to - from) * eased;
    element.textContent = `${prefix}${format(value, decimals, locale)}${suffix}`;
    if (progress < 1) window.requestAnimationFrame(step);
  };
  window.requestAnimationFrame(step);
}
