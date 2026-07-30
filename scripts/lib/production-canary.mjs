import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { cloudflareApiRequest, parseSecretNames } from "./platform.mjs";
import { assertProductionBootstrapSpecIdentity } from "./production-bootstrap.mjs";
import { REQUIRED_PRODUCTION_VARS, REQUIRED_WORKER_SECRET_NAMES } from "./release.mjs";

export const CANARY_AUDIT_TOKEN_NAME = "CLOUDFLARE_CANARY_AUDIT_API_TOKEN";
export const CANARY_ROUTE_TOKEN_NAME = "CLOUDFLARE_CANARY_ROUTE_API_TOKEN";
export const CANARY_WORKER_TOKEN_NAME = "CLOUDFLARE_CANARY_WORKER_API_TOKEN";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40,64}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/u;
const SAFE_TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{7,80}$/u;
const CEREMONY_ID_PATTERN = /^bootstrap_[a-z0-9][a-z0-9._-]{7,72}$/u;
const MIGRATION_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/u;
const PLACEHOLDER_PATTERN = /(?:change-me|not-provisioned|placeholder|replace-with|<[^>]+>)/iu;
const BUILD_ENVIRONMENT_ALLOWLIST = new Set([
  "CI",
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

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function assertProductionCanaryStaticIdentity(input) {
  assertProductionBootstrapSpecIdentity(input.productionSpec);
  if (!isDeepStrictEqual(input.productionSpec, input.canonicalProductionSpec)) {
    throw new Error("production_canary_spec_identity_mismatch");
  }
  if (!isDeepStrictEqual(input.generatedManifest, input.canonicalGeneratedManifest)) {
    throw new Error("production_canary_manifest_identity_mismatch");
  }
  const manifest = input.generatedManifest;
  const spec = input.productionSpec;
  if (
    manifest?.environment !== "production"
    || manifest?.accountId !== spec.accountId
    || manifest?.zoneId !== spec.zoneId
    || manifest?.zoneName !== spec.zoneName
    || manifest?.workerName !== spec.workerName
    || manifest?.resources?.d1?.name !== spec.resources.d1
    || !UUID_PATTERN.test(manifest?.resources?.d1?.id ?? "")
  ) {
    throw new Error("production_canary_manifest_identity_mismatch");
  }
}

export function validateProductionCanaryPlan(input) {
  const plan = input.plan;
  const allowedMutations = ["production_candidate_worker_version", "production_canary_worker_route"];
  const routeAction = plan?.actions?.find((action) => action?.code === "traffic.canary_route");
  if (
    plan?.schemaVersion !== 1
    || plan?.phase !== "canary"
    || plan?.environment !== "production"
    || plan?.ceremonyId !== input.evidence?.ceremonyId
    || !isDeepStrictEqual(plan?.safeguards?.allowedMutations, allowedMutations)
    || plan?.fingerprints?.inventorySha256 !== fingerprint(input.trafficSnapshot)
    || plan?.fingerprints?.sourceSha256 !== fingerprint(input.repositoryState)
    || plan?.fingerprints?.specSha256 !== fingerprint(input.productionSpec)
    || routeAction?.action !== "create"
    || routeAction?.pattern !== input.productionSpec?.routing?.canaryOverrideRoute
    || routeAction?.script !== input.productionSpec?.workerName
    || !plan.actions.some((action) => action?.code === "worker.candidate_canary_only")
    || plan.actions.some((action) => action?.code === "traffic.canary_domain")
  ) {
    throw new Error("production_canary_plan_invalid");
  }
  return fingerprint(plan);
}

function parseJson(output, code) {
  try {
    return JSON.parse(String(output ?? ""));
  } catch {
    throw new Error(code);
  }
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

function requireToken(environment, name) {
  const rawValue = environment?.[name];
  const value = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!value) throw new Error(`${name.toLowerCase()}_missing`);
  return value;
}

export function requireCanaryAuditToken(environment) {
  return requireToken(environment, CANARY_AUDIT_TOKEN_NAME);
}

export function requireCanaryRouteToken(environment) {
  return requireToken(environment, CANARY_ROUTE_TOKEN_NAME);
}

export function requireCanaryWorkerToken(environment) {
  return requireToken(environment, CANARY_WORKER_TOKEN_NAME);
}

export function buildCanaryWranglerEnvironment(environment, accountId, token) {
  if (!ACCOUNT_ID_PATTERN.test(accountId ?? "")) throw new Error("production_canary_account_invalid");
  if (typeof token !== "string" || token.trim().length === 0) throw new Error("production_canary_token_invalid");
  const child = {
    ...environment,
    CI: "1",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: token.trim(),
  };
  delete child.CLOUDFLARE_OAUTH_TOKEN;
  delete child.CLOUDFLARE_API_KEY;
  delete child.CLOUDFLARE_API_USER_SERVICE_KEY;
  delete child.CLOUDFLARE_EMAIL;
  delete child.CF_API_KEY;
  delete child.CF_API_TOKEN;
  delete child[CANARY_AUDIT_TOKEN_NAME];
  delete child[CANARY_ROUTE_TOKEN_NAME];
  delete child[CANARY_WORKER_TOKEN_NAME];
  delete child.CLOUDFLARE_PLATFORM_API_TOKEN;
  delete child.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN;
  return child;
}

export function buildCanaryBuildEnvironment(environment) {
  const child = Object.fromEntries(Object.entries(environment ?? {}).filter(([name, value]) => (
    BUILD_ENVIRONMENT_ALLOWLIST.has(name) && typeof value === "string"
  )));
  return { ...child, CI: "1", CLOUDFLARE_ENV: "production" };
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
    throw new Error("production_canary_route_inventory_invalid");
  }
  return { id: route.id, pattern: route.pattern, script: route.script };
}

function normalizeDomain(domain) {
  if (
    typeof domain !== "object"
    || domain === null
    || typeof domain.hostname !== "string"
    || typeof domain.service !== "string"
  ) {
    throw new Error("production_canary_domain_inventory_invalid");
  }
  return {
    hostname: domain.hostname.toLowerCase(),
    service: domain.service,
    zoneId: typeof domain.zone_id === "string" ? domain.zone_id : typeof domain.zoneId === "string" ? domain.zoneId : null,
    zoneName: typeof domain.zone_name === "string" ? domain.zone_name.toLowerCase() : typeof domain.zoneName === "string" ? domain.zoneName.toLowerCase() : null,
  };
}

function normalizeVersions(value) {
  if (!Array.isArray(value)) throw new Error("production_canary_versions_invalid");
  return value.map((version) => {
    if (typeof version?.id !== "string" || !UUID_PATTERN.test(version.id)) {
      throw new Error("production_canary_versions_invalid");
    }
    return {
      annotations: typeof version.annotations === "object" && version.annotations !== null ? version.annotations : {},
      id: version.id,
      metadata: typeof version.metadata === "object" && version.metadata !== null ? version.metadata : {},
      number: Number.isSafeInteger(version.number) ? version.number : null,
    };
  });
}

function normalizeDeployments(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("production_canary_deployments_invalid");
  return value.map((deployment) => {
    if (
      typeof deployment?.id !== "string"
      || !UUID_PATTERN.test(deployment.id)
      || safeDate(deployment.created_on) === null
      || !Array.isArray(deployment.versions)
      || deployment.versions.length !== 1
      || typeof deployment.versions[0]?.version_id !== "string"
      || !UUID_PATTERN.test(deployment.versions[0].version_id)
      || deployment.versions[0].percentage !== 100
    ) {
      throw new Error("production_canary_deployments_invalid");
    }
    return {
      createdOn: deployment.created_on,
      id: deployment.id,
      versionId: deployment.versions[0].version_id,
    };
  }).sort((left, right) => Date.parse(right.createdOn) - Date.parse(left.createdOn));
}

function normalizeSchedules(value) {
  if (!Array.isArray(value)) throw new Error("production_canary_schedule_inventory_invalid");
  return value.map((schedule) => {
    if (typeof schedule?.cron !== "string" || schedule.cron.length < 5 || schedule.cron.length > 100) {
      throw new Error("production_canary_schedule_inventory_invalid");
    }
    return { cron: schedule.cron };
  }).sort((left, right) => left.cron.localeCompare(right.cron));
}

function normalizeQueueConsumers(queueNames, outputs) {
  return queueNames.map((queueName) => {
    const parsed = parseJson(outputs[queueName], "production_canary_queue_consumer_inventory_invalid");
    if (!Array.isArray(parsed)) throw new Error("production_canary_queue_consumer_inventory_invalid");
    return { consumers: parsed, queueName };
  });
}

function accountIdsFromWhoami(output) {
  return String(output ?? "")
    .match(/(?<![a-f0-9])[a-f0-9]{32}(?![a-f0-9])/giu)
    ?.map((value) => value.toLowerCase()) ?? [];
}

function assertDatabaseIdentity(output, databaseId, databaseName) {
  const databases = parseJson(output, "production_canary_database_inventory_invalid");
  if (!Array.isArray(databases)) throw new Error("production_canary_database_inventory_invalid");
  const matches = databases.filter((database) => database?.name === databaseName);
  if (matches.length !== 1 || matches[0]?.uuid !== databaseId) {
    throw new Error("production_canary_database_identity_mismatch");
  }
}

export async function discoverProductionCanaryInventory(input) {
  const spec = input.productionSpec;
  if (
    spec?.environment !== "production"
    || !ACCOUNT_ID_PATTERN.test(spec?.accountId ?? "")
    || !ACCOUNT_ID_PATTERN.test(spec?.zoneId ?? "")
    || typeof spec?.zoneName !== "string"
    || typeof spec?.workerName !== "string"
  ) {
    throw new Error("production_canary_spec_invalid");
  }
  const runner = input.runWranglerImplementation;
  if (typeof runner !== "function") throw new Error("production_canary_runner_missing");
  const cwd = input.repositoryRoot;
  const env = input.commandEnvironment;
  const run = (args) => runner(args, { cwd, env }).stdout;
  const queueNames = [
    spec.resources?.integrationQueue,
    spec.resources?.notificationQueue,
    spec.resources?.deadLetterQueue,
  ];
  if (queueNames.some((name) => typeof name !== "string")) throw new Error("production_canary_spec_invalid");

  // Establish CLI identity before making the broader live inventory calls.
  const whoami = run(["whoami", "--json"]);
  if (!accountIdsFromWhoami(whoami).includes(spec.accountId.toLowerCase())) {
    throw new Error("production_canary_account_identity_mismatch");
  }
  const d1Output = run(["d1", "list", "--env", "production", "--json"]);
  assertDatabaseIdentity(d1Output, input.databaseId, spec.resources.d1);
  const secretNames = parseSecretNames(run(["secret", "list", "--name", spec.workerName]));

  const [routes, domains, schedulesResult] = await Promise.all([
    cloudflareApiRequest(input.auditToken, `/zones/${spec.zoneId}/workers/routes`, {
      fetchImplementation: input.fetchImplementation,
    }),
    cloudflareApiRequest(input.auditToken, `/accounts/${spec.accountId}/workers/domains`, {
      fetchImplementation: input.fetchImplementation,
    }),
    cloudflareApiRequest(input.auditToken, `/accounts/${spec.accountId}/workers/scripts/${encodeURIComponent(spec.workerName)}/schedules`, {
      fetchImplementation: input.fetchImplementation,
    }),
  ]);
  const schedules = Array.isArray(schedulesResult) ? schedulesResult : schedulesResult?.schedules;
  const deployments = parseJson(
    run(["deployments", "list", "--env", "production", "--json"]),
    "production_canary_deployments_invalid",
  );
  const versions = parseJson(
    run(["versions", "list", "--env", "production", "--json"]),
    "production_canary_versions_invalid",
  );
  const queueOutputs = Object.fromEntries(queueNames.map((queueName) => [
    queueName,
    run(["queues", "consumer", "list", queueName, "--json"]),
  ]));
  return normalizeCanaryInventory({
    accountId: spec.accountId,
    databaseId: input.databaseId,
    databaseName: spec.resources.d1,
    deployments,
    domains,
    observedAt: (input.now ?? new Date()).toISOString(),
    queueConsumers: normalizeQueueConsumers(queueNames, queueOutputs),
    routes,
    schedules,
    secretNames,
    versions,
    workerName: spec.workerName,
    zoneId: spec.zoneId,
    zoneName: spec.zoneName,
  });
}

export function normalizeCanaryInventory(input) {
  if (
    !ACCOUNT_ID_PATTERN.test(input?.accountId ?? "")
    || !ACCOUNT_ID_PATTERN.test(input?.zoneId ?? "")
    || !UUID_PATTERN.test(input?.databaseId ?? "")
    || typeof input?.databaseName !== "string"
    || typeof input?.workerName !== "string"
    || typeof input?.zoneName !== "string"
    || safeDate(input?.observedAt) === null
    || !Array.isArray(input?.routes)
    || !Array.isArray(input?.domains)
    || !Array.isArray(input?.queueConsumers)
    || !Array.isArray(input?.secretNames)
  ) {
    throw new Error("production_canary_inventory_invalid");
  }
  const routes = input.routes.map(normalizeRoute).sort((left, right) => left.pattern.localeCompare(right.pattern));
  if (new Set(routes.map((route) => route.pattern)).size !== routes.length) {
    throw new Error("production_canary_route_inventory_invalid");
  }
  const domains = input.domains.map(normalizeDomain).sort((left, right) => left.hostname.localeCompare(right.hostname));
  if (new Set(domains.map((domain) => domain.hostname)).size !== domains.length) {
    throw new Error("production_canary_domain_inventory_invalid");
  }
  return {
    accountId: input.accountId,
    databaseId: input.databaseId,
    databaseName: input.databaseName,
    deployments: normalizeDeployments(input.deployments),
    domains,
    observedAt: input.observedAt,
    queueConsumers: input.queueConsumers.map((entry) => {
      if (typeof entry?.queueName !== "string" || !Array.isArray(entry.consumers)) {
        throw new Error("production_canary_queue_consumer_inventory_invalid");
      }
      return { consumers: entry.consumers, queueName: entry.queueName };
    }).sort((left, right) => left.queueName.localeCompare(right.queueName)),
    routes,
    schedules: normalizeSchedules(input.schedules),
    secretNames: [...new Set(input.secretNames.map((name) => {
      if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{1,127}$/u.test(name)) {
        throw new Error("production_canary_secret_inventory_invalid");
      }
      return name;
    }))].sort(),
    versions: normalizeVersions(input.versions),
    workerName: input.workerName,
    zoneId: input.zoneId,
    zoneName: input.zoneName.toLowerCase(),
  };
}

