import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-08-09T00:00:00.000Z";
const TRIAL_END = "2099-08-16T00:00:00.000Z";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(maximumVersion = Number.POSITIVE_INFINITY): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= maximumVersion)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  return database;
}

function seedTenant(database: DatabaseSync, input: { shopId: string; suffix: string; userId: string }): void {
  database.prepare(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(input.userId, `${input.suffix}@example.test`, `Owner ${input.suffix}`, NOW, NOW);
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 'en', 'USD', 'UTC', 1, ?, ?)
  `).run(input.shopId, `shop_public_${input.suffix}`, `shop-${input.suffix}`, `Shop ${input.suffix}`, NOW, NOW);
  database.prepare(`
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES (?, ?, 'owner', 'active', ?, ?)
  `).run(input.shopId, input.userId, NOW, NOW);
}

function seedOrder(database: DatabaseSync, input: { orderId: string; shopId: string; suffix: string }): void {
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor, total_minor,
      currency, locale, customer_email_masked, checkout_subject_hash, order_token_hash,
      expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, 'web', 'pending_payment', 'unpaid', 'reserved',
      1000, 0, 1000, 'USD', 'en', NULL, ?, ?, ?, ?, ?)
  `).run(
    input.orderId,
    `order_public_${input.suffix}`,
    input.shopId,
    `SO-${input.suffix}`,
    `subject-${input.suffix}`,
    `token-${input.suffix}`,
    TRIAL_END,
    NOW,
    NOW,
  );
}

