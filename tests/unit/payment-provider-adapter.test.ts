import { describe, expect, it } from "vitest";

import { decideNormalizedPayment, decidePayment } from "../../src/lib/payments/decision";
import { PAYOS_PROVIDER_DESCRIPTOR } from "../../src/lib/payments/payos";
import {
  PAYMENT_PROVIDER_DEFINITION_VERSION,
  PAYMENT_PROVIDER_OPERATION_BY_CAPABILITY,
  PaymentProviderRegistry,
  definePaymentProvider,
  definePaymentProviderDescriptor,
  isSupportedPaymentSettlementPolicy,
  type NormalizedPaymentEvidence,
  type PaymentProviderEvidenceBinding,
  type PaymentProviderAdapter,
  type PaymentProviderDefinition,
} from "../../src/lib/payments/provider";

type FakeWebhook = {
  body: {
    amountMinor: number;
    attemptReference: string;
    currency: string;
    description: string;
    occurredAt: string;
    paymentReference: string;
    providerStatus: string;
    reference: string;
  };
  signature: string;
};

const fakeDescriptor = definePaymentProviderDescriptor({
  capabilities: ["checkout.create", "credential.health", "payment.reconcile", "webhook.verify"],
  code: "acmepay",
  connectionModes: ["bring_your_own"],
  settlementMode: "direct",
  supportedCurrencies: ["EUR", "USD"],
  supportedPaymentMethods: ["card"],
});

const fakeBinding: PaymentProviderEvidenceBinding = {
  shopId: "shop-a",
  orderId: "order-a",
  providerCode: "acmepay",
  providerEnvironment: "sandbox",
  connectionId: "connection-a",
  credentialId: "credential-a",
  credentialVersion: 3,
  providerAccountFingerprint: "account-fingerprint-a",
  settlementMode: "direct",
};

class FakeSecondProvider implements PaymentProviderAdapter<FakeWebhook, FakeWebhook["body"]> {
  readonly descriptor = fakeDescriptor;

  checkCredentialHealth(): Promise<"healthy"> {
    return Promise.resolve("healthy");
  }

  createCheckout(input: FakeWebhook["body"]): Promise<{ reference: string }> {
    return Promise.resolve({ reference: input.paymentReference });
  }

  reconcile(input: FakeWebhook["body"]): Promise<NormalizedPaymentEvidence> {
    return Promise.resolve(this.normalize(input));
  }

  verifyAndNormalizeWebhook(input: FakeWebhook): Promise<NormalizedPaymentEvidence> {
    if (input.signature !== `signed:${input.body.reference}`) return Promise.reject(new Error("fake_signature_invalid"));
    return Promise.resolve(this.normalize(input.body));
  }

  private normalize(input: FakeWebhook["body"]): NormalizedPaymentEvidence {
    return {
      amountMinor: input.amountMinor,
      attemptReference: input.attemptReference,
      currency: input.currency,
      description: input.description,
      occurredAt: input.occurredAt,
      paymentReference: input.paymentReference,
      providerStatus: input.providerStatus.toUpperCase(),
      reference: input.reference,
      success: input.providerStatus === "succeeded",
      binding: fakeBinding,
    };
  }
}

const fakeProviderDefinition = definePaymentProvider({
  adapter: new FakeSecondProvider(),
  version: PAYMENT_PROVIDER_DEFINITION_VERSION,
});

const webhookBody: FakeWebhook["body"] = {
  amountMinor: 5_000,
  attemptReference: "pi_test_123",
  currency: "USD",
  description: "ORDER-123",
  occurredAt: "2026-07-29T04:00:00.000Z",
  paymentReference: "checkout_test_123",
  providerStatus: "succeeded",
  reference: "evt_test_123",
};

const expectation = {
  amountMinor: 5_000,
  attemptReference: "pi_test_123",
  currency: "USD",
  description: "ORDER-123",
  expiresAt: "2026-07-29T04:30:00.000Z",
  paymentReference: "checkout_test_123",
  binding: fakeBinding,
};

