import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as platformModule from "../../scripts/lib/platform.mjs";
import * as releaseModule from "../../scripts/lib/release.mjs";

const now = new Date("2026-08-09T00:00:00.000Z");
const currentWorkerVersion = "11111111-1111-4111-8111-111111111111";
const rollbackWorkerVersion = "22222222-2222-4222-8222-222222222222";
const candidateWorkerVersion = "33333333-3333-4333-8333-333333333333";
const migrationNames = readdirSync("migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort();
const requiredInvariants = [...((releaseModule as Record<string, unknown>).REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS as string[])];

function evidence() {
  return {
    candidateWorkerVersion,
    commitSha: "a".repeat(40),
    previousWorkerVersion: currentWorkerVersion,
    rollback: {
      candidate: {
        accepted: true,
        artifactSha256: "c".repeat(64),
        commitSha: "b".repeat(40),
        evidenceRef: "private/rollback/schema-compatible-candidate.json",
        invariants: requiredInvariants,
        migrationLedgerSha256: createHash("sha256").update(JSON.stringify(migrationNames)).digest("hex"),
        migrationName: migrationNames.at(-1),
        rehearsalPassed: true,
        rehearsedAt: "2026-08-08T12:00:00.000Z",
        schemaVersion: 2,
        treeSha: "c".repeat(40),
        workerVersion: rollbackWorkerVersion,
      },
      rehearsedAt: "2026-08-08T12:00:00.000Z",
    },
  };
}

function rollbackEvaluator() {
  return (releaseModule as Record<string, unknown>).evaluateProductionRollbackCandidate;
}

describe("production rollback schema compatibility admission", () => {
  it("accepts only an explicit source-ledger-bound rollback candidate", () => {
    const evaluate = rollbackEvaluator();
    expect(typeof evaluate).toBe("function");
    if (typeof evaluate !== "function") return;

    const result = (evaluate as (value: Record<string, unknown>, time: Date, names: string[]) => {
      candidate: Record<string, unknown>;
      missing: string[];
      ok: boolean;
    })(evidence(), now, migrationNames);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.candidate.workerVersion).toBe(rollbackWorkerVersion);
  });

  it("rejects the currently deployed phase-6 Worker as the rollback candidate", () => {
    const evaluate = rollbackEvaluator();
    expect(typeof evaluate).toBe("function");
    if (typeof evaluate !== "function") return;
    const input = evidence();
    input.rollback.candidate.workerVersion = currentWorkerVersion;

    const result = (evaluate as (value: Record<string, unknown>, time: Date, names: string[]) => { missing: string[] })(input, now, migrationNames);
    expect(result.missing).toContain("evidence.rollback.candidate.notCurrentWorker");
  });

  it("rejects stale or incomplete trial-claim, privacy and recovery compatibility evidence", () => {
    const evaluate = rollbackEvaluator();
    expect(typeof evaluate).toBe("function");
    if (typeof evaluate !== "function") return;
    const input = evidence();
    input.rollback.candidate.rehearsedAt = "2026-06-01T00:00:00.000Z";
    input.rollback.rehearsedAt = "2026-06-01T00:00:00.000Z";
    input.rollback.candidate.invariants = requiredInvariants.slice(0, -1);

    const result = (evaluate as (value: Record<string, unknown>, time: Date, names: string[]) => { missing: string[] })(input, now, migrationNames);
    expect(result.missing).toEqual(expect.arrayContaining([
      "evidence.rollback.candidate.invariants",
      "evidence.rollback.candidate.rehearsedAtFresh",
    ]));
  });

  it("accepts reviewed invariant supersets and invalidates evidence when the source ledger advances", () => {
    const evaluate = rollbackEvaluator();
    expect(typeof evaluate).toBe("function");
    if (typeof evaluate !== "function") return;
    const input = evidence();
    input.rollback.candidate.invariants = [...requiredInvariants, "future_reviewed_integrity_guard"];
    const accepted = (evaluate as (
      value: Record<string, unknown>, time: Date, names: string[],
    ) => { missing: string[]; ok: boolean })(input, now, migrationNames);
    expect(accepted.ok).toBe(true);

    const advanced = (evaluate as (
      value: Record<string, unknown>, time: Date, names: string[],
    ) => { missing: string[] })(input, now, [...migrationNames, "0090_future.sql"]);
    expect(advanced.missing).toEqual(expect.arrayContaining([
      "evidence.rollback.candidate.migrationLedgerSha256",
      "evidence.rollback.candidate.migrationName",
    ]));
  });

  it("requires an immutable Cloudflare Worker version ID for the rollback candidate", () => {
    const evaluate = rollbackEvaluator();
    expect(typeof evaluate).toBe("function");
    if (typeof evaluate !== "function") return;
    const input = evidence();
    input.rollback.candidate.workerVersion = "phase-6-worker";

    const result = (evaluate as (value: Record<string, unknown>, time: Date, names: string[]) => { missing: string[] })(input, now, migrationNames);
    expect(result.missing).toContain("evidence.rollback.candidate.workerVersion");
  });

  it("directs rollback operations to the admitted schema-compatible candidate", () => {
    const matrix = releaseModule.buildRollbackMatrix();
    const serialized = JSON.stringify(matrix);

    expect(serialized).toContain("schema_compatible_rollback_candidate");
    expect(serialized).not.toContain("previous_worker_version");
  });

  it("reads the exact 100-percent live Worker deployment and binds version admission", () => {
    const parse = (platformModule as Record<string, unknown>).parseProductionWorkerDeploymentVersion;
    const parseDeployable = (platformModule as Record<string, unknown>).parseProductionWorkerDeployableVersions;
    const assertVersion = (platformModule as Record<string, unknown>).assertProductionWorkerVersionAdmission;
    expect(typeof parse).toBe("function");
    expect(typeof parseDeployable).toBe("function");
    expect(typeof assertVersion).toBe("function");
    if (typeof parse !== "function" || typeof parseDeployable !== "function" || typeof assertVersion !== "function") return;

    const observed = (parse as (value: unknown) => string)({
      deployments: [{
        created_on: "2026-08-08T12:00:00.000Z",
        id: "44444444-4444-4444-8444-444444444444",
        versions: [{ percentage: 100, version_id: currentWorkerVersion }],
      }, {
        created_on: "2026-08-01T12:00:00.000Z",
        id: "55555555-5555-4555-8555-555555555555",
        versions: [
          { percentage: 50, version_id: candidateWorkerVersion },
          { percentage: 50, version_id: rollbackWorkerVersion },
        ],
      }],
    });
    const deployableWorkerVersionIds = (parseDeployable as (value: unknown) => string[])({
      items: [{ id: candidateWorkerVersion }, { id: rollbackWorkerVersion }],
    });
    expect(observed).toBe(currentWorkerVersion);
    expect((assertVersion as (input: Record<string, unknown>) => Record<string, unknown>)({
      candidateWorkerVersion,
      currentWorkerVersion: observed,
      deployableWorkerVersionIds,
      previousWorkerVersion: currentWorkerVersion,
      rollbackCandidateWorkerVersion: rollbackWorkerVersion,
    })).toEqual({ candidateWorkerVersion, currentWorkerVersion, rollbackCandidateWorkerVersion: rollbackWorkerVersion });
  });

  it("rejects undeployable or overlapping candidate and rollback Worker versions", () => {
    const assertVersion = (platformModule as Record<string, unknown>).assertProductionWorkerVersionAdmission;
    expect(typeof assertVersion).toBe("function");
    if (typeof assertVersion !== "function") return;
    const admit = (overrides: Record<string, unknown>) => (assertVersion as (
      input: Record<string, unknown>,
    ) => Record<string, unknown>)({
      candidateWorkerVersion,
      currentWorkerVersion,
      deployableWorkerVersionIds: [candidateWorkerVersion, rollbackWorkerVersion],
      previousWorkerVersion: currentWorkerVersion,
      rollbackCandidateWorkerVersion: rollbackWorkerVersion,
      ...overrides,
    });

    expect(() => admit({ candidateWorkerVersion: currentWorkerVersion }))
      .toThrow("production_candidate_worker_version_is_current");
    expect(() => admit({ rollbackCandidateWorkerVersion: candidateWorkerVersion }))
      .toThrow("production_candidate_and_rollback_versions_match");
    expect(() => admit({ deployableWorkerVersionIds: [rollbackWorkerVersion] }))
      .toThrow("production_candidate_worker_version_not_deployable");
    expect(() => admit({ deployableWorkerVersionIds: [candidateWorkerVersion] }))
      .toThrow("production_rollback_candidate_version_not_deployable");
  });

  it("requires reviewed provenance metadata for candidate and rollback inventory entries", () => {
    const parseInventory = (platformModule as Record<string, unknown>).parseProductionWorkerDeployableVersionInventory;
    const assertVersion = (platformModule as Record<string, unknown>).assertProductionWorkerVersionAdmission;
    expect(typeof parseInventory).toBe("function");
    expect(typeof assertVersion).toBe("function");
    if (typeof parseInventory !== "function" || typeof assertVersion !== "function") return;
    const inventory = (parseInventory as (value: unknown) => Array<{ id: string; binding: Record<string, string> }>)(
      {
        items: [
          {
            annotations: {
              "workers/message": `selinow-release commitSha=${"a".repeat(40)} treeSha=${"b".repeat(40)} releaseId=release_20260809_abcdef12 manifestRef=.wrangler/releases/release_20260809_abcdef12/release-manifest.json`,
            },
            id: candidateWorkerVersion,
          },
          {
            metadata: {
              commitSha: "a".repeat(40),
              manifestRef: ".wrangler/releases/release_20260809_rollback12/release-manifest.json",
              releaseId: "release_20260809_rollback12",
              treeSha: "b".repeat(40),
            },
            id: rollbackWorkerVersion,
          },
        ],
      },
    );
    expect(() => (assertVersion as (input: Record<string, unknown>) => unknown)({
      candidateWorkerVersion,
      candidateWorkerVersionBinding: {
        commitSha: "a".repeat(40),
        manifestRef: ".wrangler/releases/release_20260809_abcdef12/release-manifest.json",
        releaseId: "release_20260809_abcdef12",
        treeSha: "b".repeat(40),
      },
      currentWorkerVersion,
      deployableWorkerVersionIds: [candidateWorkerVersion, rollbackWorkerVersion],
      deployableWorkerVersionInventory: inventory,
      previousWorkerVersion: currentWorkerVersion,
      rollbackCandidateWorkerVersion: rollbackWorkerVersion,
    })).not.toThrow();
    expect(() => (assertVersion as (input: Record<string, unknown>) => unknown)({
      candidateWorkerVersion,
      candidateWorkerVersionBinding: {
        commitSha: "c".repeat(40),
        manifestRef: ".wrangler/releases/release_20260809_abcdef12/release-manifest.json",
        releaseId: "release_20260809_abcdef12",
        treeSha: "b".repeat(40),
      },
      currentWorkerVersion,
      deployableWorkerVersionIds: [candidateWorkerVersion, rollbackWorkerVersion],
      deployableWorkerVersionInventory: inventory,
      previousWorkerVersion: currentWorkerVersion,
      rollbackCandidateWorkerVersion: rollbackWorkerVersion,
    })).toThrow("production_candidate_worker_version_binding_mismatch");
  });

  it("rejects a latest deployment that is split or not exactly 100 percent", () => {
    const parse = (platformModule as Record<string, unknown>).parseProductionWorkerDeploymentVersion;
    expect(typeof parse).toBe("function");
    if (typeof parse !== "function") return;
    expect(() => (parse as (value: unknown) => string)({
      deployments: [{
        created_on: "2026-08-08T12:00:00.000Z",
        id: "44444444-4444-4444-8444-444444444444",
        versions: [
          { percentage: 50, version_id: currentWorkerVersion },
          { percentage: 50, version_id: candidateWorkerVersion },
        ],
      }],
    })).toThrow("production_worker_deployment_inventory_invalid");
  });
});