function routeShape(routes) {
  return routes.map(({ pattern, script }) => ({ pattern, script })).sort((left, right) => left.pattern.localeCompare(right.pattern));
}

function domainShape(domains, zoneId, zoneName) {
  return domains
    .filter((domain) => domain.zoneId === zoneId || domain.zoneName === zoneName)
    .map(({ hostname, service }) => ({ hostname, service }))
    .sort((left, right) => left.hostname.localeCompare(right.hostname));
}

function assertSavedTrafficSnapshot(inventory, snapshot) {
  if (!Array.isArray(snapshot?.routes) || !Array.isArray(snapshot?.domains)) {
    throw new Error("production_canary_traffic_snapshot_invalid");
  }
  const expectedRoutes = snapshot.routes
    .map((route) => ({ pattern: route?.pattern, script: route?.script ?? null }))
    .sort((left, right) => String(left.pattern).localeCompare(String(right.pattern)));
  if (!isDeepStrictEqual(routeShape(inventory.routes), expectedRoutes)) {
    throw new Error("production_canary_saved_routes_mismatch");
  }
  const expectedDomains = snapshot.domains
    .map((domain) => ({ hostname: domain?.hostname?.toLowerCase(), service: domain?.service }))
    .sort((left, right) => String(left.hostname).localeCompare(String(right.hostname)));
  if (!isDeepStrictEqual(domainShape(inventory.domains, inventory.zoneId, inventory.zoneName), expectedDomains)) {
    throw new Error("production_canary_saved_domains_mismatch");
  }
}

