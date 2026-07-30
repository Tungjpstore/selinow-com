import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertProductionWorkerIdentityAdmission,
  repositoryRoot,
} from "./platform.mjs";

export const REQUIRED_PRODUCTION_VARS = [
  "ACTIVE_CREDENTIAL_KEY_VERSION",
  "ACTIVE_INVENTORY_KEY_VERSION",
  "API_ORIGIN",
  "APP_ENV",
  "CANARY_HOSTNAME",
  "CLOUDFLARE_ZONE_ID",
  "CREDENTIAL_KEY_VERSION",
  "DASHBOARD_ORIGIN",
  "DEFAULT_CURRENCY",
  "DEFAULT_LOCALE",
  "DEFAULT_TIMEZONE",
  "EMAIL_FROM_ADDRESS",
  "EMAIL_FROM_NAME",
  "EXPORT_KEY_VERSION",
  "INVENTORY_KEY_VERSION",
  "LOG_LEVEL",
  "MAGIC_LINK_GLOBAL_RATE_LIMIT",
  "MAGIC_LINK_RATE_LIMIT_WINDOW_SECONDS",
  "MAGIC_LINK_REQUESTER_RATE_LIMIT",
  "MEDIA_PUBLIC_BASE_URL",
  "PLATFORM_BASE_DOMAIN",
  "PLATFORM_NAME",
  "PLATFORM_ORIGIN",
  "RESOURCE_MANIFEST_VERSION",
  "SAAS_CNAME_TARGET",
  "SESSION_COOKIE_NAME",
  "STOREFRONT_CART_RATE_LIMIT",
  "STOREFRONT_CHECKOUT_RATE_LIMIT",
  "STOREFRONT_RATE_LIMIT_WINDOW_SECONDS",
  "STOREFRONT_TURNSTILE_THRESHOLD",
  "TELEGRAM_WEBHOOK_MAX_CONNECTIONS",
  "TURNSTILE_SITE_KEY",
];

export const REQUIRED_WORKER_SECRET_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "CREDENTIAL_KEK_V1",
  "EXPORT_KEK_V1",
  "IDENTIFIER_HMAC_SECRET",
  "INVENTORY_KEK_V1",
  "MAGIC_LINK_SECRET",
  "SESSION_SECRET",
  "TURNSTILE_SECRET_KEY",
];

const REQUIRED_SPEC_PATHS = [
  "accountId",
  "environment",
  "hostnames.api",
  "hostnames.dashboard",
  "hostnames.marketing",
  "resources.d1",
  "resources.deadLetterQueue",
  "resources.integrationQueue",
  "resources.notificationQueue",
  "resources.platformCacheKv",
  "resources.privateExports",
  "resources.r2",
  "resources.sessionKv",
  "saas.cnameTarget",
  "saas.fallbackOrigin",
  "workerName",
  "zoneId",
  "zoneName",
];

const REQUIRED_EVIDENCE_PATHS = [
  "approvals.releaseOwner",
  "approvals.supportOwner",
  "backup.completedAt",
  "backup.providerBookmarkRecorded",
  "backup.restoreDrillCompletedAt",
  "backup.restoreDrillPassed",
  "backup.restoreDrillReportRef",
  "backup.snapshotReportRef",
  "candidateWorkerVersion",
  "commitSha",
  "manualAcceptance.customDomain",
  "manualAcceptance.paymentSignedEvent",
  "manualAcceptance.telegram",
  "manualAcceptance.website",
  "monitoring.alertsReady",
  "monitoring.budgetAlertsReady",
  "monitoring.dashboardReady",
  "pilot.shopCount",
  "previousWorkerVersion",
  "quality.build",
  "quality.check",
  "quality.deployDryRun",
  "quality.lint",
  "quality.test",
  "releaseId",
  "security.criticalOpen",
  "security.highOpen",
  "staging.accepted",
  "staging.acceptedAt",
];

const PLACEHOLDER_PATTERN = /(?:change-me|not-provisioned|placeholder|replace-with|<[^>]+>)/iu;
const RELEASE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{7,80}$/u;
const SAFE_NAME_PATTERN = /^[a-z][a-z0-9._-]{2,80}$/u;
const MAX_SMOKE_RESPONSE_BYTES = 256 * 1024;

