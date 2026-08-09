import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import process from "node:process";

import { readTrustedStagingUatBinding } from "./lib/commerce-uat-evidence.mjs";
import { evaluatePayosStagingUatEvidence } from "./lib/payos-uat-evidence.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

function parseArguments(argv) {
  const options = {
    evidencePath: resolve(repositoryRoot, ".wrangler/releases/staging/payos-uat-evidence.json"),
    json: false,
    manifestPath: null,
    ownerAttestationKeyId: null,
    ownerAttestationPublicKeyPath: null,
    workerVersion: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--manifest") options.manifestPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--owner-attestation-key-id") options.ownerAttestationKeyId = argv[++index] ?? "";
    else if (argument === "--owner-attestation-public-key") options.ownerAttestationPublicKeyPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--worker-version") options.workerVersion = argv[++index] ?? "";
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

async function loadOwnerAttestationPublicKeys(options) {
  const keyId = options.ownerAttestationKeyId ?? process.env.SELINOW_PAYOS_UAT_ATTESTATION_KEY_ID ?? null;
  if (options.ownerAttestationPublicKeyPath !== null) {
    if (keyId === null || keyId.length === 0) throw new Error("payos_uat_owner_attestation_key_id_required");
    return { [keyId]: await readFile(options.ownerAttestationPublicKeyPath, "utf8") };
  }
  const encoded = process.env.SELINOW_PAYOS_UAT_ATTESTATION_PUBLIC_KEY_PEM_BASE64;
  if (keyId !== null && keyId.length > 0 && typeof encoded === "string" && encoded.length > 0) {
    return { [keyId]: Buffer.from(encoded, "base64").toString("utf8") };
  }
  return {};
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.manifestPath === null) throw new Error("payos_uat_manifest_required");
  if (options.workerVersion === null || options.workerVersion.length === 0) throw new Error("payos_uat_worker_version_required");
  const evidence = JSON.parse(await readFile(options.evidencePath, "utf8"));
  const binding = await readTrustedStagingUatBinding({ evidence, manifestPath: options.manifestPath, repositoryRoot, workerVersion: options.workerVersion });
  const result = evaluatePayosStagingUatEvidence(evidence, {
    ...binding,
    ownerAttestationPublicKeys: await loadOwnerAttestationPublicKeys(options),
  });
  const output = {
    accepted: result.accepted,
    acceptanceReasonCode: result.acceptanceReasonCode,
    evidenceFingerprintSha256: result.evidenceFingerprintSha256,
    evidenceKind: result.evidenceKind,
    localScenarioCount: result.localScenarioCount,
    providerScenarioCount: result.providerScenarioCount,
    releaseId: result.releaseId,
    scenarioCount: result.scenarioCount,
    unsupportedReasonCodes: result.unsupportedReasonCodes,
    unsupportedScenarioCount: result.unsupportedScenarioCount,
    workerVersion: result.workerVersion,
  };
  if (!result.accepted) {
    if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else process.stderr.write(`BLOCKED payos staging UAT ${result.acceptanceReasonCode} ${result.releaseId}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(options.json ? `${JSON.stringify(output, null, 2)}\n` : `PASS payos staging UAT ${result.providerScenarioCount} provider + ${result.localScenarioCount} local scenarios ${result.releaseId}\n`);
  }
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message) ? error.message : "payos_uat_validation_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
