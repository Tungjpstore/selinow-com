import { bindReveal } from "../lib/reveal";
import { countUp } from "../lib/countup";

/**
 * Marketing reveal boot (EX0/EX5): activates the `data-reveal` hooks across
 * the public pages and starts tabular count-ups once their numbers scroll
 * into view. MOTION.md allowlist governs what may carry these attributes;
 * fully inert under prefers-reduced-motion.
 */
bindReveal();

if (typeof IntersectionObserver !== "undefined") {
  const counter = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const element = entry.target as HTMLElement;
      counter.unobserve(element);
      countUp(element);
    }
  }, { threshold: 0.4 });
  for (const element of [...document.querySelectorAll<HTMLElement>("[data-count-to]")]) {
    counter.observe(element);
  }
}
