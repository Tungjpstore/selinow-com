import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { ChannelAdapterRegistry } from "../../src/lib/channels/registry";
import { D1ChannelConnectionRepository } from "../../src/lib/channels/store";
import { toBase64Url } from "../../src/lib/core/ids";
import type { ChannelAdapterManifest, ChannelCapability } from "../../src/lib/channels/types";

class SqliteStatement {
  private values: SQLInputValue[] = [];

  constructor(private readonly database: DatabaseSync, private readonly sql: string) {}

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: Record<string, SQLInputValue>[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
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

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
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

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(): SqliteD1 {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  const now = "2026-07-26T00:00:00.000Z";
  database.exec(`
    INSERT INTO platform_users (
      id, email_normalized, display_name, status, created_at, updated_at
    ) VALUES
      ('user_owner_a', 'owner-a@example.com', 'Owner A', 'active', '${now}', '${now}'),
      ('user_owner_b', 'owner-b@example.com', 'Owner B', 'active', '${now}', '${now}');

    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shop_tenant_a', 'shop_public_a', 'tenant-a', 'Tenant A', 'draft',
        'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}'),
      ('shop_tenant_b', 'shop_public_b', 'tenant-b', 'Tenant B', 'draft',
        'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}');

    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES
      ('shop_tenant_a', 'user_owner_a', 'owner', 'active', '${now}', '${now}'),
      ('shop_tenant_b', 'user_owner_b', 'owner', 'active', '${now}', '${now}');
  `);
  return new SqliteD1(database);
}

const CAPABILITIES = {
  catalog: "catalog.read",
  checkout: "checkout.external_link",
  inbound: "conversation.inbound",
} as const satisfies Record<string, ChannelCapability>;

const manifest: ChannelAdapterManifest = {
  capabilities: [CAPABILITIES.inbound, CAPABILITIES.catalog, CAPABILITIES.checkout],
  code: "fake.provider",
  version: 1,
};

function repositoryFor(database: SqliteD1): D1ChannelConnectionRepository {
  return new D1ChannelConnectionRepository(
    database as unknown as D1Database,
    new ChannelAdapterRegistry([manifest]),
  );
}

function capabilitySet(...capabilities: ChannelCapability[]): ReadonlySet<ChannelCapability> {
  return new Set(capabilities);
}

describe("generic channel connection migration", () => {
  it("creates tenant-bound channel, connection, grant and credential foreign keys", () => {
    const database = createDatabase().database;

    expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'shop_channels', 'channel_connections',
        'channel_connection_grants', 'channel_credentials'
      ) ORDER BY name
    `).all()).toEqual([
      { name: "channel_connection_grants" },
      { name: "channel_connections" },
      { name: "channel_credentials" },
      { name: "shop_channels" },
    ]);

    const now = "2026-07-26T00:00:00.000Z";
    database.exec(`
      INSERT INTO shop_channels (
        id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
      ) VALUES
        ('shop_channel_a', 'shop_tenant_a', 'fake', 'enabled', '{}', 1, '${now}', '${now}'),
        ('shop_channel_b', 'shop_tenant_b', 'fake', 'enabled', '{}', 1, '${now}', '${now}');
    `);
    expect(() => {
      database.exec(`
        INSERT INTO channel_connections (
          id, public_id, shop_id, shop_channel_id, provider_code,
          status, settings_json, version, created_at, updated_at
        ) VALUES (
          'connection_cross_tenant', 'connection_public_cross', 'shop_tenant_a',
          'shop_channel_b', 'fake.provider', 'pending', '{}', 1, '${now}', '${now}'
        );
      `);
    }).toThrow();
    expect(() => {
      database.exec(`
        INSERT INTO channel_connections (
          id, public_id, shop_id, shop_channel_id, provider_code,
          status, settings_json, version, created_at, updated_at
        ) VALUES (
          'connection_secret_metadata', 'connection_public_secret', 'shop_tenant_a',
          'shop_channel_a', 'fake.provider', 'pending', '{"accessToken":"secret"}',
          1, '${now}', '${now}'
        );
      `);
    }).toThrow();
  });

  it("allows same-connection rotation but blocks a live credential fingerprint crossing connections", () => {
    const database = createDatabase().database;
    const now = "2026-07-26T00:00:00.000Z";
    const fingerprint = "f".repeat(64);
    database.exec(`
      INSERT INTO shop_channels (
        id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
      ) VALUES
        ('shop_channel_a', 'shop_tenant_a', 'fake', 'enabled', '{}', 1, '${now}', '${now}'),
        ('shop_channel_b', 'shop_tenant_b', 'fake', 'enabled', '{}', 1, '${now}', '${now}');
      INSERT INTO channel_connections (
        id, public_id, shop_id, shop_channel_id, provider_code,
        status, settings_json, version, created_at, updated_at
      ) VALUES
        ('connection_tenant_a', 'connection_public_a', 'shop_tenant_a', 'shop_channel_a',
          'fake.provider', 'active', '{}', 1, '${now}', '${now}'),
        ('connection_tenant_b', 'connection_public_b', 'shop_tenant_b', 'shop_channel_b',
          'fake.provider', 'pending', '{}', 1, '${now}', '${now}');
      INSERT INTO channel_credentials (
        id, shop_id, connection_id, provider_code, status, version, key_version,
        credential_envelope_ciphertext_b64, credential_envelope_iv_b64,
        credential_fingerprint, created_by_user_id, created_at
      ) VALUES (
        'credential_a_v1', 'shop_tenant_a', 'connection_tenant_a', 'fake.provider',
        'grace', 1, 'key-v1', 'ciphertext-value-1', 'iv-value-0001',
        '${fingerprint}', 'user_owner_a', '${now}'
      );
      INSERT INTO channel_credentials (
        id, shop_id, connection_id, provider_code, status, version, key_version,
        credential_envelope_ciphertext_b64, credential_envelope_iv_b64,
        credential_fingerprint, created_by_user_id, created_at
      ) VALUES (
        'credential_a_v2', 'shop_tenant_a', 'connection_tenant_a', 'fake.provider',
        'active', 2, 'key-v2', 'ciphertext-value-2', 'iv-value-0002',
        '${fingerprint}', 'user_owner_a', '${now}'
      );
    `);

    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM channel_credentials
      WHERE connection_id = 'connection_tenant_a' AND credential_fingerprint = ?
    `).get(fingerprint)).toEqual({ count: 2 });
    expect(() => database.prepare(`
      INSERT INTO channel_credentials (
        id, shop_id, connection_id, provider_code, status, version, key_version,
        credential_envelope_ciphertext_b64, credential_envelope_iv_b64,
        credential_fingerprint, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?)
    `).run(
      "credential_b_v1", "shop_tenant_b", "connection_tenant_b", "fake.provider",
      "key-v1", "ciphertext-value-3", "iv-value-0003", fingerprint, "user_owner_b", now,
    )).toThrow(/channel_credential_owned_by_other_connection/u);
    expect(() => database.prepare(`
      INSERT INTO channel_credentials (
        id, shop_id, connection_id, provider_code, status, version, key_version,
        credential_envelope_ciphertext_b64, credential_envelope_iv_b64,
        credential_fingerprint, created_by_user_id, created_at
      ) VALUES (?, ?, ?, ?, 'pending', 3, ?, ?, ?, ?, ?, ?)
    `).run(
      "credential_wrong_actor", "shop_tenant_a", "connection_tenant_a", "fake.provider",
      "key-v3", "ciphertext-value-4", "iv-value-0004", "e".repeat(64), "user_owner_b", now,
    )).toThrow(/channel_credential_actor_not_tenant_member/u);

    database.prepare("UPDATE channel_connections SET status = 'active' WHERE id = ?")
      .run("connection_tenant_b");
    database.prepare("UPDATE channel_connections SET status = 'disconnected' WHERE id = ?")
      .run("connection_tenant_b");
    expect(() => database.prepare(
      "UPDATE channel_connections SET status = 'active' WHERE id = ?",
    ).run("connection_tenant_b")).toThrow(/channel_connection_status_transition_invalid/u);
  });
});

