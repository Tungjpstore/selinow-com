import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it, vi } from "vitest";

import { toBase64Url } from "../../src/lib/core/ids";
import { applyVerifiedPaymentReversal } from "../../src/lib/commerce/payment-reversal";
import { encryptInventoryKey } from "../../src/lib/crypto/inventory";
import { encryptTelegramCredential } from "../../src/lib/telegram/crypto";
import {
  applyDeletionLegalHold,
  cancelShopDeletion,
  getShopDeletion,
  listActiveDeletionRequests,
  requestShopDeletion,
  resumeShopDeletion,
} from "../../src/lib/operations/deletion";
import {
  consumeDataExportDownload,
  createDataExport,
  decodeExportJson,
  purgeExpiredDataExports,
} from "../../src/lib/operations/exports";
import type { AppBindings } from "../../src/lib/platform/bindings";

const SHOP_ID = "shop-a";
const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const OTHER_SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000010";
const USER_ID = "user-a";
const V1_KEK = toBase64Url(new Uint8Array(32));
const V2_KEK = toBase64Url(new Uint8Array(32).fill(1));
const NOW = new Date("2026-01-01T00:00:00.000Z");
const AFTER_GRACE = new Date("2026-02-15T00:00:00.000Z");

type BoundStatement = {
  all: () => Promise<unknown>;
  first: () => Promise<unknown>;
  run: () => Promise<unknown>;
  sql: string;
};

function createD1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      return {
        bind(...values: unknown[]): BoundStatement {
          const sqlValues = values as SQLInputValue[];
          return {
            all() {
              return Promise.resolve({
                meta: {},
                results: statement.all(...sqlValues),
                success: true,
              });
            },
            first() {
              return Promise.resolve(statement.get(...sqlValues) ?? null);
            },
            run() {
              const result = statement.run(...sqlValues);
              return Promise.resolve({
                meta: { changes: Number(result.changes) },
                results: [],
                success: true,
              });
            },
            sql,
          };
        },
      };
    },
    async batch(statements: BoundStatement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

function applyMigrations(database: DatabaseSync): void {
  const directory = resolve(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(resolve(directory, filename), "utf8"));
  }
}

function seedTenant(database: DatabaseSync): void {
  const nowIso = NOW.toISOString();
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-a', 'legacy_test', 'Legacy Test', '{}', '{}', '${nowIso}', '${nowIso}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('${USER_ID}', 'owner@example.test', 'Owner', 'active', '${nowIso}', '${nowIso}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      canonical_domain_id, readiness_version, created_at, updated_at
    ) VALUES (
      '${SHOP_ID}', '${SHOP_PUBLIC_ID}', 'alpha-shop', 'Alpha Shop', 'active',
      'vi', 'VND', 'Asia/Ho_Chi_Minh', 'domain-platform', 1, '${nowIso}', '${nowIso}'
    );
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('${SHOP_ID}', '${USER_ID}', 'owner', 'active', '${nowIso}', '${nowIso}');
    INSERT INTO shop_settings (
      shop_id, branding_json, storefront_json, order_expiry_minutes,
      low_stock_threshold, version, updated_at
    ) VALUES ('${SHOP_ID}', '{}', '{}', 30, 5, 1, '${nowIso}');
    INSERT INTO shop_subscriptions (
      id, shop_id, plan_id, state, current_period_start, current_period_end,
      created_at, updated_at
    ) VALUES (
      'subscription-a', '${SHOP_ID}', 'plan-a', 'active', '${nowIso}',
      '2027-01-01T00:00:00.000Z', '${nowIso}', '${nowIso}'
    );
    INSERT INTO shop_domains (
      id, shop_id, hostname_normalized, type, status, is_primary,
      validation_metadata_json, dns_status, version, activated_at, created_at, updated_at
    ) VALUES (
      'domain-platform', '${SHOP_ID}', 'alpha-shop.example.test', 'platform_subdomain',
      'active', 1, '{}', 'active', 1, '${nowIso}', '${nowIso}', '${nowIso}'
    );
  `);
}

function seedOtherTenant(database: DatabaseSync): void {
  const nowIso = NOW.toISOString();
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-b', 'other@example.test', 'Other Owner', 'active', '${nowIso}', '${nowIso}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      canonical_domain_id, readiness_version, created_at, updated_at
    ) VALUES (
      'shop-b', '${OTHER_SHOP_PUBLIC_ID}', 'beta-shop', 'Beta Shop', 'active',
      'vi', 'VND', 'Asia/Ho_Chi_Minh', 'domain-beta', 1, '${nowIso}', '${nowIso}'
    );
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('shop-b', 'user-b', 'owner', 'active', '${nowIso}', '${nowIso}');
    INSERT INTO shop_settings (
      shop_id, branding_json, storefront_json, order_expiry_minutes,
      low_stock_threshold, version, updated_at
    ) VALUES ('shop-b', '{}', '{}', 30, 5, 1, '${nowIso}');
    INSERT INTO shop_subscriptions (
      id, shop_id, plan_id, state, current_period_start, current_period_end,
      created_at, updated_at
    ) VALUES (
      'subscription-b', 'shop-b', 'plan-a', 'active', '${nowIso}',
      '2027-01-01T00:00:00.000Z', '${nowIso}', '${nowIso}'
    );
    INSERT INTO shop_domains (
      id, shop_id, hostname_normalized, type, status, is_primary,
      validation_metadata_json, dns_status, version, activated_at, created_at, updated_at
    ) VALUES (
      'domain-beta', 'shop-b', 'beta-shop.example.test', 'platform_subdomain',
      'active', 1, '{}', 'active', 1, '${nowIso}', '${nowIso}', '${nowIso}'
    );
  `);
}

function seedPlatformAdmin(database: DatabaseSync, role: "owner" | "risk" | "support" = "risk"): void {
  const nowIso = NOW.toISOString();
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('admin-a', 'admin@example.test', 'Admin', 'active', '${nowIso}', '${nowIso}');
    UPDATE platform_users SET two_factor_enabled = 1, two_factor_enabled_at = '${nowIso}'
    WHERE id = 'admin-a';
    INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
    VALUES ('admin-a', '${role}', 'active', '${nowIso}', '${nowIso}');
  `);
}

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly deleteAttempts = new Map<string, number>();
  readonly deleteFailures = new Map<string, number>();
  beforeDelete: ((key: string) => Promise<void>) | null = null;

  failNextDelete(key: string, count = 1): void {
    this.deleteFailures.set(key, count);
  }

  bucket(): R2Bucket {
    return {
      delete: async (key: string) => {
        this.deleteAttempts.set(key, (this.deleteAttempts.get(key) ?? 0) + 1);
        const failures = this.deleteFailures.get(key) ?? 0;
        if (failures > 0) {
          this.deleteFailures.set(key, failures - 1);
          throw new Error(`simulated_media_failure:${key}`);
        }
        await this.beforeDelete?.(key);
        this.objects.delete(key);
      },
      get: (key: string) => {
        const value = this.objects.get(key);
        if (value === undefined) return Promise.resolve(null);
        return Promise.resolve({
          arrayBuffer: () => Promise.resolve(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)),
        });
      },
      put: (key: string, value: Uint8Array<ArrayBuffer>) => {
        this.objects.set(key, new Uint8Array(value));
        return Promise.resolve({ httpEtag: `"${key}"` });
      },
    } as unknown as R2Bucket;
  }
}

function createRuntime(): { database: DatabaseSync; env: AppBindings; r2: MemoryR2 } {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  seedTenant(database);
  const r2 = new MemoryR2();
  const env = {
    ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
    ACTIVE_INVENTORY_KEY_VERSION: "v1",
    APP_ENV: "local",
    CLOUDFLARE_ZONE_ID: "zone-test",
    EXPORT_KEK_V1: V1_KEK,
    EXPORT_KEY_VERSION: "v1",
    CREDENTIAL_KEK_V1: V1_KEK,
    IDENTIFIER_HMAC_SECRET: "identifier-secret",
    INVENTORY_KEK_V1: V1_KEK,
    INVENTORY_KEK_V2: V2_KEK,
    MEDIA: r2.bucket(),
    PLATFORM_DB: createD1(database),
    PRIVATE_EXPORTS: r2.bucket(),
    SESSION_SECRET: "session-secret",
  } as unknown as AppBindings;
  return { database, env, r2 };
}

function seedPrivateDownload(runtime: { database: DatabaseSync; r2: MemoryR2 }): {
  assetId: string;
  assetVersionId: string;
  entitlementId: string;
  grantId: string;
  objectKey: string;
} {
  const nowIso = NOW.toISOString();
  const objectKey = `private-digital-assets/${SHOP_ID}/asset-private/version-private`;
  runtime.r2.objects.set(objectKey, new TextEncoder().encode("private-content"));
  runtime.database.exec(`
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES (
      'product-private', '${SHOP_ID}', 'private-product', 'Private Product', '', 'active',
      'manual', 1, '${nowIso}', '${nowIso}'
    );
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      currency, min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES (
      'variant-private', '${SHOP_ID}', 'product-private', 'PRIVATE-SKU', 'Default', '{}', 100,
      'VND', 1, 1, 'active', 1, '${nowIso}', '${nowIso}'
    );
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status, payment_status,
      fulfillment_status, subtotal_minor, discount_minor, total_minor, currency,
      locale, checkout_subject_hash, order_token_hash, expires_at, paid_at,
      created_at, updated_at
    ) VALUES (
      'order-private', 'order_00000000-0000-4000-8000-000000000099', '${SHOP_ID}',
      'PRIVATE-1', 'web', 'processing', 'paid', 'fulfilled', 100, 0, 100, 'VND', 'vi',
      'private-subject', '${"b".repeat(43)}', '2027-01-01T00:00:00.000Z', '${nowIso}',
      '${nowIso}', '${nowIso}'
    );
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title, variant_title,
      sku, unit_price_minor, quantity, line_total_minor, fulfillment_type, created_at
    ) VALUES (
      'order-item-private', '${SHOP_ID}', 'order-private', 'product-private', 'variant-private',
      'Private Product', 'Default', 'PRIVATE-SKU', 100, 1, 100, 'manual', '${nowIso}'
    );
    INSERT INTO digital_assets (
      id, shop_id, kind, status, created_by_user_id, created_at, updated_at
    ) VALUES ('asset-private', '${SHOP_ID}', 'private_file', 'active', '${USER_ID}', '${nowIso}', '${nowIso}');
    INSERT INTO digital_asset_versions (
      id, shop_id, asset_id, version, object_key, filename_sanitized, content_type,
      byte_size, content_sha256, object_etag, status, created_by_user_id, created_at, updated_at
    ) VALUES (
      'version-private', '${SHOP_ID}', 'asset-private', 1, '${objectKey}', 'private.txt',
      'text/plain', 15, '${"c".repeat(43)}', 'etag-private', 'active', '${USER_ID}', '${nowIso}', '${nowIso}'
    );
    INSERT INTO product_fulfillment_policies (
      id, shop_id, product_id, capability, policy_version, asset_version_id,
      max_downloads, grant_ttl_seconds, entitlement_ttl_seconds, status,
      created_by_user_id, created_at, updated_at
    ) VALUES (
      'policy-private', '${SHOP_ID}', 'product-private', 'private_file', 1, 'version-private',
      3, 600, 3600, 'active', '${USER_ID}', '${nowIso}', '${nowIso}'
    );
    INSERT INTO order_item_fulfillment_requirements (
      id, shop_id, order_id, order_item_id, capability, policy_id, policy_version,
      asset_version_id, max_downloads, grant_ttl_seconds, entitlement_ttl_seconds, created_at
    ) VALUES (
      'requirement-private', '${SHOP_ID}', 'order-private', 'order-item-private', 'private_file',
      'policy-private', 1, 'version-private', 3, 600, 3600, '${nowIso}'
    );
    INSERT INTO digital_entitlements (
      id, shop_id, order_id, order_item_id, requirement_id, asset_version_id,
      buyer_binding_hash, status, max_downloads, download_count, access_expires_at,
      version, created_at, updated_at
    ) VALUES (
      'entitlement-private', '${SHOP_ID}', 'order-private', 'order-item-private',
      'requirement-private', 'version-private', '${"b".repeat(43)}', 'active', 3, 0,
      '2026-01-01T01:00:00.000Z', 1, '${nowIso}', '${nowIso}'
    );
    INSERT INTO delivery_grants (
      id, shop_id, entitlement_id, order_id, order_item_id, asset_version_id,
      buyer_binding_hash, token_nonce, token_hash, token_key_version, issuance_key_hash,
      request_hash, status, expires_at, version, created_at, updated_at
    ) VALUES (
      'grant-private', '${SHOP_ID}', 'entitlement-private', 'order-private', 'order-item-private',
      'version-private', '${"b".repeat(43)}', '${"d".repeat(43)}', '${"e".repeat(43)}',
      'identifier-hmac-v1', '${"f".repeat(43)}', '${"a".repeat(43)}', 'active',
      '2026-01-01T00:10:00.000Z',
      1, '${nowIso}', '${nowIso}'
    );
  `);
  return {
    assetId: "asset-private",
    assetVersionId: "version-private",
    entitlementId: "entitlement-private",
    grantId: "grant-private",
    objectKey,
  };
}

async function seedActiveTelegram(database: DatabaseSync): Promise<void> {
  const nowIso = NOW.toISOString();
  const encrypted = await encryptTelegramCredential({
    botToken: "123456789:abcdefghijklmnopqrstuvwxyzABCDE",
    credentialId: "telegram-credential-a",
    hmacSecret: "identifier-secret",
    integrationId: "telegram-integration-a",
    kek: V1_KEK,
    keyVersion: "v1",
    shopId: SHOP_ID,
    webhookSecret: "telegram-webhook-secret",
  });
  database.prepare(`
    INSERT INTO telegram_integrations (
      id, public_id, webhook_public_id, shop_id, status, webhook_status,
      active_credential_id, bot_id, bot_username_sanitized, bot_display_name_sanitized,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 'verified', ?, '123456789', 'alpha_bot', 'Alpha Bot', ?, ?)
  `).run(
    "telegram-integration-a",
    "tgint_00000000-0000-4000-8000-000000000001",
    "tgwh_00000000-0000-4000-8000-000000000001",
    SHOP_ID,
    "telegram-credential-a",
    nowIso,
    nowIso,
  );
  database.prepare(`
    INSERT INTO telegram_credentials (
      id, shop_id, integration_id, status, version, key_version,
      bot_token_ciphertext_b64, bot_token_iv_b64,
      webhook_secret_ciphertext_b64, webhook_secret_iv_b64,
      token_fingerprint, webhook_secret_digest, activated_at,
      created_by_user_id, created_at
    ) VALUES (?, ?, ?, 'active', 1, 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "telegram-credential-a",
    SHOP_ID,
    "telegram-integration-a",
    encrypted.botTokenCiphertextB64,
    encrypted.botTokenIvB64,
    encrypted.webhookSecretCiphertextB64,
    encrypted.webhookSecretIvB64,
    encrypted.tokenFingerprint,
    encrypted.webhookSecretDigest,
    nowIso,
    USER_ID,
    nowIso,
  );
}

async function seedInventory(database: DatabaseSync, values: { plaintext: string; version: "v1" | "v2" }[]): Promise<void> {
  const nowIso = NOW.toISOString();
  database.exec(`
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES (
      'product-a', '${SHOP_ID}', 'product-a', 'Product A', '', 'active',
      'license_key', 1, '${nowIso}', '${nowIso}'
    );
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      currency, min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES (
      'variant-a', '${SHOP_ID}', 'product-a', 'SKU-A', 'Default', '{}', 10000,
      'VND', 1, 10, 'active', 1, '${nowIso}', '${nowIso}'
    );
    INSERT INTO inventory_batches (
      id, shop_id, variant_id, source, total_count, accepted_count,
      rejected_count, created_by_user_id, created_at
    ) VALUES (
      'batch-a', '${SHOP_ID}', 'variant-a', 'paste', ${String(values.length)},
      ${String(values.length)}, 0, '${USER_ID}', '${nowIso}'
    );
  `);
  for (const [index, item] of values.entries()) {
    const encrypted = await encryptInventoryKey({
      hmacSecret: "identifier-secret",
      keyVersion: item.version,
      kek: item.version === "v1" ? V1_KEK : V2_KEK,
      plaintext: item.plaintext,
      shopId: SHOP_ID,
      variantId: "variant-a",
    });
    database.prepare(`
      INSERT INTO inventory_keys (
        id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64,
        key_version, key_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, 'available', ?, ?, ?, ?, ?)
    `).run(
      `inventory-${String(index + 1)}`,
      SHOP_ID,
      "variant-a",
      "batch-a",
      encrypted.ciphertextB64,
      encrypted.ivB64,
      encrypted.keyVersion,
      encrypted.fingerprint,
      nowIso,
    );
  }
}

