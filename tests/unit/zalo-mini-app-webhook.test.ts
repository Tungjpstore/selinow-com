import { describe, expect, it } from "vitest";

import { parseZaloMiniAppWebhook } from "../../src/lib/channels/provider-routes";

const BASE = {
  connectionId: "connection-001",
  expectedAppId: "app-123",
  shopId: "shop-001",
};

describe("Zalo Mini App webhook claim boundary", () => {
  it("binds the parsed event to the tenant app and returns a reference-only replay key", async () => {
    const claims = await parseZaloMiniAppWebhook({
      ...BASE,
      rawBody: JSON.stringify({
        appId: "app-123",
        event: "user.revoke.consent",
        timestamp: 1670553442564,
        userId: "user-1",
      }),
    });
    expect(claims).toMatchObject({
      appId: "app-123",
      event: "user.revoke.consent",
      timestamp: "1670553442564",
      userId: "user-1",
    });
    expect(claims.eventId).toMatch(/^zalo_[A-Za-z0-9_-]{43}$/u);
    expect(claims.replayKey).toMatch(/^zalo\.mini_app:[A-Za-z0-9_-]{43}$/u);
    expect(JSON.stringify(claims)).not.toContain("api-key");
    expect(JSON.stringify(claims)).not.toContain("token");
  });

  it("rejects a validly shaped event from another Zalo app", async () => {
    await expect(parseZaloMiniAppWebhook({
      ...BASE,
      rawBody: JSON.stringify({ appId: "app-other", event: "user.revoke.consent", timestamp: 1, userId: "user-1" }),
    })).rejects.toMatchObject({ code: "channel_tenant_mismatch", status: 403 });
  });

  it("changes the replay key when an event conflicts or changes tenant scope", async () => {
    const first = await parseZaloMiniAppWebhook({
      ...BASE,
      rawBody: JSON.stringify({ appId: "app-123", event: "user.revoke.consent", timestamp: "10", userId: "user-1" }),
    });
    const changedPayload = await parseZaloMiniAppWebhook({
      ...BASE,
      rawBody: JSON.stringify({ appId: "app-123", event: "user.revoke.consent", timestamp: "10", userId: "user-2" }),
    });
    const changedTenant = await parseZaloMiniAppWebhook({
      ...BASE,
      connectionId: "connection-002",
      rawBody: JSON.stringify({ appId: "app-123", event: "user.revoke.consent", timestamp: "10", userId: "user-1" }),
    });
    expect(changedPayload.replayKey).not.toBe(first.replayKey);
    expect(changedTenant.replayKey).not.toBe(first.replayKey);
  });

  it("normalizes safe numeric provider identities without losing precision", async () => {
    const claims = await parseZaloMiniAppWebhook({
      ...BASE,
      expectedAppId: "123456789",
      rawBody: JSON.stringify({ appId: 123456789, event: "user.revoke.consent", timestamp: 10, userId: 42 }),
    });
    expect(claims).toMatchObject({ appId: "123456789", timestamp: "10", userId: "42" });
  });

  it("rejects malformed timestamps and oversized payloads before creating a claim", async () => {
    await expect(parseZaloMiniAppWebhook({
      ...BASE,
      rawBody: JSON.stringify({ appId: "app-123", event: "user.revoke.consent", timestamp: "not-a-timestamp" }),
    })).rejects.toMatchObject({ code: "channel_route_invalid", status: 401 });
    await expect(parseZaloMiniAppWebhook({
      ...BASE,
      rawBody: "x".repeat(3 * 1024 * 1024 + 1),
    })).rejects.toMatchObject({ code: "channel_route_invalid", status: 413 });
  });
});
