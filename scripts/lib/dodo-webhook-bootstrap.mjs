import { createHash, createHmac, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { URL } from "node:url";

import { assertProductionWorkerVersionAdmission } from "./platform.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{7,80}$/u;
const WEBHOOK_SECRET = /^(?:whsec_)?[A-Za-z0-9_+/=-]{16,512}$/u;
const SECRET_NAME = "DODO_PAYMENTS_WEBHOOK_KEY";
const BOOTSTRAP_FILE = "dodo-webhook-bootstrap.json";
const HEALTH_FILE = "dodo-webhook-bootstrap-health.json";
const ROLLBACK_FILE = "dodo-webhook-bootstrap-rollback.json";
const RESERVATION_FILE = "dodo-webhook-bootstrap-reservation.json";
const RESUME_CLAIM_FILE = "dodo-webhook-bootstrap-resume-claim.json";
const RESUME_CLAIM_TTL_MS = 15 * 60_000;
const RESUME_ATTEMPTS_DIRECTORY = "dodo-webhook-bootstrap-resume-attempts";
const RESUME_CLAIM_MUTATION_LEASE = "dodo-webhook-bootstrap-resume-claim-mutation-lease.json";
const RESUME_CLAIM_MUTATION_LEASE_TTL_MS = 30_000;

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function exactKeys(value, expected, issue) {
  const actual = Object.keys(object(value)).sort();
  if (!isDeepStrictEqual(actual, [...expected].sort())) throw new Error(issue);
}

function releaseManifestRef(releaseId) {
  return `.wrangler/releases/${releaseId}/release-manifest.json`;
}

function artifactRef(releaseId, filename) {
  return `.wrangler/releases/${releaseId}/${filename}`;
}

function canonicalArtifactIdentity(ref, filename) {
  if (typeof ref !== "string" || ref.startsWith("/") || ref.includes("..") || ref.includes("\\")) {
    throw new Error("dodo_webhook_bootstrap_artifact_path_invalid");
  }
  const match = /^\.wrangler\/releases\/([a-z0-9][a-z0-9._-]{7,80})\/([A-Za-z0-9._-]+\.json)$/u.exec(ref);
  if (match === null || match[2] !== filename) throw new Error("dodo_webhook_bootstrap_artifact_path_invalid");
  return { releaseId: match[1], ref };
}

function bindingFromEvidence(evidence) {
  return {
    commitSha: evidence.commitSha,
    manifestRef: releaseManifestRef(evidence.releaseId),
    releaseId: evidence.releaseId,
    role: "candidate",
    treeSha: evidence.treeSha,
  };
}

function fingerprintBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function safeCanonicalParent(root, path, create = false) {
  const rootResolved = resolve(root);
  const rootStat = await lstat(rootResolved);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("dodo_webhook_bootstrap_repository_root_not_canonical");
  }
  const rootReal = await realpath(rootResolved);
  const parent = dirname(path);
  const pathRelative = relative(rootResolved, parent);
  if (pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || resolve(rootResolved, pathRelative) !== parent) {
    throw new Error("dodo_webhook_bootstrap_artifact_path_invalid");
  }
  let current = rootReal;
  for (const segment of pathRelative.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (!create || error?.code !== "ENOENT") throw new Error("dodo_webhook_bootstrap_artifact_ancestor_invalid", { cause: error });
      try { await mkdir(current, { mode: 0o700 }); } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw new Error("dodo_webhook_bootstrap_artifact_ancestor_invalid", { cause: mkdirError });
      }
      stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("dodo_webhook_bootstrap_artifact_ancestor_invalid");
    if (await realpath(current) !== current) throw new Error("dodo_webhook_bootstrap_artifact_ancestor_invalid");
  }
  return parent;
}

