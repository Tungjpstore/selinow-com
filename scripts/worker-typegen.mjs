import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { normalizeWorkerTypes } from "./lib/worker-typegen.mjs";

function parseArguments(argv) {
  const options = { environment: null, output: resolve("worker-configuration.d.ts") };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--env") options.environment = argv[++index] ?? "";
    else if (argument === "--output") options.output = resolve(argv[++index] ?? "");
    else throw new Error("worker_typegen_argument_invalid");
  }
  if (options.environment !== null && !/^[a-z][a-z0-9_-]{0,31}$/u.test(options.environment)) {
    throw new Error("worker_typegen_environment_invalid");
  }
  return options;
}

const options = parseArguments(process.argv.slice(2));
const temporaryDirectory = await mkdtemp(join(tmpdir(), "selinow-worker-typegen-"));
const temporaryOutput = join(temporaryDirectory, "worker-configuration.d.ts");
try {
  const wranglerArguments = ["wrangler", "types", temporaryOutput];
  if (options.environment !== null) wranglerArguments.push("--env", options.environment);
  const generated = spawnSync("npx", wranglerArguments, { encoding: "utf8", stdio: ["ignore", "inherit", "inherit"] });
  if (generated.error !== undefined || generated.status !== 0) throw new Error("worker_typegen_wrangler_failed");
  const source = await readFile(temporaryOutput, "utf8");
  await writeFile(options.output, normalizeWorkerTypes(source), { encoding: "utf8", mode: 0o644 });
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}
