import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  assertFrontendOnlyActivationTransition,
  assertFrontendOnlyControlInventory,
  assertFrontendOnlyUploadTransition,
  assertFrontendOnlyVersionParity,
  compensateFrontendOnlyActivation,
  FRONTEND_ONLY_BASELINE_COMMIT,
  discoverFrontendOnlyWorkerVersions,
  FRONTEND_ONLY_ROLLBACK_VERSION,
  normalizeFrontendOnlyMigrationLedger,
  qualifyFrontendOnlySource,
  runFrontendOnlySmoke,
  validateFrontendOnlyEvidence,
  waitForFrontendOnlyActiveVersion,
} from "../../scripts/lib/frontend-only-release.mjs";

const candidate = "11111111-1111-4111-8111-111111111111";
const deployment = "22222222-2222-4222-8222-222222222222";

function evidence() {
  const report = (name: string) => ({
    reportRef: `.wrangler/releases/release_20260801_abcdef12/${name}-report.json`,
    reportSha256: "a".repeat(64),
  });
  return {
    baselineCommitSha: FRONTEND_ONLY_BASELINE_COMMIT,
    browser: {
      axeViolations: 0,
      consoleErrors: 0,
      desktop: true,
      mobile: true,
      pageErrors: 0,
      ...report("browser"),
      zoom200: true,
    },
    commitSha: "b".repeat(40),
    diffSha256: "c".repeat(64),
    environment: "production",
    mode: "production_frontend_only_v1",
    quality: {
      build: true,
      check: true,
      deployDryRun: true,
      lint: true,
      ...report("quality"),
      test: true,
    },
    releaseId: "release_20260801_abcdef12",
    rollbackWorkerVersion: FRONTEND_ONLY_ROLLBACK_VERSION,
    schemaVersion: 1,
    security: { criticalOpen: 0, highOpen: 0, ...report("security") },
    treeSha: "d".repeat(40),
    visual: { accepted: true, ...report("visual") },
  };
}

function packageJson(): { dependencies: Record<string, string>; scripts: Record<string, string> } {
  return {
    dependencies: { astro: "7.1.3" },
    scripts: { build: "astro build" },
  };
}

function source(path = "src/pages/index.astro") {
  const item = evidence();
  return {
    baselineCommitSha: FRONTEND_ONLY_BASELINE_COMMIT,
    baselineIsAncestor: true,
    changes: [{ newMode: "100644", oldMode: "100644", path, status: "M" }],
    clean: true,
    commitSha: item.commitSha,
    diffSha256: item.diffSha256,
    mergeCommits: [],
    storefrontSuffixUnchanged: true,
    treeSha: item.treeSha,
  };
}

function inventory(overrides: Record<string, unknown> = {}) {
  return {
    accountId: "a".repeat(32),
    databaseId: "33333333-3333-4333-8333-333333333333",
    databaseName: "selinow-production",
    deployments: [{ createdOn: "2026-08-01T00:00:00.000Z", id: "44444444-4444-4444-8444-444444444444", versionId: FRONTEND_ONLY_ROLLBACK_VERSION }],
    domains: [{ hostname: "selinow.com", service: "selinow-com-production" }],
    observedAt: "2026-08-01T00:00:00.000Z",
    queueConsumers: [],
    routes: [{ id: "route-a", pattern: "selinow.com/*", script: "selinow-com-production" }],
    schedules: [],
    secretNames: ["SESSION_SECRET"],
    versions: [{ id: FRONTEND_ONLY_ROLLBACK_VERSION }],
    workerName: "selinow-com-production",
    workerSubdomain: { enabled: false, previewsEnabled: false },
    zoneId: "b".repeat(32),
    zoneName: "selinow.com",
    ...overrides,
  };
}

