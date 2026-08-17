import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppError } from "../../src/lib/core/errors";

const dependencies = vi.hoisted(() => ({
  cancel: vi.fn(),
  env: {},
  legalHold: vi.fn(),
  rateGuard: vi.fn(),
  recentAuth: vi.fn(),
  requireCsrf: vi.fn(),
}));

vi.mock("../../src/lib/auth/session", () => ({
  requireCsrfSession: dependencies.requireCsrf,
  requireRecentAuth: dependencies.recentAuth,
}));
vi.mock("../../src/lib/http/admin-rate-limit", () => ({
  guardAdminMutationRate: dependencies.rateGuard,
}));
vi.mock("../../src/lib/platform/bindings", () => ({ getBindings: () => dependencies.env }));
vi.mock("../../src/lib/operations/deletion", () => ({
  applyDeletionLegalHold: dependencies.legalHold,
  cancelShopDeletion: dependencies.cancel,
}));

import { POST as legalHoldRoute } from "../../src/pages/api/admin/operations/deletions/[deletionRequestId]/legal-hold";
import { POST as cancelRoute } from "../../src/pages/api/app/shops/[shopPublicId]/deletion/cancel";

const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-000000000001";
const DELETION_REQUEST_ID = "del_00000000-0000-4000-8000-000000000002";
const auth = {
  authenticatedAt: "2026-07-26T04:00:00.000Z",
  csrfTokenHash: "csrf-hash",
  displayName: "Operator",
  email: "operator@example.test",
  sessionId: "session-a",
  userId: "user-a",
};

function context(input: { body: Record<string, unknown>; params: Record<string, string>; url: string }) {
  return {
    locals: { requestId: "request-deletion-control-route" },
    params: input.params,
    request: new Request(input.url, {
      body: JSON.stringify(input.body),
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "deletion-control-route-001",
      },
      method: "POST",
    }),
  };
}

beforeEach(() => {
  dependencies.cancel.mockReset();
  dependencies.legalHold.mockReset();
  dependencies.rateGuard.mockReset();
  dependencies.recentAuth.mockReset();
  dependencies.requireCsrf.mockReset();
  dependencies.rateGuard.mockResolvedValue(undefined);
  dependencies.requireCsrf.mockResolvedValue(auth);
  dependencies.cancel.mockResolvedValue({ id: DELETION_REQUEST_ID, status: "canceled", version: 4 });
  dependencies.legalHold.mockResolvedValue({
    action: "set",
    actionId: "mod-a",
    deletionRequestId: DELETION_REQUEST_ID,
    holdUntil: "2027-01-01T00:00:00.000Z",
    status: "applied",
    version: 4,
  });
});

describe("deletion control route security", () => {
  it("requires CSRF and recent auth and forwards seller cancellation guards", async () => {
    await cancelRoute(context({
      body: {
        deletionRequestId: DELETION_REQUEST_ID,
        expectedVersion: 3,
        reasonCode: "seller_changed_mind",
      },
      params: { shopPublicId: SHOP_PUBLIC_ID },
      url: `https://app.example.test/api/app/shops/${SHOP_PUBLIC_ID}/deletion/cancel`,
    }) as never);
    expect(dependencies.requireCsrf).toHaveBeenCalledOnce();
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth);
    expect(dependencies.cancel).toHaveBeenCalledWith(expect.objectContaining({
      deletionRequestId: DELETION_REQUEST_ID,
      expectedVersion: 3,
      idempotencyKey: "deletion-control-route-001",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: "user-a",
    }));
  });

  it("forwards only safe legal-hold references to the owner/risk service", async () => {
    await legalHoldRoute(context({
      body: {
        action: "set",
        evidenceReference: "case:legal-2026-001",
        expectedVersion: 3,
        holdUntil: "2027-01-01T00:00:00.000Z",
        reasonCode: "legal_preservation",
        shopPublicId: SHOP_PUBLIC_ID,
      },
      params: { deletionRequestId: DELETION_REQUEST_ID },
      url: `https://app.example.test/api/admin/operations/deletions/${DELETION_REQUEST_ID}/legal-hold`,
    }) as never);
    expect(dependencies.requireCsrf).toHaveBeenCalledOnce();
    expect(dependencies.recentAuth).toHaveBeenCalledWith(auth, 5);
    expect(dependencies.legalHold).toHaveBeenCalledWith(expect.objectContaining({
      action: "set",
      actorUserId: "user-a",
      deletionRequestId: DELETION_REQUEST_ID,
      evidenceReference: "case:legal-2026-001",
      expectedVersion: 3,
      idempotencyKey: "deletion-control-route-001",
      shopPublicId: SHOP_PUBLIC_ID,
    }));
  });

  it("never reaches either service when CSRF or recent authentication fails", async () => {
    dependencies.requireCsrf.mockRejectedValueOnce(new AppError("csrf_invalid", 403));
    await cancelRoute(context({
      body: { deletionRequestId: DELETION_REQUEST_ID, expectedVersion: 3, reasonCode: "seller_changed_mind" },
      params: { shopPublicId: SHOP_PUBLIC_ID },
      url: `https://app.example.test/api/app/shops/${SHOP_PUBLIC_ID}/deletion/cancel`,
    }) as never);
    dependencies.requireCsrf.mockResolvedValueOnce(auth);
    dependencies.recentAuth.mockImplementationOnce(() => { throw new AppError("recent_auth_required", 403); });
    await legalHoldRoute(context({
      body: {
        action: "release",
        expectedVersion: 4,
        reasonCode: "legal_clearance",
        shopPublicId: SHOP_PUBLIC_ID,
      },
      params: { deletionRequestId: DELETION_REQUEST_ID },
      url: `https://app.example.test/api/admin/operations/deletions/${DELETION_REQUEST_ID}/legal-hold`,
    }) as never);
    expect(dependencies.cancel).not.toHaveBeenCalled();
    expect(dependencies.legalHold).not.toHaveBeenCalled();
  });
});
