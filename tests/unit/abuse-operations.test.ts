import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppError } from "../../src/lib/core/errors";
import { updateProduct } from "../../src/lib/catalog/store";
import {
  applyModerationAction,
  createPublicAbuseReport,
  listAdminAbuseReports,
  listOwnerAbuseReports,
  sanitizeAbuseSummary,
  transitionAbuseReport,
} from "../../src/lib/operations/abuse";
import { createOperationsAuditEvent } from "../../src/lib/operations/audit";
import type { AppBindings } from "../../src/lib/platform/bindings";
import type { StorefrontShop } from "../../src/lib/storefront/store";

const NOW = new Date("2026-07-26T04:00:00.000Z");
const PRODUCT_A = "prd_00000000-0000-4000-8000-000000000001";
const PRODUCT_B = "prd_00000000-0000-4000-8000-000000000002";
const VARIANT_A = "var_00000000-0000-4000-8000-000000000001";

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    const sqlValues = values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    });
    return new SqliteStatement(this.database, this.sql, sqlValues);
  }

  first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.values) as T | undefined;
    return Promise.resolve(row ?? null);
  }

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

function bindings(database: DatabaseSync): AppBindings {
  const platformDb = {
    async batch(statements: D1PreparedStatement[]) {
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
    prepare(sql: string) {
      return new SqliteStatement(database, sql) as unknown as D1PreparedStatement;
    },
  };
  return {
    APP_ENV: "local",
    IDENTIFIER_HMAC_SECRET: "identifier-secret-for-abuse-tests",
    PLATFORM_DB: platformDb,
    SESSION_SECRET: "session-secret-for-abuse-tests",
  } as unknown as AppBindings;
}

function seed(database: DatabaseSync): void {
  const now = NOW.toISOString();
  database.prepare(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-test', 'test', 'Test plan', '{}', '{}', ?, ?)
  `).run(now, now);
  const users: Array<[string, string]> = [
    ["user-admin", "risk@example.test"],
    ["user-manager-a", "manager-a@example.test"],
    ["user-platform-owner", "platform-owner@example.test"],
    ["user-support", "support@example.test"],
    ["user-owner-a", "owner-a@example.test"],
    ["user-owner-b", "owner-b@example.test"],
  ];
  for (const [id, email] of users) {
    database.prepare(`
      INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `).run(id, email, id, now, now);
  }
  database.prepare(`
    INSERT INTO platform_admins (user_id, role, status, created_at, updated_at)
    VALUES
      ('user-admin', 'risk', 'active', ?, ?),
      ('user-platform-owner', 'owner', 'active', ?, ?),
      ('user-support', 'support', 'active', ?, ?)
  `).run(now, now, now, now, now, now);
  const shops: Array<[string, string, string, string]> = [
    ["shop-a", "shop_00000000-0000-4000-8000-000000000001", "shop-a", "user-owner-a"],
    ["shop-b", "shop_00000000-0000-4000-8000-000000000002", "shop-b", "user-owner-b"],
  ];
  for (const [id, publicId, slug, owner] of shops) {
    database.prepare(`
      INSERT INTO shops (
        id, public_id, slug, name, status, default_locale, currency, timezone,
        readiness_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', 'vi', 'VND', 'Asia/Ho_Chi_Minh', 1, ?, ?)
    `).run(id, publicId, slug, id, now, now);
    database.prepare(`
      INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
      VALUES (?, ?, 'owner', 'active', ?, ?)
    `).run(id, owner, now, now);
    database.prepare(`
      INSERT INTO shop_subscriptions (
        id, shop_id, plan_id, state, current_period_start, current_period_end,
        created_at, updated_at
      ) VALUES (?, ?, 'plan-test', 'active', ?, ?, ?, ?)
    `).run(`sub-${id}`, id, now, new Date(NOW.getTime() + 86_400_000).toISOString(), now, now);
    database.prepare(`
      INSERT INTO shop_domains (
        id, shop_id, hostname_normalized, type, status, is_primary,
        validation_metadata_json, dns_status, version, activated_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'platform_subdomain', 'active', 1, '{}', 'active', 1, ?, ?, ?)
    `).run(`dom-${id}`, id, `${slug}.example.test`, now, now, now);
  }
  database.prepare(`
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('shop-a', 'user-manager-a', 'manager', 'active', ?, ?)
  `).run(now, now);
  const products: Array<[string, string, string]> = [
    [PRODUCT_A, "shop-a", "safe-product"],
    [PRODUCT_B, "shop-b", "other-product"],
  ];
  for (const [id, shopId, slug] of products) {
    database.prepare(`
      INSERT INTO products (
        id, shop_id, category_id, slug, title, description, status,
        fulfillment_type, version, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, ?, '', 'active', 'manual', 1, ?, ?)
    `).run(id, shopId, slug, slug, now, now);
  }
  database.prepare(`
    INSERT INTO product_variants (
      id, shop_id, product_id, sku, title, options_json, price_minor,
      compare_at_minor, currency, min_per_order, max_per_order, status,
      version, created_at, updated_at
    ) VALUES (?, 'shop-a', ?, 'SKU-A', 'Default', '{}', 10000, NULL,
      'VND', 1, 10, 'active', 1, ?, ?)
  `).run(VARIANT_A, PRODUCT_A, now, now);
}

function shopA(): StorefrontShop {
  return {
    access: "live",
    canonicalHostname: "shop-a.example.test",
    content: {},
    currency: "VND",
    currentHostname: "shop-a.example.test",
    defaultLocale: "vi",
    id: "shop-a",
    lowStockThreshold: 5,
    name: "shop-a",
    orderExpiryMinutes: 30,
    publicId: "shop_00000000-0000-4000-8000-000000000001",
    settingsVersion: 1,
    slug: "shop-a",
    status: "active",
    subscriptionState: "active",
    theme: {},
  } as unknown as StorefrontShop;
}

function publicRequest(id: number, userAgent = "abuse-test"): Request {
  return new Request("https://shop-a.example.test/api/store/abuse-reports", {
    headers: { "CF-Connecting-IP": `198.51.100.${String(id)}`, "User-Agent": userAgent },
    method: "POST",
  });
}

describe("abuse and moderation operations", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    seed(database);
    env = bindings(database);
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  it("redacts credential-like material and URL identity before persistence", () => {
    const sanitized = sanitizeAbuseSummary(
      "Trang nay phat tan malware. token: 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef and https://user:pass@example.test/path?buyer=secret#key",
    );
    expect(sanitized).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(sanitized).not.toContain("user:pass");
    expect(sanitized).not.toContain("buyer=secret");
    expect(sanitized).toContain("[redacted]");
  });

  it("creates a tenant-bound report without storing contact plaintext and replays safely", async () => {
    const input = {
      category: "malware" as const,
      env,
      idempotencyKey: "report-request-001",
      now: NOW,
      productSlug: "safe-product",
      reporterContact: "Reporter@Example.Test",
      request: publicRequest(1),
      requestId: "request-abuse-001",
      shop: shopA(),
      summary: "San pham nay co tep thuc thi dang ngo va can duoc kiem tra ngay.",
      targetKind: "product" as const,
    };
    const first = await createPublicAbuseReport(input);
    const replay = await createPublicAbuseReport(input);

    expect(first.created).toBe(true);
    expect(replay).toEqual({ created: false, report: first.report });
    const stored = database.prepare(`
      SELECT shop_id AS shopId, target_ref AS targetRef,
        reporter_contact_hash AS contactHash, summary_sanitized AS summary
      FROM abuse_reports
    `).get() as { contactHash: string; shopId: string; summary: string; targetRef: string };
    expect(stored.shopId).toBe("shop-a");
    expect(stored.targetRef).toBe(PRODUCT_A);
    expect(stored.contactHash).not.toContain("reporter@example.test");
    expect(stored.summary).toContain("kiem tra");
    expect(database.prepare("SELECT COUNT(*) AS count FROM abuse_reports").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT action FROM audit_logs").get()).toEqual({ action: "abuse.report_received" });

    await expect(createPublicAbuseReport({ ...input, summary: "Noi dung khac hoan toan nhung dung lai cung idempotency key." }))
      .rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  it("fails closed outside local when Turnstile configuration is missing", async () => {
    env = { ...env, APP_ENV: "production" };

    await expect(createPublicAbuseReport({
      category: "malware",
      env,
      idempotencyKey: "report-turnstile-missing",
      now: NOW,
      request: publicRequest(21),
      requestId: "request-turnstile-missing",
      shop: shopA(),
      summary: "Bao cao hop le nhung production Turnstile dang bi thieu cau hinh.",
      targetKind: "shop",
    })).rejects.toMatchObject({ code: "turnstile_unavailable", status: 503 });

    expect(database.prepare("SELECT COUNT(*) AS count FROM abuse_reports").get()).toEqual({ count: 0 });
  });

  it("rejects a production report when Turnstile verification fails", async () => {
    env = {
      ...env,
      APP_ENV: "production",
      TURNSTILE_SECRET_KEY: "0xabcdefghijklmnopqrstuvwxyz123456",
      TURNSTILE_SITE_KEY: "0xabcdefghijklmnopqrstuvwxyz123456",
    };
    const providerFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      action: "report_abuse",
      hostname: "shop-a.example.test",
      success: false,
    }), { status: 200 }));
    vi.stubGlobal("fetch", providerFetch);

    await expect(createPublicAbuseReport({
      category: "fraud",
      env,
      idempotencyKey: "report-turnstile-invalid",
      now: NOW,
      request: publicRequest(22),
      requestId: "request-turnstile-invalid",
      shop: shopA(),
      summary: "Bao cao hop le nhung Turnstile provider da tu choi challenge nay.",
      targetKind: "shop",
      turnstileToken: "invalid-turnstile-token",
    })).rejects.toMatchObject({ code: "turnstile_invalid", status: 403 });

    expect(providerFetch).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT COUNT(*) AS count FROM abuse_reports").get()).toEqual({ count: 0 });
  });

  it("rate limits anonymous reports by tenant and pseudonymous actor", async () => {
    for (let index = 0; index < 5; index += 1) {
      await createPublicAbuseReport({
        category: "fraud",
        env,
        idempotencyKey: `report-rate-${String(index).padStart(3, "0")}`,
        now: NOW,
        request: publicRequest(9, `abuse-test-${String(index)}`),
        requestId: `request-rate-${String(index).padStart(3, "0")}`,
        shop: shopA(),
        summary: `Bao cao gian lan hop le thu ${String(index)} voi du thong tin toi thieu.`,
        targetKind: "shop",
      });
    }
    await expect(createPublicAbuseReport({
      category: "fraud",
      env,
      idempotencyKey: "report-rate-999",
      now: NOW,
      request: publicRequest(9, "abuse-test-rotated"),
      requestId: "request-rate-999",
      shop: shopA(),
      summary: "Bao cao vuot qua gioi han cua cung mot actor trong cua so.",
      targetKind: "shop",
    })).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM abuse_reports").get()).toEqual({ count: 5 });
    expect(database.prepare("SELECT COUNT(*) AS rows, MAX(request_count) AS requestCount FROM security_rate_limits WHERE action = 'abuse_report'").get())
      .toEqual({ requestCount: 6, rows: 1 });
  });

  it("keeps owner report views tenant-scoped and hides reporter hashes", async () => {
    await createPublicAbuseReport({
      category: "privacy",
      env,
      idempotencyKey: "owner-list-report",
      now: NOW,
      reporterContact: "private@example.test",
      request: publicRequest(2),
      requestId: "request-owner-list",
      shop: shopA(),
      summary: "Bao cao quyen rieng tu cua shop A voi noi dung da duoc sanitize.",
      targetKind: "shop",
    });
    const owner = await listOwnerAbuseReports({
      cursor: null,
      env,
      shopPublicId: shopA().publicId,
      status: null,
      userId: "user-owner-a",
    });
    expect(owner.reports).toHaveLength(1);
    expect(owner.reports[0]).toMatchObject({ ownerRestoreEligible: false, targetStatus: null });
    expect(owner.reports[0]).not.toHaveProperty("reporterContactHash");
    await expect(listOwnerAbuseReports({
      cursor: null,
      env,
      shopPublicId: "shop_00000000-0000-4000-8000-000000000002",
      status: null,
      userId: "user-owner-a",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });

  it("applies admin product suspension once, preserves tenant scope, and restores prior state", async () => {
    const report = await createPublicAbuseReport({
      category: "prohibited_content",
      env,
      idempotencyKey: "moderation-report-001",
      now: NOW,
      productSlug: "safe-product",
      request: publicRequest(3),
      requestId: "request-moderation-report",
      shop: shopA(),
      summary: "San pham co dau hieu vi pham chinh sach va can tam dung de dieu tra.",
      targetKind: "product",
    });
    const suspendInput = {
      actionKind: "product_suspend" as const,
      actorScope: "platform_admin" as const,
      actorUserId: "user-admin",
      env,
      idempotencyKey: "moderation-action-001",
      now: NOW,
      reasonCode: "reported_abuse",
      reportPublicId: report.report.publicId,
      requestId: "request-moderation-001",
      shopPublicId: shopA().publicId,
      targetId: PRODUCT_A,
    };
    const suspended = await applyModerationAction(suspendInput);
    const replay = await applyModerationAction(suspendInput);
    expect(replay).toEqual(suspended);
    expect(database.prepare("SELECT status FROM products WHERE id = ?").get(PRODUCT_A)).toEqual({ status: "suspended" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM moderation_actions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'moderation.product_suspend'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT status FROM abuse_reports WHERE public_id = ?").get(report.report.publicId)).toEqual({ status: "actioned" });
    const ownerReports = await listOwnerAbuseReports({
      cursor: null,
      env,
      shopPublicId: shopA().publicId,
      status: null,
      userId: "user-owner-a",
    });
    expect(ownerReports.reports[0]).toMatchObject({ ownerRestoreEligible: false, targetStatus: "suspended" });

    await expect(applyModerationAction({ ...suspendInput, idempotencyKey: "moderation-cross-tenant", targetId: PRODUCT_B }))
      .rejects.toMatchObject({ code: "resource_not_found", status: 404 });
    await expect(applyModerationAction({ ...suspendInput, actorUserId: "user-support", idempotencyKey: "support-action-001" }))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    await expect(applyModerationAction({
      ...suspendInput,
      actionKind: "product_restore",
      actorScope: "shop_owner",
      actorUserId: "user-owner-a",
      idempotencyKey: "owner-cannot-restore-platform-action",
      reportPublicId: null,
      requestId: "request-owner-cannot-restore",
    })).rejects.toMatchObject({ code: "moderation_restore_unavailable", status: 409 });
    expect(database.prepare("SELECT status FROM products WHERE id = ?").get(PRODUCT_A)).toEqual({ status: "suspended" });

    const restored = await applyModerationAction({
      ...suspendInput,
      actionKind: "product_restore",
      idempotencyKey: "moderation-action-restore",
      reportPublicId: null,
      requestId: "request-moderation-restore",
    });
    expect(restored.newStatus).toBe("active");
    expect(database.prepare("SELECT status FROM products WHERE id = ?").get(PRODUCT_A)).toEqual({ status: "active" });
    await expect(applyModerationAction({
      ...suspendInput,
      actionKind: "product_restore",
      idempotencyKey: "moderation-action-restore-again",
      reportPublicId: null,
    })).rejects.toMatchObject({ code: "moderation_restore_unavailable", status: 409 });
  });

  it("allows only the exact shop owner to take voluntary product action", async () => {
    const report = await createPublicAbuseReport({
      category: "fraud",
      env,
      idempotencyKey: "owner-moderation-report-001",
      now: NOW,
      productSlug: "safe-product",
      request: publicRequest(11),
      requestId: "request-owner-moderation-report",
      shop: shopA(),
      summary: "Owner can tam ngung san pham nay de chu dong xu ly bao cao hop le.",
      targetKind: "product",
    });
    await applyModerationAction({
      actionKind: "product_suspend",
      actorScope: "shop_owner",
      actorUserId: "user-owner-a",
      env,
      idempotencyKey: "owner-moderation-001",
      now: NOW,
      reasonCode: "voluntary_compliance",
      reportPublicId: report.report.publicId,
      requestId: "request-owner-moderation",
      shopPublicId: shopA().publicId,
      targetId: PRODUCT_A,
    });
    expect(database.prepare("SELECT status FROM products WHERE id = ?").get(PRODUCT_A)).toEqual({ status: "suspended" });
    const suspendedReports = await listOwnerAbuseReports({
      cursor: null,
      env,
      shopPublicId: shopA().publicId,
      status: null,
      userId: "user-owner-a",
    });
    expect(suspendedReports.reports[0]).toMatchObject({
      ownerRestoreEligible: true,
      publicId: report.report.publicId,
      status: "actioned",
      targetStatus: "suspended",
    });
    const editedWhileSuspended = await updateProduct({
      data: {
        categoryId: null,
        description: "owner remediation notes without restoring sale",
        fulfillmentType: "manual",
        slug: "safe-product",
        status: "suspended",
        title: "safe-product",
      },
      env,
      productId: PRODUCT_A,
      shopPublicId: shopA().publicId,
      userId: "user-owner-a",
    }) as { description: string; status: string };
    expect(editedWhileSuspended).toMatchObject({
      description: "owner remediation notes without restoring sale",
      status: "suspended",
    });
    await expect(updateProduct({
      data: {
        categoryId: null,
        description: "attempted unaudited owner restore",
        fulfillmentType: "manual",
        slug: "safe-product",
        status: "active",
        title: "safe-product",
      },
      env,
      productId: PRODUCT_A,
      shopPublicId: shopA().publicId,
      userId: "user-owner-a",
    })).rejects.toMatchObject({ code: "moderation_state_conflict", status: 409 });
    await expect(applyModerationAction({
      actionKind: "product_suspend",
      actorScope: "shop_owner",
      actorUserId: "user-owner-a",
      env,
      idempotencyKey: "owner-moderation-cross-tenant",
      now: NOW,
      reasonCode: "voluntary_compliance",
      requestId: "request-owner-cross",
      shopPublicId: "shop_00000000-0000-4000-8000-000000000002",
      targetId: PRODUCT_B,
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });

    const restored = await applyModerationAction({
      actionKind: "product_restore",
      actorScope: "shop_owner",
      actorUserId: "user-owner-a",
      env,
      idempotencyKey: "owner-moderation-restore-001",
      now: new Date(NOW.getTime() + 1),
      reasonCode: "voluntary_compliance",
      reportPublicId: report.report.publicId,
      requestId: "request-owner-moderation-restore",
      shopPublicId: shopA().publicId,
      targetId: PRODUCT_A,
    });
    expect(restored.newStatus).toBe("active");
    expect(database.prepare("SELECT status FROM products WHERE id = ?").get(PRODUCT_A)).toEqual({ status: "active" });
    const restoredReports = await listOwnerAbuseReports({
      cursor: null,
      env,
      shopPublicId: shopA().publicId,
      status: null,
      userId: "user-owner-a",
    });
    expect(restoredReports.reports[0]).toMatchObject({ ownerRestoreEligible: false, targetStatus: "active" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action LIKE 'moderation.product_%'").get())
      .toEqual({ count: 2 });
  });

  it("blocks owner and manager catalog updates from overriding a platform suspension", async () => {
    await applyModerationAction({
      actionKind: "product_suspend",
      actorScope: "platform_admin",
      actorUserId: "user-admin",
      env,
      idempotencyKey: "catalog-platform-suspend-001",
      now: NOW,
      reasonCode: "reported_abuse",
      requestId: "request-catalog-platform-suspend",
      shopPublicId: shopA().publicId,
      targetId: PRODUCT_A,
    });

    for (const userId of ["user-owner-a", "user-manager-a"]) {
      await expect(updateProduct({
        data: {
          categoryId: null,
          description: "attempted override",
          fulfillmentType: "manual",
          slug: "safe-product",
          status: "active",
          title: "Safe product",
        },
        env,
        productId: PRODUCT_A,
        shopPublicId: shopA().publicId,
        userId,
      })).rejects.toMatchObject({ code: "moderation_state_conflict", status: 409 });
    }
    expect(database.prepare("SELECT status, description FROM products WHERE id = ?").get(PRODUCT_A))
      .toEqual({ description: "", status: "suspended" });
  });

  it("triages idempotently for support admins and keeps the audit ledger immutable", async () => {
    const report = await createPublicAbuseReport({
      category: "other",
      env,
      idempotencyKey: "triage-report-001",
      now: NOW,
      request: publicRequest(4),
      requestId: "request-triage-report",
      shop: shopA(),
      summary: "Bao cao can duoc support triage truoc khi risk admin quyet dinh.",
      targetKind: "shop",
    });
    const input = {
      adminUserId: "user-support",
      env,
      idempotencyKey: "triage-action-001",
      now: NOW,
      reportPublicId: report.report.publicId,
      requestId: "request-triage-action",
      status: "triaged" as const,
    };
    const first = await transitionAbuseReport(input);
    const replay = await transitionAbuseReport(input);
    expect(replay).toEqual(first);
    expect((await listAdminAbuseReports({ cursor: null, env, status: "triaged", userId: "user-support" })).reports).toHaveLength(1);
    const auditId = (database.prepare("SELECT id FROM audit_logs WHERE action = 'abuse.report_status_changed'").get() as { id: string }).id;
    expect(() => database.prepare("UPDATE audit_logs SET action = 'changed' WHERE id = ?").run(auditId))
      .toThrow(/audit_logs_immutable/u);

    await expect(transitionAbuseReport({
      ...input,
      idempotencyKey: "support-dismiss-denied",
      requestId: "request-support-dismiss-denied",
      status: "dismissed",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    await expect(transitionAbuseReport({
      ...input,
      idempotencyKey: "support-close-denied",
      requestId: "request-support-close-denied",
      status: "closed",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    expect(database.prepare("SELECT status FROM abuse_reports WHERE public_id = ?").get(report.report.publicId))
      .toEqual({ status: "triaged" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'abuse.report_status_changed'").get())
      .toEqual({ count: 1 });

    await expect(transitionAbuseReport({
      ...input,
      adminUserId: "user-admin",
      idempotencyKey: "risk-dismiss-allowed",
      requestId: "request-risk-dismiss-allowed",
      status: "dismissed",
    })).resolves.toMatchObject({ status: "dismissed" });
    await expect(transitionAbuseReport({
      ...input,
      adminUserId: "user-admin",
      idempotencyKey: "risk-close-allowed",
      requestId: "request-risk-close-allowed",
      status: "closed",
    })).resolves.toMatchObject({ status: "closed" });
  });

  it("keeps investigation and decision transitions owner/risk-only", async () => {
    const supportReport = await createPublicAbuseReport({
      category: "other",
      env,
      idempotencyKey: "support-boundary-report-001",
      now: NOW,
      request: publicRequest(5),
      requestId: "request-support-boundary-report",
      shop: shopA(),
      summary: "Bao cao de xac minh support chi duoc phan loai triage.",
      targetKind: "shop",
    });
    const supportInput = {
      adminUserId: "user-support",
      env,
      now: NOW,
      reportPublicId: supportReport.report.publicId,
    };
    await expect(transitionAbuseReport({
      ...supportInput,
      idempotencyKey: "support-investigate-received-denied",
      requestId: "request-support-investigate-received-denied",
      status: "investigating",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    expect(database.prepare("SELECT status FROM abuse_reports WHERE public_id = ?").get(supportReport.report.publicId))
      .toEqual({ status: "received" });

    await transitionAbuseReport({
      ...supportInput,
      idempotencyKey: "support-triage-boundary-allowed",
      requestId: "request-support-triage-boundary-allowed",
      status: "triaged",
    });
    for (const status of ["investigating", "actioned"] as const) {
      await expect(transitionAbuseReport({
        ...supportInput,
        idempotencyKey: `support-${status}-triaged-denied`,
        requestId: `request-support-${status}-triaged-denied`,
        status,
      })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    }
    expect(database.prepare("SELECT status FROM abuse_reports WHERE public_id = ?").get(supportReport.report.publicId))
      .toEqual({ status: "triaged" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'abuse.report_status_changed'").get())
      .toEqual({ count: 1 });

    await expect(transitionAbuseReport({
      ...supportInput,
      adminUserId: "user-admin",
      idempotencyKey: "risk-investigate-triaged-allowed",
      requestId: "request-risk-investigate-triaged-allowed",
      status: "investigating",
    })).resolves.toMatchObject({ status: "investigating" });

    const ownerReport = await createPublicAbuseReport({
      category: "other",
      env,
      idempotencyKey: "owner-boundary-report-001",
      now: NOW,
      request: publicRequest(6),
      requestId: "request-owner-boundary-report",
      shop: shopA(),
      summary: "Bao cao de xac minh platform owner co quyen dieu tra.",
      targetKind: "shop",
    });
    await expect(transitionAbuseReport({
      adminUserId: "user-platform-owner",
      env,
      idempotencyKey: "owner-investigate-received-allowed",
      now: NOW,
      reportPublicId: ownerReport.report.publicId,
      requestId: "request-owner-investigate-received-allowed",
      status: "investigating",
    })).resolves.toMatchObject({ status: "investigating" });
  });

  it("rejects unsafe audit metadata fields before a statement is created", () => {
    expect(() => createOperationsAuditEvent({
      action: "moderation.product_suspend",
      actorId: "user-admin",
      actorType: "platform_admin",
      metadata: { token: "must-not-enter-audit" },
      now: NOW,
      requestId: "request-audit-safe",
      resourceId: PRODUCT_A,
      resourceType: "product",
      shopId: "shop-a",
    })).toThrow(expect.objectContaining<Partial<AppError>>({ code: "operations_audit_invalid" }));
  });
});
