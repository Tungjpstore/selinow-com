import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertStagingReleaseAdmission,
  assertStagingContinuationBinding,
  assertStagingDatabasePreflight,
  assertStagingMigrationLedger,
  assertStagingMigrationLedgerPrefix,
  buildStagingReleaseManifest,
  captureStagingReleaseDatabaseBaseline,
  validateStagingReleaseManifest,
  parseStagingMigrationLedgerOutput,
  parseStagingDatabasePreflightOutput,
  runStagingMigrationWithVerification,
  writeStagingReleaseManifest,
} from "../../scripts/lib/staging-release.mjs";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const NOW = new Date("2026-08-03T00:00:00.000Z");
const FIRST_MIGRATION = "0001_foundation.sql";
const MIGRATIONS = [FIRST_MIGRATION, "0002_catalog.sql"];
const MIGRATION_LEDGER_PREFIX = [FIRST_MIGRATION];
const DATABASE_TARGET = {
  accountId: "a".repeat(32),
  databaseId: "17ea8f2f-4c97-4337-8989-28b25a58ddeb",
  databaseName: "selinow-staging",
};
const CONTINUATION_EVIDENCE = {
  backup: {
    checksumSha256: "c".repeat(64),
    completedAt: "2026-08-02T23:30:00.000Z",
    reportRef: ".wrangler/backups/staging/bkp_safe/snapshot.json",
    sizeBytes: 128,
    snapshotId: "bkp_20260802233000_aaaaaaaaaaaa",
  },
  restore: {
    completedAt: "2026-08-02T23:45:00.000Z",
    reportRef: ".wrangler/restore-drills/staging/rdr_safe.json",
    snapshotId: "bkp_20260802234500_bbbbbbbbbbbb",
    targetResourceRef: "d1:selinow-restore-drill-staging-bbbbbbbbbbbb",
  },
};
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
      continuationEvidence: CONTINUATION_EVIDENCE,
      databaseTarget: DATABASE_TARGET,
      migrationLedgerPrefix: MIGRATION_LEDGER_PREFIX,
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: repositoryState(),
    });

    expect(manifest).toMatchObject({
      commitSha: COMMIT_SHA,
      databaseTarget: DATABASE_TARGET,
      environment: "staging",
      migrationLedgerPrefix: MIGRATION_LEDGER_PREFIX,
      migrationNames: MIGRATIONS,
      releaseId: `stg_20260803T000000Z_${COMMIT_SHA.slice(0, 12)}`,
      schemaVersion: 3,
      treeSha: TREE_SHA,
    });
    expect(validateStagingReleaseManifest({
      manifest,
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: repositoryState(),
    })).toMatchObject({ commitSha: COMMIT_SHA, databaseTarget: DATABASE_TARGET, releaseId: manifest.releaseId, treeSha: TREE_SHA });
  });

  it("rejects dirty, changed, expired, and migration-drifted candidates", async () => {
    const manifest = await buildStagingReleaseManifest({
      continuationEvidence: CONTINUATION_EVIDENCE,
      databaseTarget: DATABASE_TARGET,
      migrationLedgerPrefix: MIGRATION_LEDGER_PREFIX,
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
    expect(() => validateStagingReleaseManifest({
      manifest: { ...manifest, migrationLedgerPrefix: [] },
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: repositoryState(),
    })).toThrow("staging_release_migration_ledger_baseline_mismatch");
  });

  it("rejects replacement backup, restore, or D1 evidence after manifest creation", async () => {
    const manifest = await buildStagingReleaseManifest({
      continuationEvidence: CONTINUATION_EVIDENCE,
      databaseTarget: DATABASE_TARGET,
      migrationLedgerPrefix: MIGRATION_LEDGER_PREFIX,
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: repositoryState(),
    });
    const admission = validateStagingReleaseManifest({
      manifest,
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: repositoryState(),
    });

    expect(() => {
      assertStagingContinuationBinding(admission, {
        ...CONTINUATION_EVIDENCE,
        backup: { ...CONTINUATION_EVIDENCE.backup, snapshotId: "bkp_20260802233000_cccccccccccc" },
      }, DATABASE_TARGET);
    }).toThrow("staging_release_continuation_evidence_mismatch");
    expect(() => {
      assertStagingContinuationBinding(admission, CONTINUATION_EVIDENCE, {
        ...DATABASE_TARGET,
        databaseId: "7ba9b340-514a-4b9f-81ed-00a4d115cc8d",
      });
    }).toThrow("staging_release_continuation_evidence_mismatch");
  });

  it("requires the complete ordered migration ledger before staging deploy", async () => {
    const output = JSON.stringify([{ results: MIGRATIONS.map((name) => ({ name })) }]);
    expect(parseStagingMigrationLedgerOutput(output)).toEqual(MIGRATIONS);
    await expect(assertStagingMigrationLedger({
      migrationNames: MIGRATIONS,
      runWranglerImplementation: () => ({ stderr: "", stdout: output }),
    })).resolves.toEqual({ migrationNames: MIGRATIONS });
    await expect(assertStagingMigrationLedger({
      migrationNames: MIGRATIONS,
      runWranglerImplementation: () => ({
        stderr: "",
        stdout: JSON.stringify([{ results: [{ name: MIGRATIONS[0] }] }]),
      }),
    })).rejects.toThrow("staging_migration_ledger_incomplete");
  });

  it("rejects a staging migration ledger that is not a reviewed prefix", async () => {
    const output = JSON.stringify([{ results: [{ name: "0002_catalog.sql" }] }]);
    await expect(assertStagingMigrationLedgerPrefix({
      migrationNames: MIGRATIONS,
      runWranglerImplementation: () => ({ stderr: "", stdout: output }),
    })).rejects.toThrow("staging_migration_ledger_prefix_invalid");
    await expect(assertStagingMigrationLedgerPrefix({
      migrationNames: MIGRATIONS,
      runWranglerImplementation: () => ({
        stderr: "",
        stdout: JSON.stringify([{ results: [...MIGRATIONS, "0003_extra.sql"].map((name) => ({ name })) }]),
      }),
    })).rejects.toThrow("staging_migration_ledger_prefix_invalid");
    await expect(assertStagingMigrationLedgerPrefix({
      migrationNames: MIGRATIONS,
      runWranglerImplementation: () => ({
        stderr: "",
        stdout: JSON.stringify([{ results: [] }]),
      }),
    })).rejects.toThrow("staging_migration_ledger_prefix_empty");
    await expect(assertStagingMigrationLedgerPrefix({
      migrationNames: MIGRATIONS,
      runWranglerImplementation: () => {
        throw new Error("ambiguous provider response");
      },
    })).rejects.toThrow("staging_migration_ledger_unavailable");
  });

  it("binds migration admission to the exact manifest ledger baseline", async () => {
    const output = JSON.stringify([{ results: MIGRATION_LEDGER_PREFIX.map((name) => ({ name })) }]);
    await expect(assertStagingMigrationLedgerPrefix({
      expectedPrefix: MIGRATION_LEDGER_PREFIX,
      migrationNames: MIGRATIONS,
      runWranglerImplementation: () => ({ stderr: "", stdout: output }),
    })).resolves.toEqual({ migrationNames: MIGRATION_LEDGER_PREFIX });
    await expect(assertStagingMigrationLedgerPrefix({
      expectedPrefix: MIGRATIONS,
      migrationNames: MIGRATIONS,
      runWranglerImplementation: () => ({ stderr: "", stdout: output }),
    })).rejects.toThrow("staging_migration_ledger_baseline_mismatch");
  });

  it("captures the live staging identity and non-empty ledger in the release baseline", async () => {
    const runner = vi.fn((_args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      expect(options?.env?.CLOUDFLARE_ACCOUNT_ID).toBe(DATABASE_TARGET.accountId);
      return {
        stderr: "",
        stdout: JSON.stringify([{ results: MIGRATION_LEDGER_PREFIX.map((name) => ({ name })) }]),
      };
    });
    await expect(captureStagingReleaseDatabaseBaseline({
      assertStagingMutationAdmissionImplementation: () => Promise.resolve(DATABASE_TARGET),
      databaseTarget: DATABASE_TARGET,
      environment: { CLOUDFLARE_PLATFORM_API_TOKEN: "not-forwarded" },
      migrationNames: MIGRATIONS,
      runWranglerImplementation: runner,
    })).resolves.toEqual({
      databaseTarget: DATABASE_TARGET,
      migrationLedgerPrefix: MIGRATION_LEDGER_PREFIX,
    });
    await expect(captureStagingReleaseDatabaseBaseline({
      assertStagingMutationAdmissionImplementation: () => Promise.resolve({
        ...DATABASE_TARGET,
        databaseId: "7ba9b340-514a-4b9f-81ed-00a4d115cc8d",
      }),
      databaseTarget: DATABASE_TARGET,
      migrationNames: MIGRATIONS,
      runWranglerImplementation: runner,
    })).rejects.toThrow("staging_release_target_mismatch");
  });

  it("requires every staging data preflight check to pass before deploy", () => {
    const output = JSON.stringify({
      checks: [{ code: "tenant_relationships", detail: "0", ok: true }],
      environment: "staging",
      ok: true,
    });
    expect(parseStagingDatabasePreflightOutput(output)).toEqual({
      checks: [{ code: "tenant_relationships", detail: "0", ok: true }],
    });
    expect(assertStagingDatabasePreflight({
      runImplementation: () => ({ stderr: "", stdout: output }),
    })).toEqual({ checks: [{ code: "tenant_relationships", detail: "0", ok: true }] });
    expect(() => {
      parseStagingDatabasePreflightOutput(JSON.stringify({
        checks: [{ code: "tenant_relationships", detail: "1", ok: false }],
        environment: "staging",
        ok: false,
      }));
    }).toThrow("staging_database_preflight_failed");
    expect(() => assertStagingDatabasePreflight({
      runImplementation: () => {
        throw new Error("provider output");
      },
    })).toThrow("staging_database_preflight_failed");
  });

  it("never invokes Wrangler migration when the staging preflight fails", async () => {
    const sink = vi.fn();
    const prefix = vi.fn(() => Promise.resolve({ migrationNames: MIGRATION_LEDGER_PREFIX }));
    const complete = vi.fn(() => Promise.resolve({ migrationNames: MIGRATIONS }));
    await expect(runStagingMigrationWithVerification({
      assertDatabasePreflightImplementation: () => {
        throw new Error("staging_database_preflight_failed");
      },
      assertMigrationLedgerImplementation: complete,
      assertMigrationLedgerPrefixImplementation: prefix,
      expectedPrefix: MIGRATION_LEDGER_PREFIX,
      migrationNames: MIGRATIONS,
      runMigrationImplementation: sink,
    })).rejects.toThrow("staging_database_preflight_failed");
    expect(prefix).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("rechecks the complete ledger and database preflight after staging migration", async () => {
    const events: string[] = [];
    await expect(runStagingMigrationWithVerification({
      assertDatabasePreflightImplementation: () => {
        events.push("preflight");
      },
      assertMigrationLedgerImplementation: () => {
        events.push("complete");
        return Promise.resolve({ migrationNames: MIGRATIONS });
      },
      assertMigrationLedgerPrefixImplementation: (input) => {
        events.push(`prefix:${input?.expectedPrefix?.join(",") ?? "missing"}`);
        return Promise.resolve({ migrationNames: MIGRATION_LEDGER_PREFIX });
      },
      expectedPrefix: MIGRATION_LEDGER_PREFIX,
      migrationNames: MIGRATIONS,
      runMigrationImplementation: () => {
        events.push("migrate");
      },
    })).resolves.toBeUndefined();
    expect(events).toEqual([
      "preflight",
      `prefix:${MIGRATION_LEDGER_PREFIX.join(",")}`,
      "migrate",
      "complete",
      "preflight",
    ]);
  });

  it("writes a private canonical manifest that admission can revalidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-staging-release-"));
    roots.push(root);
    const manifest = await buildStagingReleaseManifest({
      continuationEvidence: CONTINUATION_EVIDENCE,
      databaseTarget: DATABASE_TARGET,
      migrationLedgerPrefix: MIGRATION_LEDGER_PREFIX,
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
    })).resolves.toMatchObject({
      commitSha: COMMIT_SHA,
      databaseTarget: DATABASE_TARGET,
      releaseId: manifest.releaseId,
      treeSha: TREE_SHA,
    });
  });
});