async function safeReadPrivateFile(root, path) {
  await safeCanonicalParent(root, path, false);
  let before;
  try { before = await lstat(path); } catch (error) {
    throw new Error("dodo_webhook_bootstrap_artifact_missing", { cause: error });
  }
  if (!before.isFile() || before.isSymbolicLink() || (before.mode & 0o077) !== 0) {
    throw new Error("dodo_webhook_bootstrap_artifact_permissions_invalid");
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || !opened.isFile()) throw new Error("dodo_webhook_bootstrap_artifact_inode_changed");
    const bytes = await handle.readFile();
    await safeCanonicalParent(root, path, false);
    const after = await lstat(path);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) throw new Error("dodo_webhook_bootstrap_artifact_inode_changed");
    return { bytes, stat: opened };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("dodo_webhook_bootstrap_")) throw error;
    if (error?.code === "ENOENT") throw new Error("dodo_webhook_bootstrap_artifact_missing", { cause: error });
    throw new Error("dodo_webhook_bootstrap_artifact_read_failed", { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function cleanupExclusiveFile(root, path, opened) {
  if (opened === null) return;
  try {
    await safeCanonicalParent(root, path, false);
    const current = await lstat(path);
    if (sameInode(current, opened)) await rm(path);
  } catch {
    // A swapped ancestor is left untouched; no payload bytes are written until
    // the canonical target and opened descriptor are proven identical.
  }
}

async function removeAttemptDirectory(root, path) {
  await safeCanonicalParent(root, resolve(path, "owner.json"), false);
  let names;
  try { names = await readdir(path); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("dodo_webhook_bootstrap_resume_claim_cleanup_failed", { cause: error });
  }
  for (const name of names) {
    if (name !== "owner.json" && name !== "released.json" && !/^heartbeat-\d+-[a-f0-9-]{36}\.json$/u.test(name)) {
      throw new Error("dodo_webhook_bootstrap_resume_claim_cleanup_failed");
    }
    const child = resolve(path, name);
    await safeCanonicalParent(root, child, false);
    const childStat = await lstat(child);
    if (!childStat.isFile() || childStat.isSymbolicLink()) throw new Error("dodo_webhook_bootstrap_resume_claim_cleanup_failed");
    await unlink(child);
  }
  await safeCanonicalParent(root, path, false);
  await rmdir(path);
}

async function safeWriteExclusive(root, path, bytes, mode = 0o600, hooks = {}) {
  await safeCanonicalParent(root, path, true);
  let handle;
  let opened = null;
  try {
    await hooks.beforeOpen?.({ path });
    // Recheck after testable/pre-open work: no descriptor has been opened yet,
    // so an ancestor replacement cannot make this write escape the repository.
    await safeCanonicalParent(root, path, true);
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    opened = await handle.stat();
    if (!opened.isFile() || (opened.mode & 0o077) !== 0) throw new Error("dodo_webhook_bootstrap_artifact_permissions_invalid");
    await safeCanonicalParent(root, path, false);
    const beforeWrite = await lstat(path);
    if (beforeWrite.isSymbolicLink() || !sameInode(beforeWrite, opened)) {
      throw new Error("dodo_webhook_bootstrap_artifact_inode_changed");
    }
    await handle.writeFile(bytes);
    await handle.sync();
    await safeCanonicalParent(root, path, false);
    const afterWrite = await lstat(path);
    if (afterWrite.isSymbolicLink() || !sameInode(afterWrite, opened)) {
      throw new Error("dodo_webhook_bootstrap_artifact_inode_changed");
    }
    return opened;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    handle = undefined;
    await cleanupExclusiveFile(root, path, opened);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function claimMutationLease(releaseId, now = new Date()) {
  return {
    acquiredAt: now.toISOString(),
    attemptId: randomUUID(),
    expiresAt: new Date(now.getTime() + RESUME_CLAIM_MUTATION_LEASE_TTL_MS).toISOString(),
    mode: "dodo_webhook_bootstrap_claim_mutation_lease",
    releaseId,
    schemaVersion: 1,
  };
}

function assertClaimMutationLease(value) {
  exactKeys(value, ["acquiredAt", "attemptId", "expiresAt", "mode", "releaseId", "schemaVersion"], "dodo_webhook_bootstrap_resume_claim_lock_invalid");
  if (value.schemaVersion !== 1 || value.mode !== "dodo_webhook_bootstrap_claim_mutation_lease"
    || !RELEASE_ID.test(value.releaseId ?? "") || !UUID.test(value.attemptId ?? "")
    || !Number.isFinite(Date.parse(value.acquiredAt ?? "")) || !Number.isFinite(Date.parse(value.expiresAt ?? ""))
    || Date.parse(value.expiresAt) - Date.parse(value.acquiredAt) !== RESUME_CLAIM_MUTATION_LEASE_TTL_MS) {
    throw new Error("dodo_webhook_bootstrap_resume_claim_lock_invalid");
  }
  return value;
}

async function removeExactPrivateFile(root, path, expectedStat, hooks = {}) {
  await safeCanonicalParent(root, path, false);
  let current;
  try { current = await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!sameInode(current, expectedStat)) return false;
  await hooks.beforeExactUnlink?.({ path });
  let latest;
  try { latest = await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (!sameInode(latest, expectedStat)) return false;
  try { await unlink(path); } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  return true;
}

async function acquireClaimMutationLease(root, releaseId, hooks = {}) {
  const path = resolve(root, ".wrangler", "releases", releaseId, RESUME_CLAIM_MUTATION_LEASE);
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const lease = claimMutationLease(releaseId, hooks.now instanceof Date ? hooks.now : new Date());
    const bytes = Buffer.from(`${JSON.stringify(lease, null, 2)}\n`, "utf8");
    const candidatePath = resolve(dirname(path), `.${RESUME_CLAIM_MUTATION_LEASE}.candidate-${randomUUID()}`);
    let candidateStat = null;
    try {
      // Write the lease privately before publishing it. Creating the canonical
      // path first would expose a zero-byte file to concurrent contenders.
      candidateStat = await safeWriteExclusive(root, candidatePath, bytes);
      await safeCanonicalParent(root, path, true);
      try { await link(candidatePath, path); } catch (error) {
        throw error;
      }
      const owner = await safeReadPrivateFile(root, path);
      assertClaimMutationLease(JSON.parse(owner.bytes.toString("utf8")));
      if (!sameInode(owner.stat, candidateStat)) throw new Error("dodo_webhook_bootstrap_resume_claim_lock_race");
      await cleanupExclusiveFile(root, candidatePath, candidateStat);
      return { lease, owner, path };
    } catch (error) {
      await cleanupExclusiveFile(root, candidatePath, candidateStat);
      if (error?.code !== "EEXIST") throw new Error("dodo_webhook_bootstrap_resume_claim_lock_failed", { cause: error });
    }
    let existing;
    try {
      existing = await safeReadPrivateFile(root, path);
    } catch (error) {
      if (error instanceof Error && error.message === "dodo_webhook_bootstrap_artifact_missing") continue;
      throw new Error("dodo_webhook_bootstrap_resume_claim_lock_failed", { cause: error });
    }
    let current;
    try { current = assertClaimMutationLease(JSON.parse(existing.bytes.toString("utf8"))); } catch (error) {
      throw new Error("dodo_webhook_bootstrap_resume_claim_lock_invalid", { cause: error });
    }
    const observedAt = hooks.now instanceof Date ? hooks.now : new Date();
    if (Date.parse(current.expiresAt) > observedAt.getTime()) {
      await hooks.onClaimMutationLockBlocked?.({ lockPath: path });
      await delay(2);
      continue;
    }
    await hooks.beforeStaleMutationLeaseTakeover?.({ lease: current, path });
    if (await removeExactPrivateFile(root, path, existing.stat, hooks)) continue;
  }
  throw new Error("dodo_webhook_bootstrap_resume_claim_lock_failed");
}

async function withDodoBootstrapClaimMutation(root, releaseId, operation, hooks = {}) {
  const owner = await acquireClaimMutationLease(root, releaseId, hooks);
  let operationError;
  let result;
  try { result = await operation(); } catch (error) { operationError = error; }
  let released;
  try { released = await removeExactPrivateFile(root, owner.path, owner.owner.stat, hooks); } catch (error) {
    throw new Error("dodo_webhook_bootstrap_resume_claim_lock_release_failed", { cause: error });
  }
  if (!released) throw new Error("dodo_webhook_bootstrap_resume_claim_lock_release_failed");
  if (operationError !== undefined) throw operationError;
  return result;
}

function signingKey(secret) {
  if (secret.startsWith("whsec_")) {
    try {
      const decoded = Buffer.from(secret.slice(6).replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
      if (decoded.byteLength > 0) return decoded;
    } catch {
      // The strict secret pattern and signed probe keep malformed input closed.
    }
  }
  return Buffer.from(secret, "utf8");
}

function webhookRows(payload) {
  if (Array.isArray(payload)) return payload;
  const envelope = object(payload);
  for (const name of ["items", "data", "webhooks"]) {
    if (Array.isArray(envelope[name])) return envelope[name];
  }
  throw new Error("dodo_webhook_provider_response_invalid");
}

function rowUrl(row) {
  return typeof object(row).url === "string" ? object(row).url : null;
}

function rowId(row) {
  const id = object(row).id;
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u.test(id) ? id : null;
}

function normalizedVersionResources(version, omitBootstrapSecret) {
  const value = object(version);
  const resources = JSON.parse(JSON.stringify(object(value.resources)));
  if (!Array.isArray(resources.bindings)) throw new Error("dodo_webhook_bootstrap_version_view_invalid");
  resources.bindings = resources.bindings
    .filter((binding) => !(omitBootstrapSecret && object(binding).type === "secret_text" && object(binding).name === SECRET_NAME))
    .map((binding) => object(binding))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return resources;
}

export function assertDodoBootstrapCandidateAdmission(input) {
  const evidence = object(input.evidence);
  const repository = object(input.repository);
  const worker = object(input.worker);
  const rollback = object(object(evidence.rollback).candidate);
  if (evidence.schemaVersion !== 2 || evidence.environment !== "production"
    || !RELEASE_ID.test(evidence.releaseId ?? "") || !SHA.test(evidence.commitSha ?? "")
    || !SHA.test(evidence.treeSha ?? "") || !UUID.test(evidence.candidateWorkerVersion ?? "")
    || !UUID.test(evidence.previousWorkerVersion ?? "") || !UUID.test(rollback.workerVersion ?? "")) {
    throw new Error("dodo_webhook_bootstrap_release_evidence_invalid");
  }
  if (repository.clean !== true || repository.commitSha !== evidence.commitSha || repository.treeSha !== evidence.treeSha) {
    throw new Error("dodo_webhook_bootstrap_source_mismatch");
  }
  if (worker.ok !== true || typeof worker.accountId !== "string" || !/^[a-f0-9]{32}$/u.test(worker.accountId)
    || typeof worker.workerName !== "string" || worker.workerName.length < 3) {
    throw new Error("dodo_webhook_bootstrap_worker_admission_invalid");
  }
  assertProductionWorkerVersionAdmission({
    candidateWorkerVersion: evidence.candidateWorkerVersion,
    candidateWorkerVersionBinding: bindingFromEvidence(evidence),
    currentWorkerVersion: worker.currentWorkerVersion,
    deployableWorkerVersionIds: worker.deployableWorkerVersionIds,
    deployableWorkerVersionInventory: worker.deployableWorkerVersionInventory,
    previousWorkerVersion: evidence.previousWorkerVersion,
    rollbackCandidateWorkerVersion: rollback.workerVersion,
    rollbackWorkerVersionBinding: {
      commitSha: rollback.commitSha,
      manifestRef: releaseManifestRef(evidence.releaseId),
      releaseId: evidence.releaseId,
      role: "rollback",
      treeSha: rollback.treeSha,
    },
    workerVersionAdmissionMode: "pre_candidate",
  });
  return {
    accountId: worker.accountId,
    binding: bindingFromEvidence(evidence),
    candidateSourceWorkerVersion: evidence.candidateWorkerVersion,
    commitSha: evidence.commitSha,
    previousWorkerVersion: evidence.previousWorkerVersion,
    releaseId: evidence.releaseId,
    rollbackWorkerVersion: rollback.workerVersion,
    treeSha: evidence.treeSha,
    workerName: worker.workerName,
  };
}

export function assertDodoSecretVersionClone(input) {
  if (!UUID.test(input?.sourceWorkerVersion ?? "") || !UUID.test(input?.candidateWorkerVersion ?? "")
    || input.sourceWorkerVersion === input.candidateWorkerVersion
    || object(input.sourceVersion).id !== input.sourceWorkerVersion
    || object(input.candidateVersion).id !== input.candidateWorkerVersion) {
    throw new Error("dodo_webhook_bootstrap_version_identity_invalid");
  }
  const bindings = object(input.candidateVersion).resources?.bindings;
  if (!Array.isArray(bindings) || bindings.filter((binding) => object(binding).type === "secret_text" && object(binding).name === SECRET_NAME).length !== 1) {
    throw new Error("dodo_webhook_bootstrap_secret_binding_invalid");
  }
  const source = normalizedVersionResources(input.sourceVersion, true);
  const candidate = normalizedVersionResources(input.candidateVersion, true);
  if (!isDeepStrictEqual(source, candidate)) throw new Error("dodo_webhook_bootstrap_version_clone_mismatch");
}

export function assertDodoWebhookEndpointInventory(payload, endpointUrl) {
  const endpoint = new URL(endpointUrl);
  const rows = webhookRows(payload);
  const canonicalPrefix = "/api/webhooks/billing/dodo/";
  const matching = rows.filter((row) => rowUrl(row) === endpoint.toString());
  if (matching.length > 1) throw new Error("dodo_webhook_endpoint_duplicate");
  const conflicts = rows.filter((row) => {
    const url = rowUrl(row);
    if (url === null || url === endpoint.toString()) return false;
    try {
      const candidate = new URL(url);
      return candidate.origin === endpoint.origin && candidate.pathname.startsWith(canonicalPrefix);
    } catch {
      return false;
    }
  });
  if (conflicts.length > 0) throw new Error("dodo_webhook_endpoint_conflict");
  return matching.length === 1 ? rowId(matching[0]) : null;
}

export async function inspectDodoWebhookEndpoint(input) {
  let response;
  try {
    response = await input.fetcher(`${input.apiBaseUrl.replace(/\/+$/u, "")}/webhooks`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      method: "GET",
    });
  } catch {
    throw new Error("dodo_webhook_provider_unavailable");
  }
  if (!response.ok) throw new Error(`dodo_webhook_provider_http_${response.status}`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error("dodo_webhook_provider_response_invalid"); }
  return assertDodoWebhookEndpointInventory(payload, input.endpointUrl);
}

export async function readDodoWebhookSigningSecret(input) {
  const id = await inspectDodoWebhookEndpoint(input);
  if (id === null) throw new Error("dodo_webhook_endpoint_missing");
  let response;
  try {
    response = await input.fetcher(`${input.apiBaseUrl.replace(/\/+$/u, "")}/webhooks/${encodeURIComponent(id)}/secret`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      method: "GET",
    });
  } catch {
    throw new Error("dodo_webhook_provider_unavailable");
  }
  if (!response.ok) throw new Error(`dodo_webhook_provider_http_${response.status}`);
  let payload;
  try { payload = object(await response.json()); } catch { throw new Error("dodo_webhook_provider_response_invalid"); }
  const secret = [payload.secret, payload.signing_key, payload.webhook_secret]
    .find((value) => typeof value === "string" && WEBHOOK_SECRET.test(value));
  if (typeof secret !== "string") throw new Error("dodo_webhook_signing_key_invalid");
  return secret;
}

export function buildDodoBootstrapArtifact(input) {
  const admission = object(input.admission);
  if (!UUID.test(input.candidateWorkerVersion ?? "") || input.candidateWorkerVersion === admission.candidateSourceWorkerVersion
    || !SHA256.test(input.endpointFingerprintSha256 ?? "") || !SHA256.test(input.providerWebhookFingerprintSha256 ?? "")
    || typeof input.observedAt !== "string" || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("dodo_webhook_bootstrap_artifact_input_invalid");
  }
  return {
    environment: "production",
    gates: {
      canonicalRouteHealth: "pending",
      checkoutActivationAuthorized: false,
      deploymentAuthorized: false,
      providerMutationReplayAuthorized: false,
      signedWebhookHealthProven: false,
    },
    mode: "route_neutral_candidate_secret_bootstrap",
    observedAt: input.observedAt,
    provider: {
      created: input.created === true,
      endpointFingerprintSha256: input.endpointFingerprintSha256,
      environment: "live_mode",
      providerWebhookFingerprintSha256: input.providerWebhookFingerprintSha256,
    },
    release: {
      candidateSourceWorkerVersion: admission.candidateSourceWorkerVersion,
      candidateWorkerVersion: input.candidateWorkerVersion,
      commitSha: admission.commitSha,
      manifestRef: releaseManifestRef(admission.releaseId),
      previousWorkerVersion: admission.previousWorkerVersion,
      releaseId: admission.releaseId,
      rollbackWorkerVersion: admission.rollbackWorkerVersion,
      treeSha: admission.treeSha,
    },
    schemaVersion: 1,
    worker: {
      accountId: admission.accountId,
      activeWorkerVersionUnchanged: true,
      routeMutationPerformed: false,
      secretNames: [SECRET_NAME],
      workerName: admission.workerName,
    },
  };
}

export function assertDodoBootstrapArtifact(artifact) {
  exactKeys(artifact, ["environment", "gates", "mode", "observedAt", "provider", "release", "schemaVersion", "worker"], "dodo_webhook_bootstrap_artifact_invalid");
  exactKeys(artifact.gates, ["canonicalRouteHealth", "checkoutActivationAuthorized", "deploymentAuthorized", "providerMutationReplayAuthorized", "signedWebhookHealthProven"], "dodo_webhook_bootstrap_artifact_invalid");
  exactKeys(artifact.provider, ["created", "endpointFingerprintSha256", "environment", "providerWebhookFingerprintSha256"], "dodo_webhook_bootstrap_artifact_invalid");
  exactKeys(artifact.release, ["candidateSourceWorkerVersion", "candidateWorkerVersion", "commitSha", "manifestRef", "previousWorkerVersion", "releaseId", "rollbackWorkerVersion", "treeSha"], "dodo_webhook_bootstrap_artifact_invalid");
  exactKeys(artifact.worker, ["accountId", "activeWorkerVersionUnchanged", "routeMutationPerformed", "secretNames", "workerName"], "dodo_webhook_bootstrap_artifact_invalid");
  if (artifact.schemaVersion !== 1 || artifact.environment !== "production" || artifact.mode !== "route_neutral_candidate_secret_bootstrap"
    || artifact.gates.canonicalRouteHealth !== "pending" || artifact.gates.checkoutActivationAuthorized !== false
    || artifact.gates.deploymentAuthorized !== false || artifact.gates.providerMutationReplayAuthorized !== false
    || artifact.gates.signedWebhookHealthProven !== false || artifact.provider.environment !== "live_mode"
    || !SHA256.test(artifact.provider.endpointFingerprintSha256 ?? "") || !SHA256.test(artifact.provider.providerWebhookFingerprintSha256 ?? "")
    || !RELEASE_ID.test(artifact.release.releaseId ?? "") || !SHA.test(artifact.release.commitSha ?? "") || !SHA.test(artifact.release.treeSha ?? "")
    || artifact.release.manifestRef !== releaseManifestRef(artifact.release.releaseId)
    || !UUID.test(artifact.release.candidateSourceWorkerVersion ?? "") || !UUID.test(artifact.release.candidateWorkerVersion ?? "")
    || !UUID.test(artifact.release.previousWorkerVersion ?? "") || !UUID.test(artifact.release.rollbackWorkerVersion ?? "")
    || artifact.release.candidateSourceWorkerVersion === artifact.release.candidateWorkerVersion
    || artifact.worker.activeWorkerVersionUnchanged !== true || artifact.worker.routeMutationPerformed !== false
    || !isDeepStrictEqual(artifact.worker.secretNames, [SECRET_NAME]) || !/^[a-f0-9]{32}$/u.test(artifact.worker.accountId ?? "")
    || typeof artifact.worker.workerName !== "string" || !Number.isFinite(Date.parse(artifact.observedAt ?? ""))) {
    throw new Error("dodo_webhook_bootstrap_artifact_invalid");
  }
  return artifact;
}

export function assertDodoBootstrapReleaseBinding(input) {
  const artifact = assertDodoBootstrapArtifact(input.artifact);
  const manifest = object(input.manifest);
  const repository = object(input.repository);
  const worker = object(input.worker);
  if (manifest.schemaVersion !== 2 || manifest.environment !== "production"
    || manifest.releaseId !== artifact.release.releaseId || manifest.commitSha !== artifact.release.commitSha
    || manifest.treeSha !== artifact.release.treeSha || manifest.candidateWorkerVersion !== artifact.release.candidateWorkerVersion
    || manifest.previousWorkerVersion !== artifact.release.previousWorkerVersion
    || object(manifest.rollbackCandidate).workerVersion !== artifact.release.rollbackWorkerVersion) {
    throw new Error("dodo_webhook_bootstrap_release_binding_mismatch");
  }
  if (repository.clean !== true || repository.commitSha !== artifact.release.commitSha || repository.treeSha !== artifact.release.treeSha) {
    throw new Error("dodo_webhook_bootstrap_source_mismatch");
  }
  if (worker.ok !== true || worker.accountId !== artifact.worker.accountId || worker.workerName !== artifact.worker.workerName) {
    throw new Error("dodo_webhook_bootstrap_worker_admission_invalid");
  }
  assertProductionWorkerVersionAdmission({
    candidateWorkerVersion: artifact.release.candidateWorkerVersion,
    candidateWorkerVersionBinding: {
      commitSha: artifact.release.commitSha,
      manifestRef: artifact.release.manifestRef,
      releaseId: artifact.release.releaseId,
      role: "candidate",
      treeSha: artifact.release.treeSha,
    },
    currentWorkerVersion: worker.currentWorkerVersion,
    deployableWorkerVersionIds: worker.deployableWorkerVersionIds,
    deployableWorkerVersionInventory: worker.deployableWorkerVersionInventory,
    previousWorkerVersion: artifact.release.previousWorkerVersion,
    rollbackCandidateWorkerVersion: artifact.release.rollbackWorkerVersion,
    rollbackWorkerVersionBinding: {
      commitSha: manifest.rollbackCandidate.commitSha,
      manifestRef: artifact.release.manifestRef,
      releaseId: artifact.release.releaseId,
      role: "rollback",
      treeSha: manifest.rollbackCandidate.treeSha,
    },
    workerVersionAdmissionMode: input.mode ?? "candidate_active",
  });
  return artifact;
}

export function buildDodoSignedHealthProbe(input) {
  if (!WEBHOOK_SECRET.test(input.secret ?? "") || typeof input.requestId !== "string" || !/^[A-Za-z0-9._-]{8,120}$/u.test(input.requestId)
    || !Number.isSafeInteger(input.timestamp) || input.timestamp < 1) {
    throw new Error("dodo_webhook_signed_probe_input_invalid");
  }
  const body = "{";
  const webhookId = `bootstrap-probe-${input.requestId}`.slice(0, 150);
  const digest = createHmac("sha256", signingKey(input.secret)).update(`${webhookId}.${input.timestamp}.${body}`).digest("base64");
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": input.requestId,
      "webhook-id": webhookId,
      "webhook-signature": `v1,${digest}`,
      "webhook-timestamp": String(input.timestamp),
    },
  };
}

export function assertDodoSignedHealthProbe(response, payload, requestId) {
  if (response.status !== 400 || response.redirected || response.url.length === 0
    || response.headers.get("X-Request-Id") !== requestId
    || response.headers.get("Cache-Control") !== "private, no-store, max-age=0"
    || payload?.ok !== false || payload?.code !== "billing_webhook_invalid" || payload?.requestId !== requestId
    || !isDeepStrictEqual(payload?.issues, ["json_invalid"])
    || !isDeepStrictEqual(Object.keys(object(payload)).sort(), ["code", "issues", "ok", "requestId"])) {
    throw new Error("dodo_webhook_signed_health_invalid");
  }
}

export function buildDodoBootstrapHealthArtifact(input) {
  const bootstrap = assertDodoBootstrapArtifact(input.bootstrap);
  if (typeof input.observedAt !== "string" || !Number.isFinite(Date.parse(input.observedAt))
    || !SHA256.test(input.bootstrapArtifactSha256 ?? "") || !SHA256.test(input.releaseManifestSha256 ?? "")) {
    throw new Error("dodo_webhook_bootstrap_health_input_invalid");
  }
  return {
    environment: "production",
    gates: {
      checkoutActivationAuthorized: false,
      deploymentAuthorized: false,
      separateReleaseAcceptanceRequired: true,
      signedWebhookHealthProven: true,
    },
    mode: "candidate_bound_signed_webhook_health",
    observedAt: input.observedAt,
    provider: {
      endpointFingerprintSha256: bootstrap.provider.endpointFingerprintSha256,
      providerWebhookFingerprintSha256: bootstrap.provider.providerWebhookFingerprintSha256,
    },
    release: { ...bootstrap.release },
    schemaVersion: 1,
    sourceEvidence: {
      bootstrapArtifactSha256: input.bootstrapArtifactSha256,
      releaseManifestSha256: input.releaseManifestSha256,
    },
    worker: {
      secretNames: [SECRET_NAME],
      workerName: bootstrap.worker.workerName,
    },
  };
}

export function buildDodoBootstrapRollbackArtifact(input) {
  const bootstrap = assertDodoBootstrapArtifact(input.bootstrap);
  if (object(input.worker).currentWorkerVersion !== bootstrap.release.previousWorkerVersion
    || typeof input.observedAt !== "string" || !Number.isFinite(Date.parse(input.observedAt))
    || !SHA256.test(input.bootstrapArtifactSha256 ?? "") || !SHA256.test(input.releaseManifestSha256 ?? "")) {
    throw new Error("dodo_webhook_bootstrap_rollback_not_observed");
  }
  return {
    environment: "production",
    gates: {
      checkoutActivationAuthorized: false,
      providerCleanupRequired: true,
      signedWebhookHealthProven: false,
    },
    mode: "candidate_bootstrap_rollback_observation",
    observedAt: input.observedAt,
    release: { ...bootstrap.release },
    schemaVersion: 1,
    sourceEvidence: {
      bootstrapArtifactSha256: input.bootstrapArtifactSha256,
      releaseManifestSha256: input.releaseManifestSha256,
    },
    worker: {
      activeWorkerVersion: bootstrap.release.previousWorkerVersion,
      workerName: bootstrap.worker.workerName,
    },
  };
}

export function buildDodoBootstrapReservation(input) {
  const admission = object(input.admission);
  const beforeWorkerVersionIds = Array.isArray(input.beforeWorkerVersionIds)
    ? [...input.beforeWorkerVersionIds].sort()
    : [];
  if (!RELEASE_ID.test(admission.releaseId ?? "") || !SHA.test(admission.commitSha ?? "") || !SHA.test(admission.treeSha ?? "")
    || !UUID.test(admission.candidateSourceWorkerVersion ?? "") || !UUID.test(admission.previousWorkerVersion ?? "")
    || !UUID.test(admission.rollbackWorkerVersion ?? "") || beforeWorkerVersionIds.length === 0
    || new Set(beforeWorkerVersionIds).size !== beforeWorkerVersionIds.length
    || beforeWorkerVersionIds.some((version) => !UUID.test(version))
    || typeof input.observedAt !== "string" || !Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("dodo_webhook_bootstrap_reservation_input_invalid");
  }
  const reservationId = createHash("sha256").update(JSON.stringify({
    candidateSourceWorkerVersion: admission.candidateSourceWorkerVersion,
    commitSha: admission.commitSha,
    releaseId: admission.releaseId,
    treeSha: admission.treeSha,
  })).digest("hex");
  return {
    environment: "production",
    mode: "dodo_webhook_bootstrap_mutation_reservation",
    release: {
      candidateSourceWorkerVersion: admission.candidateSourceWorkerVersion,
      commitSha: admission.commitSha,
      manifestRef: releaseManifestRef(admission.releaseId),
      previousWorkerVersion: admission.previousWorkerVersion,
      releaseId: admission.releaseId,
      rollbackWorkerVersion: admission.rollbackWorkerVersion,
      treeSha: admission.treeSha,
    },
    reservationId,
    schemaVersion: 1,
    state: {
      bootstrapArtifactSha256: null,
      bootstrapEvidenceRef: null,
      candidateVersionMayExist: false,
      candidateWorkerVersion: null,
      cleanupRequired: false,
      lastErrorCode: null,
      phase: "reserved",
      providerEndpointMayExist: false,
      providerWebhookFingerprintSha256: null,
      retryMode: "explicit_same_binding_only",
      status: "in_progress",
      updatedAt: input.observedAt,
    },
    worker: {
      accountId: admission.accountId,
      beforeWorkerVersionIds,
      secretNames: [SECRET_NAME],
      workerName: admission.workerName,
    },
  };
}

export function assertDodoBootstrapReservation(reservation) {
  exactKeys(reservation, ["environment", "mode", "release", "reservationId", "schemaVersion", "state", "worker"], "dodo_webhook_bootstrap_reservation_invalid");
  exactKeys(reservation.release, ["candidateSourceWorkerVersion", "commitSha", "manifestRef", "previousWorkerVersion", "releaseId", "rollbackWorkerVersion", "treeSha"], "dodo_webhook_bootstrap_reservation_invalid");
  exactKeys(reservation.state, ["bootstrapArtifactSha256", "bootstrapEvidenceRef", "candidateVersionMayExist", "candidateWorkerVersion", "cleanupRequired", "lastErrorCode", "phase", "providerEndpointMayExist", "providerWebhookFingerprintSha256", "retryMode", "status", "updatedAt"], "dodo_webhook_bootstrap_reservation_invalid");
  exactKeys(reservation.worker, ["accountId", "beforeWorkerVersionIds", "secretNames", "workerName"], "dodo_webhook_bootstrap_reservation_invalid");
  const release = reservation.release;
  const state = reservation.state;
  const worker = reservation.worker;
  const expectedReservationId = createHash("sha256").update(JSON.stringify({
    candidateSourceWorkerVersion: release.candidateSourceWorkerVersion,
    commitSha: release.commitSha,
    releaseId: release.releaseId,
    treeSha: release.treeSha,
  })).digest("hex");
  if (reservation.schemaVersion !== 1 || reservation.environment !== "production" || reservation.mode !== "dodo_webhook_bootstrap_mutation_reservation"
    || reservation.reservationId !== expectedReservationId || !RELEASE_ID.test(release.releaseId ?? "")
    || !SHA.test(release.commitSha ?? "") || !SHA.test(release.treeSha ?? "")
    || release.manifestRef !== releaseManifestRef(release.releaseId)
    || !UUID.test(release.candidateSourceWorkerVersion ?? "") || !UUID.test(release.previousWorkerVersion ?? "") || !UUID.test(release.rollbackWorkerVersion ?? "")
    || !new Set(["in_progress", "failed_recoverable", "completed"]).has(state.status)
    || !new Set(["reserved", "provider_mutation_pending", "provider_registered", "version_upload_pending", "version_uploaded", "completed", "failed"]).has(state.phase)
    || state.retryMode !== "explicit_same_binding_only" || typeof state.providerEndpointMayExist !== "boolean"
    || typeof state.candidateVersionMayExist !== "boolean" || typeof state.cleanupRequired !== "boolean"
    || (state.candidateWorkerVersion !== null && !UUID.test(state.candidateWorkerVersion))
    || (state.providerWebhookFingerprintSha256 !== null && !SHA256.test(state.providerWebhookFingerprintSha256))
    || (state.bootstrapArtifactSha256 !== null && !SHA256.test(state.bootstrapArtifactSha256))
    || (state.bootstrapEvidenceRef !== null && state.bootstrapEvidenceRef !== artifactRef(release.releaseId, BOOTSTRAP_FILE))
    || (state.lastErrorCode !== null && !/^[a-z0-9_:.-]{1,180}$/u.test(state.lastErrorCode))
    || !Number.isFinite(Date.parse(state.updatedAt ?? "")) || !/^[a-f0-9]{32}$/u.test(worker.accountId ?? "")
    || !Array.isArray(worker.beforeWorkerVersionIds) || worker.beforeWorkerVersionIds.length === 0
    || new Set(worker.beforeWorkerVersionIds).size !== worker.beforeWorkerVersionIds.length
    || worker.beforeWorkerVersionIds.some((version) => !UUID.test(version))
    || !isDeepStrictEqual(worker.beforeWorkerVersionIds, [...worker.beforeWorkerVersionIds].sort())
    || !isDeepStrictEqual(worker.secretNames, [SECRET_NAME]) || typeof worker.workerName !== "string") {
    throw new Error("dodo_webhook_bootstrap_reservation_invalid");
  }
  return reservation;
}

export function updateDodoBootstrapReservation(reservation, input) {
  const current = assertDodoBootstrapReservation(reservation);
  const state = {
    ...current.state,
    ...input.state,
    updatedAt: input.observedAt,
  };
  const updated = { ...current, state };
  return assertDodoBootstrapReservation(updated);
}

export async function readPrivateDodoArtifact(root, ref, filename, expectedSha256) {
  const identity = canonicalArtifactIdentity(ref, filename);
  const path = resolve(root, identity.ref);
  if (path !== resolve(root, artifactRef(identity.releaseId, filename))) throw new Error("dodo_webhook_bootstrap_artifact_path_invalid");
  const { bytes } = await safeReadPrivateFile(root, path);
  const artifactSha256 = fingerprintBytes(bytes);
  if (expectedSha256 !== undefined && (!SHA256.test(expectedSha256) || artifactSha256 !== expectedSha256)) {
    throw new Error("dodo_webhook_bootstrap_artifact_hash_mismatch");
  }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("dodo_webhook_bootstrap_artifact_invalid"); }
  return { artifactSha256, evidenceRef: identity.ref, releaseId: identity.releaseId, value };
}