function getPath(value, path) {
  return path.split(".").reduce((current, key) => (
    typeof current === "object" && current !== null ? current[key] : undefined
  ), value);
}

function isConfigured(value) {
  if (typeof value === "boolean" || typeof value === "number") return true;
  return typeof value === "string" && value.trim().length > 0 && !PLACEHOLDER_PATTERN.test(value);
}

function makeCheck(name, ok) {
  return { name, ok: Boolean(ok) };
}

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

function bindingNames(items) {
  return new Set(Array.isArray(items) ? items.map((item) => item?.binding).filter((name) => typeof name === "string") : []);
}

function queueNames(config) {
  const producers = bindingNames(config?.queues?.producers);
  const consumers = new Set(Array.isArray(config?.queues?.consumers)
    ? config.queues.consumers.map((item) => item?.queue).filter((name) => typeof name === "string")
    : []);
  return { consumers, producers };
}

function safeDate(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validHostname(value) {
  return typeof value === "string"
    && value.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u.test(value);
}

function validHttpsOrigin(value) {
  try {
    const url = new globalThis.URL(value);
    return url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function validProductionVar(name, value) {
  if (name === "APP_ENV") return value === "production";
  if (name === "CANARY_HOSTNAME") return validHostname(value) && value === "canary.selinow.com";
  if (name === "CLOUDFLARE_ZONE_ID") return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
  if (["API_ORIGIN", "DASHBOARD_ORIGIN", "MEDIA_PUBLIC_BASE_URL", "PLATFORM_ORIGIN"].includes(name)) return validHttpsOrigin(value);
  if (name === "PLATFORM_BASE_DOMAIN" || name === "SAAS_CNAME_TARGET") return validHostname(value);
  if (name === "RESOURCE_MANIFEST_VERSION") return typeof value === "string" && /^[a-f0-9]{16,64}$/u.test(value);
  if (name === "SESSION_COOKIE_NAME") return value === "selinow_session";
  return isConfigured(value);
}

function validSpecPath(path, value) {
  if (path === "environment") return value === "production";
  if (path === "accountId" || path === "zoneId") return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
  if (path.startsWith("hostnames.") || path === "zoneName" || path.startsWith("saas.")) return validHostname(value);
  if (path === "workerName") return value === "selinow-com-production";
  if (path.startsWith("resources.")) return typeof value === "string" && /^selinow-(?:[a-z0-9-]+-)?production$/u.test(value);
  return isConfigured(value);
}

function validEvidencePath(path, value) {
  if (path.startsWith("quality.") || path.startsWith("manualAcceptance.") || path.startsWith("monitoring.")) return value === true;
  if (path === "staging.accepted") return value === true;
  if (path === "staging.acceptedAt") return safeDate(value) !== null;
  if (path === "security.criticalOpen" || path === "security.highOpen") return value === 0;
  if (path === "pilot.shopCount") return Number.isSafeInteger(value) && value >= 2;
  if (path === "releaseId") return typeof value === "string" && RELEASE_ID_PATTERN.test(value) && !PLACEHOLDER_PATTERN.test(value);
  if (path === "commitSha") return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
  return isConfigured(value);
}

export function evaluateBackupPrerequisites(evidence, now = new Date()) {
  const backup = evidence?.backup;
  const completedAt = safeDate(backup?.completedAt);
  const restoreCompletedAt = safeDate(backup?.restoreDrillCompletedAt);
  const age = completedAt === null ? Number.POSITIVE_INFINITY : now.getTime() - completedAt;
  const restoreAge = restoreCompletedAt === null ? Number.POSITIVE_INFINITY : now.getTime() - restoreCompletedAt;
  return [
    makeCheck("backup.snapshotReportRef", isConfigured(backup?.snapshotReportRef)),
    makeCheck("backup.providerBookmarkRecorded", backup?.providerBookmarkRecorded === true),
    makeCheck("backup.completedAt", completedAt !== null && age >= 0 && age <= 24 * 60 * 60_000),
    makeCheck("backup.restoreDrillReportRef", isConfigured(backup?.restoreDrillReportRef)),
    makeCheck("backup.restoreDrillPassed", backup?.restoreDrillPassed === true),
    makeCheck("backup.restoreDrillCompletedAt", restoreCompletedAt !== null && restoreAge >= 0 && restoreAge <= 30 * 24 * 60 * 60_000),
  ];
}

export function inspectProductionReadiness(input) {
  const production = input.wranglerConfig?.env?.production;
  const spec = input.productionSpec;
  const evidence = input.evidence;
  const checks = [
    makeCheck("wrangler.env.production", typeof production === "object" && production !== null),
    makeCheck("wrangler.env.production.name", isConfigured(production?.name)),
    makeCheck("wrangler.env.production.workers_dev", production?.workers_dev === false),
    makeCheck("wrangler.env.production.routes", Array.isArray(production?.routes) && production.routes.length >= 3),
    makeCheck("wrangler.env.production.assets.ASSETS", production?.assets?.binding === "ASSETS"),
  ];

  const d1Bindings = bindingNames(production?.d1_databases);
  const r2Bindings = bindingNames(production?.r2_buckets);
  const kvBindings = bindingNames(production?.kv_namespaces);
  const emailBindings = new Map(
    Array.isArray(production?.send_email)
      ? production.send_email
        .filter((binding) => typeof binding?.name === "string")
        .map((binding) => [binding.name, binding])
      : [],
  );
  const queues = queueNames(production);
  checks.push(
    makeCheck("binding.PLATFORM_DB", d1Bindings.has("PLATFORM_DB")),
    makeCheck("binding.MEDIA", r2Bindings.has("MEDIA")),
    makeCheck("binding.PRIVATE_EXPORTS", r2Bindings.has("PRIVATE_EXPORTS")),
    makeCheck("binding.PLATFORM_CACHE", kvBindings.has("PLATFORM_CACHE")),
    makeCheck("binding.SESSION", kvBindings.has("SESSION")),
    makeCheck("binding.EMAIL", emailBindings.has("EMAIL")),
    makeCheck(
      "binding.EMAIL.allowedSender",
      Array.isArray(emailBindings.get("EMAIL")?.allowed_sender_addresses)
        && emailBindings.get("EMAIL").allowed_sender_addresses.includes(production?.vars?.EMAIL_FROM_ADDRESS),
    ),
    makeCheck("binding.INTEGRATION_QUEUE", queues.producers.has("INTEGRATION_QUEUE")),
    makeCheck("binding.NOTIFICATION_QUEUE", queues.producers.has("NOTIFICATION_QUEUE")),
    makeCheck("queue.consumer.integration", queues.consumers.size >= 2),
    makeCheck("wrangler.env.production.triggers", Array.isArray(production?.triggers?.crons) && production.triggers.crons.length > 0),
    makeCheck("wrangler.env.production.observability", production?.observability?.enabled === true),
  );

  for (const name of REQUIRED_PRODUCTION_VARS) {
    const value = production?.vars?.[name];
    checks.push(makeCheck(`var.${name}`, validProductionVar(name, value)));
  }
  for (const name of REQUIRED_WORKER_SECRET_NAMES) {
    checks.push(makeCheck(`secret.${name}`, input.workerSecretNames?.includes(name) === true));
  }
  for (const path of REQUIRED_SPEC_PATHS) {
    const value = getPath(spec, path);
    checks.push(makeCheck(`productionSpec.${path}`, validSpecPath(path, value)));
  }
  for (const path of REQUIRED_EVIDENCE_PATHS) {
    const value = getPath(evidence, path);
    checks.push(makeCheck(`evidence.${path}`, validEvidencePath(path, value)));
  }
  const routes = new Set(Array.isArray(production?.routes) ? production.routes.map((route) => route?.pattern).filter((value) => typeof value === "string") : []);
  const d1Database = Array.isArray(production?.d1_databases)
    ? production.d1_databases.find((database) => database?.binding === "PLATFORM_DB")
    : null;
  const mediaBucket = Array.isArray(production?.r2_buckets)
    ? production.r2_buckets.find((bucket) => bucket?.binding === "MEDIA")
    : null;
  const exportsBucket = Array.isArray(production?.r2_buckets)
    ? production.r2_buckets.find((bucket) => bucket?.binding === "PRIVATE_EXPORTS")
    : null;
  checks.push(
    makeCheck("alignment.workerName", isConfigured(spec?.workerName) && production?.name === spec.workerName),
    makeCheck("alignment.resource.d1", isConfigured(spec?.resources?.d1) && d1Database?.database_name === spec.resources.d1),
    makeCheck("alignment.resource.media", isConfigured(spec?.resources?.r2) && mediaBucket?.bucket_name === spec.resources.r2),
    makeCheck("alignment.resource.privateExports", isConfigured(spec?.resources?.privateExports) && exportsBucket?.bucket_name === spec.resources.privateExports),
    makeCheck("alignment.queue.integration", isConfigured(spec?.resources?.integrationQueue) && queues.consumers.has(spec.resources.integrationQueue)),
    makeCheck("alignment.queue.notification", isConfigured(spec?.resources?.notificationQueue) && queues.consumers.has(spec.resources.notificationQueue)),
    makeCheck("alignment.route.marketing", isConfigured(spec?.hostnames?.marketing) && routes.has(spec.hostnames.marketing)),
    makeCheck("alignment.route.dashboard", isConfigured(spec?.hostnames?.dashboard) && routes.has(spec.hostnames.dashboard)),
    makeCheck("alignment.route.api", isConfigured(spec?.hostnames?.api) && routes.has(spec.hostnames.api)),
    makeCheck("alignment.var.zoneId", isConfigured(spec?.zoneId) && production?.vars?.CLOUDFLARE_ZONE_ID === spec.zoneId),
    makeCheck("alignment.var.saasTarget", isConfigured(spec?.saas?.cnameTarget) && production?.vars?.SAAS_CNAME_TARGET === spec.saas.cnameTarget),
  );
  checks.push(...evaluateBackupPrerequisites(evidence, input.now).map((check) => ({
    name: `evidence.${check.name}`,
    ok: check.ok,
  })));

  const unique = new Map(checks.map((check) => [check.name, check]));
  const result = [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
  return {
    checks: result,
    missing: result.filter((check) => !check.ok).map((check) => check.name),
    ok: result.every((check) => check.ok),
  };
}

export function buildRollbackMatrix() {
  return [
    {
      authority: "release_owner",
      containment: "stop_rollout_and_restore_previous_worker_version",
      signal: "worker_error_or_latency_regression",
      strategy: "worker_version_rollback",
      verification: "health_storefront_dashboard_webhook_smoke",
    },
    {
      authority: "release_owner_and_data_owner",
      containment: "stop_writes_and_new_pilot_traffic",
      signal: "d1_schema_or_data_integrity_regression",
      strategy: "forward_fix_or_restore_to_isolated_database_then_controlled_cutover_no_down_migration",
      verification: "integrity_foreign_keys_counts_and_tenant_isolation",
    },
    {
      authority: "payment_incident_owner",
      containment: "disable_new_checkout_and_pause_fulfillment_workers",
      signal: "payment_or_fulfillment_correctness_failure",
      strategy: "previous_worker_version_and_manual_payment_exception_review",
      verification: "signed_event_dedupe_inventory_and_fulfillment_reconciliation",
    },
    {
      authority: "integration_incident_owner",
      containment: "pause_affected_integration_jobs_without_rotating_credentials",
      signal: "telegram_or_provider_webhook_degradation",
      strategy: "previous_worker_version_or_provider_specific_fix_forward",
      verification: "webhook_secret_replay_queue_and_private_chat_checks",
    },
    {
      authority: "domain_incident_owner",
      containment: "switch_affected_shop_to_platform_subdomain_and_purge_hostname_cache",
      signal: "custom_domain_misroute_or_certificate_failure",
      strategy: "revert_canonical_mapping_without_broad_dns_mutation",
      verification: "hostname_ssl_dns_and_cross_tenant_routing",
    },
    {
      authority: "operations_owner",
      containment: "pause_consumers_if_retries_amplify_and_preserve_dlq_evidence",
      signal: "queue_backlog_or_dlq_growth",
      strategy: "previous_worker_version_then_bounded_replay",
      verification: "queue_age_retry_rate_dlq_and_exactly_once_side_effects",
    },
  ];
}

export function buildReleaseArtifacts(input) {
  if (!RELEASE_ID_PATTERN.test(input.evidence?.releaseId ?? "") || PLACEHOLDER_PATTERN.test(input.evidence.releaseId)) {
    throw new Error("release_id_invalid");
  }
  const readiness = inspectProductionReadiness(input);
  if (!readiness.ok) throw new Error(`release_prerequisites_incomplete:${readiness.missing[0] ?? "unknown"}`);
  const migrationNames = [...input.migrationNames].sort();
  const configFingerprint = fingerprint({
    production: input.wranglerConfig.env.production,
    productionSpec: input.productionSpec,
  });
  const manifest = {
    backup: {
      bookmarkRecorded: true,
      completedAt: input.evidence.backup.completedAt,
      restoreDrillCompletedAt: input.evidence.backup.restoreDrillCompletedAt,
      restoreDrillPassed: true,
    },
    candidateWorkerVersion: input.evidence.candidateWorkerVersion,
    commitSha: input.evidence.commitSha,
    configFingerprintSha256: configFingerprint,
    createdAt: input.now.toISOString(),
    environment: "production",
    manualAcceptance: input.evidence.manualAcceptance,
    migrationNames,
    packageVersion: input.packageVersion,
    pilotShopCount: input.evidence.pilot.shopCount,
    previousWorkerVersion: input.evidence.previousWorkerVersion,
    releaseEvidenceFingerprintSha256: fingerprint(input.evidence),
    releaseId: input.evidence.releaseId,
    schemaVersion: 2,
  };
  return { manifest, rollbackMatrix: buildRollbackMatrix() };
}

export function validateProductionDeployAdmission(input) {
  if (typeof input.manifest !== "object" || input.manifest === null || Array.isArray(input.manifest)) {
    throw new Error("production_release_manifest_invalid");
  }
  if (input.repositoryClean !== true) throw new Error("production_release_source_dirty");
  if (!/^[a-f0-9]{40}$/u.test(input.repositoryCommitSha ?? "")) {
    throw new Error("production_release_commit_unavailable");
  }
  if (input.evidence?.commitSha !== input.repositoryCommitSha) {
    throw new Error("production_release_evidence_commit_mismatch");
  }

  const createdAt = safeDate(input.manifest.createdAt);
  if (createdAt === null || createdAt > input.now.getTime() + 5 * 60_000) {
    throw new Error("production_release_manifest_created_at_invalid");
  }

  const expected = buildReleaseArtifacts(input).manifest;
  expected.createdAt = input.manifest.createdAt;
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(input.manifest).sort();
  if (!isDeepStrictEqual(actualKeys, expectedKeys)) {
    throw new Error("production_release_manifest_shape_invalid");
  }
  for (const key of expectedKeys) {
    if (!isDeepStrictEqual(input.manifest[key], expected[key])) {
      throw new Error(`production_release_manifest_mismatch:${key}`);
    }
  }
  return {
    commitSha: input.repositoryCommitSha,
    releaseId: input.manifest.releaseId,
  };
}

function readRepositoryGitState(root) {
  const commit = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if (commit.error || commit.status !== 0) {
    throw new Error("production_release_commit_unavailable");
  }
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
  });
  if (status.error || status.status !== 0) {
    throw new Error("production_release_source_status_unavailable");
  }
  return {
    commitSha: commit.stdout.trim(),
    clean: status.stdout.trim().length === 0,
  };
}

export async function assertProductionDeployAdmission(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const manifestPath = resolve(root, input.manifestPath);
  let manifestStat;
  try {
    manifestStat = await lstat(manifestPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && error.code === "ENOENT") {
      throw new Error("production_release_manifest_missing", { cause: error });
    }
    throw new Error("production_release_manifest_read_failed", { cause: error });
  }
  if (!manifestStat.isFile() || (manifestStat.mode & 0o077) !== 0) {
    throw new Error("production_release_manifest_permissions_invalid");
  }

  const evidencePath = input.evidencePath
    ?? resolve(root, ".wrangler/release/production-evidence.json");
  const specPath = input.specPath ?? resolve(root, "infra/environments/production.json");
  const [manifest, evidence, productionSpec, wranglerConfig, packageJson, migrationNames] = await Promise.all([
    readOptionalJson(manifestPath),
    readOptionalJson(evidencePath),
    readOptionalJson(specPath),
    readFile(resolve(root, "wrangler.jsonc"), "utf8").then((text) => JSON.parse(text)),
    readFile(resolve(root, "package.json"), "utf8").then((text) => JSON.parse(text)),
    listMigrationNames(root),
  ]);
  if (manifest === null) throw new Error("production_release_manifest_missing");
  if (evidence === null) throw new Error("production_evidence_missing");
  if (productionSpec === null) throw new Error("production_spec_missing");
  const gitState = readRepositoryGitState(root);
  const admission = validateProductionDeployAdmission({
    evidence,
    manifest,
    migrationNames,
    now: input.now ?? new Date(),
    packageVersion: String(packageJson.version ?? "unknown"),
    productionSpec,
    repositoryClean: gitState.clean,
    repositoryCommitSha: gitState.commitSha,
    workerSecretNames: input.workerSecretNames,
    wranglerConfig,
  });
  const canonicalManifestPath = resolve(
    root,
    ".wrangler",
    "releases",
    admission.releaseId,
    "release-manifest.json",
  );
  if (manifestPath !== canonicalManifestPath) {
    throw new Error("production_release_manifest_path_invalid");
  }
  return admission;
}

export async function assertProductionWorkerDeployAdmission(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const releaseAdmission = await (
    input.assertReleaseAdmissionImplementation ?? assertProductionDeployAdmission
  )({
    manifestPath: input.manifestPath,
    now: input.now,
    repositoryRoot: root,
    workerSecretNames: input.workerSecretNames,
  });
  const [productionSpec, stagingSpec, wranglerConfig] = await Promise.all([
    input.productionSpec === undefined
      ? readOptionalJson(resolve(root, "infra/environments/production.json"))
      : input.productionSpec,
    input.stagingSpec === undefined
      ? readOptionalJson(resolve(root, "infra/environments/staging.json"))
      : input.stagingSpec,
    input.wranglerConfig === undefined
      ? readFile(resolve(root, "wrangler.jsonc"), "utf8").then((text) => JSON.parse(text))
      : input.wranglerConfig,
  ]);
  if (productionSpec === null) throw new Error("production_spec_missing");
  if (stagingSpec === null) throw new Error("staging_spec_missing");
  const workerAdmission = await (
    input.workerIdentityImplementation ?? assertProductionWorkerIdentityAdmission
  )({
    environment: input.environment,
    fetchImplementation: input.fetchImplementation,
    productionSpec,
    repositoryRoot: root,
    runWranglerImplementation: input.runWranglerImplementation,
    stagingSpec,
    token: input.token,
    wranglerConfig,
  });
  return {
    ...releaseAdmission,
    accountId: workerAdmission.accountId,
    databaseId: workerAdmission.databaseId,
    databaseName: workerAdmission.databaseName,
    workerName: workerAdmission.workerName,
    zoneId: workerAdmission.zoneId,
    zoneName: workerAdmission.zoneName,
  };
}

export async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("release_json_invalid", { cause: error });
    if (typeof error === "object" && error !== null && error.code === "ENOENT") return null;
    throw new Error("release_json_read_failed", { cause: error });
  }
}

