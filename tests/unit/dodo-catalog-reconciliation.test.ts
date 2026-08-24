import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attestDodoCatalogProducts,
  classifyDodoCatalogRows,
  DODO_CATALOG_OFFERS,
  dodoCatalogCompletionSql,
  dodoCatalogReadSql,
  dodoCatalogRotationSql,
  dodoCatalogUpdateSql,
  inspectDodoCatalog,
  parseDodoCatalogRotationCommandOutput,
  parseDodoCatalogArguments,
  parseDodoCatalogCommandOutput,
  readDodoCatalogReferences,
  reconcileDodoCatalog,
  validateDodoCatalogProviderProduct,
  validateDodoCatalogTarget,
} from "../../scripts/lib/dodo-catalog-reconciliation.mjs";

const NOW = "2026-08-08T00:00:00.000Z";
const REFERENCES = {
  price_pro_global_v1: "pdt_test_pro_global",
  price_pro_vn_v1: "pdt_test_pro_vn",
  price_starter_global_v1: "pdt_test_starter_global",
  price_starter_vn_v1: "pdt_test_starter_vn",
};

const LIVE_REFERENCES = {
  price_pro_global_v1: "pdt_live_pro_global",
  price_pro_vn_v1: "pdt_live_pro_vn",
  price_starter_global_v1: "pdt_live_starter_global",
  price_starter_vn_v1: "pdt_live_starter_vn",
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
        .run(`+${String(Math.floor(index / 2))} seconds`, id);
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
    expect(database.prepare("SELECT value_json AS valueJson FROM platform_settings WHERE key = 'dodo_catalog_reconciliation_required'").get())
      .toEqual({ valueJson: '{"value":false}' });
  });

  it("keeps the completion marker true until all four exact offers are published", () => {
    database.exec(dodoCatalogCompletionSql(REFERENCES, "already_configured"));
    expect(database.prepare("SELECT value_json AS valueJson FROM platform_settings WHERE key = 'dodo_catalog_reconciliation_required'").get())
      .toEqual({ valueJson: '{"value":true}' });

    database.prepare("UPDATE plan_prices SET provider_price_ref = ? WHERE id = ?")
      .run(REFERENCES.price_starter_vn_v1, "price_starter_vn_v1");
    database.exec(dodoCatalogCompletionSql(REFERENCES, "already_configured"));

    expect(database.prepare("SELECT value_json AS valueJson FROM platform_settings WHERE key = 'dodo_catalog_reconciliation_required'").get())
      .toEqual({ valueJson: '{"value":true}' });
  });

  it("rotates published v1 rows into v2 without rebinding existing subscriptions or checkouts", () => {
    database.exec(dodoCatalogUpdateSql(LIVE_REFERENCES));
    database.exec(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency, timezone,
        readiness_version, merchant_country_code, business_country_code, created_at, updated_at
      ) VALUES ('dodo-rotation-shop', 'shop_dodo_rotation', 'dodo-rotation', 'Dodo Rotation',
        'draft', 'en', 'VND', 'UTC', 1, 'VN', 'VN', '${NOW}', '${NOW}');
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, billing_provider_code, market_code, price_currency,
        price_amount_minor, price_interval, price_version, price_id, created_at, updated_at
      ) VALUES ('dodo-rotation-sub', 'dodo-rotation-shop', 'plan_starter_v1', 'active', 'dodo', 'vn',
        'VND', 99000, 'month', 1, 'price_starter_vn_v1', '${NOW}', '${NOW}');
      INSERT INTO billing_checkout_sessions (
        id, public_id, shop_id, subscription_id, plan_id, price_id, provider_code,
        provider_checkout_ref, status, idempotency_key_hash, request_hash, version,
        created_at, updated_at
      ) VALUES ('dodo-rotation-checkout', 'bchk_dodo_rotation', 'dodo-rotation-shop',
        'dodo-rotation-sub', 'plan_starter_v1', 'price_starter_vn_v1', 'dodo', NULL,
        'pending', 'hash_dodo_rotation_idempotency', 'hash_dodo_rotation_request', 1,
        '${NOW}', '${NOW}');
    `);
    expect(classifyDodoCatalogRows(rows(database), REFERENCES)).toEqual({
      mode: "rotation_required",
      pendingCount: 0,
      publishedCount: 4,
    });
    database.prepare("UPDATE platform_settings SET value_json = '{\"value\":true}' WHERE key = 'dodo_catalog_reconciliation_required'").run();

    database.exec(dodoCatalogRotationSql(LIVE_REFERENCES, REFERENCES));

    expect(classifyDodoCatalogRows(rows(database), REFERENCES)).toEqual({
      mode: "rotated",
      pendingCount: 0,
      publishedCount: 4,
    });
    expect(database.prepare(`
      SELECT id, provider_price_ref, is_active, version
      FROM plan_prices
      WHERE id IN ('price_starter_vn_v1', 'price_starter_vn_v2')
      ORDER BY version
    `).all()).toEqual([
      {
        id: "price_starter_vn_v1",
        provider_price_ref: LIVE_REFERENCES.price_starter_vn_v1,
        is_active: 0,
        version: 1,
      },
      {
        id: "price_starter_vn_v2",
        provider_price_ref: REFERENCES.price_starter_vn_v1,
        is_active: 1,
        version: 2,
      },
    ]);
    expect(database.prepare(`
      SELECT effective_to IS NOT NULL AS v1_closed,
        (SELECT effective_to IS NULL FROM plan_prices WHERE id = 'price_starter_vn_v2') AS v2_open
      FROM plan_prices WHERE id = 'price_starter_vn_v1'
    `).get()).toEqual({ v1_closed: 1, v2_open: 1 });
    expect(database.prepare("SELECT price_id FROM shop_subscriptions WHERE id = 'dodo-rotation-sub'").get())
      .toEqual({ price_id: "price_starter_vn_v1" });
    expect(database.prepare("SELECT price_id FROM billing_checkout_sessions WHERE id = 'dodo-rotation-checkout'").get())
      .toEqual({ price_id: "price_starter_vn_v1" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("emits catalog rotation SQL compatible with remote D1 execution", () => {
    const sql = dodoCatalogRotationSql(LIVE_REFERENCES, REFERENCES);

    expect(sql).not.toMatch(/\bBEGIN(?:\s+IMMEDIATE)?\b/iu);
    expect(sql).not.toMatch(/\bCOMMIT\b/iu);
    expect(sql).toContain("WITH state");
    expect(parseDodoCatalogRotationCommandOutput(JSON.stringify([
      { success: true, results: [{ rotation_mode: "rotated", closed_count: 4, inserted_count: 4 }] },
    ]))).toEqual({ mode: "rotated", closedCount: 4, insertedCount: 4 });
  });

  it("replays rotation idempotently and rolls back when the observed v1 source is stale", () => {
    database.exec(dodoCatalogUpdateSql(LIVE_REFERENCES));
    const rotationSql = dodoCatalogRotationSql(LIVE_REFERENCES, REFERENCES);
    database.exec(rotationSql);
    database.exec(rotationSql);
    expect(database.prepare("SELECT COUNT(*) AS count FROM plan_prices WHERE version = 2").get())
      .toEqual({ count: 4 });
    expect(() => {
      database.exec(dodoCatalogRotationSql({
        ...LIVE_REFERENCES,
        price_starter_vn_v1: "pdt_live_starter_vn_changed",
      }, REFERENCES));
    }).toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM plan_prices WHERE version = 2").get())
      .toEqual({ count: 4 });
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
    expect(parseDodoCatalogArguments(["--env", "production", "--inspect"]))
      .toMatchObject({ apply: false, inspect: true });
    expect(() => parseDodoCatalogArguments(["--env", "production", "--inspect", "--dry-run"]))
      .toThrow("dodo_catalog_mode_conflict");
    expect(() => parseDodoCatalogArguments(["--env", "production", "--inspect", "--apply"]))
      .toThrow("dodo_catalog_mode_conflict");
    expect(() => parseDodoCatalogArguments(["--env", "production", "--apply", "--confirm-catalog-update"]))
      .toThrow("production_confirmation_required");
    expect(() => parseDodoCatalogArguments(["--env", "staging", "--apply", "--confirm-catalog-update"]))
      .toThrow("staging_test_catalog_confirmation_required");
    expect(parseDodoCatalogArguments([
      "--env", "staging", "--apply", "--confirm-catalog-update", "--confirm-staging-test-catalog",
    ])).toMatchObject({ confirmStagingTestCatalog: true });
    expect(() => parseDodoCatalogArguments([
      "--env", "production", "--apply", "--confirm-catalog-update", "--confirm-production",
    ])).toThrow("production_live_catalog_confirmation_required");
    expect(parseDodoCatalogArguments([
      "--env", "production", "--apply", "--confirm-catalog-update", "--confirm-production",
      "--confirm-production-live-catalog",
    ])).toMatchObject({ confirmProductionLiveCatalog: true });
    expect(() => {
      validateDodoCatalogTarget({
        environment: "staging", providerMode: "live_mode", confirmStagingTestCatalog: true,
      });
    }).toThrow("dodo_catalog_staging_live_mode_forbidden");
    expect(() => {
      validateDodoCatalogTarget({
        environment: "production", providerMode: "test_mode", confirmProduction: true,
        confirmProductionLiveCatalog: true,
      });
    }).toThrow("dodo_catalog_production_test_mode_forbidden");
  });

  it("attests every provider product before catalog publication", async () => {
    const byReference = new Map(Object.entries(REFERENCES).map(([offerId, reference]) => {
      const offer = DODO_CATALOG_OFFERS.find((candidate) => candidate.id === offerId);
      if (offer === undefined) throw new Error("missing_offer_fixture");
      return [reference, {
        is_recurring: true,
        price: {
          currency: offer.currency,
          payment_frequency_count: 1,
          payment_frequency_interval: "month",
          price: offer.amountMinor,
          purchasing_power_parity: false,
          subscription_period_count: 1,
          subscription_period_interval: "month",
          tax_inclusive: true,
          trial_amount: null,
          trial_period_days: 0,
          type: "recurring_price",
        },
        product_id: reference,
      }];
    }));
    const calls: string[] = [];
    const result = await attestDodoCatalogProducts({
      apiBaseUrl: "https://test.dodopayments.com",
      apiKey: "test-api-key-with-enough-entropy",
      references: REFERENCES,
      fetcher: (input, init) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        calls.push(url.pathname);
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-api-key-with-enough-entropy");
        return Promise.resolve(Response.json(byReference.get(decodeURIComponent(url.pathname.split("/").at(-1) ?? ""))));
      },
    });
    expect(result).toEqual({ verifiedCount: 4 });
    expect(calls).toHaveLength(4);

    const proOffer = DODO_CATALOG_OFFERS.find((offer) => offer.id === "price_pro_vn_v1");
    if (proOffer === undefined) throw new Error("missing_pro_offer_fixture");
    expect(() => validateDodoCatalogProviderProduct({
      ...byReference.get(REFERENCES.price_pro_vn_v1),
      price: { ...byReference.get(REFERENCES.price_pro_vn_v1)?.price, trial_period_days: 7 },
    }, proOffer, REFERENCES.price_pro_vn_v1)).toThrow("dodo_catalog_provider_trial_mismatch:price_pro_vn_v1");
  });

  it("never reads or mutates D1 when provider catalog attestation fails", async () => {
    let remoteCalls = 0;
    await expect(reconcileDodoCatalog({
      apiBaseUrl: "https://test.dodopayments.com",
      apiKey: "test-api-key-with-enough-entropy",
      attestProviderImplementation: () => Promise.reject(new Error("dodo_catalog_provider_trial_mismatch:price_pro_vn_v1")),
      confirmStagingTestCatalog: true,
      environment: "staging",
      providerMode: "test_mode",
      references: REFERENCES,
      runRemoteImplementation: () => {
        remoteCalls += 1;
        return "";
      },
    })).rejects.toThrow("dodo_catalog_provider_trial_mismatch:price_pro_vn_v1");
    expect(remoteCalls).toBe(0);
  });

  it("inspects the remote catalog with SELECT-only commands", () => {
    const catalogRows = rows(database);
    const calls: string[][] = [];
    const runRemoteImplementation = (_environment: string, args: string[]): string => {
      calls.push(args);
      return JSON.stringify([{
        success: true,
        results: calls.length === 1 ? catalogRows : [{ reconciliation_required: 1 }],
      }]);
    };

    expect(inspectDodoCatalog({
      environment: "production",
      providerMode: "live_mode",
      references: LIVE_REFERENCES,
      runRemoteImplementation,
    })).toEqual({
      environment: "production",
      mode: "pending",
      pendingCount: 4,
      publishedCount: 0,
      reconciliationRequired: true,
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((args) => args.includes("--command") && args.includes("--json"))).toBe(true);
    expect(calls.flat()).not.toContain("--file");
    expect(calls.flat()).not.toContain("--yes");
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
    expect(parseDodoCatalogRotationCommandOutput(JSON.stringify([{ success: true, results: [{ rotation_mode: "rotated", closed_count: 4, inserted_count: 4 }] }]))).toEqual({
      mode: "rotated",
      closedCount: 4,
      insertedCount: 4,
    });
  });

  it("passes the provider configuration into the apply reconciliation path", () => {
    const script = readFileSync("scripts/dodo-catalog-reconcile.mjs", "utf8");
    expect(script).toContain("apiBaseUrl: providerConfig.apiBaseUrl");
    expect(script).toContain("apiKey: providerConfig.apiKey");
  });
});
