import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  env: {},
  process: vi.fn(),
}));

vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));
vi.mock("../../src/lib/channels/discord-webhooks", () => ({ processDiscordWebhook: dependencies.process }));

import { POST } from "../../src/pages/webhooks/discord/[connectionPublicId]";

const PUBLIC_ID = "discord-connection-001";

function context(connectionPublicId = PUBLIC_ID) {
  return {
    locals: { requestId: "request-discord-route" },
    params: { connectionPublicId },
    request: new Request(`https://api.test/webhooks/discord/${connectionPublicId}`, { body: "{}", method: "POST" }),
  } as unknown as Parameters<typeof POST>[0];
}

describe("Discord interactions webhook route", () => {
  beforeEach(() => dependencies.process.mockReset());

  it("returns the PONG callback for a verified Discord ping", async () => {
    dependencies.process.mockResolvedValue({ eventId: null, interactionType: 1, result: "ping" });
    const response = await POST(context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it("returns an autocomplete result instead of an invalid deferred callback", async () => {
    dependencies.process.mockResolvedValue({ eventId: "interaction-001", interactionType: 4, result: "accepted" });
    const response = await POST(context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: { choices: [] }, type: 8 });
  });

  it("keeps deferred acknowledgement for normal interactions", async () => {
    dependencies.process.mockResolvedValue({ eventId: "interaction-002", interactionType: 2, result: "accepted" });
    const response = await POST(context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 5 });
  });
});
