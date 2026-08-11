/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { executeProductionRollbackRehearsal, parseArguments } from "../../scripts/release-rollback-rehearsal.mjs";
import {
  REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS,
  validateProductionRollbackArtifact,
} from "../../scripts/lib/release.mjs";

const PREVIOUS = "11111111-1111-4111-8111-111111111111";
const ROLLBACK = "22222222-2222-4222-8222-222222222222";
const CANDIDATE = "33333333-3333-4333-8333-333333333333";
const MIGRATIONS = ["0001_first.sql"];

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    candidateWorkerVersion: CANDIDATE,
    commitSha: "a".repeat(40),
    previousWorkerVersion: PREVIOUS,
    releaseId: "release-2026-08-11",
    rollback: {
      candidate: {
        commitSha: "b".repeat(40),
        invariants: [...REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS],
        migrationLedgerSha256: createHash("sha256").update(JSON.stringify(MIGRATIONS)).digest("hex"),
        migrationName: MIGRATIONS[0],
        schemaVersion: 2,
        treeSha: "c".repeat(40),
        workerVersion: ROLLBACK,
      },
      rehearsedAt: "2026-08-01T00:00:00.000Z",
    },
    treeSha: "d".repeat(40),
    ...overrides,
  };
}

function successfulOperations(events: string[]) {
  let active = PREVIOUS;
  return {
    deployWorkerVersion: vi.fn(async (version: string) => {
      events.push(`deploy:${version}`);
      active = version;
    }),
    getActiveWorkerVersion: vi.fn(async () => {
      events.push("read:initial");
      return active;
    }),
    restoreWorkerVersion: vi.fn(async (version: string) => {
      events.push(`restore:${version}`);
      active = version;
    }),
    smokeCanary: vi.fn(async () => {
      events.push("smoke");
      return { status: 200 };
    }),
    verifyActiveWorkerVersion: vi.fn(async () => {
      events.push(`verify:${active}`);
      return active;
    }),
  };
}

function sourceAdmission() {
  return vi.fn(async () => undefined);
}