function insertRecovery(database: DatabaseSync, input: { capabilityId: string; orderId: string; shopId: string }): void {
  database.prepare(`
    INSERT INTO checkout_recovery_capabilities (
      id, shop_id, cart_id, checkout_subject_hash, request_hash, issued_at,
      expires_at, consumed_at, consumed_order_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.capabilityId,
    input.shopId,
    `cart-${input.capabilityId}`,
    `subject-${input.capabilityId}`,
    `request-${input.capabilityId}`,
    NOW,
    TRIAL_END,
    NOW,
    input.orderId,
    NOW,
  );
}

describe("migration 0087 integrity hardening", () => {
  it("installs the post-migration privacy, recovery and trial guard contracts", () => {
    const database = createDatabase();
    const expectedTriggers = [
      "checkout_recovery_capabilities_tenant_order_guard",
      "checkout_recovery_capabilities_tenant_order_insert_guard",
      "shop_customers_anonymized_insert_guard",
      "shop_customers_anonymized_update_guard",
      "shop_subscriptions_trial_claim_insert_guard",
      "shop_subscriptions_trial_claim_update_guard",
    ];
    const triggers = database.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${expectedTriggers.map(() => "?").join(", ")})
      ORDER BY name
    `).all(...expectedTriggers) as Array<{ name: string; sql: string }>;

    expect(triggers.map((trigger) => trigger.name)).toEqual([...expectedTriggers].sort());
    expect(triggers.find((trigger) => trigger.name === "checkout_recovery_capabilities_tenant_order_guard")?.sql)
      .toContain("UPDATE OF shop_id, consumed_order_id");
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("keeps anonymized customer identity and blocked status immutable at the database boundary", () => {
    const database = createDatabase();
    seedTenant(database, { shopId: "privacy-shop", suffix: "privacy", userId: "privacy-user" });
    database.prepare(`
      INSERT INTO shop_customers (
        id, shop_id, email_normalized, display_name, locale, status,
        created_at, updated_at, anonymized_at
      ) VALUES ('privacy-customer', 'privacy-shop', NULL, NULL, 'en', 'blocked', ?, ?, ?)
    `).run(NOW, NOW, NOW);

    expect(() => database.prepare(`
      UPDATE shop_customers
      SET email_normalized = 'restored@example.test', display_name = 'Restored Buyer',
        status = 'active', anonymized_at = NULL, updated_at = ?, version = version + 1
      WHERE shop_id = 'privacy-shop' AND id = 'privacy-customer'
    `).run(NOW)).toThrow(/customer_anonymized_immutable/u);
    expect(database.prepare(`
      SELECT email_normalized AS email, display_name AS displayName, status, anonymized_at AS anonymizedAt
      FROM shop_customers WHERE shop_id = 'privacy-shop' AND id = 'privacy-customer'
    `).get()).toEqual({ anonymizedAt: NOW, displayName: null, email: null, status: "blocked" });
  });

  it("rejects cross-tenant consumed orders on recovery inserts and shop-changing updates", () => {
    const database = createDatabase();
    seedTenant(database, { shopId: "recovery-shop-a", suffix: "recovery-a", userId: "recovery-user-a" });
    seedTenant(database, { shopId: "recovery-shop-b", suffix: "recovery-b", userId: "recovery-user-b" });
    seedOrder(database, { orderId: "recovery-order-b", shopId: "recovery-shop-b", suffix: "recovery-b" });

    expect(() => {
      insertRecovery(database, {
        capabilityId: "recovery-cross-insert",
        orderId: "recovery-order-b",
        shopId: "recovery-shop-a",
      });
    }).toThrow(/checkout_recovery_order_tenant_mismatch/u);

    insertRecovery(database, {
      capabilityId: "recovery-cross-update",
      orderId: "recovery-order-b",
      shopId: "recovery-shop-b",
    });
    expect(() => database.prepare(`
      UPDATE checkout_recovery_capabilities
      SET shop_id = 'recovery-shop-a'
      WHERE id = 'recovery-cross-update'
    `).run()).toThrow(/checkout_recovery_order_tenant_mismatch/u);
  });

  it("creates a durable account claim for an old-runtime trial insert", () => {
    const database = createDatabase();
    seedTenant(database, { shopId: "legacy-trial-shop", suffix: "legacy-trial", userId: "legacy-trial-user" });

    database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at
      ) VALUES ('legacy-trial-sub', 'legacy-trial-shop', 'plan_starter_v1', 'trialing', ?, ?, ?)
    `).run(TRIAL_END, NOW, NOW);

    expect(database.prepare(`
      SELECT user_id AS userId, shop_id AS shopId, claimed_at AS claimedAt
      FROM account_trial_claims WHERE shop_id = 'legacy-trial-shop'
    `).get()).toEqual({ claimedAt: NOW, shopId: "legacy-trial-shop", userId: "legacy-trial-user" });
  });

  it("creates a durable account claim when an existing subscription enters trialing", () => {
    const database = createDatabase();
    seedTenant(database, { shopId: "trial-update-shop", suffix: "trial-update", userId: "trial-update-user" });
    database.prepare(`
      INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at)
      VALUES ('trial-update-sub', 'trial-update-shop', 'plan_starter_v1', 'canceled', ?, ?)
    `).run(NOW, NOW);

    database.prepare(`
      UPDATE shop_subscriptions
      SET state = 'trialing', trial_ends_at = ?, updated_at = ?, version = version + 1
      WHERE id = 'trial-update-sub'
    `).run(TRIAL_END, NOW);

    expect(database.prepare(`
      SELECT user_id AS userId, shop_id AS shopId
      FROM account_trial_claims WHERE shop_id = 'trial-update-shop'
    `).get()).toEqual({ shopId: "trial-update-shop", userId: "trial-update-user" });
  });

  it("rejects unowned trials and a second trial for the same account", () => {
    const database = createDatabase();
    seedTenant(database, { shopId: "first-trial-shop", suffix: "first-trial", userId: "trial-user" });
    database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at
      ) VALUES ('first-trial-sub', 'first-trial-shop', 'plan_starter_v1', 'trialing', ?, ?, ?)
    `).run(TRIAL_END, NOW, NOW);

    database.prepare(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency, timezone,
        readiness_version, created_at, updated_at
      ) VALUES ('unowned-trial-shop', 'shop_public_unowned_trial', 'unowned-trial',
        'Unowned Trial', 'active', 'en', 'USD', 'UTC', 1, ?, ?)
    `).run(NOW, NOW);
    expect(() => database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at
      ) VALUES ('unowned-trial-sub', 'unowned-trial-shop', 'plan_starter_v1', 'trialing', ?, ?, ?)
    `).run(TRIAL_END, NOW, NOW)).toThrow(/trial_account_claim_required/u);

    database.prepare(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency, timezone,
        readiness_version, created_at, updated_at
      ) VALUES ('second-trial-shop', 'shop_public_second_trial', 'second-trial',
        'Second Trial', 'active', 'en', 'USD', 'UTC', 1, ?, ?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
      VALUES ('second-trial-shop', 'trial-user', 'owner', 'active', ?, ?)
    `).run(NOW, NOW);
    expect(() => database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at
      ) VALUES ('second-trial-sub', 'second-trial-shop', 'plan_starter_v1', 'trialing', ?, ?, ?)
    `).run(TRIAL_END, NOW, NOW)).toThrow(/trial_account_claim_required/u);
    expect(database.prepare("SELECT COUNT(*) AS count FROM account_trial_claims WHERE user_id = 'trial-user'").get())
      .toEqual({ count: 1 });
  });

  it("backfills a post-0082 legacy trial before enabling the guards", () => {
    const database = createDatabase(86);
    seedTenant(database, { shopId: "gap-trial-shop", suffix: "gap-trial", userId: "gap-trial-user" });
    database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at
      ) VALUES ('gap-trial-sub', 'gap-trial-shop', 'plan_starter_v1', 'trialing', ?, ?, ?)
    `).run(TRIAL_END, NOW, NOW);
    expect(database.prepare("SELECT COUNT(*) AS count FROM account_trial_claims WHERE shop_id = 'gap-trial-shop'").get())
      .toEqual({ count: 0 });

    database.exec(readFileSync(join(process.cwd(), "migrations/0087_integrity_hardening.sql"), "utf8"));

    expect(database.prepare(`
      SELECT user_id AS userId, shop_id AS shopId
      FROM account_trial_claims WHERE shop_id = 'gap-trial-shop'
    `).get()).toEqual({ shopId: "gap-trial-shop", userId: "gap-trial-user" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
