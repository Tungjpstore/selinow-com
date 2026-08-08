import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  classifyDodoCatalogRows,
  dodoCatalogReadSql,
  dodoCatalogUpdateSql,
  parseDodoCatalogArguments,
  parseDodoCatalogCommandOutput,
  readDodoCatalogReferences,
} from "../../scripts/lib/dodo-catalog-reconciliation.mjs";

const NOW = "2026-08-08T00:00:00.000Z";
const REFERENCES = {
  price_pro_global_v1: "pdt_test_pro_global",
  price_pro_vn_v1: "pdt_test_pro_vn",
  price_starter_global_v1: "pdt_test_starter_global",
  price_starter_vn_v1: "pdt_test_starter_vn",
};

function applyMigrations(database: DatabaseSync): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function rows(database: DatabaseSync): Record<string, unknown>[] {
  return database.prepare(dodoCatalogReadSql()).all();
}

describe("Dodo catalog reconciliation", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
  });

  afterEach(() => { database.close(); });

  it("accepts valid per-row pending timestamp drift and reconciles atomically", () => {
    // Migration 0076 can replay across multiple SQLite seconds. Preserve the
    // exact offer shape while accepting independently valid row timestamps.
    Object.keys(REFERENCES).forEach((id, index) => {
      database.prepare("UPDATE plan_prices SET updated_at = datetime(created_at, ?) WHERE id = ?")
        .run(`+${Math.floor(index / 2)} seconds`, id);
    });
    expect(classifyDodoCatalogRows(rows(database), REFERENCES)).toEqual({
      mode: "pending",
      pendingCount: 4,
      publishedCount: 0,
    });
    database.exec(dodoCatalogUpdateSql(REFERENCES));
    expect(classifyDodoCatalogRows(rows(database), REFERENCES)).toEqual({
      mode: "already_configured",
      pendingCount: 0,
      publishedCount: 4,
    });
  });

  it("rejects catalog timing drift before publishing provider references", () => {
    const baseline = rows(database);
    const altered = baseline.map((row, index) => index === 0
      ? { ...row, effective_from: "2099-01-01 00:00:00" }
      : row);
    expect(() => classifyDodoCatalogRows(altered, REFERENCES)).toThrow("dodo_catalog_baseline_mismatch");

    database.prepare("UPDATE plan_prices SET updated_at = datetime(created_at, '-1 second') WHERE id = ?")
      .run("price_starter_vn_v1");
    expect(() => classifyDodoCatalogRows(rows(database), REFERENCES)).toThrow("dodo_catalog_baseline_mismatch");
    database.exec(dodoCatalogUpdateSql(REFERENCES));
    expect(rows(database).every((row) => String(row.provider_price_ref).startsWith("pending:dodo:"))).toBe(true);
  });

  it("rejects duplicate references and rewrites after publication", () => {
    database.prepare("UPDATE plan_prices SET provider_price_ref = ? WHERE id = ?")
      .run(REFERENCES.price_starter_vn_v1, "price_starter_vn_v1");
    expect(() => database.prepare("UPDATE plan_prices SET provider_price_ref = ? WHERE id = ?")
      .run(REFERENCES.price_starter_vn_v1, "price_pro_vn_v1"))
      .toThrow(/UNIQUE/u);
    expect(() => database.prepare("UPDATE plan_prices SET provider_price_ref = ? WHERE id = ?").run("pdt_other", "price_starter_vn_v1"))
      .toThrow(/plan_price_provider_identity_immutable/u);
  });

  it("permits one pending-to-published transition but rejects pending rewrites and tax changes", () => {
    expect(() => database.prepare("UPDATE plan_prices SET provider_price_ref = ? WHERE id = ?")
      .run("pending:dodo:replacement", "price_starter_vn_v1"))
      .toThrow(/plan_price_provider_identity_immutable/u);
    database.prepare("UPDATE plan_prices SET provider_price_ref = ? WHERE id = ?")
      .run(REFERENCES.price_starter_vn_v1, "price_starter_vn_v1");
    expect(() => database.prepare("UPDATE plan_prices SET tax_behavior = 'exclusive' WHERE id = ?")
      .run("price_starter_vn_v1")).toThrow(/plan_price_provider_identity_immutable/u);
  });

  it("keeps legacy plans hidden and validates subscription price snapshots", () => {
    database.prepare(`
      INSERT INTO plans (
        id, code, name, feature_flags_json, limits_json, version, is_active,
        created_at, updated_at, is_public, is_assignable, schema_version
      ) VALUES ('plan-legacy-test', 'legacy-test', 'Legacy', '{}', '{}', 1, 1, ?, ?, 0, 0, 1)
    `).run(NOW, NOW);
    expect(() => database.prepare("UPDATE plans SET is_public = 1 WHERE code = 'legacy-test'").run())
      .toThrow(/legacy_plan_visibility_forbidden/u);
    database.exec(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES ('dodo-catalog-user', 'dodo-catalog@example.test', 'Catalog', 'active', '${NOW}', '${NOW}');
      INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone,
        readiness_version, merchant_country_code, business_country_code, created_at, updated_at)
      VALUES ('dodo-catalog-shop', 'shop_dodo_catalog', 'dodo-catalog', 'Catalog', 'draft', 'en', 'USD', 'UTC',
        1, 'US', 'US', '${NOW}', '${NOW}');
    `);
    expect(() => database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, billing_provider_code, market_code, price_currency,
        price_amount_minor, price_interval, price_version, price_id, created_at, updated_at
      ) VALUES ('dodo-catalog-sub', 'dodo-catalog-shop', 'plan_pro_v1', 'active', 'dodo', 'global',
        'USD', 500, 'month', 1, 'price_pro_global_v1', ?, ?)
    `).run(NOW, NOW)).toThrow(/subscription_price_snapshot_scope_mismatch/u);
  });

  it("fails closed on malformed references, duplicate references and unsafe mutations", () => {
    expect(() => readDodoCatalogReferences({
      DODO_STARTER_VN_PRODUCT_ID: "pdt_a",
      DODO_PRO_VN_PRODUCT_ID: "pdt_a",
      DODO_STARTER_GLOBAL_PRODUCT_ID: "pdt_c",
      DODO_PRO_GLOBAL_PRODUCT_ID: "pdt_d",
    })).toThrow("dodo_catalog_references_not_unique");
    expect(() => readDodoCatalogReferences({
      DODO_STARTER_VN_PRODUCT_ID: "pdt_a",
      DODO_PRO_VN_PRODUCT_ID: "pdt_b",
      DODO_STARTER_GLOBAL_PRODUCT_ID: "pending:dodo:bad",
      DODO_PRO_GLOBAL_PRODUCT_ID: "pdt_d",
    })).toThrow(/dodo_starter_global_product_id_invalid/u);
    expect(() => parseDodoCatalogArguments(["--env", "staging", "--apply"]))
      .toThrow("dodo_catalog_confirmation_required");
    expect(() => parseDodoCatalogArguments(["--env", "production", "--apply", "--confirm-catalog-update"]))
      .toThrow("production_confirmation_required");
  });

  it("keeps dry-run output free of product references and parses exact update counts", () => {
    const result = spawnSync(process.execPath, [
      "scripts/dodo-catalog-reconcile.mjs", "--env", "staging", "--json",
    ], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        DODO_PRO_GLOBAL_PRODUCT_ID: REFERENCES.price_pro_global_v1,
        DODO_PRO_VN_PRODUCT_ID: REFERENCES.price_pro_vn_v1,
        DODO_STARTER_GLOBAL_PRODUCT_ID: REFERENCES.price_starter_global_v1,
        DODO_STARTER_VN_PRODUCT_ID: REFERENCES.price_starter_vn_v1,
      },
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("pdt_test_");
    expect(JSON.parse(result.stdout)).toMatchObject({ mode: "dry_run", environment: "staging" });
    expect(parseDodoCatalogCommandOutput(JSON.stringify([{ success: true, results: [{ updated_count: 4 }] }]))).toEqual({ updatedCount: 4 });
    expect(() => parseDodoCatalogCommandOutput(JSON.stringify([{ success: true, results: [{ updated_count: 3 }] }]))).toThrow("dodo_catalog_update_count_mismatch");
  });
});
