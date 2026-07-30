import { AppError } from "../core/errors";
import { constantTimeEqual, hmacToken } from "../core/crypto";
import { parseCookies } from "../http/cookies";

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError("validation_failed", 400, ["email_required"]);
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new AppError("validation_failed", 400, ["email_invalid"]);
  }

  return normalized;
}

export function normalizeDisplayName(value: unknown, email: string): string {
  if (value === undefined) {
    return email.split("@", 1)[0]?.slice(0, 80) || "Seller";
  }
  if (typeof value !== "string") {
    throw new AppError("validation_failed", 400, ["display_name_invalid"]);
  }

  const normalized = value.trim().replace(/\s+/gu, " ");
  if (normalized.length < 1 || normalized.length > 80) {
    throw new AppError("validation_failed", 400, ["display_name_invalid"]);
  }
  return normalized;
}

export function assertDashboardOrigin(request: Request, dashboardOrigin: string): void {
  if (request.headers.get("Origin") !== dashboardOrigin) {
    throw new AppError("csrf_invalid", 403, ["origin_mismatch"]);
  }
}

export async function assertCsrfRequest(input: {
  csrfCookieName: string;
  csrfTokenHash: string;
  dashboardOrigin: string;
  request: Request;
  sessionSecret: string;
}): Promise<void> {
  assertDashboardOrigin(input.request, input.dashboardOrigin);

  const headerToken = input.request.headers.get("X-CSRF-Token") ?? "";
  const cookieToken = parseCookies(input.request.headers.get("Cookie")).get(input.csrfCookieName) ?? "";
  if (headerToken.length < 20 || !constantTimeEqual(headerToken, cookieToken)) {
    throw new AppError("csrf_invalid", 403, ["token_mismatch"]);
  }

  const candidateHash = await hmacToken(input.sessionSecret, "csrf", headerToken);
  if (!constantTimeEqual(candidateHash, input.csrfTokenHash)) {
    throw new AppError("csrf_invalid", 403, ["token_invalid"]);
  }
}
