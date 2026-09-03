const REDIRECT_BASE = "https://selinow.invalid";

/** Keep post-auth navigation on the dashboard origin. */
export function safeRelativeRedirect(requested: string | null, fallback = "/app"): string {
  if (requested === null || !requested.startsWith("/") || requested.startsWith("//") || requested.includes("\\")) {
    return fallback;
  }

  try {
    const decoded = decodeURIComponent(requested);
    if (decoded.startsWith("//") || decoded.includes("\\")) return fallback;
    const resolved = new URL(requested, REDIRECT_BASE);
    return resolved.origin === REDIRECT_BASE
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}
