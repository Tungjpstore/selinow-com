import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import {
  buildProductionRollbackRehearsalArtifact,
  listMigrationNames,
  readOptionalJson,
  validateProductionRollbackArtifact,
  writeProductionRollbackRehearsalArtifact,
} from "./lib/release.mjs";
import { run, runWrangler } from "./lib/cli.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const WEBHOOK_PUBLIC_ID_PATTERN = /^(?:ddowh|dodow)_[0-9a-f-]{36}$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,160}$/u;
const MAX_SMOKE_BODY_BYTES = 256 * 1024;
const MAX_DRAIN_EVIDENCE_AGE_MS = 15 * 60_000;

export function parseArguments(argv) {
  const options = {
    confirmMaintenanceDrain: false,
    confirmProduction: false,
    evidencePath: resolve(repositoryRoot, ".wrangler/release/production-evidence.json"),
    execute: false,
    json: false,
    maintenanceDrainEvidencePath: null,
    smokeStorefrontUrl: null,
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--json") options.json = true;
    else if (argument === "--write") options.write = true;
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--confirm-production") options.confirmProduction = true;
    else if (argument === "--confirm-maintenance-drain") options.confirmMaintenanceDrain = true;
    else if (argument === "--maintenance-drain-evidence") options.maintenanceDrainEvidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--smoke-storefront-url") options.smokeStorefrontUrl = argv[++index] ?? "";
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (options.execute && options.write) throw new Error("production_rollback_rehearsal_mode_conflict");
  if (options.execute && !options.confirmProduction) throw new Error("production_confirmation_required");
  if (options.execute && !options.confirmMaintenanceDrain) throw new Error("maintenance_drain_confirmation_required");
  if (options.execute && options.maintenanceDrainEvidencePath === null) throw new Error("maintenance_drain_evidence_required");
  if (options.execute && options.smokeStorefrontUrl === null) throw new Error("rollback_smoke_storefront_url_required");
  if (options.execute) assertSafeSmokeStorefrontUrl(options.smokeStorefrontUrl);
  return options;
}

function assertSafeSmokeStorefrontUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("rollback_smoke_storefront_url_invalid");
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash
    || url.username || url.password || !hostname.includes(".")
    || hostname === "localhost" || /^\d+(?:\.\d+){3}$/u.test(hostname)
    || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) {
    throw new Error("rollback_smoke_storefront_url_invalid");
  }
  return url.toString();
}

async function boundedResponseText(response, code) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_SMOKE_BODY_BYTES) throw new Error(code);
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > MAX_SMOKE_BODY_BYTES) throw new Error(code);
  return body;
}

function requireNoStore(response, code) {
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  if (!cacheControl.includes("no-store")) throw new Error(code);
}

function requireHtml(response, body, code) {
  if (response.status !== 200 || response.redirected
    || !response.headers.get("content-type")?.toLowerCase().includes("text/html")
    || !body.toLowerCase().includes("<html")) throw new Error(code);
}

