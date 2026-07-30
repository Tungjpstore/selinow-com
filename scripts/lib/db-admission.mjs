import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { resolveDatabaseTarget } from "./backup.mjs";
import { parseFlags, runWrangler } from "./cli.mjs";
import { buildPinnedCloudflareEnvironment, repositoryRoot } from "./platform.mjs";
import { assertProductionDeployAdmission, readOptionalJson } from "./release.mjs";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;

export function parseDatabaseFlags(argv) {
  const commonArgv = [];
  let releaseManifestPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--release-manifest") {
      if (releaseManifestPath !== null) throw new Error("production_release_manifest_duplicate");
      releaseManifestPath = argv[++index] ?? "";
    } else if (argument.startsWith("--release-manifest=")) {
      if (releaseManifestPath !== null) throw new Error("production_release_manifest_duplicate");
      releaseManifestPath = argument.slice("--release-manifest=".length);
    } else {
      commonArgv.push(argument);
    }
  }
  if (releaseManifestPath !== null && releaseManifestPath.length === 0) {
    throw new Error("production_release_manifest_path_invalid");
  }
  return { ...parseFlags(commonArgv), releaseManifestPath };
}

export function requiresProductionMigrationAdmission(operation, flags) {
  return new Set(["migrate", "seed"]).has(operation)
    && flags.environment === "production"
    && !flags.dryRun;
}

export function requiresStagingDatabaseAdmission(operation, flags) {
  return new Set(["migrate", "seed"]).has(operation)
    && flags.environment === "staging"
    && !flags.dryRun;
}

export function resolveApprovedProductionDatabaseTarget(input) {
  if (input.productionSpec?.environment !== "production") {
    throw new Error("production_database_spec_invalid");
  }
  const accountId = input.productionSpec?.accountId;
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("production_account_identity_invalid");
  }
  const target = resolveDatabaseTarget(input.wranglerConfig, "production");
  if (input.productionSpec?.resources?.d1 !== target.databaseName) {
    throw new Error("production_database_target_mismatch");
  }
  return { accountId, target };
}

export function assertProductionAccountIdentity(whoamiOutput, accountId) {
  const observed = String(whoamiOutput ?? "")
    .match(/(?<![a-f0-9])[a-f0-9]{32}(?![a-f0-9])/giu)
    ?.map((value) => value.toLowerCase()) ?? [];
  if (!observed.includes(accountId.toLowerCase())) {
    throw new Error("production_account_identity_mismatch");
  }
}

export function assertProductionDatabaseIdentity(d1ListOutput, databaseId, databaseName) {
  let databases;
  try {
    databases = JSON.parse(String(d1ListOutput ?? ""));
  } catch {
    throw new Error("production_database_identity_invalid");
  }
  if (!Array.isArray(databases)) {
    throw new Error("production_database_identity_invalid");
  }

  const rows = databases.map((database) => ({
    id: database?.uuid,
    name: database?.name,
  }));
  if (rows.some((database) => (
    typeof database.id !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(database.id)
      || typeof database.name !== "string"
      || database.name.length < 1
      || database.name.length > 128
  ))) {
    throw new Error("production_database_identity_invalid");
  }

  const matchingNames = rows.filter((database) => database.name === databaseName);
  if (matchingNames.length !== 1 || matchingNames[0]?.id !== databaseId) {
    throw new Error("production_database_identity_mismatch");
  }
}

export async function assertProductionMigrationAdmission(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const releaseAdmission = input.assertReleaseAdmissionImplementation
    ?? assertProductionDeployAdmission;
  const runner = input.runWranglerImplementation ?? runWrangler;
  const operatorEnvironment = input.environment ?? process.env;
  const releaseInput = {
    manifestPath: input.manifestPath,
    repositoryRoot: root,
    workerSecretNames: input.workerSecretNames,
  };

  const initialAdmission = await releaseAdmission(releaseInput);
  const [wranglerConfig, productionSpec] = await Promise.all([
    input.wranglerConfig === undefined
      ? readFile(resolve(root, "wrangler.jsonc"), "utf8").then((text) => JSON.parse(text))
      : input.wranglerConfig,
    input.productionSpec === undefined
      ? readOptionalJson(resolve(root, "infra/environments/production.json"))
      : input.productionSpec,
  ]);
  if (productionSpec === null) throw new Error("production_spec_missing");
  const approved = resolveApprovedProductionDatabaseTarget({ productionSpec, wranglerConfig });
  const runnerOptions = {
    cwd: root,
    env: buildPinnedCloudflareEnvironment(operatorEnvironment, approved.accountId),
  };
  let whoami;
  try {
    whoami = runner(["whoami", "--json"], runnerOptions).stdout;
  } catch {
    throw new Error("production_account_identity_unavailable");
  }
  assertProductionAccountIdentity(whoami, approved.accountId);
  let d1List;
  try {
    d1List = runner(["d1", "list", "--env", "production", "--json"], runnerOptions).stdout;
  } catch {
    throw new Error("production_database_identity_unavailable");
  }
  assertProductionDatabaseIdentity(d1List, approved.target.databaseId, approved.target.databaseName);

  // Recheck the local release permit after the provider identity lookup and
  // immediately before the caller crosses into the migration subprocess.
  const finalAdmission = await releaseAdmission(releaseInput);
  if (initialAdmission.releaseId !== finalAdmission.releaseId
    || initialAdmission.commitSha !== finalAdmission.commitSha) {
    throw new Error("production_release_admission_changed");
  }
  return {
    accountId: approved.accountId,
    commitSha: finalAdmission.commitSha,
    databaseId: approved.target.databaseId,
    databaseName: approved.target.databaseName,
    releaseId: finalAdmission.releaseId,
  };
}
