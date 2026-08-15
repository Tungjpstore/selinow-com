import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acknowledgeDeadLetter,
  listActiveDeadLetters,
  recordDeadLetter,
  requestGenericDeadLetterReplay,
  requestDeadLetterRetry,
  resolveDeadLetter,
} from "../../src/lib/operations/dead-letters";
import {
  acknowledgeIncident,
  listActiveIncidents,
  resolveIncident,
  upsertOpenIncident,
} from "../../src/lib/operations/incidents";
import { consumeDeadLetterQueue } from "../../src/lib/operations/queue-dead-letter";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-07-26T03:00:00.000Z");

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]) {
    const sqlValues = values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    });
    return new SqliteStatement(this.database, this.sql, sqlValues);
  }

  first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.values) as T | undefined;
    return Promise.resolve(row ?? null);
  }

  all(): Promise<{ results: unknown[] }> {
    const results = this.database.prepare(this.sql).all(...this.values);
    return Promise.resolve({ results });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function bindings(database: DatabaseSync): AppBindings {
  const platformDb = {
    async batch(statements: D1PreparedStatement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql: string) {
      return new SqliteStatement(database, sql) as unknown as D1PreparedStatement;
    },
  };
  return { PLATFORM_DB: platformDb } as unknown as AppBindings;
}

function seedActors(database: DatabaseSync): void {
  const now = NOW.toISOString();
  database.prepare(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run("user-ops", "ops@example.test", "Operations", now, now);
  for (const shop of [
    { id: "shop-a", publicId: "shop_public_a", slug: "shop-a" },
    { id: "shop-b", publicId: "shop_public_b", slug: "shop-b" },
  ] as const) {
    database.prepare(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency,
        timezone, readiness_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(shop.id, shop.publicId, shop.slug, shop.id, now, now);
  }
}

function queueMessage(id: string, body: unknown, attempts = 6) {
  const state = { acked: 0, retried: 0 };
  return {
    message: {
      ack: () => { state.acked += 1; },
      attempts,
      body,
      id,
      retry: () => { state.retried += 1; },
    },
    state,
  };
}

describe("operations control plane", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    seedActors(database);
    env = bindings(database);
  });

  afterEach(() => {
    database.close();
  });

  it("applies the operations schema with tenant-leading indexes and immutable audit rows", () => {
    const names = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('table', 'index', 'trigger') AND name LIKE '%operations%'
         OR name IN ('queue_dead_letters', 'audit_logs_immutable_update',
           'audit_logs_immutable_delete', 'idx_outbox_jobs_shop_ready',
           'idx_outbox_jobs_shop_failed')
      ORDER BY name
    `).all().map((row) => String((row as { name: unknown }).name));
    expect(names).toEqual(expect.arrayContaining([
      "audit_logs_immutable_delete",
      "audit_logs_immutable_update",
      "idx_operations_incidents_shop_status",
      "idx_outbox_jobs_shop_failed",
      "idx_outbox_jobs_shop_ready",
      "operations_incidents",
      "queue_dead_letters",
    ]));

    database.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES (?, ?, 'system', NULL, 'operations.test', 'shop', ?, '{}', ?, ?)
    `).run("aud-test", "shop-a", "shop-a", "request-operations", NOW.toISOString());
    expect(() => database.prepare("UPDATE audit_logs SET action = 'changed' WHERE id = 'aud-test'").run())
      .toThrow(/audit_logs_immutable/u);
    expect(() => database.prepare("DELETE FROM audit_logs WHERE id = 'aud-test'").run())
      .toThrow(/audit_logs_immutable/u);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });

  it("reports when active incident and dead-letter lists are truncated", async () => {
    const now = NOW.toISOString();
    database.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 101
      )
      INSERT INTO operations_incidents (
        id, shop_id, scope_key, incident_key, category, severity, status,
        source_kind, source_ref, safe_context_json, occurrence_count,
        first_seen_at, last_seen_at, version, created_at, updated_at
      )
      SELECT printf('incident-visible-%03d', value), NULL, 'platform',
        printf('visibility-%03d', value), 'system_health', 'low', 'open',
        'system', printf('source-%03d', value), '{}', 1,
        '${now}', '${now}', 1, '${now}', '${now}'
      FROM sequence;

      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 101
      )
      INSERT INTO queue_dead_letters (
        id, shop_id, scope_key, queue_name, message_id, message_kind,
        reference_type, reference_id, failure_code, safe_envelope_json,
        status, provider_attempts, occurrence_count, first_seen_at,
        last_seen_at, retry_count, version, created_at, updated_at
      )
      SELECT printf('dead-letter-visible-%03d', value), NULL, 'platform',
        'integration-staging', printf('message-visible-%03d', value), 'integration',
        'none', NULL, 'queue_retries_exhausted', '{}', 'open', 6, 1,
        '${now}', '${now}', 0, 1, '${now}', '${now}'
      FROM sequence;
    `);

    const [deadLetters, incidents] = await Promise.all([
      listActiveDeadLetters({ env }),
      listActiveIncidents({ env }),
    ]);

    expect(deadLetters).toMatchObject({ hasMore: true, limit: 100 });
    expect(deadLetters.items).toHaveLength(100);
    expect(incidents).toMatchObject({ hasMore: true, limit: 100 });
    expect(incidents.items).toHaveLength(100);
  });

  it("deduplicates queue messages and stores only allowlisted references", async () => {
    const first = await recordDeadLetter({
      env,
      failureCode: "telegram_delivery_failed",
      messageId: "message-001",
      messageKind: "telegram_delivery",
      now: NOW,
      providerAttempts: 2,
      queueName: "notification-staging",
      referenceId: "job-001",
      referenceType: "outbox_job",
      safeEnvelope: { operationId: "operation-001", requestId: "request-001" },
      shopId: "shop-a",
    });
    const duplicate = await recordDeadLetter({
      env,
      failureCode: "telegram_delivery_failed",
      messageId: "message-001",
      messageKind: "telegram_delivery",
      now: new Date(NOW.getTime() + 1_000),
      providerAttempts: 4,
      queueName: "notification-staging",
      referenceId: "job-001",
      referenceType: "outbox_job",
      safeEnvelope: { operationId: "operation-001", requestId: "request-002" },
      shopId: "shop-a",
    });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.incidentId).toBe(first.incidentId);
    expect(duplicate.occurrenceCount).toBe(2);
    expect(duplicate.providerAttempts).toBe(4);
    expect(duplicate.safeEnvelope).toEqual({ operationId: "operation-001", requestId: "request-002" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM queue_dead_letters").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT occurrence_count AS count FROM operations_incidents").get()).toEqual({ count: 2 });

    await expect(recordDeadLetter({
      env,
      failureCode: "telegram_delivery_failed",
      messageId: "message-001",
      messageKind: "telegram_delivery",
      now: NOW,
      providerAttempts: 1,
      queueName: "notification-staging",
      referenceId: "job-other-tenant",
      referenceType: "outbox_job",
      shopId: "shop-b",
    })).rejects.toMatchObject({ code: "dead_letter_scope_conflict", status: 409 });

    await expect(recordDeadLetter({
      env,
      failureCode: "telegram_delivery_failed",
      messageId: "message-002",
      messageKind: "telegram_delivery",
      now: NOW,
      providerAttempts: 1,
      queueName: "notification-staging",
      referenceId: "job-002",
      referenceType: "outbox_job",
      safeEnvelope: { body: "raw-secret-payload" },
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "operations_validation_failed", status: 400 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM queue_dead_letters").get()).toEqual({ count: 1 });
  });

  it("persists exhausted queue messages before ack and deduplicates delivery replays", async () => {
    const body = {
      kind: "telegram_delivery",
      operationId: "operation-dlq-001",
      referenceId: "outbox-job-001",
      referenceType: "outbox_job",
      requestId: "request-dlq-001",
      shopId: "shop-a",
      sourceQueue: "notification",
      version: 1,
    };
    const first = queueMessage("message-exhausted-001", body);
    const firstResult = await consumeDeadLetterQueue({
      messages: [first.message],
      queue: "selinow-dlq-staging",
    }, env);
    expect(firstResult).toEqual({ persisted: 1, rejected: 0, retried: 0 });
    expect(first.state).toEqual({ acked: 1, retried: 0 });

    const replay = queueMessage("message-exhausted-001", body, 7);
    await consumeDeadLetterQueue({
      messages: [replay.message],
      queue: "selinow-dlq-staging",
    }, env);
    expect(replay.state).toEqual({ acked: 1, retried: 0 });
    expect(database.prepare(`
      SELECT status, occurrence_count AS occurrenceCount,
        provider_attempts AS providerAttempts, safe_envelope_json AS safeEnvelopeJson
      FROM queue_dead_letters WHERE message_id = ?
    `).get("message-exhausted-001")).toEqual({
      occurrenceCount: 2,
      providerAttempts: 7,
      safeEnvelopeJson: JSON.stringify({ operationId: "operation-dlq-001", requestId: "request-dlq-001" }),
      status: "open",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM queue_dead_letters").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM operations_incidents WHERE status = 'open'").get()).toEqual({ count: 1 });
  });

  it("auto-links generic dead letters only to same-tenant domain events and delivery jobs", async () => {
    const now = NOW.toISOString();
    database.exec(`
      INSERT INTO shop_channels (
        id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
      ) VALUES ('channel-dlq-link-a', 'shop-a', 'telegram', 'enabled', '{}', 1, '${now}', '${now}');
      INSERT INTO channel_connections (
        id, public_id, shop_id, shop_channel_id, provider_code, status,
        settings_json, version, created_at, updated_at
      ) VALUES ('connection-dlq-link-a', 'connection-dlq-link-public-a', 'shop-a',
        'channel-dlq-link-a', 'telegram', 'active', '{}', 1, '${now}', '${now}');
      INSERT INTO domain_events (
        id, shop_id, event_type, aggregate_type, aggregate_id, schema_version,
        idempotency_key_hash, status, attempts, next_attempt_at, occurred_at,
        created_at, updated_at
      ) VALUES ('event-dlq-link-a', 'shop-a', 'order.paid', 'order', 'order-dlq-link-a',
        1, '${"c".repeat(64)}', 'pending', 0, '${now}', '${now}', '${now}', '${now}');
      UPDATE domain_events SET status = 'processing', attempts = 1,
        next_attempt_at = NULL, lease_token = 'lease-event-dlq-link-1234',
        lease_expires_at = '${now}', version = 2, updated_at = '${now}'
      WHERE id = 'event-dlq-link-a';
      UPDATE domain_events SET status = 'failed', lease_token = NULL,
        lease_expires_at = NULL, last_safe_error_code = 'dispatch_failed',
        version = 3, updated_at = '${now}' WHERE id = 'event-dlq-link-a';
      INSERT INTO delivery_jobs (
        id, shop_id, event_id, connection_id, purpose, queue_kind,
        idempotency_key_hash, status, attempts, next_attempt_at, created_at, updated_at
      ) VALUES ('delivery-dlq-link-a', 'shop-a', 'event-dlq-link-a',
        'connection-dlq-link-a', 'order_paid', 'notification', '${"d".repeat(64)}',
        'pending', 0, '${now}', '${now}', '${now}');
      UPDATE delivery_jobs SET status = 'processing', attempts = 1,
        next_attempt_at = NULL, lease_token = 'lease-delivery-dlq-1234',
        lease_expires_at = '${now}', version = 2, updated_at = '${now}'
      WHERE id = 'delivery-dlq-link-a';
      UPDATE delivery_jobs SET status = 'dead_letter', lease_token = NULL,
        lease_expires_at = NULL, dead_lettered_at = '${now}',
        last_safe_error_code = 'delivery_failed', version = 3, updated_at = '${now}'
      WHERE id = 'delivery-dlq-link-a';
    `);
    const eventMessage = queueMessage("message-domain-event-dlq-link", {
      kind: "integration",
      operationId: "domain_event_dispatch",
      referenceId: "event-dlq-link-a",
      referenceType: "outbox_job",
      requestId: "request-domain-event-dlq-link",
      shopId: "shop-a",
      sourceQueue: "integration",
      version: 1,
    });
    const deliveryMessage = queueMessage("message-delivery-dlq-link", {
      kind: "notification",
      operationId: "channel_delivery",
      referenceId: "delivery-dlq-link-a",
      referenceType: "outbox_job",
      requestId: "request-delivery-dlq-link",
      shopId: "shop-a",
      sourceQueue: "notification",
      version: 1,
    });
    const crossTenantMessage = queueMessage("message-cross-tenant-dlq-link", {
      kind: "notification",
      operationId: "channel_delivery",
      referenceId: "delivery-dlq-link-a",
      referenceType: "outbox_job",
      requestId: "request-cross-tenant-dlq-link",
      shopId: "shop-b",
      sourceQueue: "notification",
      version: 1,
    });

    const result = await consumeDeadLetterQueue({
      messages: [eventMessage.message, deliveryMessage.message, crossTenantMessage.message],
      queue: "selinow-dlq-staging",
    }, env);

    expect(result).toEqual({ persisted: 3, rejected: 0, retried: 0 });
    expect(database.prepare(`
      SELECT queue_dead_letters.message_id AS messageId,
        queue_dead_letter_outbox_links.shop_id AS shopId,
        queue_dead_letter_outbox_links.target_kind AS targetKind,
        COALESCE(queue_dead_letter_outbox_links.domain_event_id,
          queue_dead_letter_outbox_links.delivery_job_id) AS targetId
      FROM queue_dead_letter_outbox_links
      INNER JOIN queue_dead_letters
        ON queue_dead_letters.id = queue_dead_letter_outbox_links.dead_letter_id
      ORDER BY queue_dead_letters.message_id
    `).all()).toEqual([
      {
        messageId: "message-delivery-dlq-link",
        shopId: "shop-a",
        targetId: "delivery-dlq-link-a",
        targetKind: "delivery_job",
      },
      {
        messageId: "message-domain-event-dlq-link",
        shopId: "shop-a",
        targetId: "event-dlq-link-a",
        targetKind: "domain_event",
      },
    ]);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM queue_dead_letter_outbox_links AS link
      INNER JOIN queue_dead_letters AS dead_letter ON dead_letter.id = link.dead_letter_id
      WHERE dead_letter.message_id = 'message-cross-tenant-dlq-link'
    `).get()).toEqual({ count: 0 });
  });

  it("stores a reference-free rejection record without persisting malformed secret-like bodies", async () => {
    const botToken = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const malformed = queueMessage("message-secret-like-001", {
      botToken,
      kind: "telegram_delivery",
      referenceId: "outbox-job-secret",
      referenceType: "outbox_job",
      shopId: "shop-a",
      sourceQueue: "notification",
      version: 1,
    });
    const result = await consumeDeadLetterQueue({
      messages: [malformed.message],
      queue: "selinow-dlq-staging",
    }, env);
    expect(result).toEqual({ persisted: 1, rejected: 1, retried: 0 });
    expect(malformed.state).toEqual({ acked: 1, retried: 0 });
    const stored = database.prepare(`
      SELECT shop_id AS shopId, message_kind AS messageKind,
        reference_type AS referenceType, reference_id AS referenceId,
        failure_code AS failureCode, safe_envelope_json AS safeEnvelopeJson
      FROM queue_dead_letters WHERE message_id = ?
    `).get("message-secret-like-001");
    expect(stored).toEqual({
      failureCode: "queue_envelope_rejected",
      messageKind: "unknown",
      referenceId: null,
      referenceType: "none",
      safeEnvelopeJson: "{}",
      shopId: null,
    });
    expect(JSON.stringify(stored)).not.toContain(botToken);
  });

  it("guards dead-letter transitions by tenant, state, and version", async () => {
    const created = await recordDeadLetter({
      env,
      failureCode: "provider_timeout",
      messageId: "message-guarded",
      messageKind: "integration",
      now: NOW,
      providerAttempts: 1,
      queueName: "integration-staging",
      referenceId: "payment-integration-001",
      referenceType: "payment_integration",
      shopId: "shop-a",
    });

    await expect(acknowledgeDeadLetter({
      actorUserId: "user-ops",
      env,
      expectedVersion: created.version,
      id: created.id,
      now: NOW,
      requestId: "request-dead-letter-cross-tenant",
      shopId: "shop-b",
    })).rejects.toMatchObject({ code: "dead_letter_not_found", status: 404 });

    const acknowledged = await acknowledgeDeadLetter({
      actorUserId: "user-ops",
      env,
      expectedVersion: created.version,
      id: created.id,
      now: NOW,
      requestId: "request-dead-letter-acknowledge",
      shopId: "shop-a",
    });
    await expect(acknowledgeDeadLetter({
      actorUserId: "user-ops",
      env,
      expectedVersion: created.version,
      id: created.id,
      now: NOW,
      requestId: "request-dead-letter-acknowledge-replay",
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "dead_letter_conflict", status: 409 });
    await expect(requestDeadLetterRetry({
      actorUserId: "user-ops",
      env,
      expectedVersion: created.version,
      id: created.id,
      now: NOW,
      requestId: "request-dead-letter-stale-retry",
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "dead_letter_conflict", status: 409 });

    const retry = await requestDeadLetterRetry({
      actorUserId: "user-ops",
      env,
      expectedVersion: acknowledged.version,
      id: acknowledged.id,
      now: NOW,
      requestId: "request-dead-letter-retry",
      shopId: "shop-a",
    });
    expect(retry.status).toBe("retry_requested");
    expect(retry.retryCount).toBe(1);

    const resolved = await resolveDeadLetter({
      actorUserId: "user-ops",
      env,
      expectedVersion: retry.version,
      id: retry.id,
      now: NOW,
      requestId: "request-dead-letter-resolve",
      resolutionCode: "retry_confirmed",
      shopId: "shop-a",
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolutionCode).toBe("retry_confirmed");
    expect(database.prepare(`
      SELECT action, request_id AS requestId
      FROM audit_logs WHERE resource_id = ? ORDER BY rowid
    `).all(created.id)).toEqual([
      {
        action: "operations.dead_letter_acknowledged",
        requestId: "request-dead-letter-acknowledge",
      },
      {
        action: "operations.dead_letter_retry_requested",
        requestId: "request-dead-letter-retry",
      },
      {
        action: "operations.dead_letter_resolved",
        requestId: "request-dead-letter-resolve",
      },
    ]);
  });

  it("recovers and enqueues a generic delivery dead letter exactly once per idempotency key", async () => {
    const now = NOW.toISOString();
    database.prepare(`
      INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
      VALUES ('user-ops', 'owner', 'active', ?, ?)
    `).run(now, now);
    database.exec(`
      INSERT INTO shop_channels (
        id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
      ) VALUES ('channel-replay-a', 'shop-a', 'telegram', 'enabled', '{}', 1, '${now}', '${now}');
      INSERT INTO channel_connections (
        id, public_id, shop_id, shop_channel_id, provider_code, status,
        settings_json, version, created_at, updated_at
      ) VALUES ('connection-replay-a', 'connection-replay-public-a', 'shop-a',
        'channel-replay-a', 'telegram', 'active', '{}', 1, '${now}', '${now}');
      INSERT INTO domain_events (
        id, shop_id, event_type, aggregate_type, aggregate_id, schema_version,
        idempotency_key_hash, status, attempts, next_attempt_at, occurred_at,
        created_at, updated_at
      ) VALUES ('event-replay-a', 'shop-a', 'order.paid', 'order', 'order-replay-a',
        1, '${"a".repeat(64)}', 'pending', 0, '${now}', '${now}', '${now}', '${now}');
      INSERT INTO delivery_jobs (
        id, shop_id, event_id, connection_id, purpose, queue_kind,
        idempotency_key_hash, status, attempts, next_attempt_at, created_at, updated_at
      ) VALUES ('delivery-replay-a', 'shop-a', 'event-replay-a', 'connection-replay-a',
        'order_paid', 'notification', '${"b".repeat(64)}', 'pending', 0, '${now}', '${now}', '${now}');
      UPDATE delivery_jobs SET status = 'processing', attempts = 1,
        next_attempt_at = NULL, lease_token = 'lease-replay-123456',
        lease_expires_at = '${now}', version = 2, updated_at = '${now}'
      WHERE id = 'delivery-replay-a';
      UPDATE delivery_jobs SET status = 'dead_letter', attempts = 1,
        lease_token = NULL, lease_expires_at = NULL, dead_lettered_at = '${now}',
        version = 3, updated_at = '${now}' WHERE id = 'delivery-replay-a';
    `);
    const created = await recordDeadLetter({
      env,
      failureCode: "delivery_retries_exhausted",
      messageId: "message-generic-replay-a",
      messageKind: "notification",
      now: NOW,
      providerAttempts: 5,
      queueName: "notification",
      referenceId: "delivery-replay-a",
      referenceType: "outbox_job",
      shopId: "shop-a",
    });
    expect(created).toMatchObject({
      replayStatus: "idle",
      replayTargetKind: "delivery_job",
    });
    expect(database.prepare(`
      SELECT target_kind AS targetKind, delivery_job_id AS deliveryJobId,
        replay_status AS replayStatus
      FROM queue_dead_letter_outbox_links WHERE dead_letter_id = ?
    `).get(created.id)).toEqual({
      deliveryJobId: "delivery-replay-a",
      replayStatus: "idle",
      targetKind: "delivery_job",
    });
    const sent: unknown[] = [];
    env = {
      ...bindings(database),
      INTEGRATION_QUEUE: { send: () => Promise.resolve() },
      NOTIFICATION_QUEUE: {
        send: (message: unknown) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
      SESSION_SECRET: "test-session-secret-for-dead-letter-replay",
    } as unknown as AppBindings;
    const request = {
      actorUserId: "user-ops",
      env,
      expectedVersion: created.version,
      id: created.id,
      idempotencyKey: "dead-letter-replay-0001",
      now: NOW,
      requestId: "request-generic-replay-a",
      shopId: "shop-a",
    };
    const first = await requestGenericDeadLetterReplay(request);
    const replay = await requestGenericDeadLetterReplay(request);

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ operationId: first.operationId, replayed: true });
    expect(sent).toEqual([{
      kind: "notification",
      operationId: "channel_delivery",
      referenceId: "delivery-replay-a",
      referenceType: "outbox_job",
      requestId: "request-generic-replay-a",
      shopId: "shop-a",
      sourceQueue: "notification",
      version: 1,
    }]);
    expect(database.prepare(`
      SELECT queue_dead_letters.status, queue_dead_letters.retry_count AS retryCount,
        queue_dead_letter_outbox_links.replay_status AS replayStatus,
        queue_dead_letter_outbox_links.replay_count AS replayCount,
        delivery_jobs.status AS deliveryStatus
      FROM queue_dead_letters
      INNER JOIN queue_dead_letter_outbox_links
        ON queue_dead_letter_outbox_links.dead_letter_id = queue_dead_letters.id
      INNER JOIN delivery_jobs ON delivery_jobs.id = queue_dead_letter_outbox_links.delivery_job_id
      WHERE queue_dead_letters.id = ? AND queue_dead_letters.shop_id = 'shop-a'
    `).get(created.id)).toEqual({
      deliveryStatus: "retryable",
      replayCount: 1,
      replayStatus: "enqueued",
      retryCount: 1,
      status: "retry_requested",
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs
      WHERE resource_id = ? AND action = 'operations.dead_letter_replay_requested'
    `).get(created.id)).toEqual({ count: 1 });
    await expect(requestGenericDeadLetterReplay({
      ...request,
      idempotencyKey: "dead-letter-replay-other-0001",
      shopId: "shop-b",
    }))
      .rejects.toMatchObject({ code: "dead_letter_not_found", status: 404 });
    database.prepare("UPDATE platform_admins SET role = 'support' WHERE user_id = 'user-ops'").run();
    await expect(requestGenericDeadLetterReplay({
      ...request,
      idempotencyKey: "dead-letter-replay-support-0001",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });

  it("links a repeated dead letter to a new incident after the previous incident is resolved", async () => {
    const first = await recordDeadLetter({
      env,
      failureCode: "provider_timeout",
      messageId: "message-reopened",
      messageKind: "integration",
      now: NOW,
      providerAttempts: 1,
      queueName: "integration-staging",
      referenceId: "payment-integration-reopened",
      referenceType: "payment_integration",
      shopId: "shop-a",
    });
    const firstIncidentId = first.incidentId;
    expect(firstIncidentId).not.toBeNull();
    await resolveIncident({
      actorUserId: "user-ops",
      env,
      expectedVersion: 1,
      incidentId: String(firstIncidentId),
      now: NOW,
      requestId: "request-incident-resolve-before-reopen",
      resolutionCode: "provider_restored",
      shopId: "shop-a",
    });

    const repeated = await recordDeadLetter({
      env,
      failureCode: "provider_timeout",
      messageId: "message-reopened",
      messageKind: "integration",
      now: new Date(NOW.getTime() + 1_000),
      providerAttempts: 2,
      queueName: "integration-staging",
      referenceId: "payment-integration-reopened",
      referenceType: "payment_integration",
      shopId: "shop-a",
    });
    expect(repeated.id).toBe(first.id);
    expect(repeated.incidentId).not.toBe(firstIncidentId);
    expect(database.prepare("SELECT COUNT(*) AS count FROM operations_incidents").get()).toEqual({ count: 2 });
  });

  it("reopens, escalates, acknowledges, and resolves incidents with optimistic guards", async () => {
    const first = await upsertOpenIncident({
      category: "system_health",
      env,
      incidentKey: "health:database",
      now: NOW,
      safeContext: { operationId: "health-check-001" },
      severity: "medium",
      shopId: null,
      sourceKind: "system",
      sourceRef: "platform-database",
    });
    const acknowledged = await acknowledgeIncident({
      actorUserId: "user-ops",
      env,
      expectedVersion: first.version,
      incidentId: first.id,
      now: NOW,
      requestId: "request-incident-acknowledge",
      shopId: null,
    });
    await expect(acknowledgeIncident({
      actorUserId: "user-ops",
      env,
      expectedVersion: first.version,
      incidentId: first.id,
      now: NOW,
      requestId: "request-incident-acknowledge-replay",
      shopId: null,
    })).rejects.toMatchObject({ code: "operations_incident_conflict", status: 409 });
    const reopened = await upsertOpenIncident({
      category: "system_health",
      env,
      incidentKey: "health:database",
      now: new Date(NOW.getTime() + 1_000),
      safeContext: { operationId: "health-check-002" },
      severity: "critical",
      shopId: null,
      sourceKind: "system",
      sourceRef: "platform-database",
    });

    expect(reopened.id).toBe(first.id);
    expect(reopened.status).toBe("open");
    expect(reopened.severity).toBe("critical");
    expect(reopened.occurrenceCount).toBe(2);
    expect(reopened.acknowledgedAt).toBeNull();
    await expect(resolveIncident({
      actorUserId: "user-ops",
      env,
      expectedVersion: acknowledged.version,
      incidentId: first.id,
      now: NOW,
      requestId: "request-incident-stale-resolve",
      resolutionCode: "health_restored",
      shopId: null,
    })).rejects.toMatchObject({ code: "operations_incident_conflict", status: 409 });

    const resolved = await resolveIncident({
      actorUserId: "user-ops",
      env,
      expectedVersion: reopened.version,
      incidentId: first.id,
      now: NOW,
      requestId: "request-incident-resolve",
      resolutionCode: "health_restored",
      shopId: null,
    });
    expect(resolved.status).toBe("resolved");
    expect(database.prepare(`
      SELECT action, request_id AS requestId
      FROM audit_logs WHERE resource_id = ? ORDER BY rowid
    `).all(first.id)).toEqual([
      {
        action: "operations.incident_acknowledged",
        requestId: "request-incident-acknowledge",
      },
      {
        action: "operations.incident_resolved",
        requestId: "request-incident-resolve",
      },
    ]);
  });
});
