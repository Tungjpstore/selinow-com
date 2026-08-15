import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const MIGRATION = "0097_telegram_action_generation_and_delivery_interlock.sql";
const NOW = "2026-08-13T00:00:00.000Z";

function applyThrough0097(database: DatabaseSync): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && name <= MIGRATION)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function seed(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-tg-rollback', 'tg-rollback@example.test', 'Owner', 'active', '${NOW}', '${NOW}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (
      'shop-tg-rollback', 'shop-public-tg-rollback', 'tg-rollback', 'Telegram Rollback',
      'active', 'en', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'
    );
    INSERT INTO telegram_integrations (
      id, public_id, webhook_public_id, shop_id, status, webhook_status,
      bot_id, created_at, updated_at
    ) VALUES (
      'integration-tg-rollback', 'integration-public-tg-rollback', 'webhook-tg-rollback',
      'shop-tg-rollback', 'active', 'verified', '111111111', '${NOW}', '${NOW}'
    );
    INSERT INTO telegram_credentials (
      id, shop_id, integration_id, status, version, key_version,
      bot_token_ciphertext_b64, bot_token_iv_b64,
      webhook_secret_ciphertext_b64, webhook_secret_iv_b64,
      token_fingerprint, webhook_secret_digest, activated_at,
      created_by_user_id, created_at
    ) VALUES
      ('credential-tg-rollback-1', 'shop-tg-rollback', 'integration-tg-rollback', 'active', 1, 'v1',
        'ciphertext-1', 'iv-1', 'secret-ciphertext-1', 'secret-iv-1',
        '${"a".repeat(64)}', '${"b".repeat(64)}', '${NOW}', 'user-tg-rollback', '${NOW}'),
      ('credential-tg-rollback-2', 'shop-tg-rollback', 'integration-tg-rollback', 'pending', 2, 'v1',
        'ciphertext-2', 'iv-2', 'secret-ciphertext-2', 'secret-iv-2',
        '${"c".repeat(64)}', '${"d".repeat(64)}', NULL, 'user-tg-rollback', '${NOW}');
    UPDATE telegram_integrations
    SET generation_state = 'draining'
    WHERE id = 'integration-tg-rollback';
    UPDATE telegram_integrations
    SET active_credential_id = 'credential-tg-rollback-1',
      integration_generation = integration_generation + 1,
      generation_state = 'active'
    WHERE id = 'integration-tg-rollback';
  `);
}

function oldRuntimeInsert(database: DatabaseSync, id: string, updateId: number, status = "processing"): void {
  database.prepare(`
    INSERT INTO telegram_updates (
      id, shop_id, integration_id, update_id, payload_hash, update_kind,
      status, attempts, received_at, updated_at
    ) VALUES (?, 'shop-tg-rollback', 'integration-tg-rollback', ?, ?, 'message', ?, 1, ?, ?)
  `).run(id, updateId, `hash-${String(updateId)}`, status, NOW, NOW);
}

function oldRuntimeAction(database: DatabaseSync, id: string, updateId: number): void {
  database.prepare(`
    INSERT INTO telegram_actions (
      id, shop_id, integration_id, update_id, action_kind, result_reference, created_at
    ) VALUES (?, 'shop-tg-rollback', 'integration-tg-rollback', ?, 'cart_quote:v1', ?, ?)
  `).run(id, updateId, `reference-${String(updateId)}`, NOW);
}

function oldRuntimeRotate(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    UPDATE telegram_credentials
    SET status = 'revoked', revoked_at = '${NOW}'
    WHERE integration_id = 'integration-tg-rollback'
      AND shop_id = 'shop-tg-rollback' AND status = 'active'
      AND id != 'credential-tg-rollback-2';
    UPDATE telegram_credentials
    SET status = 'active', activated_at = '${NOW}'
    WHERE id = 'credential-tg-rollback-2'
      AND integration_id = 'integration-tg-rollback'
      AND shop_id = 'shop-tg-rollback' AND status IN ('pending', 'error');
    UPDATE telegram_updates
    SET status = 'rejected', safe_result_code = 'telegram_update_stale_generation',
      processed_at = '${NOW}', updated_at = '${NOW}'
    WHERE integration_id = 'integration-tg-rollback'
      AND shop_id = 'shop-tg-rollback'
      AND status IN ('accepted', 'processing', 'failed');
    UPDATE telegram_integrations
    SET status = 'active', webhook_status = 'verified',
      active_credential_id = 'credential-tg-rollback-2', bot_id = '222222222',
      updated_at = '${NOW}'
    WHERE id = 'integration-tg-rollback' AND shop_id = 'shop-tg-rollback';
    COMMIT;
  `);
}

