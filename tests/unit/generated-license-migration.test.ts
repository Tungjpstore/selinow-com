import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

const NOW = "2026-07-30T06:00:00.000Z";
const HASH_A = "a".repeat(43);
const HASH_C = "c".repeat(43);
const HASH_D = "d".repeat(43);
const HASH_E = "e".repeat(43);
const HASH_F = "f".repeat(43);
const databases: DatabaseSync[] = [];

function hash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

interface EntitlementGraph {
  entitlementId: string;
  grantId: string;
  orderId: string;
  orderItemId: string;
  requirementId: string;
  resourceId: string;
}

function applyMigrations(database: DatabaseSync, maximumMigration: number): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    if (Number.parseInt(filename.slice(0, 4), 10) > maximumMigration) break;
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function createLegacyDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database, 48);
  return database;
}

function applyGeneratedLicenseMigration(database: DatabaseSync): void {
  database.exec(readFileSync(
    join(process.cwd(), "migrations", "0049_generated_license_fulfillment.sql"),
    "utf8",
  ));
}

function applyGeneratedLicenseCurrentMigrations(database: DatabaseSync): void {
  for (const filename of [
    "0049_generated_license_fulfillment.sql",
    "0050_generated_license_deletion_lifecycle.sql",
    "0051_generated_license_rotation.sql",
    "0052_generated_license_request_hardening.sql",
  ]) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function seedShop(database: DatabaseSync, suffix: string): void {
  database.prepare(`
    INSERT INTO platform_users (
      id, email_normalized, display_name, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'active', ?, ?)
  `).run(
    `user-${suffix}`,
    `${suffix}@example.test`,
    `User ${suffix}`,
    NOW,
    NOW,
  );
  database.prepare(`
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', 'en', 'USD', 'UTC', 1, ?, ?)
  `).run(
    `shop-${suffix}`,
    `shop-public-${suffix}`,
    `shop-${suffix}`,
    `Shop ${suffix}`,
    NOW,
    NOW,
  );
}

function seedEntitlementGraph(database: DatabaseSync, input: {
  grantQuantity?: number;
  resourceType?: "generated_license" | "membership";
  shopSuffix: string;
  suffix: string;
}): EntitlementGraph {
  const grantQuantity = input.grantQuantity ?? 1;
  const resourceType = input.resourceType ?? "generated_license";
  const shopId = `shop-${input.shopSuffix}`;
  const productId = `product-${input.suffix}`;
  const variantId = `variant-${input.suffix}`;
  const resourceId = `resource-${input.suffix}`;
  const policyId = `policy-${input.suffix}`;
  const orderId = `order-${input.suffix}`;
  const orderItemId = `item-${input.suffix}`;
  const requirementId = `requirement-${input.suffix}`;
  const entitlementId = `entitlement-${input.suffix}`;
  const grantId = `grant-${input.suffix}`;

  database.prepare(`
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'active', 'manual', 1, ?, ?)
  `).run(productId, shopId, `product-${input.suffix}`, `Product ${input.suffix}`, NOW, NOW);
  database.prepare(`
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor, currency,
      min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Default', '{}', 0, 'USD', 1, 10, 'active', 1, ?, ?)
  `).run(variantId, shopId, productId, `SKU-${input.suffix}`, NOW, NOW);
  database.prepare(`
    INSERT INTO entitlement_resources (
      id, shop_id, resource_key, resource_type, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?)
  `).run(resourceId, shopId, `resource.${input.suffix}`, resourceType, NOW, NOW);
  database.prepare(`
    INSERT INTO product_entitlement_policies (
      id, shop_id, product_id, resource_id, policy_version, activation_condition,
      grant_quantity_per_unit, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 'order_paid', ?, 'active', ?, ?)
  `).run(policyId, shopId, productId, resourceId, grantQuantity, NOW, NOW);
  database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, paid_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'web', 'processing', 'paid', 'fulfilled', 0, 0, 0,
      'USD', 'en', ?, ?, ?, ?, ?, ?)
  `).run(
    orderId,
    `order-public-${input.suffix}`,
    shopId,
    `ORDER-${input.suffix}`,
    `subject-${input.suffix}`,
    HASH_A,
    "2026-07-30T08:00:00.000Z",
    NOW,
    NOW,
    NOW,
  );
  database.prepare(`
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title,
      variant_title, sku, unit_price_minor, quantity, line_total_minor,
      fulfillment_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'Default', ?, 0, 1, 0, 'manual', ?)
  `).run(
    orderItemId,
    shopId,
    orderId,
    productId,
    variantId,
    `Product ${input.suffix}`,
    `SKU-${input.suffix}`,
    NOW,
  );
  database.prepare(`
    INSERT INTO order_item_entitlement_requirements (
      id, shop_id, order_id, order_item_id, policy_id, resource_id,
      policy_version, activation_condition, item_quantity, grant_quantity,
      entitlement_ttl_seconds, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'order_paid', 1, ?, NULL, ?)
  `).run(requirementId, shopId, orderId, orderItemId, policyId, resourceId, grantQuantity, NOW);
  database.prepare(`
    INSERT INTO entitlements (
      id, shop_id, order_id, order_item_id, requirement_id, resource_id,
      buyer_binding_hash, status, grant_quantity, entitlement_ttl_seconds,
      access_expires_at, activated_at, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, ?, 1, ?, ?)
  `).run(
    entitlementId,
    shopId,
    orderId,
    orderItemId,
    requirementId,
    resourceId,
    HASH_A,
    grantQuantity,
    NOW,
    NOW,
    NOW,
  );
  database.prepare(`
    INSERT INTO entitlement_grants (
      id, shop_id, entitlement_id, requirement_id, order_id, resource_id,
      source_kind, source_payment_event_id, idempotency_key_hash, request_hash,
      request_id, granted_quantity, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'free_checkout', NULL, ?, ?, ?, ?, ?)
  `).run(
    grantId,
    shopId,
    entitlementId,
    requirementId,
    orderId,
    resourceId,
    hash(`grant-idempotency:${input.suffix}`),
    hash(`grant-request:${input.suffix}`),
    `checkout-${input.suffix}`,
    grantQuantity,
    NOW,
  );

  return { entitlementId, grantId, orderId, orderItemId, requirementId, resourceId };
}

function insertConnection(database: DatabaseSync, suffix: string): void {
  database.prepare(`
    INSERT INTO generated_license_provider_connections (
      id, shop_id, provider_code, provider_environment, status,
      external_account_fingerprint, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, 'fake.license', 'sandbox', 'active', ?, ?, ?, ?)
  `).run(
    `connection-${suffix}`,
    `shop-${suffix}`,
    HASH_D,
    `user-${suffix}`,
    NOW,
    NOW,
  );
}

function insertCredential(database: DatabaseSync, input: {
  connectionSuffix: string;
  id: string;
  providerCode?: string;
  shopSuffix: string;
}): void {
  database.prepare(`
    INSERT INTO generated_license_provider_credentials (
      id, shop_id, connection_id, provider_code, credential_version, status,
      key_version, endpoint_ciphertext_b64, endpoint_iv_b64,
      credential_ciphertext_b64, credential_iv_b64, endpoint_fingerprint,
      credential_fingerprint, created_by_user_id, activated_at, created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, 1, 'active', 'v1', 'endpoint-cipher', 'endpoint-iv',
      'credential-cipher', 'credential-iv', ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    `shop-${input.shopSuffix}`,
    `connection-${input.connectionSuffix}`,
    input.providerCode ?? "fake.license",
    HASH_E,
    HASH_F,
    `user-${input.shopSuffix}`,
    NOW,
    NOW,
    NOW,
  );
}

