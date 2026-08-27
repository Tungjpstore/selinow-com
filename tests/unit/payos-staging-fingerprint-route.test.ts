import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("PayOS staging fingerprint derivation contract", () => {
  it("is a staging-only admin endpoint without a short step-up prompt and never accepts provider credentials", () => {
    const source = readFileSync("src/pages/api/admin/payments/payos/staging-fingerprint.ts", "utf8");
    expect(source).toContain('env.APP_ENV !== "staging"');
    expect(source).toContain("requirePlatformAdminApiAccess");
    expect(source).not.toContain("requireRecentAuth");
    expect(source).toContain("requireCsrfSession");
    expect(source).toContain('rejectUnknownFields(body, ["clientId"])');
    expect(source).toContain('{ environment: "staging", fingerprint, ok: true, requestId: locals.requestId }');
    expect(source).not.toMatch(/apiKey|checksumKey/iu);
  });
});
