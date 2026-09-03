import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

function applyMigrations(database: DatabaseSync, maximumMigration = Number.POSITIVE_INFINITY): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    if (Number.parseInt(filename.slice(0, 4), 10) > maximumMigration) break;
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function createDatabase(maximumMigration = Number.POSITIVE_INFINITY): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, maximumMigration);
  return database;
}

function telegramIntegrationColumns(database: DatabaseSync): Map<string, { type: string; dflt: string | null; notnull: number }> {
  const rows = database.prepare("PRAGMA table_info(telegram_integrations)").all() as Array<Record<string, unknown>>;
  return new Map(rows.map((row) => [String(row.name), { type: String(row.type), dflt: typeof row.dflt_value === "string" ? row.dflt_value : null, notnull: Number(row.notnull) }]));
}

function seedShopWithTelegramChannel(database: DatabaseSync): void {
  database.prepare(`
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('shop-00000001', 'shop-public-00000001', 'shop-00000001', 'Shop', 'draft', 'vi-VN', 'VND', 'Asia/Ho_Chi_Minh', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
  database.prepare(`
    INSERT INTO shop_channels (id, shop_id, channel_code, status, settings_json, version, created_at, updated_at)
    VALUES ('tin-00000001', 'shop-00000001', 'telegram', 'pending', '{}', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
  database.prepare(`
    INSERT INTO channel_connections (id, public_id, shop_id, shop_channel_id, provider_code, status, settings_json, version, created_at, updated_at)
    VALUES ('tin-00000001', 'conn-000001', 'shop-00000001', 'tin-00000001', 'telegram', 'pending', '{}', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
}

describe("0124_telegram_menu_templates", () => {
  it("is additive-only over the pre-migration telegram_integrations shape", () => {
    const before = createDatabase(123);
    const after = createDatabase();

    for (const column of telegramIntegrationColumns(before).keys()) {
      expect(telegramIntegrationColumns(after).has(column), `pre-existing column ${column} must survive 0124`).toBe(true);
    }
    for (const column of ["template_preset", "welcome_message_custom", "support_handle", "menu_config_json"]) {
      expect(telegramIntegrationColumns(after).has(column), `0124 must add ${column}`).toBe(true);
    }
  });

  it("defaults existing and new rows to the license_vault preset", () => {
    const database = createDatabase();

    const template = telegramIntegrationColumns(database).get("template_preset");
    expect(template?.notnull).toBe(1);
    expect(template?.dflt).toBe("'license_vault'");

    seedShopWithTelegramChannel(database);
    const inserted = database.prepare(`
      INSERT INTO telegram_integrations (id, public_id, webhook_public_id, shop_id, channel_connection_id, status, webhook_status, created_at, updated_at)
      VALUES ('tin-00000001', 'tgint-000001', 'tgwh-000001', 'shop-00000001', 'tin-00000001', 'pending', 'pending', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      RETURNING template_preset
    `).get() as { template_preset: string };
    expect(inserted.template_preset).toBe("license_vault");
  });

  it("rejects template presets outside the industry allowlist", () => {
    const database = createDatabase();
    seedShopWithTelegramChannel(database);
    expect(() => database.prepare(`
      INSERT INTO telegram_integrations (id, public_id, webhook_public_id, shop_id, channel_connection_id, status, webhook_status, template_preset, created_at, updated_at)
      VALUES ('tin-00000001', 'tgint-000001', 'tgwh-000001', 'shop-00000001', 'tin-00000001', 'pending', 'pending', 'unknown_preset', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run()).toThrow();
  });

  it("provides the tenant-leading template index", () => {
    const database = createDatabase();
    const indexes = database.prepare("PRAGMA index_list(telegram_integrations)").all() as Array<Record<string, unknown>>;
    const names = indexes.map((index) => String(index.name));
    expect(names).toContain("idx_telegram_integrations_template");
  });

  it("keeps the menu columns nullable except the preset default", () => {
    const database = createDatabase();
    for (const column of ["welcome_message_custom", "support_handle", "menu_config_json"]) {
      expect(telegramIntegrationColumns(database).get(column)?.notnull).toBe(0);
    }
  });
});
