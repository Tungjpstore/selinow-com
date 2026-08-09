import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";

const members = new Map([
  ["shop-a", { row: { shop_id: "shop-a", role: "owner" }, shop: { name: "Shop A" } }],
  ["shop-b", { row: { shop_id: "shop-b", role: "owner" }, shop: { name: "Shop B" } }],
  ["shop-support", { row: { shop_id: "shop-support", role: "support" }, shop: { name: "Support Shop" } }],
  ["shop-viewer", { row: { shop_id: "shop-viewer", role: "viewer" }, shop: { name: "Viewer Shop" } }],
]);

vi.mock("../../src/lib/tenants/store", () => ({
  getShopForMember: vi.fn((input: { capability: string; shopPublicId: string }) => {
    const member = members.get(input.shopPublicId);
    if (member === undefined || (member.row.role === "support" && input.capability !== "shop:read")) {
      return Promise.reject(Object.assign(new Error("authorization_denied"), { code: "authorization_denied", status: 403 }));
    }
    return Promise.resolve(member);
  }),
}));

import { getSellerOrder, listSellerOrders, listSellerOrdersPage } from "../../src/lib/commerce/seller-orders";
import { parsePublicApiPage } from "../../src/lib/api/pagination";
import { listSellerAuditEntries } from "../../src/lib/operations/seller-audit";
import { getSellerBilling, listSellerCustomers, listSellerCustomersPage, listSellerMembers } from "../../src/lib/tenants/seller-management";
import { getSellerCustomer } from "../../src/lib/tenants/customer-management";
import { getSellerStorefrontSettings, updateSellerStorefrontSettings } from "../../src/lib/tenants/storefront-settings";
import { getShopForMember } from "../../src/lib/tenants/store";

type Call = { sql: string; values: unknown[] };

class FakeDatabase {
  readonly calls: Call[] = [];
  private branding = JSON.stringify({ primaryColor: "#5B5CEB", accentColor: "#F6C344" });
  private storefront = JSON.stringify({ headline: "Cửa hàng A", announcement: "Mở bán" });
  private version = 1;
  private publishedVersion = 1;
  private publishedAt = "2026-07-28T00:00:00.000Z";

