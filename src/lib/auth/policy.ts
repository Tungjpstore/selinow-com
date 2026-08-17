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

const COMMON_WEAK_PASSWORDS = new Set([
  "12345678", "password", "password123", "123456789", "1234567890",
  "qwerty123", "admin123", "selinow123", "iloveyou"
]);

export function validatePasswordStrength(password: unknown): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new AppError("validation_failed", 400, ["password_required"]);
  }
  if (password.length < 8) {
    throw new AppError("validation_failed", 400, ["password_too_short"]);
  }
  if (password.length > 128) {
    throw new AppError("validation_failed", 400, ["password_too_long"]);
  }
  if (COMMON_WEAK_PASSWORDS.has(password.toLowerCase())) {
    throw new AppError("validation_failed", 400, ["password_too_weak"]);
  }

  const hasLower = /[a-z]/u.test(password);
  const hasUpper = /[A-Z]/u.test(password);
  const hasNumber = /[0-9]/u.test(password);
  const hasSpecial = /[^A-Za-z0-9]/u.test(password);

  const passedRules = [hasLower, hasUpper, hasNumber, hasSpecial].filter(Boolean).length;
  if (passedRules < 3) {
    throw new AppError("validation_failed", 400, ["password_complexity_failed"]);
  }

  return password;
}

export function normalizeOtp(value: unknown): string {
  if (typeof value !== "string") {
    throw new AppError("validation_failed", 400, ["otp_required"]);
  }
  const clean = value.trim().replace(/\s+/gu, "");
  if (!/^\d{6}$/u.test(clean)) {
    throw new AppError("validation_failed", 400, ["otp_invalid_format"]);
  }
  return clean;
}


export function assertDashboardOrigin(request: Request, dashboardOrigin: string): void {
  const origin = request.headers.get("Origin");
  if (origin !== null) {
    if (origin !== dashboardOrigin) {
      throw new AppError("csrf_invalid", 403, ["origin_mismatch"]);
    }
    return;
  }
  // Browsers omit Origin on same-origin GET/HEAD fetches. Accept the absent
  // header only for those methods when the request URL itself is the
  // dashboard origin; every other shape fails closed. No Referer fallback:
  // private pages set Referrer-Policy: no-referrer.
  const method = request.method.toUpperCase();
  if ((method === "GET" || method === "HEAD") && new URL(request.url).origin === dashboardOrigin) {
    return;
  }
  throw new AppError("csrf_invalid", 403, ["origin_mismatch"]);
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
