/**
 * toast.ts — controller for the ToastRegion primitive (EX0). One region per
 * document (mounted in AppLayout); callers push copy they already localized.
 * Danger toasts persist until dismissed; the rest auto-dismiss after 4s.
 * Fully inert under prefers-reduced-motion (instant swap, no slide).
 */

type ToastTone = "danger" | "info" | "success" | "warning";

const AUTO_DISMISS_MS = 4_000;
const MAX_STACK = 3;

function region(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-sln-toast-region]");
}

function buildToast(tone: ToastTone, message: string): HTMLElement {
  const article = document.createElement("article");
  article.className = "sln-toast";
  article.dataset.tone = tone;
  const text = document.createElement("p");
  text.textContent = message;
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.dataset.slnToastClose = "";
  dismiss.setAttribute("aria-label", "×");
  dismiss.textContent = "×";
  article.appendChild(text);
  article.appendChild(dismiss);
  return article;
}

export function showToast(message: string, tone: ToastTone = "info"): void {
  const host = region();
  if (host === null) return;
  while (host.childElementCount >= MAX_STACK) host.firstElementChild?.remove();
  const toast = buildToast(tone, message);
  host.appendChild(toast);
  if (tone !== "danger") {
    window.setTimeout(() => { toast.remove(); }, AUTO_DISMISS_MS);
  }
}

export function bindToastRegion(): void {
  const host = region();
  if (host === null) return;
  if (host.dataset.slnToastBound === "true") return;
  host.dataset.slnToastBound = "true";
  host.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("[data-sln-toast-close]") !== null) {
      target.closest(".sln-toast")?.remove();
    }
  });
}
