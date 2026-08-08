import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import type { PayOSCredentials } from "../../src/lib/payments/crypto";

vi.mock("../../src/lib/tenants/store", () => ({
  getShopForMember: vi.fn((input: { shopPublicId: string }) => Promise.resolve({
    row: {
      role: "owner",
      shop_id: input.shopPublicId.endsWith("0001") ? "shop-a" : "shop-b",
    },
    shop: {},
  })),
}));

import { connectPayOS } from "../../src/lib/payments/integrations";

const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SHOP_A = "shop_00000000-0000-4000-8000-000000000001";
const SHOP_B = "shop_00000000-0000-4000-8000-000000000002";
const CHANNEL: PayOSCredentials = {
  apiKey: "shared-api-key",
  checksumKey: "shared-checksum-key",
  clientId: "shared-client-id",
};

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    readonly sql: string,
    private readonly values: SQLInputValue[] = [],
    private readonly beforeFirst?: FirstHook,
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }), this.beforeFirst);
  }

  async first<T>(): Promise<T | null> {
    await this.beforeFirst?.(this);
    return (this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
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

function seed(database: DatabaseSync): void {
  const now = "2026-08-09T00:00:00.000Z";
  database.prepare(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES
      ('owner-a', 'owner-a@example.test', 'Owner A', 'active', ?, ?),
      ('owner-b', 'owner-b@example.test', 'Owner B', 'active', ?, ?)
  `).run(now, now, now, now);
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shop-a', ?, 'shop-a', 'Shop A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?),
      ('shop-b', ?, 'shop-b', 'Shop B', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(SHOP_A, now, now, SHOP_B, now, now);
}

type BatchHook = (statements: SqliteStatement[]) => void;
type FirstHook = (statement: SqliteStatement) => Promise<void>;

function bindings(database: DatabaseSync, hooks: { beforeBatch?: BatchHook; beforeFirst?: FirstHook } = {}): AppBindings {
  return {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    API_ORIGIN: "https://api.example.test",
    CREDENTIAL_KEK_V1: KEK,
    CREDENTIAL_KEY_VERSION: "v1",
    IDENTIFIER_HMAC_SECRET: "payos-concurrency-test-secret",
    PLATFORM_DB: {
      async batch(statements: D1PreparedStatement[]) {
        const sqliteStatements = statements as unknown as SqliteStatement[];
        hooks.beforeBatch?.(sqliteStatements);
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
        return new SqliteStatement(database, sql, [], hooks.beforeFirst) as unknown as D1PreparedStatement;
      },
    } as D1Database,
  } as unknown as AppBindings;
}

type ProviderCall = {
  resolve: () => void;
  webhookUrl: string;
};

class ControlledProvider {
  readonly calls: ProviderCall[] = [];
  private readonly waiters: Array<() => void> = [];

  readonly fetcher: typeof fetch = (_url, init) => new Promise<Response>((resolve) => {
    if (typeof init?.body !== "string") throw new TypeError("provider_body_required");
    const body = JSON.parse(init.body) as { webhookUrl: string };
    this.calls.push({
      resolve: () => {
        resolve(new Response(JSON.stringify({ code: "00", data: true }), { status: 200 }));
      },
      webhookUrl: body.webhookUrl,
    });
    this.waiters.splice(0).forEach((notify) => {
      notify();
    });
  });

  async waitForCalls(count: number): Promise<void> {
    while (this.calls.length < count) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

type Outcome =
  | { error: unknown; status: "rejected" }
  | { status: "fulfilled"; value: Awaited<ReturnType<typeof connectPayOS>> };

function outcome(promise: ReturnType<typeof connectPayOS>): Promise<Outcome> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (error: unknown) => ({ error, status: "rejected" }),
  );
}

function webhookUrl(database: DatabaseSync, shopId: string): string {
  const row = database.prepare(`
    SELECT webhook_public_id AS webhookPublicId
    FROM payment_integrations WHERE shop_id = ?
  `).get(shopId) as { webhookPublicId: string };
  return `https://api.example.test/webhooks/payos/${row.webhookPublicId}`;
}

function unclaimedIdentityReadBarrier(): { beforeFirst: FirstHook; reads: () => number } {
  let reads = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    beforeFirst: async (statement) => {
      if (reads >= 2 || !statement.sql.includes("WHERE provider = 'payos' AND provider_identity_fingerprint = ?")) return;
      reads += 1;
      if (reads === 2) release();
      await gate;
    },
    reads: () => reads,
  };
}

describe("PayOS integration ownership concurrency", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    seed(database);
  });

  afterEach(() => {
    database.close();
  });

  it.each([
    {
      first: { publicId: SHOP_A, shopId: "shop-a", userId: "owner-a" },
      name: "the first provider response arrives first",
      responseOrder: [0, 1],
      second: { publicId: SHOP_B, shopId: "shop-b", userId: "owner-b" },
    },
    {
      first: { publicId: SHOP_B, shopId: "shop-b", userId: "owner-b" },
      name: "the second provider response arrives first",
      responseOrder: [1, 0],
      second: { publicId: SHOP_A, shopId: "shop-a", userId: "owner-a" },
    },
  ])("reserves identical credentials before redirecting the webhook when $name", async ({ first, responseOrder, second }) => {
    const barrier = unclaimedIdentityReadBarrier();
    const env = bindings(database, { beforeFirst: barrier.beforeFirst });
    const provider = new ControlledProvider();
    const firstResult = outcome(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: provider.fetcher,
      requestId: `request-${first.shopId}`,
      shopPublicId: first.publicId,
      userId: first.userId,
    }));
    const secondResult = outcome(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: provider.fetcher,
      requestId: `request-${second.shopId}`,
      shopPublicId: second.publicId,
      userId: second.userId,
    }));
    const phase = await Promise.race([
      provider.waitForCalls(2).then(() => "both-called" as const),
      firstResult.then(() => "one-settled" as const),
      secondResult.then(() => "one-settled" as const),
    ]);

    if (phase === "both-called") {
      for (const index of responseOrder) {
        provider.calls[index]?.resolve();
        await (index === 0 ? firstResult : secondResult);
      }
    } else {
      provider.calls[0]?.resolve();
    }

    const [firstOutcome, secondOutcome] = await Promise.all([firstResult, secondResult]);
    const successfulShop = firstOutcome.status === "fulfilled" ? first : second;
    const rejectedOutcome = firstOutcome.status === "rejected" ? firstOutcome : secondOutcome;
    expect([firstOutcome.status, secondOutcome.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(rejectedOutcome).toMatchObject({ error: { code: "credential_already_connected", status: 409 }, status: "rejected" });
    expect(provider.calls.map((call) => call.webhookUrl)).toEqual([webhookUrl(database, successfulShop.shopId)]);
    expect(barrier.reads()).toBe(2);
    expect(database.prepare(`
      SELECT shop_id AS shopId FROM payment_integrations
      WHERE provider_identity_fingerprint IS NOT NULL
    `).all()).toEqual([{ shopId: successfulShop.shopId }]);
  });

  it("releases provisional ownership after provider rejection so another shop can connect", async () => {
    const env = bindings(database);
    let failedCalls = 0;
    const rejectedProvider: typeof fetch = () => {
      failedCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({ code: "01", data: false }), { status: 409 }));
    };
    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: rejectedProvider,
      requestId: "request-rejected",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "provider_verification_failed", status: 409 });

    expect(database.prepare(`
      SELECT provider_identity_fingerprint AS identity, status
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get()).toEqual({ identity: null, status: "error" });
    expect(database.prepare(`
      SELECT provider_ownership_fingerprint AS ownership, status
      FROM payment_credentials WHERE shop_id = 'shop-a'
    `).get()).toEqual({ ownership: null, status: "error" });

    let successfulCalls = 0;
    const acceptedProvider: typeof fetch = () => {
      successfulCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({ code: "00", data: true }), { status: 200 }));
    };
    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: acceptedProvider,
      requestId: "request-retry-other-shop",
      shopPublicId: SHOP_B,
      userId: "owner-b",
    })).resolves.toMatchObject({ status: "active", webhookStatus: "verified" });
    expect({ failedCalls, successfulCalls }).toEqual({ failedCalls: 1, successfulCalls: 1 });
  });

  it("retains provisional ownership when release compensation fails and blocks another provider write", async () => {
    let compensationAttempts = 0;
    const env = bindings(database, {
      beforeBatch: (statements) => {
        if (statements.some((statement) => statement.sql.includes("SET provider_identity_fingerprint = NULL"))) {
          compensationAttempts += 1;
          throw new Error("injected_compensation_failure");
        }
      },
    });
    let failedCalls = 0;
    const rejectedProvider: typeof fetch = () => {
      failedCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({ code: "01", data: false }), { status: 409 }));
    };
    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: rejectedProvider,
      requestId: "request-compensation-failure",
      shopPublicId: SHOP_A,
      userId: "owner-a",
    })).rejects.toMatchObject({ code: "provider_verification_failed", status: 409 });

    expect(compensationAttempts).toBe(1);
    expect(database.prepare(`
      SELECT provider_identity_fingerprint IS NOT NULL AS identityOwned, status
      FROM payment_integrations WHERE shop_id = 'shop-a'
    `).get()).toEqual({ identityOwned: 1, status: "error" });
    expect(database.prepare(`
      SELECT provider_ownership_fingerprint IS NOT NULL AS credentialOwned, status
      FROM payment_credentials WHERE shop_id = 'shop-a'
    `).get()).toEqual({ credentialOwned: 1, status: "error" });

    let secondProviderCalls = 0;
    const secondProvider: typeof fetch = () => {
      secondProviderCalls += 1;
      return Promise.resolve(new Response(JSON.stringify({ code: "00", data: true }), { status: 200 }));
    };
    await expect(connectPayOS({
      credentials: CHANNEL,
      env,
      fetcher: secondProvider,
      requestId: "request-blocked-other-shop",
      shopPublicId: SHOP_B,
      userId: "owner-b",
    })).rejects.toMatchObject({ code: "credential_already_connected", status: 409 });
    expect({ failedCalls, secondProviderCalls }).toEqual({ failedCalls: 1, secondProviderCalls: 0 });
  });
});
