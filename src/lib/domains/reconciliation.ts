import { createOpaqueToken } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { reconcileCustomDomainRecord, type DomainRuntime } from "./store";

type DueDomain = {
  id: string;
  shopId: string;
};

export type DomainReconciliationResult = {
  checked: number;
  deleted: number;
  failed: number;
};

export async function reconcileCustomDomains(
  env: AppBindings,
  now = new Date(),
  runtime: Omit<DomainRuntime, "now"> = {},
): Promise<DomainReconciliationResult> {
  const nowIso = now.toISOString();
  const due = await env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId
    FROM shop_domains
    WHERE type = 'custom'
      AND deleted_at IS NULL
      AND next_check_at IS NOT NULL
      AND next_check_at <= ?
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      AND (delete_requested_at IS NOT NULL OR status IN ('pending', 'validating', 'active', 'failed', 'suspended'))
    ORDER BY next_check_at, id
    LIMIT 25
  `).bind(nowIso, nowIso).all<DueDomain>();
  const result: DomainReconciliationResult = { checked: 0, deleted: 0, failed: 0 };

  for (const domain of due.results) {
    const leaseToken = createOpaqueToken(18);
    const leaseExpiresAt = new Date(now.getTime() + 90_000).toISOString();
    const claimed = await env.PLATFORM_DB.prepare(`
      UPDATE shop_domains
      SET lease_token = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND shop_id = ? AND type = 'custom' AND deleted_at IS NULL
        AND next_check_at IS NOT NULL AND next_check_at <= ?
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).bind(leaseToken, leaseExpiresAt, nowIso, domain.id, domain.shopId, nowIso, nowIso).run();
    if (claimed.meta.changes !== 1) continue;

    try {
      const outcome = await reconcileCustomDomainRecord({ env, leaseToken, now, row: domain, runtime });
      result[outcome] += 1;
    } catch {
      result.failed += 1;
    }
  }

  return result;
}
