import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  env: { APP_ENV: "local" },
  processPayOSWebhook: vi.fn(),
}));

vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));
vi.mock("../../src/lib/payments/webhooks", () => ({ processPayOSWebhook: dependencies.processPayOSWebhook }));

import { POST } from "../../src/pages/webhooks/payos/[webhookPublicId]";

function context(request: Request, webhookPublicId = "paywh_00000000-0000-4000-8000-000000000001") {
  return {
    locals: { requestId: "request-payos-reversal-route" },
    params: { webhookPublicId },
    request,
  } as never;
}

describe("PayOS reversal webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dependencies.processPayOSWebhook.mockResolvedValue({
      duplicate: false,
      processed: true,
      state: "full_refund",
    });
  });

  it("forwards the signed envelope to the runtime and returns a no-store result", async () => {
    const body = {
      code: "00",
      data: {
        amount: 1000,
        currency: "USD",
        description: "A",
        orderCode: 70001,
        reference: "refund-route-a",
        reversalKind: "refund",
        transactionDateTime: "2026-07-30T02:10:00.000Z",
      },
      signature: "signed-data-only",
      success: true,
    };
    const response = await POST(context(new Request("https://shop.example.test/webhooks", {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    })));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      data: { duplicate: false, processed: true, state: "full_refund" },
      success: true,
    });
    expect(dependencies.processPayOSWebhook).toHaveBeenCalledWith({
      body,
      env: dependencies.env,
      webhookPublicId: "paywh_00000000-0000-4000-8000-000000000001",
    });
  });

  it("rejects malformed route identities before reading or forwarding a webhook", async () => {
    const response = await POST(context(new Request("https://shop.example.test/webhooks", {
      body: JSON.stringify({ data: {}, signature: "ignored" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    }), "paywh-not-a-uuid"));

    expect(response.status).toBe(404);
    expect(dependencies.processPayOSWebhook).not.toHaveBeenCalled();
  });
});