export async function readCanonicalPrivateJson(root, ref, expectedRef, issue) {
  if (ref !== expectedRef || typeof ref !== "string" || ref.startsWith("/") || ref.includes("..") || ref.includes("\\")) {
    throw new Error(`${issue}_path_invalid`);
  }
  const path = resolve(root, ref);
  if (path !== resolve(root, expectedRef)) throw new Error(`${issue}_path_invalid`);
  let loaded;
  try { loaded = await safeReadPrivateFile(root, path); } catch (error) {
    throw new Error(issue, { cause: error });
  }
  try { return JSON.parse(loaded.bytes.toString("utf8")); } catch (error) {
    throw new Error(issue, { cause: error });
  }
}

export async function writePrivateDodoArtifact(root, releaseId, filename, value, options = {}) {
  const ref = artifactRef(releaseId, filename);
  const path = resolve(root, ref);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await safeWriteExclusive(root, path, bytes, 0o600, options.fileSystemHooks);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("dodo_webhook_bootstrap_replay", { cause: error });
    throw error;
  }
  return { artifactSha256: fingerprintBytes(bytes), evidenceRef: ref };
}

async function replacePrivateDodoArtifactUnderLease(root, releaseId, filename, value, expectedSha256, options = {}) {
  const ref = artifactRef(releaseId, filename);
  canonicalArtifactIdentity(ref, filename);
  const path = resolve(root, ref);
  if (!SHA256.test(expectedSha256 ?? "")) throw new Error("dodo_webhook_bootstrap_artifact_cas_required");
  const current = await safeReadPrivateFile(root, path);
  if (fingerprintBytes(current.bytes) !== expectedSha256) throw new Error("dodo_webhook_bootstrap_artifact_cas_mismatch");
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const replacementPath = resolve(dirname(path), `.${filename}.replace-${randomUUID()}`);
  let replacement;
  try {
    replacement = await safeWriteExclusive(root, replacementPath, bytes, 0o600, options.fileSystemHooks);
    await options.fileSystemHooks?.beforeReplaceCommit?.({ path, replacementPath });
    await safeCanonicalParent(root, path, false);
    await safeCanonicalParent(root, replacementPath, false);
    const [beforeReplace, replacementEntry] = await Promise.all([lstat(path), lstat(replacementPath)]);
    if (beforeReplace.isSymbolicLink() || !sameInode(beforeReplace, current.stat)
      || replacementEntry.isSymbolicLink() || !sameInode(replacementEntry, replacement)) {
      throw new Error("dodo_webhook_bootstrap_artifact_cas_mismatch");
    }
    await rename(replacementPath, path);
    await safeCanonicalParent(root, path, false);
    const afterReplace = await lstat(path);
    if (afterReplace.isSymbolicLink() || !sameInode(afterReplace, replacement)) {
      throw new Error("dodo_webhook_bootstrap_artifact_cas_mismatch");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "dodo_webhook_bootstrap_artifact_cas_mismatch") throw error;
    throw new Error("dodo_webhook_bootstrap_reservation_update_failed", { cause: error });
  } finally {
    await cleanupExclusiveFile(root, replacementPath, replacement);
  }
  return { artifactSha256: fingerprintBytes(bytes), evidenceRef: ref };
}

