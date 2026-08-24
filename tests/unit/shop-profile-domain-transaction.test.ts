import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { createShop, updateShopProfile } from "../../src/lib/tenants/store";

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
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

function createD1(database: DatabaseSync): D1Database {
  return {
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
  } as unknown as D1Database;
}

function applyMigrations(database: DatabaseSync): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
}

function createEnv(database: DatabaseSync): AppBindings {
  return {
    DEFAULT_CURRENCY: "VND",
    DEFAULT_LOCALE: "vi",
    DEFAULT_TIMEZONE: "Asia/Ho_Chi_Minh",
    IDENTIFIER_HMAC_SECRET: "shop-profile-domain-test-secret",
    PLATFORM_BASE_DOMAIN: "staging.selinow.test",
    PLATFORM_DB: createD1(database),
    SESSION_SECRET: "shop-profile-domain-test-session-secret",
  } as unknown as AppBindings;
}

function insertUser(database: DatabaseSync, id: string, email: string): void {
  const now = "2026-07-29T00:00:00.000Z";
  database.prepare(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(id, email, id, now, now);
}

describe("updateShopProfile platform slug/domain transaction", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    insertUser(database, "user-a", "a@example.test");
    insertUser(database, "user-b", "b@example.test");
    env = createEnv(database);
  });

  afterEach(() => {
    database.close();
  });

  async function createOwnedShop(input: { idempotencyKey: string; slug: string; userId: string }) {
    return createShop({
      env,
      idempotencyKey: input.idempotencyKey,
      name: `Shop ${input.slug}`,
      planCode: "starter",
      requesterAddress: input.userId === "user-a" ? "203.0.113.10" : "203.0.113.11",
      requestId: `request-${input.slug}`,
      slug: input.slug,
      userId: input.userId,
    });
  }

  function shopRow(publicId: string): { id: string; slug: string; canonicalDomainId: string | null } {
    return database.prepare(`
      SELECT id, slug, canonical_domain_id AS canonicalDomainId
      FROM shops WHERE public_id = ?
    `).get(publicId) as { id: string; slug: string; canonicalDomainId: string | null };
  }

  it("rejects reserved slugs before changing the shop or its platform domain", async () => {
    const shop = await createOwnedShop({ idempotencyKey: "profile-domain-reserved", slug: "reserved-source", userId: "user-a" });
    const before = shopRow(shop.shop.publicId);
    const domainBefore = database.prepare(`
      SELECT id, hostname_normalized AS hostname, status, is_primary AS isPrimary, deleted_at AS deletedAt
      FROM shop_domains WHERE shop_id = ? ORDER BY created_at, id
    `).all(before.id);

    await expect(updateShopProfile({
      env,
      requestId: "request-reserved-slug",
      shopPublicId: shop.shop.publicId,
      slug: "www",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["slug_reserved"], status: 409 });

    expect(shopRow(shop.shop.publicId)).toEqual(before);
    expect(database.prepare(`
      SELECT id, hostname_normalized AS hostname, status, is_primary AS isPrimary, deleted_at AS deletedAt
      FROM shop_domains WHERE shop_id = ? ORDER BY created_at, id
    `).all(before.id)).toEqual(domainBefore);
  });

  it("rejects a globally unavailable slug without touching either tenant", async () => {
    const shopA = await createOwnedShop({ idempotencyKey: "profile-domain-unavailable-a", slug: "unavailable-source", userId: "user-a" });
    const shopB = await createOwnedShop({ idempotencyKey: "profile-domain-unavailable-b", slug: "unavailable-target", userId: "user-b" });
    const beforeA = shopRow(shopA.shop.publicId);
    const beforeB = shopRow(shopB.shop.publicId);

    await expect(updateShopProfile({
      env,
      requestId: "request-unavailable-slug",
      shopPublicId: shopA.shop.publicId,
      slug: "unavailable-target",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["slug_unavailable"], status: 409 });

    expect(shopRow(shopA.shop.publicId)).toEqual(beforeA);
    expect(shopRow(shopB.shop.publicId)).toEqual(beforeB);
    expect(database.prepare("SELECT COUNT(*) AS count FROM shop_domains WHERE hostname_normalized = ?")
      .get("unavailable-target.staging.selinow.test")).toEqual({ count: 1 });
  });

  it("enforces tenant isolation for slug/domain mutations", async () => {
    const shopA = await createOwnedShop({ idempotencyKey: "profile-domain-isolation-a", slug: "isolation-source", userId: "user-a" });
    const shopB = await createOwnedShop({ idempotencyKey: "profile-domain-isolation-b", slug: "isolation-other", userId: "user-b" });
    const beforeA = shopRow(shopA.shop.publicId);
    const beforeB = shopRow(shopB.shop.publicId);

    await expect(updateShopProfile({
      env,
      requestId: "request-cross-tenant-slug",
      shopPublicId: shopA.shop.publicId,
      slug: "cross-tenant-attempt",
      userId: "user-b",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });

    expect(shopRow(shopA.shop.publicId)).toEqual(beforeA);
    expect(shopRow(shopB.shop.publicId)).toEqual(beforeB);
    expect(database.prepare("SELECT COUNT(*) AS count FROM shop_domains WHERE hostname_normalized = ?")
      .get("cross-tenant-attempt.staging.selinow.test")).toEqual({ count: 0 });
  });

  it("tombstones the old platform domain and selects the new hostname as active primary canonical", async () => {
    const shop = await createOwnedShop({ idempotencyKey: "profile-domain-rotate", slug: "rotate-source", userId: "user-a" });
    const before = shopRow(shop.shop.publicId);
    const oldDomain = database.prepare(`
      SELECT id, hostname_normalized AS hostname
      FROM shop_domains WHERE shop_id = ? AND type = 'platform_subdomain' AND deleted_at IS NULL
      ORDER BY is_primary DESC, created_at ASC, id ASC LIMIT 1
    `).get(before.id) as { id: string; hostname: string };

    await expect(updateShopProfile({
      env,
      requestId: "request-rotate-slug",
      shopPublicId: shop.shop.publicId,
      slug: "rotate-target",
      userId: "user-a",
    })).resolves.toMatchObject({ slug: "rotate-target" });

    const after = shopRow(shop.shop.publicId);
    const domains = database.prepare(`
      SELECT id, hostname_normalized AS hostname, status, is_primary AS isPrimary, deleted_at AS deletedAt
      FROM shop_domains WHERE shop_id = ? ORDER BY created_at, id
    `).all(before.id) as unknown as Array<{
      id: string;
      hostname: string;
      status: string;
      isPrimary: number;
      deletedAt: string | null;
    }>;
    const retired = domains.find((domain) => domain.id === oldDomain.id);
    const current = domains.find((domain) => domain.hostname === "rotate-target.staging.selinow.test");
    expect(retired).toMatchObject({ hostname: oldDomain.hostname, status: "deleted", isPrimary: 0 });
    expect(retired?.deletedAt).toEqual(expect.any(String));
    expect(current).toMatchObject({ status: "active", isPrimary: 1, deletedAt: null });
    expect(after.canonicalDomainId).toBe(current?.id);
  });

  it("rolls back the tombstone and slug update when the replacement hostname conflicts", async () => {
    const shop = await createOwnedShop({ idempotencyKey: "profile-domain-rollback-a", slug: "rollback-source", userId: "user-a" });
    const otherShop = await createOwnedShop({ idempotencyKey: "profile-domain-rollback-b", slug: "rollback-other", userId: "user-b" });
    const before = shopRow(shop.shop.publicId);
    const oldDomain = database.prepare(`
      SELECT id, hostname_normalized AS hostname, status, is_primary AS isPrimary, deleted_at AS deletedAt
      FROM shop_domains WHERE shop_id = ? AND type = 'platform_subdomain' AND deleted_at IS NULL
      ORDER BY is_primary DESC, created_at ASC, id ASC LIMIT 1
    `).get(before.id) as { id: string; hostname: string; status: string; isPrimary: number; deletedAt: string | null };
    const otherShopId = shopRow(otherShop.shop.publicId).id;
    const injectedAt = "2026-08-24T00:00:00.000Z";
    database.prepare(`
      INSERT INTO shop_domains (
        id, shop_id, hostname_normalized, type, status, is_primary,
        validation_metadata_json, activated_at, created_at, updated_at
      ) VALUES ('domain-injected-conflict', ?, 'rollback-target.staging.selinow.test', 'platform_subdomain', 'active', 0, '{}', ?, ?, ?)
    `).run(otherShopId, injectedAt, injectedAt, injectedAt);

    await expect(updateShopProfile({
      env,
      requestId: "request-rollback-slug",
      shopPublicId: shop.shop.publicId,
      slug: "rollback-target",
      userId: "user-a",
    })).rejects.toThrow();

    expect(shopRow(shop.shop.publicId)).toEqual(before);
    expect(database.prepare(`
      SELECT id, hostname_normalized AS hostname, status, is_primary AS isPrimary, deleted_at AS deletedAt
      FROM shop_domains WHERE id = ?
    `).get(oldDomain.id)).toEqual(oldDomain);
    expect(database.prepare("SELECT COUNT(*) AS count FROM shop_domains WHERE shop_id = ? AND hostname_normalized = ?")
      .get(before.id, "rollback-target.staging.selinow.test")).toEqual({ count: 0 });
  });
});
