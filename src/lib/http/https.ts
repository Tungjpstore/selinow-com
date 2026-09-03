const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return LOOPBACK_HOSTNAMES.has(normalized) || normalized.endsWith(".localhost");
}

function forwardedProto(request: Request): string | null {
  const value = request.headers.get("X-Forwarded-Proto");
  if (value === null) return null;
  const first = value.split(",")[0]?.trim().toLowerCase();
  return first === "http" || first === "https" ? first : null;
}

/**
 * BUG-001: every platform, API, dashboard and tenant storefront host must
 * canonicalize plaintext HTTP to HTTPS. Local development (loopback hosts)
 * stays on plain HTTP so `wrangler dev` and browser gates keep working.
 */
export function shouldEnforceHttps(request: Request, appEnv: "local" | "staging" | "production"): boolean {
  if (appEnv === "local") return false;
  const url = new URL(request.url);
  if (isLoopbackHostname(url.hostname)) return false;
  return forwardedProto(request) === "http" || url.protocol === "http:";
}

/**
 * Build the universal 308 redirect (method and body preserving) to the
 * equivalent HTTPS URL. Returns null when the request must not be redirected.
 */
export function toHttpsRedirect(request: Request): Response | null {
  if (!shouldEnforceHttps(request, "production") && !shouldEnforceHttps(request, "staging")) {
    return null;
  }
  const url = new URL(request.url);
  url.protocol = "https:";
  url.port = "";
  return new Response(null, {
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Location: url.toString(),
      "X-Robots-Tag": "noindex, nofollow",
    },
    status: 308,
  });
}