export async function replacePrivateDodoArtifact(root, releaseId, filename, value, expectedSha256, options = {}) {
  // All legitimate writers share this lease. POSIX offers no conditional
  // rename primitive, so serializing our CAS writers prevents a second
  // bootstrap process from replacing the target between inode check and
  // rename; an untrusted filesystem swap still fails before commit.
  return withDodoBootstrapClaimMutation(
    root,
    releaseId,
    () => replacePrivateDodoArtifactUnderLease(root, releaseId, filename, value, expectedSha256, options),
    options.fileSystemHooks,
  );
}

async function removeCanonicalClaimIfOwnedUnderLock(root, path, ownerPath) {
  let canonical;
  let owner;
  try {
    [canonical, owner] = await Promise.all([
      safeReadPrivateFile(root, path),
      safeReadPrivateFile(root, ownerPath),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === "dodo_webhook_bootstrap_artifact_missing") return false;
    throw error;
  }
  if (!sameInode(canonical.stat, owner.stat)) return false;
  await safeCanonicalParent(root, path, false);
  const latest = await lstat(path);
  if (!sameInode(latest, owner.stat)) return false;
  await rm(path);
  return true;
}

function assertDodoBootstrapResumeClaim(claim) {
  exactKeys(claim, ["acquiredAt", "attemptId", "environment", "expiresAt", "heartbeatAt", "mode", "releaseId", "reservationId", "reservationSha256", "schemaVersion"], "dodo_webhook_bootstrap_resume_claim_invalid");
  const acquiredAt = Date.parse(claim.acquiredAt ?? "");
  const heartbeatAt = Date.parse(claim.heartbeatAt ?? "");
  const expiresAt = Date.parse(claim.expiresAt ?? "");
  if (claim.schemaVersion !== 1 || claim.environment !== "production" || claim.mode !== "dodo_webhook_bootstrap_resume_claim"
    || !RELEASE_ID.test(claim.releaseId ?? "") || !SHA256.test(claim.reservationId ?? "")
    || !SHA256.test(claim.reservationSha256 ?? "") || !UUID.test(claim.attemptId ?? "")
    || !Number.isFinite(acquiredAt) || !Number.isFinite(heartbeatAt) || !Number.isFinite(expiresAt)
    || heartbeatAt < acquiredAt || expiresAt - heartbeatAt !== RESUME_CLAIM_TTL_MS) {
    throw new Error("dodo_webhook_bootstrap_resume_claim_invalid");
  }
  return claim;
}

export async function acquireDodoBootstrapResumeClaim(root, input) {
  if (!RELEASE_ID.test(input.releaseId ?? "") || !SHA256.test(input.reservationId ?? "") || !SHA256.test(input.reservationSha256 ?? "")) {
    throw new Error("dodo_webhook_bootstrap_resume_claim_input_invalid");
  }
  const now = input.now instanceof Date ? input.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("dodo_webhook_bootstrap_resume_claim_input_invalid");
  const ref = artifactRef(input.releaseId, RESUME_CLAIM_FILE);
  const path = resolve(root, ref);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const claim = {
      acquiredAt: now.toISOString(),
      attemptId: randomUUID(),
      environment: "production",
      expiresAt: new Date(now.getTime() + RESUME_CLAIM_TTL_MS).toISOString(),
      heartbeatAt: now.toISOString(),
      mode: "dodo_webhook_bootstrap_resume_claim",
      releaseId: input.releaseId,
      reservationId: input.reservationId,
      reservationSha256: input.reservationSha256,
      schemaVersion: 1,
    };
    const bytes = Buffer.from(`${JSON.stringify(claim, null, 2)}\n`, "utf8");
    const attemptDirectory = resolve(root, ".wrangler", "releases", input.releaseId, RESUME_ATTEMPTS_DIRECTORY, claim.attemptId);
    const ownerPath = resolve(attemptDirectory, "owner.json");
    try {
      await safeWriteExclusive(root, ownerPath, bytes);
      const acquired = await withDodoBootstrapClaimMutation(root, input.releaseId, async () => {
        await safeCanonicalParent(root, path, true);
        try { await link(ownerPath, path); } catch (error) {
          if (error?.code === "EEXIST") return null;
          throw error;
        }
        try {
          const ownership = await assertDodoBootstrapResumeClaimOwnership(root, { claim, now });
          return { artifactSha256: fingerprintBytes(bytes), claim: ownership, evidenceRef: ref };
        } catch (error) {
          await removeCanonicalClaimIfOwnedUnderLock(root, path, ownerPath);
          throw error;
        }
      }, input.fileSystemHooks);
      if (acquired !== null) return acquired;
    } catch (error) {
      await removeAttemptDirectory(root, attemptDirectory).catch(() => undefined);
      throw new Error("dodo_webhook_bootstrap_resume_claim_failed", { cause: error });
    }
    await removeAttemptDirectory(root, attemptDirectory).catch(() => undefined);
    const takeover = await withDodoBootstrapClaimMutation(root, input.releaseId, async () => {
      let existing;
      let existingFile;
      try {
        existingFile = await safeReadPrivateFile(root, path);
        existing = assertDodoBootstrapResumeClaim(JSON.parse(existingFile.bytes.toString("utf8")));
      } catch (error) {
        if (error instanceof Error && error.message === "dodo_webhook_bootstrap_artifact_missing") return "retry";
        throw new Error("dodo_webhook_bootstrap_resume_claim_invalid", { cause: error });
      }
      if (existing.releaseId !== input.releaseId) throw new Error("dodo_webhook_bootstrap_resume_claim_invalid");
      const currentState = await readDodoBootstrapResumeAttemptState(root, existing);
      if (!currentState.released && Date.parse(currentState.expiresAt) > now.getTime()) {
        if (existing.reservationId !== input.reservationId || existing.reservationSha256 !== input.reservationSha256) {
          throw new Error("dodo_webhook_bootstrap_resume_claim_conflict");
        }
        throw new Error("dodo_webhook_bootstrap_resume_in_progress");
      }
      const staleFilename = `dodo-webhook-bootstrap-resume-claim-stale-${existing.attemptId}.json`;
      const stalePath = resolve(root, artifactRef(input.releaseId, staleFilename));
      try {
        await safeCanonicalParent(root, path, false);
        await safeCanonicalParent(root, stalePath, true);
        try { await link(path, stalePath); } catch (error) {
          if (error?.code !== "EEXIST") throw error;
        }
        const [canonical, stale] = await Promise.all([
          safeReadPrivateFile(root, path),
          safeReadPrivateFile(root, stalePath),
        ]);
        if (!sameInode(existingFile.stat, canonical.stat) || !sameInode(canonical.stat, stale.stat)
          || fingerprintBytes(canonical.bytes) !== fingerprintBytes(existingFile.bytes)) {
          throw new Error("dodo_webhook_bootstrap_resume_claim_recovery_failed");
        }
        await input.fileSystemHooks?.beforeCanonicalClaimUnlink?.({ path, stalePath });
        await safeCanonicalParent(root, path, false);
        const latest = await lstat(path);
        if (!sameInode(latest, existingFile.stat)) throw new Error("dodo_webhook_bootstrap_resume_claim_recovery_failed");
        await rm(path);
      } catch (error) {
        if (error?.code === "ENOENT") return "retry";
        if (error instanceof Error && error.message === "dodo_webhook_bootstrap_resume_claim_recovery_failed") throw error;
        throw new Error("dodo_webhook_bootstrap_resume_claim_recovery_failed", { cause: error });
      }
      return "retry";
    }, input.fileSystemHooks);
    if (takeover !== "retry") throw new Error("dodo_webhook_bootstrap_resume_claim_race");
  }
  throw new Error("dodo_webhook_bootstrap_resume_claim_race");
}

