import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DomainDeliveryQueueEnvelope } from "../../src/lib/delivery/runtime";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-07-30T00:00:00.000Z");
const SHOP_ID = "shop-exact-once";
const CONNECTION_ID = "connection-exact-once";
const INTEGRATION_ID = "integration-exact-once";
const EVENT_ID = "event-exact-once";
const ORDER_ID = "order-exact-once";

const dependencies = vi.hoisted(() => ({
  decryptCredential: vi.fn(),
  decryptRecipient: vi.fn(),
}));

vi.mock("@astrojs/cloudflare/handler", () => ({ handle: vi.fn() }));
vi.mock("../../src/lib/analytics/activation", () => ({
  processActivationMilestoneBackfill: vi.fn().mockResolvedValue({ attempted: 0, created: 0, failed: 0, shops: 0 }),
}));
vi.mock("../../src/lib/auth/admission", () => ({ purgeAuthRequestAdmissions: vi.fn().mockResolvedValue(0) }));
vi.mock("../../src/lib/auth/google-state-maintenance", () => ({ purgeGoogleOAuthStates: vi.fn().mockResolvedValue(0) }));
vi.mock("../../src/lib/automation/scheduler", () => ({
  processScheduledAutomationTasks: vi.fn().mockResolvedValue({
    attempted: 0,
    canceled: 0,
    candidates: 0,
    errors: 0,
    failed: 0,
    missingExecutors: 0,
    recovered: 0,
    retryable: 0,
    skipped: 0,
    succeeded: 0,
  }),
}));
vi.mock("../../src/lib/billing/service", () => ({
  expireBillingCheckoutSessions: vi.fn().mockResolvedValue(0),
  processDueDodoSubscriptionChanges: vi.fn().mockResolvedValue({
    attempted: 0,
    candidates: 0,
    failed: 0,
    providerPending: 0,
  }),
  reconcileDodoSubscriptionChanges: vi.fn().mockResolvedValue({ candidates: 0, completed: 0, failed: 0, pending: 0 }),
  suspendExpiredBillingGracePeriods: vi.fn().mockResolvedValue(0),
  suspendExpiredTrials: vi.fn().mockResolvedValue(0),
}));
vi.mock("../../src/lib/commerce/cart-mutation", () => ({ purgeCartMutationReplays: vi.fn().mockResolvedValue(0) }));
vi.mock("../../src/lib/commerce/entitlements", () => ({ expireDueGenericEntitlements: vi.fn().mockResolvedValue(0) }));
vi.mock("../../src/lib/commerce/generated-license", () => ({
  enqueueDueGeneratedLicenseRequests: vi.fn().mockResolvedValue({ candidates: 0, failed: 0, sent: 0 }),
  GeneratedLicenseProviderRegistry: vi.fn(),
  isGeneratedLicenseQueueEnvelope: () => false,
  processGeneratedLicenseRequestReference: vi.fn(),
  SellerWebhookGeneratedLicenseAdapter: vi.fn(),
}));
vi.mock("../../src/lib/commerce/private-file-maintenance", () => ({ purgeExpiredDeliveryGrantClaims: vi.fn().mockResolvedValue(0) }));
vi.mock("../../src/lib/commerce/store", () => ({ expireUnpaidOrders: vi.fn().mockResolvedValue(0) }));
vi.mock("../../src/lib/domains/reconciliation", () => ({
  reconcileCustomDomains: vi.fn().mockResolvedValue({ checked: 0, deleted: 0, failed: 0 }),
}));
vi.mock("../../src/lib/operations/dead-letters", () => ({ recordDeadLetter: vi.fn() }));
vi.mock("../../src/lib/operations/exports", () => ({
  purgeExpiredDataExports: vi.fn().mockResolvedValue({ candidates: 0, deleted: 0, failed: 0, invalidObjectKeys: 0 }),
}));
vi.mock("../../src/lib/operations/logger", () => ({
  loggerFor: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));
vi.mock("../../src/lib/operations/queue-dead-letter", () => ({
  consumeDeadLetterQueue: vi.fn(),
  isDeadLetterQueue: () => false,
}));
vi.mock("../../src/lib/operations/security-rate-limit-maintenance", () => ({ purgeExpiredSecurityRateLimits: vi.fn().mockResolvedValue(0) }));
vi.mock("../../src/lib/payments/reconciliation", () => ({
  reconcilePendingPayments: vi.fn().mockResolvedValue({ failed: 0, processed: 0 }),
}));
vi.mock("../../src/lib/storefront/abuse", () => ({ purgeAnonymousLimits: vi.fn().mockResolvedValue(0) }));
vi.mock("../../src/lib/telegram/credentials", () => ({
  decryptTelegramCredentialRow: dependencies.decryptCredential,
  decryptTelegramRecipientRow: dependencies.decryptRecipient,
}));

import worker from "../../src/worker";

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
    private readonly hooks?: {
      before?: (sql: string) => void;
      after?: (sql: string) => void;
    },
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }), this.hooks);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    this.hooks?.before?.(this.sql);
    const result = this.database.prepare(this.sql).run(...this.values);
    this.hooks?.after?.(this.sql);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class MemoryQueue {
  readonly sent: DomainDeliveryQueueEnvelope[] = [];

  send(body: unknown): Promise<QueueSendResponse> {
    this.sent.push(body as DomainDeliveryQueueEnvelope);
    return Promise.resolve({
      metadata: { metrics: { backlogBytes: 0, backlogCount: this.sent.length } },
    });
  }
}

