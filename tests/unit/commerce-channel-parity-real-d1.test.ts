import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { CommerceApplicationService } from "../../src/lib/commerce/application";
import { executeCanonicalCheckoutTransaction } from "../../src/lib/commerce/checkout-transaction";
import { applyCommercePaymentEvent, type CommercePaymentAttempt } from "../../src/lib/commerce/payment-events";
import { listWebsitePrivateDownloads } from "../../src/lib/commerce/private-file-fulfillment";
import { hmacToken } from "../../src/lib/core/crypto";
import { isAppError } from "../../src/lib/core/errors";
import { createQuoteEvidence } from "../../src/lib/commerce/quote-evidence";
import type {
  CommerceCheckoutCommand,
  CommerceCheckoutView,
  CommerceContext,
  CommerceQuoteView,
} from "../../src/lib/commerce/contracts";
import {
  createTelegramCartMutationApplicationKey,
  createTelegramCheckoutApplication,
  createTelegramCheckoutApplicationKey,
  readTelegramCartLines,
  TelegramCartMutationPort,
  type TelegramCheckoutShop,
} from "../../src/lib/commerce/telegram-port";
import { createWebsiteCommerceApplication } from "../../src/lib/commerce/website-port";
import { createPrincipalChannelCommerceApplication, type PrincipalChannelShop } from "../../src/lib/commerce/principal-channel-port";
import { ChannelAdapterRegistry } from "../../src/lib/channels/registry";
import type { AppBindings } from "../../src/lib/platform/bindings";
import { getPaymentFulfillmentEligibility } from "../../src/lib/payments/store";
import type { StorefrontShop } from "../../src/lib/storefront/store";
import { FakeChannelAdapter, FAKE_CHANNEL_CODE, FAKE_CHANNEL_MANIFEST } from "../helpers/fake-channel-adapter";

