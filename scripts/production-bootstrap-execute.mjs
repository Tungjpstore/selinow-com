import { spawnSync } from "node:child_process";
import process from "node:process";
import { resolve } from "node:path";

import { runWrangler, writeOutput } from "./lib/cli.mjs";
import {
  assertProductionAccountIdentity,
  assertProductionDatabaseIdentity,
} from "./lib/db-admission.mjs";
import {
  parseProductionBootstrapExecuteFlags,
  runProductionBootstrapMigrations,
} from "./lib/production-bootstrap-execute.mjs";
import { listMigrationNames, readOptionalJson } from "./lib/release.mjs";
import {
  discoverRemoteResources,
  parseSecretNames,
  repositoryRoot,
} from "./lib/platform.mjs";

const SPEC_PATH = resolve(repositoryRoot, "infra/environments/production.json");
const MANIFEST_PATH = resolve(repositoryRoot, "infra/generated/production.json");
const EVIDENCE_PATH = resolve(repositoryRoot, ".wrangler/bootstrap/production-evidence.json");

function parseArguments(argv) {
  const flagsArgv = [];
  const options = {
    backupRoot: undefined,
    evidencePath: EVIDENCE_PATH,
    manifestPath: MANIFEST_PATH,
    secretNamesPath: null,
    specPath: SPEC_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--manifest") options.manifestPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--secret-names") options.secretNamesPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--spec") options.specPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--backup-root") options.backupRoot = resolve(repositoryRoot, argv[++index] ?? "");
    else flagsArgv.push(argument);
  }
  return { ...parseProductionBootstrapExecuteFlags(flagsArgv), ...options };
}

function readGitValue(args, errorCode) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) throw new Error(errorCode);
  return result.stdout.trim();
}

function readRepositoryState() {
  return {
    clean: readGitValue(["status", "--porcelain=v1", "--untracked-files=all"], "production_bootstrap_source_status_unavailable") === "",
    commitSha: readGitValue(["rev-parse", "--verify", "HEAD"], "production_bootstrap_commit_unavailable"),
    treeSha: readGitValue(["rev-parse", "--verify", "HEAD^{tree}"], "production_bootstrap_tree_unavailable"),
  };
}

async function loadSecretNames(path) {
  const value = path === null
    ? (process.env.SELINOW_WORKER_SECRET_NAMES ?? "").split(",").map((name) => name.trim()).filter(Boolean)
    : await readOptionalJson(path);
  if (!Array.isArray(value)) throw new Error("production_bootstrap_secret_names_invalid");
  return value;
}

function writeResult(result, json) {
  writeOutput({
    actions: result.actions,
    databaseName: result.databaseName,
    environment: "production",
    executed: result.executed,
    migrationNames: result.migrationNames,
    ok: result.ok,
  }, json);
}

function parseD1Rows(output, errorCode) {
  let payload;
  try {
    payload = JSON.parse(String(output ?? ""));
  } catch {
    throw new Error(errorCode);
  }
  const envelopes = Array.isArray(payload) ? payload : [payload];
  const rows = envelopes.flatMap((envelope) => Array.isArray(envelope?.results) ? envelope.results : []);
  if (!Array.isArray(rows)) throw new Error(errorCode);
  return rows;
}

