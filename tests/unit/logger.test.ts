import { describe, expect, it } from "vitest";

import { createLogger, sanitizeLogEvent } from "../../src/lib/operations/logger";

describe("safe structured logger", () => {
  it("honors LOG_LEVEL and emits stable structured JSON", () => {
    const output: string[] = [];
    const logger = createLogger({
      level: "warn",
      now: () => new Date("2026-07-26T00:00:00.000Z"),
      sink: (_level, serialized) => { output.push(serialized); },
    });

    logger.info({ event: "ignored.info" });
    logger.error({ errorCode: "provider_unavailable", event: "worker.failed", metrics: { failed: 1 } });

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? "") as unknown).toEqual({
      errorCode: "provider_unavailable",
      event: "worker.failed",
      level: "error",
      metrics: { failed: 1 },
      timestamp: "2026-07-26T00:00:00.000Z",
    });
  });

  it("drops unsafe strings, arbitrary fields, and sensitive metric names", () => {
    const event = sanitizeLogEvent({
      authorization: "Bearer secret",
      cookie: "session=secret",
      durationMs: 12.4,
      event: "http.request_completed",
      metrics: {
        accountNumber: 123456,
        processed: 2,
        webhookSignatureCount: 1,
      },
      queue: "unsafe\nqueue",
      requestId: "person@example.com",
      source: "http",
      status: 201,
    } as never, "info", "2026-07-26T00:00:00.000Z");

    expect(event).toEqual({
      durationMs: 12,
      event: "http.request_completed",
      level: "info",
      metrics: { processed: 2 },
      source: "http",
      status: 201,
      timestamp: "2026-07-26T00:00:00.000Z",
    });
    expect(JSON.stringify(event)).not.toContain("secret");
    expect(JSON.stringify(event)).not.toContain("example.com");
  });

  it("never lets a logging sink failure change application behavior", () => {
    const logger = createLogger({ sink: () => { throw new Error("sink unavailable"); } });
    expect(() => { logger.info({ event: "http.request_completed" }); }).not.toThrow();
  });
});
