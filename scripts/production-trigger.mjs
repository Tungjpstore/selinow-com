import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { resolve } from "node:path";

import { writeOutput } from "./lib/cli.mjs";
import {
  compensateProductionTriggerCeremony,
  deriveProductionTriggerConfig,
  discoverProductionTriggerInventory,
  executeProductionTriggerCeremony,
  fingerprintProductionTrigger,
  productionTriggerSchedulePath,
  validateProductionTriggerReleaseManifest,
} from "./lib/production-trigger-ceremony.mjs";
import { cloudflareApiRequest, repositoryRoot } from "./lib/platform.mjs";

const DEFAULT_SPEC_PATH = resolve(repositoryRoot, "infra/environments/production.json");
const DEFAULT_CONFIG_PATH = resolve(repositoryRoot, "wrangler.jsonc");
const DEFAULT_EVIDENCE_PATH = resolve(repositoryRoot, ".wrangler/production-triggers/evidence.json");
const DEFAULT_RELEASE_EVIDENCE_PATH = resolve(repositoryRoot, ".wrangler/release/production-evidence.json");
const AUDIT_TOKEN_NAME = "CLOUDFLARE_PRODUCTION_TRIGGER_AUDIT_API_TOKEN";
const MUTATION_TOKEN_NAME = "CLOUDFLARE_PRODUCTION_TRIGGER_MUTATION_API_TOKEN";
const WRANGLER_TOKEN_NAME = "CLOUDFLARE_PRODUCTION_TRIGGER_WRANGLER_API_TOKEN";
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;

function parseArguments(argv) {
  const options = {
    apply: false,
    configPath: DEFAULT_CONFIG_PATH,
    confirmProduction: false,
    dryRun: false,
    evidencePath: DEFAULT_EVIDENCE_PATH,
    json: false,
    releaseEvidencePath: DEFAULT_RELEASE_EVIDENCE_PATH,
    rollback: false,
    specPath: DEFAULT_SPEC_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--rollback") options.rollback = true;
    else if (argument === "--confirm-production") options.confirmProduction = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument.startsWith("--evidence=")) options.evidencePath = resolve(repositoryRoot, argument.slice("--evidence=".length));
    else if (argument === "--spec") options.specPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument.startsWith("--spec=")) options.specPath = resolve(repositoryRoot, argument.slice("--spec=".length));
    else if (argument === "--config") options.configPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument.startsWith("--config=")) options.configPath = resolve(repositoryRoot, argument.slice("--config=".length));
    else if (argument === "--release-evidence") options.releaseEvidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument.startsWith("--release-evidence=")) options.releaseEvidencePath = resolve(repositoryRoot, argument.slice("--release-evidence=".length));
    else if (argument === "--plan") {
      // The default mode is already a read-only exact-diff plan.
    } else {
      throw new Error(`unknown_argument:${argument}`);
    }
  }
  if (options.apply && options.rollback) throw new Error("production_trigger_operation_conflict");
  if ((options.apply || options.rollback) && !options.confirmProduction) {
    throw new Error("production_trigger_confirmation_required");
  }
  if (options.rollback && options.dryRun) throw new Error("production_trigger_rollback_dry_run_conflict");
  return options;
}

function requireToken(name, environment = process.env) {
  const token = typeof environment?.[name] === "string" ? environment[name].trim() : "";
  if (!token) throw new Error(`${name.toLowerCase()}_missing`);
  return token;
}

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(code);
  }
}

async function readJson(path, code) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(code);
  }
  return parseJson(text, code);
}

function runGit(args, code) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(code);
  return result.stdout.trim();
}

function readRepositoryState() {
  return {
    clean: runGit(["status", "--porcelain=v1", "--untracked-files=normal"], "production_trigger_git_status_failed") === "",
    commitSha: runGit(["rev-parse", "--verify", "HEAD"], "production_trigger_git_commit_failed"),
    treeSha: runGit(["rev-parse", "--verify", "HEAD^{tree}"], "production_trigger_git_tree_failed"),
  };
}

async function readReleaseBinding(evidencePath, releaseConfigFingerprintSha256) {
  const evidence = await readJson(evidencePath, "production_trigger_release_evidence_missing");
  if (typeof evidence?.releaseId !== "string" || !RELEASE_ID_PATTERN.test(evidence.releaseId)) {
    throw new Error("production_trigger_release_id_invalid");
  }
  const manifestRef = `.wrangler/releases/${String(evidence?.releaseId ?? "")}/release-manifest.json`;
  const manifestPath = resolve(repositoryRoot, manifestRef);
  let manifestText;
  try {
    manifestText = await readFile(manifestPath, "utf8");
  } catch {
    throw new Error("production_trigger_release_manifest_missing");
  }
  const manifest = parseJson(manifestText, "production_trigger_release_manifest_invalid");
  return validateProductionTriggerReleaseManifest({
    evidence,
    manifest,
    manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
    releaseConfigFingerprintSha256,
    repositoryState: readRepositoryState(),
  });
}

