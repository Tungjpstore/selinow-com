import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  env: {},
  process: vi.fn(),
}));

vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));
vi.mock("../../src/lib/channels/zalo-mini-app-webhooks", () => ({ processZaloMiniAppWebhook: dependencies.process }));

import { POST } from "../../src/pages/webhooks/zalo-mini-app/[connectionPublicId]";

const PUBLIC_ID = "channel-00000000-0000-4000-8000-000000000001";

function context(connectionPublicId = PUBLIC_ID) {
  return {
    locals: { requestId: "request-zalo-route" },
    params: { connectionPublicId },
    request: new Request(`https://api.test/webhooks/zalo-mini-app/${connectionPublicId}`, {
      body: "{}",
      method: "POST",
    }),
  } as unknown as Parameters<typeof POST>[0];
}

describe("Zalo Mini App webhook route", () => {
  beforeEach(() => dependencies.process.mockReset());

  it("delegates the raw request to the tenant-bound service and returns only safe references", async () => {
    dependencies.process.mockResolvedValue({ action: "user.revoke.consent", eventId: "zalo_event_hash", result: "accepted" });
    const response = await POST(context());
    expect(dependencies.process).toHaveBeenCalledTimes(1);
    const call = dependencies.process.mock.calls[0]?.[0] as unknown;
    expect(call).toMatchObject({ connectionPublicId: PUBLIC_ID });
    expect(call).toHaveProperty("env", dependencies.env);
    expect(call).toHaveProperty("request");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("zalo_event_hash");
    expect(body).not.toContain("secret");
  });

});