describe("provider-neutral payment adapter foundation", () => {
  it("describes PayOS truthfully without changing its direct BYO boundary", () => {
    expect(PAYOS_PROVIDER_DESCRIPTOR).toEqual({
      capabilities: ["checkout.create", "credential.health", "payment.reconcile", "webhook.verify"],
      code: "payos",
      connectionModes: ["bring_your_own"],
      settlementMode: "direct",
      supportedCurrencies: ["VND"],
      supportedPaymentMethods: ["bank_transfer_qr"],
    });
    expect(PAYOS_PROVIDER_DESCRIPTOR.capabilities).not.toContain("refund.create");
  });

  it("keeps direct settlement seller-owned and managed settlement with the merchant-of-record partner", () => {
    expect(isSupportedPaymentSettlementPolicy({
      connectionMode: "bring_your_own",
      credentialOwnership: "seller",
      settlementMode: "direct",
    })).toBe(true);
    expect(isSupportedPaymentSettlementPolicy({
      connectionMode: "managed",
      credentialOwnership: "provider_partner",
      settlementMode: "mor_partner",
    })).toBe(true);
    expect(isSupportedPaymentSettlementPolicy({
      connectionMode: "managed",
      credentialOwnership: "platform",
      settlementMode: "direct",
    })).toBe(false);
  });

  it("runs a fake second provider through the shared conservative decision", async () => {
    const adapter = fakeProviderDefinition.adapter;
    const evidence = await adapter.verifyAndNormalizeWebhook({
      body: webhookBody,
      signature: "signed:evt_test_123",
    });

    expect(decideNormalizedPayment({ evidence, expectation })).toBe("paid_exact");
    expect(JSON.stringify(evidence)).not.toContain("signature");
    expect(JSON.stringify(evidence)).not.toContain("secret");
  });

  it("rejects invalid provider authentication before normalized evidence exists", async () => {
    const adapter = fakeProviderDefinition.adapter;
    await expect(adapter.verifyAndNormalizeWebhook({ body: webhookBody, signature: "invalid" }))
      .rejects.toThrow("fake_signature_invalid");
  });

  it.each([
    [{ amountMinor: 4_999 }, "partial"],
    [{ amountMinor: 5_001 }, "overpaid"],
    [{ currency: "EUR" }, "identity_mismatch"],
    [{ attemptReference: "pi_other" }, "identity_mismatch"],
    [{ paymentReference: "checkout_other" }, "identity_mismatch"],
    [{ occurredAt: "2026-07-29T05:00:00.000Z" }, "late"],
    [{ providerStatus: "failed" }, "terminal_unpaid"],
  ] as const)("fails closed for normalized evidence mismatch %#", async (change, decision) => {
    const adapter = fakeProviderDefinition.adapter;
    const body = { ...webhookBody, ...change };
    const evidence = await adapter.verifyAndNormalizeWebhook({
      body,
      signature: `signed:${body.reference}`,
    });
    expect(decideNormalizedPayment({ evidence, expectation })).toBe(decision);
  });

  it.each([
    ["shopId", "shop-b"],
    ["orderId", "order-b"],
    ["providerCode", "otherpay"],
    ["providerEnvironment", "live"],
    ["connectionId", "connection-b"],
    ["credentialId", "credential-b"],
    ["credentialVersion", 4],
    ["providerAccountFingerprint", "account-fingerprint-b"],
    ["settlementMode", "mor_partner"],
  ] as const)("rejects a mismatched trusted binding field %s", async (field, value) => {
    const evidence = await fakeProviderDefinition.adapter.verifyAndNormalizeWebhook({
      body: webhookBody,
      signature: "signed:evt_test_123",
    });
    const mismatched = {
      ...evidence,
      binding: { ...evidence.binding, [field]: value },
    };

    expect(decideNormalizedPayment({ evidence: mismatched, expectation })).toBe("identity_mismatch");
  });

  it("keeps the legacy PayOS decision API behavior-equivalent", () => {
    expect(decidePayment({
      amount: 5_000,
      currency: "VND",
      description: "SEL000123",
      expectedAmount: 5_000,
      expectedCurrency: "VND",
      expectedDescription: "SEL000123",
      expectedPaymentLinkId: "payos-link-123",
      occurredAt: "2026-07-29T04:00:00.000Z",
      orderCode: 123,
      paymentLinkId: "payos-link-123",
      providerOrderCode: 123,
      providerStatus: "PAID",
      reservationExpiresAt: "2026-07-29T04:30:00.000Z",
      success: true,
    })).toBe("paid_exact");
  });

  it("rejects descriptors that could overstate provider capability", () => {
    expect(() => definePaymentProviderDescriptor({
      ...fakeDescriptor,
      capabilities: ["checkout.create"],
    })).toThrow("payment_provider_descriptor_invalid");
    expect(() => definePaymentProviderDescriptor({
      ...fakeDescriptor,
      supportedCurrencies: ["usd"],
    })).toThrow("payment_provider_descriptor_invalid");
    expect(() => definePaymentProviderDescriptor({
      ...fakeDescriptor,
      supportedPaymentMethods: ["card", "card"],
    })).toThrow("payment_provider_descriptor_invalid");
  });

  it("registers a versioned definition only when capabilities match adapter operations", () => {
    const registry = new PaymentProviderRegistry([fakeProviderDefinition]);

    expect(registry.require("acmepay")).toBe(fakeProviderDefinition);
    expect(registry.require("acmepay").version).toBe(1);
    expect(registry.list()).toEqual([fakeProviderDefinition]);
    expect(() => registry.require("unknownpay")).toThrow("payment_provider_unknown");
  });

  it.each(Object.entries(PAYMENT_PROVIDER_OPERATION_BY_CAPABILITY))(
    "rejects capability %s when operation %s is absent",
    (capability, operation) => {
      const descriptor = definePaymentProviderDescriptor({
        capabilities: [...Object.keys(PAYMENT_PROVIDER_OPERATION_BY_CAPABILITY)] as (keyof typeof PAYMENT_PROVIDER_OPERATION_BY_CAPABILITY)[],
        code: `missing-${operation.toLowerCase()}`,
        connectionModes: ["bring_your_own"],
        settlementMode: "direct",
        supportedCurrencies: ["USD"],
        supportedPaymentMethods: ["card"],
      });
      const adapter: Record<string, unknown> = {
        checkCredentialHealth: () => Promise.resolve("healthy"),
        createCheckout: () => Promise.resolve({ reference: "checkout" }),
        createRefund: () => Promise.resolve({ reference: "refund" }),
        descriptor,
        reconcile: () => Promise.resolve({}),
        verifyAndNormalizeWebhook: () => Promise.resolve({}),
      };
      Reflect.deleteProperty(adapter, operation);
      const definition = {
        adapter,
        version: PAYMENT_PROVIDER_DEFINITION_VERSION,
      } as unknown as PaymentProviderDefinition;

      expect(() => new PaymentProviderRegistry([definition])).toThrow(expect.objectContaining({
        code: "payment_provider_definition_invalid",
        issues: [`capability_operation_missing:${capability}`],
      }));
    },
  );

  it("rejects implemented operations that the descriptor does not declare", () => {
    const adapter = new FakeSecondProvider();
    const definition = {
      adapter: {
        checkCredentialHealth: adapter.checkCredentialHealth.bind(adapter),
        createCheckout: adapter.createCheckout.bind(adapter),
        createRefund: () => Promise.resolve({ reference: "refund" }),
        descriptor: adapter.descriptor,
        reconcile: adapter.reconcile.bind(adapter),
        verifyAndNormalizeWebhook: adapter.verifyAndNormalizeWebhook.bind(adapter),
      },
      version: PAYMENT_PROVIDER_DEFINITION_VERSION,
    } as unknown as PaymentProviderDefinition;

    expect(() => new PaymentProviderRegistry([definition])).toThrow(expect.objectContaining({
      code: "payment_provider_definition_invalid",
      issues: ["operation_capability_missing:refund.create"],
    }));
  });

  it("rejects unsupported definition versions and duplicate provider codes", () => {
    const unsupportedVersion = {
      ...fakeProviderDefinition,
      version: 2,
    } as unknown as PaymentProviderDefinition;

    expect(() => new PaymentProviderRegistry([unsupportedVersion])).toThrow(expect.objectContaining({
      code: "payment_provider_definition_invalid",
      issues: ["definition_version_invalid"],
    }));
    expect(() => new PaymentProviderRegistry([fakeProviderDefinition, fakeProviderDefinition]))
      .toThrow(expect.objectContaining({ code: "payment_provider_registry_invalid", issues: ["provider_duplicate"] }));
  });
});
