import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { assertDodoStagingUatEvidence, readDodoUatExecutionProofArtifacts } from "./dodo-uat-evidence.mjs";
import { assertPayosStagingUatEvidence, readPayosProviderExecutionArtifacts } from "./payos-uat-evidence.mjs";
import { verifyStagingDeploymentEvidence } from "./staging-deployment-evidence.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const RELEASE_ID = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const SAFE_REF = /^\.wrangler\/releases\/staging\/[A-Za-z0-9._/-]+\.json$/u;

function assertStagingManifestWindow(manifest, now = new Date()) {
  const createdAt = new Date(manifest?.createdAt ?? "");
  const expiresAt = new Date(manifest?.expiresAt ?? "");
  if (!Number.isFinite(createdAt.getTime())
    || !Number.isFinite(expiresAt.getTime())
    || createdAt.toISOString() !== manifest?.createdAt
    || expiresAt.toISOString() !== manifest?.expiresAt
    || createdAt.getTime() > now.getTime() + 5 * 60_000
    || expiresAt.getTime() <= createdAt.getTime()
    || expiresAt.getTime() - createdAt.getTime() > 7 * 24 * 60 * 60_000) {
    throw new Error("commerce_uat_staging_manifest_window_invalid");
  }
  if (now.getTime() > expiresAt.getTime()) throw new Error("commerce_uat_staging_manifest_expired");
}

function git(root, args, issue) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(issue);
  return result.stdout.trim();
}

