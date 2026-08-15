import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claimDeliveryJob,
  claimDeliveryProviderAttempt,
  claimDeliveryJobReference,
  claimDomainEvent,
  dispatchDomainEventReference,
  dispatchDueDomainEvents,
  enqueueDueDeliveryJobs,
  settleDeliveryJob,
  terminalizeDeliveryProviderOutcomeUnknown,
  type DeliveryJobClaim,
  type DomainDeliveryQueueEnvelope,
} from "../../src/lib/delivery/runtime";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-07-27T00:00:00.000Z");

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }));
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const testDatabase = this.database as DatabaseSync & { failNextAuditInsert?: boolean };
    if (testDatabase.failNextAuditInsert && this.sql.includes("INSERT INTO audit_logs")) {
      testDatabase.failNextAuditInsert = false;
      return Promise.reject(new Error("audit_unavailable"));
    }
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class MemoryQueue {
  failNext = false;
  readonly sent: DomainDeliveryQueueEnvelope[] = [];

  send(body: unknown): Promise<QueueSendResponse> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error("queue_unavailable"));
    }
    this.sent.push(body as DomainDeliveryQueueEnvelope);
    return Promise.resolve({
      metadata: { metrics: { backlogBytes: 0, backlogCount: this.sent.length } },
    });
  }
}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function createBindings(database: DatabaseSync): {
  env: AppBindings;
  integrationQueue: MemoryQueue;
  notificationQueue: MemoryQueue;
} {
  const integrationQueue = new MemoryQueue();
  const notificationQueue = new MemoryQueue();
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
  return {
    env: {
      INTEGRATION_QUEUE: integrationQueue,
      NOTIFICATION_QUEUE: notificationQueue,
      PLATFORM_DB: platformDb,
    } as unknown as AppBindings,
    integrationQueue,
    notificationQueue,
  };
}

function seedShop(database: DatabaseSync, shopId: string, status = "active"): void {
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency,
      timezone, readiness_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(
    shopId,
    `public-${shopId}`,
    shopId,
    shopId,
    status,
    NOW.toISOString(),
    NOW.toISOString(),
  );
}

function seedConnection(input: {
  channelStatus?: "disabled" | "enabled" | "pending";
  connectionId: string;
  database: DatabaseSync;
  grantExpiresAt?: string | null;
  providerCode?: string;
  shopId: string;
  status?: "active" | "degraded" | "disconnected";
  withGrant?: boolean;
}): void {
  const channelId = `channel-${input.shopId}-${input.providerCode ?? "telegram"}`;
  const providerCode = input.providerCode ?? "telegram";
  input.database.prepare(`
    INSERT OR IGNORE INTO shop_channels (
      id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '{}', 1, ?, ?)
  `).run(
    channelId,
    input.shopId,
    providerCode,
    input.channelStatus ?? "enabled",
    NOW.toISOString(),
    NOW.toISOString(),
  );
  input.database.prepare(`
    INSERT INTO channel_connections (
      id, public_id, shop_id, shop_channel_id, provider_code, status,
      settings_json, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, '{}', 1, ?, ?)
  `).run(
    input.connectionId,
    `public-${input.connectionId}`,
    input.shopId,
    channelId,
    providerCode,
    input.status ?? "active",
    NOW.toISOString(),
    NOW.toISOString(),
  );
  if (input.withGrant === false) return;
  input.database.prepare(`
    INSERT INTO channel_connection_grants (
      shop_id, connection_id, capability_code, granted_at, expires_at
    ) VALUES (?, ?, 'conversation.outbound', ?, ?)
  `).run(
    input.shopId,
    input.connectionId,
    NOW.toISOString(),
    input.grantExpiresAt ?? null,
  );
}

