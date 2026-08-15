import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { cloudflareApiRequest, repositoryRoot } from "./platform.mjs";
import { assertStagingReleaseAdmission } from "./staging-release.mjs";
import { auditTriggerInventory, discoverTriggerInventory, loadTriggerContract } from "./trigger-inventory.mjs";

const RELEASE_ID_PATTERN = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const WORKER_NAME_PATTERN = /^selinow-com-[a-z0-9-]+$/u;
const MAX_EVIDENCE_AGE_MS = 2 * 60 * 60_000;

function exactKeys(value, expected, issue) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(issue);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(issue);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function artifactBytes(artifact) {
  return Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

function manifestRef(releaseId) {
  return `.wrangler/releases/staging/${releaseId}/release-manifest.json`;
}

function evidenceRef(releaseId) {
  return `.wrangler/releases/staging/${releaseId}/deployment-evidence.json`;
}

async function assertNoSymlinkAncestors(path, root, issue) {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  const rel = relative(absoluteRoot, absolutePath);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(issue);
  const segments = rel.split(sep);
  let current = absoluteRoot;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(issue);
    } catch (error) {
      if (error instanceof Error && error.message === issue) throw error;
      if (error?.code === "ENOENT") return;
      throw new Error(issue, { cause: error });
    }
  }
}

async function readPrivateJson(path, root, issues) {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  const rel = relative(absoluteRoot, absolutePath);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new Error(issues.symlink);
  }
  let handle;
  try {
    const canonicalRoot = await realpath(absoluteRoot);
    const canonicalPath = await realpath(absolutePath);
    const expectedCanonicalPath = resolve(canonicalRoot, rel);
    if (canonicalPath !== expectedCanonicalPath) throw new Error(issues.symlink);
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = await handle.stat({ bigint: true });
    const pathStat = await stat(absolutePath, { bigint: true });
    if (!openedStat.isFile()
      || (openedStat.mode & 0o077n) !== 0n
      || openedStat.dev !== pathStat.dev
      || openedStat.ino !== pathStat.ino
      || await realpath(absolutePath) !== canonicalPath) {
      throw new Error(issues.permissions);
    }
    const bytes = await handle.readFile();
    const closedOverStat = await handle.stat({ bigint: true });
    const finalPathStat = await stat(absolutePath, { bigint: true });
    if (openedStat.dev !== closedOverStat.dev
      || openedStat.ino !== closedOverStat.ino
      || openedStat.dev !== finalPathStat.dev
      || openedStat.ino !== finalPathStat.ino
      || openedStat.size !== closedOverStat.size
      || openedStat.mtimeNs !== closedOverStat.mtimeNs
      || openedStat.ctimeNs !== closedOverStat.ctimeNs
      || await realpath(absolutePath) !== canonicalPath) {
      throw new Error(issues.symlink);
    }
    try {
      return { bytes, value: JSON.parse(bytes.toString("utf8")) };
    } catch (error) {
      throw new Error(issues.invalid ?? issues.missing, { cause: error });
    }
  } catch (error) {
    if (error instanceof Error && Object.values(issues).includes(error.message)) throw error;
    if (error?.code === "ELOOP") throw new Error(issues.symlink, { cause: error });
    throw new Error(issues.missing, { cause: error });
  } finally {
    await handle?.close();
  }
}

async function loadManifestBundle(input, releaseIdHint = null) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const absoluteManifestPath = resolve(input.manifestPath ?? "");
  const relativeManifestPath = relative(resolve(root), absoluteManifestPath).split(sep).join("/");
  const match = relativeManifestPath.match(/^\.wrangler\/releases\/staging\/(stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12})\/release-manifest\.json$/u);
  if (match === null || (releaseIdHint !== null && match[1] !== releaseIdHint)) {
    throw new Error("staging_deployment_manifest_path_noncanonical");
  }
  await assertNoSymlinkAncestors(absoluteManifestPath, root, "staging_deployment_manifest_symlink_invalid");
  const loaded = await readPrivateJson(absoluteManifestPath, root, {
    invalid: "staging_deployment_manifest_invalid",
    missing: "staging_deployment_manifest_missing",
    permissions: "staging_deployment_manifest_permissions_invalid",
    symlink: "staging_deployment_manifest_symlink_invalid",
  });
  const manifest = loaded.value;
  if (manifest?.releaseId !== match[1]) throw new Error("staging_deployment_manifest_binding_invalid");
  const admissionImplementation = input.assertStagingReleaseAdmissionImplementation ?? assertStagingReleaseAdmission;
  const admission = await admissionImplementation({
    manifestPath: absoluteManifestPath,
    now: input.now,
    repositoryRoot: root,
  });
  if (admission?.releaseId !== manifest.releaseId || admission?.commitSha !== manifest.commitSha
    || admission?.treeSha !== manifest.treeSha) {
    throw new Error("staging_deployment_manifest_binding_invalid");
  }
  return {
    admission,
    manifest,
    manifestRef: manifestRef(manifest.releaseId),
    manifestSha256: createHash("sha256").update(loaded.bytes).digest("hex"),
  };
}

