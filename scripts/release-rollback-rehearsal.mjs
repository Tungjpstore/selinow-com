import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import process from "node:process";
import { resolve } from "node:path";

import {
  buildProductionRollbackRehearsalArtifact,
  listMigrationNames,
  readOptionalJson,
  writeProductionRollbackRehearsalArtifact,
} from "./lib/release.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

function parseArguments(argv) {
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

try {
  const options = parseArguments(process.argv.slice(2));
  const evidence = await readOptionalJson(options.evidencePath);
  if (evidence === null) throw new Error("production_evidence_missing");
  const migrationNames = await listMigrationNames();
  const input = { evidence, migrationNames, now: new Date(), repositoryRoot };
  const artifact = buildProductionRollbackRehearsalArtifact(input);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  const result = options.write
    ? await writeProductionRollbackRehearsalArtifact(input)
    : {
      artifactSha256: createHash("sha256").update(bytes).digest("hex"),
      evidenceRef: `.wrangler/releases/${evidence.releaseId}/rollback-rehearsal.json`,
    };
  const output = {
    artifactSha256: result.artifactSha256,
    environment: "production",
    evidenceRef: result.evidenceRef,
    mode: options.write ? "written" : "validated",
    ok: true,
  };
  process.stdout.write(options.json ? `${JSON.stringify(output, null, 2)}\n` : `PASS rollback rehearsal ${output.mode}: ${output.evidenceRef}\n`);
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message)
    ? error.message
    : "production_rollback_rehearsal_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