function assertIdleProductionTriggers(inventory) {
  if (inventory.schedules.length !== 0) throw new Error("production_canary_cron_trigger_present");
  const activeConsumers = inventory.queueConsumers.filter((entry) => entry.consumers.length > 0);
  if (activeConsumers.length > 0) {
    throw new Error(`production_canary_queue_consumer_present:${activeConsumers[0].queueName}`);
  }
}

function assertRuntimeSecrets(inventory) {
  const names = new Set(inventory.secretNames);
  const missing = REQUIRED_WORKER_SECRET_NAMES.find((name) => !names.has(name));
  if (missing !== undefined) throw new Error(`production_canary_worker_secret_missing:${missing}`);
}

function assertTargetIdentity(inventory, input) {
  if (
    inventory.accountId !== input.productionSpec.accountId
    || inventory.zoneId !== input.productionSpec.zoneId
    || inventory.zoneName !== input.productionSpec.zoneName
    || inventory.workerName !== input.productionSpec.workerName
    || inventory.databaseName !== input.productionSpec.resources.d1
    || inventory.databaseId !== input.databaseId
  ) {
    throw new Error("production_canary_target_identity_mismatch");
  }
}

function assertNoProductionTraffic(inventory, productionSpec) {
  if (inventory.routes.some((route) => route.script === productionSpec.workerName)) {
    throw new Error("production_canary_existing_worker_route");
  }
  if (inventory.domains.some((domain) => domain.service === productionSpec.workerName)) {
    throw new Error("production_canary_existing_worker_domain");
  }
}

