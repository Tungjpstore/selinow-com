import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { cloudflareApiRequest } from "./platform.mjs";
import {
  assertProductionBootstrapSpecIdentity,
  buildProductionRouteHandoff,
  inspectProductionBootstrapCutoverBlockers,
} from "./production-bootstrap.mjs";

export const PROMOTION_AUDIT_TOKEN_NAME = "CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN";
export const PROMOTION_ROUTE_TOKEN_NAME = "CLOUDFLARE_PRODUCTION_PROMOTION_ROUTE_API_TOKEN";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const CEREMONY_ID_PATTERN = /^bootstrap_[a-z0-9][a-z0-9._-]{7,72}$/u;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40,64}$/u;
const WORKER_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{5,160}$/u;
const PLACEHOLDER_PATTERN = /(?:change-me|not-provisioned|placeholder|replace-with|<[^>]+>)/iu;
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60_000;
const APPROVED_MUTATIONS = ["production_shared_zone_worker_routes"];
const AUDIT_ENVIRONMENT_ALLOWLIST = new Set([
  "COREPACK_HOME",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NO_COLOR",
  "NPM_CONFIG_CACHE",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "TEMP",
  "TMP",
  "TMPDIR",
  "npm_config_cache",
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, canonicalize(nested)]),
  );
}

export function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function configuredReference(value) {
  return typeof value === "string"
    && value.trim().length >= 8
    && value.length <= 240
    && !PLACEHOLDER_PATTERN.test(value);
}

function safeDate(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function routeShape(routes) {
  return routes
    .map(({ pattern, script }) => ({ pattern, script }))
    .sort((left, right) => left.pattern.localeCompare(right.pattern));
}

function routeInventory(routes) {
  return routes
    .map(({ id, pattern, script }) => ({ id, pattern, script }))
    .sort((left, right) => left.pattern.localeCompare(right.pattern));
}

function domainShape(domains, zoneId, zoneName) {
  return domains
    .filter((domain) => domain.zoneId === zoneId || domain.zoneName === zoneName)
    .map(({ hostname, service }) => ({ hostname, service }))
    .sort((left, right) => left.hostname.localeCompare(right.hostname));
}

function activeVersionId(inventory) {
  if (Array.isArray(inventory?.deployments) && inventory.deployments.length > 0) {
    return inventory.deployments[0]?.versionId ?? null;
  }
  return typeof inventory?.activeVersionId === "string" ? inventory.activeVersionId : null;
}

function normalizeRoute(route) {
  if (
    typeof route !== "object"
    || route === null
    || typeof route.id !== "string"
    || !SAFE_ID_PATTERN.test(route.id)
    || typeof route.pattern !== "string"
    || route.pattern.length < 3
    || route.pattern.length > 253
    || (route.script !== null && typeof route.script !== "string")
  ) {
    throw new Error("production_promotion_route_inventory_invalid");
  }
  return { id: route.id, pattern: route.pattern, script: route.script };
}

function normalizeInventory(input) {
  if (
    typeof input !== "object"
    || input === null
    || !ACCOUNT_ID_PATTERN.test(input.accountId ?? "")
    || !ACCOUNT_ID_PATTERN.test(input.zoneId ?? "")
    || typeof input.zoneName !== "string"
    || !Array.isArray(input.routes)
    || !Array.isArray(input.domains)
    || safeDate(input.observedAt) === null
  ) {
    throw new Error("production_promotion_inventory_invalid");
  }
  if (input.databaseId !== undefined && !UUID_PATTERN.test(input.databaseId ?? "")) {
    throw new Error("production_promotion_inventory_invalid");
  }
  const routes = input.routes.map(normalizeRoute).sort((left, right) => left.pattern.localeCompare(right.pattern));
  if (
    new Set(routes.map((route) => route.pattern)).size !== routes.length
    || new Set(routes.map((route) => route.id)).size !== routes.length
  ) {
    throw new Error("production_promotion_route_inventory_invalid");
  }
  const domains = input.domains.map((domain) => {
    if (
      typeof domain?.hostname !== "string"
      || typeof domain?.service !== "string"
      || (domain.zoneId !== null && typeof domain.zoneId !== "string")
      || (domain.zoneName !== null && typeof domain.zoneName !== "string")
    ) throw new Error("production_promotion_domain_inventory_invalid");
    return {
      hostname: domain.hostname.toLowerCase(),
      service: domain.service,
      zoneId: domain.zoneId ?? null,
      zoneName: domain.zoneName?.toLowerCase() ?? null,
    };
  }).sort((left, right) => left.hostname.localeCompare(right.hostname));
  if (new Set(domains.map((domain) => domain.hostname)).size !== domains.length) {
    throw new Error("production_promotion_domain_inventory_invalid");
  }
  return {
    ...input,
    domains,
    routes,
    zoneName: input.zoneName.toLowerCase(),
  };
}

function normalizeTrafficSnapshot(input) {
  if (
    typeof input !== "object"
    || input === null
    || !ACCOUNT_ID_PATTERN.test(input.accountId ?? "")
    || !ACCOUNT_ID_PATTERN.test(input.zoneId ?? "")
    || typeof input.zoneName !== "string"
    || !Array.isArray(input.routes)
    || !Array.isArray(input.domains)
  ) throw new Error("production_promotion_saved_inventory_invalid");
  const routes = input.routes.map((route) => {
    if (
      typeof route?.pattern !== "string"
      || (route.script !== null && typeof route.script !== "string")
    ) throw new Error("production_promotion_saved_inventory_invalid");
    return { pattern: route.pattern, script: route.script ?? null };
  });
  if (new Set(routes.map((route) => route.pattern)).size !== routes.length) {
    throw new Error("production_promotion_saved_inventory_invalid");
  }
  const domains = input.domains.map((domain) => ({
    hostname: typeof domain?.hostname === "string" ? domain.hostname.toLowerCase() : null,
    service: domain?.service,
  }));
  if (domains.some((domain) => typeof domain.hostname !== "string" || typeof domain.service !== "string")) {
    throw new Error("production_promotion_saved_inventory_invalid");
  }
  return {
    accountId: input.accountId,
    domains: domains.sort((left, right) => left.hostname.localeCompare(right.hostname)),
    routes: routeShape(routes),
    zoneId: input.zoneId,
    zoneName: input.zoneName.toLowerCase(),
  };
}

function assertIdentity(inventory, productionSpec, expectedDatabaseId = undefined) {
  if (
    inventory.accountId !== productionSpec.accountId
    || inventory.zoneId !== productionSpec.zoneId
    || inventory.zoneName !== productionSpec.zoneName
    || inventory.workerName !== productionSpec.workerName
  ) throw new Error("production_promotion_target_identity_mismatch");
  if (expectedDatabaseId !== undefined
    && (inventory.databaseId !== expectedDatabaseId || inventory.databaseName !== productionSpec.resources?.d1)) {
    throw new Error("production_promotion_database_identity_mismatch");
  }
}

function assertFreshObservedAt(value, now, code) {
  const observedAt = safeDate(value);
  const current = now.getTime();
  if (observedAt === null || observedAt > current || current - observedAt > MAX_SNAPSHOT_AGE_MS) {
    throw new Error(code);
  }
}

function liveObservationNow(input) {
  const value = typeof input.liveNow === "function" ? input.liveNow() : input.now;
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("production_promotion_live_clock_invalid");
  }
  return value;
}

