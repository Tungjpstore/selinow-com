import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createGeneratedLicenseQueueEnvelope,
  enqueueDueGeneratedLicenseRequests,
  GeneratedLicenseProviderRegistry,
  isGeneratedLicenseQueueEnvelope,
  prepareGeneratedLicenseRequestStatements,
  prepareGeneratedLicenseRequirementStatements,
  processGeneratedLicenseRequestReference,
  requestGeneratedLicenseDeadLetterRetry,
  revealGeneratedLicenseArtifact,
  type GeneratedLicenseProviderAdapter,
  type GeneratedLicenseProviderCall,
  type GeneratedLicenseProviderResult,
} from "../../src/lib/commerce/generated-license";
import { encryptGeneratedLicenseProviderSecrets } from "../../src/lib/commerce/generated-license-crypto";
import {
  revealPrincipalDigitalFulfillment,
  revealWebsiteDigitalFulfillment,
} from "../../src/lib/commerce/digital-fulfillment";
import {
  expireGenericEntitlements,
  prepareGenericCheckoutEntitlementStatements,
  prepareGenericPaidActivationStatements,
} from "../../src/lib/commerce/entitlements";
import { hmacToken, sha256Json } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-07-30T06:00:00.000Z");
const NOW_ISO = NOW.toISOString();
const CREDENTIAL_KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INVENTORY_KEK = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const IDENTIFIER_SECRET = "generated-license-identifier-secret";
const SESSION_SECRET = "generated-license-session-secret-is-deliberately-distinct";
const HASH = "a".repeat(43);
const databases: DatabaseSync[] = [];

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
    private readonly beforeRun?: (sql: string) => void,
  ) {}

  get sqlText(): string {
    return this.sql;
  }

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[], this.beforeRun);
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    this.beforeRun?.(this.sql);
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  private batchQueue = Promise.resolve();
  private pendingFailure: { error: Error; predicate: (sql: string) => boolean } | undefined;

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql, [], (statementSql) => {
      if (this.pendingFailure === undefined || !this.pendingFailure.predicate(statementSql)) return;
      const failure = this.pendingFailure;
      this.pendingFailure = undefined;
      throw failure.error;
    });
  }

  failNextStatement(predicate: (sql: string) => boolean, error = new Error("injected_statement_failure")): void {
    this.pendingFailure = { error, predicate };
  }

  batch(statements: readonly SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const operation = this.batchQueue.then(async () => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        this.database.exec("COMMIT");
        return results;
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    });
    this.batchQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

class MemoryQueue {
  readonly messages: unknown[] = [];

  send(message: unknown): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }
}

type ProviderHandler = (input: GeneratedLicenseProviderCall) => GeneratedLicenseProviderResult | Promise<GeneratedLicenseProviderResult>;

class FakeGeneratedLicenseAdapter implements GeneratedLicenseProviderAdapter {
  readonly code = "fake.license";
  readonly generateCalls: GeneratedLicenseProviderCall[] = [];
  readonly reconcileCalls: GeneratedLicenseProviderCall[] = [];

  constructor(
    private readonly generateHandler: ProviderHandler,
    private readonly reconcileHandler: ProviderHandler = generateHandler,
  ) {}

  generate(input: GeneratedLicenseProviderCall): Promise<GeneratedLicenseProviderResult> {
    this.generateCalls.push(input);
    return Promise.resolve(this.generateHandler(input));
  }

  reconcile(input: GeneratedLicenseProviderCall): Promise<GeneratedLicenseProviderResult> {
    this.reconcileCalls.push(input);
    return Promise.resolve(this.reconcileHandler(input));
  }
}

type GeneratedOrder = {
  entitlementTtlSeconds: number | null;
  entitlementId?: string;
  grantId?: string;
  itemId: string;
  orderId: string;
  orderPublicId: string;
  orderToken: string;
  policyId: string;
  productId: string;
  requestId?: string;
  requirementId: string;
  resourceId: string;
  shopId: string;
  suffix: string;
};

function applyMigrations(database: DatabaseSync): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

function createDatabase(): { database: DatabaseSync; d1: SqliteD1 } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  applyMigrations(database);
  return { database, d1: new SqliteD1(database) };
}