export async function releaseDodoBootstrapResumeClaim(root, input) {
  const claim = assertDodoBootstrapResumeClaim(input.claim);
  try { await assertDodoBootstrapResumeClaimOwnership(root, { claim, now: input.now }); } catch (error) {
    if (error instanceof Error && error.message === "dodo_webhook_bootstrap_resume_claim_ownership_lost") return { ownershipLost: true, released: false };
    throw error;
  }
  const releasedAt = input.now instanceof Date ? input.now : new Date();
  const releasePath = resolve(root, ".wrangler", "releases", claim.releaseId, RESUME_ATTEMPTS_DIRECTORY, claim.attemptId, "released.json");
  const bytes = Buffer.from(`${JSON.stringify({
    attemptId: claim.attemptId,
    releasedAt: releasedAt.toISOString(),
    reservationId: claim.reservationId,
    reservationSha256: claim.reservationSha256,
  }, null, 2)}\n`, "utf8");
  try { await safeWriteExclusive(root, releasePath, bytes); } catch (error) {
    if (error?.code !== "EEXIST") throw new Error("dodo_webhook_bootstrap_resume_claim_release_invalid", { cause: error });
  }
  return { ownershipLost: false, released: true };
}

export async function assertDodoBootstrapResumeClaimOwnership(root, input) {
  const expected = assertDodoBootstrapResumeClaim(input.claim);
  const now = input.now instanceof Date ? input.now : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("dodo_webhook_bootstrap_resume_claim_input_invalid");
  const path = resolve(root, artifactRef(expected.releaseId, RESUME_CLAIM_FILE));
  const ownerPath = resolve(root, ".wrangler", "releases", expected.releaseId, RESUME_ATTEMPTS_DIRECTORY, expected.attemptId, "owner.json");
  let current;
  try {
    const [canonical, owner] = await Promise.all([safeReadPrivateFile(root, path), safeReadPrivateFile(root, ownerPath)]);
    if (!sameInode(canonical.stat, owner.stat)) throw new Error("dodo_webhook_bootstrap_resume_claim_ownership_lost");
    current = assertDodoBootstrapResumeClaim(JSON.parse(canonical.bytes.toString("utf8")));
  } catch (error) {
    throw new Error("dodo_webhook_bootstrap_resume_claim_ownership_lost", { cause: error });
  }
  const state = await readDodoBootstrapResumeAttemptState(root, current);
  if (current.attemptId !== expected.attemptId || current.reservationSha256 !== expected.reservationSha256
    || current.reservationId !== expected.reservationId || current.releaseId !== expected.releaseId
    || state.released || Date.parse(state.expiresAt) <= now.getTime()) {
    throw new Error("dodo_webhook_bootstrap_resume_claim_ownership_lost");
  }
  return { ...current, expiresAt: state.expiresAt, heartbeatAt: state.heartbeatAt };
}

