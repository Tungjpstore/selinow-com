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
      expiresAt: "2026-08-10T01:02:03.000Z",
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
      expect(report.staging.candidateMatchesLatestStaging).toBe(false);
      expect(report.staging.latestManifest?.path).toContain(`${releaseId}/release-manifest.json`);
      expect(report.staging.latestManifest).toMatchObject({
        releaseId,
        commitSha: "0123456789abcdef0123456789abcdef01234567",
        treeSha: "89abcdef0123456789abcdef0123456789abcdef",
        createdAt: "2026-08-09T01:02:03.000Z",
        expiresAt: "2026-08-10T01:02:03.000Z",
        schemaVersion: 3,
      });
      expect(JSON.stringify(report)).not.toContain("must-not-appear");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