describe("D1 channel connection repository", () => {
  it("reports live provider codes that are missing from the server registry", async () => {
    const database = createDatabase();
    const repository = repositoryFor(database);
    const known = await repository.createConnection({
      channelCode: "fake",
      externalAccountId: "registry-known-account",
      providerCode: "fake.provider",
      shopId: "shop_tenant_a",
    });
    const disconnected = await repository.createConnection({
      channelCode: "fake",
      externalAccountId: "registry-historical-account",
      providerCode: "fake.provider",
      shopId: "shop_tenant_a",
    });
    await repository.setStatus({
      connectionId: disconnected.id,
      expectedVersion: disconnected.version,
      shopId: "shop_tenant_a",
      status: "disconnected",
    });
    database.database.prepare(`
      INSERT INTO channel_connections (
        id, public_id, shop_id, shop_channel_id, provider_code,
        external_account_id, status, settings_json, version, created_at, updated_at
      ) SELECT
        'connection_unknown_registry', 'connection_unknown_public', shop_id, id,
        'unregistered.provider', 'registry-unknown-account', 'degraded', '{}', 1,
        '2026-07-26T00:00:00.000Z', '2026-07-26T00:00:00.000Z'
      FROM shop_channels WHERE shop_id = 'shop_tenant_a' AND channel_code = 'fake'
    `).run();

    expect(known.status).toBe("pending");
    expect(await repository.registryHealth()).toMatchObject({
      referencedProviderCodes: ["fake.provider", "unregistered.provider"],
      status: "unhealthy",
      unknownProviderCodes: ["unregistered.provider"],
    });
  });

  it("keeps reads and optimistic lifecycle updates tenant scoped", async () => {
    const database = createDatabase();
    const repository = repositoryFor(database);
    const connection = await repository.createConnection({
      channelCode: "fake",
      externalAccountId: "provider-account-a",
      providerCode: "fake.provider",
      providerGrants: [CAPABILITIES.catalog, CAPABILITIES.checkout],
      shopId: "shop_tenant_a",
    });

    expect(await repository.get("shop_tenant_b", connection.id)).toBeNull();
    expect(await repository.list("shop_tenant_b")).toEqual([]);
    await expect(repository.setStatus({
      connectionId: connection.id,
      expectedVersion: connection.version,
      shopId: "shop_tenant_b",
      status: "active",
    })).rejects.toMatchObject({ code: "channel_connection_not_found", status: 404 });

    const active = await repository.setStatus({
      connectionId: connection.id,
      expectedVersion: connection.version,
      shopId: "shop_tenant_a",
      status: "active",
    });
    expect(active).toMatchObject({ shopId: "shop_tenant_a", status: "active", version: 2 });
    await expect(repository.setStatus({
      connectionId: connection.id,
      expectedVersion: connection.version,
      shopId: "shop_tenant_a",
      status: "degraded",
    })).rejects.toMatchObject({ code: "channel_connection_version_conflict", status: 409 });
  });

  it("enforces the connection lifecycle transition graph", async () => {
    const database = createDatabase();
    const repository = repositoryFor(database);
    const connection = await repository.createConnection({
      channelCode: "fake",
      externalAccountId: "transition-account",
      providerCode: "fake.provider",
      shopId: "shop_tenant_a",
    });
    const active = await repository.setStatus({
      connectionId: connection.id,
      expectedVersion: connection.version,
      shopId: "shop_tenant_a",
      status: "active",
    });
    const disconnected = await repository.setStatus({
      connectionId: active.id,
      expectedVersion: active.version,
      shopId: "shop_tenant_a",
      status: "disconnected",
    });

    await expect(repository.setStatus({
      connectionId: disconnected.id,
      expectedVersion: disconnected.version,
      shopId: "shop_tenant_a",
      status: "active",
    })).rejects.toMatchObject({
      code: "channel_connection_transition_invalid",
      status: 409,
    });
    expect(database.database.prepare(
      "SELECT status FROM channel_connections WHERE id = ?",
    ).get(disconnected.id)).toEqual({ status: "disconnected" });
  });

  it("requires and replays an idempotency key for a connection without external identity", async () => {
    const database = createDatabase();
    const repository = repositoryFor(database);
    await expect(repository.createConnection({
      channelCode: "fake",
      providerCode: "fake.provider",
      shopId: "shop_tenant_a",
    })).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["channel_idempotency_key_required"],
      status: 400,
    });

    const first = await repository.createConnection({
      channelCode: "fake",
      idempotencyKey: "connect-intent-replay",
      providerCode: "fake.provider",
      shopId: "shop_tenant_a",
    });
    const replay = await repository.createConnection({
      channelCode: "fake",
      idempotencyKey: "connect-intent-replay",
      providerCode: "fake.provider",
      shopId: "shop_tenant_a",
    });
    expect(replay.id).toBe(first.id);
    expect(await repository.list("shop_tenant_a", "fake")).toHaveLength(1);
  });

  it("projects only capabilities allowed by adapter, live grants, plan, health and policy", async () => {
    const database = createDatabase();
    const repository = repositoryFor(database);
    const pending = await repository.createConnection({
      channelCode: "fake",
      idempotencyKey: "connect-intent-projection",
      providerCode: "fake.provider",
      providerGrants: [CAPABILITIES.catalog, CAPABILITIES.checkout],
      shopId: "shop_tenant_a",
    });

    const pendingProjection = await repository.projectCapabilities({
      connectionId: pending.id,
      planEntitlements: capabilitySet(CAPABILITIES.catalog, CAPABILITIES.checkout),
      shopId: "shop_tenant_a",
    });
    expect(pendingProjection.capabilities.size).toBe(0);

    const active = await repository.setStatus({
      connectionId: pending.id,
      expectedVersion: pending.version,
      shopId: "shop_tenant_a",
      status: "active",
    });
    const projection = await repository.projectCapabilities({
      connectionId: active.id,
      planEntitlements: capabilitySet(CAPABILITIES.catalog, CAPABILITIES.checkout),
      policyBlockedCapabilities: capabilitySet(CAPABILITIES.checkout),
      shopId: "shop_tenant_a",
    });

    expect([...projection.providerGrants]).toEqual([CAPABILITIES.catalog, CAPABILITIES.checkout]);
    expect([...projection.capabilities]).toEqual([CAPABILITIES.catalog]);
    await expect(repository.projectCapabilities({
      connectionId: active.id,
      planEntitlements: capabilitySet(CAPABILITIES.catalog),
      shopId: "shop_tenant_b",
    })).rejects.toMatchObject({ code: "channel_connection_not_found", status: 404 });
  });

  it.each(["pending", "disabled"] as const)(
    "projects no effective capabilities when the parent shop channel is %s",
    async (channelStatus) => {
      const database = createDatabase();
      const repository = repositoryFor(database);
      const pending = await repository.createConnection({
        channelCode: "fake",
        idempotencyKey: `connect-intent-${channelStatus}`,
        providerCode: "fake.provider",
        providerGrants: [CAPABILITIES.catalog, CAPABILITIES.checkout],
        shopId: "shop_tenant_a",
      });
      const active = await repository.setStatus({
        connectionId: pending.id,
        expectedVersion: pending.version,
        shopId: "shop_tenant_a",
        status: "active",
      });
      database.database.prepare(`
        UPDATE shop_channels
        SET status = ?, version = version + 1, updated_at = ?
        WHERE shop_id = ? AND id = ?
      `).run(
        channelStatus,
        "2026-07-26T01:00:00.000Z",
        active.shopId,
        active.shopChannelId,
      );

      const projection = await repository.projectCapabilities({
        connectionId: active.id,
        planEntitlements: capabilitySet(CAPABILITIES.catalog, CAPABILITIES.checkout),
        shopId: active.shopId,
      });

      expect([...projection.providerGrants]).toEqual([CAPABILITIES.catalog, CAPABILITIES.checkout]);
      expect(projection.capabilities.size).toBe(0);
    },
  );

  it("supports multiple accounts, replays one tenant identity and rejects cross-tenant reuse", async () => {
    const database = createDatabase();
    const repository = repositoryFor(database);
    const first = await repository.createConnection({
      channelCode: "fake",
      externalAccountId: "account-a",
      providerCode: "fake.provider",
      shopId: "shop_tenant_a",
    });
    await repository.createConnection({
      channelCode: "fake",
      externalAccountId: "account-b",
      providerCode: "fake.provider",
      shopId: "shop_tenant_a",
    });
    const replay = await repository.createConnection({
      channelCode: "fake",
      externalAccountId: "account-a",
      providerCode: "fake.provider",
      shopId: "shop_tenant_a",
    });

    expect(replay.id).toBe(first.id);
    expect(await repository.list("shop_tenant_a", "fake")).toHaveLength(2);
    await expect(repository.createConnection({
      channelCode: "fake",
      externalAccountId: "account-a",
      providerCode: "fake.provider",
      shopId: "shop_tenant_b",
    })).rejects.toMatchObject({ code: "channel_connection_conflict", status: 409 });
  });

  it("rejects unreviewed settings so credentials cannot enter generic metadata", async () => {
    const database = createDatabase();
    const repository = repositoryFor(database);

    await expect(repository.createConnection({
      channelCode: "fake",
      idempotencyKey: "connect-intent-settings",
      providerCode: "fake.provider",
      settings: { accessToken: "must-not-be-stored" },
      shopId: "shop_tenant_a",
    })).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["channel_settings_not_supported"],
      status: 400,
    });
    expect(database.database.prepare("SELECT COUNT(*) AS count FROM channel_connections").get())
      .toEqual({ count: 0 });
  });

  it("validates encrypted envelopes and requires an active tenant member actor", async () => {
    const database = createDatabase();
    const repository = repositoryFor(database);
    const connection = await repository.createConnection({
      channelCode: "fake",
      externalAccountId: "credential-account",
      providerCode: "fake.provider",
      shopId: "shop_tenant_a",
    });
    const ciphertextB64 = toBase64Url(new Uint8Array(32).fill(1));
    const ivB64 = toBase64Url(new Uint8Array(12).fill(2));
    const fingerprint = toBase64Url(new Uint8Array(32).fill(3));

    const credential = await repository.createCredentialEnvelope({
      ciphertextB64,
      createdByUserId: "user_owner_a",
      fingerprint,
      ivB64,
      keyVersion: "v1",
      connectionId: connection.id,
      shopId: "shop_tenant_a",
    });
    expect(credential).toMatchObject({
      connectionId: connection.id,
      createdByUserId: "user_owner_a",
      status: "pending",
      version: 1,
    });

    await expect(repository.createCredentialEnvelope({
      ciphertextB64: "not-base64-url",
      createdByUserId: "user_owner_a",
      fingerprint,
      ivB64,
      keyVersion: "v1",
      connectionId: connection.id,
      shopId: "shop_tenant_a",
    })).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["channel_credential_ciphertext_invalid"],
      status: 400,
    });
    await expect(repository.createCredentialEnvelope({
      ciphertextB64,
      createdByUserId: "user_owner_a",
      fingerprint,
      ivB64: toBase64Url(new Uint8Array(11).fill(2)),
      keyVersion: "v1",
      connectionId: connection.id,
      shopId: "shop_tenant_a",
    })).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["channel_credential_iv_invalid"],
      status: 400,
    });
    await expect(repository.createCredentialEnvelope({
      ciphertextB64,
      createdByUserId: "user_owner_a",
      fingerprint: toBase64Url(new Uint8Array(31).fill(3)),
      ivB64,
      keyVersion: "v1",
      connectionId: connection.id,
      shopId: "shop_tenant_a",
    })).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["channel_credential_fingerprint_invalid"],
      status: 400,
    });
    await expect(repository.createCredentialEnvelope({
      ciphertextB64,
      createdByUserId: "user_owner_b",
      fingerprint: toBase64Url(new Uint8Array(32).fill(4)),
      ivB64,
      keyVersion: "v1",
      connectionId: connection.id,
      shopId: "shop_tenant_a",
    })).rejects.toMatchObject({ code: "channel_credential_actor_forbidden", status: 403 });
  });
});
