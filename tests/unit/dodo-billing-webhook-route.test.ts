import { existsSync, readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  env: { PLATFORM_DB: {} },
  process: vi.fn(),
}));

vi.mock("../../src/lib/billing/service", () => ({
  processDodoWebhookRequest: dependencies.process,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

import { POST } from "../../src/pages/api/webhooks/billing/dodo/[webhookPublicId]";

const ROUTE_PATH = "src/pages/api/webhooks/billing/dodo/[webhookPublicId].ts";
const LEGACY_ROUTE_PATH = "src/pages/api/webhooks/billing/paddle/[webhookPublicId].ts";
const WEBHOOK_PUBLIC_ID = "dodow_00000000-0000-4000-8000-000000000001";

function context() {
  const request = new Request(`https://dashboard.test/api/webhooks/billing/dodo/${WEBHOOK_PUBLIC_ID}`, {
    body: JSON.stringify({ type: "subscription.active" }),
    headers: { "Content-Type": "application/json", "webhook-id": "msg_test" },
    method: "POST",
  });
  return {
    locals: { requestId: "request-dodo-route" },
    params: { webhookPublicId: WEBHOOK_PUBLIC_ID },
    request,
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  dependencies.process.mockReset();
});

describe("Dodo Payments billing webhook route", () => {
  it("keeps only the canonical Dodo route and no Paddle runtime path", () => {
    expect(existsSync(ROUTE_PATH)).toBe(true);
    expect(existsSync(LEGACY_ROUTE_PATH)).toBe(false);
    const source = readFileSync(ROUTE_PATH, "utf8");
    expect(source).toContain("processDodoWebhookRequest");
    expect(source).toContain("Canonical Dodo Payments webhook path");
    expect(source).not.toMatch(/paddle/iu);
  });

  it("passes the raw request and webhook public id to the Dodo service", async () => {
    const requestContext = context();
    dependencies.process.mockResolvedValue({ eventId: "evt_dodo_test", status: "processed" });

    const response = await POST(requestContext);

    expect(dependencies.process).toHaveBeenCalledWith({
      env: dependencies.env,
      request: requestContext.request,
      webhookPublicId: WEBHOOK_PUBLIC_ID,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      data: { eventId: "evt_dodo_test", status: "processed" },
      ok: true,
    });
  });
});
