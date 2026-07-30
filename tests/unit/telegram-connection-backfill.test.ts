import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const databases: DatabaseSync[] = [];
const BACKFILL = "0025_telegram_channel_connection_backfill.sql";
const NOW = "2026-07-26T00:00:00.000Z";

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function applyMigration(database: DatabaseSync): void {
  const sql = readFileSync(join(process.cwd(), "migrations", BACKFILL), "utf8");
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(sql);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && name < BACKFILL)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  database.exec(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shop_backfill_a', 'shop_public_backfill_a', 'backfill-a', 'A', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'),
      ('shop_backfill_b', 'shop_public_backfill_b', 'backfill-b', 'B', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'),
      ('shop_backfill_c', 'shop_public_backfill_c', 'backfill-c', 'C', 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'),
      ('shop_backfill_d', 'shop_public_backfill_d', 'backfill-d', 'D', 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'),
      ('shop_backfill_e', 'shop_public_backfill_e', 'backfill-e', 'E', 'draft', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}');
    INSERT INTO shop_channels (
      id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
    ) VALUES (
      'shop_channel_existing_a', 'shop_backfill_a', 'telegram', 'enabled', '{}', 1, '${NOW}', '${NOW}'
    );
    INSERT INTO telegram_integrations (
      id, public_id, webhook_public_id, shop_id, status, webhook_status,
      active_credential_id, bot_id, bot_username_sanitized, bot_display_name_sanitized,
      pending_update_count, last_safe_error_code, last_checked_at,
      last_update_at, last_outbound_at, connected_at, created_at, updated_at,
      last_health_update_at
    ) VALUES
      ('integration_tg_a', 'integration_public_tg_a', 'webhook_public_tg_a', 'shop_backfill_a', 'active', 'verified',
       NULL, 'bot-1001', '@bot_a', 'Bot A', 0, NULL, '${NOW}', '${NOW}', '${NOW}', '${NOW}', '${NOW}', '${NOW}', '${NOW}'),
      ('integration_tg_b', 'integration_public_tg_b', 'webhook_public_tg_b', 'shop_backfill_b', 'degraded', 'mismatch',
       NULL, 'bot-1002', '@bot_b', 'Bot B', 1, 'telegram_provider_error', '${NOW}', '${NOW}', NULL, '${NOW}', '${NOW}', '${NOW}', NULL),
      ('integration_tg_c', 'integration_public_tg_c', 'webhook_public_tg_c', 'shop_backfill_c', 'disabled', 'disabled',
       NULL, 'bot-1003', '@bot_c', 'Bot C', 0, NULL, '${NOW}', NULL, NULL, '${NOW}', '${NOW}', '${NOW}', NULL),
      ('integration_tg_d', 'integration_public_tg_d', 'webhook_public_tg_d', 'shop_backfill_d', 'error', 'error',
       NULL, 'bot-1004', '@bot_d', 'Bot D', 0, 'x', '${NOW}', NULL, NULL, NULL, '${NOW}', '${NOW}', NULL),
      ('integration_tg_e', 'integration_public_tg_e', 'webhook_public_tg_e', 'shop_backfill_e', 'pending', 'pending',
       NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, '${NOW}', '${NOW}', NULL);
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, total_minor,
      currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, created_at, updated_at
    ) VALUES
      ('order_backfill_tg_a', 'order_public_backfill_tg_a', 'shop_backfill_a', 'A-1', 'telegram', 'pending_payment', 'unpaid', 'reserved', 1000, 1000, 'VND', 'vi', 'subject-a', 'token-a', '${NOW}', '${NOW}', '${NOW}'),
      ('order_backfill_tg_b', 'order_public_backfill_tg_b', 'shop_backfill_b', 'B-1', 'telegram', 'pending_payment', 'unpaid', 'reserved', 1000, 1000, 'VND', 'vi', 'subject-b', 'token-b', '${NOW}', '${NOW}', '${NOW}'),
      ('order_backfill_web_a', 'order_public_backfill_web_a', 'shop_backfill_a', 'A-2', 'web', 'pending_payment', 'unpaid', 'reserved', 1000, 1000, 'VND', 'vi', 'subject-web', 'token-web', '${NOW}', '${NOW}', '${NOW}');
    INSERT INTO order_channel_attributions (
      shop_id, order_id, channel_code, adapter_version, connection_id, created_at
    ) VALUES
      ('shop_backfill_a', 'order_backfill_tg_a', 'telegram', 1, NULL, '${NOW}'),
      ('shop_backfill_b', 'order_backfill_tg_b', 'telegram', 1, NULL, '${NOW}'),
      ('shop_backfill_a', 'order_backfill_web_a', 'website', 1, NULL, '${NOW}');
  `);
  return database;
}

describe("Telegram generic connection backfill", () => {
  it("projects every legacy integration, preserves legacy data, fills Telegram attribution and is rerunnable", () => {
    const database = createDatabase();
    const legacyBefore = database.prepare(`
      SELECT id, shop_id AS shopId, status, bot_id AS botId,
        last_safe_error_code AS lastSafeErrorCode, created_at AS createdAt, updated_at AS updatedAt
      FROM telegram_integrations ORDER BY id
    `).all();

    applyMigration(database);
    const projectionAfterFirstRun = database.prepare(`
      SELECT shop_id AS shopId, channel_code AS channelCode, status, id
      FROM shop_channels ORDER BY shopId
    `).all();
    const connectionsAfterFirstRun = database.prepare(`
      SELECT id, public_id AS publicId, shop_id AS shopId, shop_channel_id AS shopChannelId,
        provider_code AS providerCode, external_account_id AS externalAccountId,
        display_name_sanitized AS displayName, status, last_safe_error_code AS lastSafeErrorCode,
        last_health_at AS lastHealthAt, connected_at AS connectedAt, disconnected_at AS disconnectedAt,
        settings_json AS settingsJson
      FROM channel_connections ORDER BY shopId
    `).all();

    expect(projectionAfterFirstRun).toEqual([
      { channelCode: "telegram", id: "shop_channel_existing_a", shopId: "shop_backfill_a", status: "enabled" },
      { channelCode: "telegram", id: "integration_tg_b", shopId: "shop_backfill_b", status: "enabled" },
      { channelCode: "telegram", id: "integration_tg_c", shopId: "shop_backfill_c", status: "disabled" },
      { channelCode: "telegram", id: "integration_tg_d", shopId: "shop_backfill_d", status: "pending" },
      { channelCode: "telegram", id: "integration_tg_e", shopId: "shop_backfill_e", status: "pending" },
    ]);
    expect(connectionsAfterFirstRun).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "integration_tg_a", shopId: "shop_backfill_a", shopChannelId: "shop_channel_existing_a", providerCode: "telegram", externalAccountId: "bot-1001", status: "active", displayName: "Bot A", settingsJson: "{}" }),
      expect.objectContaining({ id: "integration_tg_b", shopId: "shop_backfill_b", externalAccountId: "bot-1002", status: "degraded", lastSafeErrorCode: "telegram_provider_error", lastHealthAt: NOW }),
      expect.objectContaining({ id: "integration_tg_c", shopId: "shop_backfill_c", status: "disconnected", disconnectedAt: NOW }),
      expect.objectContaining({ id: "integration_tg_d", shopId: "shop_backfill_d", externalAccountId: null, status: "pending", lastSafeErrorCode: "telegram_legacy_error" }),
      expect.objectContaining({ id: "integration_tg_e", shopId: "shop_backfill_e", status: "pending" }),
    ]));
    expect(database.prepare(`
      SELECT shop_id AS shopId, order_id AS orderId, connection_id AS connectionId
      FROM order_channel_attributions ORDER BY shopId, orderId
    `).all()).toEqual([
      { connectionId: "integration_tg_a", orderId: "order_backfill_tg_a", shopId: "shop_backfill_a" },
      { connectionId: null, orderId: "order_backfill_web_a", shopId: "shop_backfill_a" },
      { connectionId: "integration_tg_b", orderId: "order_backfill_tg_b", shopId: "shop_backfill_b" },
    ]);
    expect(database.prepare(`
      SELECT id, shop_id AS shopId, status, bot_id AS botId,
        last_safe_error_code AS lastSafeErrorCode, created_at AS createdAt, updated_at AS updatedAt
      FROM telegram_integrations ORDER BY id
    `).all()).toEqual(legacyBefore);

    applyMigration(database);
    expect(database.prepare(`
      SELECT shop_id AS shopId, channel_code AS channelCode, status, id
      FROM shop_channels ORDER BY shopId
    `).all()).toEqual(projectionAfterFirstRun);
    expect(database.prepare(`
      SELECT id, public_id AS publicId, shop_id AS shopId, shop_channel_id AS shopChannelId,
        provider_code AS providerCode, external_account_id AS externalAccountId,
        display_name_sanitized AS displayName, status, last_safe_error_code AS lastSafeErrorCode,
        last_health_at AS lastHealthAt, connected_at AS connectedAt, disconnected_at AS disconnectedAt,
        settings_json AS settingsJson
      FROM channel_connections ORDER BY shopId
    `).all()).toEqual(connectionsAfterFirstRun);
  });

  it("fails closed on a cross-tenant deterministic connection-id collision", () => {
    const database = createDatabase();
    database.exec(`
      INSERT INTO shop_channels (
        id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
      ) VALUES ('shop_channel_collision_b', 'shop_backfill_b', 'telegram', 'enabled', '{}', 1, '${NOW}', '${NOW}');
      INSERT INTO channel_connections (
        id, public_id, shop_id, shop_channel_id, provider_code,
        status, settings_json, version, created_at, updated_at
      ) VALUES (
        'integration_tg_a', 'connection_collision_b', 'shop_backfill_b',
        'shop_channel_collision_b', 'telegram', 'disconnected', '{}', 1, '${NOW}', '${NOW}'
      );
    `);

    expect(() => {
      applyMigration(database);
    }).toThrow();
    expect(database.prepare("SELECT COUNT(*) AS count FROM channel_connections WHERE shop_id = 'shop_backfill_a'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT connection_id AS connectionId FROM order_channel_attributions WHERE order_id = 'order_backfill_tg_a'").get()).toEqual({ connectionId: null });
    expect(database.prepare("SELECT shop_id AS shopId FROM channel_connections WHERE id = 'integration_tg_a'").get()).toEqual({ shopId: "shop_backfill_b" });
  });
});
