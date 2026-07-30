import { describe, expect, it, vi } from "vitest";

import { CommerceApplicationService } from "../../src/lib/commerce/application";
import type { CommerceContext, CommerceOrderView } from "../../src/lib/commerce/contracts";
import { CommercePaymentFulfillmentService, type CommercePaymentFulfillmentPort } from "../../src/lib/commerce/payment-fulfillment";
import { renderTelegramCheckoutResult, type TelegramOrderSummary } from "../../src/lib/telegram/commerce";

const context: CommerceContext = {
  actor: { customerId: "customer-telegram", kind: "customer" },
  channel: { code: "telegram", connectionId: "connection-telegram" },
  locale: "vi",
  requestId: "request-telegram-checkout",
  shopId: "shop-telegram",
};

function orderView(order: TelegramOrderSummary): CommerceOrderView {
  return {
    currency: order.currency,
    expiresAt: "2026-07-29T02:00:00.000Z",
    fulfillmentStatus: order.fulfillmentStatus,
    items: [],
    orderNumber: order.orderNumber,
    paymentStatus: order.paymentStatus,
    status: order.status,
    totalMinor: order.totalMinor,
  };
}

function createOrderApplication(order: TelegramOrderSummary, paymentFulfillment?: CommercePaymentFulfillmentService): CommerceApplicationService {
  return new CommerceApplicationService({ getOrder: () => Promise.resolve(orderView(order)) }, paymentFulfillment);
}

function createPaymentApplication(input: { eligible: boolean; expiresAt?: string; revealFulfillment?: CommercePaymentFulfillmentPort["revealFulfillment"] }): { application: CommercePaymentFulfillmentService; reveal: ReturnType<typeof vi.fn<CommercePaymentFulfillmentPort["revealFulfillment"]>> } {
  const reveal = vi.fn<CommercePaymentFulfillmentPort["revealFulfillment"]>(input.revealFulfillment ?? (() => Promise.resolve({ items: [], orderId: "order-telegram" })));
  const port: CommercePaymentFulfillmentPort = {
    createPaymentHandoff: () => Promise.resolve({ expiresAt: input.expiresAt ?? "2026-07-29T02:00:00.000Z", handoffId: "handoff-telegram", presentation: null, redirectUrl: "https://pay.example.test", status: "pending" }),
    getFulfillmentEligibility: ({ command }) => Promise.resolve({ eligible: input.eligible, orderId: command.order.orderId, reason: input.eligible ? "ready" : "fulfillment_pending" }),
    revealFulfillment: reveal,
  };
  return { application: new CommercePaymentFulfillmentService(port), reveal };
}

describe("Telegram canonical checkout replies", () => {
  it("renders payment expiry in the buyer locale without exposing the raw ISO value", async () => {
    const order: TelegramOrderSummary = { currency: "VND", fulfillmentStatus: "unfulfilled", orderId: "order-unpaid", orderNumber: "ORDER-UNPAID", paymentStatus: "unpaid", status: "pending_payment", totalMinor: 199_000 };
    const payment = createPaymentApplication({ eligible: false });
    const application = createOrderApplication(order, payment.application);

    const reply = await renderTelegramCheckoutResult({ context, order, orderApplication: application, origin: "https://shop.example.test", paymentApplication: application });

    expect(reply.text).toContain("Hết hạn:");
    expect(reply.text).not.toContain("2026-07-29T02:00:00.000Z");
    expect(reply.text).toContain(new Intl.DateTimeFormat("vi-VN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "UTC",
    }).format(new Date("2026-07-29T02:00:00.000Z")));
  });

  it("renders a processing order for a paid manual-only checkout without attempting key reveal", async () => {
    const order: TelegramOrderSummary = { currency: "VND", fulfillmentStatus: "unfulfilled", orderId: "order-manual", orderNumber: "ORDER-MANUAL", paymentStatus: "paid", status: "processing", totalMinor: 0 };
    const payment = createPaymentApplication({ eligible: false });
    const application = createOrderApplication(order, payment.application);

    await expect(renderTelegramCheckoutResult({ context, order, orderApplication: application, origin: "https://shop.example.test", paymentApplication: application })).resolves.toEqual({
      keyboard: [[{ callback_data: "menu", text: "Menu" }]],
      text: "Đơn ORDER-MANUAL\nTổng: 0 ₫\nThanh toán: Đã thanh toán\nTrạng thái: Đang xử lý\nGiao hàng: Chưa giao",
    });
    expect(payment.reveal).not.toHaveBeenCalled();
  });

  it("reveals the ready digital allocation for a paid mixed checkout while manual work remains", async () => {
    const order: TelegramOrderSummary = { currency: "VND", fulfillmentStatus: "unfulfilled", orderId: "order-mixed", orderNumber: "ORDER-MIXED", paymentStatus: "paid", status: "processing", totalMinor: 0 };
    const payment = createPaymentApplication({
      eligible: true,
      revealFulfillment: ({ command }) => Promise.resolve({
        items: [{ productTitle: "Digital add-on", value: "KEY-MIXED-ONLY", variantTitle: "Lifetime" }],
        orderId: command.order.orderId,
      }),
    });
    const application = createOrderApplication(order, payment.application);

    await expect(renderTelegramCheckoutResult({ context, order, orderApplication: application, origin: "https://shop.example.test", paymentApplication: application })).resolves.toEqual({
      keyboard: [[{ callback_data: "ord:order-mixed", text: "Xem đơn" }]],
      protectContent: true,
      text: "Key của đơn ORDER-MIXED\n\n1. Digital add-on - Lifetime\nKEY-MIXED-ONLY",
    });
    expect(payment.reveal).toHaveBeenCalledOnce();
  });

  it("renders the same checkout outcome with the English catalog", async () => {
    const order: TelegramOrderSummary = { currency: "USD", fulfillmentStatus: "fulfilled", orderId: "order-english", orderNumber: "ORDER-ENGLISH", paymentStatus: "paid", status: "completed", totalMinor: 1_234 };
    const payment = createPaymentApplication({ eligible: true, revealFulfillment: ({ command }) => Promise.resolve({ items: [{ productTitle: "Digital add-on", value: "KEY-ENGLISH", variantTitle: "Lifetime" }], orderId: command.order.orderId }) });
    const application = createOrderApplication(order, payment.application);

    await expect(renderTelegramCheckoutResult({ context: { ...context, locale: "en" }, order, orderApplication: application, origin: "https://shop.example.test", paymentApplication: application })).resolves.toEqual({
      keyboard: [[{ callback_data: "ord:order-english", text: "View order" }]],
      protectContent: true,
      text: "Keys for order ORDER-ENGLISH\n\n1. Digital add-on - Lifetime\nKEY-ENGLISH",
    });
  });
});
