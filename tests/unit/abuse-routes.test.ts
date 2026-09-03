import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  apply: vi.fn(),
  env: {},
  recentAuth: vi.fn(),
  requireCsrf: vi.fn(),
  transition: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recentAuth,
}));

vi.mock("../../src/lib/http/admin-rate-limit", () => ({
  guardAdminMutationRate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));

vi.mock("../../src/lib/operations/abuse", () => ({
  applyModerationAction: dependencies.apply,
  parseAbuseReportStatus(value: unknown) { return value; },
  parseModerationActionKind(value: unknown) { return value; },
  transitionAbuseReport: dependencies.transition,
}));

import { POST as adminAction } from "../../src/pages/api/admin/moderation/actions";
import { POST as reportTransition } from "../../src/pages/api/admin/abuse-reports/[reportPublicId]";
import { POST as ownerAction } from "../../src/pages/api/app/shops/[shopPublicId]/moderation/actions";
import { POST as legacyShopSuspend } from "../../src/pages/api/admin/shops/[shopPublicId]/suspend";

const auth = {
  authenticatedAt: "2026-07-26T04:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Risk Admin",
  email: "risk@example.test",
  sessionId: "session-admin",
  userId: "user-admin",
};
const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const PRODUCT_ID = "prd_00000000-0000-4000-8000-000000000001";
const REPORT_PUBLIC_ID = "abr_abcdefghijklmnopqrstuvwxyz0123456789ABCD";

function context(input: { body: Record<string, string>; params?: Record<string, string>; url: string }) {
  return {
    locals: { requestId: "request-abuse-route" },
    params: input.params ?? {},
    request: new Request(input.url, {
      body: JSON.stringify(input.body),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "route-idempotency-001",
      },
      method: "POST",
    }),
  };
}

beforeEach(() => {
  dependencies.apply.mockReset();
  dependencies.recentAuth.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.transition.mockReset();
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.apply.mockResolvedValue({ id: "mod-action", status: "applied" });
  dependencies.transition.mockResolvedValue({ publicId: REPORT_PUBLIC_ID, status: "triaged" });
});

describe("abuse mutation route security", () => {
  it("requires CSRF and recent authentication before a platform moderation action", async () => {
    const response = await adminAction(context({
      body: {
        abuseReportPublicId: REPORT_PUBLIC_ID,
        actionKind: "product_suspend",
        reasonCode: "reported_abuse",
        shopPublicId: SHOP_PUBLIC_ID,
        targetId: PRODUCT_ID,
      },
      url: "https://app.example.test/api/admin/moderation/actions",
    }) as never);
    expect(response).toBeInstanceOf(Response);
    expect(dependencies.requireCsrf).toHaveBeenCalledOnce();
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth, 5);
    expect(dependencies.apply).toHaveBeenCalledWith(expect.objectContaining({
      actionKind: "product_suspend",
      actorScope: "platform_admin",
      actorUserId: "user-admin",
      idempotencyKey: "route-idempotency-001",
      shopPublicId: SHOP_PUBLIC_ID,
      targetId: PRODUCT_ID,
    }));
  });

  it("never reaches moderation when CSRF or recent authentication fails", async () => {
    dependencies.requireCsrf.mockRejectedValueOnce(new AppError("csrf_invalid", 403));
    const csrfResponse = await adminAction(context({
      body: { actionKind: "shop_suspend", reasonCode: "reported_abuse", shopPublicId: SHOP_PUBLIC_ID },
      url: "https://app.example.test/api/admin/moderation/actions",
    }) as never);
    expect(csrfResponse).toBeInstanceOf(Response);
    expect(dependencies.apply).not.toHaveBeenCalled();

    dependencies.requireCsrf.mockResolvedValueOnce(auth);
    dependencies.recentAuth.mockImplementationOnce(() => { throw new AppError("recent_auth_required", 403); });
    const recentResponse = await adminAction(context({
      body: { actionKind: "shop_suspend", reasonCode: "reported_abuse", shopPublicId: SHOP_PUBLIC_ID },
      url: "https://app.example.test/api/admin/moderation/actions",
    }) as never);
    expect(recentResponse).toBeInstanceOf(Response);
    expect(dependencies.apply).not.toHaveBeenCalled();
  });

  it("uses the owner scope and recent auth for product suspend and restore actions", async () => {
    await ownerAction(context({
      body: { actionKind: "product_suspend", reasonCode: "voluntary_compliance", targetId: PRODUCT_ID },
      params: { shopPublicId: SHOP_PUBLIC_ID },
      url: `https://app.example.test/api/app/shops/${SHOP_PUBLIC_ID}/moderation/actions`,
    }) as never);
    expect(dependencies.apply).toHaveBeenCalledWith(expect.objectContaining({
      actorScope: "shop_owner",
      shopPublicId: SHOP_PUBLIC_ID,
      targetId: PRODUCT_ID,
    }));
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth, 5);

    await ownerAction(context({
      body: { actionKind: "product_restore", reasonCode: "reported_abuse", targetId: PRODUCT_ID },
      params: { shopPublicId: SHOP_PUBLIC_ID },
      url: `https://app.example.test/api/app/shops/${SHOP_PUBLIC_ID}/moderation/actions`,
    }) as never);
    expect(dependencies.apply).toHaveBeenLastCalledWith(expect.objectContaining({
      actionKind: "product_restore",
      actorScope: "shop_owner",
      shopPublicId: SHOP_PUBLIC_ID,
      targetId: PRODUCT_ID,
    }));
  });

  it("guards report transitions and the legacy suspend endpoint with recent auth", async () => {
    await reportTransition(context({
      body: { status: "triaged" },
      params: { reportPublicId: REPORT_PUBLIC_ID },
      url: `https://app.example.test/api/admin/abuse-reports/${REPORT_PUBLIC_ID}`,
    }) as never);
    expect(dependencies.transition).toHaveBeenCalledWith(expect.objectContaining({
      adminUserId: "user-admin",
      idempotencyKey: "route-idempotency-001",
      reportPublicId: REPORT_PUBLIC_ID,
      status: "triaged",
    }));

    await legacyShopSuspend(context({
      body: { reasonCode: "reported_abuse" },
      params: { shopPublicId: SHOP_PUBLIC_ID },
      url: `https://app.example.test/api/admin/shops/${SHOP_PUBLIC_ID}/suspend`,
    }) as never);
    expect(dependencies.recentAuth).toHaveBeenCalledTimes(2);
    expect(dependencies.apply).toHaveBeenLastCalledWith(expect.objectContaining({
      actionKind: "shop_suspend",
      actorScope: "platform_admin",
      shopPublicId: SHOP_PUBLIC_ID,
    }));
  });
});
