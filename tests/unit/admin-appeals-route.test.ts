import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseCreatedIdCursor } from "../../src/lib/core/pagination";

const dependencies = vi.hoisted(() => ({
  authenticate: vi.fn(),
  env: {},
  list: vi.fn(),
  requireAccess: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  authenticateRequest: dependencies.authenticate,
}));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => dependencies.env,
}));

vi.mock("../../src/lib/payments/remediation", () => ({
  listAdminPaymentRemediationRequests: dependencies.list,
}));

vi.mock("../../src/lib/tenants/store", () => ({
  requirePlatformAdminApiAccess: dependencies.requireAccess,
}));

import { GET } from "../../src/pages/api/admin/appeals/index";

function row(index: number) {
  return {
    createdAt: new Date(Date.UTC(2026, 7, 17, 12, 0, 0) - index * 60_000).toISOString(),
    id: `pmt_${String(index).padStart(4, "0")}`,
  };
}

function context(url: string) {
  return {
    locals: { requestId: "request-appeals-route" },
    request: new Request(url),
  } as never;
}

function listCall(index: number): { cursor: string | null; limit: number } {
  const call = dependencies.list.mock.calls[index]?.[0] as { cursor: string | null; limit: number } | undefined;
  if (call === undefined) throw new Error("call_missing");
  return call;
}

beforeEach(() => {
  for (const dependency of [dependencies.authenticate, dependencies.list, dependencies.requireAccess]) {
    dependency.mockReset();
  }
  dependencies.authenticate.mockResolvedValue({ userId: "admin-risk" });
  dependencies.requireAccess.mockResolvedValue("risk");
});

describe("appeals list route page limits", () => {
  it("accepts limit=100, fetches at the service cap and probes for hasMore", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => row(index));
    dependencies.list.mockResolvedValueOnce(rows).mockResolvedValueOnce([]);

    const response = await GET(context("https://app.test/api/admin/appeals?limit=100"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      hasMore: false,
      nextCursor: null,
      ok: true,
    });
    expect(dependencies.list).toHaveBeenCalledTimes(2);
    expect(listCall(0)).toMatchObject({ cursor: null, limit: 100 });
    expect(listCall(1)).toMatchObject({ limit: 1 });
    const last = rows.at(-1);
    if (last === undefined) throw new Error("seed_missing");
    expect(parseCreatedIdCursor(listCall(1).cursor)).toEqual({
      createdAt: last.createdAt,
      id: last.id,
    });
  });

  it("reports hasMore via the probe when exactly limit rows remain past the page", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => row(index));
    dependencies.list.mockResolvedValueOnce(rows).mockResolvedValueOnce([row(100)]);

    const response = await GET(context("https://app.test/api/admin/appeals?limit=100"));
    expect(response.status).toBe(200);
    const body: { hasMore: boolean; nextCursor: string | null; requests: unknown[] } = await response.json();
    expect(body.hasMore).toBe(true);
    expect(body.requests).toHaveLength(100);
    const last = rows.at(-1);
    if (last === undefined) throw new Error("seed_missing");
    expect(parseCreatedIdCursor(body.nextCursor)).toEqual({ createdAt: last.createdAt, id: last.id });
  });

  it("defaults to limit=100 when the parameter is omitted", async () => {
    dependencies.list.mockResolvedValue([]);
    const response = await GET(context("https://app.test/api/admin/appeals"));
    expect(response.status).toBe(200);
    expect(dependencies.list).toHaveBeenCalledTimes(1);
    expect(listCall(0)).toMatchObject({ cursor: null, limit: 100 });
    expect(dependencies.requireAccess).toHaveBeenCalledWith({ env: dependencies.env, userId: "admin-risk" });
  });

  it("rejects limit=101 with validation_failed before any fetch", async () => {
    const response = await GET(context("https://app.test/api/admin/appeals?limit=101"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "validation_failed",
      issues: ["limit_invalid"],
      ok: false,
      requestId: "request-appeals-route",
    });
    expect(dependencies.list).not.toHaveBeenCalled();
  });

  it("rejects limit=0 with validation_failed", async () => {
    const response = await GET(context("https://app.test/api/admin/appeals?limit=0"));
    expect(response.status).toBe(400);
    expect(dependencies.list).not.toHaveBeenCalled();
  });
});