function assertRepositoryState(repositoryState, evidence) {
  if (repositoryState?.clean !== true) throw new Error("production_canary_source_dirty");
  if (!GIT_OBJECT_PATTERN.test(repositoryState?.commitSha ?? "") || !GIT_OBJECT_PATTERN.test(repositoryState?.treeSha ?? "")) {
    throw new Error("production_canary_repository_state_invalid");
  }
  if (evidence?.reviewedCommitSha !== repositoryState.commitSha) throw new Error("production_canary_reviewed_commit_mismatch");
  if (evidence?.reviewedTreeSha !== repositoryState.treeSha) throw new Error("production_canary_reviewed_tree_mismatch");
}

function assertUploadEvidence(evidence, migrationNames, now) {
  const completedAt = safeDate(evidence?.backup?.completedAt);
  const restoreAt = safeDate(evidence?.backup?.restoreDrillCompletedAt);
  const migratedAt = safeDate(evidence?.migrations?.appliedAt);
  const currentTime = now.getTime();
  if (
    evidence?.schemaVersion !== 1
    || evidence?.environment !== "production"
    || evidence?.phase !== "canary"
    || !CEREMONY_ID_PATTERN.test(evidence?.ceremonyId ?? "")
    || !configuredReference(evidence?.preBootstrapTrafficSnapshotRef)
    || !configuredReference(evidence?.resourceManifestRef)
    || !configuredReference(evidence?.backup?.snapshotReportRef)
    || !configuredReference(evidence?.backup?.restoreDrillReportRef)
    || evidence?.backup?.providerBookmarkRecorded !== true
    || evidence?.backup?.emptyDatabaseBaselineVerified !== true
    || evidence?.backup?.restoreDrillPassed !== true
    || completedAt === null
    || restoreAt === null
    || migratedAt === null
    || completedAt > currentTime
    || currentTime - completedAt > 24 * 60 * 60_000
    || restoreAt < completedAt
    || migratedAt < completedAt
    || evidence?.migrations?.direction !== "forward_only"
    || !isDeepStrictEqual(evidence?.migrations?.names, migrationNames)
    || evidence?.candidateWorkerVersion !== null
    || evidence?.previousWorkerVersion !== null
    || evidence?.canary?.accepted !== false
    || evidence?.rollback?.strategy !== "restore_pre_bootstrap_traffic_inventory"
    || evidence?.rollback?.snapshotRef !== evidence.preBootstrapTrafficSnapshotRef
  ) {
    throw new Error("production_canary_upload_evidence_incomplete");
  }
}

function activeVersionId(inventory) {
  return inventory.deployments[0].versionId;
}

function assertBaseInventory(input, inventory) {
  assertTargetIdentity(inventory, input);
  assertNoProductionTraffic(inventory, input.productionSpec);
  assertSavedTrafficSnapshot(inventory, input.trafficSnapshot);
  assertIdleProductionTriggers(inventory);
  assertRuntimeSecrets(inventory);
  if (
    input.plan?.safeguards?.secretNamesFingerprintSha256 !== undefined
    && input.plan.safeguards.secretNamesFingerprintSha256 !== fingerprint(inventory.secretNames)
  ) {
    throw new Error("production_canary_plan_secret_inventory_drift");
  }
  const canaryRoute = input.productionSpec.routing?.canaryOverrideRoute;
  if (canaryRoute !== `canary.${input.productionSpec.zoneName}/*`) {
    throw new Error("production_canary_route_contract_invalid");
  }
  if (inventory.routes.some((route) => route.pattern === canaryRoute)) {
    throw new Error("production_canary_route_already_present");
  }
}

