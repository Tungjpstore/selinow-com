export function isSellerWorkspacePath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/") || pathname === "/onboarding";
}

export function withSelectedShop(
  href: string,
  selectedShopPublicId: string | undefined,
  origin: string,
): string {
  if (selectedShopPublicId === undefined || selectedShopPublicId.length === 0) return href;

  try {
    const base = new URL(origin);
    const target = new URL(href, base);
    if (target.origin !== base.origin || !isSellerWorkspacePath(target.pathname)) return href;
    if (!target.searchParams.has("shop")) target.searchParams.set("shop", selectedShopPublicId);
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return href;
  }
}

export function shopSwitchHref(currentUrl: URL, nextShopPublicId: string): string {
  const target = new URL(currentUrl);

  // Entity identifiers and filters belong to the previous tenant and must not
  // survive a shop switch. Order detail routes return to the safe list surface.
  if (target.pathname.startsWith("/app/orders/")) target.pathname = "/app/orders";
  target.search = "";
  target.hash = "";
  target.searchParams.set("shop", nextShopPublicId);

  return `${target.pathname}${target.search}`;
}
