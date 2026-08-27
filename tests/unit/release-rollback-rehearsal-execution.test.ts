/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/require-await */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  executeProductionRollbackRehearsal,
  parseArguments,
  smokeRollbackCanary,
  verifyMaintenanceDrainEvidence,
} from "../../scripts/release-rollback-rehearsal.mjs";
import {
  REQUIRED_PRODUCTION_ROLLBACK_INVARIANTS,
  validateProductionRollbackArtifact,
} from "../../scripts/lib/release.mjs";

const PREVIOUS = "11111111-1111-4111-8111-111111111111";
const ROLLBACK = "22222222-2222-4222-8222-222222222222";
const CANDIDATE = "33333333-3333-4333-8333-333333333333";
const MIGRATIONS = ["0001_first.sql"];

function requestUrl(request: string | URL | Request): string {
  if (typeof request === "string") return request;
  return request instanceof URL ? request.toString() : request.url;
}

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
    verifyMaintenanceDrain: vi.fn(async () => {
      events.push("drain");
      return { observedAt: "2026-08-11T03:59:00.000Z" };
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
    expect(() => parseArguments([
      "--execute", "--confirm-production", "--confirm-maintenance-drain",
    ])).toThrow("maintenance_drain_evidence_required");
    expect(() => parseArguments([
      "--execute", "--confirm-production", "--confirm-maintenance-drain",
      "--maintenance-drain-evidence", "private/drain.json",
    ])).toThrow("rollback_smoke_storefront_url_required");
    expect(parseArguments([
      "--execute", "--confirm-production", "--confirm-maintenance-drain",
      "--maintenance-drain-evidence", "private/drain.json",
      "--smoke-storefront-url", "https://pilot.selinow.com/",
    ])).toMatchObject({
      confirmMaintenanceDrain: true,
      confirmProduction: true,
      execute: true,
      maintenanceDrainEvidencePath: expect.stringMatching(/private\/drain\.json$/u),
      smokeStorefrontUrl: "https://pilot.selinow.com/",
      write: false,
    });
    expect(() => parseArguments([
      "--execute", "--write", "--confirm-production", "--confirm-maintenance-drain",
      "--maintenance-drain-evidence", "private/drain.json",
      "--smoke-storefront-url", "https://pilot.selinow.com/",
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
      "drain",
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

  it("isolates deployment reads and version mutations behind their dedicated credentials", async () => {
    let active = PREVIOUS;
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const runWranglerImplementation = vi.fn((args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
      const env = options?.env ?? {};
      calls.push({ args, env });
      if (args[0] === "deployments") {
        return {
          stderr: "",
          stdout: JSON.stringify([{
            created_on: "2026-08-11T04:00:00.000Z",
            versions: [{ percentage: 100, version_id: active }],
          }]),
        };
      }
      if (args[0] === "versions" && args[1] === "deploy") {
        active = String(args[2]).split("@")[0] ?? "";
        return { stderr: "", stdout: "" };
      }
      throw new Error(`unexpected_wrangler_command:${args.join(":")}`);
    });

    await expect(executeProductionRollbackRehearsal({
      evidence: evidence(),
      migrationNames: MIGRATIONS,
      now: new Date("2026-08-11T04:00:00.000Z"),
      operatorEnvironment: {
        CLOUDFLARE_API_TOKEN: "forbidden-general-token",
        CLOUDFLARE_D1_API_TOKEN: "forbidden-d1-token",
        CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN: "promotion-audit-token",
        CLOUDFLARE_WORKER_DEPLOY_API_TOKEN: "worker-deploy-token",
        PATH: process.env.PATH,
      },
      operations: {
        smokeCanary: vi.fn(async () => ({ status: 200 })),
        verifyMaintenanceDrain: vi.fn(async () => ({ observedAt: "2026-08-11T03:59:00.000Z" })),
      },
      productionAccountId: "a".repeat(32),
      runWranglerImplementation,
      assertSourceBindingImplementation: sourceAdmission(),
      writeAuthorizingArtifact: vi.fn(async ({ artifact }: { artifact: Record<string, any> }) => ({
        artifact,
        artifactSha256: "f".repeat(64),
        evidenceRef: "private/rehearsal.json",
      })),
    })).resolves.toMatchObject({ artifactSha256: "f".repeat(64) });

    expect(calls.filter(({ args }) => args[0] === "deployments")).toHaveLength(3);
    expect(calls.filter(({ args }) => args[0] === "versions")).toHaveLength(2);
    for (const { args, env } of calls) {
      expect(env.CLOUDFLARE_ACCOUNT_ID).toBe("a".repeat(32));
      expect(env.CLOUDFLARE_D1_API_TOKEN).toBeUndefined();
      expect(env.CLOUDFLARE_WORKER_DEPLOY_API_TOKEN).toBeUndefined();
      expect(env.CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN).toBeUndefined();
      expect(env.CLOUDFLARE_API_TOKEN).toBe(
        args[0] === "deployments" ? "promotion-audit-token" : "worker-deploy-token",
      );
      expect(env.CLOUDFLARE_API_TOKEN).not.toBe("forbidden-general-token");
    }
  });

  it("rejects a shared token for audit and deployment roles", async () => {
    const sharedToken = "shared-token";
    await expect(executeProductionRollbackRehearsal({
      evidence: evidence(),
      migrationNames: MIGRATIONS,
      operatorEnvironment: {
        CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN: sharedToken,
        CLOUDFLARE_WORKER_DEPLOY_API_TOKEN: sharedToken,
      },
      operations: {
        verifyMaintenanceDrain: vi.fn(async () => ({ observedAt: "2026-08-11T03:59:00.000Z" })),
      },
      productionAccountId: "a".repeat(32),
      assertSourceBindingImplementation: sourceAdmission(),
    })).rejects.toThrow("production_rollback_rehearsal_credentials_not_separated");
  });

  it("fails before version discovery or deployment when maintenance drain evidence is rejected", async () => {
    const events: string[] = [];
    const operations = successfulOperations(events);
    operations.verifyMaintenanceDrain.mockRejectedValue(new Error("maintenance_drain_evidence_invalid"));

    await expect(executeProductionRollbackRehearsal({
      evidence: evidence(),
      migrationNames: MIGRATIONS,
      operations,
      assertSourceBindingImplementation: sourceAdmission(),
    })).rejects.toThrow("maintenance_drain_evidence_invalid");
    expect(events).toEqual([]);
    expect(operations.getActiveWorkerVersion).not.toHaveBeenCalled();
    expect(operations.deployWorkerVersion).not.toHaveBeenCalled();
  });

  it("accepts only fresh mode-0600 maintenance drain evidence bound to the exact candidate", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-maintenance-drain-"));
    const boundEvidence = evidence();
    const path = join(root, ".wrangler/releases/release-2026-08-11/maintenance-drain-evidence.json");
    const artifact = {
      commitSha: boundEvidence.commitSha,
      environment: "production",
      mode: "production_maintenance_drain",
      observedAt: "2026-08-11T03:55:00.000Z",
      previousWorkerVersion: PREVIOUS,
      releaseId: boundEvidence.releaseId,
      schemaVersion: 1,
      states: {
        inFlightJobsDrained: true,
        queueProducersPaused: true,
        scheduledWorkPaused: true,
        writeAdmissionClosed: true,
      },
      treeSha: boundEvidence.treeSha,
    };
    try {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
      await expect(verifyMaintenanceDrainEvidence({
        evidence: boundEvidence,
        evidencePath: path,
        now: new Date("2026-08-11T04:00:00.000Z"),
        repositoryRoot: root,
      })).resolves.toEqual({ observedAt: artifact.observedAt });

      await chmod(path, 0o644);
      await expect(verifyMaintenanceDrainEvidence({
        evidence: boundEvidence,
        evidencePath: path,
        now: new Date("2026-08-11T04:00:00.000Z"),
        repositoryRoot: root,
      })).rejects.toThrow("maintenance_drain_evidence_permissions_invalid");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("accepts semantically identical maintenance drain states regardless of JSON key order", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-maintenance-drain-order-"));
    const boundEvidence = evidence();
    const path = join(root, ".wrangler/releases/release-2026-08-11/maintenance-drain-evidence.json");
    const artifact = {
      commitSha: boundEvidence.commitSha,
      environment: "production",
      mode: "production_maintenance_drain",
      observedAt: "2026-08-11T03:55:00.000Z",
      previousWorkerVersion: PREVIOUS,
      releaseId: boundEvidence.releaseId,
      schemaVersion: 1,
      states: {
        writeAdmissionClosed: true,
        scheduledWorkPaused: true,
        queueProducersPaused: true,
        inFlightJobsDrained: true,
      },
      treeSha: boundEvidence.treeSha,
    };
    try {
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
      await expect(verifyMaintenanceDrainEvidence({
        evidence: boundEvidence,
        evidencePath: path,
        now: new Date("2026-08-11T04:00:00.000Z"),
        repositoryRoot: root,
      })).resolves.toEqual({ observedAt: artifact.observedAt });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("requires phase-10 health, dashboard, marketing, storefront and fail-closed Dodo route checks", async () => {
    const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(request);
      if (url.endsWith("/api/health")) return new Response(JSON.stringify({
        commerce: { channels: ["telegram", "website"], contract: "principal-channel-canonical-v1" },
        ok: true,
        phase: 10,
        release: { commerce: "provider_pending", platform: "deployed" },
        requestId: "rollback-health-request",
        service: "selinow.com",
      }), { headers: { "cache-control": "no-store", "content-type": "application/json" }, status: 200 });
      if (url.endsWith("/solutions")) return new Response("<html><main>Solutions</main></html>", { headers: { "content-type": "text/html" }, status: 200 });
      if (url.endsWith("/llms.txt")) return new Response("# Selinow\nWebsite and Telegram\n", { headers: { "content-type": "text/plain; charset=utf-8" }, status: 200 });
      if (url.endsWith("/login")) return new Response("<html><main>Login</main></html>", { headers: { "content-type": "text/html", "x-robots-tag": "noindex" }, status: 200 });
      if (url === "https://pilot.selinow.com/") return new Response("<html><body data-storefront-surface></body></html>", { headers: { "content-type": "text/html" }, status: 200 });
      if (url.includes("/api/webhooks/billing/dodo/")) {
        expect(init?.method).toBe("POST");
        return new Response(JSON.stringify({ code: "webhook_signature_invalid", ok: false, requestId: "rollback-webhook-request" }), {
          headers: { "cache-control": "private, no-store, max-age=0", "content-type": "application/json" },
          status: 401,
        });
      }
      throw new Error(`unexpected_url:${url}`);
    });

    await expect(smokeRollbackCanary({
      apiBaseUrl: "https://api.selinow.com/",
      dashboardUrl: "https://app.selinow.com/login",
      fetcher,
      marketingUrl: "https://selinow.com/solutions",
      storefrontUrl: "https://pilot.selinow.com/",
      webhookPublicId: "ddowh_00000000-0000-4000-8000-000000000001",
    })).resolves.toEqual({
      checks: ["health", "dashboard", "marketing", "llms", "storefront", "dodo_unsigned_webhook"],
      status: "passed",
    });
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(fetcher.mock.calls.map(([request]) => requestUrl(request))).toEqual([
      "https://api.selinow.com/api/health",
      "https://app.selinow.com/login",
      "https://selinow.com/solutions",
      "https://selinow.com/llms.txt",
      "https://pilot.selinow.com/",
      "https://api.selinow.com/api/webhooks/billing/dodo/ddowh_00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("rejects a phase-6 rollback health response", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true, phase: 6 }), {
      headers: { "cache-control": "no-store", "content-type": "application/json" },
      status: 200,
    }));
    await expect(smokeRollbackCanary({
      apiBaseUrl: "https://api.selinow.com/",
      dashboardUrl: "https://app.selinow.com/login",
      fetcher,
      marketingUrl: "https://selinow.com/solutions",
      storefrontUrl: "https://pilot.selinow.com/",
      webhookPublicId: "ddowh_00000000-0000-4000-8000-000000000001",
    })).rejects.toThrow("production_rollback_health_contract_failed");
  });

  it("rejects production rollback admission when llms.txt is missing", async () => {
    const fetcher = vi.fn(async (request: string | URL | Request) => {
      const url = requestUrl(request);
      if (url.endsWith("/api/health")) return new Response(JSON.stringify({
        commerce: { channels: ["telegram", "website"], contract: "principal-channel-canonical-v1" },
        ok: true,
        phase: 10,
        release: { commerce: "provider_pending", platform: "deployed" },
        requestId: "rollback-health-request",
        service: "selinow.com",
      }), { headers: { "cache-control": "no-store", "content-type": "application/json" }, status: 200 });
      if (url.endsWith("/login")) return new Response("<html><main>Login</main></html>", { headers: { "content-type": "text/html", "x-robots-tag": "noindex" }, status: 200 });
      if (url.endsWith("/solutions")) return new Response("<html><main>Solutions</main></html>", { headers: { "content-type": "text/html" }, status: 200 });
      return new Response("Not found\n", { headers: { "content-type": "text/plain; charset=utf-8" }, status: 404 });
    });

    await expect(smokeRollbackCanary({
      fetcher,
      storefrontUrl: "https://pilot.selinow.com/",
      webhookPublicId: "ddowh_00000000-0000-4000-8000-000000000001",
    })).rejects.toThrow("production_rollback_llms_smoke_failed");
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