function buildRunnerOptions(spec, environment, mutationToken, auditToken) {
  const wranglerToken = mutationToken
    || (typeof environment?.[WRANGLER_TOKEN_NAME] === "string" ? environment[WRANGLER_TOKEN_NAME].trim() : "")
    || auditToken;
  if (!wranglerToken) throw new Error("production_trigger_wrangler_token_missing");
  const childEnvironment = {};
  for (const name of ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NO_COLOR", "PATH", "SHELL", "SSL_CERT_DIR", "SSL_CERT_FILE", "TERM", "TMPDIR"]) {
    if (typeof environment?.[name] === "string") childEnvironment[name] = environment[name];
  }
  return {
    cwd: repositoryRoot,
    env: {
      ...childEnvironment,
      CLOUDFLARE_ACCOUNT_ID: spec.accountId,
      CLOUDFLARE_API_TOKEN: wranglerToken,
    },
  };
}

function triggerShape(value) {
  return {
    activeWorkerVersion: value.activeWorkerVersion,
    queueConsumers: value.queueConsumers,
    schedules: value.schedules,
  };
}

async function runRollback({ configFingerprintSha256, evidencePath, environment, productionConfig, releaseBinding, spec }) {
  const evidence = await readJson(evidencePath, "production_trigger_evidence_missing");
  if (evidence?.configFingerprintSha256 !== configFingerprintSha256) {
    throw new Error("production_trigger_evidence_config_mismatch");
  }
  if (fingerprintProductionTrigger(evidence?.release) !== fingerprintProductionTrigger(releaseBinding)) {
    throw new Error("production_trigger_evidence_release_mismatch");
  }
  const auditToken = requireToken(AUDIT_TOKEN_NAME, environment);
  const mutationToken = requireToken(MUTATION_TOKEN_NAME, environment);
  const runnerOptions = buildRunnerOptions(spec, environment, mutationToken, auditToken);
  const discover = (context) => discoverProductionTriggerInventory({
    ...context,
    auditToken,
    configFingerprintSha256: evidence.configFingerprintSha256,
    runnerOptions,
    spec,
  });
  const current = await discover({});
  const result = await compensateProductionTriggerCeremony({
    confirmProduction: true,
    currentInventory: current,
    evidence,
    mutationToken,
    requestSchedulesImplementation: cloudflareApiRequest,
    runnerOptions,
    runWranglerImplementation: undefined,
    schedulePath: productionTriggerSchedulePath(spec),
    spec,
  });
  const after = await discover({});
  if (fingerprintProductionTrigger(triggerShape(after)) !== fingerprintProductionTrigger(evidence.before)) {
    throw new Error("production_trigger_rollback_verification_failed");
  }
  return {
    accountId: productionConfig.accountId,
    after: triggerShape(after),
    environment: "production",
    evidencePath,
    executed: result.executed,
    ok: true,
    workerName: productionConfig.workerName,
  };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const [productionSpec, wranglerConfig] = await Promise.all([
    readJson(options.specPath, "production_trigger_spec_missing"),
    readJson(options.configPath, "production_trigger_wrangler_config_missing"),
  ]);
  const config = deriveProductionTriggerConfig(productionSpec, wranglerConfig);
  const releaseBinding = await readReleaseBinding(
    options.releaseEvidencePath,
    config.releaseConfigFingerprintSha256,
  );
  const environment = process.env;
  if (options.rollback) {
    const result = await runRollback({
      configFingerprintSha256: config.configFingerprintSha256,
      evidencePath: options.evidencePath,
      environment,
      productionConfig: productionSpec,
      releaseBinding,
      spec: config.spec,
    });
    writeOutput(result, options.json);
  } else {
    const auditToken = requireToken(AUDIT_TOKEN_NAME, environment);
    const willApply = options.apply && !options.dryRun;
    const mutationToken = willApply
      ? requireToken(MUTATION_TOKEN_NAME, environment)
      : null;
    const runnerOptions = buildRunnerOptions(config.spec, environment, mutationToken, auditToken);
    const result = await executeProductionTriggerCeremony({
      apply: willApply,
      auditToken,
      confirmProduction: options.confirmProduction,
      configFingerprintSha256: config.configFingerprintSha256,
      evidencePath: options.evidencePath,
      mutationToken,
      requestSchedulesImplementation: cloudflareApiRequest,
      releaseBinding,
      runnerOptions,
      runWranglerImplementation: undefined,
      spec: config.spec,
    });
    writeOutput({
      accountId: config.spec.accountId,
      actions: result.plan.actions,
      after: result.after ? triggerShape(result.after) : undefined,
      environment: "production",
      evidencePath: result.evidencePath,
      executed: result.applied?.executed === true,
      fingerprints: result.plan.fingerprints,
      ok: true,
      release: result.plan.release,
      safeguards: result.plan.safeguards,
      workerName: config.spec.workerName,
    }, options.json);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "production_trigger_failed";
  const safeCode = /^[a-z0-9_:.-]{1,220}$/u.test(message) ? message : "production_trigger_failed";
  process.stderr.write(`${safeCode}\n`);
  process.exitCode = 1;
}
