import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { requireRecentAuth, type AuthContext } from "../../src/lib/auth/session";

const auth = (ageMinutes: number): AuthContext => ({
  authenticatedAt: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
  csrfTokenHash: "csrf-hash",
  displayName: "Seller",
  email: "seller@example.test",
  sessionId: "session-current",
  userId: "user-seller",
});

describe("recent authentication policy", () => {
  it("does not force a 15-minute re-login for standard seller actions", () => {
    expect(() => { requireRecentAuth(auth(60)); }).not.toThrow();
    expect(() => { requireRecentAuth(auth(60), 15); }).not.toThrow();
  });

  it("keeps explicit five-minute high-risk gates enforced", () => {
    let failure: unknown;
    try {
      requireRecentAuth(auth(6), 5);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "recent_auth_required", status: 403 });
    expect(() => { requireRecentAuth(auth(4), 5); }).not.toThrow();
  });

  it("keeps financial, identity, access-control, domain, and export mutations on explicit step-up", () => {
    const sensitiveRoutes = [
      "src/pages/api/auth/google/callback.ts",
      "src/pages/api/auth/member-invitations/accept.ts",
      "src/pages/api/app/shops/[shopPublicId]/channels/zalo-oa/oauth/start.ts",
      "src/pages/api/app/shops/[shopPublicId]/customers/[customerPublicId]/privacy.ts",
      "src/pages/api/app/shops/[shopPublicId]/domains/[domainId].ts",
      "src/pages/api/app/shops/[shopPublicId]/domains/[domainId]/primary.ts",
      "src/pages/api/app/shops/[shopPublicId]/domains/index.ts",
      "src/pages/api/app/shops/[shopPublicId]/exports/[exportId]/download.ts",
      "src/pages/api/app/shops/[shopPublicId]/exports/index.ts",
      "src/pages/api/app/shops/[shopPublicId]/members/[memberPublicId].ts",
      "src/pages/api/app/shops/[shopPublicId]/members/invitations/[invitationPublicId].ts",
      "src/pages/api/app/shops/[shopPublicId]/members/invitations/index.ts",
      "src/pages/api/app/shops/[shopPublicId]/moderation/actions.ts",
      "src/pages/api/app/shops/[shopPublicId]/payments/payos/uat-reconciliation.ts",
      "src/pages/api/app/shops/[shopPublicId]/payments/remediation.ts",
    ];
    for (const route of sensitiveRoutes) {
      expect(readFileSync(route, "utf8"), route).toContain("requireRecentAuth(auth, 5)");
    }
  });
});
