import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { REQUIRED_WORKER_SECRET_NAMES } from "./release.mjs";
import { validateStagingRouteInventory } from "./platform.mjs";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/u;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40,64}$/u;
const CEREMONY_ID_PATTERN = /^bootstrap_[a-z0-9][a-z0-9._-]{7,72}$/u;
const WORKER_VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{5,160}$/u;
const PLACEHOLDER_PATTERN = /(?:change-me|not-provisioned|placeholder|replace-with|<[^>]+>)/iu;
const PHASES = new Set(["resources", "canary", "promote"]);

const RESOURCE_DESCRIPTORS = [
  { key: "d1", kind: "d1", requiresId: true },
  { key: "r2", kind: "r2", requiresId: false },
  { key: "privateExports", kind: "r2", requiresId: false },
  { key: "platformCacheKv", kind: "kv", requiresId: true },
  { key: "sessionKv", kind: "kv", requiresId: true },
  { key: "integrationQueue", kind: "queue", requiresId: false },
  { key: "notificationQueue", kind: "queue", requiresId: false },
  { key: "deadLetterQueue", kind: "queue", requiresId: false },
];

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

function safeDate(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function configuredReference(value) {
  return typeof value === "string"
    && value.trim().length >= 8
    && value.length <= 240
    && !PLACEHOLDER_PATTERN.test(value);
}

function exactKeys(value, keys, code) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) throw new Error(code);
}

function assertRepositoryState(repositoryState, evidence) {
  exactKeys(repositoryState, ["clean", "commitSha", "treeSha"], "production_bootstrap_repository_state_invalid");
  if (repositoryState.clean !== true) throw new Error("production_bootstrap_source_dirty");
  if (!GIT_OBJECT_PATTERN.test(repositoryState.commitSha ?? "")) {
    throw new Error("production_bootstrap_commit_unavailable");
  }
  if (!GIT_OBJECT_PATTERN.test(repositoryState.treeSha ?? "")) {
    throw new Error("production_bootstrap_tree_unavailable");
  }
  if (evidence?.reviewedCommitSha !== repositoryState.commitSha) {
    throw new Error("production_bootstrap_reviewed_commit_mismatch");
  }
  if (evidence?.reviewedTreeSha !== repositoryState.treeSha) {
    throw new Error("production_bootstrap_reviewed_tree_mismatch");
  }
}

