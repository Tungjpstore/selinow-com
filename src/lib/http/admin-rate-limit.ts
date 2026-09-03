import { hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";

/**
 * Per-IP rate limiting for admin mutation routes. Reuses the durable
 * `security_rate_limits` fixed-window upsert pattern from operations/abuse.ts so
 * limits survive across Worker invocations and are purged by the existing cron.
 * Records are platform-scoped (shop_id NULL) and keyed per client IP + mutation
 * family; the subject_hash is an HMAC of the client address so raw IPs are never
 * stored. Fail-closed: exceeding the window budget raises the standard
 * `rate_limited` 429 with a safe code.
 */

export const ADMIN_MUTATION_RATE_FAMILIES = [
  "abuse_reports",
  "appeals",
  "moderation",
  "operations_dead_letters",
  "operations_deletions",
  "operations_incidents",
  "operations_rotations",
  "payments_payos",
  "shops",
] as const;

export type AdminMutationRateFamily = typeof ADMIN_MUTATION_RATE_FAMILIES[number];

const DEFAULT_WINDOW_SECONDS = 60;
const DEFAULT_LIMIT = 30;

function clientAddress(request: Request): string {
  return request.headers.get("CF-Connecting-IP")?.trim() || "local";
}

export async function guardAdminMutationRate(input: {
  env: AppBindings;
  family: AdminMutationRateFamily;
  limit?: number;
  now?: Date;
  request: Request;
  windowSeconds?: number;
}): Promise<void> {
  if (!ADMIN_MUTATION_RATE_FAMILIES.includes(input.family)) {
    throw new AppError("internal_error", 500);
  }
  const limit = input.limit ?? DEFAULT_LIMIT;
  const windowSeconds = input.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
    throw new AppError("internal_error", 500);
  }
  const now = input.now ?? new Date();
  const windowStartMs = Math.floor(now.getTime() / (windowSeconds * 1_000)) * windowSeconds * 1_000;
  const windowStartedAt = new Date(windowStartMs).toISOString();
  const windowEndsAt = new Date(windowStartMs + windowSeconds * 1_000).toISOString();
  const subjectHash = await hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    `admin-mutation-rate:v1:${input.family}`,
    clientAddress(input.request),
  );
  const row = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO security_rate_limits (
      id, shop_id, scope_key, action, subject_hash, window_started_at,
      window_ends_at, request_count, blocked_count, blocked_until,
      version, created_at, updated_at
    ) VALUES (?, NULL, ?, 'admin_mutation', ?, ?, ?, 1, 0, NULL, 1, ?, ?)
    ON CONFLICT(scope_key, action, subject_hash, window_started_at)
    DO UPDATE SET
      request_count = security_rate_limits.request_count + 1,
      blocked_count = security_rate_limits.blocked_count + CASE
        WHEN security_rate_limits.request_count + 1 > ? THEN 1 ELSE 0 END,
      blocked_until = CASE
        WHEN security_rate_limits.request_count + 1 > ? THEN excluded.window_ends_at
        ELSE security_rate_limits.blocked_until END,
      version = security_rate_limits.version + 1,
      updated_at = excluded.updated_at
    RETURNING request_count AS requestCount
  `).bind(
    createId("lim"),
    `platform-admin:${input.family}`,
    subjectHash,
    windowStartedAt,
    windowEndsAt,
    now.toISOString(),
    now.toISOString(),
    limit,
    limit,
  ).first<{ requestCount: number }>();
  if ((row?.requestCount ?? 1) > limit) throw new AppError("rate_limited", 429);
}