function invariantInventory(inventory) {
  return {
    accountId: inventory.accountId,
    databaseId: inventory.databaseId,
    databaseName: inventory.databaseName,
    deployments: inventory.deployments,
    domains: inventory.domains,
    queueConsumers: inventory.queueConsumers,
    routes: inventory.routes,
    schedules: inventory.schedules,
    secretNames: inventory.secretNames,
    workerName: inventory.workerName,
    zoneId: inventory.zoneId,
    zoneName: inventory.zoneName,
  };
}

function assertUploadRouteNeutral(before, after) {
  const beforeValue = invariantInventory(before);
  const afterValue = invariantInventory(after);
  beforeValue.deployments = before.deployments;
  afterValue.deployments = after.deployments;
  if (!isDeepStrictEqual(beforeValue, afterValue)) {
    throw new Error("production_canary_upload_changed_live_state");
  }
}

function candidateFromInventories(before, after) {
  const beforeIds = new Set(before.versions.map((version) => version.id));
  const added = after.versions.filter((version) => !beforeIds.has(version.id));
  if (added.length !== 1) throw new Error("production_canary_candidate_capture_invalid");
  if (added[0].metadata?.has_preview !== false) throw new Error("production_canary_preview_url_enabled");
  return added[0];
}

function candidateBindingContract(input) {
  const production = input.wranglerConfig?.env?.production;
  const spec = input.productionSpec;
  const manifest = input.generatedManifest;
  if (
    production?.name !== spec?.workerName
    || manifest?.accountId !== spec?.accountId
    || manifest?.zoneId !== spec?.zoneId
    || manifest?.workerName !== spec?.workerName
    || manifest?.resources?.d1?.name !== spec?.resources?.d1
  ) {
    throw new Error("production_canary_candidate_contract_invalid");
  }
  const expected = new Map();
  for (const name of REQUIRED_PRODUCTION_VARS) {
    const value = production?.vars?.[name];
    if (typeof value !== "string") throw new Error("production_canary_candidate_contract_invalid");
    expected.set(name, { text: value, type: "plain_text" });
  }
  for (const name of REQUIRED_WORKER_SECRET_NAMES) expected.set(name, { type: "secret_text" });
  expected.set("ASSETS", { type: "assets" });
  expected.set("EMAIL", {
    allowed_sender_addresses: production?.send_email?.find((binding) => binding?.name === "EMAIL")?.allowed_sender_addresses,
    type: "send_email",
  });
  expected.set("INTEGRATION_QUEUE", { queue_name: spec.resources.integrationQueue, type: "queue" });
  expected.set("NOTIFICATION_QUEUE", { queue_name: spec.resources.notificationQueue, type: "queue" });
  expected.set("MEDIA", { bucket_name: spec.resources.r2, type: "r2_bucket" });
  expected.set("PRIVATE_EXPORTS", { bucket_name: spec.resources.privateExports, type: "r2_bucket" });
  expected.set("PLATFORM_CACHE", { namespace_id: manifest?.resources?.platformCacheKv?.id, type: "kv_namespace" });
  expected.set("SESSION", { namespace_id: manifest?.resources?.sessionKv?.id, type: "kv_namespace" });
  expected.set("PLATFORM_DB", { database_id: manifest?.resources?.d1?.id, id: manifest?.resources?.d1?.id, type: "d1" });
  if ([...expected.values()].some((binding) => Object.values(binding).some((value) => value === undefined))) {
    throw new Error("production_canary_candidate_contract_invalid");
  }
  return expected;
}

export function validateCandidateVersionView(view, candidateVersionId, input) {
  if (
    view?.id !== candidateVersionId
    || view?.metadata?.has_preview !== false
    || !Array.isArray(view?.resources?.bindings)
    || !Array.isArray(view?.resources?.script?.handlers)
    || !view.resources.script.handlers.includes("fetch")
  ) {
    throw new Error("production_canary_candidate_view_invalid");
  }
  const expected = candidateBindingContract(input);
  const observed = new Map();
  for (const binding of view.resources.bindings) {
    if (typeof binding?.name !== "string" || observed.has(binding.name)) {
      throw new Error("production_canary_candidate_binding_inventory_invalid");
    }
    observed.set(binding.name, binding);
  }
  const missing = [...expected.keys()].find((name) => !observed.has(name));
  if (missing !== undefined) throw new Error(`production_canary_candidate_binding_missing:${missing}`);
  const unexpected = [...observed.keys()].find((name) => !expected.has(name));
  if (unexpected !== undefined) throw new Error(`production_canary_candidate_binding_unexpected:${unexpected}`);
  for (const [name, expectedBinding] of expected) {
    const observedBinding = observed.get(name);
    for (const [field, expectedValue] of Object.entries(expectedBinding)) {
      if (!isDeepStrictEqual(observedBinding?.[field], expectedValue)) {
        throw new Error(`production_canary_candidate_binding_mismatch:${name}:${field}`);
      }
    }
  }
  return [...observed.keys()].sort();
}

