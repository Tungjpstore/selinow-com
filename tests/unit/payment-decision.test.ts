import { describe, expect, it } from "vitest";

import { decidePayment } from "../../src/lib/payments/decision";

const baseline = {
  amount: 100_000,
  currency: "VND",
  description: "SELINOW123456",
  expectedAmount: 100_000,
  expectedCurrency: "VND",
  expectedDescription: "SELINOW123456",
  expectedPaymentLinkId: "link-a",
  occurredAt: "2026-07-25T00:05:00.000Z",
  orderCode: 123_456,
  paymentLinkId: "link-a",
  providerOrderCode: 123_456,
  providerStatus: "PAID",
  reservationExpiresAt: "2026-07-25T00:10:00.000Z",
  success: true,
} as const;

describe("payment decision engine", () => {
  it("allows only an exact timely identity match", () => {
    expect(decidePayment(baseline)).toBe("paid_exact");
    expect(decidePayment({ ...baseline, amount: 99_999 })).toBe("partial");
    expect(decidePayment({ ...baseline, amount: 100_001 })).toBe("overpaid");
    expect(decidePayment({ ...baseline, occurredAt: "2026-07-25T00:11:00.000Z" })).toBe("late");
    expect(decidePayment({ ...baseline, description: "WRONG" })).toBe("identity_mismatch");
    expect(decidePayment({ ...baseline, currency: "USD" })).toBe("identity_mismatch");
    expect(decidePayment({ ...baseline, paymentLinkId: "link-b" })).toBe("identity_mismatch");
  });

  it("never treats browser/provider pending state as paid", () => {
    expect(decidePayment({ ...baseline, providerStatus: "PENDING", success: false })).toBe("pending");
    expect(decidePayment({ ...baseline, providerStatus: "EXPIRED", success: false })).toBe("terminal_unpaid");
  });
});