function assertRepositoryState(repositoryState, evidence) {
  if (
    repositoryState?.clean !== true
    || !GIT_OBJECT_PATTERN.test(repositoryState?.commitSha ?? "")
    || !GIT_OBJECT_PATTERN.test(repositoryState?.treeSha ?? "")
  ) throw new Error("production_promotion_repository_state_invalid");
  if (repositoryState.commitSha !== evidence.reviewedCommitSha) {
    throw new Error("production_promotion_reviewed_commit_mismatch");
  }
  if (repositoryState.treeSha !== evidence.reviewedTreeSha) {
    throw new Error("production_promotion_reviewed_tree_mismatch");
  }
}

function assertEvidence(input) {
  const { evidence, acceptanceEvidence, canaryState, now } = input;
  const acceptedAt = safeDate(evidence?.canary?.acceptedAt);
  const monitoringAt = safeDate(acceptanceEvidence?.monitoring?.observedAt);
  const backupAt = safeDate(evidence?.backup?.completedAt);
  const restoreAt = safeDate(evidence?.backup?.restoreDrillCompletedAt);
  const migrationAt = safeDate(evidence?.migrations?.appliedAt);
  const migrationNames = Array.isArray(input.migrationNames) ? [...input.migrationNames].sort() : null;
  if (
    evidence?.schemaVersion !== 1
    || evidence.environment !== "production"
    || evidence.phase !== "promote"
    || !CEREMONY_ID_PATTERN.test(evidence.ceremonyId ?? "")
    || !configuredReference(evidence.approvals?.releaseOwner)
    || !configuredReference(evidence.approvals?.supportOwner)
    || !configuredReference(evidence.preBootstrapTrafficSnapshotRef)
    || !configuredReference(evidence.resourceManifestRef)
    || !configuredReference(evidence.backup?.snapshotReportRef)
    || !configuredReference(evidence.backup?.restoreDrillReportRef)
    || evidence.backup?.providerBookmarkRecorded !== true
    || evidence.backup?.emptyDatabaseBaselineVerified !== true
    || evidence.backup?.restoreDrillPassed !== true
    || backupAt === null
    || restoreAt === null
    || migrationAt === null
    || backupAt > now.getTime()
    || restoreAt > now.getTime()
    || migrationAt > now.getTime()
    || now.getTime() - backupAt > MAX_SNAPSHOT_AGE_MS
    || restoreAt < backupAt
    || migrationAt < backupAt
    || evidence.migrations?.direction !== "forward_only"
    || migrationNames === null
    || !isDeepStrictEqual(evidence.migrations?.names, migrationNames)
    || evidence.canary?.accepted !== true
    || acceptedAt === null
    || acceptedAt > now.getTime()
    || now.getTime() - acceptedAt > MAX_SNAPSHOT_AGE_MS
    || evidence.canary.workerVersion !== evidence.candidateWorkerVersion
    || !WORKER_VERSION_PATTERN.test(evidence.candidateWorkerVersion ?? "")
    || !configuredReference(evidence.canary.smokeReportRef)
    || evidence.canary.stagingRoutesPreserved !== true
    || evidence.monitoring?.alertsReady !== true
    || evidence.monitoring?.dashboardReady !== true
    || evidence.previousWorkerVersion !== null
    || evidence.rollback?.strategy !== "restore_pre_bootstrap_traffic_inventory"
    || evidence.rollback?.snapshotRef !== evidence.preBootstrapTrafficSnapshotRef
    || canaryState?.schemaVersion !== 1
    || canaryState.mode !== "applied"
    || canaryState.environment !== "production"
    || canaryState.ceremonyId !== evidence.ceremonyId
    || canaryState.candidateVersionId !== evidence.candidateWorkerVersion
    || !UUID_PATTERN.test(canaryState.candidateVersionId ?? "")
    || !Array.isArray(canaryState.routesBefore)
    || !Array.isArray(canaryState.routesAfter)
    || acceptanceEvidence?.schemaVersion !== 1
    || acceptanceEvidence.mode !== "promotion_acceptance"
    || acceptanceEvidence.environment !== "production"
    || acceptanceEvidence.ceremonyId !== evidence.ceremonyId
    || acceptanceEvidence.candidateVersionId !== evidence.candidateWorkerVersion
    || acceptanceEvidence.acceptedAt !== evidence.canary.acceptedAt
    || acceptanceEvidence.smokeReportRef !== evidence.canary.smokeReportRef
    || acceptanceEvidence.stagingRoutesPreserved !== true
    || !configuredReference(acceptanceEvidence.canaryStateRef)
    || acceptanceEvidence.monitoring?.alertsReady !== true
    || acceptanceEvidence.monitoring?.dashboardReady !== true
    || !configuredReference(acceptanceEvidence.monitoring?.alertsEvidenceRef)
    || !configuredReference(acceptanceEvidence.monitoring?.dashboardEvidenceRef)
    || !configuredReference(acceptanceEvidence.acceptedBy)
    || monitoringAt === null
    || monitoringAt > now.getTime()
    || now.getTime() - monitoringAt > MAX_SNAPSHOT_AGE_MS
    || acceptanceEvidence.canaryStateSha256 !== fingerprint({
      routesBefore: canaryState.routesBefore,
      routesAfter: canaryState.routesAfter,
    })
  ) throw new Error("production_promotion_evidence_incomplete");
}

