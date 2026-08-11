import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { assertDodoStagingUatEvidence, readDodoUatScenarioArtifacts } from "./lib/dodo-uat-evidence.mjs";
import { readTrustedStagingUatBinding } from "./lib/commerce-uat-evidence.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

function parseArguments(argv) {
  const options = {
    evidencePath: resolve(repositoryRoot, ".wrangler/releases/staging/dodo-uat-evidence.json"),
    json: false,
    manifestPath: null,
    workerVersion: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--manifest") options.manifestPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--worker-version") options.workerVersion = argv[++index] ?? "";
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.manifestPath === null) throw new Error("dodo_uat_manifest_required");
  if (options.workerVersion === null || options.workerVersion.length === 0) throw new Error("dodo_uat_worker_version_required");
  const evidenceStat = await lstat(options.evidencePath).catch(() => null);
  if (evidenceStat === null || !evidenceStat.isFile() || (evidenceStat.mode & 0o777) !== 0o600) {
    throw new Error("dodo_uat_evidence_permissions_invalid");
  }
  const evidence = JSON.parse(await readFile(options.evidencePath, "utf8"));
  const binding = await readTrustedStagingUatBinding({
    evidence,
    manifestPath: options.manifestPath,
    repositoryRoot,
    workerVersion: options.workerVersion,
  });
  const scenarioArtifactFingerprints = readDodoUatScenarioArtifacts({ evidence, repositoryRoot });
  const result = assertDodoStagingUatEvidence(evidence, {
    ...binding,
    requireArtifactProof: true,
    scenarioArtifactFingerprints,
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
