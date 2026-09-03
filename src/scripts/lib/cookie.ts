/** Shared browser helpers for dashboard/storefront client bundles (EX0). */

export function readCookie(name: string): string | null {
  if (name.length === 0) return null;
  const prefix = `${encodeURIComponent(name)}=`;
  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (value.startsWith(prefix)) return decodeURIComponent(value.slice(prefix.length));
  }
  return null;
}

export function csrfCookieName(): string | null {
  const host = document.querySelector<HTMLElement>("[data-app-shell][data-csrf-cookie-name]");
  return host?.dataset.csrfCookieName ?? null;
}
