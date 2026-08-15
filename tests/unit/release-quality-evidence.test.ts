import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectReleaseQualityEvidence,
  QUALITY_COMMANDS,
  writeReleaseQualityEvidence,
} from "../../scripts/lib/release-quality-evidence.mjs";
import {
  parseArguments,
  runReleaseQualityEvidence,
} from "../../scripts/release-quality-evidence.mjs";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const RELEASE_ID = "prd_20260813t010203z_abcdef123456";
const STAGING_WORKER_VERSION = "22222222-2222-4222-8222-222222222222";
const roots: string[] = [];

function evidence() {
  return {
    commitSha: COMMIT_SHA,
    releaseId: RELEASE_ID,
    staging: { workerVersion: STAGING_WORKER_VERSION },
    treeSha: TREE_SHA,
  };
}

function cleanState() {
  return { commitSha: COMMIT_SHA, dirty: "", treeSha: TREE_SHA };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("release quality evidence", () => {
  it("runs every declared gate sequentially and binds the artifact to staging Worker identity", async () => {
    const observed: string[] = [];
    const collected = await collectReleaseQualityEvidence({
      evidence: evidence(),
      now: new Date("2026-08-13T01:02:03.000Z"),
      readCandidateStateImplementation: cleanState,
      repositoryRoot: "/unused",
      runCommandImplementation: (step: { key: string }) => {
        observed.push(step.key);
      },
    });

    expect(observed).toEqual(QUALITY_COMMANDS.map((step) => step.key));
    expect(collected.artifact).toMatchObject({
      commitSha: COMMIT_SHA,
      mode: "quality_evidence",
      releaseId: RELEASE_ID,
      treeSha: TREE_SHA,
      workerVersion: STAGING_WORKER_VERSION,
    });
    expect(Object.values(collected.artifact.evidence as Record<string, unknown>)).toEqual(expect.arrayContaining([true, 2]));
    expect(collected.artifactSha256).toBe(createHash("sha256")
      .update(`${JSON.stringify(collected.artifact, null, 2)}\n`)
      .digest("hex"));
  });

  it("stops at the first failing gate and never returns an artifact", async () => {
    const observed: string[] = [];
    await expect(collectReleaseQualityEvidence({
      evidence: evidence(),
      readCandidateStateImplementation: cleanState,
      repositoryRoot: "/unused",
      runCommandImplementation: (step: { key: string }) => {
        observed.push(step.key);
        if (step.key === "test") throw new Error("quality_evidence_gate_failed:test");
      },
    })).rejects.toThrow("quality_evidence_gate_failed:test");
    expect(observed).toEqual(["check", "lint", "tscNoEmit", "test"]);
  });

  it("rejects dirty or drifted candidate state before running commands", async () => {
    let ran = false;
    await expect(collectReleaseQualityEvidence({
      evidence: evidence(),
      readCandidateStateImplementation: () => ({ ...cleanState(), dirty: " M src/file.ts" }),
      repositoryRoot: "/unused",
      runCommandImplementation: () => {
        ran = true;
      },
    })).rejects.toThrow("quality_evidence_candidate_mismatch");
    expect(ran).toBe(false);
  });

  it("writes private artifact and patches only the quality projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-quality-evidence-"));
    roots.push(root);
    const evidencePath = join(root, ".wrangler/release/production-evidence.json");
    await mkdir(join(evidencePath, ".."), { recursive: true, mode: 0o700 });
    const input = { ...evidence(), approvals: { releaseOwner: "pending" } };
    await writeFile(evidencePath, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
    await chmod(evidencePath, 0o600);
    const collected = await collectReleaseQualityEvidence({
      evidence: input,
      now: new Date("2026-08-13T01:02:03.000Z"),
      readCandidateStateImplementation: cleanState,
      repositoryRoot: root,
      runCommandImplementation: () => undefined,
    });

    const written = await writeReleaseQualityEvidence({
      collected,
      evidence: input,
      evidencePath,
      readCandidateStateImplementation: cleanState,
      repositoryRoot: root,
    });
    const updated = JSON.parse(await readFile(evidencePath, "utf8")) as Record<string, unknown>;
    expect(written.evidenceRef).toBe(`.wrangler/releases/${RELEASE_ID}/quality-evidence.json`);
    expect(updated.approvals).toEqual(input.approvals);
    expect(updated.quality).toEqual(collected.quality);
    expect(JSON.parse(await readFile(join(root, written.evidenceRef), "utf8"))).toEqual(collected.artifact);
  });

  it("rejects a symlinked private evidence source", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-quality-symlink-"));
    roots.push(root);
    const external = await mkdtemp(join(tmpdir(), "selinow-quality-external-"));
    roots.push(external);
    const evidencePath = join(root, ".wrangler/release/production-evidence.json");
    const externalPath = join(external, "evidence.json");
    await mkdir(join(evidencePath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(externalPath, `${JSON.stringify(evidence())}\n`, { mode: 0o600 });
    await symlink(externalPath, evidencePath);

    await expect(writeReleaseQualityEvidence({
      collected: { artifact: {}, artifactSha256: "0".repeat(64), evidenceRef: "invalid", quality: {} },
      evidence: evidence(),
      evidencePath,
      readCandidateStateImplementation: cleanState,
      repositoryRoot: root,
    })).rejects.toThrow("quality_evidence_source_permissions_invalid");
  });

  it("parses CLI flags and remains non-writing unless explicitly requested", async () => {
    expect(parseArguments(["--json", "--write", "--evidence", ".wrangler/release/custom.json"]))
      .toMatchObject({ json: true, write: true });
    let wrote = false;
    const result = await runReleaseQualityEvidence({
      evidencePath: "/unused/.wrangler/release/production-evidence.json",
      json: true,
      write: false,
    }, {
      collectReleaseQualityEvidenceImplementation: () => Promise.resolve({
        artifactSha256: "c".repeat(64),
        evidenceRef: `.wrangler/releases/${RELEASE_ID}/quality-evidence.json`,
      }),
      readOptionalJsonImplementation: () => Promise.resolve(evidence()),
      writeReleaseQualityEvidenceImplementation: () => {
        wrote = true;
        return Promise.resolve({ artifactSha256: "c".repeat(64), evidenceRef: "unused" });
      },
    });
    expect(result.mode).toBe("validated");
    expect(wrote).toBe(false);
  });
});