function validateCommonMutationFlags(input) {
  if (input.execute !== true) return;
  if (input.confirmProduction !== true) throw new Error("production_confirmation_required");
  if (input.confirmFirstProductionBootstrap !== true) throw new Error("production_first_bootstrap_confirmation_required");
}

export async function runProductionCanaryUpload(input) {
  validateCommonMutationFlags(input);
  const planSha256 = validateProductionCanaryPlan(input);
  if (!SAFE_TAG_PATTERN.test(input.tag ?? "") || PLACEHOLDER_PATTERN.test(input.tag)) {
    throw new Error("production_canary_tag_invalid");
  }
  if (!Array.isArray(input.migrationNames) || input.migrationNames.some((name) => !MIGRATION_PATTERN.test(name))) {
    throw new Error("production_canary_migration_inventory_invalid");
  }
  assertRepositoryState(input.repositoryState, input.evidence);
  assertUploadEvidence(input.evidence, input.migrationNames, input.now);
  const before = normalizeCanaryInventory(await input.inventoryImplementation());
  assertBaseInventory(input, before);
  if (!input.execute) {
    return {
      actions: [
        { code: "worker_version_upload", detail: "wrangler versions upload --strict", ok: true },
        { code: "route_neutrality_verify", detail: "routes_domains_deployments_queues_crons", ok: true },
      ],
      environment: "production",
      executed: false,
      ok: true,
    };
  }

  await input.buildImplementation();
  const admitted = normalizeCanaryInventory(await input.inventoryImplementation());
  assertBaseInventory(input, admitted);
  if (!isDeepStrictEqual(invariantInventory(before), invariantInventory(admitted))) {
    throw new Error("production_canary_admission_changed");
  }
  await input.uploadImplementation();
  const after = normalizeCanaryInventory(await input.inventoryImplementation());
  assertUploadRouteNeutral(admitted, after);
  const candidate = candidateFromInventories(admitted, after);
  const versionView = await input.versionViewImplementation(candidate.id);
  const bindingNames = validateCandidateVersionView(versionView, candidate.id, {
    generatedManifest: input.generatedManifest,
    productionSpec: input.productionSpec,
    wranglerConfig: input.wranglerConfig,
  });
  const report = {
    accountId: after.accountId,
    bindingNames,
    candidateVersionId: candidate.id,
    ceremonyId: input.evidence.ceremonyId,
    controlVersionId: activeVersionId(admitted),
    createdAt: input.now.toISOString(),
    environment: "production",
    mode: "upload",
    planSha256,
    reviewedCommitSha: input.repositoryState.commitSha,
    reviewedTreeSha: input.repositoryState.treeSha,
    routeSnapshot: admitted.routes,
    routeSnapshotSha256: fingerprint(admitted.routes),
    schemaVersion: 1,
    tag: input.tag,
    triggerSnapshotSha256: fingerprint({ queueConsumers: admitted.queueConsumers, schedules: admitted.schedules }),
    workerName: after.workerName,
    zoneId: after.zoneId,
  };
  const reportRef = await input.writeReportImplementation(report, "upload");
  return {
    actions: [
      { code: "worker_version_uploaded", detail: candidate.id, ok: true },
      { code: "route_neutrality_verified", detail: report.routeSnapshotSha256, ok: true },
    ],
    candidateVersionId: candidate.id,
    environment: "production",
    executed: true,
    ok: true,
    report,
    reportRef,
  };
}

function assertUploadReport(input) {
  const report = input.uploadReport;
  const planSha256 = validateProductionCanaryPlan(input);
  if (
    report?.schemaVersion !== 1
    || report?.mode !== "upload"
    || report?.environment !== "production"
    || report?.ceremonyId !== input.evidence?.ceremonyId
    || report?.reviewedCommitSha !== input.repositoryState?.commitSha
    || report?.reviewedTreeSha !== input.repositoryState?.treeSha
    || report?.accountId !== input.productionSpec?.accountId
    || report?.zoneId !== input.productionSpec?.zoneId
    || report?.workerName !== input.productionSpec?.workerName
    || report?.planSha256 !== planSha256
    || !UUID_PATTERN.test(report?.candidateVersionId ?? "")
    || !UUID_PATTERN.test(report?.controlVersionId ?? "")
    || report.candidateVersionId === report.controlVersionId
    || !Array.isArray(report?.routeSnapshot)
    || report?.routeSnapshotSha256 !== fingerprint(report.routeSnapshot)
    || input.evidence?.candidateWorkerVersion !== report.candidateVersionId
  ) {
    throw new Error("production_canary_upload_report_invalid");
  }
  assertRepositoryState(input.repositoryState, input.evidence);
  return report;
}

function assertRouteSnapshot(inventory, routes, code) {
  if (!isDeepStrictEqual(inventory.routes, routes)) throw new Error(code);
}

function assertNonDeploymentInventoryUnchanged(before, after, code) {
  if (
    !isDeepStrictEqual(before.routes, after.routes)
    || !isDeepStrictEqual(before.domains, after.domains)
    || !isDeepStrictEqual(before.queueConsumers, after.queueConsumers)
    || !isDeepStrictEqual(before.schedules, after.schedules)
    || !isDeepStrictEqual(before.secretNames, after.secretNames)
  ) {
    throw new Error(code);
  }
}