export function buildStagingDeploymentVersionMessage({ manifest, manifestRef: ref, manifestSha256 }) {
  if (!GIT_SHA_PATTERN.test(manifest?.commitSha ?? "") || !GIT_SHA_PATTERN.test(manifest?.treeSha ?? "")
    || !RELEASE_ID_PATTERN.test(manifest?.releaseId ?? "") || ref !== manifestRef(manifest.releaseId)
    || !SHA256_PATTERN.test(manifestSha256 ?? "")) {
    throw new Error("staging_deployment_version_message_invalid");
  }
  return JSON.stringify({
    commitSha: manifest.commitSha,
    manifestRef: ref,
    manifestSha256,
    releaseId: manifest.releaseId,
    role: "staging_candidate",
    treeSha: manifest.treeSha,
  });
}

function parseDeploymentInventory(value) {
  const deployments = Array.isArray(value) ? value : value?.deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("staging_deployment_inventory_invalid");
  }
  const normalized = deployments.map((deployment) => {
    const deployedAt = deployment?.created_on ?? deployment?.createdOn;
    if (!UUID_PATTERN.test(deployment?.id ?? "") || !Number.isFinite(Date.parse(deployedAt ?? ""))) {
      throw new Error("staging_deployment_inventory_invalid");
    }
    return { deployedAt, deployment };
  }).sort((left, right) => Date.parse(right.deployedAt) - Date.parse(left.deployedAt));
  const latest = normalized[0];
  const versions = latest.deployment?.versions;
  if (!Array.isArray(versions) || versions.length !== 1 || versions[0]?.percentage !== 100
    || !UUID_PATTERN.test(versions[0]?.version_id ?? "")) {
    throw new Error("staging_deployment_inventory_invalid");
  }
  return {
    deployedAt: latest.deployedAt,
    deploymentId: latest.deployment.id,
    percentage: 100,
    workerVersion: versions[0].version_id,
  };
}

function parseVersionBinding(value, workerVersion) {
  const versions = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(versions)) throw new Error("staging_deployment_version_inventory_invalid");
  const matches = versions.filter((version) => version?.id === workerVersion);
  if (matches.length !== 1) throw new Error("staging_deployment_version_inventory_invalid");
  const message = matches[0]?.annotations?.["workers/message"]
    ?? matches[0]?.metadata?.annotations?.["workers/message"];
  let binding;
  try {
    binding = JSON.parse(message);
  } catch {
    throw new Error("staging_deployment_version_binding_invalid");
  }
  exactKeys(binding, ["commitSha", "manifestRef", "manifestSha256", "releaseId", "role", "treeSha"], "staging_deployment_version_binding_invalid");
  return binding;
}

function normalizeRouteInventory(value, spec) {
  const routes = Array.isArray(value) ? value : value?.routes;
  if (!Array.isArray(routes) || !Array.isArray(spec?.stagingRouteExceptions)) {
    throw new Error("staging_deployment_route_inventory_invalid");
  }
  const owned = routes.flatMap((route) => {
    const script = route?.script ?? route?.script_name ?? null;
    if (typeof route?.pattern !== "string" || (script !== null && typeof script !== "string")) {
      throw new Error("staging_deployment_route_inventory_invalid");
    }
    return script === spec.workerName ? [{ pattern: route.pattern, script }] : [];
  }).sort((left, right) => left.pattern.localeCompare(right.pattern));
  const expected = [...spec.stagingRouteExceptions].sort();
  if (new Set(owned.map((route) => route.pattern)).size !== owned.length
    || owned.length !== expected.length
    || owned.some((route, index) => route.pattern !== expected[index])) {
    throw new Error("staging_deployment_route_inventory_mismatch");
  }
  return owned;
}