function queryProductionDatabaseState(runner, databaseName, runnerOptions) {
  const execute = (sql, errorCode) => {
    let output;
    try {
      output = runner([
        "d1", "execute", databaseName, "--remote", "--env", "production",
        "--command", sql, "--json",
      ], runnerOptions).stdout;
    } catch {
      throw new Error(errorCode);
    }
    return parseD1Rows(output, errorCode);
  };
  const applicationTableNames = execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV', '_cf_METADATA', 'd1_migrations') ORDER BY name;",
    "production_bootstrap_live_schema_unavailable",
  ).map((row) => {
    if (typeof row?.name !== "string") throw new Error("production_bootstrap_live_schema_invalid");
    return row.name;
  });
  const ledgerTables = execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations';",
    "production_bootstrap_live_migration_ledger_unavailable",
  );
  let migrationNames = [];
  if (ledgerTables.length > 0) {
    if (ledgerTables.length !== 1 || ledgerTables[0]?.name !== "d1_migrations") {
      throw new Error("production_bootstrap_live_migration_ledger_invalid");
    }
    migrationNames = execute(
      "SELECT name FROM d1_migrations ORDER BY name;",
      "production_bootstrap_live_migration_ledger_unavailable",
    ).map((row) => {
      if (typeof row?.name !== "string") throw new Error("production_bootstrap_live_migration_ledger_invalid");
      return row.name;
    });
  }
  return { applicationTableNames, migrationNames };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const [productionSpec, generatedManifest, evidence, wranglerConfig, secretNames, migrationNames] = await Promise.all([
    readOptionalJson(options.specPath),
    readOptionalJson(options.manifestPath),
    readOptionalJson(options.evidencePath),
    readOptionalJson(resolve(repositoryRoot, "wrangler.jsonc")),
    loadSecretNames(options.secretNamesPath),
    listMigrationNames(),
  ]);
  if (productionSpec === null) throw new Error("production_spec_missing");
  if (generatedManifest === null) throw new Error("production_bootstrap_generated_manifest_missing");
  if (evidence === null) throw new Error("production_bootstrap_evidence_missing");
  if (wranglerConfig === null) throw new Error("wrangler_config_invalid");

  const operatorEnvironment = { ...process.env };
  const runner = runWrangler;
  const identityImplementation = async (commandEnvironment) => {
    let whoami;
    try {
      whoami = runner(["whoami", "--json"], {
        cwd: repositoryRoot,
        env: commandEnvironment,
      }).stdout;
    } catch {
      throw new Error("production_bootstrap_account_identity_unavailable");
    }
    try {
      assertProductionAccountIdentity(whoami, productionSpec.accountId);
    } catch {
      throw new Error("production_bootstrap_account_identity_mismatch");
    }
    let remoteResources;
    try {
      remoteResources = await discoverRemoteResources({
        environment: commandEnvironment,
        runWranglerImplementation: runner,
      });
    } catch {
      throw new Error("production_bootstrap_live_resource_inventory_unavailable");
    }
    const expectedDatabase = generatedManifest.resources?.d1;
    try {
      assertProductionDatabaseIdentity(
        JSON.stringify(remoteResources.d1),
        expectedDatabase.id,
        expectedDatabase.name,
      );
    } catch {
      throw new Error("production_bootstrap_database_identity_mismatch");
    }
    let liveSecretNames;
    try {
      liveSecretNames = parseSecretNames(runner([
        "secret", "list", "--name", productionSpec.workerName,
      ], {
        cwd: repositoryRoot,
        env: commandEnvironment,
      }).stdout);
    } catch {
      throw new Error("production_bootstrap_live_secret_inventory_unavailable");
    }
    const databaseState = queryProductionDatabaseState(runner, productionSpec.resources.d1, {
      cwd: repositoryRoot,
      env: commandEnvironment,
    });
    return {
      accountId: productionSpec.accountId,
      ...databaseState,
      databaseId: expectedDatabase.id,
      databaseName: expectedDatabase.name,
      secretNames: liveSecretNames,
      resources: {
        d1: remoteResources.d1.map((resource) => ({ id: resource.uuid, name: resource.name })),
        kv: remoteResources.kv.map((resource) => ({ id: resource.id, name: resource.title })),
        queue: remoteResources.queues.map((name) => ({ name })),
        r2: remoteResources.r2.map((name) => ({ name })),
      },
    };
  };

  const result = await runProductionBootstrapMigrations({
    backupRoot: options.backupRoot,
    dryRun: options.dryRun,
    evidence,
    generatedManifest,
    identityImplementation: options.execute ? identityImplementation : undefined,
    migrationNames,
    now: new Date(),
    operatorEnvironment,
    productionSpec,
    repositoryRoot,
    repositoryState: readRepositoryState(),
    runWranglerImplementation: options.execute ? runner : undefined,
    secretNames,
    wranglerConfig,
  });
  writeResult(result, options.json);
} catch (error) {
  const message = error instanceof Error ? error.message : "production_bootstrap_migration_failed";
  const safeCode = /^[a-z0-9_:.-]{1,220}$/u.test(message) ? message : "production_bootstrap_migration_failed";
  writeOutput({
    actions: [{ code: safeCode, ok: false }],
    environment: "production",
    ok: false,
  }, process.argv.includes("--json"));
  process.exitCode = 1;
}