function assertCandidateActive(inventory, candidateVersionId) {
  if (activeVersionId(inventory) !== candidateVersionId) {
    throw new Error("production_canary_candidate_not_active");
  }
}

function assertCanaryRouteApplied(before, after, pattern, workerName, routeId) {
  if (before.routes.some((route) => route.id === routeId)) {
    throw new Error("production_canary_route_apply_mismatch");
  }
  const expected = [...before.routes, { id: routeId, pattern, script: workerName }]
    .sort((left, right) => left.pattern.localeCompare(right.pattern));
  if (!isDeepStrictEqual(after.routes, expected)) throw new Error("production_canary_route_apply_mismatch");
  if (
    !isDeepStrictEqual(before.domains, after.domains)
    || !isDeepStrictEqual(before.queueConsumers, after.queueConsumers)
    || !isDeepStrictEqual(before.schedules, after.schedules)
  ) {
    throw new Error("production_canary_route_apply_changed_unapproved_state");
  }
}

export async function runProductionCanaryApply(input) {
  validateCommonMutationFlags(input);
  const report = assertUploadReport(input);
  const initial = normalizeCanaryInventory(await input.inventoryImplementation());
  assertBaseInventory(input, initial);
  assertRouteSnapshot(initial, report.routeSnapshot, "production_canary_route_snapshot_drift");
  if (activeVersionId(initial) !== report.controlVersionId) {
    throw new Error("production_canary_control_version_drift");
  }
  if (!initial.versions.some((version) => version.id === report.candidateVersionId)) {
    throw new Error("production_canary_candidate_missing");
  }
  if (!input.execute) {
    return {
      actions: [
        { code: "candidate_deployment", detail: report.candidateVersionId, ok: true },
        { code: "canary_route_create", detail: input.productionSpec.routing.canaryOverrideRoute, ok: true },
      ],
      environment: "production",
      executed: false,
      ok: true,
    };
  }

  let candidateDeployed = false;
  let createdRouteId = null;
  try {
    await input.deployVersionImplementation(report.candidateVersionId);
    candidateDeployed = true;
    const deployed = normalizeCanaryInventory(await input.inventoryImplementation());
    assertNonDeploymentInventoryUnchanged(initial, deployed, "production_canary_deploy_changed_live_state");
    assertIdleProductionTriggers(deployed);
    assertCandidateActive(deployed, report.candidateVersionId);
    const routePattern = input.productionSpec.routing.canaryOverrideRoute;
    const workerName = input.productionSpec.workerName;
    const createdRoute = await input.createRouteImplementation({
      pattern: routePattern,
      script: workerName,
    });
    createdRouteId = typeof createdRoute?.id === "string" ? createdRoute.id : null;
    if (
      typeof createdRoute?.id !== "string"
      || !SAFE_ID_PATTERN.test(createdRoute.id)
      || (createdRoute.pattern !== undefined && createdRoute.pattern !== routePattern)
      || (createdRoute.script !== undefined && createdRoute.script !== workerName)
    ) {
      throw new Error("production_canary_route_create_response_invalid");
    }
    const after = normalizeCanaryInventory(await input.inventoryImplementation());
    assertCandidateActive(after, report.candidateVersionId);
    assertCanaryRouteApplied(deployed, after, routePattern, workerName, createdRoute.id);
    const state = {
      accountId: after.accountId,
      appliedAt: input.now.toISOString(),
      candidateVersionId: report.candidateVersionId,
      canaryRoute: { id: createdRoute.id, pattern: routePattern, script: workerName },
      ceremonyId: report.ceremonyId,
      controlVersionId: report.controlVersionId,
      environment: "production",
      mode: "applied",
      planSha256: report.planSha256,
      routesAfter: after.routes,
      routesBefore: deployed.routes,
      schemaVersion: 1,
      triggerSnapshotSha256: fingerprint({ queueConsumers: after.queueConsumers, schedules: after.schedules }),
      workerName: after.workerName,
      zoneId: after.zoneId,
    };
    const stateRef = await input.writeReportImplementation(state, "applied");
    return {
      actions: [
        { code: "candidate_deployed", detail: report.candidateVersionId, ok: true },
        { code: "canary_route_created", detail: routePattern, ok: true },
      ],
      environment: "production",
      executed: true,
      ok: true,
      state,
      stateRef,
    };
  } catch (error) {
    if (!candidateDeployed) throw error;
    let compensationFailed = false;
    if (createdRouteId !== null && typeof input.deleteRouteImplementation === "function") {
      try {
        await input.deleteRouteImplementation(createdRouteId);
      } catch {
        compensationFailed = true;
      }
    }
    try {
      await input.deployVersionImplementation(report.controlVersionId);
    } catch {
      compensationFailed = true;
    }
    try {
      const restored = normalizeCanaryInventory(await input.inventoryImplementation());
      assertNonDeploymentInventoryUnchanged(initial, restored, "production_canary_apply_compensation_state_drift");
      if (activeVersionId(restored) !== report.controlVersionId) {
        compensationFailed = true;
      }
    } catch {
      compensationFailed = true;
    }
    if (compensationFailed) throw new Error("production_canary_apply_compensation_failed", { cause: error });
    throw error;
  }
}

