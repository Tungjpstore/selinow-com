import process from "node:process";

import { createBackup } from "./lib/backup.mjs";
import { parseFlags, writeOutput } from "./lib/cli.mjs";

try {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.environment === "production" && !flags.confirmProduction) {
    throw new Error("production_confirmation_required");
  }
  const result = await createBackup({
    dryRun: flags.dryRun,
    environment: flags.environment,
  });
  writeOutput(result, flags.json);
} catch (error) {
  const message = error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message)
    ? error.message
    : "backup_failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