function seedActivePayment(database: DatabaseSync): void {
  const nowIso = NOW.toISOString();
  database.exec(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel,
      status, payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, customer_email_masked, checkout_subject_hash,
      checkout_request_hash, order_token_hash, expires_at, created_at, updated_at
    ) VALUES (
      'order-a', 'order_00000000-0000-4000-8000-000000000002', '${SHOP_ID}', NULL,
      'ORDER-A', 'web', 'pending_payment', 'unpaid', 'unfulfilled', 10000, 0,
      10000, 'VND', 'vi', NULL, 'checkout-a', 'request-a', 'token-a',
      '2026-03-01T00:00:00.000Z', '${nowIso}', '${nowIso}'
    );
    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status,
      webhook_status, active_credential_id, provider_identity_fingerprint,
      created_at, updated_at
    ) VALUES (
      'payos-a', 'payos_00000000-0000-4000-8000-000000000003',
      'hook_00000000-0000-4000-8000-000000000004', '${SHOP_ID}', 'payos',
      'active', 'verified', NULL, 'provider-identity-a', '${nowIso}', '${nowIso}'
    );
    INSERT INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
      api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
      credential_fingerprint, provider_ownership_fingerprint, activated_at,
      created_by_user_id, created_at
    ) VALUES (
      'credential-a', '${SHOP_ID}', 'payos-a', 'payos', 'active', 1, 'v1',
      'cipher', 'iv', 'cipher', 'iv', 'cipher', 'iv', 'fingerprint-a',
      'provider-ownership-a',
      '${nowIso}', '${USER_ID}', '${nowIso}'
    );
    UPDATE payment_integrations SET active_credential_id = 'credential-a'
    WHERE id = 'payos-a' AND shop_id = '${SHOP_ID}';
    INSERT INTO payment_attempts (
      id, public_id, shop_id, order_id, integration_id, credential_id, provider,
      provider_order_code, state, expected_amount_minor, currency,
      expected_description, expires_at, checkout_domain_id, return_origin,
      cancel_origin, created_at, updated_at
    ) VALUES (
      'attempt-a', 'payment_00000000-0000-4000-8000-000000000005', '${SHOP_ID}',
      'order-a', 'payos-a', 'credential-a', 'payos', 123456, 'pending', 10000,
      'VND', 'SELINOW123456', '2026-03-01T00:00:00.000Z', 'domain-platform',
      'https://alpha-shop.example.test', 'https://alpha-shop.example.test',
      '${nowIso}', '${nowIso}'
    );
  `);
}

type PaidReversalFixture = {
  credentialId: string;
  evidenceHash: string;
  integrationId: string;
  orderId: string;
  orderPublicId: string;
  paymentAttemptId: string;
  paymentAttemptPublicId: string;
  paymentEventId: string;
  providerReference: string;
  shopId: string;
  suffix: "a" | "b";
};

function seedPaidReversalPayment(database: DatabaseSync, suffix: "a" | "b"): PaidReversalFixture {
  const fixture = suffix === "a"
    ? {
        credentialId: "credential-reversal-a",
        evidenceHash: "z".repeat(43),
        integrationId: "payos-reversal-a",
        orderId: "order-reversal-a",
        orderPublicId: "order_00000000-0000-4000-8000-000000000021",
        paymentAttemptId: "attempt-reversal-a",
        paymentAttemptPublicId: "payment_00000000-0000-4000-8000-000000000024",
        paymentEventId: "event-reversal-a",
        providerOrderCode: 223456,
        providerReference: "provider-reversal-reference-a",
        shopId: SHOP_ID,
        userId: USER_ID,
      }
    : {
        credentialId: "credential-reversal-b",
        evidenceHash: "y".repeat(43),
        integrationId: "payos-reversal-b",
        orderId: "order-reversal-b",
        orderPublicId: "order_00000000-0000-4000-8000-000000000031",
        paymentAttemptId: "attempt-reversal-b",
        paymentAttemptPublicId: "payment_00000000-0000-4000-8000-000000000034",
        paymentEventId: "event-reversal-b",
        providerOrderCode: 323456,
        providerReference: "provider-reversal-reference-b",
        shopId: "shop-b",
        userId: "user-b",
      };
  const nowIso = NOW.toISOString();
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, customer_id, order_number, source_channel,
      status, payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, customer_email_masked, checkout_subject_hash,
      checkout_request_hash, order_token_hash, expires_at, paid_at, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, 'web', 'processing', 'paid', 'unfulfilled',
      10000, 0, 10000, 'VND', 'vi', NULL, ?, ?, ?,
      '2026-03-01T00:00:00.000Z', ?, ?, ?)
  `).run(
    fixture.orderId,
    fixture.orderPublicId,
    fixture.shopId,
    `REVERSAL-${suffix.toUpperCase()}`,
    `checkout-reversal-${suffix}`,
    `checkout-request-reversal-${suffix}`,
    `order-token-reversal-${suffix}`,
    nowIso,
    nowIso,
    nowIso,
  );
  database.prepare(`
    INSERT INTO payment_integrations (
      id, public_id, webhook_public_id, shop_id, provider, status,
      webhook_status, active_credential_id, provider_identity_fingerprint,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'payos', 'active', 'verified', NULL, ?, ?, ?)
  `).run(
    fixture.integrationId,
    `payos_00000000-0000-4000-8000-0000000000${suffix === "a" ? "22" : "32"}`,
    `hook_00000000-0000-4000-8000-0000000000${suffix === "a" ? "23" : "33"}`,
    fixture.shopId,
    `provider-identity-reversal-${suffix}`,
    nowIso,
    nowIso,
  );
  database.prepare(`
    INSERT INTO payment_credentials (
      id, shop_id, integration_id, provider, status, version, key_version,
      client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
      api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
      credential_fingerprint, provider_ownership_fingerprint, activated_at,
      created_by_user_id, created_at
    ) VALUES (?, ?, ?, 'payos', 'active', 1, 'v1',
      'cipher', 'iv', 'cipher', 'iv', 'cipher', 'iv', ?, ?, ?, ?, ?)
  `).run(
    fixture.credentialId,
    fixture.shopId,
    fixture.integrationId,
    `credential-fingerprint-reversal-${suffix}`,
    `provider-ownership-reversal-${suffix}`,
    nowIso,
    fixture.userId,
    nowIso,
  );
  database.prepare(`
    UPDATE payment_integrations SET active_credential_id = ?
    WHERE id = ? AND shop_id = ?
  `).run(fixture.credentialId, fixture.integrationId, fixture.shopId);
  database.prepare(`
    INSERT INTO payment_attempts (
      id, public_id, shop_id, order_id, integration_id, credential_id, provider,
      provider_order_code, state, expected_amount_minor, currency,
      expected_description, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'payos', ?, 'paid_exact', 10000, 'VND', ?,
      '2026-03-01T00:00:00.000Z', ?, ?)
  `).run(
    fixture.paymentAttemptId,
    fixture.paymentAttemptPublicId,
    fixture.shopId,
    fixture.orderId,
    fixture.integrationId,
    fixture.credentialId,
    fixture.providerOrderCode,
    `SELINOW-REVERSAL-${suffix.toUpperCase()}`,
    nowIso,
    nowIso,
  );
  database.prepare(`
    INSERT INTO payment_events (
      id, shop_id, payment_attempt_id, integration_id, provider,
      provider_event_reference, payload_hash, signature_verified,
      normalized_state, process_result, received_at, processed_at
    ) VALUES (?, ?, ?, ?, 'payos', ?, ?, 1, 'paid_exact', 'fulfilled', ?, ?)
  `).run(
    fixture.paymentEventId,
    fixture.shopId,
    fixture.paymentAttemptId,
    fixture.integrationId,
    `paid-event-reference-${suffix}`,
    `paid-event-payload-${suffix}`,
    nowIso,
    nowIso,
  );
  database.prepare(`
    UPDATE payment_attempts SET paid_event_id = ?
    WHERE id = ? AND shop_id = ?
  `).run(fixture.paymentEventId, fixture.paymentAttemptId, fixture.shopId);
  return { ...fixture, suffix };
}

async function applyReversal(
  env: AppBindings,
  fixture: PaidReversalFixture,
  amountMinor = 10000,
): Promise<{ decision: string; reversalId: string }> {
  return applyVerifiedPaymentReversal({
    amountMinor,
    credentialId: fixture.credentialId,
    credentialVersion: 1,
    currency: "VND",
    env,
    evidenceHash: fixture.evidenceHash,
    idempotencyKey: `payment-reversal-idempotency-${fixture.suffix}-${String(amountMinor)}`,
    integrationId: fixture.integrationId,
    occurredAt: NOW.toISOString(),
    orderId: fixture.orderId,
    originalPaymentEventId: fixture.paymentEventId,
    paymentAttemptId: fixture.paymentAttemptId,
    provider: "payos",
    providerReference: `${fixture.providerReference}-${String(amountMinor)}`,
    requestId: `request-payment-reversal-${fixture.suffix}-${String(amountMinor)}`,
    reversalKind: "refund",
    shopId: fixture.shopId,
    verificationMethod: "signed_webhook",
    verified: true,
  });
}

function seedGenericPaymentConnection(
  database: DatabaseSync,
  input: { connectionId: string; publicId: string; shopId: string; suffix: string },
): string[] {
  const nowIso = NOW.toISOString();
  const fingerprint = `raw-provider-fingerprint-${input.suffix}`;
  const evidenceReference = `raw-provider-evidence-${input.suffix}`;
  database.prepare("UPDATE shops SET merchant_country_code = 'VN' WHERE id = ?").run(input.shopId);
  database.prepare(`
    INSERT INTO payment_provider_connections (
      id, public_id, shop_id, provider_code, provider_environment,
      provider_descriptor_version, capability_policy_version,
      connection_mode, settlement_mode, credential_ownership,
      merchant_country_code, provider_attested_country_code,
      provider_country_attested_at, status, webhook_status,
      provider_account_fingerprint, provider_account_verified_at,
      connected_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, 'futurepay', 'sandbox', 1, 1, 'bring_your_own',
      'direct', 'seller', 'VN', 'VN', ?, 'active', 'verified', ?, ?, ?, 1, ?, ?)
  `).run(
    input.connectionId,
    input.publicId,
    input.shopId,
    nowIso,
    fingerprint,
    nowIso,
    nowIso,
    nowIso,
    nowIso,
  );
  database.prepare(`
    INSERT INTO payment_provider_connection_capabilities (
      shop_id, connection_id, capability_code, provider_granted,
      effective_enabled, provider_descriptor_version,
      capability_policy_version, evidence_reference, granted_at, evaluated_at
    ) VALUES (?, ?, 'checkout.create', 1, 1, 1, 1, ?, ?, ?)
  `).run(input.shopId, input.connectionId, evidenceReference, nowIso, nowIso);
  database.prepare(`
    INSERT INTO payment_provider_connection_currencies (
      shop_id, connection_id, currency_code, provider_supported,
      effective_enabled, provider_descriptor_version,
      capability_policy_version, evidence_reference, evaluated_at
    ) VALUES (?, ?, 'VND', 1, 1, 1, 1, ?, ?)
  `).run(input.shopId, input.connectionId, evidenceReference, nowIso);
  database.prepare(`
    INSERT INTO payment_provider_connection_methods (
      shop_id, connection_id, method_code, provider_supported,
      effective_enabled, provider_descriptor_version,
      capability_policy_version, evidence_reference, evaluated_at
    ) VALUES (?, ?, 'bank_transfer_qr', 1, 1, 1, 1, ?, ?)
  `).run(input.shopId, input.connectionId, evidenceReference, nowIso);
  return [fingerprint, evidenceReference];
}

function seedProviderBackedCustomDomain(database: DatabaseSync): void {
  const nowIso = NOW.toISOString();
  database.prepare(`
    INSERT INTO shop_domains (
      id, shop_id, hostname_normalized, type, status, is_primary,
      validation_metadata_json, dns_status, cloudflare_hostname_id,
      hostname_status, ssl_status, ownership_verified_at,
      version, activated_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'custom', 'active', 0,
      json_object(
        'turnstile', json_object(
          'hostname', ?,
          'mode', 'operator_managed',
          'source', 'cloudflare_widget_domains',
          'status', 'active',
          'checkedAt', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )
      ),
      'active', ?, 'active', 'active', ?, 1, ?, ?, ?)
  `).run(
    "domain-custom-a",
    SHOP_ID,
    "custom.alpha.example.test",
    "custom.alpha.example.test",
    "cloudflare-hostname-a",
    nowIso,
    nowIso,
    nowIso,
    nowIso,
  );
}

function seedPrivateDownloadExportGraph(database: DatabaseSync): {
  filePlaintext: string;
  objectKey: string;
  sensitiveValues: string[];
} {
  const nowIso = NOW.toISOString();
  const consumedAt = "2026-01-01T00:01:00.000Z";
  const objectKey = "private-digital-assets/shop-a/das-export/dav-export-sensitive-object-key";
  const buyerBindingHash = "b".repeat(43);
  const tokenNonce = "n".repeat(43);
  const tokenHash = "t".repeat(43);
  const issuanceKeyHash = "i".repeat(43);
  const requestHash = "r".repeat(43);
  database.exec(`
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES (
      'product-private-export', '${SHOP_ID}', 'private-export', 'Private Export', '',
      'active', 'manual', 1, '${nowIso}', '${nowIso}'
    );
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      currency, min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES (
      'variant-private-export', '${SHOP_ID}', 'product-private-export',
      'PRIVATE-EXPORT', 'Default', '{}', 10000, 'VND', 1, 2, 'active', 1,
      '${nowIso}', '${nowIso}'
    );
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, paid_at, created_at, updated_at
    ) VALUES (
      'order-private-export', 'order_00000000-0000-4000-8000-000000000099',
      '${SHOP_ID}', 'PRIVATE-EXPORT', 'web', 'processing', 'paid', 'unfulfilled',
      10000, 0, 10000, 'VND', 'vi', 'private-export-subject',
      '${buyerBindingHash}', '2026-01-01T01:00:00.000Z', '${nowIso}', '${nowIso}', '${nowIso}'
    );
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title,
      variant_title, sku, unit_price_minor, quantity, line_total_minor,
      fulfillment_type, created_at
    ) VALUES (
      'order-item-private-export', '${SHOP_ID}', 'order-private-export',
      'product-private-export', 'variant-private-export', 'Private Export',
      'Default', 'PRIVATE-EXPORT', 10000, 1, 10000, 'manual', '${nowIso}'
    );
    INSERT INTO digital_assets (
      id, shop_id, kind, status, created_by_user_id, created_at, updated_at
    ) VALUES (
      'asset-private-export', '${SHOP_ID}', 'private_file', 'active',
      '${USER_ID}', '${nowIso}', '${nowIso}'
    );
    INSERT INTO digital_asset_versions (
      id, shop_id, asset_id, version, object_key, filename_sanitized,
      content_type, byte_size, content_sha256, object_etag, status,
      created_by_user_id, created_at, updated_at
    ) VALUES (
      'asset-version-private-export', '${SHOP_ID}', 'asset-private-export', 1,
      '${objectKey}', 'seller-guide.pdf', 'application/pdf', 36,
      '${"c".repeat(43)}', 'etag-private-export', 'active', '${USER_ID}',
      '${nowIso}', '${nowIso}'
    );
    INSERT INTO product_fulfillment_policies (
      id, shop_id, product_id, capability, policy_version, asset_version_id,
      max_downloads, grant_ttl_seconds, entitlement_ttl_seconds, status,
      created_by_user_id, created_at, updated_at
    ) VALUES (
      'policy-private-export', '${SHOP_ID}', 'product-private-export',
      'private_file', 1, 'asset-version-private-export', 2, 600, 3600,
      'active', '${USER_ID}', '${nowIso}', '${nowIso}'
    );
    INSERT INTO order_item_fulfillment_requirements (
      id, shop_id, order_id, order_item_id, capability, policy_id,
      policy_version, asset_version_id, max_downloads, grant_ttl_seconds,
      entitlement_ttl_seconds, created_at
    ) VALUES (
      'requirement-private-export', '${SHOP_ID}', 'order-private-export',
      'order-item-private-export', 'private_file', 'policy-private-export', 1,
      'asset-version-private-export', 2, 600, 3600, '${nowIso}'
    );
    INSERT INTO digital_entitlements (
      id, shop_id, order_id, order_item_id, requirement_id, asset_version_id,
      buyer_binding_hash, status, max_downloads, download_count,
      access_expires_at, version, created_at, updated_at
    ) VALUES (
      'entitlement-private-export', '${SHOP_ID}', 'order-private-export',
      'order-item-private-export', 'requirement-private-export',
      'asset-version-private-export', '${buyerBindingHash}', 'active', 2, 0,
      '2026-01-01T01:00:00.000Z', 1, '${nowIso}', '${nowIso}'
    );
    INSERT INTO delivery_grants (
      id, shop_id, entitlement_id, order_id, order_item_id, asset_version_id,
      buyer_binding_hash, token_nonce, token_hash, token_key_version,
      issuance_key_hash, request_hash, status, expires_at, version,
      created_at, updated_at
    ) VALUES (
      'grant-private-export', '${SHOP_ID}', 'entitlement-private-export',
      'order-private-export', 'order-item-private-export', 'asset-version-private-export',
      '${buyerBindingHash}', '${tokenNonce}', '${tokenHash}', 'identifier-hmac-v1',
      '${issuanceKeyHash}', '${requestHash}', 'active',
      '2026-01-01T00:10:00.000Z', 1, '${nowIso}', '${nowIso}'
    );
    INSERT INTO delivery_grant_consumptions (
      id, shop_id, entitlement_id, grant_id, order_id, asset_version_id,
      request_id, outcome, created_at
    ) VALUES (
      'consumption-private-export', '${SHOP_ID}', 'entitlement-private-export',
      'grant-private-export', 'order-private-export', 'asset-version-private-export',
      'request-private-export-consumption', 'served', '${consumedAt}'
    );
    UPDATE delivery_grants
    SET status = 'consumed', consumed_at = '${consumedAt}', version = 2,
      updated_at = '${consumedAt}'
    WHERE id = 'grant-private-export' AND shop_id = '${SHOP_ID}';
    UPDATE digital_entitlements
    SET download_count = 1, version = 2, updated_at = '${consumedAt}'
    WHERE id = 'entitlement-private-export' AND shop_id = '${SHOP_ID}';
  `);
  return {
    filePlaintext: "PRIVATE-FILE-PLAINTEXT-MUST-NOT-LEAK",
    objectKey,
    sensitiveValues: [buyerBindingHash, tokenNonce, tokenHash, issuanceKeyHash, requestHash],
  };
}

function seedGenericEntitlementGraph(database: DatabaseSync): {
  grantIds: string[];
  resourceIds: string[];
  policyIds: string[];
  entitlementIds: string[];
} {
  const nowIso = NOW.toISOString();
  const hash = (letter: string): string => letter.repeat(43);
  database.exec(`
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES
      ('product-entitlement-pending', '${SHOP_ID}', 'entitlement-pending', 'Entitlement Pending', '', 'active', 'manual', 1, '${nowIso}', '${nowIso}'),
      ('product-entitlement-active', '${SHOP_ID}', 'entitlement-active', 'Entitlement Active', '', 'active', 'manual', 1, '${nowIso}', '${nowIso}'),
      ('product-entitlement-suspended', '${SHOP_ID}', 'entitlement-suspended', 'Entitlement Suspended', '', 'active', 'manual', 1, '${nowIso}', '${nowIso}');
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      currency, min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES
      ('variant-entitlement-pending', '${SHOP_ID}', 'product-entitlement-pending', 'ENT-PENDING', 'Default', '{}', 100, 'VND', 1, 1, 'active', 1, '${nowIso}', '${nowIso}'),
      ('variant-entitlement-active', '${SHOP_ID}', 'product-entitlement-active', 'ENT-ACTIVE', 'Default', '{}', 0, 'VND', 1, 1, 'active', 1, '${nowIso}', '${nowIso}'),
      ('variant-entitlement-suspended', '${SHOP_ID}', 'product-entitlement-suspended', 'ENT-SUSPENDED', 'Default', '{}', 0, 'VND', 1, 1, 'active', 1, '${nowIso}', '${nowIso}');
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status, payment_status,
      fulfillment_status, subtotal_minor, discount_minor, total_minor, currency,
      locale, checkout_subject_hash, order_token_hash, expires_at, paid_at,
      created_at, updated_at
    ) VALUES
      ('order-entitlement-pending', 'order_00000000-0000-4000-8000-000000000111', '${SHOP_ID}', 'ENT-PENDING', 'web', 'pending_payment', 'unpaid', 'unfulfilled', 100, 0, 100, 'VND', 'vi', 'entitlement-pending-subject', '${hash("p")}', '2027-01-01T00:00:00.000Z', NULL, '${nowIso}', '${nowIso}'),
      ('order-entitlement-active', 'order_00000000-0000-4000-8000-000000000112', '${SHOP_ID}', 'ENT-ACTIVE', 'web', 'processing', 'paid', 'unfulfilled', 0, 0, 0, 'VND', 'vi', 'entitlement-active-subject', '${hash("a")}', '2027-01-01T00:00:00.000Z', '${nowIso}', '${nowIso}', '${nowIso}'),
      ('order-entitlement-suspended', 'order_00000000-0000-4000-8000-000000000113', '${SHOP_ID}', 'ENT-SUSPENDED', 'web', 'processing', 'paid', 'unfulfilled', 0, 0, 0, 'VND', 'vi', 'entitlement-suspended-subject', '${hash("s")}', '2027-01-01T00:00:00.000Z', '${nowIso}', '${nowIso}', '${nowIso}');
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title, variant_title,
      sku, unit_price_minor, quantity, line_total_minor, fulfillment_type, created_at
    ) VALUES
      ('order-item-entitlement-pending', '${SHOP_ID}', 'order-entitlement-pending', 'product-entitlement-pending', 'variant-entitlement-pending', 'Entitlement Pending', 'Default', 'ENT-PENDING', 100, 1, 100, 'manual', '${nowIso}'),
      ('order-item-entitlement-active', '${SHOP_ID}', 'order-entitlement-active', 'product-entitlement-active', 'variant-entitlement-active', 'Entitlement Active', 'Default', 'ENT-ACTIVE', 0, 1, 0, 'manual', '${nowIso}'),
      ('order-item-entitlement-suspended', '${SHOP_ID}', 'order-entitlement-suspended', 'product-entitlement-suspended', 'variant-entitlement-suspended', 'Entitlement Suspended', 'Default', 'ENT-SUSPENDED', 0, 1, 0, 'manual', '${nowIso}');
    INSERT INTO entitlement_resources (
      id, shop_id, resource_key, resource_type, status, created_by_user_id,
      created_at, updated_at, retired_at, version
    ) VALUES
      ('resource-entitlement-pending', '${SHOP_ID}', 'entitlement.pending', 'membership', 'active', '${USER_ID}', '${nowIso}', '${nowIso}', NULL, 1),
      ('resource-entitlement-active', '${SHOP_ID}', 'entitlement.active', 'membership', 'active', '${USER_ID}', '${nowIso}', '${nowIso}', NULL, 1),
      ('resource-entitlement-suspended', '${SHOP_ID}', 'entitlement.suspended', 'membership', 'active', '${USER_ID}', '${nowIso}', '${nowIso}', NULL, 1);
    INSERT INTO product_entitlement_policies (
      id, shop_id, product_id, resource_id, policy_version, activation_condition,
      grant_quantity_per_unit, entitlement_ttl_seconds, status, created_by_user_id,
      created_at, updated_at, retired_at
    ) VALUES
      ('policy-entitlement-pending', '${SHOP_ID}', 'product-entitlement-pending', 'resource-entitlement-pending', 1, 'order_paid', 1, NULL, 'active', '${USER_ID}', '${nowIso}', '${nowIso}', NULL),
      ('policy-entitlement-active', '${SHOP_ID}', 'product-entitlement-active', 'resource-entitlement-active', 1, 'order_paid', 1, NULL, 'active', '${USER_ID}', '${nowIso}', '${nowIso}', NULL),
      ('policy-entitlement-suspended', '${SHOP_ID}', 'product-entitlement-suspended', 'resource-entitlement-suspended', 1, 'order_paid', 1, NULL, 'active', '${USER_ID}', '${nowIso}', '${nowIso}', NULL);
    INSERT INTO order_item_entitlement_requirements (
      id, shop_id, order_id, order_item_id, policy_id, resource_id, policy_version,
      activation_condition, item_quantity, grant_quantity, entitlement_ttl_seconds, created_at
    ) VALUES
      ('requirement-entitlement-pending', '${SHOP_ID}', 'order-entitlement-pending', 'order-item-entitlement-pending', 'policy-entitlement-pending', 'resource-entitlement-pending', 1, 'order_paid', 1, 1, NULL, '${nowIso}'),
      ('requirement-entitlement-active', '${SHOP_ID}', 'order-entitlement-active', 'order-item-entitlement-active', 'policy-entitlement-active', 'resource-entitlement-active', 1, 'order_paid', 1, 1, NULL, '${nowIso}'),
      ('requirement-entitlement-suspended', '${SHOP_ID}', 'order-entitlement-suspended', 'order-item-entitlement-suspended', 'policy-entitlement-suspended', 'resource-entitlement-suspended', 1, 'order_paid', 1, 1, NULL, '${nowIso}');
    INSERT INTO entitlements (
      id, shop_id, order_id, order_item_id, requirement_id, resource_id, customer_id,
      buyer_binding_hash, status, grant_quantity, entitlement_ttl_seconds, access_expires_at,
      activated_at, suspended_at, expired_at, revoked_at, version, created_at, updated_at
    ) VALUES
      ('entitlement-pending', '${SHOP_ID}', 'order-entitlement-pending', 'order-item-entitlement-pending', 'requirement-entitlement-pending', 'resource-entitlement-pending', NULL, '${hash("p")}', 'pending', 1, NULL, NULL, NULL, NULL, NULL, NULL, 1, '${nowIso}', '${nowIso}'),
      ('entitlement-active', '${SHOP_ID}', 'order-entitlement-active', 'order-item-entitlement-active', 'requirement-entitlement-active', 'resource-entitlement-active', NULL, '${hash("a")}', 'active', 1, NULL, NULL, '${nowIso}', NULL, NULL, NULL, 1, '${nowIso}', '${nowIso}'),
      ('entitlement-suspended', '${SHOP_ID}', 'order-entitlement-suspended', 'order-item-entitlement-suspended', 'requirement-entitlement-suspended', 'resource-entitlement-suspended', NULL, '${hash("s")}', 'active', 1, NULL, NULL, '${nowIso}', NULL, NULL, NULL, 1, '${nowIso}', '${nowIso}');
    INSERT INTO entitlement_grants (
      id, shop_id, entitlement_id, requirement_id, order_id, resource_id, source_kind,
      source_payment_event_id, idempotency_key_hash, request_hash, request_id,
      granted_quantity, reference_hash, reference_hash_key_version, created_at
    ) VALUES
      ('grant-entitlement-active', '${SHOP_ID}', 'entitlement-active', 'requirement-entitlement-active', 'order-entitlement-active', 'resource-entitlement-active', 'free_checkout', NULL, '${hash("A")}', '${hash("B")}', 'request-entitlement-active', 1, '${hash("M")}', 'identifier-hmac-v1', '${nowIso}'),
      ('grant-entitlement-suspended', '${SHOP_ID}', 'entitlement-suspended', 'requirement-entitlement-suspended', 'order-entitlement-suspended', 'resource-entitlement-suspended', 'free_checkout', NULL, '${hash("C")}', '${hash("D")}', 'request-entitlement-suspended', 1, NULL, NULL, '${nowIso}');
    INSERT INTO entitlement_transitions (
      id, shop_id, entitlement_id, requirement_id, resource_id, entitlement_version,
      from_status, to_status, source_grant_id, reason_code, idempotency_key_hash,
      request_hash, actor_kind, actor_user_id, occurred_at, created_at
    ) VALUES
      ('transition-entitlement-pending-1', '${SHOP_ID}', 'entitlement-pending', 'requirement-entitlement-pending', 'resource-entitlement-pending', 1, NULL, 'pending', NULL, 'checkout_pending', '${hash("E")}', '${hash("F")}', 'system', NULL, '${nowIso}', '${nowIso}'),
      ('transition-entitlement-active-1', '${SHOP_ID}', 'entitlement-active', 'requirement-entitlement-active', 'resource-entitlement-active', 1, NULL, 'active', 'grant-entitlement-active', 'free_checkout', '${hash("G")}', '${hash("H")}', 'system', NULL, '${nowIso}', '${nowIso}'),
      ('transition-entitlement-suspended-1', '${SHOP_ID}', 'entitlement-suspended', 'requirement-entitlement-suspended', 'resource-entitlement-suspended', 1, NULL, 'active', 'grant-entitlement-suspended', 'free_checkout', '${hash("I")}', '${hash("J")}', 'system', NULL, '${nowIso}', '${nowIso}');
    UPDATE entitlements
    SET status = 'suspended', suspended_at = '${nowIso}', version = 2, updated_at = '${nowIso}'
    WHERE id = 'entitlement-suspended' AND shop_id = '${SHOP_ID}';
    INSERT INTO entitlement_transitions (
      id, shop_id, entitlement_id, requirement_id, resource_id, entitlement_version,
      from_status, to_status, source_grant_id, reason_code, idempotency_key_hash,
      request_hash, actor_kind, actor_user_id, occurred_at, created_at
    ) VALUES (
      'transition-entitlement-suspended-2', '${SHOP_ID}', 'entitlement-suspended',
      'requirement-entitlement-suspended', 'resource-entitlement-suspended', 2,
      'active', 'suspended', NULL, 'seller_suspended', '${hash("K")}', '${hash("L")}',
      'system', NULL, '${nowIso}', '${nowIso}'
    );
  `);
  return {
    grantIds: ["grant-entitlement-active", "grant-entitlement-suspended"],
    resourceIds: ["resource-entitlement-pending", "resource-entitlement-active", "resource-entitlement-suspended"],
    policyIds: ["policy-entitlement-pending", "policy-entitlement-active", "policy-entitlement-suspended"],
    entitlementIds: ["entitlement-pending", "entitlement-active", "entitlement-suspended"],
  };
}