function assertManifestVersionBinding(binding, bundle) {
  const expected = {
    commitSha: bundle.manifest.commitSha,
    manifestRef: bundle.manifestRef,
    manifestSha256: bundle.manifestSha256,
    releaseId: bundle.manifest.releaseId,
    role: "staging_candidate",
    treeSha: bundle.manifest.treeSha,
  };
  if (Object.keys(expected).some((key) => binding?.[key] !== expected[key])) {
    throw new Error("staging_deployment_version_binding_mismatch");
  }
}

function loadToken(environment, name) {
  const value = environment?.[name]?.trim();
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
}

async function loadStagingSpec(root) {
  return readFile(resolve(root, "infra/environments/staging.json"), "utf8").then((value) => JSON.parse(value));
}

function validateSpec(spec) {
  if (spec?.environment !== "staging" || !ACCOUNT_ID_PATTERN.test(spec?.accountId ?? "")
    || !ACCOUNT_ID_PATTERN.test(spec?.zoneId ?? "") || !WORKER_NAME_PATTERN.test(spec?.workerName ?? "")) {
    throw new Error("staging_deployment_spec_invalid");
  }
}

function assertFreshTimes({ deployedAt, manifest, now, observedAt }) {
  const deployed = Date.parse(deployedAt ?? "");
  const observed = Date.parse(observedAt ?? "");
  const created = Date.parse(manifest?.createdAt ?? "");
  const expires = Date.parse(manifest?.expiresAt ?? "");
  const current = now.getTime();
  if (![deployed, observed, created, expires, current].every(Number.isFinite)
    || deployed < created || observed < deployed || observed > expires
    || current < observed || current - observed > MAX_EVIDENCE_AGE_MS || current > expires) {
    throw new Error("staging_deployment_evidence_stale");
  }
}

