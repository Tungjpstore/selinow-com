import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const MIGRATION = "0119_payos_provider_projection_lifecycle.sql";
const DISCONNECT_REPAIR_MIGRATION = "0121_payos_disconnect_projection_repair.sql";
const NOW = "2026-08-25T10:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function databaseThrough(maximumMigration: number): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= maximumMigration)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  return database;
}

function seedShop(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at, merchant_country_code,
      business_country_code
    ) VALUES (
      'shop-payos-projection', 'shop_payos_projection', 'payos-projection',
      'PayOS Projection', 'active', 'vi-VN', 'VND', 'Asia/Ho_Chi_Minh',
      1, '${NOW}', '${NOW}', 'VN', 'VN'
    );
  `);
}

function insertLegacyIntegration(
  database: DatabaseSync,
  id: string,
  status = "pending",
  webhookStatus = "pending",
  fingerprint: string | null = null,
): void {
  database.prepare(`
    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status,
      webhook_status, provider_identity_fingerprint, connected_at,
      last_checked_at, last_webhook_verified_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'shop-payos-projection', 'payos', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `public-${id}`,
    `webhook-${id}`,
    status,
    webhookStatus,
    fingerprint,
    status === "active" ? NOW : null,
    status === "active" ? NOW : null,
    status === "active" ? NOW : null,
    NOW,
    NOW,
  );
}

function projection(database: DatabaseSync, id: string): Record<string, unknown> | undefined {
  return database.prepare(`
    SELECT status, webhook_status AS webhookStatus,
      provider_account_fingerprint AS fingerprint,
      provider_account_verified_at AS verifiedAt,
      disconnected_at AS disconnectedAt
    FROM payment_provider_connections
    WHERE id = ? AND shop_id = 'shop-payos-projection'
  `).get(id);
}

