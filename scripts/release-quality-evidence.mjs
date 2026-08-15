import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectReleaseQualityEvidence,
  writeReleaseQualityEvidence,
} from "./lib/release-quality-evidence.mjs";
import { readOptionalJson } from "./lib/release.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

export function parseArguments(argv) {
  const options = {
    evidencePath: resolve(repositoryRoot, ".wrangler/release/production-evidence.json"),
    json: false,
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--json") options.json = true;
    else if (argument === "--write") options.write = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}
export async function runReleaseQualityEvidence(options, dependencies = {}) {
  const evidence = await (dependencies.readOptionalJsonImplementation ?? readOptionalJson)(options.evidencePath);
  if (evidence === null) throw new Error("production_evidence_missing");
  const collected = await (dependencies.collectReleaseQualityEvidenceImplementation ?? collectReleaseQualityEvidence)({
    evidence,
    repositoryRoot,
  });
  const written = options.write
    ? await (dependencies.writeReleaseQualityEvidenceImplementation ?? writeReleaseQualityEvidence)({
      collected,
      evidence,
      evidencePath: options.evidencePath,
      repositoryRoot,
    })
    : { artifactSha256: collected.artifactSha256, evidenceRef: collected.evidenceRef };
  return {
    artifactSha256: written.artifactSha256,
    environment: "production",
    evidenceRef: written.evidenceRef,
    mode: options.write ? "written" : "validated",
    ok: true,
  };
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await runReleaseQualityEvidence(options);
    process.stdout.write(options.json
      ? `${JSON.stringify(result, null, 2)}\n`
      : `PASS production quality evidence ${result.mode}: ${result.evidenceRef}\n`);
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message)
      ? error.message
      : "release_quality_evidence_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