function assertCanaryStateSnapshot(canaryState, trafficSnapshot, input) {
  const before = canaryState.routesBefore.map(normalizeRoute).sort((left, right) => left.pattern.localeCompare(right.pattern));
  const after = canaryState.routesAfter.map(normalizeRoute).sort((left, right) => left.pattern.localeCompare(right.pattern));
  if (before.some((route) => route.pattern === input.productionSpec.routing.canaryOverrideRoute)) {
    throw new Error("production_promotion_canary_state_invalid");
  }
  if (!after.some((route) => route.pattern === input.productionSpec.routing.canaryOverrideRoute
    && route.script === input.productionSpec.workerName)) {
    throw new Error("production_promotion_canary_state_invalid");
  }
  if (!isDeepStrictEqual(routeShape(after), trafficSnapshot.routes)) {
    throw new Error("production_promotion_saved_inventory_mismatch");
  }
  if (
    canaryState.accountId !== input.productionSpec.accountId
    || canaryState.zoneId !== input.productionSpec.zoneId
    || canaryState.workerName !== input.productionSpec.workerName
  ) throw new Error("production_promotion_canary_state_invalid");
  assertFreshObservedAt(canaryState.appliedAt, input.now, "production_promotion_saved_inventory_stale");
}

function assertPromotionPlan(input) {
  const plan = input.plan;
  const handoff = buildProductionRouteHandoff(input.productionSpec, input.stagingSpec);
  if (
    plan?.schemaVersion !== 1
    || plan.phase !== "promote"
    || plan.environment !== "production"
    || plan.ceremonyId !== input.evidence.ceremonyId
    || !isDeepStrictEqual(plan.safeguards?.allowedMutations, APPROVED_MUTATIONS)
    || (plan.safeguards?.cutoverBlockers?.length ?? 1) !== 0
    || plan.fingerprints?.inventorySha256 !== fingerprint(input.trafficSnapshotForFingerprint)
    || plan.fingerprints?.sourceSha256 !== fingerprint(input.repositoryState)
    || plan.fingerprints?.specSha256 !== fingerprint(input.productionSpec)
    || plan.fingerprints?.stagingSpecSha256 !== fingerprint(input.stagingSpec)
    || plan.fingerprints?.evidenceSha256 !== fingerprint(input.evidence)
  ) throw new Error("production_promotion_plan_invalid");
  const expected = new Map(handoff.promote.map((route) => [route.pattern, route.script]));
  const routeActions = plan.actions?.filter((action) => action?.code === "traffic.shared_zone_route") ?? [];
  if (routeActions.length !== expected.size) throw new Error("production_promotion_plan_invalid");
  for (const action of routeActions) {
    if (!expected.has(action.pattern) || action.script !== expected.get(action.pattern)
      || !new Set(["reuse", "reconcile"]).has(action.action)) {
      throw new Error("production_promotion_plan_invalid");
    }
    expected.delete(action.pattern);
  }
  const canaryAction = plan.actions?.filter((action) => action?.code === "traffic.canary_route");
  if (
    expected.size !== 0
    || canaryAction?.length !== 1
    || canaryAction[0].action !== "delete"
    || canaryAction[0].pattern !== handoff.canary[0].pattern
    || canaryAction[0].script !== handoff.canary[0].script
    || plan.actions.some((action) => action?.code === "traffic.stable_domain")
  ) throw new Error("production_promotion_plan_invalid");
  return { handoff, planSha256: fingerprint(plan) };
}

