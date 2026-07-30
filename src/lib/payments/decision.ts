import { samePaymentProviderEvidenceBinding, type NormalizedPaymentEvidence, type PaymentAttemptExpectation } from "./provider";

export type PaymentDecision = "identity_mismatch" | "inconsistent" | "late" | "overpaid" | "paid_exact" | "partial" | "pending" | "terminal_unpaid";

export function decideNormalizedPayment(input: {
  evidence: NormalizedPaymentEvidence;
  expectation: PaymentAttemptExpectation;
}): PaymentDecision {
  if (!samePaymentProviderEvidenceBinding(input.evidence.binding, input.expectation.binding)) return "identity_mismatch";
  if (input.evidence.attemptReference !== input.expectation.attemptReference) return "identity_mismatch";
  if (input.expectation.paymentReference !== null
    && input.evidence.paymentReference !== null
    && input.evidence.paymentReference !== input.expectation.paymentReference) return "identity_mismatch";
  if (input.evidence.currency !== input.expectation.currency) return "identity_mismatch";
  if (!input.evidence.success) return new Set(["CANCELLED", "EXPIRED", "FAILED"]).has(input.evidence.providerStatus) ? "terminal_unpaid" : "pending";
  if (input.evidence.description !== input.expectation.description) return "identity_mismatch";
  if (!Number.isFinite(Date.parse(input.evidence.occurredAt))) return "inconsistent";
  if (Date.parse(input.evidence.occurredAt) > Date.parse(input.expectation.expiresAt)) return "late";
  if (input.evidence.amountMinor < input.expectation.amountMinor) return "partial";
  if (input.evidence.amountMinor > input.expectation.amountMinor) return "overpaid";
  return "paid_exact";
}

export function decidePayment(input: {
  amount: number;
  currency: string;
  description: string;
  expectedAmount: number;
  expectedCurrency: string;
  expectedDescription: string;
  expectedPaymentLinkId: string | null;
  occurredAt: string;
  orderCode: number;
  paymentLinkId: string | null;
  providerOrderCode: number;
  providerStatus: string;
  reservationExpiresAt: string;
  success: boolean;
}): PaymentDecision {
  return decideNormalizedPayment({
    evidence: {
      amountMinor: input.amount,
      attemptReference: String(input.orderCode),
      currency: input.currency,
      description: input.description,
      occurredAt: input.occurredAt,
      paymentReference: input.paymentLinkId,
      providerStatus: input.providerStatus,
      reference: String(input.orderCode),
      success: input.success,
      binding: {
        shopId: "legacy-payos",
        orderId: String(input.orderCode),
        providerCode: "payos",
        providerEnvironment: "live",
        connectionId: "legacy-payos",
        credentialId: "legacy-payos",
        credentialVersion: 1,
        providerAccountFingerprint: "legacy-payos",
        settlementMode: "direct",
      },
    },
    expectation: {
      amountMinor: input.expectedAmount,
      attemptReference: String(input.providerOrderCode),
      currency: input.expectedCurrency,
      description: input.expectedDescription,
      expiresAt: input.reservationExpiresAt,
      paymentReference: input.expectedPaymentLinkId,
      binding: {
        shopId: "legacy-payos",
        orderId: String(input.providerOrderCode),
        providerCode: "payos",
        providerEnvironment: "live",
        connectionId: "legacy-payos",
        credentialId: "legacy-payos",
        credentialVersion: 1,
        providerAccountFingerprint: "legacy-payos",
        settlementMode: "direct",
      },
    },
  });
}