export async function renewDodoBootstrapResumeClaim(root, input) {
  const current = await assertDodoBootstrapResumeClaimOwnership(root, input);
  const now = input.now instanceof Date ? input.now : new Date();
  if (now.getTime() < Date.parse(current.heartbeatAt)) throw new Error("dodo_webhook_bootstrap_resume_claim_clock_invalid");
  const heartbeat = {
    attemptId: current.attemptId,
    expiresAt: new Date(now.getTime() + RESUME_CLAIM_TTL_MS).toISOString(),
    heartbeatAt: now.toISOString(),
    reservationId: current.reservationId,
    reservationSha256: current.reservationSha256,
  };
  const bytes = Buffer.from(`${JSON.stringify(heartbeat, null, 2)}\n`, "utf8");
  const heartbeatPath = resolve(root, ".wrangler", "releases", current.releaseId, RESUME_ATTEMPTS_DIRECTORY, current.attemptId, `heartbeat-${now.getTime()}-${randomUUID()}.json`);
  try { await safeWriteExclusive(root, heartbeatPath, bytes); } catch (error) {
    throw new Error("dodo_webhook_bootstrap_resume_claim_renewal_failed", { cause: error });
  }
  const verified = await assertDodoBootstrapResumeClaimOwnership(root, { claim: current, now });
  return { artifactSha256: fingerprintBytes(bytes), claim: verified, evidenceRef: artifactRef(current.releaseId, RESUME_CLAIM_FILE) };
}