function assertLiveBase(input, inventory, savedInventory, canaryState, trafficSnapshot, handoff) {
  assertIdentity(inventory, input.productionSpec, input.databaseId);
  assertFreshObservedAt(
    inventory.observedAt,
    liveObservationNow(input),
    "production_promotion_live_inventory_stale",
  );
  if (!isDeepStrictEqual(inventory.routes, savedInventory.routes)) {
    throw new Error("production_promotion_live_inventory_drift");
  }
  if (!isDeepStrictEqual(domainShape(inventory.domains, inventory.zoneId, inventory.zoneName), trafficSnapshot.domains)) {
    throw new Error("production_promotion_live_domain_drift");
  }
  if (activeVersionId(inventory) !== canaryState.candidateVersionId) {
    throw new Error("production_promotion_candidate_not_active");
  }
  if (inventory.schedules?.length !== 0) throw new Error("production_promotion_cron_trigger_present");
  if (inventory.queueConsumers?.some((entry) => entry.consumers?.length > 0)) {
    throw new Error("production_promotion_queue_consumer_present");
  }
  const approved = new Set([
    ...handoff.canary.map((route) => route.pattern),
    ...handoff.promote.map((route) => route.pattern),
  ]);
  const unapproved = inventory.routes.find((route) => !approved.has(route.pattern));
  if (unapproved !== undefined) throw new Error(`production_promotion_unapproved_route:${unapproved.pattern}`);
  const canary = inventory.routes.filter((route) => route.pattern === handoff.canary[0].pattern);
  if (canary.length !== 1 || canary[0].script !== input.productionSpec.workerName) {
    throw new Error("production_promotion_canary_route_invalid");
  }
  for (const pattern of handoff.stagingExceptions) {
    const route = inventory.routes.find((candidate) => candidate.pattern === pattern);
    if (route !== undefined && route.script !== input.stagingSpec.workerName) {
      throw new Error(`production_promotion_staging_route_drift:${pattern}`);
    }
  }
}

function assertRoutesEqual(actual, expected, code) {
  if (!isDeepStrictEqual(routeShape(actual), routeShape(expected))) throw new Error(code);
}

function assertRouteInventoryEqual(actual, expected, code) {
  if (!isDeepStrictEqual(routeInventory(actual), routeInventory(expected))) throw new Error(code);
}

function routeByPattern(routes, pattern) {
  return routes.find((route) => route.pattern === pattern);
}

function buildOperations(initialRoutes, handoff, productionSpec) {
  const current = new Map(initialRoutes.map((route) => [route.pattern, route]));
  const operations = [];
  const order = [
    ...handoff.stagingExceptions,
    productionSpec.routing.platformApexRoute,
    productionSpec.routing.platformStorefrontWildcard,
    productionSpec.routing.externalCustomDomainFallbackRoute,
  ];
  for (const target of handoff.promote) {
    if (!order.includes(target.pattern)) order.push(target.pattern);
  }
  for (const pattern of order) {
    const target = handoff.promote.find((route) => route.pattern === pattern);
    if (!target) continue;
    const before = current.get(pattern);
    if (before?.script === target.script) continue;
    if (before?.script !== undefined && handoff.stagingExceptions.includes(pattern)) {
      throw new Error(`production_promotion_staging_route_drift:${pattern}`);
    }
    operations.push({
      before: before ?? null,
      pattern: target.pattern,
      script: target.script,
      type: before ? "replace" : "create",
    });
    current.set(pattern, { id: before?.id ?? "pending", pattern, script: target.script });
  }
  const canary = current.get(handoff.canary[0].pattern);
  if (!canary || canary.script !== productionSpec.workerName) {
    throw new Error("production_promotion_canary_route_invalid");
  }
  operations.push({ before: canary, pattern: canary.pattern, script: canary.script, type: "delete" });
  return operations;
}

function validateCreatedRoute(value, operation) {
  if (
    typeof value?.id !== "string"
    || !SAFE_ID_PATTERN.test(value.id)
    || (value.pattern !== undefined && value.pattern !== operation.pattern)
    || (value.script !== undefined && value.script !== operation.script)
  ) throw new Error("production_promotion_route_create_response_invalid");
  return { id: value.id, pattern: operation.pattern, script: operation.script };
}

function validateUpdatedRoute(value, before, operation) {
  if (
    typeof value?.id !== "string"
    || value.id !== before.id
    || (value.pattern !== undefined && value.pattern !== operation.pattern)
    || (value.script !== undefined && value.script !== operation.script)
  ) throw new Error("production_promotion_route_update_response_invalid");
  return { id: before.id, pattern: operation.pattern, script: operation.script };
}

function validateDeletedRouteResponse(value) {
  if (value !== undefined && value !== null && value !== true && value?.success !== true) {
    throw new Error("production_promotion_route_delete_response_invalid");
  }
}

async function readAndNormalizeInventory(input) {
  if (typeof input.inventoryImplementation !== "function") {
    throw new Error("production_promotion_live_inventory_unavailable");
  }
  return normalizeInventory(await input.inventoryImplementation());
}

async function createRouteWithReconciliation(input, operation) {
  try {
    return validateCreatedRoute(
      await input.createRouteImplementation({ pattern: operation.pattern, script: operation.script }),
      operation,
    );
  } catch (error) {
    const inventory = await readAndNormalizeInventory(input);
    const observed = routeByPattern(inventory.routes, operation.pattern);
    if (observed?.script === operation.script) return observed;
    throw error;
  }
}

async function updateRouteWithReconciliation(input, before, operation) {
  try {
    return validateUpdatedRoute(
      await input.updateRouteImplementation(before.id, {
        pattern: operation.pattern,
        script: operation.script,
      }),
      before,
      operation,
    );
  } catch (error) {
    const inventory = await readAndNormalizeInventory(input);
    const observed = routeByPattern(inventory.routes, operation.pattern);
    if (observed?.id === before.id && observed.script === operation.script) return observed;
    throw error;
  }
}

