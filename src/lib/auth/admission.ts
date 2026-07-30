import { AppError } from "../core/errors";
import { hmacToken } from "../core/crypto";
import { createId } from "../core/ids";
import type { AppBindings } from "../platform/bindings";

const DEFAULT_GLOBAL_LIMIT = 200;
const DEFAULT_REQUESTER_LIMIT = 20;
const DEFAULT_WINDOW_SECONDS = 15 * 60;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function magicLinkRequesterAddress(request: Request): string {
  const address = request.headers.get("CF-Connecting-IP")?.trim();
  return address !== undefined && address.length > 0 && address.length <= 128 ? address : "unknown";
}

export async function claimMagicLinkAdmission(input: {
  env: AppBindings;
  now: Date;
  requesterAddress: string;
}): Promise<void> {
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
  const globalLimit = positiveInteger(input.env.MAGIC_LINK_GLOBAL_RATE_LIMIT, DEFAULT_GLOBAL_LIMIT);
  const requesterLimit = positiveInteger(input.env.MAGIC_LINK_REQUESTER_RATE_LIMIT, DEFAULT_REQUESTER_LIMIT);

  const claimed = await input.env.PLATFORM_DB.prepare(`
    INSERT INTO auth_request_admissions (
      id, action, requester_hash, window_started_at, window_ends_at, created_at
    )
    SELECT ?, 'magic_link_request', ?, ?, ?, ?
    WHERE (
      SELECT COUNT(*) FROM auth_request_admissions
      WHERE action = 'magic_link_request' AND window_started_at = ?
    ) < ? AND (
      SELECT COUNT(*) FROM auth_request_admissions
      WHERE action = 'magic_link_request'
        AND requester_hash = ? AND window_started_at = ?
    ) < ?
    RETURNING id
  `).bind(
    createId("adm"),
    requesterHash,
    windowStartedAt,
    windowEndsAt,
    input.now.toISOString(),
    windowStartedAt,
    globalLimit,
    requesterHash,
    windowStartedAt,
    requesterLimit,
  ).first<{ id: string }>();

  if (claimed === null) throw new AppError("rate_limited", 429);
}

export async function purgeAuthRequestAdmissions(env: AppBindings, now = new Date()): Promise<number> {
  const result = await env.PLATFORM_DB.prepare(`
    DELETE FROM auth_request_admissions WHERE window_ends_at <= ?
  `).bind(now.toISOString()).run();
  return result.meta.changes;
}
