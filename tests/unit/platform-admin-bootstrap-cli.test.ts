import { describe, expect, it } from "vitest";

import {
  buildPlatformAdminBootstrapSql,
  parsePlatformAdminBootstrapFlags,
  parsePlatformAdminBootstrapOutput,
  runPlatformAdminBootstrap,
} from "../../scripts/lib/platform-admin-bootstrap.mjs";

const USER_ID = "user-bootstrap-owner";
const EMAIL = "owner@example.test";
const REQUEST_ID = "bootstrap-request-1";

describe("platform admin bootstrap guard", () => {
  it("requires exact identity and explicit execution confirmation", () => {
    expect(() => parsePlatformAdminBootstrapFlags(["--env", "staging", "--user-id", USER_ID, "--user-email", EMAIL]))
      .toThrow("platform_admin_bootstrap_confirmation_required");
    expect(parsePlatformAdminBootstrapFlags(["--env", "staging", "--user-id", USER_ID, "--user-email", EMAIL, "--dry-run"]))
      .toMatchObject({ dryRun: true, userEmail: EMAIL, userId: USER_ID });
  });

  it("builds a one-time transaction guarded by both empty admin state and active exact user", () => {
    const sql = buildPlatformAdminBootstrapSql({ requestId: REQUEST_ID, userEmail: EMAIL, userId: USER_ID });
    expect(sql).toContain("(SELECT COUNT(*) FROM platform_admins) = 0");
    expect(sql).toContain("(SELECT COUNT(*) FROM platform_admin_bootstrap_receipts) = 0");
    expect(sql).toContain("email_normalized = 'owner@example.test' AND status = 'active'");
    expect(sql).not.toMatch(/secret|token|password|credential/iu);
  });

  it("accepts only the exact single-owner verification result", () => {
    const output = JSON.stringify([{ results: [{ adminCount: 1, candidateOwnerCount: 1, receiptCount: 1 }] }]);
    expect(parsePlatformAdminBootstrapOutput(output)).toEqual({ adminCount: 1, candidateOwnerCount: 1, receiptCount: 1 });
    expect(() => runPlatformAdminBootstrap({
      flags: { confirm: true, dryRun: false, environment: "staging", json: true, userEmail: EMAIL, userId: USER_ID },
      requestId: REQUEST_ID,
      runner: () => ({ stdout: JSON.stringify([{ results: [{ adminCount: 2, candidateOwnerCount: 0, receiptCount: 0 }] }]) }),
    })).toThrow("platform_admin_bootstrap_exact_empty_state_required");
  });
});