function eventHash(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function seedPaidOrderEvent(input: {
  connectionId?: string | null;
  database: DatabaseSync;
  eventId: string;
  eventType?: string;
  hashIndex: number;
  orderId: string;
  paymentStatus?: "paid" | "unpaid";
  schemaVersion?: number;
  shopId: string;
  sourceChannel?: "telegram" | "web";
}): void {
  const nowIso = NOW.toISOString();
  input.database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel,
      status, payment_status, fulfillment_status, subtotal_minor,
      discount_minor, total_minor, currency, locale, checkout_subject_hash,
      order_token_hash, expires_at, paid_at, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, 'processing', ?, 'fulfilled', 0, 0, 0,
      'VND', 'vi', ?, ?, '2099-01-01T00:00:00.000Z', ?, ?, ?)
  `).run(
    input.orderId,
    `public-${input.orderId}`,
    input.shopId,
    `number-${input.orderId}`,
    input.sourceChannel ?? "telegram",
    input.paymentStatus ?? "paid",
    `subject-${input.orderId}`,
    `token-${input.orderId}`,
    input.paymentStatus === "unpaid" ? null : nowIso,
    nowIso,
    nowIso,
  );
  input.database.prepare(`
    INSERT INTO order_channel_attributions (
      shop_id, order_id, channel_code, adapter_version, connection_id, created_at
    ) VALUES (?, ?, ?, 1, ?, ?)
  `).run(
    input.shopId,
    input.orderId,
    input.sourceChannel ?? "telegram",
    input.connectionId ?? null,
    nowIso,
  );
  input.database.prepare(`
    INSERT INTO domain_events (
      id, shop_id, event_type, aggregate_type, aggregate_id, schema_version,
      idempotency_key_hash, source_connection_id, status, attempts,
      next_attempt_at, occurred_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'order', ?, ?, ?, ?, 'pending', 0, ?, ?, 1, ?, ?)
  `).run(
    input.eventId,
    input.shopId,
    input.eventType ?? "order.paid",
    input.orderId,
    input.schemaVersion ?? 1,
    eventHash(input.hashIndex),
    input.connectionId ?? null,
    nowIso,
    nowIso,
    nowIso,
    nowIso,
  );
}

function deliveryJobRow(database: DatabaseSync): {
  attempts: number;
  connectionId: string;
  eventId: string;
  id: string;
  lastSafeErrorCode: string | null;
  leaseToken: string | null;
  nextAttemptAt: string | null;
  purpose: string;
  status: string;
  version: number;
} {
  const row = database.prepare(`
    SELECT id, event_id AS eventId, connection_id AS connectionId, purpose,
      status, attempts, next_attempt_at AS nextAttemptAt,
      lease_token AS leaseToken, last_safe_error_code AS lastSafeErrorCode,
      version
    FROM delivery_jobs LIMIT 1
  `).get();
  if (row === undefined) throw new Error("delivery_job_missing");
  return row as ReturnType<typeof deliveryJobRow>;
}

describe("generic domain event and delivery runtime", () => {
  let database: DatabaseSync;
  let env: AppBindings;
  let integrationQueue: MemoryQueue;
  let notificationQueue: MemoryQueue;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    ({ env, integrationQueue, notificationQueue } = createBindings(database));
  });

  afterEach(() => {
    database.close();
  });

  it("publishes order.paid@1 before enqueueing one idempotent reference-only delivery", async () => {
    seedShop(database, "shop-runtime-a");
    seedConnection({ connectionId: "connection-runtime-a", database, shopId: "shop-runtime-a" });
    seedPaidOrderEvent({
      connectionId: "connection-runtime-a",
      database,
      eventId: "event-runtime-paid-a",
      hashIndex: 1,
      orderId: "order-runtime-a",
      shopId: "shop-runtime-a",
    });

    const result = await dispatchDueDomainEvents(env, NOW);

    expect(result).toMatchObject({
      candidates: 1,
      createdJobs: 1,
      enqueueFailures: 0,
      enqueuedJobs: 1,
      published: 1,
    });
    expect(database.prepare(`
      SELECT status, published_at AS publishedAt, lease_token AS leaseToken,
        version FROM domain_events WHERE id = 'event-runtime-paid-a'
    `).get()).toEqual({
      leaseToken: null,
      publishedAt: NOW.toISOString(),
      status: "published",
      version: 3,
    });
    expect(deliveryJobRow(database)).toMatchObject({
      attempts: 0,
      connectionId: "connection-runtime-a",
      eventId: "event-runtime-paid-a",
      purpose: "order.paid",
      status: "pending",
      version: 1,
    });
    expect(integrationQueue.sent).toEqual([]);
    expect(notificationQueue.sent).toHaveLength(1);
    expect(notificationQueue.sent[0]).toMatchObject({
      kind: "notification",
      operationId: "channel_delivery",
      referenceId: deliveryJobRow(database).id,
      referenceType: "outbox_job",
      shopId: "shop-runtime-a",
      sourceQueue: "notification",
      version: 1,
    });
    expect(Object.keys(notificationQueue.sent[0] ?? {}).sort()).toEqual([
      "kind",
      "operationId",
      "referenceId",
      "referenceType",
      "requestId",
      "shopId",
      "sourceQueue",
      "version",
    ]);
    await expect(dispatchDomainEventReference({
      env,
      eventId: "event-runtime-paid-a",
      now: NOW,
      shopId: "shop-runtime-a",
    })).resolves.toMatchObject({ state: "not_claimed" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_jobs").get())
      .toEqual({ count: 1 });
  });

  it("publishes a paid website event without inventing a channel delivery", async () => {
    seedShop(database, "shop-runtime-web");
    seedPaidOrderEvent({
      connectionId: null,
      database,
      eventId: "event-runtime-web",
      hashIndex: 2,
      orderId: "order-runtime-web",
      shopId: "shop-runtime-web",
      sourceChannel: "web",
    });

    await expect(dispatchDueDomainEvents(env, NOW)).resolves.toMatchObject({
      createdJobs: 0,
      published: 1,
    });
    expect(database.prepare("SELECT status FROM domain_events WHERE id = 'event-runtime-web'").get())
      .toEqual({ status: "published" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_jobs").get())
      .toEqual({ count: 0 });
    expect(notificationQueue.sent).toEqual([]);
  });

  it("publishes order.created as an unsubscribed event without a delivery job", async () => {
    seedShop(database, "shop-runtime-created");
    seedConnection({
      connectionId: "connection-runtime-created",
      database,
      shopId: "shop-runtime-created",
    });
    seedPaidOrderEvent({
      connectionId: "connection-runtime-created",
      database,
      eventId: "event-runtime-created",
      eventType: "order.created",
      hashIndex: 3,
      orderId: "order-runtime-created",
      shopId: "shop-runtime-created",
    });

    await expect(dispatchDueDomainEvents(env, NOW)).resolves.toMatchObject({
      createdJobs: 0,
      failed: 0,
      published: 1,
    });
    expect(database.prepare(`
      SELECT status, published_at AS publishedAt,
        last_safe_error_code AS lastSafeErrorCode, version
      FROM domain_events WHERE id = 'event-runtime-created'
    `).get()).toEqual({
      lastSafeErrorCode: null,
      publishedAt: NOW.toISOString(),
      status: "published",
      version: 3,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_jobs").get())
      .toEqual({ count: 0 });
    expect(notificationQueue.sent).toEqual([]);
  });

  it("fails closed for ineligible tenant or connection routes", async () => {
    seedShop(database, "shop-runtime-gates");
    seedShop(database, "shop-runtime-suspended");
    seedConnection({
      connectionId: "connection-runtime-good",
      database,
      shopId: "shop-runtime-gates",
    });
    seedConnection({
      connectionId: "connection-runtime-missing-grant",
      database,
      shopId: "shop-runtime-gates",
      withGrant: false,
    });
    seedConnection({
      connectionId: "connection-runtime-expired-grant",
      database,
      grantExpiresAt: "2026-07-26T23:59:59.000Z",
      shopId: "shop-runtime-gates",
    });
    seedConnection({
      connectionId: "connection-runtime-disconnected",
      database,
      shopId: "shop-runtime-gates",
      status: "disconnected",
    });
    seedConnection({
      connectionId: "connection-runtime-suspended",
      database,
      shopId: "shop-runtime-suspended",
    });
    const rows = [
      ["event-runtime-no-grant", "order-runtime-no-grant", "connection-runtime-missing-grant", "order.paid", "shop-runtime-gates"],
      ["event-runtime-expired", "order-runtime-expired", "connection-runtime-expired-grant", "order.paid", "shop-runtime-gates"],
      ["event-runtime-disconnected", "order-runtime-disconnected", "connection-runtime-disconnected", "order.paid", "shop-runtime-gates"],
      ["event-runtime-suspended", "order-runtime-suspended", "connection-runtime-suspended", "order.paid", "shop-runtime-suspended"],
    ] as const;
    rows.forEach(([eventId, orderId, connectionId, eventType, shopId], index) => {
      seedPaidOrderEvent({
        connectionId,
        database,
        eventId,
        eventType,
        hashIndex: index + 10,
        orderId,
        shopId,
      });
    });
    database.prepare(`
      UPDATE shops SET status = 'suspended', updated_at = ?
      WHERE id = 'shop-runtime-suspended'
    `).run(NOW.toISOString());

    await expect(dispatchDueDomainEvents(env, NOW)).resolves.toMatchObject({
      candidates: 4,
      createdJobs: 0,
      failed: 4,
    });
    const events = database.prepare(`
      SELECT id, status, last_safe_error_code AS errorCode
      FROM domain_events ORDER BY id
    `).all();
    expect(events).toEqual(expect.arrayContaining([
      { errorCode: "delivery_route_ineligible", id: "event-runtime-disconnected", status: "failed" },
      { errorCode: "delivery_route_ineligible", id: "event-runtime-expired", status: "failed" },
      { errorCode: "delivery_route_ineligible", id: "event-runtime-no-grant", status: "failed" },
      { errorCode: "shop_inactive", id: "event-runtime-suspended", status: "failed" },
    ]));
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_jobs").get())
      .toEqual({ count: 0 });
    expect(notificationQueue.sent).toEqual([]);
  });

  it.each(["pending", "disabled"] as const)(
    "fails closed before dispatch when the parent shop channel is %s",
    async (channelStatus) => {
      const shopId = `shop-runtime-channel-${channelStatus}`;
      const connectionId = `connection-runtime-channel-${channelStatus}`;
      const eventId = `event-runtime-channel-${channelStatus}`;
      seedShop(database, shopId);
      seedConnection({ channelStatus, connectionId, database, shopId });
      seedPaidOrderEvent({
        connectionId,
        database,
        eventId,
        hashIndex: channelStatus === "pending" ? 18 : 19,
        orderId: `order-runtime-channel-${channelStatus}`,
        shopId,
      });

      await expect(dispatchDueDomainEvents(env, NOW)).resolves.toMatchObject({
        candidates: 1,
        createdJobs: 0,
        failed: 1,
      });
      expect(database.prepare(`
        SELECT status, last_safe_error_code AS errorCode
        FROM domain_events WHERE id = ?
      `).get(eventId)).toEqual({
        errorCode: "delivery_route_ineligible",
        status: "failed",
      });
      expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_jobs").get())
        .toEqual({ count: 0 });
      expect(notificationQueue.sent).toEqual([]);
    },
  );

  it("uses version CAS so only one event claimant wins and expired leases are reclaimable", async () => {
    seedShop(database, "shop-runtime-cas");
    seedPaidOrderEvent({
      connectionId: null,
      database,
      eventId: "event-runtime-cas",
      hashIndex: 20,
      orderId: "order-runtime-cas",
      shopId: "shop-runtime-cas",
      sourceChannel: "web",
    });

    const claims = await Promise.all([
      claimDomainEvent({
        database: env.PLATFORM_DB,
        eventId: "event-runtime-cas",
        expectedVersion: 1,
        now: NOW,
        shopId: "shop-runtime-cas",
      }),
      claimDomainEvent({
        database: env.PLATFORM_DB,
        eventId: "event-runtime-cas",
        expectedVersion: 1,
        now: NOW,
        shopId: "shop-runtime-cas",
      }),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const first = claims.find((claim): claim is NonNullable<typeof claim> => claim !== null);
    if (first === undefined) throw new Error("event_claim_missing");
    const reclaimedAt = new Date(first.leaseExpiresAt);
    const reclaimed = await claimDomainEvent({
      database: env.PLATFORM_DB,
      eventId: first.id,
      expectedVersion: first.version,
      now: reclaimedAt,
      shopId: first.shopId,
    });
    expect(reclaimed).toMatchObject({ attempts: 2, version: 3 });
    expect(reclaimed?.leaseToken).not.toBe(first.leaseToken);
  });

  it("keeps a durable pending job when enqueue fails and cron re-enqueues its reference", async () => {
    seedShop(database, "shop-runtime-requeue");
    seedConnection({
      connectionId: "connection-runtime-requeue",
      database,
      shopId: "shop-runtime-requeue",
    });
    seedPaidOrderEvent({
      connectionId: "connection-runtime-requeue",
      database,
      eventId: "event-runtime-requeue",
      hashIndex: 30,
      orderId: "order-runtime-requeue",
      shopId: "shop-runtime-requeue",
    });
    notificationQueue.failNext = true;

    await expect(dispatchDueDomainEvents(env, NOW)).resolves.toMatchObject({
      createdJobs: 1,
      enqueueFailures: 1,
      published: 1,
    });
    expect(deliveryJobRow(database)).toMatchObject({ status: "pending", version: 1 });
    expect(notificationQueue.sent).toEqual([]);

    await expect(enqueueDueDeliveryJobs(env, NOW)).resolves.toEqual({
      candidates: 1,
      failed: 0,
      sent: 1,
    });
    expect(notificationQueue.sent[0]).toMatchObject({
      operationId: "channel_delivery",
      referenceId: deliveryJobRow(database).id,
      shopId: "shop-runtime-requeue",
    });
  });

  it("stops enqueue and claim when the parent shop channel is disabled after job creation", async () => {
    seedShop(database, "shop-runtime-disabled-job");
    seedConnection({
      connectionId: "connection-runtime-disabled-job",
      database,
      shopId: "shop-runtime-disabled-job",
    });
    seedPaidOrderEvent({
      connectionId: "connection-runtime-disabled-job",
      database,
      eventId: "event-runtime-disabled-job",
      hashIndex: 35,
      orderId: "order-runtime-disabled-job",
      shopId: "shop-runtime-disabled-job",
    });
    await dispatchDueDomainEvents(env, NOW);
    notificationQueue.sent.length = 0;
    const job = deliveryJobRow(database);
    database.prepare(`
      UPDATE shop_channels
      SET status = 'disabled', version = version + 1, updated_at = ?
      WHERE shop_id = ? AND id = (
        SELECT shop_channel_id FROM channel_connections
        WHERE shop_id = ? AND id = ?
      )
    `).run(
      new Date(NOW.getTime() + 1_000).toISOString(),
      "shop-runtime-disabled-job",
      "shop-runtime-disabled-job",
      "connection-runtime-disabled-job",
    );

    const retryNow = new Date(NOW.getTime() + 2_000);
    await expect(enqueueDueDeliveryJobs(env, retryNow)).resolves.toEqual({
      candidates: 0,
      failed: 0,
      sent: 0,
    });
    await expect(claimDeliveryJobReference({
      env,
      jobId: job.id,
      now: retryNow,
      queueKind: "notification",
      shopId: "shop-runtime-disabled-job",
    })).resolves.toBeNull();
    await expect(claimDeliveryJob({
      database: env.PLATFORM_DB,
      expectedVersion: job.version,
      jobId: job.id,
      now: retryNow,
      queueKind: "notification",
      shopId: "shop-runtime-disabled-job",
    })).resolves.toBeNull();
    expect(deliveryJobRow(database)).toMatchObject({ attempts: 0, status: "pending", version: 1 });
    expect(notificationQueue.sent).toEqual([]);
  });

  it("claims and settles delivery jobs with tenant, version and lease ownership guards", async () => {
    seedShop(database, "shop-runtime-delivery");
    seedShop(database, "shop-runtime-other");
    seedConnection({
      connectionId: "connection-runtime-delivery",
      database,
      shopId: "shop-runtime-delivery",
      status: "degraded",
    });
    seedPaidOrderEvent({
      connectionId: "connection-runtime-delivery",
      database,
      eventId: "event-runtime-delivery",
      hashIndex: 40,
      orderId: "order-runtime-delivery",
      shopId: "shop-runtime-delivery",
    });
    await dispatchDueDomainEvents(env, NOW);
    notificationQueue.sent.length = 0;
    const job = deliveryJobRow(database);

    await expect(claimDeliveryJob({
      database: env.PLATFORM_DB,
      expectedVersion: job.version,
      jobId: job.id,
      now: NOW,
      queueKind: "notification",
      shopId: "shop-runtime-other",
    })).resolves.toBeNull();
    const claims = await Promise.all([
      claimDeliveryJob({
        database: env.PLATFORM_DB,
        expectedVersion: job.version,
        jobId: job.id,
        now: NOW,
        queueKind: "notification",
        shopId: "shop-runtime-delivery",
      }),
      claimDeliveryJob({
        database: env.PLATFORM_DB,
        expectedVersion: job.version,
        jobId: job.id,
        now: NOW,
        queueKind: "notification",
        shopId: "shop-runtime-delivery",
      }),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    const claim = claims.find((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
    if (claim === undefined) throw new Error("delivery_claim_missing");
    expect(claim).toMatchObject({
      attempts: 1,
      connectionId: "connection-runtime-delivery",
      eventId: "event-runtime-delivery",
      orderId: "order-runtime-delivery",
      providerCode: "telegram",
      purpose: "order.paid",
      version: 2,
    });
    const staleClaim: DeliveryJobClaim = { ...claim, version: claim.version - 1 };
    await expect(settleDeliveryJob({
      claim: staleClaim,
      database: env.PLATFORM_DB,
      now: new Date(NOW.getTime() + 1_000),
      settlement: { status: "delivered" },
    })).resolves.toBe(false);
    const retryAt = new Date(NOW.getTime() + 60_000).toISOString();
    await expect(settleDeliveryJob({
      claim,
      database: env.PLATFORM_DB,
      now: new Date(NOW.getTime() + 1_000),
      settlement: {
        errorCode: "telegram_rate_limited",
        nextAttemptAt: retryAt,
        status: "retryable",
      },
    })).resolves.toBe(true);
    expect(deliveryJobRow(database)).toMatchObject({
      attempts: 1,
      lastSafeErrorCode: "telegram_rate_limited",
      leaseToken: null,
      nextAttemptAt: retryAt,
      status: "retryable",
      version: 3,
    });

    const retryNow = new Date(NOW.getTime() + 61_000);
    await expect(enqueueDueDeliveryJobs(env, retryNow)).resolves.toEqual({
      candidates: 1,
      failed: 0,
      sent: 1,
    });
    const retryClaim = await claimDeliveryJobReference({
      env,
      jobId: job.id,
      now: retryNow,
      queueKind: "notification",
      shopId: "shop-runtime-delivery",
    });
    if (retryClaim === null) throw new Error("delivery_retry_claim_missing");
    await expect(settleDeliveryJob({
      claim: retryClaim,
      database: env.PLATFORM_DB,
      now: new Date(retryNow.getTime() + 1_000),
      settlement: { status: "delivered" },
    })).resolves.toBe(true);
    expect(deliveryJobRow(database)).toMatchObject({
      attempts: 2,
      lastSafeErrorCode: null,
      status: "delivered",
      version: 5,
    });
    await expect(settleDeliveryJob({
      claim: retryClaim,
      database: env.PLATFORM_DB,
      now: new Date(retryNow.getTime() + 2_000),
      settlement: { status: "delivered" },
    })).resolves.toBe(false);
  });

  it("cron re-enqueues expired processing leases and a new claimant can dead-letter them", async () => {
    seedShop(database, "shop-runtime-expired-job");
    seedConnection({
      connectionId: "connection-runtime-expired-job",
      database,
      shopId: "shop-runtime-expired-job",
    });
    seedPaidOrderEvent({
      connectionId: "connection-runtime-expired-job",
      database,
      eventId: "event-runtime-expired-job",
      hashIndex: 50,
      orderId: "order-runtime-expired-job",
      shopId: "shop-runtime-expired-job",
    });
    await dispatchDueDomainEvents(env, NOW);
    notificationQueue.sent.length = 0;
    const job = deliveryJobRow(database);
    const firstClaim = await claimDeliveryJobReference({
      env,
      jobId: job.id,
      now: NOW,
      queueKind: "notification",
      shopId: "shop-runtime-expired-job",
    });
    if (firstClaim === null) throw new Error("delivery_claim_missing");
    const expiredAt = new Date(firstClaim.leaseExpiresAt);

    await expect(enqueueDueDeliveryJobs(env, expiredAt)).resolves.toEqual({
      candidates: 1,
      failed: 0,
      sent: 1,
    });
    const reclaimed = await claimDeliveryJobReference({
      env,
      jobId: job.id,
      now: expiredAt,
      queueKind: "notification",
      shopId: "shop-runtime-expired-job",
    });
    if (reclaimed === null) throw new Error("delivery_reclaim_missing");
    expect(reclaimed).toMatchObject({ attempts: 2, version: 3 });
    await expect(settleDeliveryJob({
      claim: reclaimed,
      database: env.PLATFORM_DB,
      now: new Date(expiredAt.getTime() + 1_000),
      settlement: { errorCode: "delivery_attempts_exhausted", status: "dead_letter" },
    })).resolves.toBe(true);
    expect(database.prepare(`
      SELECT status, dead_lettered_at AS deadLetteredAt,
        lease_token AS leaseToken, version
      FROM delivery_jobs WHERE id = ?
    `).get(job.id)).toEqual({
      deadLetteredAt: new Date(expiredAt.getTime() + 1_000).toISOString(),
      leaseToken: null,
      status: "dead_letter",
      version: 4,
    });
  });

  it("claims provider-attempt authority once and settles with the incremented lease version", async () => {
    seedShop(database, "shop-runtime-provider-marker");
    seedConnection({
      connectionId: "connection-runtime-provider-marker",
      database,
      shopId: "shop-runtime-provider-marker",
    });
    seedPaidOrderEvent({
      connectionId: "connection-runtime-provider-marker",
      database,
      eventId: "event-runtime-provider-marker",
      hashIndex: 60,
      orderId: "order-runtime-provider-marker",
      shopId: "shop-runtime-provider-marker",
    });
    await dispatchDueDomainEvents(env, NOW);
    const job = deliveryJobRow(database);
    const claim = await claimDeliveryJobReference({
      env,
      jobId: job.id,
      now: NOW,
      queueKind: "notification",
      shopId: "shop-runtime-provider-marker",
    });
    if (claim === null) throw new Error("provider_marker_claim_missing");

    const marked = await claimDeliveryProviderAttempt({
      claim,
      env,
      now: NOW,
      requestId: "request-provider-marker-001",
    });
    if (marked === null) throw new Error("provider_marker_missing");
    expect(marked.version).toBe(claim.version + 1);
    expect(deliveryJobRow(database)).toMatchObject({
      lastSafeErrorCode: "delivery_provider_attempt_claimed",
      status: "processing",
      version: claim.version + 1,
    });
    await expect(claimDeliveryProviderAttempt({
      claim,
      env,
      now: NOW,
      requestId: "request-provider-marker-replay-001",
    })).resolves.toBeNull();
    expect(database.prepare(`
      SELECT action, resource_id AS resourceId, request_id AS requestId
      FROM audit_logs WHERE action = 'delivery.provider_attempt_claimed'
    `).get()).toEqual({
      action: "delivery.provider_attempt_claimed",
      requestId: "request-provider-marker-001",
      resourceId: job.id,
    });
    await expect(settleDeliveryJob({
      claim: marked,
      database: env.PLATFORM_DB,
      now: new Date(NOW.getTime() + 1_000),
      settlement: { status: "delivered" },
    })).resolves.toBe(true);
  });

  it("keeps the durable provider marker when its audit projection fails", async () => {
    seedShop(database, "shop-runtime-provider-audit-failure");
    seedConnection({
      connectionId: "connection-runtime-provider-audit-failure",
      database,
      shopId: "shop-runtime-provider-audit-failure",
    });
    seedPaidOrderEvent({
      connectionId: "connection-runtime-provider-audit-failure",
      database,
      eventId: "event-runtime-provider-audit-failure",
      hashIndex: 62,
      orderId: "order-runtime-provider-audit-failure",
      shopId: "shop-runtime-provider-audit-failure",
    });
    await dispatchDueDomainEvents(env, NOW);
    const job = deliveryJobRow(database);
    const claim = await claimDeliveryJobReference({
      env,
      jobId: job.id,
      now: NOW,
      queueKind: "notification",
      shopId: "shop-runtime-provider-audit-failure",
    });
    if (claim === null) throw new Error("provider_audit_claim_missing");

    (database as DatabaseSync & { failNextAuditInsert?: boolean }).failNextAuditInsert = true;
    await expect(claimDeliveryProviderAttempt({
      claim,
      env,
      now: NOW,
      requestId: "request-provider-audit-failure-001",
    })).resolves.toMatchObject({ version: claim.version + 1 });
    expect(deliveryJobRow(database)).toMatchObject({
      lastSafeErrorCode: "delivery_provider_attempt_claimed",
      status: "processing",
      version: claim.version + 1,
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'delivery.provider_attempt_claimed'").get())
      .toEqual({ count: 0 });
  });

  it("terminalizes an expired provider marker instead of reclaiming and sending again", async () => {
    seedShop(database, "shop-runtime-provider-expired");
    seedConnection({
      connectionId: "connection-runtime-provider-expired",
      database,
      shopId: "shop-runtime-provider-expired",
    });
    seedPaidOrderEvent({
      connectionId: "connection-runtime-provider-expired",
      database,
      eventId: "event-runtime-provider-expired",
      hashIndex: 61,
      orderId: "order-runtime-provider-expired",
      shopId: "shop-runtime-provider-expired",
    });
    await dispatchDueDomainEvents(env, NOW);
    const job = deliveryJobRow(database);
    const claim = await claimDeliveryJobReference({
      env,
      jobId: job.id,
      now: NOW,
      queueKind: "notification",
      shopId: "shop-runtime-provider-expired",
    });
    if (claim === null) throw new Error("provider_expired_claim_missing");
    const marked = await claimDeliveryProviderAttempt({
      claim,
      env,
      now: NOW,
      requestId: "request-provider-expired-001",
    });
    if (marked === null) throw new Error("provider_expired_marker_missing");
    const expiredAt = new Date(marked.leaseExpiresAt);

    await expect(claimDeliveryJobReference({
      env,
      jobId: job.id,
      now: expiredAt,
      queueKind: "notification",
      requestId: "request-provider-expired-replay-001",
      shopId: "shop-runtime-provider-expired",
    })).resolves.toBeNull();
    expect(deliveryJobRow(database)).toMatchObject({
      lastSafeErrorCode: "delivery_provider_outcome_unknown",
      status: "dead_letter",
      version: marked.version + 1,
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs
      WHERE action = 'delivery.provider_outcome_unknown'
    `).get()).toEqual({ count: 1 });
    await expect(terminalizeDeliveryProviderOutcomeUnknown({
      claim: marked,
      env,
      now: expiredAt,
      requestId: "request-provider-expired-second-replay-001",
    })).resolves.toMatchObject({ status: "dead_letter" });
  });
});