async function deleteRouteWithReconciliation(input, route) {
  try {
    validateDeletedRouteResponse(await input.deleteRouteImplementation(route.id));
  } catch (error) {
    const inventory = await readAndNormalizeInventory(input);
    const byId = inventory.routes.find((candidate) => candidate.id === route.id);
    const byPattern = routeByPattern(inventory.routes, route.pattern);
    if (byId === undefined && byPattern === undefined) return;
    throw error;
  }
}

async function verifyMutationState(input, expectedRoutes, code) {
  const current = await readAndNormalizeInventory(input);
  assertIdentity(current, input.productionSpec, input.databaseId);
  assertFreshObservedAt(
    current.observedAt,
    liveObservationNow(input),
    "production_promotion_live_inventory_stale",
  );
  assertRouteInventoryEqual(current.routes, expectedRoutes, code);
  if (activeVersionId(current) !== input.canaryState.candidateVersionId) {
    throw new Error("production_promotion_candidate_not_active");
  }
  if (!isDeepStrictEqual(domainShape(current.domains, current.zoneId, current.zoneName), input.trafficSnapshot.domains)) {
    throw new Error("production_promotion_live_domain_drift");
  }
  if (input.baselineInvariant !== undefined && !isDeepStrictEqual({
    domains: current.domains,
    queueConsumers: current.queueConsumers ?? [],
    schedules: current.schedules ?? [],
  }, input.baselineInvariant)) {
    throw new Error("production_promotion_unapproved_state_drift");
  }
  return current;
}

async function compensate(input, originalRoutes, applied) {
  let current = await readAndNormalizeInventory(input);
  try {
    for (const mutation of [...applied].reverse()) {
      if (mutation.type === "create" && mutation.after !== null) {
        const created = routeByPattern(current.routes, mutation.after.pattern);
        if (!created || created.id !== mutation.after.id) {
          throw new Error("production_promotion_compensation_route_drift");
        }
        await deleteRouteWithReconciliation(input, created);
        current = await readAndNormalizeInventory(input);
      }
      if (mutation.type === "replace" && mutation.before !== null && mutation.after !== null) {
        const observed = routeByPattern(current.routes, mutation.after.pattern);
        if (!observed || observed.id !== mutation.after.id) {
          throw new Error("production_promotion_compensation_route_drift");
        }
        await updateRouteWithReconciliation(input, observed, mutation.before);
        current = await readAndNormalizeInventory(input);
      }
      if (mutation.type === "delete" && mutation.before !== null) {
        const recreated = await createRouteWithReconciliation(input, mutation.before);
        current = await readAndNormalizeInventory(input);
        if (!routeByPattern(current.routes, recreated.pattern)
          || routeByPattern(current.routes, recreated.pattern).script !== recreated.script) {
          throw new Error("production_promotion_compensation_route_drift");
        }
      }
    }
    assertRoutesEqual(current.routes, originalRoutes, "production_promotion_compensation_state_drift");
    return current;
  } catch (error) {
    throw new Error("production_promotion_compensation_failed", { cause: error });
  }
}

function validateCommonFlags(input) {
  if (input.execute !== true) return;
  if (input.confirmProduction !== true) throw new Error("production_confirmation_required");
  if (input.confirmFirstProductionBootstrap !== true) {
    throw new Error("production_first_bootstrap_confirmation_required");
  }
}

export function validateProductionPromotionPlan(input) {
  assertProductionBootstrapSpecIdentity(input.productionSpec);
  const blockers = inspectProductionBootstrapCutoverBlockers(input);
  if (blockers.length > 0) throw new Error(`production_promotion_cutover_blocked:${blockers[0]}`);
  assertRepositoryState(input.repositoryState, input.evidence);
  const trafficSnapshot = normalizeTrafficSnapshot(input.trafficSnapshot);
  const { handoff, planSha256 } = assertPromotionPlan({
    ...input,
    trafficSnapshot,
    trafficSnapshotForFingerprint: input.trafficSnapshot,
  });
  assertEvidence(input);
  assertCanaryStateSnapshot(input.canaryState, trafficSnapshot, input);
  return { handoff, planSha256, trafficSnapshot };
}

