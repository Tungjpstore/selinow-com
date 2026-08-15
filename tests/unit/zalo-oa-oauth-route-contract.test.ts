import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

const dependencies = { env: {} };

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

describe("Zalo OA OAuth route security contract", () => {
  it("keeps the authenticated start route tenant-bound and guarded", async () => {
    const source = await readFile("src/pages/api/app/shops/[shopPublicId]/channels/zalo-oa/oauth/start.ts", "utf8");
    expect(source).toContain("requireCsrfSession");
    expect(source).toContain("requireRecentAuth");
    expect(source).toContain("rejectUnknownFields(body, [\"appId\", \"connectorRequestPublicId\", \"redirectUri\"])");
    expect(source).toContain("requireResourceId(params.shopPublicId, \"shop\")");
    expect(source).toContain("PRIVATE_RESPONSE_HEADERS");
    expect(source).not.toMatch(/providerPayload|accessToken|refreshToken|secretKey/u);
  });

  it("matches Zalo's GET redirect callback while remaining fail-closed", async () => {
    const [route, service, stateStore] = await Promise.all([
      readFile("src/pages/api/channels/zalo-oa/callback.ts", "utf8"),
      readFile("src/lib/channels/zalo-oa-oauth-routes.ts", "utf8"),
      readFile("src/lib/channels/zalo-oa-oauth-state-store.ts", "utf8"),
    ]);
    expect(route).toContain("export const POST");
    expect(route).toContain("export const GET");
    expect(route).toContain("rejectUnknownFields(body, [\"code\", \"oa_id\", \"state\"])");
    expect(route).toContain("Zalo redirects the OA administrator's browser to the callback with a GET");
    expect(route).toContain("PRIVATE_RESPONSE_HEADERS");
    expect(route).not.toContain("authenticateRequest");
    expect(route).not.toMatch(/body\.(?:shopId|shopPublicId|requestId|connectorRequestId)/u);
    expect(service).toContain("channel_provider_pending");
    expect(service).not.toContain("secretKey: unknown");
    expect(service).not.toContain("oaId: unknown");
    expect(service).not.toContain("consumeZaloOfficialAccountOAuthStateByState");
    expect(service).not.toContain("encryptZaloOfficialAccountCredential");
    expect(stateStore).toContain("loadStateByLookupHash");
    expect(stateStore).toContain("state_lookup_hash AS stateLookupHash");
    expect(stateStore).toContain("consumeZaloOfficialAccountOAuthStateByState");
  });

  it("accepts the provider's GET query shape without consuming OAuth state", async () => {
    const { GET } = await import("../../src/pages/api/channels/zalo-oa/callback");
    const response = await GET({
      locals: { requestId: "req-zalo-oa" },
      params: {},
      request: new Request("https://api.selinow.test/api/channels/zalo-oa/callback?code=one-use-code&oa_id=123456789&state=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-abc"),
    } as never);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, code: "channel_provider_pending" });
  });

  it("rejects ambiguous or unrecognized callback query fields before the pending gate", async () => {
    const { GET } = await import("../../src/pages/api/channels/zalo-oa/callback");
    const duplicate = await GET({
      locals: { requestId: "req-zalo-oa" },
      params: {},
      request: new Request("https://api.selinow.test/api/channels/zalo-oa/callback?code=one&code=two&oa_id=123&state=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-abc"),
    } as never);
    expect(duplicate.status).toBe(400);
    await expect(duplicate.json()).resolves.toMatchObject({ ok: false, code: "validation_failed" });

    const unknown = await GET({
      locals: { requestId: "req-zalo-oa" },
      params: {},
      request: new Request("https://api.selinow.test/api/channels/zalo-oa/callback?code=one&oa_id=123&state=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-abc&shop_id=shop-1"),
    } as never);
    expect(unknown.status).toBe(400);
    await expect(unknown.json()).resolves.toMatchObject({ ok: false, code: "validation_failed" });

    const oversized = await GET({
      locals: { requestId: "req-zalo-oa" },
      params: {},
      request: new Request(`https://api.selinow.test/api/channels/zalo-oa/callback?code=${"x".repeat(12 * 1024)}`),
    } as never);
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ ok: false, code: "validation_failed" });
  });
});
