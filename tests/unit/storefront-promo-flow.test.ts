import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { applyWebsiteCartMutation } from "../../src/lib/commerce/cart-mutation";
import type { AppBindings } from "../../src/lib/platform/bindings";

/** EX3.4a/EX4.1 — discount.apply/remove on the anonymous website cart. */

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
const NOW = "2026-08-22T00:00:00.000Z";
const SECRET = "test-identifier-secret";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(): { database: DatabaseSync; env: AppBindings; cartId: string; cartToken: string } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(readFileSync("seeds/0001_platform_defaults.sql", "utf8"));
  database.prepare("INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at) VALUES ('user-a', 'a@example.test', 'Owner A', 'active', ?, ?)").run(NOW, NOW);
  database.prepare(`
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-a', 'public-a', 'seller-a', 'Shop A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
  `).run(NOW, NOW);
  database.prepare("INSERT INTO shop_settings (shop_id, branding_json, storefront_json, version, updated_at) VALUES ('shop-a', '{}', '{}', 1, ?)").run(NOW);

  const cartId = "cart_11111111-1111-4111-8111-111111111111";
  const cartToken = "cart-token-1234567890123456789012";
  const subjectHash = hmacTokenSync(`cart:shop-a`, cartToken);
  database.prepare(`
    INSERT INTO carts (id, shop_id, channel, subject_hash, locale, state, expires_at, created_at, updated_at)
    VALUES (?, 'shop-a', 'web', ?, 'vi', 'active', '2099-01-01T00:00:00.000Z', ?, ?)
  `).run(cartId, subjectHash, NOW, NOW);
  database.prepare(`
    INSERT INTO discounts (id, shop_id, code_normalized, type, value, currency, minimum_minor, starts_at, ends_at, status, created_at, updated_at)
    VALUES ('dsc_11111111-1111-4111-8111-111111111111', 'shop-a', 'BUSTLE10', 'percentage', 10, 'VND', 0, NULL, '2099-01-01T00:00:00.000Z', 'active', ?, ?)
  `).run(NOW, NOW);

  const env = {
    IDENTIFIER_HMAC_SECRET: SECRET,
    PLATFORM_DB: new SqliteD1(database) as unknown as D1Database,
  } as unknown as AppBindings;
  return { cartId, cartToken, database, env };
}

/** Synchronous stand-in for the async hmacToken to keep seeding linear. */
function hmacTokenSync(purpose: string, value: string): string {
  return createHmac("sha256", SECRET).update(`${purpose}\0${value}`).digest("base64url");
}

function appliedCode(database: DatabaseSync, cartId: string): string | null {
  const row = database.prepare("SELECT discount_code_normalized AS code FROM carts WHERE id = ?").get(cartId) as { code: string | null } | undefined;
  return row?.code ?? null;
}

describe("website cart discount mutations (EX3.4a)", () => {
  it("applies then removes a promo code on the anonymous cart", async () => {
    const { cartId, cartToken, database, env } = setup();
    const applied = await applyWebsiteCartMutation({
      cartId,
      cartToken,
      env,
      idempotencyKey: "promo-key-apply-0000000001",
      mutation: { code: "BUSTLE10", kind: "discount.apply" },
      shop: { currency: "VND", id: "shop-a" },
    });
    expect(applied.replayed).toBe(false);
    expect(appliedCode(database, cartId)).toBe("BUSTLE10");

    const removed = await applyWebsiteCartMutation({
      cartId,
      cartToken,
      env,
      idempotencyKey: "promo-key-remove-0000000001",
      mutation: { kind: "discount.remove" },
      shop: { currency: "VND", id: "shop-a" },
    });
    expect(removed.replayed).toBe(false);
    expect(appliedCode(database, cartId)).toBeNull();
  });

  it("treats removing an absent code as a clean no-op", async () => {
    const { cartId, cartToken, database, env } = setup();
    const removed = await applyWebsiteCartMutation({
      cartId,
      cartToken,
      env,
      idempotencyKey: "promo-key-noop-0000000001",
      mutation: { kind: "discount.remove" },
      shop: { currency: "VND", id: "shop-a" },
    });
    expect(removed).toMatchObject({ cartId, replayed: false });
    expect(appliedCode(database, cartId)).toBeNull();
  });

  it("still rejects an invalid code with discount_invalid", async () => {
    const { cartId, cartToken, env } = setup();
    await expect(applyWebsiteCartMutation({
      cartId,
      cartToken,
      env,
      idempotencyKey: "promo-key-bad-00000000001",
      mutation: { code: "NOPE123", kind: "discount.apply" },
      shop: { currency: "VND", id: "shop-a" },
    })).rejects.toMatchObject({ code: "discount_invalid" });
  });
});

describe("checkout promo surface render contract (EX4.1)", () => {
  it("ships the promo field, applied chip, and discount row wired to quote re-render", () => {
    const page = readFileSync("src/pages/checkout.astro", "utf8");
    expect(page).toContain("data-promo-input");
    expect(page).toContain("data-promo-apply");
    expect(page).toContain("data-promo-remove");
    expect(page).toContain('id="discount-row"');
    const script = readFileSync("src/scripts/storefront/checkout.ts", "utf8");
    expect(script).toContain("runPromoMutation");
    expect(script).toContain("renderPromo(quote)");
    expect(script).toContain("renderPromo(intent.quote)");
    expect(script).toContain("discount_invalid");
    expect(script).toContain("selinow-promo-draft");
    const voucher = readFileSync("src/scripts/storefront/voucher-copy.ts", "utf8");
    expect(voucher).toContain("selinow-promo-draft");
    const css = readFileSync("src/styles/storefront/sections.css", "utf8");
    expect(css).toContain(".promo-chip");
  });
});
