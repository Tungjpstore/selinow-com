import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { recordDeadLetter, requestGenericDeadLetterReplay } from "../../src/lib/operations/dead-letters";
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
    VALUES ('user-ops', 'ops@example.test', 'Operations', 'active', ?, ?)
  `).run(now, now);
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency,
      timezone, readiness_version, created_at, updated_at
    ) VALUES ('shop-a', 'shop_public_a', 'shop-a', 'shop-a', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(now, now);
}

function seedDeadLetteredDeliveryJob(database: DatabaseSync): void {
  const now = NOW.toISOString();
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
}

describe("dead-letter replay service guard", () => {
  let database: DatabaseSync;
  let env: AppBindings;
  let sent: unknown[];

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    seedActors(database);
    seedDeadLetteredDeliveryJob(database);
    sent = [];
    env = {
      ...bindings(database),
      INTEGRATION_QUEUE: { send: () => Promise.resolve() },
      NOTIFICATION_QUEUE: {
        send: (message: unknown) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
      SESSION_SECRET: "test-session-secret-for-dead-letter-replay-guard",
    } as unknown as AppBindings;
  });

  afterEach(() => {
    database.close();
  });

  it("denies an un-enrolled admin through the real requireReplayOperator until enrollment completes", async () => {
    const now = NOW.toISOString();
    // Active owner admin without confirmed two-factor enrollment.
    database.prepare(`
      INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
      VALUES ('user-ops', 'owner', 'active', ?, ?)
    `).run(now, now);
    const created = await recordDeadLetter({
      env,
      failureCode: "delivery_retries_exhausted",
      messageId: "message-unenrolled-replay",
      messageKind: "notification",
      now: NOW,
      providerAttempts: 5,
      queueName: "notification",
      referenceId: "delivery-replay-a",
      referenceType: "outbox_job",
      shopId: "shop-a",
    });
    const request = {
      actorUserId: "user-ops",
      env,
      expectedVersion: created.version,
      id: created.id,
      idempotencyKey: "dead-letter-unenrolled-replay-0001",
      now: NOW,
      requestId: "request-unenrolled-replay",
      shopId: "shop-a",
    };

    await expect(requestGenericDeadLetterReplay(request))
      .rejects.toMatchObject({ code: "admin_two_factor_required", status: 403 });

    // No side effects: the dead letter, replay link, delivery job, audit trail,
    // and idempotency namespace all stay untouched, and nothing was enqueued.
    expect(database.prepare(`
      SELECT status, retry_count AS retryCount FROM queue_dead_letters WHERE id = ?
    `).get(created.id)).toEqual({ retryCount: 0, status: "open" });
    expect(database.prepare(`
      SELECT replay_status AS replayStatus, replay_count AS replayCount
      FROM queue_dead_letter_outbox_links WHERE dead_letter_id = ?
    `).get(created.id)).toEqual({ replayCount: 0, replayStatus: "idle" });
    expect(database.prepare("SELECT status FROM delivery_jobs WHERE id = 'delivery-replay-a'").get())
      .toEqual({ status: "dead_letter" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs
      WHERE action = 'operations.dead_letter_replay_requested'
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM idempotency_records
      WHERE namespace = 'admin.dead-letter-replay.v1'
    `).get()).toEqual({ count: 0 });
    expect(sent).toEqual([]);

    database.prepare(`
      UPDATE platform_users SET two_factor_enabled = 1, two_factor_enabled_at = ?
      WHERE id = 'user-ops'
    `).run(now);
    const replay = await requestGenericDeadLetterReplay(request);
    expect(replay.replayed).toBe(false);
    expect(replay.deadLetter.status).toBe("retry_requested");
    expect(sent).toHaveLength(1);
    expect(database.prepare(`
      SELECT replay_status AS replayStatus, replay_count AS replayCount
      FROM queue_dead_letter_outbox_links WHERE dead_letter_id = ?
    `).get(created.id)).toEqual({ replayCount: 1, replayStatus: "enqueued" });
  });
});
