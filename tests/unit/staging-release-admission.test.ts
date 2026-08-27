import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertStagingContinuationBinding,
  assertStagingDatabasePreflight,
  assertStagingMigrationLedger,
  assertStagingMigrationLedgerPrefix,
  assertStagingMigrationCompletion,
  assertStagingPostMigrationEvidence,
  assertStagingReleaseAdmission,
  buildStagingMigrationCompletion,
  buildStagingPostMigrationEvidence,
  buildStagingReleaseManifest,
  captureStagingReleaseDatabaseBaseline,
  parseStagingDatabasePreflightOutput,
  parseStagingMigrationLedgerOutput,
  runStagingMigrationWithVerification,
  validateStagingReleaseManifest,
  writeStagingMigrationCompletion,
  writeStagingPostMigrationEvidence,
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

  it("normalizes sub-second manifest timestamps to the admitted release-id format", async () => {
    const manifest = await buildStagingReleaseManifest({
      continuationEvidence: CONTINUATION_EVIDENCE,
      databaseTarget: DATABASE_TARGET,
      migrationLedgerPrefix: MIGRATION_LEDGER_PREFIX,
      migrationNames: MIGRATIONS,
      now: new Date("2026-08-03T00:00:00.001Z"),
      repositoryState: repositoryState(),
    });
    expect(manifest.releaseId).toBe(`stg_20260803T000000Z_${COMMIT_SHA.slice(0, 12)}`);
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

  it("binds immutable post-migration evidence to the release, target, ledger, and migration completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-staging-release-completion-"));
    roots.push(root);
    const manifest = await buildStagingReleaseManifest({
      continuationEvidence: CONTINUATION_EVIDENCE,
      databaseTarget: DATABASE_TARGET,
      migrationLedgerPrefix: MIGRATION_LEDGER_PREFIX,
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: repositoryState(),
    });
    const releaseAdmission = validateStagingReleaseManifest({
      manifest,
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: repositoryState(),
    });
    const migrationCompletion = buildStagingMigrationCompletion({
      databaseTarget: DATABASE_TARGET,
      migrationNames: MIGRATIONS,
      now: new Date("2026-08-03T00:10:00.000Z"),
      releaseAdmission,
    });
    await writeStagingMigrationCompletion(migrationCompletion, root);
    await expect(assertStagingMigrationCompletion({
      databaseTarget: DATABASE_TARGET,
      migrationNames: MIGRATIONS,
      now: new Date("2026-08-03T00:40:00.000Z"),
      releaseAdmission,
      repositoryRoot: root,
    })).resolves.toEqual(migrationCompletion);

    const postMigrationContinuation = {
      backup: {
        checksumSha256: "d".repeat(64),
        completedAt: "2026-08-03T00:20:00.000Z",
        reportRef: ".wrangler/backups/staging/bkp_20260803002000_cccccccccccc/snapshot.json",
        sizeBytes: 256,
        snapshotId: "bkp_20260803002000_cccccccccccc",
      },
      restore: {
        completedAt: "2026-08-03T00:30:00.000Z",
        reportRef: ".wrangler/restore-drills/staging/rdr_20260803003000_dddddddddddd.json",
        snapshotId: "bkp_20260803003000_dddddddddddd",
        targetResourceRef: "d1:selinow-restore-drill-staging-dddddddddddd",
      },
    };
    const postMigrationEvidence = buildStagingPostMigrationEvidence({
      continuationEvidence: postMigrationContinuation,
      databaseTarget: DATABASE_TARGET,
      migrationCompletion,
      migrationNames: MIGRATIONS,
      now: new Date("2026-08-03T00:40:00.000Z"),
      releaseAdmission,
    });
    await writeStagingPostMigrationEvidence(postMigrationEvidence, root);
    await expect(assertStagingPostMigrationEvidence({
      continuationEvidence: postMigrationContinuation,
      databaseTarget: DATABASE_TARGET,
      migrationCompletion,
      migrationNames: MIGRATIONS,
      now: new Date("2026-08-03T00:45:00.000Z"),
      releaseAdmission,
      repositoryRoot: root,
    })).resolves.toEqual(postMigrationEvidence);
    await expect(writeStagingPostMigrationEvidence(postMigrationEvidence, root))
      .rejects.toThrow("staging_post_migration_evidence_exists");
    expect(() => buildStagingPostMigrationEvidence({
      continuationEvidence: {
        ...postMigrationContinuation,
        backup: { ...postMigrationContinuation.backup, completedAt: migrationCompletion.completedAt },
      },
      databaseTarget: DATABASE_TARGET,
      migrationCompletion,
      migrationNames: MIGRATIONS,
      now: new Date("2026-08-03T00:40:00.000Z"),
      releaseAdmission,
    })).toThrow("staging_post_migration_evidence_invalid");
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
      environment: {
        CLOUDFLARE_D1_API_TOKEN: "d1-token",
        CLOUDFLARE_PLATFORM_API_TOKEN: "not-forwarded",
      },
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
    const repairableOutput = JSON.stringify({
      checks: [
        { code: "tenant_relationships", detail: "0", ok: true },
        { code: "missing_payos_connections", detail: "1", ok: false },
      ],
      environment: "staging",
      ok: false,
    });
    expect(parseStagingDatabasePreflightOutput(repairableOutput, {
      allowMissingPayosConnections: true,
    })).toEqual({
      checks: [
        { code: "tenant_relationships", detail: "0", ok: true },
        { code: "missing_payos_connections", detail: "1", ok: false },
      ],
    });
    expect(() => parseStagingDatabasePreflightOutput(repairableOutput))
      .toThrow("staging_database_preflight_failed");
    expect(() => parseStagingDatabasePreflightOutput(JSON.stringify({
      checks: [{ code: "missing_payos_connections", detail: "1", ok: false }],
      environment: "staging",
      ok: true,
    }), { allowMissingPayosConnections: true }))
      .toThrow("staging_database_preflight_failed");
    expect(() => parseStagingDatabasePreflightOutput(JSON.stringify({
      checks: [
        { code: "missing_payos_connections", detail: "1", ok: false },
        { code: "invalid_payos_connection_links", detail: "1", ok: false },
      ],
      environment: "staging",
      ok: false,
    }), { allowMissingPayosConnections: true }))
      .toThrow("staging_database_preflight_failed");
    expect(() => assertStagingDatabasePreflight({
      runImplementation: () => {
        throw new Error("provider output");
      },
    })).toThrow("staging_database_preflight_failed");

    const nestedRunner = vi.fn((
      command: string,
      args: string[],
      options?: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      void command;
      void args;
      void options;
      return { stderr: "", stdout: output };
    });
    assertStagingDatabasePreflight({
      environment: {
        CLOUDFLARE_ACCOUNT_ID: DATABASE_TARGET.accountId,
        CLOUDFLARE_API_TOKEN: "pinned-d1-token",
      },
      runImplementation: nestedRunner,
    });
    expect(nestedRunner.mock.calls[0]?.[2]?.env).toMatchObject({
      CLOUDFLARE_ACCOUNT_ID: DATABASE_TARGET.accountId,
      CLOUDFLARE_API_TOKEN: "pinned-d1-token",
      CLOUDFLARE_D1_API_TOKEN: "pinned-d1-token",
    });
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
    expect(prefix).toHaveBeenCalledOnce();
    expect(sink).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("rechecks the complete ledger and database preflight after staging migration", async () => {
    const events: string[] = [];
    await expect(runStagingMigrationWithVerification({
      assertDatabasePreflightImplementation: (input) => {
        events.push(`preflight:${String(input?.allowMissingPayosConnections)}`);
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
      assertPostMigrationContractImplementation: () => {
        events.push("post-contract");
      },
      runMigrationImplementation: () => {
        events.push("migrate");
      },
    })).resolves.toBeUndefined();
    expect(events).toEqual([
      `prefix:${MIGRATION_LEDGER_PREFIX.join(",")}`,
      "preflight:false",
      "migrate",
      "complete",
      "preflight:false",
      "post-contract",
    ]);
  });

  it("allows only the known PayOS projection defect while migration 0119 is pending", async () => {
    const migrationNames = [
      FIRST_MIGRATION,
      "0119_payos_provider_projection_lifecycle.sql",
    ];
    const events: string[] = [];
    await runStagingMigrationWithVerification({
      assertDatabasePreflightImplementation: (input) => {
        events.push(`preflight:${String(input?.allowMissingPayosConnections)}`);
      },
      assertMigrationLedgerImplementation: () => Promise.resolve({ migrationNames }),
      assertMigrationLedgerPrefixImplementation: () => Promise.resolve({
        migrationNames: [FIRST_MIGRATION],
      }),
      expectedPrefix: [FIRST_MIGRATION],
      migrationNames,
      runMigrationImplementation: () => {
        events.push("migrate");
      },
    });
    expect(events).toEqual([
      "preflight:true",
      "migrate",
      "preflight:false",
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
    await expect(writeStagingReleaseManifest(manifest, root)).rejects.toThrow("staging_release_manifest_exists");
  });

  it("rejects symlinked manifest paths before opening or writing evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-staging-release-symlink-"));
    roots.push(root);
    const manifest = await buildStagingReleaseManifest({
      continuationEvidence: CONTINUATION_EVIDENCE,
      databaseTarget: DATABASE_TARGET,
      migrationLedgerPrefix: MIGRATION_LEDGER_PREFIX,
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryState: repositoryState(),
    });
    const target = join(root, "target");
    await mkdir(target, { recursive: true });
    await symlink(target, join(root, ".wrangler"));
    await expect(writeStagingReleaseManifest(manifest, root)).rejects.toThrow("staging_release_manifest_symlink_invalid");

    const cleanRoot = await mkdtemp(join(tmpdir(), "selinow-staging-release-file-symlink-"));
    roots.push(cleanRoot);
    const manifestPath = await writeStagingReleaseManifest(manifest, cleanRoot);
    const replacement = join(cleanRoot, "replacement.json");
    await rm(manifestPath);
    await symlink(replacement, manifestPath);
    await expect(assertStagingReleaseAdmission({
      manifestPath: relative(cleanRoot, manifestPath),
      migrationNames: MIGRATIONS,
      now: NOW,
      repositoryRoot: cleanRoot,
      repositoryState: repositoryState(),
    })).rejects.toThrow("staging_release_manifest_symlink_invalid");
  });
});
