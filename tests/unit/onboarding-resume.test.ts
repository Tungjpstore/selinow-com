import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { getOnboardingResume } from "../../src/lib/onboarding/resume";
import { createShop } from "../../src/lib/tenants/store";

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
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
  return new SqliteD1(database);
}

function appEnv(database: SqliteD1): AppBindings {
  return {
    DEFAULT_CURRENCY: "VND",
    DEFAULT_LOCALE: "vi",
    DEFAULT_TIMEZONE: "Asia/Ho_Chi_Minh",
    IDENTIFIER_HMAC_SECRET: "unit-test-identifier-secret",
    PLATFORM_BASE_DOMAIN: "selinow.com",
    PLATFORM_DB: database as unknown as D1Database,
    SESSION_SECRET: "unit-test-session-secret",
  } as unknown as AppBindings;
}

function seedUser(database: DatabaseSync, userId: string): void {
  const now = "2026-08-16T00:00:00.000Z";
  database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
    .run(userId, `${userId}@example.test`, "Owner", now, now);
}

async function provisionShop(database: SqliteD1, userId: string, slug: string): Promise<string> {
  const result = await createShop({
    channels: { customDomainPreference: "later", telegramEnabled: true, websiteEnabled: true },
    currency: "VND",
    defaultLocale: "vi",
    env: appEnv(database),
    idempotencyKey: `resume-unit-${slug}`,
    name: `Shop ${slug}`,
    planCode: "starter",
    requesterAddress: "203.0.113.20",
    requestId: "request-resume",
    slug,
    templateId: "aurora",
    userId,
    vertical: "physical",
  });
  if (!result.created) throw new Error("shop_creation_replayed");
  return result.shop.publicId;
}

describe("onboarding wizard resume (OB-B4)", () => {
  it("resumes a freshly created shop at the product step with server truth", async () => {
    const database = createDatabase();
    seedUser(database.database, "user-r1");
    const publicId = await provisionShop(database, "user-r1", "resume-fresh");
    const resume = await getOnboardingResume({ env: appEnv(database), shopPublicId: publicId, userId: "user-r1" });

    expect(resume).not.toBeNull();
    expect(resume?.wizardStep).toBe("product");
    expect(resume?.shop.vertical).toBe("physical");
    expect(resume?.shop.templateId).toBe("aurora");
    expect(resume?.shop.slug).toBe("resume-fresh");
    expect(resume?.storefrontVersion).toBe(1);
    expect(resume?.channels).toEqual({ telegramEnabled: true, websiteEnabled: true });
    expect(resume?.catalog.hasProducts).toBe(false);
    expect(resume?.catalog.hasStock).toBe(false);
    expect(resume?.integrations.payosReady).toBe(false);
    expect(resume?.integrations.telegramReady).toBe(false);
  });

  it("holds a stocked shop at connect until PayOS is verified", async () => {
    const database = createDatabase();
    seedUser(database.database, "user-r2");
    const publicId = await provisionShop(database, "user-r2", "resume-stocked");
    const shopId = (database.database.prepare("SELECT id FROM shops WHERE slug = 'resume-stocked'").get() as { id: string }).id;
    const now = "2026-08-16T00:00:00.000Z";
    // Seed one manual-fulfilment product: stock requirement satisfied without keys.
    database.database.prepare(`
      INSERT INTO products (id, shop_id, slug, title, status, fulfillment_type, version, created_at, updated_at)
      VALUES ('prd-manual', ?, 'ao-thun', 'Áo Thun', 'active', 'manual', 1, ?, ?)
    `).run(shopId, now, now);
    database.database.prepare(`
      INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
      VALUES ('var-manual', ?, 'prd-manual', 'TEE-001', 'Mặc định', '{}', 250000, 'VND', 1, 10, 'active', 1, ?, ?)
    `).run(shopId, now, now);

    const resume = await getOnboardingResume({ env: appEnv(database), shopPublicId: publicId, userId: "user-r2" });
    expect(resume?.catalog.hasProducts).toBe(true);
    expect(resume?.catalog.hasStock).toBe(true);
    expect(resume?.catalog.hasManualProduct).toBe(true);
    expect(resume?.catalog.firstVariantId).toBe("var-manual");
    // Catalog + stock are ready; the resume must not skip past connections
    // while PayOS (and the enabled Telegram channel) are still unverified.
    expect(resume?.wizardStep).toBe("connect");
  });

  it("returns null for non-members so foreign shops never hydrate a wizard", async () => {
    const database = createDatabase();
    seedUser(database.database, "user-r3");
    seedUser(database.database, "user-outsider");
    const publicId = await provisionShop(database, "user-r3", "resume-private");
    const resume = await getOnboardingResume({ env: appEnv(database), shopPublicId: publicId, userId: "user-outsider" });
    expect(resume).toBeNull();
  });
});
