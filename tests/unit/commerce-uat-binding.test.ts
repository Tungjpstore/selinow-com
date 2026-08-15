import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readTrustedStagingUatBinding } from "../../scripts/lib/commerce-uat-evidence.mjs";

const RELEASE_ID = "stg_20260808T090000Z_aaaaaaaaaaaa";

async function fixture(expiresAt: string) {
  const root = await mkdtemp(join(tmpdir(), "selinow-commerce-uat-binding-"));
  await mkdir(join(root, ".wrangler/releases/staging", RELEASE_ID), { recursive: true });
  await writeFile(join(root, "package.json"), "{}\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "release-test@selinow.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Selinow Release Test"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "uat binding fixture"], { cwd: root });
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  const manifest = {
    commitSha,
    createdAt: "2026-08-08T09:00:00.000Z",
    environment: "staging",
    expiresAt,
    releaseId: RELEASE_ID,
    schemaVersion: 3,
    treeSha,
  };
  const manifestRef = `.wrangler/releases/staging/${RELEASE_ID}/release-manifest.json`;
  const manifestBytes = `${JSON.stringify(manifest)}\n`;
  await writeFile(join(root, manifestRef), manifestBytes, { mode: 0o600 });
  return {
    commitSha,
    manifestRef,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    root,
    treeSha,
  };
}

describe("commerce UAT staging binding", () => {
  it("rejects an expired staging release manifest", async () => {
    const value = await fixture("2026-08-08T10:00:00.000Z");
    try {
      expect(() => readTrustedStagingUatBinding({
        evidence: {
          release: {
            commitSha: value.commitSha,
            manifestRef: value.manifestRef,
            manifestSha256: value.manifestSha256,
            releaseId: RELEASE_ID,
            treeSha: value.treeSha,
            workerVersion: "worker-20260808",
          },
        },
        now: new Date("2026-08-09T00:00:00.000Z"),
        repositoryRoot: value.root,
      })).toThrow("commerce_uat_staging_manifest_expired");
    } finally {
      await rm(value.root, { force: true, recursive: true });
    }
  });
});
