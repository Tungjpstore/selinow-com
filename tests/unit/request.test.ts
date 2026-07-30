import { describe, expect, it } from "vitest";

import { readJsonObject, rejectUnknownFields } from "../../src/lib/http/request";

function streamingRequest(chunks: Uint8Array[], headers: Record<string, string> = {}): Request {
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
  });
  return new Request("https://example.test/api", {
    body: stream,
    duplex: "half",
    headers: { "Content-Type": "application/json", ...headers },
    method: "POST",
  } as RequestInit & { duplex: "half" });
}

describe("bounded HTTP request parsing", () => {
  it("parses a JSON object split across streamed chunks", async () => {
    const encoder = new TextEncoder();
    const request = streamingRequest([encoder.encode('{"name"'), encoder.encode(':"safe"}')]);
    await expect(readJsonObject(request, 64)).resolves.toEqual({ name: "safe" });
  });

  it("stops streamed bodies that exceed the byte limit despite a small content length", async () => {
    const encoder = new TextEncoder();
    const request = streamingRequest([encoder.encode('{"value":"'), encoder.encode("x".repeat(64)), encoder.encode('"}')], { "Content-Length": "4" });
    await expect(readJsonObject(request, 32)).rejects.toMatchObject({
      issues: ["request_body_too_large"],
      status: 413,
    });
  });

  it("rejects oversized declared bodies before consuming the stream", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request("https://example.test/api", {
      body: stream,
      duplex: "half",
      headers: { "Content-Length": "100", "Content-Type": "application/json" },
      method: "POST",
    } as RequestInit & { duplex: "half" });

    await expect(readJsonObject(request, 16)).rejects.toMatchObject({ status: 413 });
    expect(pulls).toBe(0);
  });

  it("rejects invalid UTF-8 and non-object JSON", async () => {
    await expect(readJsonObject(streamingRequest([new Uint8Array([0xff])]), 16)).rejects.toMatchObject({ issues: ["json_invalid"] });
    await expect(readJsonObject(new Request("https://example.test/api", {
      body: "[]",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }), 16)).rejects.toMatchObject({ issues: ["json_object_required"] });
  });

  it("preserves unknown-field rejection", () => {
    expect(() => { rejectUnknownFields({ allowed: true, secret: true }, ["allowed"]); }).toThrow();
  });
});
