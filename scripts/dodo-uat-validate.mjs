import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  assertCanonicalDodoUatEvidencePath,
  assertDodoStagingUatEvidence,
  readDodoUatExecutionProofArtifacts,
} from "./lib/dodo-uat-evidence.mjs";
import { readTrustedStagingUatBinding } from "./lib/commerce-uat-evidence.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

function parseArguments(argv) {
  const options = {
    approvedKeyId: null,
    approvedSpkiSha256: null,
    evidencePath: resolve(repositoryRoot, ".wrangler/releases/staging/dodo-uat-evidence.json"),
    json: false,
    manifestPath: null,
    trustedPublicKeysPath: null,
    workerVersion: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--manifest") options.manifestPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--trusted-public-keys") options.trustedPublicKeysPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument.startsWith("--trusted-public-keys=")) options.trustedPublicKeysPath = resolve(repositoryRoot, argument.slice("--trusted-public-keys=".length));
    else if (argument === "--approved-key-id") options.approvedKeyId = argv[++index] ?? "";
    else if (argument.startsWith("--approved-key-id=")) options.approvedKeyId = argument.slice("--approved-key-id=".length);
    else if (argument === "--approved-spki-sha256") options.approvedSpkiSha256 = argv[++index] ?? "";
    else if (argument.startsWith("--approved-spki-sha256=")) options.approvedSpkiSha256 = argument.slice("--approved-spki-sha256=".length);
    else if (argument === "--worker-version") options.workerVersion = argv[++index] ?? "";
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

function exactKeys(value, expected, issue) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(issue);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) throw new Error(issue);
}

async function readTrustedPublicKeys(path) {
  const stat = await lstat(path).catch(() => null);
  if (stat === null || !stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("dodo_uat_trusted_public_keys_permissions_invalid");
  let keyring;
  try { keyring = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error("dodo_uat_trusted_public_keys_invalid"); }
  exactKeys(keyring, ["environment", "keys", "provider", "schemaVersion"], "dodo_uat_trusted_public_keys_invalid");
  if (keyring.schemaVersion !== 1 || keyring.environment !== "staging" || keyring.provider !== "dodo"
    || !Array.isArray(keyring.keys) || keyring.keys.length === 0) throw new Error("dodo_uat_trusted_public_keys_invalid");
  const result = {};
  for (const entry of keyring.keys) {
    exactKeys(entry, ["keyId", "publicKeyPem"], "dodo_uat_trusted_public_keys_invalid");
    if (typeof entry.keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(entry.keyId)
      || typeof entry.publicKeyPem !== "string"
      || !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/u.test(entry.publicKeyPem)
      || Object.prototype.hasOwnProperty.call(result, entry.keyId)) throw new Error("dodo_uat_trusted_public_keys_invalid");
    result[entry.keyId] = entry.publicKeyPem;
  }
  return result;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.manifestPath === null) throw new Error("dodo_uat_manifest_required");
  if (options.workerVersion === null || options.workerVersion.length === 0) throw new Error("dodo_uat_worker_version_required");
  const evidenceStat = await lstat(options.evidencePath).catch(() => null);
  if (evidenceStat === null || !evidenceStat.isFile() || (evidenceStat.mode & 0o777) !== 0o600) {
    throw new Error("dodo_uat_evidence_permissions_invalid");
  }
  if (options.trustedPublicKeysPath === null) throw new Error("dodo_uat_trusted_public_keys_required");
  if (options.approvedKeyId === null || options.approvedSpkiSha256 === null) {
    throw new Error("dodo_uat_approved_execution_proof_trust_required");
  }
  const approvedExecutionProofTrust = {
    keyId: options.approvedKeyId,
    spkiSha256: options.approvedSpkiSha256,
  };
  const evidence = JSON.parse(await readFile(options.evidencePath, "utf8"));
  assertCanonicalDodoUatEvidencePath({
    evidencePath: options.evidencePath,
    releaseId: evidence?.release?.releaseId,
    repositoryRoot,
  });
  const binding = await readTrustedStagingUatBinding({
    evidence,
    manifestPath: options.manifestPath,
    repositoryRoot,
    workerVersion: options.workerVersion,
  });
  const executionProofPublicKeys = await readTrustedPublicKeys(options.trustedPublicKeysPath);
  const verifiedExecutionProofs = readDodoUatExecutionProofArtifacts({
    approvedExecutionProofTrust,
    evidence,
    executionProofPublicKeys,
    repositoryRoot,
  });
  const result = assertDodoStagingUatEvidence(evidence, {
    ...binding,
    approvedExecutionProofTrust,
    verifiedExecutionProofs,
  });
  const output = {
    accepted: result.accepted,
    evidenceFingerprintSha256: result.evidenceFingerprintSha256,
    releaseId: result.releaseId,
    scenarioCount: result.scenarioCount,
    workerVersion: result.workerVersion,
  };
  process.stdout.write(options.json ? `${JSON.stringify(output, null, 2)}\n` : `PASS dodo staging UAT ${result.scenarioCount} scenarios ${result.releaseId}\n`);
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message)
    ? error.message
    : "dodo_uat_validation_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
