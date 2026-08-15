import { describe, expect, it } from "vitest";

import { AppError } from "../../src/lib/core/errors";
import {
  executeProviderOutboundDelivery,
  prepareProviderOutboundDelivery,
  type ProviderOutboundPlan,
} from "../../src/lib/channels/provider-outbound";
import type { ChannelOutboundCommand } from "../../src/lib/channels/types";

const command: ChannelOutboundCommand = {
  bodyReference: "body-ref-001",
  connectionId: "connection-001",
  idempotencyKey: "outbound-key-001",
  purpose: "order.status_push",
  recipientReference: "recipient-001",
};

const persistedPlan: ProviderOutboundPlan = Object.freeze({
  authScheme: "bot_token",
  bodyReference: command.bodyReference,
  connectionId: command.connectionId,
  endpoint: "https://discord.com/api/v10/channels/channel-001/messages",
  headers: Object.freeze({ "content-type": "application/json" }),
  idempotencyKey: command.idempotencyKey,
  method: "POST",
  providerCode: "discord.bot",
  purpose: command.purpose,
  recipientReference: command.recipientReference,
  status: "prepared",
});

describe("provider outbound contract", () => {
  it.each(["whatsapp.cloud", "discord.bot"] as const)("keeps %s outbound provider-pending even with forged ready admission", (providerCode) => {
    expect(() => prepareProviderOutboundDelivery({
      admission: { status: "ready" },
      command,
      endpoint: providerCode === "whatsapp.cloud"
        ? "https://graph.facebook.com/v20.0/phone-number-001/messages"
        : "https://discord.com/api/v10/channels/channel-001/messages",
      providerCode,
    })).toThrow(expect.objectContaining({ code: "channel_provider_pending", status: 409 }));
  });

  it("does not perform a provider call without an explicitly injected transport", async () => {
    await expect(executeProviderOutboundDelivery({ plan: persistedPlan })).rejects.toMatchObject({
      code: "channel_outbound_transport_unconfigured",
      status: 503,
    });
  });

  it("validates provider receipts without exposing transport payloads", async () => {
    const receipt = await executeProviderOutboundDelivery({
      plan: persistedPlan,
      transport: ({ plan: received }) => {
        expect(received.bodyReference).toBe(command.bodyReference);
        expect(received.headers).toEqual({ "content-type": "application/json" });
        return Promise.resolve({ providerMessageReference: "wamid-001", status: "accepted" as const });
      },
    });
    expect(receipt).toEqual({ providerMessageReference: "wamid-001", status: "accepted" });

    await expect(executeProviderOutboundDelivery({
      plan: persistedPlan,
      transport: () => Promise.resolve({ providerMessageReference: "unsafe value", status: "accepted" as const }),
    })).rejects.toMatchObject({ code: "channel_outbound_result_invalid", status: 502 });
  });

  it("rejects runtime receipts with an invalid delivery status", async () => {
    await expect(executeProviderOutboundDelivery({
      plan: persistedPlan,
      // Deliberately bypass the compile-time type: provider transports are an
      // execution boundary and must still be validated at runtime.
      transport: () => Promise.resolve({ providerMessageReference: null, status: "queued" } as never),
    })).rejects.toMatchObject({ code: "channel_outbound_result_invalid", status: 502 });
  });

  it("keeps unexpected errors wrapped only at the transport boundary", async () => {
    const error = new AppError("channel_outbound_transport_unconfigured", 503);
    await expect(executeProviderOutboundDelivery({
      plan: persistedPlan,
      transport: () => Promise.reject(error),
    })).rejects.toBe(error);
  });
});
