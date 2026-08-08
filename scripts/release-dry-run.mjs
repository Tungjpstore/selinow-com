import { spawnSync } from "node:child_process";
import process from "node:process";

const STEPS = [
  { args: ["run", "check"], command: "npm", name: "type_check" },
  { args: ["run", "lint"], command: "npm", name: "lint" },
  { args: ["tsc", "--noEmit"], command: "npx", name: "typescript_no_emit" },
  { args: ["run", "test"], command: "npm", name: "tests" },
  { args: ["run", "build"], command: "npm", name: "build" },
  { args: ["run", "build:staging"], command: "npm", name: "staging_build" },
  { args: ["audit", "--audit-level=high"], command: "npm", name: "audit_high" },
  { args: ["run", "deploy:dry-run"], command: "npm", name: "deploy_dry_run" },
  { args: ["run", "deploy:staging:dry-run"], command: "npm", name: "staging_deploy_dry_run" },
  { args: ["diff", "--check"], command: "git", name: "git_diff_check" },
  { args: ["scripts/backup.mjs", "--env", "production", "--dry-run", "--confirm-production", "--json"], command: "node", name: "backup_plan" },
  { args: ["scripts/restore-drill.mjs", "--env", "production", "--dry-run", "--confirm-production", "--json"], command: "node", name: "restore_drill_plan" },
  { args: ["scripts/db.mjs", "preflight", "--env", "production", "--dry-run", "--confirm-production", "--json"], command: "node", name: "database_preflight_plan" },
  { args: ["scripts/db.mjs", "status", "--env", "production", "--dry-run", "--confirm-production", "--json"], command: "node", name: "migration_status_plan" },
  { args: ["scripts/deploy.mjs", "--env", "production", "--dry-run", "--confirm-production"], command: "node", name: "worker_deploy_dry_run" },
  { args: ["scripts/release-doctor.mjs", "--json"], command: "node", name: "production_config_doctor" },
];

function formatCommand(step) {
  return [step.command, ...step.args].join(" ");
}

function parseArguments(argv) {
  const options = { execute: false, json: false };
  for (const argument of argv) {
    if (argument === "--execute") options.execute = true;
    else if (argument === "--json") options.json = true;
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

function writePlan(json) {
  const result = {
    actions: STEPS.map((step) => ({
      args: [...step.args],
      code: "would_run",
      command: step.command,
      name: step.name,
      ok: true,
    })),
    environment: "production",
    executed: false,
    ok: true,
  };
  process.stdout.write(json
    ? `${JSON.stringify(result, null, 2)}\n`
    : `${STEPS.map((step) => `= ${step.name}: ${formatCommand(step)}`).join("\n")}\n`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (!options.execute) {
    writePlan(options.json);
  } else {
    for (const step of STEPS) {
      process.stdout.write(`RUN ${step.name}: ${formatCommand(step)}\n`);
      const result = spawnSync(step.command, step.args, { encoding: "utf8", stdio: "inherit" });
      if (result.error || result.status !== 0) throw new Error(`release_dry_run_step_failed:${step.name}`);
    }
    process.stdout.write("PASS production dry-run\n");
  }
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message)
    ? error.message
    : "release_dry_run_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