class SqliteStatement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly forceCheckoutLookupMiss: () => boolean,
  ) {}

  get sqlText(): string {
    return this.sql;
  }

  bind(...values: unknown[]): this {
    this.values = values as SQLInputValue[];
    return this;
  }

  first<T>(): Promise<T | null> {
    if (/FROM orders\b/iu.test(this.sql) && /checkout_subject_hash/iu.test(this.sql) && this.forceCheckoutLookupMiss()) return Promise.resolve(null);
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: Record<string, SQLInputValue>[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  private checkoutLookupMisses = 0;
  private batchFailureFragment: string | null = null;
  private batchGate: { reached: () => void; resume: Promise<void> } | null = null;

  constructor(readonly database: DatabaseSync) {}

  hideNextCheckoutLookup(): void {
    this.checkoutLookupMisses += 1;
  }

  failNextBatchOn(fragment: string): void {
    this.batchFailureFragment = fragment;
  }

  pauseNextBatch(): { reached: Promise<void>; resume: () => void } {
    let markReached: () => void = () => undefined;
    let resume: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => { markReached = resolve; });
    const resumePromise = new Promise<void>((resolve) => { resume = resolve; });
    this.batchGate = { reached: markReached, resume: resumePromise };
    return { reached, resume };
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql, () => {
      if (this.checkoutLookupMisses < 1) return false;
      this.checkoutLookupMisses -= 1;
      return true;
    });
  }

  async batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const gate = this.batchGate;
    if (gate !== null) {
      this.batchGate = null;
      gate.reached();
      await gate.resume;
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        if (this.batchFailureFragment !== null && statement.sqlText.includes(this.batchFailureFragment)) {
          this.batchFailureFragment = null;
          throw new Error("injected_batch_failure");
        }
        results.push(await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const databases: DatabaseSync[] = [];
const NOW = "2026-07-29T00:00:00.000Z";
const SHOP_ID = "shop-parity";
const INTEGRATION_ID = "integration-parity";
const TELEGRAM_CUSTOMER_ID = "customer-parity";
const FAKE_CUSTOMER_ID = "customer-fake-parity";
const FAKE_CONNECTION_ID = "connection-fake-parity";
const FAKE_REGISTRY = new ChannelAdapterRegistry([FAKE_CHANNEL_MANIFEST]);
const FAKE_PLAN_ENTITLEMENTS = new Set(FAKE_CHANNEL_MANIFEST.capabilities);

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createRuntime(): { database: SqliteD1; env: AppBindings; fakeShop: PrincipalChannelShop; shop: StorefrontShop; telegramShop: TelegramCheckoutShop } {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations")).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    sqlite.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  sqlite.exec(`
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('user-parity', 'parity@example.test', 'Parity test', 'active', '${NOW}', '${NOW}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('${SHOP_ID}', 'shop-public-parity', 'parity-shop', 'Parity Shop', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, '${NOW}', '${NOW}');
    INSERT INTO telegram_integrations (id, public_id, webhook_public_id, shop_id, status, webhook_status, created_at, updated_at)
    VALUES ('${INTEGRATION_ID}', 'integration-public-parity', 'webhook-public-parity', '${SHOP_ID}', 'active', 'verified', '${NOW}', '${NOW}');
    INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at)
    VALUES
      ('${TELEGRAM_CUSTOMER_ID}', '${SHOP_ID}', 'telegram-parity@example.test', 'Telegram buyer', 'vi', 'active', '${NOW}', '${NOW}'),
      ('${FAKE_CUSTOMER_ID}', '${SHOP_ID}', 'fake-parity@example.test', 'Fake-channel buyer', 'vi', 'active', '${NOW}', '${NOW}');
    INSERT INTO shop_channels (id, shop_id, channel_code, status, settings_json, version, created_at, updated_at)
    VALUES ('shop-channel-fake-parity', '${SHOP_ID}', '${FAKE_CHANNEL_CODE}', 'enabled', '{}', 1, '${NOW}', '${NOW}');
    INSERT INTO channel_connections (id, public_id, shop_id, shop_channel_id, provider_code, status, settings_json, version, connected_at, created_at, updated_at)
    VALUES ('${FAKE_CONNECTION_ID}', 'public-connection-fake-parity', '${SHOP_ID}', 'shop-channel-fake-parity', '${FAKE_CHANNEL_CODE}', 'active', '{}', 1, '${NOW}', '${NOW}', '${NOW}');
    INSERT INTO channel_connection_grants (shop_id, connection_id, capability_code, granted_at)
    VALUES
      ('${SHOP_ID}', '${FAKE_CONNECTION_ID}', 'catalog.read', '${NOW}'),
      ('${SHOP_ID}', '${FAKE_CONNECTION_ID}', 'cart.interactive', '${NOW}'),
      ('${SHOP_ID}', '${FAKE_CONNECTION_ID}', 'checkout.external_link', '${NOW}'),
      ('${SHOP_ID}', '${FAKE_CONNECTION_ID}', 'orders.status_push', '${NOW}');
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
    VALUES
      ('product-free', '${SHOP_ID}', 'free-license', 'Free license', '', 'active', 'license_key', 1, '${NOW}', '${NOW}'),
      ('product-paid', '${SHOP_ID}', 'paid-license', 'Paid license', '', 'active', 'license_key', 1, '${NOW}', '${NOW}'),
      ('product-generated-free', '${SHOP_ID}', 'generated-free-license', 'Generated free license', '', 'active', 'manual', 1, '${NOW}', '${NOW}'),
      ('product-generated-paid', '${SHOP_ID}', 'generated-paid-license', 'Generated paid license', '', 'active', 'manual', 1, '${NOW}', '${NOW}'),
      ('product-manual', '${SHOP_ID}', 'manual-access', 'Manual access', '', 'active', 'manual', 1, '${NOW}', '${NOW}'),
      ('product-private', '${SHOP_ID}', 'private-download', 'Private download', '', 'active', 'manual', 1, '${NOW}', '${NOW}'),
      ('product-last', '${SHOP_ID}', 'last-license', 'Last license', '', 'active', 'license_key', 1, '${NOW}', '${NOW}');
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
    VALUES
      ('variant-free', '${SHOP_ID}', 'product-free', 'SKU-FREE', 'Default', '{}', 0, 'VND', 1, 5, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-paid', '${SHOP_ID}', 'product-paid', 'SKU-PAID', 'Default', '{}', 9000, 'VND', 1, 5, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-generated-free', '${SHOP_ID}', 'product-generated-free', 'SKU-GENERATED-FREE', 'Default', '{}', 0, 'VND', 1, 1, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-generated-paid', '${SHOP_ID}', 'product-generated-paid', 'SKU-GENERATED-PAID', 'Default', '{}', 11000, 'VND', 1, 1, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-manual', '${SHOP_ID}', 'product-manual', 'SKU-MANUAL', 'Default', '{}', 0, 'VND', 1, 5, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-private-free', '${SHOP_ID}', 'product-private', 'SKU-PRIVATE-FREE', 'Default', '{}', 0, 'VND', 1, 5, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-private-paid', '${SHOP_ID}', 'product-private', 'SKU-PRIVATE-PAID', 'Paid', '{}', 7000, 'VND', 1, 5, 'active', 1, '${NOW}', '${NOW}'),
      ('variant-last', '${SHOP_ID}', 'product-last', 'SKU-LAST', 'Default', '{}', 5000, 'VND', 1, 5, 'active', 1, '${NOW}', '${NOW}');
    INSERT INTO discounts (id, shop_id, code_normalized, type, value, currency, minimum_minor, status, created_at, updated_at)
    VALUES ('discount-parity', '${SHOP_ID}', 'WELCOME15', 'percentage', 1500, 'VND', 0, 'active', '${NOW}', '${NOW}');
    INSERT INTO inventory_batches (id, shop_id, variant_id, source, filename_sanitized, total_count, accepted_count, rejected_count, created_by_user_id, created_at)
    VALUES
      ('batch-free', '${SHOP_ID}', 'variant-free', 'paste', NULL, 2, 2, 0, 'user-parity', '${NOW}'),
      ('batch-paid', '${SHOP_ID}', 'variant-paid', 'paste', NULL, 4, 4, 0, 'user-parity', '${NOW}'),
      ('batch-last', '${SHOP_ID}', 'variant-last', 'paste', NULL, 1, 1, 0, 'user-parity', '${NOW}');
    INSERT INTO inventory_keys (id, shop_id, variant_id, batch_id, status, ciphertext_b64, iv_b64, key_version, key_fingerprint, created_at)
    VALUES
      ('key-free-1', '${SHOP_ID}', 'variant-free', 'batch-free', 'available', 'cipher-free-1', 'iv-free-1', 'v1', 'fingerprint-free-1', '${NOW}'),
      ('key-free-2', '${SHOP_ID}', 'variant-free', 'batch-free', 'available', 'cipher-free-2', 'iv-free-2', 'v1', 'fingerprint-free-2', '${NOW}'),
      ('key-paid-1', '${SHOP_ID}', 'variant-paid', 'batch-paid', 'available', 'cipher-paid-1', 'iv-paid-1', 'v1', 'fingerprint-paid-1', '${NOW}'),
      ('key-paid-2', '${SHOP_ID}', 'variant-paid', 'batch-paid', 'available', 'cipher-paid-2', 'iv-paid-2', 'v1', 'fingerprint-paid-2', '${NOW}'),
      ('key-paid-3', '${SHOP_ID}', 'variant-paid', 'batch-paid', 'available', 'cipher-paid-3', 'iv-paid-3', 'v1', 'fingerprint-paid-3', '${NOW}'),
      ('key-paid-4', '${SHOP_ID}', 'variant-paid', 'batch-paid', 'available', 'cipher-paid-4', 'iv-paid-4', 'v1', 'fingerprint-paid-4', '${NOW}'),
      ('key-last-1', '${SHOP_ID}', 'variant-last', 'batch-last', 'available', 'cipher-last-1', 'iv-last-1', 'v1', 'fingerprint-last-1', '${NOW}');
    INSERT INTO digital_assets (id, shop_id, kind, status, created_by_user_id, created_at, updated_at)
    VALUES ('asset-private-parity', '${SHOP_ID}', 'private_file', 'active', 'user-parity', '${NOW}', '${NOW}');
    INSERT INTO digital_asset_versions (
      id, shop_id, asset_id, version, object_key, filename_sanitized,
      content_type, byte_size, content_sha256, object_etag, status,
      created_by_user_id, created_at, updated_at
    ) VALUES (
      'asset-version-private-parity', '${SHOP_ID}', 'asset-private-parity', 1,
      'private-digital-assets/shop-parity/asset-private-parity-v1',
      'Parity Guide.pdf', 'application/pdf', 128,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'etag-private-parity-v1',
      'active', 'user-parity', '${NOW}', '${NOW}'
    );
    INSERT INTO entitlement_resources (
      id, shop_id, resource_key, resource_type, status, created_at, updated_at
    ) VALUES
      ('resource-generated-free', '${SHOP_ID}', 'generated.parity.free', 'generated_license', 'active', '${NOW}', '${NOW}'),
      ('resource-generated-paid', '${SHOP_ID}', 'generated.parity.paid', 'generated_license', 'active', '${NOW}', '${NOW}');
    INSERT INTO product_entitlement_policies (
      id, shop_id, product_id, resource_id, policy_version, activation_condition,
      grant_quantity_per_unit, entitlement_ttl_seconds, status, created_at, updated_at
    ) VALUES
      ('policy-generated-free-v1', '${SHOP_ID}', 'product-generated-free', 'resource-generated-free', 1, 'order_paid', 1, NULL, 'active', '${NOW}', '${NOW}'),
      ('policy-generated-paid-v1', '${SHOP_ID}', 'product-generated-paid', 'resource-generated-paid', 1, 'order_paid', 1, NULL, 'active', '${NOW}', '${NOW}');
    INSERT INTO generated_license_provider_connections (
      id, shop_id, provider_code, provider_environment, status,
      created_by_user_id, created_at, updated_at
    ) VALUES ('connection-generated-parity', '${SHOP_ID}', 'fake.license', 'sandbox', 'active', 'user-parity', '${NOW}', '${NOW}');
    INSERT INTO generated_license_provider_credentials (
      id, shop_id, connection_id, provider_code, credential_version, status,
      key_version, endpoint_ciphertext_b64, endpoint_iv_b64,
      credential_ciphertext_b64, credential_iv_b64, endpoint_fingerprint,
      credential_fingerprint, created_by_user_id, activated_at, created_at,
      updated_at
    ) VALUES (
      'credential-generated-parity', '${SHOP_ID}', 'connection-generated-parity', 'fake.license', 1, 'active',
      'v1', 'endpoint-ciphertext', 'endpoint-iv', 'credential-ciphertext', 'credential-iv',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'user-parity', '${NOW}', '${NOW}', '${NOW}'
    );
    INSERT INTO generated_license_resource_bindings (
      id, shop_id, resource_id, connection_id, provider_code,
      generation_template_version, request_shape_hash, status,
      created_by_user_id, created_at, updated_at
    ) VALUES
      ('binding-generated-free', '${SHOP_ID}', 'resource-generated-free', 'connection-generated-parity', 'fake.license', 1, 'ccccccccccccccccccccccccccccccccccccccccccc', 'active', 'user-parity', '${NOW}', '${NOW}'),
      ('binding-generated-paid', '${SHOP_ID}', 'resource-generated-paid', 'connection-generated-parity', 'fake.license', 1, 'ddddddddddddddddddddddddddddddddddddddddddd', 'active', 'user-parity', '${NOW}', '${NOW}');
    INSERT INTO product_fulfillment_policies (
      id, shop_id, product_id, capability, policy_version, asset_version_id,
      max_downloads, grant_ttl_seconds, entitlement_ttl_seconds, status,
      created_by_user_id, created_at, updated_at
    ) VALUES (
      'policy-private-parity-v1', '${SHOP_ID}', 'product-private', 'private_file', 1,
      'asset-version-private-parity', 3, 600, 3600, 'active',
      'user-parity', '${NOW}', '${NOW}'
    );
  `);
  const database = new SqliteD1(sqlite);
  const env = { IDENTIFIER_HMAC_SECRET: "commerce-parity-secret", PLATFORM_DB: database as unknown as D1Database } as unknown as AppBindings;
  const shop = {
    access: "live",
    canonicalHostname: "parity.selinow.com",
    content: {
      announcement: null,
      deliveryText: "Delivery",
      description: "Parity",
      footerText: "Footer",
      headline: "Parity",
      seoDescription: "Parity",
      seoTitle: "Parity",
      showExactStock: false,
      supportText: "Support",
    },
    currency: "VND",
    currentHostname: "parity.selinow.com",
    defaultLocale: "vi",
    id: SHOP_ID,
    lowStockThreshold: 1,
    name: "Parity Shop",
    orderExpiryMinutes: 30,
    publicId: "shop-public-parity",
    publicDetails: { deliveryText: "Delivery", privacyUrl: null, refundPolicyUrl: null, support: { href: null, label: "Support" }, termsUrl: null },
    settingsVersion: 1,
    slug: "parity-shop",
    status: "active",
    subscriptionState: "active",
    theme: { accent: "#111111", accentInk: "#FFFFFF", brand: "#111111", brandInk: "#FFFFFF", logoUrl: null },
  } as StorefrontShop;
  const telegramShop: TelegramCheckoutShop = { currency: "VND", defaultLocale: "vi", id: SHOP_ID, orderExpiryMinutes: 30, status: "active", subscriptionState: "active" };
  const fakeShop: PrincipalChannelShop = { currency: "VND", defaultLocale: "vi", id: SHOP_ID, orderExpiryMinutes: 30, status: "active", subscriptionState: "active" };
  return { database, env, fakeShop, shop, telegramShop };
}

type PreparedWebsiteCheckout = {
  app: CommerceApplicationService;
  command: CommerceCheckoutCommand;
  context: CommerceContext;
  quote: CommerceQuoteView;
};

type PreparedTelegramCheckout = {
  app: CommerceApplicationService;
  command: CommerceCheckoutCommand;
  context: CommerceContext;
  snapshot: Awaited<ReturnType<typeof readTelegramCartLines>>;
};

type PreparedFakeCheckout = {
  adapter: FakeChannelAdapter;
  app: CommerceApplicationService;
  command: CommerceCheckoutCommand;
  context: CommerceContext;
  quote: CommerceQuoteView;
};

function expectedItems(quote: CommerceQuoteView): CommerceCheckoutCommand["expected"] {
  return quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion }));
}

function expectedSnapshot(snapshot: PreparedTelegramCheckout["snapshot"]): CommerceCheckoutCommand["expected"] {
  return snapshot.lines.map((line) => ({ quantity: line.quantity, unitPriceMinor: line.priceMinor, variantId: line.variantId, variantVersion: line.version }));
}

async function prepareWebsiteCheckout(runtime: ReturnType<typeof createRuntime>, variantId: string, idempotencyKey: string, customerEmail = "website-parity@example.test", discountCode: string | null = null, locale = "vi"): Promise<PreparedWebsiteCheckout> {
  const context: CommerceContext = { actor: { kind: "anonymous" }, channel: { code: "website", connectionId: null }, locale, requestId: `request-${idempotencyKey}`, shopId: SHOP_ID };
  const app = createWebsiteCommerceApplication(runtime.env, runtime.shop);
  const cart = await app.createCart(context, { items: [{ quantity: 1, variantId }] });
  if (cart.access.kind !== "opaque_token") throw new Error("website_cart_access_invalid");
  const cartReference = { access: cart.access, cartId: cart.cartId };
  if (discountCode !== null) {
    await app.mutateCart(context, {
      cart: cartReference,
      idempotencyKey: `${idempotencyKey}-discount`,
      mutation: { code: discountCode, kind: "discount.apply" },
    });
  }
  const quote = await app.quoteCart(context, { cart: cartReference });
  if (quote.quoteEvidence === undefined) throw new Error("website_quote_evidence_missing");
  return {
    app,
    command: { cart: cartReference, customerEmail, expected: expectedItems(quote), idempotencyKey, quoteEvidence: quote.quoteEvidence },
    context,
    quote,
  };
}

async function prepareTelegramCheckout(runtime: ReturnType<typeof createRuntime>, variantId: string, updateId: number, discountCode: string | null = null, locale = "vi"): Promise<PreparedTelegramCheckout> {
  const identity = { customerId: TELEGRAM_CUSTOMER_ID, subjectHash: `telegram-subject-${String(updateId)}` };
  const shop = { ...runtime.telegramShop, defaultLocale: locale };
  const mutationKey = await createTelegramCartMutationApplicationKey(runtime.env, SHOP_ID, INTEGRATION_ID, updateId);
  const mutationContext: CommerceContext = { actor: { customerId: identity.customerId, kind: "customer" }, channel: { code: "telegram", connectionId: null }, locale, requestId: mutationKey, shopId: SHOP_ID };
  const mutationApplication = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: mutationKey, identity, integrationId: INTEGRATION_ID, shop, updateId }));
  let mutation = await mutationApplication.mutateCart(mutationContext, { cart: { access: { kind: "principal" }, cartId: null }, idempotencyKey: mutationKey, mutation: { kind: "item.increment", quantity: 1, variantId } });
  let quoteApplication = mutationApplication;
  let quoteContext = mutationContext;
  if (discountCode !== null) {
    const discountUpdateId = updateId + 10_000;
    const discountKey = await createTelegramCartMutationApplicationKey(runtime.env, SHOP_ID, INTEGRATION_ID, discountUpdateId);
    quoteContext = { ...mutationContext, requestId: discountKey };
    quoteApplication = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: discountKey, identity, integrationId: INTEGRATION_ID, shop, updateId: discountUpdateId }));
    mutation = await quoteApplication.mutateCart(quoteContext, { cart: { access: { kind: "principal" }, cartId: null }, idempotencyKey: discountKey, mutation: { code: discountCode, kind: "discount.apply" } });
  }
  const quote = await quoteApplication.quoteCart(quoteContext, { cart: mutation.cart });
  if (quote.quoteEvidence === undefined) throw new Error("telegram_quote_evidence_missing");
  const snapshot = await readTelegramCartLines(runtime.env, shop, mutation.cart.cartId);
  const checkoutKey = await createTelegramCheckoutApplicationKey(runtime.env, SHOP_ID, INTEGRATION_ID, updateId);
  const context: CommerceContext = { actor: { customerId: identity.customerId, kind: "customer" }, channel: { code: "telegram", connectionId: null }, locale, requestId: checkoutKey, shopId: SHOP_ID };
  const app = createTelegramCheckoutApplication({ connectionId: null, env: runtime.env, expectedIdempotencyKey: checkoutKey, identity: { ...identity, integrationId: INTEGRATION_ID }, requestedSnapshot: snapshot, shop, updateId });
  return { app, command: { cart: { access: { kind: "principal" }, cartId: snapshot.cartId }, customerEmail: null, expected: expectedSnapshot(snapshot), idempotencyKey: checkoutKey, quoteEvidence: quote.quoteEvidence }, context, snapshot };
}

async function prepareFakeCheckout(runtime: ReturnType<typeof createRuntime>, variantId: string, idempotencyKey: string, discountCode: string | null = null, locale = "vi"): Promise<PreparedFakeCheckout> {
  const adapter = new FakeChannelAdapter({ now: NOW });
  await adapter.connect({ connectionId: FAKE_CONNECTION_ID, shopId: SHOP_ID }, `connect:${idempotencyKey}`);
  const [event] = await adapter.verifyAndNormalize(new Request("https://fake.invalid/webhook", {
    body: JSON.stringify({
      action: "checkout.create",
      eventReference: `event:${idempotencyKey}`,
      idempotencyKey: `inbound:${idempotencyKey}`,
      payloadReference: `payload:${idempotencyKey}`,
      receivedAt: NOW,
    }),
    method: "POST",
  }), { connectionId: FAKE_CONNECTION_ID, shopId: SHOP_ID });
  if (event === undefined) throw new Error("fake_event_missing");
  const context: CommerceContext = {
    actor: { customerId: FAKE_CUSTOMER_ID, kind: "customer" },
    channel: { code: event.channelCode, connectionId: event.connectionId },
    locale,
    requestId: event.idempotencyKey,
    shopId: event.shopId,
  };
  const app = createPrincipalChannelCommerceApplication({
    adapterVersion: adapter.manifest.version,
    channelCode: adapter.manifest.code,
    connectionId: FAKE_CONNECTION_ID,
    env: runtime.env,
    expectedIdempotencyKey: idempotencyKey,
    identity: { customerId: FAKE_CUSTOMER_ID, subjectHash: `fake-subject:${idempotencyKey}` },
    legacySourceChannel: "web",
    planEntitlements: FAKE_PLAN_ENTITLEMENTS,
    registry: FAKE_REGISTRY,
    shop: runtime.fakeShop,
  });
  const cart = await app.createCart(context, { items: [{ quantity: 1, variantId }] });
  if (discountCode !== null) {
    await app.mutateCart(context, {
      cart: { access: { kind: "principal" }, cartId: null },
      idempotencyKey: `${idempotencyKey}:discount`,
      mutation: { code: discountCode, kind: "discount.apply" },
    });
  }
  const quote = await app.quoteCart(context, { cart: { access: cart.access, cartId: cart.cartId } });
  if (quote.quoteEvidence === undefined) throw new Error("fake_quote_evidence_missing");
  return {
    adapter,
    app,
    command: {
      cart: { access: { kind: "principal" }, cartId: cart.cartId },
      customerEmail: null,
      expected: expectedItems(quote),
      idempotencyKey,
      quoteEvidence: quote.quoteEvidence,
    },
    context,
    quote,
  };
}

async function checkoutAndReadOrder(input: { app: CommerceApplicationService; command: CommerceCheckoutCommand; context: CommerceContext }): Promise<{ order: Awaited<ReturnType<CommerceApplicationService["getOrder"]>>; view: CommerceCheckoutView }> {
  const view = await input.app.checkoutCart(input.context, input.command);
  const access = view.access.kind === "principal" ? { kind: "principal" as const } : view.access;
  const order = await input.app.getOrder(input.context, { order: { access, orderId: view.orderId } });
  return { order, view };
}

function persistedCheckoutState(runtime: ReturnType<typeof createRuntime>, cartId: string, variantId: string): {
  cart: { discountCode: string | null; locale: string; state: string } | null;
  fulfillments: Array<{ state: string; type: string }>;
  inventory: Array<{ count: number; status: string }>;
  order: { currency: string; discountMinor: number; fulfillmentStatus: string; locale: string; paymentStatus: string; sourceChannel: string; status: string; subtotalMinor: number; totalMinor: number } | null;
} {
  const database = runtime.database.database;
  const cart = database.prepare("SELECT discount_code_normalized AS discountCode, locale, state FROM carts WHERE id = ? AND shop_id = ?").get(cartId, SHOP_ID) as { discountCode: string | null; locale: string; state: string } | undefined;
  const order = database.prepare(`
    SELECT currency, discount_minor AS discountMinor, fulfillment_status AS fulfillmentStatus,
      locale, payment_status AS paymentStatus, source_channel AS sourceChannel,
      status, subtotal_minor AS subtotalMinor, total_minor AS totalMinor
    FROM orders WHERE shop_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(SHOP_ID) as { currency: string; discountMinor: number; fulfillmentStatus: string; locale: string; paymentStatus: string; sourceChannel: string; status: string; subtotalMinor: number; totalMinor: number } | undefined;
  const fulfillments = database.prepare("SELECT fulfillment_type AS type, state FROM fulfillments WHERE shop_id = ? ORDER BY fulfillment_type, id").all(SHOP_ID) as Array<{ state: string; type: string }>;
  const inventory = database.prepare("SELECT status, COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = ? GROUP BY status ORDER BY status").all(SHOP_ID, variantId) as Array<{ count: number; status: string }>;
  return { cart: cart ?? null, fulfillments, inventory, order: order ?? null };
}

describe("canonical commerce channel parity on local D1", () => {
  it.each([
    ["without discount", null, 9000],
    ["with discount", "WELCOME15", 7650],
  ] as const)("recovers a canonical Website checkout %s from pre-authorized evidence", async (_label, discountCode, expectedTotal) => {
    const runtime = createRuntime();
    const idempotencyKey = discountCode === null
      ? "parity-recovery-canonical-plain-0001"
      : "parity-recovery-canonical-discount-0001";
    const prepared = await prepareWebsiteCheckout(
      runtime,
      "variant-paid",
      idempotencyKey,
      "recovery-parity@example.test",
      discountCode,
    );
    if (prepared.command.quoteEvidence === undefined) throw new Error("website_recovery_quote_evidence_missing");
    const recovery = await prepared.app.prepareCheckoutRecovery(prepared.context, {
      cart: prepared.command.cart,
      customerEmail: prepared.command.customerEmail,
      expected: prepared.command.expected,
      idempotencyKey: prepared.command.idempotencyKey,
      quoteEvidence: prepared.command.quoteEvidence,
    });

    const created = await prepared.app.checkoutCart(prepared.context, prepared.command);
    const recovered = await prepared.app.recoverCheckout(prepared.context, {
      cart: prepared.command.cart,
      customerEmail: prepared.command.customerEmail,
      expected: prepared.command.expected,
      idempotencyKey: prepared.command.idempotencyKey,
      recoveryEvidence: recovery.evidence,
    });

    expect(created).toMatchObject({ paymentStatus: "unpaid", status: "pending_payment", totalMinor: expectedTotal });
    expect(recovered).toMatchObject({
      access: created.access,
      orderId: created.orderId,
      paymentStatus: created.paymentStatus,
      status: created.status,
      totalMinor: expectedTotal,
    });
    await expect(prepared.app.recoverCheckout(prepared.context, {
      cart: prepared.command.cart,
      customerEmail: prepared.command.customerEmail,
      expected: prepared.command.expected,
      idempotencyKey: prepared.command.idempotencyKey,
      recoveryEvidence: recovery.evidence,
    })).resolves.toMatchObject({
      access: created.access,
      orderId: created.orderId,
      paymentStatus: created.paymentStatus,
      status: created.status,
      totalMinor: expectedTotal,
    });
    expect(runtime.database.database.prepare(`
      SELECT COUNT(*) AS count FROM checkout_recovery_capabilities
      WHERE shop_id = ? AND consumed_at IS NOT NULL
    `).get(SHOP_ID)).toEqual({ count: 1 });
    const persisted = runtime.database.database.prepare(`
      SELECT checkout_request_hash AS requestHash, discount_minor AS discountMinor,
        total_minor AS totalMinor
      FROM orders WHERE shop_id = ? AND public_id = ?
    `).get(SHOP_ID, created.orderId) as { discountMinor: number; requestHash: string; totalMinor: number } | undefined;
    expect(persisted).toMatchObject({
      discountMinor: discountCode === null ? 0 : 1350,
      totalMinor: expectedTotal,
    });
    expect(persisted?.requestHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it("fails closed before checkout when expected lines mix fulfillment modes", async () => {
    const runtime = createRuntime();
    const context: CommerceContext = {
      actor: { kind: "anonymous" },
      channel: { code: "website", connectionId: null },
      locale: "vi",
      requestId: "request-recovery-reordered-0001",
      shopId: SHOP_ID,
    };
    const app = createWebsiteCommerceApplication(runtime.env, runtime.shop);
    const cart = await app.createCart(context, {
      items: [
        { quantity: 1, variantId: "variant-paid" },
        { quantity: 1, variantId: "variant-manual" },
      ],
    });
    if (cart.access.kind !== "opaque_token") throw new Error("website_reordered_cart_access_invalid");
    const cartReference = { access: cart.access, cartId: cart.cartId };
    const quote = await app.quoteCart(context, { cart: cartReference });
    if (quote.quoteEvidence === undefined) throw new Error("website_mixed_quote_evidence_missing");
    await expect(app.checkoutCart(context, {
      cart: cartReference,
      customerEmail: null,
      expected: expectedItems(quote),
      idempotencyKey: "parity-recovery-reordered-0001",
      quoteEvidence: quote.quoteEvidence,
    })).rejects.toMatchObject({
      code: "mixed_fulfillment_unsupported",
      status: 409,
      issues: ["split_cart_by_fulfillment"],
    });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
  });

  it.each(["website", "telegram", "fake"] as const)("keeps %s commerce state equivalent for English and Vietnamese locales", async (channel) => {
    const run = async (locale: "en" | "vi-VN") => {
      const runtime = createRuntime();
      const prepared = channel === "website"
        ? await prepareWebsiteCheckout(runtime, "variant-paid", `parity-locale-${channel}-${locale}-0001`, `locale-${locale}@example.test`, null, locale)
        : channel === "telegram"
          ? await prepareTelegramCheckout(runtime, "variant-paid", locale === "en" ? 2101 : 2102, null, locale)
          : await prepareFakeCheckout(runtime, "variant-paid", `parity-locale-${channel}-${locale}-0001`, null, locale);
      const result = await checkoutAndReadOrder({ app: prepared.app, command: prepared.command, context: prepared.context });
      const state = persistedCheckoutState(runtime, prepared.command.cart.cartId, "variant-paid");
      expect(state.order?.locale).toBe(locale);
      expect(state.cart?.locale).toBe(locale);
      return {
        order: { ...state.order, locale: undefined },
        result: { items: result.order.items, view: { currency: result.view.currency, fulfillmentStatus: result.view.fulfillmentStatus, paymentStatus: result.view.paymentStatus, status: result.view.status, totalMinor: result.view.totalMinor } },
        cart: { ...state.cart, locale: undefined },
        fulfillments: state.fulfillments,
        inventory: state.inventory,
      };
    };

    const english = await run("en");
    const vietnamese = await run("vi-VN");
    expect(vietnamese).toEqual(english);
  });

  it("executes free-license, paid-reservation and free-manual checkouts through the fake adapter on real D1", async () => {
    const runtime = createRuntime();
    const free = await prepareFakeCheckout(runtime, "variant-free", "parity-fake-free-0001");
    const paid = await prepareFakeCheckout(runtime, "variant-paid", "parity-fake-paid-0001");
    const manual = await prepareFakeCheckout(runtime, "variant-manual", "parity-fake-manual-0001");
    const freeResult = await checkoutAndReadOrder({ app: free.app, command: free.command, context: free.context });
    const paidResult = await checkoutAndReadOrder({ app: paid.app, command: paid.command, context: paid.context });
    const manualResult = await checkoutAndReadOrder({ app: manual.app, command: manual.command, context: manual.context });

    expect(freeResult.view).toMatchObject({ fulfillmentStatus: "fulfilled", paymentStatus: "paid", status: "completed", totalMinor: 0 });
    expect(paidResult.view).toMatchObject({ fulfillmentStatus: "reserved", paymentStatus: "unpaid", status: "pending_payment", totalMinor: 9000 });
    expect(manualResult.view).toMatchObject({ fulfillmentStatus: "unfulfilled", paymentStatus: "paid", status: "processing", totalMinor: 0 });
    expect(freeResult.order.items).toEqual([{ fulfillmentType: "license_key", lineTotalMinor: 0, productTitle: "Free license", quantity: 1, variantTitle: "Default" }]);
    expect(paidResult.order.items).toEqual([{ fulfillmentType: "license_key", lineTotalMinor: 9000, productTitle: "Paid license", quantity: 1, variantTitle: "Default" }]);
    expect(manualResult.order.items).toEqual([{ fulfillmentType: "manual", lineTotalMinor: 0, productTitle: "Manual access", quantity: 1, variantTitle: "Default" }]);
    expect(runtime.database.database.prepare("SELECT source_channel AS sourceChannel, COUNT(*) AS count FROM orders WHERE shop_id = ? GROUP BY source_channel").all(SHOP_ID)).toEqual([{ sourceChannel: "web", count: 3 }]);
    expect(runtime.database.database.prepare("SELECT channel_code AS channelCode, adapter_version AS adapterVersion, connection_id AS connectionId, COUNT(*) AS count FROM order_channel_attributions WHERE shop_id = ? GROUP BY channel_code, adapter_version, connection_id").all(SHOP_ID)).toEqual([{ channelCode: FAKE_CHANNEL_CODE, adapterVersion: 1, connectionId: FAKE_CONNECTION_ID, count: 3 }]);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM order_items WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 3 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM fulfillment_items WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-free' AND status = 'sold'").get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT fulfillment_type AS fulfillmentType, state FROM fulfillments WHERE shop_id = ? ORDER BY fulfillment_type").all(SHOP_ID)).toEqual([
      { fulfillmentType: "digital_keys", state: "fulfilled" },
      { fulfillmentType: "manual", state: "pending" },
    ]);
  });

  it("keeps the fake web compatibility bucket out of Website order, payment and private-download authorization", async () => {
    const runtime = createRuntime();
    const paidKey = "parity-fake-website-boundary-paid-0001";
    const paid = await prepareFakeCheckout(runtime, "variant-paid", paidKey);
    const paidOrder = await paid.app.checkoutCart(paid.context, paid.command);
    const paidToken = await hmacToken(
      runtime.env.IDENTIFIER_HMAC_SECRET,
      `principal-order-token:${SHOP_ID}:${FAKE_CHANNEL_CODE}:${FAKE_CONNECTION_ID}`,
      paidKey,
    );
    const websiteContext: CommerceContext = {
      actor: { kind: "anonymous" },
      channel: { code: "website", connectionId: null },
      locale: "vi",
      requestId: "request-fake-website-boundary-0001",
      shopId: SHOP_ID,
    };
    const websiteApplication = createWebsiteCommerceApplication(runtime.env, runtime.shop);
    await expect(websiteApplication.getOrder(websiteContext, {
      order: { access: { kind: "opaque_token", token: paidToken }, orderId: paidOrder.orderId },
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
    await expect(getPaymentFulfillmentEligibility({
      env: runtime.env,
      orderPublicId: paidOrder.orderId,
      orderToken: paidToken,
      shopId: SHOP_ID,
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });

    const privateKey = "parity-fake-website-boundary-private-0001";
    const privateCheckout = await prepareFakeCheckout(runtime, "variant-private-free", privateKey);
    const privateOrder = await privateCheckout.app.checkoutCart(privateCheckout.context, privateCheckout.command);
    const privateToken = await hmacToken(
      runtime.env.IDENTIFIER_HMAC_SECRET,
      `principal-order-token:${SHOP_ID}:${FAKE_CHANNEL_CODE}:${FAKE_CONNECTION_ID}`,
      privateKey,
    );
    await expect(listWebsitePrivateDownloads({
      env: runtime.env,
      orderPublicId: privateOrder.orderId,
      orderToken: privateToken,
      shopId: SHOP_ID,
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });

    expect(runtime.database.database.prepare(`
      SELECT orders.source_channel AS sourceChannel,
        attribution.channel_code AS channelCode,
        attribution.adapter_version AS adapterVersion,
        attribution.connection_id AS connectionId
      FROM orders
      INNER JOIN order_channel_attributions AS attribution
        ON attribution.shop_id = orders.shop_id AND attribution.order_id = orders.id
      WHERE orders.shop_id = ? AND orders.public_id IN (?, ?)
      ORDER BY orders.public_id
    `).all(SHOP_ID, paidOrder.orderId, privateOrder.orderId)).toEqual([
      expect.objectContaining({ adapterVersion: 1, channelCode: FAKE_CHANNEL_CODE, connectionId: FAKE_CONNECTION_ID, sourceChannel: "web" }),
      expect.objectContaining({ adapterVersion: 1, channelCode: FAKE_CHANNEL_CODE, connectionId: FAKE_CONNECTION_ID, sourceChannel: "web" }),
    ]);
  });

  it("rejects Website replay when normalized attribution no longer identifies Website", async () => {
    const runtime = createRuntime();
    const prepared = await prepareWebsiteCheckout(runtime, "variant-paid", "parity-website-attribution-replay-0001");
    const first = await prepared.app.checkoutCart(prepared.context, prepared.command);
    runtime.database.database.prepare(`
      UPDATE order_channel_attributions
      SET channel_code = ?, adapter_version = 1, connection_id = ?
      WHERE shop_id = ? AND order_id = (SELECT id FROM orders WHERE public_id = ? AND shop_id = ?)
    `).run(FAKE_CHANNEL_CODE, FAKE_CONNECTION_ID, SHOP_ID, first.orderId, SHOP_ID);

    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    if (first.access.kind !== "opaque_token") throw new Error("website_order_token_missing");
    await expect(prepared.app.getOrder(prepared.context, {
      order: { access: first.access, orderId: first.orderId },
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
  });

  it("preserves Website authorization and replay for explicit pre-attribution legacy rows", async () => {
    const runtime = createRuntime();
    const prepared = await prepareWebsiteCheckout(runtime, "variant-free", "parity-website-legacy-attribution-0001");
    const first = await prepared.app.checkoutCart(prepared.context, prepared.command);
    runtime.database.database.prepare(`
      DELETE FROM order_channel_attributions
      WHERE shop_id = ? AND order_id = (SELECT id FROM orders WHERE public_id = ? AND shop_id = ?)
    `).run(SHOP_ID, first.orderId, SHOP_ID);

    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).resolves.toEqual(first);
    if (first.access.kind !== "opaque_token") throw new Error("website_order_token_missing");
    await expect(prepared.app.getOrder(prepared.context, {
      order: { access: first.access, orderId: first.orderId },
    })).resolves.toMatchObject({ paymentStatus: "paid", status: "completed" });
    await expect(getPaymentFulfillmentEligibility({
      env: runtime.env,
      orderPublicId: first.orderId,
      orderToken: first.access.token,
      shopId: SHOP_ID,
    })).resolves.toEqual({ eligible: true, reason: "ready" });
  });

  it.each([
    ["unsupported", "GBP"],
    ["shop-mismatched", "USD"],
  ] as const)("rejects a fake checkout with %s currency before any real-D1 write", async (kind, currency) => {
    const runtime = createRuntime();
    const prepared = await prepareFakeCheckout(runtime, "variant-paid", `parity-fake-currency-${kind}-0001`);
    const badApp = createPrincipalChannelCommerceApplication({
      adapterVersion: FAKE_CHANNEL_MANIFEST.version,
      channelCode: FAKE_CHANNEL_MANIFEST.code,
      connectionId: FAKE_CONNECTION_ID,
      env: runtime.env,
      expectedIdempotencyKey: prepared.command.idempotencyKey,
      identity: { customerId: FAKE_CUSTOMER_ID, subjectHash: `fake-subject:${prepared.command.idempotencyKey}` },
      legacySourceChannel: "web",
      planEntitlements: FAKE_PLAN_ENTITLEMENTS,
      registry: FAKE_REGISTRY,
      shop: { ...runtime.fakeShop, currency },
    });
    const before = {
      attributions: runtime.database.database.prepare("SELECT COUNT(*) AS count FROM order_channel_attributions WHERE shop_id = ?").get(SHOP_ID),
      cart: runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID),
      events: runtime.database.database.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE shop_id = ?").get(SHOP_ID),
      fulfillments: runtime.database.database.prepare("SELECT COUNT(*) AS count FROM fulfillments WHERE shop_id = ?").get(SHOP_ID),
      inventory: runtime.database.database.prepare("SELECT status, reservation_token AS reservationToken FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid'").all(SHOP_ID),
      orders: runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID),
    };

    await expect(badApp.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({ code: "catalog_changed", status: 409 });

    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual(before.orders);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM order_channel_attributions WHERE shop_id = ?").get(SHOP_ID)).toEqual(before.attributions);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE shop_id = ?").get(SHOP_ID)).toEqual(before.events);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM fulfillments WHERE shop_id = ?").get(SHOP_ID)).toEqual(before.fulfillments);
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual(before.cart);
    expect(runtime.database.database.prepare("SELECT status, reservation_token AS reservationToken FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid'").all(SHOP_ID)).toEqual(before.inventory);
  });

  it("applies exact payment through the canonical event seam for Website, Telegram and fake orders", async () => {
    const runtime = createRuntime();
    const website = await prepareWebsiteCheckout(runtime, "variant-paid", "parity-payment-event-web-0001");
    const telegram = await prepareTelegramCheckout(runtime, "variant-paid", 2201);
    const fake = await prepareFakeCheckout(runtime, "variant-paid", "parity-payment-event-fake-0001");
    const checkouts = [
      { channelCode: "website", prepared: website },
      { channelCode: "telegram", prepared: telegram },
      { channelCode: FAKE_CHANNEL_CODE, prepared: fake },
    ] as const;

    for (const checkout of checkouts) {
      await checkout.prepared.app.checkoutCart(checkout.prepared.context, checkout.prepared.command);
    }

    runtime.database.database.exec(`
      INSERT INTO payment_integrations (
        id, public_id, webhook_public_id, shop_id, provider, status, webhook_status,
        created_at, updated_at
      ) VALUES (
        'integration-parity-payment', 'integration-public-parity-payment',
        'webhook-public-parity-payment', '${SHOP_ID}', 'payos', 'active', 'verified',
        '${NOW}', '${NOW}'
      );
      INSERT INTO payment_credentials (
        id, shop_id, integration_id, provider, status, version, key_version,
        client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
        api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
        credential_fingerprint, created_by_user_id, created_at
      ) VALUES (
        'credential-parity-payment', '${SHOP_ID}', 'integration-parity-payment',
        'payos', 'active', 1, 'v1', 'cipher', 'iv', 'cipher', 'iv', 'cipher',
        'iv', 'fingerprint-parity-payment', 'user-parity', '${NOW}'
      );
    `);

    const paymentRows: Array<{ attempt: CommercePaymentAttempt; eventId: string; orderId: string; channelCode: string }> = [];
    for (const [index, checkout] of checkouts.entries()) {
      const order = runtime.database.database.prepare("SELECT id, public_id AS publicId FROM orders WHERE shop_id = ? AND source_channel = ? ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ?").get(
        SHOP_ID,
        checkout.channelCode === "telegram" ? "telegram" : "web",
        checkout.channelCode === "telegram" ? 0 : checkout.channelCode === "website" ? 0 : 1,
      ) as { id: string; publicId: string } | undefined;
      if (order === undefined) throw new Error(`payment_event_order_missing:${checkout.channelCode}`);
      const attemptId = `attempt-parity-payment-${String(index)}`;
      const eventId = `event-parity-payment-${String(index)}`;
      runtime.database.database.prepare(`
        INSERT INTO payment_attempts (
          id, public_id, shop_id, order_id, integration_id, credential_id, provider,
          provider_order_code, state, expected_amount_minor, currency,
          expected_description, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'integration-parity-payment', 'credential-parity-payment',
          'payos', ?, 'pending', 9000, 'VND', 'Parity payment', ?, ?, ?)
      `).run(attemptId, `${attemptId}-public`, SHOP_ID, order.id, 88001 + index, "2026-07-30T06:00:00.000Z", NOW, NOW);
      runtime.database.database.prepare(`
        INSERT INTO payment_events (
          id, shop_id, payment_attempt_id, integration_id, provider,
          provider_event_reference, payload_hash, signature_verified,
          normalized_state, process_result, received_at, processing_token,
          processing_started_at
        ) VALUES (?, ?, ?, 'integration-parity-payment', 'payos', ?, ?, 1,
          'processing', 'processing', ?, ?, ?)
      `).run(eventId, SHOP_ID, attemptId, `reference-${eventId}`, `payload-${eventId}`, NOW, `claim-${eventId}`, NOW);
      paymentRows.push({
        attempt: { id: attemptId, integrationId: "integration-parity-payment", orderId: order.id, shopId: SHOP_ID, state: "pending" },
        channelCode: checkout.channelCode,
        eventId,
        orderId: order.publicId,
      });
    }

    for (const row of paymentRows) {
      await expect(applyCommercePaymentEvent({
        attempt: row.attempt,
        claimToken: `claim-${row.eventId}`,
        decision: "paid_exact",
        env: runtime.env,
        eventId: row.eventId,
        evidence: { amount: 9000, expectedAmount: 9000, occurredAt: NOW, reference: `reference-${row.eventId}` },
        integrationId: "integration-parity-payment",
      })).resolves.toEqual({ processed: true, state: "paid_exact" });

      expect(runtime.database.database.prepare(`
        SELECT status, payment_status AS paymentStatus, fulfillment_status AS fulfillmentStatus
        FROM orders WHERE shop_id = ? AND public_id = ?
      `).get(SHOP_ID, row.orderId)).toEqual({ fulfillmentStatus: "fulfilled", paymentStatus: "paid", status: "completed" });
      expect(runtime.database.database.prepare("SELECT state FROM payment_attempts WHERE id = ? AND shop_id = ?").get(row.attempt.id, SHOP_ID)).toEqual({ state: "paid_exact" });
      expect(runtime.database.database.prepare("SELECT normalized_state AS normalizedState, process_result AS processResult, processed_at AS processedAt FROM payment_events WHERE id = ? AND shop_id = ?").get(row.eventId, SHOP_ID)).toMatchObject({ normalizedState: "paid_exact", processResult: "fulfilled" });
      expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM fulfillment_items WHERE shop_id = ? AND fulfillment_id IN (SELECT id FROM fulfillments WHERE shop_id = ? AND order_id = (SELECT id FROM orders WHERE shop_id = ? AND public_id = ?))").get(SHOP_ID, SHOP_ID, SHOP_ID, row.orderId)).toEqual({ count: 1 });
    }

    expect(runtime.database.database.prepare("SELECT status, COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' GROUP BY status ORDER BY status").all(SHOP_ID)).toEqual([
      { status: "available", count: 1 },
      { status: "sold", count: 3 },
    ]);
    expect(runtime.database.database.prepare("SELECT channel_code AS channelCode, COUNT(*) AS count FROM order_channel_attributions WHERE shop_id = ? GROUP BY channel_code ORDER BY channel_code").all(SHOP_ID)).toEqual([
      { channelCode: FAKE_CHANNEL_CODE, count: 1 },
      { channelCode: "telegram", count: 1 },
      { channelCode: "website", count: 1 },
    ]);
  });

  it("commits fake discounted checkout totals and reservation state on real D1", async () => {
    const runtime = createRuntime();
    const prepared = await prepareFakeCheckout(runtime, "variant-paid", "parity-fake-discount-success-0001", "WELCOME15");
    const result = await checkoutAndReadOrder({ app: prepared.app, command: prepared.command, context: prepared.context });

    expect(prepared.quote).toMatchObject({ subtotalMinor: 9000, discountMinor: 1350, totalMinor: 7650 });
    expect(result.view).toMatchObject({ fulfillmentStatus: "reserved", paymentStatus: "unpaid", status: "pending_payment", totalMinor: 7650 });
    expect(runtime.database.database.prepare("SELECT subtotal_minor AS subtotalMinor, discount_minor AS discountMinor, total_minor AS totalMinor FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ subtotalMinor: 9000, discountMinor: 1350, totalMinor: 7650 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM fulfillments WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
  });

  it("preserves fake-channel quote discount evidence and rejects a same-key discount drift", async () => {
    const runtime = createRuntime();
    const prepared = await prepareFakeCheckout(runtime, "variant-paid", "parity-fake-discount-0001", "WELCOME15");
    expect(prepared.quote).toMatchObject({ discountMinor: 1350, totalMinor: 7650 });
    runtime.database.database.exec("UPDATE discounts SET value = value + 100, updated_at = '2026-07-29T00:01:00.000Z' WHERE shop_id = 'shop-parity' AND code_normalized = 'WELCOME15'");
    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({ status: 409 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
  });

  it("rejects a same-key fake replay after the canonical discount changes", async () => {
    const runtime = createRuntime();
    const prepared = await prepareFakeCheckout(runtime, "variant-paid", "parity-fake-discount-replay-0001", "WELCOME15");
    const first = await prepared.app.checkoutCart(prepared.context, prepared.command);
    runtime.database.database.exec("UPDATE discounts SET value = value + 100, updated_at = '2026-07-29T00:01:00.000Z' WHERE shop_id = 'shop-parity' AND code_normalized = 'WELCOME15'");
    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(first.orderId).toBeTruthy();
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
  });

  it("rejects a tampered fake quote and catalog drift before canonical writes", async () => {
    const runtime = createRuntime();
    const tampered = await prepareFakeCheckout(runtime, "variant-paid", "parity-fake-tamper-0001");
    if (tampered.command.quoteEvidence === undefined) throw new Error("fake_quote_evidence_missing");
    await expect(tampered.app.checkoutCart(tampered.context, { ...tampered.command, quoteEvidence: `${tampered.command.quoteEvidence}tampered` })).rejects.toMatchObject({ status: 409 });
    const stale = await prepareFakeCheckout(runtime, "variant-paid", "parity-fake-stale-0001");
    runtime.database.database.exec("UPDATE product_variants SET version = version + 1, price_minor = price_minor + 100 WHERE shop_id = 'shop-parity' AND id = 'variant-paid'");
    await expect(stale.app.checkoutCart(stale.context, stale.command)).rejects.toMatchObject({ status: 409 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
  });

  it("replays the durable fake-channel winner and binds replay to customer, connection and adapter version", async () => {
    const runtime = createRuntime();
    const prepared = await prepareFakeCheckout(runtime, "variant-paid", "parity-fake-replay-0001");
    const first = await prepared.app.checkoutCart(prepared.context, prepared.command);
    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).resolves.toEqual(first);
    await expect(prepared.app.checkoutCart(prepared.context, {
      ...prepared.command,
      expected: prepared.command.expected.map((item) => ({ ...item, quantity: item.quantity + 1 })),
    })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    runtime.database.database.exec(`
      INSERT INTO channel_connections (id, public_id, shop_id, shop_channel_id, provider_code, status, settings_json, version, connected_at, created_at, updated_at)
      VALUES ('connection-other-fake', 'public-connection-other-fake', '${SHOP_ID}', 'shop-channel-fake-parity', '${FAKE_CHANNEL_CODE}', 'active', '{}', 1, '${NOW}', '${NOW}', '${NOW}');
      INSERT INTO channel_connection_grants (shop_id, connection_id, capability_code, granted_at)
      SELECT '${SHOP_ID}', 'connection-other-fake', capability_code, '${NOW}'
      FROM channel_connection_grants WHERE shop_id = '${SHOP_ID}' AND connection_id = '${FAKE_CONNECTION_ID}';
    `);
    const wrongConnection = createPrincipalChannelCommerceApplication({
      adapterVersion: 1,
      channelCode: FAKE_CHANNEL_CODE,
      connectionId: "connection-other-fake",
      env: runtime.env,
      expectedIdempotencyKey: prepared.command.idempotencyKey,
      identity: { customerId: FAKE_CUSTOMER_ID, subjectHash: "fake-subject:parity-fake-replay-0001" },
      planEntitlements: FAKE_PLAN_ENTITLEMENTS,
      registry: FAKE_REGISTRY,
      shop: runtime.fakeShop,
    });
    const wrongConnectionContext = { ...prepared.context, channel: { code: FAKE_CHANNEL_CODE, connectionId: "connection-other-fake" } };
    await expect(wrongConnection.checkoutCart(wrongConnectionContext, prepared.command)).rejects.toMatchObject({ status: 404 });
    const wrongVersion = createPrincipalChannelCommerceApplication({
      adapterVersion: 2,
      channelCode: FAKE_CHANNEL_CODE,
      connectionId: FAKE_CONNECTION_ID,
      env: runtime.env,
      expectedIdempotencyKey: prepared.command.idempotencyKey,
      identity: { customerId: FAKE_CUSTOMER_ID, subjectHash: "fake-subject:parity-fake-replay-0001" },
      planEntitlements: FAKE_PLAN_ENTITLEMENTS,
      registry: FAKE_REGISTRY,
      shop: runtime.fakeShop,
    });
    await expect(wrongVersion.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({ code: "channel_adapter_version_conflict", status: 409 });
    const wrongCustomer = createPrincipalChannelCommerceApplication({
      adapterVersion: 1,
      channelCode: FAKE_CHANNEL_CODE,
      connectionId: FAKE_CONNECTION_ID,
      env: runtime.env,
      expectedIdempotencyKey: prepared.command.idempotencyKey,
      identity: { customerId: "customer-intruder", subjectHash: "fake-subject:parity-fake-replay-0001" },
      planEntitlements: FAKE_PLAN_ENTITLEMENTS,
      registry: FAKE_REGISTRY,
      shop: runtime.fakeShop,
    });
    const wrongContext = { ...prepared.context, actor: { customerId: "customer-intruder", kind: "customer" as const } };
    await expect(wrongCustomer.checkoutCart(wrongContext, prepared.command)).rejects.toSatisfy((error: unknown) => isAppError(error) && [404, 409].includes(error.status));
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
  });

  it("allows exactly one fake-channel winner for the last stock item", async () => {
    const runtime = createRuntime();
    const prepared = await prepareFakeCheckout(runtime, "variant-last", "parity-fake-last-0001");
    const website = await prepareWebsiteCheckout(runtime, "variant-last", "parity-fake-last-web-0001");
    const results = await Promise.allSettled([
      prepared.app.checkoutCart(prepared.context, prepared.command),
      website.app.checkoutCart(website.context, website.command),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "inventory_unavailable", status: 409 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-last' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM fulfillments WHERE shop_id = ? AND order_id IN (SELECT id FROM orders WHERE shop_id = ?)").get(SHOP_ID, SHOP_ID)).toEqual({ count: 0 });
  });

  it("keeps fake principal cart increments tenant- and connection-scoped", async () => {
    const runtime = createRuntime();
    const prepared = await prepareFakeCheckout(runtime, "variant-paid", "parity-fake-increment-0001");
    const mutation = (key: string) => prepared.app.mutateCart(prepared.context, {
      cart: { access: { kind: "principal" }, cartId: null },
      idempotencyKey: key,
      mutation: { kind: "item.increment", quantity: 1, variantId: "variant-paid" },
    });
    await expect(Promise.all([mutation("fake-increment-a-0001"), mutation("fake-increment-b-0001")])).resolves.toHaveLength(2);
    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE cart_id = ? AND shop_id = ? AND variant_id = ?").get(prepared.command.cart.cartId, SHOP_ID, "variant-paid")).toEqual({ quantity: 3 });
    const wrongTenantContext = { ...prepared.context, shopId: "shop-other" };
    await expect(prepared.app.mutateCart(wrongTenantContext, {
      cart: { access: { kind: "principal" }, cartId: null },
      idempotencyKey: "fake-increment-tenant-0001",
      mutation: { kind: "item.increment", quantity: 1, variantId: "variant-paid" },
    })).rejects.toMatchObject({ status: 403 });
  });

  it("fails fake commerce closed when plan, policy, or parent-channel capability admission is missing", async () => {
    const runtime = createRuntime();
    const context: CommerceContext = {
      actor: { customerId: FAKE_CUSTOMER_ID, kind: "customer" },
      channel: { code: FAKE_CHANNEL_CODE, connectionId: FAKE_CONNECTION_ID },
      locale: "vi",
      requestId: "fake-capability-admission-0001",
      shopId: SHOP_ID,
    };
    const missingCartEntitlement = createPrincipalChannelCommerceApplication({
      adapterVersion: 1,
      channelCode: FAKE_CHANNEL_CODE,
      connectionId: FAKE_CONNECTION_ID,
      env: runtime.env,
      identity: { customerId: FAKE_CUSTOMER_ID, subjectHash: "fake-subject:capability-admission" },
      planEntitlements: new Set(["catalog.read", "checkout.external_link", "orders.status_push"]),
      registry: FAKE_REGISTRY,
      shop: runtime.fakeShop,
    });
    await expect(missingCartEntitlement.createCart(context, { items: [{ quantity: 1, variantId: "variant-paid" }] }))
      .rejects.toMatchObject({ code: "channel_capability_unavailable", status: 403 });

    const prepared = await prepareFakeCheckout(runtime, "variant-paid", "parity-fake-policy-block-0001");
    const blockedCheckout = createPrincipalChannelCommerceApplication({
      adapterVersion: 1,
      channelCode: FAKE_CHANNEL_CODE,
      connectionId: FAKE_CONNECTION_ID,
      env: runtime.env,
      expectedIdempotencyKey: prepared.command.idempotencyKey,
      identity: { customerId: FAKE_CUSTOMER_ID, subjectHash: "fake-subject:parity-fake-policy-block-0001" },
      planEntitlements: FAKE_PLAN_ENTITLEMENTS,
      policyBlockedCapabilities: new Set(["checkout.external_link"]),
      registry: FAKE_REGISTRY,
      shop: runtime.fakeShop,
    });
    await expect(blockedCheckout.checkoutCart(prepared.context, prepared.command))
      .rejects.toMatchObject({ code: "channel_capability_unavailable", status: 403 });

    runtime.database.database.prepare("UPDATE shop_channels SET status = 'disabled', updated_at = ? WHERE id = ? AND shop_id = ?")
      .run("2026-07-29T00:02:00.000Z", "shop-channel-fake-parity", SHOP_ID);
    const disabledChannelCheckout = createPrincipalChannelCommerceApplication({
      adapterVersion: 1,
      channelCode: FAKE_CHANNEL_CODE,
      connectionId: FAKE_CONNECTION_ID,
      env: runtime.env,
      expectedIdempotencyKey: prepared.command.idempotencyKey,
      identity: { customerId: FAKE_CUSTOMER_ID, subjectHash: "fake-subject:parity-fake-policy-block-0001" },
      planEntitlements: FAKE_PLAN_ENTITLEMENTS,
      registry: FAKE_REGISTRY,
      shop: runtime.fakeShop,
    });
    await expect(disabledChannelCheckout.checkoutCart(prepared.context, prepared.command))
      .rejects.toMatchObject({ code: "channel_capability_unavailable", status: 403 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
  });

  it("rolls back the fake-channel canonical transaction without adapter-owned writes", async () => {
    const runtime = createRuntime();
    const prepared = await prepareFakeCheckout(runtime, "variant-paid", "parity-fake-rollback-0001");
    runtime.database.failNextBatchOn("INSERT INTO orders");
    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({ code: "checkout_failed", status: 409 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });
    expect(JSON.stringify(prepared.adapter.transcript)).not.toMatch(/INSERT|UPDATE|DELETE|license-plaintext/iu);
  });

  it("atomically accumulates concurrent Telegram increments with distinct idempotency keys", async () => {
    const runtime = createRuntime();
    const identity = { customerId: TELEGRAM_CUSTOMER_ID, subjectHash: "telegram-subject-concurrent-cart" };
    const mutation = async (updateId: number) => {
      const key = await createTelegramCartMutationApplicationKey(runtime.env, SHOP_ID, INTEGRATION_ID, updateId);
      const context: CommerceContext = { actor: { customerId: identity.customerId, kind: "customer" }, channel: { code: "telegram", connectionId: null }, locale: "vi", requestId: key, shopId: SHOP_ID };
      const app = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: key, identity, integrationId: INTEGRATION_ID, shop: runtime.telegramShop, updateId }));
      return app.mutateCart(context, { cart: { access: { kind: "principal" }, cartId: null }, idempotencyKey: key, mutation: { kind: "item.increment", quantity: 1, variantId: "variant-paid" } });
    };
    const initial = await mutation(1100);
    const gate = runtime.database.pauseNextBatch();
    const first = mutation(1101);
    await gate.reached;
    const second = await mutation(1102);
    gate.resume();

    await expect(first).resolves.toMatchObject({ replayed: false });
    expect(second).toMatchObject({ replayed: false, cart: initial.cart });
    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE cart_id = ? AND shop_id = ? AND variant_id = ?").get(initial.cart.cartId, SHOP_ID, "variant-paid")).toEqual({ quantity: 3 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM telegram_actions WHERE shop_id = ? AND integration_id = ? AND update_id IN (?, ?, ?)").get(SHOP_ID, INTEGRATION_ID, 1100, 1101, 1102)).toEqual({ count: 3 });
  });

  it("rejects a Telegram checkout when a cart increment commits before the guarded order batch", async () => {
    const runtime = createRuntime();
    const prepared = await prepareTelegramCheckout(runtime, "variant-paid", 1103);
    const gate = runtime.database.pauseNextBatch();
    const checkout = prepared.app.checkoutCart(prepared.context, prepared.command);
    await gate.reached;

    const identity = { customerId: TELEGRAM_CUSTOMER_ID, subjectHash: "telegram-subject-1103" };
    const addKey = await createTelegramCartMutationApplicationKey(runtime.env, SHOP_ID, INTEGRATION_ID, 1104);
    const addContext: CommerceContext = { actor: { customerId: identity.customerId, kind: "customer" }, channel: { code: "telegram", connectionId: null }, locale: "vi", requestId: addKey, shopId: SHOP_ID };
    const addApplication = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: addKey, identity, integrationId: INTEGRATION_ID, shop: runtime.telegramShop, updateId: 1104 }));
    await addApplication.mutateCart(addContext, { cart: { access: { kind: "principal" }, cartId: null }, idempotencyKey: addKey, mutation: { kind: "item.increment", quantity: 1, variantId: "variant-paid" } });
    gate.resume();

    await expect(checkout).rejects.toMatchObject({ code: "checkout_changed", status: 409 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
    expect(runtime.database.database.prepare("SELECT quantity FROM cart_items WHERE cart_id = ? AND shop_id = ? AND variant_id = ?").get(prepared.command.cart.cartId, SHOP_ID, "variant-paid")).toEqual({ quantity: 2 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });
  });

  it("matches free checkout outcomes and durable fulfillment across Website and Telegram", async () => {
    const runtime = createRuntime();
    const website = await prepareWebsiteCheckout(runtime, "variant-free", "parity-free-web-0001");
    const telegram = await prepareTelegramCheckout(runtime, "variant-free", 1001);
    const websiteResult = await checkoutAndReadOrder({ app: website.app, command: website.command, context: website.context });
    const telegramResult = await checkoutAndReadOrder({ app: telegram.app, command: telegram.command, context: telegram.context });

    expect(websiteResult.view).toMatchObject({ fulfillmentStatus: "fulfilled", paymentStatus: "paid", status: "completed", totalMinor: 0 });
    expect(telegramResult.view).toMatchObject({ fulfillmentStatus: "fulfilled", paymentStatus: "paid", status: "completed", totalMinor: 0 });
    expect(websiteResult.order).toMatchObject({ fulfillmentStatus: "fulfilled", paymentStatus: "paid", status: "completed", totalMinor: 0 });
    expect(telegramResult.order).toMatchObject({ fulfillmentStatus: "fulfilled", paymentStatus: "paid", status: "completed", totalMinor: 0 });
    expect(websiteResult.order.items).toEqual(telegramResult.order.items);
    expect(runtime.database.database.prepare("SELECT source_channel AS sourceChannel, status, payment_status AS paymentStatus, fulfillment_status AS fulfillmentStatus FROM orders WHERE shop_id = ? ORDER BY source_channel").all(SHOP_ID)).toEqual([
      { sourceChannel: "telegram", status: "completed", paymentStatus: "paid", fulfillmentStatus: "fulfilled" },
      { sourceChannel: "web", status: "completed", paymentStatus: "paid", fulfillmentStatus: "fulfilled" },
    ]);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM fulfillment_items WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 2 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-free' AND status = 'sold'").get(SHOP_ID)).toEqual({ count: 2 });
  });

  it("matches paid checkout reservation outcomes across Website and Telegram", async () => {
    const runtime = createRuntime();
    const website = await prepareWebsiteCheckout(runtime, "variant-paid", "parity-paid-web-0001");
    const telegram = await prepareTelegramCheckout(runtime, "variant-paid", 1002);
    const websiteResult = await checkoutAndReadOrder({ app: website.app, command: website.command, context: website.context });
    const telegramResult = await checkoutAndReadOrder({ app: telegram.app, command: telegram.command, context: telegram.context });

    expect(websiteResult.view).toMatchObject({ fulfillmentStatus: "reserved", paymentStatus: "unpaid", status: "pending_payment", totalMinor: 9000 });
    expect(telegramResult.view).toMatchObject({ fulfillmentStatus: "reserved", paymentStatus: "unpaid", status: "pending_payment", totalMinor: 9000 });
    expect(websiteResult.order.items).toEqual(telegramResult.order.items);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM fulfillments WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 2 });
  });

  it("keeps free generated-license checkout outcomes and provider contracts equivalent across Website, Telegram and fake", async () => {
    const runtime = createRuntime();
    const website = await prepareWebsiteCheckout(runtime, "variant-generated-free", "parity-generated-free-web-0001");
    const telegram = await prepareTelegramCheckout(runtime, "variant-generated-free", 4101);
    const fake = await prepareFakeCheckout(runtime, "variant-generated-free", "parity-generated-free-fake-0001");
    const checkouts = [website, telegram, fake] as const;
    const results = [];
    for (const prepared of checkouts) {
      results.push(await checkoutAndReadOrder({ app: prepared.app, command: prepared.command, context: prepared.context }));
    }

    for (const result of results) {
      expect(result.view).toMatchObject({ fulfillmentStatus: "unfulfilled", paymentStatus: "paid", status: "processing", totalMinor: 0 });
      expect(result.order).toMatchObject({ fulfillmentStatus: "unfulfilled", paymentStatus: "paid", status: "processing", totalMinor: 0 });
      expect(result.order.items).toEqual(results[0]?.order.items);
    }
    expect(runtime.database.database.prepare(`
      SELECT attribution.channel_code AS channelCode,
        attribution.adapter_version AS adapterVersion,
        attribution.connection_id AS connectionId,
        orders.status, orders.payment_status AS paymentStatus,
        orders.fulfillment_status AS fulfillmentStatus
      FROM orders
      INNER JOIN order_channel_attributions AS attribution
        ON attribution.order_id = orders.id AND attribution.shop_id = orders.shop_id
      WHERE orders.shop_id = ?
      ORDER BY attribution.channel_code
    `).all(SHOP_ID)).toEqual([
      { adapterVersion: 1, channelCode: FAKE_CHANNEL_CODE, connectionId: FAKE_CONNECTION_ID, fulfillmentStatus: "unfulfilled", paymentStatus: "paid", status: "processing" },
      { adapterVersion: 1, channelCode: "telegram", connectionId: null, fulfillmentStatus: "unfulfilled", paymentStatus: "paid", status: "processing" },
      { adapterVersion: 1, channelCode: "website", connectionId: null, fulfillmentStatus: "unfulfilled", paymentStatus: "paid", status: "processing" },
    ]);
    expect(runtime.database.database.prepare(`
      SELECT attribution.channel_code AS channelCode,
        request.status, request.provider_code AS providerCode,
        request.connection_id AS providerConnectionId,
        request.credential_version AS credentialVersion,
        request.unit_ordinal AS unitOrdinal,
        resource.resource_key AS resourceKey,
        length(request.provider_idempotency_key_hash) AS idempotencyHashLength,
        length(request.request_hash) AS requestHashLength
      FROM generated_license_requests AS request
      INNER JOIN orders ON orders.id = request.order_id AND orders.shop_id = request.shop_id
      INNER JOIN order_channel_attributions AS attribution
        ON attribution.order_id = orders.id AND attribution.shop_id = orders.shop_id
      INNER JOIN entitlement_resources AS resource
        ON resource.id = request.resource_id AND resource.shop_id = request.shop_id
      WHERE request.shop_id = ?
      ORDER BY attribution.channel_code
    `).all(SHOP_ID)).toEqual([
      { channelCode: FAKE_CHANNEL_CODE, credentialVersion: 1, idempotencyHashLength: 43, providerCode: "fake.license", providerConnectionId: "connection-generated-parity", requestHashLength: 43, resourceKey: "generated.parity.free", status: "pending", unitOrdinal: 1 },
      { channelCode: "telegram", credentialVersion: 1, idempotencyHashLength: 43, providerCode: "fake.license", providerConnectionId: "connection-generated-parity", requestHashLength: 43, resourceKey: "generated.parity.free", status: "pending", unitOrdinal: 1 },
      { channelCode: "website", credentialVersion: 1, idempotencyHashLength: 43, providerCode: "fake.license", providerConnectionId: "connection-generated-parity", requestHashLength: 43, resourceKey: "generated.parity.free", status: "pending", unitOrdinal: 1 },
    ]);
    const requestColumns = (runtime.database.database.prepare("PRAGMA table_info(generated_license_requests)").all() as Array<{ name: string }>).map((column) => column.name);
    expect(requestColumns).not.toContain("channel_code");
    expect(requestColumns).not.toContain("source_channel");
    expect(requestColumns).not.toContain("adapter_version");
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM fulfillments WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
  });

  it("creates paid generated-license requests only after exact payment across Website, Telegram and fake", async () => {
    const runtime = createRuntime();
    const website = await prepareWebsiteCheckout(runtime, "variant-generated-paid", "parity-generated-paid-web-0001");
    const telegram = await prepareTelegramCheckout(runtime, "variant-generated-paid", 4102);
    const fake = await prepareFakeCheckout(runtime, "variant-generated-paid", "parity-generated-paid-fake-0001");
    const checkouts = [website, telegram, fake] as const;
    const checkoutViews: CommerceCheckoutView[] = [];
    for (const prepared of checkouts) {
      const view = await prepared.app.checkoutCart(prepared.context, prepared.command);
      expect(view).toMatchObject({ fulfillmentStatus: "reserved", paymentStatus: "unpaid", status: "pending_payment", totalMinor: 11000 });
      checkoutViews.push(view);
    }

    expect(runtime.database.database.prepare("SELECT status, COUNT(*) AS count FROM entitlements WHERE shop_id = ? GROUP BY status").all(SHOP_ID)).toEqual([{ count: 3, status: "pending" }]);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM generated_license_requirement_snapshots WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 3 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM entitlement_grants WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM generated_license_requests WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });

    runtime.database.database.exec(`
      INSERT INTO payment_integrations (
        id, public_id, webhook_public_id, shop_id, provider, status, webhook_status,
        created_at, updated_at
      ) VALUES (
        'integration-generated-parity-payment', 'integration-public-generated-parity-payment',
        'webhook-public-generated-parity-payment', '${SHOP_ID}', 'payos', 'active', 'verified',
        '${NOW}', '${NOW}'
      );
      INSERT INTO payment_credentials (
        id, shop_id, integration_id, provider, status, version, key_version,
        client_id_ciphertext_b64, client_id_iv_b64, api_key_ciphertext_b64,
        api_key_iv_b64, checksum_key_ciphertext_b64, checksum_key_iv_b64,
        credential_fingerprint, created_by_user_id, created_at
      ) VALUES (
        'credential-generated-parity-payment', '${SHOP_ID}', 'integration-generated-parity-payment',
        'payos', 'active', 1, 'v1', 'cipher', 'iv', 'cipher', 'iv', 'cipher',
        'iv', 'fingerprint-generated-parity-payment', 'user-parity', '${NOW}'
      );
    `);
    for (const [index, view] of checkoutViews.entries()) {
      const order = runtime.database.database.prepare("SELECT id FROM orders WHERE public_id = ? AND shop_id = ?").get(view.orderId, SHOP_ID) as { id: string } | undefined;
      if (order === undefined) throw new Error("generated_paid_order_missing");
      const attemptId = `attempt-generated-parity-${String(index)}`;
      const eventId = `event-generated-parity-${String(index)}`;
      runtime.database.database.prepare(`
        INSERT INTO payment_attempts (
          id, public_id, shop_id, order_id, integration_id, credential_id, provider,
          provider_order_code, state, expected_amount_minor, currency,
          expected_description, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'integration-generated-parity-payment',
          'credential-generated-parity-payment', 'payos', ?, 'pending', 11000,
          'VND', 'Generated parity payment', ?, ?, ?)
      `).run(attemptId, `${attemptId}-public`, SHOP_ID, order.id, 99001 + index, "2026-07-30T06:00:00.000Z", NOW, NOW);
      runtime.database.database.prepare(`
        INSERT INTO payment_events (
          id, shop_id, payment_attempt_id, integration_id, provider,
          provider_event_reference, payload_hash, signature_verified,
          normalized_state, process_result, received_at, processing_token,
          processing_started_at
        ) VALUES (?, ?, ?, 'integration-generated-parity-payment', 'payos', ?, ?, 1,
          'processing', 'processing', ?, ?, ?)
      `).run(eventId, SHOP_ID, attemptId, `reference-${eventId}`, `payload-${eventId}`, NOW, `claim-${eventId}`, NOW);
      await expect(applyCommercePaymentEvent({
        attempt: { id: attemptId, integrationId: "integration-generated-parity-payment", orderId: order.id, shopId: SHOP_ID, state: "pending" },
        claimToken: `claim-${eventId}`,
        decision: "paid_exact",
        env: runtime.env,
        eventId,
        evidence: { amount: 11000, expectedAmount: 11000, occurredAt: NOW, reference: `reference-${eventId}` },
        integrationId: "integration-generated-parity-payment",
      })).resolves.toEqual({ processed: true, state: "paid_exact" });
    }

    expect(runtime.database.database.prepare(`
      SELECT attribution.channel_code AS channelCode, orders.status,
        orders.payment_status AS paymentStatus,
        orders.fulfillment_status AS fulfillmentStatus,
        entitlement.status AS entitlementStatus,
        grant_row.source_kind AS grantSource,
        request.status AS requestStatus
      FROM orders
      INNER JOIN order_channel_attributions AS attribution
        ON attribution.order_id = orders.id AND attribution.shop_id = orders.shop_id
      INNER JOIN entitlements AS entitlement
        ON entitlement.order_id = orders.id AND entitlement.shop_id = orders.shop_id
      INNER JOIN entitlement_grants AS grant_row
        ON grant_row.entitlement_id = entitlement.id AND grant_row.shop_id = entitlement.shop_id
      INNER JOIN generated_license_requests AS request
        ON request.entitlement_grant_id = grant_row.id AND request.shop_id = grant_row.shop_id
      WHERE orders.shop_id = ?
      ORDER BY attribution.channel_code
    `).all(SHOP_ID)).toEqual([
      { channelCode: FAKE_CHANNEL_CODE, entitlementStatus: "active", fulfillmentStatus: "unfulfilled", grantSource: "payment_exact", paymentStatus: "paid", requestStatus: "pending", status: "processing" },
      { channelCode: "telegram", entitlementStatus: "active", fulfillmentStatus: "unfulfilled", grantSource: "payment_exact", paymentStatus: "paid", requestStatus: "pending", status: "processing" },
      { channelCode: "website", entitlementStatus: "active", fulfillmentStatus: "unfulfilled", grantSource: "payment_exact", paymentStatus: "paid", requestStatus: "pending", status: "processing" },
    ]);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM fulfillments WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
  });

  it.each(["website", "telegram", "fake"] as const)("replays one generated-license request and rejects changed same-key %s checkout", async (channel) => {
    const runtime = createRuntime();
    if (channel === "website") {
      const prepared = await prepareWebsiteCheckout(runtime, "variant-generated-free", "parity-generated-replay-web-0001");
      const first = await prepared.app.checkoutCart(prepared.context, prepared.command);
      await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).resolves.toEqual(first);
      await expect(prepared.app.checkoutCart(prepared.context, { ...prepared.command, customerEmail: "generated-conflict@example.test" })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    } else if (channel === "telegram") {
      const updateId = 4103;
      const prepared = await prepareTelegramCheckout(runtime, "variant-generated-free", updateId);
      const first = await prepared.app.checkoutCart(prepared.context, prepared.command);
      await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).resolves.toEqual(first);
      const changedSnapshot = { ...prepared.snapshot, lines: prepared.snapshot.lines.map((line) => ({ ...line, quantity: line.quantity + 1 })) };
      const changedApp = createTelegramCheckoutApplication({
        connectionId: null,
        env: runtime.env,
        expectedIdempotencyKey: prepared.command.idempotencyKey,
        identity: { customerId: TELEGRAM_CUSTOMER_ID, integrationId: INTEGRATION_ID, subjectHash: `telegram-subject-${String(updateId)}` },
        requestedSnapshot: changedSnapshot,
        shop: runtime.telegramShop,
        updateId,
      });
      await expect(changedApp.checkoutCart(prepared.context, { ...prepared.command, expected: expectedSnapshot(changedSnapshot) })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    } else {
      const prepared = await prepareFakeCheckout(runtime, "variant-generated-free", "parity-generated-replay-fake-0001");
      const first = await prepared.app.checkoutCart(prepared.context, prepared.command);
      await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).resolves.toEqual(first);
      const changedExpected = prepared.command.expected.map((item) => ({ ...item, quantity: item.quantity + 1 }));
      await expect(prepared.app.checkoutCart(prepared.context, { ...prepared.command, expected: changedExpected })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    }
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM entitlement_grants WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM generated_license_requests WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
  });

  it.each(["website", "telegram", "fake"] as const)("fails closed on cross-tenant generated-license %s checkout", async (channel) => {
    const runtime = createRuntime();
    const otherShopId = "shop-generated-other";
    let cartId: string;
    let rejection: unknown = null;
    if (channel === "website") {
      const prepared = await prepareWebsiteCheckout(runtime, "variant-generated-free", "parity-generated-tenant-web-0001");
      cartId = prepared.command.cart.cartId;
      try {
        await createWebsiteCommerceApplication(runtime.env, { ...runtime.shop, id: otherShopId, publicId: "shop-public-generated-other", slug: "generated-other" }).checkoutCart(
          { ...prepared.context, requestId: "request-generated-tenant-web", shopId: otherShopId },
          prepared.command,
        );
      } catch (error: unknown) {
        rejection = error;
      }
    } else if (channel === "telegram") {
      const updateId = 4104;
      const prepared = await prepareTelegramCheckout(runtime, "variant-generated-free", updateId);
      cartId = prepared.command.cart.cartId;
      const context: CommerceContext = { ...prepared.context, actor: { customerId: "customer-generated-other", kind: "customer" }, requestId: "request-generated-tenant-telegram", shopId: otherShopId };
      const app = createTelegramCheckoutApplication({
        connectionId: null,
        env: runtime.env,
        expectedIdempotencyKey: prepared.command.idempotencyKey,
        identity: { customerId: "customer-generated-other", integrationId: INTEGRATION_ID, subjectHash: "telegram-generated-other-subject" },
        requestedSnapshot: prepared.snapshot,
        shop: { ...runtime.telegramShop, id: otherShopId },
        updateId,
      });
      try {
        await app.checkoutCart(context, prepared.command);
      } catch (error: unknown) {
        rejection = error;
      }
    } else {
      const prepared = await prepareFakeCheckout(runtime, "variant-generated-free", "parity-generated-tenant-fake-0001");
      cartId = prepared.command.cart.cartId;
      const context: CommerceContext = { ...prepared.context, actor: { customerId: "customer-generated-other", kind: "customer" }, requestId: "request-generated-tenant-fake", shopId: otherShopId };
      const app = createPrincipalChannelCommerceApplication({
        adapterVersion: prepared.adapter.manifest.version,
        channelCode: prepared.adapter.manifest.code,
        connectionId: FAKE_CONNECTION_ID,
        env: runtime.env,
        expectedIdempotencyKey: prepared.command.idempotencyKey,
        identity: { customerId: "customer-generated-other", subjectHash: "fake-generated-other-subject" },
        legacySourceChannel: "web",
        planEntitlements: FAKE_PLAN_ENTITLEMENTS,
        registry: FAKE_REGISTRY,
        shop: { ...runtime.fakeShop, id: otherShopId },
      });
      try {
        await app.checkoutCart(context, prepared.command);
      } catch (error: unknown) {
        rejection = error;
      }
    }

    expect(isAppError(rejection)).toBe(true);
    if (!isAppError(rejection)) throw new Error("generated_cross_tenant_checkout_did_not_fail_closed");
    expect([403, 404, 409]).toContain(rejection.status);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM generated_license_requirement_snapshots WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM generated_license_requests WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(cartId, SHOP_ID)).toEqual({ state: "active" });
  });

  it.each(["website", "fake"] as const)("captures the private-file requirement in the canonical %s checkout", async (channel) => {
    const runtime = createRuntime();
    const prepared = channel === "website"
      ? await prepareWebsiteCheckout(runtime, "variant-private-free", `parity-private-${channel}-0001`)
      : await prepareFakeCheckout(runtime, "variant-private-free", `parity-private-${channel}-0001`);
    const first = await checkoutAndReadOrder({ app: prepared.app, command: prepared.command, context: prepared.context });
    const order = runtime.database.database.prepare("SELECT id FROM orders WHERE public_id = ? AND shop_id = ?").get(first.view.orderId, SHOP_ID) as { id: string } | undefined;
    expect(order).toBeDefined();
    if (order === undefined) throw new Error("private_checkout_order_missing");
    expect(runtime.database.database.prepare(`
      SELECT capability, policy_id AS policyId, policy_version AS policyVersion,
        asset_version_id AS assetVersionId, max_downloads AS maxDownloads,
        grant_ttl_seconds AS grantTtlSeconds, entitlement_ttl_seconds AS entitlementTtlSeconds
      FROM order_item_fulfillment_requirements
      WHERE shop_id = ? AND order_id = ?
    `).all(SHOP_ID, order.id)).toEqual([{
      assetVersionId: "asset-version-private-parity",
      capability: "private_file",
      entitlementTtlSeconds: 3600,
      grantTtlSeconds: 600,
      maxDownloads: 3,
      policyId: "policy-private-parity-v1",
      policyVersion: 1,
    }]);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM digital_entitlements WHERE shop_id = ? AND order_id = ?").get(SHOP_ID, order.id)).toEqual({ count: 0 });

    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).resolves.toEqual(first.view);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM order_item_fulfillment_requirements WHERE shop_id = ? AND order_id = ?").get(SHOP_ID, order.id)).toEqual({ count: 1 });
  });

  it("rejects Telegram private-file checkout before creating an order", async () => {
    const runtime = createRuntime();
    const prepared = await prepareTelegramCheckout(runtime, "variant-private-free", 3011);

    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({
      code: "telegram_private_file_unsupported",
      status: 409,
    });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
  });

  it("preserves the checkout-time private-file policy when the seller publishes a replacement", async () => {
    const runtime = createRuntime();
    const prepared = await prepareWebsiteCheckout(runtime, "variant-private-free", "parity-private-policy-drift-0001");
    const checkedOut = await checkoutAndReadOrder({ app: prepared.app, command: prepared.command, context: prepared.context });
    const order = runtime.database.database.prepare("SELECT id FROM orders WHERE public_id = ? AND shop_id = ?").get(checkedOut.view.orderId, SHOP_ID) as { id: string } | undefined;
    if (order === undefined || checkedOut.view.access.kind !== "opaque_token") throw new Error("private_policy_drift_order_missing");

    runtime.database.database.prepare("UPDATE product_fulfillment_policies SET status = 'retired', retired_at = ?, updated_at = ? WHERE shop_id = ? AND id = ?").run(NOW, NOW, SHOP_ID, "policy-private-parity-v1");
    runtime.database.database.prepare(`
      INSERT INTO digital_asset_versions (
        id, shop_id, asset_id, version, object_key, filename_sanitized,
        content_type, byte_size, content_sha256, object_etag, status,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, 2, ?, 'Parity Guide v2.pdf', 'application/pdf', 256, ?, ?, 'active', 'user-parity', ?, ?)
    `).run(
      "asset-version-private-parity-v2", SHOP_ID, "asset-private-parity",
      "private-digital-assets/shop-parity/asset-private-parity-v2",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "etag-private-parity-v2", NOW, NOW,
    );
    runtime.database.database.prepare(`
      INSERT INTO product_fulfillment_policies (
        id, shop_id, product_id, capability, policy_version, asset_version_id,
        max_downloads, grant_ttl_seconds, entitlement_ttl_seconds, status,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'private_file', 2, ?, 1, 300, NULL, 'active', 'user-parity', ?, ?)
    `).run("policy-private-parity-v2", SHOP_ID, "product-private", "asset-version-private-parity-v2", NOW, NOW);

    expect(runtime.database.database.prepare(`
      SELECT policy_id AS policyId, policy_version AS policyVersion,
        asset_version_id AS assetVersionId, max_downloads AS maxDownloads
      FROM order_item_fulfillment_requirements WHERE shop_id = ? AND order_id = ?
    `).get(SHOP_ID, order.id)).toEqual({ assetVersionId: "asset-version-private-parity", maxDownloads: 3, policyId: "policy-private-parity-v1", policyVersion: 1 });
    await expect(prepared.app.listPrivateDownloads(prepared.context, { order: { access: checkedOut.view.access, orderId: checkedOut.view.orderId } })).resolves.toEqual([
      expect.objectContaining({ assetVersionId: "asset-version-private-parity", filename: "Parity Guide.pdf", maxDownloads: 3 }),
    ]);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM digital_entitlements WHERE shop_id = ? AND order_id = ?").get(SHOP_ID, order.id)).toEqual({ count: 0 });
  });

  it("rolls back private-file checkout when the policy changes before the guarded order batch", async () => {
    const runtime = createRuntime();
    const prepared = await prepareWebsiteCheckout(runtime, "variant-private-free", "parity-private-policy-race-0001");
    const gate = runtime.database.pauseNextBatch();
    const checkout = prepared.app.checkoutCart(prepared.context, prepared.command);
    await gate.reached;

    runtime.database.database.prepare("UPDATE product_fulfillment_policies SET status = 'retired', retired_at = ?, updated_at = ? WHERE shop_id = ? AND id = ?").run(NOW, NOW, SHOP_ID, "policy-private-parity-v1");
    runtime.database.database.prepare(`
      INSERT INTO product_fulfillment_policies (
        id, shop_id, product_id, capability, policy_version, asset_version_id,
        max_downloads, grant_ttl_seconds, entitlement_ttl_seconds, status,
        created_by_user_id, created_at, updated_at
      ) VALUES ('policy-private-parity-race-v2', ?, 'product-private', 'private_file', 2, 'asset-version-private-parity', 2, 600, 3600, 'active', 'user-parity', ?, ?)
    `).run(SHOP_ID, NOW, NOW);
    gate.resume();

    await expect(checkout).rejects.toMatchObject({ status: 409 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM order_item_fulfillment_requirements WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
  });

  it("matches discounted quote and checkout outcomes across Website and Telegram", async () => {
    const runtime = createRuntime();
    const quantity = 2;
    const discountCode = "WELCOME15";

    const websiteContext: CommerceContext = { actor: { kind: "anonymous" }, channel: { code: "website", connectionId: null }, locale: "vi", requestId: "request-parity-discount-web", shopId: SHOP_ID };
    const websiteApp = createWebsiteCommerceApplication(runtime.env, runtime.shop);
    const websiteCart = await websiteApp.createCart(websiteContext, { items: [{ quantity, variantId: "variant-paid" }] });
    if (websiteCart.access.kind !== "opaque_token") throw new Error("website_discount_cart_access_invalid");
    const websiteCartTarget = { access: websiteCart.access, cartId: websiteCart.cartId };
    const websiteDiscountKey = "parity-discount-web-mutation-0001";
    await websiteApp.mutateCart(
      { ...websiteContext, requestId: `request-${websiteDiscountKey}` },
      { cart: websiteCartTarget, idempotencyKey: websiteDiscountKey, mutation: { code: discountCode, kind: "discount.apply" } },
    );
    const websiteQuote = await websiteApp.quoteCart(websiteContext, { cart: websiteCartTarget });
    if (websiteQuote.quoteEvidence === undefined) throw new Error("website_discount_quote_evidence_missing");
    const websiteCommand: CommerceCheckoutCommand = {
      cart: websiteCartTarget,
      customerEmail: "website-discount-parity@example.test",
      expected: expectedItems(websiteQuote),
      idempotencyKey: "parity-discount-web-checkout-0001",
      quoteEvidence: websiteQuote.quoteEvidence,
    };

    const telegramIdentity = { customerId: TELEGRAM_CUSTOMER_ID, subjectHash: "telegram-subject-discount-parity" };
    const telegramAddKey = await createTelegramCartMutationApplicationKey(runtime.env, SHOP_ID, INTEGRATION_ID, 1020);
    const telegramAddContext: CommerceContext = { actor: { customerId: telegramIdentity.customerId, kind: "customer" }, channel: { code: "telegram", connectionId: null }, locale: "vi", requestId: telegramAddKey, shopId: SHOP_ID };
    const telegramAddApp = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: telegramAddKey, identity: telegramIdentity, integrationId: INTEGRATION_ID, shop: runtime.telegramShop, updateId: 1020 }));
    await telegramAddApp.mutateCart(telegramAddContext, { cart: { access: { kind: "principal" }, cartId: null }, idempotencyKey: telegramAddKey, mutation: { kind: "item.increment", quantity, variantId: "variant-paid" } });
    const telegramDiscountKey = await createTelegramCartMutationApplicationKey(runtime.env, SHOP_ID, INTEGRATION_ID, 1021);
    const telegramDiscountContext: CommerceContext = { ...telegramAddContext, requestId: telegramDiscountKey };
    const telegramDiscountApp = new CommerceApplicationService(new TelegramCartMutationPort({ connectionId: null, env: runtime.env, expectedIdempotencyKey: telegramDiscountKey, identity: telegramIdentity, integrationId: INTEGRATION_ID, shop: runtime.telegramShop, updateId: 1021 }));
    const telegramCart = await telegramDiscountApp.mutateCart(telegramDiscountContext, { cart: { access: { kind: "principal" }, cartId: null }, idempotencyKey: telegramDiscountKey, mutation: { code: discountCode, kind: "discount.apply" } });
    const telegramQuote = await telegramDiscountApp.quoteCart(telegramDiscountContext, { cart: telegramCart.cart });
    const telegramSnapshot = await readTelegramCartLines(runtime.env, runtime.telegramShop, telegramCart.cart.cartId);
    const telegramCheckoutKey = await createTelegramCheckoutApplicationKey(runtime.env, SHOP_ID, INTEGRATION_ID, 1022);
    const telegramCheckoutContext: CommerceContext = { ...telegramAddContext, requestId: telegramCheckoutKey };
    const telegramCheckoutApp = createTelegramCheckoutApplication({ connectionId: null, env: runtime.env, expectedIdempotencyKey: telegramCheckoutKey, identity: { ...telegramIdentity, integrationId: INTEGRATION_ID }, requestedSnapshot: telegramSnapshot, shop: runtime.telegramShop, updateId: 1022 });
    if (telegramQuote.quoteEvidence === undefined) throw new Error("telegram_discount_quote_evidence_missing");
    const telegramCommand: CommerceCheckoutCommand = { cart: { access: { kind: "principal" }, cartId: telegramSnapshot.cartId }, customerEmail: null, expected: expectedSnapshot(telegramSnapshot), idempotencyKey: telegramCheckoutKey, quoteEvidence: telegramQuote.quoteEvidence };

    expect(websiteQuote).toMatchObject({ currency: "VND", discountMinor: 2700, subtotalMinor: 18000, totalMinor: 15300 });
    expect(telegramQuote).toMatchObject({ currency: "VND", discountMinor: 2700, subtotalMinor: 18000, totalMinor: 15300 });
    expect(websiteQuote.items).toEqual(telegramQuote.items);
    expect(websiteQuote.items).toEqual([{ lineTotalMinor: 18000, productTitle: "Paid license", quantity, unitPriceMinor: 9000, variantId: "variant-paid", variantTitle: "Default", variantVersion: 1 }]);

    const websiteView = await websiteApp.checkoutCart(websiteContext, websiteCommand);
    const telegramView = await telegramCheckoutApp.checkoutCart(telegramCheckoutContext, telegramCommand);
    await expect(websiteApp.checkoutCart(websiteContext, websiteCommand)).resolves.toEqual(websiteView);
    await expect(telegramCheckoutApp.checkoutCart(telegramCheckoutContext, telegramCommand)).resolves.toEqual(telegramView);
    expect(websiteView).toMatchObject({ fulfillmentStatus: "reserved", paymentStatus: "unpaid", status: "pending_payment", totalMinor: 15300 });
    expect(telegramView).toMatchObject({ fulfillmentStatus: "reserved", paymentStatus: "unpaid", status: "pending_payment", totalMinor: 15300 });
    expect(runtime.database.database.prepare("SELECT source_channel AS sourceChannel, subtotal_minor AS subtotalMinor, discount_minor AS discountMinor, total_minor AS totalMinor FROM orders WHERE shop_id = ? ORDER BY source_channel").all(SHOP_ID)).toEqual([
      { sourceChannel: "telegram", subtotalMinor: 18000, discountMinor: 2700, totalMinor: 15300 },
      { sourceChannel: "web", subtotalMinor: 18000, discountMinor: 2700, totalMinor: 15300 },
    ]);
    expect(runtime.database.database.prepare("SELECT channel, discount_code_normalized AS discountCode FROM carts WHERE shop_id = ? ORDER BY channel").all(SHOP_ID)).toEqual([
      { channel: "telegram", discountCode },
      { channel: "web", discountCode },
    ]);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 2 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 4 });
  });

  it("rejects a Telegram checkout when canonical expected quantity differs from the cart snapshot", async () => {
    const runtime = createRuntime();
    const prepared = await prepareTelegramCheckout(runtime, "variant-paid", 1015);

    await expect(prepared.app.checkoutCart(prepared.context, {
      ...prepared.command,
      expected: prepared.command.expected.map((item) => ({ ...item, quantity: item.quantity + 1 })),
    })).rejects.toMatchObject({ code: "checkout_changed", status: 409 });

    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
  });

  it("requires signed quote evidence for a new Telegram checkout before any order or reservation write", async () => {
    const runtime = createRuntime();
    const prepared = await prepareTelegramCheckout(runtime, "variant-paid", 1023);
    const commandWithoutQuote = { ...prepared.command };
    delete commandWithoutQuote.quoteEvidence;

    await expect(prepared.app.checkoutCart(prepared.context, commandWithoutQuote)).rejects.toMatchObject({ code: "quote_invalid", status: 409 });

    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
  });

  it("rejects tampered Telegram quote evidence before any order or reservation write", async () => {
    const runtime = createRuntime();
    const prepared = await prepareTelegramCheckout(runtime, "variant-paid", 1024);
    const quoteEvidence = prepared.command.quoteEvidence;
    if (quoteEvidence === undefined) throw new Error("telegram_quote_evidence_missing");
    const tampered = `${quoteEvidence.slice(0, -1)}${quoteEvidence.endsWith("a") ? "b" : "a"}`;

    await expect(prepared.app.checkoutCart(prepared.context, { ...prepared.command, quoteEvidence: tampered })).rejects.toMatchObject({ code: "quote_invalid", status: 409 });

    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
  });

  it("rejects expired Telegram quote evidence before any order or reservation write", async () => {
    const runtime = createRuntime();
    const prepared = await prepareTelegramCheckout(runtime, "variant-paid", 1025);
    const cart = runtime.database.database.prepare("SELECT expires_at AS expiresAt FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID) as { expiresAt: string } | undefined;
    if (cart === undefined) throw new Error("telegram_cart_missing");
    const expired = await createQuoteEvidence({
      cartExpiresAt: cart.expiresAt,
      cartId: prepared.command.cart.cartId,
      expected: prepared.command.expected,
      expiresAt: "2020-01-01T00:01:00.000Z",
      issuedAt: "2020-01-01T00:00:00.000Z",
      secret: runtime.env.IDENTIFIER_HMAC_SECRET,
      shopId: SHOP_ID,
    });

    await expect(prepared.app.checkoutCart(prepared.context, { ...prepared.command, quoteEvidence: expired })).rejects.toMatchObject({ code: "quote_expired", status: 409 });

    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
  });

  it.each(["website", "fake"] as const)("rejects expired quote evidence before any %s order or reservation write", async (channel) => {
    const runtime = createRuntime();
    const prepared = channel === "website"
      ? await prepareWebsiteCheckout(runtime, "variant-paid", "parity-expired-quote-web-0001")
      : await prepareFakeCheckout(runtime, "variant-paid", "parity-expired-quote-fake-0001");
    const cart = runtime.database.database.prepare("SELECT expires_at AS expiresAt FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID) as { expiresAt: string } | undefined;
    if (cart === undefined) throw new Error(`${channel}_cart_missing`);
    const expired = await createQuoteEvidence({
      cartExpiresAt: cart.expiresAt,
      cartId: prepared.command.cart.cartId,
      expected: prepared.command.expected,
      expiresAt: "2020-01-01T00:01:00.000Z",
      issuedAt: "2020-01-01T00:00:00.000Z",
      secret: runtime.env.IDENTIFIER_HMAC_SECRET,
      shopId: SHOP_ID,
    });

    await expect(prepared.app.checkoutCart(prepared.context, { ...prepared.command, quoteEvidence: expired }))
      .rejects.toMatchObject({ code: "quote_expired", status: 409 });

    const state = persistedCheckoutState(runtime, prepared.command.cart.cartId, "variant-paid");
    expect(state.order).toBeNull();
    expect(state.fulfillments).toEqual([]);
    expect(state.inventory).toEqual([{ count: 4, status: "available" }]);
    expect(state.cart).toMatchObject({ state: "active" });
  });

  it.each([
    ["price", "UPDATE product_variants SET price_minor = price_minor + 1 WHERE id = 'variant-paid' AND shop_id = 'shop-parity'"],
    ["version", "UPDATE product_variants SET version = version + 1 WHERE id = 'variant-paid' AND shop_id = 'shop-parity'"],
  ])("rejects a Telegram checkout after the displayed quote's %s changes", async (_field, sql) => {
    const runtime = createRuntime();
    const prepared = await prepareTelegramCheckout(runtime, "variant-paid", 1026);
    runtime.database.database.exec(sql);

    let rejection: unknown = null;
    try {
      await prepared.app.checkoutCart(prepared.context, prepared.command);
    } catch (error: unknown) {
      rejection = error;
    }

    expect(isAppError(rejection)).toBe(true);
    if (!isAppError(rejection)) throw new Error("telegram_stale_quote_did_not_fail_closed");
    expect(rejection.status).toBe(409);
    expect(["checkout_changed", "quote_invalid"]).toContain(rejection.code);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
  });

  it.each(["website", "telegram"] as const)("rejects a %s checkout after the displayed quote's product version changes", async (channel) => {
    const runtime = createRuntime();
    const prepared = channel === "website"
      ? await prepareWebsiteCheckout(runtime, "variant-paid", "parity-product-version-web-0001")
      : await prepareTelegramCheckout(runtime, "variant-paid", 1028);
    runtime.database.database.exec("UPDATE products SET title = 'Renamed product', version = version + 1 WHERE id = 'product-paid' AND shop_id = 'shop-parity'");

    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({ status: 409 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
  });

  it.each(["website", "telegram", "fake"] as const)("rejects a quote-valid %s checkout after the variant currency drifts without partial state", async (channel) => {
    const runtime = createRuntime();
    const prepared = channel === "website"
      ? await prepareWebsiteCheckout(runtime, "variant-paid", "parity-currency-drift-web-0001", "currency-drift-web@example.test")
      : channel === "telegram"
        ? await prepareTelegramCheckout(runtime, "variant-paid", 1031)
        : await prepareFakeCheckout(runtime, "variant-paid", "parity-currency-drift-fake-0001");

    // Simulate a legacy/pre-invariant row changing after quote issuance.
    runtime.database.database.exec("DROP TRIGGER product_variants_currency_update_shop_guard; UPDATE product_variants SET currency = 'USD' WHERE id = 'variant-paid' AND shop_id = 'shop-parity'");

    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({ code: "catalog_changed", status: 409 });

    const state = persistedCheckoutState(runtime, prepared.command.cart.cartId, "variant-paid");
    expect(state.order).toBeNull();
    expect(state.fulfillments).toEqual([]);
    expect(state.inventory).toEqual([{ count: 4, status: "available" }]);
    expect(state.cart).toMatchObject({ state: "active" });
    if (channel === "website") {
      expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM shop_customers WHERE shop_id = ? AND email_normalized = ?").get(SHOP_ID, "currency-drift-web@example.test")).toEqual({ count: 0 });
    }
    if (channel === "telegram") {
      expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM telegram_actions WHERE shop_id = ? AND integration_id = ? AND update_id = ? AND action_kind = 'checkout'").get(SHOP_ID, INTEGRATION_ID, 1031)).toEqual({ count: 0 });
    }
  });

  it.each(["website", "telegram"] as const)("rejects a %s checkout when the displayed discount value changes", async (channel) => {
    const runtime = createRuntime();
    const prepared = channel === "website"
      ? await prepareWebsiteCheckout(runtime, "variant-paid", "parity-discount-drift-web-0001", "website-discount-drift@example.test", "WELCOME15")
      : await prepareTelegramCheckout(runtime, "variant-paid", 1029, "WELCOME15");
    runtime.database.database.exec("UPDATE discounts SET value = value + 100, updated_at = '2026-07-29T00:01:00.000Z' WHERE shop_id = 'shop-parity' AND code_normalized = 'WELCOME15'");

    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({ code: "quote_invalid", status: 409 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
  });

  it.each(["website", "telegram"] as const)("rejects a same-key replay after the canonical %s discount changes", async (channel) => {
    const runtime = createRuntime();
    const prepared = channel === "website"
      ? await prepareWebsiteCheckout(runtime, "variant-paid", "parity-discount-replay-web-0001", "website-discount-replay@example.test", "WELCOME15")
      : await prepareTelegramCheckout(runtime, "variant-paid", 1030, "WELCOME15");
    const first = await prepared.app.checkoutCart(prepared.context, prepared.command);
    runtime.database.database.exec("UPDATE discounts SET value = value + 100, updated_at = '2026-07-29T00:01:00.000Z' WHERE shop_id = 'shop-parity' AND code_normalized = 'WELCOME15'");

    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(first.orderId).toBeTruthy();
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
  });

  it("rejects a displayed Telegram quote used by another principal before any order or reservation write", async () => {
    const runtime = createRuntime();
    const prepared = await prepareTelegramCheckout(runtime, "variant-paid", 1027);
    const intruderContext: CommerceContext = { ...prepared.context, actor: { customerId: "customer-intruder", kind: "customer" } };
    const intruderApp = createTelegramCheckoutApplication({
      connectionId: null,
      env: runtime.env,
      expectedIdempotencyKey: prepared.command.idempotencyKey,
      identity: { customerId: "customer-intruder", integrationId: INTEGRATION_ID, subjectHash: "telegram-subject-intruder" },
      requestedSnapshot: prepared.snapshot,
      shop: runtime.telegramShop,
      updateId: 1027,
    });

    let rejection: unknown = null;
    try {
      await intruderApp.checkoutCart(intruderContext, prepared.command);
    } catch (error: unknown) {
      rejection = error;
    }
    expect(isAppError(rejection)).toBe(true);
    if (!isAppError(rejection)) throw new Error("telegram_cross_principal_checkout_did_not_fail_closed");
    expect(rejection.status).toBeGreaterThanOrEqual(400);

    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
  });

  it("matches free manual checkout semantics across Website and Telegram", async () => {
    const runtime = createRuntime();
    const website = await prepareWebsiteCheckout(runtime, "variant-manual", "parity-manual-web-0001");
    const telegram = await prepareTelegramCheckout(runtime, "variant-manual", 1005);
    const websiteResult = await checkoutAndReadOrder({ app: website.app, command: website.command, context: website.context });
    const telegramResult = await checkoutAndReadOrder({ app: telegram.app, command: telegram.command, context: telegram.context });

    expect(websiteResult.view).toMatchObject({ fulfillmentStatus: "unfulfilled", paymentStatus: "paid", status: "processing", totalMinor: 0 });
    expect(telegramResult.view).toMatchObject({ fulfillmentStatus: "unfulfilled", paymentStatus: "paid", status: "processing", totalMinor: 0 });
    expect(websiteResult.order.items).toEqual(telegramResult.order.items);
    expect(runtime.database.database.prepare("SELECT fulfillment_type AS fulfillmentType, state FROM fulfillments WHERE shop_id = ? ORDER BY fulfillment_type").all(SHOP_ID)).toEqual([
      { fulfillmentType: "manual", state: "pending" },
      { fulfillmentType: "manual", state: "pending" },
    ]);
  });

  it.each(["website", "telegram"] as const)("replays a same-key checkout after a pre-reservation inventory race through the %s port", async (channel) => {
    const runtime = createRuntime();
    if (channel === "website") {
      const prepared = await prepareWebsiteCheckout(runtime, "variant-last", "parity-pre-reservation-web-0001");
      const first = await prepared.app.checkoutCart(prepared.context, prepared.command);
      runtime.database.database.prepare("UPDATE carts SET state = 'active' WHERE id = ? AND shop_id = ?").run(prepared.command.cart.cartId, SHOP_ID);
      runtime.database.hideNextCheckoutLookup();

      await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).resolves.toEqual(first);
    } else {
      const prepared = await prepareTelegramCheckout(runtime, "variant-last", 1006);
      const first = await prepared.app.checkoutCart(prepared.context, prepared.command);
      const depletedSnapshot = {
        ...prepared.snapshot,
        lines: prepared.snapshot.lines.map((line) => ({ ...line, availableStock: 0 })),
      };
      const replayApp = createTelegramCheckoutApplication({
        connectionId: null,
        env: runtime.env,
        expectedIdempotencyKey: prepared.command.idempotencyKey,
        identity: { customerId: TELEGRAM_CUSTOMER_ID, subjectHash: "telegram-subject-1006", integrationId: INTEGRATION_ID },
        requestedSnapshot: depletedSnapshot,
        shop: runtime.telegramShop,
        updateId: 1006,
      });
      runtime.database.hideNextCheckoutLookup();

      await expect(replayApp.checkoutCart(prepared.context, { ...prepared.command, expected: expectedSnapshot(depletedSnapshot) })).resolves.toEqual(first);
    }
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
  });

  it.each(["website", "telegram"] as const)("rolls back customer and reservation writes when the %s order batch fails", async (channel) => {
    const runtime = createRuntime();
    const prepared = channel === "website"
      ? await prepareWebsiteCheckout(runtime, "variant-paid", "parity-failure-web-0001", "atomic-failure@example.test")
      : await prepareTelegramCheckout(runtime, "variant-paid", 1012);
    runtime.database.failNextBatchOn("INSERT INTO orders");

    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({ code: "checkout_failed", status: 409 });

    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });
    if (channel === "website") {
      expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM shop_customers WHERE shop_id = ? AND email_normalized = ?").get(SHOP_ID, "atomic-failure@example.test")).toEqual({ count: 0 });
    }
  });

  it("rolls back an existing website customer update, then reuses that customer on a safe retry", async () => {
    const runtime = createRuntime();
    runtime.database.database.prepare(`
      INSERT INTO shop_customers (
        id, shop_id, email_normalized, display_name, locale, status,
        created_at, updated_at
      ) VALUES (?, ?, ?, NULL, 'en', 'active', ?, ?)
    `).run("customer-existing-web", SHOP_ID, "existing-web@example.test", NOW, NOW);
    const prepared = await prepareWebsiteCheckout(runtime, "variant-paid", "parity-existing-customer-web-0001", "existing-web@example.test");
    runtime.database.failNextBatchOn("INSERT INTO orders");

    await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).rejects.toMatchObject({ code: "checkout_failed", status: 409 });
    expect(runtime.database.database.prepare("SELECT locale FROM shop_customers WHERE id = ? AND shop_id = ?").get("customer-existing-web", SHOP_ID)).toEqual({ locale: "en" });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });

    const order = await prepared.app.checkoutCart(prepared.context, prepared.command);
    expect(runtime.database.database.prepare("SELECT customer_id AS customerId FROM orders WHERE public_id = ? AND shop_id = ?").get(order.orderId, SHOP_ID)).toEqual({ customerId: "customer-existing-web" });
    expect(runtime.database.database.prepare("SELECT locale FROM shop_customers WHERE id = ? AND shop_id = ?").get("customer-existing-web", SHOP_ID)).toEqual({ locale: "vi" });
  });

  it.each(["website", "telegram"] as const)("recovers the durable winner when same-key retries overlap at the order batch boundary through the %s port", async (channel) => {
    const runtime = createRuntime();
    const prepared = channel === "website"
      ? await prepareWebsiteCheckout(runtime, "variant-last", "parity-same-key-boundary-web-0001")
      : await prepareTelegramCheckout(runtime, "variant-last", 1013);
    const gate = runtime.database.pauseNextBatch();
    const blocked = prepared.app.checkoutCart(prepared.context, prepared.command);
    await gate.reached;
    const winner = await prepared.app.checkoutCart(prepared.context, prepared.command);
    gate.resume();

    await expect(blocked).resolves.toEqual(winner);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-last' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 1 });
  });

  it.each(["website", "telegram"] as const)("replays and rejects idempotency conflicts through the %s canonical port", async (channel) => {
    const runtime = createRuntime();
    if (channel === "website") {
      const prepared = await prepareWebsiteCheckout(runtime, "variant-paid", "parity-replay-web-0001");
      const first = await prepared.app.checkoutCart(prepared.context, prepared.command);
      await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).resolves.toEqual(first);
      await expect(prepared.app.checkoutCart(prepared.context, { ...prepared.command, customerEmail: "different@example.test" })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    } else {
      const prepared = await prepareTelegramCheckout(runtime, "variant-paid", 1003);
      const first = await prepared.app.checkoutCart(prepared.context, prepared.command);
      await expect(prepared.app.checkoutCart(prepared.context, prepared.command)).resolves.toEqual(first);
      const changedSnapshot = { ...prepared.snapshot, lines: prepared.snapshot.lines.map((line) => ({ ...line, quantity: line.quantity + 1 })) };
      const changedApp = createTelegramCheckoutApplication({ connectionId: null, env: runtime.env, expectedIdempotencyKey: prepared.command.idempotencyKey, identity: { customerId: TELEGRAM_CUSTOMER_ID, subjectHash: "telegram-subject-1003", integrationId: INTEGRATION_ID }, requestedSnapshot: changedSnapshot, shop: runtime.telegramShop, updateId: 1003 });
      const changedExpected = expectedSnapshot(changedSnapshot);
      const cart = runtime.database.database.prepare("SELECT expires_at AS expiresAt FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID) as { expiresAt: string } | undefined;
      if (cart === undefined) throw new Error("telegram_cart_missing");
      const changedEvidence = await createQuoteEvidence({
        cartExpiresAt: cart.expiresAt,
        cartId: prepared.command.cart.cartId,
        expected: changedExpected,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        secret: runtime.env.IDENTIFIER_HMAC_SECRET,
        shopId: SHOP_ID,
      });
      await expect(changedApp.checkoutCart(prepared.context, { ...prepared.command, expected: changedExpected, quoteEvidence: changedEvidence })).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    }
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
  });

  it("allows exactly one winner when Website and Telegram contend for the last key", async () => {
    const runtime = createRuntime();
    const website = await prepareWebsiteCheckout(runtime, "variant-last", "parity-last-web-0001");
    const telegram = await prepareTelegramCheckout(runtime, "variant-last", 1004);
    const results = await Promise.allSettled([
      website.app.checkoutCart(website.context, website.command),
      telegram.app.checkoutCart(telegram.context, telegram.command),
    ]);
    const winners = results.filter((result): result is PromiseFulfilledResult<CommerceCheckoutView> => result.status === "fulfilled");
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(winners[0]?.value).toMatchObject({ status: "pending_payment", paymentStatus: "unpaid", totalMinor: 5000 });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatchObject({ code: "inventory_unavailable", status: 409 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-last' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 1 });
  });

  it.each(["website", "telegram"] as const)("fails closed on a cross-tenant %s checkout without leaking cart or inventory state", async (channel) => {
    const runtime = createRuntime();
    const otherShopId = "shop-other";
    let cartId: string;
    let rejection: unknown = null;
    if (channel === "website") {
      const prepared = await prepareWebsiteCheckout(runtime, "variant-paid", "parity-cross-tenant-web-0001");
      const otherShop: StorefrontShop = { ...runtime.shop, id: otherShopId, publicId: "shop-public-other", slug: "other-shop" };
      const context: CommerceContext = { ...prepared.context, requestId: "request-cross-tenant-web-0001", shopId: otherShopId };
      cartId = prepared.command.cart.cartId;
      try {
        await createWebsiteCommerceApplication(runtime.env, otherShop).checkoutCart(context, prepared.command);
      } catch (error: unknown) {
        rejection = error;
      }
    } else {
      const prepared = await prepareTelegramCheckout(runtime, "variant-paid", 1014);
      const context: CommerceContext = { ...prepared.context, actor: { customerId: "customer-other", kind: "customer" }, requestId: "request-cross-tenant-tg-1014", shopId: otherShopId };
      cartId = prepared.command.cart.cartId;
      const app = createTelegramCheckoutApplication({
          connectionId: null,
          env: runtime.env,
          expectedIdempotencyKey: prepared.command.idempotencyKey,
          identity: { customerId: "customer-other", integrationId: INTEGRATION_ID, subjectHash: "telegram-other-subject-1014" },
          requestedSnapshot: prepared.snapshot,
          shop: { ...runtime.telegramShop, id: otherShopId },
          updateId: 1014,
        });
      try {
        await app.checkoutCart(context, prepared.command);
      } catch (error: unknown) {
        rejection = error;
      }
    }

    expect(isAppError(rejection)).toBe(true);
    if (!isAppError(rejection)) throw new Error("cross_tenant_checkout_did_not_fail_closed");
    expect([403, 404, 409]).toContain(rejection.status);
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(otherShopId)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(cartId, SHOP_ID)).toEqual({ state: "active" });
  });

  it("rolls back the canonical core when an existing customer belongs to another tenant", async () => {
    const runtime = createRuntime();
    const prepared = await prepareWebsiteCheckout(runtime, "variant-paid", "parity-core-cross-tenant-0001");
    runtime.database.database.prepare(`
      INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
      VALUES ('shop-other', 'shop-public-other', 'other-shop', 'Other Shop', 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(NOW, NOW);
    runtime.database.database.prepare(`
      INSERT INTO shop_customers (id, shop_id, email_normalized, display_name, locale, status, created_at, updated_at)
      VALUES ('customer-other', 'shop-other', 'other@example.test', 'Other buyer', 'vi', 'active', ?, ?)
    `).run(NOW, NOW);

    const quoteItem = prepared.quote.items[0];
    if (quoteItem === undefined) throw new Error("canonical_core_fixture_missing");
    await expect(executeCanonicalCheckoutTransaction({
      cartId: prepared.command.cart.cartId,
      cartSnapshot: { discountCode: null },
      channel: { code: "website", connectionId: null },
      checkoutRequestHash: "core-request-hash-0001",
      checkoutSubjectHash: "core-subject-hash-0001",
      env: runtime.env,
      eventIdempotencyKey: "core-event-key-0001",
      expiresAt: "2026-07-29T00:30:00.000Z",
      fulfillmentIdempotencyPrefix: "core-test",
      locale: "vi",
      nowIso: NOW,
      orderId: "ord-core-cross-tenant-0001",
      orderPublicId: "order-core-cross-tenant-0001",
      orderTokenHash: "order-token-hash-core-0001",
      shopId: SHOP_ID,
      currency: "VND",
      customer: { customerId: "customer-other", kind: "existing", maskedEmail: null },
      discountMinor: 0,
      reservationToken: "reservation-core-cross-tenant-0001",
      lines: [{
        fulfillmentType: "license_key",
        priceMinor: quoteItem.unitPriceMinor,
        productId: "product-paid",
        productTitle: quoteItem.productTitle,
        productVersion: 1,
        quantity: quoteItem.quantity,
        sku: "SKU-PAID",
        title: quoteItem.variantTitle,
        variantId: quoteItem.variantId,
        variantVersion: quoteItem.variantVersion,
      }],
      subtotalMinor: quoteItem.lineTotalMinor,
      totalMinor: quoteItem.lineTotalMinor,
    })).rejects.toThrow();

    expect(runtime.database.database.prepare("SELECT state FROM carts WHERE id = ? AND shop_id = ?").get(prepared.command.cart.cartId, SHOP_ID)).toEqual({ state: "active" });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM orders WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM order_items WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM order_channel_attributions WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
    expect(runtime.database.database.prepare("SELECT COUNT(*) AS count FROM inventory_keys WHERE shop_id = ? AND variant_id = 'variant-paid' AND status = 'reserved'").get(SHOP_ID)).toEqual({ count: 0 });
  });
});
