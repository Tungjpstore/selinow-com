import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ChannelAdapterRegistry } from "../../src/lib/channels/registry";
import type { ChannelCapability, ChannelConnectionContext } from "../../src/lib/channels/types";
import { CommerceApplicationService } from "../../src/lib/commerce/application";
import type { CommerceApplicationPort, CommerceContext } from "../../src/lib/commerce/contracts";
import {
  attemptFakeOutboundFanOut,
  FakeChannelAdapter,
  FAKE_CHANNEL_CODE,
  FAKE_CHANNEL_MANIFEST,
  type FakeInboundEnvelope,
} from "../helpers/fake-channel-adapter";

const NOW = "2026-07-29T00:00:00.000Z";
const SHOP_ID = "shop-fake-acceptance";

function context(connectionId: string): ChannelConnectionContext {
  return { connectionId, shopId: SHOP_ID };
}

function inboundRequest(envelope: FakeInboundEnvelope, authorization = "Bearer provider-secret-must-not-leak"): Request {
  return new Request("https://fake.invalid/webhook", {
    body: JSON.stringify(envelope),
    headers: {
      authorization,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

function capabilities(...values: ChannelCapability[]): ReadonlySet<ChannelCapability> {
  return new Set(values);
}

describe("reusable fake third-channel adapter acceptance", () => {
  it("covers connect, health degradation, disconnect and registry admission", async () => {
    const adapter = new FakeChannelAdapter({ now: NOW });
    const registry = new ChannelAdapterRegistry([adapter.manifest]);
    const connection = context("connection-fake-lifecycle");

    expect(registry.health([FAKE_CHANNEL_CODE])).toMatchObject({ status: "healthy", unknownProviderCodes: [] });
    await expect(adapter.connect(connection, "connect:intent:fake-lifecycle")).resolves.toEqual({ connectionId: connection.connectionId });
    await expect(adapter.healthCheck(connection)).resolves.toBe("active");

    adapter.setHealth(connection, "degraded");
    await expect(adapter.healthCheck(connection)).resolves.toBe("degraded");
    await adapter.disconnect(connection);
    await expect(adapter.healthCheck(connection)).resolves.toBe("disconnected");
    expect(() => adapter.connect(connection, "connect:intent:fake-lifecycle"))
      .toThrow(expect.objectContaining({ code: "fake_reconnect_not_allowed", status: 409 }));
  });

  it("normalizes reference-only inbound events and enforces scoped idempotency", async () => {
    const adapter = new FakeChannelAdapter({ now: NOW });
    const connection = context("connection-fake-inbound");
    await adapter.connect(connection, "connect:intent:fake-inbound");
    const envelope: FakeInboundEnvelope = {
      action: "cart.open",
      eventReference: "event:fake:0001",
      idempotencyKey: "inbound:fake:0001",
      payloadReference: "payload:stored:0001",
      receivedAt: NOW,
    };

    const first = await adapter.verifyAndNormalize(inboundRequest(envelope), connection);
    const replay = await adapter.verifyAndNormalize(inboundRequest(envelope, "Bearer different-provider-secret"), connection);

    expect(first).toEqual([{
      action: "cart.open",
      channelCode: FAKE_CHANNEL_CODE,
      connectionId: connection.connectionId,
      eventId: "event:fake:0001",
      idempotencyKey: "inbound:fake:0001",
      payloadReference: "payload:stored:0001",
      receivedAt: NOW,
      shopId: SHOP_ID,
    }]);
    expect(replay).toEqual(first);
    expect(JSON.stringify({ events: replay, transcript: adapter.transcript })).not.toContain("provider-secret");
    await expect(adapter.verifyAndNormalize(inboundRequest({
      ...envelope,
      eventReference: "event:fake:conflict",
    }), connection)).rejects.toMatchObject({ code: "fake_inbound_idempotency_conflict", status: 409 });
    await expect(adapter.verifyAndNormalize(new Request("https://fake.invalid/webhook", {
      body: JSON.stringify({ ...envelope, providerPayload: { private: "raw" } }),
      method: "POST",
    }), connection)).rejects.toMatchObject({ code: "fake_inbound_invalid", status: 400 });
  });

  it("fans out reference commands once and leaves retry scheduling to the caller", async () => {
    const primary = context("connection-fake-primary");
    const secondary = context("connection-fake-secondary");
    const adapter = new FakeChannelAdapter({
      now: NOW,
      targets: [
        { ...primary, recipientReference: "recipient:primary" },
        { ...secondary, recipientReference: "recipient:secondary" },
      ],
    });
    await adapter.connect(primary, "connect:intent:fake-primary");
    await adapter.connect(secondary, "connect:intent:fake-secondary");
    adapter.setDeliveryPlan("recipient:primary", ["delivered"]);
    adapter.setDeliveryPlan("recipient:secondary", ["retry", "delivered"]);

    const attempts = await attemptFakeOutboundFanOut({
      adapter,
      capabilities: capabilities("conversation.outbound", "checkout.external_link"),
      contextByConnection: new Map([
        [primary.connectionId, primary],
        [secondary.connectionId, secondary],
      ]),
      view: { kind: "checkout", referenceId: "order:public:0001", shopId: SHOP_ID },
    });

    expect(attempts.map((attempt) => attempt.classification)).toEqual(["delivered", "retry"]);
    expect(attempts.map((attempt) => attempt.command)).toEqual([
      {
        bodyReference: "view:checkout:order:public:0001",
        connectionId: primary.connectionId,
        idempotencyKey: "deliver:checkout:order:public:0001:1",
        purpose: "checkout",
        recipientReference: "recipient:primary",
      },
      {
        bodyReference: "view:checkout:order:public:0001",
        connectionId: secondary.connectionId,
        idempotencyKey: "deliver:checkout:order:public:0001:2",
        purpose: "checkout",
        recipientReference: "recipient:secondary",
      },
    ]);
    expect(attempts.every((attempt) => Object.keys(attempt.command).sort().join(",") === "bodyReference,connectionId,idempotencyKey,purpose,recipientReference")).toBe(true);
    expect(JSON.stringify(attempts)).not.toMatch(/provider-secret|license-plaintext|raw-provider-payload/iu);

    const retryCommand = attempts[1]?.command;
    if (retryCommand === undefined) throw new Error("retry_command_missing");
    const retryReceipt = await adapter.deliver(secondary, retryCommand);
    expect(retryReceipt.status).toBe("delivered");
    expect(retryReceipt.providerMessageReference).toMatch(/^message:/u);
    await expect(adapter.deliver(secondary, retryCommand)).resolves.toEqual(retryReceipt);

    const deliveryEntries = adapter.transcript.filter((entry) => entry.operation === "deliver");
    expect(deliveryEntries).toHaveLength(4);
    expect(deliveryEntries.map((entry) => entry.status)).toEqual(["success", "error", "success", "success"]);
  });

  it("classifies recipient, terminal and unknown errors without provider details", async () => {
    const recipientContext = context("connection-fake-recipient");
    const terminalContext = context("connection-fake-terminal");
    const adapter = new FakeChannelAdapter({
      now: NOW,
      targets: [
        { ...recipientContext, recipientReference: "recipient:missing" },
        { ...terminalContext, recipientReference: "recipient:terminal" },
      ],
    });
    await adapter.connect(recipientContext, "connect:intent:fake-recipient");
    await adapter.connect(terminalContext, "connect:intent:fake-terminal");
    adapter.setDeliveryPlan("recipient:missing", ["recipient_unavailable"]);
    adapter.setDeliveryPlan("recipient:terminal", ["terminal"]);

    const attempts = await attemptFakeOutboundFanOut({
      adapter,
      capabilities: capabilities("conversation.outbound", "fulfillment.push"),
      contextByConnection: new Map([
        [recipientContext.connectionId, recipientContext],
        [terminalContext.connectionId, terminalContext],
      ]),
      view: { kind: "fulfillment", referenceId: "fulfillment:public:0001", shopId: SHOP_ID },
    });

    expect(attempts.map((attempt) => attempt.classification)).toEqual(["recipient_unavailable", "terminal"]);
    expect(adapter.classifyError(new Error("untyped_transport_failure"))).toBe("retry");
  });

  it("runs a canonical application contract scenario for the fake channel without adapter business writes", async () => {
    const observedContexts: CommerceContext[] = [];
    const port: CommerceApplicationPort = {
      checkoutCart: vi.fn<CommerceApplicationPort["checkoutCart"]>((input) => {
        observedContexts.push(input.context);
        return Promise.resolve({
          access: { kind: "principal" },
          currency: "VND",
          expiresAt: "2026-07-29T00:30:00.000Z",
          fulfillmentStatus: "reserved",
          orderId: "order-fake-0001",
          orderNumber: "FAKE-0001",
          paymentStatus: "unpaid",
          status: "pending_payment",
          totalMinor: 12000,
        });
      }),
      createCart: vi.fn<CommerceApplicationPort["createCart"]>((input) => {
        observedContexts.push(input.context);
        return Promise.resolve({ access: { kind: "principal" }, cartId: "cart-fake-0001", expiresAt: "2026-07-29T00:30:00.000Z" });
      }),
      getOrder: vi.fn<CommerceApplicationPort["getOrder"]>(() => Promise.resolve({
        currency: "VND",
        expiresAt: "2026-07-29T00:30:00.000Z",
        fulfillmentStatus: "reserved",
        items: [{ fulfillmentType: "manual", lineTotalMinor: 12000, productTitle: "Reference product", quantity: 1, variantTitle: "Reference variant" }],
        orderNumber: "FAKE-0001",
        paymentStatus: "unpaid",
        status: "pending_payment",
        totalMinor: 12000,
      })),
      quoteCart: vi.fn<CommerceApplicationPort["quoteCart"]>((input) => {
        observedContexts.push(input.context);
        return Promise.resolve({
          currency: "VND",
          discountMinor: 0,
          expiresAt: "2026-07-29T00:05:00.000Z",
          items: [{ lineTotalMinor: 12000, productTitle: "Reference product", quantity: 1, unitPriceMinor: 12000, variantId: "variant-fake-0001", variantTitle: "Reference variant", variantVersion: 1 }],
          subtotalMinor: 12000,
          totalMinor: 12000,
        });
      }),
    };
    const application = new CommerceApplicationService(port);
    const commerceContext: CommerceContext = {
      actor: { customerId: "customer-fake-0001", kind: "customer" },
      channel: { code: FAKE_CHANNEL_CODE, connectionId: "connection-fake-commerce" },
      locale: "vi",
      requestId: "request-fake-commerce-0001",
      shopId: SHOP_ID,
    };

    const cart = await application.createCart(commerceContext, { items: [{ quantity: 1, variantId: "variant-fake-0001" }] });
    const quote = await application.quoteCart(commerceContext, { cart: { access: cart.access, cartId: cart.cartId } });
    const checkout = await application.checkoutCart(commerceContext, {
      cart: { access: cart.access, cartId: cart.cartId },
      customerEmail: null,
      expected: quote.items.map((item) => ({ quantity: item.quantity, unitPriceMinor: item.unitPriceMinor, variantId: item.variantId, variantVersion: item.variantVersion })),
      idempotencyKey: "checkout:fake:0001",
    });

    expect(checkout).toMatchObject({ orderId: "order-fake-0001", status: "pending_payment", totalMinor: 12000 });
    expect(observedContexts).toHaveLength(3);
    expect(observedContexts.every((value) => value.channel.code === FAKE_CHANNEL_CODE && value.channel.connectionId === "connection-fake-commerce")).toBe(true);
    const helperSource = readFileSync(join(process.cwd(), "tests/helpers/fake-channel-adapter.ts"), "utf8");
    expect(helperSource).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b[\s\S]{0,48}\b(?:carts|orders|inventory_keys|fulfillments)\b/iu);
  });

  it("exports a stable manifest for reuse by additional adapter acceptance suites", () => {
    expect(FAKE_CHANNEL_MANIFEST).toEqual({
      capabilities: [
        "conversation.inbound",
        "conversation.outbound",
        "message.rich_ui",
        "catalog.read",
        "cart.interactive",
        "checkout.external_link",
        "orders.status_push",
        "fulfillment.push",
      ],
      code: FAKE_CHANNEL_CODE,
      version: 1,
    });
  });
});