export async function smokeRollbackCanary({
  apiBaseUrl = "https://api.selinow.com/",
  dashboardUrl = "https://app.selinow.com/login",
  fetcher = globalThis.fetch,
  marketingUrl = "https://selinow.com/solutions",
  storefrontUrl,
  webhookPublicId,
} = {}) {
  if (typeof fetcher !== "function" || !WEBHOOK_PUBLIC_ID_PATTERN.test(webhookPublicId ?? "")) {
    throw new Error("production_rollback_smoke_contract_invalid");
  }
  const storefront = assertSafeSmokeStorefrontUrl(storefrontUrl);
  const apiBase = new URL(apiBaseUrl);
  const dashboard = new URL(dashboardUrl);
  const marketing = new URL(marketingUrl);
  if (apiBase.protocol !== "https:" || apiBase.pathname !== "/" || apiBase.search || apiBase.hash
    || dashboard.protocol !== "https:" || dashboard.search || dashboard.hash
    || marketing.protocol !== "https:" || marketing.search || marketing.hash) {
    throw new Error("production_rollback_smoke_contract_invalid");
  }

  const healthResponse = await fetcher(new URL("api/health", apiBase), {
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  const healthBody = await boundedResponseText(healthResponse, "production_rollback_health_contract_failed");
  let health;
  try {
    health = JSON.parse(healthBody);
  } catch {
    throw new Error("production_rollback_health_contract_failed");
  }
  requireNoStore(healthResponse, "production_rollback_health_contract_failed");
  if (healthResponse.status !== 200 || healthResponse.redirected || health?.ok !== true
    || health?.service !== "selinow.com" || health?.phase !== 10
    || health?.release?.platform !== "deployed" || health?.release?.commerce !== "provider_pending"
    || health?.commerce?.contract !== "principal-channel-canonical-v1"
    || JSON.stringify(health?.commerce?.channels) !== JSON.stringify(["telegram", "website"])
    || !REQUEST_ID_PATTERN.test(health?.requestId ?? "")) {
    throw new Error("production_rollback_health_contract_failed");
  }

  const dashboardResponse = await fetcher(dashboard, {
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  const dashboardBody = await boundedResponseText(dashboardResponse, "production_rollback_dashboard_smoke_failed");
  requireHtml(dashboardResponse, dashboardBody, "production_rollback_dashboard_smoke_failed");
  if (!(dashboardResponse.headers.get("x-robots-tag") ?? "").toLowerCase().includes("noindex")) {
    throw new Error("production_rollback_dashboard_smoke_failed");
  }

  const marketingResponse = await fetcher(marketing, {
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  requireHtml(
    marketingResponse,
    await boundedResponseText(marketingResponse, "production_rollback_marketing_smoke_failed"),
    "production_rollback_marketing_smoke_failed",
  );

  const storefrontResponse = await fetcher(storefront, {
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  const storefrontBody = await boundedResponseText(storefrontResponse, "production_rollback_storefront_smoke_failed");
  requireHtml(storefrontResponse, storefrontBody, "production_rollback_storefront_smoke_failed");
  if (!storefrontBody.includes("data-storefront-surface")) {
    throw new Error("production_rollback_storefront_smoke_failed");
  }

  const webhookResponse = await fetcher(new URL(`api/webhooks/billing/dodo/${webhookPublicId}`, apiBase), {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
    redirect: "manual",
    signal: globalThis.AbortSignal.timeout(15_000),
  });
  const webhookBody = await boundedResponseText(webhookResponse, "production_rollback_dodo_webhook_smoke_failed");
  let webhook;
  try {
    webhook = JSON.parse(webhookBody);
  } catch {
    throw new Error("production_rollback_dodo_webhook_smoke_failed");
  }
  requireNoStore(webhookResponse, "production_rollback_dodo_webhook_smoke_failed");
  if (webhookResponse.status !== 401 || webhookResponse.redirected || webhook?.ok !== false
    || webhook?.code !== "webhook_signature_invalid" || !REQUEST_ID_PATTERN.test(webhook?.requestId ?? "")) {
    throw new Error("production_rollback_dodo_webhook_smoke_failed");
  }

  return {
    checks: ["health", "dashboard", "marketing", "storefront", "dodo_unsigned_webhook"],
    status: "passed",
  };
}

export async function verifyMaintenanceDrainEvidence({
  evidence,
  evidencePath,
  now = new Date(),
  repositoryRoot: root = repositoryRoot,
}) {
  const expectedPath = resolve(
    root,
    ".wrangler",
    "releases",
    evidence?.releaseId ?? "",
    "maintenance-drain-evidence.json",
  );
  if (typeof evidencePath !== "string" || resolve(evidencePath) !== expectedPath) {
    throw new Error("maintenance_drain_evidence_ref_invalid");
  }
  let stat;
  let artifact;
  try {
    stat = await lstat(evidencePath);
    artifact = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch {
    throw new Error("maintenance_drain_evidence_invalid");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error("maintenance_drain_evidence_permissions_invalid");
  }
  const observedAt = Date.parse(artifact?.observedAt ?? "");
  const age = now.getTime() - observedAt;
  const states = artifact?.states;
  const stateKeys = states && typeof states === "object" && !Array.isArray(states)
    ? Object.keys(states).sort()
    : [];
  const keys = artifact && typeof artifact === "object" && !Array.isArray(artifact)
    ? Object.keys(artifact).sort()
    : [];
  if (JSON.stringify(keys) !== JSON.stringify([
    "commitSha", "environment", "mode", "observedAt", "previousWorkerVersion", "releaseId", "schemaVersion", "states", "treeSha",
  ]) || artifact.schemaVersion !== 1 || artifact.mode !== "production_maintenance_drain"
    || artifact.environment !== "production" || artifact.releaseId !== evidence?.releaseId
    || artifact.commitSha !== evidence?.commitSha || artifact.treeSha !== evidence?.treeSha
    || artifact.previousWorkerVersion !== evidence?.previousWorkerVersion
    || !Number.isFinite(observedAt) || age < 0 || age > MAX_DRAIN_EVIDENCE_AGE_MS
    || JSON.stringify(stateKeys) !== JSON.stringify([
      "inFlightJobsDrained", "queueProducersPaused", "scheduledWorkPaused", "writeAdmissionClosed",
    ])
    || stateKeys.some((key) => states[key] !== true)) {
    throw new Error("maintenance_drain_evidence_invalid");
  }
  return { observedAt: artifact.observedAt };
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("production_rollback_active_version_invalid");
  }
}

function activeVersionFromDeployments(payload) {
  const deployments = Array.isArray(payload) ? payload : payload?.deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("production_rollback_active_version_invalid");
  }
  const first = [...deployments].sort((left, right) => (
    Date.parse(right?.created_on ?? right?.createdOn ?? "")
    - Date.parse(left?.created_on ?? left?.createdOn ?? "")
  ))[0];
  const version = first?.versionId
    ?? (Array.isArray(first?.versions) && first.versions.length === 1 && first.versions[0]?.percentage === 100
      ? first.versions[0]?.version_id
      : null);
  if (typeof version !== "string" || !UUID_PATTERN.test(version)) {
    throw new Error("production_rollback_active_version_invalid");
  }
  return version;
}

function defaultOperations({
  apiBaseUrl = "https://api.selinow.com/",
  commandEnvironment = process.env,
  dashboardUrl = "https://app.selinow.com/login",
  evidence,
  maintenanceDrainEvidencePath,
  marketingUrl = "https://selinow.com/solutions",
  now,
  repositoryRoot: root = repositoryRoot,
  smokeStorefrontUrl,
} = {}) {
  const deploy = async (version, role) => {
    runWrangler([
      "versions", "deploy", `${version}@100%`, "--env", "production", "--yes",
      "--message", `rollback rehearsal ${role} ${version}`,
    ], { cwd: root, env: commandEnvironment });
  };
  const active = async () => activeVersionFromDeployments(parseJsonOutput(runWrangler(
    ["deployments", "list", "--env", "production", "--json"],
    { cwd: root, env: commandEnvironment },
  ).stdout));
  return {
    deployWorkerVersion: deploy,
    getActiveWorkerVersion: active,
    restoreWorkerVersion: (version) => deploy(version, "restore"),
    smokeCanary: async () => {
      let config;
      try {
        config = JSON.parse(await readFile(resolve(root, "wrangler.jsonc"), "utf8"));
      } catch {
        throw new Error("production_rollback_smoke_contract_invalid");
      }
      return smokeRollbackCanary({
        apiBaseUrl,
        dashboardUrl,
        marketingUrl,
        storefrontUrl: smokeStorefrontUrl,
        webhookPublicId: config?.env?.production?.vars?.DODO_PAYMENTS_WEBHOOK_PUBLIC_ID,
      });
    },
    verifyMaintenanceDrain: () => verifyMaintenanceDrainEvidence({
      evidence,
      evidencePath: maintenanceDrainEvidencePath,
      now: now instanceof Date ? now : new Date(),
      repositoryRoot: root,
    }),
    verifyActiveWorkerVersion: active,
  };
}

function authorizingArtifact(input, completedAt) {
  const artifact = buildProductionRollbackRehearsalArtifact({ ...input, now: new Date(completedAt) });
  artifact.rehearsal = {
    authorizesProductionAdmission: true,
    completedAt,
    kind: "live_rollback_rehearsal",
    result: "passed",
  };
  return artifact;
}

function assertRepositorySourceBinding(evidence, root) {
  const git = (args) => run("git", args, { cwd: root }).stdout.trim();
  let commitSha;
  let treeSha;
  let status;
  let rollbackCommitSha;
  let rollbackTreeSha;
  try {
    commitSha = git(["rev-parse", "--verify", "HEAD^{commit}"]);
    treeSha = git(["rev-parse", "--verify", "HEAD^{tree}"]);
    status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
    rollbackCommitSha = git(["rev-parse", "--verify", `${evidence.rollback.candidate.commitSha}^{commit}`]);
    rollbackTreeSha = git(["rev-parse", "--verify", `${evidence.rollback.candidate.commitSha}^{tree}`]);
  } catch (error) {
    throw new Error("production_rollback_rehearsal_source_unavailable", { cause: error });
  }
  if (status !== "" || commitSha !== evidence.commitSha || treeSha !== evidence.treeSha) {
    throw new Error("production_rollback_rehearsal_source_mismatch");
  }
  if (rollbackCommitSha !== evidence.rollback.candidate.commitSha
    || rollbackTreeSha !== evidence.rollback.candidate.treeSha) {
    throw new Error("production_rollback_rehearsal_rollback_source_invalid");
  }
}

async function writeAuthorizingArtifact({ artifact, evidence, migrationNames, repositoryRoot: root }) {
  const evidenceRef = `.wrangler/releases/${evidence.releaseId}/rollback-rehearsal.json`;
  const artifactPath = resolve(root, evidenceRef);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  const rollback = evidence.rollback;
  rollback.rehearsedAt = artifact.rehearsal.completedAt;
  rollback.candidate.rehearsedAt = artifact.rehearsal.completedAt;
  rollback.candidate.evidenceRef = evidenceRef;
  rollback.candidate.artifactSha256 = artifactSha256;
  rollback.rehearsalEvidenceRef = evidenceRef;

  const directory = dirname(artifactPath);
  const temporaryPath = `${artifactPath}.tmp-${process.pid}`;
  const backupPath = `${artifactPath}.bak-${process.pid}`;
  await mkdir(directory, { mode: 0o700, recursive: true });
  await writeFile(temporaryPath, bytes, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  let hadPrevious = false;
  try {
    if (existsSync(artifactPath)) {
      await rename(artifactPath, backupPath);
      hadPrevious = true;
    }
    await rename(temporaryPath, artifactPath);
    validateProductionRollbackArtifact({ evidence, migrationNames, repositoryRoot: root });
    if (hadPrevious) await rm(backupPath, { force: true });
  } catch (error) {
    await rm(artifactPath, { force: true });
    if (hadPrevious) await rename(backupPath, artifactPath);
    throw error;
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { artifact, artifactSha256, evidenceRef };
}

export async function executeProductionRollbackRehearsal(input) {
  const evidence = input?.evidence;
  const migrationNames = input?.migrationNames;
  const root = input?.repositoryRoot ?? repositoryRoot;
  const operations = { ...defaultOperations(input), ...(input?.operations ?? {}) };
  if (typeof operations.getActiveWorkerVersion !== "function"
    || typeof operations.deployWorkerVersion !== "function"
    || typeof operations.restoreWorkerVersion !== "function"
    || typeof operations.verifyActiveWorkerVersion !== "function"
    || typeof operations.verifyMaintenanceDrain !== "function"
    || typeof operations.smokeCanary !== "function") {
    throw new Error("production_rollback_rehearsal_operations_missing");
  }
  const previousVersion = evidence?.previousWorkerVersion;
  const rollbackVersion = evidence?.rollback?.candidate?.workerVersion;
  if (!UUID_PATTERN.test(previousVersion ?? "") || !UUID_PATTERN.test(rollbackVersion ?? "")
    || previousVersion === rollbackVersion) {
    throw new Error("production_rollback_rehearsal_input_invalid");
  }
  // Fail before any live mutation if the schema/source-bound compatibility contract is invalid.
  buildProductionRollbackRehearsalArtifact({ evidence, migrationNames, now: input?.now });
  const sourceAdmission = input?.assertSourceBindingImplementation ?? assertRepositorySourceBinding;
  await sourceAdmission(evidence, root);
  await operations.verifyMaintenanceDrain();
  const current = await operations.getActiveWorkerVersion();
  if (current !== previousVersion) throw new Error("production_rollback_rehearsal_previous_not_active");

  let rollbackAttempted = false;
  let primaryError = null;
  let restoreError = null;
  let restored = false;
  try {
    rollbackAttempted = true;
    await operations.deployWorkerVersion(rollbackVersion, "rollback");
    const activeRollback = await operations.verifyActiveWorkerVersion();
    if (activeRollback !== rollbackVersion) throw new Error("production_rollback_rehearsal_rollback_not_active");
    await operations.smokeCanary({ url: input?.canaryUrl ?? "https://canary.selinow.com/", workerVersion: rollbackVersion });
  } catch (error) {
    primaryError = error;
  } finally {
    if (rollbackAttempted) {
      try {
        await operations.restoreWorkerVersion(previousVersion);
        const activeRestored = await operations.verifyActiveWorkerVersion();
        if (activeRestored !== previousVersion) {
          restoreError = new Error("production_rollback_rehearsal_restore_not_active");
        } else {
          restored = true;
        }
      } catch (error) {
        restoreError = error;
      }
    }
  }
  if (restoreError !== null) {
    throw new Error("production_rollback_rehearsal_restore_failed", { cause: restoreError });
  }
  if (primaryError !== null) throw primaryError;
  if (!restored) throw new Error("production_rollback_rehearsal_restore_failed");

  const completedAt = new Date(input?.now ?? Date.now()).toISOString();
  const artifact = authorizingArtifact({ evidence, migrationNames, repositoryRoot: root }, completedAt);
  const writer = input?.writeAuthorizingArtifact ?? writeAuthorizingArtifact;
  return writer({ artifact, evidence, migrationNames, repositoryRoot: root });
}

export async function runProductionRollbackRehearsal(options, dependencies = {}) {
  const evidence = await readOptionalJson(options.evidencePath);
  if (evidence === null) throw new Error("production_evidence_missing");
  const migrationNames = await listMigrationNames();
  const input = {
    evidence,
    maintenanceDrainEvidencePath: options.maintenanceDrainEvidencePath,
    migrationNames,
    now: new Date(),
    repositoryRoot,
    smokeStorefrontUrl: options.smokeStorefrontUrl,
    ...dependencies,
  };
  if (options.execute) {
    const result = await executeProductionRollbackRehearsal(input);
    return {
      authorizesProductionAdmission: true,
      artifactSha256: result.artifactSha256,
      environment: "production",
      evidenceRef: result.evidenceRef,
      mode: "live_rollback_rehearsal",
      ok: true,
    };
  }
  const artifact = buildProductionRollbackRehearsalArtifact(input);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const result = options.write
    ? await writeProductionRollbackRehearsalArtifact(input)
    : {
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      evidenceRef: `.wrangler/releases/${evidence.releaseId}/rollback-rehearsal.json`,
    };
  return {
    authorizesProductionAdmission: false,
    artifactSha256: result.artifactSha256,
    environment: "production",
    evidenceRef: result.evidenceRef,
    mode: "schema_compatibility_validation",
    ok: true,
  };
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const output = await runProductionRollbackRehearsal(options);
    process.stdout.write(options.json
      ? `${JSON.stringify(output, null, 2)}\n`
      : `PASS rollback ${output.mode} ${options.write ? "written" : "validated"}: ${output.evidenceRef}\n`);
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message)
      ? error.message
      : "production_rollback_rehearsal_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
