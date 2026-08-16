/**
 * Scroll-linked staging for landing v4, powered by `motion` (scroll()).
 *
 * Hooks (all optional per page):
 * - `[data-parallax-far]`  — drifts slower than scroll inside the hero (canvas layer).
 * - `[data-parallax-near]` — copy layer: gentle lift + fade as the hero scrolls away.
 * - `[data-flow-section]` + `[data-flow-progress]` — the how-it-works progress rail.
 *
 * Only `transform` and `opacity` are written, and nothing runs under
 * `prefers-reduced-motion`.
 */

import { scroll } from "motion";

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function init(): void {
  if (REDUCED_MOTION) return;

  const far = document.querySelector<HTMLElement>("[data-parallax-far]");
  const near = document.querySelector<HTMLElement>("[data-parallax-near]");
  const hero = document.querySelector<HTMLElement>("[data-hero-root]");

  if (hero !== null && (far !== null || near !== null)) {
    scroll((progress: number) => {
      const p = clamp01(progress);
      if (far !== null) far.style.transform = `translate3d(0, ${(p * 72).toFixed(2)}px, 0)`;
      if (near !== null) {
        near.style.transform = `translate3d(0, ${(-p * 28).toFixed(2)}px, 0)`;
        near.style.opacity = (1 - p * 0.7).toFixed(3);
      }
    }, { target: hero, offset: ["start start", "end start"] });
  }

  const section = document.querySelector<HTMLElement>("[data-flow-section]");
  const rail = document.querySelector<HTMLElement>("[data-flow-progress]");
  if (section !== null && rail !== null) {
    rail.style.transformOrigin = "top center";
    scroll((progress: number) => {
      rail.style.transform = `scaleY(${clamp01(progress).toFixed(4)})`;
    }, { target: section, offset: ["start 0.72", "end 0.55"] });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

export {};
