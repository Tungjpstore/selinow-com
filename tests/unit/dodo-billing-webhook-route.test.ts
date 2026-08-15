import { existsSync, readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  backfill: vi.fn(),
  env: {
    DODO_PAYMENTS_WEBHOOK_PUBLIC_ID: undefined as string | undefined,
    PLATFORM_DB: {},
  },
  process: vi.fn(),
}));

vi.mock("../../src/lib/analytics/activation", () => ({
  backfillActivationMilestones: dependencies.backfill,
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
const OTHER_WEBHOOK_PUBLIC_ID = "ddowh_00000000-0000-4000-8000-000000000002";

function context(webhookPublicId = WEBHOOK_PUBLIC_ID, webhookId = "msg_test") {
  const request = new Request(`https://dashboard.test/api/webhooks/billing/dodo/${webhookPublicId}`, {
    body: JSON.stringify({ type: "subscription.active" }),
    headers: { "Content-Type": "application/json", "webhook-id": webhookId },
    method: "POST",
  });
  return {
    locals: { requestId: "request-dodo-route" },
    params: { webhookPublicId },
    request,
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  dependencies.backfill.mockReset();
  dependencies.env = { DODO_PAYMENTS_WEBHOOK_PUBLIC_ID: WEBHOOK_PUBLIC_ID, PLATFORM_DB: {} };
  dependencies.process.mockReset();
});

describe("Dodo Payments billing webhook route", () => {
  it("keeps only the canonical Dodo route and no Paddle runtime path", () => {
    expect(existsSync(ROUTE_PATH)).toBe(true);
    expect(existsSync(LEGACY_ROUTE_PATH)).toBe(false);
    const source = readFileSync(ROUTE_PATH, "utf8");
    expect(source).toContain("processDodoWebhookRequest");
    expect(source).toContain("Canonical Dodo Payments webhook path");
    expect(source).not.toContain("Promise.all");
    expect(source).not.toContain("SELECT DISTINCT shop_id");
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

  it("rejects a well-formed endpoint id that differs from the configured environment id", async () => {
    dependencies.env = {
      DODO_PAYMENTS_WEBHOOK_PUBLIC_ID: OTHER_WEBHOOK_PUBLIC_ID,
      PLATFORM_DB: {},
    };
    dependencies.process.mockResolvedValue({ processed: true, state: "active" });

    const response = await POST(context());

    expect(response.status).toBe(404);
    expect(dependencies.process).not.toHaveBeenCalled();
    expect(dependencies.backfill).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: "webhook_not_found", ok: false });
  });

  it.each([undefined, "", "not-a-public-id"])("fails closed before processing when the configured endpoint id is %s", async (configured) => {
    dependencies.env = { DODO_PAYMENTS_WEBHOOK_PUBLIC_ID: configured, PLATFORM_DB: {} };

    const response = await POST(context());

    expect(response.status).toBe(502);
    expect(dependencies.process).not.toHaveBeenCalled();
    expect(dependencies.backfill).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ code: "billing_provider_invalid", ok: false });
  });

  it("backfills only the shop bound to the processed Standard Webhooks event", async () => {
    const first = vi.fn().mockResolvedValue({ shopId: "billing-shop-a" });
    const bind = vi.fn().mockReturnValue({ first });
    const prepare = vi.fn().mockReturnValue({ bind });
    dependencies.env = {
      DODO_PAYMENTS_WEBHOOK_PUBLIC_ID: WEBHOOK_PUBLIC_ID,
      PLATFORM_DB: { prepare },
    };
    dependencies.process.mockResolvedValue({ duplicate: false, processed: true, state: "active" });
    dependencies.backfill.mockResolvedValue({ attempted: 1, created: 1 });

    const requestContext = context(WEBHOOK_PUBLIC_ID, "evt_dodo_processed");
    const response = await POST(requestContext);

    expect(response.status).toBe(200);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0]?.[0]).toContain("FROM billing_provider_events");
    expect(bind).toHaveBeenCalledWith("evt_dodo_processed");
    expect(dependencies.backfill).toHaveBeenCalledTimes(1);
    expect(dependencies.backfill).toHaveBeenCalledWith({ env: dependencies.env, shopId: "billing-shop-a" });
  });

  it("does not query tenant analytics for ignored or duplicate webhook results", async () => {
    const prepare = vi.fn();
    dependencies.env = { DODO_PAYMENTS_WEBHOOK_PUBLIC_ID: WEBHOOK_PUBLIC_ID, PLATFORM_DB: { prepare } };
    dependencies.process.mockResolvedValue({ duplicate: true, processed: false, state: "processed" });

    const response = await POST(context());

    expect(response.status).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
    expect(dependencies.backfill).not.toHaveBeenCalled();
  });
});
