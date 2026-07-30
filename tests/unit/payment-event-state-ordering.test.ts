import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyCommercePaymentEvent, type CommercePaymentAttempt } from "../../src/lib/commerce/payment-events";
import type { AppBindings } from "../../src/lib/platform/bindings";

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

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

const SHOP_ID = "shop-a";
const ATTEMPT_ID = "attempt-a";
const INTEGRATION_ID = "integration-a";
const ORDER_ID = "order-a";

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

function attempt(state: string, overrides: Partial<CommercePaymentAttempt> = {}): CommercePaymentAttempt {
  return {
    id: ATTEMPT_ID,
    integrationId: INTEGRATION_ID,
    orderId: ORDER_ID,
    shopId: SHOP_ID,
    state,
    ...overrides,
  };
}

function evidence() {
  return {
    amount: 100_000,
    expectedAmount: 100_000,
    occurredAt: "2026-07-26T04:05:00.000Z",
    reference: "reference-a",
  };
}

describe("commerce payment event ordering", () => {
  let database: DatabaseSync;
  let env: AppBindings;
  let eventCounter = 0;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE payment_attempts (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        integration_id TEXT NOT NULL,
        state TEXT NOT NULL,
        provider_status TEXT,
        last_safe_error_code TEXT,
        updated_at TEXT,
        paid_event_id TEXT
      );
      CREATE TABLE payment_events (
        id TEXT PRIMARY KEY,
        shop_id TEXT NOT NULL,
        payment_attempt_id TEXT NOT NULL,
        integration_id TEXT NOT NULL,
        provider_event_reference TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        processing_token TEXT,
        processing_started_at TEXT,
        processed_at TEXT,
        normalized_state TEXT,
        process_result TEXT
      );
    `);
    database.prepare(`
      INSERT INTO payment_attempts (id, shop_id, order_id, integration_id, state)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(ATTEMPT_ID, SHOP_ID, ORDER_ID, INTEGRATION_ID);
    env = bindings(database);
    eventCounter = 0;
  });

  afterEach(() => {
    database.close();
  });

  async function apply(state: string, decision: "pending" | "terminal_unpaid" | "paid_exact") {
    eventCounter += 1;
    const eventId = `event-${String(eventCounter)}`;
    const claimToken = `claim-${eventId}`;
    database.prepare(`
      INSERT INTO payment_events (
        id, shop_id, payment_attempt_id, integration_id, provider_event_reference,
        payload_hash, processing_token, process_result
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')
    `).run(eventId, SHOP_ID, ATTEMPT_ID, INTEGRATION_ID, `reference-${eventId}`, `hash-${eventId}`, claimToken);
    return applyCommercePaymentEvent({
      attempt: attempt(state),
      claimToken,
      decision,
      env,
      eventId,
      evidence: evidence(),
      integrationId: INTEGRATION_ID,
    });
  }

  it("does not let a stale pending observation reopen a terminal unpaid attempt", async () => {
    await expect(apply("pending", "terminal_unpaid")).resolves.toEqual({ processed: true, state: "terminal_unpaid" });
    await expect(apply("terminal_unpaid", "pending")).resolves.toEqual({ processed: false, state: "terminal_unpaid" });

    expect(database.prepare("SELECT state, provider_status AS providerStatus FROM payment_attempts WHERE id = ?").get(ATTEMPT_ID))
      .toEqual({ state: "terminal_unpaid", providerStatus: "FAILED" });
    expect(database.prepare("SELECT normalized_state AS normalizedState, process_result AS processResult FROM payment_events WHERE id = 'event-2'").get())
      .toEqual({ normalizedState: "terminal_unpaid", processResult: "state_conflict" });
  });

  it("does not let a stale terminal event replace an existing payment exception", async () => {
    database.prepare("UPDATE payment_attempts SET state = 'partial' WHERE id = ?").run(ATTEMPT_ID);

    await expect(apply("partial", "pending")).resolves.toEqual({ processed: false, state: "partial" });
    await expect(apply("partial", "terminal_unpaid")).resolves.toEqual({ processed: false, state: "partial" });

    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = ?").get(ATTEMPT_ID)).toEqual({ state: "partial" });
    expect(database.prepare("SELECT normalized_state AS normalizedState, process_result AS processResult FROM payment_events WHERE id = 'event-2'").get())
      .toEqual({ normalizedState: "partial", processResult: "state_conflict" });
  });

  it("does not allow an exact event to fulfill after terminal unpaid wins", async () => {
    await expect(apply("pending", "terminal_unpaid")).resolves.toEqual({ processed: true, state: "terminal_unpaid" });
    await expect(apply("terminal_unpaid", "paid_exact")).resolves.toEqual({ processed: false, state: "terminal_unpaid" });

    expect(database.prepare("SELECT state, paid_event_id AS paidEventId FROM payment_attempts WHERE id = ?").get(ATTEMPT_ID))
      .toEqual({ state: "terminal_unpaid", paidEventId: null });
    expect(database.prepare("SELECT normalized_state AS normalizedState, process_result AS processResult FROM payment_events WHERE id = 'event-2'").get())
      .toEqual({ normalizedState: "terminal_unpaid", processResult: "state_conflict" });
  });

  it.each([
    ["shop", { shopId: "shop-b" }],
    ["attempt", { id: "attempt-b", orderId: "order-b" }],
    ["order", { orderId: "order-b" }],
  ] as const)("rejects a claimed event with a mismatched %s binding", async (_field, overrides) => {
    database.prepare(`
      INSERT INTO payment_attempts (id, shop_id, order_id, integration_id, state)
      VALUES ('attempt-b', ?, 'order-b', ?, 'pending')
    `).run(SHOP_ID, INTEGRATION_ID);
    database.prepare(`
      INSERT INTO payment_events (
        id, shop_id, payment_attempt_id, integration_id, provider_event_reference,
        payload_hash, processing_token, process_result
      ) VALUES ('event-bound-a', ?, ?, ?, 'reference-bound-a', 'hash-bound-a', 'claim-bound-a', 'processing')
    `).run(SHOP_ID, ATTEMPT_ID, INTEGRATION_ID);

    await expect(applyCommercePaymentEvent({
      attempt: attempt("pending", overrides),
      claimToken: "claim-bound-a",
      decision: "paid_exact",
      env,
      eventId: "event-bound-a",
      evidence: evidence(),
      integrationId: INTEGRATION_ID,
    })).rejects.toMatchObject({ code: "payment_event_claim_invalid" });

    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-a'").get()).toEqual({ state: "pending" });
    expect(database.prepare("SELECT state FROM payment_attempts WHERE id = 'attempt-b'").get()).toEqual({ state: "pending" });
    expect(database.prepare("SELECT process_result AS processResult, processed_at AS processedAt FROM payment_events WHERE id = 'event-bound-a'").get())
      .toEqual({ processResult: "processing", processedAt: null });
  });
});