type GeneratedLicenseExportFixture = {
  artifactId: string | null;
  attemptId: string;
  connectionId: string;
  credentialId: string;
  deadLetterId: string | null;
  requestId: string;
  sensitiveValues: string[];
};

function seedGeneratedLicenseExportGraph(database: DatabaseSync, input: {
  mode: "manual_review" | "pending" | "processing" | "reconcile_pending" | "retryable" | "succeeded";
  shopId: string;
  suffix: string;
  userId: string;
  leaseExpiresAt?: string;
}): GeneratedLicenseExportFixture {
  const nowIso = NOW.toISOString();
  const id = (kind: string): string => `${kind}-generated-license-${input.suffix}`;
  const hash = (letter: string): string => `${letter}-${input.suffix}`.padEnd(43, letter).slice(0, 43);
  const artifactId = input.mode === "succeeded" ? id("artifact") : null;
  const deadLetterId = input.mode === "manual_review" ? id("dead-letter") : null;
  const connectionId = id("connection");
  const credentialId = id("credential");
  const requestId = id("request");
  const requestShapeHash = hash("h");
  const providerIdempotencyKeyHash = hash("j");
  const requestHash = hash("k");
  const providerReferenceHash = hash("l");
  const evidenceHash = hash("m");
  const externalAccountFingerprint = hash("n");
  const endpointFingerprint = hash("o");
  const credentialFingerprint = hash("p");
  const artifactFingerprint = hash("q");
  const endpointCiphertext = `ENDPOINT-CIPHERTEXT-${input.suffix}-MUST-NOT-LEAK`;
  const endpointIv = `ENDPOINT-IV-${input.suffix}-MUST-NOT-LEAK`;
  const credentialCiphertext = `CREDENTIAL-CIPHERTEXT-${input.suffix}-MUST-NOT-LEAK`;
  const credentialIv = `CREDENTIAL-IV-${input.suffix}-MUST-NOT-LEAK`;
  const artifactCiphertext = `ARTIFACT-CIPHERTEXT-${input.suffix}-MUST-NOT-LEAK`;
  const artifactIv = `ARTIFACT-IV-${input.suffix}-MUST-NOT-LEAK`;
  const leaseToken = `LEASE-TOKEN-${input.suffix}-MUST-NOT-LEAK`;
  const attemptOutcome = {
    manual_review: "manual_review",
    pending: "retryable",
    processing: "ambiguous",
    reconcile_pending: "retryable",
    retryable: "retryable",
    succeeded: "success",
  }[input.mode];

  database.prepare(`
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'active', 'manual', 1, ?, ?)
  `).run(id("product"), input.shopId, id("product"), `Generated License ${input.suffix}`, nowIso, nowIso);
  database.prepare(`
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      currency, min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Default', '{}', 0, 'VND', 1, 1, 'active', 1, ?, ?)
  `).run(id("variant"), input.shopId, id("product"), `GL-${input.suffix}`, nowIso, nowIso);
  database.prepare(`
    INSERT INTO entitlement_resources (
      id, shop_id, resource_key, resource_type, status, created_by_user_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'generated_license', 'active', ?, ?, ?)
  `).run(id("resource"), input.shopId, `generated-license.${input.suffix}`, input.userId, nowIso, nowIso);
  database.prepare(`
    INSERT INTO generated_license_provider_connections (
      id, shop_id, provider_code, provider_environment, status,
      external_account_fingerprint, last_health_at, created_by_user_id,
      created_at, updated_at
    ) VALUES (?, ?, 'fake.license', 'sandbox', 'active', ?, ?, ?, ?, ?)
  `).run(connectionId, input.shopId, externalAccountFingerprint, nowIso, input.userId, nowIso, nowIso);
  database.prepare(`
    INSERT INTO generated_license_provider_credentials (
      id, shop_id, connection_id, provider_code, credential_version, status,
      key_version, endpoint_ciphertext_b64, endpoint_iv_b64,
      credential_ciphertext_b64, credential_iv_b64, endpoint_fingerprint,
      credential_fingerprint, created_by_user_id, activated_at, created_at,
      updated_at
    ) VALUES (?, ?, ?, 'fake.license', 1, 'active', 'v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    credentialId,
    input.shopId,
    connectionId,
    endpointCiphertext,
    endpointIv,
    credentialCiphertext,
    credentialIv,
    endpointFingerprint,
    credentialFingerprint,
    input.userId,
    nowIso,
    nowIso,
    nowIso,
  );
  database.prepare(`
    INSERT INTO generated_license_resource_bindings (
      id, shop_id, resource_id, connection_id, provider_code,
      generation_template_version, request_shape_hash, status,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'fake.license', 1, ?, 'active', ?, ?, ?)
  `).run(
    id("binding"),
    input.shopId,
    id("resource"),
    connectionId,
    requestShapeHash,
    input.userId,
    nowIso,
    nowIso,
  );
  database.prepare(`
    INSERT INTO product_entitlement_policies (
      id, shop_id, product_id, resource_id, policy_version,
      activation_condition, grant_quantity_per_unit, status,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 'order_paid', 1, 'active', ?, ?, ?)
  `).run(
    id("policy"),
    input.shopId,
    id("product"),
    id("resource"),
    input.userId,
    nowIso,
    nowIso,
  );
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, paid_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'web', 'processing', 'paid', 'unfulfilled',
      0, 0, 0, 'VND', 'vi', ?, ?, '2027-01-01T00:00:00.000Z', ?, ?, ?)
  `).run(
    id("order"),
    `order-public-generated-license-${input.suffix}`,
    input.shopId,
    `GL-${input.suffix}`,
    hash("r"),
    hash("s"),
    nowIso,
    nowIso,
    nowIso,
  );
  database.prepare(`
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title,
      variant_title, sku, unit_price_minor, quantity, line_total_minor,
      fulfillment_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'Default', ?, 0, 1, 0, 'manual', ?)
  `).run(
    id("order-item"),
    input.shopId,
    id("order"),
    id("product"),
    id("variant"),
    `Generated License ${input.suffix}`,
    `GL-${input.suffix}`,
    nowIso,
  );
  database.prepare(`
    INSERT INTO order_item_entitlement_requirements (
      id, shop_id, order_id, order_item_id, policy_id, resource_id,
      policy_version, activation_condition, item_quantity, grant_quantity,
      entitlement_ttl_seconds, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'order_paid', 1, 1, NULL, ?)
  `).run(
    id("requirement"),
    input.shopId,
    id("order"),
    id("order-item"),
    id("policy"),
    id("resource"),
    nowIso,
  );
  database.prepare(`
    INSERT INTO entitlements (
      id, shop_id, order_id, order_item_id, requirement_id, resource_id,
      buyer_binding_hash, status, grant_quantity, activated_at,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, 1, ?, ?)
  `).run(
    id("entitlement"),
    input.shopId,
    id("order"),
    id("order-item"),
    id("requirement"),
    id("resource"),
    hash("s"),
    nowIso,
    nowIso,
    nowIso,
  );
  database.prepare(`
    INSERT INTO entitlement_grants (
      id, shop_id, entitlement_id, requirement_id, order_id, resource_id,
      source_kind, idempotency_key_hash, request_hash, request_id,
      granted_quantity, reference_hash, reference_hash_key_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'free_checkout', ?, ?, ?, 1, ?, 'identifier-hmac-v1', ?)
  `).run(
    id("grant"),
    input.shopId,
    id("entitlement"),
    id("requirement"),
    id("order"),
    id("resource"),
    hash("u"),
    hash("v"),
    id("checkout-request"),
    hash("w"),
    nowIso,
  );
  database.prepare(`
    INSERT INTO entitlement_transitions (
      id, shop_id, entitlement_id, requirement_id, resource_id,
      entitlement_version, from_status, to_status, source_grant_id,
      reason_code, idempotency_key_hash, request_hash, actor_kind,
      actor_user_id, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 1, NULL, 'active', ?, 'free_checkout',
      ?, ?, 'system', NULL, ?, ?)
  `).run(
    id("transition"),
    input.shopId,
    id("entitlement"),
    id("requirement"),
    id("resource"),
    id("grant"),
    hash("x"),
    hash("y"),
    nowIso,
    nowIso,
  );
  database.prepare(`
    INSERT INTO generated_license_requirement_snapshots (
      id, shop_id, entitlement_requirement_id, entitlement_id, order_id,
      order_item_id, resource_id, binding_id, connection_id, provider_code,
      generation_template_version, request_shape_hash, requested_quantity,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fake.license', 1, ?, 1, ?)
  `).run(
    id("snapshot"),
    input.shopId,
    id("requirement"),
    id("entitlement"),
    id("order"),
    id("order-item"),
    id("resource"),
    id("binding"),
    connectionId,
    requestShapeHash,
    nowIso,
  );
  // Requests are created pending, then moved through the same leased state
  // machine used by production before the fixture reaches its requested mode.
  database.prepare(`
    INSERT INTO generated_license_requests (
      id, shop_id, requirement_snapshot_id, entitlement_id,
      entitlement_grant_id, order_id, resource_id, connection_id,
      provider_code, unit_ordinal, provider_idempotency_key_hash,
      request_hash, credential_version, status, attempt_count, next_attempt_at,
      lease_token, lease_expires_at, last_safe_error_code,
      provider_reference_hash, evidence_hash, succeeded_at,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fake.license', 1, ?, ?, 1, 'pending', 0, ?,
      NULL, NULL, NULL, NULL, NULL, NULL, 1, ?, ?)
  `).run(
    requestId,
    input.shopId,
    id("snapshot"),
    id("entitlement"),
    id("grant"),
    id("order"),
    id("resource"),
    connectionId,
    providerIdempotencyKeyHash,
    requestHash,
    nowIso,
    nowIso,
    nowIso,
  );

  if (input.mode !== "pending") {
    database.prepare(`
      UPDATE generated_license_requests
      SET status = 'processing', attempt_count = 1,
        lease_token = ?, lease_expires_at = ?, version = 2, updated_at = ?
      WHERE id = ? AND shop_id = ?
    `).run(
      leaseToken,
      input.leaseExpiresAt ?? "2026-01-01T00:05:00.000Z",
      nowIso,
      requestId,
      input.shopId,
    );

    if (input.mode === "processing") {
      // Leave the request leased; data-lifecycle tests use this row to verify
      // that active work blocks destructive cleanup.
    } else {
      const finalStatus = input.mode === "manual_review" ? "failed" : input.mode;
      database.prepare(`
        UPDATE generated_license_requests
        SET status = ?, lease_token = NULL, lease_expires_at = NULL,
          last_safe_error_code = ?, provider_reference_hash = ?, evidence_hash = ?,
          succeeded_at = ?, version = 3, updated_at = ?
        WHERE id = ? AND shop_id = ?
      `).run(
        finalStatus,
        finalStatus === "failed" ? "generated_license_provider_manual_review" : null,
        providerReferenceHash,
        evidenceHash,
        finalStatus === "succeeded" ? nowIso : null,
        nowIso,
        requestId,
        input.shopId,
      );
      if (input.mode === "manual_review") {
        database.prepare(`
          UPDATE generated_license_requests
          SET status = 'manual_review', version = 4, updated_at = ?
          WHERE id = ? AND shop_id = ?
        `).run(nowIso, requestId, input.shopId);
      }
    }
  }

  if (input.mode !== "pending") {
    database.prepare(`
      INSERT INTO generated_license_attempts (
        id, shop_id, request_id, attempt_no, action_kind, credential_version,
        request_hash, provider_reference_hash, evidence_hash, outcome,
        safe_error_code, occurred_at, created_at
      ) VALUES (?, ?, ?, 1, 'generate', 1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id("attempt"),
      input.shopId,
      requestId,
      requestHash,
      providerReferenceHash,
      evidenceHash,
      attemptOutcome,
      input.mode === "manual_review" ? "generated_license_provider_manual_review" : null,
      nowIso,
      nowIso,
    );
  }

  if (artifactId !== null) {
    database.prepare(`
      INSERT INTO generated_license_artifacts (
        id, shop_id, request_id, entitlement_id, ordinal, ciphertext_b64,
        iv_b64, key_version, artifact_fingerprint, format, status, created_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, 'v1', ?, 'text', 'active', ?)
    `).run(
      artifactId,
      input.shopId,
      requestId,
      id("entitlement"),
      artifactCiphertext,
      artifactIv,
      artifactFingerprint,
      nowIso,
    );
  }

  if (deadLetterId !== null) {
    database.prepare(`
      INSERT INTO generated_license_dead_letters (
        id, shop_id, request_id, failure_code, safe_context_json, status,
        provider_attempts, occurrence_count, created_at, updated_at
      ) VALUES (?, ?, ?, 'generated_license_provider_manual_review',
        '{"operatorAction":"reconcile"}', 'open', 1, 1, ?, ?)
    `).run(deadLetterId, input.shopId, requestId, nowIso, nowIso);
  }

  return {
    artifactId,
    attemptId: id("attempt"),
    connectionId,
    credentialId,
    deadLetterId,
    requestId,
    sensitiveValues: [
      artifactCiphertext,
      artifactFingerprint,
      artifactIv,
      credentialCiphertext,
      credentialFingerprint,
      credentialIv,
      endpointCiphertext,
      endpointFingerprint,
      endpointIv,
      evidenceHash,
      externalAccountFingerprint,
      ...(input.mode === "processing" ? [leaseToken] : []),
      providerIdempotencyKeyHash,
      providerReferenceHash,
      requestHash,
      requestShapeHash,
    ],
  };
}

describe("Phase 9 data lifecycle", () => {
  it("runs standard export SQL on SQLite, excludes key material, and consumes the token once", async () => {
    const runtime = createRuntime();
    await seedInventory(runtime.database, [{ plaintext: "STANDARD-MUST-NOT-LEAK", version: "v1" }]);

    const created = await createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-standard",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const encryptedObject = [...runtime.r2.objects.values()][0];
    expect(encryptedObject).toBeDefined();
    expect(new TextDecoder().decode(encryptedObject)).not.toContain("STANDARD-MUST-NOT-LEAK");

    const downloaded = await consumeDataExportDownload({
      env: runtime.env,
      exportId: created.export.id,
      requestId: "request-download",
      runtime: { now: new Date("2026-01-01T00:05:00.000Z") },
      shopPublicId: SHOP_PUBLIC_ID,
      token: created.downloadToken,
      userId: USER_ID,
    });
    const payload = decodeExportJson(downloaded.bytes) as { data: { inventory: { keys: Record<string, unknown>[] } } };
    expect(payload.data.inventory.keys).toHaveLength(1);
    expect(payload.data.inventory.keys[0]).not.toHaveProperty("value");
    expect(payload.data.inventory.keys[0]).not.toHaveProperty("ciphertextB64");
    expect(JSON.stringify(payload)).not.toContain("STANDARD-MUST-NOT-LEAK");

    await expect(consumeDataExportDownload({
      env: runtime.env,
      exportId: created.export.id,
      requestId: "request-download-replay",
      runtime: { now: new Date("2026-01-01T00:06:00.000Z") },
      shopPublicId: SHOP_PUBLIC_ID,
      token: created.downloadToken,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "export_download_not_found", status: 404 });
  });

  it("exports allowlisted provider-connection metadata without provider identity or evidence", async () => {
    const runtime = createRuntime();
    seedOtherTenant(runtime.database);
    const sensitiveValues = seedGenericPaymentConnection(runtime.database, {
      connectionId: "provider-connection-internal-a",
      publicId: "provider-connection-public-a",
      shopId: SHOP_ID,
      suffix: "tenant-a",
    });
    seedGenericPaymentConnection(runtime.database, {
      connectionId: "provider-connection-internal-b",
      publicId: "provider-connection-public-b",
      shopId: "shop-b",
      suffix: "tenant-b",
    });

    const created = await createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-provider-connection-export",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const downloaded = await consumeDataExportDownload({
      env: runtime.env,
      exportId: created.export.id,
      requestId: "request-provider-connection-export-download",
      runtime: { now: new Date("2026-01-01T00:05:00.000Z") },
      shopPublicId: SHOP_PUBLIC_ID,
      token: created.downloadToken,
      userId: USER_ID,
    });
    const payload = decodeExportJson(downloaded.bytes) as {
      schemaVersion: number;
      data: {
        payments: {
          providerConnectionCapabilities: Record<string, unknown>[];
          providerConnectionCurrencies: Record<string, unknown>[];
          providerConnectionMethods: Record<string, unknown>[];
          providerConnections: Record<string, unknown>[];
        };
      };
    };

    expect(payload.data.payments.providerConnections).toEqual([
      expect.objectContaining({
        connectionMode: "bring_your_own",
        credentialOwnership: "seller",
        merchantCountryCode: "VN",
        providerCode: "futurepay",
        publicId: "provider-connection-public-a",
        settlementMode: "direct",
        status: "active",
        webhookStatus: "verified",
      }),
    ]);
    expect(payload.data.payments.providerConnectionCapabilities).toEqual([
      expect.objectContaining({
        capabilityCode: "checkout.create",
        connectionPublicId: "provider-connection-public-a",
        effectiveEnabled: 1,
        providerGranted: 1,
      }),
    ]);
    expect(payload.data.payments.providerConnectionCurrencies).toEqual([
      expect.objectContaining({
        connectionPublicId: "provider-connection-public-a",
        currencyCode: "VND",
        effectiveEnabled: 1,
        providerSupported: 1,
      }),
    ]);
    expect(payload.data.payments.providerConnectionMethods).toEqual([
      expect.objectContaining({
        connectionPublicId: "provider-connection-public-a",
        effectiveEnabled: 1,
        methodCode: "bank_transfer_qr",
        providerSupported: 1,
      }),
    ]);
    const serialized = JSON.stringify(payload);
    for (const sensitiveValue of sensitiveValues) expect(serialized).not.toContain(sensitiveValue);
    expect(serialized).not.toContain("provider-connection-internal-a");
    expect(serialized).not.toContain("provider-connection-public-b");
    expect(serialized).not.toMatch(
      /provider(?:Identity|Account)Fingerprint|externalAccountReference|evidenceReference/iu,
    );
  });

  it("exports only safe normalized payment-reversal metadata for one tenant", async () => {
    const runtime = createRuntime();
    seedOtherTenant(runtime.database);
    const fixtureA = seedPaidReversalPayment(runtime.database, "a");
    const fixtureB = seedPaidReversalPayment(runtime.database, "b");
    const reversalA = await applyReversal(runtime.env, fixtureA, 4000);
    const reversalB = await applyReversal(runtime.env, fixtureB, 4000);

    const created = await createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-reversal-export",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const downloaded = await consumeDataExportDownload({
      env: runtime.env,
      exportId: created.export.id,
      requestId: "request-reversal-export-download",
      runtime: { now: new Date("2026-01-01T00:05:00.000Z") },
      shopPublicId: SHOP_PUBLIC_ID,
      token: created.downloadToken,
      userId: USER_ID,
    });
    const payload = decodeExportJson(downloaded.bytes) as {
      data: { payments: { reversals: Record<string, unknown>[] } };
      schemaVersion: number;
    };
    expect(payload.schemaVersion).toBe(5);
    expect(payload.data.payments.reversals).toEqual([
      expect.objectContaining({
        amountMinor: 4000,
        decision: "partial",
        expectedAmountMinor: 10000,
        orderPublicId: fixtureA.orderPublicId,
        paymentAttemptPublicId: fixtureA.paymentAttemptPublicId,
        provider: "payos",
        reversalKind: "refund",
      }),
    ]);
    const reversalProjection = JSON.stringify(payload.data.payments.reversals);
    const ledger = runtime.database.prepare(`
      SELECT provider_reference_hash AS providerReferenceHash,
        evidence_hash AS evidenceHash, idempotency_key_hash AS idempotencyKeyHash,
        request_hash AS requestHash
      FROM payment_reversal_events WHERE id = ? AND shop_id = ?
    `).get(reversalA.reversalId, SHOP_ID) as Record<string, string>;
    expect(reversalA.reversalId).not.toBe(reversalB.reversalId);
    expect(reversalProjection).not.toContain(fixtureA.providerReference);
    for (const secret of Object.values(ledger)) expect(reversalProjection).not.toContain(secret);
    expect(reversalProjection).not.toMatch(/(?:providerReference|evidenceHash|idempotencyKeyHash|requestHash|credentialId|integrationId)/u);
    expect(reversalProjection).not.toContain(reversalB.reversalId);
    expect(reversalProjection).not.toContain(fixtureB.orderPublicId);
    expect(reversalProjection).not.toContain(fixtureB.paymentAttemptPublicId);
  });

  it("decrypts mixed inventory key versions only for the explicit high-risk export", async () => {
    const runtime = createRuntime();
    await seedInventory(runtime.database, [
      { plaintext: "KEY-FROM-V1", version: "v1" },
      { plaintext: "KEY-FROM-V2", version: "v2" },
    ]);
    await expect(createDataExport({
      env: runtime.env,
      kind: "inventory_keys_plaintext",
      requestId: "request-keys-without-ack",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "validation_failed", status: 400 });
    const created = await createDataExport({
      acknowledgePlaintextRisk: true,
      env: runtime.env,
      kind: "inventory_keys_plaintext",
      requestId: "request-keys",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const encryptedObject = [...runtime.r2.objects.values()][0];
    const stored = new TextDecoder().decode(encryptedObject);
    expect(stored).not.toContain("KEY-FROM-V1");
    expect(stored).not.toContain("KEY-FROM-V2");

    const downloaded = await consumeDataExportDownload({
      env: runtime.env,
      exportId: created.export.id,
      requestId: "request-keys-download",
      runtime: { now: new Date("2026-01-01T00:05:00.000Z") },
      shopPublicId: SHOP_PUBLIC_ID,
      token: created.downloadToken,
      userId: USER_ID,
    });
    const payload = decodeExportJson(downloaded.bytes) as { keys: { value: string }[] };
    expect(payload.keys.map((key) => key.value)).toEqual(["KEY-FROM-V1", "KEY-FROM-V2"]);
  });

  it("exports private-download lifecycle metadata without storage, token, buyer, or file secrets", async () => {
    const runtime = createRuntime();
    const source = seedPrivateDownloadExportGraph(runtime.database);
    const externalReferencePlaintext = "PRIVATE-EXTERNAL-REFERENCE-MUST-NOT-LEAK";
    runtime.database.exec(`
      INSERT INTO products (
        id, shop_id, slug, title, description, status, fulfillment_type,
        version, created_at, updated_at
      ) VALUES (
        'product-manual-export', '${SHOP_ID}', 'manual-export', 'Manual Export',
        '', 'active', 'manual', 1, '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor,
        currency, min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES (
        'variant-manual-export', '${SHOP_ID}', 'product-manual-export',
        'MANUAL-EXPORT', 'Default', '{}', 100, 'VND', 1, 1, 'active', 1,
        '${NOW.toISOString()}', '${NOW.toISOString()}'
      );
      INSERT INTO order_items (
        id, shop_id, order_id, product_id, variant_id, product_title,
        variant_title, sku, unit_price_minor, quantity, line_total_minor,
        fulfillment_type, created_at
      ) VALUES (
        'order-item-manual-export', '${SHOP_ID}', 'order-private-export',
        'product-manual-export', 'variant-manual-export', 'Manual Export',
        'Default', 'MANUAL-EXPORT', 100, 1, 100, 'manual', '${NOW.toISOString()}'
      );
    `);
    runtime.database.prepare(`
      INSERT INTO fulfillments (
        id, shop_id, order_id, fulfillment_type, state, idempotency_key, created_at
      ) VALUES (?, ?, ?, 'manual', 'pending', ?, ?)
    `).run(
      "fulfillment-private-export",
      SHOP_ID,
      "order-private-export",
      "payment:private-export-manual",
      NOW.toISOString(),
    );
    runtime.database.prepare(`
      INSERT INTO manual_fulfillment_executions (
        id, shop_id, order_id, order_item_id, fulfillment_id, execution_type,
        state, completed_quantity, actor_user_id, idempotency_key_hash,
        request_hash, request_id, completed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'seller_attested_delivery', 'completed', 1,
        ?, ?, ?, ?, ?, ?)
    `).run(
      "mfx-private-export",
      SHOP_ID,
      "order-private-export",
      "order-item-manual-export",
      "fulfillment-private-export",
      USER_ID,
      "k".repeat(43),
      "q".repeat(43),
      "request-private-manual-export",
      NOW.toISOString(),
      NOW.toISOString(),
    );
    runtime.database.prepare(`
      INSERT INTO external_fulfillment_references (
        id, shop_id, execution_id, reference_type, reference_hash,
        hash_key_version, created_at
      ) VALUES (?, ?, ?, 'delivery_reference', ?, 'identifier-hmac-v1', ?)
    `).run(
      "efr-private-export",
      SHOP_ID,
      "mfx-private-export",
      "e".repeat(43),
      NOW.toISOString(),
    );
    runtime.r2.objects.set(source.objectKey, new TextEncoder().encode(source.filePlaintext));

    const created = await createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-private-download-standard-export",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const downloaded = await consumeDataExportDownload({
      env: runtime.env,
      exportId: created.export.id,
      requestId: "request-private-download-standard-export-consume",
      runtime: { now: new Date("2026-01-01T00:05:00.000Z") },
      shopPublicId: SHOP_PUBLIC_ID,
      token: created.downloadToken,
      userId: USER_ID,
    });
    const payload = decodeExportJson(downloaded.bytes) as {
      schemaVersion: number;
      data: {
        fulfillment: {
          assetVersions: Record<string, unknown>[];
          assets: Record<string, unknown>[];
          deliveryGrants: Record<string, unknown>[];
          entitlements: Record<string, unknown>[];
          grantConsumptions: Record<string, unknown>[];
          manualFulfillmentExecutions: Record<string, unknown>[];
          externalFulfillmentReferences: Record<string, unknown>[];
          policies: Record<string, unknown>[];
          requirements: Record<string, unknown>[];
        };
      };
    };
    const privateFulfillment = payload.data.fulfillment;

    expect(payload.schemaVersion).toBe(5);

    expect(privateFulfillment.manualFulfillmentExecutions).toEqual([
      expect.objectContaining({
        completedQuantity: 1,
        executionType: "seller_attested_delivery",
        id: "mfx-private-export",
        orderItemId: "order-item-manual-export",
        state: "completed",
      }),
    ]);
    expect(privateFulfillment.externalFulfillmentReferences).toEqual([
      expect.objectContaining({
        executionId: "mfx-private-export",
        hashKeyVersion: "identifier-hmac-v1",
        id: "efr-private-export",
        referenceType: "delivery_reference",
      }),
    ]);

    expect(privateFulfillment.assets).toEqual([
      expect.objectContaining({ id: "asset-private-export", kind: "private_file", status: "active" }),
    ]);
    expect(privateFulfillment.assetVersions).toEqual([
      expect.objectContaining({
        assetId: "asset-private-export",
        byteSize: 36,
        contentType: "application/pdf",
        filename: "seller-guide.pdf",
        id: "asset-version-private-export",
      }),
    ]);
    expect(privateFulfillment.policies).toEqual([
      expect.objectContaining({ id: "policy-private-export", maxDownloads: 2, policyVersion: 1 }),
    ]);
    expect(privateFulfillment.requirements).toEqual([
      expect.objectContaining({ id: "requirement-private-export", orderItemId: "order-item-private-export" }),
    ]);
    expect(privateFulfillment.entitlements).toEqual([
      expect.objectContaining({ downloadCount: 1, id: "entitlement-private-export", status: "active" }),
    ]);
    expect(privateFulfillment.deliveryGrants).toEqual([
      expect.objectContaining({ id: "grant-private-export", status: "consumed", tokenKeyVersion: "identifier-hmac-v1" }),
    ]);
    expect(privateFulfillment.grantConsumptions).toEqual([
      expect.objectContaining({
        grantId: "grant-private-export",
        id: "consumption-private-export",
        outcome: "served",
        requestId: "request-private-export-consumption",
      }),
    ]);

    const serialized = JSON.stringify(payload);
    expect(privateFulfillment.assetVersions[0]).not.toHaveProperty("objectKey");
    expect(privateFulfillment.entitlements[0]).not.toHaveProperty("buyerBindingHash");
    expect(privateFulfillment.deliveryGrants[0]).not.toHaveProperty("buyerBindingHash");
    expect(privateFulfillment.deliveryGrants[0]).not.toHaveProperty("tokenNonce");
    expect(privateFulfillment.deliveryGrants[0]).not.toHaveProperty("tokenHash");
    expect(privateFulfillment.deliveryGrants[0]).not.toHaveProperty("issuanceKeyHash");
    expect(privateFulfillment.deliveryGrants[0]).not.toHaveProperty("requestHash");
    expect(privateFulfillment.manualFulfillmentExecutions[0]).not.toHaveProperty("requestHash");
    expect(privateFulfillment.manualFulfillmentExecutions[0]).not.toHaveProperty("idempotencyKeyHash");
    expect(privateFulfillment.externalFulfillmentReferences[0]).not.toHaveProperty("referenceHash");
    expect(serialized).not.toContain(source.objectKey);
    expect(serialized).not.toContain(source.filePlaintext);
    expect(serialized).not.toContain(externalReferencePlaintext);
    for (const value of source.sensitiveValues) expect(serialized).not.toContain(value);
  });

  it("exports generic entitlement metadata through schema v5 without buyer or replay hashes", async () => {
    const runtime = createRuntime();
    seedGenericEntitlementGraph(runtime.database);

    const created = await createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-generic-entitlement-export",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const downloaded = await consumeDataExportDownload({
      env: runtime.env,
      exportId: created.export.id,
      requestId: "request-generic-entitlement-export-download",
      runtime: { now: new Date("2026-01-01T00:05:00.000Z") },
      shopPublicId: SHOP_PUBLIC_ID,
      token: created.downloadToken,
      userId: USER_ID,
    });
    const payload = decodeExportJson(downloaded.bytes) as {
      schemaVersion: number;
      data: {
        fulfillment: {
          genericEntitlements: {
            entitlements: Record<string, unknown>[];
            grants: Record<string, unknown>[];
            policies: Record<string, unknown>[];
            requirements: Record<string, unknown>[];
            resources: Record<string, unknown>[];
            transitions: Record<string, unknown>[];
          };
        };
      };
    };
    const generic = payload.data.fulfillment.genericEntitlements;

    expect(payload.schemaVersion).toBe(5);
    expect(generic.resources).toHaveLength(3);
    expect(generic.policies).toHaveLength(3);
    expect(generic.requirements).toHaveLength(3);
    expect(generic.entitlements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "entitlement-pending", status: "pending" }),
      expect.objectContaining({ id: "entitlement-active", status: "active" }),
      expect.objectContaining({ id: "entitlement-suspended", status: "suspended" }),
    ]));
    expect(generic.grants).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entitlementId: "entitlement-active",
        grantedQuantity: 1,
        id: "grant-entitlement-active",
        sourceKind: "free_checkout",
      }),
    ]));
    expect(generic.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        entitlementId: "entitlement-suspended",
        entitlementVersion: 2,
        fromStatus: "active",
        reasonCode: "seller_suspended",
        toStatus: "suspended",
      }),
    ]));

    for (const row of [...generic.entitlements, ...generic.grants, ...generic.transitions]) {
      expect(row).not.toHaveProperty("buyerBindingHash");
      expect(row).not.toHaveProperty("idempotencyKeyHash");
      expect(row).not.toHaveProperty("requestHash");
      expect(row).not.toHaveProperty("referenceHash");
    }
    for (const grant of generic.grants) expect(grant).not.toHaveProperty("requestId");
    const serialized = JSON.stringify(generic);
    for (const letter of ["p", "a", "s", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M"]) {
      expect(serialized).not.toContain(letter.repeat(43));
    }
    expect(serialized).not.toContain("request-entitlement-active");
    expect(serialized).not.toContain("request-entitlement-suspended");
  });

  it("exports tenant-scoped generated-license lifecycle metadata through schema v5 without secret envelopes or hashes", async () => {
    const runtime = createRuntime();
    seedOtherTenant(runtime.database);
    const succeeded = seedGeneratedLicenseExportGraph(runtime.database, {
      mode: "succeeded",
      shopId: SHOP_ID,
      suffix: "tenant-a-success",
      userId: USER_ID,
    });
    const manualReview = seedGeneratedLicenseExportGraph(runtime.database, {
      mode: "manual_review",
      shopId: SHOP_ID,
      suffix: "tenant-a-review",
      userId: USER_ID,
    });
    const processing = seedGeneratedLicenseExportGraph(runtime.database, {
      mode: "processing",
      shopId: SHOP_ID,
      suffix: "tenant-a-processing",
      userId: USER_ID,
    });
    const otherTenant = seedGeneratedLicenseExportGraph(runtime.database, {
      mode: "succeeded",
      shopId: "shop-b",
      suffix: "tenant-b-success",
      userId: "user-b",
    });

    const created = await createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-generated-license-standard-export",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const downloaded = await consumeDataExportDownload({
      env: runtime.env,
      exportId: created.export.id,
      requestId: "request-generated-license-standard-export-download",
      runtime: { now: new Date("2026-01-01T00:05:00.000Z") },
      shopPublicId: SHOP_PUBLIC_ID,
      token: created.downloadToken,
      userId: USER_ID,
    });
    const payload = decodeExportJson(downloaded.bytes) as {
      schemaVersion: number;
      data: {
        fulfillment: {
          generatedLicenses: {
            artifacts: Record<string, unknown>[];
            attempts: Record<string, unknown>[];
            deadLetters: Record<string, unknown>[];
            providerConnections: Record<string, unknown>[];
            providerCredentials: Record<string, unknown>[];
            requests: Record<string, unknown>[];
            requirementSnapshots: Record<string, unknown>[];
            resourceBindings: Record<string, unknown>[];
          };
        };
      };
    };
    const generated = payload.data.fulfillment.generatedLicenses;

    expect(payload.schemaVersion).toBe(5);
    expect(generated.providerConnections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: succeeded.connectionId,
        providerCode: "fake.license",
        providerEnvironment: "sandbox",
        status: "active",
      }),
      expect.objectContaining({ id: manualReview.connectionId }),
    ]));
    expect(generated.providerCredentials).toEqual(expect.arrayContaining([
      expect.objectContaining({
        connectionId: succeeded.connectionId,
        credentialVersion: 1,
        id: succeeded.credentialId,
        status: "active",
      }),
      expect.objectContaining({ id: manualReview.credentialId }),
    ]));
    expect(generated.resourceBindings).toHaveLength(3);
    expect(generated.requirementSnapshots).toHaveLength(3);
    expect(generated.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        attemptCount: 1,
        id: succeeded.requestId,
        status: "succeeded",
      }),
      expect.objectContaining({
        id: manualReview.requestId,
        lastSafeErrorCode: "generated_license_provider_manual_review",
        status: "manual_review",
      }),
      expect.objectContaining({
        attemptCount: 1,
        id: processing.requestId,
        status: "processing",
      }),
    ]));
    expect(generated.attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionKind: "generate",
        id: succeeded.attemptId,
        outcome: "success",
      }),
      expect.objectContaining({
        id: manualReview.attemptId,
        outcome: "manual_review",
        safeErrorCode: "generated_license_provider_manual_review",
      }),
      expect.objectContaining({
        id: processing.attemptId,
        outcome: "ambiguous",
      }),
    ]));
    expect(generated.artifacts).toEqual([
      expect.objectContaining({
        format: "text",
        id: succeeded.artifactId,
        requestId: succeeded.requestId,
        status: "active",
      }),
    ]);
    expect(generated.deadLetters).toEqual([
      expect.objectContaining({
        failureCode: "generated_license_provider_manual_review",
        id: manualReview.deadLetterId,
        requestId: manualReview.requestId,
        safeContextJson: '{"operatorAction":"reconcile"}',
        status: "open",
      }),
    ]);

    for (const connection of generated.providerConnections) {
      expect(connection).not.toHaveProperty("externalAccountFingerprint");
    }
    for (const credential of generated.providerCredentials) {
      expect(credential).not.toHaveProperty("keyVersion");
      expect(credential).not.toHaveProperty("endpointCiphertextB64");
      expect(credential).not.toHaveProperty("endpointIvB64");
      expect(credential).not.toHaveProperty("credentialCiphertextB64");
      expect(credential).not.toHaveProperty("credentialIvB64");
      expect(credential).not.toHaveProperty("endpointFingerprint");
      expect(credential).not.toHaveProperty("credentialFingerprint");
    }
    for (const binding of generated.resourceBindings) expect(binding).not.toHaveProperty("requestShapeHash");
    for (const snapshot of generated.requirementSnapshots) expect(snapshot).not.toHaveProperty("requestShapeHash");
    for (const request of generated.requests) {
      expect(request).not.toHaveProperty("providerIdempotencyKeyHash");
      expect(request).not.toHaveProperty("requestHash");
      expect(request).not.toHaveProperty("providerReferenceHash");
      expect(request).not.toHaveProperty("evidenceHash");
      expect(request).not.toHaveProperty("leaseToken");
      expect(request).not.toHaveProperty("leaseExpiresAt");
    }
    for (const attempt of generated.attempts) {
      expect(attempt).not.toHaveProperty("requestHash");
      expect(attempt).not.toHaveProperty("providerReferenceHash");
      expect(attempt).not.toHaveProperty("evidenceHash");
    }
    for (const artifact of generated.artifacts) {
      expect(artifact).not.toHaveProperty("ciphertextB64");
      expect(artifact).not.toHaveProperty("ivB64");
      expect(artifact).not.toHaveProperty("keyVersion");
      expect(artifact).not.toHaveProperty("artifactFingerprint");
    }

    const serialized = JSON.stringify(generated);
    for (const value of [
      ...succeeded.sensitiveValues,
      ...manualReview.sensitiveValues,
      ...processing.sensitiveValues,
    ]) {
      expect(serialized).not.toContain(value);
    }
    expect(serialized).not.toContain(otherTenant.connectionId);
    expect(serialized).not.toContain(otherTenant.credentialId);
    expect(serialized).not.toContain(otherTenant.requestId);
    for (const value of otherTenant.sensitiveValues) expect(serialized).not.toContain(value);
  });

  it("does not consume a download token when the stored export key version is unavailable", async () => {
    const runtime = createRuntime();
    const created = await createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-missing-export-key",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    runtime.database.prepare(`
      UPDATE data_export_jobs SET encryption_key_version = 'v2' WHERE id = ? AND shop_id = ?
    `).run(created.export.id, SHOP_ID);

    await expect(consumeDataExportDownload({
      env: runtime.env,
      exportId: created.export.id,
      requestId: "request-missing-export-key-download",
      runtime: { now: new Date("2026-01-01T00:05:00.000Z") },
      shopPublicId: SHOP_PUBLIC_ID,
      token: created.downloadToken,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "encryption_key_version_unavailable", status: 500 });
    expect(runtime.database.prepare(`
      SELECT status, download_token_consumed_at AS consumedAt
      FROM data_export_jobs WHERE id = ? AND shop_id = ?
    `).get(created.export.id, SHOP_ID)).toMatchObject({ consumedAt: null, status: "available" });
    expect(runtime.r2.objects.size).toBe(1);

    runtime.database.prepare(`
      UPDATE data_export_jobs SET encryption_key_version = 'v1' WHERE id = ? AND shop_id = ?
    `).run(created.export.id, SHOP_ID);
    await expect(consumeDataExportDownload({
      env: runtime.env,
      exportId: created.export.id,
      requestId: "request-missing-export-key-retry",
      runtime: { now: new Date("2026-01-01T00:06:00.000Z") },
      shopPublicId: SHOP_PUBLIC_ID,
      token: created.downloadToken,
      userId: USER_ID,
    })).resolves.toMatchObject({ kind: "standard" });
  });

  it("keeps export lookup and one-time tokens isolated by shop_id", async () => {
    const runtime = createRuntime();
    seedOtherTenant(runtime.database);
    const created = await createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-tenant-export",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    await expect(consumeDataExportDownload({
      env: runtime.env,
      exportId: created.export.id,
      requestId: "request-cross-tenant-download",
      runtime: { now: new Date("2026-01-01T00:05:00.000Z") },
      shopPublicId: OTHER_SHOP_PUBLIC_ID,
      token: created.downloadToken,
      userId: "user-b",
    })).rejects.toMatchObject({ code: "export_download_not_found", status: 404 });
    expect(runtime.database.prepare(`
      SELECT status, download_token_consumed_at AS consumedAt
      FROM data_export_jobs WHERE id = ? AND shop_id = ?
    `).get(created.export.id, SHOP_ID)).toMatchObject({ consumedAt: null, status: "available" });
  });

  it("revokes expired exports before retrying exact private-object deletion", async () => {
    const runtime = createRuntime();
    const created = await createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-expired-export",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const objectKey = `exports/${created.export.id}.bin`;
    runtime.r2.failNextDelete(objectKey);

    await expect(consumeDataExportDownload({
      env: runtime.env,
      exportId: created.export.id,
      requestId: "request-expired-export-download",
      runtime: { now: new Date("2026-01-09T00:00:00.000Z") },
      shopPublicId: SHOP_PUBLIC_ID,
      token: created.downloadToken,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "export_download_not_found", status: 404 });

    await expect(purgeExpiredDataExports(
      runtime.env,
      new Date("2026-01-09T00:00:00.000Z"),
    )).resolves.toEqual({ candidates: 1, deleted: 0, failed: 1, invalidObjectKeys: 0 });
    expect(runtime.r2.objects.has(objectKey)).toBe(true);
    expect(runtime.database.prepare(`
      SELECT status, object_deleted_at AS objectDeletedAt,
        download_token_hash AS downloadTokenHash, last_safe_error_code AS lastSafeErrorCode
      FROM data_export_jobs WHERE id = ? AND shop_id = ?
    `).get(created.export.id, SHOP_ID)).toEqual({
      downloadTokenHash: null,
      lastSafeErrorCode: "export_object_delete_failed",
      objectDeletedAt: null,
      status: "expired",
    });

    await expect(purgeExpiredDataExports(
      runtime.env,
      new Date("2026-01-09T00:01:00.000Z"),
    )).resolves.toEqual({ candidates: 1, deleted: 1, failed: 0, invalidObjectKeys: 0 });
    expect(runtime.r2.objects.has(objectKey)).toBe(false);
    expect(runtime.r2.deleteAttempts.get(objectKey)).toBe(2);
    await expect(purgeExpiredDataExports(
      runtime.env,
      new Date("2026-01-09T00:02:00.000Z"),
    )).resolves.toEqual({ candidates: 0, deleted: 0, failed: 0, invalidObjectKeys: 0 });
  });

  it("fails closed instead of deleting a non-canonical export object key", async () => {
    const runtime = createRuntime();
    const created = await createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-invalid-export-key",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const canonicalKey = `exports/${created.export.id}.bin`;
    const foreignKey = "private-digital-assets/shop-b/foreign-object";
    runtime.r2.objects.delete(canonicalKey);
    runtime.r2.objects.set(foreignKey, new TextEncoder().encode("other-tenant"));
    runtime.database.prepare(`
      UPDATE data_export_jobs SET object_key = ? WHERE id = ? AND shop_id = ?
    `).run(foreignKey, created.export.id, SHOP_ID);

    await expect(purgeExpiredDataExports(
      runtime.env,
      new Date("2026-01-09T00:00:00.000Z"),
    )).resolves.toEqual({ candidates: 1, deleted: 0, failed: 0, invalidObjectKeys: 1 });
    expect(runtime.r2.objects.get(foreignKey)).toEqual(new TextEncoder().encode("other-tenant"));
    expect(runtime.r2.deleteAttempts.has(foreignKey)).toBe(false);
    expect(runtime.database.prepare(`
      SELECT status, object_deleted_at AS objectDeletedAt, last_safe_error_code AS lastSafeErrorCode
      FROM data_export_jobs WHERE id = ? AND shop_id = ?
    `).get(created.export.id, SHOP_ID)).toEqual({
      lastSafeErrorCode: "export_object_key_invalid",
      objectDeletedAt: null,
      status: "expired",
    });
  });

  it("blocks checkout and provider cleanup while an active payment is retained", async () => {
    const runtime = createRuntime();
    seedActivePayment(runtime.database);
    const cleanup = vi.fn(() => Promise.resolve());
    const deletion = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-delete",
      runtime: {
        cleanupCustomDomains: cleanup,
        cleanupPayment: cleanup,
        cleanupTelegram: cleanup,
        now: NOW,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(deletion.status).toBe("blocked");
    expect(deletion.steps.find((step) => step.code === "active_payment_drain")?.lastSafeErrorCode)
      .toBe("active_payment_retention");
    expect(cleanup).not.toHaveBeenCalled();
    expect(runtime.database.prepare("SELECT status, canonical_domain_id AS canonicalDomainId FROM shops WHERE id = ?")
      .get(SHOP_ID)).toMatchObject({ canonicalDomainId: null, status: "suspended" });
    expect(() => runtime.database.prepare(`
      INSERT INTO orders (
        id, public_id, shop_id, order_number, source_channel, status, payment_status,
        fulfillment_status, subtotal_minor, discount_minor, total_minor, currency,
        locale, checkout_subject_hash, order_token_hash, expires_at, created_at, updated_at
      ) VALUES (
        'late-order', 'order_00000000-0000-4000-8000-000000000006', ?, 'LATE', 'web',
        'pending_payment', 'unpaid', 'unfulfilled', 1, 0, 1, 'VND', 'vi',
        'late-checkout', 'late-token', '2026-03-01T00:00:00.000Z', ?, ?
      )
    `).run(SHOP_ID, NOW.toISOString(), NOW.toISOString())).toThrow(/shop_checkout_blocked/u);
  });

  it("retains full-refund reversal ledgers through tenant deletion and crypto-shred", async () => {
    const runtime = createRuntime();
    seedOtherTenant(runtime.database);
    const fixtureA = seedPaidReversalPayment(runtime.database, "a");
    const fixtureB = seedPaidReversalPayment(runtime.database, "b");
    const reversalA = await applyReversal(runtime.env, fixtureA);
    const reversalB = await applyReversal(runtime.env, fixtureB);
    const beforeA = runtime.database.prepare(`
      SELECT * FROM payment_reversal_events WHERE id = ? AND shop_id = ?
    `).get(reversalA.reversalId, SHOP_ID);
    const beforeB = runtime.database.prepare(`
      SELECT * FROM payment_reversal_events WHERE id = ? AND shop_id = ?
    `).get(reversalB.reversalId, "shop-b");

    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-reversal-retention-delete",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const completed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-reversal-retention-delete-resume",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(completed.status).toBe("completed");
    expect(runtime.database.prepare(`
      SELECT * FROM payment_reversal_events WHERE id = ? AND shop_id = ?
    `).get(reversalA.reversalId, SHOP_ID)).toEqual(beforeA);
    expect(runtime.database.prepare(`
      SELECT * FROM payment_reversal_events WHERE id = ? AND shop_id = ?
    `).get(reversalB.reversalId, "shop-b")).toEqual(beforeB);
    expect(runtime.database.prepare(`
      SELECT key_version AS keyVersion, credential_fingerprint AS fingerprint
      FROM payment_credentials WHERE id = ? AND shop_id = ?
    `).get(fixtureA.credentialId, SHOP_ID)).toEqual({
      fingerprint: `destroyed:${fixtureA.credentialId}`,
      keyVersion: "destroyed",
    });
    expect(runtime.database.prepare(`
      SELECT key_version AS keyVersion, status FROM payment_credentials
      WHERE id = ? AND shop_id = ?
    `).get(fixtureB.credentialId, "shop-b")).toEqual({ keyVersion: "v1", status: "active" });
  });

  it("blocks deletion when a partial reversal leaves an open manual-review exception", async () => {
    const runtime = createRuntime();
    const fixture = seedPaidReversalPayment(runtime.database, "a");
    const reversal = await applyReversal(runtime.env, fixture, 4000);
    const cleanup = vi.fn(() => Promise.resolve());
    const deletion = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-reversal-manual-review-delete",
      runtime: {
        cleanupCustomDomains: cleanup,
        cleanupPayment: cleanup,
        cleanupTelegram: cleanup,
        now: NOW,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(reversal.decision).toBe("partial");
    expect(runtime.database.prepare(`
      SELECT type, status FROM payment_exceptions
      WHERE shop_id = ? AND order_id = ? AND payment_attempt_id = ?
    `).get(SHOP_ID, fixture.orderId, fixture.paymentAttemptId)).toEqual({
      status: "open",
      type: "manual_review",
    });
    expect(deletion.status).toBe("blocked");
    expect(deletion.steps.find((step) => step.code === "active_payment_drain")?.lastSafeErrorCode)
      .toBe("active_payment_retention");
    expect(cleanup).not.toHaveBeenCalled();
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM payment_reversal_events WHERE id = ? AND shop_id = ?
    `).get(reversal.reversalId, SHOP_ID)).toEqual({ count: 1 });
  });

  it("crypto-shreds PayOS ownership fingerprints and releases the integration claim", async () => {
    const runtime = createRuntime();
    seedActivePayment(runtime.database);
    runtime.database.prepare("UPDATE payment_attempts SET state = 'terminal_unpaid', next_reconcile_at = NULL WHERE shop_id = ?").run(SHOP_ID);
    runtime.database.prepare("UPDATE orders SET status = 'canceled', payment_status = 'failed', expires_at = ? WHERE shop_id = ?").run(NOW.toISOString(), SHOP_ID);

    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-ownership-shred",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const deletion = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-ownership-shred-resume",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(deletion.secretMaterialDestroyedAt).not.toBeNull();
    expect(runtime.database.prepare(`
      SELECT provider_ownership_fingerprint AS ownership, key_version AS keyVersion
      FROM payment_credentials WHERE id = 'credential-a'
    `).get()).toEqual({ keyVersion: "destroyed", ownership: "destroyed:credential-a" });
    expect(runtime.database.prepare(`
      SELECT provider_identity_fingerprint AS identity
      FROM payment_integrations WHERE id = 'payos-a'
    `).get()).toEqual({ identity: null });
  });

  it("disconnects and revokes generic payment connections without deleting financial records", async () => {
    const runtime = createRuntime();
    seedOtherTenant(runtime.database);
    seedActivePayment(runtime.database);
    seedGenericPaymentConnection(runtime.database, {
      connectionId: "provider-connection-delete-a",
      publicId: "provider-connection-delete-public-a",
      shopId: SHOP_ID,
      suffix: "delete-a",
    });
    seedGenericPaymentConnection(runtime.database, {
      connectionId: "provider-connection-delete-b",
      publicId: "provider-connection-delete-public-b",
      shopId: "shop-b",
      suffix: "delete-b",
    });
    runtime.database.prepare(`
      INSERT INTO payment_events (
        id, shop_id, payment_attempt_id, integration_id, provider,
        provider_event_reference, payload_hash, signature_verified,
        normalized_state, process_result, received_at
      ) VALUES (
        'payment-event-retained', ?, 'attempt-a', 'payos-a', 'payos',
        'event-retained', 'payload-hash-retained', 1, 'pending', 'accepted', ?
      )
    `).run(SHOP_ID, NOW.toISOString());
    runtime.database.prepare(`
      INSERT INTO payment_exceptions (
        id, shop_id, order_id, payment_attempt_id, type, status,
        safe_evidence_json, resolution_reason, resolved_at, created_at
      ) VALUES (
        'payment-exception-retained', ?, 'order-a', 'attempt-a',
        'manual_review', 'resolved', '{}', 'seller_reviewed', ?, ?
      )
    `).run(SHOP_ID, NOW.toISOString(), NOW.toISOString());
    runtime.database.prepare(`
      UPDATE payment_attempts
      SET state = 'terminal_unpaid', next_reconcile_at = NULL, updated_at = ?
      WHERE id = 'attempt-a' AND shop_id = ?
    `).run(NOW.toISOString(), SHOP_ID);
    runtime.database.prepare(`
      UPDATE orders
      SET status = 'canceled', payment_status = 'failed', expires_at = ?, updated_at = ?
      WHERE id = 'order-a' AND shop_id = ?
    `).run(NOW.toISOString(), NOW.toISOString(), SHOP_ID);

    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-generic-provider-delete",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const completed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-generic-provider-delete-resume",
      runtime: { now: AFTER_GRACE },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(completed.status).toBe("completed");
    expect(runtime.database.prepare(`
      SELECT status, webhook_status AS webhookStatus,
        provider_attested_country_code AS attestedCountry,
        provider_country_attested_at AS countryAttestedAt,
        provider_account_fingerprint AS accountFingerprint,
        provider_account_verified_at AS accountVerifiedAt
      FROM payment_provider_connections
      WHERE id = 'provider-connection-delete-a' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({
      accountFingerprint: null,
      accountVerifiedAt: null,
      attestedCountry: null,
      countryAttestedAt: null,
      status: "disconnected",
      webhookStatus: "disconnected",
    });
    expect(runtime.database.prepare(`
      SELECT provider_granted AS providerGranted, effective_enabled AS effectiveEnabled,
        evidence_reference AS evidenceReference, revoked_at AS revokedAt
      FROM payment_provider_connection_capabilities
      WHERE connection_id = 'provider-connection-delete-a' AND shop_id = ?
    `).get(SHOP_ID)).toMatchObject({
      effectiveEnabled: 0,
      evidenceReference: null,
      providerGranted: 0,
      revokedAt: AFTER_GRACE.toISOString(),
    });
    expect(runtime.database.prepare(`
      SELECT provider_supported AS providerSupported, effective_enabled AS effectiveEnabled,
        evidence_reference AS evidenceReference
      FROM payment_provider_connection_currencies
      WHERE connection_id = 'provider-connection-delete-a' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({ effectiveEnabled: 0, evidenceReference: null, providerSupported: 1 });
    expect(runtime.database.prepare(`
      SELECT provider_supported AS providerSupported, effective_enabled AS effectiveEnabled,
        evidence_reference AS evidenceReference
      FROM payment_provider_connection_methods
      WHERE connection_id = 'provider-connection-delete-a' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({ effectiveEnabled: 0, evidenceReference: null, providerSupported: 1 });
    expect(runtime.database.prepare(`
      SELECT status, webhook_status AS webhookStatus,
        provider_attested_country_code AS attestedCountry,
        provider_account_fingerprint AS accountFingerprint
      FROM payment_provider_connections WHERE id = 'provider-connection-delete-b' AND shop_id = 'shop-b'
    `).get()).toEqual({
      accountFingerprint: "raw-provider-fingerprint-delete-b",
      attestedCountry: "VN",
      status: "active",
      webhookStatus: "verified",
    });
    expect(runtime.database.prepare(`
      SELECT provider_granted AS providerGranted, effective_enabled AS effectiveEnabled,
        evidence_reference AS evidenceReference
      FROM payment_provider_connection_capabilities
      WHERE connection_id = 'provider-connection-delete-b' AND shop_id = 'shop-b'
    `).get()).toEqual({
      effectiveEnabled: 1,
      evidenceReference: "raw-provider-evidence-delete-b",
      providerGranted: 1,
    });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM payment_attempts WHERE id = 'attempt-a' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM payment_events WHERE id = 'payment-event-retained' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM payment_exceptions
      WHERE id = 'payment-exception-retained' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({ count: 1 });
  });

  it("revokes tenant export jobs and objects before crypto-shredding secrets", async () => {
    const runtime = createRuntime();
    seedOtherTenant(runtime.database);
    const tenantExport = await createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-delete-export-a",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const otherExport = await createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-delete-export-b",
      runtime: { now: NOW },
      shopPublicId: OTHER_SHOP_PUBLIC_ID,
      userId: "user-b",
    });
    const tenantObjectKey = `exports/${tenantExport.export.id}.bin`;
    const otherObjectKey = `exports/${otherExport.export.id}.bin`;

    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-delete-export-shop",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const completed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-delete-export-shop-resume",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(completed.status).toBe("completed");
    expect(completed.secretMaterialDestroyedAt).not.toBeNull();
    expect(runtime.r2.objects.has(tenantObjectKey)).toBe(false);
    expect(runtime.r2.objects.has(otherObjectKey)).toBe(true);
    const deletedTenantExport = runtime.database.prepare(`
      SELECT status, object_deleted_at AS objectDeletedAt,
        download_token_hash AS downloadTokenHash
      FROM data_export_jobs WHERE id = ? AND shop_id = ?
    `).get(tenantExport.export.id, SHOP_ID) as {
      downloadTokenHash: string | null;
      objectDeletedAt: string | null;
      status: string;
    };
    expect(deletedTenantExport).toMatchObject({ downloadTokenHash: null, status: "canceled" });
    expect(typeof deletedTenantExport.objectDeletedAt).toBe("string");
    const retainedOtherExport = runtime.database.prepare(`
      SELECT status, object_deleted_at AS objectDeletedAt,
        download_token_hash AS downloadTokenHash
      FROM data_export_jobs WHERE id = ? AND shop_id = ?
    `).get(otherExport.export.id, "shop-b") as {
      downloadTokenHash: string | null;
      objectDeletedAt: string | null;
      status: string;
    };
    expect(retainedOtherExport).toMatchObject({ objectDeletedAt: null, status: "available" });
    expect(typeof retainedOtherExport.downloadTokenHash).toBe("string");
  });

  it("revokes private download access and removes only the tenant asset objects", async () => {
    const runtime = createRuntime();
  const privateDownload = seedPrivateDownload(runtime);
    const unrelatedKey = "private-digital-assets/shop-b/asset-other/version-other";
    runtime.r2.objects.set(unrelatedKey, new TextEncoder().encode("other-tenant"));
    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-private-delete",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    const completed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-private-delete-resume",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(completed.status).toBe("completed");
    expect(runtime.r2.objects.has(privateDownload.objectKey)).toBe(false);
    expect(runtime.r2.objects.has(unrelatedKey)).toBe(true);
    expect(runtime.database.prepare(`
      SELECT status FROM digital_entitlements WHERE id = ? AND shop_id = ?
    `).get(privateDownload.entitlementId, SHOP_ID)).toEqual({ status: "revoked" });
    expect(runtime.database.prepare(`
      SELECT status FROM delivery_grants WHERE id = ? AND shop_id = ?
    `).get(privateDownload.grantId, SHOP_ID)).toEqual({ status: "revoked" });
    expect(runtime.database.prepare(`
      SELECT status, deleted_at AS deletedAt FROM digital_asset_versions
      WHERE id = ? AND shop_id = ?
    `).get(privateDownload.assetVersionId, SHOP_ID)).toMatchObject({ status: "deleted" });
    expect(runtime.database.prepare(`
      SELECT status, deleted_at AS deletedAt FROM digital_assets
      WHERE id = ? AND shop_id = ?
    `).get(privateDownload.assetId, SHOP_ID)).toMatchObject({ status: "deleted" });
    expect(runtime.database.prepare(`
      SELECT status FROM product_fulfillment_policies WHERE id = 'policy-private' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({ status: "retired" });
    const safeEvidence = String(runtime.database.prepare(`
      SELECT secret_material_destroyed_json AS evidence FROM shop_deletion_requests
      WHERE id = ? AND shop_id = ?
    `).get(completed.id, SHOP_ID)?.evidence ?? "");
    expect(safeEvidence).not.toContain(privateDownload.objectKey);
    expect(safeEvidence).not.toContain("grant-private");
  });

  it("retires generic entitlement configuration and appends immutable revocation evidence", async () => {
    const runtime = createRuntime();
    const graph = seedGenericEntitlementGraph(runtime.database);
    runtime.database.prepare(`
      UPDATE orders
      SET status = 'canceled', payment_status = 'failed', expires_at = ?
      WHERE id = 'order-entitlement-pending' AND shop_id = ?
    `).run(NOW.toISOString(), SHOP_ID);
    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-generic-entitlement-delete",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    const completed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-generic-entitlement-delete-resume",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(completed.status).toBe("completed");
    const entitlementRows = runtime.database.prepare(`
      SELECT id, status, activated_at AS activatedAt, revoked_at AS revokedAt, version
      FROM entitlements WHERE shop_id = ? ORDER BY id
    `).all(SHOP_ID);
    expect(entitlementRows).toEqual([
      expect.objectContaining({ id: "entitlement-active", status: "revoked", version: 2 }),
      expect.objectContaining({ id: "entitlement-pending", status: "revoked", version: 2 }),
      expect.objectContaining({ id: "entitlement-suspended", status: "revoked", version: 3 }),
    ]);
    expect(entitlementRows.find((row) => row.id === "entitlement-pending")).toMatchObject({
      activatedAt: null,
      status: "revoked",
    });
    for (const row of entitlementRows) expect(typeof row.revokedAt).toBe("string");

    expect(runtime.database.prepare(`
      SELECT id, status FROM product_entitlement_policies
      WHERE shop_id = ? ORDER BY id
    `).all(SHOP_ID)).toEqual(graph.policyIds.toSorted().map((id) => ({ id, status: "retired" })));
    expect(runtime.database.prepare(`
      SELECT id, status, version FROM entitlement_resources
      WHERE shop_id = ? ORDER BY id
    `).all(SHOP_ID)).toEqual(graph.resourceIds.toSorted().map((id) => ({ id, status: "retired", version: 2 })));

    expect(runtime.database.prepare(`
      SELECT id FROM entitlement_grants WHERE shop_id = ? ORDER BY id
    `).all(SHOP_ID)).toEqual(graph.grantIds.toSorted().map((id) => ({ id })));
    expect(runtime.database.prepare(`
      SELECT id FROM order_item_entitlement_requirements WHERE shop_id = ? ORDER BY id
    `).all(SHOP_ID)).toHaveLength(3);
    expect(runtime.database.prepare(`
      SELECT entitlement_id AS entitlementId, entitlement_version AS entitlementVersion,
        from_status AS fromStatus, to_status AS toStatus, source_grant_id AS sourceGrantId,
        reason_code AS reasonCode, actor_kind AS actorKind
      FROM entitlement_transitions
      WHERE shop_id = ? AND reason_code = 'shop_deleted'
      ORDER BY entitlement_id
    `).all(SHOP_ID)).toEqual([
      {
        actorKind: "system",
        entitlementId: "entitlement-active",
        entitlementVersion: 2,
        fromStatus: "active",
        reasonCode: "shop_deleted",
        sourceGrantId: null,
        toStatus: "revoked",
      },
      {
        actorKind: "system",
        entitlementId: "entitlement-pending",
        entitlementVersion: 2,
        fromStatus: "pending",
        reasonCode: "shop_deleted",
        sourceGrantId: null,
        toStatus: "revoked",
      },
      {
        actorKind: "system",
        entitlementId: "entitlement-suspended",
        entitlementVersion: 3,
        fromStatus: "suspended",
        reasonCode: "shop_deleted",
        sourceGrantId: null,
        toStatus: "revoked",
      },
    ]);

    await expect(resumeShopDeletion({
      env: runtime.env,
      requestId: "request-generic-entitlement-delete-replay",
      runtime: { now: new Date(AFTER_GRACE.getTime() + 1) },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    })).resolves.toMatchObject({ status: "completed" });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM entitlement_transitions
      WHERE shop_id = ? AND reason_code = 'shop_deleted'
    `).get(SHOP_ID)).toEqual({ count: 3 });
  });

  it("fences active generated-license leases, then crypto-destroys only the deleted tenant while retaining evidence", async () => {
    const runtime = createRuntime();
    seedOtherTenant(runtime.database);
    const pending = seedGeneratedLicenseExportGraph(runtime.database, {
      mode: "pending",
      shopId: SHOP_ID,
      suffix: "delete-pending-a",
      userId: USER_ID,
    });
    const retryable = seedGeneratedLicenseExportGraph(runtime.database, {
      mode: "retryable",
      shopId: SHOP_ID,
      suffix: "delete-retryable-a",
      userId: USER_ID,
    });
    const activeLeaseUntil = new Date(AFTER_GRACE.getTime() + 60 * 60_000);
    const processing = seedGeneratedLicenseExportGraph(runtime.database, {
      mode: "processing",
      leaseExpiresAt: activeLeaseUntil.toISOString(),
      shopId: SHOP_ID,
      suffix: "delete-processing-a",
      userId: USER_ID,
    });
    const reconcilePending = seedGeneratedLicenseExportGraph(runtime.database, {
      mode: "reconcile_pending",
      shopId: SHOP_ID,
      suffix: "delete-reconcile-a",
      userId: USER_ID,
    });
    const succeeded = seedGeneratedLicenseExportGraph(runtime.database, {
      mode: "succeeded",
      shopId: SHOP_ID,
      suffix: "delete-succeeded-a",
      userId: USER_ID,
    });
    const manualReview = seedGeneratedLicenseExportGraph(runtime.database, {
      mode: "manual_review",
      shopId: SHOP_ID,
      suffix: "delete-review-a",
      userId: USER_ID,
    });
    const otherTenant = seedGeneratedLicenseExportGraph(runtime.database, {
      mode: "succeeded",
      shopId: "shop-b",
      suffix: "delete-succeeded-b",
      userId: "user-b",
    });
    runtime.database.prepare(`
      UPDATE generated_license_artifacts
      SET status = 'revoked', revoked_at = ?
      WHERE id = ? AND shop_id = ? AND status = 'active'
    `).run(NOW.toISOString(), succeeded.artifactId, SHOP_ID);

    const retainedRequestEvidence = runtime.database.prepare(`
      SELECT provider_idempotency_key_hash AS providerIdempotencyKeyHash,
        request_hash AS requestHash, provider_reference_hash AS providerReferenceHash,
        evidence_hash AS evidenceHash
      FROM generated_license_requests WHERE id = ? AND shop_id = ?
    `).get(processing.requestId, SHOP_ID);
    const retainedAttemptEvidence = runtime.database.prepare(`
      SELECT request_hash AS requestHash,
        provider_reference_hash AS providerReferenceHash,
        evidence_hash AS evidenceHash, outcome, safe_error_code AS safeErrorCode
      FROM generated_license_attempts WHERE id = ? AND shop_id = ?
    `).get(processing.attemptId, SHOP_ID);

    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-generated-license-delete",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const blocked = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-generated-license-delete-blocked",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(blocked).toMatchObject({
      lastSafeErrorCode: "shop_deletion_generated_license_work_inflight",
      secretMaterialDestroyedAt: null,
      status: "blocked",
    });
    expect(blocked.steps.find((step) => step.code === "crypto_shred")).toMatchObject({
      lastSafeErrorCode: "shop_deletion_generated_license_work_inflight",
      status: "blocked",
    });
    expect(runtime.database.prepare(`
      SELECT status, lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
      FROM generated_license_requests WHERE id = ? AND shop_id = ?
    `).get(processing.requestId, SHOP_ID)).toMatchObject({
      leaseExpiresAt: activeLeaseUntil.toISOString(),
      status: "processing",
    });
    expect(runtime.database.prepare(`
      SELECT status, key_version AS keyVersion
      FROM generated_license_provider_credentials WHERE id = ? AND shop_id = ?
    `).get(succeeded.credentialId, SHOP_ID)).toEqual({ keyVersion: "v1", status: "active" });
    expect(runtime.database.prepare(`
      SELECT status, ciphertext_b64 AS ciphertext
      FROM generated_license_artifacts WHERE id = ? AND shop_id = ?
    `).get(succeeded.artifactId, SHOP_ID)).toMatchObject({ status: "revoked" });

    const retryNow = new Date(activeLeaseUntil.getTime() + 1);
    const completed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-generated-license-delete-complete",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: retryNow,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(completed).toMatchObject({ lastSafeErrorCode: null, status: "completed" });
    const canceledIds = [pending.requestId, retryable.requestId, processing.requestId, reconcilePending.requestId]
      .toSorted();
    expect(runtime.database.prepare(`
      SELECT id, status, canceled_at AS canceledAt,
        lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt,
        last_safe_error_code AS lastSafeErrorCode
      FROM generated_license_requests
      WHERE shop_id = ? AND status = 'canceled'
      ORDER BY id
    `).all(SHOP_ID)).toEqual(canceledIds.map((id) => ({
      canceledAt: retryNow.toISOString(),
      id,
      lastSafeErrorCode: "shop_deleted",
      leaseExpiresAt: null,
      leaseToken: null,
      status: "canceled",
    })));
    expect(runtime.database.prepare(`
      SELECT status FROM generated_license_requests WHERE id = ? AND shop_id = ?
    `).get(succeeded.requestId, SHOP_ID)).toEqual({ status: "succeeded" });
    expect(runtime.database.prepare(`
      SELECT status FROM generated_license_requests WHERE id = ? AND shop_id = ?
    `).get(manualReview.requestId, SHOP_ID)).toEqual({ status: "manual_review" });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM generated_license_requests WHERE shop_id = ?
    `).get(SHOP_ID)).toEqual({ count: 6 });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM generated_license_attempts WHERE shop_id = ?
    `).get(SHOP_ID)).toEqual({ count: 5 });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM generated_license_requirement_snapshots WHERE shop_id = ?
    `).get(SHOP_ID)).toEqual({ count: 6 });
    expect(runtime.database.prepare(`
      SELECT provider_idempotency_key_hash AS providerIdempotencyKeyHash,
        request_hash AS requestHash, provider_reference_hash AS providerReferenceHash,
        evidence_hash AS evidenceHash
      FROM generated_license_requests WHERE id = ? AND shop_id = ?
    `).get(processing.requestId, SHOP_ID)).toEqual(retainedRequestEvidence);
    expect(runtime.database.prepare(`
      SELECT request_hash AS requestHash,
        provider_reference_hash AS providerReferenceHash,
        evidence_hash AS evidenceHash, outcome, safe_error_code AS safeErrorCode
      FROM generated_license_attempts WHERE id = ? AND shop_id = ?
    `).get(processing.attemptId, SHOP_ID)).toEqual(retainedAttemptEvidence);
    expect(runtime.database.prepare(`
      SELECT status, resolution_code AS resolutionCode,
        safe_context_json AS safeContextJson, resolved_at AS resolvedAt
      FROM generated_license_dead_letters WHERE id = ? AND shop_id = ?
    `).get(manualReview.deadLetterId, SHOP_ID)).toEqual({
      resolutionCode: "shop_deleted",
      resolvedAt: retryNow.toISOString(),
      safeContextJson: '{"operatorAction":"reconcile"}',
      status: "resolved",
    });
    expect(runtime.database.prepare(`
      SELECT status, ciphertext_b64 AS ciphertext, iv_b64 AS iv,
        key_version AS keyVersion, artifact_fingerprint AS artifactFingerprint
      FROM generated_license_artifacts WHERE id = ? AND shop_id = ?
    `).get(succeeded.artifactId, SHOP_ID)).toEqual({
      artifactFingerprint: "destroyed",
      ciphertext: "destroyed",
      iv: "destroyed",
      keyVersion: "destroyed",
      status: "destroyed",
    });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count
      FROM generated_license_provider_credentials
      WHERE shop_id = ? AND status = 'destroyed' AND key_version = 'destroyed'
        AND endpoint_ciphertext_b64 = 'destroyed' AND endpoint_iv_b64 = 'destroyed'
        AND credential_ciphertext_b64 = 'destroyed' AND credential_iv_b64 = 'destroyed'
        AND endpoint_fingerprint = 'destroyed' AND credential_fingerprint = 'destroyed'
    `).get(SHOP_ID)).toEqual({ count: 6 });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count
      FROM generated_license_provider_connections
      WHERE shop_id = ? AND status = 'retired'
        AND external_account_fingerprint IS NULL AND last_safe_error_code = 'shop_deleted'
    `).get(SHOP_ID)).toEqual({ count: 6 });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count
      FROM generated_license_resource_bindings
      WHERE shop_id = ? AND status = 'retired' AND retired_at IS NOT NULL
    `).get(SHOP_ID)).toEqual({ count: 6 });

    expect(runtime.database.prepare(`
      SELECT status, external_account_fingerprint AS externalAccountFingerprint
      FROM generated_license_provider_connections WHERE id = ? AND shop_id = 'shop-b'
    `).get(otherTenant.connectionId)).toMatchObject({ status: "active" });
    expect(runtime.database.prepare(`
      SELECT status, key_version AS keyVersion,
        endpoint_ciphertext_b64 AS endpointCiphertext
      FROM generated_license_provider_credentials WHERE id = ? AND shop_id = 'shop-b'
    `).get(otherTenant.credentialId)).toMatchObject({ keyVersion: "v1", status: "active" });
    expect(runtime.database.prepare(`
      SELECT status, ciphertext_b64 AS ciphertext
      FROM generated_license_artifacts WHERE id = ? AND shop_id = 'shop-b'
    `).get(otherTenant.artifactId)).toMatchObject({ status: "active" });
    expect(runtime.database.prepare(`
      SELECT status FROM generated_license_requests WHERE id = ? AND shop_id = 'shop-b'
    `).get(otherTenant.requestId)).toEqual({ status: "succeeded" });

    const safeEvidence = String(runtime.database.prepare(`
      SELECT secret_material_destroyed_json AS evidence
      FROM shop_deletion_requests WHERE id = ? AND shop_id = ?
    `).get(completed.id, SHOP_ID)?.evidence ?? "");
    expect(safeEvidence).toContain("generated_license_credentials");
    expect(safeEvidence).toContain("generated_license_artifacts");
    for (const value of [...succeeded.sensitiveValues, ...manualReview.sensitiveValues]) {
      expect(safeEvidence).not.toContain(value);
    }
  });

  it("fails closed on private object deletion and retries idempotently", async () => {
    const runtime = createRuntime();
    seedPlatformAdmin(runtime.database);
    const privateDownload = seedPrivateDownload(runtime);
    runtime.r2.failNextDelete(privateDownload.objectKey);
    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-private-delete-failure",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    const failed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-private-delete-failure-first",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    expect(failed.status).toBe("failed");
    expect(failed.lastSafeErrorCode).toBe("private_asset_delete_failed");
    expect(failed.secretMaterialDestroyedAt).toBeNull();
    expect(failed.steps.find((step) => step.code === "crypto_shred")).toMatchObject({
      lastSafeErrorCode: "crypto_shred_destructive_in_flight",
      status: "failed",
    });
    expect(runtime.r2.objects.has(privateDownload.objectKey)).toBe(true);
    expect(runtime.database.prepare(`
      SELECT status FROM digital_entitlements WHERE id = ? AND shop_id = ?
    `).get(privateDownload.entitlementId, SHOP_ID)).toEqual({ status: "revoked" });
    expect(runtime.database.prepare(`
      SELECT status FROM delivery_grants WHERE id = ? AND shop_id = ?
    `).get(privateDownload.grantId, SHOP_ID)).toEqual({ status: "revoked" });

    await expect(applyDeletionLegalHold({
      action: "set",
      actorUserId: "admin-a",
      deletionRequestId: failed.id,
      env: runtime.env,
      expectedVersion: failed.version,
      holdUntil: "2027-01-01T00:00:00.000Z",
      idempotencyKey: "private-delete-failure-hold-001",
      now: new Date(AFTER_GRACE.getTime() + 91_000),
      reasonCode: "legal_preservation",
      requestId: "request-private-delete-failure-hold",
      shopPublicId: SHOP_PUBLIC_ID,
    })).rejects.toMatchObject({ code: "shop_deletion_legal_hold_conflict", status: 409 });

    const recovered = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-private-delete-failure-retry",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: new Date(AFTER_GRACE.getTime() + 91_001),
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    expect(recovered.status).toBe("completed");
    expect(runtime.r2.objects.has(privateDownload.objectKey)).toBe(false);
    expect(runtime.r2.deleteAttempts.get(privateDownload.objectKey)).toBe(2);

    const replayed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-private-delete-failure-replay",
      runtime: { now: new Date(AFTER_GRACE.getTime() + 2) },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    expect(replayed.status).toBe("completed");
    expect(runtime.r2.deleteAttempts.get(privateDownload.objectKey)).toBe(2);
  });

  it("fails closed on export-object deletion and retries before marking secrets destroyed", async () => {
    const runtime = createRuntime();
    const created = await createDataExport({
      env: runtime.env,
      kind: "inventory_keys_plaintext",
      acknowledgePlaintextRisk: true,
      requestId: "request-export-delete-failure",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const objectKey = `exports/${created.export.id}.bin`;
    runtime.r2.failNextDelete(objectKey);
    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-export-delete-shop",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    const failed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-export-delete-failure-first",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    expect(failed).toMatchObject({
      lastSafeErrorCode: "export_object_delete_failed",
      secretMaterialDestroyedAt: null,
      status: "failed",
    });
    expect(failed.steps.find((step) => step.code === "crypto_shred")).toMatchObject({
      lastSafeErrorCode: "crypto_shred_destructive_in_flight",
      status: "failed",
    });
    expect(runtime.r2.objects.has(objectKey)).toBe(true);
    expect(runtime.database.prepare(`
      SELECT status, object_deleted_at AS objectDeletedAt, download_token_hash AS downloadTokenHash
      FROM data_export_jobs WHERE id = ? AND shop_id = ?
    `).get(created.export.id, SHOP_ID)).toEqual({
      downloadTokenHash: null,
      objectDeletedAt: null,
      status: "canceled",
    });
    await expect(createDataExport({
      env: runtime.env,
      kind: "standard",
      requestId: "request-export-delete-failure-race",
      runtime: { now: AFTER_GRACE },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "export_state_conflict", status: 409 });

    const recovered = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-export-delete-failure-retry",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: new Date(AFTER_GRACE.getTime() + 91_001),
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    expect(recovered.status).toBe("completed");
    expect(recovered.secretMaterialDestroyedAt).not.toBeNull();
    expect(runtime.r2.objects.has(objectKey)).toBe(false);
    expect(runtime.r2.deleteAttempts.get(objectKey)).toBe(2);
    const deletedExport = runtime.database.prepare(`
      SELECT object_deleted_at AS objectDeletedAt
      FROM data_export_jobs WHERE id = ? AND shop_id = ?
    `).get(created.export.id, SHOP_ID) as { objectDeletedAt: string | null };
    expect(typeof deletedExport.objectDeletedAt).toBe("string");
  });

  it("fails Telegram cleanup on transient provider errors and retries before local revocation", async () => {
    const runtime = createRuntime();
    await seedActiveTelegram(runtime.database);
    const requested = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-telegram-cleanup",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const unavailable: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ error_code: 500, ok: false }), { status: 500 }));
    const failed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-telegram-cleanup-failed",
      runtime: { fetcher: unavailable, now: AFTER_GRACE },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    expect(failed.status).toBe("failed");
    expect(failed.steps.find((step) => step.code === "telegram_cleanup")).toMatchObject({
      lastSafeErrorCode: "provider_unavailable",
      status: "failed",
    });
    expect(runtime.database.prepare("SELECT status FROM telegram_integrations WHERE id = 'telegram-integration-a'").get())
      .toEqual({ status: "active" });
    expect(runtime.database.prepare("SELECT status FROM telegram_credentials WHERE id = 'telegram-credential-a'").get())
      .toEqual({ status: "active" });

    const recovered = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-telegram-cleanup-retry",
      runtime: {
        fetcher: () => Promise.resolve(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })),
        now: new Date(AFTER_GRACE.getTime() + 1),
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    expect(recovered.steps.find((step) => step.code === "telegram_cleanup")).toMatchObject({ status: "completed" });
    expect(runtime.database.prepare("SELECT status FROM telegram_integrations WHERE id = 'telegram-integration-a'").get())
      .toEqual({ status: "disabled" });
    expect(runtime.database.prepare("SELECT status FROM telegram_credentials WHERE id = 'telegram-credential-a'").get())
      .toEqual({ status: "revoked" });
    expect(requested.id).toBe(failed.id);
  });

  it("does not claim provider cleanup or allow seller cancellation under an active legal hold", async () => {
    const runtime = createRuntime();
    seedPlatformAdmin(runtime.database);
    const requested = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-held-provider-cleanup",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const held = await applyDeletionLegalHold({
      action: "set",
      actorUserId: "admin-a",
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: requested.version,
      holdUntil: "2027-01-01T00:00:00.000Z",
      idempotencyKey: "held-provider-cleanup-001",
      now: NOW,
      reasonCode: "legal_preservation",
      requestId: "request-held-provider-cleanup-set",
      shopPublicId: SHOP_PUBLIC_ID,
    });
    runtime.database.prepare(`
      UPDATE shop_deletion_steps
      SET status = 'completed', completed_at = ?, updated_at = ?
      WHERE request_id = ? AND shop_id = ? AND step_code = 'grace_wait'
    `).run(AFTER_GRACE.toISOString(), AFTER_GRACE.toISOString(), requested.id, SHOP_ID);
    const cleanup = vi.fn(() => Promise.resolve());
    const resumed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-held-provider-cleanup-resume",
      runtime: {
        cleanupCustomDomains: cleanup,
        cleanupPayment: cleanup,
        cleanupTelegram: cleanup,
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    expect(resumed.status).toBe("retention_hold");
    expect(cleanup).not.toHaveBeenCalled();
    expect(resumed.steps.find((step) => step.code === "custom_domain_cleanup")).toMatchObject({ status: "pending" });
    await expect(cancelShopDeletion({
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: held.version,
      idempotencyKey: "held-provider-cleanup-cancel",
      now: AFTER_GRACE,
      reasonCode: "seller_changed_mind",
      requestId: "request-held-provider-cleanup-cancel",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "shop_deletion_cancel_conflict", status: 409 });
  });

  it("rechecks legal holds after a provider cleanup lease is claimed", async () => {
    const runtime = createRuntime();
    const requested = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-held-race",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    runtime.database.prepare(`
      UPDATE shop_deletion_steps
      SET status = 'completed', completed_at = ?, updated_at = ?
      WHERE request_id = ? AND shop_id = ? AND step_code = 'grace_wait'
    `).run(AFTER_GRACE.toISOString(), AFTER_GRACE.toISOString(), requested.id, SHOP_ID);
    const cleanup = vi.fn(() => Promise.resolve());
    const resumed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-held-race-resume",
      runtime: {
        beforeStep: ({ requestId, stepCode }) => {
          if (stepCode === "custom_domain_cleanup") {
            runtime.database.prepare(`
              UPDATE shop_deletion_requests
              SET status = 'retention_hold', legal_hold_until = ?, updated_at = ?
              WHERE id = ? AND shop_id = ?
            `).run("2027-01-01T00:00:00.000Z", AFTER_GRACE.toISOString(), requestId, SHOP_ID);
          }
          return Promise.resolve();
        },
        cleanupCustomDomains: cleanup,
        cleanupPayment: cleanup,
        cleanupTelegram: cleanup,
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    expect(resumed.status).toBe("retention_hold");
    expect(cleanup).not.toHaveBeenCalled();
    expect(resumed.steps.find((step) => step.code === "custom_domain_cleanup")).toMatchObject({
      lastSafeErrorCode: "legal_hold_active",
      status: "blocked",
    });
  });

  it("does not report a legal hold applied while custom-domain cleanup owns the provider fence", async () => {
    const runtime = createRuntime();
    seedPlatformAdmin(runtime.database);
    seedProviderBackedCustomDomain(runtime.database);
    Object.assign(runtime.env, { CLOUDFLARE_API_TOKEN: "cloudflare-token-test" });
    const requested = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-domain-race",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    let releaseProvider!: () => void;
    const providerResponse = new Promise<Response>((resolve) => {
      releaseProvider = () => {
        resolve(new Response(JSON.stringify({ result: {}, success: true }), { status: 200 }));
      };
    });
    let signalDispatch!: (version: number) => void;
    const dispatched = new Promise<number>((resolve) => {
      signalDispatch = resolve;
    });
    const fetcher: typeof fetch = () => {
      const row = runtime.database.prepare("SELECT version FROM shop_deletion_requests WHERE id = ? AND shop_id = ?")
        .get(requested.id, SHOP_ID) as { version: number };
      signalDispatch(row.version);
      return providerResponse;
    };
    const resume = resumeShopDeletion({
      env: runtime.env,
      requestId: "request-domain-race-resume",
      runtime: { fetcher, now: AFTER_GRACE },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const expectedVersion = await dispatched;
    const holdResult = await applyDeletionLegalHold({
      action: "set",
      actorUserId: "admin-a",
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion,
      holdUntil: "2027-01-01T00:00:00.000Z",
      idempotencyKey: "domain-race-hold-001",
      now: AFTER_GRACE,
      reasonCode: "legal_preservation",
      requestId: "request-domain-race-hold",
      shopPublicId: SHOP_PUBLIC_ID,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    releaseProvider();
    const resumed = await resume;

    expect(holdResult).toMatchObject({ error: { code: "shop_deletion_legal_hold_conflict", status: 409 }, ok: false });
    expect(resumed.legalHoldUntil).toBeNull();
    expect(runtime.database.prepare(`
      SELECT status, cloudflare_hostname_id AS cloudflareHostnameId
      FROM shop_domains WHERE id = ? AND shop_id = ?
    `).get("domain-custom-a", SHOP_ID)).toEqual({ cloudflareHostnameId: null, status: "deleted" });
  });

  it("does not report a legal hold applied while Telegram cleanup owns the provider fence", async () => {
    const runtime = createRuntime();
    seedPlatformAdmin(runtime.database);
    await seedActiveTelegram(runtime.database);
    const requested = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-telegram-race",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    let releaseProvider!: () => void;
    const providerResponse = new Promise<Response>((resolve) => {
      releaseProvider = () => {
        resolve(new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }));
      };
    });
    let signalDispatch!: (version: number) => void;
    const dispatched = new Promise<number>((resolve) => {
      signalDispatch = resolve;
    });
    const fetcher: typeof fetch = () => {
      const row = runtime.database.prepare("SELECT version FROM shop_deletion_requests WHERE id = ? AND shop_id = ?")
        .get(requested.id, SHOP_ID) as { version: number };
      signalDispatch(row.version);
      return providerResponse;
    };
    const resume = resumeShopDeletion({
      env: runtime.env,
      requestId: "request-telegram-race-resume",
      runtime: { fetcher, now: AFTER_GRACE },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const expectedVersion = await dispatched;
    const holdResult = await applyDeletionLegalHold({
      action: "set",
      actorUserId: "admin-a",
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion,
      holdUntil: "2027-01-01T00:00:00.000Z",
      idempotencyKey: "telegram-race-hold-001",
      now: AFTER_GRACE,
      reasonCode: "legal_preservation",
      requestId: "request-telegram-race-hold",
      shopPublicId: SHOP_PUBLIC_ID,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    releaseProvider();
    const resumed = await resume;

    expect(holdResult).toMatchObject({ error: { code: "shop_deletion_legal_hold_conflict", status: 409 }, ok: false });
    expect(resumed.legalHoldUntil).toBeNull();
    expect(runtime.database.prepare("SELECT status FROM telegram_integrations WHERE id = ? AND shop_id = ?")
      .get("telegram-integration-a", SHOP_ID)).toEqual({ status: "disabled" });
    expect(runtime.database.prepare("SELECT status FROM telegram_credentials WHERE id = ? AND shop_id = ?")
      .get("telegram-credential-a", SHOP_ID)).toEqual({ status: "revoked" });
  });

  it("does not report a legal hold applied before the fenced payment cleanup batch commits", async () => {
    const runtime = createRuntime();
    seedPlatformAdmin(runtime.database);
    seedActivePayment(runtime.database);
    runtime.database.prepare("UPDATE payment_attempts SET state = 'terminal_unpaid', next_reconcile_at = NULL WHERE shop_id = ?").run(SHOP_ID);
    runtime.database.prepare("UPDATE orders SET status = 'canceled', payment_status = 'failed', expires_at = ? WHERE shop_id = ?")
      .run(NOW.toISOString(), SHOP_ID);
    const requested = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-payment-race",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const d1 = runtime.env.PLATFORM_DB as unknown as {
      batch: (statements: BoundStatement[]) => Promise<unknown[]>;
    };
    const originalBatch = d1.batch.bind(d1);
    let intercepted = false;
    let holdResult: { error: unknown; ok: false } | { ok: true } | null = null;
    d1.batch = async (statements) => {
      if (!intercepted && statements.some((statement) => statement.sql.includes("UPDATE payment_integrations")
        && statement.sql.includes("status = 'disconnected'"))) {
        intercepted = true;
        const row = runtime.database.prepare("SELECT version FROM shop_deletion_requests WHERE id = ? AND shop_id = ?")
          .get(requested.id, SHOP_ID) as { version: number };
        holdResult = await applyDeletionLegalHold({
          action: "set",
          actorUserId: "admin-a",
          deletionRequestId: requested.id,
          env: runtime.env,
          expectedVersion: row.version,
          holdUntil: "2027-01-01T00:00:00.000Z",
          idempotencyKey: "payment-race-hold-001",
          now: AFTER_GRACE,
          reasonCode: "legal_preservation",
          requestId: "request-payment-race-hold",
          shopPublicId: SHOP_PUBLIC_ID,
        }).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ error, ok: false as const }),
        );
      }
      return originalBatch(statements);
    };
    const resumed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-payment-race-resume",
      runtime: { now: AFTER_GRACE },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(intercepted).toBe(true);
    expect(holdResult).toMatchObject({ error: { code: "shop_deletion_legal_hold_conflict", status: 409 }, ok: false });
    expect(resumed.legalHoldUntil).toBeNull();
    expect(runtime.database.prepare("SELECT status FROM payment_integrations WHERE id = ? AND shop_id = ?")
      .get("payos-a", SHOP_ID)).toEqual({ status: "disconnected" });
    expect(runtime.database.prepare("SELECT status FROM payment_credentials WHERE id = ? AND shop_id = ?")
      .get("credential-a", SHOP_ID)).toEqual({ status: "revoked" });
  });

  it("honors a legal hold set after the crypto-shred step is claimed", async () => {
    const runtime = createRuntime();
    await seedInventory(runtime.database, [{ plaintext: "PRESERVE-ON-HOLD", version: "v1" }]);
    const privateDownload = seedPrivateDownload(runtime);
    seedGenericEntitlementGraph(runtime.database);
    runtime.database.prepare(`
      UPDATE orders
      SET status = 'canceled', payment_status = 'failed', expires_at = ?
      WHERE id = 'order-entitlement-pending' AND shop_id = ?
    `).run(NOW.toISOString(), SHOP_ID);
    const preservedExport = await createDataExport({
      env: runtime.env,
      kind: "inventory_keys_plaintext",
      acknowledgePlaintextRisk: true,
      requestId: "request-delete-hold-export",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const preservedExportObjectKey = `exports/${preservedExport.export.id}.bin`;
    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-delete-hold",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    const deletion = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-delete-hold-resume",
      runtime: {
        beforeStep: ({ requestId, stepCode }) => {
          if (stepCode !== "crypto_shred") return Promise.resolve();
          runtime.database.prepare(`
            UPDATE shop_deletion_requests SET legal_hold_until = ? WHERE id = ? AND shop_id = ?
          `).run("2027-01-01T00:00:00.000Z", requestId, SHOP_ID);
          return Promise.resolve();
        },
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(deletion.status).toBe("retention_hold");
    expect(deletion.secretMaterialDestroyedAt).toBeNull();
    expect(deletion.steps.find((step) => step.code === "crypto_shred")?.lastSafeErrorCode).toBe("legal_hold_active");
    expect(runtime.database.prepare("SELECT key_version AS keyVersion FROM inventory_keys WHERE id = 'inventory-1'").get())
      .toMatchObject({ keyVersion: "v1" });
    expect(runtime.r2.objects.has(privateDownload.objectKey)).toBe(true);
    expect(runtime.r2.objects.has(preservedExportObjectKey)).toBe(true);
    const heldExport = runtime.database.prepare(`
      SELECT status, object_deleted_at AS objectDeletedAt, download_token_hash AS downloadTokenHash
      FROM data_export_jobs WHERE id = ? AND shop_id = ?
    `).get(preservedExport.export.id, SHOP_ID) as {
      downloadTokenHash: string | null;
      objectDeletedAt: string | null;
      status: string;
    };
    expect(heldExport).toMatchObject({ objectDeletedAt: null, status: "available" });
    expect(typeof heldExport.downloadTokenHash).toBe("string");
    expect(runtime.database.prepare(`
      SELECT status FROM digital_entitlements WHERE id = ? AND shop_id = ?
    `).get(privateDownload.entitlementId, SHOP_ID)).toEqual({ status: "active" });
    expect(runtime.database.prepare(`
      SELECT status FROM delivery_grants WHERE id = ? AND shop_id = ?
    `).get(privateDownload.grantId, SHOP_ID)).toEqual({ status: "active" });
    expect(runtime.database.prepare(`
      SELECT id, status FROM entitlements WHERE shop_id = ? ORDER BY id
    `).all(SHOP_ID)).toEqual([
      { id: "entitlement-active", status: "active" },
      { id: "entitlement-pending", status: "pending" },
      { id: "entitlement-suspended", status: "suspended" },
    ]);
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM entitlement_resources
      WHERE shop_id = ? AND status = 'active'
    `).get(SHOP_ID)).toEqual({ count: 3 });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM entitlement_transitions
      WHERE shop_id = ? AND reason_code = 'shop_deleted'
    `).get(SHOP_ID)).toEqual({ count: 0 });
  });

  it.each([
    { holdOffsetMs: 0, timing: "before" },
    { holdOffsetMs: 91_000, timing: "after" },
  ])("does not report a legal hold applied $timing the crypto-shred lease expires", async ({ holdOffsetMs }) => {
    const runtime = createRuntime();
    seedPlatformAdmin(runtime.database);
    const privateDownload = seedPrivateDownload(runtime);
    const requested = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-private-destructive-race",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    let releaseDelete!: () => void;
    const deleteReleased = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let signalDelete!: () => void;
    const deleteStarted = new Promise<void>((resolve) => {
      signalDelete = resolve;
    });
    runtime.r2.beforeDelete = () => {
      signalDelete();
      return deleteReleased;
    };

    const resume = resumeShopDeletion({
      env: runtime.env,
      requestId: "request-private-destructive-race-resume",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    await deleteStarted;
    const row = runtime.database.prepare("SELECT version FROM shop_deletion_requests WHERE id = ? AND shop_id = ?")
      .get(requested.id, SHOP_ID) as { version: number };
    const holdResult = await applyDeletionLegalHold({
      action: "set",
      actorUserId: "admin-a",
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: row.version,
      holdUntil: "2027-01-01T00:00:00.000Z",
      idempotencyKey: "private-destructive-hold-001",
      now: new Date(AFTER_GRACE.getTime() + holdOffsetMs),
      reasonCode: "legal_preservation",
      requestId: "request-private-destructive-hold",
      shopPublicId: SHOP_PUBLIC_ID,
    }).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ error, ok: false as const }),
    );
    releaseDelete();
    const completed = await resume;

    expect(holdResult).toMatchObject({ error: { code: "shop_deletion_legal_hold_conflict", status: 409 }, ok: false });
    expect(completed.status).toBe("completed");
    expect(runtime.r2.objects.has(privateDownload.objectKey)).toBe(false);
  });

  it("does not remove private objects when the crypto-shred lease is stolen", async () => {
    const runtime = createRuntime();
    const privateDownload = seedPrivateDownload(runtime);
    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-private-lease",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    const deletion = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-private-lease-resume",
      runtime: {
        beforeStep: ({ requestId, stepCode }) => {
          if (stepCode !== "crypto_shred") return Promise.resolve();
          runtime.database.prepare(`
            UPDATE shop_deletion_steps
            SET lease_token = 'private-new-owner', lease_expires_at = '2027-01-01T00:00:00.000Z'
            WHERE request_id = ? AND shop_id = ? AND step_code = 'crypto_shred'
          `).run(requestId, SHOP_ID);
          return Promise.resolve();
        },
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(deletion.status).toBe("processing");
    expect(runtime.r2.objects.has(privateDownload.objectKey)).toBe(true);
    expect(runtime.database.prepare(`
      SELECT status FROM digital_asset_versions WHERE id = ? AND shop_id = ?
    `).get(privateDownload.assetVersionId, SHOP_ID)).toEqual({ status: "active" });
    expect(runtime.database.prepare(`
      SELECT status FROM digital_entitlements WHERE id = ? AND shop_id = ?
    `).get(privateDownload.entitlementId, SHOP_ID)).toEqual({ status: "active" });
  });

  it("does not archive the shop when the finalize lease is stolen", async () => {
    const runtime = createRuntime();
    await seedInventory(runtime.database, [{ plaintext: "DESTROY-AFTER-GRACE", version: "v1" }]);
    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-delete-stale",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    const deletion = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-delete-stale-resume",
      runtime: {
        beforeStep: ({ requestId, stepCode }) => {
          if (stepCode !== "finalize") return Promise.resolve();
          runtime.database.prepare(`
            UPDATE shop_deletion_steps
            SET lease_token = 'new-owner', lease_expires_at = '2027-01-01T00:00:00.000Z'
            WHERE request_id = ? AND shop_id = ? AND step_code = 'finalize'
          `).run(requestId, SHOP_ID);
          return Promise.resolve();
        },
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(deletion.status).toBe("processing");
    expect(deletion.steps.find((step) => step.code === "finalize")?.status).toBe("processing");
    expect(runtime.database.prepare("SELECT status FROM shops WHERE id = ?").get(SHOP_ID))
      .toMatchObject({ status: "suspended" });
    expect(runtime.database.prepare("SELECT state FROM shop_subscriptions WHERE shop_id = ?").get(SHOP_ID))
      .toMatchObject({ state: "active" });
    expect(await getShopDeletion({ env: runtime.env, shopPublicId: SHOP_PUBLIC_ID, userId: USER_ID }))
      .toMatchObject({ status: "processing" });
  });

  it("cancels only a tenant-owned deletion that has not entered an irreversible step", async () => {
    const runtime = createRuntime();
    seedOtherTenant(runtime.database);
    const requested = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-cancel-create",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const canceled = await cancelShopDeletion({
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: requested.version,
      idempotencyKey: "cancel-deletion-001",
      now: new Date("2026-01-02T00:00:00.000Z"),
      reasonCode: "seller_changed_mind",
      requestId: "request-cancel",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    expect(canceled.status).toBe("canceled");
    expect(canceled.version).toBe(requested.version + 1);
    expect(canceled.steps.filter((step) => step.code === "checkout_block" || step.code === "routing_remove")
      .every((step) => step.status === "completed")).toBe(true);
    expect(canceled.steps.filter((step) => [
      "grace_wait",
      "custom_domain_cleanup",
      "telegram_cleanup",
      "payment_cleanup",
      "crypto_shred",
      "finalize",
    ].includes(step.code)).every((step) => step.status === "skipped")).toBe(true);
    await expect(cancelShopDeletion({
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: requested.version,
      idempotencyKey: "cancel-deletion-001",
      now: new Date("2026-01-02T00:01:00.000Z"),
      reasonCode: "seller_changed_mind",
      requestId: "request-cancel-replay",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    })).resolves.toMatchObject({ status: "canceled", version: canceled.version });
    await expect(cancelShopDeletion({
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: requested.version,
      idempotencyKey: "cancel-cross-shop-001",
      now: new Date("2026-01-02T00:02:00.000Z"),
      reasonCode: "seller_changed_mind",
      requestId: "request-cancel-cross-shop",
      shopPublicId: OTHER_SHOP_PUBLIC_ID,
      userId: "user-b",
    })).rejects.toMatchObject({ code: "shop_deletion_not_found", status: 404 });
  });

  it("refuses cancellation for stale versions, live leases, and irreversible progress", async () => {
    const runtime = createRuntime();
    const requested = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-cancel-guards-create",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    await expect(cancelShopDeletion({
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: requested.version - 1,
      idempotencyKey: "cancel-stale-001",
      now: new Date("2026-01-02T00:00:00.000Z"),
      reasonCode: "seller_changed_mind",
      requestId: "request-cancel-stale",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "shop_deletion_cancel_conflict", status: 409 });

    runtime.database.prepare(`
      UPDATE shop_deletion_steps
      SET status = 'processing', lease_token = 'lease-a', lease_expires_at = ?, updated_at = ?
      WHERE request_id = ? AND shop_id = ? AND step_code = 'grace_wait'
    `).run("2026-01-03T00:00:00.000Z", "2026-01-02T00:00:00.000Z", requested.id, SHOP_ID);
    await expect(cancelShopDeletion({
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: requested.version,
      idempotencyKey: "cancel-live-lease-001",
      now: new Date("2026-01-02T00:00:00.000Z"),
      reasonCode: "seller_changed_mind",
      requestId: "request-cancel-lease",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "shop_deletion_cancel_conflict", status: 409 });

    runtime.database.prepare(`
      UPDATE shop_deletion_steps
      SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
        completed_at = ?, updated_at = ?
      WHERE request_id = ? AND shop_id = ? AND step_code = 'custom_domain_cleanup'
    `).run("2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z", requested.id, SHOP_ID);
    await expect(cancelShopDeletion({
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: requested.version,
      idempotencyKey: "cancel-irreversible-001",
      now: new Date("2026-01-02T00:00:00.000Z"),
      reasonCode: "seller_changed_mind",
      requestId: "request-cancel-irreversible",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "shop_deletion_cancel_conflict", status: 409 });
  });

  it("sets and releases a tenant-guarded legal hold without losing a concurrent crypto lease", async () => {
    const runtime = createRuntime();
    seedPlatformAdmin(runtime.database);
    seedOtherTenant(runtime.database);
    const requested = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-hold-create",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    runtime.database.prepare(`
      UPDATE shop_deletion_steps
      SET status = 'processing', lease_token = 'crypto-lease', lease_expires_at = ?, updated_at = ?
      WHERE request_id = ? AND shop_id = ? AND step_code = 'crypto_shred'
    `).run("2026-02-16T00:00:00.000Z", AFTER_GRACE.toISOString(), requested.id, SHOP_ID);
    const held = await applyDeletionLegalHold({
      action: "set",
      actorUserId: "admin-a",
      deletionRequestId: requested.id,
      env: runtime.env,
      evidenceReference: "case:legal-2026-001",
      expectedVersion: requested.version,
      holdUntil: "2027-01-01T00:00:00.000Z",
      idempotencyKey: "legal-hold-set-001",
      now: AFTER_GRACE,
      reasonCode: "legal_preservation",
      requestId: "request-hold-set",
      shopPublicId: SHOP_PUBLIC_ID,
    });
    expect(held).toMatchObject({ action: "set", status: "applied", version: requested.version + 1 });
    expect(runtime.database.prepare(`
      SELECT status, legal_hold_until AS legalHoldUntil, version FROM shop_deletion_requests
      WHERE id = ? AND shop_id = ?
    `).get(requested.id, SHOP_ID)).toMatchObject({
      legalHoldUntil: "2027-01-01T00:00:00.000Z",
      status: "retention_hold",
      version: held.version,
    });
    expect(runtime.database.prepare(`
      SELECT status, lease_token AS leaseToken FROM shop_deletion_steps
      WHERE request_id = ? AND shop_id = ? AND step_code = 'crypto_shred'
    `).get(requested.id, SHOP_ID)).toMatchObject({ leaseToken: "crypto-lease", status: "processing" });
    await expect(applyDeletionLegalHold({
      action: "release",
      actorUserId: "admin-a",
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: held.version - 1,
      idempotencyKey: "legal-hold-release-stale",
      now: AFTER_GRACE,
      reasonCode: "legal_clearance",
      requestId: "request-hold-release-stale",
      shopPublicId: SHOP_PUBLIC_ID,
    })).rejects.toMatchObject({ code: "shop_deletion_legal_hold_conflict", status: 409 });
    await expect(applyDeletionLegalHold({
      action: "release",
      actorUserId: "admin-a",
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: held.version,
      idempotencyKey: "legal-hold-release-001",
      now: AFTER_GRACE,
      reasonCode: "legal_clearance",
      requestId: "request-hold-release",
      shopPublicId: OTHER_SHOP_PUBLIC_ID,
    })).rejects.toMatchObject({ code: "shop_deletion_not_found", status: 404 });
    runtime.database.prepare(`
      UPDATE platform_admins SET role = 'owner', updated_at = ? WHERE user_id = 'admin-a'
    `).run(AFTER_GRACE.toISOString());
    const released = await applyDeletionLegalHold({
      action: "release",
      actorUserId: "admin-a",
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: held.version,
      idempotencyKey: "legal-hold-release-owner-001",
      now: AFTER_GRACE,
      reasonCode: "legal_clearance",
      requestId: "request-hold-release-owner",
      shopPublicId: SHOP_PUBLIC_ID,
    });
    expect(released).toMatchObject({ action: "release", holdUntil: null, version: held.version + 1 });
    expect(runtime.database.prepare(`
      SELECT status, legal_hold_until AS legalHoldUntil, version
      FROM shop_deletion_requests WHERE id = ? AND shop_id = ?
    `).get(requested.id, SHOP_ID)).toMatchObject({
      legalHoldUntil: null,
      status: "processing",
      version: released.version,
    });
    expect(runtime.database.prepare(`
      SELECT status, lease_token AS leaseToken FROM shop_deletion_steps
      WHERE request_id = ? AND shop_id = ? AND step_code = 'crypto_shred'
    `).get(requested.id, SHOP_ID)).toMatchObject({ leaseToken: "crypto-lease", status: "processing" });
  });

  it("returns a safe active-deletion projection to platform admins and keeps support read-only", async () => {
    const runtime = createRuntime();
    seedPlatformAdmin(runtime.database, "risk");
    const requested = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "trace-request-must-not-leak",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    runtime.database.prepare(`
      UPDATE shop_deletion_requests
      SET secret_material_destroyed_json = ?
      WHERE id = ? AND shop_id = ?
    `).run('{"marker":"SECRET-JSON-MUST-NOT-LEAK"}', requested.id, SHOP_ID);

    const riskOverview = await listActiveDeletionRequests({
      env: runtime.env,
      userId: "admin-a",
    });
    expect(riskOverview.canOperate).toBe(true);
    expect(riskOverview.requests).toHaveLength(1);
    expect(Object.keys(riskOverview.requests[0] ?? {}).sort()).toEqual([
      "checkoutBlockedAt",
      "createdAt",
      "deletionRequestId",
      "financialRecordsRetainUntil",
      "graceEndsAt",
      "lastSafeErrorCode",
      "legalHoldUntil",
      "reasonCode",
      "routingRemovedAt",
      "shopName",
      "shopPublicId",
      "status",
      "updatedAt",
      "version",
    ]);
    expect(riskOverview.requests[0]).toMatchObject({
      deletionRequestId: requested.id,
      shopName: "Alpha Shop",
      shopPublicId: SHOP_PUBLIC_ID,
    });
    const serialized = JSON.stringify(riskOverview);
    expect(serialized).not.toContain("trace-request-must-not-leak");
    expect(serialized).not.toContain("SECRET-JSON-MUST-NOT-LEAK");
    expect(riskOverview.requests[0]).not.toHaveProperty("shopId");
    expect(riskOverview.requests[0]).not.toHaveProperty("requestedByUserId");
    expect(riskOverview.requests[0]).not.toHaveProperty("requestId");

    await expect(listActiveDeletionRequests({
      env: runtime.env,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });

    const supportRuntime = createRuntime();
    seedPlatformAdmin(supportRuntime.database, "support");
    const supportRequested = await requestShopDeletion({
      env: supportRuntime.env,
      reasonCode: "seller_request",
      requestId: "support-read-projection",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const supportOverview = await listActiveDeletionRequests({
      env: supportRuntime.env,
      userId: "admin-a",
    });
    expect(supportOverview).toMatchObject({ canOperate: false });
    expect(supportOverview.requests).toHaveLength(1);
    await expect(applyDeletionLegalHold({
      action: "set",
      actorUserId: "admin-a",
      deletionRequestId: supportRequested.id,
      env: supportRuntime.env,
      expectedVersion: supportRequested.version,
      holdUntil: "2027-01-01T00:00:00.000Z",
      idempotencyKey: "support-legal-hold-denied-001",
      now: NOW,
      reasonCode: "legal_preservation",
      requestId: "support-legal-hold-denied",
      shopPublicId: SHOP_PUBLIC_ID,
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });

  it("denies an un-enrolled admin on deletion reads and legal holds until two-factor enrollment completes", async () => {
    const runtime = createRuntime();
    const nowIso = NOW.toISOString();
    runtime.database.exec(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES ('admin-unenrolled', 'unenrolled-deletion@example.test', 'Unenrolled Admin', 'active', '${nowIso}', '${nowIso}');
      INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
      VALUES ('admin-unenrolled', 'risk', 'active', '${nowIso}', '${nowIso}');
    `);
    const requested = await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-unenrolled-deletion",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const before = runtime.database.prepare(`
      SELECT status, legal_hold_until AS legalHoldUntil, version
      FROM shop_deletion_requests WHERE id = ? AND shop_id = ?
    `).get(requested.id, SHOP_ID);

    // Deletion-reader path: the queue projection is denied before any read.
    await expect(listActiveDeletionRequests({
      env: runtime.env,
      userId: "admin-unenrolled",
    })).rejects.toMatchObject({ code: "admin_two_factor_required", status: 403 });
    // Operator path: the legal-hold mutation is denied through the real guard.
    const holdInput = {
      action: "set" as const,
      actorUserId: "admin-unenrolled",
      deletionRequestId: requested.id,
      env: runtime.env,
      expectedVersion: requested.version,
      holdUntil: "2027-01-01T00:00:00.000Z",
      idempotencyKey: "unenrolled-legal-hold-001",
      now: NOW,
      reasonCode: "legal_preservation",
      requestId: "request-unenrolled-hold",
      shopPublicId: SHOP_PUBLIC_ID,
    };
    await expect(applyDeletionLegalHold(holdInput))
      .rejects.toMatchObject({ code: "admin_two_factor_required", status: 403 });

    // No side effects: the request row is untouched and nothing was audited.
    expect(runtime.database.prepare(`
      SELECT status, legal_hold_until AS legalHoldUntil, version
      FROM shop_deletion_requests WHERE id = ? AND shop_id = ?
    `).get(requested.id, SHOP_ID)).toEqual(before);
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id = 'admin-unenrolled'
    `).get()).toEqual({ count: 0 });

    runtime.database.prepare(`
      UPDATE platform_users SET two_factor_enabled = 1, two_factor_enabled_at = ?
      WHERE id = 'admin-unenrolled'
    `).run(nowIso);
    const overview = await listActiveDeletionRequests({
      env: runtime.env,
      userId: "admin-unenrolled",
    });
    expect(overview.canOperate).toBe(true);
    expect(overview.requests).toHaveLength(1);
    const held = await applyDeletionLegalHold(holdInput);
    expect(held).toMatchObject({ action: "set", status: "applied", version: requested.version + 1 });
    expect(runtime.database.prepare(`
      SELECT status, legal_hold_until AS legalHoldUntil, version
      FROM shop_deletion_requests WHERE id = ? AND shop_id = ?
    `).get(requested.id, SHOP_ID)).toMatchObject({
      legalHoldUntil: "2027-01-01T00:00:00.000Z",
      status: "retention_hold",
      version: held.version,
    });
  });

  it("disconnects generic channels, shreds their envelopes, and terminalizes queued work idempotently", async () => {
    const runtime = createRuntime();
    seedOtherTenant(runtime.database);
    const nowIso = NOW.toISOString();
    runtime.database.exec(`
      INSERT INTO shop_channels (
        id, shop_id, channel_code, status, settings_json, version, created_at, updated_at
      ) VALUES ('channel-shop-a', '${SHOP_ID}', 'telegram', 'enabled', '{}', 1, '${nowIso}', '${nowIso}');
      INSERT INTO channel_connections (
        id, public_id, shop_id, shop_channel_id, provider_code, status,
        settings_json, connected_at, version, created_at, updated_at
      ) VALUES (
        'connection-shop-a', 'connection_public_shop_a', '${SHOP_ID}', 'channel-shop-a',
        'telegram', 'active', '{}', '${nowIso}', 1, '${nowIso}', '${nowIso}'
      );
      INSERT INTO channel_credentials (
        id, shop_id, connection_id, provider_code, status, version, key_version,
        credential_envelope_ciphertext_b64, credential_envelope_iv_b64,
        credential_fingerprint, created_by_user_id, activated_at, created_at
      ) VALUES (
        'channel-credential-a', '${SHOP_ID}', 'connection-shop-a', 'telegram', 'active', 1, 'v1',
        'ciphertext0123456789', 'iv0123456789',
        '${"a".repeat(64)}', '${USER_ID}', '${nowIso}', '${nowIso}'
      );
      INSERT INTO api_credentials (
        id, public_id, shop_id, name, scope_json, token_hash, status,
        created_by_user_id, version, created_at, updated_at
      ) VALUES (
        'api-credential-delete-a',
        'akc_00000000-0000-4000-8000-000000000020',
        '${SHOP_ID}', 'Deletion test key', '["shop:read"]',
        '${"d".repeat(43)}', 'active', '${USER_ID}', 1, '${nowIso}', '${nowIso}'
      );
      INSERT INTO domain_events (
        id, shop_id, event_type, aggregate_type, aggregate_id, schema_version,
        idempotency_key_hash, source_connection_id, status, attempts, next_attempt_at,
        occurred_at, version, created_at, updated_at
      ) VALUES (
        'domain-event-a', '${SHOP_ID}', 'order.created', 'order', 'order-a', 1,
        '${"b".repeat(64)}', 'connection-shop-a', 'retryable', 1, '${AFTER_GRACE.toISOString()}',
        '${nowIso}', 1, '${nowIso}', '${nowIso}'
      );
      INSERT INTO delivery_jobs (
        id, shop_id, event_id, connection_id, purpose, queue_kind,
        idempotency_key_hash, status, attempts, next_attempt_at, version, created_at, updated_at
      ) VALUES (
        'delivery-job-a', '${SHOP_ID}', 'domain-event-a', 'connection-shop-a',
        'order.notification', 'notification', '${"c".repeat(64)}', 'pending', 0,
        '${AFTER_GRACE.toISOString()}', 1, '${nowIso}', '${nowIso}'
      );
      INSERT INTO security_rate_limits (
        id, shop_id, scope_key, action, subject_hash, window_started_at,
        window_ends_at, request_count, blocked_count, blocked_until,
        version, created_at, updated_at
      ) VALUES
        ('rate-limit-delete-a', '${SHOP_ID}', 'api-credential:api-credential-delete-a',
          'public_api_v1', '${"a".repeat(43)}', '${nowIso}', '${AFTER_GRACE.toISOString()}',
          1, 0, NULL, 1, '${nowIso}', '${nowIso}'),
        ('rate-limit-delete-b', 'shop-b', 'api-credential:other-credential',
          'public_api_v1', '${"b".repeat(43)}', '${nowIso}', '${AFTER_GRACE.toISOString()}',
          1, 0, NULL, 1, '${nowIso}', '${nowIso}');
    `);

    await requestShopDeletion({
      env: runtime.env,
      reasonCode: "seller_request",
      requestId: "request-generic-delete",
      runtime: { now: NOW },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const completed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-generic-delete-resume",
      runtime: {
        cleanupCustomDomains: () => Promise.resolve(),
        cleanupPayment: () => Promise.resolve(),
        cleanupTelegram: () => Promise.resolve(),
        now: AFTER_GRACE,
      },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });

    expect(completed.status).toBe("completed");
    expect(runtime.database.prepare(`
      SELECT status, disconnected_at AS disconnectedAt
      FROM channel_connections WHERE id = 'connection-shop-a' AND shop_id = ?
    `).get(SHOP_ID)).toMatchObject({ disconnectedAt: AFTER_GRACE.toISOString(), status: "disconnected" });
    expect(runtime.database.prepare(`
      SELECT status FROM shop_channels WHERE id = 'channel-shop-a' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({ status: "disabled" });
    const shredded = runtime.database.prepare(`
      SELECT status, key_version AS keyVersion,
        credential_envelope_ciphertext_b64 AS ciphertext,
        credential_envelope_iv_b64 AS iv, credential_fingerprint AS fingerprint
      FROM channel_credentials WHERE id = 'channel-credential-a' AND shop_id = ?
    `).get(SHOP_ID) as Record<string, unknown>;
    expect(shredded).toMatchObject({
      ciphertext: "destroyed:00000000",
      iv: "destroyed:iv0",
      keyVersion: "destroyed",
      status: "revoked",
    });
    expect(String(shredded.fingerprint)).toHaveLength(64);
    expect(runtime.database.prepare(`
      SELECT status, token_hash AS tokenHash, revoke_reason AS revokeReason, version
      FROM api_credentials WHERE id = 'api-credential-delete-a' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({
      revokeReason: "shop_deleted",
      status: "revoked",
      tokenHash: "d".repeat(43),
      version: 2,
    });
    expect(runtime.database.prepare(`
      SELECT status, next_attempt_at AS nextAttemptAt, last_safe_error_code AS errorCode
      FROM domain_events WHERE id = 'domain-event-a' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({ errorCode: "shop_deleted", nextAttemptAt: null, status: "failed" });
    expect(runtime.database.prepare(`
      SELECT status, next_attempt_at AS nextAttemptAt, last_safe_error_code AS errorCode
      FROM delivery_jobs WHERE id = 'delivery-job-a' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({ errorCode: "shop_deleted", nextAttemptAt: null, status: "canceled" });

    const replayed = await resumeShopDeletion({
      env: runtime.env,
      requestId: "request-generic-delete-replay",
      runtime: { now: new Date(AFTER_GRACE.getTime() + 1) },
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    expect(replayed.status).toBe("completed");
    expect(runtime.database.prepare(`
      SELECT credential_fingerprint AS fingerprint
      FROM channel_credentials WHERE id = 'channel-credential-a' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({ fingerprint: shredded.fingerprint });
    expect(runtime.database.prepare(`
      SELECT status, version FROM api_credentials
      WHERE id = 'api-credential-delete-a' AND shop_id = ?
    `).get(SHOP_ID)).toEqual({ status: "revoked", version: 2 });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM security_rate_limits WHERE shop_id = ?
    `).get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.prepare(`
      SELECT COUNT(*) AS count FROM security_rate_limits WHERE shop_id = 'shop-b'
    `).get()).toEqual({ count: 1 });
  });
});
