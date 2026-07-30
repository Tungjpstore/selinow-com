import type { AppBindings } from "../platform/bindings";

const DEFAULT_PURGE_LIMIT = 500;
const MAX_PURGE_LIMIT = 1_000;

function boundedLimit(limit: number): number {
  return Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, MAX_PURGE_LIMIT)
    : DEFAULT_PURGE_LIMIT;
}

/** Remove only expired ephemeral claims, in deterministic bounded batches. */
export async function purgeExpiredDeliveryGrantClaims(
  env: AppBindings,
  now = new Date(),
  limit = DEFAULT_PURGE_LIMIT,
): Promise<number> {
  const result = await env.PLATFORM_DB.prepare(`
    DELETE FROM delivery_grant_claims
    WHERE (shop_id, id) IN (
      SELECT shop_id, id
      FROM delivery_grant_claims
      WHERE lease_expires_at <= ?
      ORDER BY lease_expires_at, shop_id, id
      LIMIT ?
    )
  `).bind(now.toISOString(), boundedLimit(limit)).run();
  return result.meta.changes;
}
