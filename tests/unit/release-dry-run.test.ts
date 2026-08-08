import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const scriptPath = resolve(repositoryRoot, "scripts/release-dry-run.mjs");

const expectedSteps = [
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
] as const;

describe("production release dry-run", () => {
  it("plans every required gate in exact sequential order with doctor last", () => {
    const output = execFileSync(process.execPath, [scriptPath, "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
    const result = JSON.parse(output) as {
      actions: Array<{ args: string[]; code: string; command: string; name: string; ok: boolean }>;
    };

    expect(result.actions).toEqual(expectedSteps.map((step) => ({
      ...step,
      code: "would_run",
      ok: true,
    })));
  });

  it("executes and prints the exact command transcript in the planned order", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-release-dry-run-"));
    const bin = join(root, "bin");
    const logPath = join(root, "commands.log");
    await mkdir(bin, { recursive: true });
    const shim = "#!/bin/sh\nprintf '%s\\n' \"${0##*/} $*\" >> \"$SELINOW_RELEASE_TEST_LOG\"\n";
    await Promise.all(["git", "node", "npm", "npx"].map(async (command) => {
      const path = join(bin, command);
      await writeFile(path, shim);
      await chmod(path, 0o755);
    }));

    try {
      const output = execFileSync(process.execPath, [scriptPath, "--execute"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          SELINOW_RELEASE_TEST_LOG: logPath,
        },
      });
      const commands = (await readFile(logPath, "utf8")).trim().split("\n");

      expect(commands).toEqual(expectedSteps.map((step) => [step.command, ...step.args].join(" ")));
      expect(output.trim().split("\n")).toEqual([
        ...expectedSteps.map((step) => `RUN ${step.name}: ${[step.command, ...step.args].join(" ")}`),
        "PASS production dry-run",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