export async function listMigrationNames(root = repositoryRoot) {
  return (await readdir(resolve(root, "migrations")))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
}

export async function writeReleaseArtifacts(artifacts) {
  const releaseId = artifacts.manifest.releaseId;
  if (!RELEASE_ID_PATTERN.test(releaseId) || PLACEHOLDER_PATTERN.test(releaseId)) throw new Error("release_id_invalid");
  const directory = resolve(repositoryRoot, ".wrangler", "releases", releaseId);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const manifestPath = resolve(directory, "release-manifest.json");
  const rollbackPath = resolve(directory, "rollback-matrix.json");
  await writeFile(manifestPath, `${JSON.stringify(artifacts.manifest, null, 2)}\n`, { mode: 0o600 });
  await writeFile(rollbackPath, `${JSON.stringify(artifacts.rollbackMatrix, null, 2)}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  await chmod(rollbackPath, 0o600);
  return {
    manifestRef: `.wrangler/releases/${releaseId}/release-manifest.json`,
    rollbackRef: `.wrangler/releases/${releaseId}/rollback-matrix.json`,
  };
}

export function validatePilotSmokePlan(plan) {
  if (plan?.environment !== "production") throw new Error("pilot_plan_environment_invalid");
  if (!RELEASE_ID_PATTERN.test(plan?.releaseId ?? "") || PLACEHOLDER_PATTERN.test(plan.releaseId)) {
    throw new Error("pilot_plan_release_id_invalid");
  }
  if (!Array.isArray(plan.checks) || plan.checks.length === 0 || plan.checks.length > 20) {
    throw new Error("pilot_plan_checks_invalid");
  }
  const names = new Set();
  const pilotHosts = new Set();
  const checks = plan.checks.map((check) => {
    if (!SAFE_NAME_PATTERN.test(check?.name ?? "") || names.has(check.name)) throw new Error("pilot_check_name_invalid");
    names.add(check.name);
    if (!new Set(["health", "marketing", "pilot_storefront", "custom_domain"]).has(check.kind)) {
      throw new Error(`pilot_check_kind_invalid:${check.name}`);
    }
    let url;
    try {
      url = new globalThis.URL(check.url);
    } catch {
      throw new Error(`pilot_check_url_invalid:${check.name}`);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || PLACEHOLDER_PATTERN.test(url.hostname)) {
      throw new Error(`pilot_check_url_invalid:${check.name}`);
    }
    if (!Number.isSafeInteger(check.expectedStatus) || check.expectedStatus < 200 || check.expectedStatus > 399) {
      throw new Error(`pilot_check_status_invalid:${check.name}`);
    }
    if (check.kind === "pilot_storefront") pilotHosts.add(url.hostname);
    const requiredHeaders = Array.isArray(check.requiredHeaders) ? check.requiredHeaders : [];
    if (requiredHeaders.some((name) => !/^[a-z0-9-]{2,80}$/u.test(name))) {
      throw new Error(`pilot_check_header_invalid:${check.name}`);
    }
    if (check.bodyMarker !== undefined && (typeof check.bodyMarker !== "string" || check.bodyMarker.length < 2 || check.bodyMarker.length > 120)) {
      throw new Error(`pilot_check_marker_invalid:${check.name}`);
    }
    return {
      bodyMarker: check.bodyMarker,
      expectedStatus: check.expectedStatus,
      kind: check.kind,
      name: check.name,
      requiredHeaders,
      url: url.toString(),
    };
  });
  if (pilotHosts.size < 2) throw new Error("pilot_plan_two_shop_hosts_required");
  return { checks, environment: "production", releaseId: plan.releaseId };
}

async function readBoundedResponse(response) {
  if (response.body === null) return { body: "", tooLarge: false };
  const reader = response.body.getReader();
  const decoder = new globalThis.TextDecoder();
  let body = "";
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_SMOKE_RESPONSE_BYTES) {
      await reader.cancel();
      return { body: "", tooLarge: true };
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  body += decoder.decode();
  return { body, tooLarge: false };
}

export async function runPilotSmoke(input) {
  const plan = validatePilotSmokePlan(input.plan);
  if (!input.execute) {
    return {
      actions: plan.checks.map((check) => ({ code: "would_get", name: check.name, ok: true })),
      environment: "production",
      executed: false,
      ok: true,
    };
  }
  if (!input.confirmProduction) throw new Error("pilot_production_confirmation_required");
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  const results = [];
  for (const check of plan.checks) {
    let response;
    try {
      response = await fetchImplementation(check.url, {
        method: "GET",
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(10_000),
      });
    } catch {
      results.push({ code: "request_failed", name: check.name, ok: false });
      continue;
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > MAX_SMOKE_RESPONSE_BYTES) {
      results.push({ code: "response_too_large", name: check.name, ok: false });
      continue;
    }
    let bounded;
    try {
      bounded = await readBoundedResponse(response);
    } catch {
      results.push({ code: "response_read_failed", name: check.name, ok: false });
      continue;
    }
    if (bounded.tooLarge) {
      results.push({ code: "response_too_large", name: check.name, ok: false });
      continue;
    }
    const statusOk = response.status === check.expectedStatus;
    const headersOk = check.requiredHeaders.every((name) => response.headers.has(name));
    const markerOk = check.bodyMarker === undefined || bounded.body.includes(check.bodyMarker);
    results.push({
      code: statusOk && headersOk && markerOk ? "passed" : "contract_mismatch",
      name: check.name,
      ok: statusOk && headersOk && markerOk,
    });
  }
  return {
    actions: results,
    environment: "production",
    executed: true,
    ok: results.every((result) => result.ok),
  };
}
