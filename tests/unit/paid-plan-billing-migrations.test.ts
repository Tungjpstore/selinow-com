import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const NOW = "2026-08-03T00:00:00.000Z";

function applyMigrations(database: DatabaseSync): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function insertShopFixture(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO platform_users (
      id, email_normalized, display_name, status, created_at, updated_at
    ) VALUES ('user-billing-a', 'billing-a@example.test', 'Billing A', 'active', '${NOW}', '${NOW}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, merchant_country_code, business_country_code,
      created_at, updated_at
    ) VALUES (
      'shop-billing-a', 'shop-billing-public-a', 'billing-a', 'Billing A',
      'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, 'VN', 'VN', '${NOW}', '${NOW}'
    );
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('shop-billing-a', 'user-billing-a', 'owner', 'active', '${NOW}', '${NOW}');
  `);
}

describe("paid pricing and billing migrations", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
  });

  afterEach(() => {
    database.close();
  });

  it("publishes only starter/pro offers with approved market prices", () => {
    const plans = database.prepare(`
      SELECT code, is_public AS isPublic, is_assignable AS isAssignable
      FROM plans
      WHERE is_public = 1 OR is_assignable = 1
      ORDER BY code
    `).all();
    expect(plans).toEqual([
      { code: "pro", isPublic: 1, isAssignable: 1 },
      { code: "starter", isPublic: 1, isAssignable: 1 },
    ]);

    expect(database.prepare(`
      SELECT plans.code, prices.market_code AS marketCode, prices.currency,
        prices.amount_minor AS amountMinor, prices.provider_code AS providerCode
      FROM plan_prices AS prices
      INNER JOIN plans ON plans.id = prices.plan_id
      WHERE prices.is_active = 1
      ORDER BY plans.code, prices.market_code
    `).all()).toEqual([
      { code: "pro", marketCode: "global", currency: "USD", amountMinor: 1500, providerCode: "dodo" },
      { code: "pro", marketCode: "vn", currency: "VND", amountMinor: 299000, providerCode: "dodo" },
      { code: "starter", marketCode: "global", currency: "USD", amountMinor: 500, providerCode: "dodo" },
      { code: "starter", marketCode: "vn", currency: "VND", amountMinor: 99000, providerCode: "dodo" },
    ]);
    expect(database.prepare("SELECT value_json FROM platform_settings WHERE key = 'default_trial_days'").get())
      .toEqual({ value_json: '{"value":7}' });
    expect(database.prepare("SELECT value_json FROM platform_settings WHERE key = 'subscription_grace_days'").get())
      .toEqual({ value_json: '{"value":3}' });
  });

  it("rebinds every billing provider constraint to Dodo without legacy Paddle markers", () => {
    for (const table of [
      "plan_prices",
      "shop_subscriptions",
      "billing_accounts",
      "billing_checkout_sessions",
      "billing_invoices",
      "billing_provider_events",
    ]) {
      const schema = database.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table) as { sql: string };
      expect(schema.sql).not.toContain("'paddle'");
      expect(schema.sql).toContain("'dodo'");
    }

    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM plan_prices WHERE provider_code = 'paddle'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM billing_provider_events WHERE provider_code = 'paddle'",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM plan_prices WHERE provider_price_ref LIKE 'pending:dodo:%'",
    ).get()).toEqual({ count: 4 });
  });

  it("preserves legacy rows while enforcing explicit seven-day trial expiry", () => {
    insertShopFixture(database);
    database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at
      ) VALUES (?, ?, 'plan_starter_v1', 'pending_payment', NULL, ?, ?)
    `).run("sub-billing-pending", "shop-billing-a", NOW, NOW);
    database.prepare(`
      UPDATE shop_subscriptions
      SET state = 'trialing', trial_ends_at = '2999-01-01T00:00:00.000Z',
        version = 2, updated_at = ?
      WHERE id = 'sub-billing-pending'
    `).run(NOW);

    database.prepare(`
      UPDATE shop_subscriptions
      SET state = 'canceled', canceled_at = ?, version = 3, updated_at = ?
      WHERE id = 'sub-billing-pending'
    `).run(NOW, NOW);
    expect(() => database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, trial_ends_at, created_at, updated_at
      ) VALUES (?, ?, 'plan_starter_v1', 'trialing', '2000-01-01T00:00:00.000Z', ?, ?)
    `).run("sub-billing-expired", "shop-billing-a", NOW, NOW)).toThrow(/trial_subscription_expired/u);

    expect(database.prepare(`
      SELECT state, trial_ends_at AS trialEndsAt
      FROM shop_subscriptions WHERE id = 'sub-billing-pending'
    `).get()).toEqual({ state: "canceled", trialEndsAt: "2999-01-01T00:00:00.000Z" });
  });

  it("keeps billing webhook references and subscription transitions tenant-scoped", () => {
    insertShopFixture(database);
    database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, created_at, updated_at
      ) VALUES ('sub-billing-active', 'shop-billing-a', 'plan_starter_v1', 'active', ?, ?)
    `).run(NOW, NOW);

    database.prepare(`
      INSERT INTO billing_provider_events (
        id, provider_code, provider_event_id, payload_hash, shop_id,
        event_type, status, occurred_at, created_at
      ) VALUES ('billing-event-a', 'dodo', 'evt_1', ?, 'shop-billing-a',
        'subscription.updated', 'received', ?, ?)
    `).run("a".repeat(64), NOW, NOW);
    database.prepare(`
      UPDATE billing_provider_events
      SET status = 'processed', processed_at = ?
      WHERE id = 'billing-event-a'
    `).run(NOW);
    expect(() => database.prepare(`
      UPDATE billing_provider_events
      SET provider_event_id = 'evt_tampered'
      WHERE id = 'billing-event-a'
    `).run()).toThrow(/billing_provider_event_identity_immutable/u);

    database.prepare(`
      INSERT INTO subscription_events (
        id, shop_id, subscription_id, provider_event_id, source_kind,
        event_type, from_state, to_state, event_hash, occurred_at, created_at
      ) VALUES ('sub-event-a', 'shop-billing-a', 'sub-billing-active',
        'billing-event-a', 'provider', 'subscription.activated',
        'pending_payment', 'active', ?, ?, ?)
    `).run("b".repeat(64), NOW, NOW);
    expect(() => database.prepare(`
      INSERT INTO subscription_events (
        id, shop_id, subscription_id, source_kind, event_type,
        to_state, event_hash, occurred_at, created_at
      ) VALUES ('sub-event-wrong-tenant', 'shop-billing-a', 'missing-sub',
        'system', 'subscription.activated', 'active', ?, ?, ?)
    `).run("c".repeat(64), NOW, NOW)).toThrow(/FOREIGN KEY/u);
  });

  it("repairs subscription ledger foreign keys to canonical billing tables", () => {
    const expectedParents: Record<string, string[]> = {
      subscription_change_requests: ["shop_subscriptions"],
      subscription_events: ["billing_provider_events", "shop_subscriptions"],
      usage_events: ["shop_subscriptions"],
    };
    for (const [table, expected] of Object.entries(expectedParents)) {
      const parents = database.prepare(`PRAGMA foreign_key_list(${table})`).all()
        .map((row) => (row as { table: string }).table)
        .filter((value, index, values) => values.indexOf(value) === index)
        .sort();
      expect(parents).toEqual(expect.arrayContaining(expected));
      expect(parents.some((parent) => parent.includes("legacy_0076") || parent.includes("repair_0110"))).toBe(false);
    }
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE name LIKE '%legacy_0110' OR name LIKE '%repair_0110'
    `).all()).toEqual([]);
  });

  it("repairs the legacy 0076 foreign-key metadata shape without losing ledger rows", () => {
    const broken = new DatabaseSync(":memory:");
    try {
      broken.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE shops (id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE plans (id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE platform_users (id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE shop_members (
          shop_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL
        ) STRICT;
        CREATE TABLE plan_prices (
          id TEXT PRIMARY KEY,
          plan_id TEXT NOT NULL,
          provider_code TEXT NOT NULL,
          market_code TEXT NOT NULL,
          currency TEXT NOT NULL,
          interval TEXT NOT NULL
        ) STRICT;
        CREATE TABLE shop_subscriptions (
          id TEXT PRIMARY KEY,
          shop_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          billing_provider_code TEXT,
          market_code TEXT,
          price_currency TEXT,
          scheduled_plan_id TEXT,
          scheduled_price_id TEXT,
          scheduled_effective_at TEXT,
          scheduled_change_request_id TEXT,
          UNIQUE (shop_id, id)
        ) STRICT;
        CREATE TABLE billing_provider_events (
          id TEXT PRIMARY KEY,
          shop_id TEXT
        ) STRICT;
        CREATE TABLE subscription_change_requests (
          id TEXT PRIMARY KEY NOT NULL,
          public_id TEXT NOT NULL UNIQUE,
          shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
          subscription_id TEXT NOT NULL,
          current_plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
          requested_plan_id TEXT REFERENCES plans(id) ON DELETE RESTRICT,
          action TEXT NOT NULL,
          status TEXT NOT NULL,
          expected_subscription_version INTEGER NOT NULL,
          reason_code TEXT NOT NULL,
          requested_by_user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
          reviewed_by_user_id TEXT REFERENCES platform_users(id) ON DELETE SET NULL,
          reviewed_at TEXT,
          completed_at TEXT,
          idempotency_key_hash TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          provider_action_ref TEXT,
          provider_event_id TEXT,
          failure_code TEXT,
          execution_attempts INTEGER NOT NULL DEFAULT 0,
          last_attempt_at TEXT,
          provider_acknowledged_at TEXT,
          reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
          next_reconciliation_at TEXT,
          last_reconciliation_at TEXT,
          reconciliation_failure_code TEXT,
          UNIQUE (shop_id, id),
          UNIQUE (shop_id, idempotency_key_hash),
          FOREIGN KEY (shop_id, subscription_id)
            REFERENCES shop_subscriptions_legacy_0076(shop_id, id) ON DELETE RESTRICT
        ) STRICT;
        CREATE TABLE subscription_events (
          id TEXT PRIMARY KEY NOT NULL,
          shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE RESTRICT,
          subscription_id TEXT NOT NULL,
          provider_event_id TEXT REFERENCES billing_provider_events_legacy_0076(id) ON DELETE RESTRICT,
          source_kind TEXT NOT NULL,
          event_type TEXT NOT NULL,
          from_state TEXT,
          to_state TEXT NOT NULL,
          event_hash TEXT NOT NULL,
          safe_metadata_json TEXT NOT NULL DEFAULT '{}',
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (shop_id, id),
          UNIQUE (shop_id, subscription_id, event_hash),
          FOREIGN KEY (shop_id, subscription_id)
            REFERENCES shop_subscriptions_legacy_0076(shop_id, id) ON DELETE RESTRICT
        ) STRICT;
        CREATE TABLE usage_events (
          id TEXT PRIMARY KEY NOT NULL,
          shop_id TEXT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
          subscription_id TEXT,
          metric TEXT NOT NULL,
          period_kind TEXT NOT NULL,
          period_key TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          delta INTEGER NOT NULL,
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (shop_id, metric, period_key, source_kind, source_id),
          FOREIGN KEY (shop_id, subscription_id)
            REFERENCES shop_subscriptions_legacy_0076(shop_id, id) ON DELETE RESTRICT
        ) STRICT;

        INSERT INTO shops VALUES ('shop-repair');
        INSERT INTO plans VALUES ('plan_pro_v1');
        INSERT INTO platform_users VALUES ('user-repair');
        INSERT INTO shop_members VALUES ('shop-repair', 'user-repair', 'active');
        INSERT INTO plan_prices VALUES ('price_pro_v1', 'plan_pro_v1', 'dodo', 'vn', 'VND', 'month');
        INSERT INTO shop_subscriptions VALUES (
          'sub-repair', 'shop-repair', 'plan_pro_v1', 1, 'dodo', 'vn', 'VND',
          NULL, NULL, NULL, NULL
        );
        INSERT INTO billing_provider_events VALUES ('provider-event-repair', 'shop-repair');
        INSERT INTO subscription_change_requests (
          id, public_id, shop_id, subscription_id, current_plan_id, requested_plan_id,
          action, status, expected_subscription_version, reason_code,
          requested_by_user_id, reviewed_by_user_id, reviewed_at, completed_at,
          idempotency_key_hash, request_hash, version, created_at, updated_at
        ) VALUES (
          'request-repair', 'request-public-repair', 'shop-repair', 'sub-repair',
          'plan_pro_v1', NULL, 'cancel', 'requested', 1, 'seller_requested',
          'user-repair', NULL, NULL, NULL, 'key-repair', 'hash-repair', 1, '${NOW}', '${NOW}'
        );
        INSERT INTO subscription_events VALUES (
          'event-repair', 'shop-repair', 'sub-repair', 'provider-event-repair',
          'provider', 'payment.succeeded', 'pending_payment', 'active',
          '${"e".repeat(64)}', '{}', '${NOW}', '${NOW}'
        );
        INSERT INTO usage_events VALUES (
          'usage-repair', 'shop-repair', 'sub-repair', 'orders.created', 'billing',
          '2026-08', 'order', 'order-repair', 1, '${NOW}', '${NOW}'
        );
        PRAGMA foreign_keys = ON;
      `);

      expect(() => broken.prepare(`
        EXPLAIN INSERT INTO subscription_events (
          id, shop_id, subscription_id, provider_event_id, source_kind, event_type,
          from_state, to_state, event_hash, safe_metadata_json, occurred_at, created_at
        ) VALUES (
          'event-before-repair', 'shop-repair', 'sub-repair', 'provider-event-repair',
          'provider', 'payment.succeeded', 'pending_payment', 'active',
          '${"f".repeat(64)}', '{}', '${NOW}', '${NOW}'
        )
      `)).toThrow(/legacy_0076/u);

      broken.exec(readFileSync(join(process.cwd(), "migrations/0110_repair_subscription_ledger_foreign_keys.sql"), "utf8"));

      expect(broken.prepare("SELECT COUNT(*) AS count FROM subscription_change_requests").get()).toEqual({ count: 1 });
      expect(broken.prepare("SELECT COUNT(*) AS count FROM subscription_events").get()).toEqual({ count: 1 });
      expect(broken.prepare("SELECT COUNT(*) AS count FROM usage_events").get()).toEqual({ count: 1 });
      expect(broken.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() => broken.prepare(`
        EXPLAIN INSERT INTO subscription_events (
          id, shop_id, subscription_id, provider_event_id, source_kind, event_type,
          from_state, to_state, event_hash, safe_metadata_json, occurred_at, created_at
        ) VALUES (
          'event-after-repair', 'shop-repair', 'sub-repair', 'provider-event-repair',
          'provider', 'payment.succeeded', 'pending_payment', 'active',
          '${"f".repeat(64)}', '{}', '${NOW}', '${NOW}'
        )
      `)).not.toThrow();
    } finally {
      broken.close();
    }
  });

  it("enforces Dodo reference uniqueness and billing write-scope guards", () => {
    insertShopFixture(database);
    database.exec(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency, timezone,
        readiness_version, merchant_country_code, business_country_code,
        created_at, updated_at
      ) VALUES ('shop-billing-b', 'shop-billing-public-b', 'billing-b', 'Billing B',
        'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, 'VN', 'VN', '${NOW}', '${NOW}');
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, billing_provider_code,
        provider_subscription_ref, created_at, updated_at
      ) VALUES ('sub-billing-a', 'shop-billing-a', 'plan_starter_v1', 'active', 'dodo', 'sub_duplicate', '${NOW}', '${NOW}');
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, billing_provider_code,
        provider_subscription_ref, created_at, updated_at
      ) VALUES ('sub-billing-b', 'shop-billing-b', 'plan_starter_v1', 'active', 'dodo', 'sub_unique', '${NOW}', '${NOW}');
    `);
    expect(() => database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, billing_provider_code,
        provider_subscription_ref, created_at, updated_at
      ) VALUES ('sub-billing-c', 'shop-billing-b', 'plan_starter_v1', 'canceled', 'dodo', 'sub_duplicate', '${NOW}', '${NOW}')
    `).run()).toThrow(/UNIQUE/u);
    expect(() => database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, provider_subscription_ref, created_at, updated_at
      ) VALUES ('sub-billing-null-provider', 'shop-billing-b', 'plan_starter_v1', 'canceled', 'sub_null_provider', '${NOW}', '${NOW}')
    `).run()).toThrow(/subscription_provider_scope_mismatch/u);

    expect(() => database.prepare(`
      INSERT INTO billing_provider_events (
        id, provider_code, provider_event_id, payload_hash, shop_id, subscription_id,
        event_type, status, occurred_at, created_at
      ) VALUES ('billing-event-scope', 'dodo', 'evt_scope', ?, 'shop-billing-a', 'sub-billing-b',
        'subscription.updated', 'received', ?, ?)
    `).run("d".repeat(64), NOW, NOW)).toThrow(/billing_provider_event_subscription_scope_mismatch/u);

    expect(() => database.prepare(`
      INSERT INTO billing_checkout_sessions (
        id, public_id, shop_id, subscription_id, plan_id, price_id, provider_code,
        status, idempotency_key_hash, request_hash, created_at, updated_at
      ) VALUES ('checkout-scope', 'checkout-scope', 'shop-billing-a', 'sub-billing-a',
        'plan_pro_v1', 'price_starter_vn_v1', 'dodo', 'pending', 'scope-key', 'scope-hash', '${NOW}', '${NOW}')
    `).run()).toThrow(/billing_checkout_scope_mismatch/u);
  });

  it("enforces enum-only activation projections and initializes the backfill cursor", () => {
    insertShopFixture(database);
    expect(database.prepare("SELECT last_shop_id AS lastShopId FROM activation_backfill_checkpoints WHERE id = 'global'").get()).toEqual({ lastShopId: null });
    expect(() => database.prepare(`
      INSERT INTO activation_milestones (
        id, shop_id, milestone_code, source_kind, reason_code,
        idempotency_key_hash, payload_hash, projection_json, occurred_at, created_at
      ) VALUES ('activation-invalid', 'shop-billing-a', 'setup_started', 'onboarding', 'started',
        ?, ?, '{"channel":true}', ?, ?)
    `).run("a".repeat(64), "b".repeat(64), NOW, NOW)).toThrow(/activation_projection_invalid/u);
  });

  it("deduplicates immutable usage events and separates trial/billing periods", () => {
    insertShopFixture(database);
    database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, created_at, updated_at
      ) VALUES ('sub-usage-a', 'shop-billing-a', 'plan_starter_v1', 'active', ?, ?)
    `).run(NOW, NOW);

    const insert = database.prepare(`
      INSERT INTO usage_events (
        id, shop_id, subscription_id, metric, period_kind, period_key,
        source_kind, source_id, delta, occurred_at, created_at
      ) VALUES (?, 'shop-billing-a', 'sub-usage-a', 'orders_created', ?, ?,
        'order', ?, 1, ?, ?)
    `);
    insert.run("usage-trial", "trial", "trial:sub-usage-a:2026-08-03", "order-1", NOW, NOW);
    insert.run("usage-paid", "billing", "billing:sub-usage-a:2026-08-03", "order-1", NOW, NOW);
    expect(() => insert.run("usage-duplicate", "billing", "billing:sub-usage-a:2026-08-03", "order-1", NOW, NOW))
      .toThrow(/UNIQUE/u);
    expect(() => database.prepare("DELETE FROM usage_events WHERE id = 'usage-trial'").run())
      .toThrow(/usage_event_immutable/u);
    expect(database.prepare(`
      SELECT period_kind AS periodKind, COUNT(*) AS count
      FROM usage_events GROUP BY period_kind ORDER BY period_kind
    `).all()).toEqual([
      { periodKind: "billing", count: 1 },
      { periodKind: "trial", count: 1 },
    ]);
  });
});