export async function runProductionPromotion(input) {
  validateCommonFlags(input);
  const { handoff, planSha256, trafficSnapshot } = validateProductionPromotionPlan(input);
  const savedInventory = normalizeInventory(input.savedInventory ?? {
    ...input.canaryState,
    domains: trafficSnapshot.domains.map((domain) => ({
      ...domain,
      zoneId: input.productionSpec.zoneId,
      zoneName: input.productionSpec.zoneName,
    })),
    observedAt: input.canaryState.appliedAt,
    routes: input.canaryState.routesAfter,
    zoneName: input.productionSpec.zoneName,
  });
  const canaryRoutes = input.canaryState.routesAfter.map(normalizeRoute)
    .sort((left, right) => left.pattern.localeCompare(right.pattern));
  if (!isDeepStrictEqual(savedInventory.routes, canaryRoutes)) {
    throw new Error("production_promotion_saved_inventory_mismatch");
  }
  const initial = await readAndNormalizeInventory(input);
  assertLiveBase(input, initial, savedInventory, input.canaryState, trafficSnapshot, handoff);
  const operations = buildOperations(initial.routes, handoff, input.productionSpec);
  const executionInput = {
    ...input,
    baselineInvariant: {
      domains: initial.domains,
      queueConsumers: initial.queueConsumers ?? [],
      schedules: initial.schedules ?? [],
    },
    trafficSnapshot,
  };
  if (!input.execute) {
    return {
      actions: operations.map((operation) => ({
        action: operation.type,
        code: operation.type === "delete" ? "traffic.canary_route_delete" : "traffic.shared_zone_route_reconcile",
        detail: `${operation.pattern} -> ${operation.script}`,
        ok: true,
      })),
      environment: "production",
      executed: false,
      ok: true,
      planSha256,
    };
  }
  if (
    typeof input.createRouteImplementation !== "function"
    || typeof input.deleteRouteImplementation !== "function"
    || typeof input.updateRouteImplementation !== "function"
  ) {
    throw new Error("production_promotion_route_mutation_unavailable");
  }
  const expectedRoutes = [...initial.routes];
  const applied = [];
  try {
    for (const operation of operations) {
      const current = await verifyMutationState(executionInput, expectedRoutes, "production_promotion_pre_mutation_drift");
      const live = routeByPattern(current.routes, operation.pattern);
      if (operation.type === "delete") {
        applied.push({ ...operation, after: null });
        await deleteRouteWithReconciliation(executionInput, live);
        expectedRoutes.splice(expectedRoutes.findIndex((route) => route.id === live.id), 1);
      } else if (operation.type === "replace") {
        const mutation = { ...operation, after: null };
        applied.push(mutation);
        const updatedRoute = await updateRouteWithReconciliation(executionInput, live, operation);
        mutation.after = updatedRoute;
        expectedRoutes.splice(expectedRoutes.findIndex((route) => route.id === live.id), 1, updatedRoute);
      } else {
        const mutation = { ...operation, after: null };
        applied.push(mutation);
        const createdRoute = await createRouteWithReconciliation(executionInput, operation);
        mutation.after = createdRoute;
        expectedRoutes.push(createdRoute);
      }
      await verifyMutationState(executionInput, expectedRoutes, "production_promotion_post_mutation_drift");
    }
    const final = await verifyMutationState(executionInput, expectedRoutes, "production_promotion_post_state_invalid");
    assertRoutesEqual(final.routes, handoff.promote, "production_promotion_route_matrix_incomplete");
    const stateBody = {
      accountId: final.accountId,
      appliedAt: input.now.toISOString(),
      candidateVersionId: input.canaryState.candidateVersionId,
      ceremonyId: input.evidence.ceremonyId,
      environment: "production",
      mode: "applied",
      planSha256,
      routesAfter: final.routes,
      routesBefore: initial.routes,
      changes: applied.map((mutation) => ({
        after: mutation.after,
        before: mutation.before,
        pattern: mutation.pattern,
        script: mutation.script,
        type: mutation.type,
      })),
      routeSnapshotSha256: fingerprint(final.routes),
      schemaVersion: 1,
      stagingExceptions: handoff.stagingExceptions,
      workerName: final.workerName,
      zoneId: final.zoneId,
    };
    const state = { ...stateBody, stateSha256: fingerprint(stateBody) };
    const stateRef = typeof input.writeReportImplementation === "function"
      ? await input.writeReportImplementation(state, "applied")
      : null;
    return {
      actions: applied.map((mutation) => ({
        code: mutation.type === "delete" ? "traffic.canary_route_deleted" : "traffic.shared_zone_route_reconciled",
        detail: mutation.pattern,
        ok: true,
      })),
      environment: "production",
      executed: true,
      ok: true,
      state,
      stateRef,
    };
  } catch (error) {
    try {
      await compensate(executionInput, initial.routes, applied);
    } catch (compensationError) {
      throw new Error("production_promotion_compensation_failed", { cause: compensationError });
    }
    throw error;
  }
}

