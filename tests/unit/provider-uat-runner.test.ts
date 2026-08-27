import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runProviderUatScenario } from "../../scripts/lib/provider-uat-runner.mjs";

const roots: string[] = [];
const NOW = "2026-08-26T10:00:00.000Z";
const WORKER_VERSION = "11111111-1111-4111-8111-111111111111";

function contextFiles(root: string) {
  const paths = Object.fromEntries(["d1", "auth", "dodo", "payos"].map((name) => {
    const path = join(root, `${name}-context.json`);
    writeFileSync(path, "{\"opaque\":true}\n", { mode: 0o600 });
    return [name, path];
  }));
  return paths as Record<string, string>;
}

function fixture({ manual = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "selinow-provider-uat-runner-"));
  roots.push(root);
  const releaseId = "stg_20260826T100000Z_aaaaaaaaaaaa";
  const staging = join(root, ".wrangler", "releases", "staging", releaseId);
  mkdirSync(staging, { recursive: true });
  const executor = join(root, "provider-executor.mjs");
  const executorSource = manual
    ? "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({accepted:true,passed:true}));\n"
    : `#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const input = JSON.parse(await new Promise((resolve) => { let value = ""; process.stdin.on("data", (chunk) => { value += chunk; }); process.stdin.on("end", () => resolve(value)); }));
const artifactRef = "artifact:.wrangler/releases/staging/" + input.release.releaseId + "/dodo-uat-execution-proofs/plan_catalog_offers.json";
const fingerprints = {
  d1BeforeSha256: "b".repeat(64),
  d1AfterSha256: "b".repeat(64),
  d1TransitionSha256: "c".repeat(64),
  executionTranscriptSha256: "d".repeat(64),
  providerEventSha256: null,
  providerSignatureSha256: null,
};
const artifact = { provider: input.provider, scenarioId: input.scenarioId, environment: "staging", release: input.release, fingerprints, attestation: { algorithm: "ed25519", signatureBase64: "a".repeat(96) } };
const artifactBytes = JSON.stringify(artifact) + "\\n";
const artifactPath = join(process.cwd(), artifactRef.slice("artifact:".length));
mkdirSync(join(process.cwd(), ".wrangler", "releases", "staging", input.release.releaseId, "dodo-uat-execution-proofs"), { recursive: true, mode: 0o700 });
writeFileSync(artifactPath, artifactBytes, { mode: 0o600 });
const hash = createHash("sha256").update(artifactBytes).digest("hex");
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  artifactRef,
  artifactSha256: hash,
  authority: "dodo_test_api",
  d1BeforeSha256: fingerprints.d1BeforeSha256,
  d1AfterSha256: fingerprints.d1AfterSha256,
  d1TransitionSha256: fingerprints.d1TransitionSha256,
  executionTranscriptSha256: fingerprints.executionTranscriptSha256,
  observedAt: "${NOW}",
  provider: input.provider,
  providerEventSha256: fingerprints.providerEventSha256,
  providerSignatureSha256: fingerprints.providerSignatureSha256,
  release: input.release,
  scenarioId: input.scenarioId,
}));
`;
  writeFileSync(executor, executorSource, { mode: 0o700 });
  chmodSync(executor, 0o700);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "uat-runner-test@selinow.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Selinow UAT Runner Test"], { cwd: root });
  writeFileSync(join(root, ".gitignore"), ".wrangler/\n*-context.json\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "runner fixture"], { cwd: root });
  const commitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const treeSha = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim();
  const manifestPath = join(staging, "release-manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    commitSha,
    createdAt: NOW,
    environment: "staging",
    expiresAt: "2026-08-27T10:00:00.000Z",
    releaseId,
    schemaVersion: 3,
    treeSha,
  }) + "\n", { mode: 0o600 });
  expect(readFileSync(manifestPath, "utf8")).toContain(commitSha);
  return { contexts: contextFiles(root), executor, manifestPath, releaseId, root };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("provider UAT runner", () => {
  it("executes only an exact candidate-bound provider receipt and keeps acceptance false", async () => {
    const test = fixture();
    const result = await runProviderUatScenario({
      environment: {
        SELINOW_UAT_AUTH_CONTEXT_PATH: test.contexts.auth,
        SELINOW_UAT_D1_CONTEXT_PATH: test.contexts.d1,
        SELINOW_UAT_DODO_CONTEXT_PATH: test.contexts.dodo,
      },
      executor: test.executor,
      manifestPath: test.manifestPath,
      provider: "dodo",
      repositoryRoot: test.root,
      scenarioId: "plan_catalog_offers",
      verifyStagingDeploymentEvidenceImplementation: () => Promise.resolve({ workerVersion: WORKER_VERSION }),
    });

    expect(result.accepted).toBe(false);
    expect(result.releaseId).toBe(test.releaseId);
    expect(result.receiptRef).toContain("provider-dodo-plan_catalog_offers.receipt.json");
    expect(result.next).toContain("dodo-uat-collect");
  });

  it("fails closed when prerequisites are absent", async () => {
    const test = fixture();
    await expect(runProviderUatScenario({
      environment: {},
      executor: test.executor,
      manifestPath: test.manifestPath,
      provider: "dodo",
      repositoryRoot: test.root,
      scenarioId: "plan_catalog_offers",
      verifyStagingDeploymentEvidenceImplementation: () => Promise.resolve({ workerVersion: WORKER_VERSION }),
    })).rejects.toThrow("provider_uat_runner_prerequisite_missing");
  });

  it("rejects operator-authored accepted/passed booleans", async () => {
    const test = fixture({ manual: true });
    await expect(runProviderUatScenario({
      environment: {
        SELINOW_UAT_AUTH_CONTEXT_PATH: test.contexts.auth,
        SELINOW_UAT_D1_CONTEXT_PATH: test.contexts.d1,
        SELINOW_UAT_DODO_CONTEXT_PATH: test.contexts.dodo,
      },
      executor: test.executor,
      manifestPath: test.manifestPath,
      provider: "dodo",
      repositoryRoot: test.root,
      scenarioId: "plan_catalog_offers",
      verifyStagingDeploymentEvidenceImplementation: () => Promise.resolve({ workerVersion: WORKER_VERSION }),
    })).rejects.toThrow("provider_uat_runner_receipt_invalid");
  });
});
