/**
 * Scroll-reveal system for landing v4.
 *
 * Markup contract:
 * - `[data-reveal]` on any element that should animate in.
 * - Optional `data-reveal-group` on a container: its direct `[data-reveal]`
 *   children receive an increasing `--reveal-i` so CSS can stagger them.
 *
 * Progressive enhancement: elements are only hidden while the document carries
 * `data-reveal-ready` (set here before observing). If this script never runs,
 * content renders fully visible with no motion.
 *
 * Each element reveals exactly once; the observer disconnects when the last
 * element has entered the viewport. `prefers-reduced-motion` skips the hiding
 * phase entirely — the CSS transition guard in shell.css neutralises motion.
 */

const MAX_STAGGER_INDEX = 8;

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function assignStaggerIndices(root: ParentNode): void {
  for (const group of root.querySelectorAll<HTMLElement>("[data-reveal-group]")) {
    const children = [...group.querySelectorAll<HTMLElement>(":scope > [data-reveal]")];
    for (const [index, child] of children.entries()) {
      child.style.setProperty("--reveal-i", String(Math.min(index, MAX_STAGGER_INDEX)));
    }
  }
}

function init(): void {
  const targets = [...document.querySelectorAll<HTMLElement>("[data-reveal]")];
  if (targets.length === 0) return;

  assignStaggerIndices(document);

  if (reducedMotion || typeof IntersectionObserver === "undefined") {
    for (const target of targets) target.setAttribute("data-revealed", "");
    return;
  }

  document.documentElement.setAttribute("data-reveal-ready", "");

  let pending = targets.length;
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      (entry.target as HTMLElement).setAttribute("data-revealed", "");
      observer.unobserve(entry.target);
      pending -= 1;
    }
    if (pending === 0) observer.disconnect();
  }, { rootMargin: "0px 0px -12% 0px", threshold: 0.08 });

  for (const target of targets) observer.observe(target);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}

export {};
