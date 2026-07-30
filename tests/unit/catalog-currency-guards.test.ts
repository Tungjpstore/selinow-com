import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";

const getShopForMember = vi.fn();

vi.mock("../../src/lib/tenants/store", () => ({ getShopForMember }));

const { createProductWithInitialVariant, createVariant, updateVariant } = await import("../../src/lib/catalog/store");

const variant = {
  compareAtMinor: null,
  currency: "USD",
  maxPerOrder: 10,
  minPerOrder: 1,
  optionsJson: "{}",
  priceMinor: 1_000,
  sku: "USD-PLAN",
  status: "active" as const,
  title: "Standard",
};

function createEnv() {
  const prepare = vi.fn(() => {
    throw new Error("unexpected_d1_access");
  });
  return {
    env: {
      PLATFORM_DB: { prepare },
      SESSION_SECRET: "catalog-currency-guard-session-secret",
    } as unknown as AppBindings,
    prepare,
  };
}

beforeEach(() => {
  getShopForMember.mockReset();
  getShopForMember.mockResolvedValue({ row: { currency: "VND", shop_id: "shop-a" } });
});

describe("catalog currency write guards", () => {
  it("rejects a mismatched initial variant before any catalog D1 access", async () => {
    const { env, prepare } = createEnv();

    await expect(createProductWithInitialVariant({
      data: {
        categoryId: null,
        description: "",
        fulfillmentType: "license_key",
        slug: "usd-product",
        status: "draft",
        title: "USD product",
      },
      env,
      idempotencyKey: "catalog-currency-guard-0001",
      initialVariant: variant,
      requestId: "request-currency-guard",
      shopPublicId: "shop_00000000-0000-4000-8000-000000000001",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["currency_mismatch"], status: 400 });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects a mismatched variant create before product lookup or mutation", async () => {
    const { env, prepare } = createEnv();

    await expect(createVariant({
      data: variant,
      env,
      productId: "prd_00000000-0000-4000-8000-000000000001",
      shopPublicId: "shop_00000000-0000-4000-8000-000000000001",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["currency_mismatch"], status: 400 });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects mismatched and unsupported variant updates before mutation", async () => {
    const mismatch = createEnv();
    await expect(updateVariant({
      data: variant,
      env: mismatch.env,
      shopPublicId: "shop_00000000-0000-4000-8000-000000000001",
      userId: "user-a",
      variantId: "var_00000000-0000-4000-8000-000000000001",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["currency_mismatch"], status: 400 });
    expect(mismatch.prepare).not.toHaveBeenCalled();

    const unsupported = createEnv();
    await expect(updateVariant({
      data: { ...variant, currency: "GBP" },
      env: unsupported.env,
      shopPublicId: "shop_00000000-0000-4000-8000-000000000001",
      userId: "user-a",
      variantId: "var_00000000-0000-4000-8000-000000000001",
    })).rejects.toMatchObject({ code: "validation_failed", issues: ["currency_invalid"], status: 400 });
    expect(unsupported.prepare).not.toHaveBeenCalled();
  });

  it("uses the authoritative shop currency when a variant omits currency", async () => {
    const bindings: unknown[][] = [];
    const prepare = vi.fn(() => ({
      bind: (...values: unknown[]) => {
        bindings.push(values);
        return { first: () => Promise.resolve({ id: "var-created" }) };
      },
    }));
    const env = { PLATFORM_DB: { prepare }, SESSION_SECRET: "catalog-currency-guard-session-secret" } as unknown as AppBindings;

    await createVariant({
      data: { ...variant, currency: undefined },
      env,
      productId: "prd_00000000-0000-4000-8000-000000000001",
      shopPublicId: "shop_00000000-0000-4000-8000-000000000001",
      userId: "user-a",
    });

    expect(bindings[1]?.[8]).toBe("VND");
  });
});
