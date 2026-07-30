import { describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";
import {
  evaluateInventoryDryRun,
  runControlledTestOrder,
  type RunTestReadiness,
} from "../../src/lib/onboarding/test-order";
import type { AppBindings } from "../../src/lib/platform/bindings";

const SHOP_PUBLIC_ID = "shop_11111111-1111-4111-8111-111111111111";
const VARIANT_ID = "var_22222222-2222-4222-8222-222222222222";
const CHECKED_AT = "2026-07-26T12:00:00.000Z";

type TestDatabaseOptions = {
  availableCount?: number;
  domainType?: "custom" | "platform_subdomain";
  domainReady?: boolean;
  role?: "manager" | "owner";
  userId?: string;
};

class TestOrderDatabase {
  readonly queries: string[] = [];
  mutationAttempts = 0;
  private readonly options: Required<TestDatabaseOptions>;

  constructor(options: TestDatabaseOptions = {}) {
    this.options = {
      availableCount: options.availableCount ?? 2,
      domainReady: options.domainReady ?? true,
      domainType: options.domainType ?? "platform_subdomain",
      role: options.role ?? "owner",
      userId: options.userId ?? "user-a",
    };
  }

  prepare(sql: string) {
    this.queries.push(sql);
    const options = this.options;
    const mutation = () => {
      this.mutationAttempts += 1;
      throw new Error("test_order_must_not_mutate");
    };

    return {
      bind: (...values: unknown[]) => ({
        first: () => Promise.resolve((() => {
          if (sql.includes("INNER JOIN shop_members")) {
            if (values[0] !== options.userId || values[1] !== SHOP_PUBLIC_ID) return null;
            return {
              currency: "VND",
              default_locale: "vi",
              feature_flags_json: "{}",
              limits_json: "{}",
              name: "Shop A",
              plan_code: "business",
              public_id: SHOP_PUBLIC_ID,
              role: options.role,
              shop_id: "shop-a",
              shop_status: "draft",
              slug: "shop-a",
              subscription_state: "trialing",
              timezone: "Asia/Ho_Chi_Minh",
            };
          }
          if (sql.includes("FROM product_variants")) {
            if (values[0] !== "shop-a") return null;
            if (values.length === 2 && values[1] !== VARIANT_ID) return null;
            return {
              available_count: options.availableCount,
              currency: "VND",
              fulfillment_type: "license_key",
              max_per_order: 5,
              min_per_order: 1,
              price_minor: 25_000,
              product_id: "prd_33333333-3333-4333-8333-333333333333",
              product_title: "Test product",
              variant_id: VARIANT_ID,
              variant_title: "1 thang",
            };
          }
          if (sql.includes("FROM payment_integrations")) {
            return {
              active_credential_id: "paycred-active",
              last_checked_at: CHECKED_AT,
              last_safe_error_code: null,
              last_webhook_verified_at: CHECKED_AT,
              status: "active",
              webhook_status: "verified",
            };
          }
          if (sql.includes("FROM telegram_integrations")) {
            return {
              active_credential_id: "tgcred-active",
              last_health_update_at: CHECKED_AT,
              last_safe_error_code: null,
              status: "active",
              webhook_status: "verified",
            };
          }
          if (sql.includes("INNER JOIN shop_domains")) {
            const ready = options.domainReady;
            return {
              delete_requested_at: null,
              deleted_at: null,
              dns_status: options.domainType === "custom" ? (ready ? "active" : "pending") : null,
              hostname_normalized: options.domainType === "custom"
                ? "shop.customer.example"
                : "shop-a.staging.selinow.com",
              hostname_status: options.domainType === "custom" ? (ready ? "active" : "pending") : null,
              ssl_status: options.domainType === "custom" ? (ready ? "active" : "pending") : null,
              status: "active",
              type: options.domainType,
            };
          }
          return null;
        })()),
        run: mutation,
      }),
      run: mutation,
    };
  }

  batch(): never {
    this.mutationAttempts += 1;
    throw new Error("test_order_must_not_mutate");
  }
}

function createEnv(database: TestOrderDatabase): AppBindings {
  return { PLATFORM_DB: database as unknown as D1Database } as AppBindings;
}

function createReadiness(ready = true): RunTestReadiness {
  const status: "fail" | "pass" = ready ? "pass" : "fail";
  const implementation: RunTestReadiness = () => Promise.resolve({
    checkedAt: CHECKED_AT,
    checks: [
      {
        checkedAt: CHECKED_AT,
        code: "payos_ready",
        messageKey: "readiness.payos_ready",
        required: true,
        status,
      },
      {
        checkedAt: CHECKED_AT,
        code: "telegram_ready",
        messageKey: "readiness.telegram_ready",
        required: true,
        status,
      },
    ],
    readinessVersion: 3,
    ready,
    runId: "rdy_44444444-4444-4444-8444-444444444444",
  });
  return vi.fn(implementation);
}

describe("controlled onboarding test order", () => {
  it("quotes and checks health without reserving inventory or calling provider clients", async () => {
    const database = new TestOrderDatabase();
    const runReadiness = createReadiness();

    const result = await runControlledTestOrder({
      body: { quantity: 2, variantId: VARIANT_ID },
      env: createEnv(database),
      requestId: "request-test-order",
      runReadiness,
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-a",
    });

    expect(result.passed).toBe(true);
    expect(result.inventoryDryRun).toMatchObject({
      availableCount: 2,
      code: "test_inventory_available",
      quantity: 2,
      requiredCount: 2,
      sufficient: true,
      totalMinor: 50_000,
      variantId: VARIANT_ID,
    });
    expect(result.providerHealth.payos.ready).toBe(true);
    expect(result.providerHealth.telegram.ready).toBe(true);
    expect(result.domainHealth.ready).toBe(true);
    expect(database.mutationAttempts).toBe(0);
    expect(runReadiness).toHaveBeenCalledWith(expect.objectContaining({
      shopPublicId: SHOP_PUBLIC_ID,
      trigger: "test",
      userId: "user-a",
    }));
    expect(database.queries.filter((sql) => sql.includes("inventory_keys"))).not.toHaveLength(0);
    expect(database.queries.every((sql) => sql.trimStart().startsWith("SELECT"))).toBe(true);
    expect(database.queries.every((sql) => !sql.includes("INSERT INTO orders"))).toBe(true);
  });

  it("fails safely when inventory is insufficient without changing key state", async () => {
    const database = new TestOrderDatabase({ availableCount: 1 });
    const result = await runControlledTestOrder({
      body: { quantity: 2, variantId: VARIANT_ID },
      env: createEnv(database),
      requestId: "request-test-order-low-stock",
      runReadiness: createReadiness(),
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-a",
    });

    expect(result.passed).toBe(false);
    expect(result.inventoryDryRun).toMatchObject({
      availableCount: 1,
      code: "test_inventory_unavailable",
      sufficient: false,
    });
    expect(database.mutationAttempts).toBe(0);
  });

  it("requires an owner and stops before readiness or shop detail checks", async () => {
    const database = new TestOrderDatabase({ role: "manager" });
    const runReadiness = createReadiness();

    await expect(runControlledTestOrder({
      body: {},
      env: createEnv(database),
      requestId: "request-test-order-manager",
      runReadiness,
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-a",
    })).rejects.toEqual(expect.objectContaining({ code: "authorization_denied", status: 403 }));
    expect(runReadiness).not.toHaveBeenCalled();
    expect(database.queries).toHaveLength(1);
  });

  it("does not resolve another tenant's shop or variant", async () => {
    const database = new TestOrderDatabase();
    const runReadiness = createReadiness();

    await expect(runControlledTestOrder({
      body: { variantId: VARIANT_ID },
      env: createEnv(database),
      requestId: "request-cross-tenant",
      runReadiness,
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-b",
    })).rejects.toEqual(expect.objectContaining({ code: "authorization_denied", status: 403 }));
    expect(runReadiness).not.toHaveBeenCalled();
    expect(database.queries).toHaveLength(1);
  });

  it("keeps an unready custom domain from passing the controlled test", async () => {
    const database = new TestOrderDatabase({ domainReady: false, domainType: "custom" });
    const result = await runControlledTestOrder({
      body: { variantId: VARIANT_ID },
      env: createEnv(database),
      requestId: "request-domain-pending",
      runReadiness: createReadiness(),
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-a",
    });

    expect(result.domainHealth).toMatchObject({
      hostname: "shop.customer.example",
      ready: false,
      status: "active",
      type: "custom",
    });
    expect(result.passed).toBe(false);
  });
});

describe("inventory dry-run decisions", () => {
  it("supports manual fulfillment without requiring inventory keys", () => {
    expect(evaluateInventoryDryRun({
      currency: "VND",
      quantity: 1,
      variant: {
        available_count: 0,
        currency: "VND",
        fulfillment_type: "manual",
        max_per_order: 2,
        min_per_order: 1,
        price_minor: 10_000,
        product_id: "product-manual",
        product_title: "Manual product",
        variant_id: "variant-manual",
        variant_title: "Manual",
      },
    })).toMatchObject({
      availableCount: null,
      code: "test_manual_fulfillment_ready",
      requiredCount: 0,
      sufficient: true,
    });
  });

  it("rejects quantities outside the selected variant policy", () => {
    expect(evaluateInventoryDryRun({
      currency: "VND",
      quantity: 3,
      variant: {
        available_count: 10,
        currency: "VND",
        fulfillment_type: "license_key",
        max_per_order: 2,
        min_per_order: 1,
        price_minor: 10_000,
        product_id: "product-limited",
        product_title: "Limited product",
        variant_id: "variant-limited",
        variant_title: "Limited",
      },
    })).toMatchObject({
      code: "test_quantity_out_of_range",
      sufficient: false,
    });
  });
});

it("rejects invalid quantities after confirming owner scope", async () => {
  const database = new TestOrderDatabase();

  await expect(runControlledTestOrder({
    body: { quantity: 0 },
    env: createEnv(database),
    requestId: "request-invalid-quantity",
    runReadiness: createReadiness(),
    shopPublicId: SHOP_PUBLIC_ID,
    userId: "user-a",
  })).rejects.toBeInstanceOf(AppError);
  expect(database.queries).toHaveLength(1);
});
