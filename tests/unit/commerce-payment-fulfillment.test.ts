import { describe, expect, it, vi } from "vitest";

import type { CommerceContext, CommerceOrderReference } from "../../src/lib/commerce/contracts";
import {
  CommercePaymentFulfillmentService,
  PrincipalPaymentFulfillmentPort,
  WebsitePaymentFulfillmentPort,
  type CommercePaymentFulfillmentPort,
} from "../../src/lib/commerce/payment-fulfillment";
import { hmacToken } from "../../src/lib/core/crypto";
import { encryptInventoryKey } from "../../src/lib/crypto/inventory";
import {
  revealPrincipalDigitalFulfillment,
  revealWebsiteDigitalFulfillment,
} from "../../src/lib/commerce/digital-fulfillment";
import { getPaymentFulfillmentEligibility } from "../../src/lib/payments/store";
import type { AppBindings } from "../../src/lib/platform/bindings";
import type { StorefrontShop } from "../../src/lib/storefront/store";
import { FALLBACK_STOREFRONT_TEMPLATE } from "../../src/lib/storefront/templates";

const order: CommerceOrderReference = {
  access: { kind: "opaque_token", token: "order-access-token-1234567890" },
  orderId: "order_11111111-1111-4111-8111-111111111111",
};

const context: CommerceContext = {
  actor: { kind: "anonymous" },
  channel: { code: "website", connectionId: null },
  locale: "vi",
  requestId: "request-payment-fulfillment-001",
  shopId: "shop-a",
};

const principalOrder: CommerceOrderReference = {
  access: { kind: "principal" },
  orderId: order.orderId,
};

const principalContext: CommerceContext = {
  actor: { customerId: "customer-a", kind: "customer" },
  channel: { code: "telegram", connectionId: "conn-telegram-a" },
  locale: "vi",
  requestId: "request-principal-payment-001",
  shopId: "shop-a",
};

const shop: StorefrontShop = {
  access: "live",
  canonicalHostname: "signal.example.test",
  content: { announcement: null, deliveryText: "", description: "", footerText: "", headline: "", seoDescription: "", seoTitle: "", showExactStock: false, supportText: "", templateId: null },
  currency: "VND",
  currentHostname: "signal.example.test",
  defaultLocale: "vi",
  id: "shop-a",
  lowStockThreshold: 5,
  name: "Signal",
  orderExpiryMinutes: 30,
  publicDetails: { deliveryText: "", privacyUrl: null, refundPolicyUrl: null, support: { href: null, label: "Support" }, termsUrl: null },
  publicId: "shop_11111111-1111-4111-8111-111111111111",
  settingsVersion: 1,
  slug: "signal",
  status: "active",
  subscriptionState: "active",
  timezone: "Asia/Ho_Chi_Minh",
  template: FALLBACK_STOREFRONT_TEMPLATE,
  theme: { accent: "#E9A62F", accentInk: "#102824", brand: "#176B5B", brandInk: "#FFF9EA", logoUrl: null },
};

function createPort(input: { eligible?: boolean } = {}): {
  createPaymentHandoff: ReturnType<typeof vi.fn<CommercePaymentFulfillmentPort["createPaymentHandoff"]>>;
  port: CommercePaymentFulfillmentPort;
  revealFulfillment: ReturnType<typeof vi.fn<CommercePaymentFulfillmentPort["revealFulfillment"]>>;
} {
  const eligible = input.eligible ?? true;
  const eligibilityReason = eligible ? "ready" as const : "payment_unconfirmed" as const;
  const createPaymentHandoff = vi.fn<CommercePaymentFulfillmentPort["createPaymentHandoff"]>(() => Promise.resolve({
    expiresAt: "2026-07-29T02:00:00.000Z",
    handoffId: "pat-internal-1",
    presentation: { kind: "qr", payload: "qr-payload" },
    providerPaymentLinkId: "must-not-leak",
    redirectUrl: "https://pay.example.test/checkout",
    status: "pending",
  } as never));
  const revealFulfillment = vi.fn<CommercePaymentFulfillmentPort["revealFulfillment"]>(() => Promise.resolve({
    items: [{ productTitle: "Editor", value: "LICENSE-ONLY", variantTitle: "Lifetime" }],
    orderId: order.orderId,
  }));
  return { port: {
    createPaymentHandoff,
    getFulfillmentEligibility: vi.fn(() => Promise.resolve({
      eligible,
      orderId: order.orderId,
      reason: eligibilityReason,
    })),
    revealFulfillment,
  }, createPaymentHandoff, revealFulfillment };
}

