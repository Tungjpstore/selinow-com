import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-07-30T00:00:00.000Z";
const HASH = "a".repeat(43);
const HASH_B = "b".repeat(43);
const HASH_C = "c".repeat(43);
const HASH_D = "d".repeat(43);
const HASH_E = "e".repeat(43);
const HASH_F = "f".repeat(43);
const HASH_G = "g".repeat(43);
const databases: DatabaseSync[] = [];

function createDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  return database;
}

function seedPaymentGraph(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-a', 'a@example.test', 'A', 'active', '${NOW}', '${NOW}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES ('shop-a', 'shop-public-a', 'shop-a', 'A', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}'),
      ('shop-b', 'shop-public-b', 'shop-b', 'B', 'active', 'en', 'USD', 'UTC', 1, '${NOW}', '${NOW}');
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status, payment_status,
      fulfillment_status, subtotal_minor, discount_minor, total_minor, currency,
      locale, checkout_subject_hash, order_token_hash, expires_at, paid_at,
      created_at, updated_at
    ) VALUES ('order-a', 'order-public-a', 'shop-a', 'A-1', 'web', 'processing', 'paid',
      'unfulfilled', 1000, 0, 1000, 'USD', 'en', 'subject-a', '${HASH}', '${NOW}', '${NOW}', '${NOW}', '${NOW}');
    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status, webhook_status,
      created_at, updated_at
    ) VALUES ('integration-a', 'integration-public-a', 'webhook-a', 'shop-a', 'payos', 'active', 'verified', '${NOW}', '${NOW}');
    INSERT INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
      api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
      credential_fingerprint, created_by_user_id, created_at
    ) VALUES ('credential-a', 'shop-a', 'integration-a', 'payos', 'active', 1, 'v1',
      'cipher', 'iv', 'cipher', 'iv', 'cipher', 'iv', 'fingerprint-a', 'user-a', '${NOW}');
    INSERT INTO payment_attempts (
      id, public_id, shop_id, order_id, integration_id, credential_id, provider,
      provider_order_code, state, expected_amount_minor, currency, expected_description,
      expires_at, created_at, updated_at
    ) VALUES ('attempt-a', 'attempt-public-a', 'shop-a', 'order-a', 'integration-a',
      'credential-a', 'payos', 70001, 'paid_exact', 1000, 'USD', 'A', '${NOW}', '${NOW}', '${NOW}');
    INSERT INTO payment_events (
      id, shop_id, payment_attempt_id, integration_id, provider,
      provider_event_reference, payload_hash, signature_verified, normalized_state,
      process_result, received_at, processed_at
    ) VALUES ('event-a', 'shop-a', 'attempt-a', 'integration-a', 'payos', 'ref-a',
      'payload-a', 1, 'paid_exact', 'fulfilled', '${NOW}', '${NOW}');
    UPDATE payment_attempts SET paid_event_id = 'event-a' WHERE id = 'attempt-a';
  `);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("0048 payment reversal migration", () => {
  it("adds a tenant-bound immutable, hash-only reversal ledger", () => {
    const database = createDatabase();
    seedPaymentGraph(database);
    const columns = database.prepare("PRAGMA table_info(payment_reversal_events)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      "provider_reference", "payload_json", "provider_secret", "request_id",
    ]));
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_payment_reversal_events_shop_order'").get()).toEqual({ name: "idx_payment_reversal_events_shop_order" });

    database.prepare(`
      INSERT INTO payment_reversal_events (
        id, shop_id, order_id, payment_attempt_id, integration_id, credential_id,
        credential_version, original_payment_event_id, provider, reversal_kind,
        decision, verification_method, evidence_verified, amount_minor,
        expected_amount_minor, currency, expected_currency, provider_reference_hash,
        provider_reference_hash_key_version, evidence_hash, idempotency_key_hash,
        request_hash, reason_code, occurred_at, created_at
      ) VALUES ('reversal-a', 'shop-a', 'order-a', 'attempt-a', 'integration-a',
        'credential-a', 1, 'event-a', 'payos', 'refund', 'full_refund',
        'signed_webhook', 1, 1000, 1000, 'USD', 'USD', ?,
        'identifier-hmac-v1', ?, ?, ?, 'payment_full_refund', ?, ?)
    `).run(HASH, HASH, HASH, HASH, NOW, NOW);

    expect(() => database.prepare("UPDATE payment_reversal_events SET decision = 'manual_review' WHERE id = 'reversal-a'").run()).toThrow("payment_reversal_event_immutable");
    expect(() => database.prepare("DELETE FROM payment_reversal_events WHERE id = 'reversal-a'").run()).toThrow("payment_reversal_event_immutable");
    expect(() => database.prepare(`
      INSERT INTO payment_reversal_events (
        id, shop_id, order_id, payment_attempt_id, integration_id, credential_id,
        credential_version, original_payment_event_id, provider, reversal_kind,
        decision, verification_method, evidence_verified, amount_minor,
        expected_amount_minor, currency, expected_currency, provider_reference_hash,
        provider_reference_hash_key_version, evidence_hash, idempotency_key_hash,
        request_hash, reason_code, occurred_at, created_at
      ) SELECT 'reversal-cross', 'shop-b', order_id, payment_attempt_id, integration_id,
        credential_id, 1, original_payment_event_id, 'payos', 'refund', 'full_refund',
        'signed_webhook', 1, 1000, 1000, 'USD', 'USD', ?, 'identifier-hmac-v1',
        ?, ?, ?, 'payment_full_refund', ?, ?
      FROM payment_reversal_events WHERE id = 'reversal-a'
    `).run(HASH, HASH, HASH, HASH, NOW, NOW)).toThrow(/FOREIGN KEY|payment_reversal_scope_mismatch/u);
  });

  it("rejects invalid reversal scope and decision combinations at the database boundary", () => {
    const database = createDatabase();
    seedPaymentGraph(database);
    const insert = (input: {
      amount?: number;
      credentialVersion?: number;
      currency?: string;
      decision?: string;
      hash: string;
      id: string;
      kind?: string;
      originalPaymentEventId?: string;
      reason?: string;
    }) => database.prepare(`
      INSERT INTO payment_reversal_events (
        id, shop_id, order_id, payment_attempt_id, integration_id, credential_id,
        credential_version, original_payment_event_id, provider, reversal_kind,
        decision, verification_method, evidence_verified, amount_minor,
        expected_amount_minor, currency, expected_currency, provider_reference_hash,
        provider_reference_hash_key_version, evidence_hash, idempotency_key_hash,
        request_hash, reason_code, occurred_at, created_at
      ) VALUES (?, 'shop-a', 'order-a', 'attempt-a', 'integration-a', 'credential-a',
        ?, ?, 'payos', ?, ?, 'signed_webhook', 1, ?, 1000, ?, 'USD', ?,
        'identifier-hmac-v1', ?, ?, ?, ?, ?, ?)
    `).run(
      input.id,
      input.credentialVersion ?? 1,
      input.originalPaymentEventId ?? "event-a",
      input.kind ?? "refund",
      input.decision ?? "full_refund",
      input.amount ?? 1000,
      input.currency ?? "USD",
      input.hash,
      HASH,
      input.hash,
      input.hash,
      input.reason ?? "payment_full_refund",
      NOW,
      NOW,
    );

    expect(() => insert({ id: "bad-credential", credentialVersion: 2, hash: HASH_B })).toThrow("payment_reversal_scope_mismatch");
    expect(() => insert({ id: "bad-event", originalPaymentEventId: "missing-event", hash: HASH_C })).toThrow(/FOREIGN KEY|payment_reversal_scope_mismatch/u);
    expect(() => insert({ id: "bad-amount", amount: 999, hash: HASH_D })).toThrow(/CHECK/u);
    expect(() => insert({ id: "bad-currency", currency: "EUR", hash: HASH_E })).toThrow(/CHECK/u);
    expect(() => insert({ id: "bad-decision", decision: "settled", hash: HASH_F })).toThrow(/CHECK/u);
    expect(() => insert({ id: "bad-kind", kind: "void", hash: HASH_G })).toThrow(/CHECK/u);
  });
});
