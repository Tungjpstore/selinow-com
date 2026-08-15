import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import {
  POST_MIGRATION_COLUMN_SQL,
  POST_MIGRATION_CROSS_LEDGER_SQL,
  POST_MIGRATION_FOREIGN_KEY_SQL,
  POST_MIGRATION_OBJECT_SQL,
  REQUIRED_POST_MIGRATION_COLUMNS,
  REQUIRED_POST_MIGRATION_OBJECTS,
  assertRemotePostMigrationContract,
  parsePostMigrationColumnOutput,
  parsePostMigrationCrossLedgerOutput,
  parsePostMigrationForeignKeyOutput,
  parsePostMigrationObjectOutput,
} from "../../scripts/lib/db-post-migration-contract.mjs";
import { findCompoundSelectLimitViolations } from "../helpers/d1-migration-guard";

function envelope(results: unknown[], success = true) {
  return JSON.stringify([{ success, results }]);
}

function completeObjects() {
  return Object.entries(REQUIRED_POST_MIGRATION_OBJECTS).flatMap(([type, names]) => (
    names.map((name) => ({ type, name }))
  ));
}

function completeColumns() {
  return Object.entries(REQUIRED_POST_MIGRATION_COLUMNS).flatMap(([table_name, columns]) => (
    columns.map((column_name) => ({ table_name, column_name }))
  ));
}

