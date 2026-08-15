/* eslint-disable @typescript-eslint/require-await */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildStagingDeploymentVersionMessage,
  collectStagingDeploymentEvidence,
  verifyStagingDeploymentEvidence,
  writeStagingDeploymentEvidence,
} from "../../scripts/lib/staging-deployment-evidence.mjs";
import {
  parseArguments,
  runStagingDeploymentEvidence,
} from "../../scripts/staging-deployment-evidence.mjs";

const RELEASE_ID = "stg_20260811T053816Z_92869a04a250";
const COMMIT_SHA = "9".repeat(40);
const TREE_SHA = "8".repeat(40);
const ACCOUNT_ID = "a".repeat(32);
const ZONE_ID = "b".repeat(32);
const WORKER_NAME = "selinow-com-staging";
const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const WORKER_VERSION = "22222222-2222-4222-8222-222222222222";
const DEPLOYED_AT = "2026-08-11T05:40:00.000Z";
const OBSERVED_AT = "2026-08-11T05:45:00.000Z";
const MANIFEST_REF = `.wrangler/releases/staging/${RELEASE_ID}/release-manifest.json`;
const EVIDENCE_REF = `.wrangler/releases/staging/${RELEASE_ID}/deployment-evidence.json`;
const roots: string[] = [];

type CollectOverrides = Record<string, unknown> & {
  percentage?: number;
  routes?: unknown[];
  triggerAuditOk?: boolean;
};

const manifest = {
  commitSha: COMMIT_SHA,
  createdAt: "2026-08-11T05:38:16.000Z",
  environment: "staging",
  expiresAt: "2026-08-12T05:38:16.000Z",
  releaseId: RELEASE_ID,
  schemaVersion: 3,
  treeSha: TREE_SHA,
};

const spec = {
  accountId: ACCOUNT_ID,
  environment: "staging",
  stagingRouteExceptions: [
    "staging.selinow.com/*",
    "app-staging.selinow.com/*",
    "api-staging.selinow.com/*",
    "*.staging.selinow.com/*",
  ],
  workerName: WORKER_NAME,
  zoneId: ZONE_ID,
};

const triggerContract = {
  accountId: ACCOUNT_ID,
  consumers: [{ queue: "selinow-integration-staging", script: WORKER_NAME, settings: { batchSize: 10 } }],
  environment: "staging",
  schedules: ["* * * * *"],
  workerName: WORKER_NAME,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "selinow-staging-deployment-"));
  roots.push(root);
  const manifestPath = join(root, MANIFEST_REF);
  await mkdir(join(manifestPath, ".."), { recursive: true, mode: 0o700 });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { manifestPath, root };
}

function releaseAdmission() {
  return {
    commitSha: COMMIT_SHA,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    releaseId: RELEASE_ID,
    treeSha: TREE_SHA,
  };
}

function cloudflareResult(path: string, manifestSha256: string, percentage = 100) {
  if (path.endsWith("/deployments")) return {
    deployments: [{
      created_on: DEPLOYED_AT,
      id: DEPLOYMENT_ID,
      versions: [{ percentage, version_id: WORKER_VERSION }],
    }],
  };
  if (path.includes("/versions?deployable=true")) return {
    items: [{
      annotations: {
        "workers/message": buildStagingDeploymentVersionMessage({
          manifest,
          manifestRef: MANIFEST_REF,
          manifestSha256,
        }),
      },
      id: WORKER_VERSION,
    }],
  };
  if (path.endsWith("/workers/routes")) return spec.stagingRouteExceptions.map((pattern, index) => ({
    id: String(index + 1),
    pattern,
    script: WORKER_NAME,
  }));
  throw new Error(`unexpected_cloudflare_path:${path}`);
}

