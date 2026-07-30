import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  buildReleaseArtifacts,
  listMigrationNames,
  readOptionalJson,
  writeReleaseArtifacts,
} from "./lib/release.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

function parseArguments(argv) {
  const options = {
    evidencePath: resolve(repositoryRoot, ".wrangler/release/production-evidence.json"),
    json: false,
    specPath: resolve(repositoryRoot, "infra/environments/production.json"),
    write: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--write") options.write = true;
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--spec") options.specPath = resolve(repositoryRoot, argv[++index] ?? "");
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const [wranglerConfig, packageJson, productionSpec, evidence, migrationNames] = await Promise.all([
    readFile(resolve(repositoryRoot, "wrangler.jsonc"), "utf8").then((text) => JSON.parse(text)),
    readFile(resolve(repositoryRoot, "package.json"), "utf8").then((text) => JSON.parse(text)),
    readOptionalJson(options.specPath),
    readOptionalJson(options.evidencePath),
    listMigrationNames(),
  ]);
  if (productionSpec === null) throw new Error("production_spec_missing");
  if (evidence === null) throw new Error("production_evidence_missing");
  const workerSecretNames = (process.env.SELINOW_WORKER_SECRET_NAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const artifacts = buildReleaseArtifacts({
    evidence,
    migrationNames,
    now: new Date(),
    packageVersion: String(packageJson.version ?? "unknown"),
    productionSpec,
    workerSecretNames,
    wranglerConfig,
  });
  const refs = options.write ? await writeReleaseArtifacts(artifacts) : null;
  const result = {
    artifacts: ["release-manifest.json", "rollback-matrix.json"],
    environment: "production",
    mode: options.write ? "written" : "validated",
    ok: true,
    ...(refs === null ? {} : refs),
  };
  process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `PASS production ${result.mode}\n`);
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message)
    ? error.message
    : "release_manifest_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
