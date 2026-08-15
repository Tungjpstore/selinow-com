import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const MIGRATION = "0095_telegram_generation_and_legacy_outbox_quarantine.sql";
const NOW = "2026-08-11T00:00:00.000Z";

function applyBefore0095(database: DatabaseSync): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name) && name < MIGRATION)
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function seed(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-tg-fence', 'tg-fence@example.test', 'Owner', 'active', '${NOW}', '${NOW}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (
      'shop-tg-fence', 'shop-public-tg-fence', 'tg-fence', 'Telegram Fence',
      'active', 'en', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}'
    );
    INSERT INTO telegram_integrations (
      id, public_id, webhook_public_id, shop_id, status, webhook_status,
      bot_id, created_at, updated_at
    ) VALUES (
      'integration-tg-fence', 'integration-public-tg-fence', 'webhook-tg-fence',
      'shop-tg-fence', 'active', 'verified', '111111111', '${NOW}', '${NOW}'
    );
    INSERT INTO telegram_credentials (
      id, shop_id, integration_id, status, version, key_version,
      bot_token_ciphertext_b64, bot_token_iv_b64,
      webhook_secret_ciphertext_b64, webhook_secret_iv_b64,
      token_fingerprint, webhook_secret_digest, activated_at,
      created_by_user_id, created_at
    ) VALUES (
      'credential-tg-fence-1', 'shop-tg-fence', 'integration-tg-fence', 'active', 1, 'v1',
      'ciphertext', 'iv', 'secret-ciphertext', 'secret-iv',
      '${"a".repeat(64)}', '${"b".repeat(64)}', '${NOW}', 'user-tg-fence', '${NOW}'
    );
    UPDATE telegram_integrations
    SET active_credential_id = 'credential-tg-fence-1'
    WHERE id = 'integration-tg-fence';
    INSERT INTO outbox_jobs (
      id, shop_id, kind, aggregate_type, aggregate_id, status, attempts,
      next_attempt_at, lease_token, lease_expires_at, created_at, updated_at
    ) VALUES (
      'legacy-before-0095', 'shop-tg-fence', 'order_paid', 'order', 'order-before-0095',
      'processing', 1, '${NOW}', 'legacy-lease', '2099-01-01T00:00:00.000Z', '${NOW}', '${NOW}'
    );
  `);
}

describe("Telegram generation and legacy outbox migration", () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it("quarantines historical and future legacy order-paid rows without rejecting old inserts", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON");
    applyBefore0095(database);
    seed(database);

    const applyMigration = () => { database.exec(readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8")); };
    expect(applyMigration).not.toThrow();
    expect(database.prepare(`
      SELECT status, lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
        last_safe_error_code AS errorCode
      FROM outbox_jobs WHERE id = 'legacy-before-0095'
    `).get()).toEqual({
      errorCode: "telegram_legacy_notification_superseded",
      leaseExpiresAt: null,
      leaseToken: null,
      status: "completed",
    });

    expect(() => database.prepare(`
      INSERT INTO outbox_jobs (
        id, shop_id, kind, aggregate_type, aggregate_id, status, attempts,
        next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, 'order_paid', 'order', ?, 'pending', 0, ?, ?, ?)
    `).run("legacy-after-0095", "shop-tg-fence", "order-after-0095", NOW, NOW, NOW)).not.toThrow();
    expect(database.prepare(`
      SELECT status, last_safe_error_code AS errorCode
      FROM outbox_jobs WHERE id = 'legacy-after-0095'
    `).get()).toEqual({
      errorCode: "telegram_legacy_notification_superseded",
      status: "completed",
    });
  });

  it("requires generation-aware credential switches and binds update receipts to a generation", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    database.exec("PRAGMA foreign_keys = ON");
    applyBefore0095(database);
    seed(database);
    database.exec(readFileSync(join(process.cwd(), "migrations", MIGRATION), "utf8"));

    database.prepare(`
      INSERT INTO telegram_credentials (
        id, shop_id, integration_id, status, version, key_version,
        bot_token_ciphertext_b64, bot_token_iv_b64,
        webhook_secret_ciphertext_b64, webhook_secret_iv_b64,
        token_fingerprint, webhook_secret_digest, created_by_user_id, created_at
      ) VALUES (?, 'shop-tg-fence', 'integration-tg-fence', 'pending', 2, 'v1',
        'ciphertext-2', 'iv-2', 'secret-ciphertext-2', 'secret-iv-2', ?, ?,
        'user-tg-fence', ?)
    `).run("credential-tg-fence-2", "c".repeat(64), "d".repeat(64), NOW);

    expect(() => database.prepare(`
      UPDATE telegram_integrations
      SET active_credential_id = 'credential-tg-fence-2'
      WHERE id = 'integration-tg-fence'
    `).run()).toThrow(/telegram_generation_required/u);

    expect(() => database.prepare(`
      INSERT INTO telegram_updates (
        id, shop_id, integration_id, credential_id, integration_generation,
        update_id, payload_hash, update_kind, status, attempts, received_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'message', 'processing', 1, ?, ?)
    `).run(
      "update-tg-fence",
      "shop-tg-fence",
      "integration-tg-fence",
      "credential-tg-fence-1",
      1,
      100,
      "payload-hash",
      NOW,
      NOW,
    )).not.toThrow();
  });
});