function assertCanaryState(input) {
  const state = input.canaryState;
  const planSha256 = validateProductionCanaryPlan(input);
  if (
    state?.schemaVersion !== 1
    || state?.mode !== "applied"
    || state?.environment !== "production"
    || state?.accountId !== input.productionSpec?.accountId
    || state?.zoneId !== input.productionSpec?.zoneId
    || state?.workerName !== input.productionSpec?.workerName
    || state?.planSha256 !== planSha256
    || state?.ceremonyId !== input.evidence?.ceremonyId
    || !UUID_PATTERN.test(state?.candidateVersionId ?? "")
    || !UUID_PATTERN.test(state?.controlVersionId ?? "")
    || typeof state?.canaryRoute?.id !== "string"
    || !SAFE_ID_PATTERN.test(state.canaryRoute.id)
    || state.canaryRoute.pattern !== input.productionSpec?.routing?.canaryOverrideRoute
    || state.canaryRoute.script !== input.productionSpec?.workerName
    || !Array.isArray(state?.routesBefore)
    || !Array.isArray(state?.routesAfter)
  ) {
    throw new Error("production_canary_state_invalid");
  }
  let routesBefore;
  let routesAfter;
  try {
    routesBefore = state.routesBefore.map(normalizeRoute).sort((left, right) => left.pattern.localeCompare(right.pattern));
    routesAfter = state.routesAfter.map(normalizeRoute).sort((left, right) => left.pattern.localeCompare(right.pattern));
  } catch {
    throw new Error("production_canary_state_invalid");
  }
  const route = { id: state.canaryRoute.id, pattern: state.canaryRoute.pattern, script: state.canaryRoute.script };
  const expectedAfter = [...routesBefore, route].sort((left, right) => left.pattern.localeCompare(right.pattern));
  if (
    routesBefore.some((entry) => entry.pattern === route.pattern || entry.id === route.id)
    || !isDeepStrictEqual(routesAfter, expectedAfter)
  ) {
    throw new Error("production_canary_state_route_mismatch");
  }
  return state;
}

export async function runProductionCanaryRollback(input) {
  validateCommonMutationFlags(input);
  const state = assertCanaryState(input);
  const initial = normalizeCanaryInventory(await input.inventoryImplementation());
  assertCandidateActive(initial, state.candidateVersionId);
  assertRouteSnapshot(initial, state.routesAfter, "production_canary_rollback_route_drift");
  assertIdleProductionTriggers(initial);
  if (!input.execute) {
    return {
      actions: [
        { code: "canary_route_delete", detail: state.canaryRoute.pattern, ok: true },
        { code: "control_version_restore", detail: state.controlVersionId, ok: true },
      ],
      environment: "production",
      executed: false,
      ok: true,
    };
  }

  await input.deleteRouteImplementation(state.canaryRoute.id);
  const routeRestored = normalizeCanaryInventory(await input.inventoryImplementation());
  assertRouteSnapshot(routeRestored, state.routesBefore, "production_canary_rollback_routes_not_restored");
  assertCandidateActive(routeRestored, state.candidateVersionId);
  assertIdleProductionTriggers(routeRestored);
  await input.deployVersionImplementation(state.controlVersionId);
  const final = normalizeCanaryInventory(await input.inventoryImplementation());
  assertRouteSnapshot(final, state.routesBefore, "production_canary_rollback_final_route_drift");
  assertIdleProductionTriggers(final);
  if (activeVersionId(final) !== state.controlVersionId) {
    throw new Error("production_canary_control_version_not_restored");
  }
  const report = {
    accountId: final.accountId,
    candidateVersionId: state.candidateVersionId,
    canaryRouteId: state.canaryRoute.id,
    controlVersionId: state.controlVersionId,
    environment: "production",
    mode: "rolled_back",
    rolledBackAt: input.now.toISOString(),
    schemaVersion: 1,
    workerName: final.workerName,
    zoneId: final.zoneId,
  };
  const reportRef = await input.writeReportImplementation(report, "rollback");
  return {
    actions: [
      { code: "canary_route_deleted", detail: state.canaryRoute.pattern, ok: true },
      { code: "control_version_restored", detail: state.controlVersionId, ok: true },
    ],
    environment: "production",
    executed: true,
    ok: true,
    report,
    reportRef,
  };
}

export async function createProductionCanaryRoute(input) {
  return cloudflareApiRequest(input.token, `/zones/${input.zoneId}/workers/routes`, {
    body: { pattern: input.pattern, script: input.script },
    fetchImplementation: input.fetchImplementation,
    method: "POST",
  });
}

export async function deleteProductionCanaryRoute(input) {
  return cloudflareApiRequest(input.token, `/zones/${input.zoneId}/workers/routes/${encodeURIComponent(input.routeId)}`, {
    fetchImplementation: input.fetchImplementation,
    method: "DELETE",
  });
}

export async function writeProductionCanaryReport(root, ceremonyId, mode, value) {
  if (!CEREMONY_ID_PATTERN.test(ceremonyId ?? "") || !new Set(["applied", "rollback", "upload"]).has(mode)) {
    throw new Error("production_canary_report_path_invalid");
  }
  const directory = resolve(root, ".wrangler", "bootstrap", ceremonyId);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const path = resolve(directory, `canary-${mode}.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return `.wrangler/bootstrap/${ceremonyId}/canary-${mode}.json`;
}
