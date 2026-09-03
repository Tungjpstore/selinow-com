import { createOpaqueToken } from "../core/ids";
import type { AppBindings } from "../platform/bindings";

type OutboxJob = {
  id: string;
  shopId: string;
};

const LEGACY_NOTIFICATION_SUPERSEDED = "telegram_legacy_notification_superseded";

async function quarantineLegacyJob(env: AppBindings, job: OutboxJob, leaseToken: string, nowIso: string): Promise<boolean> {
  const result = await env.PLATFORM_DB.prepare(`
    UPDATE outbox_jobs
    SET status = 'completed', last_safe_error_code = ?, lease_token = NULL,
      lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND shop_id = ? AND kind = 'order_paid'
      AND status = 'processing' AND lease_token = ?
  `).bind(LEGACY_NOTIFICATION_SUPERSEDED, nowIso, job.id, job.shopId, leaseToken).run();
  return result.meta.changes === 1;
}

/**
 * Drain old order_paid rows without delivering them. The domain-event delivery
 * queue is the sole Telegram paid-order notification authority.
 */
export async function processTelegramOutbox(env: AppBindings, now = new Date(), _fetcher: typeof fetch = fetch, shopId: string | null = null): Promise<{ failed: number; processed: number; skipped: number }> {
  void _fetcher;
  const nowIso = now.toISOString();
  const maxAttempts = 5; // Triệt để retry cho Telegram (backend yếu)

  const due = await env.PLATFORM_DB.prepare(`
    SELECT id, shop_id AS shopId
    FROM outbox_jobs
    WHERE kind = 'order_paid' AND next_attempt_at <= ?
      AND (status = 'pending' OR (status = 'processing' AND lease_expires_at <= ?))
      AND (? IS NULL OR shop_id = ?)
      AND (status != 'failed' OR attempts < ?)
    ORDER BY next_attempt_at, id
    LIMIT 25
  `).bind(nowIso, nowIso, shopId, shopId, maxAttempts).all<OutboxJob>();

  let skipped = 0;
  let processed = 0;
  const failed = 0;

  for (const job of due.results) {
    const leaseToken = createOpaqueToken(18);
    const leaseExpiresAt = new Date(now.getTime() + 60000).toISOString(); // 1 phút

    const claimed = await env.PLATFORM_DB.prepare(`
      UPDATE outbox_jobs
      SET status = 'processing', lease_token = ?, lease_expires_at = ?, attempts = COALESCE(attempts, 0) + 1, updated_at = ?
      WHERE id = ? AND shop_id = ? AND kind = 'order_paid'
        AND (status = 'pending' OR (status = 'processing' AND lease_expires_at <= ?))
        AND (status != 'failed' OR attempts < ?)
    `).bind(leaseToken, leaseExpiresAt, nowIso, job.id, job.shopId, nowIso, maxAttempts).run();

    if (claimed.meta.changes !== 1) continue;

    if (await quarantineLegacyJob(env, job, leaseToken, nowIso)) {
      skipped += 1;
      continue;
    }

    processed += 1;
  }

  // Tự động chuyển failed sang dead-letter sau 5 lần
  if (processed > 0) {
    await env.PLATFORM_DB.prepare(`
      UPDATE outbox_jobs
      SET status = 'failed', next_attempt_at = NULL
      WHERE kind = 'order_paid'
        AND status = 'failed'
        AND attempts >= ?
        AND (? IS NULL OR shop_id = ?)
    `).bind(maxAttempts, shopId, shopId).run();
  }

  return { failed, processed, skipped };
}

export async function purgeTelegramUpdateHistory(env: AppBindings, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
  const results = await env.PLATFORM_DB.batch([
    env.PLATFORM_DB.prepare("DELETE FROM telegram_actions WHERE created_at < ?").bind(cutoff),
    env.PLATFORM_DB.prepare("DELETE FROM telegram_updates WHERE received_at < ? AND status IN ('processed', 'rejected')").bind(cutoff),
  ]);
  return (results[0]?.meta.changes ?? 0) + (results[1]?.meta.changes ?? 0);
}