function assertProductionSpecContract(productionSpec) {
  const zoneName = productionSpec?.zoneName;
  if (
    productionSpec?.environment !== "production"
    || !ACCOUNT_ID_PATTERN.test(productionSpec?.accountId ?? "")
    || !ACCOUNT_ID_PATTERN.test(productionSpec?.zoneId ?? "")
    || zoneName !== "selinow.com"
    || productionSpec.workerName !== "selinow-com-production"
  ) {
    throw new Error("production_bootstrap_spec_identity_invalid");
  }

  exactKeys(
    productionSpec.hostnames,
    ["api", "dashboard", "marketing"],
    "production_bootstrap_hostname_contract_invalid",
  );
  if (
    productionSpec.hostnames.marketing !== zoneName
    || productionSpec.hostnames.dashboard !== `app.${zoneName}`
    || productionSpec.hostnames.api !== `api.${zoneName}`
  ) {
    throw new Error("production_bootstrap_hostname_contract_invalid");
  }

  exactKeys(
    productionSpec.bootstrap,
    ["canaryHostname", "firstVersionRollback", "promotionStrategy"],
    "production_bootstrap_traffic_strategy_invalid",
  );
  if (
    productionSpec.bootstrap.canaryHostname !== `canary.${zoneName}`
    || productionSpec.bootstrap.firstVersionRollback !== "restore_pre_bootstrap_traffic_inventory"
    || productionSpec.bootstrap.promotionStrategy !== "canary_then_stable_domains"
  ) {
    throw new Error("production_bootstrap_traffic_strategy_invalid");
  }

  exactKeys(
    productionSpec.routing,
    [
      "canaryOverrideRoute",
      "externalCustomDomainFallbackRoute",
      "externalCustomDomainStrategy",
      "platformApexRoute",
      "platformStorefrontWildcard",
      "routeHandoff",
      "stagingExternalCustomDomainInventory",
      "stagingRouteExceptions",
    ],
    "production_bootstrap_route_strategy_invalid",
  );
  if (
    productionSpec.routing.canaryOverrideRoute !== `canary.${zoneName}/*`
    || productionSpec.routing.externalCustomDomainFallbackRoute !== "*/*"
    || productionSpec.routing.externalCustomDomainStrategy !== "production_fallback_with_platform_staging_exceptions"
    || productionSpec.routing.platformApexRoute !== `${zoneName}/*`
    || productionSpec.routing.platformStorefrontWildcard !== `*.${zoneName}/*`
    || productionSpec.routing.routeHandoff !== "atomic_shared_zone_route_replacement"
    || !new Set(["pending_inventory", "verified_none_active"]).has(
      productionSpec.routing.stagingExternalCustomDomainInventory,
    )
    || !Array.isArray(productionSpec.routing.stagingRouteExceptions)
    || productionSpec.routing.stagingRouteExceptions.some((route) => (
      typeof route !== "string" || route.length === 0 || route.length > 253
    ))
  ) {
    throw new Error("production_bootstrap_route_strategy_invalid");
  }

  exactKeys(
    productionSpec.turnstile,
    ["externalCustomDomainAdmission", "externalCustomDomainStrategy", "platformHostname"],
    "production_bootstrap_turnstile_strategy_invalid",
  );
  if (
    productionSpec.turnstile.platformHostname !== zoneName
    || productionSpec.turnstile.externalCustomDomainStrategy !== "exact_hostname_admission_before_activation"
    || !new Set(["pending_runtime_lifecycle", "verified_before_domain_activation"]).has(
      productionSpec.turnstile.externalCustomDomainAdmission,
    )
  ) {
    throw new Error("production_bootstrap_turnstile_strategy_invalid");
  }

  exactKeys(
    productionSpec.resources,
    RESOURCE_DESCRIPTORS.map((resource) => resource.key),
    "production_bootstrap_resource_spec_invalid",
  );
  const expectedNames = {
    d1: "selinow-production",
    deadLetterQueue: "selinow-dlq-production",
    integrationQueue: "selinow-integration-production",
    notificationQueue: "selinow-notification-production",
    platformCacheKv: "selinow-cache-production",
    privateExports: "selinow-private-exports-production",
    r2: "selinow-media-production",
    sessionKv: "selinow-session-production",
  };
  if (!isDeepStrictEqual(productionSpec.resources, expectedNames)) {
    throw new Error("production_bootstrap_resource_spec_invalid");
  }
}

export function assertProductionBootstrapSpecIdentity(productionSpec) {
  assertProductionSpecContract(productionSpec);
}

function assertSpecContract(productionSpec, stagingSpec) {
  assertProductionSpecContract(productionSpec);
  if (
    stagingSpec?.environment !== "staging"
    || productionSpec.accountId !== stagingSpec.accountId
    || productionSpec.zoneId !== stagingSpec.zoneId
    || productionSpec.zoneName !== stagingSpec.zoneName
  ) {
    throw new Error("production_bootstrap_spec_identity_invalid");
  }
}

export function assertProductionBootstrapSecretNames(secretNames) {
  if (!Array.isArray(secretNames) || secretNames.length === 0) {
    throw new Error("production_bootstrap_secret_names_invalid");
  }
  const names = new Set();
  for (const name of secretNames) {
    if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]{2,80}$/u.test(name) || names.has(name)) {
      throw new Error("production_bootstrap_secret_names_invalid");
    }
    names.add(name);
  }
  const missing = REQUIRED_WORKER_SECRET_NAMES.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`production_bootstrap_secret_name_missing:${missing[0]}`);
  return [...names].sort();
}

function normalizeInventoryResources(inventory) {
  exactKeys(inventory.resources, ["d1", "kv", "queue", "r2"], "production_bootstrap_resource_inventory_invalid");
  const normalized = {};
  for (const kind of ["d1", "kv", "queue", "r2"]) {
    if (!Array.isArray(inventory.resources[kind])) {
      throw new Error("production_bootstrap_resource_inventory_invalid");
    }
    normalized[kind] = inventory.resources[kind].map((resource) => {
      exactKeys(
        resource,
        kind === "d1" || kind === "kv" ? ["id", "name"] : ["name"],
        "production_bootstrap_resource_inventory_invalid",
      );
      if (typeof resource.name !== "string" || !/^selinow-[a-z0-9-]+$/u.test(resource.name)) {
        throw new Error("production_bootstrap_resource_inventory_invalid");
      }
      if (kind === "d1" && !UUID_PATTERN.test(resource.id ?? "")) {
        throw new Error("production_bootstrap_resource_inventory_invalid");
      }
      if (kind === "kv" && !ACCOUNT_ID_PATTERN.test(resource.id ?? "")) {
        throw new Error("production_bootstrap_resource_inventory_invalid");
      }
      return { ...resource };
    });
  }
  return normalized;
}

