import { createOpaqueToken } from "../core/ids";
import type { AppBindings } from "../platform/bindings";
import { turnstileAdmissionRefreshWindow } from "./readiness";
import { reconcileCustomDomainRecord, refreshCustomDomainTurnstileAdmission, type DomainRuntime } from "./store";

type DueDomain = {
  id: string;
  shopId: string;
};

// Bounds the number of proactive Turnstile admission refreshes per reconcile
// tick so the Cloudflare widget API is never hammered when many admissions age
// out at once; remaining domains are picked up on subsequent ticks.
export const TURNSTILE_REFRESH_MAX_PER_TICK = 10;

const DOMAIN_RECONCILE_LEASE_MS = 90_000;

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
    const leaseExpiresAt = new Date(now.getTime() + DOMAIN_RECONCILE_LEASE_MS).toISOString();
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

  // Second pass: proactively refresh Turnstile widget-domain admissions that
  // are stale (or already expired) on otherwise healthy active domains, before
  // the 12-hour serve-gate freshness window silently stops the storefront.
  const refreshWindow = turnstileAdmissionRefreshWindow(now);
  if (refreshWindow !== null) {
    const dueRefreshes = await env.PLATFORM_DB.prepare(`
      /* domain:refresh-turnstile-due */
      SELECT id, shop_id AS shopId
      FROM shop_domains
      WHERE type = 'custom'
        AND deleted_at IS NULL
        AND delete_requested_at IS NULL
        AND status = 'active'
        AND ownership_verified_at IS NOT NULL
        AND hostname_status = 'active' AND ssl_status = 'active' AND dns_status = 'active'
        AND json_extract(validation_metadata_json, '$.turnstile.status') = 'active'
        AND json_extract(validation_metadata_json, '$.turnstile.hostname') = hostname_normalized
        AND json_extract(validation_metadata_json, '$.turnstile.mode') = 'operator_managed'
        AND json_extract(validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'
        AND json_type(validation_metadata_json, '$.turnstile.checkedAt') = 'text'
        AND julianday(json_extract(validation_metadata_json, '$.turnstile.checkedAt')) IS NOT NULL
        AND julianday(json_extract(validation_metadata_json, '$.turnstile.checkedAt')) < julianday(?)
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND COALESCE(last_checked_at, '') <= ?
      ORDER BY json_extract(validation_metadata_json, '$.turnstile.checkedAt'), id
      LIMIT ${String(TURNSTILE_REFRESH_MAX_PER_TICK)}
    `).bind(refreshWindow.dueBefore, nowIso, refreshWindow.retryBefore).all<DueDomain>();

    for (const domain of dueRefreshes.results) {
      const leaseToken = createOpaqueToken(18);
      const leaseExpiresAt = new Date(now.getTime() + DOMAIN_RECONCILE_LEASE_MS).toISOString();
      const claimed = await env.PLATFORM_DB.prepare(`
        /* domain:claim-turnstile-refresh-lease */
        UPDATE shop_domains
        SET lease_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND shop_id = ? AND type = 'custom' AND deleted_at IS NULL
          AND delete_requested_at IS NULL AND status = 'active'
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
      `).bind(leaseToken, leaseExpiresAt, nowIso, domain.id, domain.shopId, nowIso).run();
      if (claimed.meta.changes !== 1) continue;

      try {
        const outcome = await refreshCustomDomainTurnstileAdmission({ env, leaseToken, now, row: domain, runtime });
        result[outcome] += 1;
      } catch {
        result.failed += 1;
      }
    }
  }

  return result;
}
