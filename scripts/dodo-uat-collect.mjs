import { lstat } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { collectDodoStagingUatEvidence, DODO_STAGING_UAT_SCENARIO_IDS } from "./lib/dodo-uat-evidence.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

function parseArguments(argv) {
  const options = { inputPath: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--input") options.inputPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument.startsWith("--input=")) options.inputPath = resolve(repositoryRoot, argument.slice("--input=".length));
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.inputPath === null) throw new Error("dodo_uat_input_required");
  const stat = await lstat(options.inputPath).catch(() => null);
  if (stat === null || !stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error("dodo_uat_input_permissions_invalid");
  const input = JSON.parse(await readFile(options.inputPath, "utf8"));
  const result = await collectDodoStagingUatEvidence({ ...input, repositoryRoot });
  const output = {
    accepted: true,
    artifactSha256: result.artifactSha256,
    evidenceRef: result.evidenceRef,
    releaseId: result.evidence.release.releaseId,
    scenarioCount: DODO_STAGING_UAT_SCENARIO_IDS.length,
  };
  process.stdout.write(options.json ? `${JSON.stringify(output, null, 2)}\n` : `PASS dodo staging UAT artifacts ${output.scenarioCount} scenarios ${output.releaseId}\n`);
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message)
    ? error.message
    : "dodo_uat_collection_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