function planResources(productionSpec, resources) {
  return RESOURCE_DESCRIPTORS.map((descriptor) => {
    const name = productionSpec.resources[descriptor.key];
    const wrongType = Object.entries(resources).some(([kind, items]) => (
      kind !== descriptor.kind && items.some((resource) => resource.name === name)
    ));
    if (wrongType) throw new Error(`production_bootstrap_resource_type_conflict:${descriptor.key}`);
    const matching = resources[descriptor.kind].filter((resource) => resource.name === name);
    if (matching.length > 1) throw new Error(`production_bootstrap_resource_conflict:${descriptor.key}`);
    const existing = matching[0];
    return {
      action: existing ? "reuse" : "create",
      code: `resource.${descriptor.key}`,
      kind: descriptor.kind,
      name,
      ...(existing?.id === undefined ? {} : { id: existing.id }),
    };
  });
}

function domainIdentity(domain) {
  if (
    typeof domain !== "object"
    || domain === null
    || Array.isArray(domain)
    || typeof domain.hostname !== "string"
    || typeof domain.service !== "string"
    || typeof domain.zoneId !== "string"
    || typeof domain.zoneName !== "string"
  ) {
    throw new Error("production_bootstrap_domain_inventory_invalid");
  }
  return {
    hostname: domain.hostname.toLowerCase(),
    service: domain.service,
    zoneId: domain.zoneId,
    zoneName: domain.zoneName.toLowerCase(),
  };
}

function expectedStagingDomains(stagingSpec) {
  return new Map(stagingSpec.hostnames.map((hostname) => [hostname, stagingSpec.workerName]));
}

function planTraffic(phase, productionSpec, stagingSpec, inventory) {
  const canaryPattern = productionSpec.routing.canaryOverrideRoute;
  const canaryRoutes = inventory.routes.filter((route) => route?.pattern === canaryPattern);
  if (canaryRoutes.length > 1 || canaryRoutes.some((route) => route.script !== productionSpec.workerName)) {
    throw new Error("production_bootstrap_canary_route_drift");
  }
  const routeAudit = validateStagingRouteInventory(
    stagingSpec,
    phase === "resources"
      ? inventory.routes
      : inventory.routes.filter((route) => route?.pattern !== canaryPattern),
  );
  if (!routeAudit.ok) {
    const failed = routeAudit.checks.find((check) => !check.ok)?.code ?? "unknown";
    throw new Error(`production_bootstrap_staging_route_drift:${failed}`);
  }
  if (!Array.isArray(inventory.domains)) throw new Error("production_bootstrap_domain_inventory_invalid");
  const domains = inventory.domains.map(domainIdentity).filter((domain) => (
    domain.zoneId === productionSpec.zoneId || domain.zoneName === productionSpec.zoneName
  ));
  const observed = new Map();
  for (const domain of domains) {
    if (observed.has(domain.hostname)) throw new Error("production_bootstrap_domain_inventory_invalid");
    observed.set(domain.hostname, domain.service);
  }

  const expected = expectedStagingDomains(stagingSpec);
  if (phase === "promote") {
    for (const hostname of Object.values(productionSpec.hostnames)) {
      const service = observed.get(hostname);
      if (service !== undefined && service !== productionSpec.workerName) {
        throw new Error(`production_bootstrap_domain_conflict:${hostname}`);
      }
    }
  }

  const stableHostnames = new Set(Object.values(productionSpec.hostnames));
  for (const [hostname, service] of observed) {
    if (phase === "promote" && stableHostnames.has(hostname) && service === productionSpec.workerName) continue;
    if (expected.get(hostname) !== service) {
      throw new Error(`production_bootstrap_domain_drift:${hostname}`);
    }
  }
  for (const [hostname, service] of expected) {
    if (observed.get(hostname) !== service) {
      throw new Error(`production_bootstrap_domain_missing:${hostname}`);
    }
  }

  if (phase === "resources") return [];
  if (phase === "canary") {
    return [{
      action: canaryRoutes.length === 1 ? "reuse" : "create",
      code: "traffic.canary_route",
      pattern: canaryPattern,
      script: productionSpec.workerName,
      workerName: productionSpec.workerName,
    }];
  }
  return Object.values(productionSpec.hostnames).sort().map((hostname) => ({
    action: observed.get(hostname) === productionSpec.workerName ? "reuse" : "create",
    code: "traffic.stable_domain",
    hostname,
    workerName: productionSpec.workerName,
  }));
}

