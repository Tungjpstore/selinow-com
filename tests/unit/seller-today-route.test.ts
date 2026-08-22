import { beforeEach, describe, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  authenticate: vi.fn(),
  env: {},
  snapshot: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({ authenticateRequest: dependencies.authenticate }));
vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));

import { GET as today } from "../../src/pages/api/app/shops/[shopPublicId]/today";
import { getSellerTodaySnapshot } from "../../src/lib/dashboard/today-snapshot";

vi.mock("../../src/lib/dashboard/today-snapshot", () => ({ getSellerTodaySnapshot: dependencies.snapshot }));

const shopPublicId = "shop_11111111-1111-4111-8111-111111111111";

function request(headers: Record<string, string> = {}): Request {
  return new Request(`https://app.selinow.com/api/app/shops/${shopPublicId}/today`, { headers });
}

const snapshotBody = {
  activity: { state: "empty" },
  fetchedAt: "2026-08-22T00:00:00.000Z",
  health: { data: { readinessReady: false, sellability: "draft" }, state: "ready" },
  metrics: { data: { currency: "VND", foreignCurrencyOrders: 0, points: [], totalMinor: 0 }, state: "ready" },
  queue: { data: [], state: "ready" },
  recentOrders: { state: "empty" },
  role: "owner",
};

beforeEach(() => {
  dependencies.authenticate.mockReset().mockResolvedValue({ userId: "user-a" });
  dependencies.snapshot.mockReset().mockResolvedValue(snapshotBody);
});

describe("EX3.2 today route", () => {
  it("serves the snapshot with a strong ETag", async () => {
    const response = await today({ locals: { requestId: "request-today-1" }, params: { shopPublicId }, request: request() } as unknown as Parameters<typeof today>[0]);
    expect(response.status).toBe(200);
    const etag = response.headers.get("ETag");
    expect(etag).toMatch(/^"today-[0-9a-f]{32}"$/u);
    await expect(response.json()).resolves.toMatchObject({ ok: true, snapshot: { role: "owner" } });
  });

  it("answers 304 for a matching If-None-Match without re-serializing the body", async () => {
    const first = await today({ locals: { requestId: "request-today-2" }, params: { shopPublicId }, request: request() } as unknown as Parameters<typeof today>[0]);
    const etag = first.headers.get("ETag");
    if (etag === null) throw new Error("etag_missing");
    const revalidation = await today({ locals: { requestId: "request-today-3" }, params: { shopPublicId }, request: request({ "If-None-Match": etag }) } as unknown as Parameters<typeof today>[0]);
    expect(revalidation.status).toBe(304);
    expect(revalidation.headers.get("ETag")).toBe(etag);
    expect(revalidation.headers.get("Cache-Control")).toContain("must-revalidate");
    await expect(revalidation.text()).resolves.toBe("");
  });

  it("still recomputes the snapshot on a stale validator", async () => {
    const response = await today({ locals: { requestId: "request-today-4" }, params: { shopPublicId }, request: request({ "If-None-Match": '"today-stale"' }) } as unknown as Parameters<typeof today>[0]);
    expect(response.status).toBe(200);
    expect(dependencies.snapshot).toHaveBeenCalledTimes(1);
    expect(getSellerTodaySnapshot).toBeDefined();
  });
});
