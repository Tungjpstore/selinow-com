const searchForm = document.querySelector<HTMLFormElement>("[data-store-search-form]");
const searchInput = document.querySelector<HTMLInputElement>("[data-store-search-input]");
const searchEmpty = document.querySelector<HTMLElement>("[data-store-search-empty]");
const categoryFilter = document.querySelector("[data-store-category-filter]");
const productCards = [...document.querySelectorAll<HTMLElement>("[data-product-card]")];

function filterProducts(): void {
  const query = searchInput?.value.trim().toLocaleLowerCase() ?? "";
  const category = categoryFilter instanceof HTMLSelectElement ? categoryFilter.value : "";
  let visible = 0;
  for (const card of productCards) {
    const searchMatch = query === "" || (card.dataset.searchText ?? "").toLocaleLowerCase().includes(query);
    const categoryMatch = category === "" || (card.dataset.categoryId ?? "") === category;
    const match = searchMatch && categoryMatch;
    card.hidden = !match;
    if (match) visible += 1;
  }
  if (searchEmpty !== null) searchEmpty.hidden = visible > 0;
}

searchForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  filterProducts();
});
searchInput?.addEventListener("input", filterProducts);
if (categoryFilter !== null) categoryFilter.addEventListener("change", filterProducts);
document.querySelector<HTMLElement>("[data-store-search-reset]")?.addEventListener("click", () => {
  if (searchInput !== null) searchInput.value = "";
  if (categoryFilter instanceof HTMLSelectElement) categoryFilter.value = "";
  filterProducts();
});
