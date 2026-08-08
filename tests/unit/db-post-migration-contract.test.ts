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
  });

  it("pins every schema contract introduced by migrations 0081 through 0083", () => {
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
      ["index", "idx_auth_request_admissions_subject_window"],
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
      ["auth_request_admissions", "subject_hash"],
      ["auth_request_admissions", "delivery_permitted"],
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
