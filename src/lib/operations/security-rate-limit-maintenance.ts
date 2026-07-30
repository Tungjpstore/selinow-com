import type { AppBindings } from "../platform/bindings";

const DEFAULT_PURGE_LIMIT = 500;
const MAX_PURGE_LIMIT = 1_000;

function boundedLimit(limit: number): number {
  return Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, MAX_PURGE_LIMIT)
    : DEFAULT_PURGE_LIMIT;
}

/** Delete only completed limiter windows whose temporary block has also ended. */
export async function purgeExpiredSecurityRateLimits(
  env: AppBindings,
  now = new Date(),
  limit = DEFAULT_PURGE_LIMIT,
): Promise<number> {
  const nowIso = now.toISOString();
  const result = await env.PLATFORM_DB.prepare(`
    DELETE FROM security_rate_limits
    WHERE id IN (
      SELECT id
      FROM security_rate_limits
      WHERE window_ends_at <= ?
        AND (blocked_until IS NULL OR blocked_until <= ?)
      ORDER BY window_ends_at, shop_id, id
      LIMIT ?
    )
  `).bind(nowIso, nowIso, boundedLimit(limit)).run();
  return result.meta.changes;
}