function safeArtifactPath(root, value, issue) {
  if (typeof value !== "string" || !SAFE_REF.test(value)) throw new Error(issue);
  const path = resolve(root, value);
  const rel = relative(resolve(root, ".wrangler/releases/staging"), path);
  if (rel.startsWith("..") || rel.includes("\\") || rel.length === 0) throw new Error(issue);
  return path;
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readPrivateFile(root, reference, issues) {
  const path = safeArtifactPath(root, reference, issues.reference ?? issues.path);
  let descriptor;
  try {
    const canonicalRoot = realpathSync.native(resolve(root));
    const canonicalPath = realpathSync.native(path);
    const expectedCanonicalPath = resolve(canonicalRoot, relative(resolve(root), path));
    if (canonicalPath !== expectedCanonicalPath) throw new Error(issues.path);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = fstatSync(descriptor, { bigint: true });
    const pathStat = statSync(path, { bigint: true });
    if (!openedStat.isFile()
      || (openedStat.mode & 0o077n) !== 0n
      || !sameFile(openedStat, pathStat)
      || realpathSync.native(path) !== canonicalPath) {
      throw new Error(issues.permissions);
    }
    const bytes = readFileSync(descriptor);
    const closedOverStat = fstatSync(descriptor, { bigint: true });
    const finalPathStat = statSync(path, { bigint: true });
    if (!sameFile(openedStat, closedOverStat)
      || !sameFile(openedStat, finalPathStat)
      || openedStat.size !== closedOverStat.size
      || openedStat.mtimeNs !== closedOverStat.mtimeNs
      || openedStat.ctimeNs !== closedOverStat.ctimeNs
      || realpathSync.native(path) !== canonicalPath) {
      throw new Error(issues.path);
    }
    return { bytes, path };
  } catch (error) {
    if (error instanceof Error && Object.values(issues).includes(error.message)) throw error;
    if (error?.code === "ELOOP") throw new Error(issues.path, { cause: error });
    throw new Error(descriptor === undefined ? issues.missing : issues.invalid, { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readPrivateJson(root, reference, missingIssue) {
  const loaded = readPrivateFile(root, reference, {
    invalid: `${missingIssue}_invalid`,
    missing: missingIssue,
    path: `${missingIssue}_path_invalid`,
    permissions: `${missingIssue}_permissions_invalid`,
    reference: missingIssue,
  });
  try {
    return { ...loaded, value: JSON.parse(loaded.bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`${missingIssue}_invalid`, { cause: error });
  }
}

function exactObjectKeys(value, expected, issue) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(issue);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(issue);
}

function readDodoExecutionProofPublicKeys(root, releaseId) {
  const reference = `.wrangler/releases/staging/${releaseId}/dodo-uat-trusted-public-keys.json`;
  const loaded = readPrivateJson(root, reference, "dodo_uat_trusted_public_keys_missing");
  exactObjectKeys(loaded.value, ["environment", "keys", "provider", "schemaVersion"], "dodo_uat_trusted_public_keys_invalid");
  if (loaded.value.schemaVersion !== 1
    || loaded.value.environment !== "staging"
    || loaded.value.provider !== "dodo"
    || !Array.isArray(loaded.value.keys)
    || loaded.value.keys.length === 0) {
    throw new Error("dodo_uat_trusted_public_keys_invalid");
  }
  const keys = {};
  for (const entry of loaded.value.keys) {
    exactObjectKeys(entry, ["keyId", "publicKeyPem"], "dodo_uat_trusted_public_keys_invalid");
    if (typeof entry.keyId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(entry.keyId)
      || typeof entry.publicKeyPem !== "string"
      || !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/u.test(entry.publicKeyPem)
      || Object.prototype.hasOwnProperty.call(keys, entry.keyId)) {
      throw new Error("dodo_uat_trusted_public_keys_invalid");
    }
    keys[entry.keyId] = entry.publicKeyPem;
  }
  return keys;
}

function assertScenarioArtifacts(root, evidence, provider, providerExecutionArtifactFingerprints = {}) {
  const fingerprints = {};
  const ids = provider === "dodo"
    ? Object.keys(evidence.scenarios ?? {})
    : Object.keys(evidence.scenarios ?? {});
  for (const id of ids) {
    const record = evidence.scenarios[id];
    const refs = [record?.requestReference, record?.eventReference, record?.sessionReference].filter((ref) => ref !== null && ref !== undefined);
    if (refs.length === 0 || refs.some((ref) => typeof ref !== "string" || !ref.startsWith("artifact:"))) {
      throw new Error(`${provider}_uat_scenario_artifact_reference_required`);
    }
    for (const ref of refs) {
      const relativeRef = ref.slice("artifact:".length);
      const artifact = readPrivateJson(root, relativeRef, `${provider}_uat_scenario_artifact_missing`);
      const digest = createHash("sha256").update(artifact.bytes).digest("hex");
      if (digest !== record.evidenceFingerprintSha256) throw new Error(`${provider}_uat_scenario_artifact_hash_mismatch`);
      if (artifact.value?.provider !== provider || artifact.value?.environment !== "staging"
        || artifact.value?.release?.releaseId !== evidence.release.releaseId) {
        throw new Error(`${provider}_uat_scenario_artifact_binding_mismatch`);
      }
      if (provider === "payos") {
        const providerExecutionScenario = evidence.evidenceKind === "provider_acceptance"
          && (id === "signed_exact_payment" || id === "direct_reconciliation");
        exactObjectKeys(artifact.value, [
          "classification",
          "controlledAccountFingerprintSha256",
          "evidenceKind",
          "environment",
          "observedAt",
          "provider",
          "proofOfExecutionFingerprintSha256",
          "redaction",
          "release",
          "result",
          "scenarioId",
          "schemaVersion",
          "verificationMethod",
        ], "payos_uat_scenario_artifact_invalid");
        if (artifact.value.schemaVersion !== 1
          || artifact.value.evidenceKind !== evidence.evidenceKind
          || artifact.value.scenarioId !== id
          || artifact.value.classification !== record.classification
          || artifact.value.result !== record.status
          || artifact.value.verificationMethod !== record.verificationMethod
          || artifact.value.observedAt !== record.observedAt
          || artifact.value.controlledAccountFingerprintSha256 !== (providerExecutionScenario ? evidence.providerExecution.controlledAccountFingerprintSha256 : null)
          || artifact.value.proofOfExecutionFingerprintSha256 !== (providerExecutionScenario ? providerExecutionArtifactFingerprints[id] : null)) {
          throw new Error("payos_uat_scenario_artifact_binding_mismatch");
        }
        exactObjectKeys(artifact.value.redaction, ["noRawPayload", "noSensitiveValues"], "payos_uat_scenario_artifact_redaction_invalid");
        if (artifact.value.redaction.noRawPayload !== true || artifact.value.redaction.noSensitiveValues !== true) {
          throw new Error("payos_uat_scenario_artifact_redaction_invalid");
        }
        exactObjectKeys(artifact.value.release, ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha", "workerVersion"], "payos_uat_scenario_artifact_binding_mismatch");
        for (const key of ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha", "workerVersion"]) {
          if (artifact.value.release[key] !== evidence.release[key]) throw new Error("payos_uat_scenario_artifact_binding_mismatch");
        }
      }
      fingerprints[id] = digest;
    }
  }
  return fingerprints;
}

export function readTrustedStagingUatBinding({ evidence, manifestPath: requestedManifestPath, now = new Date(), repositoryRoot, workerVersion }) {
  const root = repositoryRoot;
  const release = evidence?.release;
  if (typeof release?.manifestRef !== "string") throw new Error("commerce_uat_release_binding_missing");
  if (!GIT_SHA.test(release.commitSha ?? "") || !GIT_SHA.test(release.treeSha ?? "") || !RELEASE_ID.test(release.releaseId ?? "")) {
    throw new Error("commerce_uat_release_binding_invalid");
  }
  if (!SHA256.test(release.manifestSha256 ?? "")) throw new Error("commerce_uat_manifest_hash_invalid");
  const manifestPath = safeArtifactPath(root, release.manifestRef, "commerce_uat_manifest_ref_invalid");
  if (requestedManifestPath !== undefined && resolve(root, requestedManifestPath) !== manifestPath) throw new Error("commerce_uat_manifest_ref_mismatch");
  if (workerVersion !== undefined && workerVersion !== release.workerVersion) throw new Error("commerce_uat_worker_version_mismatch");
  const { bytes } = readPrivateFile(root, release.manifestRef, {
    invalid: "commerce_uat_manifest_invalid",
    missing: "commerce_uat_manifest_missing",
    path: "commerce_uat_manifest_path_invalid",
    permissions: "commerce_uat_manifest_permissions_invalid",
  });
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  if (manifestSha256 !== release.manifestSha256) throw new Error("commerce_uat_manifest_hash_mismatch");
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("commerce_uat_manifest_invalid");
  }
  if (manifest.schemaVersion !== 3 || manifest.environment !== "staging" || manifest.releaseId !== release.releaseId) {
    throw new Error("commerce_uat_manifest_invalid");
  }
  assertStagingManifestWindow(manifest, now);
  const commitSha = git(root, ["rev-parse", "--verify", "HEAD"], "commerce_uat_commit_unavailable");
  const treeSha = git(root, ["rev-parse", "--verify", "HEAD^{tree}"], "commerce_uat_tree_unavailable");
  if (commitSha !== release.commitSha) throw new Error("commerce_uat_commit_mismatch");
  if (treeSha !== release.treeSha) throw new Error("commerce_uat_tree_mismatch");
  if (manifest.commitSha !== commitSha || manifest.treeSha !== treeSha) throw new Error("commerce_uat_manifest_binding_mismatch");
  return {
    commitSha,
    manifestRef: release.manifestRef,
    manifestSha256,
    releaseId: release.releaseId,
    treeSha,
    workerVersion: release.workerVersion,
  };
}

function resolvePayosOwnerAttestationPublicKeys(explicit) {
  if (explicit !== undefined) return explicit;
  const keyId = process.env.SELINOW_PAYOS_UAT_ATTESTATION_KEY_ID;
  const encoded = process.env.SELINOW_PAYOS_UAT_ATTESTATION_PUBLIC_KEY_PEM_BASE64;
  if (typeof keyId !== "string" || keyId.length === 0 || typeof encoded !== "string" || encoded.length === 0) return {};
  try {
    return { [keyId]: Buffer.from(encoded, "base64").toString("utf8") };
  } catch {
    return {};
  }
}

function resolveDodoApprovedExecutionProofTrust(explicit, environment = process.env) {
  if (explicit !== undefined) return explicit;
  return {
    keyId: environment.SELINOW_DODO_UAT_RUNNER_KEY_ID ?? "",
    spkiSha256: environment.SELINOW_DODO_UAT_RUNNER_SPKI_SHA256 ?? "",
  };
}

function resolvePayosStagingRunnerTrust(publicKeys, spkiFingerprints, environment = process.env) {
  if (publicKeys !== undefined || spkiFingerprints !== undefined) {
    return {
      publicKeys: publicKeys ?? {},
      spkiFingerprints: spkiFingerprints ?? {},
    };
  }
  const keyId = environment.SELINOW_PAYOS_UAT_RUNNER_KEY_ID;
  const encoded = environment.SELINOW_PAYOS_UAT_RUNNER_PUBLIC_KEY_PEM_BASE64;
  const spkiSha256 = environment.SELINOW_PAYOS_UAT_RUNNER_SPKI_SHA256;
  if (typeof keyId !== "string" || keyId.length === 0
    || typeof encoded !== "string" || encoded.length === 0
    || typeof spkiSha256 !== "string" || spkiSha256.length === 0) {
    return { publicKeys: {}, spkiFingerprints: {} };
  }
  try {
    return {
      publicKeys: { [keyId]: Buffer.from(encoded, "base64").toString("utf8") },
      spkiFingerprints: { [keyId]: spkiSha256 },
    };
  } catch {
    return { publicKeys: {}, spkiFingerprints: {} };
  }
}

export function validateCommerceUatArtifactsSync({
  dodoApprovedExecutionProofTrust,
  environment,
  evidence,
  now = new Date(),
  payosOwnerAttestationPublicKeys,
  payosStagingRunnerPublicKeys,
  payosStagingRunnerSpkiFingerprints,
  repositoryRoot,
  trustedStagingWorkerVersion,
}) {
  const root = repositoryRoot;
  const result = {};
  const dodoTrust = resolveDodoApprovedExecutionProofTrust(dodoApprovedExecutionProofTrust, environment);
  const payosRunnerTrust = resolvePayosStagingRunnerTrust(
    payosStagingRunnerPublicKeys,
    payosStagingRunnerSpkiFingerprints,
    environment,
  );
  for (const [provider, validator] of [["dodo", assertDodoStagingUatEvidence], ["payos", assertPayosStagingUatEvidence]]) {
    const reference = evidence?.commerceAcceptance?.[provider]?.evidenceRef;
    try {
      if (typeof trustedStagingWorkerVersion !== "string" || trustedStagingWorkerVersion.length === 0) {
        throw new Error("commerce_uat_trusted_worker_version_required");
      }
      const loaded = readPrivateJson(root, reference, `${provider}_uat_artifact_missing`);
      const artifact = loaded.value;
      const declaredArtifactSha256 = evidence?.commerceAcceptance?.[provider]?.artifactSha256;
      if (typeof declaredArtifactSha256 !== "string" || !SHA256.test(declaredArtifactSha256)) {
        throw new Error(`${provider}_uat_artifact_fingerprint_missing`);
      }
      const artifactSha256 = createHash("sha256").update(loaded.bytes).digest("hex");
      if (artifactSha256 !== declaredArtifactSha256) throw new Error(`${provider}_uat_artifact_hash_mismatch`);
      const expectedProviderEnvironment = provider === "dodo" ? "test_mode" : "production_controlled";
      if (artifact.provider !== provider || artifact.providerEnvironment !== expectedProviderEnvironment) {
        throw new Error(`${provider}_uat_provider_binding_mismatch`);
      }
      let scenarioArtifactFingerprints = {};
      let providerBinding = {};
      if (provider === "dodo") {
        const executionProofPublicKeys = readDodoExecutionProofPublicKeys(root, artifact.release.releaseId);
        const verifiedExecutionProofs = readDodoUatExecutionProofArtifacts({
          approvedExecutionProofTrust: dodoTrust,
          evidence: artifact,
          executionProofPublicKeys,
          repositoryRoot: root,
        });
        scenarioArtifactFingerprints = Object.fromEntries(Object.entries(verifiedExecutionProofs)
          .map(([scenarioId, proof]) => [scenarioId, proof.artifactSha256]));
        providerBinding = { approvedExecutionProofTrust: dodoTrust, verifiedExecutionProofs };
      } else {
        const providerExecution = readPayosProviderExecutionArtifacts({
          evidence: artifact,
          repositoryRoot: root,
          stagingRunnerPublicKeys: payosRunnerTrust.publicKeys,
          stagingRunnerSpkiFingerprints: payosRunnerTrust.spkiFingerprints,
        });
        scenarioArtifactFingerprints = assertScenarioArtifacts(root, artifact, provider, providerExecution.fingerprints);
        providerBinding = {
          ownerAttestationPublicKeys: resolvePayosOwnerAttestationPublicKeys(payosOwnerAttestationPublicKeys),
          providerExecutionArtifactFingerprints: providerExecution.fingerprints,
        };
      }
      const binding = {
        ...readTrustedStagingUatBinding({
          evidence: artifact,
          now,
          repositoryRoot: root,
          workerVersion: trustedStagingWorkerVersion,
        }),
        requireArtifactProof: true,
        scenarioArtifactFingerprints,
        ...providerBinding,
      };
      const accepted = validator(artifact, binding);
      result[provider] = {
        accepted: true,
        artifactFingerprintSha256: artifactSha256,
        manifestRef: binding.manifestRef,
        manifestSha256: binding.manifestSha256,
        releaseId: binding.releaseId,
        scenarioCount: accepted.scenarioCount,
        workerVersion: binding.workerVersion,
        ...(provider === "payos" ? {
          fullCommerceAccepted: accepted.fullCommerceAccepted === true,
          paymentLaneAccepted: accepted.paymentLaneAccepted === true,
          reasonCodes: Array.isArray(accepted.fullCommerceReasonCodes) ? [...accepted.fullCommerceReasonCodes] : [],
        } : {}),
      };
    } catch (error) {
      result[provider] = {
        accepted: false,
        error: error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message) ? error.message : `${provider}_uat_validation_failed`,
      };
    }
  }
  return result;
}

export async function validateCommerceUatArtifacts(input) {
  try {
    const releaseId = input.evidence?.staging?.releaseId;
    const manifestPath = input.evidence?.staging?.manifestRef;
    if (typeof releaseId !== "string" || typeof manifestPath !== "string") {
      throw new Error("staging_deployment_binding_missing");
    }
    const deployment = await verifyStagingDeploymentEvidence({
      environment: input.environment ?? process.env,
      evidencePath: `.wrangler/releases/staging/${releaseId}/deployment-evidence.json`,
      manifestPath,
      now: input.now ?? new Date(),
      repositoryRoot: input.repositoryRoot,
    });
    if (input.evidence.staging.workerVersion !== deployment.workerVersion) {
      throw new Error("staging_deployment_claim_mismatch");
    }
    return validateCommerceUatArtifactsSync({
      ...input,
      trustedStagingWorkerVersion: deployment.workerVersion,
    });
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message)
      ? error.message
      : "staging_deployment_validation_failed";
    return {
      dodo: { accepted: false, error: code },
      payos: { accepted: false, error: code },
    };
  }
}
