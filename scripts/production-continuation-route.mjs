import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { writeOutput } from "./lib/cli.mjs";
import {
  PRODUCTION_CONTINUATION_ROUTE_AUDIT_TOKEN_NAME,
  PRODUCTION_CONTINUATION_ROUTE_MUTATION_TOKEN_NAME,
  applyProductionContinuationRouteHandoff,
  buildProductionContinuationRoutePlan,
  createProductionContinuationRoute,
  deleteProductionContinuationRoute,
  discoverProductionContinuationRouteInventory,
  rollbackProductionContinuationRouteHandoff,
  updateProductionContinuationRoute,
} from "./lib/production-continuation-route.mjs";
import { CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_TOKEN_NAME, repositoryRoot } from "./lib/platform.mjs";

const DEFAULT_PRODUCTION_SPEC = resolve(repositoryRoot, "infra/environments/production.json");
const DEFAULT_STAGING_SPEC = resolve(repositoryRoot, "infra/environments/staging.json");
const DEFAULT_DATABASE = resolve(repositoryRoot, "infra/generated/production.json");

function parseArguments(argv) {
  const options = { apply: false, confirmProduction: false, json: false, rollback: false, spec: DEFAULT_PRODUCTION_SPEC, stagingSpec: DEFAULT_STAGING_SPEC, database: DEFAULT_DATABASE, inventory: null, state: null, releaseBinding: null, releaseManifest: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--rollback") options.rollback = true;
    else if (arg === "--confirm-production") options.confirmProduction = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--spec") options.spec = resolve(repositoryRoot, argv[++index] ?? "");
    else if (arg === "--staging-spec") options.stagingSpec = resolve(repositoryRoot, argv[++index] ?? "");
    else if (arg === "--database") options.database = resolve(repositoryRoot, argv[++index] ?? "");
    else if (arg === "--inventory") options.inventory = resolve(repositoryRoot, argv[++index] ?? "");
    else if (arg === "--state") options.state = resolve(repositoryRoot, argv[++index] ?? "");
    else if (arg === "--release-binding") options.releaseBinding = resolve(repositoryRoot, argv[++index] ?? "");
    else if (arg === "--release-manifest") options.releaseManifest = resolve(repositoryRoot, argv[++index] ?? "");
    else if (arg === "--plan") { /* read-only default */ }
    else throw new Error(`unknown_argument:${arg}`);
  }
  if (options.apply && options.rollback) throw new Error("production_continuation_route_operation_conflict");
  if ((options.apply || options.rollback) && !options.confirmProduction) throw new Error("production_continuation_route_confirmation_required");
  if ((options.apply || options.rollback) && options.inventory) throw new Error("production_continuation_route_static_inventory_execution_forbidden");
  if ((options.apply || options.rollback) && !options.releaseManifest) throw new Error("production_continuation_route_release_manifest_required");
  if (options.releaseBinding && options.releaseManifest) throw new Error("production_continuation_route_release_source_conflict");
  return options;
}

async function readJson(path, code) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { throw new Error(code); }
}

function databaseIdentity(value) {
  const resource = value?.resources?.d1;
  return { databaseId: resource?.id ?? value?.databaseId, databaseName: resource?.name ?? value?.databaseName };
}

