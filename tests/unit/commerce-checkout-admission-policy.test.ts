import { describe, expect, it } from "vitest";

import { executeCanonicalCheckoutTransaction, type CanonicalCheckoutTransactionInput } from "../../src/lib/commerce/checkout-transaction";
import type { AppBindings } from "../../src/lib/platform/bindings";

function checkoutInput(overrides: Partial<CanonicalCheckoutTransactionInput> = {}): CanonicalCheckoutTransactionInput {
  const database = {
    prepare: () => ({
      bind: () => ({ first: () => Promise.resolve({ status: "blocked" }) }),
    }),
  };
  return {
    cartId: "cart-admission",
    cartSnapshot: { discountCode: null },
    channel: { attribution: { adapterVersion: 1, channelCode: "website", legacySourceChannel: "web" }, code: "website", connectionId: null },
    checkoutRequestHash: "request-hash",
    checkoutSubjectHash: "subject-hash",
    currency: "USD",
    customer: { customerId: "customer-blocked", kind: "existing", maskedEmail: null },
    discountMinor: 0,
    env: { PLATFORM_DB: database } as unknown as AppBindings,
    eventIdempotencyKey: "event-key",
    expiresAt: "2026-08-08T12:00:00.000Z",
    fulfillmentIdempotencyPrefix: "checkout",
    lines: [{ fulfillmentType: "manual", priceMinor: 100, productId: "product-manual", productTitle: "Manual", productVersion: 1, quantity: 1, sku: "MANUAL", title: "Manual", variantId: "variant-manual", variantVersion: 1 }],
    locale: "en",
    nowIso: "2026-08-08T10:00:00.000Z",
    orderId: "order-internal",
    orderPublicId: "order_public",
    orderTokenHash: "order-token-hash",
    reservationToken: "reservation-token",
    shopId: "shop-a",
    subtotalMinor: 100,
    totalMinor: 100,
    ...overrides,
  };
}

describe("canonical checkout admission policy", () => {
  it("rejects mixed fulfillment before reading or writing checkout state", async () => {
    const prepare = () => { throw new Error("database_must_not_be_touched"); };
    const input = checkoutInput({
      env: { PLATFORM_DB: { prepare } } as unknown as AppBindings,
      lines: [
        { fulfillmentType: "manual", priceMinor: 100, productId: "product-manual", productTitle: "Manual", productVersion: 1, quantity: 1, sku: "MANUAL", title: "Manual", variantId: "variant-manual", variantVersion: 1 },
        { fulfillmentType: "license_key", priceMinor: 200, productId: "product-key", productTitle: "Key", productVersion: 1, quantity: 1, sku: "KEY", title: "Key", variantId: "variant-key", variantVersion: 1 },
      ],
      subtotalMinor: 300,
      totalMinor: 300,
    });
    await expect(executeCanonicalCheckoutTransaction(input)).rejects.toMatchObject({
      code: "mixed_fulfillment_unsupported",
      status: 409,
    });
  });

  it("rejects a tenant-bound blocked customer before order creation", async () => {
    await expect(executeCanonicalCheckoutTransaction(checkoutInput())).rejects.toMatchObject({
      code: "customer_blocked",
      status: 403,
    });
  });
});
