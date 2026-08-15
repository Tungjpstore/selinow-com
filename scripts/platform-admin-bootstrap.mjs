import process from "node:process";
import { randomUUID } from "node:crypto";

import { runWrangler, writeOutput } from "./lib/cli.mjs";
import { repositoryRoot } from "./lib/platform.mjs";
import {
  parsePlatformAdminBootstrapFlags,
  runPlatformAdminBootstrap,
  safePlatformAdminBootstrapErrorCode,
} from "./lib/platform-admin-bootstrap.mjs";

try {
  const flags = parsePlatformAdminBootstrapFlags(process.argv.slice(2));
  const workerSecretNames = (process.env.SELINOW_WORKER_SECRET_NAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const result = await runPlatformAdminBootstrap({
    environment: process.env,
    flags,
    repositoryRoot,
    requestId: randomUUID(),
    runner: runWrangler,
    workerSecretNames,
  });
  writeOutput(result, flags.json);
} catch (error) {
  const safeCode = safePlatformAdminBootstrapErrorCode(error);
  writeOutput({ actions: [{ code: safeCode, ok: false }], environment: "unknown", ok: false }, process.argv.includes("--json"));
  process.exitCode = 1;
}
