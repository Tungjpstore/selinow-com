import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  configurePrivateFilePolicy,
  consumeWebsitePrivateDownloadGrant,
  createPrivateDigitalAsset,
  issueWebsitePrivateDownloadGrant,
  listWebsitePrivateDownloads,
  revokePrivateDownloadEntitlement,
} from "../../src/lib/commerce/private-file-fulfillment";
import { hmacToken, sha256Json } from "../../src/lib/core/crypto";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-07-29T06:00:00.000Z");
const SHOP_ID = "shop-private-a";
const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-0000000000a1";
const USER_ID = "user-private-a";
const ORDER_PUBLIC_ID = "order_00000000-0000-4000-8000-0000000000a1";
const ORDER_TOKEN = "order-access-token-private-a-1234567890";
const FILE_BYTES = new TextEncoder().encode("private file payload");

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values as SQLInputValue[]);
  }

  setValue(index: number, value: SQLInputValue): void {
    this.values[index] = value;
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class SqliteD1 {
  private batchQueue = Promise.resolve();
  private nextBatchPause: { reached: () => void; released: Promise<void> } | null = null;
  private beforeBatchHook: ((statements: SqliteStatement[]) => void) | null = null;

  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.database, sql);
  }

  pauseNextBatch(): { reached: Promise<void>; resume: () => void } {
    let reachedResolve!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextBatchPause = { reached: reachedResolve, released };
    return { reached, resume: release };
  }

  beforeNextBatch(hook: (statements: SqliteStatement[]) => void): void {
    this.beforeBatchHook = hook;
  }

  batch(statements: SqliteStatement[]): Promise<Array<{ meta: { changes: number } }>> {
    const pause = this.nextBatchPause;
    this.nextBatchPause = null;
    pause?.reached();
    const operation = this.batchQueue.then(async () => {
      if (pause !== null) await pause.released;
      const beforeBatchHook = this.beforeBatchHook;
      this.beforeBatchHook = null;
      beforeBatchHook?.(statements);
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

class MemoryR2 {
  arrayBufferCalls = 0;
  readonly etags = new Map<string, string>();
  getCalls = 0;
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();

  bucket(): R2Bucket {
    return {
      delete: (key: string) => {
        this.objects.delete(key);
        this.etags.delete(key);
        return Promise.resolve();
      },
      get: (key: string) => {
        this.getCalls += 1;
        const bytes = this.objects.get(key);
        const httpEtag = this.etags.get(key);
        if (bytes === undefined || httpEtag === undefined) return Promise.resolve(null);
        return Promise.resolve({
          arrayBuffer: () => {
            this.arrayBufferCalls += 1;
            return Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
          },
          httpEtag,
        });
      },
      put: (key: string, value: Uint8Array<ArrayBuffer>) => {
        const httpEtag = `etag-${String(this.objects.size + 1)}`;
        this.objects.set(key, new Uint8Array(value));
        this.etags.set(key, httpEtag);
        return Promise.resolve({ httpEtag });
      },
    } as unknown as R2Bucket;
  }
}

function applyMigrations(database: DatabaseSync): void {
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
}

async function seed(database: DatabaseSync): Promise<void> {
  const nowIso = NOW.toISOString();
  const orderTokenHash = await hmacToken("identifier-secret", "order-access", ORDER_TOKEN);
  const otherOrderTokenHash = await hmacToken("identifier-secret", "order-access", "other-order-token-private-123456789");
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-private', 'private', 'Private', '{}', '{}', '${nowIso}', '${nowIso}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES
      ('${USER_ID}', 'private-a@example.test', 'Private A', 'active', '${nowIso}', '${nowIso}'),
      ('user-private-b', 'private-b@example.test', 'Private B', 'active', '${nowIso}', '${nowIso}');
    INSERT INTO shops (
      id, public_id, slug, name, status, default_locale, currency, timezone,
      readiness_version, created_at, updated_at
    ) VALUES
      ('${SHOP_ID}', '${SHOP_PUBLIC_ID}', 'private-a', 'Private A', 'active', 'en', 'USD', 'UTC', 1, '${nowIso}', '${nowIso}'),
      ('shop-private-b', 'shop_00000000-0000-4000-8000-0000000000b1', 'private-b', 'Private B', 'active', 'en', 'USD', 'UTC', 1, '${nowIso}', '${nowIso}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES
      ('${SHOP_ID}', '${USER_ID}', 'owner', 'active', '${nowIso}', '${nowIso}'),
      ('shop-private-b', 'user-private-b', 'owner', 'active', '${nowIso}', '${nowIso}');
    INSERT INTO shop_settings (shop_id, branding_json, storefront_json, order_expiry_minutes, low_stock_threshold, version, updated_at)
    VALUES
      ('${SHOP_ID}', '{}', '{}', 30, 5, 1, '${nowIso}'),
      ('shop-private-b', '{}', '{}', 30, 5, 1, '${nowIso}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, current_period_start, current_period_end, created_at, updated_at)
    VALUES
      ('subscription-private-a', '${SHOP_ID}', 'plan-private', 'active', '${nowIso}', '2027-07-29T00:00:00.000Z', '${nowIso}', '${nowIso}'),
      ('subscription-private-b', 'shop-private-b', 'plan-private', 'active', '${nowIso}', '2027-07-29T00:00:00.000Z', '${nowIso}', '${nowIso}');
    INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
    VALUES
      ('product-private-a', '${SHOP_ID}', 'download-a', 'Download A', '', 'active', 'manual', 1, '${nowIso}', '${nowIso}'),
      ('product-private-b', 'shop-private-b', 'download-b', 'Download B', '', 'active', 'manual', 1, '${nowIso}', '${nowIso}');
    INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
    VALUES
      ('variant-private-a', '${SHOP_ID}', 'product-private-a', 'PRIVATE-A', 'Default', '{}', 1000, 'USD', 1, 5, 'active', 1, '${nowIso}', '${nowIso}'),
      ('variant-private-b', 'shop-private-b', 'product-private-b', 'PRIVATE-B', 'Default', '{}', 1000, 'USD', 1, 5, 'active', 1, '${nowIso}', '${nowIso}');
    INSERT INTO orders (
      id, public_id, shop_id, order_number, source_channel, status,
      payment_status, fulfillment_status, subtotal_minor, discount_minor,
      total_minor, currency, locale, checkout_subject_hash, order_token_hash,
      expires_at, paid_at, created_at, updated_at
    ) VALUES
      ('order-private-a', '${ORDER_PUBLIC_ID}', '${SHOP_ID}', 'PRIVATE-A', 'web', 'processing', 'paid', 'unfulfilled', 1000, 0, 1000, 'USD', 'en', 'subject-private-a', '${orderTokenHash}', '2026-07-29T07:00:00.000Z', '${nowIso}', '${nowIso}', '${nowIso}'),
      ('order-private-b', 'order_00000000-0000-4000-8000-0000000000b1', 'shop-private-b', 'PRIVATE-B', 'web', 'processing', 'paid', 'unfulfilled', 1000, 0, 1000, 'USD', 'en', 'subject-private-b', '${otherOrderTokenHash}', '2026-07-29T07:00:00.000Z', '${nowIso}', '${nowIso}', '${nowIso}');
    INSERT INTO order_items (
      id, shop_id, order_id, product_id, variant_id, product_title,
      variant_title, sku, unit_price_minor, quantity, line_total_minor,
      fulfillment_type, created_at
    ) VALUES
      ('order-item-private-a', '${SHOP_ID}', 'order-private-a', 'product-private-a', 'variant-private-a', 'Download A', 'Default', 'PRIVATE-A', 1000, 1, 1000, 'manual', '${nowIso}'),
      ('order-item-private-b', 'shop-private-b', 'order-private-b', 'product-private-b', 'variant-private-b', 'Download B', 'Default', 'PRIVATE-B', 1000, 1, 1000, 'manual', '${nowIso}');
  `);
}

describe("private file fulfillment", () => {
  let database: DatabaseSync;
  let env: AppBindings;
  let r2: MemoryR2;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    applyMigrations(database);
    await seed(database);
    r2 = new MemoryR2();
    env = {
      APP_ENV: "local",
      IDENTIFIER_HMAC_SECRET: "identifier-secret",
      MEDIA: r2.bucket(),
      PLATFORM_DB: new SqliteD1(database) as unknown as D1Database,
      SESSION_SECRET: "session-secret",
    } as unknown as AppBindings;
  });

  afterEach(() => {
    database.close();
  });

  function snapshotRequirement(input: {
    orderItemId: string;
    orderId?: string;
    policy: Awaited<ReturnType<typeof configurePrivateFilePolicy>>;
  }): void {
    database.prepare(`
      INSERT INTO order_item_fulfillment_requirements (
        id, shop_id, order_id, order_item_id, capability, policy_id,
        policy_version, asset_version_id, max_downloads, grant_ttl_seconds,
        entitlement_ttl_seconds, created_at
      ) VALUES (?, ?, ?, ?, 'private_file', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `requirement-${input.orderItemId}`,
      SHOP_ID,
      input.orderId ?? "order-private-a",
      input.orderItemId,
      input.policy.id,
      input.policy.policyVersion,
      input.policy.assetVersionId,
      input.policy.maxDownloads,
      input.policy.grantTtlSeconds,
      input.policy.entitlementTtlSeconds,
      NOW.toISOString(),
    );
  }

  async function provision(maxDownloads = 2, entitlementTtlSeconds: number | null = null, snapshotOrder = true) {
    const asset = await createPrivateDigitalAsset({
      bytes: FILE_BYTES,
      contentType: "application/pdf",
      env,
      filename: "../Private Guide.pdf",
      requestId: "request-asset-create",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const policy = await configurePrivateFilePolicy({
      assetVersionId: asset.assetVersionId,
      entitlementTtlSeconds,
      env,
      grantTtlSeconds: 600,
      maxDownloads,
      productId: "product-private-a",
      requestId: "request-policy-create",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    if (snapshotOrder) snapshotRequirement({ orderItemId: "order-item-private-a", policy });
    return asset;
  }

  async function issue(assetVersionId: string, idempotencyKey = "private-grant-key-0001", now = NOW, orderItemId = "order-item-private-a") {
    return issueWebsitePrivateDownloadGrant({
      assetVersionId,
      env,
      idempotencyKey,
      orderItemId,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId: `request-${idempotencyKey}`,
      runtime: { now },
      shopId: SHOP_ID,
    });
  }

  it("stores private bytes behind opaque R2 metadata and lists a paid order capability", async () => {
    const asset = await provision();

    expect(asset).toMatchObject({ byteSize: FILE_BYTES.byteLength, contentType: "application/pdf", filename: "Private Guide.pdf", version: 1 });
    const version = database.prepare(`
      SELECT object_key AS objectKey, filename_sanitized AS filename
      FROM digital_asset_versions WHERE id = ? AND shop_id = ?
    `).get(asset.assetVersionId, SHOP_ID) as { filename: string; objectKey: string };
    expect(version.objectKey).toMatch(/^private-digital-assets\/shop-private-a\/das_/u);
    expect(version.objectKey).not.toContain("Private Guide");
    expect(r2.objects.has(version.objectKey)).toBe(true);

    await expect(listWebsitePrivateDownloads({ env, orderPublicId: ORDER_PUBLIC_ID, orderToken: ORDER_TOKEN, runtime: { now: NOW }, shopId: SHOP_ID })).resolves.toEqual([
      expect.objectContaining({ assetVersionId: asset.assetVersionId, downloadCount: 0, filename: "Private Guide.pdf", maxDownloads: 2, remainingDownloads: 2 }),
    ]);
  });

  it("does not attach a newly configured private-file policy to an older manual order", async () => {
    const asset = await provision(2, null, false);

    await expect(listWebsitePrivateDownloads({ env, orderPublicId: ORDER_PUBLIC_ID, orderToken: ORDER_TOKEN, runtime: { now: NOW }, shopId: SHOP_ID })).resolves.toEqual([]);
    await expect(issue(asset.assetVersionId, "private-historical-policy-0001"))
      .rejects.toMatchObject({ code: "private_download_not_found", status: 404 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM order_item_fulfillment_requirements WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
  });

  it("rejects uploads when the shop becomes suspended before the authoritative insert", async () => {
    const originalMedia = env.MEDIA;
    env.MEDIA = {
      ...originalMedia,
      put: async (key, value, options) => {
        const stored = await originalMedia.put(key, value, options);
        database.prepare("UPDATE shops SET status = 'suspended' WHERE id = ?").run(SHOP_ID);
        return stored;
      },
    };

    await expect(createPrivateDigitalAsset({
      bytes: FILE_BYTES,
      contentType: "application/pdf",
      env,
      filename: "private.pdf",
      requestId: "request-upload-suspended-race",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "shop_inactive", status: 409 });
    expect(r2.objects.size).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM digital_assets WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 0 });
  });

  it("rejects private-file policy mutations for a suspended shop", async () => {
    const asset = await provision();
    database.prepare("UPDATE shops SET status = 'suspended' WHERE id = ?").run(SHOP_ID);

    await expect(configurePrivateFilePolicy({
      assetVersionId: asset.assetVersionId,
      entitlementTtlSeconds: null,
      env,
      grantTtlSeconds: 600,
      maxDownloads: 3,
      productId: "product-private-a",
      requestId: "request-policy-suspended",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "shop_inactive", status: 409 });

    expect(database.prepare("SELECT COUNT(*) AS count FROM product_fulfillment_policies WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
  });

  it("rejects private-file policy mutations when suspension wins before the policy batch", async () => {
    const asset = await provision();
    const d1 = env.PLATFORM_DB as unknown as {
      batch: (statements: unknown[]) => Promise<Array<{ meta: { changes: number } }>>;
    };
    const originalBatch = d1.batch.bind(d1);
    d1.batch = (statements) => {
      if (statements.some((statement) => (statement as { sql: string }).sql.includes("UPDATE product_fulfillment_policies"))) {
        database.prepare("UPDATE shops SET status = 'suspended' WHERE id = ?").run(SHOP_ID);
      }
      return originalBatch(statements);
    };

    await expect(configurePrivateFilePolicy({
      assetVersionId: asset.assetVersionId,
      entitlementTtlSeconds: null,
      env,
      grantTtlSeconds: 600,
      maxDownloads: 3,
      productId: "product-private-a",
      requestId: "request-policy-suspended-race",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "shop_inactive", status: 409 });

    expect(database.prepare("SELECT COUNT(*) AS count FROM product_fulfillment_policies WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
  });

  it("replays one deterministic grant and bounds fresh grants to durable entitlement quota", async () => {
    const asset = await provision(2);
    const first = await issue(asset.assetVersionId);
    const replay = await issue(asset.assetVersionId);
    expect(replay).toEqual(first);
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grants").get()).toEqual({ count: 1 });

    await expect(issue(asset.assetVersionId, "private-grant-key-0002")).rejects.toMatchObject({ code: "private_download_grant_active", status: 409 });
    await expect(consumeWebsitePrivateDownloadGrant({
      env,
      grantId: first.grantId,
      grantToken: first.grantToken,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId: "request-consume-1",
      runtime: { now: NOW },
      shopId: SHOP_ID,
    })).resolves.toMatchObject({ contentType: "application/pdf", filename: "Private Guide.pdf" });

    const second = await issue(asset.assetVersionId, "private-grant-key-0002", new Date(NOW.getTime() + 1_000));
    await consumeWebsitePrivateDownloadGrant({
      env,
      grantId: second.grantId,
      grantToken: second.grantToken,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId: "request-consume-2",
      runtime: { now: new Date(NOW.getTime() + 1_000) },
      shopId: SHOP_ID,
    });

    expect(database.prepare("SELECT status, download_count AS downloadCount, max_downloads AS maxDownloads FROM digital_entitlements").get()).toEqual({ downloadCount: 2, maxDownloads: 2, status: "exhausted" });
    await expect(issue(asset.assetVersionId, "private-grant-key-0003", new Date(NOW.getTime() + 2_000))).rejects.toMatchObject({ code: "private_download_not_found", status: 404 });
  });

  it("recovers one durable grant when identical issuance batches overlap", async () => {
    const asset = await provision(2);
    const d1 = env.PLATFORM_DB as unknown as SqliteD1;
    const firstGate = d1.pauseNextBatch();
    const firstAttempt = issue(asset.assetVersionId, "private-grant-race-same-0001");
    await firstGate.reached;

    const secondGate = d1.pauseNextBatch();
    const secondAttempt = issue(asset.assetVersionId, "private-grant-race-same-0001");
    await secondGate.reached;

    firstGate.resume();
    const first = await firstAttempt;
    secondGate.resume();
    const second = await secondAttempt;

    expect(second).toEqual(first);
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grants WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE shop_id = ? AND action = 'delivery_grant.issued'").get(SHOP_ID)).toEqual({ count: 1 });
    const durableEvidence = JSON.stringify(database.prepare(`
      SELECT token_hash AS tokenHash, token_nonce AS tokenNonce, request_hash AS requestHash
      FROM delivery_grants WHERE shop_id = ?
    `).get(SHOP_ID));
    expect(durableEvidence).not.toContain(first.grantToken);
  });

  it("fails closed when an overlapping same-key winner has a different request payload", async () => {
    const asset = await provision(2);
    const d1 = env.PLATFORM_DB as unknown as SqliteD1;
    const differentRequestHash = await sha256Json({
      assetVersionId: asset.assetVersionId,
      orderId: "order-private-a",
      orderItemId: "order-item-private-different",
      shopId: SHOP_ID,
    });
    const firstGate = d1.pauseNextBatch();
    const firstAttempt = issue(asset.assetVersionId, "private-grant-race-conflict-0001");
    await firstGate.reached;

    const secondGate = d1.pauseNextBatch();
    const secondAttempt = issue(asset.assetVersionId, "private-grant-race-conflict-0001");
    await secondGate.reached;
    d1.beforeNextBatch((statements) => {
      statements[0]?.setValue(11, differentRequestHash);
    });

    firstGate.resume();
    const first = await firstAttempt;
    secondGate.resume();

    await expect(secondAttempt).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grants WHERE shop_id = ?").get(SHOP_ID)).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE shop_id = ? AND action = 'delivery_grant.issued'").get(SHOP_ID)).toEqual({ count: 1 });
    expect(JSON.stringify(database.prepare("SELECT token_hash AS tokenHash, token_nonce AS tokenNonce FROM delivery_grants WHERE shop_id = ?").get(SHOP_ID))).not.toContain(first.grantToken);
  });

  it("expires a stale active grant before issuing a replacement", async () => {
    const asset = await provision(2);
    const first = await issue(asset.assetVersionId, "private-expiring-grant-0001");
    const afterExpiry = new Date(NOW.getTime() + 601_000);

    const replacement = await issue(asset.assetVersionId, "private-expiring-grant-0002", afterExpiry);

    expect(replacement.grantId).not.toBe(first.grantId);
    expect(database.prepare(`
      SELECT status FROM delivery_grants WHERE id = ? AND shop_id = ?
    `).get(first.grantId, SHOP_ID)).toEqual({ status: "expired" });
    expect(database.prepare(`
      SELECT status FROM delivery_grants WHERE id = ? AND shop_id = ?
    `).get(replacement.grantId, SHOP_ID)).toEqual({ status: "active" });
  });

  it("binds grants to an exact order item when products share one asset version", async () => {
    const asset = await provision(2);
    database.exec(`
      INSERT INTO products (id, shop_id, slug, title, description, status, fulfillment_type, version, created_at, updated_at)
      VALUES ('product-private-c', '${SHOP_ID}', 'download-c', 'Download C', '', 'active', 'manual', 1, '${NOW.toISOString()}', '${NOW.toISOString()}');
      INSERT INTO product_variants (id, shop_id, product_id, sku, title, options_json, price_minor, currency, min_per_order, max_per_order, status, version, created_at, updated_at)
      VALUES ('variant-private-c', '${SHOP_ID}', 'product-private-c', 'PRIVATE-C', 'Default', '{}', 1000, 'USD', 1, 5, 'active', 1, '${NOW.toISOString()}', '${NOW.toISOString()}');
      INSERT INTO order_items (
        id, shop_id, order_id, product_id, variant_id, product_title,
        variant_title, sku, unit_price_minor, quantity, line_total_minor,
        fulfillment_type, created_at
      ) VALUES (
        'order-item-private-c', '${SHOP_ID}', 'order-private-a', 'product-private-c',
        'variant-private-c', 'Download C', 'Default', 'PRIVATE-C', 1000, 1, 1000,
        'manual', '${NOW.toISOString()}'
      );
    `);
    const sharedPolicy = await configurePrivateFilePolicy({
      assetVersionId: asset.assetVersionId,
      entitlementTtlSeconds: null,
      env,
      grantTtlSeconds: 600,
      maxDownloads: 5,
      productId: "product-private-c",
      requestId: "request-policy-c",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    snapshotRequirement({ orderItemId: "order-item-private-c", policy: sharedPolicy });

    await issue(asset.assetVersionId, "private-shared-asset-a", NOW, "order-item-private-a");
    await issue(asset.assetVersionId, "private-shared-asset-c", NOW, "order-item-private-c");

    expect(database.prepare(`
      SELECT order_item_id AS orderItemId, max_downloads AS maxDownloads
      FROM digital_entitlements ORDER BY order_item_id
    `).all()).toEqual([
      { maxDownloads: 2, orderItemId: "order-item-private-a" },
      { maxDownloads: 5, orderItemId: "order-item-private-c" },
    ]);
  });

  it("rechecks paid order state in the grant issuance transaction", async () => {
    const asset = await provision(1);
    const d1 = env.PLATFORM_DB as unknown as {
      batch: (statements: unknown[]) => Promise<Array<{ meta: { changes: number } }>>;
    };
    const originalBatch = d1.batch.bind(d1);
    d1.batch = (statements) => {
      if (statements.some((statement) => (statement as { sql: string }).sql.includes("INSERT INTO delivery_grants"))) {
        database.prepare("UPDATE orders SET status = 'canceled', payment_status = 'failed' WHERE id = ? AND shop_id = ?")
          .run("order-private-a", SHOP_ID);
      }
      return originalBatch(statements);
    };

    await expect(issue(asset.assetVersionId, "private-payment-race-issue"))
      .rejects.toMatchObject({ code: "private_download_grant_active", status: 409 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grants").get()).toEqual({ count: 0 });
  });

  it("allows exactly one concurrent consume winner and gates R2 reads and hashing", async () => {
    const asset = await provision(1);
    const grant = await issue(asset.assetVersionId);
    const consume = (requestId: string) => consumeWebsitePrivateDownloadGrant({
      env,
      grantId: grant.grantId,
      grantToken: grant.grantToken,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId,
      runtime: { now: NOW },
      shopId: SHOP_ID,
    });

    const digestSpy = vi.spyOn(globalThis.crypto.subtle, "digest");
    try {
      const results = await Promise.allSettled([consume("request-race-a"), consume("request-race-b")]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(results.find((result) => result.status === "rejected"))
        .toMatchObject({ reason: { code: "private_download_grant_not_found", status: 404 } });
      expect(r2.getCalls).toBe(1);
      expect(r2.arrayBufferCalls).toBe(1);
      expect(digestSpy).toHaveBeenCalledTimes(1);
      expect(database.prepare("SELECT download_count AS downloadCount, status FROM digital_entitlements").get()).toEqual({ downloadCount: 1, status: "exhausted" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grant_consumptions").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grant_claims").get()).toEqual({ count: 0 });
    } finally {
      digestSpy.mockRestore();
    }
  });

  it("consumes a legitimate grant and releases its ephemeral claim", async () => {
    const asset = await provision(1);
    const grant = await issue(asset.assetVersionId);
    const digestSpy = vi.spyOn(globalThis.crypto.subtle, "digest");
    try {
      await expect(consumeWebsitePrivateDownloadGrant({
        env,
        grantId: grant.grantId,
        grantToken: grant.grantToken,
        orderPublicId: ORDER_PUBLIC_ID,
        orderToken: ORDER_TOKEN,
        requestId: "request-legitimate-consume",
        runtime: { now: NOW },
        shopId: SHOP_ID,
      })).resolves.toMatchObject({ bytes: FILE_BYTES, contentType: "application/pdf", filename: "Private Guide.pdf" });
      expect(r2.getCalls).toBe(1);
      expect(r2.arrayBufferCalls).toBe(1);
      expect(digestSpy).toHaveBeenCalledTimes(1);
      expect(database.prepare("SELECT status FROM delivery_grants").get()).toEqual({ status: "consumed" });
      expect(database.prepare("SELECT download_count AS downloadCount FROM digital_entitlements").get()).toEqual({ downloadCount: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grant_claims").get()).toEqual({ count: 0 });
    } finally {
      digestSpy.mockRestore();
    }
  });

  it("replays a durable consumption after response loss without consuming quota twice", async () => {
    const asset = await provision(1);
    const grant = await issue(asset.assetVersionId);
    const requestId = "request-consume-response-loss";
    const consume = () => consumeWebsitePrivateDownloadGrant({
      env,
      grantId: grant.grantId,
      grantToken: grant.grantToken,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId,
      runtime: { now: NOW },
      shopId: SHOP_ID,
    });

    await expect(consume()).resolves.toMatchObject({ bytes: FILE_BYTES, contentType: "application/pdf", filename: "Private Guide.pdf" });
    const readsAfterFirstServe = r2.getCalls;
    await expect(consume()).resolves.toMatchObject({ bytes: FILE_BYTES, contentType: "application/pdf", filename: "Private Guide.pdf" });

    expect(r2.getCalls).toBe(readsAfterFirstServe + 1);
    expect(r2.arrayBufferCalls).toBe(2);
    expect(database.prepare("SELECT download_count AS downloadCount, status FROM digital_entitlements").get()).toEqual({ downloadCount: 1, status: "exhausted" });
    expect(database.prepare("SELECT status FROM delivery_grants").get()).toEqual({ status: "consumed" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grant_consumptions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grant_claims").get()).toEqual({ count: 0 });

    await expect(consumeWebsitePrivateDownloadGrant({
      env,
      grantId: grant.grantId,
      grantToken: grant.grantToken,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId: "request-consume-response-loss-mismatch",
      runtime: { now: NOW },
      shopId: SHOP_ID,
    })).rejects.toMatchObject({ code: "private_download_grant_not_found", status: 404 });
    await expect(consumeWebsitePrivateDownloadGrant({
      env,
      grantId: grant.grantId,
      grantToken: `${grant.grantToken.slice(0, -1)}${grant.grantToken.endsWith("x") ? "y" : "x"}`,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId,
      runtime: { now: NOW },
      shopId: SHOP_ID,
    })).rejects.toMatchObject({ code: "private_download_grant_not_found", status: 404 });
    expect(r2.getCalls).toBe(readsAfterFirstServe + 1);
  });

  it("reclaims an expired download lease before reading the private object", async () => {
    const asset = await provision(1);
    const grant = await issue(asset.assetVersionId);
    database.prepare(`
      INSERT INTO delivery_grant_claims (
        id, shop_id, grant_id, created_at, lease_expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      "claim-stale",
      SHOP_ID,
      grant.grantId,
      NOW.toISOString(),
      new Date(NOW.getTime() + 1_000).toISOString(),
    );

    await expect(consumeWebsitePrivateDownloadGrant({
      env,
      grantId: grant.grantId,
      grantToken: grant.grantToken,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId: "request-stale-claim-retry",
      runtime: { now: new Date(NOW.getTime() + 2_000) },
      shopId: SHOP_ID,
    })).resolves.toMatchObject({ contentType: "application/pdf", filename: "Private Guide.pdf" });
    expect(r2.getCalls).toBe(1);
    expect(r2.arrayBufferCalls).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grant_claims").get()).toEqual({ count: 0 });
  });

  it("fails closed for cross-tenant, wrong buyer, wrong token, expired and revoked grants", async () => {
    const asset = await provision(3, 1_200);
    const grant = await issue(asset.assetVersionId);
    await expect(issueWebsitePrivateDownloadGrant({
      assetVersionId: asset.assetVersionId,
      env,
      idempotencyKey: "private-cross-shop-0001",
      orderItemId: "order-item-private-a",
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId: "request-cross-shop",
      runtime: { now: NOW },
      shopId: "shop-private-b",
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
    await expect(consumeWebsitePrivateDownloadGrant({
      env,
      grantId: grant.grantId,
      grantToken: grant.grantToken,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: "wrong-order-token-private-123456789",
      requestId: "request-wrong-order-token",
      runtime: { now: NOW },
      shopId: SHOP_ID,
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
    await expect(consumeWebsitePrivateDownloadGrant({
      env,
      grantId: grant.grantId,
      grantToken: `${grant.grantToken.slice(0, -1)}x`,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId: "request-wrong-grant-token",
      runtime: { now: NOW },
      shopId: SHOP_ID,
    })).rejects.toMatchObject({ code: "private_download_grant_not_found", status: 404 });
    await expect(consumeWebsitePrivateDownloadGrant({
      env,
      grantId: grant.grantId,
      grantToken: grant.grantToken,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId: "request-expired-grant",
      runtime: { now: new Date(NOW.getTime() + 601_000) },
      shopId: SHOP_ID,
    })).rejects.toMatchObject({ code: "private_download_grant_not_found", status: 404 });

    const entitlement = database.prepare("SELECT id FROM digital_entitlements LIMIT 1").get() as { id: string };
    await revokePrivateDownloadEntitlement({ entitlementId: entitlement.id, env, requestId: "request-revoke", shopPublicId: SHOP_PUBLIC_ID, userId: USER_ID });
    await expect(consumeWebsitePrivateDownloadGrant({
      env,
      grantId: grant.grantId,
      grantToken: grant.grantToken,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId: "request-revoked-grant",
      runtime: { now: NOW },
      shopId: SHOP_ID,
    })).rejects.toMatchObject({ code: "private_download_grant_not_found", status: 404 });
  });

  it("does not consume quota when the private object fails integrity", async () => {
    const asset = await provision(1);
    const grant = await issue(asset.assetVersionId);
    const version = database.prepare("SELECT object_key AS objectKey FROM digital_asset_versions WHERE id = ?").get(asset.assetVersionId) as { objectKey: string };
    r2.objects.set(version.objectKey, new TextEncoder().encode("tampered"));

    await expect(consumeWebsitePrivateDownloadGrant({
      env,
      grantId: grant.grantId,
      grantToken: grant.grantToken,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId: "request-integrity-failure",
      runtime: { now: NOW },
      shopId: SHOP_ID,
    })).rejects.toMatchObject({ code: "private_download_integrity_failed", status: 500 });
    expect(database.prepare("SELECT download_count AS downloadCount, status FROM digital_entitlements").get()).toEqual({ downloadCount: 0, status: "active" });
    expect(database.prepare("SELECT status FROM delivery_grants").get()).toEqual({ status: "active" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grant_claims").get()).toEqual({ count: 0 });
  });

  it("rechecks paid order state before committing a download consumption", async () => {
    const asset = await provision(1);
    const grant = await issue(asset.assetVersionId);
    const d1 = env.PLATFORM_DB as unknown as {
      batch: (statements: unknown[]) => Promise<Array<{ meta: { changes: number } }>>;
    };
    const originalBatch = d1.batch.bind(d1);
    d1.batch = (statements) => {
      if (statements.some((statement) => {
        const sql = (statement as { sql: string }).sql;
        return sql.includes("INSERT INTO delivery_grant_claims") || sql.includes("INSERT INTO delivery_grant_consumptions");
      })) {
        database.prepare("UPDATE orders SET status = 'canceled', payment_status = 'failed' WHERE id = ? AND shop_id = ?")
          .run("order-private-a", SHOP_ID);
      }
      return originalBatch(statements);
    };

    await expect(consumeWebsitePrivateDownloadGrant({
      env,
      grantId: grant.grantId,
      grantToken: grant.grantToken,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId: "request-payment-race-consume",
      runtime: { now: NOW },
      shopId: SHOP_ID,
    })).rejects.toMatchObject({ code: "private_download_grant_not_found", status: 404 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grant_consumptions").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT download_count AS downloadCount FROM digital_entitlements").get()).toEqual({ downloadCount: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM delivery_grant_claims").get()).toEqual({ count: 0 });
    expect(r2.getCalls).toBe(0);
    expect(r2.arrayBufferCalls).toBe(0);
  });

  it("keeps grant tokens and object keys out of audit and outbox payloads", async () => {
    const asset = await provision(1);
    const grant = await issue(asset.assetVersionId);
    await consumeWebsitePrivateDownloadGrant({
      env,
      grantId: grant.grantId,
      grantToken: grant.grantToken,
      orderPublicId: ORDER_PUBLIC_ID,
      orderToken: ORDER_TOKEN,
      requestId: "request-redaction",
      runtime: { now: NOW },
      shopId: SHOP_ID,
    });
    const auditJson = JSON.stringify(database.prepare("SELECT action, resource_id AS resourceId, safe_metadata_json AS safeMetadataJson FROM audit_logs ORDER BY created_at, id").all());
    const objectKey = (database.prepare("SELECT object_key AS objectKey FROM digital_asset_versions WHERE id = ?").get(asset.assetVersionId) as { objectKey: string }).objectKey;
    expect(auditJson).not.toContain(grant.grantToken);
    expect(auditJson).not.toContain(ORDER_TOKEN);
    expect(auditJson).not.toContain(objectKey);
    expect(database.prepare("SELECT COUNT(*) AS count FROM outbox_jobs").get()).toEqual({ count: 0 });
  });
});
