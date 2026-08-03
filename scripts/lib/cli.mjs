import { spawnSync } from "node:child_process";
import process from "node:process";

export function parseFlags(argv) {
  const flags = {
    buildOnly: false,
    confirmProduction: false,
    dryRun: false,
    environment: "local",
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      flags.dryRun = true;
    } else if (argument === "--json") {
      flags.json = true;
    } else if (argument === "--build-only") {
      flags.buildOnly = true;
    } else if (argument === "--confirm-production") {
      flags.confirmProduction = true;
    } else if (argument === "--env") {
      flags.environment = argv[index + 1] ?? "";
      index += 1;
    } else if (argument.startsWith("--env=")) {
      flags.environment = argument.slice("--env=".length);
    } else {
      throw new Error(`unknown_argument:${argument}`);
    }
  }

  if (!new Set(["local", "staging", "production"]).has(flags.environment)) {
    throw new Error(`unsupported_environment:${flags.environment}`);
  }

  return flags;
}

export function parseDeployFlags(argv) {
  const deployArgv = [];
  let releaseManifestPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--release-manifest") {
      if (releaseManifestPath !== null) throw new Error("production_release_manifest_duplicate");
      releaseManifestPath = argv[index + 1] ?? "";
      index += 1;
    } else if (argument.startsWith("--release-manifest=")) {
      if (releaseManifestPath !== null) throw new Error("production_release_manifest_duplicate");
      releaseManifestPath = argument.slice("--release-manifest=".length);
    } else {
      deployArgv.push(argument);
    }
  }

  const hasExplicitEnvironment = argv.some((argument) => (
    argument === "--env" || argument.startsWith("--env=")
  ));
  if (!hasExplicitEnvironment) throw new Error("deploy_environment_required");

  const flags = parseFlags(deployArgv);
  if (flags.environment === "local" && !flags.dryRun && !flags.buildOnly) {
    throw new Error("remote_deploy_target_required");
  }
  if (flags.environment === "production" && !flags.confirmProduction) {
    throw new Error("production_confirmation_required");
  }
  const requiresReleaseManifest = (flags.environment === "production" || flags.environment === "staging")
    && !flags.dryRun
    && !flags.buildOnly;
  if (requiresReleaseManifest && !releaseManifestPath) {
    throw new Error(flags.environment === "production"
      ? "production_release_manifest_required"
      : "staging_release_manifest_required");
  }
  return { ...flags, releaseManifestPath };
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    stdio: options.capture === false ? "inherit" : "pipe",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const safeOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(`command_failed:${command}:${args[0] ?? "unknown"}:${safeOutput}`);
  }

  return {
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

export function runWrangler(args, options = {}) {
  return run("npx", ["--no-install", "wrangler", ...args], options);
}

export function writeOutput(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  const status = value.ok ? "PASS" : "FAIL";
  process.stdout.write(`${status} ${value.environment}\n`);
  for (const action of value.actions ?? value.checks ?? []) {
    const marker = action.ok === false ? "x" : action.action === "create" ? "+" : "=";
    process.stdout.write(`${marker} ${action.code ?? action.type ?? "step"}: ${action.detail ?? action.name ?? ""}\n`);
  }
}