async function readDodoBootstrapResumeAttemptState(root, claim) {
  const attemptDirectory = resolve(root, ".wrangler", "releases", claim.releaseId, RESUME_ATTEMPTS_DIRECTORY, claim.attemptId);
  await safeCanonicalParent(root, resolve(attemptDirectory, "owner.json"), false);
  let names;
  try { names = await readdir(attemptDirectory); } catch (error) {
    throw new Error("dodo_webhook_bootstrap_resume_claim_invalid", { cause: error });
  }
  let heartbeatAt = claim.heartbeatAt;
  let expiresAt = claim.expiresAt;
  for (const name of names.filter((entry) => /^heartbeat-\d+-[a-f0-9-]{36}\.json$/u.test(entry))) {
    const loaded = await safeReadPrivateFile(root, resolve(attemptDirectory, name));
    let heartbeat;
    try { heartbeat = JSON.parse(loaded.bytes.toString("utf8")); } catch (error) {
      throw new Error("dodo_webhook_bootstrap_resume_claim_invalid", { cause: error });
    }
    if (heartbeat?.attemptId !== claim.attemptId || heartbeat?.reservationId !== claim.reservationId
      || heartbeat?.reservationSha256 !== claim.reservationSha256
      || !Number.isFinite(Date.parse(heartbeat?.heartbeatAt ?? "")) || !Number.isFinite(Date.parse(heartbeat?.expiresAt ?? ""))
      || Date.parse(heartbeat.expiresAt) - Date.parse(heartbeat.heartbeatAt) !== RESUME_CLAIM_TTL_MS) {
      throw new Error("dodo_webhook_bootstrap_resume_claim_invalid");
    }
    if (Date.parse(heartbeat.heartbeatAt) > Date.parse(heartbeatAt)) {
      heartbeatAt = heartbeat.heartbeatAt;
      expiresAt = heartbeat.expiresAt;
    }
  }
  let released = false;
  if (names.includes("released.json")) {
    const loaded = await safeReadPrivateFile(root, resolve(attemptDirectory, "released.json"));
    let marker;
    try { marker = JSON.parse(loaded.bytes.toString("utf8")); } catch (error) {
      throw new Error("dodo_webhook_bootstrap_resume_claim_invalid", { cause: error });
    }
    released = marker?.attemptId === claim.attemptId && marker?.reservationId === claim.reservationId
      && marker?.reservationSha256 === claim.reservationSha256 && Number.isFinite(Date.parse(marker?.releasedAt ?? ""));
    if (!released) throw new Error("dodo_webhook_bootstrap_resume_claim_invalid");
  }
  return { expiresAt, heartbeatAt, released };
}

export const DODO_BOOTSTRAP_ARTIFACT_FILES = Object.freeze({ bootstrap: BOOTSTRAP_FILE, health: HEALTH_FILE, reservation: RESERVATION_FILE, resumeClaim: RESUME_CLAIM_FILE, rollback: ROLLBACK_FILE });
export const DODO_BOOTSTRAP_SECRET_NAME = SECRET_NAME;
