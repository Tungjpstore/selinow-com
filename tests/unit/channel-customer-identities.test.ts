import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { upsertChannelCustomerIdentity } from "../../src/lib/channels/customer-identities";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = "2026-08-02T12:00:00.000Z";
const IDENTIFIER_SECRET = "channel-customer-identity-test-secret";

class SqliteStatement {
  constructor(private readonly database: DatabaseSync, private readonly sql: string, private readonly values: SQLInputValue[] = []) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[]);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createRuntime(): { database: DatabaseSync; env: Pick<AppBindings, "IDENTIFIER_HMAC_SECRET" | "PLATFORM_DB"> } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
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
      ('shop-identity-a', 'shop-identity-public-a', 'identity-a', 'Identity A', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}'),
      ('shop-identity-b', 'shop-identity-public-b', 'identity-b', 'Identity B', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}');
    INSERT INTO shop_customers (id, shop_id, display_name, locale, status, created_at, updated_at)
    VALUES
      ('customer-identity-a', 'shop-identity-a', 'Buyer A', 'en', 'active', '${NOW}', '${NOW}'),
      ('customer-identity-a2', 'shop-identity-a', 'Buyer A2', 'en', 'active', '${NOW}', '${NOW}'),
      ('customer-identity-b', 'shop-identity-b', 'Buyer B', 'en', 'active', '${NOW}', '${NOW}');
    INSERT INTO shop_channels (id, shop_id, channel_code, status, settings_json, version, created_at, updated_at)
    VALUES
      ('channel-identity-a', 'shop-identity-a', 'whatsapp.cloud', 'enabled', '{}', 1, '${NOW}', '${NOW}'),
      ('channel-identity-b', 'shop-identity-b', 'whatsapp.cloud', 'enabled', '{}', 1, '${NOW}', '${NOW}');
    INSERT INTO channel_connections (
      id, public_id, shop_id, shop_channel_id, provider_code, external_account_id,
      status, settings_json, version, created_at, updated_at
    ) VALUES
      ('connection-identity-a', 'connection-identity-public-a', 'shop-identity-a', 'channel-identity-a', 'whatsapp.cloud', 'waba-a', 'active', '{}', 1, '${NOW}', '${NOW}'),
      ('connection-identity-b', 'connection-identity-public-b', 'shop-identity-b', 'channel-identity-b', 'whatsapp.cloud', 'waba-b', 'active', '{}', 1, '${NOW}', '${NOW}');
  `);
  return { database, env: { IDENTIFIER_HMAC_SECRET: IDENTIFIER_SECRET, PLATFORM_DB: new SqliteD1(database) as unknown as D1Database } };
}

describe("channel customer identity migration and service", () => {
  it("adds a generic tenant-bound identity table without changing Telegram legacy rows", () => {
    const { database } = createRuntime();
    expect(database.prepare("PRAGMA table_info(channel_customer_identities)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "external_subject_hash", notnull: 1 }),
      expect.objectContaining({ name: "connection_id", notnull: 1 }),
    ]));
    database.prepare(`
      INSERT INTO customer_identities (
        id, shop_id, customer_id, provider, external_subject,
        verified_at, created_at, updated_at
      ) VALUES ('legacy-telegram-identity', 'shop-identity-a', 'customer-identity-a', 'telegram', 'legacy-hash', '${NOW}', '${NOW}', '${NOW}')
    `).run();
    expect(database.prepare("SELECT provider, external_subject FROM customer_identities WHERE id = 'legacy-telegram-identity'").get()).toEqual({ provider: "telegram", external_subject: "legacy-hash" });
  });

  it("hashes and idempotently upserts a same-tenant provider subject", async () => {
    const runtime = createRuntime();
    const first = await upsertChannelCustomerIdentity({
      connectionId: "connection-identity-a",
      customerId: "customer-identity-a",
      displayHandle: "buyer_a",
      displayName: "Buyer A",
      env: runtime.env,
      externalSubject: "provider-user-123",
      languageCode: "en-US",
      now: NOW,
      providerCode: "whatsapp.cloud",
      shopId: "shop-identity-a",
      verifiedAt: NOW,
    });
    const second = await upsertChannelCustomerIdentity({
      connectionId: "connection-identity-a",
      customerId: "customer-identity-a",
      displayHandle: "buyer_updated",
      displayName: "Buyer Updated",
      env: runtime.env,
      externalSubject: "provider-user-123",
      languageCode: "vi-VN",
      now: "2026-08-02T12:01:00.000Z",
      providerCode: "whatsapp.cloud",
      shopId: "shop-identity-a",
      verifiedAt: "2026-08-02T12:01:00.000Z",
    });
    expect(second.id).toBe(first.id);
    expect(second.externalSubjectHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second.displayName).toBe("Buyer Updated");
    expect(databaseRows(runtime.database)).toHaveLength(1);
    const stored = databaseRows(runtime.database)[0];
    expect(stored?.external_subject_hash).not.toBe("provider-user-123");
  });

  it("rejects tenant/provider/customer conflicts and unsafe direct writes", async () => {
    const runtime = createRuntime();
    const input = {
      connectionId: "connection-identity-a",
      customerId: "customer-identity-a",
      env: runtime.env,
      externalSubject: "provider-user-456",
      providerCode: "whatsapp.cloud",
      shopId: "shop-identity-a",
    } as const;
    await upsertChannelCustomerIdentity(input);
    await expect(upsertChannelCustomerIdentity({ ...input, customerId: "customer-identity-a2" })).rejects.toMatchObject({ code: "channel_customer_identity_conflict" });
    await expect(upsertChannelCustomerIdentity({ ...input, connectionId: "connection-identity-b" })).rejects.toMatchObject({ code: "channel_customer_identity_scope_invalid" });
    expect(() => runtime.database.prepare(`
      INSERT INTO channel_customer_identities (
        id, shop_id, customer_id, connection_id, provider_code,
        external_subject_hash, verified_at, created_at, updated_at
      ) VALUES ('identity-direct-cross-tenant', 'shop-identity-b', 'customer-identity-b', 'connection-identity-a', 'whatsapp.cloud', '${"A".repeat(43)}', '${NOW}', '${NOW}', '${NOW}')
    `).run()).toThrow(/channel_customer_identity_scope_mismatch/u);
  });

  it("fails closed when the seller disables the channel", async () => {
    const runtime = createRuntime();
    const input = {
      connectionId: "connection-identity-a",
      customerId: "customer-identity-a",
      env: runtime.env,
      externalSubject: "provider-user-disabled",
      providerCode: "whatsapp.cloud",
      shopId: "shop-identity-a",
    } as const;
    runtime.database.prepare("UPDATE shop_channels SET status = 'disabled' WHERE id = 'channel-identity-a'").run();
    await expect(upsertChannelCustomerIdentity(input)).rejects.toMatchObject({ code: "channel_customer_identity_scope_invalid" });
    expect(() => runtime.database.prepare(`
      INSERT INTO channel_customer_identities (
        id, shop_id, customer_id, connection_id, provider_code,
        external_subject_hash, verified_at, created_at, updated_at
      ) VALUES ('identity-disabled-channel', 'shop-identity-a', 'customer-identity-a', 'connection-identity-a', 'whatsapp.cloud', '${"B".repeat(43)}', '${NOW}', '${NOW}', '${NOW}')
    `).run()).toThrow(/channel_customer_identity_scope_mismatch/u);
    expect(() => runtime.database.prepare(`
      INSERT INTO channel_provider_event_receipts (
        id, shop_id, connection_id, provider_code, provider_event_id,
        action, payload_reference, status, received_at, created_at, updated_at
      ) VALUES ('receipt-disabled-channel', 'shop-identity-a', 'connection-identity-a', 'whatsapp.cloud', 'event-disabled', 'message.received', '${"C".repeat(43)}', 'accepted', '${NOW}', '${NOW}', '${NOW}')
    `).run()).toThrow(/channel_provider_event_receipt_scope_mismatch/u);
  });
});

function databaseRows(database: DatabaseSync): Array<Record<string, unknown>> {
  return database.prepare(`
    SELECT id, external_subject_hash, display_name_sanitized, display_handle_sanitized, language_code
    FROM channel_customer_identities
    ORDER BY id
  `).all();
}
