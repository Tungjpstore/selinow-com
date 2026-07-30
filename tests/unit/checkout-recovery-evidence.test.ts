import { describe, expect, it } from "vitest";

import {
  createCheckoutRecoveryEvidence,
  verifyCheckoutRecoveryEvidence,
} from "../../src/lib/commerce/checkout-recovery-evidence";

const secret = "checkout-recovery-evidence-test-secret";
const base = {
  cartId: "cart_11111111-1111-4111-8111-111111111111",
  checkoutSubjectHash: "checkout-subject-hash",
  requestHash: "request-hash",
  shopId: "shop_recovery_test",
};
const issuedAt = "2026-07-29T01:00:00.000Z";
const expiresAt = "2026-07-29T02:00:00.000Z";

async function evidence(overrides: Partial<typeof base> = {}, expiry = expiresAt): Promise<string> {
  return createCheckoutRecoveryEvidence({
    ...base,
    ...overrides,
    expiresAt: expiry,
    issuedAt,
    secret,
  });
}

describe("checkout recovery evidence", () => {
  it("verifies a token bound to the cart, shop, idempotency subject and request hash", async () => {
    const token = await evidence();

    await expect(verifyCheckoutRecoveryEvidence({
      ...base,
      cartExpiresAt: "2026-07-29T03:00:00.000Z",
      evidence: token,
      now: new Date("2026-07-29T01:30:00.000Z"),
      secret,
    })).resolves.toBeUndefined();
  });

  it("rejects tampering and every cross-boundary mismatch", async () => {
    const token = await evidence();
    const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    await expect(verifyCheckoutRecoveryEvidence({ ...base, cartExpiresAt: "2026-07-29T03:00:00.000Z", evidence: tampered, now: new Date("2026-07-29T01:30:00.000Z"), secret })).rejects.toMatchObject({ code: "checkout_recovery_invalid" });
    await expect(verifyCheckoutRecoveryEvidence({ ...base, cartExpiresAt: "2026-07-29T03:00:00.000Z", evidence: token, now: new Date("2026-07-29T01:30:00.000Z"), requestHash: "other-request", secret })).rejects.toMatchObject({ code: "checkout_recovery_invalid" });
    await expect(verifyCheckoutRecoveryEvidence({ ...base, cartExpiresAt: "2026-07-29T03:00:00.000Z", evidence: token, now: new Date("2026-07-29T01:30:00.000Z"), shopId: "shop_other", secret })).rejects.toMatchObject({ code: "checkout_recovery_invalid" });
    await expect(verifyCheckoutRecoveryEvidence({ ...base, cartExpiresAt: "2026-07-29T03:00:00.000Z", evidence: token, now: new Date("2026-07-29T01:30:00.000Z"), cartId: "cart_22222222-2222-4222-8222-222222222222", secret })).rejects.toMatchObject({ code: "checkout_recovery_invalid" });
    await expect(verifyCheckoutRecoveryEvidence({ ...base, cartExpiresAt: "2026-07-29T03:00:00.000Z", checkoutSubjectHash: "other-subject", evidence: token, now: new Date("2026-07-29T01:30:00.000Z"), secret })).rejects.toMatchObject({ code: "checkout_recovery_invalid" });
  });

  it("rejects expired evidence and evidence that outlives the cart", async () => {
    const token = await evidence();

    await expect(verifyCheckoutRecoveryEvidence({
      ...base,
      cartExpiresAt: "2026-07-29T03:00:00.000Z",
      evidence: token,
      now: new Date("2026-07-29T02:00:00.000Z"),
      secret,
    })).rejects.toMatchObject({ code: "checkout_recovery_expired" });

    await expect(verifyCheckoutRecoveryEvidence({
      ...base,
      cartExpiresAt: "2026-07-29T01:30:00.000Z",
      evidence: token,
      now: new Date("2026-07-29T01:15:00.000Z"),
      secret,
    })).rejects.toMatchObject({ code: "checkout_recovery_invalid" });
  });
});
