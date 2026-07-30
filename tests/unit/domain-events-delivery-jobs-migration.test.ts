import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-07-26T08:00:00.000Z";
const HASH = "a".repeat(64);
const databases: DatabaseSync[] = [];

function createDatabase(maximumMigration = Number.POSITIVE_INFINITY): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= maximumMigration)
    .sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
  database.exec(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency,
      timezone, readiness_version, created_at, updated_at
    ) VALUES
      ('shop-event-a', 'shop-event-public-a', 'event-a', 'Event A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'),
      ('shop-event-b', 'shop-event-public-b', 'event-b', 'Event B', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}');
    INSERT INTO shop_channels (
      id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
    ) VALUES
      ('channel-event-a', 'shop-event-a', 'telegram', 'enabled', '{}', 1, '${NOW}', '${NOW}'),
      ('channel-event-b', 'shop-event-b', 'telegram', 'enabled', '{}', 1, '${NOW}', '${NOW}');
    INSERT INTO channel_connections (
      id, public_id, shop_id, shop_channel_id, provider_code, external_account_id,
      status, settings_json, version, created_at, updated_at
    ) VALUES
      ('connection-event-a', 'connection-event-public-a', 'shop-event-a', 'channel-event-a', 'telegram', 'bot-event-a', 'active', '{}', 1, '${NOW}', '${NOW}'),
      ('connection-event-a2', 'connection-event-public-a2', 'shop-event-a', 'channel-event-a', 'telegram', 'bot-event-a2', 'degraded', '{}', 1, '${NOW}', '${NOW}'),
      ('connection-event-b', 'connection-event-public-b', 'shop-event-b', 'channel-event-b', 'telegram', 'bot-event-b', 'active', '{}', 1, '${NOW}', '${NOW}');
  `);
  return database;
}

function insertEvent(database: DatabaseSync, id = "event-aaa", shopId = "shop-event-a"): void {
  database.prepare(`
    INSERT INTO domain_events (
      id, shop_id, event_type, aggregate_type, aggregate_id, schema_version,
      idempotency_key_hash, status, attempts, next_attempt_at, occurred_at,
      created_at, updated_at
    ) VALUES (?, ?, 'order.paid', 'order', 'order-event-a', 1, ?, 'pending', 0, ?, ?, ?, ?)
  `).run(id, shopId, HASH, NOW, NOW, NOW, NOW);
}

function insertDelivery(database: DatabaseSync, id: string, connectionId: string, shopId = "shop-event-a"): void {
  database.prepare(`
    INSERT INTO delivery_jobs (
      id, shop_id, event_id, connection_id, purpose, queue_kind,
      idempotency_key_hash, status, attempts, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, 'event-aaa', ?, 'order_paid', 'notification', ?, 'pending', 0, ?, ?, ?)
  `).run(id, shopId, connectionId, HASH, NOW, NOW, NOW);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("domain event and delivery job migration", () => {
  it("keeps the event and delivery schema tenant-bound and reference-only", () => {
    const database = createDatabase(25);
    database.prepare(`
      INSERT INTO outbox_jobs (
        id, shop_id, kind, aggregate_type, aggregate_id, status, attempts,
        next_attempt_at, created_at, updated_at
      ) VALUES ('legacy-outbox-a', 'shop-event-a', 'order_paid', 'order',
        'legacy-order-a', 'pending', 0, ?, ?, ?)
    `).run(NOW, NOW, NOW);
    database.exec(readFileSync(
      join(process.cwd(), "migrations/0026_domain_event_delivery_outbox.sql"),
      "utf8",
    ));
    insertEvent(database);
    insertDelivery(database, "delivery-a", "connection-event-a");
    insertDelivery(database, "delivery-a2", "connection-event-a2");

    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare(`
      SELECT id, shop_id AS shopId, status, aggregate_id AS aggregateId
      FROM outbox_jobs WHERE id = 'legacy-outbox-a'
    `).get()).toEqual({
      aggregateId: "legacy-order-a",
      id: "legacy-outbox-a",
      shopId: "shop-event-a",
      status: "pending",
    });

    for (const table of ["domain_events", "delivery_jobs"]) {
      expect(database.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)?.sql)
        .toContain("STRICT");
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      expect(columns.some((column) => /payload|body|credential|secret|token_plaintext/iu.test(column.name))).toBe(false);
    }
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_delivery_jobs_shop_due'").get())
      .toEqual({ name: "idx_delivery_jobs_shop_due" });
  });

  it("supports independent fan-out, dedupe and same-tenant enforcement", () => {
    const database = createDatabase();
    insertEvent(database);
    insertDelivery(database, "delivery-a", "connection-event-a");
    insertDelivery(database, "delivery-a2", "connection-event-a2");

    expect(() => { insertDelivery(database, "delivery-duplicate", "connection-event-a"); }).toThrow(/UNIQUE/u);
    expect(() => { insertDelivery(database, "delivery-cross-tenant", "connection-event-b", "shop-event-b"); }).toThrow(/FOREIGN KEY|delivery_job_connection_unavailable/u);
    expect(() => database.prepare(`
      INSERT INTO domain_events (
        id, shop_id, event_type, aggregate_type, aggregate_id, schema_version,
        idempotency_key_hash, status, attempts, next_attempt_at, occurred_at,
        created_at, updated_at
      ) VALUES ('event-duplicate', 'shop-event-a', 'order.paid', 'order', 'order-event-a', 1, ?, 'pending', 0, ?, ?, ?, ?)
    `).run(HASH, NOW, NOW, NOW, NOW)).toThrow(/UNIQUE/u);
  });

  it("guards immutable identities and lease/status transitions", () => {
    const database = createDatabase();
    insertEvent(database);
    insertDelivery(database, "delivery-a", "connection-event-a");

    expect(() => database.prepare(`
      UPDATE domain_events
      SET event_type = 'order.refunded', status = 'processing', attempts = 1,
        lease_token = 'lease-event-123456', lease_expires_at = ?,
        next_attempt_at = NULL, version = 2
      WHERE id = 'event-aaa'
    `).run(NOW))
      .toThrow(/domain_event_identity_immutable/u);
    expect(() => database.prepare("DELETE FROM domain_events WHERE id = 'event-aaa'").run())
      .toThrow(/domain_event_immutable/u);

    database.prepare(`
      UPDATE domain_events
      SET status = 'processing', attempts = 1, lease_token = 'lease-event-123456',
        lease_expires_at = ?, next_attempt_at = NULL, version = 2, updated_at = ?
      WHERE id = 'event-aaa'
    `).run(NOW, NOW);
    database.prepare(`
      UPDATE domain_events
      SET status = 'published', attempts = 1, lease_token = NULL,
        lease_expires_at = NULL, published_at = ?, version = 3, updated_at = ?
      WHERE id = 'event-aaa'
    `).run(NOW, NOW);
    expect(() => database.prepare("UPDATE domain_events SET status = 'processing', version = 4 WHERE id = 'event-aaa'").run())
      .toThrow(/domain_event_transition_invalid/u);

    database.prepare(`
      UPDATE delivery_jobs
      SET status = 'processing', attempts = 1, lease_token = 'lease-delivery-123456',
        lease_expires_at = ?, next_attempt_at = NULL, version = 2, updated_at = ?
      WHERE id = 'delivery-a'
    `).run(NOW, NOW);
    database.prepare(`
      UPDATE delivery_jobs
      SET status = 'retryable', attempts = 2, lease_token = NULL,
        lease_expires_at = NULL, next_attempt_at = ?, version = 3, updated_at = ?
      WHERE id = 'delivery-a'
    `).run(NOW, NOW);
    database.prepare(`
      UPDATE delivery_jobs
      SET status = 'processing', attempts = 3, lease_token = 'lease-delivery-654321',
        lease_expires_at = ?, next_attempt_at = NULL, version = 4, updated_at = ?
      WHERE id = 'delivery-a'
    `).run(NOW, NOW);
    database.prepare(`
      UPDATE delivery_jobs
      SET status = 'delivered', attempts = 3, lease_token = NULL,
        lease_expires_at = NULL, delivered_at = ?, version = 5, updated_at = ?
      WHERE id = 'delivery-a'
    `).run(NOW, NOW);
    expect(() => database.prepare("UPDATE delivery_jobs SET status = 'processing', version = 6 WHERE id = 'delivery-a'").run())
      .toThrow(/delivery_job_transition_invalid/u);
  });

  it("rejects new fan-out to a disconnected connection", () => {
    const database = createDatabase();
    insertEvent(database);
    database.prepare("UPDATE channel_connections SET status = 'disconnected', version = 2 WHERE id = 'connection-event-a'").run();
    expect(() => { insertDelivery(database, "delivery-disconnected", "connection-event-a"); }).toThrow(/delivery_job_connection_unavailable/u);
  });
});