describe("production rollback rehearsal execution", () => {
  it("keeps plan and write-only modes non-authorizing and requires both execution confirmations", () => {
    expect(parseArguments([])).toMatchObject({ execute: false, write: false });
    expect(parseArguments(["--write"])).toMatchObject({ execute: false, write: true });
    expect(() => parseArguments(["--execute"])).toThrow("production_confirmation_required");
    expect(() => parseArguments(["--execute", "--confirm-production"]))
      .toThrow("maintenance_drain_confirmation_required");
    expect(parseArguments([
      "--execute", "--confirm-production", "--confirm-maintenance-drain",
    ])).toMatchObject({
      confirmMaintenanceDrain: true,
      confirmProduction: true,
      execute: true,
      write: false,
    });
    expect(() => parseArguments([
      "--execute", "--write", "--confirm-production", "--confirm-maintenance-drain",
    ])).toThrow("production_rollback_rehearsal_mode_conflict");
  });

  it("authorizes only after rollback smoke and exact previous-version restoration", async () => {
    const events: string[] = [];
    const writer = vi.fn(async ({ artifact }: { artifact: Record<string, any> }) => {
      events.push("write");
      expect(events.at(-2)).toBe(`verify:${PREVIOUS}`);
      expect(artifact.rehearsal).toEqual({
        authorizesProductionAdmission: true,
        completedAt: "2026-08-11T04:00:00.000Z",
        kind: "live_rollback_rehearsal",
        result: "passed",
      });
      return { artifact, artifactSha256: "f".repeat(64), evidenceRef: "private/rehearsal.json" };
    });

    await expect(executeProductionRollbackRehearsal({
      evidence: evidence(),
      migrationNames: MIGRATIONS,
      now: new Date("2026-08-11T04:00:00.000Z"),
      operations: successfulOperations(events),
      assertSourceBindingImplementation: sourceAdmission(),
      writeAuthorizingArtifact: writer,
    })).resolves.toMatchObject({ artifactSha256: "f".repeat(64) });
    expect(events).toEqual([
      "read:initial",
      `deploy:${ROLLBACK}`,
      `verify:${ROLLBACK}`,
      "smoke",
      `restore:${PREVIOUS}`,
      `verify:${PREVIOUS}`,
      "write",
    ]);
    expect(writer).toHaveBeenCalledOnce();
  });

  it("restores the previous version and never writes when canary smoke fails", async () => {
    const events: string[] = [];
    const operations = successfulOperations(events);
    operations.smokeCanary.mockImplementation(async () => {
      events.push("smoke:failed");
      throw new Error("production_rollback_canary_smoke_failed");
    });
    const writer = vi.fn();

    await expect(executeProductionRollbackRehearsal({
      evidence: evidence(),
      migrationNames: MIGRATIONS,
      operations,
      assertSourceBindingImplementation: sourceAdmission(),
      writeAuthorizingArtifact: writer,
    })).rejects.toThrow("production_rollback_canary_smoke_failed");
    expect(events.slice(-2)).toEqual([`restore:${PREVIOUS}`, `verify:${PREVIOUS}`]);
    expect(writer).not.toHaveBeenCalled();
  });

  it("never writes when restoration fails, even after a successful smoke", async () => {
    const events: string[] = [];
    const operations = successfulOperations(events);
    operations.restoreWorkerVersion.mockImplementation(async () => {
      events.push("restore:failed");
      throw new Error("provider_restore_failed");
    });
    const writer = vi.fn();

    await expect(executeProductionRollbackRehearsal({
      evidence: evidence(),
      migrationNames: MIGRATIONS,
      operations,
      assertSourceBindingImplementation: sourceAdmission(),
      writeAuthorizingArtifact: writer,
    })).rejects.toThrow("production_rollback_rehearsal_restore_failed");
    expect(writer).not.toHaveBeenCalled();
  });

  it("rejects stale active-version state before making any mutation", async () => {
    const events: string[] = [];
    const operations = successfulOperations(events);
    operations.getActiveWorkerVersion.mockResolvedValue(CANDIDATE);
    const writer = vi.fn();

    await expect(executeProductionRollbackRehearsal({
      evidence: evidence(),
      migrationNames: MIGRATIONS,
      operations,
      assertSourceBindingImplementation: sourceAdmission(),
      writeAuthorizingArtifact: writer,
    })).rejects.toThrow("production_rollback_rehearsal_previous_not_active");
    expect(operations.deployWorkerVersion).not.toHaveBeenCalled();
    expect(operations.restoreWorkerVersion).not.toHaveBeenCalled();
    expect(writer).not.toHaveBeenCalled();
  });

  it("writes a private canonical artifact accepted by the existing release validator", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-live-rollback-"));
    try {
      await mkdir(join(root, "migrations"), { recursive: true });
      await writeFile(join(root, "migrations/0001_first.sql"), "SELECT 1;\n");
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["config", "user.email", "rollback-test@selinow.invalid"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Selinow Rollback Test"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "rollback"], { cwd: root });
      const rollbackCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      const rollbackTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
      await writeFile(join(root, "release.txt"), "release\n");
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "--quiet", "-m", "release"], { cwd: root });
      const releaseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      const releaseTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
      const boundEvidence = evidence({ commitSha: releaseCommit, treeSha: releaseTree }) as any;
      boundEvidence.rollback.candidate.commitSha = rollbackCommit;
      boundEvidence.rollback.candidate.treeSha = rollbackTree;

      const result = await executeProductionRollbackRehearsal({
        evidence: boundEvidence,
        migrationNames: MIGRATIONS,
        now: new Date("2026-08-11T04:30:00.000Z"),
        operations: successfulOperations([]),
        repositoryRoot: root,
      });
      expect(validateProductionRollbackArtifact({
        evidence: boundEvidence,
        migrationNames: MIGRATIONS,
        repositoryRoot: root,
      })).toMatchObject({ accepted: true, artifactSha256: result.artifactSha256 });
      expect((await readFile(join(root, result.evidenceRef), "utf8"))).toContain('"live_rollback_rehearsal"');
      expect((await (await import("node:fs/promises")).stat(join(root, result.evidenceRef))).mode & 0o077).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
