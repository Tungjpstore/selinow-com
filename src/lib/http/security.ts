const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "connect-src 'self' https://challenges.cloudflare.com",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src https://challenges.cloudflare.com",
    "img-src 'self' data: https:",
    "object-src 'none'",
    "script-src 'self' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "upgrade-insecure-requests",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export const PRIVATE_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Expires: "0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
} as const;

export function resolveRequestId(candidate: string | null): string {
  if (candidate !== null && REQUEST_ID_PATTERN.test(candidate)) {
    return candidate;
  }

  return crypto.randomUUID();
}

export function applySecurityHeaders(headers: Headers, requestId: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    // Preserve an endpoint-specific policy such as no-referrer.
    if (name === "Referrer-Policy" && headers.get(name) === "no-referrer") continue;
    headers.set(name, value);
  }

  headers.set("X-Request-Id", requestId);
}

export function isPrivatePagePath(pathname: string): boolean {
  return pathname === "/app"
    || pathname.startsWith("/app/")
    || pathname === "/onboarding"
    || pathname === "/admin"
    || pathname.startsWith("/admin/")
    || pathname === "/login";
}

export function applyPrivatePageHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(PRIVATE_RESPONSE_HEADERS)) {
    headers.set(name, value);
  }
}

export function createErrorResponse(
  code: string,
  requestId: string,
  status: number,
  issues?: readonly string[],
): Response {
  const body = issues === undefined
    ? { ok: false, code, requestId }
    : { ok: false, code, requestId, issues };

  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export function createCaughtErrorResponse(error: unknown, requestId: string): Response {
  if (isAppError(error)) {
    return createErrorResponse(error.code, requestId, error.status, error.issues);
  }

  return createErrorResponse("internal_error", requestId, 500);
}

export function createPrivateCaughtErrorResponse(error: unknown, requestId: string): Response {
  const response = createCaughtErrorResponse(error, requestId);
  applyPrivatePageHeaders(response.headers);
  return response;
}
import { isAppError } from "../core/errors";
