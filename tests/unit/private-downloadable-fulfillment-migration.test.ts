import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { purgeExpiredDeliveryGrantClaims } from "../../src/lib/commerce/private-file-maintenance";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = "2026-07-29T00:00:00.000Z";
const GRANT_EXPIRES_AT = "2026-07-29T00:05:00.000Z";
const ENTITLEMENT_EXPIRES_AT = "2026-07-29T01:00:00.000Z";
const ORDER_EXPIRES_AT = "2026-07-30T00:00:00.000Z";
const HASH_A = "a".repeat(43);
const HASH_B = "b".repeat(43);
const HASH_C = "c".repeat(43);
const HASH_D = "d".repeat(43);
const HASH_E = "e".repeat(43);

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

function applyPrivateDownloadMigration(database: DatabaseSync): void {
  database.exec(readFileSync(
    join(process.cwd(), "migrations", "0034_private_downloadable_fulfillment.sql"),
    "utf8",
  ));
}

function seedLegacyCommerce(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency,
      timezone, readiness_version, created_at, updated_at
    ) VALUES
      ('shop-a', 'shop-public-a', 'shop-a', 'Shop A', 'active', 'en', 'USD',
        'UTC', 1, '${NOW}', '${NOW}'),
      ('shop-b', 'shop-public-b', 'shop-b', 'Shop B', 'active', 'vi-VN', 'USD',
        'UTC', 1, '${NOW}', '${NOW}');

    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES
      ('product-a-manual', 'shop-a', 'manual-a', 'Manual A', '', 'active', 'manual', 1, '${NOW}', '${NOW}'),
      ('product-a-manual-2', 'shop-a', 'manual-a-2', 'Manual A 2', '', 'active', 'manual', 1, '${NOW}', '${NOW}'),
      ('product-a-license', 'shop-a', 'license-a', 'License A', '', 'active', 'license_key', 1, '${NOW}', '${NOW}'),
      ('product-b-manual', 'shop-b', 'manual-b', 'Manual B', '', 'active', 'manual', 1, '${NOW}', '${NOW}');

    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      currency, min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES
      ('variant-a-manual', 'shop-a', 'product-a-manual', 'MANUAL-A', 'Default', '{}', 1000, 'USD', 1, 10, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-a-manual-2', 'shop-a', 'product-a-manual-2', 'MANUAL-A-2', 'Default', '{}', 1000, 'USD', 1, 10, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-a-license', 'shop-a', 'product-a-license', 'LICENSE-A', 'Default', '{}', 1000, 'USD', 1, 10, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-b-manual', 'shop-b', 'product-b-manual', 'MANUAL-B', 'Default', '{}', 1000, 'USD', 1, 10, 'active', 1, '${NOW}', '${NOW}');

    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, paid_at, created_at, updated_at
    ) VALUES
      ('order-a-paid', 'order-public-a-paid', 'shop-a', 'A-PAID', 'web', 'processing',
        'paid', 'unfulfilled', 1000, 0, 1000, 'USD', 'en', 'subject-a-paid', '${HASH_A}',
        '${ORDER_EXPIRES_AT}', '${NOW}', '${NOW}', '${NOW}'),
      ('order-a-unpaid', 'order-public-a-unpaid', 'shop-a', 'A-UNPAID', 'web', 'pending_payment',
        'unpaid', 'unfulfilled', 1000, 0, 1000, 'USD', 'en', 'subject-a-unpaid', '${HASH_B}',
        '${ORDER_EXPIRES_AT}', NULL, '${NOW}', '${NOW}'),
      ('order-a-other', 'order-public-a-other', 'shop-a', 'A-OTHER', 'web', 'completed',
        'paid', 'fulfilled', 1000, 0, 1000, 'USD', 'en', 'subject-a-other', '${HASH_C}',
        '${ORDER_EXPIRES_AT}', '${NOW}', '${NOW}', '${NOW}'),
      ('order-a-legacy-license', 'order-public-a-legacy-license', 'shop-a', 'A-LEGACY-LICENSE', 'web', 'processing',
        'paid', 'unfulfilled', 1000, 0, 1000, 'USD', 'en', 'subject-a-legacy-license', '${HASH_D}',
        '${ORDER_EXPIRES_AT}', '${NOW}', '${NOW}', '${NOW}'),
      ('order-b-paid', 'order-public-b-paid', 'shop-b', 'B-PAID', 'web', 'processing',
        'paid', 'unfulfilled', 1000, 0, 1000, 'USD', 'vi-VN', 'subject-b-paid', '${HASH_E}',
        '${ORDER_EXPIRES_AT}', '${NOW}', '${NOW}', '${NOW}');

    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title,
      variant_title, sku, unit_price_minor, quantity, line_total_minor,
      fulfillment_type, created_at
    ) VALUES
      ('item-a-paid', 'shop-a', 'order-a-paid', 'product-a-manual', 'variant-a-manual',
        'Manual A', 'Default', 'MANUAL-A', 1000, 1, 1000, 'manual', '${NOW}'),
      ('item-a-unpaid', 'shop-a', 'order-a-unpaid', 'product-a-manual', 'variant-a-manual',
        'Manual A', 'Default', 'MANUAL-A', 1000, 1, 1000, 'manual', '${NOW}'),
      ('item-a-other', 'shop-a', 'order-a-other', 'product-a-manual-2', 'variant-a-manual-2',
        'Manual A 2', 'Default', 'MANUAL-A-2', 1000, 1, 1000, 'manual', '${NOW}'),
      ('item-a-legacy-license', 'shop-a', 'order-a-legacy-license', 'product-a-manual', 'variant-a-manual',
        'Manual A', 'Default', 'MANUAL-A', 1000, 1, 1000, 'license_key', '${NOW}'),
      ('item-b-paid', 'shop-b', 'order-b-paid', 'product-b-manual', 'variant-b-manual',
        'Manual B', 'Default', 'MANUAL-B', 1000, 1, 1000, 'manual', '${NOW}');
  `);
}

function insertAsset(database: DatabaseSync, input: {
  assetId: string;
  shopId: string;
  status?: "active" | "deleted" | "revoked";
  versionId: string;
  versionStatus?: "active" | "deleted" | "revoked";
}): void {
  const assetStatus = input.status ?? "active";
  const versionStatus = input.versionStatus ?? "active";
  const assetDeletedAt = assetStatus === "deleted" ? NOW : null;
  const versionDeletedAt = versionStatus === "deleted" ? NOW : null;
  database.prepare(`
    INSERT INTO digital_assets (
      id, shop_id, kind, status, created_at, updated_at, deleted_at
    ) VALUES (?, ?, 'private_file', ?, ?, ?, ?)
  `).run(input.assetId, input.shopId, assetStatus, NOW, NOW, assetDeletedAt);
  database.prepare(`
    INSERT INTO digital_asset_versions (
      id, shop_id, asset_id, version, object_key, filename_sanitized,
      content_type, byte_size, content_sha256, object_etag, status,
      created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, 1, ?, 'download.pdf', 'application/pdf', 1024, ?, 'etag-1', ?, ?, ?, ?)
  `).run(
    input.versionId,
    input.shopId,
    input.assetId,
    `private-digital-assets/${input.shopId}/${input.assetId}/${input.versionId}`,
    HASH_A,
    versionStatus,
    NOW,
    NOW,
    versionDeletedAt,
  );
}

function insertPolicy(database: DatabaseSync, input: {
  assetVersionId: string;
  id: string;
  productId: string;
  shopId: string;
}): void {
  database.prepare(`
    INSERT INTO product_fulfillment_policies (
      id, shop_id, product_id, capability, policy_version, asset_version_id,
      max_downloads, grant_ttl_seconds, entitlement_ttl_seconds, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'private_file', 1, ?, 2, 300, 3600, 'active', ?, ?)
  `).run(input.id, input.shopId, input.productId, input.assetVersionId, NOW, NOW);
}

function insertRequirement(database: DatabaseSync, input: {
  id: string;
  orderId: string;
  orderItemId: string;
  policyId: string;
  shopId: string;
  assetVersionId?: string;
}): void {
  database.prepare(`
    INSERT INTO order_item_fulfillment_requirements (
      id, shop_id, order_id, order_item_id, capability, policy_id,
      policy_version, asset_version_id, max_downloads, grant_ttl_seconds,
      entitlement_ttl_seconds, created_at
    ) VALUES (?, ?, ?, ?, 'private_file', ?, 1, ?, 2, 300, 3600, ?)
  `).run(
    input.id,
    input.shopId,
    input.orderId,
    input.orderItemId,
    input.policyId,
    input.assetVersionId ?? "asset-version-a",
    NOW,
  );
}

function insertEntitlement(database: DatabaseSync, input: {
  assetVersionId?: string;
  buyerBindingHash?: string;
  id: string;
  orderId: string;
  orderItemId: string;
  requirementId: string;
  shopId: string;
  status?: "active" | "expired" | "revoked" | "suspended";
}): void {
  const status = input.status ?? "active";
  database.prepare(`
    INSERT INTO digital_entitlements (
      id, shop_id, order_id, order_item_id, requirement_id, asset_version_id,
      buyer_binding_hash, status, max_downloads, download_count,
      access_expires_at, revoked_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, 0, ?, ?, 1, ?, ?)
  `).run(
    input.id,
    input.shopId,
    input.orderId,
    input.orderItemId,
    input.requirementId,
    input.assetVersionId ?? "asset-version-a",
    input.buyerBindingHash ?? HASH_A,
    status,
    ENTITLEMENT_EXPIRES_AT,
    status === "revoked" ? NOW : null,
    NOW,
    NOW,
  );
}

function insertGrant(database: DatabaseSync, input: {
  assetVersionId?: string;
  buyerBindingHash?: string;
  entitlementId: string;
  expiresAt?: string;
  id: string;
  orderId: string;
  orderItemId: string;
  shopId: string;
}): void {
  database.prepare(`
    INSERT INTO delivery_grants (
      id, shop_id, entitlement_id, order_id, order_item_id,
      asset_version_id, buyer_binding_hash, token_nonce, token_hash,
      token_key_version, issuance_key_hash, request_hash, status,
      expires_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'identifier-hmac-v1', ?, ?, 'active', ?, 1, ?, ?)
  `).run(
    input.id,
    input.shopId,
    input.entitlementId,
    input.orderId,
    input.orderItemId,
    input.assetVersionId ?? "asset-version-a",
    input.buyerBindingHash ?? HASH_A,
    HASH_B,
    HASH_C,
    HASH_D,
    HASH_E,
    input.expiresAt ?? GRANT_EXPIRES_AT,
    NOW,
    NOW,
  );
}

function seedPrivateGraph(database: DatabaseSync): void {
  insertAsset(database, { assetId: "asset-a", shopId: "shop-a", versionId: "asset-version-a" });
  insertAsset(database, { assetId: "asset-b", shopId: "shop-b", versionId: "asset-version-b" });
  insertPolicy(database, {
    assetVersionId: "asset-version-a",
    id: "policy-a",
    productId: "product-a-manual",
    shopId: "shop-a",
  });
  insertPolicy(database, {
    assetVersionId: "asset-version-b",
    id: "policy-b",
    productId: "product-b-manual",
    shopId: "shop-b",
  });
  insertRequirement(database, {
    id: "requirement-a-paid",
    orderId: "order-a-paid",
    orderItemId: "item-a-paid",
    policyId: "policy-a",
    shopId: "shop-a",
  });
  insertEntitlement(database, {
    id: "entitlement-a",
    orderId: "order-a-paid",
    orderItemId: "item-a-paid",
    requirementId: "requirement-a-paid",
    shopId: "shop-a",
  });
}

function plan(database: DatabaseSync, sql: string, ...values: SQLInputValue[]): string {
  return database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values)
    .map((row) => String((row as { detail: unknown }).detail))
    .join("\n");
}

function maintenanceBindings(database: DatabaseSync, boundValues: unknown[]): AppBindings {
  return {
    PLATFORM_DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            boundValues.push(...values);
            return {
              run: () => Promise.resolve({
                meta: { changes: Number(database.prepare(sql).run(...values as SQLInputValue[]).changes) },
              }),
            };
          },
        };
      },
    },
  } as unknown as AppBindings;
}

describe("private downloadable fulfillment migration", () => {
  it("applies the full migration chain and creates the bounded capability schema", () => {
    const database = createDatabase();
    try {
      const tables = database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name IN (
          'digital_assets', 'digital_asset_versions', 'product_fulfillment_policies',
          'order_item_fulfillment_requirements', 'digital_entitlements',
          'delivery_grants', 'delivery_grant_claims', 'delivery_grant_consumptions'
        ) ORDER BY name
      `).all().map((row) => (row as { name: string }).name);
      expect(tables).toEqual([
        "delivery_grant_claims",
        "delivery_grant_consumptions",
        "delivery_grants",
        "digital_asset_versions",
        "digital_assets",
        "digital_entitlements",
        "order_item_fulfillment_requirements",
        "product_fulfillment_policies",
      ]);
      expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      database.close();
    }
  });

  it("preserves legacy license-key/manual products and historical orders", () => {
    const database = createDatabase(33);
    try {
      seedLegacyCommerce(database);
      const before = database.prepare(`
        SELECT fulfillment_type AS fulfillmentType, COUNT(*) AS count
        FROM order_items GROUP BY fulfillment_type ORDER BY fulfillment_type
      `).all();

      applyPrivateDownloadMigration(database);

      expect(database.prepare(`
        SELECT fulfillment_type AS fulfillmentType, COUNT(*) AS count
        FROM order_items GROUP BY fulfillment_type ORDER BY fulfillment_type
      `).all()).toEqual(before);
      expect(database.prepare("SELECT COUNT(*) AS count FROM products").get()).toEqual({ count: 4 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 5 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM digital_entitlements").get()).toEqual({ count: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("enforces composite tenant ownership across assets and fulfillment records", () => {
    const database = createDatabase();
    try {
      seedLegacyCommerce(database);
      insertAsset(database, { assetId: "asset-a", shopId: "shop-a", versionId: "asset-version-a" });
      insertAsset(database, { assetId: "asset-b", shopId: "shop-b", versionId: "asset-version-b" });

      expect(() => database.prepare(`
        INSERT INTO digital_asset_versions (
          id, shop_id, asset_id, version, object_key, filename_sanitized,
          content_type, byte_size, content_sha256, object_etag, status,
          created_at, updated_at
        ) VALUES (
          'asset-version-cross', 'shop-b', 'asset-a', 2,
          'private-digital-assets/shop-b/asset-a/asset-version-cross',
          'cross.pdf', 'application/pdf', 1024, ?, 'etag-cross', 'active', ?, ?
        )
      `).run(HASH_A, NOW, NOW)).toThrow(/FOREIGN KEY constraint failed/u);

      expect(() => { insertPolicy(database, {
        assetVersionId: "asset-version-a",
        id: "policy-cross",
        productId: "product-b-manual",
        shopId: "shop-b",
      }); }).toThrow(/private_file_asset_ineligible|FOREIGN KEY constraint failed/u);

      insertPolicy(database, {
        assetVersionId: "asset-version-a",
        id: "policy-a",
        productId: "product-a-manual",
        shopId: "shop-a",
      });
      expect(() => { insertRequirement(database, {
        id: "requirement-cross",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        policyId: "policy-a",
        shopId: "shop-b",
      }); }).toThrow(/private_file_requirement_scope_mismatch|FOREIGN KEY constraint failed/u);

      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("allows policies only for manual products and active tenant-owned assets", () => {
    const database = createDatabase();
    try {
      seedLegacyCommerce(database);
      insertAsset(database, { assetId: "asset-a", shopId: "shop-a", versionId: "asset-version-a" });
      insertAsset(database, {
        assetId: "asset-revoked",
        shopId: "shop-a",
        status: "revoked",
        versionId: "asset-version-revoked",
      });

      expect(() => { insertPolicy(database, {
        assetVersionId: "asset-version-a",
        id: "policy-license",
        productId: "product-a-license",
        shopId: "shop-a",
      }); }).toThrow(/private_file_product_ineligible/u);
      expect(() => { insertPolicy(database, {
        assetVersionId: "asset-version-revoked",
        id: "policy-revoked",
        productId: "product-a-manual",
        shopId: "shop-a",
      }); }).toThrow(/private_file_asset_ineligible/u);

      insertPolicy(database, {
        assetVersionId: "asset-version-a",
        id: "policy-a",
        productId: "product-a-manual",
        shopId: "shop-a",
      });
      expect(() => { insertPolicy(database, {
        assetVersionId: "asset-version-a",
        id: "policy-a-second-active",
        productId: "product-a-manual",
        shopId: "shop-a",
      }); }).toThrow(/UNIQUE constraint failed/u);
    } finally {
      database.close();
    }
  });

  it("binds requirement snapshots to the exact order item, product and legacy fulfillment type", () => {
    const database = createDatabase();
    try {
      seedLegacyCommerce(database);
      insertAsset(database, { assetId: "asset-a", shopId: "shop-a", versionId: "asset-version-a" });
      insertPolicy(database, {
        assetVersionId: "asset-version-a",
        id: "policy-a",
        productId: "product-a-manual",
        shopId: "shop-a",
      });

      expect(() => { insertRequirement(database, {
        id: "requirement-wrong-order",
        orderId: "order-a-other",
        orderItemId: "item-a-paid",
        policyId: "policy-a",
        shopId: "shop-a",
      }); }).toThrow(/private_file_requirement_scope_mismatch/u);
      expect(() => { insertRequirement(database, {
        id: "requirement-wrong-product",
        orderId: "order-a-other",
        orderItemId: "item-a-other",
        policyId: "policy-a",
        shopId: "shop-a",
      }); }).toThrow(/private_file_requirement_scope_mismatch/u);
      expect(() => { insertRequirement(database, {
        id: "requirement-legacy-license",
        orderId: "order-a-legacy-license",
        orderItemId: "item-a-legacy-license",
        policyId: "policy-a",
        shopId: "shop-a",
      }); }).toThrow(/private_file_requirement_scope_mismatch/u);

      expect(() => database.prepare(`
        INSERT INTO order_item_fulfillment_requirements (
          id, shop_id, order_id, order_item_id, capability, policy_id,
          policy_version, asset_version_id, max_downloads, grant_ttl_seconds,
          entitlement_ttl_seconds, created_at
        ) VALUES (
          'requirement-bad-snapshot', 'shop-a', 'order-a-paid', 'item-a-paid',
          'private_file', 'policy-a', 1, 'asset-version-a', 99, 300, 3600, ?
        )
      `).run(NOW)).toThrow(/private_file_requirement_scope_mismatch/u);

      insertRequirement(database, {
        id: "requirement-a-paid",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        policyId: "policy-a",
        shopId: "shop-a",
      });
    } finally {
      database.close();
    }
  });

  it("creates an entitlement only for the paid bound order and policy expiry", () => {
    const database = createDatabase();
    try {
      seedLegacyCommerce(database);
      insertAsset(database, { assetId: "asset-a", shopId: "shop-a", versionId: "asset-version-a" });
      insertPolicy(database, {
        assetVersionId: "asset-version-a",
        id: "policy-a",
        productId: "product-a-manual",
        shopId: "shop-a",
      });
      insertRequirement(database, {
        id: "requirement-a-paid",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        policyId: "policy-a",
        shopId: "shop-a",
      });
      insertRequirement(database, {
        id: "requirement-a-unpaid",
        orderId: "order-a-unpaid",
        orderItemId: "item-a-unpaid",
        policyId: "policy-a",
        shopId: "shop-a",
      });

      expect(() => { insertEntitlement(database, {
        buyerBindingHash: HASH_B,
        id: "entitlement-unpaid",
        orderId: "order-a-unpaid",
        orderItemId: "item-a-unpaid",
        requirementId: "requirement-a-unpaid",
        shopId: "shop-a",
      }); }).toThrow(/private_file_entitlement_scope_mismatch/u);
      expect(() => { insertEntitlement(database, {
        buyerBindingHash: HASH_B,
        id: "entitlement-wrong-buyer",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        requirementId: "requirement-a-paid",
        shopId: "shop-a",
      }); }).toThrow(/private_file_entitlement_scope_mismatch/u);
      expect(() => database.prepare(`
        INSERT INTO digital_entitlements (
          id, shop_id, order_id, order_item_id, requirement_id, asset_version_id,
          buyer_binding_hash, status, max_downloads, download_count,
          access_expires_at, version, created_at, updated_at
        ) VALUES (
          'entitlement-bad-expiry', 'shop-a', 'order-a-paid', 'item-a-paid',
          'requirement-a-paid', 'asset-version-a', ?, 'active', 2, 0,
          '2026-07-30T00:00:00.000Z', 1, ?, ?
        )
      `).run(HASH_A, NOW, NOW)).toThrow(/private_file_entitlement_scope_mismatch/u);

      insertEntitlement(database, {
        id: "entitlement-a",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        requirementId: "requirement-a-paid",
        shopId: "shop-a",
      });
      expect(() => { insertEntitlement(database, {
        id: "entitlement-a-duplicate",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        requirementId: "requirement-a-paid",
        shopId: "shop-a",
      }); }).toThrow(/UNIQUE constraint failed/u);
    } finally {
      database.close();
    }
  });

  it("bounds grant issuance and consumption to active unexpired authoritative state", () => {
    const database = createDatabase();
    try {
      seedLegacyCommerce(database);
      seedPrivateGraph(database);

      expect(() => { insertGrant(database, {
        entitlementId: "entitlement-a",
        expiresAt: "2026-07-29T00:10:00.000Z",
        id: "grant-too-long",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        shopId: "shop-a",
      }); }).toThrow(/private_file_grant_scope_mismatch/u);

      insertGrant(database, {
        entitlementId: "entitlement-a",
        id: "grant-a",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        shopId: "shop-a",
      });
      expect(() => { insertGrant(database, {
        entitlementId: "entitlement-a",
        id: "grant-a-second-active",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        shopId: "shop-a",
      }); }).toThrow(/UNIQUE constraint failed/u);

      expect(() => database.prepare(`
        INSERT INTO delivery_grant_consumptions (
          id, shop_id, entitlement_id, grant_id, order_id,
          asset_version_id, request_id, outcome, created_at
        ) VALUES (
          'consumption-expired', 'shop-a', 'entitlement-a', 'grant-a',
          'order-a-paid', 'asset-version-a', 'request-expired', 'served',
          '2026-07-29T00:06:00.000Z'
        )
      `).run()).toThrow(/private_file_consumption_scope_mismatch/u);
      expect(() => database.prepare(`
        INSERT INTO delivery_grant_consumptions (
          id, shop_id, entitlement_id, grant_id, order_id,
          asset_version_id, request_id, outcome, created_at
        ) VALUES (
          'consumption-cross', 'shop-b', 'entitlement-a', 'grant-a',
          'order-b-paid', 'asset-version-b', 'request-cross', 'served',
          '2026-07-29T00:01:00.000Z'
        )
      `).run()).toThrow(/private_file_consumption_scope_mismatch|FOREIGN KEY constraint failed/u);

      database.prepare(`
        INSERT INTO delivery_grant_consumptions (
          id, shop_id, entitlement_id, grant_id, order_id,
          asset_version_id, request_id, outcome, created_at
        ) VALUES (
          'consumption-a', 'shop-a', 'entitlement-a', 'grant-a',
          'order-a-paid', 'asset-version-a', 'request-a', 'served',
          '2026-07-29T00:01:00.000Z'
        )
      `).run();
      expect(() => database.prepare(`
        INSERT INTO delivery_grant_consumptions (
          id, shop_id, entitlement_id, grant_id, order_id,
          asset_version_id, request_id, outcome, created_at
        ) VALUES (
          'consumption-a-replay', 'shop-a', 'entitlement-a', 'grant-a',
          'order-a-paid', 'asset-version-a', 'request-a-replay', 'served',
          '2026-07-29T00:02:00.000Z'
        )
      `).run()).toThrow(/UNIQUE constraint failed/u);

      database.prepare(`
        UPDATE digital_entitlements
        SET status = 'revoked', revoked_at = '2026-07-29T00:03:00.000Z',
          version = 2, updated_at = ?
        WHERE id = 'entitlement-a'
      `).run(NOW);
      expect(() => { insertGrant(database, {
        entitlementId: "entitlement-a",
        id: "grant-after-revocation",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        shopId: "shop-a",
      }); }).toThrow(/private_file_grant_scope_mismatch/u);
    } finally {
      database.close();
    }
  });

  it("fences private download claims by tenant, active scope and a bounded lease", () => {
    const database = createDatabase();
    try {
      seedLegacyCommerce(database);
      seedPrivateGraph(database);
      insertGrant(database, {
        entitlementId: "entitlement-a",
        id: "grant-a",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        shopId: "shop-a",
      });

      database.prepare(`
        INSERT INTO delivery_grant_claims (
          id, shop_id, grant_id, created_at, lease_expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run("claim-a", "shop-a", "grant-a", NOW, "2026-07-29T00:04:00.000Z");

      expect(() => database.prepare(`
        INSERT INTO delivery_grant_claims (
          id, shop_id, grant_id, created_at, lease_expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run("claim-replay", "shop-a", "grant-a", NOW, "2026-07-29T00:04:00.000Z"))
        .toThrow(/UNIQUE constraint failed/u);
      expect(() => database.prepare(`
        INSERT INTO delivery_grant_claims (
          id, shop_id, grant_id, created_at, lease_expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run("claim-cross", "shop-b", "grant-a", NOW, "2026-07-29T00:04:00.000Z"))
        .toThrow(/private_file_claim_scope_mismatch|FOREIGN KEY constraint failed/u);
      expect(() => database.prepare(`
        INSERT INTO delivery_grant_claims (
          id, shop_id, grant_id, created_at, lease_expires_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run("claim-too-long", "shop-a", "grant-a", NOW, "2026-07-29T00:05:01.000Z"))
        .toThrow(/private_file_claim_scope_mismatch|CHECK constraint failed/u);
      expect(() => database.prepare(`
        UPDATE delivery_grant_claims SET lease_expires_at = ? WHERE id = ?
      `).run("2026-07-29T00:03:00.000Z", "claim-a"))
        .toThrow(/private_file_claim_immutable/u);

      database.prepare(`
        DELETE FROM delivery_grant_claims
        WHERE id = ? AND shop_id = ? AND grant_id = ?
      `).run("claim-a", "shop-a", "grant-a");
      expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grant_claims").get()).toEqual({ count: 0 });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      database.close();
    }
  });

  it("purges expired claims in bounded tenant-safe batches and retains active leases", async () => {
    const database = createDatabase();
    try {
      seedLegacyCommerce(database);
      seedPrivateGraph(database);

      insertGrant(database, {
        entitlementId: "entitlement-a",
        id: "grant-a",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        shopId: "shop-a",
      });
      insertPolicy(database, {
        assetVersionId: "asset-version-a",
        id: "policy-a-other",
        productId: "product-a-manual-2",
        shopId: "shop-a",
      });

      insertRequirement(database, {
        id: "requirement-a-other",
        orderId: "order-a-other",
        orderItemId: "item-a-other",
        policyId: "policy-a-other",
        shopId: "shop-a",
      });
      insertEntitlement(database, {
        assetVersionId: "asset-version-a",
        buyerBindingHash: HASH_C,
        id: "entitlement-a-other",
        orderId: "order-a-other",
        orderItemId: "item-a-other",
        requirementId: "requirement-a-other",
        shopId: "shop-a",
      });
      insertGrant(database, {
        buyerBindingHash: HASH_C,
        entitlementId: "entitlement-a-other",
        id: "grant-a-active",
        orderId: "order-a-other",
        orderItemId: "item-a-other",
        shopId: "shop-a",
      });

      database.exec(`
        INSERT INTO orders (
          id, public_id, shop_id, order_number, source_channel, status,
          payment_status, fulfillment_status, subtotal_minor, discount_minor,
          total_minor, currency, locale, checkout_subject_hash, order_token_hash,
          expires_at, paid_at, created_at, updated_at
        ) VALUES (
          'order-b-other', 'order-public-b-other', 'shop-b', 'B-OTHER', 'web', 'processing',
          'paid', 'unfulfilled', 1000, 0, 1000, 'USD', 'vi-VN', 'subject-b-other', '${HASH_A}',
          '${ORDER_EXPIRES_AT}', '${NOW}', '${NOW}', '${NOW}'
        );
        INSERT INTO order_items (
          id, shop_id, order_id, product_id, variant_id, product_title,
          variant_title, sku, unit_price_minor, quantity, line_total_minor,
          fulfillment_type, created_at
        ) VALUES (
          'item-b-other', 'shop-b', 'order-b-other', 'product-b-manual', 'variant-b-manual',
          'Manual B', 'Default', 'MANUAL-B', 1000, 1, 1000, 'manual', '${NOW}'
        );
      `);
      insertRequirement(database, {
        assetVersionId: "asset-version-b",
        id: "requirement-b-paid",
        orderId: "order-b-paid",
        orderItemId: "item-b-paid",
        policyId: "policy-b",
        shopId: "shop-b",
      });
      insertEntitlement(database, {
        assetVersionId: "asset-version-b",
        buyerBindingHash: HASH_E,
        id: "entitlement-b-paid",
        orderId: "order-b-paid",
        orderItemId: "item-b-paid",
        requirementId: "requirement-b-paid",
        shopId: "shop-b",
      });
      insertGrant(database, {
        buyerBindingHash: HASH_E,
        assetVersionId: "asset-version-b",
        entitlementId: "entitlement-b-paid",
        id: "grant-b-expired",
        orderId: "order-b-paid",
        orderItemId: "item-b-paid",
        shopId: "shop-b",
      });
      insertRequirement(database, {
        assetVersionId: "asset-version-b",
        id: "requirement-b-other",
        orderId: "order-b-other",
        orderItemId: "item-b-other",
        policyId: "policy-b",
        shopId: "shop-b",
      });
      insertEntitlement(database, {
        assetVersionId: "asset-version-b",
        id: "entitlement-b-other",
        orderId: "order-b-other",
        orderItemId: "item-b-other",
        requirementId: "requirement-b-other",
        shopId: "shop-b",
      });
      insertGrant(database, {
        assetVersionId: "asset-version-b",
        buyerBindingHash: HASH_A,
        entitlementId: "entitlement-b-other",
        id: "grant-b-active",
        orderId: "order-b-other",
        orderItemId: "item-b-other",
        shopId: "shop-b",
      });

      database.prepare(`
        INSERT INTO delivery_grant_claims (id, shop_id, grant_id, created_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run("claim-a-expired", "shop-a", "grant-a", NOW, "2026-07-29T00:01:00.000Z");
      database.prepare(`
        INSERT INTO delivery_grant_claims (id, shop_id, grant_id, created_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run("claim-a-active", "shop-a", "grant-a-active", NOW, "2026-07-29T00:04:00.000Z");
      database.prepare(`
        INSERT INTO delivery_grant_claims (id, shop_id, grant_id, created_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run("claim-b-expired", "shop-b", "grant-b-expired", NOW, "2026-07-29T00:01:00.000Z");
      database.prepare(`
        INSERT INTO delivery_grant_claims (id, shop_id, grant_id, created_at, lease_expires_at)
        VALUES (?, ?, ?, ?, ?)
      `).run("claim-b-active", "shop-b", "grant-b-active", NOW, "2026-07-29T00:04:00.000Z");

      const boundValues: unknown[] = [];
      const env = maintenanceBindings(database, boundValues);
      const purgeAt = new Date("2026-07-29T00:02:00.000Z");
      expect(await purgeExpiredDeliveryGrantClaims(env, purgeAt, 1)).toBe(1);
      expect(boundValues).toEqual([purgeAt.toISOString(), 1]);
      expect(database.prepare("SELECT id FROM delivery_grant_claims ORDER BY id").all()).toEqual([
        { id: "claim-a-active" },
        { id: "claim-b-active" },
        { id: "claim-b-expired" },
      ]);

      expect(await purgeExpiredDeliveryGrantClaims(env, purgeAt, 1)).toBe(1);
      expect(database.prepare("SELECT id FROM delivery_grant_claims ORDER BY id").all()).toEqual([
        { id: "claim-a-active" },
        { id: "claim-b-active" },
      ]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(JSON.stringify(boundValues)).not.toContain("token");
      expect(JSON.stringify(boundValues)).not.toContain("secret");
    } finally {
      database.close();
    }
  });

  it("keeps identities, snapshots and terminal transition evidence immutable", () => {
    const database = createDatabase();
    try {
      seedLegacyCommerce(database);
      seedPrivateGraph(database);
      insertGrant(database, {
        entitlementId: "entitlement-a",
        id: "grant-a",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        shopId: "shop-a",
      });
      database.prepare(`
        INSERT INTO delivery_grant_consumptions (
          id, shop_id, entitlement_id, grant_id, order_id,
          asset_version_id, request_id, outcome, created_at
        ) VALUES (
          'consumption-a', 'shop-a', 'entitlement-a', 'grant-a',
          'order-a-paid', 'asset-version-a', 'request-a', 'served',
          '2026-07-29T00:01:00.000Z'
        )
      `).run();

      expect(() => database.prepare(`
        UPDATE digital_assets SET shop_id = 'shop-b', updated_at = ? WHERE id = 'asset-a'
      `).run(NOW)).toThrow(/digital_asset_identity_immutable/u);
      expect(() => database.prepare(`
        UPDATE digital_asset_versions SET object_key = 'private-digital-assets/changed/object-key', updated_at = ?
        WHERE id = 'asset-version-a'
      `).run(NOW)).toThrow(/digital_asset_version_identity_immutable/u);
      expect(() => database.prepare(`
        UPDATE product_fulfillment_policies SET max_downloads = 3, updated_at = ? WHERE id = 'policy-a'
      `).run(NOW)).toThrow(/private_file_policy_identity_immutable/u);
      expect(() => database.prepare(`
        UPDATE order_item_fulfillment_requirements SET max_downloads = 1 WHERE id = 'requirement-a-paid'
      `).run()).toThrow(/private_file_requirement_immutable/u);
      expect(() => database.prepare(`
        DELETE FROM order_item_fulfillment_requirements WHERE id = 'requirement-a-paid'
      `).run()).toThrow(/private_file_requirement_immutable/u);

      expect(() => database.prepare(`
        UPDATE digital_entitlements SET download_count = 1, version = 1, updated_at = ?
        WHERE id = 'entitlement-a'
      `).run(NOW)).toThrow(/private_file_entitlement_transition_invalid/u);
      database.prepare(`
        UPDATE digital_entitlements
        SET status = 'revoked', revoked_at = '2026-07-29T00:02:00.000Z', version = 2, updated_at = ?
        WHERE id = 'entitlement-a'
      `).run(NOW);
      expect(() => database.prepare(`
        UPDATE digital_entitlements
        SET revoked_at = '2026-07-29T00:03:00.000Z', version = 3, updated_at = ?
        WHERE id = 'entitlement-a'
      `).run(NOW)).toThrow(/private_file_entitlement_transition_invalid/u);

      database.prepare(`
        UPDATE delivery_grants
        SET status = 'consumed', consumed_at = '2026-07-29T00:01:00.000Z', version = 2, updated_at = ?
        WHERE id = 'grant-a'
      `).run(NOW);
      expect(() => database.prepare(`
        UPDATE delivery_grants
        SET consumed_at = '2026-07-29T00:02:00.000Z', version = 3, updated_at = ?
        WHERE id = 'grant-a'
      `).run(NOW)).toThrow(/private_file_grant_transition_invalid/u);
      expect(() => database.prepare(`
        UPDATE delivery_grant_consumptions SET request_id = 'changed' WHERE id = 'consumption-a'
      `).run()).toThrow(/private_file_consumption_immutable/u);
      expect(() => database.prepare(`
        DELETE FROM delivery_grant_consumptions WHERE id = 'consumption-a'
      `).run()).toThrow(/private_file_consumption_immutable/u);

      database.prepare(`
        UPDATE digital_assets
        SET status = 'revoked', updated_at = ? WHERE id = 'asset-b'
      `).run(NOW);
      expect(() => database.prepare(`
        UPDATE digital_assets
        SET status = 'active', updated_at = ? WHERE id = 'asset-b'
      `).run(NOW)).toThrow(/digital_asset_transition_invalid/u);
      database.prepare(`
        UPDATE product_fulfillment_policies
        SET status = 'retired', retired_at = ?, updated_at = ? WHERE id = 'policy-b'
      `).run(NOW, NOW);
      expect(() => database.prepare(`
        UPDATE product_fulfillment_policies
        SET status = 'active', retired_at = NULL, updated_at = ? WHERE id = 'policy-b'
      `).run(NOW)).toThrow(/private_file_policy_transition_invalid/u);
    } finally {
      database.close();
    }
  });

  it("provides tenant-leading indexes for fulfillment lookups and due access paths", () => {
    const database = createDatabase();
    try {
      seedLegacyCommerce(database);
      seedPrivateGraph(database);
      insertGrant(database, {
        entitlementId: "entitlement-a",
        id: "grant-a",
        orderId: "order-a-paid",
        orderItemId: "item-a-paid",
        shopId: "shop-a",
      });

      const tenantIndexes = [
        "idx_products_shop_id",
        "idx_order_items_shop_id",
        "idx_digital_assets_shop_status",
        "idx_digital_asset_versions_shop_asset",
        "idx_digital_asset_versions_shop_status",
        "idx_product_fulfillment_policies_shop_active",
        "idx_product_fulfillment_policies_shop_asset",
        "idx_order_item_requirements_shop_order",
        "idx_order_item_requirements_shop_asset",
        "idx_digital_entitlements_shop_order",
        "idx_digital_entitlements_shop_access",
        "idx_delivery_grants_shop_active_entitlement",
        "idx_delivery_grants_shop_order",
        "idx_delivery_grants_shop_expiry",
        "idx_delivery_grant_claims_shop_expiry",
        "idx_delivery_grant_consumptions_shop_entitlement",
        "idx_delivery_grant_consumptions_shop_order",
      ];
      for (const indexName of tenantIndexes) {
        const columns = database.prepare(`PRAGMA index_info('${indexName}')`).all();
        expect(columns[0]).toMatchObject({ name: "shop_id", seqno: 0 });
      }

      expect(plan(database, `
        SELECT id FROM delivery_grants
        WHERE shop_id = ? AND entitlement_id = ? AND status = 'active'
      `, "shop-a", "entitlement-a")).toContain("idx_delivery_grants_shop_active_entitlement");
      expect(plan(database, `
        SELECT id FROM digital_entitlements
        WHERE shop_id = ? AND status = 'active' AND access_expires_at <= ?
      `, "shop-a", ENTITLEMENT_EXPIRES_AT)).toContain("idx_digital_entitlements_shop_access");
      expect(plan(database, `
        SELECT id FROM delivery_grants
        WHERE shop_id = ? AND status = 'active' AND expires_at <= ?
      `, "shop-a", GRANT_EXPIRES_AT)).toContain("idx_delivery_grants_shop_expiry");
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } finally {
      database.close();
    }
  });
});