async function collect(root: string, overrides: CollectOverrides = {}) {
  const manifestBytes = await readFile(join(root, MANIFEST_REF));
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const requests: Array<{ method: string; path: string }> = [];
  const result = await collectStagingDeploymentEvidence({
    assertStagingReleaseAdmissionImplementation: vi.fn(async () => releaseAdmission()),
    auditTriggerInventoryImplementation: vi.fn(() => ({
      checks: [{ code: "ok", ok: overrides.triggerAuditOk !== false }],
      ok: overrides.triggerAuditOk !== false,
    })),
    cloudflareApiRequestImplementation: vi.fn(async (_token: string, path: string, options?: { method?: string }) => {
      requests.push({ method: options?.method ?? "GET", path });
      if (path.endsWith("/workers/routes") && overrides.routes !== undefined) return overrides.routes;
      return cloudflareResult(path, manifestSha256, overrides.percentage);
    }),
    discoverTriggerInventoryImplementation: vi.fn(async () => ({
      accountId: ACCOUNT_ID,
      environment: "staging",
      observedAt: OBSERVED_AT,
      queueConsumers: [],
      schedules: ["* * * * *"],
      workerName: WORKER_NAME,
    })),
    environment: {
      CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: "route-read-token",
      CLOUDFLARE_STAGING_DEPLOYMENT_AUDIT_API_TOKEN: "deployment-read-token",
      CLOUDFLARE_STAGING_TRIGGER_AUDIT_API_TOKEN: "trigger-read-token",
    },
    loadStagingSpecImplementation: vi.fn(async () => spec),
    loadTriggerContractImplementation: vi.fn(async () => triggerContract),
    manifestPath: join(root, MANIFEST_REF),
    now: new Date(OBSERVED_AT),
    repositoryRoot: root,
    ...overrides,
  });
  return { ...result, requests };
}