class SqliteD1 {
  failNextDeliverySettlementAfterCommit = false;
  failNextDeliverySettlementBeforeCommit = false;

  constructor(private readonly database: DatabaseSync) {}

  prepare(sql: string): D1PreparedStatement {
    const isSettlement = /UPDATE delivery_jobs\s+SET status = \?, next_attempt_at = \?/u.test(sql);
    return new SqliteStatement(this.database, sql, [], {
      before: () => {
        if (!isSettlement || !this.failNextDeliverySettlementBeforeCommit) return;
        this.failNextDeliverySettlementBeforeCommit = false;
        throw new Error("settlement_response_lost_before_commit");
      },
      after: () => {
        if (!isSettlement || !this.failNextDeliverySettlementAfterCommit) return;
        this.failNextDeliverySettlementAfterCommit = false;
        throw new Error("settlement_response_lost_after_commit");
      },
    }) as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function seedPaidTelegramOrder(database: DatabaseSync): void {
  const nowIso = NOW.toISOString();
  const digest = "a".repeat(64);
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-exact-once', 'seller@example.test', 'Exact once seller', 'active', '${nowIso}', '${nowIso}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency,
      timezone, readiness_version, created_at, updated_at
    ) VALUES (
      '${SHOP_ID}', 'public-${SHOP_ID}', 'exact-once', 'Exact once shop',
      'active', 'en', 'VND', 'Asia/Ho_Chi_Minh', 1, '${nowIso}', '${nowIso}'
    );
    INSERT INTO shop_customers (
      id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at
    ) VALUES (
      'customer-exact-once', '${SHOP_ID}', 'buyer@example.test', 'Buyer',
      'en', 'active', '${nowIso}', '${nowIso}'
    );
    INSERT INTO shop_channels (
      id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
    ) VALUES (
      'channel-exact-once', '${SHOP_ID}', 'telegram', 'enabled', '{}', 1, '${nowIso}', '${nowIso}'
    );
    INSERT INTO channel_connections (
      id, public_id, shop_id, shop_channel_id, provider_code, external_account_id,
      status, settings_json, version, connected_at, created_at, updated_at
    ) VALUES (
      '${CONNECTION_ID}', 'public-${CONNECTION_ID}', '${SHOP_ID}', 'channel-exact-once',
      'telegram', 'bot-exact-once', 'active', '{}', 1, '${nowIso}', '${nowIso}', '${nowIso}'
    );
    INSERT INTO channel_connection_grants (
      shop_id, connection_id, capability_code, granted_at
    ) VALUES ('${SHOP_ID}', '${CONNECTION_ID}', 'conversation.outbound', '${nowIso}');
    INSERT INTO telegram_integrations (
      id, public_id, webhook_public_id, shop_id, status, webhook_status,
      bot_id, connected_at, created_at, updated_at, channel_connection_id
    ) VALUES (
      '${INTEGRATION_ID}', 'public-${INTEGRATION_ID}', 'webhook-exact-once', '${SHOP_ID}',
      'active', 'verified', '123456789', '${nowIso}', '${nowIso}', '${nowIso}', '${CONNECTION_ID}'
    );
    INSERT INTO telegram_credentials (
      id, shop_id, integration_id, status, version, key_version,
      bot_token_ciphertext_b64, bot_token_iv_b64,
      webhook_secret_ciphertext_b64, webhook_secret_iv_b64,
      token_fingerprint, webhook_secret_digest, activated_at,
      created_by_user_id, created_at
    ) VALUES (
      'credential-exact-once', '${SHOP_ID}', '${INTEGRATION_ID}', 'active', 1, 'v1',
      'encrypted-token', 'token-iv', 'encrypted-secret', 'secret-iv',
      '${digest}', '${digest}', '${nowIso}', 'user-exact-once', '${nowIso}'
    );
    UPDATE telegram_integrations
    SET generation_state = 'draining', updated_at = '${nowIso}'
    WHERE id = '${INTEGRATION_ID}';
    UPDATE telegram_integrations
    SET active_credential_id = 'credential-exact-once',
      integration_generation = integration_generation + 1,
      generation_state = 'active',
      updated_at = '${nowIso}'
    WHERE id = '${INTEGRATION_ID}';
    INSERT INTO customer_identities (
      id, shop_id, customer_id, provider, external_subject,
      language_code, verified_at, created_at, updated_at
    ) VALUES (
      'identity-exact-once', '${SHOP_ID}', 'customer-exact-once', 'telegram',
      'buyer-telegram-id', 'en', '${nowIso}', '${nowIso}', '${nowIso}'
    );
    INSERT INTO telegram_recipients (
      id, shop_id, integration_id, customer_identity_id, key_version,
      chat_id_ciphertext_b64, chat_id_iv_b64, status, last_seen_at, created_at, updated_at
    ) VALUES (
      'recipient-exact-once', '${SHOP_ID}', '${INTEGRATION_ID}', 'identity-exact-once',
      'v1', 'encrypted-chat', 'chat-iv', 'active', '${nowIso}', '${nowIso}', '${nowIso}'
    );
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel,
      status, payment_status, fulfillment_status, subtotal_minor,
      discount_minor, total_minor, currency, locale, checkout_subject_hash,
      order_token_hash, expires_at, paid_at, created_at, updated_at
    ) VALUES (
      '${ORDER_ID}', 'public-${ORDER_ID}', '${SHOP_ID}', 'customer-exact-once',
      'ORDER-EXACT-ONCE', 'telegram', 'processing', 'paid', 'fulfilled',
      10000, 0, 10000, 'VND', 'en', 'subject-exact-once', 'token-exact-once',
      '2099-01-01T00:00:00.000Z', '${nowIso}', '${nowIso}', '${nowIso}'
    );
    INSERT INTO order_channel_attributions (
      shop_id, order_id, channel_code, adapter_version, connection_id, created_at
    ) VALUES ('${SHOP_ID}', '${ORDER_ID}', 'telegram', 1, '${CONNECTION_ID}', '${nowIso}');
    INSERT INTO domain_events (
      id, shop_id, event_type, aggregate_type, aggregate_id, schema_version,
      idempotency_key_hash, source_connection_id, status, attempts,
      next_attempt_at, occurred_at, version, created_at, updated_at
    ) VALUES (
      '${EVENT_ID}', '${SHOP_ID}', 'order.paid', 'order', '${ORDER_ID}', 1,
      '${digest}', '${CONNECTION_ID}', 'pending', 0, '${nowIso}', '${nowIso}', 1,
      '${nowIso}', '${nowIso}'
    );
    INSERT INTO outbox_jobs (
      id, shop_id, kind, aggregate_type, aggregate_id, status,
      attempts, next_attempt_at, created_at, updated_at
    ) VALUES (
      'legacy-exact-once', '${SHOP_ID}', 'order_paid', 'order', '${ORDER_ID}',
      'pending', 0, '${nowIso}', '${nowIso}', '${nowIso}'
    );
  `);
}

type TrackedMessage = Omit<Message, "ack" | "retry"> & {
  ack: ReturnType<typeof vi.fn<() => void>>;
  retry: ReturnType<typeof vi.fn<(options?: QueueRetryOptions) => void>>;
};

function trackedMessage(body: DomainDeliveryQueueEnvelope, id: string): TrackedMessage {
  return {
    ack: vi.fn<() => void>(),
    attempts: 1,
    body,
    id,
    retry: vi.fn<(options?: QueueRetryOptions) => void>(),
    timestamp: NOW,
  };
}

function messageBatch(message: Message, queue: string): MessageBatch {
  return {
    ackAll: vi.fn(),
    messages: [message],
    metadata: { metrics: { backlogBytes: 0, backlogCount: 1 } },
    queue,
    retryAll: vi.fn(),
  };
}

function domainEventReplayEnvelope(): DomainDeliveryQueueEnvelope {
  return {
    kind: "integration",
    operationId: "domain_event_dispatch",
    referenceId: EVENT_ID,
    referenceType: "outbox_job",
    requestId: "request-event-exact-once",
    shopId: SHOP_ID,
    sourceQueue: "integration",
    version: 1,
  };
}

describe("Telegram paid-order exact-once authority", () => {
  let database: DatabaseSync;
  let env: AppBindings;
  let notificationQueue: MemoryQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    dependencies.decryptCredential.mockReset().mockResolvedValue({
      botToken: "123456789:test-token",
      webhookSecret: "test-webhook-secret",
    });
    dependencies.decryptRecipient.mockReset().mockResolvedValue("9007199254740991");
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    seedPaidTelegramOrder(database);
    const integrationQueue = new MemoryQueue();
    notificationQueue = new MemoryQueue();
    env = {
      APP_ENV: "staging",
      INTEGRATION_QUEUE: integrationQueue,
      LOG_LEVEL: "silent",
      NOTIFICATION_QUEUE: notificationQueue,
      PLATFORM_DB: new SqliteD1(database),
    } as unknown as AppBindings;
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("sends at most once across cron dispatch, durable legacy quarantine, and event/job replays", async () => {
    const providerFetch = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
      expect(url).toBe("https://api.telegram.org/bot123456789:test-token/sendMessage");
      expect(body).toMatchObject({ chat_id: "9007199254740991" });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
    });
    vi.stubGlobal("fetch", providerFetch);

    expect(database.prepare("SELECT status FROM outbox_jobs WHERE id = 'legacy-exact-once'").get())
      .toEqual({ status: "completed" });
    expect(providerFetch).not.toHaveBeenCalled();

    const controller: ScheduledController = {
      cron: "*/5 * * * *",
      noRetry: vi.fn(),
      scheduledTime: NOW.getTime(),
    };
    await worker.scheduled(controller, env as unknown as Env);

    expect(notificationQueue.sent).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_jobs").get()).toEqual({ count: 1 });

    const deliveryEnvelope = notificationQueue.sent[0];
    if (deliveryEnvelope === undefined) throw new Error("delivery_envelope_missing");
    const firstDelivery = trackedMessage(deliveryEnvelope, "message-delivery-first");
    await worker.queue(messageBatch(firstDelivery, "selinow-notification-staging"), env as unknown as Env);

    expect(providerFetch).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT status, attempts FROM delivery_jobs").get()).toEqual({
      attempts: 1,
      status: "delivered",
    });

    const replayedDelivery = trackedMessage(deliveryEnvelope, "message-delivery-replay");
    await worker.queue(messageBatch(replayedDelivery, "selinow-notification-staging"), env as unknown as Env);
    const replayedEvent = trackedMessage(domainEventReplayEnvelope(), "message-event-replay");
    await worker.queue(messageBatch(replayedEvent, "selinow-integration-staging"), env as unknown as Env);
    await worker.scheduled(controller, env as unknown as Env);

    expect(providerFetch).toHaveBeenCalledOnce();
    expect(notificationQueue.sent).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_jobs").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT status FROM outbox_jobs WHERE id = 'legacy-exact-once'").get())
      .toEqual({ status: "completed" });
  });

  it("does not resend when provider success is followed by a lost D1 settlement response", async () => {
    const providerFetch = vi.fn<typeof fetch>(() => Promise.resolve(new Response(
      JSON.stringify({ ok: true, result: { message_id: 2 } }),
      { status: 200 },
    )));
    vi.stubGlobal("fetch", providerFetch);
    const controller: ScheduledController = {
      cron: "*/5 * * * *",
      noRetry: vi.fn(),
      scheduledTime: NOW.getTime(),
    };
    await worker.scheduled(controller, env as unknown as Env);
    const deliveryEnvelope = notificationQueue.sent[0];
    if (deliveryEnvelope === undefined) throw new Error("delivery_envelope_missing");
    const firstDelivery = trackedMessage(deliveryEnvelope, "message-delivery-settlement-loss");
    const databaseBinding = env.PLATFORM_DB as unknown as SqliteD1;
    databaseBinding.failNextDeliverySettlementAfterCommit = true;

    await worker.queue(messageBatch(firstDelivery, "selinow-notification-staging"), env as unknown as Env);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(firstDelivery.ack).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT status, attempts FROM delivery_jobs").get()).toEqual({
      attempts: 1,
      status: "delivered",
    });

    const replay = trackedMessage(deliveryEnvelope, "message-delivery-settlement-replay");
    await worker.queue(messageBatch(replay, "selinow-notification-staging"), env as unknown as Env);
    await worker.scheduled({ ...controller, scheduledTime: NOW.getTime() + 300_000 }, env as unknown as Env);

    expect(providerFetch).toHaveBeenCalledOnce();
    expect(replay.ack).toHaveBeenCalledOnce();
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs
      WHERE action = 'delivery.provider_attempt_claimed'
    `).get()).toEqual({ count: 1 });
  });

  it("dead-letters a marked provider attempt when settlement cannot commit", async () => {
    const providerFetch = vi.fn<typeof fetch>(() => Promise.resolve(new Response(
      JSON.stringify({ ok: true, result: { message_id: 3 } }),
      { status: 200 },
    )));
    vi.stubGlobal("fetch", providerFetch);
    const controller: ScheduledController = {
      cron: "*/5 * * * *",
      noRetry: vi.fn(),
      scheduledTime: NOW.getTime(),
    };
    await worker.scheduled(controller, env as unknown as Env);
    const deliveryEnvelope = notificationQueue.sent[0];
    if (deliveryEnvelope === undefined) throw new Error("delivery_envelope_missing");
    const firstDelivery = trackedMessage(deliveryEnvelope, "message-delivery-settlement-failure");
    const databaseBinding = env.PLATFORM_DB as unknown as SqliteD1;
    databaseBinding.failNextDeliverySettlementBeforeCommit = true;

    await worker.queue(messageBatch(firstDelivery, "selinow-notification-staging"), env as unknown as Env);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(firstDelivery.ack).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT status, last_safe_error_code AS errorCode FROM delivery_jobs").get())
      .toEqual({ errorCode: "delivery_provider_outcome_unknown", status: "dead_letter" });

    const replay = trackedMessage(deliveryEnvelope, "message-delivery-settlement-failure-replay");
    await worker.queue(messageBatch(replay, "selinow-notification-staging"), env as unknown as Env);
    expect(providerFetch).toHaveBeenCalledOnce();
    expect(replay.ack).toHaveBeenCalledOnce();
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs
      WHERE action = 'delivery.provider_outcome_unknown'
    `).get()).toEqual({ count: 1 });
  });
});
