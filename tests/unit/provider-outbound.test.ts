import { describe, expect, it } from "vitest";

import { AppError } from "../../src/lib/core/errors";
import {
  executeProviderOutboundDelivery,
  prepareProviderOutboundDelivery,
} from "../../src/lib/channels/provider-outbound";
import type { ChannelOutboundCommand } from "../../src/lib/channels/types";

const command: ChannelOutboundCommand = {
  bodyReference: "body-ref-001",
  connectionId: "connection-001",
  idempotencyKey: "outbound-key-001",
  purpose: "order.status_push",
  recipientReference: "recipient-001",
};

describe("provider outbound contract", () => {
  it("allows only tenant-bound WhatsApp and Discord provider endpoints", () => {
    expect(prepareProviderOutboundDelivery({
      admission: { status: "ready" },
      command,
      endpoint: "https://graph.facebook.com/v20.0/phone-number-001/messages",
      providerCode: "whatsapp.cloud",
    })).toMatchObject({
      authScheme: "bearer_access_token",
      providerCode: "whatsapp.cloud",
      status: "prepared",
    });

    expect(prepareProviderOutboundDelivery({
      admission: { status: "ready" },
      command,
      endpoint: "https://discord.com/api/v10/channels/channel-001/messages",
      providerCode: "discord.bot",
    })).toMatchObject({
      authScheme: "bot_token",
      providerCode: "discord.bot",
      status: "prepared",
    });
  });

  it("rejects endpoint origins, paths, queries and fragments outside the provider contract", () => {
    const cases = [
      { endpoint: "https://evil.example/v20.0/phone-number-001/messages", providerCode: "whatsapp.cloud" as const },
      { endpoint: "https://graph.facebook.com/v20.0/phone-number-001/profile", providerCode: "whatsapp.cloud" as const },
      { endpoint: "https://discord.com/api/v10/channels/channel-001/messages?x=1", providerCode: "discord.bot" as const },
      { endpoint: "https://discord.com/api/v10/channels/channel-001/messages#fragment", providerCode: "discord.bot" as const },
    ];
    for (const input of cases) {
      expect(() => prepareProviderOutboundDelivery({
        admission: { status: "ready" },
        command,
        ...input,
      })).toThrow(expect.objectContaining({ code: "channel_provider_endpoint_invalid" }));
    }
  });

  it("fails closed when runtime admission is blocked", () => {
    expect(() => prepareProviderOutboundDelivery({
      admission: { reasons: ["provider_acceptance_missing"], status: "blocked" },
      command,
      endpoint: "https://discord.com/api/v10/channels/channel-001/messages",
      providerCode: "discord.bot",
    })).toThrow(expect.objectContaining({
      code: "channel_provider_not_ready",
      status: 409,
    }));
  });

  it("requires safe references and purpose values", () => {
    for (const [field, value] of [
      ["connectionId", "x"],
      ["idempotencyKey", "x"],
      ["bodyReference", "x"],
      ["recipientReference", "x"],
      ["purpose", "Bad Purpose"],
    ] as const) {
      expect(() => prepareProviderOutboundDelivery({
        admission: { status: "ready" },
        command: { ...command, [field]: value },
        endpoint: "https://discord.com/api/v10/channels/channel-001/messages",
        providerCode: "discord.bot",
      })).toThrow(expect.objectContaining({ code: "channel_outbound_invalid" }));
    }
  });

  it("does not perform a provider call without an explicitly injected transport", async () => {
    const plan = prepareProviderOutboundDelivery({
      admission: { status: "ready" },
      command,
      endpoint: "https://discord.com/api/v10/channels/channel-001/messages",
      providerCode: "discord.bot",
    });
    await expect(executeProviderOutboundDelivery({ plan })).rejects.toMatchObject({
      code: "channel_outbound_transport_unconfigured",
      status: 503,
    });
  });

  it("validates provider receipts without exposing transport payloads", async () => {
    const plan = prepareProviderOutboundDelivery({
      admission: { status: "ready" },
      command,
      endpoint: "https://graph.facebook.com/v20.0/phone-number-001/messages",
      providerCode: "whatsapp.cloud",
    });
    const receipt = await executeProviderOutboundDelivery({
      plan,
      transport: ({ plan: received }) => {
        expect(received.bodyReference).toBe(command.bodyReference);
        expect(received.headers).toEqual({ "content-type": "application/json" });
        return Promise.resolve({ providerMessageReference: "wamid-001", status: "accepted" as const });
      },
    });
    expect(receipt).toEqual({ providerMessageReference: "wamid-001", status: "accepted" });

    await expect(executeProviderOutboundDelivery({
      plan,
      transport: () => Promise.resolve({ providerMessageReference: "unsafe value", status: "accepted" as const }),
    })).rejects.toMatchObject({ code: "channel_outbound_result_invalid", status: 502 });
  });

  it("rejects runtime receipts with an invalid delivery status", async () => {
    const plan = prepareProviderOutboundDelivery({
      admission: { status: "ready" },
      command,
      endpoint: "https://discord.com/api/v10/channels/channel-001/messages",
      providerCode: "discord.bot",
    });
    await expect(executeProviderOutboundDelivery({
      plan,
      // Deliberately bypass the compile-time type: provider transports are an
      // execution boundary and must still be validated at runtime.
      transport: () => Promise.resolve({ providerMessageReference: null, status: "queued" } as never),
    })).rejects.toMatchObject({ code: "channel_outbound_result_invalid", status: 502 });
  });

  it("keeps unexpected errors wrapped only at the transport boundary", async () => {
    const plan = prepareProviderOutboundDelivery({
      admission: { status: "ready" },
      command,
      endpoint: "https://discord.com/api/v10/channels/channel-001/messages",
      providerCode: "discord.bot",
    });
    const error = new AppError("channel_outbound_transport_unconfigured", 503);
    await expect(executeProviderOutboundDelivery({
      plan,
      transport: () => Promise.reject(error),
    })).rejects.toBe(error);
  });
});