describe("staging deployment evidence", () => {
  it("builds a manifest-bound Cloudflare version message without artifact self-reference", () => {
    const message = JSON.parse(buildStagingDeploymentVersionMessage({
      manifest,
      manifestRef: MANIFEST_REF,
      manifestSha256: "f".repeat(64),
    })) as Record<string, unknown>;
    expect(message).toEqual({
      commitSha: COMMIT_SHA,
      manifestRef: MANIFEST_REF,
      manifestSha256: "f".repeat(64),
      releaseId: RELEASE_ID,
      role: "staging_candidate",
      treeSha: TREE_SHA,
    });
    expect(JSON.stringify(message)).not.toContain("deployment-evidence.json");
  });

  it("collects only read-only observed inventory, writes mode-0600, and verifies the canonical artifact", async () => {
    const { root } = await fixture();
    const { artifact, artifactSha256, evidenceRef, requests } = await collect(root);
    expect(artifact).toMatchObject({
      cloudflare: {
        accountId: ACCOUNT_ID,
        deployedAt: DEPLOYED_AT,
        deploymentId: DEPLOYMENT_ID,
        percentage: 100,
        workerName: WORKER_NAME,
        workerVersion: WORKER_VERSION,
      },
      environment: "staging",
      mode: "staging_worker_deployment_binding",
      observedAt: OBSERVED_AT,
      release: {
        commitSha: COMMIT_SHA,
        manifestRef: MANIFEST_REF,
        releaseId: RELEASE_ID,
        treeSha: TREE_SHA,
      },
      schemaVersion: 1,
    });
    expect(artifact.inventory.routeInventorySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(artifact.inventory.triggerInventorySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(artifactSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidenceRef).toBe(EVIDENCE_REF);
    expect(requests).toHaveLength(3);
    expect(requests.every(({ method }) => method === "GET")).toBe(true);

    const written = await writeStagingDeploymentEvidence({ artifact, repositoryRoot: root });
    expect(written.evidenceRef).toBe(EVIDENCE_REF);
    expect((await lstat(join(root, EVIDENCE_REF))).mode & 0o077).toBe(0);
    await expect(verifyStagingDeploymentEvidence({
      assertStagingReleaseAdmissionImplementation: vi.fn(async () => releaseAdmission()),
      collectStagingDeploymentEvidenceImplementation: vi.fn(async () => ({ artifact })),
      evidencePath: join(root, EVIDENCE_REF),
      loadStagingSpecImplementation: vi.fn(async () => spec),
      manifestPath: join(root, MANIFEST_REF),
      now: new Date("2026-08-11T06:00:00.000Z"),
      repositoryRoot: root,
    })).resolves.toMatchObject({
      artifactSha256: written.artifactSha256,
      deploymentId: DEPLOYMENT_ID,
      remoteObservedAt: OBSERVED_AT,
      workerVersion: WORKER_VERSION,
    });
  });

  it("rejects claimed-versus-observed deployment mismatches and non-100-percent deployments", async () => {
    const { root } = await fixture();
    await expect(collect(root, {
      expectedDeployment: { deploymentId: "33333333-3333-4333-8333-333333333333", workerVersion: WORKER_VERSION },
    })).rejects.toThrow("staging_deployment_claim_mismatch");
    await expect(collect(root, { percentage: 50 })).rejects.toThrow("staging_deployment_inventory_invalid");
  });

  it("rejects route or trigger inventory drift before creating evidence", async () => {
    const { root } = await fixture();
    await expect(collect(root, { routes: [] })).rejects.toThrow("staging_deployment_route_inventory_mismatch");
    await expect(collect(root, { triggerAuditOk: false })).rejects.toThrow("staging_deployment_trigger_inventory_mismatch");
  });

  it("rejects stale evidence and noncanonical evidence paths", async () => {
    const { root } = await fixture();
    const { artifact } = await collect(root);
    await writeStagingDeploymentEvidence({ artifact, repositoryRoot: root });
    await expect(verifyStagingDeploymentEvidence({
      assertStagingReleaseAdmissionImplementation: vi.fn(async () => releaseAdmission()),
      evidencePath: join(root, EVIDENCE_REF),
      loadStagingSpecImplementation: vi.fn(async () => spec),
      manifestPath: join(root, MANIFEST_REF),
      now: new Date("2026-08-11T08:00:00.001Z"),
      repositoryRoot: root,
    })).rejects.toThrow("staging_deployment_evidence_stale");

    const copied = join(root, "copied-deployment-evidence.json");
    await writeFile(copied, await readFile(join(root, EVIDENCE_REF)), { mode: 0o600 });
    await expect(verifyStagingDeploymentEvidence({
      assertStagingReleaseAdmissionImplementation: vi.fn(async () => releaseAdmission()),
      evidencePath: copied,
      loadStagingSpecImplementation: vi.fn(async () => spec),
      manifestPath: join(root, MANIFEST_REF),
      now: new Date("2026-08-11T06:00:00.000Z"),
      repositoryRoot: root,
    })).rejects.toThrow("staging_deployment_evidence_path_noncanonical");
  });

  it("rejects artifact binding after the manifest bytes change", async () => {
    const { root } = await fixture();
    const { artifact } = await collect(root);
    await writeStagingDeploymentEvidence({ artifact, repositoryRoot: root });
    await writeFile(join(root, MANIFEST_REF), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    await expect(verifyStagingDeploymentEvidence({
      assertStagingReleaseAdmissionImplementation: vi.fn(async () => releaseAdmission()),
      evidencePath: join(root, EVIDENCE_REF),
      loadStagingSpecImplementation: vi.fn(async () => spec),
      manifestPath: join(root, MANIFEST_REF),
      now: new Date("2026-08-11T06:00:00.000Z"),
      repositoryRoot: root,
    })).rejects.toThrow("staging_deployment_evidence_binding_mismatch");
  });

  it("rejects a forged self-consistent artifact that disagrees with fresh live inventory", async () => {
    const { root } = await fixture();
    const { artifact: observedArtifact } = await collect(root);
    const forgedArtifact = {
      ...observedArtifact,
      cloudflare: {
        ...observedArtifact.cloudflare,
        deploymentId: "33333333-3333-4333-8333-333333333333",
        workerVersion: "44444444-4444-4444-8444-444444444444",
      },
    };
    await writeStagingDeploymentEvidence({ artifact: forgedArtifact, repositoryRoot: root });
    await expect(verifyStagingDeploymentEvidence({
      assertStagingReleaseAdmissionImplementation: vi.fn(async () => releaseAdmission()),
      collectStagingDeploymentEvidenceImplementation: vi.fn(async () => ({ artifact: observedArtifact })),
      evidencePath: join(root, EVIDENCE_REF),
      loadStagingSpecImplementation: vi.fn(async () => spec),
      manifestPath: join(root, MANIFEST_REF),
      now: new Date("2026-08-11T06:00:00.000Z"),
      repositoryRoot: root,
    })).rejects.toThrow("staging_deployment_evidence_observed_mismatch");
  });

  it("fails closed when fresh Cloudflare observation is unavailable", async () => {
    const { root } = await fixture();
    const { artifact } = await collect(root);
    await writeStagingDeploymentEvidence({ artifact, repositoryRoot: root });
    await expect(verifyStagingDeploymentEvidence({
      assertStagingReleaseAdmissionImplementation: vi.fn(async () => releaseAdmission()),
      collectStagingDeploymentEvidenceImplementation: vi.fn(async () => {
        throw new Error("cloudflare_api_unavailable");
      }),
      evidencePath: join(root, EVIDENCE_REF),
      loadStagingSpecImplementation: vi.fn(async () => spec),
      manifestPath: join(root, MANIFEST_REF),
      now: new Date("2026-08-11T06:00:00.000Z"),
      repositoryRoot: root,
    })).rejects.toThrow("staging_deployment_remote_observation_failed");
  });

  it("rejects a symlinked canonical ancestor and relaxed artifact permissions", async () => {
    const { root } = await fixture();
    const { artifact } = await collect(root);
    await writeStagingDeploymentEvidence({ artifact, repositoryRoot: root });
    await chmod(join(root, EVIDENCE_REF), 0o644);
    await expect(verifyStagingDeploymentEvidence({
      assertStagingReleaseAdmissionImplementation: vi.fn(async () => releaseAdmission()),
      evidencePath: join(root, EVIDENCE_REF),
      loadStagingSpecImplementation: vi.fn(async () => spec),
      manifestPath: join(root, MANIFEST_REF),
      now: new Date("2026-08-11T06:00:00.000Z"),
      repositoryRoot: root,
    })).rejects.toThrow("staging_deployment_evidence_permissions_invalid");

    const symlinkRoot = await mkdtemp(join(tmpdir(), "selinow-staging-deployment-symlink-"));
    roots.push(symlinkRoot);
    const target = join(symlinkRoot, "target");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "deployment-evidence.json"), `${JSON.stringify(artifact)}\n`, { mode: 0o600 });
    await mkdir(join(symlinkRoot, ".wrangler/releases/staging"), { recursive: true });
    await symlink(target, join(symlinkRoot, `.wrangler/releases/staging/${RELEASE_ID}`));
    await expect(verifyStagingDeploymentEvidence({
      assertStagingReleaseAdmissionImplementation: vi.fn(async () => releaseAdmission()),
      evidencePath: join(symlinkRoot, EVIDENCE_REF),
      loadStagingSpecImplementation: vi.fn(async () => spec),
      manifestPath: join(root, MANIFEST_REF),
      now: new Date("2026-08-11T06:00:00.000Z"),
      repositoryRoot: symlinkRoot,
    })).rejects.toThrow("staging_deployment_evidence_symlink_invalid");
  });

  it("wires the staging deploy sink to a manifest-hash provenance message", async () => {
    const source = await readFile(join(process.cwd(), "scripts/deploy.mjs"), "utf8");
    expect(source).toContain("buildStagingDeploymentVersionMessage");
    expect(source).toContain('deployArgs.push("--message", stagingVersionMessage)');
  });

  it("keeps CLI validation read-only unless immutable artifact writing is explicit", async () => {
    expect(() => parseArguments([])).toThrow("staging_deployment_manifest_required");
    const options = parseArguments(["--manifest", MANIFEST_REF, "--json"]);
    expect(options).toMatchObject({ json: true, write: false });
    const collector = vi.fn(async () => ({
      artifact: {
        cloudflare: { deploymentId: DEPLOYMENT_ID, workerVersion: WORKER_VERSION },
      },
      artifactSha256: "f".repeat(64),
      evidenceRef: EVIDENCE_REF,
    }));
    const writer = vi.fn();
    await expect(runStagingDeploymentEvidence(options, {
      collectStagingDeploymentEvidenceImplementation: collector,
      writeStagingDeploymentEvidenceImplementation: writer,
    })).resolves.toMatchObject({ mode: "validated", ok: true });
    expect(writer).not.toHaveBeenCalled();

    writer.mockResolvedValue({ artifactSha256: "e".repeat(64), evidenceRef: EVIDENCE_REF });
    await expect(runStagingDeploymentEvidence({ ...options, write: true }, {
      collectStagingDeploymentEvidenceImplementation: collector,
      writeStagingDeploymentEvidenceImplementation: writer,
    })).resolves.toMatchObject({ artifactSha256: "e".repeat(64), mode: "written", ok: true });
    expect(writer).toHaveBeenCalledOnce();
  });
});