function validateArtifactShape(artifact) {
  exactKeys(artifact, ["cloudflare", "environment", "inventory", "mode", "observedAt", "release", "schemaVersion"], "staging_deployment_evidence_invalid");
  exactKeys(artifact.cloudflare, ["accountId", "deployedAt", "deploymentId", "percentage", "workerName", "workerVersion"], "staging_deployment_evidence_invalid");
  exactKeys(artifact.inventory, ["routeInventorySha256", "triggerInventorySha256"], "staging_deployment_evidence_invalid");
  exactKeys(artifact.release, ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha"], "staging_deployment_evidence_invalid");
  if (artifact.schemaVersion !== 1 || artifact.mode !== "staging_worker_deployment_binding"
    || artifact.environment !== "staging" || artifact.cloudflare.percentage !== 100
    || !ACCOUNT_ID_PATTERN.test(artifact.cloudflare.accountId ?? "")
    || !WORKER_NAME_PATTERN.test(artifact.cloudflare.workerName ?? "")
    || !UUID_PATTERN.test(artifact.cloudflare.deploymentId ?? "")
    || !UUID_PATTERN.test(artifact.cloudflare.workerVersion ?? "")
    || !GIT_SHA_PATTERN.test(artifact.release.commitSha ?? "")
    || !GIT_SHA_PATTERN.test(artifact.release.treeSha ?? "")
    || !RELEASE_ID_PATTERN.test(artifact.release.releaseId ?? "")
    || artifact.release.manifestRef !== manifestRef(artifact.release.releaseId)
    || !SHA256_PATTERN.test(artifact.release.manifestSha256 ?? "")
    || !SHA256_PATTERN.test(artifact.inventory.routeInventorySha256 ?? "")
    || !SHA256_PATTERN.test(artifact.inventory.triggerInventorySha256 ?? "")) {
    throw new Error("staging_deployment_evidence_invalid");
  }
}

export async function collectStagingDeploymentEvidence(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const now = input.now instanceof Date ? input.now : new Date();
  const bundle = await loadManifestBundle(input);
  const specLoader = input.loadStagingSpecImplementation ?? loadStagingSpec;
  const spec = await specLoader(root);
  validateSpec(spec);
  if (bundle.manifest.environment !== "staging") throw new Error("staging_deployment_manifest_binding_invalid");
  const deploymentToken = loadToken(input.environment, "CLOUDFLARE_STAGING_DEPLOYMENT_AUDIT_API_TOKEN");
  const routeToken = loadToken(input.environment, "CLOUDFLARE_ROUTE_AUDIT_API_TOKEN");
  const triggerToken = loadToken(input.environment, "CLOUDFLARE_STAGING_TRIGGER_AUDIT_API_TOKEN");
  const request = input.cloudflareApiRequestImplementation ?? cloudflareApiRequest;
  const workerPath = `/accounts/${spec.accountId}/workers/scripts/${encodeURIComponent(spec.workerName)}`;
  const [deployments, versions, routes, triggerContract] = await Promise.all([
    request(deploymentToken, `${workerPath}/deployments`, { fetchImplementation: input.fetchImplementation, method: "GET" }),
    request(deploymentToken, `${workerPath}/versions?deployable=true`, { fetchImplementation: input.fetchImplementation, method: "GET" }),
    request(routeToken, `/zones/${spec.zoneId}/workers/routes`, { fetchImplementation: input.fetchImplementation, method: "GET" }),
    (input.loadTriggerContractImplementation ?? loadTriggerContract)("staging", root),
  ]);
  const deployment = parseDeploymentInventory(deployments);
  if (input.expectedDeployment !== undefined
    && (input.expectedDeployment?.deploymentId !== deployment.deploymentId
      || input.expectedDeployment?.workerVersion !== deployment.workerVersion)) {
    throw new Error("staging_deployment_claim_mismatch");
  }
  const binding = parseVersionBinding(versions, deployment.workerVersion);
  assertManifestVersionBinding(binding, bundle);
  const routeInventory = normalizeRouteInventory(routes, spec);
  const discoverTriggers = input.discoverTriggerInventoryImplementation ?? discoverTriggerInventory;
  const liveTriggers = await discoverTriggers({
    contract: triggerContract,
    fetchImplementation: input.fetchImplementation,
    runWranglerImplementation: input.runWranglerImplementation,
    token: triggerToken,
    now,
  });
  const triggerAudit = (input.auditTriggerInventoryImplementation ?? auditTriggerInventory)({
    contract: triggerContract,
    queueConsumers: liveTriggers.queueConsumers,
    schedules: liveTriggers.schedules,
  });
  if (triggerAudit?.ok !== true) throw new Error("staging_deployment_trigger_inventory_mismatch");
  const observedAt = now.toISOString();
  assertFreshTimes({ deployedAt: deployment.deployedAt, manifest: bundle.manifest, now, observedAt });
  const artifact = {
    cloudflare: {
      accountId: spec.accountId,
      deployedAt: deployment.deployedAt,
      deploymentId: deployment.deploymentId,
      percentage: deployment.percentage,
      workerName: spec.workerName,
      workerVersion: deployment.workerVersion,
    },
    environment: "staging",
    inventory: {
      routeInventorySha256: fingerprint({ routes: routeInventory }),
      triggerInventorySha256: fingerprint({ consumers: triggerContract.consumers, schedules: triggerContract.schedules }),
    },
    mode: "staging_worker_deployment_binding",
    observedAt,
    release: {
      commitSha: bundle.manifest.commitSha,
      manifestRef: bundle.manifestRef,
      manifestSha256: bundle.manifestSha256,
      releaseId: bundle.manifest.releaseId,
      treeSha: bundle.manifest.treeSha,
    },
    schemaVersion: 1,
  };
  validateArtifactShape(artifact);
  return {
    artifact,
    artifactSha256: createHash("sha256").update(artifactBytes(artifact)).digest("hex"),
    evidenceRef: evidenceRef(bundle.manifest.releaseId),
  };
}

export async function writeStagingDeploymentEvidence({ artifact, repositoryRoot: root = repositoryRoot }) {
  validateArtifactShape(artifact);
  const ref = evidenceRef(artifact.release.releaseId);
  const path = resolve(root, ref);
  await assertNoSymlinkAncestors(path, root, "staging_deployment_evidence_symlink_invalid");
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  await chmod(dirname(path), 0o700);
  await assertNoSymlinkAncestors(dirname(path), root, "staging_deployment_evidence_symlink_invalid");
  const bytes = artifactBytes(artifact);
  try {
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("staging_deployment_evidence_exists", { cause: error });
    throw error;
  }
  await chmod(path, 0o600);
  return {
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    evidenceRef: ref,
  };
}

function releaseIdFromEvidencePath(path, root) {
  const rel = relative(resolve(root), resolve(path)).split(sep).join("/");
  const match = rel.match(/^\.wrangler\/releases\/staging\/(stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12})\/deployment-evidence\.json$/u);
  if (match === null) throw new Error("staging_deployment_evidence_path_noncanonical");
  return match[1];
}