function assertInventoryIdentity(productionSpec, inventory) {
  exactKeys(
    inventory,
    ["accountId", "domains", "resources", "routes", "zoneId", "zoneName"],
    "production_bootstrap_inventory_invalid",
  );
  if (
    inventory.accountId !== productionSpec.accountId
    || inventory.zoneId !== productionSpec.zoneId
    || inventory.zoneName !== productionSpec.zoneName
  ) {
    throw new Error("production_bootstrap_inventory_identity_mismatch");
  }
}

function assertCommonEvidence(evidence, phase) {
  if (
    evidence?.schemaVersion !== 1
    || evidence?.environment !== "production"
    || evidence?.phase !== phase
    || !CEREMONY_ID_PATTERN.test(evidence?.ceremonyId ?? "")
    || !configuredReference(evidence?.approvals?.releaseOwner)
    || !configuredReference(evidence?.approvals?.supportOwner)
    || !configuredReference(evidence?.preBootstrapTrafficSnapshotRef)
  ) {
    throw new Error("production_bootstrap_evidence_invalid");
  }
}

function assertCanaryPrerequisites(evidence, migrationNames, now) {
  const completedAt = safeDate(evidence?.backup?.completedAt);
  const restoreCompletedAt = safeDate(evidence?.backup?.restoreDrillCompletedAt);
  const migratedAt = safeDate(evidence?.migrations?.appliedAt);
  const currentTime = now.getTime();
  if (
    !configuredReference(evidence?.resourceManifestRef)
    || !configuredReference(evidence?.backup?.snapshotReportRef)
    || evidence?.backup?.providerBookmarkRecorded !== true
    || evidence?.backup?.emptyDatabaseBaselineVerified !== true
    || completedAt === null
    || completedAt > currentTime
    || currentTime - completedAt > 24 * 60 * 60_000
    || !configuredReference(evidence?.backup?.restoreDrillReportRef)
    || evidence?.backup?.restoreDrillPassed !== true
    || restoreCompletedAt === null
    || restoreCompletedAt > currentTime
    || restoreCompletedAt < completedAt
    || currentTime - restoreCompletedAt > 30 * 24 * 60 * 60_000
    || evidence?.migrations?.direction !== "forward_only"
    || migratedAt === null
    || migratedAt < completedAt
    || !isDeepStrictEqual(evidence?.migrations?.names, migrationNames)
    || evidence?.previousWorkerVersion !== null
    || !WORKER_VERSION_PATTERN.test(evidence?.candidateWorkerVersion ?? "")
    || evidence?.rollback?.strategy !== "restore_pre_bootstrap_traffic_inventory"
    || evidence?.rollback?.snapshotRef !== evidence.preBootstrapTrafficSnapshotRef
  ) {
    throw new Error("production_bootstrap_canary_prerequisites_incomplete");
  }
}

function assertPromotionPrerequisites(evidence) {
  const acceptedAt = safeDate(evidence?.canary?.acceptedAt);
  if (
    evidence?.canary?.accepted !== true
    || acceptedAt === null
    || evidence?.canary?.workerVersion !== evidence.candidateWorkerVersion
    || !configuredReference(evidence?.canary?.smokeReportRef)
    || evidence?.canary?.stagingRoutesPreserved !== true
    || evidence?.monitoring?.alertsReady !== true
    || evidence?.monitoring?.dashboardReady !== true
  ) {
    throw new Error("production_bootstrap_promotion_prerequisites_incomplete");
  }
}

