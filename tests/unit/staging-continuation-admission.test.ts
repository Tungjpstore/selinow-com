import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertFreshStagingContinuationEvidence,
  assertStagingContinuationEvidenceByReference,
} from "../../scripts/lib/backup.mjs";

const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const DATABASE_ID = "17ea8f2f-4c97-4337-8989-28b25a58ddeb";
const DATABASE_NAME = "selinow-staging";
const REVIEWED_COMMIT = "c".repeat(40);
const NOW = new Date("2026-08-03T00:45:00.000Z");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function writeEvidenceRoot() {
  const root = await mkdtemp(join(tmpdir(), "selinow-staging-continuation-"));
  roots.push(root);
  const backupDirectory = join(root, ".wrangler/backups/staging/bkp_20260803000000_aaaaaaaaaaaa");
  const restoreDirectory = join(root, ".wrangler/restore-drills/staging");
  await mkdir(backupDirectory, { mode: 0o700, recursive: true });
  await mkdir(restoreDirectory, { mode: 0o700, recursive: true });
  const artifact = "CREATE TABLE safe_baseline (id TEXT);\n";
  const checksum = createHash("sha256").update(artifact).digest("hex");
  await writeFile(join(backupDirectory, "database.sql"), artifact, { mode: 0o600 });
  const source = {
    account_id: ACCOUNT_ID,
    database_id: DATABASE_ID,
    database_name: DATABASE_NAME,
    resource_ref: `d1:${DATABASE_NAME}`,
  };
  await writeFile(join(backupDirectory, "snapshot.json"), `${JSON.stringify({
    artifact: { format: "sql", path: "database.sql" },
    records: {
      backup_snapshots: [{
        checksum_sha256: checksum,
        completed_at: "2026-08-03T00:00:00.000Z",
        environment: "staging",
        id: "bkp_20260803000000_aaaaaaaaaaaa",
        provider_reference: "bookmark-staging",
        resource_ref: `d1:${DATABASE_NAME}`,
        size_bytes: artifact.length,
        snapshot_kind: "time_travel",
        status: "available",
      }],
      restore_drills: [],
    },
    report_version: 2,
    source,
  }, null, 2)}\n`, { mode: 0o600 });

  const migrationNames = (await readdir(join(process.cwd(), "migrations")))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  const restoreSnapshotId = "bkp_20260803000000_aaaaaaaaaaaa";
  const reportPath = join(restoreDirectory, "rdr_20260803003000_bbbbbbbbbbbb.json");
  await writeFile(reportPath, `${JSON.stringify({
    records: {
      backup_snapshots: [{
        checksum_sha256: checksum,
        environment: "staging",
        id: restoreSnapshotId,
        resource_ref: `d1:${DATABASE_NAME}`,
        size_bytes: artifact.length,
        status: "available",
      }],
      restore_drills: [{
        backup_snapshot_id: restoreSnapshotId,
        environment: "staging",
        foreign_key_violation_count: 0,
        restored_item_count: 12,
        status: "passed",
        target_resource_ref: "d1:selinow-restore-drill-staging-bbbbbbbbbbbb",
        updated_at: "2026-08-03T00:30:00.000Z",
      }],
    },
    report_version: 1,
    reviewed_commit_sha: REVIEWED_COMMIT,
    source,
    verification: {
      foreignKeyViolationCount: 0,
      integrityOk: true,
      migrationNames,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(root, 0o700);
  return {
    backupRoot: join(root, ".wrangler/backups/staging"),
    reportPath,
    restoreRoot: restoreDirectory,
    root,
  };
}

describe("staging continuation admission", () => {
  it("requires a fresh backup and restore bound to the exact reviewed commit", async () => {
    const evidence = await writeEvidenceRoot();
    await expect(assertFreshStagingContinuationEvidence({
      accountId: ACCOUNT_ID,
      backupRoot: evidence.backupRoot,
      databaseId: DATABASE_ID,
      databaseName: DATABASE_NAME,
      now: NOW,
      repositoryRoot: process.cwd(),
      restoreRoot: evidence.restoreRoot,
      reviewedCommitSha: REVIEWED_COMMIT,
    })).resolves.toMatchObject({
      backup: { snapshotId: "bkp_20260803000000_aaaaaaaaaaaa" },
      reviewedCommitSha: REVIEWED_COMMIT,
      restore: { snapshotId: "bkp_20260803000000_aaaaaaaaaaaa" },
    });
  });

  it("loads manifest-pinned evidence even when newer unrelated artifacts exist", async () => {
    const evidence = await writeEvidenceRoot();
    const pinned = await assertFreshStagingContinuationEvidence({
      accountId: ACCOUNT_ID,
      backupRoot: evidence.backupRoot,
      databaseId: DATABASE_ID,
      databaseName: DATABASE_NAME,
      now: NOW,
      repositoryRoot: process.cwd(),
      restoreRoot: evidence.restoreRoot,
      reviewedCommitSha: REVIEWED_COMMIT,
    });
    await mkdir(join(evidence.backupRoot, "bkp_20260803004000_eeeeeeeeeeee"), { mode: 0o700 });
    await writeFile(
      join(evidence.restoreRoot, "rdr_20260803004000_eeeeeeeeeeee.json"),
      "{}\n",
      { mode: 0o600 },
    );

    await expect(assertStagingContinuationEvidenceByReference({
      accountId: ACCOUNT_ID,
      backupRoot: evidence.backupRoot,
      continuationEvidence: {
        backupChecksumSha256: pinned.backup.checksumSha256,
        backupCompletedAt: pinned.backup.completedAt,
        backupReportRef: pinned.backup.reportRef,
        backupSizeBytes: pinned.backup.sizeBytes,
        backupSnapshotId: pinned.backup.snapshotId,
        restoreCompletedAt: pinned.restore.completedAt,
        restoreReportRef: pinned.restore.reportRef,
        restoreSnapshotId: pinned.restore.snapshotId,
        restoreTargetResourceRef: pinned.restore.targetResourceRef,
      },
      databaseId: DATABASE_ID,
      databaseName: DATABASE_NAME,
      evidenceRecordedAt: NOW,
      repositoryRoot: process.cwd(),
      restoreRoot: evidence.restoreRoot,
      reviewedCommitSha: REVIEWED_COMMIT,
    })).resolves.toMatchObject({
      backup: { snapshotId: "bkp_20260803000000_aaaaaaaaaaaa" },
      restore: { reportRef: evidence.reportPath },
    });
  });

  it("rejects a restore report without exact commit binding", async () => {
    const evidence = await writeEvidenceRoot();
    const report = JSON.parse(await readFile(evidence.reportPath, "utf8")) as Record<string, unknown>;
    delete report.reviewed_commit_sha;
    await writeFile(evidence.reportPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });

    await expect(assertFreshStagingContinuationEvidence({
      accountId: ACCOUNT_ID,
      backupRoot: evidence.backupRoot,
      databaseId: DATABASE_ID,
      databaseName: DATABASE_NAME,
      now: NOW,
      repositoryRoot: process.cwd(),
      restoreRoot: evidence.restoreRoot,
      reviewedCommitSha: REVIEWED_COMMIT,
    })).rejects.toThrow("staging_continuation_restore_evidence_invalid");
  });

  it("rejects equal-size restore evidence for changed backup contents", async () => {
    const evidence = await writeEvidenceRoot();
    const report = JSON.parse(await readFile(evidence.reportPath, "utf8")) as {
      records: { backup_snapshots: Array<{ checksum_sha256: string }> };
    };
    const changedArtifact = "CREATE TABLE evil_baseline (id TEXT);\n";
    expect(changedArtifact.length).toBe("CREATE TABLE safe_baseline (id TEXT);\n".length);
    report.records.backup_snapshots[0].checksum_sha256 = createHash("sha256")
      .update(changedArtifact)
      .digest("hex");
    await writeFile(evidence.reportPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });

    await expect(assertFreshStagingContinuationEvidence({
      accountId: ACCOUNT_ID,
      backupRoot: evidence.backupRoot,
      databaseId: DATABASE_ID,
      databaseName: DATABASE_NAME,
      now: NOW,
      repositoryRoot: process.cwd(),
      restoreRoot: evidence.restoreRoot,
      reviewedCommitSha: REVIEWED_COMMIT,
    })).rejects.toThrow("staging_continuation_restore_evidence_invalid");
  });

  it("rejects a restore report that renames the protected backup snapshot", async () => {
    const evidence = await writeEvidenceRoot();
    const report = JSON.parse(await readFile(evidence.reportPath, "utf8")) as {
      records: {
        backup_snapshots: Array<{ id: string }>;
        restore_drills: Array<{ backup_snapshot_id: string }>;
      };
    };
    const renamedSnapshotId = "bkp_20260803003000_bbbbbbbbbbbb";
    report.records.backup_snapshots[0].id = renamedSnapshotId;
    report.records.restore_drills[0].backup_snapshot_id = renamedSnapshotId;
    await writeFile(evidence.reportPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });

    await expect(assertFreshStagingContinuationEvidence({
      accountId: ACCOUNT_ID,
      backupRoot: evidence.backupRoot,
      databaseId: DATABASE_ID,
      databaseName: DATABASE_NAME,
      now: NOW,
      repositoryRoot: process.cwd(),
      restoreRoot: evidence.restoreRoot,
      reviewedCommitSha: REVIEWED_COMMIT,
    })).rejects.toThrow("staging_continuation_restore_evidence_invalid");
  });
});
