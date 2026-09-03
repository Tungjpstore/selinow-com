/**
 * flow-scene.ts — LP editorial scrollytelling coordinator (LP1).
 *
 * The flow chapter keeps a sticky visual pane on the right while the five
 * stage texts scroll past on the left. This script mirrors scroll position
 * onto `data-flow-scene` so CSS can cross-fade the scene layers and photos.
 * Everything is progress-on-scroll: no autoplay, no looping; fully inert
 * under prefers-reduced-motion (all scenes stay stacked visible in a
 * simple list per the reduced-motion stylesheet).
 */

const CHAPTER_SELECTOR = "[data-flow-chapter]";
const SCENE_SELECTOR = "[data-flow-scene]";

function indexForProgress(stages: DOMRect[], viewportMid: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, rect] of stages.entries()) {
    const center = rect.top + rect.height / 2;
    const distance = Math.abs(center - viewportMid);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

function bootFlowChapter(chapter: HTMLElement): void {
  const scene = chapter.querySelector<HTMLElement>(SCENE_SELECTOR);
  const stages = [...chapter.querySelectorAll<HTMLElement>("[data-flow-stage]")];
  if (scene === null || stages.length === 0) return;

  const update = (): void => {
    const viewportMid = window.innerHeight * 0.42;
    const active = indexForProgress(stages.map((stage) => stage.getBoundingClientRect()), viewportMid);
    scene.dataset.flowActive = String(active);
    for (const [index, stage] of stages.entries()) {
      stage.dataset.flowState = index === active ? "active" : index < active ? "passed" : "upcoming";
    }
  };

  let ticking = false;
  const onScroll = (): void => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(() => {
      ticking = false;
      update();
    });
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  update();
}

if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  for (const chapter of [...document.querySelectorAll<HTMLElement>(CHAPTER_SELECTOR)]) {
    bootFlowChapter(chapter);
  }
}
