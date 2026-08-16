/**
 * Hero transaction-lifecycle player (landing v4).
 *
 * The hero product mock walks a real checkout story — message received,
 * order created, payment verified, key allocated, delivered — by advancing a
 * `data-lifecycle-step` attribute on `[data-lifecycle]`. CSS owns the visual
 * choreography per step; this module only owns timing.
 *
 * Runtime guards:
 * - Starts when the panel enters the viewport, stops fully when it leaves
 *   or the tab is hidden (documented deviation for demo loops — see
 *   LANDING_V4_DESIGN_DIRECTION.md §5.4).
 * - 4s hold on the completed state between cycles.
 * - `prefers-reduced-motion` renders the final "all steps complete" state
 *   statically and never loops.
 */

const STEP_INTERVAL_MS = 2100;
const HOLD_INTERVAL_MS = 4000;

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface LifecycleState {
  step: number;
  timer: number;
  running: boolean;
  inView: boolean;
}

function init(panel: HTMLElement): void {
  const totalSteps = Number(panel.dataset.lifecycleSteps ?? "5");
  const state: LifecycleState = { step: 0, timer: 0, running: false, inView: false };

  const apply = (): void => {
    panel.dataset.lifecycleStep = String(state.step);
  };

  const schedule = (delay: number): void => {
    state.timer = window.setTimeout(() => {
      state.step = state.step >= totalSteps ? 0 : state.step + 1;
      apply();
      schedule(state.step === totalSteps ? HOLD_INTERVAL_MS : STEP_INTERVAL_MS);
    }, delay);
  };

  const start = (): void => {
    if (state.running || REDUCED_MOTION || !state.inView || document.hidden) return;
    state.running = true;
    schedule(state.step === totalSteps ? HOLD_INTERVAL_MS : STEP_INTERVAL_MS);
  };

  const stop = (): void => {
    if (!state.running) return;
    state.running = false;
    window.clearTimeout(state.timer);
  };

  if (REDUCED_MOTION) {
    state.step = totalSteps;
    apply();
    return;
  }

  apply();

  const io = new IntersectionObserver((entries) => {
    state.inView = entries.some((entry) => entry.isIntersecting);
    if (state.inView) start();
    else stop();
  }, { rootMargin: "60px" });
  io.observe(panel);

  const onVisibility = (): void => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener("visibilitychange", onVisibility);

  panel._lifecycleCleanup = () => {
    stop();
    io.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

declare global {
  interface HTMLElement {
    _lifecycleCleanup?: () => void;
  }
}

const panel = document.querySelector<HTMLElement>("[data-lifecycle]");
if (panel !== null) init(panel);

export {};