describe("canonical payment and fulfillment capability", () => {
  it("projects a provider-neutral handoff without leaking adapter identity", async () => {
    const service = new CommercePaymentFulfillmentService(createPort().port);
    const handoff = await service.createPaymentHandoff(context, { order, origin: "https://signal.example.test" });

    expect(handoff).toEqual({
      expiresAt: "2026-07-29T02:00:00.000Z",
      handoffId: "pat-internal-1",
      presentation: { kind: "qr", payload: "qr-payload" },
      redirectUrl: "https://pay.example.test/checkout",
      status: "pending",
    });
    expect(JSON.stringify(handoff)).not.toContain("provider");
  });

  it("checks fulfillment eligibility before any secret reveal", async () => {
    const { port, revealFulfillment } = createPort({ eligible: false });
    const service = new CommercePaymentFulfillmentService(port);

    await expect(service.revealFulfillment(context, { order })).rejects.toMatchObject({ code: "order_not_ready", status: 409 });
    expect(revealFulfillment).not.toHaveBeenCalled();
  });

  it("returns only the canonical secret projection after eligibility passes", async () => {
    const service = new CommercePaymentFulfillmentService(createPort().port);
    await expect(service.revealFulfillment(context, { order })).resolves.toEqual({
      items: [{ productTitle: "Editor", value: "LICENSE-ONLY", variantTitle: "Lifetime" }],
      orderId: order.orderId,
    });
  });

  it("maps the existing website payment store behind the capability port", async () => {
    const createPaymentLink = vi.fn(() => Promise.resolve({
      checkoutUrl: "https://pay.payos.vn/web/link-1",
      expiresAt: "2026-07-29T02:00:00.000Z",
      paymentAttemptId: "pat-internal-1",
      qrCode: "qr-payload",
      state: "pending",
    }));
    const port = new WebsitePaymentFulfillmentPort({} as AppBindings, shop, { createPaymentLink });
    const service = new CommercePaymentFulfillmentService(port);

    await expect(service.createPaymentHandoff(context, { order, origin: "https://signal.example.test" })).resolves.toEqual({
      expiresAt: "2026-07-29T02:00:00.000Z",
      handoffId: "pat-internal-1",
      presentation: { kind: "qr", payload: "qr-payload" },
      redirectUrl: "https://pay.payos.vn/web/link-1",
      status: "pending",
    });
    expect(createPaymentLink).toHaveBeenCalledWith({
      env: {},
      orderPublicId: order.orderId,
      orderToken: "order-access-token-1234567890",
      origin: "https://signal.example.test",
      shopId: "shop-a",
    });
  });

  it.each([
    { eligible: false, reason: "payment_unconfirmed" },
    { eligible: false, reason: "fulfillment_pending" },
    { eligible: true, reason: "ready" },
    { eligible: false, reason: "order_expired" },
  ] as const)("maps the payment domain eligibility decision without provider fields", async (decision) => {
    const getEligibility = vi.fn(() => Promise.resolve(decision));
    const service = new CommercePaymentFulfillmentService(new WebsitePaymentFulfillmentPort({} as AppBindings, shop, { getEligibility }));

    await expect(service.getFulfillmentEligibility(context, { order })).resolves.toEqual({
      ...decision,
      orderId: order.orderId,
    });
    expect(getEligibility).toHaveBeenCalledWith({
      env: {},
      orderPublicId: order.orderId,
      orderToken: "order-access-token-1234567890",
      shopId: "shop-a",
    });
  });

  it("rejects cross-tenant context before calling the payment adapter", async () => {
    const createPaymentLink = vi.fn(() => Promise.reject(new Error("adapter_should_not_run")));
    const service = new CommercePaymentFulfillmentService(new WebsitePaymentFulfillmentPort({} as AppBindings, shop, { createPaymentLink }));

    await expect(service.createPaymentHandoff({ ...context, shopId: "shop-b" }, { order, origin: "https://signal.example.test" }))
      .rejects.toMatchObject({ code: "commerce_context_mismatch", issues: ["shop_id_mismatch"], status: 403 });
    expect(createPaymentLink).not.toHaveBeenCalled();
  });

  it("rejects provider identity fields at the capability boundary", async () => {
    const port = createPort().port;
    const service = new CommercePaymentFulfillmentService(port);
    await expect(service.createPaymentHandoff({
      ...context,
      actor: { kind: "anonymous", telegramUserId: "123" } as never,
    }, { order, origin: "https://signal.example.test" })).rejects.toMatchObject({ code: "validation_failed", issues: ["commerce_actor_invalid"], status: 400 });
    await expect(service.createPaymentHandoff(context, {
      order,
      origin: "https://signal.example.test",
      providerOrderCode: 123,
    } as never)).rejects.toMatchObject({ code: "validation_failed", issues: ["payment_handoff_invalid"], status: 400 });
  });

  it.each(["EN-us", "vi-Latn-VN", "en-US-u-nu-latn"])("accepts supported BCP47 locale hint %s at the payment boundary", async (locale) => {
    const { createPaymentHandoff, port } = createPort();
    const service = new CommercePaymentFulfillmentService(port);

    await expect(service.createPaymentHandoff({ ...context, locale }, { order, origin: "https://signal.example.test" }))
      .resolves.toMatchObject({ handoffId: "pat-internal-1" });
    expect(createPaymentHandoff).toHaveBeenCalledOnce();
  });

  it.each(["fr-FR", "vi_VN", "not a locale"])("rejects unsupported or malformed locale hint %s at the payment boundary", async (locale) => {
    const { createPaymentHandoff, port } = createPort();
    const service = new CommercePaymentFulfillmentService(port);

    await expect(service.createPaymentHandoff({ ...context, locale }, { order, origin: "https://signal.example.test" }))
      .rejects.toMatchObject({ code: "validation_failed", issues: ["locale_invalid"], status: 400 });
    expect(createPaymentHandoff).not.toHaveBeenCalled();
  });

  it("supports customer-principal payment and fulfillment without channel identity in the contract", async () => {
    const createPaymentHandoff = vi.fn(() => Promise.resolve({
      checkoutUrl: "https://pay.example.test/checkout",
      expiresAt: "2026-07-29T02:00:00.000Z",
      paymentAttemptId: "pat-principal-1",
      qrCode: "",
      state: "pending",
    }));
    const getEligibility = vi.fn(() => Promise.resolve({ eligible: true as const, reason: "ready" as const }));
    const revealFulfillment = vi.fn(() => Promise.resolve({
      items: [{ productTitle: "Editor", value: "LICENSE-ONLY", variantTitle: "Lifetime" }],
      orderId: order.orderId,
    }));
    const port = new PrincipalPaymentFulfillmentPort({} as AppBindings, "shop-a", null, { createPaymentHandoff, getEligibility, revealFulfillment });
    const service = new CommercePaymentFulfillmentService(port);

    await expect(service.createPaymentHandoff(principalContext, { order: principalOrder, origin: "https://telegram.example.test" })).resolves.toMatchObject({ handoffId: "pat-principal-1", presentation: null });
    await expect(service.revealFulfillment(principalContext, { order: principalOrder })).resolves.toEqual({
      items: [{ productTitle: "Editor", value: "LICENSE-ONLY", variantTitle: "Lifetime" }],
      orderId: order.orderId,
    });
    expect(createPaymentHandoff).toHaveBeenCalledWith({
      customerId: "customer-a",
      env: {},
      orderPublicId: order.orderId,
      origin: "https://telegram.example.test",
      shopId: "shop-a",
    });
    expect(getEligibility).toHaveBeenCalledWith({ customerId: "customer-a", env: {}, orderPublicId: order.orderId, shopId: "shop-a" });
    expect(revealFulfillment).toHaveBeenCalledWith({ customerId: "customer-a", env: {}, orderPublicId: order.orderId, shopId: "shop-a" });
    await expect(service.createPaymentHandoff({ ...principalContext, shopId: "shop-b" }, { order: principalOrder, origin: "https://telegram.example.test" }))
      .rejects.toMatchObject({ code: "commerce_context_mismatch", issues: ["shop_id_mismatch"], status: 403 });
    const telegramPort = new PrincipalPaymentFulfillmentPort({} as AppBindings, "shop-a", "telegram", { createPaymentHandoff, getEligibility, revealFulfillment });
    await expect(new CommercePaymentFulfillmentService(telegramPort).createPaymentHandoff({
      ...principalContext,
      channel: { code: "website", connectionId: null },
    }, { order: principalOrder, origin: "https://signal.example.test" })).rejects.toMatchObject({ code: "commerce_context_mismatch", issues: ["channel_required"], status: 403 });
  });

  it("forwards Telegram connection identity to payment and fulfillment stores", async () => {
    const createPaymentHandoff = vi.fn(() => Promise.resolve({
      checkoutUrl: "https://pay.example.test/checkout",
      expiresAt: "2026-07-29T02:00:00.000Z",
      paymentAttemptId: "pat-telegram-connection-1",
      qrCode: "",
      state: "pending",
    }));
    const getEligibility = vi.fn(() => Promise.resolve({ eligible: true as const, reason: "ready" as const }));
    const revealFulfillment = vi.fn(() => Promise.resolve({
      items: [{ productTitle: "Editor", value: "LICENSE-ONLY", variantTitle: "Lifetime" }],
      orderId: order.orderId,
    }));
    const port = new PrincipalPaymentFulfillmentPort({} as AppBindings, "shop-a", "telegram", {
      createPaymentHandoff,
      getEligibility,
      revealFulfillment,
    });
    const service = new CommercePaymentFulfillmentService(port);

    await expect(service.createPaymentHandoff(principalContext, { order: principalOrder, origin: "https://telegram.example.test" }))
      .resolves.toMatchObject({ handoffId: "pat-telegram-connection-1" });
    await expect(service.getFulfillmentEligibility(principalContext, { order: principalOrder }))
      .resolves.toEqual({ eligible: true, orderId: order.orderId, reason: "ready" });
    await expect(service.revealFulfillment(principalContext, { order: principalOrder }))
      .resolves.toEqual({ items: [{ productTitle: "Editor", value: "LICENSE-ONLY", variantTitle: "Lifetime" }], orderId: order.orderId });

    expect(createPaymentHandoff).toHaveBeenCalledWith({
      connectionId: "conn-telegram-a",
      customerId: "customer-a",
      env: {},
      orderPublicId: order.orderId,
      origin: "https://telegram.example.test",
      shopId: "shop-a",
      sourceChannel: "telegram",
    });
    expect(getEligibility).toHaveBeenCalledWith({
      connectionId: "conn-telegram-a",
      customerId: "customer-a",
      env: {},
      orderPublicId: order.orderId,
      shopId: "shop-a",
      sourceChannel: "telegram",
    });
    expect(revealFulfillment).toHaveBeenCalledWith({
      connectionId: "conn-telegram-a",
      customerId: "customer-a",
      env: {},
      orderPublicId: order.orderId,
      shopId: "shop-a",
      sourceChannel: "telegram",
    });
  });

  it.each([
    [{ expiresAt: "2099-01-01T00:00:00.000Z", fulfillmentStatus: "reserved", paymentStatus: "unpaid", status: "pending_payment" }, 0, { eligible: false, reason: "payment_unconfirmed" }],
    [{ expiresAt: "2099-01-01T00:00:00.000Z", fulfillmentStatus: "reserved", paymentStatus: "paid", status: "processing" }, 0, { eligible: false, reason: "fulfillment_pending" }],
    [{ expiresAt: "2099-01-01T00:00:00.000Z", fulfillmentStatus: "unfulfilled", paymentStatus: "paid", status: "processing" }, 0, { eligible: false, reason: "fulfillment_pending" }],
    [{ expiresAt: "2099-01-01T00:00:00.000Z", fulfillmentStatus: "unfulfilled", paymentStatus: "paid", status: "processing" }, 1, { eligible: true, reason: "ready" }],
    [{ expiresAt: "2099-01-01T00:00:00.000Z", fulfillmentStatus: "fulfilled", paymentStatus: "paid", status: "completed" }, 1, { eligible: true, reason: "ready" }],
    [{ expiresAt: "2000-01-01T00:00:00.000Z", fulfillmentStatus: "fulfilled", paymentStatus: "paid", status: "completed" }, 1, { eligible: true, reason: "ready" }],
    [{ expiresAt: "2000-01-01T00:00:00.000Z", fulfillmentStatus: "unfulfilled", paymentStatus: "expired", status: "expired" }, 0, { eligible: false, reason: "order_expired" }],
    [{ expiresAt: "2099-01-01T00:00:00.000Z", fulfillmentStatus: "fulfilled", paymentStatus: "paid", status: "exception" }, 1, { eligible: false, reason: "order_ineligible" }],
  ] as const)("lets the payment domain decide fulfillment eligibility from authorized order state", async (state, digitalItemCount, expected) => {
    const tokenHash = await hmacToken("identifier-secret-payment-eligibility", "order-access", "order-access-token-1234567890");
    const database = {
      prepare(sql: string) {
        if (sql.includes("SELECT COUNT(*) AS digitalItemCount")) {
          return {
            bind: () => ({ first: () => Promise.resolve({ digitalItemCount }) }),
          };
        }
        expect(sql).toContain("fulfillment_status AS fulfillmentStatus");
        return {
          bind(orderId: string, shopId: string) {
            return {
              first: () => Promise.resolve(orderId === order.orderId && shopId === "shop-a" ? {
                currency: "VND",
                id: "ord-internal-1",
                orderPublicId: order.orderId,
                orderTokenHash: tokenHash,
                shopId: "shop-a",
                totalMinor: 9_000,
                ...state,
              } : null),
            };
          },
        };
      },
    };
    const env = { IDENTIFIER_HMAC_SECRET: "identifier-secret-payment-eligibility", PLATFORM_DB: database } as unknown as AppBindings;

    await expect(getPaymentFulfillmentEligibility({
      env,
      orderPublicId: order.orderId,
      orderToken: "order-access-token-1234567890",
      shopId: "shop-a",
    })).resolves.toEqual(expected);
  });

  it("reveals only allocated digital keys for a paid mixed order", async () => {
    const secret = "identifier-secret-mixed-fulfillment";
    const inventoryKek = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const encrypted = await encryptInventoryKey({
      hmacSecret: secret,
      keyVersion: "v1",
      kek: inventoryKek,
      plaintext: "MIXED-DIGITAL-KEY",
      shopId: "shop-a",
      variantId: "var-digital",
    });
    let revealQueryCount = 0;
    const database = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql.includes("SELECT COUNT(*) AS digitalItemCount")) return { first: () => Promise.resolve({ digitalItemCount: 1 }) };
            if (sql.includes("SELECT id, public_id AS orderPublicId")) {
              return {
                first: () => Promise.resolve(values[0] === order.orderId && values[1] === "shop-a" && values[2] === "customer-a" ? {
                  currency: "VND",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                  fulfillmentStatus: "unfulfilled",
                  id: "ord-mixed-1",
                  orderPublicId: order.orderId,
                  orderTokenHash: "not-used-for-principal",
                  paymentStatus: "paid",
                  shopId: "shop-a",
                  status: "processing",
                  totalMinor: 18_000,
                } : null),
              };
            }
            if (sql.includes("FROM orders") && sql.includes("INNER JOIN fulfillment_items")) {
              revealQueryCount += 1;
              expect(values).toEqual([order.orderId, "shop-a", "customer-a"]);
              return {
                all: () => Promise.resolve({ results: [{
                  ciphertextB64: encrypted.ciphertextB64,
                  ivB64: encrypted.ivB64,
                  keyVersion: encrypted.keyVersion,
                  productTitle: "Editor",
                  variantId: "var-digital",
                  variantTitle: "Lifetime",
                }] }),
              };
            }
            throw new Error(`unexpected_query:${sql}`);
          },
        };
      },
    };
    const env = { IDENTIFIER_HMAC_SECRET: secret, INVENTORY_KEK_V1: inventoryKek, PLATFORM_DB: database } as unknown as AppBindings;

    await expect(revealPrincipalDigitalFulfillment({ customerId: "customer-a", env, orderPublicId: order.orderId, shopId: "shop-a" })).resolves.toEqual({
      items: [{ productTitle: "Editor", value: "MIXED-DIGITAL-KEY", variantTitle: "Lifetime" }],
      orderId: order.orderId,
    });
    expect(revealQueryCount).toBe(1);
    await expect(revealPrincipalDigitalFulfillment({ customerId: "customer-b", env, orderPublicId: order.orderId, shopId: "shop-a" })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
    await expect(revealPrincipalDigitalFulfillment({ customerId: "customer-a", env, orderPublicId: order.orderId, shopId: "shop-b" })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
    expect(revealQueryCount).toBe(1);
  });

  it("rejects a non-web order at the opaque website payment and fulfillment boundary", async () => {
    const secret = "identifier-secret-website-source-boundary";
    const token = "order-access-token-website-source-boundary";
    const tokenHash = await hmacToken(secret, "order-access", token);
    const database = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql.includes("SELECT orders.id, orders.public_id AS orderPublicId")) {
              const sourceBound = sql.includes("orders.source_channel = ?") && values.includes("web");
              return {
                first: () => Promise.resolve(sourceBound ? null : {
                  currency: "VND",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                  fulfillmentStatus: "fulfilled",
                  id: "ord-telegram-only",
                  orderPublicId: order.orderId,
                  orderTokenHash: tokenHash,
                  paymentStatus: "paid",
                  shopId: "shop-a",
                  status: "completed",
                  totalMinor: 9_000,
                }),
              };
            }
            if (sql.includes("SELECT COUNT(*) AS digitalItemCount")) {
              return { first: () => Promise.resolve({ digitalItemCount: 1 }) };
            }
            throw new Error(`unexpected_query:${sql}:${JSON.stringify(values)}`);
          },
        };
      },
    };
    const env = { IDENTIFIER_HMAC_SECRET: secret, PLATFORM_DB: database } as unknown as AppBindings;

    await expect(getPaymentFulfillmentEligibility({
      env,
      orderPublicId: order.orderId,
      orderToken: token,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
    await expect(revealWebsiteDigitalFulfillment({
      env,
      orderPublicId: order.orderId,
      orderToken: token,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "order_not_found", status: 404 });
  });

  it("re-checks paid order state at the key-read boundary after eligibility passes", async () => {
    const secret = "identifier-secret-key-reveal-interleaving";
    const token = "order-access-token-key-reveal-interleaving";
    const tokenHash = await hmacToken(secret, "order-access", token);
    let stateChanged = false;
    let keyReadCount = 0;
    const database = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            if (sql.includes("SELECT orders.id, orders.public_id AS orderPublicId")) {
              return {
                first: () => Promise.resolve({
                  currency: "VND",
                  expiresAt: "2099-01-01T00:00:00.000Z",
                  fulfillmentStatus: "fulfilled",
                  id: "ord-reveal-interleaving",
                  orderPublicId: order.orderId,
                  orderTokenHash: tokenHash,
                  paymentStatus: "paid",
                  shopId: "shop-a",
                  status: "completed",
                  totalMinor: 9_000,
                }),
              };
            }
            if (sql.includes("SELECT COUNT(*) AS digitalItemCount")) {
              return {
                first: () => {
                  stateChanged = true;
                  return Promise.resolve({ digitalItemCount: 1 });
                },
              };
            }
            if (sql.includes("FROM orders") && sql.includes("INNER JOIN fulfillment_items")) {
              keyReadCount += 1;
              expect(stateChanged).toBe(true);
              expect(sql).toContain("orders.payment_status = 'paid'");
              expect(sql).toContain("orders.status IN ('processing', 'completed')");
              expect(values).toEqual([order.orderId, "shop-a", "web", "website", 1]);
              return { all: () => Promise.resolve({ results: [] }) };
            }
            throw new Error(`unexpected_query:${sql}:${JSON.stringify(values)}`);
          },
        };
      },
    };
    const env = { IDENTIFIER_HMAC_SECRET: secret, PLATFORM_DB: database } as unknown as AppBindings;

    await expect(revealWebsiteDigitalFulfillment({
      env,
      orderPublicId: order.orderId,
      orderToken: token,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "order_not_ready", status: 409 });
    expect(keyReadCount).toBe(1);
  });
});