export function inspectProductionBootstrapCutoverBlockers(input) {
  const zoneName = input.productionSpec?.zoneName;
  const platformApexRoute = `${zoneName}/*`;
  const platformWildcard = `*.${zoneName}/*`;
  const stagingRoot = input.stagingSpec?.hostnames?.[0];
  const stagingRouteExceptions = [
    `${stagingRoot}/*`,
    ...(input.stagingSpec?.hostnames ?? [])
      .filter((hostname) => hostname !== stagingRoot && !hostname.endsWith(`.${stagingRoot}`))
      .map((hostname) => `${hostname}/*`),
    input.stagingSpec?.wildcardRoute,
  ].filter((route) => typeof route === "string");
  const blockers = [];
  if (input.productionSpec?.routing?.platformApexRoute !== platformApexRoute) {
    blockers.push("platform_apex_route_missing");
  }
  if (input.productionSpec?.routing?.platformStorefrontWildcard !== platformWildcard) {
    blockers.push("platform_storefront_wildcard_missing");
  }
  if (input.productionSpec?.routing?.canaryOverrideRoute !== `canary.${zoneName}/*`) {
    blockers.push("production_canary_override_route_missing");
  }
  if (
    input.productionSpec?.routing?.routeHandoff !== "atomic_shared_zone_route_replacement"
    || !isDeepStrictEqual(input.productionSpec?.routing?.stagingRouteExceptions, stagingRouteExceptions)
  ) {
    blockers.push("staging_route_exceptions_not_declared");
  }
  if (input.productionSpec?.routing?.externalCustomDomainFallbackRoute !== "*/*") {
    blockers.push("external_custom_domain_fallback_route_missing");
  }
  if (input.stagingSpec?.sharedZoneDisabledRoutes?.includes(platformWildcard)) {
    blockers.push("platform_storefront_wildcard_disabled_by_staging_guard");
  }
  if (input.stagingSpec?.sharedZoneDisabledRoutes?.includes(platformApexRoute)) {
    blockers.push("platform_apex_route_disabled_by_staging_guard");
  }
  if (input.stagingSpec?.workerRoutes?.some((route) => route?.pattern === "*/*")) {
    blockers.push("external_custom_domains_captured_by_staging_catch_all");
  }
  if (
    input.productionSpec?.routing?.externalCustomDomainStrategy
      !== "production_fallback_with_platform_staging_exceptions"
  ) {
    blockers.push("external_custom_domain_route_strategy_missing");
  }
  if (input.productionSpec?.routing?.stagingExternalCustomDomainInventory !== "verified_none_active") {
    blockers.push("staging_external_custom_domain_inventory_unverified");
  }
  if (
    input.productionSpec?.turnstile?.platformHostname !== zoneName
    || input.productionSpec?.turnstile?.externalCustomDomainStrategy
      !== "exact_hostname_admission_before_activation"
  ) {
    blockers.push("turnstile_external_hostname_strategy_missing");
  }
  if (input.productionSpec?.turnstile?.externalCustomDomainAdmission !== "verified_before_domain_activation") {
    blockers.push("turnstile_external_hostname_admission_unverified");
  }
  return blockers;
}

/**
 * Route-only handoff contract. The caller must reconcile this matrix against
 * a fresh live inventory and apply it atomically; this helper never mutates
 * Cloudflare.
 */
export function buildProductionRouteHandoff(productionSpec, stagingSpec) {
  const zoneName = productionSpec?.zoneName;
  const productionWorker = productionSpec?.workerName;
  const stagingWorker = stagingSpec?.workerName;
  if (typeof zoneName !== "string" || typeof productionWorker !== "string" || typeof stagingWorker !== "string") {
    throw new Error("production_bootstrap_route_strategy_invalid");
  }
  const stagingRoot = stagingSpec?.hostnames?.[0];
  if (typeof stagingRoot !== "string") throw new Error("production_bootstrap_route_strategy_invalid");
  const stagingExceptions = [
    `${stagingRoot}/*`,
    ...(stagingSpec.hostnames ?? [])
      .filter((hostname) => hostname !== stagingRoot && !hostname.endsWith(`.${stagingRoot}`))
      .map((hostname) => `${hostname}/*`),
    stagingSpec.wildcardRoute,
  ];
  return {
    canary: [
      { pattern: `canary.${zoneName}/*`, script: productionWorker },
    ],
    promote: [
      { pattern: `${zoneName}/*`, script: productionWorker },
      { pattern: `*.${zoneName}/*`, script: productionWorker },
      ...stagingExceptions.map((pattern) => ({ pattern, script: stagingWorker })),
      { pattern: "*/*", script: productionWorker },
    ],
    stagingExceptions,
  };
}

