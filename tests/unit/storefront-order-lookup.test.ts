import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hmacToken } from "../../src/lib/core/crypto";

const dependencies = vi.hoisted(() => ({
  all: vi.fn(),
  env: {},
  guardOrderLookup: vi.fn(),
  resolveShop: vi.fn(),
}));

vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));
vi.mock("../../src/lib/storefront/abuse", () => ({ guardAnonymousOrderLookup: dependencies.guardOrderLookup }));
vi.mock("../../src/lib/storefront/store", () => ({ resolveStorefrontShop: dependencies.resolveShop }));

import { POST as lookup } from "../../src/pages/api/store/orders/lookup";

const secret = "test-identifier-secret";
const shop = { currentHostname: "seller-a.selinow.com", id: "shop-a" };
let boundValues: unknown[] = [];

function lookupRequest(body: Record<string, unknown>): Request {
  return new Request("https://seller-a.selinow.com/api/store/orders/lookup", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", Origin: "https://seller-a.selinow.com", "Sec-Fetch-Site": "same-origin" },
    method: "POST",
  });
}

beforeEach(() => {
  boundValues = [];
  dependencies.all.mockReset();
  dependencies.guardOrderLookup.mockReset();
  dependencies.resolveShop.mockReset();
  dependencies.resolveShop.mockResolvedValue(shop);
  dependencies.env = {
    IDENTIFIER_HMAC_SECRET: secret,
    PLATFORM_DB: {
      prepare: () => ({
        bind: (...values: unknown[]) => {
          boundValues.push(...values);
          return { all: dependencies.all };
        },
      }),
    },
  };
});

describe("storefront order lookup route", () => {
  it("matches orders via the shop-scoped email HMAC and returns masked rows", async () => {
    dependencies.all.mockResolvedValue({
      results: [{
        createdAt: "2026-08-20T08:00:00.000Z",
        currency: "VND",
        orderId: "order_11111111-1111-4111-8111-111111111111",
        orderNumber: "A1B2C3D4E5F6",
        paymentStatus: "paid",
        status: "completed",
        totalMinor: 250_000,
      }],
    });
    const response = await lookup({
      locals: { requestId: "request-lookup-ok" },
      request: lookupRequest({ email: " Buyer@Example.test ", turnstileToken: "0.".padEnd(40, "x") }),
    } as Parameters<typeof lookup>[0]);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    const orders = (body as { orders?: Array<{ orderId: string }> }).orders ?? [];
    expect(orders).toHaveLength(1);
    expect(orders[0]?.orderId).toBe("order_11111111-1111-4111-8111-111111111111");
    // The stored hash is derived from the normalized email under the shop purpose.
    const expectedHash = await hmacToken(secret, "order-email-lookup:v1:shop-a", "buyer@example.test");
    expect(dependencies.all).toHaveBeenCalled();
    expect(boundValues).toContain(shop.id);
    expect(boundValues).toContain(expectedHash);
  });

  it("rejects cross-site requests before touching the database", async () => {
    const response = await lookup({
      locals: { requestId: "request-lookup-origin" },
      request: new Request("https://seller-a.selinow.com/api/store/orders/lookup", {
        body: JSON.stringify({ email: "buyer@example.test" }),
        headers: { "content-type": "application/json", Origin: "https://evil.example.test", "Sec-Fetch-Site": "cross-site" },
        method: "POST",
      }),
    } as Parameters<typeof lookup>[0]);
    expect(response.status).toBe(403);
    expect(dependencies.all).not.toHaveBeenCalled();
  });

  it("returns an empty list (not an error) when no order matches", async () => {
    dependencies.all.mockResolvedValue({ results: [] });
    const response = await lookup({
      locals: { requestId: "request-lookup-empty" },
      request: lookupRequest({ email: "nobody@example.test" }),
    } as Parameters<typeof lookup>[0]);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect((body as { orders?: unknown[] }).orders).toEqual([]);
  });

  it("rejects invalid emails with a validation error", async () => {
    const response = await lookup({
      locals: { requestId: "request-lookup-invalid" },
      request: lookupRequest({ email: "not-an-email" }),
    } as Parameters<typeof lookup>[0]);
    expect(response.status).toBe(400);
    expect(dependencies.guardOrderLookup).not.toHaveBeenCalled();
  });
});

describe("storefront order lookup migration contract", () => {
  it("ships the lookup hash column and tenant-leading index in migration 0107", () => {
    const migration = readFileSync("migrations/0107_storefront_template_completion.sql", "utf8");
    expect(migration).toContain("ALTER TABLE orders ADD COLUMN customer_email_lookup_hash TEXT");
    expect(migration).toContain("CREATE INDEX idx_orders_shop_email_created");
    expect(migration).toContain("ALTER TABLE products ADD COLUMN attributes_json TEXT");
  });
});
