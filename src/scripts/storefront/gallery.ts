/**
 * Gallery thumbnail switching. Buttons carry the full-size URL; the main
 * image swaps in place with a short opacity fade (skipped by the global
 * reduced-motion kill switch).
 */
const galleries = [...document.querySelectorAll<HTMLElement>("[data-gallery]")];
for (const gallery of galleries) {
  const main = gallery.querySelector<HTMLImageElement>("[data-gallery-main]");
  const thumbs = [...gallery.querySelectorAll<HTMLButtonElement>("[data-gallery-thumb]")];
  if (main === null || thumbs.length === 0) continue;
  for (const thumb of thumbs) {
    thumb.addEventListener("click", () => {
      const source = thumb.dataset.galleryThumb;
      if (source === undefined || main.src === source) return;
      for (const candidate of thumbs) candidate.classList.toggle("is-active", candidate === thumb);
      main.src = source;
    });
  }
}