function assertPromotionState(state, input) {
  const { handoff, planSha256 } = validateProductionPromotionPlan(input);
  if (
    state?.schemaVersion !== 1
    || state.mode !== "applied"
    || state.environment !== "production"
    || state.ceremonyId !== input.evidence.ceremonyId
    || state.planSha256 !== planSha256
    || state.accountId !== input.productionSpec.accountId
    || state.zoneId !== input.productionSpec.zoneId
    || state.workerName !== input.productionSpec.workerName
    || state.candidateVersionId !== input.canaryState.candidateVersionId
    || !Array.isArray(state.routesBefore)
    || !Array.isArray(state.routesAfter)
    || !Array.isArray(state.changes)
    || !isDeepStrictEqual(state.stagingExceptions, handoff.stagingExceptions)
    || state.routeSnapshotSha256 !== fingerprint(state.routesAfter)
    || typeof state.stateSha256 !== "string"
  ) throw new Error("production_promotion_state_invalid");
  const { stateSha256, ...stateBody } = state;
  if (stateSha256 !== fingerprint(stateBody)) throw new Error("production_promotion_state_invalid");
  let routesBefore;
  let routesAfter;
  let canaryRoutesAfter;
  try {
    routesBefore = state.routesBefore.map(normalizeRoute).sort((left, right) => left.pattern.localeCompare(right.pattern));
    routesAfter = state.routesAfter.map(normalizeRoute).sort((left, right) => left.pattern.localeCompare(right.pattern));
    canaryRoutesAfter = input.canaryState.routesAfter.map(normalizeRoute)
      .sort((left, right) => left.pattern.localeCompare(right.pattern));
  } catch {
    throw new Error("production_promotion_state_invalid");
  }
  if (
    new Set(routesBefore.map((route) => route.pattern)).size !== routesBefore.length
    || new Set(routesBefore.map((route) => route.id)).size !== routesBefore.length
    || new Set(routesAfter.map((route) => route.pattern)).size !== routesAfter.length
    || new Set(routesAfter.map((route) => route.id)).size !== routesAfter.length
    || !isDeepStrictEqual(routesBefore, canaryRoutesAfter)
    || !isDeepStrictEqual(routeShape(routesAfter), routeShape(handoff.promote))
  ) throw new Error("production_promotion_state_invalid");

  const expectedOperations = buildOperations(routesBefore, handoff, input.productionSpec);
  if (state.changes.length !== expectedOperations.length) {
    throw new Error("production_promotion_state_invalid");
  }
  const beforeIds = new Set(routesBefore.map((route) => route.id));
  const createdIds = new Set();
  const normalizedChanges = [];
  let derived = [...routesBefore];
  for (let index = 0; index < state.changes.length; index += 1) {
    const change = state.changes[index];
    const expected = expectedOperations[index];
    if (
      change?.type !== expected.type
      || change.pattern !== expected.pattern
      || change.script !== expected.script
    ) throw new Error("production_promotion_state_invalid");
    let before;
    let after;
    try {
      before = change.before === null ? null : normalizeRoute(change.before);
      after = change.after === null ? null : normalizeRoute(change.after);
    } catch {
      throw new Error("production_promotion_state_invalid");
    }
    if (!isDeepStrictEqual(before, expected.before)) throw new Error("production_promotion_state_invalid");
    if (change.type === "create") {
      if (
        after === null
        || after.pattern !== expected.pattern
        || after.script !== expected.script
        || beforeIds.has(after.id)
        || createdIds.has(after.id)
      ) throw new Error("production_promotion_state_invalid");
      createdIds.add(after.id);
    }
    if (change.type === "replace" && (
      after === null
      || before === null
      || after.id !== before.id
      || after.pattern !== expected.pattern
      || after.script !== expected.script
    )) throw new Error("production_promotion_state_invalid");
    if (change.type === "delete" && after !== null) throw new Error("production_promotion_state_invalid");
    const existing = routeByPattern(derived, change.pattern);
    if (change.type === "create") {
      if (existing !== undefined) throw new Error("production_promotion_state_invalid");
      derived.push(after);
    } else {
      if (!existing || existing.id !== before.id) throw new Error("production_promotion_state_invalid");
      derived = derived.filter((route) => route.id !== before.id);
      if (after !== null) derived.push(after);
    }
    normalizedChanges.push({ ...change, after, before });
  }
  if (!isDeepStrictEqual(derived.sort((left, right) => left.pattern.localeCompare(right.pattern)), routesAfter)) {
    throw new Error("production_promotion_state_invalid");
  }
  return { ...state, routesBefore, routesAfter, changes: normalizedChanges };
}

function rollbackCheckpointMatches(actualRoutes, expectedRoutes, flexibleIds) {
  const actual = routeInventory(actualRoutes);
  const expected = routeInventory(expectedRoutes);
  if (actual.length !== expected.length) return false;
  return actual.every((route, index) => {
    const target = expected[index];
    return route.pattern === target.pattern
      && route.script === target.script
      && (flexibleIds.has(route.pattern) || route.id === target.id);
  });
}

function findRollbackCheckpoint(actualRoutes, state) {
  const reverseChanges = state.changes.slice().reverse();
  let expectedRoutes = [...state.routesAfter];
  const flexibleIds = new Set();
  const matches = [];
  for (let completed = 0; completed <= reverseChanges.length; completed += 1) {
    if (rollbackCheckpointMatches(actualRoutes, expectedRoutes, flexibleIds)) matches.push(completed);
    if (completed === reverseChanges.length) break;
    const change = reverseChanges[completed];
    const route = routeByPattern(expectedRoutes, change.pattern);
    if (change.type === "create") {
      if (!route || route.id !== change.after.id) throw new Error("production_promotion_state_invalid");
      expectedRoutes = expectedRoutes.filter((candidate) => candidate.id !== route.id);
    }
    if (change.type === "replace") {
      if (!route || route.id !== change.after.id) throw new Error("production_promotion_state_invalid");
      expectedRoutes = expectedRoutes.map((candidate) => candidate.id === route.id ? change.before : candidate);
    }
    if (change.type === "delete") {
      if (route !== undefined) throw new Error("production_promotion_state_invalid");
      expectedRoutes.push(change.before);
      flexibleIds.add(change.pattern);
    }
  }
  if (matches.length !== 1) throw new Error("production_promotion_rollback_state_drift");
  return { completed: matches[0], reverseChanges };
}

