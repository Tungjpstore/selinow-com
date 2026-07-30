import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { expect, it } from "vitest";

const NOW = "2026-07-27T00:00:00.000Z";
const HASH = "a".repeat(64);

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency,
      timezone, readiness_version, created_at, updated_at
    ) VALUES
      ('shop-hardening-a', 'shop-hardening-public-a', 'hardening-a',
        'Hardening A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'),
      ('shop-hardening-b', 'shop-hardening-public-b', 'hardening-b',
        'Hardening B', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}');
    INSERT INTO shop_channels (
      id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
    ) VALUES
      ('channel-hardening-a', 'shop-hardening-a', 'telegram', 'enabled', '{}', 1, '${NOW}', '${NOW}'),
      ('channel-hardening-b', 'shop-hardening-b', 'telegram', 'enabled', '{}', 1, '${NOW}', '${NOW}');
    INSERT INTO channel_connections (
      id, public_id, shop_id, shop_channel_id, provider_code,
      external_account_id, status, settings_json, version, created_at, updated_at
    ) VALUES
      ('connection-hardening-a', 'connection-hardening-public-a', 'shop-hardening-a',
        'channel-hardening-a', 'telegram', 'bot-hardening-a', 'active', '{}', 1, '${NOW}', '${NOW}'),
      ('connection-hardening-b', 'connection-hardening-public-b', 'shop-hardening-b',
        'channel-hardening-b', 'telegram', 'bot-hardening-b', 'active', '{}', 1, '${NOW}', '${NOW}');
  `);
  return database;
}

function plan(database: DatabaseSync, sql: string, ...values: SQLInputValue[]): string {
  return database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values)
    .map((row) => String((row as { detail: unknown }).detail))
    .join("\n");
}

it("hardens generic due polling, deletion terminalization and typed DLQ replay", () => {
  const database = createDatabase();
  try {
    database.prepare(`
      INSERT INTO domain_events (
        id, shop_id, event_type, aggregate_type, aggregate_id, schema_version,
        idempotency_key_hash, source_connection_id, status, attempts,
        next_attempt_at, occurred_at, created_at, updated_at
      ) VALUES (
        'event-hardening-a', 'shop-hardening-a', 'order.paid', 'order',
        'order-hardening-a', 1, ?, 'connection-hardening-a', 'pending', 0,
        ?, ?, ?, ?
      )
    `).run(HASH, NOW, NOW, NOW, NOW);
    database.prepare(`
      INSERT INTO delivery_jobs (
        id, shop_id, event_id, connection_id, purpose, queue_kind,
        idempotency_key_hash, status, attempts, next_attempt_at, created_at, updated_at
      ) VALUES (
        'delivery-hardening-a', 'shop-hardening-a', 'event-hardening-a',
        'connection-hardening-a', 'order_paid', 'notification', ?,
        'pending', 0, ?, ?, ?
      )
    `).run(HASH, NOW, NOW, NOW);

    expect(plan(database, `
      SELECT id, shop_id FROM domain_events
      WHERE status IN ('pending', 'retryable') AND next_attempt_at <= ?
      ORDER BY next_attempt_at, id LIMIT 50
    `, NOW)).toContain("idx_domain_events_ready_claim");
    expect(plan(database, `
      SELECT id, shop_id FROM domain_events
      WHERE status = 'processing' AND lease_expires_at <= ?
      ORDER BY lease_expires_at, id LIMIT 50
    `, NOW)).toContain("idx_domain_events_expired_lease");
    expect(plan(database, `
      SELECT id, shop_id FROM delivery_jobs
      WHERE status IN ('pending', 'retryable') AND next_attempt_at <= ?
      ORDER BY next_attempt_at, id LIMIT 50
    `, NOW)).toContain("idx_delivery_jobs_ready_claim");
    expect(plan(database, `
      SELECT id FROM domain_events
      WHERE shop_id = ? AND source_connection_id = ?
    `, "shop-hardening-a", "connection-hardening-a"))
      .toContain("idx_domain_events_source_connection_fk");

    database.prepare(`
      UPDATE delivery_jobs
      SET status = 'processing', attempts = 1, next_attempt_at = NULL,
        lease_token = 'lease-hardening-123456', lease_expires_at = ?,
        version = 2, updated_at = ?
      WHERE id = 'delivery-hardening-a'
    `).run(NOW, NOW);
    expect(() => database.prepare(`
      UPDATE delivery_jobs
      SET status = 'canceled', lease_token = NULL, lease_expires_at = NULL,
        last_safe_error_code = 'shop_deleted', version = 3, updated_at = ?
      WHERE id = 'delivery-hardening-a'
    `).run(NOW)).toThrow(/delivery_job_transition_invalid/u);

    database.prepare("UPDATE shops SET status = 'suspended' WHERE id = 'shop-hardening-a'").run();
    database.prepare(`
      UPDATE delivery_jobs
      SET status = 'canceled', lease_token = NULL, lease_expires_at = NULL,
        last_safe_error_code = 'shop_deleted', version = 3, updated_at = ?
      WHERE id = 'delivery-hardening-a'
    `).run(NOW);
    database.prepare(`
      UPDATE domain_events
      SET status = 'failed', next_attempt_at = NULL,
        last_safe_error_code = 'shop_deleted', version = 2, updated_at = ?
      WHERE id = 'event-hardening-a'
    `).run(NOW);

    database.prepare(`
      INSERT INTO queue_dead_letters (
        id, shop_id, scope_key, queue_name, message_id, message_kind,
        reference_type, reference_id, failure_code, safe_envelope_json,
        status, provider_attempts, occurrence_count, first_seen_at, last_seen_at,
        retry_count, version, created_at, updated_at
      ) VALUES (
        'dead-letter-hardening-a', 'shop-hardening-a', 'shop:shop-hardening-a',
        'notification', 'message-hardening-a', 'notification', 'outbox_job',
        'event-hardening-a', 'queue_retries_exhausted', '{}', 'open', 3, 1,
        ?, ?, 0, 1, ?, ?
      )
    `).run(NOW, NOW, NOW, NOW);
    database.prepare(`
      INSERT INTO queue_dead_letter_outbox_links (
        dead_letter_id, shop_id, target_kind, domain_event_id,
        replay_status, replay_count, version, created_at, updated_at
      ) VALUES (
        'dead-letter-hardening-a', 'shop-hardening-a', 'domain_event',
        'event-hardening-a', 'idle', 0, 1, ?, ?
      )
    `).run(NOW, NOW);
    expect(() => database.prepare(`
      UPDATE domain_events
      SET status = 'retryable', next_attempt_at = ?, version = 3, updated_at = ?
      WHERE id = 'event-hardening-a'
    `).run(NOW, NOW)).toThrow(/domain_event_transition_invalid/u);

    database.prepare(`
      UPDATE queue_dead_letters
      SET status = 'retry_requested', retry_requested_at = ?,
        retry_count = 1, version = 2, updated_at = ?
      WHERE id = 'dead-letter-hardening-a'
    `).run(NOW, NOW);
    database.prepare(`
      UPDATE queue_dead_letter_outbox_links
      SET replay_status = 'requested', replay_request_id = 'replay-hardening-a',
        replay_requested_at = ?, replay_count = 1, version = 2, updated_at = ?
      WHERE dead_letter_id = 'dead-letter-hardening-a'
    `).run(NOW, NOW);
    database.prepare(`
      UPDATE domain_events
      SET status = 'retryable', next_attempt_at = ?, version = 3, updated_at = ?
      WHERE id = 'event-hardening-a'
    `).run(NOW, NOW);

    expect(database.prepare(`
      SELECT status, next_attempt_at AS nextAttemptAt
      FROM domain_events WHERE id = 'event-hardening-a'
    `).get()).toEqual({ nextAttemptAt: NOW, status: "retryable" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally {
    database.close();
  }
});
