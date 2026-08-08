import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createDodoCheckout,
  getDodoConfig,
  parseDodoEvent,
  verifyDodoWebhookSignature,
} from "../../src/lib/billing/dodo";
import type { AppBindings } from "../../src/lib/platform/bindings";

const API_KEY = "dodo-api-key-for-adapter-tests";
const WEBHOOK_KEY = "dodo-webhook-key-for-adapter-tests";

function environment(appEnvironment: AppBindings["APP_ENV"], overrides: Record<string, unknown> = {}): AppBindings {
  return {
    APP_ENV: appEnvironment,
    DODO_PAYMENTS_API_KEY: API_KEY,
    DODO_PAYMENTS_WEBHOOK_KEY: WEBHOOK_KEY,
    PLATFORM_DB: {},
    ...overrides,
  } as unknown as AppBindings;
}

describe("Dodo billing adapter hardening", () => {
  it("locks staging to test mode and production to live mode", () => {
    expect(getDodoConfig(environment("staging")).environment).toBe("test_mode");
    expect(getDodoConfig(environment("production")).environment).toBe("live_mode");
    expect(() => getDodoConfig(environment("staging", { DODO_PAYMENTS_ENVIRONMENT: "live_mode" }))).toThrow(
      expect.objectContaining({ code: "billing_provider_invalid", status: 502 }),
    );
    expect(() => getDodoConfig(environment("production", { DODO_PAYMENTS_ENVIRONMENT: "test_mode" }))).toThrow(
      expect.objectContaining({ code: "billing_provider_invalid", status: 502 }),
    );
  });

  it("rejects API base overrides outside local development", () => {
    expect(() => getDodoConfig(environment("staging", { DODO_PAYMENTS_API_BASE_URL: "https://test.dodopayments.com" }))).toThrow(
      expect.objectContaining({ code: "billing_provider_invalid", status: 502 }),
    );
    expect(getDodoConfig(environment("local", { DODO_PAYMENTS_API_BASE_URL: "http://127.0.0.1:8787/dodo" })).apiBaseUrl).toBe("http://127.0.0.1:8787/dodo");
    expect(() => getDodoConfig(environment("local", { DODO_PAYMENTS_API_BASE_URL: "https://user:pass@example.test" }))).toThrow(
      expect.objectContaining({ code: "billing_provider_invalid", status: 502 }),
    );
  });

  it("uses the Standard Webhooks webhook-id as the canonical event identity", () => {
    const event = parseDodoEvent({
      data: { payment_id: "pay_test_123", subscription_id: "sub_test_123" },
      event_id: "payload_event_id",
      timestamp: "2026-08-08T00:00:00.000Z",
      type: "payment.succeeded",
    }, "msg_canonical_123");

    expect(event.eventId).toBe("msg_canonical_123");
    expect(() => parseDodoEvent({ timestamp: "2026-08-08T00:00:00.000Z", type: "payment.succeeded" })).toThrow(
      expect.objectContaining({ code: "billing_webhook_invalid", status: 400 }),
    );
  });

  it("keeps checkout, payment and subscription references separate", () => {
    const event = parseDodoEvent({
      data: {
        checkout_session_id: "chk_test_123",
        metadata: { checkoutSessionId: "bchk_local_123" },
        payment_id: "pay_test_123",
        subscription_id: "sub_test_123",
      },
      timestamp: "2026-08-08T00:00:00.000Z",
      type: "payment.succeeded",
    }, "msg_test_123");

    expect(event.providerCheckoutId).toBe("chk_test_123");
    expect(event.providerPaymentId).toBe("pay_test_123");
    expect(event.providerSubscriptionId).toBe("sub_test_123");
    expect(event.providerTransactionId).toBe("pay_test_123");
    expect(event.customData.checkoutSessionId).toBe("bchk_local_123");
  });

  it("rejects provider references that cannot be stored durably", async () => {
    const config = getDodoConfig(environment("local"));
    await expect(createDodoCheckout({
      config,
      currency: "USD",
      customData: { checkoutSessionId: "bchk_local_123" },
      fetcher: () => Promise.resolve(new Response(JSON.stringify({
        checkout_url: "https://test.checkout.dodopayments.com/session/valid",
        session_id: "checkout id with spaces",
      }), { status: 200 })),
      idempotencyKey: "checkout-key",
      priceId: "prod_test_123",
    })).rejects.toMatchObject({ code: "billing_provider_invalid", status: 502 });
  });

  it("returns a dedicated checkout reference while retaining the compatibility alias", async () => {
    const config = getDodoConfig(environment("local"));
    await expect(createDodoCheckout({
      config,
      currency: "USD",
      customData: { checkoutSessionId: "bchk_local_123" },
      fetcher: () => Promise.resolve(new Response(JSON.stringify({
        checkout_url: "https://test.checkout.dodopayments.com/session/chk_test_123",
        session_id: "chk_test_123",
      }), { status: 200 })),
      idempotencyKey: "checkout-key",
      priceId: "prod_test_123",
    })).resolves.toEqual({
      checkoutUrl: "https://test.checkout.dodopayments.com/session/chk_test_123",
      providerCheckoutId: "chk_test_123",
      providerTransactionId: "chk_test_123",
    });
  });

  it("rejects a webhook-id outside the durable provider reference grammar", async () => {
    const body = JSON.stringify({ timestamp: "2026-08-08T00:00:00.000Z", type: "payment.succeeded" });
    const timestamp = 1_775_779_200;
    const webhookId = "msg invalid";
    const digest = createHmac("sha256", WEBHOOK_KEY).update(`${webhookId}.${String(timestamp)}.${body}`).digest("base64");

    await expect(verifyDodoWebhookSignature({
      body,
      header: `v1,${digest}`,
      now: timestamp,
      secret: WEBHOOK_KEY,
      timestamp: String(timestamp),
      webhookId,
    })).resolves.toBe(false);
  });
});
