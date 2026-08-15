import { describe, expect, it, vi } from "vitest";

import { D1ProviderReceiptStore } from "../../src/lib/channels/provider-event-receipts";
import type { NormalizedChannelEvent } from "../../src/lib/channels/types";

const EVENT: NormalizedChannelEvent = {
  action: "message.received",
  channelCode: "whatsapp.cloud",
  connectionId: "connection-001",
  eventId: "event-001",
  idempotencyKey: "whatsapp.cloud:event-001",
  payloadReference: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  receivedAt: "2026-08-02T12:00:00.000Z",
  shopId: "shop-001",
};

function database(options: { existing?: Record<string, unknown> | null; insert?: () => Promise<void>; update?: () => Promise<{ meta: { changes: number } }> } = {}) {
  const first = vi.fn(<T>() => Promise.resolve((options.existing ?? null) as T | null));
  const run = vi.fn(async () => {
    if (options.insert !== undefined) await options.insert();
    return Promise.resolve({ meta: { changes: 1 } });
  });
  const update = options.update ?? (() => Promise.resolve({ meta: { changes: 1 } }));
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => {
      void values;
      return {
        first,
        run: sql.includes("UPDATE channel_provider_event_receipts") ? update : run,
      };
    },
  }));
  return { PLATFORM_DB: { prepare }, first, prepareSql: prepare };
}

describe("D1 provider event receipt store", () => {
  it("persists only a normalized reference and returns accepted", async () => {
    const db = database();
    const claim = await new D1ProviderReceiptStore(db.PLATFORM_DB as never).claim(EVENT);
    expect(claim.result).toBe("accepted");
    expect(db.prepareSql.mock.calls.some(([sql]) => sql.includes("channel_provider_event_receipts"))).toBe(true);
  });

  it("returns replay for the same event and payload", async () => {
    const db = database({ existing: { id: "receipt-001", action: EVENT.action, payloadReference: EVENT.payloadReference, status: "processed" } });
    await expect(new D1ProviderReceiptStore(db.PLATFORM_DB as never).claim(EVENT)).resolves.toMatchObject({ result: "replay" });
  });

  it("returns conflict for the same event with a different payload reference", async () => {
    const db = database({ existing: { id: "receipt-001", action: EVENT.action, payloadReference: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", status: "processed" } });
    await expect(new D1ProviderReceiptStore(db.PLATFORM_DB as never).claim(EVENT)).resolves.toMatchObject({ result: "conflict" });
  });

  it("audits a conflict discovered after a concurrent insert race", async () => {
    const prepareSql: string[] = [];
    const existing = { id: "receipt-001", action: EVENT.action, payloadReference: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", status: "processed" };
    const db = {
      prepare: vi.fn((sql: string) => {
        prepareSql.push(sql);
        return {
          bind: (...values: unknown[]) => {
            void values;
            return {
              first: <T>() => Promise.resolve(existing as T),
              run: () => sql.includes("INSERT INTO channel_provider_event_receipts")
                ? Promise.reject(new Error("unique race"))
                : Promise.resolve({ meta: { changes: 1 } }),
            };
          },
        };
      }),
    };
    await expect(new D1ProviderReceiptStore(db as never).claim(EVENT)).resolves.toMatchObject({ result: "conflict" });
    expect(prepareSql.some((sql) => sql.includes("INSERT INTO audit_logs"))).toBe(true);
  });

  it("re-accepts a retryable receipt discovered after a concurrent insert race", async () => {
    const prepareSql: string[] = [];
    const existing = { id: "receipt-001", action: EVENT.action, payloadReference: EVENT.payloadReference, status: "retryable" };
    const db = {
      prepare: vi.fn((sql: string) => {
        prepareSql.push(sql);
        return {
          bind: (...values: unknown[]) => {
            void values;
            return {
              first: <T>() => Promise.resolve(existing as T),
              run: () => sql.includes("INSERT INTO channel_provider_event_receipts")
                ? Promise.reject(new Error("unique race"))
                : Promise.resolve({ meta: { changes: 1 } }),
            };
          },
        };
      }),
    };
    await expect(new D1ProviderReceiptStore(db as never).claim(EVENT)).resolves.toMatchObject({ result: "accepted" });
    expect(prepareSql.some((sql) => sql.includes("SET status = 'accepted'"))).toBe(true);
  });

  it("re-accepts a retryable receipt without changing its identity", async () => {
    const db = database({ existing: { id: "receipt-001", action: EVENT.action, payloadReference: EVENT.payloadReference, status: "retryable" } });
    await expect(new D1ProviderReceiptStore(db.PLATFORM_DB as never).claim(EVENT)).resolves.toMatchObject({ result: "accepted" });
  });

  it("returns conflict when the same event and payload changes action", async () => {
    const db = database({ existing: { id: "receipt-001", action: "status.updated", payloadReference: EVENT.payloadReference, status: "processed" } });
    await expect(new D1ProviderReceiptStore(db.PLATFORM_DB as never).claim(EVENT)).resolves.toMatchObject({ result: "conflict" });
  });

  it("rejects malformed normalized events before D1 access", async () => {
    const db = database();
    await expect(new D1ProviderReceiptStore(db.PLATFORM_DB as never).claim({ ...EVENT, payloadReference: "raw-payload" })).rejects.toMatchObject({ code: "channel_event_invalid" });
    expect(db.prepareSql).not.toHaveBeenCalled();
  });
});
