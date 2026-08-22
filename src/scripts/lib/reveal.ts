/**
 * reveal.ts — the shared IntersectionObserver reveal utility (EX0). Wires the
 * `data-reveal` attribute (dead since the v5 marketing build) once for every
 * surface; children stagger via `--reveal-i`. Completely disabled under
 * prefers-reduced-motion (elements stay visible, no transform).
 */

const SELECTOR = "[data-reveal]";

export function bindReveal(root: ParentNode = document): void {
  if (typeof IntersectionObserver === "undefined") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    for (const element of [...root.querySelectorAll<HTMLElement>(SELECTOR)]) {
      element.dataset.revealState = "visible";
    }
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const element = entry.target as HTMLElement;
      element.dataset.revealState = "visible";
      observer.unobserve(element);
    }
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.08 });
  for (const element of [...root.querySelectorAll<HTMLElement>(SELECTOR)]) {
    if (element.dataset.revealBound === "true") continue;
    element.dataset.revealBound = "true";
    element.dataset.revealState = "hidden";
    const stagger = Number.parseInt(element.dataset.revealStagger ?? "", 10);
    if (Number.isSafeInteger(stagger) && stagger > 0) element.style.setProperty("--reveal-i", String(stagger));
    observer.observe(element);
  }
}