describe("PayOS provider projection lifecycle repair", () => {
  it("backfills an integration created after the original projection migration", () => {
    const database = databaseThrough(118);
    seedShop(database);
    insertLegacyIntegration(
      database,
      "integration-backfill",
      "active",
      "verified",
      "provider-fingerprint-backfill",
    );

    expect(database.prepare("SELECT COUNT(*) AS count FROM payment_provider_connections").get())
      .toEqual({ count: 0 });

    database.exec(readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8"));

    expect(projection(database, "integration-backfill")).toEqual({
      disconnectedAt: null,
      fingerprint: "provider-fingerprint-backfill",
      status: "active",
      verifiedAt: NOW,
      webhookStatus: "verified",
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM payment_provider_connection_capabilities
      WHERE connection_id = 'integration-backfill'
        AND provider_granted = 1 AND effective_enabled = 1
    `).get()).toEqual({ count: 4 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM payment_provider_connection_currencies
      WHERE connection_id = 'integration-backfill'
        AND currency_code = 'VND' AND effective_enabled = 1
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM payment_provider_connection_methods
      WHERE connection_id = 'integration-backfill'
        AND method_code = 'bank_transfer_qr' AND effective_enabled = 1
    `).get()).toEqual({ count: 1 });
  });

  it("projects insert, verification, degraded health, disconnect and reconnect atomically", () => {
    const database = databaseThrough(119);
    seedShop(database);
    insertLegacyIntegration(database, "integration-lifecycle");

    expect(projection(database, "integration-lifecycle")).toMatchObject({
      fingerprint: null,
      status: "pending",
      webhookStatus: "pending",
    });

    database.prepare(`
      UPDATE payment_integrations
      SET provider_identity_fingerprint = 'provider-fingerprint-lifecycle',
        provider_claim_generation = provider_claim_generation + 1,
        provider_claim_nonce = 'claim_lifecycle_0123456789abcdef',
        provider_claim_state = 'in_flight',
        provider_claim_target_fingerprint = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        updated_at = ?
      WHERE id = 'integration-lifecycle'
    `).run(NOW);
    database.prepare(`
      UPDATE payment_integrations
      SET status = 'active', webhook_status = 'verified',
        connected_at = ?, last_checked_at = ?, last_webhook_verified_at = ?,
        provider_claim_nonce = NULL, provider_claim_state = 'idle',
        provider_claim_target_fingerprint = NULL,
        updated_at = ?
      WHERE id = 'integration-lifecycle'
    `).run(NOW, NOW, NOW, NOW);
    expect(projection(database, "integration-lifecycle")).toMatchObject({
      fingerprint: "provider-fingerprint-lifecycle",
      status: "active",
      webhookStatus: "verified",
    });

    database.prepare(`
      UPDATE payment_integrations
      SET status = 'error', webhook_status = 'error',
        last_safe_error_code = 'provider_verification_unknown', updated_at = ?
      WHERE id = 'integration-lifecycle'
    `).run("2026-08-25T10:01:00.000Z");
    expect(projection(database, "integration-lifecycle")).toMatchObject({
      fingerprint: "provider-fingerprint-lifecycle",
      status: "degraded",
      webhookStatus: "verified",
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM payment_provider_connection_capabilities
      WHERE connection_id = 'integration-lifecycle' AND effective_enabled != 0
    `).get()).toEqual({ count: 0 });

    database.prepare(`
      UPDATE payment_integrations
      SET status = 'disconnected', webhook_status = 'disconnected',
        updated_at = ?
      WHERE id = 'integration-lifecycle'
    `).run("2026-08-25T10:02:00.000Z");
    expect(projection(database, "integration-lifecycle")).toMatchObject({
      disconnectedAt: "2026-08-25T10:02:00.000Z",
      fingerprint: "provider-fingerprint-lifecycle",
      status: "disconnected",
      webhookStatus: "disconnected",
    });

    database.prepare(`
      UPDATE payment_integrations
      SET status = 'active', webhook_status = 'verified',
        last_safe_error_code = NULL, last_checked_at = ?,
        last_webhook_verified_at = ?, updated_at = ?
      WHERE id = 'integration-lifecycle'
    `).run("2026-08-25T10:03:00.000Z", "2026-08-25T10:03:00.000Z", "2026-08-25T10:03:00.000Z");
    expect(projection(database, "integration-lifecycle")).toMatchObject({
      disconnectedAt: null,
      fingerprint: "provider-fingerprint-lifecycle",
      status: "active",
      webhookStatus: "verified",
    });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM payment_provider_connection_capabilities
      WHERE connection_id = 'integration-lifecycle' AND effective_enabled = 1
    `).get()).toEqual({ count: 4 });
  });

  it("repairs stale identity fields left on a disconnected PayOS projection", () => {
    const database = databaseThrough(120);
    seedShop(database);
    insertLegacyIntegration(
      database,
      "integration-stale-disconnect",
      "active",
      "verified",
      "provider-fingerprint-stale",
    );

    const disconnectedAt = "2026-08-25T10:04:00.000Z";
    database.prepare(`
      UPDATE payment_integrations
      SET status = 'disconnected', webhook_status = 'disconnected',
        updated_at = ?
      WHERE id = 'integration-stale-disconnect'
    `).run(disconnectedAt);
    expect(projection(database, "integration-stale-disconnect")).toMatchObject({
      disconnectedAt,
      fingerprint: "provider-fingerprint-stale",
      status: "disconnected",
      verifiedAt: NOW,
      webhookStatus: "disconnected",
    });

    const before = database.prepare(`
      SELECT version FROM payment_provider_connections
      WHERE id = 'integration-stale-disconnect'
    `).get() as { version: number };
    database.exec(readFileSync(join(process.cwd(), "migrations", DISCONNECT_REPAIR_MIGRATION), "utf8"));

    expect(projection(database, "integration-stale-disconnect")).toEqual({
      disconnectedAt,
      fingerprint: null,
      status: "disconnected",
      verifiedAt: null,
      webhookStatus: "disconnected",
    });
    expect(database.prepare(`
      SELECT version FROM payment_provider_connections
      WHERE id = 'integration-stale-disconnect'
    `).get()).toEqual({ version: before.version + 1 });

    // Reapplying the repair is a no-op once the projection is clean.
    database.exec(readFileSync(join(process.cwd(), "migrations", DISCONNECT_REPAIR_MIGRATION), "utf8"));
    expect(database.prepare(`
      SELECT version FROM payment_provider_connections
      WHERE id = 'integration-stale-disconnect'
    `).get()).toEqual({ version: before.version + 1 });
  });
});