export async function runProductionPromotionRollback(input) {
  validateCommonFlags(input);
  const state = assertPromotionState(input.state, input);
  const initial = await readAndNormalizeInventory(input);
  assertIdentity(initial, input.productionSpec, input.databaseId);
  assertFreshObservedAt(
    initial.observedAt,
    liveObservationNow(input),
    "production_promotion_live_inventory_stale",
  );
  const trafficSnapshot = normalizeTrafficSnapshot(input.trafficSnapshot);
  if (!isDeepStrictEqual(domainShape(initial.domains, initial.zoneId, initial.zoneName), trafficSnapshot.domains)) {
    throw new Error("production_promotion_live_domain_drift");
  }
  if (initial.schedules?.length !== 0) throw new Error("production_promotion_cron_trigger_present");
  if (initial.queueConsumers?.some((entry) => entry.consumers?.length > 0)) {
    throw new Error("production_promotion_queue_consumer_present");
  }
  if (activeVersionId(initial) !== input.canaryState.candidateVersionId) {
    throw new Error("production_promotion_candidate_not_active");
  }
  const checkpoint = findRollbackCheckpoint(initial.routes, state);
  const remainingChanges = checkpoint.reverseChanges.slice(checkpoint.completed);
  if (!input.execute) {
    return {
      actions: remainingChanges.map((change) => ({
        code: "traffic.rollback_route_change",
        detail: change.pattern,
        ok: true,
      })),
      environment: "production",
      executed: false,
      ok: true,
    };
  }
  if (
    typeof input.createRouteImplementation !== "function"
    || typeof input.deleteRouteImplementation !== "function"
    || typeof input.updateRouteImplementation !== "function"
  ) {
    throw new Error("production_promotion_route_mutation_unavailable");
  }
  const executionInput = {
    ...input,
    baselineInvariant: {
      domains: initial.domains,
      queueConsumers: initial.queueConsumers ?? [],
      schedules: initial.schedules ?? [],
    },
    trafficSnapshot,
  };
  let current = initial;
  const expectedRoutes = [...initial.routes];
  try {
    for (const change of remainingChanges) {
      current = await verifyMutationState(
        executionInput,
        expectedRoutes,
        "production_promotion_rollback_route_drift",
      );
      const route = routeByPattern(current.routes, change.pattern);
      if (change.type === "create") {
        if (!route || route.id !== change.after.id) throw new Error("production_promotion_rollback_route_drift");
        await deleteRouteWithReconciliation(executionInput, route);
        expectedRoutes.splice(expectedRoutes.findIndex((candidate) => candidate.id === route.id), 1);
      }
      if (change.type === "replace") {
        if (!route || route.id !== change.after.id) throw new Error("production_promotion_rollback_route_drift");
        const restored = await updateRouteWithReconciliation(executionInput, route, change.before);
        expectedRoutes.splice(
          expectedRoutes.findIndex((candidate) => candidate.id === route.id),
          1,
          restored,
        );
      }
      if (change.type === "delete" && change.before !== null) {
        const restored = await createRouteWithReconciliation(executionInput, change.before);
        expectedRoutes.push(restored);
      }
      current = await verifyMutationState(
        executionInput,
        expectedRoutes,
        "production_promotion_rollback_route_drift",
      );
    }
    assertRoutesEqual(current.routes, state.routesBefore, "production_promotion_rollback_not_restored");
    const report = {
      accountId: current.accountId,
      ceremonyId: state.ceremonyId,
      environment: "production",
      mode: "rolled_back",
      rolledBackAt: input.now.toISOString(),
      restoredRouteSnapshotSha256: fingerprint(current.routes),
      schemaVersion: 1,
      workerName: current.workerName,
      zoneId: current.zoneId,
    };
    const reportRef = typeof input.writeReportImplementation === "function"
      ? await input.writeReportImplementation(report, "rollback")
      : null;
    return { actions: [{ code: "traffic_route_matrix_rolled_back", detail: state.ceremonyId, ok: true }], environment: "production", executed: true, ok: true, report, reportRef };
  } catch (error) {
    throw new Error("production_promotion_rollback_failed", { cause: error });
  }
}

export function requirePromotionAuditToken(environment) {
  const value = typeof environment?.[PROMOTION_AUDIT_TOKEN_NAME] === "string"
    ? environment[PROMOTION_AUDIT_TOKEN_NAME].trim()
    : "";
  if (!value) throw new Error(`${PROMOTION_AUDIT_TOKEN_NAME.toLowerCase()}_missing`);
  return value;
}

export function requirePromotionRouteToken(environment) {
  const value = typeof environment?.[PROMOTION_ROUTE_TOKEN_NAME] === "string"
    ? environment[PROMOTION_ROUTE_TOKEN_NAME].trim()
    : "";
  if (!value) throw new Error(`${PROMOTION_ROUTE_TOKEN_NAME.toLowerCase()}_missing`);
  return value;
}

export function buildProductionPromotionAuditEnvironment(environment, accountId, token) {
  if (!ACCOUNT_ID_PATTERN.test(accountId ?? "")) throw new Error("production_promotion_account_invalid");
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("production_promotion_audit_token_invalid");
  }
  const child = Object.fromEntries(Object.entries(environment ?? {}).filter(([name, value]) => (
    AUDIT_ENVIRONMENT_ALLOWLIST.has(name) && typeof value === "string"
  )));
  return {
    ...child,
    CI: "1",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: token.trim(),
  };
}

export async function createProductionPromotionRoute(input) {
  return cloudflareApiRequest(input.token, `/zones/${input.zoneId}/workers/routes`, {
    body: { pattern: input.pattern, script: input.script },
    fetchImplementation: input.fetchImplementation,
    method: "POST",
  });
}

export async function updateProductionPromotionRoute(input) {
  return cloudflareApiRequest(input.token, `/zones/${input.zoneId}/workers/routes/${encodeURIComponent(input.routeId)}`, {
    body: { pattern: input.pattern, script: input.script },
    fetchImplementation: input.fetchImplementation,
    method: "PUT",
  });
}

export async function deleteProductionPromotionRoute(input) {
  return cloudflareApiRequest(input.token, `/zones/${input.zoneId}/workers/routes/${encodeURIComponent(input.routeId)}`, {
    fetchImplementation: input.fetchImplementation,
    method: "DELETE",
  });
}

export async function writeProductionPromotionReport(root, ceremonyId, mode, value) {
  if (!CEREMONY_ID_PATTERN.test(ceremonyId ?? "") || !new Set(["applied", "rollback", "failure"]).has(mode)) {
    throw new Error("production_promotion_report_path_invalid");
  }
  const directory = resolve(root, ".wrangler", "bootstrap", ceremonyId);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const path = resolve(directory, `promotion-${mode}.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return `.wrangler/bootstrap/${ceremonyId}/promotion-${mode}.json`;
}
