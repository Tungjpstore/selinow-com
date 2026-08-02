import { describe, expect, it, vi } from "vitest";

import {
  assertProductionContinuationDeployAdmission,
} from "../../scripts/lib/release.mjs";

const identity = {
  accountId: "abcdef0123456789abcdef0123456789",
  databaseId: "17ea8f2f-4c97-4337-8989-28b25a58ddeb",
  databaseName: "selinow-production",
  reviewedCommitSha: "c".repeat(40),
};

describe("production Worker continuation deploy admission", () => {
  it("returns stable backup and restore fingerprints for deploy rechecks", async () => {
    const implementation = vi.fn(() => Promise.resolve({
      backup: {
        checksumSha256: "a".repeat(64),
        snapshotId: "bkp_20260802000000_aaaaaaaaaaaa",
      },
      restore: {
        reportRef: ".wrangler/restore-drills/production/rdr_20260802010000_bbbbbbbbbbbb.json",
        snapshotId: "bkp_20260802010000_bbbbbbbbbbbb",
      },
    }));

    await expect(assertProductionContinuationDeployAdmission({
      ...identity,
      assertContinuationEvidenceImplementation: implementation,
      repositoryRoot: process.cwd(),
    })).resolves.toEqual({
      backupChecksumSha256: "a".repeat(64),
      backupSnapshotId: "bkp_20260802000000_aaaaaaaaaaaa",
      restoreReportRef: ".wrangler/restore-drills/production/rdr_20260802010000_bbbbbbbbbbbb.json",
      restoreSnapshotId: "bkp_20260802010000_bbbbbbbbbbbb",
      reviewedCommitSha: identity.reviewedCommitSha,
    });
    expect(implementation).toHaveBeenCalledWith(expect.objectContaining(identity));
  });

  it("fails closed when an injected continuation validator returns incomplete evidence", async () => {
    await expect(assertProductionContinuationDeployAdmission({
      ...identity,
      assertContinuationEvidenceImplementation: () => Promise.resolve({
        backup: { checksumSha256: "invalid", snapshotId: "historical" },
        restore: { reportRef: "restore-report", snapshotId: "restore" },
      }),
      repositoryRoot: process.cwd(),
    })).rejects.toThrow("production_continuation_evidence_invalid");
  });
});