function insertBinding(database: DatabaseSync, input: {
  connectionSuffix: string;
  graph: EntitlementGraph;
  id: string;
  shopSuffix: string;
}): void {
  database.prepare(`
    INSERT INTO generated_license_resource_bindings (
      id, shop_id, resource_id, connection_id, provider_code,
      generation_template_version, request_shape_hash, status,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'fake.license', 1, ?, 'active', ?, ?, ?)
  `).run(
    input.id,
    `shop-${input.shopSuffix}`,
    input.graph.resourceId,
    `connection-${input.connectionSuffix}`,
    HASH_A,
    `user-${input.shopSuffix}`,
    NOW,
    NOW,
  );
}

function insertRequirementSnapshot(database: DatabaseSync, input: {
  bindingId: string;
  connectionSuffix: string;
  graph: EntitlementGraph;
  id: string;
  requestedQuantity?: number;
  shopSuffix: string;
}): void {
  database.prepare(`
    INSERT INTO generated_license_requirement_snapshots (
      id, shop_id, entitlement_requirement_id, entitlement_id, order_id,
      order_item_id, resource_id, binding_id, connection_id, provider_code,
      generation_template_version, request_shape_hash, requested_quantity,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fake.license', 1, ?, ?, ?)
  `).run(
    input.id,
    `shop-${input.shopSuffix}`,
    input.graph.requirementId,
    input.graph.entitlementId,
    input.graph.orderId,
    input.graph.orderItemId,
    input.graph.resourceId,
    input.bindingId,
    `connection-${input.connectionSuffix}`,
    HASH_A,
    input.requestedQuantity ?? 1,
    NOW,
  );
}

