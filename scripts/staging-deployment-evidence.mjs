import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectStagingDeploymentEvidence,
  writeStagingDeploymentEvidence,
} from "./lib/staging-deployment-evidence.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

export function parseArguments(argv) {
  const options = { json: false, manifestPath: null, write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--write") options.write = true;
    else if (argument === "--manifest") options.manifestPath = resolve(repositoryRoot, argv[++index] ?? "");
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (options.manifestPath === null) throw new Error("staging_deployment_manifest_required");
  return options;
}

export async function runStagingDeploymentEvidence(options, dependencies = {}) {
  const collector = dependencies.collectStagingDeploymentEvidenceImplementation
    ?? collectStagingDeploymentEvidence;
  const collected = await collector({
    environment: process.env,
    manifestPath: options.manifestPath,
    now: new Date(),
    repositoryRoot,
  });
  const written = options.write
    ? await (dependencies.writeStagingDeploymentEvidenceImplementation ?? writeStagingDeploymentEvidence)({
      artifact: collected.artifact,
      repositoryRoot,
    })
    : { artifactSha256: collected.artifactSha256, evidenceRef: collected.evidenceRef };
  return {
    artifactSha256: written.artifactSha256,
    deploymentId: collected.artifact.cloudflare.deploymentId,
    environment: "staging",
    evidenceRef: written.evidenceRef,
    mode: options.write ? "written" : "validated",
    ok: true,
    workerVersion: collected.artifact.cloudflare.workerVersion,
  };
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const output = await runStagingDeploymentEvidence(options);
    process.stdout.write(options.json
      ? `${JSON.stringify(output, null, 2)}\n`
      : `PASS staging deployment ${output.mode}: ${output.evidenceRef}\n`);
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message)
      ? error.message
      : "staging_deployment_evidence_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
