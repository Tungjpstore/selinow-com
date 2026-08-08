import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { assertDodoStagingUatEvidence } from "./lib/dodo-uat-evidence.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

function parseArguments(argv) {
  const options = {
    evidencePath: resolve(repositoryRoot, ".wrangler/releases/staging/dodo-uat-evidence.json"),
    json: false,
    binding: {},
  };
  const bindingFlags = new Map([
    ["--commit", "commitSha"],
    ["--tree", "treeSha"],
    ["--release-id", "releaseId"],
    ["--manifest-ref", "manifestRef"],
    ["--manifest-sha256", "manifestSha256"],
    ["--worker-version", "workerVersion"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (bindingFlags.has(argument)) options.binding[bindingFlags.get(argument)] = argv[++index] ?? "";
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const requiredBindingKeys = ["commitSha", "treeSha", "releaseId", "manifestRef", "manifestSha256", "workerVersion"];
  if (requiredBindingKeys.some((key) => typeof options.binding[key] !== "string" || options.binding[key].length === 0)) {
    throw new Error("dodo_uat_release_binding_required");
  }
  const evidence = JSON.parse(await readFile(options.evidencePath, "utf8"));
  const result = assertDodoStagingUatEvidence(evidence, options.binding);
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
