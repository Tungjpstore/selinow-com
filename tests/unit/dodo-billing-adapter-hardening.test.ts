import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  cancelDodoSubscription,
  cancelScheduledDodoPlanChange,
  changeDodoSubscription,
  createDodoCheckout,
  createDodoCustomerPortalSession,
  getDodoConfig,
  parseDodoEvent,
  previewDodoSubscriptionChange,
  retrieveDodoCheckout,
  resumeDodoSubscription,
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

  it("passes the service-validated return URL to hosted checkout", async () => {
    const config = getDodoConfig(environment("local"));
    const fetcher: typeof fetch = (_input, init) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({
        return_url: "https://app.selinow.com/app/billing?billing_return=1&shop=shop_test_123",
      });
      return Promise.resolve(Response.json({
        checkout_url: "https://test.checkout.dodopayments.com/session/chk_return_123",
        session_id: "chk_return_123",
      }));
    };

    await expect(createDodoCheckout({
      config,
      currency: "USD",
      customData: { checkoutSessionId: "bchk_local_123" },
      fetcher,
      idempotencyKey: "checkout-return-key",
      priceId: "prod_test_123",
      returnUrl: "https://app.selinow.com/app/billing?billing_return=1&shop=shop_test_123",
    })).resolves.toMatchObject({ providerCheckoutId: "chk_return_123" });
  });

  it.each([400, 404, 409, 422])("classifies deterministic checkout HTTP %i failures as terminal", async (status) => {
    const config = getDodoConfig(environment("local"));
    await expect(createDodoCheckout({
      config,
      currency: "USD",
      customData: { checkoutSessionId: "bchk_local_123" },
      fetcher: () => Promise.resolve(new Response("provider detail must stay opaque", { status })),
      idempotencyKey: `checkout-terminal-${String(status)}`,
      priceId: "prod_test_123",
    })).rejects.toMatchObject({ code: "billing_provider_request_rejected", issues: undefined, status: 502 });
  });

  it.each([401, 403])("classifies provider authentication HTTP %i failures as unavailable", async (status) => {
    const config = getDodoConfig(environment("local"));
    await expect(createDodoCheckout({
      config,
      currency: "USD",
      customData: { checkoutSessionId: "bchk_local_123" },
      fetcher: () => Promise.resolve(Response.json({ message: "authentication failed" }, { status })),
      idempotencyKey: "checkout-auth-failure",
      priceId: "prod_starter",
    })).rejects.toMatchObject({ code: "billing_provider_unavailable", issues: ["provider_authentication"], status: 503 });
  });

  it.each([408, 425, 429, 500, 503])("keeps transient checkout HTTP %i failures retryable", async (status) => {
    const config = getDodoConfig(environment("local"));
    await expect(createDodoCheckout({
      config,
      currency: "USD",
      customData: { checkoutSessionId: "bchk_local_123" },
      fetcher: () => Promise.resolve(new Response(null, { status })),
      idempotencyKey: `checkout-retryable-${String(status)}`,
      priceId: "prod_test_123",
    })).rejects.toMatchObject({ code: "billing_provider_unavailable", status: 503 });
  });

  it("retrieves payment truth without requiring a reusable hosted checkout URL", async () => {
    const config = getDodoConfig(environment("local"));
    await expect(retrieveDodoCheckout({
      config,
      fetcher: () => Promise.resolve(Response.json({
        created_at: "2026-08-03T00:00:00.000Z",
        id: "chk_truth_123",
        payment_id: "pay_truth_123",
        payment_status: "Succeeded",
        subscription_id: "sub_truth_123",
      })),
      providerTransactionId: "chk_truth_123",
    })).resolves.toEqual({
      amountMinor: null,
      checkoutUrl: null,
      createdAt: "2026-08-03T00:00:00.000Z",
      currency: null,
      paymentId: "pay_truth_123",
      paymentStatus: "succeeded",
      priceId: null,
      providerCheckoutId: "chk_truth_123",
      providerTransactionId: "chk_truth_123",
      subscriptionId: "sub_truth_123",
    });
  });

  it("accepts the documented details-collection checkout state", async () => {
    const config = getDodoConfig(environment("local"));
    await expect(retrieveDodoCheckout({
      config,
      fetcher: () => Promise.resolve(Response.json({
        created_at: "2026-08-03T00:00:00.000Z",
        id: "chk_empty_123",
        payment_id: null,
        payment_status: null,
      })),
      providerTransactionId: "chk_empty_123",
    })).resolves.toMatchObject({
      checkoutUrl: null,
      createdAt: "2026-08-03T00:00:00.000Z",
      paymentId: null,
      paymentStatus: null,
      providerCheckoutId: "chk_empty_123",
    });
  });

  it("pins hosted checkout URLs to the configured provider environment", async () => {
    const staging = getDodoConfig(environment("staging"));
    await expect(createDodoCheckout({
      config: staging,
      currency: "USD",
      customData: { checkoutSessionId: "bchk_local_123" },
      fetcher: () => Promise.resolve(new Response(JSON.stringify({ checkout_url: "https://checkout.dodopayments.com/session/live", session_id: "chk_live_123" }), { status: 200 })),
      idempotencyKey: "checkout-key",
      priceId: "prod_test_123",
    })).rejects.toMatchObject({ code: "billing_provider_invalid", status: 502 });
  });

  it.each([200, 202, 204])("accepts an empty %i subscription mutation acknowledgement", async (status) => {
    const config = getDodoConfig(environment("local"));
    const fetcher: typeof fetch = () => Promise.resolve(new Response(null, { status }));

    await expect(changeDodoSubscription({
      config,
      effectiveAt: "immediately",
      fetcher,
      idempotencyKey: `change-${String(status)}`,
      onPaymentFailure: "prevent_change",
      priceId: "prod_test_123",
      providerSubscriptionId: "sub_test_123",
    })).resolves.toEqual({ providerActionRef: "sub_test_123" });
    await expect(cancelDodoSubscription({
      config,
      fetcher,
      idempotencyKey: `cancel-${String(status)}`,
      providerSubscriptionId: "sub_test_123",
    })).resolves.toEqual({ providerActionRef: "sub_test_123" });
    await expect(resumeDodoSubscription({
      config,
      fetcher,
      idempotencyKey: `resume-${String(status)}`,
      providerSubscriptionId: "sub_test_123",
    })).resolves.toEqual({ providerActionRef: "sub_test_123" });
  });

  it("deletes a scheduled plan change without sending a request body", async () => {
    const config = getDodoConfig(environment("local"));
    const fetcher: typeof fetch = (input, init) => {
      expect(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).toBe("https://test.dodopayments.com/subscriptions/sub_test_123/change-plan/scheduled");
      expect(init?.method).toBe("DELETE");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("cancel-scheduled-key");
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    await expect(cancelScheduledDodoPlanChange({
      config,
      fetcher,
      idempotencyKey: "cancel-scheduled-key",
      providerSubscriptionId: "sub_test_123",
    })).resolves.toEqual({ providerActionRef: "sub_test_123" });
  });

  it("creates a customer portal session with encoded return context", async () => {
    const config = getDodoConfig(environment("local"));
    const fetcher: typeof fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      expect(`${url.origin}${url.pathname}`).toBe("https://test.dodopayments.com/customers/cus_test_123/customer-portal/session");
      expect(url.searchParams.get("return_url")).toBe("https://selinow.com/app/billing?shop=shop_test_123");
      expect(url.searchParams.get("send_email")).toBe("false");
      expect(init?.method).toBe("POST");
      return Promise.resolve(Response.json({ link: "https://customer.dodopayments.com/session/portal_test_123" }));
    };
    await expect(createDodoCustomerPortalSession({
      config,
      customerId: "cus_test_123",
      fetcher,
      returnUrl: "https://selinow.com/app/billing?shop=shop_test_123",
      sendEmail: false,
    })).resolves.toEqual({ link: "https://customer.dodopayments.com/session/portal_test_123" });
  });

  it("rejects customer portal links outside Dodo hosts", async () => {
    const config = getDodoConfig(environment("local"));
    await expect(createDodoCustomerPortalSession({
      config,
      customerId: "cus_test_123",
      fetcher: () => Promise.resolve(Response.json({ link: "https://attacker.example/session/portal_test_123" })),
      returnUrl: "https://selinow.com/app/billing?shop=shop_test_123",
    })).rejects.toMatchObject({ code: "billing_provider_invalid", status: 502 });
  });

  it("returns the exact provider-calculated immediate upgrade charge", async () => {
    const config = getDodoConfig(environment("local"));
    const fetcher: typeof fetch = (_url, init) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({
        effective_at: "immediately",
        product_id: "prod_test_pro",
        proration_billing_mode: "prorated_immediately",
        quantity: 1,
      });
      return Promise.resolve(Response.json({ immediate_charge: { summary: { currency: "USD", total_amount: 725 } } }));
    };

    await expect(previewDodoSubscriptionChange({
      config,
      effectiveAt: "immediately",
      fetcher,
      priceId: "prod_test_pro",
      providerSubscriptionId: "sub_test_123",
    })).resolves.toEqual({ amountMinor: 725, currency: "USD" });
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