function version(id: string) {
  return {
    id,
    resources: {
      bindings: [
        { name: "ASSETS", type: "assets" },
        { database_id: "db", name: "PLATFORM_DB", type: "d1" },
        { name: "APP_ENV", text: "production", type: "plain_text" },
      ],
      script: { handlers: ["scheduled", "fetch", "queue"], named_handlers: [] },
      script_runtime: {
        compatibility_date: "2026-07-26",
        compatibility_flags: ["nodejs_compat"],
        limits: { cpu_ms: 50 },
        usage_model: "standard",
      },
    },
  };
}

describe("production frontend-only release", () => {
  it("requires the dedicated evidence mode and all non-normal receipts", () => {
    expect(validateFrontendOnlyEvidence(evidence())).toBeTruthy();
    expect(() => validateFrontendOnlyEvidence({ ...evidence(), mode: "normal_release" }))
      .toThrow("production_frontend_only_evidence_invalid");
    expect(() => validateFrontendOnlyEvidence({
      ...evidence(),
      security: { ...evidence().security, highOpen: 1 },
    })).toThrow("production_frontend_only_security_incomplete");
  });

  it("admits only the exact source allowlist and package script-only release changes", () => {
    const baselinePackage = packageJson();
    const currentPackage = packageJson();
    currentPackage.scripts["release:production:frontend-only"] = "node scripts/production-frontend-release.mjs";
    expect(qualifyFrontendOnlySource({
      baselinePackage,
      currentPackage,
      evidence: evidence(),
      source: source(),
    })).toMatchObject({ rollbackWorkerVersion: FRONTEND_ONLY_ROLLBACK_VERSION });
    expect(() => qualifyFrontendOnlySource({
      baselinePackage,
      currentPackage,
      evidence: evidence(),
      source: source("migrations/0053_forbidden.sql"),
    })).toThrow("production_frontend_only_source_change_forbidden");
    expect(() => qualifyFrontendOnlySource({
      baselinePackage,
      currentPackage: { ...currentPackage, dependencies: { astro: "8.0.0" } },
      evidence: evidence(),
      source: source(),
    })).toThrow("production_frontend_only_package_boundary_invalid");
    expect(() => qualifyFrontendOnlySource({
      baselinePackage,
      currentPackage,
      evidence: evidence(),
      source: { ...source(), storefrontSuffixUnchanged: false },
    })).toThrow("production_frontend_only_source_identity_invalid");
  });

  it("normalizes the applied D1 ledger and rejects malformed rows", () => {
    expect(normalizeFrontendOnlyMigrationLedger([{
      results: [{ applied_at: "2026-08-01T00:00:00.000Z", id: 1, name: "0001_platform.sql" }],
      success: true,
    }])).toEqual([{ appliedAt: "2026-08-01T00:00:00.000Z", id: 1, name: "0001_platform.sql" }]);
    expect(() => normalizeFrontendOnlyMigrationLedger([{ results: [{ id: 1, name: "bad" }], success: true }]))
      .toThrow("production_frontend_only_migration_ledger_invalid");
  });

  it("allows upload to add one inactive version and no other inventory drift", () => {
    const before = inventory();
    const after = inventory({
      observedAt: "2026-08-01T00:01:00.000Z",
      versions: [...before.versions, { id: candidate }],
    });
    expect(assertFrontendOnlyControlInventory(before)).toBe(FRONTEND_ONLY_ROLLBACK_VERSION);
    expect(assertFrontendOnlyUploadTransition(before, after)).toBe(candidate);
    expect(() => assertFrontendOnlyUploadTransition(before, {
      ...after,
      routes: [{ id: "route-b", pattern: "selinow.com/*", script: "other" }],
    })).toThrow("production_frontend_only_upload_inventory_drift");
    expect(() => assertFrontendOnlyUploadTransition(before, {
      ...after,
      versions: [{ id: FRONTEND_ONLY_ROLLBACK_VERSION, metadata: { source: "changed" } }, { id: candidate }],
    })).toThrow("production_frontend_only_candidate_transition_invalid");
  });

  it("requires exact non-ASSETS binding, handler and runtime parity", () => {
    expect(assertFrontendOnlyVersionParity(version(FRONTEND_ONLY_ROLLBACK_VERSION), version(candidate)))
      .toMatchObject({ bindingNames: ["APP_ENV", "PLATFORM_DB"] });
    const drift = version(candidate);
    drift.resources.script_runtime.compatibility_date = "2026-08-01";
    expect(() => assertFrontendOnlyVersionParity(version(FRONTEND_ONLY_ROLLBACK_VERSION), drift))
      .toThrow("production_frontend_only_version_runtime_drift");
    const handlerDrift = version(candidate);
    handlerDrift.resources.script.handlers = ["fetch"];
    expect(() => assertFrontendOnlyVersionParity(version(FRONTEND_ONLY_ROLLBACK_VERSION), handlerDrift))
      .toThrow("production_frontend_only_handler_inventory_invalid");
  });

  it("allows activation to add exactly one candidate deployment", () => {
    const before = inventory({ versions: [{ id: FRONTEND_ONLY_ROLLBACK_VERSION }, { id: candidate }] });
    const after = inventory({
      deployments: [
        { createdOn: "2026-08-01T00:02:00.000Z", id: deployment, versionId: candidate },
        ...before.deployments,
      ],
      observedAt: "2026-08-01T00:02:00.000Z",
      versions: before.versions,
    });
    expect(assertFrontendOnlyActivationTransition(before, after, candidate)).toBe(candidate);
    expect(() => assertFrontendOnlyActivationTransition(before, { ...after, secretNames: [] }, candidate))
      .toThrow("production_frontend_only_activation_inventory_drift");
    const history = Array.from({ length: 10 }, (_unused, index) => ({
      createdOn: `2026-08-01T00:00:${String(10 - index).padStart(2, "0")}.000Z`,
      id: `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      versionId: index === 0 ? FRONTEND_ONLY_ROLLBACK_VERSION : `70000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const windowBefore = inventory({ deployments: history, versions: before.versions });
    const windowAfter = inventory({
      deployments: [
        { createdOn: "2026-08-01T00:01:00.000Z", id: deployment, versionId: candidate },
        ...history.slice(0, 9),
      ],
      versions: before.versions,
    });
    expect(assertFrontendOnlyActivationTransition(windowBefore, windowAfter, candidate)).toBe(candidate);
  });


  it("paginates the complete Worker version inventory beyond Wrangler's 10-row window", async () => {
    const versionId = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
    const requestHref = (request: Parameters<typeof fetch>[0]) => {
      if (typeof request === "string") return request;
      if (request instanceof globalThis.URL) return request.href;
      return request.url;
    };
    const sixVersionImplementation: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
      result: {
        items: Array.from({ length: 6 }, (_unused, index) => ({ id: versionId(index + 1), number: index + 1 })),
      },
      result_info: { count: 6, page: 1, per_page: 100, total_count: 6 },
      success: true,
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    const sixVersionFetcher = vi.fn(sixVersionImplementation);
    await expect(discoverFrontendOnlyWorkerVersions({
      accountId: "a".repeat(32),
      fetchImplementation: sixVersionFetcher,
      token: "audit-token",
      workerName: "selinow-com-production",
    })).resolves.toHaveLength(6);
    expect(sixVersionFetcher).toHaveBeenCalledTimes(1);

    const fetchImplementation: typeof fetch = (request) => {
      const page = Number(new globalThis.URL(requestHref(request)).searchParams.get("page"));
      const start = page === 1 ? 1 : 101;
      const count = page === 1 ? 100 : 1;
      const result = Array.from({ length: count }, (_unused, index) => ({
        id: versionId(start + index),
        number: start + index,
      }));
      return Promise.resolve(new Response(JSON.stringify({
        result: { items: result },
        result_info: { count, page, per_page: 100, total_count: 101 },
        success: true,
      }), { headers: { "content-type": "application/json" }, status: 200 }));
    };
    const fetcher = vi.fn(fetchImplementation);
    await expect(discoverFrontendOnlyWorkerVersions({
      accountId: "a".repeat(32),
      fetchImplementation: fetcher,
      token: "audit-token",
      workerName: "selinow-com-production",
    })).resolves.toHaveLength(101);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(requestHref(fetcher.mock.calls[0]?.[0] ?? "")).toContain("per_page=100");
    const shortFetchImplementation: typeof fetch = (request) => {
      const page = Number(new globalThis.URL(requestHref(request)).searchParams.get("page"));
      const count = page === 1 ? 2 : 1;
      const start = page === 1 ? 1 : 3;
      const items = Array.from({ length: count }, (_unused, index) => ({
        id: versionId(start + index),
        number: start + index,
      }));
      return Promise.resolve(new Response(JSON.stringify({
        result: { items },
        result_info: {
          count,
          page,
          per_page: 2,
          total_count: 3,
          total_pages: 2,
        },
        success: true,
      }), { headers: { "content-type": "application/json" }, status: 200 }));
    };
    const shortPageFetcher = vi.fn(shortFetchImplementation);
    await expect(discoverFrontendOnlyWorkerVersions({
      accountId: "a".repeat(32),
      fetchImplementation: shortPageFetcher,
      token: "audit-token",
      workerName: "selinow-com-production",
    })).resolves.toHaveLength(3);
    expect(shortPageFetcher).toHaveBeenCalledTimes(2);

    const mismatchedTotalPagesImplementation: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
      result: { items: [{ id: versionId(1), number: 1 }] },
      result_info: { count: 1, page: 1, per_page: 100, total_count: 1, total_pages: 2 },
      success: true,
    }), { headers: { "content-type": "application/json" }, status: 200 }));
    await expect(discoverFrontendOnlyWorkerVersions({
      accountId: "a".repeat(32),
      fetchImplementation: mismatchedTotalPagesImplementation,
      token: "audit-token",
      workerName: "selinow-com-production",
    })).rejects.toThrow("production_frontend_only_full_version_inventory_invalid");
  });

  it("polls bounded control-plane propagation and rejects an unrelated active version", async () => {
    let call = 0;
    const inventoryImplementation = vi.fn(() => {
      call += 1;
      return Promise.resolve(inventory({
        deployments: [{
          createdOn: "2026-08-01T00:00:00.000Z",
          id: deployment,
          versionId: call === 1 ? FRONTEND_ONLY_ROLLBACK_VERSION : candidate,
        }],
      }));
    });
    await expect(waitForFrontendOnlyActiveVersion({
      allowedVersions: new Set([FRONTEND_ONLY_ROLLBACK_VERSION, candidate]),
      attempts: 2,
      delayImplementation: () => Promise.resolve(),
      expectedVersion: candidate,
      inventoryImplementation,
    })).resolves.toMatchObject({ deployments: [{ versionId: candidate }] });
    await expect(waitForFrontendOnlyActiveVersion({
      allowedVersions: new Set([FRONTEND_ONLY_ROLLBACK_VERSION, candidate]),
      attempts: 1,
      expectedVersion: candidate,
      inventoryImplementation: () => Promise.resolve(inventory({
        deployments: [{ createdOn: "2026-08-01T00:00:00.000Z", id: deployment, versionId: "55555555-5555-4555-8555-555555555555" }],
      })),
    })).rejects.toThrow("production_frontend_only_active_version_ambiguous");
  });

  it("verifies rollback inventory and D1 even when the rollback deploy command throws ambiguously", async () => {
    const candidateActive = inventory({
      deployments: [{ createdOn: "2026-08-01T00:01:00.000Z", id: deployment, versionId: candidate }],
      versions: [{ id: FRONTEND_ONLY_ROLLBACK_VERSION }, { id: candidate }],
    });
    const restored = inventory();
    const restoredLedger = [{ appliedAt: "2026-08-01T00:00:00.000Z", id: 1, name: "0001_platform.sql" }];
    const deployRollbackImplementation = vi.fn(() => {
      throw new Error("wrangler_transport_ambiguous");
    });
    let inventoryCall = 0;
    const inventoryImplementation = vi.fn(() => Promise.resolve([
      candidateActive,
      candidateActive,
      restored,
    ][inventoryCall++] ?? restored));
    const migrationLedgerImplementation = vi.fn(() => Promise.resolve(restoredLedger));
    const verifyRestoredImplementation = vi.fn((observedInventory, observedLedger) => {
      expect(observedInventory).toEqual(restored);
      expect(observedLedger).toEqual(restoredLedger);
    });
    const originalError = new Error("production_frontend_only_monitor_drift");

    await expect(compensateFrontendOnlyActivation({
      allowedVersions: new Set([candidate, FRONTEND_ONLY_ROLLBACK_VERSION]),
      attempts: 1,
      candidateWorkerVersion: candidate,
      deployRollbackImplementation,
      inventoryImplementation,
      migrationLedgerImplementation,
      originalError,
      verifyRestoredImplementation,
    })).rejects.toMatchObject({
      cause: originalError,
      message: "production_frontend_only_automatic_rollback_complete:production_frontend_only_monitor_drift",
    });
    expect(deployRollbackImplementation).toHaveBeenCalledOnce();
    expect(inventoryImplementation).toHaveBeenCalledTimes(3);
    expect(migrationLedgerImplementation).toHaveBeenCalledOnce();
    expect(verifyRestoredImplementation).toHaveBeenCalledOnce();
  });

  it("fails closed before rollback mutation when fresh inventory is unavailable", async () => {
    const originalError = new Error("production_frontend_only_activation_ledger_drift");
    const migrationLedgerImplementation = vi.fn(() => Promise.resolve([]));
    const deployRollbackImplementation = vi.fn(() => {
      throw new Error("must_not_run");
    });
    await expect(compensateFrontendOnlyActivation({
      allowedVersions: new Set([candidate, FRONTEND_ONLY_ROLLBACK_VERSION]),
      attempts: 1,
      candidateWorkerVersion: candidate,
      deployRollbackImplementation,
      inventoryImplementation: () => Promise.reject(new Error("inventory_unavailable")),
      migrationLedgerImplementation,
      originalError,
      verifyRestoredImplementation: vi.fn(),
    })).rejects.toMatchObject({
      cause: originalError,
      message: "production_frontend_only_automatic_rollback_admission_unavailable:production_frontend_only_activation_ledger_drift",
    });
    expect(deployRollbackImplementation).not.toHaveBeenCalled();
    expect(migrationLedgerImplementation).not.toHaveBeenCalled();
  });

  it("verifies an already-restored control version without another deploy", async () => {
    const restored = inventory();
    const deployRollbackImplementation = vi.fn();
    const migrationLedgerImplementation = vi.fn(() => Promise.resolve([]));
    await expect(compensateFrontendOnlyActivation({
      allowedVersions: new Set([candidate, FRONTEND_ONLY_ROLLBACK_VERSION]),
      candidateWorkerVersion: candidate,
      deployRollbackImplementation,
      inventoryImplementation: () => Promise.resolve(restored),
      migrationLedgerImplementation,
      originalError: new Error("production_frontend_only_monitor_drift"),
      verifyRestoredImplementation: vi.fn(),
    })).rejects.toThrow("production_frontend_only_automatic_rollback_complete");
    expect(deployRollbackImplementation).not.toHaveBeenCalled();
    expect(migrationLedgerImplementation).toHaveBeenCalledOnce();
  });

  it("rechecks the candidate immediately before rollback mutation", async () => {
    const unrelated = "55555555-5555-4555-8555-555555555555";
    const candidateActive = inventory({
      deployments: [{ createdOn: "2026-08-01T00:01:00.000Z", id: deployment, versionId: candidate }],
    });
    const unrelatedActive = inventory({
      deployments: [{ createdOn: "2026-08-01T00:02:00.000Z", id: deployment, versionId: unrelated }],
    });
    const deployRollbackImplementation = vi.fn();
    const migrationLedgerImplementation = vi.fn();
    let call = 0;
    await expect(compensateFrontendOnlyActivation({
      allowedVersions: new Set([candidate, FRONTEND_ONLY_ROLLBACK_VERSION]),
      candidateWorkerVersion: candidate,
      deployRollbackImplementation,
      inventoryImplementation: () => Promise.resolve(call++ === 0 ? candidateActive : unrelatedActive),
      migrationLedgerImplementation,
      originalError: new Error("production_frontend_only_monitor_drift"),
      verifyRestoredImplementation: vi.fn(),
    })).rejects.toThrow("production_frontend_only_automatic_rollback_active_version_ambiguous");
    expect(deployRollbackImplementation).not.toHaveBeenCalled();
    expect(migrationLedgerImplementation).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an unrelated active production version", async () => {
    const unrelated = "55555555-5555-4555-8555-555555555555";
    const deployRollbackImplementation = vi.fn();
    const migrationLedgerImplementation = vi.fn();
    const originalError = new Error("production_frontend_only_monitor_drift");
    await expect(compensateFrontendOnlyActivation({
      allowedVersions: new Set([candidate, FRONTEND_ONLY_ROLLBACK_VERSION]),
      candidateWorkerVersion: candidate,
      deployRollbackImplementation,
      inventoryImplementation: () => Promise.resolve(inventory({
        deployments: [{ createdOn: "2026-08-01T00:02:00.000Z", id: deployment, versionId: unrelated }],
      })),
      migrationLedgerImplementation,
      originalError,
      verifyRestoredImplementation: vi.fn(),
    })).rejects.toMatchObject({
      cause: originalError,
      message: "production_frontend_only_automatic_rollback_active_version_ambiguous:production_frontend_only_monitor_drift",
    });
    expect(deployRollbackImplementation).not.toHaveBeenCalled();
    expect(migrationLedgerImplementation).not.toHaveBeenCalled();
  });

  it("runs only the fixed GET smoke matrix without reading response bodies", async () => {
    const fetcher = vi.fn((url: string, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      return Promise.resolve(new Response(null, {
        status: url.endsWith("/products/frontend-release-invalid") ? 404 : 200,
      }));
    });
    await expect(runFrontendOnlySmoke(fetcher as typeof fetch)).resolves.toHaveLength(5);
    expect(fetcher).toHaveBeenCalledTimes(5);
    for (const call of fetcher.mock.calls) expect(call[1]?.method).toBe("GET");
  });

  it("keeps the operator lane limited to immutable version upload and exact version deployment", () => {
    const sourceText = readFileSync("scripts/production-frontend-release.mjs", "utf8");
    const libraryText = readFileSync("scripts/lib/frontend-only-release.mjs", "utf8");
    expect(sourceText).toContain('"versions", "upload", "dist/server/entry.mjs"');
    expect(sourceText).toContain('"--config", "production-upload-wrangler.json"');
    expect(sourceText).toContain('"--no-bundle", "--assets", "dist/client", "--strict"');
    expect(sourceText).toContain('"versions", "deploy", `${versionId}@100%`');
    expect(sourceText).toContain("stageProductionUploadInputs(");
    expect(sourceText).toContain("removeProductionUploadStage(");
    expect(sourceText).toContain("compensateFrontendOnlyActivation(");
    expect(libraryText).toContain("production_frontend_only_automatic_rollback_complete");
    expect(libraryText).toContain("automatic_rollback_${status}_verification_failed");
    expect(sourceText).not.toContain('runWrangler(["deploy"');
    expect(sourceText).not.toContain('"d1", "migrations", "apply"');
    expect(sourceText).toContain("discoverFrontendOnlyWorkerVersions(");
    expect(libraryText).toContain('url.searchParams.set("per_page", "100")');
    expect(sourceText).toContain("waitForFrontendOnlyActiveVersion(");
    expect(sourceText).toContain("assertCandidateProvenance(candidateView, evidence)");
    expect(sourceText).toContain("inventoryWithoutDeploymentState(restored)");
    expect(sourceText).not.toContain("workers/routes");
    expect(sourceText).not.toContain("workers/domains");
    expect(sourceText).not.toContain("queues consumer add");
  });
});