export function buildProductionBootstrapPlan(input) {
  if (!PHASES.has(input.phase)) throw new Error(`production_bootstrap_phase_invalid:${input.phase}`);
  assertSpecContract(input.productionSpec, input.stagingSpec);
  assertCommonEvidence(input.evidence, input.phase);
  assertRepositoryState(input.repositoryState, input.evidence);
  assertInventoryIdentity(input.productionSpec, input.inventory);
  const secretNames = assertProductionBootstrapSecretNames(input.secretNames);
  const resources = normalizeInventoryResources(input.inventory);
  const resourceActions = planResources(input.productionSpec, resources);
  if (input.phase !== "resources" && resourceActions.some((action) => action.action !== "reuse")) {
    throw new Error("production_bootstrap_resources_not_reconciled");
  }
  const trafficActions = planTraffic(
    input.phase,
    input.productionSpec,
    input.stagingSpec,
    input.inventory,
  );
  const migrationNames = [...input.migrationNames].sort();
  if (migrationNames.some((name) => !/^\d{4}_[a-z0-9_]+\.sql$/u.test(name))) {
    throw new Error("production_bootstrap_migration_inventory_invalid");
  }
  if (input.phase !== "resources") {
    assertCanaryPrerequisites(input.evidence, migrationNames, input.now);
  }
  const cutoverBlockers = inspectProductionBootstrapCutoverBlockers(input);
  if (input.phase === "promote" && cutoverBlockers.length > 0) {
    throw new Error(`production_bootstrap_cutover_blocked:${cutoverBlockers[0]}`);
  }
  if (input.phase === "promote") assertPromotionPrerequisites(input.evidence);

  const phaseActions = input.phase === "resources"
    ? [
        ...resourceActions,
        { action: "record", code: "evidence.resource_manifest" },
        { action: "record", code: "evidence.empty_d1_backup_before_migrations" },
        { action: "apply", code: "database.forward_only_migrations_after_backup" },
      ]
    : input.phase === "canary"
      ? [
          { action: "verify", code: "evidence.resource_manifest" },
          { action: "verify", code: "evidence.empty_d1_backup_before_migrations" },
          { action: "verify", code: "database.forward_only_migrations" },
          ...trafficActions,
          { action: "deploy", code: "worker.candidate_canary_only" },
          { action: "verify", code: "worker.canary_smoke" },
        ]
      : [
          { action: "verify", code: "worker.canary_accepted" },
          ...trafficActions,
          { action: "verify", code: "traffic.staging_inventory_unchanged" },
          { action: "record", code: "worker.first_stable_version_as_future_rollback" },
        ];

  return {
    actions: phaseActions,
    ceremonyId: input.evidence.ceremonyId,
    environment: "production",
    fingerprints: {
      inventorySha256: fingerprint(input.inventory),
      sourceSha256: fingerprint(input.repositoryState),
      specSha256: fingerprint(input.productionSpec),
    },
    firstVersionRollback: {
      previousWorkerVersion: null,
      snapshotRef: input.evidence.preBootstrapTrafficSnapshotRef,
      strategy: "restore_pre_bootstrap_traffic_inventory",
    },
    phase: input.phase,
    safeguards: {
      allowedMutations: input.phase === "resources"
        ? ["named_production_resources"]
        : input.phase === "canary"
          ? ["production_candidate_worker_version", "production_canary_worker_route"]
          : ["production_stable_worker_domains"],
      cutoverBlockers,
      forwardOnlyMigrations: true,
      secretNameCount: secretNames.length,
      secretNamesFingerprintSha256: fingerprint(secretNames),
      secretValuesAccepted: false,
      stagingTrafficImmutable: true,
    },
    schemaVersion: 1,
  };
}

export function assertProductionBootstrapExecutionAdmission(input) {
  if (input.confirmProduction !== true) throw new Error("production_bootstrap_confirmation_required");
  if (input.confirmFirstProductionBootstrap !== true) {
    throw new Error("production_first_bootstrap_confirmation_required");
  }
  const initial = buildProductionBootstrapPlan(input.initial);
  const final = buildProductionBootstrapPlan(input.final);
  if (!isDeepStrictEqual(initial, final)) throw new Error("production_bootstrap_admission_changed");
  return final;
}

export async function writeProductionBootstrapPlan(plan, root) {
  if (!CEREMONY_ID_PATTERN.test(plan?.ceremonyId ?? "") || !PHASES.has(plan?.phase)) {
    throw new Error("production_bootstrap_plan_invalid");
  }
  const directory = resolve(root, ".wrangler", "bootstrap", plan.ceremonyId);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const path = resolve(directory, `${plan.phase}-plan.json`);
  await writeFile(path, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return `.wrangler/bootstrap/${plan.ceremonyId}/${plan.phase}-plan.json`;
}
