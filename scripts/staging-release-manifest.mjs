import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { assertFreshStagingContinuationEvidence, resolveDatabaseTarget } from "./lib/backup.mjs";
import { repositoryRoot } from "./lib/platform.mjs";
import {
  buildStagingReleaseManifest,
  writeStagingReleaseManifest,
} from "./lib/staging-release.mjs";

function parseArguments(argv) {
  const options = { json: false, write: false };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument === "--write") options.write = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const [manifest, stagingSpec, wranglerConfig] = await Promise.all([
    buildStagingReleaseManifest({ repositoryRoot }),
    readFile(resolve(repositoryRoot, "infra/environments/staging.json"), "utf8").then((value) => JSON.parse(value)),
    readFile(resolve(repositoryRoot, "wrangler.jsonc"), "utf8").then((value) => JSON.parse(value)),
  ]);
  if (stagingSpec?.environment !== "staging" || typeof stagingSpec.accountId !== "string") {
    throw new Error("staging_release_spec_invalid");
  }
  const target = resolveDatabaseTarget(wranglerConfig, "staging");
  await assertFreshStagingContinuationEvidence({
    accountId: stagingSpec.accountId,
    databaseId: target.databaseId,
    databaseName: target.databaseName,
    repositoryRoot,
    reviewedCommitSha: manifest.commitSha,
  });
  const manifestRef = options.write ? await writeStagingReleaseManifest(manifest, repositoryRoot) : null;
  const result = {
    environment: "staging",
    manifestRef,
    mode: options.write ? "written" : "validated",
    ok: true,
    releaseId: manifest.releaseId,
  };
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `PASS staging ${result.mode}\n`);
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message)
    ? error.message
    : "staging_release_manifest_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