describe("Telegram pre-0095 runtime rollback compatibility", () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  function setup(): DatabaseSync {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON");
    applyThrough0097(database);
    seed(database);
    return database;
  }

  it("attributes an old-runtime update insert to the current credential generation", () => {
    const database = setup();
    oldRuntimeInsert(database, "update-old-runtime", 101);

    expect(database.prepare(`
      SELECT credential_id AS credentialId, integration_generation AS generation, status
      FROM telegram_updates WHERE id = 'update-old-runtime'
    `).get()).toEqual({ credentialId: "credential-tg-rollback-1", generation: 2, status: "processing" });
  });

  it("attributes an old-runtime action insert to the active generation and permits the update ID after rotation", () => {
    const database = setup();
    oldRuntimeAction(database, "action-old-runtime", 101);

    expect(database.prepare(`
      SELECT integration_generation AS generation
      FROM telegram_actions WHERE id = 'action-old-runtime'
    `).get()).toEqual({ generation: 2 });

    database.exec(`
      UPDATE telegram_integrations
      SET active_credential_id = 'credential-tg-rollback-2', updated_at = '${NOW}'
      WHERE id = 'integration-tg-rollback' AND shop_id = 'shop-tg-rollback';
      UPDATE telegram_credentials SET status = 'revoked', revoked_at = '${NOW}'
      WHERE id = 'credential-tg-rollback-1';
      UPDATE telegram_credentials SET status = 'active', activated_at = '${NOW}'
      WHERE id = 'credential-tg-rollback-2';
    `);
    oldRuntimeAction(database, "action-new-generation", 101);

    expect(database.prepare(`
      SELECT integration_generation AS generation
      FROM telegram_actions WHERE id = 'action-new-generation'
    `).get()).toEqual({ generation: 3 });
    // The legacy query has no generation predicate. The rotation trigger
    // archives the old receipt, leaving only the current-generation action in
    // telegram_actions; old Worker reads therefore cannot replay old-bot data.
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM telegram_actions
      WHERE integration_id = 'integration-tg-rollback' AND update_id = 101
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM telegram_action_history
      WHERE integration_id = 'integration-tg-rollback' AND update_id = 101
    `).get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT integration_generation AS generation
      FROM telegram_actions WHERE id = 'action-new-generation'
    `).get()).toEqual({ generation: 3 });
  });

  it("auto-fences an idle old-runtime credential switch and invalidates old-bot recipients", () => {
    const database = setup();
    database.exec(`
      INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at)
      VALUES ('customer-tg-rollback', 'shop-tg-rollback', NULL, 'Buyer', 'en', 'active', '${NOW}', '${NOW}');
      INSERT INTO customer_identities (id, shop_id, customer_id, provider, external_subject, verified_at, created_at, updated_at)
      VALUES ('identity-tg-rollback', 'shop-tg-rollback', 'customer-tg-rollback', 'telegram', 'subject-tg-rollback', '${NOW}', '${NOW}', '${NOW}');
      INSERT INTO telegram_recipients (
        id, shop_id, integration_id, customer_identity_id, key_version,
        chat_id_ciphertext_b64, chat_id_iv_b64, status, last_seen_at, created_at, updated_at
      ) VALUES (
        'recipient-tg-rollback', 'shop-tg-rollback', 'integration-tg-rollback', 'identity-tg-rollback',
        'v1', 'ciphertext', 'iv', 'active', '${NOW}', '${NOW}', '${NOW}'
      );
    `);

    expect(() => {
      oldRuntimeRotate(database);
    }).not.toThrow();
    expect(database.prepare(`
      SELECT active_credential_id AS credentialId, integration_generation AS generation,
        generation_state AS generationState
      FROM telegram_integrations WHERE id = 'integration-tg-rollback'
    `).get()).toEqual({ credentialId: "credential-tg-rollback-2", generation: 3, generationState: "active" });
    expect(database.prepare(`
      SELECT status, last_safe_error_code AS errorCode
      FROM telegram_recipients WHERE id = 'recipient-tg-rollback'
    `).get()).toEqual({ errorCode: "telegram_bot_generation_replaced", status: "unavailable" });
  });

  it("rolls back an old-runtime switch while the current generation is processing", () => {
    const database = setup();
    oldRuntimeInsert(database, "update-in-flight", 102);

    expect(() => {
      oldRuntimeRotate(database);
    }).toThrow(/telegram_integration_busy/u);
    expect(database.prepare(`
      SELECT active_credential_id AS credentialId, integration_generation AS generation
      FROM telegram_integrations WHERE id = 'integration-tg-rollback'
    `).get()).toEqual({ credentialId: "credential-tg-rollback-1", generation: 2 });
    expect(database.prepare("SELECT status FROM telegram_updates WHERE id = 'update-in-flight'").get())
      .toEqual({ status: "processing" });
    expect(database.prepare("SELECT status FROM telegram_credentials WHERE id = 'credential-tg-rollback-1'").get())
      .toEqual({ status: "active" });
  });
});
