import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertStagingReleaseAdmission,
  buildStagingReleaseManifest,
  validateStagingReleaseManifest,
  writeStagingReleaseManifest,
} from "../../scripts/lib/staging-release.mjs";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const NOW = new Date("2026-08-03T00:00:00.000Z");
const MIGRATIONS = ["0001_foundation.sql", "0002_catalog.sql"];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function repositoryState() {
  return { clean: true, commitSha: COMMIT_SHA, treeSha: TREE_SHA };
}

describe("staging release admission", () => {
  it("builds and validates an exact clean commit/tree manifest", async () => {
    const manifest = await buildStagingReleaseManifest({
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: repositoryState(),
    });

    expect(manifest).toMatchObject({
      commitSha: COMMIT_SHA,
      environment: "staging",
      migrationNames: MIGRATIONS,
      releaseId: `stg_20260803T000000Z_${COMMIT_SHA.slice(0, 12)}`,
      treeSha: TREE_SHA,
    });
    expect(validateStagingReleaseManifest({
      manifest,
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: repositoryState(),
    })).toEqual({ commitSha: COMMIT_SHA, releaseId: manifest.releaseId, treeSha: TREE_SHA });
  });

  it("rejects dirty, changed, expired, and migration-drifted candidates", async () => {
    const manifest = await buildStagingReleaseManifest({
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: repositoryState(),
    });
    expect(() => validateStagingReleaseManifest({
      manifest,
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: { ...repositoryState(), clean: false },
    })).toThrow("staging_release_source_dirty");
    expect(() => validateStagingReleaseManifest({
      manifest,
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: { ...repositoryState(), commitSha: "c".repeat(40) },
    })).toThrow("staging_release_commit_mismatch");
    expect(() => validateStagingReleaseManifest({
      manifest,
      migrationNames: [...MIGRATIONS, "0003_new.sql"],
      now: NOW,
      repositoryState: repositoryState(),
    })).toThrow("staging_release_migration_ledger_mismatch");
    expect(() => validateStagingReleaseManifest({
      manifest,
      migrationNames: MIGRATIONS,
      now: new Date("2026-08-04T00:00:00.001Z"),
      repositoryState: repositoryState(),
    })).toThrow("staging_release_window_invalid");
  });

  it("writes a private canonical manifest that admission can revalidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-staging-release-"));
    roots.push(root);
    const manifest = await buildStagingReleaseManifest({
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: repositoryState(),
    });
    const manifestPath = await writeStagingReleaseManifest(manifest, root);

    expect((await stat(manifestPath)).mode & 0o777).toBe(0o600);
    await expect(assertStagingReleaseAdmission({
      manifestPath: relative(root, manifestPath),
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryRoot: root,
      repositoryState: repositoryState(),
    })).resolves.toEqual({
      commitSha: COMMIT_SHA,
      releaseId: manifest.releaseId,
      treeSha: TREE_SHA,
    });
  });
});