function insertRequest(database: DatabaseSync, input: {
  credentialVersion?: number;
  grantId: string;
  graph: EntitlementGraph;
  id: string;
  providerIdempotencyKeyHash?: string;
  requestHash?: string;
  shopSuffix: string;
  snapshotId: string;
}): void {
  database.prepare(`
    INSERT INTO generated_license_requests (
      id, shop_id, requirement_snapshot_id, entitlement_id,
      entitlement_grant_id, order_id, resource_id, connection_id,
      provider_code, unit_ordinal, provider_idempotency_key_hash,
      request_hash, credential_version, status, next_attempt_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fake.license', 1, ?, ?, ?,
      'pending', ?, ?, ?)
  `).run(
    input.id,
    `shop-${input.shopSuffix}`,
    input.snapshotId,
    input.graph.entitlementId,
    input.grantId,
    input.graph.orderId,
    input.graph.resourceId,
    `connection-${input.shopSuffix}`,
    input.providerIdempotencyKeyHash ?? HASH_D,
    input.requestHash ?? HASH_C,
    input.credentialVersion ?? 1,
    NOW,
    NOW,
    NOW,
  );
}

function columns(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("0049 generated-license fulfillment migration", () => {
  it("applies after 0048 without reinterpreting legacy commerce or entitlement state", () => {
    const database = createLegacyDatabase();
    seedShop(database, "a");
    const graph = seedEntitlementGraph(database, { shopSuffix: "a", suffix: "legacy-a" });
    const legacyOrder = database.prepare(`
      SELECT status, payment_status AS paymentStatus,
        fulfillment_status AS fulfillmentStatus, fulfilled_at AS fulfilledAt
      FROM orders WHERE id = ?
    `).get(graph.orderId);
    const legacyEntitlement = database.prepare(`
      SELECT status, grant_quantity AS grantQuantity, version
      FROM entitlements WHERE id = ?
    `).get(graph.entitlementId);
    expect(database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'generated_license_requests'
    `).get()).toBeUndefined();

    applyGeneratedLicenseMigration(database);

    expect(database.prepare(`
      SELECT status, payment_status AS paymentStatus,
        fulfillment_status AS fulfillmentStatus, fulfilled_at AS fulfilledAt
      FROM orders WHERE id = ?
    `).get(graph.orderId)).toEqual(legacyOrder);
    expect(database.prepare(`
      SELECT status, grant_quantity AS grantQuantity, version
      FROM entitlements WHERE id = ?
    `).get(graph.entitlementId)).toEqual(legacyEntitlement);
    expect(database.prepare(`
      SELECT entitlement_id AS entitlementId, granted_quantity AS grantedQuantity
      FROM entitlement_grants WHERE id = ?
    `).get(graph.grantId)).toEqual({
      entitlementId: graph.entitlementId,
      grantedQuantity: 1,
    });

    const generatedTables = (database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'generated_license_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map((row) => row.name);
    expect(generatedTables).toEqual([
      "generated_license_artifacts",
      "generated_license_attempts",
      "generated_license_dead_letters",
      "generated_license_provider_connections",
      "generated_license_provider_credentials",
      "generated_license_requests",
      "generated_license_requirement_snapshots",
      "generated_license_resource_bindings",
    ]);
    for (const table of generatedTables) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("keeps credentials, provider evidence, and generated artifacts out of plaintext columns", () => {
    const database = createLegacyDatabase();
    applyGeneratedLicenseMigration(database);

    expect(columns(database, "generated_license_provider_credentials")).toEqual(expect.arrayContaining([
      "endpoint_ciphertext_b64",
      "endpoint_iv_b64",
      "credential_ciphertext_b64",
      "credential_iv_b64",
      "endpoint_fingerprint",
      "credential_fingerprint",
      "key_version",
    ]));
    expect(columns(database, "generated_license_artifacts")).toEqual(expect.arrayContaining([
      "ciphertext_b64",
      "iv_b64",
      "key_version",
      "artifact_fingerprint",
    ]));
    expect(columns(database, "generated_license_attempts")).toEqual(expect.arrayContaining([
      "provider_reference_hash",
      "evidence_hash",
      "safe_error_code",
    ]));

    const forbiddenPlaintextColumns = [
      "api_key",
      "artifact_plaintext",
      "artifact_value",
      "credential",
      "credential_json",
      "endpoint",
      "endpoint_url",
      "license_key",
      "license_plaintext",
      "payload_json",
      "provider_reference",
      "provider_response_json",
      "request_json",
      "response_json",
      "secret",
    ];
    const sensitiveTables = [
      "generated_license_provider_connections",
      "generated_license_provider_credentials",
      "generated_license_resource_bindings",
      "generated_license_requirement_snapshots",
      "generated_license_requests",
      "generated_license_attempts",
      "generated_license_artifacts",
      "generated_license_dead_letters",
    ];
    for (const table of sensitiveTables) {
      expect(columns(database, table).filter((column) => forbiddenPlaintextColumns.includes(column)))
        .toEqual([]);
    }
  });

  it("enforces tenant-composite ownership and generated-license quantity-one bindings", () => {
    const database = createLegacyDatabase();
    seedShop(database, "a");
    seedShop(database, "b");
    const generatedA = seedEntitlementGraph(database, { shopSuffix: "a", suffix: "generated-a" });
    const generatedB = seedEntitlementGraph(database, { shopSuffix: "b", suffix: "generated-b" });
    const membershipA = seedEntitlementGraph(database, {
      resourceType: "membership",
      shopSuffix: "a",
      suffix: "membership-a",
    });
    const quantityTwoA = seedEntitlementGraph(database, {
      grantQuantity: 2,
      shopSuffix: "a",
      suffix: "quantity-two-a",
    });
    applyGeneratedLicenseMigration(database);
    insertConnection(database, "a");
    insertConnection(database, "b");
    insertCredential(database, {
      connectionSuffix: "a",
      id: "credential-a",
      shopSuffix: "a",
    });

    expect(() => {
      insertCredential(database, {
        connectionSuffix: "b",
        id: "credential-cross-shop",
        shopSuffix: "a",
      });
    }).toThrow(/FOREIGN KEY|generated_license_credential_scope_mismatch/u);
    expect(() => {
      insertCredential(database, {
        connectionSuffix: "a",
        id: "credential-wrong-provider",
        providerCode: "other.provider",
        shopSuffix: "a",
      });
    }).toThrow("generated_license_credential_scope_mismatch");

    insertBinding(database, {
      connectionSuffix: "a",
      graph: generatedA,
      id: "binding-a",
      shopSuffix: "a",
    });
    expect(() => {
      insertBinding(database, {
        connectionSuffix: "a",
        graph: generatedB,
        id: "binding-cross-shop",
        shopSuffix: "a",
      });
    }).toThrow(/FOREIGN KEY|generated_license_binding_scope_mismatch/u);
    expect(() => {
      insertBinding(database, {
        connectionSuffix: "a",
        graph: membershipA,
        id: "binding-membership",
        shopSuffix: "a",
      });
    }).toThrow("generated_license_binding_scope_mismatch");
    insertBinding(database, {
      connectionSuffix: "a",
      graph: quantityTwoA,
      id: "binding-quantity-two",
      shopSuffix: "a",
    });

    expect(() => {
      insertRequirementSnapshot(database, {
        bindingId: "binding-a",
        connectionSuffix: "a",
        graph: generatedA,
        id: "snapshot-quantity-two-column",
        requestedQuantity: 2,
        shopSuffix: "a",
      });
    }).toThrow(/CHECK/u);
    expect(() => {
      insertRequirementSnapshot(database, {
        bindingId: "binding-quantity-two",
        connectionSuffix: "a",
        graph: quantityTwoA,
        id: "snapshot-quantity-two-requirement",
        shopSuffix: "a",
      });
    }).toThrow("generated_license_requirement_scope_mismatch");
  });

  it("requires each request to use the exact active entitlement grant captured by its snapshot", () => {
    const database = createLegacyDatabase();
    seedShop(database, "a");
    const graphA = seedEntitlementGraph(database, { shopSuffix: "a", suffix: "request-a" });
    const graphOther = seedEntitlementGraph(database, { shopSuffix: "a", suffix: "request-other" });
    applyGeneratedLicenseMigration(database);
    insertConnection(database, "a");
    insertCredential(database, {
      connectionSuffix: "a",
      id: "credential-a",
      shopSuffix: "a",
    });
    insertBinding(database, {
      connectionSuffix: "a",
      graph: graphA,
      id: "binding-request-a",
      shopSuffix: "a",
    });
    insertRequirementSnapshot(database, {
      bindingId: "binding-request-a",
      connectionSuffix: "a",
      graph: graphA,
      id: "snapshot-request-a",
      shopSuffix: "a",
    });

    expect(() => {
      insertRequest(database, {
        grantId: graphOther.grantId,
        graph: graphA,
        id: "request-wrong-grant",
        shopSuffix: "a",
        snapshotId: "snapshot-request-a",
      });
    }).toThrow("generated_license_request_scope_mismatch");
    expect(() => {
      insertRequest(database, {
        credentialVersion: 2,
        grantId: graphA.grantId,
        graph: graphA,
        id: "request-missing-credential",
        shopSuffix: "a",
        snapshotId: "snapshot-request-a",
      });
    }).toThrow("generated_license_request_scope_mismatch");

    insertRequest(database, {
      grantId: graphA.grantId,
      graph: graphA,
      id: "request-a",
      shopSuffix: "a",
      snapshotId: "snapshot-request-a",
    });
    expect(database.prepare(`
      SELECT entitlement_id AS entitlementId,
        entitlement_grant_id AS entitlementGrantId, unit_ordinal AS unitOrdinal
      FROM generated_license_requests WHERE id = 'request-a'
    `).get()).toEqual({
      entitlementGrantId: graphA.grantId,
      entitlementId: graphA.entitlementId,
      unitOrdinal: 1,
    });
    expect(() => database.prepare(`
      INSERT INTO generated_license_artifacts (
        id, shop_id, request_id, entitlement_id, ordinal, ciphertext_b64,
        iv_b64, key_version, artifact_fingerprint, format, status, created_at
      ) VALUES ('artifact-too-early', 'shop-a', 'request-a', ?, 1, 'cipher',
        'iv', 'v1', ?, 'text', 'active', ?)
    `).run(graphA.entitlementId, HASH_E, NOW)).toThrow("generated_license_artifact_scope_mismatch");
  });

  it("keeps provider attempts and generated artifact identity immutable", () => {
    const database = createLegacyDatabase();
    seedShop(database, "a");
    const graph = seedEntitlementGraph(database, { shopSuffix: "a", suffix: "immutable-a" });
    applyGeneratedLicenseMigration(database);
    insertConnection(database, "a");
    insertCredential(database, {
      connectionSuffix: "a",
      id: "credential-a",
      shopSuffix: "a",
    });
    insertBinding(database, {
      connectionSuffix: "a",
      graph,
      id: "binding-immutable-a",
      shopSuffix: "a",
    });
    insertRequirementSnapshot(database, {
      bindingId: "binding-immutable-a",
      connectionSuffix: "a",
      graph,
      id: "snapshot-immutable-a",
      shopSuffix: "a",
    });
    insertRequest(database, {
      grantId: graph.grantId,
      graph,
      id: "request-immutable-a",
      shopSuffix: "a",
      snapshotId: "snapshot-immutable-a",
    });
    database.prepare(`
      UPDATE generated_license_requests
      SET status = 'processing', attempt_count = 1, lease_token = 'lease-immutable-a',
        lease_expires_at = '2026-07-30T06:05:00.000Z', version = 2, updated_at = ?
      WHERE id = 'request-immutable-a'
    `).run(NOW);
    database.prepare(`
      INSERT INTO generated_license_attempts (
        id, shop_id, request_id, attempt_no, action_kind, credential_version,
        request_hash, provider_reference_hash, evidence_hash, outcome,
        occurred_at, created_at
      ) VALUES ('attempt-a', 'shop-a', 'request-immutable-a', 1, 'generate', 1,
        ?, ?, ?, 'success', ?, ?)
    `).run(HASH_C, HASH_D, HASH_E, NOW, NOW);

    expect(() => database.prepare(`
      UPDATE generated_license_attempts SET outcome = 'retryable'
      WHERE id = 'attempt-a'
    `).run()).toThrow("generated_license_attempt_immutable");
    expect(() => database.prepare(`
      DELETE FROM generated_license_attempts WHERE id = 'attempt-a'
    `).run()).toThrow("generated_license_attempt_immutable");
    expect(() => database.prepare(`
      INSERT INTO generated_license_attempts (
        id, shop_id, request_id, attempt_no, action_kind, credential_version,
        request_hash, outcome, occurred_at, created_at
      ) VALUES ('attempt-wrong-hash', 'shop-a', 'request-immutable-a', 1,
        'generate', 1, ?, 'success', ?, ?)
    `).run(HASH_F, NOW, NOW)).toThrow("generated_license_attempt_scope_mismatch");
    expect(() => database.prepare(`
      INSERT INTO generated_license_attempts (
        id, shop_id, request_id, attempt_no, action_kind, credential_version,
        request_hash, outcome, occurred_at, created_at
      ) VALUES ('attempt-wrong-credential', 'shop-a', 'request-immutable-a', 1,
        'generate', 2, ?, 'success', ?, ?)
    `).run(HASH_C, NOW, NOW)).toThrow("generated_license_attempt_scope_mismatch");

    database.prepare(`
      UPDATE generated_license_requests
      SET status = 'succeeded', provider_reference_hash = ?, evidence_hash = ?,
        succeeded_at = ?, lease_token = NULL, lease_expires_at = NULL,
        version = 3, updated_at = ?
      WHERE id = 'request-immutable-a'
    `).run(HASH_D, HASH_E, NOW, NOW);
    database.prepare(`
      INSERT INTO generated_license_artifacts (
        id, shop_id, request_id, entitlement_id, ordinal, ciphertext_b64,
        iv_b64, key_version, artifact_fingerprint, format, status, created_at
      ) VALUES ('artifact-a', 'shop-a', 'request-immutable-a', ?, 1,
        'license-ciphertext', 'license-iv', 'v1', ?, 'text', 'active', ?)
    `).run(graph.entitlementId, HASH_F, NOW);

    expect(() => database.prepare(`
      UPDATE generated_license_artifacts SET ciphertext_b64 = 'replacement'
      WHERE id = 'artifact-a'
    `).run()).toThrow("generated_license_artifact_identity_immutable");
    expect(() => database.prepare(`
      DELETE FROM generated_license_artifacts WHERE id = 'artifact-a'
    `).run()).toThrow("generated_license_artifact_immutable");
    database.prepare(`
      UPDATE generated_license_artifacts
      SET status = 'destroyed', ciphertext_b64 = 'destroyed', iv_b64 = 'destroyed',
        key_version = 'destroyed', artifact_fingerprint = 'destroyed', revoked_at = ?
      WHERE id = 'artifact-a'
    `).run(NOW);
    expect(database.prepare(`
      SELECT status, ciphertext_b64 AS ciphertext, key_version AS keyVersion
      FROM generated_license_artifacts WHERE id = 'artifact-a'
    `).get()).toEqual({ ciphertext: "destroyed", keyVersion: "destroyed", status: "destroyed" });
    database.prepare(`
      UPDATE generated_license_provider_credentials
      SET status = 'destroyed', key_version = 'destroyed',
        endpoint_ciphertext_b64 = 'destroyed', endpoint_iv_b64 = 'destroyed',
        credential_ciphertext_b64 = 'destroyed', credential_iv_b64 = 'destroyed',
        endpoint_fingerprint = 'destroyed', credential_fingerprint = 'destroyed',
        revoked_at = ?, version = 2, updated_at = ?
      WHERE id = 'credential-a'
    `).run(NOW, NOW);
    expect(database.prepare(`
      SELECT status, credential_ciphertext_b64 AS ciphertext,
        key_version AS keyVersion, version
      FROM generated_license_provider_credentials WHERE id = 'credential-a'
    `).get()).toEqual({
      ciphertext: "destroyed",
      keyVersion: "destroyed",
      status: "destroyed",
      version: 2,
    });
  });
});

describe("0052 generated-license request hardening migration", () => {
  it("applies after the legacy 0049-0051 chain without dropping rows or lifecycle triggers", () => {
    const database = createLegacyDatabase();
    seedShop(database, "a");
    const graph = seedEntitlementGraph(database, { shopSuffix: "a", suffix: "hardening-compat" });
    applyGeneratedLicenseCurrentMigrations(database);
    insertConnection(database, "a");
    insertCredential(database, {
      connectionSuffix: "a",
      id: "credential-hardening-compat",
      shopSuffix: "a",
    });
    insertBinding(database, {
      connectionSuffix: "a",
      graph,
      id: "binding-hardening-compat",
      shopSuffix: "a",
    });
    insertRequirementSnapshot(database, {
      bindingId: "binding-hardening-compat",
      connectionSuffix: "a",
      graph,
      id: "snapshot-hardening-compat",
      shopSuffix: "a",
    });
    insertRequest(database, {
      grantId: graph.grantId,
      graph,
      id: "request-hardening-compat",
      shopSuffix: "a",
      snapshotId: "snapshot-hardening-compat",
    });

    expect(database.prepare(`
      SELECT status, attempt_count AS attemptCount
      FROM generated_license_requests WHERE id = 'request-hardening-compat'
    `).get()).toEqual({ attemptCount: 0, status: "pending" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const triggerNames = (database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (
        'generated_license_connections_identity_guard',
        'generated_license_credentials_identity_guard',
        'generated_license_artifacts_transition_guard',
        'generated_license_requests_transition_guard'
      ) ORDER BY name
    `).all() as Array<{ name: string }>).map((row) => row.name);
    expect(triggerNames).toEqual([
      "generated_license_artifacts_transition_guard",
      "generated_license_connections_identity_guard",
      "generated_license_credentials_identity_guard",
      "generated_license_requests_transition_guard",
    ]);
  });

  it("allows only leased request progression and freezes succeeded/canceled evidence", () => {
    const database = createLegacyDatabase();
    seedShop(database, "a");
    const graph = seedEntitlementGraph(database, { shopSuffix: "a", suffix: "hardening-state" });
    const canceledGraph = seedEntitlementGraph(database, { shopSuffix: "a", suffix: "hardening-canceled" });
    applyGeneratedLicenseCurrentMigrations(database);
    insertConnection(database, "a");
    insertCredential(database, {
      connectionSuffix: "a",
      id: "credential-hardening-state",
      shopSuffix: "a",
    });
    insertBinding(database, {
      connectionSuffix: "a",
      graph,
      id: "binding-hardening-state",
      shopSuffix: "a",
    });
    insertRequirementSnapshot(database, {
      bindingId: "binding-hardening-state",
      connectionSuffix: "a",
      graph,
      id: "snapshot-hardening-state",
      shopSuffix: "a",
    });
    expect(() => database.prepare(`
      INSERT INTO generated_license_requests (
        id, shop_id, requirement_snapshot_id, entitlement_id,
        entitlement_grant_id, order_id, resource_id, connection_id,
        provider_code, unit_ordinal, provider_idempotency_key_hash,
        request_hash, credential_version, status, attempt_count,
        next_attempt_at, provider_reference_hash, evidence_hash, succeeded_at,
        version, created_at, updated_at
      ) VALUES (
        'request-hardening-invalid-initial', 'shop-a', 'snapshot-hardening-state', ?,
        ?, ?, ?, 'connection-a', 'fake.license', 1, ?, ?, 1, 'succeeded', 1,
        ?, ?, ?, ?, 2, ?, ?
      )
    `).run(
      graph.entitlementId,
      graph.grantId,
      graph.orderId,
      graph.resourceId,
      HASH_F,
      HASH_C,
      NOW,
      HASH_D,
      HASH_E,
      NOW,
      NOW,
      NOW,
    )).toThrow("generated_license_request_initial_state_invalid");
    insertRequest(database, {
      grantId: graph.grantId,
      graph,
      id: "request-hardening-state",
      shopSuffix: "a",
      snapshotId: "snapshot-hardening-state",
    });

    database.prepare(`
      UPDATE generated_license_requests
      SET status = 'processing', attempt_count = 1,
        lease_token = 'lease-hardening-state', lease_expires_at = ?,
        version = 2, updated_at = ?
      WHERE id = 'request-hardening-state'
    `).run("2026-07-30T06:05:00.000Z", NOW);
    expect(() => database.prepare(`
      UPDATE generated_license_requests
      SET lease_token = 'lease-hardening-fresh-reclaim',
        lease_expires_at = '2026-07-30T06:10:00.000Z',
        version = 3, updated_at = ?
      WHERE id = 'request-hardening-state'
    `).run(NOW)).toThrow("generated_license_request_transition_invalid");
    database.prepare(`
      UPDATE generated_license_requests
      SET attempt_count = 2, lease_token = 'lease-hardening-takeover',
        lease_expires_at = '2026-07-30T06:10:01.000Z',
        version = 3, updated_at = '2026-07-30T06:05:01.000Z'
      WHERE id = 'request-hardening-state'
    `).run();
    expect(() => database.prepare(`
      UPDATE generated_license_requests
      SET status = 'succeeded', lease_token = NULL, lease_expires_at = NULL,
        evidence_hash = ?, succeeded_at = ?, version = 4, updated_at = ?
      WHERE id = 'request-hardening-state'
    `).run(HASH_E, "2026-07-30T06:05:01.000Z", "2026-07-30T06:05:01.000Z"))
      .toThrow("generated_license_request_transition_invalid");
    database.prepare(`
      UPDATE generated_license_requests
      SET status = 'succeeded', lease_token = NULL, lease_expires_at = NULL,
        provider_reference_hash = ?, evidence_hash = ?, succeeded_at = ?,
        version = 4, updated_at = ?
      WHERE id = 'request-hardening-state'
    `).run(HASH_D, HASH_E, "2026-07-30T06:05:01.000Z", "2026-07-30T06:05:01.000Z");

    expect(() => database.prepare(`
      UPDATE generated_license_requests
      SET status = 'retryable', succeeded_at = NULL, version = 5, updated_at = ?
      WHERE id = 'request-hardening-state'
    `).run(NOW)).toThrow("generated_license_request_transition_invalid");
    expect(() => database.prepare(`
      UPDATE generated_license_requests
      SET evidence_hash = ?, version = 5, updated_at = ?
      WHERE id = 'request-hardening-state'
    `).run(HASH_F, NOW)).toThrow("generated_license_request_transition_invalid");

    insertBinding(database, {
      connectionSuffix: "a",
      graph: canceledGraph,
      id: "binding-hardening-canceled",
      shopSuffix: "a",
    });
    insertRequirementSnapshot(database, {
      bindingId: "binding-hardening-canceled",
      connectionSuffix: "a",
      graph: canceledGraph,
      id: "snapshot-hardening-canceled",
      shopSuffix: "a",
    });
    insertRequest(database, {
      grantId: canceledGraph.grantId,
      graph: canceledGraph,
      id: "request-hardening-canceled",
      providerIdempotencyKeyHash: HASH_F,
      shopSuffix: "a",
      snapshotId: "snapshot-hardening-canceled",
    });
    database.prepare(`
      UPDATE generated_license_requests
      SET status = 'canceled', canceled_at = ?,
        last_safe_error_code = 'operator_canceled', version = 2, updated_at = ?
      WHERE id = 'request-hardening-canceled'
    `).run(NOW, NOW);
    expect(() => database.prepare(`
      UPDATE generated_license_requests
      SET status = 'pending', canceled_at = NULL, version = 3, updated_at = ?
      WHERE id = 'request-hardening-canceled'
    `).run(NOW)).toThrow("generated_license_request_transition_invalid");
  });

  it("adds query-aligned global scheduler and rotation indexes", () => {
    const database = createLegacyDatabase();
    applyGeneratedLicenseCurrentMigrations(database);
    const names = (database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'idx_generated_license_requests_global_due',
        'idx_generated_license_requests_global_lease',
        'idx_generated_license_credentials_key_version',
        'idx_generated_license_artifacts_key_version'
      ) ORDER BY name
    `).all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual([
      "idx_generated_license_artifacts_key_version",
      "idx_generated_license_credentials_key_version",
      "idx_generated_license_requests_global_due",
      "idx_generated_license_requests_global_lease",
    ]);

    const duePlan = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id, shop_id AS shopId
      FROM generated_license_requests
      WHERE (
        status IN ('pending', 'retryable', 'reconcile_pending')
        AND next_attempt_at <= ?
      ) OR (
        status = 'processing'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
      )
      ORDER BY next_attempt_at, id
      LIMIT ?
    `).all(NOW, NOW, 50) as Array<{ detail: string }>;
    expect(duePlan.some((row) => row.detail.includes("idx_generated_license_requests_global_due"))).toBe(true);
    expect(duePlan.some((row) => row.detail.includes("idx_generated_license_requests_global_lease"))).toBe(true);
    expect(duePlan.some((row) => row.detail === "SCAN generated_license_requests")).toBe(false);

    const credentialPlan = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM generated_license_provider_credentials
      WHERE key_version = ? AND (? IS NULL OR shop_id = ?)
    `).all("v1", null, null) as Array<{ detail: string }>;
    expect(credentialPlan.some((row) => row.detail.includes("idx_generated_license_credentials_key_version"))).toBe(true);
    const artifactPlan = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id FROM generated_license_artifacts
      WHERE key_version = ? AND (? IS NULL OR shop_id = ?)
    `).all("v1", null, null) as Array<{ detail: string }>;
    expect(artifactPlan.some((row) => row.detail.includes("idx_generated_license_artifacts_key_version"))).toBe(true);
  });
});