export async function verifyStagingDeploymentEvidence(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const evidencePath = resolve(input.evidencePath ?? "");
  const releaseId = releaseIdFromEvidencePath(evidencePath, root);
  await assertNoSymlinkAncestors(evidencePath, root, "staging_deployment_evidence_symlink_invalid");
  const loaded = await readPrivateJson(evidencePath, root, {
    invalid: "staging_deployment_evidence_invalid",
    missing: "staging_deployment_evidence_missing",
    permissions: "staging_deployment_evidence_permissions_invalid",
    symlink: "staging_deployment_evidence_symlink_invalid",
  });
  const artifact = loaded.value;
  validateArtifactShape(artifact);
  if (artifact.release.releaseId !== releaseId) throw new Error("staging_deployment_evidence_path_noncanonical");
  const bundle = await loadManifestBundle(input, releaseId);
  const spec = await (input.loadStagingSpecImplementation ?? loadStagingSpec)(root);
  validateSpec(spec);
  if (artifact.release.commitSha !== bundle.manifest.commitSha
    || artifact.release.treeSha !== bundle.manifest.treeSha
    || artifact.release.manifestRef !== bundle.manifestRef
    || artifact.release.manifestSha256 !== bundle.manifestSha256
    || artifact.cloudflare.accountId !== spec.accountId
    || artifact.cloudflare.workerName !== spec.workerName) {
    throw new Error("staging_deployment_evidence_binding_mismatch");
  }
  if (input.expectedDeployment !== undefined
    && (input.expectedDeployment?.deploymentId !== artifact.cloudflare.deploymentId
      || input.expectedDeployment?.workerVersion !== artifact.cloudflare.workerVersion)) {
    throw new Error("staging_deployment_claim_mismatch");
  }
  const now = input.now instanceof Date ? input.now : new Date();
  assertFreshTimes({
    deployedAt: artifact.cloudflare.deployedAt,
    manifest: bundle.manifest,
    now,
    observedAt: artifact.observedAt,
  });
  const collector = input.collectStagingDeploymentEvidenceImplementation
    ?? collectStagingDeploymentEvidence;
  let observed;
  try {
    observed = await collector({
      ...input,
      expectedDeployment: undefined,
      manifestPath: input.manifestPath,
      now,
      repositoryRoot: root,
    });
  } catch (error) {
    throw new Error("staging_deployment_remote_observation_failed", { cause: error });
  }
  const observedArtifact = observed?.artifact;
  validateArtifactShape(observedArtifact);
  const observedKeys = ["accountId", "deployedAt", "deploymentId", "percentage", "workerName", "workerVersion"];
  const releaseKeys = ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha"];
  const inventoryKeys = ["routeInventorySha256", "triggerInventorySha256"];
  if (observedKeys.some((key) => observedArtifact.cloudflare[key] !== artifact.cloudflare[key])
    || releaseKeys.some((key) => observedArtifact.release[key] !== artifact.release[key])
    || inventoryKeys.some((key) => observedArtifact.inventory[key] !== artifact.inventory[key])) {
    throw new Error("staging_deployment_evidence_observed_mismatch");
  }
  return {
    artifact,
    artifactSha256: createHash("sha256").update(loaded.bytes).digest("hex"),
    deploymentId: artifact.cloudflare.deploymentId,
    evidenceRef: evidenceRef(releaseId),
    remoteObservedAt: observedArtifact.observedAt,
    routeInventorySha256: artifact.inventory.routeInventorySha256,
    triggerInventorySha256: artifact.inventory.triggerInventorySha256,
    workerVersion: artifact.cloudflare.workerVersion,
  };
}