function seedShops(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES
      ('user-gl-a', 'generated-a@example.test', 'Generated A', 'active', '${NOW_ISO}', '${NOW_ISO}'),
      ('user-gl-b', 'generated-b@example.test', 'Generated B', 'active', '${NOW_ISO}', '${NOW_ISO}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('shop-gl-a', 'shop-public-gl-a', 'generated-a', 'Generated A', 'active', 'en', 'USD', 'UTC', 1, '${NOW_ISO}', '${NOW_ISO}'),
      ('shop-gl-b', 'shop-public-gl-b', 'generated-b', 'Generated B', 'active', 'en', 'USD', 'UTC', 1, '${NOW_ISO}', '${NOW_ISO}');
  `);
}

function createEnv(d1: SqliteD1, queue = new MemoryQueue()): { env: AppBindings; queue: MemoryQueue } {
  return {
    env: {
      ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
      ACTIVE_INVENTORY_KEY_VERSION: "v1",
      APP_ENV: "local",
      CREDENTIAL_KEK_V1: CREDENTIAL_KEK,
      IDENTIFIER_HMAC_SECRET: IDENTIFIER_SECRET,
      INTEGRATION_QUEUE: queue as unknown as Queue,
      INVENTORY_KEK_V1: INVENTORY_KEK,
      PLATFORM_DB: d1 as unknown as D1Database,
      SESSION_SECRET,
    } as unknown as AppBindings,
    queue,
  };
}

async function ensureProvider(database: DatabaseSync, shopSuffix: "a" | "b"): Promise<void> {
  const shopId = `shop-gl-${shopSuffix}`;
  const connectionId = `connection-gl-${shopSuffix}`;
  const credentialId = `credential-gl-${shopSuffix}`;
  if (database.prepare("SELECT id FROM generated_license_provider_connections WHERE id = ?").get(connectionId) !== undefined) return;
  const encrypted = await encryptGeneratedLicenseProviderSecrets({
    connectionId,
    credential: `credential-secret-${shopSuffix}`,
    credentialId,
    endpoint: `https://seller-${shopSuffix}.example.test/generate`,
    hmacSecret: IDENTIFIER_SECRET,
    kek: CREDENTIAL_KEK,
    keyVersion: "v1",
    shopId,
  });
  database.prepare(`
    INSERT INTO generated_license_provider_connections (
      id, shop_id, provider_code, provider_environment, status,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, 'fake.license', 'sandbox', 'active', ?, ?, ?)
  `).run(connectionId, shopId, `user-gl-${shopSuffix}`, NOW_ISO, NOW_ISO);
  database.prepare(`
    INSERT INTO generated_license_provider_credentials (
      id, shop_id, connection_id, provider_code, credential_version, status,
      key_version, endpoint_ciphertext_b64, endpoint_iv_b64,
      credential_ciphertext_b64, credential_iv_b64, endpoint_fingerprint,
      credential_fingerprint, created_by_user_id, activated_at, created_at,
      updated_at
    ) VALUES (?, ?, ?, 'fake.license', 1, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    credentialId,
    shopId,
    connectionId,
    encrypted.keyVersion,
    encrypted.endpointCiphertextB64,
    encrypted.endpointIvB64,
    encrypted.credentialCiphertextB64,
    encrypted.credentialIvB64,
    encrypted.endpointFingerprint,
    encrypted.credentialFingerprint,
    `user-gl-${shopSuffix}`,
    NOW_ISO,
    NOW_ISO,
    NOW_ISO,
  );
}

async function seedGeneratedOrderSkeleton(input: {
  database: DatabaseSync;
  entitlementTtlSeconds?: number;
  paid: boolean;
  shopSuffix?: "a" | "b";
  suffix: string;
  totalMinor?: number;
}): Promise<GeneratedOrder> {
  const shopSuffix = input.shopSuffix ?? "a";
  const shopId = `shop-gl-${shopSuffix}`;
  const productId = `product-gl-${input.suffix}`;
  const variantId = `variant-gl-${input.suffix}`;
  const resourceId = `resource-gl-${input.suffix}`;
  const policyId = `policy-gl-${input.suffix}`;
  const bindingId = `binding-gl-${input.suffix}`;
  const orderId = `order-gl-${input.suffix}`;
  const orderPublicId = `order-public-gl-${input.suffix}`;
  const itemId = `item-gl-${input.suffix}`;
  const requirementId = `requirement-gl-${input.suffix}`;
  const orderToken = `order-token-generated-license-${input.suffix}-123456789`;
  const orderTokenHash = await hmacToken(IDENTIFIER_SECRET, "order-access", orderToken);
  const totalMinor = input.totalMinor ?? (input.paid ? 1_000 : 0);
  await ensureProvider(input.database, shopSuffix);
  input.database.prepare(`
    INSERT INTO products (
      id, shop_id, slug, title, description, status, fulfillment_type,
      version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '', 'active', 'manual', 1, ?, ?)
  `).run(productId, shopId, `generated-${input.suffix}`, `Generated ${input.suffix}`, NOW_ISO, NOW_ISO);
  input.database.prepare(`
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor, currency,
      min_per_order, max_per_order, status, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'Default', '{}', ?, 'USD', 1, 1, 'active', 1, ?, ?)
  `).run(variantId, shopId, productId, `GL-${input.suffix}`, totalMinor, NOW_ISO, NOW_ISO);
  input.database.prepare(`
    INSERT INTO entitlement_resources (
      id, shop_id, resource_key, resource_type, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'generated_license', 'active', ?, ?)
  `).run(resourceId, shopId, `generated.${input.suffix}`, NOW_ISO, NOW_ISO);
  input.database.prepare(`
    INSERT INTO product_entitlement_policies (
      id, shop_id, product_id, resource_id, policy_version,
      activation_condition, grant_quantity_per_unit, entitlement_ttl_seconds,
      status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 1, 'order_paid', 1, ?, 'active', ?, ?)
  `).run(policyId, shopId, productId, resourceId, input.entitlementTtlSeconds ?? null, NOW_ISO, NOW_ISO);
  input.database.prepare(`
    INSERT INTO generated_license_resource_bindings (
      id, shop_id, resource_id, connection_id, provider_code,
      generation_template_version, request_shape_hash, status,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'fake.license', 1, ?, 'active', ?, ?, ?)
  `).run(bindingId, shopId, resourceId, `connection-gl-${shopSuffix}`, HASH, `user-gl-${shopSuffix}`, NOW_ISO, NOW_ISO);
  input.database.prepare(`
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, paid_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'web', ?, ?, 'unfulfilled', ?, 0, ?, 'USD', 'en', ?, ?, ?, ?, ?, ?)
  `).run(
    orderId,
    orderPublicId,
    shopId,
    `ORDER-${input.suffix}`,
    input.paid ? "processing" : "pending_payment",
    input.paid ? "paid" : "unpaid",
    totalMinor,
    totalMinor,
    `subject-${input.suffix}`,
    orderTokenHash,
    "2026-07-30T08:00:00.000Z",
    input.paid ? NOW_ISO : null,
    NOW_ISO,
    NOW_ISO,
  );
  input.database.prepare(`
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title,
      variant_title, sku, unit_price_minor, quantity, line_total_minor,
      fulfillment_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'Default', ?, ?, 1, ?, 'manual', ?)
  `).run(
    itemId,
    shopId,
    orderId,
    productId,
    variantId,
    `Generated ${input.suffix}`,
    `GL-${input.suffix}`,
    totalMinor,
    totalMinor,
    NOW_ISO,
  );
  input.database.prepare(`
    INSERT INTO order_item_entitlement_requirements (
      id, shop_id, order_id, order_item_id, policy_id, resource_id,
      policy_version, activation_condition, item_quantity, grant_quantity,
      entitlement_ttl_seconds, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 'order_paid', 1, 1, ?, ?)
  `).run(requirementId, shopId, orderId, itemId, policyId, resourceId, input.entitlementTtlSeconds ?? null, NOW_ISO);
  return {
    entitlementTtlSeconds: input.entitlementTtlSeconds ?? null,
    itemId,
    orderId,
    orderPublicId,
    orderToken,
    policyId,
    productId,
    requirementId,
    resourceId,
    shopId,
    suffix: input.suffix,
  };
}

function configureTelegramGeneratedOrder(database: DatabaseSync, graph: GeneratedOrder): void {
  const customerId = `customer-gl-${graph.suffix}`;
  database.prepare(`
    INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'en', 'active', ?, ?)
  `).run(customerId, graph.shopId, `${graph.suffix}@telegram.example.test`, `Telegram ${graph.suffix}`, NOW_ISO, NOW_ISO);
  database.prepare(`
    UPDATE orders SET customer_id = ?, source_channel = 'telegram' WHERE id = ? AND shop_id = ?
  `).run(customerId, graph.orderId, graph.shopId);
  database.prepare(`
    INSERT INTO order_channel_attributions (
      shop_id, order_id, channel_code, adapter_version, connection_id, created_at
    ) VALUES (?, ?, 'telegram', 1, NULL, ?)
  `).run(graph.shopId, graph.orderId, NOW_ISO);
}

async function activateAndRequest(input: {
  d1: SqliteD1;
  graph: GeneratedOrder;
}): Promise<Required<GeneratedOrder>> {
  const entitlementId = `entitlement-gl-${input.graph.suffix}`;
  const grantId = `grant-gl-${input.graph.suffix}`;
  const idempotencyHash = await sha256Json({ purpose: "test-grant-idempotency", suffix: input.graph.suffix });
  const requestHash = await sha256Json({ purpose: "test-grant-request", suffix: input.graph.suffix });
  const entitlementTtlSeconds = input.graph.entitlementTtlSeconds;
  const accessExpiresAt = entitlementTtlSeconds === null
    ? null
    : new Date(NOW.getTime() + entitlementTtlSeconds * 1_000).toISOString();
  input.d1.database.prepare(`
    INSERT INTO entitlements (
      id, shop_id, order_id, order_item_id, requirement_id, resource_id,
      buyer_binding_hash, status, grant_quantity, entitlement_ttl_seconds,
      access_expires_at, activated_at, version, created_at, updated_at
    ) SELECT ?, shop_id, id, ?, ?, ?, order_token_hash, 'active', 1, ?,
      ?, ?, 1, ?, ? FROM orders WHERE id = ? AND shop_id = ?
  `).run(
    entitlementId,
    input.graph.itemId,
    input.graph.requirementId,
    input.graph.resourceId,
    entitlementTtlSeconds,
    accessExpiresAt,
    NOW_ISO,
    NOW_ISO,
    NOW_ISO,
    input.graph.orderId,
    input.graph.shopId,
  );
  await input.d1.batch(await prepareGeneratedLicenseRequirementStatements({
    database: input.d1 as unknown as D1Database,
    entitlementId,
    nowIso: NOW_ISO,
    requirementId: input.graph.requirementId,
    shopId: input.graph.shopId,
  }) as unknown as readonly SqliteStatement[]);
  input.d1.database.prepare(`
    INSERT INTO entitlement_grants (
      id, shop_id, entitlement_id, requirement_id, order_id, resource_id,
      source_kind, source_payment_event_id, idempotency_key_hash, request_hash,
      request_id, granted_quantity, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'free_checkout', NULL, ?, ?, ?, 1, ?)
  `).run(
    grantId,
    input.graph.shopId,
    entitlementId,
    input.graph.requirementId,
    input.graph.orderId,
    input.graph.resourceId,
    idempotencyHash,
    requestHash,
    `request-source-${input.graph.suffix}`,
    NOW_ISO,
  );
  input.d1.database.prepare(`
    INSERT INTO entitlement_transitions (
      id, shop_id, entitlement_id, requirement_id, resource_id,
      entitlement_version, from_status, to_status, source_grant_id,
      reason_code, idempotency_key_hash, request_hash, actor_kind,
      actor_user_id, occurred_at, created_at
    ) VALUES (?, ?, ?, ?, ?, 1, NULL, 'active', ?,
      'free_checkout_activated', ?, ?, 'system', NULL, ?, ?)
  `).run(
    `transition-gl-${input.graph.suffix}`,
    input.graph.shopId,
    entitlementId,
    input.graph.requirementId,
    input.graph.resourceId,
    grantId,
    idempotencyHash,
    requestHash,
    NOW_ISO,
    NOW_ISO,
  );
  await input.d1.batch(await prepareGeneratedLicenseRequestStatements({
    database: input.d1 as unknown as D1Database,
    entitlementGrantId: grantId,
    entitlementId,
    nowIso: NOW_ISO,
    orderId: input.graph.orderId,
    requirementId: input.graph.requirementId,
    shopId: input.graph.shopId,
  }) as unknown as readonly SqliteStatement[]);
  const request = input.d1.database.prepare(`
    SELECT id FROM generated_license_requests
    WHERE shop_id = ? AND entitlement_id = ?
  `).get(input.graph.shopId, entitlementId) as { id: string } | undefined;
  if (request === undefined) throw new Error("generated_license_request_missing");
  return { ...input.graph, entitlementId, grantId, requestId: request.id };
}

function success(artifact = "LICENSE-GENERATED-A"): GeneratedLicenseProviderResult {
  return {
    artifact,
    evidence: { accepted: true, providerStatus: 201 },
    format: "text",
    kind: "success",
    providerReference: "provider-reference-a",
  };
}

function registry(adapter: GeneratedLicenseProviderAdapter): GeneratedLicenseProviderRegistry {
  return new GeneratedLicenseProviderRegistry([adapter]);
}

describe("generated-license fulfillment", () => {
  let database: DatabaseSync;
  let d1: SqliteD1;
  let env: AppBindings;
  let queue: MemoryQueue;

  beforeEach(() => {
    ({ database, d1 } = createDatabase());
    seedShops(database);
    ({ env, queue } = createEnv(d1));
  });

  afterEach(() => {
    for (const openDatabase of databases.splice(0)) openDatabase.close();
  });

  it("keeps queue messages reference-only and rejects enriched envelopes", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "queue-a", totalMinor: 0 }),
    });
    const envelope = createGeneratedLicenseQueueEnvelope({ requestId: graph.requestId, shopId: graph.shopId });
    expect(isGeneratedLicenseQueueEnvelope(envelope)).toBe(true);
    expect(Object.keys(envelope).sort()).toEqual([
      "kind",
      "operationId",
      "referenceId",
      "referenceType",
      "requestId",
      "shopId",
      "sourceQueue",
      "version",
    ]);
    expect(isGeneratedLicenseQueueEnvelope({ ...envelope, credential: "must-not-travel" })).toBe(false);

    await expect(enqueueDueGeneratedLicenseRequests(env, NOW)).resolves.toEqual({ candidates: 1, failed: 0, sent: 1 });
    expect(queue.messages).toEqual([envelope]);
    expect(JSON.stringify(queue.messages)).not.toContain("credential-secret");
    expect(JSON.stringify(queue.messages)).not.toContain("seller-a.example.test");
    expect(JSON.stringify(queue.messages)).not.toContain("LICENSE-");
  });

  it("creates free requests immediately but fences paid requests until exact claimed payment", async () => {
    const free = await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "prep-free", totalMinor: 0 });
    const paid = await seedGeneratedOrderSkeleton({ database, paid: false, suffix: "prep-paid", totalMinor: 1_000 });
    const freeStatements = await prepareGenericCheckoutEntitlementStatements({
      database: d1 as unknown as D1Database,
      isFree: true,
      nowIso: NOW_ISO,
      orderId: free.orderId,
      orderPublicId: free.orderPublicId,
      orderTokenHash: HASH,
      requestHash: HASH,
      requirements: [{
        entitlementTtlSeconds: null,
        grantQuantity: 1,
        grantQuantityPerUnit: 1,
        itemQuantity: 1,
        orderItemId: free.itemId,
        policyId: free.policyId,
        policyVersion: 1,
        productId: free.productId,
        requirementId: free.requirementId,
        resourceId: free.resourceId,
        resourceType: "generated_license",
      }],
      shopId: free.shopId,
      sourceIdempotencyHash: HASH,
    });
    await d1.batch(freeStatements as unknown as readonly SqliteStatement[]);
    expect(database.prepare(`
      SELECT request.status, grant_row.source_kind AS sourceKind
      FROM generated_license_requests AS request
      INNER JOIN entitlement_grants AS grant_row
        ON grant_row.id = request.entitlement_grant_id AND grant_row.shop_id = request.shop_id
      WHERE request.order_id = ? AND request.shop_id = ?
    `).get(free.orderId, free.shopId)).toEqual({ sourceKind: "free_checkout", status: "pending" });

    const paidStatements = await prepareGenericCheckoutEntitlementStatements({
      database: d1 as unknown as D1Database,
      isFree: false,
      nowIso: NOW_ISO,
      orderId: paid.orderId,
      orderPublicId: paid.orderPublicId,
      orderTokenHash: HASH,
      requestHash: "b".repeat(43),
      requirements: [{
        entitlementTtlSeconds: null,
        grantQuantity: 1,
        grantQuantityPerUnit: 1,
        itemQuantity: 1,
        orderItemId: paid.itemId,
        policyId: paid.policyId,
        policyVersion: 1,
        productId: paid.productId,
        requirementId: paid.requirementId,
        resourceId: paid.resourceId,
        resourceType: "generated_license",
      }],
      shopId: paid.shopId,
      sourceIdempotencyHash: "c".repeat(43),
    });
    await d1.batch(paidStatements as unknown as readonly SqliteStatement[]);
    expect(database.prepare("SELECT status FROM entitlements WHERE order_id = ?").get(paid.orderId)).toEqual({ status: "pending" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM generated_license_requests WHERE order_id = ?").get(paid.orderId)).toEqual({ count: 0 });

    database.exec(`
      INSERT INTO payment_integrations (
        id, public_id, webhook_public_id, shop_id, provider, status,
        webhook_status, created_at, updated_at
      ) VALUES ('integration-gl-paid', 'integration-public-gl-paid', 'webhook-gl-paid',
        '${paid.shopId}', 'payos', 'active', 'verified', '${NOW_ISO}', '${NOW_ISO}');
      INSERT INTO payment_credentials (
        id, shop_id, integration_id, provider, status, version, key_version,
        client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
        api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
        credential_fingerprint, created_by_user_id, created_at
      ) VALUES ('payment-credential-gl-paid', '${paid.shopId}', 'integration-gl-paid',
        'payos', 'active', 1, 'v1', 'cipher', 'iv', 'cipher', 'iv', 'cipher',
        'iv', 'payment-fingerprint-gl-paid', 'user-gl-a', '${NOW_ISO}');
      INSERT INTO payment_attempts (
        id, public_id, shop_id, order_id, integration_id, credential_id, provider,
        provider_order_code, state, expected_amount_minor, currency,
        expected_description, expires_at, created_at, updated_at
      ) VALUES ('attempt-gl-paid', 'attempt-public-gl-paid', '${paid.shopId}',
        '${paid.orderId}', 'integration-gl-paid', 'payment-credential-gl-paid',
        'payos', 88001, 'paid_exact', 1000, 'USD', 'Generated',
        '2026-07-30T08:00:00.000Z', '${NOW_ISO}', '${NOW_ISO}');
      INSERT INTO payment_events (
        id, shop_id, payment_attempt_id, integration_id, provider,
        provider_event_reference, payload_hash, signature_verified,
        normalized_state, process_result, received_at, processing_token,
        processing_started_at
      ) VALUES ('event-gl-paid', '${paid.shopId}', 'attempt-gl-paid',
        'integration-gl-paid', 'payos', 'provider-event-gl-paid', 'payload-gl-paid',
        1, 'paid_exact', 'received', '${NOW_ISO}', 'processing-gl-paid', '${NOW_ISO}');
      UPDATE payment_attempts SET paid_event_id = 'event-gl-paid'
      WHERE id = 'attempt-gl-paid' AND shop_id = '${paid.shopId}';
      UPDATE orders SET status = 'processing', payment_status = 'paid',
        paid_at = '${NOW_ISO}', updated_at = '${NOW_ISO}'
      WHERE id = '${paid.orderId}' AND shop_id = '${paid.shopId}';
    `);
    const activationStatements = await prepareGenericPaidActivationStatements({
      database: d1 as unknown as D1Database,
      eventId: "event-gl-paid",
      nowIso: NOW_ISO,
      orderId: paid.orderId,
      requestHash: "d".repeat(43),
      shopId: paid.shopId,
      sourceIdempotencyHash: "e".repeat(43),
    });
    await d1.batch(activationStatements as unknown as readonly SqliteStatement[]);
    expect(database.prepare(`
      SELECT request.status, grant_row.source_kind AS sourceKind,
        grant_row.source_payment_event_id AS sourcePaymentEventId
      FROM generated_license_requests AS request
      INNER JOIN entitlement_grants AS grant_row
        ON grant_row.id = request.entitlement_grant_id AND grant_row.shop_id = request.shop_id
      WHERE request.order_id = ? AND request.shop_id = ?
    `).get(paid.orderId, paid.shopId)).toEqual({
      sourceKind: "payment_exact",
      sourcePaymentEventId: "event-gl-paid",
      status: "pending",
    });
  });

  it("allows one concurrent claim winner and gives the provider no D1 capability", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "concurrent", totalMinor: 0 }),
    });
    let releaseProvider!: () => void;
    let providerReached!: () => void;
    const reached = new Promise<void>((resolve) => { providerReached = resolve; });
    const released = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const adapter = new FakeGeneratedLicenseAdapter(async (call) => {
      providerReached();
      await released;
      expect(Object.keys(call).sort()).toEqual(["credential", "endpoint", "request"]);
      expect(Object.keys(call.request).sort()).toEqual([
        "idempotencyKey",
        "operation",
        "orderReference",
        "quantity",
        "requestReference",
        "resourceKey",
        "version",
      ]);
      expect("PLATFORM_DB" in call).toBe(false);
      expect("database" in call).toBe(false);
      return success("LICENSE-CONCURRENT");
    });
    const providerRegistry = registry(adapter);
    const first = processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: providerRegistry,
      requestId: graph.requestId,
      shopId: graph.shopId,
    });
    await reached;
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: providerRegistry,
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "not_claimed" });
    releaseProvider();
    await expect(first).resolves.toEqual({ state: "succeeded" });
    expect(adapter.generateCalls).toHaveLength(1);
    expect(database.prepare("SELECT attempt_count AS attemptCount, status FROM generated_license_requests WHERE id = ?").get(graph.requestId)).toEqual({ attemptCount: 1, status: "succeeded" });
  });

  it("encrypts a successful artifact, hashes provider evidence, completes the generated-only order, and reveals by order access", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "success", totalMinor: 0 }),
    });
    const artifact = "LICENSE-SUCCESS-PLAINTEXT";
    const adapter = new FakeGeneratedLicenseAdapter((call) => {
      expect(call.endpoint).toBe("https://seller-a.example.test/generate");
      expect(call.credential).toBe("credential-secret-a");
      expect(call.request).toMatchObject({
        operation: "generate",
        orderReference: graph.orderPublicId,
        quantity: 1,
        requestReference: graph.requestId,
        resourceKey: `generated.${graph.suffix}`,
      });
      return success(artifact);
    });
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: registry(adapter),
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "succeeded" });

    const request = database.prepare(`
      SELECT status, provider_reference_hash AS providerReferenceHash,
        evidence_hash AS evidenceHash, last_safe_error_code AS lastSafeErrorCode
      FROM generated_license_requests WHERE id = ? AND shop_id = ?
    `).get(graph.requestId, graph.shopId) as Record<string, unknown>;
    const storedArtifact = database.prepare(`
      SELECT ciphertext_b64 AS ciphertextB64, iv_b64 AS ivB64,
        artifact_fingerprint AS artifactFingerprint, key_version AS keyVersion,
        format, status
      FROM generated_license_artifacts WHERE request_id = ? AND shop_id = ?
    `).get(graph.requestId, graph.shopId) as Record<string, unknown>;
    expect(request).toMatchObject({ lastSafeErrorCode: null, status: "succeeded" });
    expect(String(request.providerReferenceHash)).toHaveLength(43);
    expect(String(request.evidenceHash)).toHaveLength(43);
    expect(storedArtifact).toMatchObject({ format: "text", keyVersion: "v1", status: "active" });
    expect(String(storedArtifact.artifactFingerprint)).toHaveLength(43);
    expect(JSON.stringify({ request, storedArtifact })).not.toContain(artifact);
    expect(database.prepare("SELECT status, fulfillment_status AS fulfillmentStatus FROM orders WHERE id = ?").get(graph.orderId)).toEqual({ fulfillmentStatus: "fulfilled", status: "completed" });

    await expect(revealGeneratedLicenseArtifact({
      env,
      orderPublicId: graph.orderPublicId,
      orderToken: graph.orderToken,
      shopId: graph.shopId,
    })).resolves.toEqual({ items: [{ format: "text", value: artifact }], orderId: graph.orderPublicId });
  });

  it("completes a mixed order when its untyped manual item was already attested", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "mixed-manual-first", totalMinor: 0 }),
    });
    const manualProductId = "product-gl-mixed-manual";
    const manualVariantId = "variant-gl-mixed-manual";
    const manualItemId = "item-gl-mixed-manual";
    const manualFulfillmentId = "fulfillment-gl-mixed-manual";
    database.exec(`
      INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
      VALUES ('${graph.shopId}', 'user-gl-a', 'owner', 'active', '${NOW_ISO}', '${NOW_ISO}');
      INSERT INTO products (
        id, shop_id, slug, title, description, status, fulfillment_type,
        version, created_at, updated_at
      ) VALUES ('${manualProductId}', '${graph.shopId}', 'manual-mixed', 'Manual mixed', '', 'active', 'manual', 1, '${NOW_ISO}', '${NOW_ISO}');
      INSERT INTO product_variants (
        id, shop_id, product_id, sku, title, options_json, price_minor, currency,
        min_per_order, max_per_order, status, version, created_at, updated_at
      ) VALUES ('${manualVariantId}', '${graph.shopId}', '${manualProductId}', 'GL-MANUAL-MIXED', 'Default', '{}', 0, 'USD', 1, 1, 'active', 1, '${NOW_ISO}', '${NOW_ISO}');
      INSERT INTO order_items (
        id, shop_id, order_id, product_id, variant_id, product_title,
        variant_title, sku, unit_price_minor, quantity, line_total_minor,
        fulfillment_type, created_at
      ) VALUES ('${manualItemId}', '${graph.shopId}', '${graph.orderId}', '${manualProductId}', '${manualVariantId}',
        'Manual mixed', 'Default', 'GL-MANUAL-MIXED', 0, 1, 0, 'manual', '${NOW_ISO}');
      INSERT INTO fulfillments (
        id, shop_id, order_id, fulfillment_type, state, idempotency_key, created_at
      ) VALUES ('${manualFulfillmentId}', '${graph.shopId}', '${graph.orderId}', 'manual', 'pending',
        'fulfillment:gl-mixed-manual', '${NOW_ISO}');
      INSERT INTO manual_fulfillment_executions (
        id, shop_id, order_id, order_item_id, fulfillment_id, execution_type,
        state, completed_quantity, actor_user_id, idempotency_key_hash,
        request_hash, request_id, completed_at, created_at
      ) VALUES ('execution-gl-mixed-manual', '${graph.shopId}', '${graph.orderId}', '${manualItemId}', '${manualFulfillmentId}',
        'seller_attested_delivery', 'completed', 1, 'user-gl-a', '${"b".repeat(43)}', '${"c".repeat(43)}',
        'request-gl-mixed-manual', '${NOW_ISO}', '${NOW_ISO}');
      UPDATE fulfillments SET state = 'fulfilled', fulfilled_at = '${NOW_ISO}'
      WHERE id = '${manualFulfillmentId}' AND shop_id = '${graph.shopId}';
    `);

    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: registry(new FakeGeneratedLicenseAdapter(() => success("LICENSE-MIXED"))),
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "succeeded" });
    expect(database.prepare("SELECT status, fulfillment_status AS fulfillmentStatus FROM orders WHERE id = ?").get(graph.orderId)).toEqual({
      fulfillmentStatus: "fulfilled",
      status: "completed",
    });
  });

  it("delivers generated artifacts through the Website and Telegram principal boundaries", async () => {
    const website = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "buyer-web", totalMinor: 0 }),
    });
    const telegram = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "buyer-telegram", totalMinor: 0 }),
    });
    configureTelegramGeneratedOrder(database, telegram);
    const adapter = new FakeGeneratedLicenseAdapter((call) => success(`LICENSE-${call.request.resourceKey}`));
    const providerRegistry = registry(adapter);

    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: providerRegistry,
      requestId: website.requestId,
      shopId: website.shopId,
    })).resolves.toEqual({ state: "succeeded" });
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: providerRegistry,
      requestId: telegram.requestId,
      shopId: telegram.shopId,
    })).resolves.toEqual({ state: "succeeded" });

    await expect(revealWebsiteDigitalFulfillment({
      env,
      orderPublicId: website.orderPublicId,
      orderToken: website.orderToken,
      shopId: website.shopId,
    })).resolves.toEqual({
      items: [{ productTitle: "Generated buyer-web", value: "LICENSE-generated.buyer-web", variantTitle: "Default" }],
      orderId: website.orderPublicId,
    });
    await expect(revealPrincipalDigitalFulfillment({
      connectionId: null,
      customerId: `customer-gl-${telegram.suffix}`,
      env,
      orderPublicId: telegram.orderPublicId,
      shopId: telegram.shopId,
      sourceChannel: "telegram",
    })).resolves.toEqual({
      items: [{ productTitle: "Generated buyer-telegram", value: "LICENSE-generated.buyer-telegram", variantTitle: "Default" }],
      orderId: telegram.orderPublicId,
    });

    await expect(revealPrincipalDigitalFulfillment({
      connectionId: null,
      customerId: "customer-gl-other",
      env,
      orderPublicId: telegram.orderPublicId,
      shopId: telegram.shopId,
      sourceChannel: "telegram",
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
  });

  it("fences Website generated-artifact reveal after entitlement TTL expiry", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, entitlementTtlSeconds: 300, paid: true, suffix: "buyer-expired", totalMinor: 0 }),
    });
    const adapter = new FakeGeneratedLicenseAdapter(() => success("LICENSE-EXPIRED"));
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: registry(adapter),
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "succeeded" });
    await expect(expireGenericEntitlements({
      env,
      nowIso: "2026-07-30T06:05:01.000Z",
      shopId: graph.shopId,
    })).resolves.toBe(1);

    await expect(revealWebsiteDigitalFulfillment({
      env,
      orderPublicId: graph.orderPublicId,
      orderToken: graph.orderToken,
      shopId: graph.shopId,
    })).rejects.toMatchObject({ code: "order_not_ready", status: 409 });
  });

  it("schedules retryable provider failures without leaking provider details", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "retryable", totalMinor: 0 }),
    });
    const adapter = new FakeGeneratedLicenseAdapter(() => ({
      errorCode: "provider_temporarily_unavailable",
      kind: "retryable",
      providerReference: "provider-retry-reference",
      retryAfterSeconds: 45,
    }));
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: registry(adapter),
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "retryable" });
    const retryRow = database.prepare(`
      SELECT status, attempt_count AS attemptCount, next_attempt_at AS nextAttemptAt,
        last_safe_error_code AS lastSafeErrorCode, provider_reference_hash AS providerReferenceHash
      FROM generated_license_requests WHERE id = ?
    `).get(graph.requestId) as {
      attemptCount: number;
      lastSafeErrorCode: string;
      nextAttemptAt: string;
      providerReferenceHash: string;
      status: string;
    };
    expect(retryRow).toMatchObject({
      attemptCount: 1,
      lastSafeErrorCode: "provider_temporarily_unavailable",
      nextAttemptAt: "2026-07-30T06:00:45.000Z",
      status: "retryable",
    });
    expect(retryRow.providerReferenceHash).toHaveLength(43);
    expect(database.prepare("SELECT action_kind AS actionKind, outcome, safe_error_code AS safeErrorCode FROM generated_license_attempts WHERE request_id = ?").get(graph.requestId)).toEqual({
      actionKind: "generate",
      outcome: "retryable",
      safeErrorCode: "provider_temporarily_unavailable",
    });
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: new Date("2026-07-30T06:00:44.999Z"),
      registry: registry(adapter),
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "not_claimed" });
    expect(adapter.generateCalls).toHaveLength(1);
    expect(JSON.stringify(database.prepare("SELECT * FROM generated_license_requests WHERE id = ?").get(graph.requestId))).not.toContain("provider-retry-reference");
  });

  it("reconciles an ambiguous result before any second generate call", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "ambiguous", totalMinor: 0 }),
    });
    const adapter = new FakeGeneratedLicenseAdapter(
      () => ({ errorCode: "provider_response_ambiguous", kind: "ambiguous", providerReference: "provider-ambiguous-reference" }),
      (call) => {
        expect(call.request.operation).toBe("reconcile");
        expect(call.request.idempotencyKey).toBe(adapter.generateCalls[0]?.request.idempotencyKey);
        return success("LICENSE-RECONCILED");
      },
    );
    const providerRegistry = registry(adapter);
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: providerRegistry,
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "reconcile_pending" });
    expect(database.prepare("SELECT status FROM generated_license_requests WHERE id = ?").get(graph.requestId)).toEqual({ status: "reconcile_pending" });

    await expect(processGeneratedLicenseRequestReference({
      env,
      now: new Date("2026-07-30T06:00:30.000Z"),
      registry: providerRegistry,
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "succeeded" });
    expect(adapter.generateCalls).toHaveLength(1);
    expect(adapter.reconcileCalls).toHaveLength(1);
    expect(database.prepare("SELECT action_kind AS actionKind, outcome FROM generated_license_attempts WHERE request_id = ? ORDER BY attempt_no").all(graph.requestId)).toEqual([
      { actionKind: "generate", outcome: "ambiguous" },
      { actionKind: "reconcile", outcome: "success" },
    ]);
  });

  it("keeps reconciliation pending across retryable reconcile failures", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "reconcile-retry", totalMinor: 0 }),
    });
    let reconcileAttempts = 0;
    const adapter = new FakeGeneratedLicenseAdapter(
      () => ({ errorCode: "provider_response_ambiguous", kind: "ambiguous" }),
      () => {
        reconcileAttempts += 1;
        return reconcileAttempts === 1
          ? { errorCode: "provider_temporarily_unavailable", kind: "retryable", retryAfterSeconds: 15 }
          : success("LICENSE-RECONCILED-AFTER-RETRY");
      },
    );
    const providerRegistry = registry(adapter);
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: providerRegistry,
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "reconcile_pending" });
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: new Date("2026-07-30T06:00:30.000Z"),
      registry: providerRegistry,
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "reconcile_pending" });
    expect(database.prepare("SELECT status, next_attempt_at AS nextAttemptAt FROM generated_license_requests WHERE id = ?").get(graph.requestId)).toEqual({
      nextAttemptAt: "2026-07-30T06:00:45.000Z",
      status: "reconcile_pending",
    });
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: new Date("2026-07-30T06:00:45.000Z"),
      registry: providerRegistry,
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "succeeded" });
    expect(adapter.generateCalls).toHaveLength(1);
    expect(adapter.reconcileCalls).toHaveLength(2);
    expect(adapter.reconcileCalls.every((call) => call.request.operation === "reconcile")).toBe(true);
    expect(database.prepare("SELECT action_kind AS actionKind, outcome FROM generated_license_attempts WHERE request_id = ? ORDER BY attempt_no").all(graph.requestId)).toEqual([
      { actionKind: "generate", outcome: "ambiguous" },
      { actionKind: "reconcile", outcome: "retryable" },
      { actionKind: "reconcile", outcome: "success" },
    ]);
  });

  it("recovers a terminal settlement when dead-letter persistence fails inside the batch", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "dead-letter-atomic", totalMinor: 0 }),
    });
    const adapter = new FakeGeneratedLicenseAdapter(() => ({
      errorCode: "provider_request_rejected",
      kind: "permanent",
    }));
    d1.failNextStatement((sql) => sql.includes("INSERT INTO generated_license_dead_letters"));
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: registry(adapter),
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).rejects.toThrow("injected_statement_failure");
    expect(database.prepare("SELECT status, attempt_count AS attemptCount FROM generated_license_requests WHERE id = ?").get(graph.requestId)).toEqual({
      attemptCount: 1,
      status: "processing",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM generated_license_attempts WHERE request_id = ?").get(graph.requestId)).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM generated_license_dead_letters WHERE request_id = ?").get(graph.requestId)).toEqual({ count: 0 });

    await expect(processGeneratedLicenseRequestReference({
      env,
      now: new Date("2026-07-30T06:05:01.000Z"),
      registry: registry(adapter),
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "failed" });
    expect(adapter.generateCalls).toHaveLength(1);
    expect(adapter.reconcileCalls).toHaveLength(1);
    expect(database.prepare("SELECT status, attempt_count AS attemptCount FROM generated_license_requests WHERE id = ?").get(graph.requestId)).toEqual({
      attemptCount: 2,
      status: "failed",
    });
    expect(database.prepare("SELECT action_kind AS actionKind, outcome FROM generated_license_attempts WHERE request_id = ? ORDER BY attempt_no").all(graph.requestId)).toEqual([
      { actionKind: "reconcile", outcome: "rejected" },
    ]);
    expect(database.prepare("SELECT status, provider_attempts AS providerAttempts, occurrence_count AS occurrenceCount FROM generated_license_dead_letters WHERE request_id = ?").get(graph.requestId)).toEqual({
      occurrenceCount: 1,
      providerAttempts: 2,
      status: "open",
    });
  });

  it("records credential failures after claim and retries after the key is restored", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "credential-failure", totalMinor: 0 }),
    });
    const adapter = new FakeGeneratedLicenseAdapter(() => success("LICENSE-AFTER-CREDENTIAL-RETRY"));
    const keyEnv = env as unknown as { CREDENTIAL_KEK_V1?: string };
    delete keyEnv.CREDENTIAL_KEK_V1;
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: registry(adapter),
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "retryable" });
    expect(adapter.generateCalls).toHaveLength(0);
    expect(database.prepare("SELECT status, attempt_count AS attemptCount, last_safe_error_code AS lastSafeErrorCode FROM generated_license_requests WHERE id = ?").get(graph.requestId)).toEqual({
      attemptCount: 1,
      lastSafeErrorCode: "generated_license_credential_unavailable",
      status: "retryable",
    });
    expect(database.prepare("SELECT action_kind AS actionKind, outcome, safe_error_code AS safeErrorCode FROM generated_license_attempts WHERE request_id = ?").get(graph.requestId)).toEqual({
      actionKind: "generate",
      outcome: "retryable",
      safeErrorCode: "generated_license_credential_unavailable",
    });

    keyEnv.CREDENTIAL_KEK_V1 = CREDENTIAL_KEK;
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: new Date("2026-07-30T06:00:30.000Z"),
      registry: registry(adapter),
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "succeeded" });
    expect(adapter.generateCalls).toHaveLength(1);
  });

  it("records an unsupported provider registry result without throwing after claim", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "registry-failure", totalMinor: 0 }),
    });
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: new GeneratedLicenseProviderRegistry([]),
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "retryable" });
    expect(database.prepare("SELECT status, last_safe_error_code AS lastSafeErrorCode FROM generated_license_requests WHERE id = ?").get(graph.requestId)).toEqual({
      lastSafeErrorCode: "generated_license_provider_unsupported",
      status: "retryable",
    });
    expect(database.prepare("SELECT outcome, safe_error_code AS safeErrorCode FROM generated_license_attempts WHERE request_id = ?").get(graph.requestId)).toEqual({
      outcome: "retryable",
      safeErrorCode: "generated_license_provider_unsupported",
    });
  });

  it("bounds provider exceptions and dead-letters after the final reconcile attempt", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "provider-exception", totalMinor: 0 }),
    });
    const adapter = new FakeGeneratedLicenseAdapter(() => {
      throw new Error("provider exception contained a credential-secret");
    });
    let now = NOW;
    for (let attemptNo = 1; attemptNo <= 8; attemptNo += 1) {
      await expect(processGeneratedLicenseRequestReference({
        env,
        now,
        registry: registry(adapter),
        requestId: graph.requestId,
        shopId: graph.shopId,
      })).resolves.toEqual({ state: attemptNo === 8 ? "failed" : "reconcile_pending" });
      if (attemptNo < 8) {
        const row = database.prepare("SELECT next_attempt_at AS nextAttemptAt FROM generated_license_requests WHERE id = ?").get(graph.requestId) as { nextAttemptAt: string };
        now = new Date(row.nextAttemptAt);
      }
    }
    expect(adapter.generateCalls).toHaveLength(1);
    expect(adapter.reconcileCalls).toHaveLength(7);
    expect(database.prepare("SELECT attempt_count AS attemptCount, status, last_safe_error_code AS lastSafeErrorCode FROM generated_license_requests WHERE id = ?").get(graph.requestId)).toEqual({
      attemptCount: 8,
      lastSafeErrorCode: "generated_license_provider_exception",
      status: "failed",
    });
    expect(database.prepare("SELECT outcome, COUNT(*) AS count FROM generated_license_attempts WHERE request_id = ? GROUP BY outcome ORDER BY outcome").all(graph.requestId)).toEqual([
      { count: 1, outcome: "ambiguous" },
      { count: 7, outcome: "retryable" },
    ]);
    expect(database.prepare("SELECT status, failure_code AS failureCode, provider_attempts AS providerAttempts FROM generated_license_dead_letters WHERE request_id = ?").get(graph.requestId)).toEqual({
      failureCode: "generated_license_provider_exception",
      providerAttempts: 8,
      status: "open",
    });
    expect(JSON.stringify(database.prepare("SELECT * FROM generated_license_attempts WHERE request_id = ?").all(graph.requestId))).not.toContain("credential-secret");
  });

  it("dead-letters permanent failures with reference-only safe context", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "permanent", totalMinor: 0 }),
    });
    const adapter = new FakeGeneratedLicenseAdapter(() => ({
      errorCode: "provider_request_rejected",
      kind: "permanent",
      providerReference: "provider-permanent-reference",
    }));
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: registry(adapter),
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "failed" });
    expect(database.prepare("SELECT status, last_safe_error_code AS lastSafeErrorCode FROM generated_license_requests WHERE id = ?").get(graph.requestId)).toEqual({
      lastSafeErrorCode: "provider_request_rejected",
      status: "failed",
    });
    const deadLetter = database.prepare(`
      SELECT failure_code AS failureCode, safe_context_json AS safeContextJson,
        status, provider_attempts AS providerAttempts, occurrence_count AS occurrenceCount
      FROM generated_license_dead_letters WHERE request_id = ? AND shop_id = ?
    `).get(graph.requestId, graph.shopId) as Record<string, unknown>;
    expect(deadLetter).toEqual({
      failureCode: "provider_request_rejected",
      occurrenceCount: 1,
      providerAttempts: 1,
      safeContextJson: JSON.stringify({ providerCode: "fake.license", requestId: graph.requestId }),
      status: "open",
    });
    const persisted = JSON.stringify({
      attempt: database.prepare("SELECT * FROM generated_license_attempts WHERE request_id = ?").get(graph.requestId),
      deadLetter,
      request: database.prepare("SELECT * FROM generated_license_requests WHERE id = ?").get(graph.requestId),
    });
    expect(persisted).not.toContain("provider-permanent-reference");
    expect(persisted).not.toContain("credential-secret-a");
    expect(persisted).not.toContain("seller-a.example.test");
  });

  it("retries failed or manual-review dead letters exactly once and rejects replay or cross-tenant requests", async () => {
    const failed = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "dead-letter-retry", totalMinor: 0 }),
    });
    const adapter = new FakeGeneratedLicenseAdapter(() => ({
      errorCode: "provider_request_rejected",
      kind: "permanent",
    }));
    await processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: registry(adapter),
      requestId: failed.requestId,
      shopId: failed.shopId,
    });
    database.prepare(`
      UPDATE generated_license_dead_letters
      SET status = 'acknowledged', updated_at = ?
      WHERE request_id = ? AND shop_id = ?
    `).run(NOW_ISO, failed.requestId, failed.shopId);

    await expect(requestGeneratedLicenseDeadLetterRetry({
      env,
      now: NOW,
      requestId: failed.requestId,
      shopId: failed.shopId,
    })).resolves.toBeUndefined();
    expect(database.prepare(`
      SELECT status, next_attempt_at AS nextAttemptAt, last_safe_error_code AS lastSafeErrorCode,
        lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
      FROM generated_license_requests WHERE id = ? AND shop_id = ?
    `).get(failed.requestId, failed.shopId)).toEqual({
      lastSafeErrorCode: null,
      leaseExpiresAt: null,
      leaseToken: null,
      nextAttemptAt: NOW_ISO,
      status: "retryable",
    });
    expect(database.prepare(`
      SELECT status FROM generated_license_dead_letters WHERE request_id = ? AND shop_id = ?
    `).get(failed.requestId, failed.shopId)).toEqual({ status: "retry_requested" });
    expect(queue.messages).toEqual([
      createGeneratedLicenseQueueEnvelope({ requestId: failed.requestId, shopId: failed.shopId }),
    ]);
    expect(JSON.stringify(queue.messages)).not.toMatch(/credential|artifact|providerReference|LICENSE-/u);

    await expect(requestGeneratedLicenseDeadLetterRetry({
      env,
      now: NOW,
      requestId: failed.requestId,
      shopId: failed.shopId,
    })).rejects.toMatchObject({ code: "generated_license_dead_letter_conflict", status: 409 });
    await expect(requestGeneratedLicenseDeadLetterRetry({
      env,
      now: NOW,
      requestId: failed.requestId,
      shopId: "shop-gl-b",
    })).rejects.toMatchObject({ code: "generated_license_dead_letter_conflict", status: 409 });
    expect(queue.messages).toHaveLength(1);

    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: registry(adapter),
      requestId: failed.requestId,
      shopId: failed.shopId,
    })).resolves.toEqual({ state: "failed" });
    database.prepare(`
      UPDATE generated_license_requests SET status = 'manual_review', version = version + 1
      WHERE id = ? AND shop_id = ?
    `).run(failed.requestId, failed.shopId);
    database.prepare(`
      UPDATE generated_license_dead_letters SET status = 'open' WHERE request_id = ? AND shop_id = ?
    `).run(failed.requestId, failed.shopId);
    await expect(requestGeneratedLicenseDeadLetterRetry({
      env,
      now: NOW,
      requestId: failed.requestId,
      shopId: failed.shopId,
    })).resolves.toBeUndefined();
    expect(database.prepare("SELECT status FROM generated_license_requests WHERE id = ?").get(failed.requestId)).toEqual({
      status: "retryable",
    });
    expect(queue.messages).toEqual([
      createGeneratedLicenseQueueEnvelope({ requestId: failed.requestId, shopId: failed.shopId }),
      createGeneratedLicenseQueueEnvelope({ requestId: failed.requestId, shopId: failed.shopId }),
    ]);
  });

  it("denies cross-tenant processing and artifact reveal without disclosing order existence", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "tenant-a", totalMinor: 0 }),
    });
    await seedGeneratedOrderSkeleton({ database, paid: true, shopSuffix: "b", suffix: "tenant-b", totalMinor: 0 });
    const adapter = new FakeGeneratedLicenseAdapter(() => success("LICENSE-TENANT-A"));
    const providerRegistry = registry(adapter);
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: providerRegistry,
      requestId: graph.requestId,
      shopId: "shop-gl-b",
    })).resolves.toEqual({ state: "not_claimed" });
    expect(adapter.generateCalls).toHaveLength(0);

    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: providerRegistry,
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "succeeded" });
    await expect(revealGeneratedLicenseArtifact({
      env,
      orderPublicId: graph.orderPublicId,
      orderToken: graph.orderToken,
      shopId: "shop-gl-b",
    })).rejects.toMatchObject({ code: "order_not_ready", status: 409 });
    await expect(revealGeneratedLicenseArtifact({
      env,
      orderPublicId: graph.orderPublicId,
      orderToken: "wrong-order-token-generated-license-123456789",
      shopId: graph.shopId,
    })).rejects.toMatchObject({ code: "order_not_ready", status: 409 });
    await expect(revealGeneratedLicenseArtifact({
      env,
      orderPublicId: graph.orderPublicId,
      orderToken: graph.orderToken,
      shopId: graph.shopId,
    })).resolves.toEqual({ items: [{ format: "text", value: "LICENSE-TENANT-A" }], orderId: graph.orderPublicId });
  });

  it("does not claim requests when their provider connection is disabled", async () => {
    const graph = await activateAndRequest({
      d1,
      graph: await seedGeneratedOrderSkeleton({ database, paid: true, suffix: "disabled-provider", totalMinor: 0 }),
    });
    database.prepare(`
      UPDATE generated_license_provider_connections
      SET status = 'disabled', version = version + 1, updated_at = ?
      WHERE id = ? AND shop_id = ?
    `).run(NOW_ISO, "connection-gl-a", graph.shopId);
    const adapter = new FakeGeneratedLicenseAdapter(() => success("SHOULD-NOT-GENERATE"));
    await expect(processGeneratedLicenseRequestReference({
      env,
      now: NOW,
      registry: registry(adapter),
      requestId: graph.requestId,
      shopId: graph.shopId,
    })).resolves.toEqual({ state: "not_claimed" });
    expect(adapter.generateCalls).toHaveLength(0);
    expect(adapter.reconcileCalls).toHaveLength(0);
    expect(database.prepare("SELECT status, attempt_count AS attemptCount FROM generated_license_requests WHERE id = ?").get(graph.requestId)).toEqual({
      attemptCount: 0,
      status: "pending",
    });
  });
});
