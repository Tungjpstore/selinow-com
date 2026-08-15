import { describe, expect, it, vi } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { processTelegramOutbox } from "../../src/lib/telegram/outbox";

function runtime(input: {
  connectionIds?: { attribution: string; integration: string };
  jobs?: Array<{ attempts?: number; id: string; orderId?: string; shopId: string }>;
} = {}): AppBindings {
  const jobs = input.jobs ?? [{ id: "job-1", orderId: "order-internal-1", shopId: "shop-1" }];
  const database = {
    prepare(sql: string) {
      return {
        bind(..._values: unknown[]) {
          void _values;
          return {
            all() {
              if (!sql.includes("FROM outbox_jobs")) throw new Error("unexpected_all_query");
              return Promise.resolve({ results: jobs });
            },
            run: () => Promise.resolve({ meta: { changes: 1 } }),
          };
        },
      };
    },
  };
  return { PLATFORM_DB: database } as unknown as AppBindings;
}

describe("Telegram legacy outbox quarantine", () => {
  it("does not send a legacy paid-order notification", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(processTelegramOutbox(runtime(), new Date("2026-07-29T00:00:00.000Z"), fetcher)).resolves.toEqual({ failed: 0, processed: 0, skipped: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("quarantines every due legacy row exactly once without invoking Telegram", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(processTelegramOutbox(runtime({ jobs: [
      { id: "job-a", orderId: "order-a", shopId: "shop-a" },
      { id: "job-b", orderId: "order-b", shopId: "shop-a" },
    ] }), new Date("2026-07-29T00:00:00.000Z"), fetcher)).resolves.toEqual({ failed: 0, processed: 0, skipped: 2 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not reroute legacy rows when a connection was replaced", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(processTelegramOutbox(runtime({ connectionIds: { attribution: "connection-original", integration: "connection-replacement" } }), new Date("2026-07-29T00:00:00.000Z"), fetcher)).resolves.toEqual({ failed: 0, processed: 0, skipped: 1 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
