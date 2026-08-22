/**
 * TM4 merchandising behaviors — honest data only:
 *  - Recently viewed: localStorage-backed rail on the home page (≤8 items).
 *  - Cart cross-sell: same-category suggestions under the cart summary (≤3).
 *  - Detail track: records the visited product slug into localStorage.
 */
type ViewedEntry = { slug: string; title: string };

const VIEWED_KEY = `selinow-viewed:v1:${window.location.host}`;
const MAX_VIEWED = 8;

function readViewed(): ViewedEntry[] {
  try {
    const raw = window.localStorage.getItem(VIEWED_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is ViewedEntry => typeof entry === "object" && entry !== null
        && typeof (entry as ViewedEntry).slug === "string" && (entry as ViewedEntry).slug.length > 0)
      .slice(0, MAX_VIEWED);
  } catch {
    return [];
  }
}

function writeViewed(entries: ViewedEntry[]): void {
  try {
    window.localStorage.setItem(VIEWED_KEY, JSON.stringify(entries.slice(0, MAX_VIEWED)));
  } catch {
    // Storage unavailable (private mode) — the rail simply won't render.
  }
}

function trackCurrentProduct(): void {
  const marker = document.querySelector<HTMLElement>("[data-detail-track]");
  const slug = marker?.dataset.detailTrack;
  const title = marker?.dataset.detailTitle;
  if (slug === undefined || slug.length === 0) return;
  const entries = readViewed().filter((entry) => entry.slug !== slug);
  entries.unshift({ slug, title: title ?? slug });
  writeViewed(entries);
}

function renderRecentlyViewed(): void {
  const host = document.querySelector<HTMLElement>("[data-recently-viewed-rail]");
  if (host === null) return;
  const current = document.querySelector<HTMLElement>("[data-detail-track]")?.dataset.detailTrack;
  const entries = readViewed().filter((entry) => entry.slug !== current).slice(0, 8);
  if (entries.length === 0) {
    host.closest(".recently-viewed-section")?.remove();
    return;
  }
  const heading = host.closest(".recently-viewed-section")?.querySelector("h2");
  if (heading instanceof HTMLElement && heading.textContent === null) heading.textContent = "Recently viewed";
  for (const entry of entries) {
    const card = document.createElement("a");
    card.className = "recently-viewed-card";
    card.href = `/products/${encodeURIComponent(entry.slug)}`;
    const visual = document.createElement("span");
    visual.className = "rv-visual";
    visual.textContent = entry.title.slice(0, 1).toUpperCase();
    const name = document.createElement("strong");
    name.textContent = entry.title;
    card.appendChild(visual);
    card.appendChild(name);
    host.appendChild(card);
  }
}

function renderCartCrossSell(): void {
  const host = document.querySelector<HTMLElement>("[data-cross-sell-grid]");
  if (host === null) return;
  // The cart page embeds the catalog as hidden JSON (CatalogData); the
  // suggestions read it client-side — same-category, excluding items in cart.
  const catalogElement = document.querySelector<HTMLTemplateElement>("#catalog-data");
  if (catalogElement === null) {
    host.closest(".cross-sell-section")?.remove();
    return;
  }
  let products: Array<{ categoryId: string | null; slug: string; title: string }> = [];
  try {
    const parsed: unknown = JSON.parse(catalogElement.innerHTML);
    if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { products?: unknown }).products)) {
      products = (parsed as { products: Array<{ categoryId: string | null; slug: string; title: string }> }).products;
    }
  } catch {
    host.closest(".cross-sell-section")?.remove();
    return;
  }
  const cartSlugs = new Set<string>();
  for (const item of document.querySelectorAll<HTMLElement>("[data-cart-item-slug]")) {
    const slug = item.dataset.cartItemSlug;
    if (slug !== undefined) cartSlugs.add(slug);
  }
  // Pick from categories present in the cart; if cart is empty the section
  // stays hidden (only the cart page mounts it after items render).
  const cartCategories = new Set<string>();
  for (const marker of document.querySelectorAll<HTMLElement>("[data-cart-item-category]")) {
    const categoryId = marker.dataset.cartItemCategory;
    if (categoryId !== undefined && categoryId.length > 0) cartCategories.add(categoryId);
  }
  if (cartCategories.size === 0) {
    host.closest(".cross-sell-section")?.remove();
    return;
  }
  const suggestions = products
    .filter((product) => product.categoryId !== null && cartCategories.has(product.categoryId) && !cartSlugs.has(product.slug))
    .slice(0, 3);
  if (suggestions.length === 0) {
    host.closest(".cross-sell-section")?.remove();
    return;
  }
  for (const product of suggestions) {
    const card = document.createElement("a");
    card.className = "recently-viewed-card";
    card.href = `/products/${encodeURIComponent(product.slug)}`;
    const visual = document.createElement("span");
    visual.className = "rv-visual";
    visual.textContent = product.title.slice(0, 1).toUpperCase();
    const name = document.createElement("strong");
    name.textContent = product.title;
    card.appendChild(visual);
    card.appendChild(name);
    host.appendChild(card);
  }
}

trackCurrentProduct();
renderRecentlyViewed();
renderCartCrossSell();