function releaseBinding(value) {
  const release = value?.release ?? value;
  if (!release?.releaseId) throw new Error("production_continuation_route_release_binding_missing");
  return {
    candidateWorkerVersion: release.candidateWorkerVersion ?? release.workerVersion,
    commitSha: release.commitSha,
    manifestRef: release.manifestRef ?? `.wrangler/releases/${release.releaseId}/release-manifest.json`,
    manifestSha256: release.manifestSha256,
    releaseId: release.releaseId,
    treeSha: release.treeSha,
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const [productionSpec, stagingSpec, database, binding, manifestArtifact] = await Promise.all([
    readJson(options.spec, "production_continuation_route_spec_missing"),
    readJson(options.stagingSpec, "production_continuation_route_staging_spec_missing"),
    readJson(options.database, "production_continuation_route_database_missing"),
    options.releaseBinding ? readJson(options.releaseBinding, "production_continuation_route_release_binding_missing") : Promise.resolve(null),
    options.releaseManifest ? readFile(options.releaseManifest, "utf8").then((text) => ({ value: JSON.parse(text), text })).catch(() => { throw new Error("production_continuation_route_release_manifest_missing"); }) : Promise.resolve(null),
  ]);
  const release = releaseBinding(binding ?? (manifestArtifact ? {
    ...manifestArtifact.value,
    manifestSha256: createHash("sha256").update(manifestArtifact.text).digest("hex"),
    manifestRef: `.wrangler/releases/${manifestArtifact.value.releaseId}/release-manifest.json`,
  } : null));
  const statePath = options.state ?? resolve(repositoryRoot, ".wrangler", "releases", release.releaseId, "continuation-route-state.json");
  const databaseTarget = databaseIdentity(database);
  const auditToken = process.env[PRODUCTION_CONTINUATION_ROUTE_AUDIT_TOKEN_NAME]?.trim();
  const deploymentAuditToken = process.env[CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_TOKEN_NAME]?.trim();
  const mutationToken = process.env[PRODUCTION_CONTINUATION_ROUTE_MUTATION_TOKEN_NAME]?.trim();
  const discover = async () => {
    if (options.inventory) return readJson(options.inventory, "production_continuation_route_inventory_missing");
    if (!auditToken || !deploymentAuditToken) throw new Error("production_continuation_route_live_inventory_inputs_missing");
    return discoverProductionContinuationRouteInventory({ auditToken, database: databaseTarget, deploymentAuditToken, productionSpec });
  };
  if (options.rollback) {
    if (!mutationToken) throw new Error(`${PRODUCTION_CONTINUATION_ROUTE_MUTATION_TOKEN_NAME.toLowerCase()}_missing`);
    const state = await readJson(statePath, "production_continuation_route_state_missing");
    const result = await rollbackProductionContinuationRouteHandoff({
      confirmProduction: true, database: databaseTarget, deleteRouteImplementation: (routeId) => deleteProductionContinuationRoute({ routeId, token: mutationToken, zoneId: productionSpec.zoneId }),
      inventoryImplementation: discover, productionSpec, releaseBinding: release, stagingSpec, state,
      updateRouteImplementation: (routeId, route) => updateProductionContinuationRoute({ ...route, routeId, token: mutationToken, zoneId: productionSpec.zoneId }),
    });
    writeOutput(result, options.json); return;
  }
  const inventory = await discover();
  const plan = buildProductionContinuationRoutePlan({ database: databaseTarget, inventory, productionSpec, releaseBinding: release, stagingSpec });
  if (!options.apply) { writeOutput({ environment: "production", executed: false, ok: true, plan }, options.json); return; }
  if (!mutationToken) throw new Error(`${PRODUCTION_CONTINUATION_ROUTE_MUTATION_TOKEN_NAME.toLowerCase()}_missing`);
  const result = await applyProductionContinuationRouteHandoff({
    confirmProduction: true, createRouteImplementation: (route) => createProductionContinuationRoute({ ...route, token: mutationToken, zoneId: productionSpec.zoneId }),
    database: databaseTarget, deleteRouteImplementation: (routeId) => deleteProductionContinuationRoute({ routeId, token: mutationToken, zoneId: productionSpec.zoneId }),
    inventoryImplementation: discover, plan, productionSpec, releaseBinding: release, repositoryRoot, stagingSpec,
    updateRouteImplementation: (routeId, route) => updateProductionContinuationRoute({ ...route, routeId, token: mutationToken, zoneId: productionSpec.zoneId }),
  });
  writeOutput(result, options.json);
}

try { await main(); } catch (error) {
  const message = error instanceof Error ? error.message : "production_continuation_route_failed";
  process.stderr.write(`${/^[a-z0-9_:.-]{1,220}$/u.test(message) ? message : "production_continuation_route_failed"}\n`);
  process.exitCode = 1;
}
