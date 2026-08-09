import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildCloseoutReport,
  classifyReleaseCheck,
} from "../../scripts/lib/release-closeout.mjs";

describe("release closeout audit", () => {
  it("classifies failed gates without exposing provider values", () => {
    const classified = classifyReleaseCheck({
      name: "secret.DODO_PAYMENTS_API_KEY",
      ok: false,
      value: "dodo-secret-value",
    });

    expect(classified.name).toBe("secret.DODO_PAYMENTS_API_KEY");
    expect(classified.ok).toBe(false);
    expect(classified.category).toBe("production_secret_inventory");
    expect(classified.nextAction).toContain("name-only production Worker secret inventory");
    expect(JSON.stringify(classified)).not.toContain("dodo-secret-value");
  });

  it("reports clean-tree and staging-candidate drift from non-secret metadata", async () => {
    const root = join(tmpdir(), `selinow-closeout-${String(Date.now())}`);
    const releaseId = "stg_20260809T010203Z_0123456789ab";
    await mkdir(join(root, releaseId), { recursive: true });
    await writeFile(join(root, releaseId, "release-manifest.json"), JSON.stringify({
      releaseId,
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      treeSha: "89abcdef0123456789abcdef0123456789abcdef",
      createdAt: "2026-08-09T01:02:03.000Z",
      expiresAt: "2020-01-01T01:02:03.000Z",
      schemaVersion: 3,
      secretValue: "must-not-appear",
    }));

    try {
      const report = await buildCloseoutReport({
        evidence: null,
        productionSpec: null,
        workerSecretNames: [],
        wranglerConfig: {},
        stagingReleaseRoot: root,
      });

      expect(report.ok).toBe(false);
      expect(report.repository.headSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(report.staging.manifestFresh).toBe(false);
      expect(report.staging.candidateMatchesLatestStaging).toBe(false);
      expect(report.staging.eligibleForCurrentCandidate).toBe(false);
      expect(report.staging.latestManifest?.path).toContain(`${releaseId}/release-manifest.json`);
      expect(report.staging.latestManifest).toMatchObject({
        releaseId,
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        treeSha: "89abcdef0123456789abcdef0123456789abcdef",
        createdAt: "2026-08-09T01:02:03.000Z",
        expiresAt: "2020-01-01T01:02:03.000Z",
        schemaVersion: 3,
      });
      expect(JSON.stringify(report)).not.toContain("must-not-appear");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks an otherwise-ready closeout when staging or continuation evidence is not bound", async () => {
    const root = join(tmpdir(), `selinow-closeout-binding-${String(Date.now())}`);
    const releaseId = "stg_20260809T010203Z_0123456789ab";
    const manifestPath = join(root, releaseId, "release-manifest.json");
    await mkdir(join(root, releaseId), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({
      releaseId,
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      createdAt: "2026-08-09T01:02:03.000Z",
      expiresAt: "2026-08-09T01:03:03.000Z",
      schemaVersion: 3,
    }));

    try {
      const report = await buildCloseoutReport({
        evidence: {
          backup: {
            completedAt: "2026-08-09T01:02:03.000Z",
            restoreDrillCompletedAt: "2026-08-09T01:02:03.000Z",
            restoreDrillReportRef: "/missing/restore.json",
            snapshotReportRef: "/missing/backup.json",
          },
          commitSha: "a".repeat(40),
          staging: {
            manifestRef: manifestPath,
            manifestSha256: "0".repeat(64),
            releaseId,
          },
        },
        inspectReadinessImplementation: () => ({ checks: [], missing: [], ok: true }),
        now: new Date("2026-08-09T01:02:30.000Z"),
        productionSpec: { accountId: "c".repeat(32) },
        repositoryStateImplementation: () => ({
          dirty: "",
          headSha: "a".repeat(40),
          treeSha: "b".repeat(40),
        }),
        stagingReleaseRoot: root,
        continuationEvidenceImplementation: () => Promise.reject(new Error("missing")),
        workerSecretNames: [],
        wranglerConfig: { env: { production: { d1_databases: [{ binding: "PLATFORM_DB", database_id: "d", database_name: "db" }] } } },
      });

      expect(report.ok).toBe(false);
      expect(report.failedChecks.map((check) => check.name)).toEqual(expect.arrayContaining([
        "evidence.continuationFiles",
        "evidence.staging.currentCandidate",
      ]));
      expect(report.staging.eligibleForCurrentCandidate).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes closeout metadata only when staging and continuation artifacts match", async () => {
    const root = join(tmpdir(), `selinow-closeout-ready-${String(Date.now())}`);
    const releaseId = "stg_20260809T010203Z_0123456789ab";
    const manifestPath = join(root, releaseId, "release-manifest.json");
    const backupRef = join(root, "backup.json");
    const restoreRef = join(root, "restore.json");
    const manifest = JSON.stringify({
      releaseId,
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      createdAt: "2026-08-09T01:02:03.000Z",
      expiresAt: "2026-08-09T02:02:03.000Z",
      schemaVersion: 3,
    });
    await mkdir(join(root, releaseId), { recursive: true });
    await writeFile(manifestPath, manifest);

    try {
      const report = await buildCloseoutReport({
        evidence: {
          backup: {
            completedAt: "2026-08-09T01:00:00.000Z",
            restoreDrillCompletedAt: "2026-08-09T01:01:00.000Z",
            restoreDrillReportRef: restoreRef,
            snapshotReportRef: backupRef,
          },
          commitSha: "a".repeat(40),
          staging: {
            manifestRef: manifestPath,
            manifestSha256: createHash("sha256").update(manifest).digest("hex"),
            releaseId,
          },
        },
        continuationEvidenceImplementation: () => Promise.resolve({
          backup: { completedAt: "2026-08-09T01:00:00.000Z", reportRef: backupRef },
          restore: { completedAt: "2026-08-09T01:01:00.000Z", reportRef: restoreRef },
        }),
        inspectReadinessImplementation: () => ({ checks: [], missing: [], ok: true }),
        now: new Date("2026-08-09T01:30:00.000Z"),
        productionSpec: { accountId: "c".repeat(32) },
        repositoryStateImplementation: () => ({
          dirty: "",
          headSha: "a".repeat(40),
          treeSha: "b".repeat(40),
        }),
        stagingReleaseRoot: root,
        workerSecretNames: [],
        wranglerConfig: { env: { production: { d1_databases: [{ binding: "PLATFORM_DB", database_id: "d", database_name: "db" }] } } },
      });

      expect(report.ok).toBe(true);
      expect(report.failedChecks).toEqual([]);
      expect(report.staging.eligibleForCurrentCandidate).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
