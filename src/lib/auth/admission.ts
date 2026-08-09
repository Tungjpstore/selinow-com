import { AppError } from "../core/errors";
import { hmacToken } from "../core/crypto";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { resolveTurnstileConfiguration } from "../storefront/turnstile";

const DEFAULT_GLOBAL_LIMIT = 200;
const DEFAULT_EMAIL_LIMIT = 5;
const DEFAULT_REQUESTER_LIMIT = 20;
const DEFAULT_WINDOW_SECONDS = 15 * 60;
const TURNSTILE_RESPONSE_MAX_BYTES = 16_384;

type TurnstileEnvelope = {
  action?: unknown;
  hostname?: unknown;
  success?: unknown;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function magicLinkRequesterAddress(request: Request): string {
  const address = request.headers.get("CF-Connecting-IP")?.trim();
  return address !== undefined && address.length > 0 && address.length <= 128 ? address : "unknown";
}

export async function claimMagicLinkAdmission(input: {
  challengePassed?: boolean;
  email: string;
  env: AppBindings;
  now: Date;
  requesterAddress: string;
}): Promise<{ challengeRequired: boolean; deliveryPermitted: boolean }> {
  const windowSeconds = positiveInteger(input.env.MAGIC_LINK_RATE_LIMIT_WINDOW_SECONDS, DEFAULT_WINDOW_SECONDS);
  const windowMs = windowSeconds * 1_000;
  const windowStartMs = Math.floor(input.now.getTime() / windowMs) * windowMs;
  const windowStartedAt = new Date(windowStartMs).toISOString();
  const windowEndsAt = new Date(windowStartMs + windowMs).toISOString();
  const requesterAddress = input.requesterAddress.trim();
  const requesterHash = await hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    "magic-link-requester:v1",
    requesterAddress.length > 0 && requesterAddress.length <= 128 ? requesterAddress : "unknown",
  );
  const subjectHash = await hmacToken(input.env.IDENTIFIER_HMAC_SECRET, "magic-link-email:v1", input.email);
  const globalLimit = positiveInteger(input.env.MAGIC_LINK_GLOBAL_RATE_LIMIT, DEFAULT_GLOBAL_LIMIT);
  const emailLimit = positiveInteger(input.env.MAGIC_LINK_EMAIL_RATE_LIMIT, DEFAULT_EMAIL_LIMIT);
  const requesterLimit = positiveInteger(input.env.MAGIC_LINK_REQUESTER_RATE_LIMIT, DEFAULT_REQUESTER_LIMIT);

  const claimed = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO auth_request_admissions (
      id, action, requester_hash, subject_hash, delivery_permitted, window_started_at, window_ends_at, created_at
    )
    SELECT ?, 'magic_link_request', ?, ?, CASE WHEN ? = 1 OR (
      SELECT COUNT(*) FROM auth_request_admissions
      WHERE action = 'magic_link_request' AND subject_hash = ?
        AND window_started_at = ? AND delivery_permitted = 1
    ) < ? THEN 1 ELSE 0 END, ?, ?, ?
    WHERE (
      SELECT COUNT(*) FROM auth_request_admissions
      WHERE action = 'magic_link_request' AND window_started_at = ?
    ) < ? AND (
      SELECT COUNT(*) FROM auth_request_admissions
      WHERE action = 'magic_link_request'
        AND requester_hash = ? AND window_started_at = ?
    ) < ?
    RETURNING delivery_permitted AS deliveryPermitted
  `).bind(
    createId("adm"),
    requesterHash,
    subjectHash,
    input.challengePassed === true ? 1 : 0,
    subjectHash,
    windowStartedAt,
    emailLimit,
    windowStartedAt,
    windowEndsAt,
    input.now.toISOString(),
    windowStartedAt,
    globalLimit,
    requesterHash,
    windowStartedAt,
    requesterLimit,
  ).first<{ deliveryPermitted: number }>();

  if (claimed === null) throw new AppError("rate_limited", 429);
  const deliveryPermitted = claimed.deliveryPermitted === 1;
  if (!deliveryPermitted && input.env.APP_ENV !== "local" && resolveTurnstileConfiguration(input.env) === null) {
    throw new AppError("turnstile_unavailable", 503);
  }
  return { challengeRequired: !deliveryPermitted, deliveryPermitted };
}

export async function verifyMagicLinkChallenge(input: {
  env: AppBindings;
  request: Request;
  token: unknown;
}): Promise<void> {
  const configuration = resolveTurnstileConfiguration(input.env);
  if (configuration === null) {
    if (input.env.APP_ENV !== "local") throw new AppError("turnstile_unavailable", 503);
    if (typeof input.token !== "string" || input.token.length < 10 || input.token.length > 2_048) {
      throw new AppError("turnstile_required", 403);
    }
    return;
  }
  if (typeof input.token !== "string" || input.token.length < 10 || input.token.length > 2_048) {
    throw new AppError("turnstile_required", 403);
  }

  const requestHostname = new URL(input.request.url).hostname.toLowerCase().replace(/\.$/u, "");
  const dashboardHostname = new URL(input.env.DASHBOARD_ORIGIN).hostname.toLowerCase().replace(/\.$/u, "");
  if (requestHostname !== dashboardHostname) throw new AppError("turnstile_invalid", 403);

  const body = new FormData();
  body.set("secret", configuration.secretKey);
  body.set("response", input.token);
  body.set("remoteip", magicLinkRequesterAddress(input.request));
  body.set("idempotency_key", crypto.randomUUID());

  let response: Response;
  try {
    response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      body,
      method: "POST",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    throw new AppError("turnstile_unavailable", 503);
  }

  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > TURNSTILE_RESPONSE_MAX_BYTES) {
    throw new AppError("turnstile_unavailable", 503);
  }
  let envelope: TurnstileEnvelope;
  try {
    const parsed: unknown = JSON.parse(text);
    envelope = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    throw new AppError("turnstile_unavailable", 503);
  }

  if (!response.ok || envelope.success !== true || envelope.action !== "magic_link_request"
    || typeof envelope.hostname !== "string"
    || envelope.hostname.toLowerCase().replace(/\.$/u, "") !== dashboardHostname) {
    throw new AppError("turnstile_invalid", 403);
  }
}

export async function purgeAuthRequestAdmissions(env: AppBindings, now = new Date()): Promise<number> {
  const result = await env.PLATFORM_DB.prepare(`
    DELETE FROM auth_request_admissions WHERE window_ends_at <= ?
  `).bind(now.toISOString()).run();
  return result.meta.changes;
}