describe("remote post-migration database contract", () => {
  it("fails closed on malformed or unsuccessful D1 envelopes", () => {
    for (const parser of [
      parsePostMigrationForeignKeyOutput,
      parsePostMigrationObjectOutput,
      parsePostMigrationColumnOutput,
      parsePostMigrationCrossLedgerOutput,
    ]) {
      expect(() => parser("not-json")).toThrow(/invalid_json/u);
      expect(() => parser(envelope([], false))).toThrow(/invalid_result/u);
      expect(() => parser(JSON.stringify([{ success: true }]))).toThrow(/invalid_result/u);
    }
  });

  it("rejects foreign keys, missing objects, columns and cross-ledger mismatches", () => {
    expect(() => parsePostMigrationForeignKeyOutput(envelope([{ table: "orders", rowid: 1 }]))).toThrow(
      "post_migration_foreign_key_violation",
    );

    for (const type of ["table", "index", "trigger"] as const) {
      const rows = completeObjects().filter((row) => row.type !== type || row.name !== REQUIRED_POST_MIGRATION_OBJECTS[type][0]);
      expect(() => parsePostMigrationObjectOutput(envelope(rows))).toThrow(`post_migration_object_missing:${type}`);
    }

    const columns = completeColumns().slice(1);
    expect(() => parsePostMigrationColumnOutput(envelope(columns))).toThrow("post_migration_column_missing");
    expect(() => parsePostMigrationCrossLedgerOutput(envelope([{ mismatch_count: 2 }]))).toThrow(
      "post_migration_cross_ledger_mismatch",
    );
    expect(() => parsePostMigrationCrossLedgerOutput(envelope([{ mismatch_count: -1 }]))).toThrow(
      "post_migration_cross_ledger_contract_invalid_result",
    );
    expect(() => parsePostMigrationObjectOutput(envelope([
      ...completeObjects(),
      { name: "auth_request_admissions_legacy_0094", type: "table" },
    ]))).toThrow("post_migration_legacy_object_present:auth_request_admissions_legacy_0094");
  });

  it("pins every schema contract introduced through migration 0097", () => {
    const requiredObjects = [
      ["index", "idx_plan_prices_provider_ref"],
      ["trigger", "plan_prices_published_reference_guard"],
      ["trigger", "plans_public_assignable_insert_guard"],
      ["trigger", "plans_public_assignable_update_guard"],
      ["trigger", "shop_subscriptions_price_snapshot_presence_guard"],
      ["trigger", "shop_subscriptions_price_snapshot_presence_update_guard"],
      ["trigger", "shop_subscriptions_price_snapshot_scope_guard"],
      ["trigger", "shop_subscriptions_price_snapshot_scope_update_guard"],
      ["table", "account_trial_claims"],
      ["index", "idx_account_trial_claims_shop"],
      ["table", "auth_request_admissions"],
      ["index", "idx_auth_request_admissions_window"],
      ["index", "idx_auth_request_admissions_requester_window"],
      ["index", "idx_auth_request_admissions_expiry"],
      ["index", "idx_auth_request_admissions_subject_window"],
      ["table", "order_access_recovery_tokens"],
      ["index", "idx_order_access_recovery_tokens_active_order"],
      ["index", "idx_order_access_recovery_tokens_previous"],
      ["index", "idx_order_access_recovery_tokens_replacement"],
      ["index", "idx_order_access_recovery_tokens_retention"],
      ["index", "idx_order_access_recovery_tokens_shop_order"],
      ["index", "idx_order_access_recovery_tokens_shop_customer"],
      ["index", "idx_orders_shop_id_customer"],
      ["trigger", "order_access_recovery_tokens_consume_rotate_order"],
      ["trigger", "order_access_recovery_tokens_customer_anonymize"],
      ["trigger", "order_access_recovery_tokens_identity_immutable"],
      ["trigger", "order_access_recovery_tokens_redaction_guard"],
      ["trigger", "order_access_recovery_tokens_scope_insert_guard"],
      ["trigger", "order_access_recovery_tokens_terminal_immutable"],
      ["trigger", "shop_domains_identity_update_guard"],
      ["trigger", "shop_domains_turnstile_active_insert_guard"],
      ["trigger", "shop_domains_turnstile_active_update_guard"],
      ["trigger", "shops_turnstile_canonical_insert_guard"],
      ["trigger", "shops_turnstile_canonical_update_guard"],
      ["table", "telegram_updates"],
      ["index", "idx_telegram_actions_generation"],
      ["index", "idx_telegram_integrations_shop_generation"],
      ["index", "idx_telegram_updates_generation_processing"],
      ["index", "idx_telegram_updates_shop_received"],
      ["index", "idx_telegram_updates_status"],
      ["trigger", "outbox_jobs_quarantine_legacy_order_paid_insert"],
      ["trigger", "telegram_credentials_legacy_generation_busy_guard"],
      ["trigger", "telegram_integrations_generation_switch_required"],
      ["trigger", "telegram_integrations_generation_transition_guard"],
      ["trigger", "telegram_integrations_delivery_generation_busy_guard"],
      ["trigger", "telegram_integrations_legacy_generation_fence"],
      ["trigger", "telegram_actions_generation_insert_guard"],
      ["trigger", "telegram_actions_legacy_generation_attribute"],
      ["trigger", "telegram_updates_generation_claim_guard"],
      ["trigger", "telegram_updates_generation_insert_guard"],
      ["trigger", "telegram_updates_legacy_generation_attribute"],
    ] as const;
    for (const [type, name] of requiredObjects) {
      const rows = completeObjects().filter((row) => row.type !== type || row.name !== name);
      expect(() => parsePostMigrationObjectOutput(envelope(rows))).toThrow(
        `post_migration_object_missing:${type}:${name}`,
      );
    }

    const requiredColumns = [
      ["account_trial_claims", "user_id"],
      ["account_trial_claims", "shop_id"],
      ["account_trial_claims", "claimed_at"],
      ["auth_request_admissions", "id"],
      ["auth_request_admissions", "action"],
      ["auth_request_admissions", "requester_hash"],
      ["auth_request_admissions", "window_started_at"],
      ["auth_request_admissions", "window_ends_at"],
      ["auth_request_admissions", "created_at"],
      ["auth_request_admissions", "subject_hash"],
      ["auth_request_admissions", "delivery_permitted"],
      ["order_access_recovery_tokens", "replacement_order_token_hash"],
      ["order_access_recovery_tokens", "previous_order_token_hash"],
      ["order_access_recovery_tokens", "recipient_hash"],
      ["order_access_recovery_tokens", "redacted_at"],
      ["order_access_recovery_tokens", "retention_expires_at"],
      ["order_access_recovery_tokens", "token_hash"],
      ["telegram_integrations", "generation_state"],
      ["telegram_integrations", "integration_generation"],
      ["telegram_actions", "integration_generation"],
      ["telegram_updates", "credential_id"],
      ["telegram_updates", "integration_generation"],
    ] as const;
    for (const [tableName, columnName] of requiredColumns) {
      const rows = completeColumns().filter((row) => (
        row.table_name !== tableName || row.column_name !== columnName
      ));
      expect(() => parsePostMigrationColumnOutput(envelope(rows))).toThrow(
        `post_migration_column_missing:${tableName}:${columnName}`,
      );
    }
  });

  it("detects provider subscription identity and open-checkout snapshot drift", () => {
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("provider.subscription_id != events.subscription_id");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("sessions.status IN ('pending', 'open')");
    for (const dimension of [
      "subscriptions.market_code != prices.market_code",
      "subscriptions.price_currency != prices.currency",
      "subscriptions.price_amount_minor != prices.amount_minor",
      "subscriptions.price_interval != prices.interval",
      "subscriptions.price_version != prices.version",
    ]) {
      expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain(dimension);
    }
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("subscriptions.price_id IS NULL");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("prices.provider_code != subscriptions.billing_provider_code");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("order_access_recovery_tokens AS recovery");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("order_row.customer_id = recovery.customer_id");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("recovery.retention_expires_at <= recovery.expires_at");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("recovery.redacted_at < recovery.retention_expires_at");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("domain.type = 'custom'");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("'$.turnstile.checkedAt'");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("canonical.shop_id = shop.id");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("auth_request_admissions AS admission");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("admission.action NOT IN ('magic_link_request', 'shop_create')");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("admission.delivery_permitted NOT IN (0, 1)");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("admission.action = 'shop_create'");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("admission.subject_hash IS NULL");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("job.kind = 'order_paid'");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("integration.generation_state NOT IN ('active', 'draining')");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL).toContain("update_row.integration_generation <= 0");
  });

  it("preserves admission rows while rebuilding the ledger for shop creation", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const migrationDirectory = join(process.cwd(), "migrations");
      const migrationNames = readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort();
      for (const filename of migrationNames.filter((name) => name !== "0094_shop_creation_admission.sql")) {
        database.exec(readFileSync(join(migrationDirectory, filename), "utf8"));
      }
      const insertExistingAdmission = database.prepare(`
        INSERT INTO auth_request_admissions (
          id, action, requester_hash, window_started_at, window_ends_at, created_at,
          subject_hash, delivery_permitted
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insertExistingAdmission.run(
        "adm-existing-magic-link",
        "magic_link_request",
        "requester_hash_0094",
        "2026-08-11T00:00:00.000Z",
        "2026-08-11T00:01:00.000Z",
        "2026-08-11T00:00:00.000Z",
        "subject_hash_0094",
        0,
      );
      insertExistingAdmission.run(
        "adm-existing-magic-link-default-delivery",
        "magic_link_request",
        "requester_hash_default_0094",
        "2026-08-11T00:00:00.000Z",
        "2026-08-11T00:01:00.000Z",
        "2026-08-11T00:00:01.000Z",
        null,
        1,
      );

      database.exec(readFileSync(join(migrationDirectory, "0094_shop_creation_admission.sql"), "utf8"));

      expect(database.prepare(`
        SELECT id, action, requester_hash, window_started_at, window_ends_at, created_at,
          subject_hash, delivery_permitted
        FROM auth_request_admissions
        WHERE id LIKE 'adm-existing-magic-link%'
        ORDER BY id
      `).all()).toEqual([
        {
          action: "magic_link_request",
          created_at: "2026-08-11T00:00:00.000Z",
          delivery_permitted: 0,
          id: "adm-existing-magic-link",
          requester_hash: "requester_hash_0094",
          subject_hash: "subject_hash_0094",
          window_ends_at: "2026-08-11T00:01:00.000Z",
          window_started_at: "2026-08-11T00:00:00.000Z",
        },
        {
          action: "magic_link_request",
          created_at: "2026-08-11T00:00:01.000Z",
          delivery_permitted: 1,
          id: "adm-existing-magic-link-default-delivery",
          requester_hash: "requester_hash_default_0094",
          subject_hash: null,
          window_ends_at: "2026-08-11T00:01:00.000Z",
          window_started_at: "2026-08-11T00:00:00.000Z",
        },
      ]);
      expect(database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'auth_request_admissions_legacy_0094'",
      ).get()).toBeUndefined();
      expect(database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'index' AND tbl_name = 'auth_request_admissions'
          AND name LIKE 'idx_auth_request_admissions_%'
        ORDER BY name
      `).all().map((row) => row.name)).toEqual([
        "idx_auth_request_admissions_expiry",
        "idx_auth_request_admissions_requester_window",
        "idx_auth_request_admissions_subject_window",
        "idx_auth_request_admissions_window",
      ]);
      expect(() => database.prepare(`
        INSERT INTO auth_request_admissions (
          id, action, requester_hash, subject_hash, delivery_permitted,
          window_started_at, window_ends_at, created_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        "adm-shop-create",
        "shop_create",
        "requester_hash_shop_create",
        "subject_hash_shop_create",
        "2026-08-11T00:00:00.000Z",
        "2026-08-11T00:01:00.000Z",
        "2026-08-11T00:00:00.000Z",
      )).not.toThrow();
      expect(() => database.prepare(`
        INSERT INTO auth_request_admissions (
          id, action, requester_hash, subject_hash, delivery_permitted,
          window_started_at, window_ends_at, created_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      `).run(
        "adm-unknown-action",
        "unknown_action",
        "requester_hash_unknown",
        "subject_hash_unknown",
        "2026-08-11T00:00:00.000Z",
        "2026-08-11T00:01:00.000Z",
        "2026-08-11T00:00:00.000Z",
      )).toThrow(/CHECK constraint failed/u);
    } finally {
      database.close();
    }
  });

  it("counts semantically unusable shop creation admissions", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const migrationDirectory = join(process.cwd(), "migrations");
      for (const filename of readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
        database.exec(readFileSync(join(migrationDirectory, filename), "utf8"));
      }
      database.prepare(`
        INSERT INTO auth_request_admissions (
          id, action, requester_hash, subject_hash, delivery_permitted,
          window_started_at, window_ends_at, created_at
        ) VALUES (?, 'shop_create', ?, ?, 1, ?, ?, ?)
      `).run(
        "adm-valid-shop-create",
        "requester_hash_valid_shop_create",
        "subject_hash_valid_shop_create",
        "2026-08-11T00:00:00.000Z",
        "2026-08-11T00:01:00.000Z",
        "2026-08-11T00:00:00.000Z",
      );
      expect(database.prepare(POST_MIGRATION_CROSS_LEDGER_SQL).get()).toMatchObject({ mismatch_count: 0 });

      database.prepare(`
        INSERT INTO auth_request_admissions (
          id, action, requester_hash, subject_hash, delivery_permitted,
          window_started_at, window_ends_at, created_at
        ) VALUES (?, 'shop_create', ?, NULL, 1, ?, ?, ?)
      `).run(
        "adm-shop-create-missing-subject",
        "requester_hash_missing_subject",
        "2026-08-11T00:00:00.000Z",
        "2026-08-11T00:01:00.000Z",
        "2026-08-11T00:00:00.000Z",
      );
      expect(database.prepare(POST_MIGRATION_CROSS_LEDGER_SQL).get()).toMatchObject({ mismatch_count: 1 });
      expect(() => parsePostMigrationCrossLedgerOutput(envelope(
        database.prepare(POST_MIGRATION_CROSS_LEDGER_SQL).all(),
      ))).toThrow("post_migration_cross_ledger_mismatch");

      database.prepare("DELETE FROM auth_request_admissions WHERE id = ?")
        .run("adm-shop-create-missing-subject");
      database.prepare(`
        INSERT INTO auth_request_admissions (
          id, action, requester_hash, subject_hash, delivery_permitted,
          window_started_at, window_ends_at, created_at
        ) VALUES (?, 'shop_create', ?, ?, 0, ?, ?, ?)
      `).run(
        "adm-shop-create-delivery-denied",
        "requester_hash_delivery_denied",
        "subject_hash_delivery_denied",
        "2026-08-11T00:00:00.000Z",
        "2026-08-11T00:01:00.000Z",
        "2026-08-11T00:00:00.000Z",
      );
      expect(database.prepare(POST_MIGRATION_CROSS_LEDGER_SQL).get()).toMatchObject({ mismatch_count: 1 });
      expect(() => parsePostMigrationCrossLedgerOutput(envelope(
        database.prepare(POST_MIGRATION_CROSS_LEDGER_SQL).all(),
      ))).toThrow("post_migration_cross_ledger_mismatch");
    } finally {
      database.close();
    }
  });

  it("rejects a leaked 0094 rebuild table observed from the executable schema query", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const migrationDirectory = join(process.cwd(), "migrations");
      for (const filename of readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
        database.exec(readFileSync(join(migrationDirectory, filename), "utf8"));
      }
      database.exec("CREATE TABLE auth_request_admissions_legacy_0094 (id TEXT PRIMARY KEY) STRICT;");
      expect(() => parsePostMigrationObjectOutput(envelope(
        database.prepare(POST_MIGRATION_OBJECT_SQL).all(),
      ))).toThrow("post_migration_legacy_object_present:auth_request_admissions_legacy_0094");
      database.exec("DROP TABLE auth_request_admissions_legacy_0094;");
      database.exec("CREATE TABLE telegram_updates_pre_generation (id TEXT PRIMARY KEY) STRICT;");
      expect(() => parsePostMigrationObjectOutput(envelope(
        database.prepare(POST_MIGRATION_OBJECT_SQL).all(),
      ))).toThrow("post_migration_legacy_object_present:telegram_updates_pre_generation");
      database.exec("DROP TABLE telegram_updates_pre_generation;");
      database.exec("CREATE TABLE telegram_updates_pre_rollback (id TEXT PRIMARY KEY) STRICT;");
      expect(() => parsePostMigrationObjectOutput(envelope(
        database.prepare(POST_MIGRATION_OBJECT_SQL).all(),
      ))).toThrow("post_migration_legacy_object_present:telegram_updates_pre_rollback");
    } finally {
      database.close();
    }
  });

  it("enforces complete, catalog-bound subscription price snapshots", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const migrationDirectory = join(process.cwd(), "migrations");
      for (const filename of readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
        database.exec(readFileSync(join(migrationDirectory, filename), "utf8"));
      }
      database.exec(`
        INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
        VALUES ('post-contract-user', 'post-contract@example.test', 'Post Contract', 'active',
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z');
        INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone,
          readiness_version, merchant_country_code, business_country_code, created_at, updated_at)
        VALUES ('post-contract-shop', 'shop_post_contract', 'post-contract', 'Post Contract', 'draft',
          'en', 'USD', 'UTC', 1, 'US', 'US', '2026-08-08T00:00:00.000Z',
          '2026-08-08T00:00:00.000Z');
      `);
      expect(() => database.prepare(`
        INSERT INTO shop_subscriptions (
          id, shop_id, plan_id, state, billing_provider_code, market_code,
          price_currency, price_amount_minor, price_interval, price_version,
          created_at, updated_at
        ) VALUES ('post-contract-partial', 'post-contract-shop', 'plan_starter_v1',
          'pending_payment', 'dodo', 'global', 'USD', 500, 'month', 1,
          '2026-08-08T00:00:00.000Z', '2026-08-08T00:00:00.000Z')
      `).run()).toThrow(/subscription_price_snapshot_incomplete/u);

      database.prepare(`
        INSERT INTO shop_subscriptions (
          id, shop_id, plan_id, state, billing_provider_code, market_code,
          price_currency, price_amount_minor, price_interval, price_version,
          price_id, created_at, updated_at
        ) VALUES ('post-contract-complete', 'post-contract-shop', 'plan_starter_v1',
          'pending_payment', 'dodo', 'global', 'USD', 500, 'month', 1,
          'price_starter_global_v1', '2026-08-08T00:00:00.000Z',
          '2026-08-08T00:00:00.000Z')
      `).run();
      expect(() => database.prepare(`
        UPDATE shop_subscriptions
        SET price_id = NULL, updated_at = '2026-08-08T00:00:01.000Z', version = version + 1
        WHERE id = 'post-contract-complete'
      `).run()).toThrow(/subscription_price_snapshot_incomplete/u);
    } finally {
      database.close();
    }
  });

  it("accepts a complete fail-closed fixture and keeps remote SQL D1-compatible", () => {
    expect(parsePostMigrationForeignKeyOutput(envelope([]))).toEqual({ violationCount: 0 });
    expect(parsePostMigrationObjectOutput(envelope(completeObjects())).objectCount).toBeGreaterThan(0);
    expect(parsePostMigrationColumnOutput(envelope(completeColumns())).columnCount).toBeGreaterThan(0);
    expect(parsePostMigrationCrossLedgerOutput(envelope([{ mismatch_count: 0 }]))).toEqual({ mismatchCount: 0 });
    expect(POST_MIGRATION_FOREIGN_KEY_SQL.toLowerCase()).toContain("pragma foreign_key_check");
    expect(POST_MIGRATION_FOREIGN_KEY_SQL.toLowerCase()).not.toContain("integrity_check");
    expect(POST_MIGRATION_CROSS_LEDGER_SQL.toLowerCase()).not.toContain("integrity_check");
    expect(POST_MIGRATION_COLUMN_SQL).not.toContain("pragma_table_info(tables.name)");
    expect(findCompoundSelectLimitViolations(POST_MIGRATION_COLUMN_SQL)).toEqual([]);
    expect(findCompoundSelectLimitViolations(POST_MIGRATION_CROSS_LEDGER_SQL)).toEqual([]);
  });

  it("expands every required table into D1-safe literal pragma groups", () => {
    const requiredTables = Object.keys(REQUIRED_POST_MIGRATION_COLUMNS);
    const pragmaTables = [...POST_MIGRATION_COLUMN_SQL.matchAll(/pragma_table_info\('([^']+)'\)/gu)]
      .map((match) => match[1]);
    expect(pragmaTables).toEqual(requiredTables);
    expect(POST_MIGRATION_COLUMN_SQL).not.toContain("pragma_table_info(tables.name)");

    const groups = [...POST_MIGRATION_COLUMN_SQL.matchAll(/SELECT \* FROM \(\n([\s\S]*?)\n\)/gu)]
      .flatMap((match) => match[1] === undefined ? [] : [match[1]]);
    expect(groups).toHaveLength(Math.ceil(requiredTables.length / 5));
    for (const group of groups) {
      const termCount = group.match(/pragma_table_info\(/gu)?.length ?? 0;
      expect(termCount).toBeGreaterThan(0);
      expect(termCount).toBeLessThanOrEqual(5);
      expect(findCompoundSelectLimitViolations(group)).toEqual([]);
    }
  });

  it("runs all four checks with the pinned remote D1 invocation", () => {
    const runner = vi.fn((args: string[], _options: { cwd: string; env?: NodeJS.ProcessEnv }) => {
      void _options;
      const sql = args[args.indexOf("--command") + 1] ?? "";
      if (sql.includes("pragma_table_info")) return { stderr: "", stdout: envelope(completeColumns()) };
      if (sql.includes("sqlite_master")) return { stderr: "", stdout: envelope(completeObjects()) };
      if (sql.toLowerCase().includes("foreign_key_check")) return { stderr: "", stdout: envelope([]) };
      return { stderr: "", stdout: envelope([{ mismatch_count: 0 }]) };
    });
    const result = assertRemotePostMigrationContract({
      environment: { CLOUDFLARE_ACCOUNT_ID: "abcdef0123456789abcdef0123456789" },
      environmentName: "staging",
      repositoryRoot: process.cwd(),
      runWranglerImplementation: runner,
    });

    expect(result).toMatchObject({ ok: true, violationCount: 0, mismatchCount: 0 });
    expect(runner).toHaveBeenCalledTimes(4);
    for (const [args, options] of runner.mock.calls) {
      expect(args.slice(0, 6)).toEqual(["d1", "execute", "PLATFORM_DB", "--env", "staging", "--remote"]);
      expect(args).toContain("--json");
      expect(options.env?.CLOUDFLARE_ACCOUNT_ID).toBe("abcdef0123456789abcdef0123456789");
    }
    expect(POST_MIGRATION_OBJECT_SQL).toContain("sqlite_master");
    expect(POST_MIGRATION_COLUMN_SQL).toContain("pragma_table_info");
  });

  it("matches the schema produced by the complete local migration chain", () => {
    const database = new DatabaseSync(":memory:");
    try {
      const migrationDirectory = join(process.cwd(), "migrations");
      for (const filename of readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
        database.exec(readFileSync(join(migrationDirectory, filename), "utf8"));
      }
      const rows = (sql: string) => database.prepare(sql).all();
      expect(() => parsePostMigrationForeignKeyOutput(envelope(rows(POST_MIGRATION_FOREIGN_KEY_SQL)))).not.toThrow();
      expect(() => parsePostMigrationObjectOutput(envelope(rows(POST_MIGRATION_OBJECT_SQL)))).not.toThrow();
      expect(() => parsePostMigrationColumnOutput(envelope(rows(POST_MIGRATION_COLUMN_SQL)))).not.toThrow();
      expect(() => parsePostMigrationCrossLedgerOutput(envelope(rows(POST_MIGRATION_CROSS_LEDGER_SQL)))).not.toThrow();
    } finally {
      database.close();
    }
  });
});
