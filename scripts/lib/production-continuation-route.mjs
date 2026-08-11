import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

import { cloudflareApiRequest } from "./platform.mjs";
import { buildProductionRouteHandoff } from "./production-bootstrap.mjs";

export const PRODUCTION_CONTINUATION_ROUTE_MUTATION_TOKEN_NAME = "CLOUDFLARE_PRODUCTION_ROUTE_MUTATION_API_TOKEN";
export const PRODUCTION_CONTINUATION_ROUTE_AUDIT_TOKEN_NAME = "CLOUDFLARE_ROUTE_AUDIT_API_TOKEN";

const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const GIT = /^[a-f0-9]{40,64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const ROUTE_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const SCRIPT = /^[A-Za-z0-9_-]{1,128}$/u;
const SCHEMA_VERSION = 1;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

export function fingerprintProductionContinuationRoute(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function assertString(value, pattern, code) {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(code);
}

function normalizeRoute(route, code = "production_continuation_route_invalid") {
  if (route === null || typeof route !== "object") throw new Error(code);
  assertString(route.id, ROUTE_ID, code);
  if (typeof route.pattern !== "string" || route.pattern.length < 3 || route.pattern.length > 253) throw new Error(code);
  if (route.script !== null && typeof route.script !== "string") throw new Error(code);
  if (route.script !== null) assertString(route.script, SCRIPT, code);
  return { id: route.id, pattern: route.pattern, script: route.script ?? null };
}

export function normalizeProductionContinuationRoute(route) {
  return normalizeRoute(route);
}

function routeInventory(routes) {
  if (!Array.isArray(routes)) throw new Error("production_continuation_route_inventory_invalid");
  const normalized = routes.map((route) => normalizeRoute(route, "production_continuation_route_inventory_invalid"));
  if (new Set(normalized.map((route) => route.id)).size !== normalized.length
    || new Set(normalized.map((route) => route.pattern)).size !== normalized.length) {
    throw new Error("production_continuation_route_inventory_duplicate");
  }
  return normalized.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

function assertProductionSpec(productionSpec, stagingSpec) {
  if (productionSpec?.environment !== "production"
    || !ACCOUNT_ID.test(productionSpec.accountId ?? "")
    || !ACCOUNT_ID.test(productionSpec.zoneId ?? "")
    || typeof productionSpec.zoneName !== "string"
    || typeof productionSpec.workerName !== "string"
    || stagingSpec?.environment !== "staging"
    || typeof stagingSpec.workerName !== "string") {
    throw new Error("production_continuation_route_spec_invalid");
  }
  return buildProductionRouteHandoff(productionSpec, stagingSpec);
}

function normalizeReleaseBinding(release) {
  if (release === null || typeof release !== "object") throw new Error("production_continuation_route_release_invalid");
  assertString(release.releaseId, RELEASE, "production_continuation_route_release_invalid");
  assertString(release.commitSha, GIT, "production_continuation_route_release_invalid");
  assertString(release.treeSha, GIT, "production_continuation_route_release_invalid");
  assertString(release.manifestSha256, SHA256, "production_continuation_route_release_invalid");
  if (release.manifestRef !== `.wrangler/releases/${release.releaseId}/release-manifest.json`) throw new Error("production_continuation_route_manifest_ref_invalid");
  assertString(release.candidateWorkerVersion, UUID, "production_continuation_route_candidate_invalid");
  return {
    candidateWorkerVersion: release.candidateWorkerVersion,
    commitSha: release.commitSha,
    manifestRef: release.manifestRef,
    manifestSha256: release.manifestSha256,
    releaseId: release.releaseId,
    treeSha: release.treeSha,
  };
}

function normalizeIdentity(input, productionSpec, database) {
  if (input?.accountId !== productionSpec.accountId || input?.zoneId !== productionSpec.zoneId
    || input?.zoneName !== productionSpec.zoneName || input?.workerName !== productionSpec.workerName) {
    throw new Error("production_continuation_route_target_identity_mismatch");
  }
  const databaseId = database?.databaseId ?? input?.databaseId;
  const databaseName = database?.databaseName ?? input?.databaseName;
  assertString(databaseId, UUID, "production_continuation_route_database_identity_invalid");
  if (databaseName !== productionSpec.resources?.d1 || typeof databaseName !== "string") throw new Error("production_continuation_route_database_identity_invalid");
  return {
    accountId: input.accountId,
    databaseId,
    databaseName,
    workerName: input.workerName,
    zoneId: input.zoneId,
    zoneName: input.zoneName,
  };
}

function normalizeInventory(input, productionSpec, database) {
  if (input === null || typeof input !== "object") throw new Error("production_continuation_route_inventory_invalid");
  const identity = normalizeIdentity(input, productionSpec, database);
  assertString(input.activeWorkerVersion, UUID, "production_continuation_route_active_version_invalid");
  return { ...identity, activeWorkerVersion: input.activeWorkerVersion, routes: routeInventory(input.routes) };
}

export function normalizeProductionContinuationRouteInventory(input, options = {}) {
  return normalizeInventory(input, options.productionSpec ?? input.productionSpec, options.database);
}

function routeByPattern(routes, pattern) { return routes.find((route) => route.pattern === pattern); }

function assertRepository(repositoryState, release) {
  if (repositoryState !== undefined && (repositoryState.clean !== true || repositoryState.commitSha !== release.commitSha || repositoryState.treeSha !== release.treeSha)) {
    throw new Error("production_continuation_route_repository_binding_mismatch");
  }
}

function assertStagingExceptions(routes, handoff, stagingWorker) {
  for (const pattern of handoff.stagingExceptions) {
    const route = routeByPattern(routes, pattern);
    if (!route || route.script !== stagingWorker) throw new Error(`production_continuation_route_staging_exception_drift:${pattern}`);
  }
}

function buildOperations(routes, handoff, productionSpec) {
  const desired = new Map(handoff.promote.map((route) => [route.pattern, route]));
  const unexpected = routes.find((route) => !desired.has(route.pattern));
  if (unexpected) throw new Error(`production_continuation_route_unapproved:${unexpected.pattern}`);
  const order = [productionSpec.routing.platformApexRoute, productionSpec.routing.platformStorefrontWildcard, productionSpec.routing.externalCustomDomainFallbackRoute, ...handoff.stagingExceptions];
  const operations = [];
  for (const pattern of order) {
    const target = desired.get(pattern);
    if (!target) continue;
    const before = routeByPattern(routes, pattern);
    if (handoff.stagingExceptions.includes(pattern)) {
      if (!before || before.script !== target.script) throw new Error(`production_continuation_route_staging_exception_drift:${pattern}`);
      continue;
    }
    if (before?.script === target.script) continue;
    operations.push({ before: before ?? null, pattern, script: target.script, type: before ? "replace" : "create" });
  }
  return operations;
}

function assertReleaseAndTarget(input, inventory) {
  const release = normalizeReleaseBinding(input.releaseBinding ?? input.release);
  const identity = normalizeIdentity(inventory, input.productionSpec, input.database);
  assertRepository(input.repositoryState, release);
  if (inventory.activeWorkerVersion !== release.candidateWorkerVersion) throw new Error("production_continuation_route_candidate_not_active");
  return { identity, release };
}

export function buildProductionContinuationRoutePlan(input) {
  const handoff = assertProductionSpec(input.productionSpec, input.stagingSpec);
  const release = normalizeReleaseBinding(input.releaseBinding ?? input.release);
  const inventory = normalizeInventory(input.inventory, input.productionSpec, input.database);
  assertRepository(input.repositoryState, release);
  if (inventory.activeWorkerVersion !== release.candidateWorkerVersion) throw new Error("production_continuation_route_candidate_not_active");
  assertStagingExceptions(inventory.routes, handoff, input.stagingSpec.workerName);
  const operations = buildOperations(inventory.routes, handoff, input.productionSpec);
  const body = {
    accountId: inventory.accountId,
    candidateWorkerVersion: release.candidateWorkerVersion,
    commitSha: release.commitSha,
    databaseId: inventory.databaseId,
    databaseName: inventory.databaseName,
    environment: "production",
    manifestRef: release.manifestRef,
    manifestSha256: release.manifestSha256,
    operations,
    releaseId: release.releaseId,
    routesBefore: inventory.routes,
    routesTarget: handoff.promote.map((route) => ({ pattern: route.pattern, script: route.script })).sort((a, b) => a.pattern.localeCompare(b.pattern)),
    stagingExceptions: handoff.stagingExceptions,
    treeSha: release.treeSha,
    workerName: inventory.workerName,
    zoneId: inventory.zoneId,
    zoneName: inventory.zoneName,
  };
  return {
    ...body,
    fingerprints: { planSha256: fingerprintProductionContinuationRoute(body) },
    safeguards: { allowedMutations: ["production_route_create", "production_route_update"], stagingTrafficImmutable: true },
    schemaVersion: SCHEMA_VERSION,
  };
}

function assertPlanMatches(plan, fresh, input) {
  const expected = buildProductionContinuationRoutePlan({ ...input, inventory: fresh });
  if (!isDeepStrictEqual(plan, expected)) throw new Error("production_continuation_route_plan_drift");
}

function validateMutationResponse(value, operation, before) {
  if (operation.type === "create") {
    const id = value?.id;
    if (typeof id !== "string" || !ROUTE_ID.test(id)) throw new Error("production_continuation_route_create_response_invalid");
    return { id, pattern: operation.pattern, script: operation.script };
  }
  if (value?.id !== undefined && value.id !== before.id) throw new Error("production_continuation_route_update_response_invalid");
  return { id: before.id, pattern: operation.pattern, script: operation.script };
}

async function applyMutationWithReconciliation(input, operation) {
  try {
    const value = operation.type === "create"
      ? await input.createRouteImplementation({ pattern: operation.pattern, script: operation.script })
      : await input.updateRouteImplementation(operation.before.id, { pattern: operation.pattern, script: operation.script });
    return validateMutationResponse(value, operation, operation.before);
  } catch (error) {
    const observed = routeByPattern((await readInventory(input)).routes, operation.pattern);
    if (observed?.script === operation.script && (operation.type === "create" || observed.id === operation.before.id)) return observed;
    throw error;
  }
}

async function readInventory(input) {
  if (typeof input.inventoryImplementation !== "function") throw new Error("production_continuation_route_inventory_unavailable");
  return normalizeInventory(await input.inventoryImplementation(), input.productionSpec, input.database);
}

async function writeState(input, state) {
  if (typeof input.writeStateImplementation === "function") return input.writeStateImplementation(state);
  return writeProductionContinuationRouteState(input.repositoryRoot ?? process.cwd(), state);
}

async function compensateApplied(input, originalRoutes, applied) {
  let current = await readInventory(input);
  try {
    for (const change of [...applied].reverse()) {
      const observed = routeByPattern(current.routes, change.pattern);
      if (change.type === "create") {
        if (!observed || observed.id !== change.after.id) throw new Error("production_continuation_route_compensation_drift");
        await input.deleteRouteImplementation(observed.id);
      } else {
        if (!observed || observed.id !== change.after.id) throw new Error("production_continuation_route_compensation_drift");
        await input.updateRouteImplementation(observed.id, change.before);
      }
      current = await readInventory(input);
    }
    if (!isDeepStrictEqual(current.routes, originalRoutes)) throw new Error("production_continuation_route_compensation_state_drift");
  } catch (error) {
    throw new Error("production_continuation_route_compensation_failed", { cause: error });
  }
}

export async function applyProductionContinuationRouteHandoff(input) {
  if (input.confirmProduction !== true) throw new Error("production_continuation_route_confirmation_required");
  const initial = await readInventory(input);
  const { release } = assertReleaseAndTarget(input, initial);
  const plan = input.plan ?? buildProductionContinuationRoutePlan({ ...input, inventory: initial });
  assertPlanMatches(plan, initial, input);
  const operations = plan.operations;
  if (operations.length === 0) {
    const stateBody = {
      accountId: initial.accountId, appliedAt: (input.now ?? new Date()).toISOString(), candidateWorkerVersion: release.candidateWorkerVersion,
      changes: [], commitSha: release.commitSha, databaseId: initial.databaseId, databaseName: initial.databaseName, environment: "production", manifestRef: release.manifestRef,
      manifestSha256: release.manifestSha256, mode: "applied", planSha256: plan.fingerprints.planSha256, releaseId: release.releaseId,
      routesAfter: initial.routes, routesBefore: initial.routes, routesAfterSha256: fingerprintProductionContinuationRoute(initial.routes),
      stagingExceptions: plan.stagingExceptions, schemaVersion: SCHEMA_VERSION, treeSha: release.treeSha, workerName: initial.workerName,
      zoneId: initial.zoneId, zoneName: initial.zoneName,
    };
    const state = { ...stateBody, stateSha256: fingerprintProductionContinuationRoute(stateBody) };
    return { environment: "production", executed: true, ok: true, plan, state, stateRef: await writeState(input, state), changes: [] };
  }
  if ((operations.some((operation) => operation.type === "create") && (typeof input.createRouteImplementation !== "function" || typeof input.deleteRouteImplementation !== "function"))
    || (operations.some((operation) => operation.type === "replace") && typeof input.updateRouteImplementation !== "function")) {
    throw new Error("production_continuation_route_mutation_unavailable");
  }
  let expected = [...initial.routes];
  const applied = [];
  try {
    for (const operation of operations) {
      const current = await readInventory(input);
      if (current.activeWorkerVersion !== release.candidateWorkerVersion || !isDeepStrictEqual(current.routes, expected)) throw new Error("production_continuation_route_pre_mutation_drift");
      const after = await applyMutationWithReconciliation(input, operation);
      applied.push({ ...operation, after });
      expected = expected.filter((route) => route.pattern !== operation.pattern).concat(after).sort((a, b) => a.pattern.localeCompare(b.pattern));
      const verified = await readInventory(input);
      if (!isDeepStrictEqual(verified.routes, expected)) throw new Error("production_continuation_route_post_mutation_drift");
    }
    const final = await readInventory(input);
    const targetRoutes = new Map(plan.routesTarget.map((route) => [route.pattern, route.script]));
    if (final.routes.length !== targetRoutes.size || final.routes.some((route) => targetRoutes.get(route.pattern) !== route.script)) {
      throw new Error("production_continuation_route_matrix_incomplete");
    }
    const stateBody = {
      accountId: final.accountId, appliedAt: (input.now ?? new Date()).toISOString(), candidateWorkerVersion: release.candidateWorkerVersion,
      changes: applied, commitSha: release.commitSha, databaseId: final.databaseId, databaseName: final.databaseName, environment: "production", manifestRef: release.manifestRef,
      manifestSha256: release.manifestSha256, mode: "applied", planSha256: plan.fingerprints.planSha256, releaseId: release.releaseId,
      routesAfter: final.routes, routesBefore: initial.routes, routesAfterSha256: fingerprintProductionContinuationRoute(final.routes),
      stagingExceptions: plan.stagingExceptions, schemaVersion: SCHEMA_VERSION, treeSha: release.treeSha, workerName: final.workerName,
      zoneId: final.zoneId, zoneName: final.zoneName,
    };
    const state = { ...stateBody, stateSha256: fingerprintProductionContinuationRoute(stateBody) };
    const stateRef = await writeState(input, state);
    return { environment: "production", executed: true, ok: true, plan, state, stateRef, changes: applied };
  } catch (error) {
    await compensateApplied(input, initial.routes, applied);
    throw error;
  }
}

function assertState(input, state, current) {
  if (state?.schemaVersion !== SCHEMA_VERSION || state.mode !== "applied" || state.environment !== "production") throw new Error("production_continuation_route_state_invalid");
  const { stateSha256, ...body } = state;
  if (stateSha256 !== fingerprintProductionContinuationRoute(body)) throw new Error("production_continuation_route_state_invalid");
  const release = normalizeReleaseBinding(input.releaseBinding ?? input.release);
  assertRepository(input.repositoryState, release);
  const handoff = assertProductionSpec(input.productionSpec, input.stagingSpec);
  if (state.releaseId !== release.releaseId || state.manifestRef !== release.manifestRef || state.manifestSha256 !== release.manifestSha256 || state.commitSha !== release.commitSha || state.treeSha !== release.treeSha || state.candidateWorkerVersion !== release.candidateWorkerVersion) throw new Error("production_continuation_route_state_binding_mismatch");
  const identity = normalizeIdentity(current, input.productionSpec, input.database);
  for (const key of ["accountId", "databaseId", "databaseName", "workerName", "zoneId", "zoneName"]) if (state[key] !== identity[key]) throw new Error("production_continuation_route_state_binding_mismatch");
  const before = routeInventory(state.routesBefore); const after = routeInventory(state.routesAfter);
  if (state.routesAfterSha256 !== fingerprintProductionContinuationRoute(after)) throw new Error("production_continuation_route_state_invalid");
  if (current.activeWorkerVersion !== release.candidateWorkerVersion) throw new Error("production_continuation_route_candidate_not_active");
  if (!isDeepStrictEqual(state.stagingExceptions, handoff.stagingExceptions)) throw new Error("production_continuation_route_state_invalid");
  assertStagingExceptions(before, handoff, input.stagingSpec.workerName);
  assertStagingExceptions(after, handoff, input.stagingSpec.workerName);
  const target = new Map(handoff.promote.map((route) => [route.pattern, route.script]));
  if (after.length !== target.size || after.some((route) => target.get(route.pattern) !== route.script)) throw new Error("production_continuation_route_state_invalid");
  const expectedOperations = buildOperations(before, handoff, input.productionSpec);
  if (!Array.isArray(state.changes) || state.changes.length !== expectedOperations.length) throw new Error("production_continuation_route_state_invalid");
  const derived = [...before];
  for (let index = 0; index < state.changes.length; index += 1) {
    const change = state.changes[index];
    const expectedOperation = expectedOperations[index];
    const expected = routeByPattern(derived, change?.pattern);
    if (!change || !expectedOperation || !new Set(["create", "replace"]).has(change.type) || !change.after
      || change.type !== expectedOperation.type || change.pattern !== expectedOperation.pattern || change.script !== expectedOperation.script
      || !isDeepStrictEqual(change.before ?? null, expected ?? null)) throw new Error("production_continuation_route_state_invalid");
    if (change.type === "create") {
      if (expected || routeByPattern(derived, change.after.pattern)) throw new Error("production_continuation_route_state_invalid");
      derived.push(normalizeRoute(change.after));
    } else {
      if (!expected || expected.id !== change.before.id || change.after.id !== change.before.id) throw new Error("production_continuation_route_state_invalid");
      const index = derived.findIndex((route) => route.id === expected.id);
      derived.splice(index, 1, normalizeRoute(change.after));
    }
  }
  if (!isDeepStrictEqual(derived.sort((a, b) => a.pattern.localeCompare(b.pattern)), after)) throw new Error("production_continuation_route_state_invalid");
  return { release, before, after };
}

function findRollbackCheckpoint(routes, state) {
  const snapshots = [[...state.routesAfter]];
  let expected = [...state.routesAfter];
  for (const change of [...state.changes].reverse()) {
    if (change.type === "create") expected = expected.filter((route) => route.id !== change.after.id);
    else expected = expected.map((route) => route.id === change.after.id ? change.before : route);
    snapshots.push([...expected].sort((a, b) => a.pattern.localeCompare(b.pattern)));
  }
  const matches = snapshots.flatMap((snapshot, completed) => isDeepStrictEqual(routes, snapshot) ? [completed] : []);
  if (matches.length !== 1) throw new Error("production_continuation_route_rollback_drift");
  return matches[0];
}

async function rollbackMutationWithReconciliation(input, change) {
  try {
    if (change.type === "create") await input.deleteRouteImplementation(change.after.id);
    else await input.updateRouteImplementation(change.after.id, change.before);
  } catch (error) {
    const observed = routeByPattern((await readInventory(input)).routes, change.pattern);
    if (change.type === "create" ? observed === undefined : isDeepStrictEqual(observed, change.before)) return;
    throw error;
  }
}

export async function rollbackProductionContinuationRouteHandoff(input) {
  if (input.confirmProduction !== true) throw new Error("production_continuation_route_confirmation_required");
  const current = await readInventory(input);
  const { release, before, after } = assertState(input, input.state, current);
  const changes = Array.isArray(input.state.changes) ? input.state.changes : [];
  if ((changes.some((change) => change.type === "create") && typeof input.deleteRouteImplementation !== "function")
    || (changes.some((change) => change.type === "replace") && typeof input.updateRouteImplementation !== "function")) {
    throw new Error("production_continuation_route_mutation_unavailable");
  }
  const reverse = [...changes].reverse();
  const completed = findRollbackCheckpoint(current.routes, input.state);
  const remaining = reverse.slice(completed);
  let expected = current.routes;
  try {
    for (const change of remaining) {
      const checkpoint = await readInventory(input);
      if (checkpoint.activeWorkerVersion !== release.candidateWorkerVersion || !isDeepStrictEqual(checkpoint.routes, expected)) throw new Error("production_continuation_route_rollback_drift");
      const observed = routeByPattern(checkpoint.routes, change.pattern);
      if (change.type === "create") {
        if (!observed || observed.id !== change.after.id) throw new Error("production_continuation_route_rollback_drift");
        await rollbackMutationWithReconciliation(input, change);
        expected = expected.filter((route) => route.id !== observed.id);
      } else if (change.type === "replace") {
        if (!observed || observed.id !== change.after.id) throw new Error("production_continuation_route_rollback_drift");
        await rollbackMutationWithReconciliation(input, change);
        expected = expected.map((route) => route.id === observed.id ? change.before : route).sort((a, b) => a.pattern.localeCompare(b.pattern));
      }
      const verified = await readInventory(input);
      if (verified.activeWorkerVersion !== release.candidateWorkerVersion || !isDeepStrictEqual(verified.routes, expected)) throw new Error("production_continuation_route_rollback_drift");
    }
    const restored = await readInventory(input);
    if (restored.activeWorkerVersion !== release.candidateWorkerVersion || !isDeepStrictEqual(restored.routes, before)) throw new Error("production_continuation_route_rollback_not_restored");
    return { environment: "production", executed: true, ok: true, release, restoredRoutes: restored.routes, previousRoutes: after };
  } catch (error) {
    throw new Error("production_continuation_route_rollback_failed", { cause: error });
  }
}

// Stable aliases keep the handoff vocabulary explicit for release choreography callers.
export const executeProductionContinuationRouteHandoff = applyProductionContinuationRouteHandoff;
export const compensateProductionContinuationRouteHandoff = rollbackProductionContinuationRouteHandoff;

export function validateProductionContinuationRouteState(input) {
  const current = normalizeInventory(input.currentInventory, input.productionSpec, input.database);
  return assertState(input, input.state, current);
}

export async function discoverProductionContinuationRouteInventory(input) {
  const workerPath = `/accounts/${input.productionSpec.accountId}/workers/scripts/${encodeURIComponent(input.productionSpec.workerName)}`;
  const [routes, deployments] = await Promise.all([
    cloudflareApiRequest(input.auditToken, `/zones/${input.productionSpec.zoneId}/workers/routes`, { fetchImplementation: input.fetchImplementation }),
    input.activeWorkerVersion === undefined && typeof input.activeWorkerVersionImplementation !== "function"
      ? cloudflareApiRequest(input.deploymentAuditToken ?? input.auditToken, `${workerPath}/deployments`, { fetchImplementation: input.fetchImplementation })
      : Promise.resolve(null),
  ]);
  let activeWorkerVersion = input.activeWorkerVersion ?? (typeof input.activeWorkerVersionImplementation === "function" ? await input.activeWorkerVersionImplementation() : null);
  if (activeWorkerVersion === null) {
    const entries = Array.isArray(deployments) ? deployments : deployments?.deployments;
    const latest = Array.isArray(entries) ? [...entries].sort((a, b) => Date.parse(b?.created_on ?? b?.createdOn ?? "") - Date.parse(a?.created_on ?? a?.createdOn ?? ""))[0] : null;
    const versions = latest?.versions;
    const version = Array.isArray(versions) && versions.length === 1 ? versions[0] : null;
    if (version?.percentage !== 100 || typeof version?.version_id !== "string") throw new Error("production_continuation_route_active_version_invalid");
    activeWorkerVersion = version.version_id;
  }
  return normalizeInventory({ accountId: input.productionSpec.accountId, activeWorkerVersion, databaseId: input.database?.databaseId, databaseName: input.database?.databaseName ?? input.productionSpec.resources?.d1, routes, workerName: input.productionSpec.workerName, zoneId: input.productionSpec.zoneId, zoneName: input.productionSpec.zoneName }, input.productionSpec, input.database);
}

export async function createProductionContinuationRoute(input) {
  return cloudflareApiRequest(input.token, `/zones/${input.zoneId}/workers/routes`, { body: { pattern: input.pattern, script: input.script }, fetchImplementation: input.fetchImplementation, method: "POST" });
}

export async function updateProductionContinuationRoute(input) {
  return cloudflareApiRequest(input.token, `/zones/${input.zoneId}/workers/routes/${encodeURIComponent(input.routeId)}`, { body: { pattern: input.pattern, script: input.script }, fetchImplementation: input.fetchImplementation, method: "PUT" });
}

export async function deleteProductionContinuationRoute(input) {
  return cloudflareApiRequest(input.token, `/zones/${input.zoneId}/workers/routes/${encodeURIComponent(input.routeId)}`, { fetchImplementation: input.fetchImplementation, method: "DELETE" });
}

export async function writeProductionContinuationRouteState(root, state) {
  if (state?.mode !== "applied" || !RELEASE.test(state.releaseId ?? "")) throw new Error("production_continuation_route_state_path_invalid");
  const directory = resolve(root, ".wrangler", "releases", state.releaseId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, "continuation-route-state.json");
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return `.wrangler/releases/${state.releaseId}/continuation-route-state.json`;
}
