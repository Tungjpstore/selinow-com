import { describe, expect, it, vi } from "vitest";

import { processProviderIngress, type ProviderReceiptClaim } from "../../src/lib/channels/ingress";

const NOW = new Date("2026-08-02T12:00:00.000Z");

function receiptStore() {
  const rows = new Map<string, ProviderReceiptClaim>();
  return {
    claim: vi.fn((event: ProviderReceiptClaim["event"]): Promise<ProviderReceiptClaim> => {
      const key = `${event.shopId}:${event.connectionId}:${event.eventId}`;
      const existing = rows.get(key);
      if (existing === undefined) {
        const accepted = { event, result: "accepted" as const };
        rows.set(key, accepted);
        return Promise.resolve(accepted);
      }
      return Promise.resolve({ event, result: existing.event.payloadReference === event.payloadReference ? "replay" : "conflict" });
    }),
  };
}

describe("provider ingress sequencing", () => {
  it("verifies before durable claim and treats identical retries as replay", async () => {
    const verify = vi.fn(() => Promise.resolve());
    const store = receiptStore();
    const input = {
      action: "message.received",
      connectionId: "connection-001",
      eventId: "event-001",
      providerCode: "discord.bot",
      rawBody: "{\"type\":1}",
      receivedAt: NOW,
      shopId: "shop-001",
      store,
      verify,
    };
    await expect(processProviderIngress(input)).resolves.toMatchObject({ result: "accepted" });
    await expect(processProviderIngress(input)).resolves.toMatchObject({ result: "replay" });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(store.claim).toHaveBeenCalledTimes(2);
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(store.claim.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
  });

  it("records a conflicting payload as a safe conflict and never parses provider data", async () => {
    const store = receiptStore();
    const base = {
      action: "message.received",
      connectionId: "connection-001",
      eventId: "event-002",
      providerCode: "whatsapp.cloud",
      receivedAt: NOW,
      shopId: "shop-001",
      store,
      verify: () => Promise.resolve(),
    };
    await expect(processProviderIngress({ ...base, rawBody: "{\"message\":\"a\"}" })).resolves.toMatchObject({ result: "accepted" });
    const conflict = await processProviderIngress({ ...base, rawBody: "{\"message\":\"b\"}" });
    expect(conflict.result).toBe("conflict");
    expect(JSON.stringify(conflict)).not.toMatch(/"a"|"b"|secret|token/i);
  });

  it("does not claim a receipt when provider proof fails", async () => {
    const store = receiptStore();
    const verify = vi.fn(() => Promise.reject(new Error("signature-invalid")));
    await expect(processProviderIngress({
      action: "message.received",
      connectionId: "connection-001",
      eventId: "event-003",
      providerCode: "discord.bot",
      rawBody: "{}",
      shopId: "shop-001",
      store,
      verify,
    })).rejects.toThrow("signature-invalid");
    expect(store.claim).not.toHaveBeenCalled();
  });
});
