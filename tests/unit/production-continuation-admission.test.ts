import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertFreshProductionContinuationEvidence,
} from "../../scripts/lib/backup.mjs";

const ACCOUNT_ID = "abcdef0123456789abcdef0123456789";
const DATABASE_ID = "17ea8f2f-4c97-4337-8989-28b25a58ddeb";
const DATABASE_NAME = "selinow-production";
const REVIEWED_COMMIT = "c".repeat(40);
const NOW = new Date("2026-08-02T04:00:00.000Z");

async function writeEvidenceRoot() {
  const root = await mkdtemp(join(tmpdir(), "selinow-continuation-evidence-"));
  const backupDirectory = join(root, ".wrangler/backups/production/bkp_20260802000000_aaaaaaaaaaaa");
  const restoreDirectory = join(root, ".wrangler/restore-drills/production");
  await mkdir(backupDirectory, { mode: 0o700, recursive: true });
  await mkdir(restoreDirectory, { mode: 0o700, recursive: true });
  const artifact = "CREATE TABLE safe_baseline (id TEXT);\n";
  const checksum = createHash("sha256").update(artifact).digest("hex");
  await writeFile(join(backupDirectory, "database.sql"), artifact, { mode: 0o600 });

  const migrationNames = (await import("node:fs/promises")).readdir(join(process.cwd(), "migrations"))
    .then((names) => names.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name)).sort());
  const names = await migrationNames;
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
        completed_at: "2026-08-02T00:00:00.000Z",
        created_at: "2026-08-02T00:00:00.000Z",
        environment: "production",
        expires_at: "2026-08-31T00:00:00.000Z",
        id: "bkp_20260802000000_aaaaaaaaaaaa",
        item_count: 12,
        last_safe_error_code: null,
        provider_reference: "bookmark-20260802",
        request_id: "request-backup",
        requested_by_user_id: null,
        resource_kind: "d1",
        resource_ref: `d1:${DATABASE_NAME}`,
        scope_key: "platform:production",
        shop_id: null,
        size_bytes: artifact.length,
        snapshot_kind: "time_travel",
        status: "available",
        updated_at: "2026-08-02T00:00:00.000Z",
        version: 1,
      }],
      restore_drills: [],
    },
    report_version: 2,
    source,
  }, null, 2)}\n`, { mode: 0o600 });

  const restoreSnapshotId = "bkp_20260802010000_bbbbbbbbbbbb";
  await writeFile(join(restoreDirectory, "rdr_20260802010000_bbbbbbbbbbbb.json"), `${JSON.stringify({
    records: {
      backup_snapshots: [{
        checksum_sha256: checksum,
        completed_at: "2026-08-02T01:00:00.000Z",
        created_at: "2026-08-02T01:00:00.000Z",
        environment: "production",
        id: restoreSnapshotId,
        resource_ref: `d1:${DATABASE_NAME}`,
        size_bytes: artifact.length,
        snapshot_kind: "export",
        status: "available",
      }],
      restore_drills: [{
        backup_snapshot_id: restoreSnapshotId,
        completed_at: "2026-08-02T01:00:00.000Z",
        created_at: "2026-08-02T01:00:00.000Z",
        environment: "isolated",
        foreign_key_violation_count: 0,
        id: "rdr_20260802010000_bbbbbbbbbbbb",
        integrity_status: "ok",
        restored_item_count: 12,
        started_at: "2026-08-02T01:00:00.000Z",
        status: "passed",
        target_resource_ref: "d1:selinow-restore-drill-production-bbbbbbbbbbbb",
        updated_at: "2026-08-02T01:00:00.000Z",
      }],
    },
    report_version: 1,
    reviewed_commit_sha: REVIEWED_COMMIT,
    source,
    verification: {
      foreignKeyViolationCount: 0,
      integrityOk: true,
      migrationNames: names,
    },
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(root, 0o700);
  return { backupRoot: join(root, ".wrangler/backups/production"), restoreRoot: restoreDirectory, root };
}

describe("production continuation migration admission", () => {
  it("requires exact fresh backup, isolated restore, reviewed commit and current migration ledger", async () => {
    const evidence = await writeEvidenceRoot();
    await expect(assertFreshProductionContinuationEvidence({
      accountId: ACCOUNT_ID,
      backupRoot: evidence.backupRoot,
      databaseId: DATABASE_ID,
      databaseName: DATABASE_NAME,
      now: NOW,
      repositoryRoot: process.cwd(),
      restoreRoot: evidence.restoreRoot,
      reviewedCommitSha: REVIEWED_COMMIT,
    })).resolves.toMatchObject({
      backup: { snapshotId: "bkp_20260802000000_aaaaaaaaaaaa" },
      reviewedCommitSha: REVIEWED_COMMIT,
      restore: { snapshotId: "bkp_20260802010000_bbbbbbbbbbbb" },
    });
  });

  it("rejects historical restore evidence without the reviewed commit binding", async () => {
    const evidence = await writeEvidenceRoot();
    const reportPath = join(evidence.restoreRoot, "rdr_20260802010000_bbbbbbbbbbbb.json");
    const report = JSON.parse(await (await import("node:fs/promises")).readFile(reportPath, "utf8")) as Record<string, unknown>;
    delete report.reviewed_commit_sha;
    await writeFile(reportPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
    await expect(assertFreshProductionContinuationEvidence({
      accountId: ACCOUNT_ID,
      backupRoot: evidence.backupRoot,
      databaseId: DATABASE_ID,
      databaseName: DATABASE_NAME,
      now: NOW,
      repositoryRoot: process.cwd(),
      restoreRoot: evidence.restoreRoot,
      reviewedCommitSha: REVIEWED_COMMIT,
    })).rejects.toThrow("production_continuation_restore_evidence_invalid");
  });
});
