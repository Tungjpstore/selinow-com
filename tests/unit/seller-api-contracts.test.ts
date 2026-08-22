import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const mutationRoutes = [
  "src/pages/api/app/shops/[shopPublicId]/members/[memberPublicId].ts",
  "src/pages/api/app/shops/[shopPublicId]/members/invitations/index.ts",
  "src/pages/api/app/shops/[shopPublicId]/members/invitations/[invitationPublicId].ts",
  "src/pages/api/app/shops/[shopPublicId]/customers/[customerPublicId].ts",
  "src/pages/api/app/shops/[shopPublicId]/customers/[customerPublicId]/notes/index.ts",
  "src/pages/api/app/shops/[shopPublicId]/customers/[customerPublicId]/notes/[notePublicId].ts",
  "src/pages/api/app/shops/[shopPublicId]/billing/requests.ts",
  "src/pages/api/app/shops/[shopPublicId]/billing/operations.ts",
  "src/pages/api/app/shops/[shopPublicId]/payments/remediation.ts",
  "src/pages/api/admin/appeals/[requestPublicId].ts",
] as const;

describe("seller operations API contracts", () => {
  it("keeps every mutation route behind CSRF, recent auth and idempotency", async () => {
    const sources = await Promise.all(mutationRoutes.map((path) => readFile(path, "utf8")));
    for (const source of sources) {
      expect(source).toContain("requireCsrfSession");
      expect(source).toContain("requireRecentAuth");
      expect(source).toContain("Idempotency-Key");
      expect(source).toContain("rejectUnknownFields");
      expect(source).toContain("PRIVATE_RESPONSE_HEADERS");
    }
  });

  it("keeps protected admin read routes authenticated and private", async () => {
    const sources = await Promise.all([
      readFile("src/pages/api/admin/investigations/orders.ts", "utf8"),
      readFile("src/pages/api/admin/investigations/audit.ts", "utf8"),
      readFile("src/pages/api/admin/appeals/index.ts", "utf8"),
      readFile("src/pages/api/app/shops/[shopPublicId]/billing/plans.ts", "utf8"),
      readFile("src/pages/api/app/shops/[shopPublicId]/billing/operations.ts", "utf8"),
    ]);
    for (const source of sources) {
      expect(source).toContain("authenticateRequest");
      expect(source).toContain("PRIVATE_RESPONSE_HEADERS");
      expect(source).toContain("createCaughtErrorResponse");
    }
  });
});
