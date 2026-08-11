import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  consumeBuyerOrderRecovery,
  isBuyerOrderRecoveryBinding,
  purgeBuyerOrderRecoveryArtifacts,
  requestBuyerOrderRecovery,
  resolveCurrentBuyerOrderRecoveryToken,
} from "../../src/lib/commerce/buyer-order-recovery";
import { hmacToken } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";
import type { StorefrontShop } from "../../src/lib/storefront/store";

const NOW = new Date("2026-08-09T04:00:00.000Z");
const ORDER_A = "order_11111111-1111-4111-8111-111111111111";
const ORDER_B = "order_22222222-2222-4222-8222-222222222222";
const ORIGINAL_ORDER_TOKEN_HASH_A = "a".repeat(43);
const ORIGINAL_ORDER_TOKEN_HASH_B = "b".repeat(43);

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[]);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  run(): Promise<{ meta: { changes: number } }> {
    return Promise.resolve(this.runSync());
  }

  runSync(): { meta: { changes: number } } {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  batch(statements: D1PreparedStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = (statements as unknown as SqliteStatement[]).map((statement) => statement.runSync());
      this.database.exec("COMMIT");
      return Promise.resolve(results);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

type SentEmail = { html?: string; text?: string; to?: string };
type Runtime = {
  database: DatabaseSync;
  env: AppBindings;
  failEmail: () => void;
  sentEmails: SentEmail[];
};

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function seed(database: DatabaseSync): void {
  const now = NOW.toISOString();
  database.exec(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shop-a', 'shop_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'shop-a', 'Shop A', 'active', 'en', 'USD', 'UTC', 1, '${now}', '${now}'),
      ('shop-b', 'shop_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'shop-b', 'Shop B', 'active', 'en', 'USD', 'UTC', 1, '${now}', '${now}'),
      ('shop-c', 'shop_cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'shop-c', 'Shop C', 'active', 'en', 'USD', 'UTC', 1, '${now}', '${now}'),
      ('shop-d', 'shop_dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'shop-d', 'Shop D', 'active', 'en', 'USD', 'UTC', 1, '${now}', '${now}');
    INSERT INTO shop_customers (
      id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at
    ) VALUES
      ('customer-a', 'shop-a', 'buyer@example.test', 'Buyer A', 'en', 'active', '${now}', '${now}'),
      ('customer-a2', 'shop-a', 'buyer-two@example.test', 'Buyer A2', 'en', 'active', '${now}', '${now}'),
      ('customer-b', 'shop-b', 'buyer@example.test', 'Buyer B', 'en', 'active', '${now}', '${now}');
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor, total_minor,
      currency, locale, customer_email_masked, checkout_subject_hash,
      order_token_hash, expires_at, created_at, updated_at
    ) VALUES
      ('order-a', '${ORDER_A}', 'shop-a', 'customer-a', 'A-1001', 'web', 'processing',
       'paid', 'unfulfilled', 1000, 0, 1000, 'USD', 'en', 'b***@example.test',
       'checkout-subject-a', '${ORIGINAL_ORDER_TOKEN_HASH_A}', '2026-08-10T04:00:00.000Z', '${now}', '${now}'),
      ('order-b', '${ORDER_B}', 'shop-b', 'customer-b', 'B-1001', 'web', 'processing',
       'paid', 'unfulfilled', 1000, 0, 1000, 'USD', 'en', 'b***@example.test',
       'checkout-subject-b', '${ORIGINAL_ORDER_TOKEN_HASH_B}', '2026-08-10T04:00:00.000Z', '${now}', '${now}');
  `);
}

function createRuntime(): Runtime {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  seed(database);
  const sentEmails: SentEmail[] = [];
  let emailFails = false;
  const env = {
    APP_ENV: "local",
    EMAIL: {
      send(message: SentEmail) {
        if (emailFails) return Promise.reject(new Error("email_unavailable"));
        sentEmails.push(message);
        return Promise.resolve({ messageId: "recovery-email" });
      },
    },
    EMAIL_FROM_ADDRESS: "no-reply@selinow.com",
    EMAIL_FROM_NAME: "Selinow",
    IDENTIFIER_HMAC_SECRET: "buyer-order-recovery-test-secret",
    PLATFORM_DB: new SqliteD1(database) as unknown as D1Database,
  } as unknown as AppBindings;
  return { database, env, failEmail: () => { emailFails = true; }, sentEmails };
}

function shop(id: string): StorefrontShop {
  return {
    currentHostname: `${id}.example.test`,
    defaultLocale: "en",
    id,
  } as StorefrontShop;
}

function recoveryToken(email: SentEmail): string {
  const text = email.text ?? "";
  const match = text.match(/#recovery=([^\s]+)/u);
  if (match?.[1] === undefined) throw new Error("recovery_token_missing");
  return decodeURIComponent(match[1]);
}

async function requestRecovery(runtime: Runtime, overrides: Partial<Parameters<typeof requestBuyerOrderRecovery>[0]> = {}): Promise<void> {
  await requestBuyerOrderRecovery({
    email: "buyer@example.test",
    env: runtime.env,
    now: NOW,
    orderPublicId: ORDER_A,
    origin: "https://shop-a.example.test",
    requesterAddress: "198.51.100.10",
    requestId: "request-recovery-0001",
    shop: shop("shop-a"),
    ...overrides,
  });
}

describe("buyer order access recovery", () => {
  it("enforces tenant-composite parents and bounded terminal audit fields", () => {
    const runtime = createRuntime();
    const issuedAt = NOW.toISOString();
    const expiresAt = new Date(NOW.getTime() + 15 * 60_000).toISOString();
    const retentionExpiresAt = new Date(NOW.getTime() + 30 * 24 * 60 * 60_000).toISOString();
    const insert = runtime.database.prepare(`
      INSERT INTO order_access_recovery_tokens (
        id, shop_id, order_id, customer_id, token_hash, recipient_hash,
        issued_request_id, issued_at, expires_at, retention_expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    expect(() => insert.run(
      "orc_cross-tenant", "shop-a", "order-a", "customer-b", "t".repeat(64),
      "r".repeat(64), "request-migration-0001", issuedAt, expiresAt, retentionExpiresAt, issuedAt,
    )).toThrow();
    insert.run(
      "orc_exact-scope", "shop-a", "order-a", "customer-a", "t".repeat(64),
      "r".repeat(64), "request-migration-0002", issuedAt, expiresAt, retentionExpiresAt, issuedAt,
    );
    expect(() => runtime.database.prepare("UPDATE orders SET customer_id = 'customer-a2' WHERE id = 'order-a'").run())
      .toThrow();
    expect(() => runtime.database.prepare(`
      UPDATE order_access_recovery_tokens
      SET consumed_at = ?, consumed_request_id = 'short', replacement_order_token_hash = ?
      WHERE id = 'orc_exact-scope'
    `).run(new Date(NOW.getTime() + 1_000).toISOString(), "o".repeat(64))).toThrow();
    expect(() => runtime.database.prepare(`
      UPDATE order_access_recovery_tokens SET revoked_at = ? WHERE id = 'orc_exact-scope'
    `).run(new Date(NOW.getTime() - 1_000).toISOString())).toThrow();
  });

  it("issues a fragment-only email link without persisting recipient or token plaintext", async () => {
    const runtime = createRuntime();
    await requestRecovery(runtime);

    expect(runtime.sentEmails).toHaveLength(1);
    const email = runtime.sentEmails[0];
    if (email === undefined) throw new Error("recovery_email_missing");
    const token = recoveryToken(email);
    expect(email.text).toContain(`${ORDER_A}#recovery=`);
    expect(email.text).not.toContain("?recovery=");
    const row = runtime.database.prepare(`
      SELECT token_hash AS tokenHash, recipient_hash AS recipientHash
      FROM order_access_recovery_tokens
    `).get() as { recipientHash: string; tokenHash: string };
    expect(row.tokenHash).not.toBe(token);
    expect(row.recipientHash).not.toBe("buyer@example.test");
    expect(JSON.stringify(row)).not.toContain("buyer@example.test");
  });

  it("consumes once, rotates the order access hash, and rejects replay", async () => {
    const runtime = createRuntime();
    await requestRecovery(runtime);
    const email = runtime.sentEmails[0];
    if (email === undefined) throw new Error("recovery_email_missing");
    const token = recoveryToken(email);

    const recovered = await consumeBuyerOrderRecovery({
      env: runtime.env,
      now: new Date(NOW.getTime() + 1_000),
      orderPublicId: ORDER_A,
      requestId: "request-consume-0001",
      shop: shop("shop-a"),
      token,
    });
    const expectedHash = await hmacToken(runtime.env.IDENTIFIER_HMAC_SECRET, "order-access", recovered.orderToken);
    expect(runtime.database.prepare("SELECT order_token_hash AS tokenHash FROM orders WHERE id = 'order-a'").get())
      .toEqual({ tokenHash: expectedHash });
    expect(runtime.database.prepare(`
      SELECT consumed_request_id AS requestId,
        previous_order_token_hash AS previousHash,
        replacement_order_token_hash AS replacementHash
      FROM order_access_recovery_tokens
    `).get()).toEqual({
      previousHash: ORIGINAL_ORDER_TOKEN_HASH_A,
      replacementHash: expectedHash,
      requestId: "request-consume-0001",
    });

    await expect(consumeBuyerOrderRecovery({
      env: runtime.env,
      now: new Date(NOW.getTime() + 2_000),
      orderPublicId: ORDER_A,
      requestId: "request-consume-replay",
      shop: shop("shop-a"),
      token,
    })).rejects.toMatchObject({ code: "order_recovery_invalid", status: 410 });
  });

  it("allows exactly one winner across concurrent consume attempts", async () => {
    const runtime = createRuntime();
    await requestRecovery(runtime);
    const email = runtime.sentEmails[0];
    if (email === undefined) throw new Error("recovery_email_missing");
    const token = recoveryToken(email);
    const attempts = await Promise.allSettled([
      consumeBuyerOrderRecovery({ env: runtime.env, now: new Date(NOW.getTime() + 1_000), orderPublicId: ORDER_A, requestId: "request-race-a", shop: shop("shop-a"), token }),
      consumeBuyerOrderRecovery({ env: runtime.env, now: new Date(NOW.getTime() + 1_000), orderPublicId: ORDER_A, requestId: "request-race-b", shop: shop("shop-a"), token }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const consumed = runtime.database.prepare(`
      SELECT consumed_request_id AS requestId, COUNT(*) AS rows
      FROM order_access_recovery_tokens WHERE consumed_at IS NOT NULL
    `).get() as { requestId: string; rows: number };
    expect(consumed.rows).toBe(1);
    expect(["request-race-a", "request-race-b"]).toContain(consumed.requestId);
  });

  it("rejects expiry and cross-tenant consumption without changing either order", async () => {
    const runtime = createRuntime();
    await requestRecovery(runtime);
    const email = runtime.sentEmails[0];
    if (email === undefined) throw new Error("recovery_email_missing");
    const token = recoveryToken(email);
    const before = runtime.database.prepare("SELECT id, order_token_hash AS tokenHash FROM orders ORDER BY id").all();

    await expect(consumeBuyerOrderRecovery({
      env: runtime.env,
      now: new Date(NOW.getTime() + 1_000),
      orderPublicId: ORDER_A,
      requestId: "request-cross-tenant",
      shop: shop("shop-b"),
      token,
    })).rejects.toMatchObject({ code: "order_recovery_invalid", status: 410 });
    await expect(consumeBuyerOrderRecovery({
      env: runtime.env,
      now: new Date(NOW.getTime() + 16 * 60_000),
      orderPublicId: ORDER_A,
      requestId: "request-expired",
      shop: shop("shop-a"),
      token,
    })).rejects.toMatchObject({ code: "order_recovery_expired", status: 410 });
    expect(runtime.database.prepare("SELECT id, order_token_hash AS tokenHash FROM orders ORDER BY id").all()).toEqual(before);
  });

  it("revokes order access and deletes recovery artifacts when the buyer is anonymized", async () => {
    const runtime = createRuntime();
    await requestRecovery(runtime);
    const email = runtime.sentEmails[0];
    if (email === undefined) throw new Error("recovery_email_missing");
    const recovered = await consumeBuyerOrderRecovery({
      env: runtime.env,
      now: new Date(NOW.getTime() + 1_000),
      orderPublicId: ORDER_A,
      requestId: "request-anonymize-consume",
      shop: shop("shop-a"),
      token: recoveryToken(email),
    });
    const recoveredHash = await hmacToken(runtime.env.IDENTIFIER_HMAC_SECRET, "order-access", recovered.orderToken);
    const anonymizedAt = new Date(NOW.getTime() + 2_000).toISOString();
    runtime.database.prepare(`
      UPDATE shop_customers
      SET email_normalized = NULL, display_name = NULL, status = 'blocked',
        anonymized_at = ?, updated_at = ?, version = version + 1
      WHERE shop_id = 'shop-a' AND id = 'customer-a'
    `).run(anonymizedAt, anonymizedAt);

    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS rows FROM order_access_recovery_tokens
      WHERE shop_id = 'shop-a' AND customer_id = 'customer-a'
    `).get()).toEqual({ rows: 0 });
    const order = runtime.database.prepare(`
      SELECT order_token_hash AS tokenHash FROM orders WHERE id = 'order-a'
    `).get() as { tokenHash: string };
    expect(order.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(order.tokenHash).not.toBe(recoveredHash);
  });

  it("deletes unconsumed artifacts and scrubs consumed recovery-link data after 30 days", async () => {
    const runtime = createRuntime();
    await requestRecovery(runtime);
    const email = runtime.sentEmails[0];
    if (email === undefined) throw new Error("recovery_email_missing");
    const recovered = await consumeBuyerOrderRecovery({
      env: runtime.env,
      now: new Date(NOW.getTime() + 1_000),
      orderPublicId: ORDER_A,
      requestId: "request-retention-consume",
      shop: shop("shop-a"),
      token: recoveryToken(email),
    });
    runtime.failEmail();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await requestRecovery(runtime, { now: new Date(NOW.getTime() + 2_000), requestId: "request-retention-revoked" });
    warning.mockRestore();
    const before = runtime.database.prepare(`
      SELECT id, token_hash AS tokenHash, recipient_hash AS recipientHash,
        previous_order_token_hash AS previousHash,
        replacement_order_token_hash AS replacementHash,
        consumed_at AS consumedAt
      FROM order_access_recovery_tokens
      ORDER BY consumed_at IS NULL, id
    `).all() as Array<{
      consumedAt: string | null;
      id: string;
      previousHash: string | null;
      recipientHash: string;
      replacementHash: string | null;
      tokenHash: string;
    }>;
    expect(before).toHaveLength(2);
    const consumed = before.find((row) => row.consumedAt !== null);
    if (consumed === undefined || consumed.replacementHash === null || consumed.previousHash === null) {
      throw new Error("consumed_recovery_missing");
    }

    await expect(purgeBuyerOrderRecoveryArtifacts({
      env: runtime.env,
      now: new Date(NOW.getTime() + 31 * 24 * 60 * 60_000),
    })).resolves.toEqual({ deleted: 1, redacted: 1 });
    const retained = runtime.database.prepare(`
      SELECT token_hash AS tokenHash, recipient_hash AS recipientHash,
        issued_request_id AS issuedRequestId, previous_order_token_hash AS previousHash,
        replacement_order_token_hash AS replacementHash, redacted_at AS redactedAt
      FROM order_access_recovery_tokens
    `).get() as {
      issuedRequestId: string;
      previousHash: string;
      recipientHash: string;
      redactedAt: string;
      replacementHash: string;
      tokenHash: string;
    };
    expect(retained.tokenHash).not.toBe(consumed.tokenHash);
    expect(retained.recipientHash).not.toBe(consumed.recipientHash);
    expect(retained.issuedRequestId).toMatch(/^redacted:/u);
    expect(retained.redactedAt).toBeTruthy();
    expect(retained.previousHash).toBe(consumed.previousHash);
    expect(retained.replacementHash).toBe(consumed.replacementHash);
    await expect(resolveCurrentBuyerOrderRecoveryToken({
      currentOrderTokenHash: retained.replacementHash,
      env: runtime.env,
      orderId: "order-a",
      shopId: "shop-a",
    })).resolves.toBe(recovered.orderToken);
  });

  it("revokes an issued token after email failure while keeping the request generic", async () => {
    const runtime = createRuntime();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    runtime.failEmail();
    await expect(requestRecovery(runtime)).resolves.toBeUndefined();
    expect(runtime.sentEmails).toHaveLength(0);
    const recovery = runtime.database.prepare(`
      SELECT consumed_at AS consumedAt, revoked_at AS revokedAt
      FROM order_access_recovery_tokens
    `).get() as { consumedAt: string | null; revokedAt: string | null };
    expect(recovery.consumedAt).toBeNull();
    expect(recovery.revokedAt).toEqual(expect.any(String));
    expect(warning).toHaveBeenCalledOnce();
    expect(warning.mock.calls[0]?.[0]).toContain('"errorCode":"buyer_order_recovery_email_failed"');
    expect(warning.mock.calls[0]?.[0]).toContain('"requestId":"request-recovery-0001"');
    expect(warning.mock.calls[0]?.[0]).not.toContain("buyer@example.test");
    warning.mockRestore();
  });

  it("records only a safe deferred failure signal when issuance storage fails", async () => {
    const runtime = createRuntime();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const database = runtime.env.PLATFORM_DB;
    const deferred: Promise<void>[] = [];
    const env = {
      ...runtime.env,
      PLATFORM_DB: {
        batch: database.batch.bind(database),
        prepare(sql: string) {
          if (sql.includes("SELECT orders.id AS orderId")) throw new Error("sensitive-storage-failure");
          return database.prepare(sql);
        },
      } as D1Database,
    } as AppBindings;

    await requestBuyerOrderRecovery({
      defer: (operation) => { deferred.push(operation); },
      email: "buyer@example.test",
      env,
      now: NOW,
      orderPublicId: ORDER_A,
      origin: "https://shop-a.example.test",
      requesterAddress: "198.51.100.10",
      requestId: "request-deferred-failure",
      shop: shop("shop-a"),
    });
    expect(deferred).toHaveLength(1);
    await Promise.all(deferred);
    expect(warning).toHaveBeenCalledOnce();
    const serialized = String(warning.mock.calls[0]?.[0]);
    expect(serialized).toContain('"errorCode":"buyer_order_recovery_internal_error"');
    expect(serialized).toContain('"requestId":"request-deferred-failure"');
    expect(serialized).not.toContain("buyer@example.test");
    expect(serialized).not.toContain(ORDER_A);
    expect(serialized).not.toContain("sensitive-storage-failure");
    warning.mockRestore();
  });

  it("returns the same silent result for invalid email, missing order, wrong email, and wrong tenant", async () => {
    const runtime = createRuntime();
    for (const overrides of [
      { email: "not-an-email" },
      { orderPublicId: "order_99999999-9999-4999-8999-999999999999" },
      { email: "other@example.test" },
      { orderPublicId: ORDER_B },
    ]) await expect(requestRecovery(runtime, overrides)).resolves.toBeUndefined();
    expect(runtime.sentEmails).toHaveLength(0);
    expect(runtime.database.prepare("SELECT COUNT(*) AS rows FROM order_access_recovery_tokens").get()).toEqual({ rows: 0 });
  });

  it("rate limits by tenant and requester before any order or email lookup", async () => {
    const runtime = createRuntime();
    const missingOrder = "order_99999999-9999-4999-8999-999999999999";
    for (let index = 0; index < 5; index += 1) {
      await requestRecovery(runtime, {
        email: `missing-${String(index)}@example.test`,
        orderPublicId: missingOrder,
        requestId: `request-rate-${String(index)}`,
      });
    }
    await expect(requestRecovery(runtime, {
      email: "missing-blocked@example.test",
      orderPublicId: missingOrder,
      requestId: "request-rate-blocked",
    }))
      .rejects.toMatchObject({ code: "rate_limited", status: 429 });
    await expect(requestRecovery(runtime, {
      orderPublicId: ORDER_B,
      origin: "https://shop-b.example.test",
      requestId: "request-rate-other-shop",
      shop: shop("shop-b"),
    })).resolves.toBeUndefined();
    expect(runtime.database.prepare(`
      SELECT shop_id AS shopId, request_count AS requestCount
      FROM security_rate_limits
      WHERE action = 'buyer_order_recovery_request'
      ORDER BY shop_id
    `).all()).toEqual([
      { requestCount: 6, shopId: "shop-a" },
      { requestCount: 1, shopId: "shop-b" },
    ]);
  });

  it("caps one requester across shops before another tenant-scoped lookup", async () => {
    const runtime = createRuntime();
    const missingOrder = "order_99999999-9999-4999-8999-999999999999";
    let requestNumber = 0;
    for (const shopId of ["shop-a", "shop-b", "shop-c", "shop-d"]) {
      for (let index = 0; index < 5; index += 1) {
        requestNumber += 1;
        await requestRecovery(runtime, {
          email: `missing-${String(requestNumber)}@example.test`,
          orderPublicId: missingOrder,
          origin: `https://${shopId}.example.test`,
          requestId: `request-global-${String(requestNumber).padStart(2, "0")}`,
          shop: shop(shopId),
        });
      }
    }
    await expect(requestRecovery(runtime, {
      email: "missing-global-blocked@example.test",
      orderPublicId: missingOrder,
      requestId: "request-global-blocked",
    })).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(runtime.database.prepare(`
      SELECT request_count AS requestCount
      FROM security_rate_limits
      WHERE action = 'buyer_order_recovery_request_global'
    `).get()).toEqual({ requestCount: 21 });
    expect(runtime.database.prepare(`
      SELECT request_count AS requestCount
      FROM security_rate_limits
      WHERE action = 'buyer_order_recovery_request' AND shop_id = 'shop-a'
    `).get()).toEqual({ requestCount: 5 });
  });

  it("resolves deterministic replacement tokens and exact-order binding history", async () => {
    const runtime = createRuntime();
    await requestRecovery(runtime);
    const firstEmail = runtime.sentEmails[0];
    if (firstEmail === undefined) throw new Error("first_recovery_email_missing");
    const first = await consumeBuyerOrderRecovery({
      env: runtime.env,
      now: new Date(NOW.getTime() + 1_000),
      orderPublicId: ORDER_A,
      requestId: "request-chain-first",
      shop: shop("shop-a"),
      token: recoveryToken(firstEmail),
    });
    const firstHash = await hmacToken(runtime.env.IDENTIFIER_HMAC_SECRET, "order-access", first.orderToken);

    await requestRecovery(runtime, { now: new Date(NOW.getTime() + 2_000), requestId: "request-chain-second-issue" });
    const secondEmail = runtime.sentEmails[1];
    if (secondEmail === undefined) throw new Error("second_recovery_email_missing");
    const second = await consumeBuyerOrderRecovery({
      env: runtime.env,
      now: new Date(NOW.getTime() + 3_000),
      orderPublicId: ORDER_A,
      requestId: "request-chain-second",
      shop: shop("shop-a"),
      token: recoveryToken(secondEmail),
    });
    const secondHash = await hmacToken(runtime.env.IDENTIFIER_HMAC_SECRET, "order-access", second.orderToken);

    await expect(resolveCurrentBuyerOrderRecoveryToken({
      currentOrderTokenHash: secondHash,
      env: runtime.env,
      orderId: "order-a",
      shopId: "shop-a",
    })).resolves.toBe(second.orderToken);
    await expect(isBuyerOrderRecoveryBinding({
      candidateBindingHash: ORIGINAL_ORDER_TOKEN_HASH_A,
      currentOrderTokenHash: secondHash,
      env: runtime.env,
      orderId: "order-a",
      shopId: "shop-a",
    })).resolves.toBe(true);
    await expect(isBuyerOrderRecoveryBinding({
      candidateBindingHash: firstHash,
      currentOrderTokenHash: secondHash,
      env: runtime.env,
      orderId: "order-a",
      shopId: "shop-a",
    })).resolves.toBe(true);
    await expect(isBuyerOrderRecoveryBinding({
      candidateBindingHash: ORIGINAL_ORDER_TOKEN_HASH_A,
      currentOrderTokenHash: secondHash,
      env: runtime.env,
      orderId: "order-b",
      shopId: "shop-b",
    })).resolves.toBe(false);
  });

  it("preserves historical bindings after more than 32 sequential recoveries", async () => {
    const runtime = createRuntime();
    let currentHash = ORIGINAL_ORDER_TOKEN_HASH_A;
    let currentToken = "";
    for (let index = 0; index < 40; index += 1) {
      const recoveryId = `orc_history_${String(index).padStart(2, "0")}`;
      const issuedAt = new Date(NOW.getTime() + index * 60_000).toISOString();
      const consumedAt = new Date(NOW.getTime() + index * 60_000 + 1_000).toISOString();
      const expiresAt = new Date(NOW.getTime() + index * 60_000 + 15 * 60_000).toISOString();
      const retentionExpiresAt = new Date(NOW.getTime() + index * 60_000 + 30 * 24 * 60 * 60_000).toISOString();
      currentToken = await hmacToken(
        runtime.env.IDENTIFIER_HMAC_SECRET,
        "buyer-order-recovery-access-token:v1:shop-a",
        recoveryId,
      );
      const replacementHash = await hmacToken(runtime.env.IDENTIFIER_HMAC_SECRET, "order-access", currentToken);
      const recoveryTokenHash = await hmacToken(
        runtime.env.IDENTIFIER_HMAC_SECRET,
        "buyer-order-recovery-history-test:v1",
        recoveryId,
      );
      runtime.database.prepare(`
        INSERT INTO order_access_recovery_tokens (
          id, shop_id, order_id, customer_id, token_hash, recipient_hash,
          issued_request_id, issued_at, expires_at, retention_expires_at, created_at
        ) VALUES (?, 'shop-a', 'order-a', 'customer-a', ?, ?, ?, ?, ?, ?, ?)
      `).run(recoveryId, recoveryTokenHash, "r".repeat(43), `request-history-${String(index).padStart(2, "0")}`, issuedAt, expiresAt, retentionExpiresAt, issuedAt);
      runtime.database.prepare(`
        UPDATE order_access_recovery_tokens
        SET consumed_at = ?, consumed_request_id = ?, previous_order_token_hash = ?,
          replacement_order_token_hash = ?
        WHERE id = ? AND shop_id = 'shop-a'
      `).run(consumedAt, `consume-history-${String(index).padStart(2, "0")}`, currentHash, replacementHash, recoveryId);
      currentHash = replacementHash;
    }

    await expect(isBuyerOrderRecoveryBinding({
      candidateBindingHash: ORIGINAL_ORDER_TOKEN_HASH_A,
      currentOrderTokenHash: currentHash,
      env: runtime.env,
      orderId: "order-a",
      shopId: "shop-a",
    })).resolves.toBe(true);
    await expect(resolveCurrentBuyerOrderRecoveryToken({
      currentOrderTokenHash: currentHash,
      env: runtime.env,
      orderId: "order-a",
      shopId: "shop-a",
    })).resolves.toBe(currentToken);
  });

  it("keeps one active token per tenant order and permits a new token only after expiry", async () => {
    const runtime = createRuntime();
    await requestRecovery(runtime);
    await requestRecovery(runtime, { requestId: "request-active-duplicate" });
    expect(runtime.sentEmails).toHaveLength(1);

    await requestRecovery(runtime, {
      now: new Date(NOW.getTime() + 16 * 60_000),
      requestId: "request-after-expiry",
    });
    expect(runtime.sentEmails).toHaveLength(2);
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS rows, SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active
      FROM order_access_recovery_tokens
    `).get()).toEqual({ active: 1, rows: 2 });
  });
});