  prepare(sql: string): D1PreparedStatement {
    const { calls } = this;
    const readState = () => ({ branding: this.branding, storefront: this.storefront, version: this.version, publishedVersion: this.publishedVersion, publishedAt: this.publishedAt });
    const writeState = (branding: string, storefront: string) => { this.branding = branding; this.storefront = storefront; this.version += 1; };
    const all = () => Promise.resolve({ results: [] });
    return {
      all,
      bind: (...values: unknown[]) => {
        calls.push({ sql, values });
        return {
          all() {
            if (sql.includes("source_kind AS sourceKind")) {
              return Promise.resolve({ results: values[0] === "shop-a" ? [{ id: "aud-a", actorType: "user", action: "inventory.imported", resourceType: "inventory_batch", resourceId: "batch-a", requestId: "request-a", createdAt: "2026-07-28T00:02:00.000Z", sourceKind: "application", operationId: null, retentionClass: "standard" }] : [] });
            }
            if (sql.includes("FROM shop_customers")) {
              return Promise.resolve({ results: ["shop-a", "shop-support", "shop-viewer"].includes(String(values[0])) ? [{ id: "customer-internal-a", displayName: "Khách A", email: "customer-a@example.test", locale: "vi", status: "active", createdAt: "2026-07-28T00:00:00.000Z", orderCount: 2, lastOrderAt: "2026-07-28T00:05:00.000Z" }] : [] });
            }
            if (sql.includes("FROM shop_members")) {
              return Promise.resolve({ results: values[0] === "shop-a" ? [{ userId: "user-internal-a", displayName: "Owner A", email: "owner-a@example.test", memberPublicId: "mbr_00000000-0000-4000-8000-0000000000a1", role: "owner", status: "active", createdAt: "2026-07-28T00:00:00.000Z", version: 1 }] : [] });
            }
            if (sql.includes("FROM usage_counters")) {
              return Promise.resolve({ results: values[0] === "shop-a" ? [{ metric: "orders_month", periodKey: "2026-07", value: 12, updatedAt: "2026-07-28T00:00:00.000Z" }] : [] });
            }
            if (sql.includes("FROM orders")) {
              return Promise.resolve({ results: values[0] === "shop-a" ? [{ orderId: "order-a", orderNumber: "A-1", customerEmail: "a***@example.test", status: "completed", paymentStatus: "paid", fulfillmentStatus: "fulfilled", sourceChannel: "web", totalMinor: 199000, currency: "VND", createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z", itemCount: 1, primaryItem: "Product A" }] : [] });
            }
            if (sql.includes("FROM order_items")) return Promise.resolve({ results: [{ id: "item-a", productTitle: "Product A", variantTitle: "Key", sku: "A-1", unitPriceMinor: 199000, quantity: 1, lineTotalMinor: 199000, fulfillmentType: "license_key" }] });
            if (sql.includes("FROM payment_attempts")) return Promise.resolve({ results: [{ provider: "payos", state: "paid_exact", expectedAmountMinor: 199000, expiresAt: "2026-07-28T01:00:00.000Z", lastSafeErrorCode: null, createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:00:00.000Z" }] });
            if (sql.includes("FROM payment_exceptions")) return Promise.resolve({ results: values[0] === "shop-a" && values[1] === "internal-a" ? [{ createdAt: "2026-07-28T00:02:00.000Z", currency: "VND", id: "pex-a", paymentAttemptId: "payatt-a", status: "open", type: "partial" }] : [] });
            if (sql.includes("FROM payment_remediation_requests")) return Promise.resolve({ results: values[0] === "shop-a" && values[1] === "internal-a" ? [{ amountMinor: 0, createdAt: "2026-07-28T00:03:00.000Z", currency: "VND", exceptionId: "pex-a", failureCode: null, kind: "manual_review", reasonCode: "seller_requested", requestPublicId: "prem-a", reviewedAt: null, status: "requested", updatedAt: "2026-07-28T00:03:00.000Z", version: 1 }] : [] });
            if (sql.includes("FROM fulfillments")) return Promise.resolve({ results: [{ type: "digital_keys", state: "fulfilled", createdAt: "2026-07-28T00:00:00.000Z", fulfilledAt: "2026-07-28T00:01:00.000Z", failedAt: null }] });
            if (sql.includes("FROM audit_logs")) return Promise.resolve({ results: [{ action: "order.fulfilled", createdAt: "2026-07-28T00:01:00.000Z" }] });
            return Promise.resolve({ results: [] });
          },
          first() {
            if (sql.includes("FROM shop_settings")) { const state = readState(); return Promise.resolve({ brandingJson: state.branding, storefrontJson: state.storefront, version: state.version, publishedVersion: state.publishedVersion, publishedAt: state.publishedAt }); }
            if (sql.includes("FROM shop_subscriptions")) {
              return Promise.resolve(values[0] === "shop-a" ? { planCode: "store", planName: "Store", planVersion: 7, featuresJson: '{"storefront":true}', limitsJson: '{"orders_month":100}', state: "active", trialEndsAt: null, currentPeriodStart: "2026-07-01T00:00:00.000Z", currentPeriodEnd: "2026-08-01T00:00:00.000Z", graceEndsAt: null, canceledAt: null, marketCode: "vn", priceCurrency: "VND", priceAmountMinor: 99000, priceInterval: "month" } : null);
            }
            if (sql.startsWith("UPDATE shop_settings")) { writeState(String(values[0]), String(values[1])); return Promise.resolve({ version: readState().version }); }
            if (sql.includes("FROM orders")) {
              const isSellerA = values[0] === "shop-a";
              const isOrderA = values[1] === "order-a";
              if (!isSellerA || !isOrderA) return Promise.resolve(null);
              return Promise.resolve({ internalId: "internal-a", orderId: "order-a", orderNumber: "A-1", customerEmail: "a***@example.test", status: "completed", paymentStatus: "paid", fulfillmentStatus: "fulfilled", sourceChannel: "web", totalMinor: 199000, currency: "VND", expiresAt: "2026-07-28T01:00:00.000Z", paidAt: "2026-07-28T00:00:00.000Z", fulfilledAt: "2026-07-28T00:01:00.000Z", createdAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-07-28T00:01:00.000Z", itemCount: 1, primaryItem: "Product A" });
            }
            return Promise.resolve(null);
          },
          run() {
            return Promise.resolve({ meta: { changes: 1 } });
          },
        } as unknown as D1PreparedStatement;
      },
    } as unknown as D1PreparedStatement;
  }

  batch(statements: D1PreparedStatement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

class KeysetDatabase {
  readonly calls: Call[] = [];

  prepare(sql: string): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => {
        this.calls.push({ sql, values });
        return {
          all: () => {
            if (sql.includes("FROM orders")) {
              const rows = values[1] === null
                ? [
                  { orderId: "order-new", orderNumber: "A-2", customerEmail: null, status: "pending", paymentStatus: "pending", fulfillmentStatus: "pending", sourceChannel: "web", totalMinor: 200, currency: "USD", createdAt: "2026-07-28T00:02:00.000Z", updatedAt: "2026-07-28T00:02:00.000Z", itemCount: 1, primaryItem: "New" },
                  { orderId: "order-old", orderNumber: "A-1", customerEmail: null, status: "completed", paymentStatus: "paid", fulfillmentStatus: "fulfilled", sourceChannel: "web", totalMinor: 100, currency: "USD", createdAt: "2026-07-28T00:01:00.000Z", updatedAt: "2026-07-28T00:01:00.000Z", itemCount: 1, primaryItem: "Old" },
                ]
                : [{ orderId: "order-old", orderNumber: "A-1", customerEmail: null, status: "completed", paymentStatus: "paid", fulfillmentStatus: "fulfilled", sourceChannel: "web", totalMinor: 100, currency: "USD", createdAt: "2026-07-28T00:01:00.000Z", updatedAt: "2026-07-28T00:01:00.000Z", itemCount: 1, primaryItem: "Old" }];
              return { results: rows };
            }
            if (sql.includes("FROM customer_summary")) {
              const rows = values[1] === null
                ? [
                  { id: "customer-new", publicId: "customer-new", version: 1, displayName: "New", email: "new@example.test", locale: "en", status: "active", createdAt: "2026-07-28T00:00:00.000Z", orderCount: 1, lastOrderAt: "2026-07-28T00:02:00.000Z", cursorCreatedAt: "2026-07-28T00:02:00.000Z" },
                  { id: "customer-old", publicId: "customer-old", version: 1, displayName: "Old", email: "old@example.test", locale: "en", status: "active", createdAt: "2026-07-28T00:00:00.000Z", orderCount: 0, lastOrderAt: null, cursorCreatedAt: "2026-07-28T00:00:00.000Z" },
                ]
                : [{ id: "customer-old", publicId: "customer-old", version: 1, displayName: "Old", email: "old@example.test", locale: "en", status: "active", createdAt: "2026-07-28T00:00:00.000Z", orderCount: 0, lastOrderAt: null, cursorCreatedAt: "2026-07-28T00:00:00.000Z" }];
              return { results: rows };
            }
            return { results: [] };
          },
        };
      },
    } as unknown as D1PreparedStatement;
  }
}

type SellerTestDatabase = {
  batch?: (statements: D1PreparedStatement[]) => unknown;
  prepare(sql: string): D1PreparedStatement;
};

function env(database: SellerTestDatabase): AppBindings {
  return { PLATFORM_DB: database } as unknown as AppBindings;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("seller surface contracts", () => {
  it("uses opaque keyset cursors for order pages", async () => {
    const database = new KeysetDatabase();
    const first = await listSellerOrdersPage({ env: env(database), limit: 1, shopPublicId: "shop-a", userId: "user-a" });
    expect(first.orders.map((order) => order.orderId)).toEqual(["order-new"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(database.calls[0]?.sql).not.toContain("OFFSET");

    const cursor = parsePublicApiPage(new URL(`https://seller.selinow.invalid/?cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).cursor;
    expect(cursor).toEqual({ createdAt: "2026-07-28T00:02:00.000Z", id: "order-new" });
    const second = await listSellerOrdersPage({ cursor: first.nextCursor, env: env(database), limit: 1, shopPublicId: "shop-a", userId: "user-a" });
    expect(second.orders.map((order) => order.orderId)).toEqual(["order-old"]);
    expect(database.calls[1]?.values).toEqual(["shop-a", cursor?.createdAt, cursor?.createdAt, cursor?.createdAt, cursor?.id, 2]);
  });

  it("uses the recency keyset for customer pages without offset scans", async () => {
    const database = new KeysetDatabase();
    const first = await listSellerCustomersPage({ env: env(database), limit: 1, shopPublicId: "shop-a", userId: "user-a" });
    expect(first.customers.map((customer) => customer.publicId)).toEqual(["customer-new"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(database.calls[0]?.sql).not.toContain("OFFSET");

    const cursor = parsePublicApiPage(new URL(`https://seller.selinow.invalid/?cursor=${encodeURIComponent(first.nextCursor ?? "")}`)).cursor;
    expect(cursor).toEqual({ createdAt: "2026-07-28T00:02:00.000Z", id: "customer-new" });
    const second = await listSellerCustomersPage({ cursor: first.nextCursor, env: env(database), limit: 1, shopPublicId: "shop-a", userId: "user-a" });
    expect(second.customers.map((customer) => customer.publicId)).toEqual(["customer-old"]);
    expect(database.calls[1]?.values).toEqual(["shop-a", cursor?.createdAt, cursor?.createdAt, cursor?.createdAt, cursor?.id, 2]);
  });

  it("keeps order list/detail queries bound to the resolved tenant", async () => {
    const database = new FakeDatabase();
    const result = await listSellerOrders({ env: env(database), shopPublicId: "shop-a", userId: "user-a" });
    expect(result).toHaveLength(1);
    expect(database.calls.every((call) => call.values[0] === "shop-a")).toBe(true);
    const orderListCall = database.calls.find((call) => call.sql.includes("FROM orders"));
    expect(orderListCall?.sql).not.toContain("OFFSET");
    expect(orderListCall?.sql).toContain("orders.created_at < ?");
    await expect(getSellerOrder({ env: env(database), shopPublicId: "shop-b", orderPublicId: "order-a", userId: "user-b" })).rejects.toMatchObject({ code: "order_not_found" });
  });

  it("projects order-specific payment exceptions and remediation without cross-tenant queries", async () => {
    const database = new FakeDatabase();
    const detail = await getSellerOrder({ env: env(database), shopPublicId: "shop-a", orderPublicId: "order-a", userId: "user-a" });

    expect(detail.paymentExceptions).toEqual([expect.objectContaining({ id: "pex-a", paymentAttemptId: "payatt-a", status: "open", type: "partial" })]);
    expect(detail.remediationRequests).toEqual([expect.objectContaining({ exceptionId: "pex-a", kind: "manual_review", requestPublicId: "prem-a", status: "requested" })]);
    for (const table of ["payment_exceptions", "payment_remediation_requests"]) {
      const call = database.calls.find((candidate) => candidate.sql.includes(`FROM ${table}`));
      expect(call?.sql).toContain("shop_id = ?");
      expect(call?.sql).toContain("order_id = ?");
      expect(call?.values).toEqual(["shop-a", "internal-a"]);
    }
    expect(JSON.stringify(detail)).not.toContain("safe_evidence_json");
    expect(JSON.stringify(detail)).not.toContain("provider_reference");
  });

  it("keeps seller remediation UI manual-review-only and surfaces safe request identifiers", async () => {
    const orderPage = await readFile("src/pages/app/orders/[id].astro", "utf8");

    expect(orderPage).toContain("data-payment-remediation");
    expect(orderPage).toContain('kind: "manual_review"');
    expect(orderPage).not.toContain('kind: "partial_refund"');
    expect(orderPage).not.toContain('kind: "refund"');
    expect(orderPage).toContain("body.code");
    expect(orderPage).toContain("body.requestId");
    expect(orderPage).toContain("data-idempotency-key");
  });

  it("sanitizes storefront settings and permits clearing optional announcement", async () => {
    const database = new FakeDatabase();
    const current = await getSellerStorefrontSettings({ env: env(database), shopPublicId: "shop-a", userId: "user-a" });
    expect(current.theme.brand).toBe("#5B5CEB");
    await expect(updateSellerStorefrontSettings({ env: env(database), shopPublicId: "shop-a", userId: "user-a", expectedVersion: 1, data: { logoUrl: "http://unsafe.example" } })).rejects.toMatchObject({ code: "validation_failed" });
    const updated = await updateSellerStorefrontSettings({ env: env(database), shopPublicId: "shop-a", userId: "user-a", expectedVersion: 1, data: { announcement: "", deliveryText: "  Giao mã sau khi xác minh  ", headline: "  Tên   mới  ", logoUrl: "https://cdn.example/logo.png", primaryColor: "#ffffff", seoDescription: "Mô tả SEO", seoTitle: "Tiêu đề SEO" } });
    expect(updated.content.announcement).toBeNull();
    expect(updated.content.headline).toBe("Tên mới");
    expect(updated.content.deliveryText).toBe("Giao mã sau khi xác minh");
    expect(updated.content.seoDescription).toBe("Mô tả SEO");
    expect(updated.content.seoTitle).toBe("Tiêu đề SEO");
    expect(database.calls.some((call) => call.sql.startsWith("UPDATE shop_settings") && call.values.includes("shop-a"))).toBe(true);
  });

  it("limits seller audit reads to the resolved owner tenant", async () => {
    const database = new FakeDatabase();
    const entries = await listSellerAuditEntries({ env: env(database), shopPublicId: "shop-a", userId: "user-a" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("actorId");
    expect(entries[0]).not.toHaveProperty("metadataJson");
    expect(database.calls.at(-1)?.values).toEqual(["shop-a", 100]);
    await expect(listSellerAuditEntries({ env: env(database), shopPublicId: "shop-support", userId: "user-support" }))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });

  it("returns tenant-bound customer projections without raw identity fields", async () => {
    const database = new FakeDatabase();
    const customers = await listSellerCustomers({ env: env(database), shopPublicId: "shop-a", userId: "user-a" });
    expect(customers).toEqual([{
      createdAt: "2026-07-28T00:00:00.000Z",
      displayName: "Khách A",
      emailMasked: "cu********@example.test",
      lastOrderAt: "2026-07-28T00:05:00.000Z",
      locale: "vi",
      orderCount: 2,
      publicId: "customer-internal-a",
      status: "active",
      version: 1,
    }]);
    expect(customers[0]).not.toHaveProperty("email");
    expect(customers[0]).not.toHaveProperty("id");
    const customerListCall = database.calls.find((call) => call.sql.includes("FROM shop_customers"));
    expect(customerListCall?.values).toEqual(["shop-a", null, null, null, null, 101]);
    expect(customerListCall?.sql).not.toContain("OFFSET");
    expect(customerListCall?.sql).toContain("cursorCreatedAt < ?");
    await expect(listSellerCustomers({ env: env(database), shopPublicId: "shop-b", userId: "user-b" })).resolves.toEqual([]);
  });

  it("redacts customer projections by support/viewer role and blocks viewer detail", async () => {
    const database = new FakeDatabase();
    await expect(listSellerCustomers({ env: env(database), shopPublicId: "shop-support", userId: "user-support" })).resolves.toEqual([{
      createdAt: "2026-07-28T00:00:00.000Z",
      displayName: "K******",
      emailMasked: "cu********@example.test",
      lastOrderAt: "2026-07-28T00:05:00.000Z",
      locale: "vi",
      orderCount: 2,
      publicId: "customer-internal-a",
      status: "active",
      version: 1,
    }]);
    await expect(listSellerCustomers({ env: env(database), shopPublicId: "shop-viewer", userId: "user-viewer" })).resolves.toEqual([{
      createdAt: null,
      displayName: null,
      emailMasked: null,
      lastOrderAt: "2026-07-28T00:05:00.000Z",
      locale: null,
      orderCount: 2,
      publicId: "customer-internal-a",
      status: "active",
      version: 1,
    }]);
    await expect(getSellerCustomer({ env: env(database), customerPublicId: "customer-internal-a", shopPublicId: "shop-viewer", userId: "user-viewer" }))
      .rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });

  it("uses team and billing capabilities and strips internal member identities", async () => {
    const database = new FakeDatabase();
    const membersResult = await listSellerMembers({ env: env(database), shopPublicId: "shop-a", userId: "user-a" });
    const billing = await getSellerBilling({ env: env(database), shopPublicId: "shop-a", userId: "user-a" });

    expect(membersResult).toEqual([{
      createdAt: "2026-07-28T00:00:00.000Z",
      displayName: "Owner A",
      emailMasked: "ow*****@example.test",
      memberPublicId: "mbr_00000000-0000-4000-8000-0000000000a1",
      role: "owner",
      status: "active",
      version: 1,
    }]);
    expect(membersResult[0]).not.toHaveProperty("email");
    expect(membersResult[0]).not.toHaveProperty("userId");
    expect(billing).toMatchObject({
      features: { storefront: true },
      limits: { orders_month: 100 },
      planCode: "store",
      planVersion: 7,
      currentPrice: { amountMinor: 99000, currency: "VND", interval: "month", marketCode: "vn" },
      state: "active",
      usage: [{ metric: "orders_month", periodKey: "2026-07", value: 12 }],
    });
    expect(vi.mocked(getShopForMember)).toHaveBeenCalledWith(expect.objectContaining({ capability: "team:manage" }));
    expect(vi.mocked(getShopForMember)).toHaveBeenCalledWith(expect.objectContaining({ capability: "billing:manage" }));
    expect(database.calls.filter((call) => call.sql.includes("shop_subscriptions") || call.sql.includes("usage_counters")).every((call) => call.values[0] === "shop-a")).toBe(true);
    await expect(listSellerMembers({ env: env(database), shopPublicId: "shop-support", userId: "user-support" })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    await expect(getSellerBilling({ env: env(database), shopPublicId: "shop-support", userId: "user-support" })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
  });

  it("keeps seller projection outages distinct from authorization failures", async () => {
    const [customersPage, membersPage, billingPage, sellerManagement] = await Promise.all([
      readFile("src/pages/app/customers.astro", "utf8"),
      readFile("src/pages/app/members.astro", "utf8"),
      readFile("src/pages/app/billing.astro", "utf8"),
      readFile("src/lib/tenants/seller-management.ts", "utf8"),
    ]);

    for (const page of [customersPage, membersPage, billingPage]) {
      expect(page).toContain('isAppError(error) && error.status === 403 ? "forbidden" : "unavailable"');
      expect(page).toContain('if (state === "unavailable") Astro.response.status = 503;');
    }
    expect(membersPage).toContain('description={t("dashboard.members.forbidden.description")}');
    expect(membersPage).toContain("listMemberInvitations");
    expect(membersPage).toContain("data-member-save");
    expect(customersPage).toContain("data-customer-open");
    expect(customersPage).toContain("customers.detail");
    expect(billingPage).toContain("data-billing-request-form");
    expect(sellerManagement).toContain('capability: "team:manage"');
    expect(membersPage).not.toContain("không còn quyền shop:read");
  });
});
