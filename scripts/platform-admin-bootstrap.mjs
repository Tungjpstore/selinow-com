import process from "node:process";
import { randomUUID } from "node:crypto";

import { runWrangler, writeOutput } from "./lib/cli.mjs";
import { parsePlatformAdminBootstrapFlags, runPlatformAdminBootstrap } from "./lib/platform-admin-bootstrap.mjs";

try {
  const flags = parsePlatformAdminBootstrapFlags(process.argv.slice(2));
  const result = runPlatformAdminBootstrap({ flags, requestId: randomUUID(), runner: runWrangler });
  writeOutput(result, flags.json);
} catch (error) {
  const message = error instanceof Error ? error.message : "platform_admin_bootstrap_failed";
  const safeCode = /^[a-z0-9_.:-]{1,128}$/u.test(message) ? message : "platform_admin_bootstrap_failed";
  writeOutput({ actions: [{ code: safeCode, ok: false }], environment: "unknown", ok: false }, process.argv.includes("--json"));
  process.exitCode = 1;
}
