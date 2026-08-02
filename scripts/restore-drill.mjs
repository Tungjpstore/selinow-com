import process from "node:process";

import { runRestoreDrill } from "./lib/backup.mjs";
import { parseFlags, writeOutput } from "./lib/cli.mjs";

function parseReviewedCommit(argv) {
  const remaining = [];
  let reviewedCommitSha = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--reviewed-commit") {
      if (reviewedCommitSha !== null) throw new Error("restore_reviewed_commit_duplicate");
      reviewedCommitSha = argv[++index] ?? "";
      continue;
    }
    if (argument.startsWith("--reviewed-commit=")) {
      if (reviewedCommitSha !== null) throw new Error("restore_reviewed_commit_duplicate");
      reviewedCommitSha = argument.slice("--reviewed-commit=".length);
      continue;
    }
    remaining.push(argument);
  }
  if (reviewedCommitSha !== null && !/^[a-f0-9]{40}$/u.test(reviewedCommitSha)) {
    throw new Error("restore_reviewed_commit_invalid");
  }
  return { remaining, reviewedCommitSha };
}

try {
  const reviewed = parseReviewedCommit(process.argv.slice(2));
  const flags = parseFlags(reviewed.remaining);
  if (flags.environment === "production" && !flags.confirmProduction) {
    throw new Error("production_confirmation_required");
  }
  const result = await runRestoreDrill({
    dryRun: flags.dryRun,
    environment: flags.environment,
    reviewedCommitSha: reviewed.reviewedCommitSha ?? undefined,
  });
  writeOutput(result, flags.json);
} catch (error) {
  const message = error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message)
    ? error.message
    : "restore_drill_failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
