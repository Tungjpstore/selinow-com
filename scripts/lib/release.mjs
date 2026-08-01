import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";

import {
  assertProductionWorkerIdentityAdmission,
  cloudflareApiRequest,
  requireCloudflareRouteAuditToken,
  repositoryRoot,
} from "./platform.mjs";

const PRODUCTION_RELEASE_GIT_MAX_BUFFER = 64 * 1024 * 1024;
const WRANGLER_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;

function resolveProductionReleaseGitExecutable(environment = process.env) {
  const executableName = process.platform === "win32" ? "git.exe" : "git";
  for (const directory of String(environment.PATH ?? "").split(delimiter).filter(Boolean)) {
    try {
      const candidate = realpathSync(resolve(directory, executableName));
      const metadata = lstatSync(candidate);
      accessSync(candidate, fsConstants.X_OK);
      if (metadata.isFile() && !metadata.isSymbolicLink()
        && !candidate.startsWith(`${repositoryRoot}${sep}`)) return candidate;
    } catch {
      // Keep searching the fixed startup PATH for a regular executable outside the candidate tree.
    }
  }
  throw new Error("production_release_git_executable_unavailable");
}

const PRODUCTION_RELEASE_GIT_EXECUTABLE = resolveProductionReleaseGitExecutable();

export function buildProductionReleaseGitEnvironment(environment = process.env) {
  const child = Object.fromEntries(["HOME", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR", "WINDIR"]
    .filter((name) => typeof environment[name] === "string")
    .map((name) => [name, environment[name]]));
  return {
    ...child,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    PATH: [dirname(PRODUCTION_RELEASE_GIT_EXECUTABLE), ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])]
      .join(delimiter),
  };
}

export function runProductionReleaseGit(args, options = {}) {
  return spawnSync(PRODUCTION_RELEASE_GIT_EXECUTABLE, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: options.encoding ?? "utf8",
    env: buildProductionReleaseGitEnvironment(options.environment),
    maxBuffer: PRODUCTION_RELEASE_GIT_MAX_BUFFER,
  });
}

async function hashWranglerToolchainDirectory(directory, root, hash) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const relativePath = relative(root, path);
    if (entry.isDirectory()) {
      hash.update(`directory:${relativePath}:`);
      await hashWranglerToolchainDirectory(path, root, hash);
      continue;
    }
    if (!entry.isFile()) throw new Error("production_release_wrangler_toolchain_invalid");
    const [metadata, value] = await Promise.all([lstat(path), readFile(path)]);
    hash.update(`file:${relativePath}:${metadata.mode & 0o777}:${value.byteLength}:`);
    hash.update(value);
  }
}

async function resolveInstalledRuntimeDependency(packageRoot, dependencyName, nodeModulesRoot) {
  const repositoryRootPath = dirname(nodeModulesRoot);
  let current = packageRoot;
  while (current === repositoryRootPath || current.startsWith(`${repositoryRootPath}${sep}`)) {
    const candidate = resolve(current, "node_modules", dependencyName);
    try {
      const resolved = await realpath(candidate);
      if (resolved.startsWith(`${nodeModulesRoot}${sep}`)) {
        await lstat(resolve(resolved, "package.json"));
        return resolved;
      }
    } catch {
      // Node resolution continues at the next parent directory.
    }
    const parent = dirname(current);
    if (parent === current || current === repositoryRootPath) break;
    current = parent;
  }
  return null;
}

async function collectWranglerRuntimePackages(root, wranglerRoot) {
  const nodeModulesRoot = resolve(root, "node_modules");
  const packages = new Map();
  const pending = [wranglerRoot];
  while (pending.length > 0) {
    const packageRoot = pending.pop();
    if (packages.has(packageRoot)) continue;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    } catch {
      throw new Error("production_release_wrangler_toolchain_invalid");
    }
    packages.set(packageRoot, manifest);
    const required = Object.keys(manifest.dependencies ?? {});
    const optional = new Set([
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const dependencyName of new Set([...required, ...optional])) {
      const dependencyRoot = await resolveInstalledRuntimeDependency(packageRoot, dependencyName, nodeModulesRoot);
      if (dependencyRoot === null) {
        if (required.includes(dependencyName) && !optional.has(dependencyName)) {
          throw new Error("production_release_wrangler_toolchain_invalid");
        }
        continue;
      }
      pending.push(dependencyRoot);
    }
  }
  return packages;
}

export async function createProductionWranglerToolchainAttestation(root = repositoryRoot) {
  let resolvedRoot;
  try {
    resolvedRoot = await realpath(root);
  } catch {
    throw new Error("production_release_wrangler_toolchain_unavailable");
  }
  const packageRoot = resolve(resolvedRoot, "node_modules", "wrangler");
  const executablePath = resolve(resolvedRoot, "node_modules", ".bin", "wrangler");
  let executableRealPath;
  let installedPackage;
  let lock;
  let packageRootRealPath;
  let rootPackage;
  try {
    [executableRealPath, installedPackage, lock, packageRootRealPath, rootPackage] = await Promise.all([
      realpath(executablePath),
      readFile(resolve(packageRoot, "package.json"), "utf8").then(JSON.parse),
      readFile(resolve(resolvedRoot, "package-lock.json"), "utf8").then(JSON.parse),
      realpath(packageRoot),
      readFile(resolve(resolvedRoot, "package.json"), "utf8").then(JSON.parse),
    ]);
  } catch {
    throw new Error("production_release_wrangler_toolchain_unavailable");
  }
  const pinnedVersion = rootPackage?.devDependencies?.wrangler ?? rootPackage?.dependencies?.wrangler;
  const lockedPackage = lock?.packages?.["node_modules/wrangler"];
  const declaredExecutable = typeof installedPackage?.bin === "string"
    ? installedPackage.bin
    : installedPackage?.bin?.wrangler;
  const expectedExecutable = resolve(packageRootRealPath, declaredExecutable ?? "");
  let cliPath;
  let cliStat;
  let packageStat;
  try {
    [cliPath, packageStat] = await Promise.all([
      realpath(resolve(packageRoot, installedPackage?.main ?? "")),
      lstat(packageRoot),
    ]);
    cliStat = await lstat(cliPath);
  } catch {
    throw new Error("production_release_wrangler_toolchain_invalid");
  }
  if (!WRANGLER_VERSION_PATTERN.test(pinnedVersion ?? "")
    || installedPackage?.name !== "wrangler"
    || installedPackage?.version !== pinnedVersion
    || lockedPackage?.version !== pinnedVersion
    || typeof lockedPackage?.integrity !== "string"
    || !packageStat.isDirectory() || packageStat.isSymbolicLink()
    || executableRealPath !== expectedExecutable
    || !cliPath.startsWith(`${packageRootRealPath}${sep}`)
    || !cliStat.isFile() || cliStat.isSymbolicLink()) {
    throw new Error("production_release_wrangler_toolchain_invalid");
  }
  const hash = createHash("sha256");
  hash.update(`wrangler:${pinnedVersion}:${lockedPackage.integrity}:${relative(packageRootRealPath, executableRealPath)}:${relative(packageRootRealPath, cliPath)}:`);
  const runtimePackages = await collectWranglerRuntimePackages(resolvedRoot, packageRootRealPath);
  const packageEntries = [...runtimePackages.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [runtimePackageRoot, runtimeManifest] of packageEntries) {
    const lockKey = relative(resolvedRoot, runtimePackageRoot).split(sep).join("/");
    const lockedRuntimePackage = lock?.packages?.[lockKey];
    if (runtimeManifest?.version !== lockedRuntimePackage?.version
      || typeof lockedRuntimePackage?.integrity !== "string") {
      throw new Error("production_release_wrangler_toolchain_invalid");
    }
    hash.update(`package:${lockKey}:${runtimeManifest.name ?? "unknown"}:${runtimeManifest.version}:${lockedRuntimePackage.integrity}:`);
    await hashWranglerToolchainDirectory(runtimePackageRoot, runtimePackageRoot, hash);
  }
  return {
    cliPath,
    fingerprintSha256: hash.digest("hex"),
    packageCount: runtimePackages.size,
    packageVersion: pinnedVersion,
  };
}

export async function fingerprintProductionWranglerToolchain(root = repositoryRoot) {
  return (await createProductionWranglerToolchainAttestation(root)).fingerprintSha256;
}

export async function assertProductionWranglerToolchain(expected, root = repositoryRoot) {
  const current = await createProductionWranglerToolchainAttestation(root);
  if (!/^[a-f0-9]{64}$/u.test(expected?.fingerprintSha256 ?? "")
    || current.cliPath !== expected.cliPath
    || current.packageCount !== expected.packageCount
    || current.packageVersion !== expected.packageVersion
    || current.fingerprintSha256 !== expected.fingerprintSha256) {
    throw new Error("production_release_wrangler_toolchain_drift");
  }
  return expected;
}

const productionWranglerRunQueues = new Map();

export async function runAttestedProductionWrangler(attestation, args, options = {}) {
  const queueKey = attestation.cliPath;
  const previous = productionWranglerRunQueues.get(queueKey) ?? Promise.resolve();
  const execution = previous.catch(() => undefined).then(async () => {
    await assertProductionWranglerToolchain(attestation, options.repositoryRoot ?? repositoryRoot);
    const environment = { ...(options.env ?? process.env) };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    const result = spawnSync(process.execPath, ["--no-warnings", attestation.cliPath, ...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: environment,
      maxBuffer: PRODUCTION_RELEASE_GIT_MAX_BUFFER,
      stdio: options.capture === false ? "inherit" : "pipe",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const safeOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
      throw new Error(`command_failed:wrangler:${args[0] ?? "unknown"}:${safeOutput}`);
    }
    return { stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
  });
  const settled = execution.finally(() => {
    if (productionWranglerRunQueues.get(queueKey) === settled) productionWranglerRunQueues.delete(queueKey);
  });
  productionWranglerRunQueues.set(queueKey, settled);
  return execution;
}

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
  "candidateUpload.completedAt",
  "candidateUpload.reportRef",
  "candidateUpload.reportSha256",
  "candidateUpload.reviewedCommitSha",
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
const WORKER_VERSION_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
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
  if (path === "candidateUpload.completedAt") return safeDate(value) !== null;
  if (path === "candidateUpload.reportSha256") return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
  if (path === "candidateUpload.reviewedCommitSha" || path === "commitSha") {
    return typeof value === "string" && /^[a-f0-9]{40}$/u.test(value);
  }
  if (path === "candidateWorkerVersion" || path === "previousWorkerVersion") {
    return typeof value === "string" && WORKER_VERSION_PATTERN.test(value);
  }
  if (path === "security.criticalOpen" || path === "security.highOpen") return value === 0;
  if (path === "pilot.shopCount") return Number.isSafeInteger(value) && value >= 2;
  if (path === "releaseId") return typeof value === "string" && RELEASE_ID_PATTERN.test(value) && !PLACEHOLDER_PATTERN.test(value);
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
    makeCheck("wrangler.env.production.preview_urls", production?.preview_urls === false),
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
  const candidatePending = input.candidatePending === true;
  for (const path of REQUIRED_EVIDENCE_PATHS) {
    if (candidatePending && (path === "candidateWorkerVersion" || path.startsWith("candidateUpload."))) continue;
    const value = getPath(evidence, path);
    checks.push(makeCheck(`evidence.${path}`, validEvidencePath(path, value)));
  }
  if (candidatePending) {
    checks.push(
      makeCheck("evidence.candidateWorkerVersion.pending", evidence?.candidateWorkerVersion === null),
      makeCheck("evidence.candidateUpload.pending", evidence?.candidateUpload == null),
    );
  } else {
    checks.push(makeCheck(
      "evidence.candidateUpload.commitAlignment",
      evidence?.candidateUpload?.reviewedCommitSha === evidence?.commitSha,
    ));
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
  if (!candidatePending) {
    checks.push(makeCheck(
      "evidence.workerVersion.transition",
      evidence?.candidateWorkerVersion !== evidence?.previousWorkerVersion,
    ));
  }

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
    candidateUpload: {
      completedAt: input.evidence.candidateUpload.completedAt,
      reportRef: input.evidence.candidateUpload.reportRef,
      reportSha256: input.evidence.candidateUpload.reportSha256,
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
    schemaVersion: 3,
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
    candidateWorkerVersion: input.manifest.candidateWorkerVersion,
    commitSha: input.repositoryCommitSha,
    previousWorkerVersion: input.manifest.previousWorkerVersion,
    releaseId: input.manifest.releaseId,
  };
}

export function validateProductionCandidateUploadAdmission(input) {
  if (input.repositoryClean !== true) throw new Error("production_candidate_source_dirty");
  if (!/^[a-f0-9]{40}$/u.test(input.repositoryCommitSha ?? "")) {
    throw new Error("production_candidate_commit_unavailable");
  }
  if (input.evidence?.commitSha !== input.repositoryCommitSha) {
    throw new Error("production_candidate_evidence_commit_mismatch");
  }
  const readiness = inspectProductionReadiness({ ...input, candidatePending: true });
  if (!readiness.ok) {
    throw new Error(`production_candidate_prerequisites_incomplete:${readiness.missing[0] ?? "unknown"}`);
  }
  return {
    commitSha: input.repositoryCommitSha,
    previousWorkerVersion: input.evidence.previousWorkerVersion,
    releaseId: input.evidence.releaseId,
  };
}

function normalizeVersionIds(versions, code) {
  if (!Array.isArray(versions)) throw new Error(code);
  const ids = versions.map((version) => version?.id);
  if (ids.some((id) => typeof id !== "string" || !WORKER_VERSION_PATTERN.test(id))) throw new Error(code);
  if (new Set(ids).size !== ids.length) throw new Error(code);
  return ids;
}

export function captureProductionCandidateVersion(input) {
  const beforeIds = normalizeVersionIds(input.beforeVersions, "production_candidate_versions_before_invalid");
  const afterIds = normalizeVersionIds(input.afterVersions, "production_candidate_versions_after_invalid");
  const before = new Set(beforeIds);
  if (beforeIds.some((id) => !afterIds.includes(id))) {
    throw new Error("production_candidate_version_inventory_drift");
  }
  const added = afterIds.filter((id) => !before.has(id));
  if (added.length !== 1 || added[0] === input.activeVersionId) {
    throw new Error("production_candidate_capture_invalid");
  }
  if (!WORKER_VERSION_PATTERN.test(input.activeVersionId ?? "")) {
    throw new Error("production_candidate_active_version_invalid");
  }
  return added[0];
}

export function productionDeploymentVersion(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("production_worker_deployments_invalid");
  }
  const normalized = deployments.map((deployment) => {
    const createdOn = deployment?.created_on ?? deployment?.createdOn;
    const version = Array.isArray(deployment?.versions) && deployment.versions.length === 1
      ? deployment.versions[0]
      : null;
    if (
      typeof createdOn !== "string"
      || safeDate(createdOn) === null
      || !WORKER_VERSION_PATTERN.test(version?.version_id ?? "")
      || version?.percentage !== 100
    ) {
      throw new Error("production_worker_deployments_invalid");
    }
    return { createdOn, versionId: version.version_id };
  }).sort((left, right) => Date.parse(right.createdOn) - Date.parse(left.createdOn));
  return normalized[0].versionId;
}

async function hashUploadDirectory(directory, root, hash) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new Error("production_candidate_upload_inputs_missing");
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const relativePath = path.slice(root.length + 1);
    if (entry.isDirectory()) {
      await hashUploadDirectory(path, root, hash);
      continue;
    }
    if (!entry.isFile()) throw new Error("production_candidate_upload_inputs_invalid");
    const value = await readFile(path);
    hash.update(`${relativePath.length}:${relativePath}:${value.byteLength}:`);
    hash.update(value);
  }
}

function assertProductionGeneratedUploadConfigNonExecutable(config) {
  if (typeof config !== "object" || config === null
    || Object.prototype.hasOwnProperty.call(config, "build")
    || Object.prototype.hasOwnProperty.call(config, "build.command")) {
    throw new Error("production_candidate_upload_config_executable_field_forbidden");
  }
}

async function buildProductionUploadConfig(root) {
  const path = resolve(root, "dist/server/wrangler.json");
  let stat;
  let source;
  try {
    [stat, source] = await Promise.all([lstat(path), readFile(path, "utf8")]);
  } catch {
    throw new Error("production_candidate_upload_config_missing");
  }
  if (!stat.isFile()) throw new Error("production_candidate_upload_config_invalid");
  let config;
  try {
    config = JSON.parse(source);
  } catch {
    throw new Error("production_candidate_upload_config_invalid");
  }
  assertProductionGeneratedUploadConfigNonExecutable(config);
  const normalized = { ...config };
  delete normalized.configPath;
  delete normalized.userConfigPath;
  delete normalized.definedEnvironments;
  delete normalized.topLevelName;
  const text = `${JSON.stringify(canonicalize(normalized), null, 2)}\n`;
  return { config: normalized, text };
}

export function validateProductionGeneratedUploadConfig(config, input) {
  assertProductionGeneratedUploadConfigNonExecutable(config);
  const databases = Array.isArray(config?.d1_databases)
    ? config.d1_databases.filter((database) => database?.binding === "PLATFORM_DB")
    : [];
  const expectedDatabase = input.generatedManifest?.resources?.d1;
  if (
    config?.name !== input.productionSpec?.workerName
    || config?.main !== "entry.mjs"
    || config?.no_bundle !== true
    || !isDeepStrictEqual(config?.rules, [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }])
    || config?.assets?.binding !== "ASSETS"
    || config?.assets?.directory !== "../client"
    || config?.assets?.run_worker_first !== false
    || config?.vars?.APP_ENV !== "production"
    || databases.length !== 1
    || databases[0]?.database_id !== expectedDatabase?.id
    || databases[0]?.database_name !== expectedDatabase?.name
    || config?.configPath !== undefined
    || config?.userConfigPath !== undefined
  ) {
    throw new Error("production_candidate_upload_config_invalid");
  }
  return true;
}

export async function fingerprintProductionUploadInputs(root = repositoryRoot) {
  const hash = createHash("sha256");
  const wranglerPath = resolve(root, "wrangler.jsonc");
  let wranglerConfig;
  try {
    wranglerConfig = await readFile(wranglerPath);
  } catch {
    throw new Error("production_candidate_upload_inputs_missing");
  }
  const uploadConfig = await buildProductionUploadConfig(root);
  hash.update(`wrangler.jsonc:${wranglerConfig.byteLength}:`);
  hash.update(wranglerConfig);
  hash.update(`production-upload-wrangler.json:${Buffer.byteLength(uploadConfig.text)}:`);
  hash.update(uploadConfig.text);
  await hashUploadDirectory(resolve(root, "dist"), resolve(root, "dist"), hash);
  return hash.digest("hex");
}

async function lockUploadDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await lockUploadDirectory(path);
      await chmod(path, 0o500);
      continue;
    }
    if (!entry.isFile()) throw new Error("production_candidate_upload_inputs_invalid");
    await chmod(path, 0o400);
  }
}

async function unlockUploadDirectory(directory) {
  await chmod(directory, 0o700);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await unlockUploadDirectory(path);
      continue;
    }
    await chmod(path, 0o600);
  }
}

export async function removeProductionUploadStage(stageRoot, root, releaseId) {
  const parent = resolve(root ?? repositoryRoot, ".wrangler", "releases", releaseId ?? "");
  const normalizedStageRoot = resolve(stageRoot ?? "");
  if (
    !RELEASE_ID_PATTERN.test(releaseId ?? "")
    || !normalizedStageRoot.startsWith(`${parent}/candidate-upload-inputs-`)
  ) {
    throw new Error("production_candidate_upload_stage_invalid");
  }
  await unlockUploadDirectory(normalizedStageRoot);
  await rm(normalizedStageRoot, { force: true, recursive: true });
}

export async function stageProductionUploadInputs(
  root = repositoryRoot,
  releaseId,
  input,
) {
  if (!RELEASE_ID_PATTERN.test(releaseId ?? "")) {
    throw new Error("production_candidate_release_id_invalid");
  }
  const uploadConfig = await buildProductionUploadConfig(root);
  if (input !== undefined) validateProductionGeneratedUploadConfig(uploadConfig.config, input);
  const artifactSha256 = await fingerprintProductionUploadInputs(root);
  const uploadConfigSha256 = createHash("sha256").update(uploadConfig.text).digest("hex");
  const parent = resolve(root, ".wrangler", "releases", releaseId);
  await mkdir(parent, { mode: 0o700, recursive: true });
  const stageRoot = await mkdtemp(resolve(parent, "candidate-upload-inputs-"));
  try {
    await copyFile(resolve(root, "wrangler.jsonc"), resolve(stageRoot, "wrangler.jsonc"));
    await cp(resolve(root, "dist"), resolve(stageRoot, "dist"), {
      errorOnExist: true,
      force: false,
      recursive: true,
    });
    await writeFile(
      resolve(stageRoot, "production-upload-wrangler.json"),
      uploadConfig.text,
      { mode: 0o600 },
    );
    const [sourceSha256, stagedSha256] = await Promise.all([
      fingerprintProductionUploadInputs(root),
      fingerprintProductionUploadInputs(stageRoot),
    ]);
    if (sourceSha256 !== artifactSha256 || stagedSha256 !== artifactSha256) {
      throw new Error("production_candidate_upload_stage_mismatch");
    }
    const [stagedUploadConfig, storedUploadConfig] = await Promise.all([
      buildProductionUploadConfig(stageRoot),
      readFile(resolve(stageRoot, "production-upload-wrangler.json"), "utf8"),
    ]);
    if (stagedUploadConfig.text !== uploadConfig.text || storedUploadConfig !== uploadConfig.text) {
      throw new Error("production_candidate_upload_stage_mismatch");
    }
    await chmod(resolve(stageRoot, "wrangler.jsonc"), 0o400);
    await chmod(resolve(stageRoot, "production-upload-wrangler.json"), 0o400);
    await lockUploadDirectory(resolve(stageRoot, "dist"));
    await chmod(resolve(stageRoot, "dist"), 0o500);
    return { artifactSha256, stageRoot, uploadConfigSha256 };
  } catch (error) {
    await removeProductionUploadStage(stageRoot, root, releaseId);
    throw error;
  }
}

function productionCandidateBindingContract(input) {
  const production = input.wranglerConfig?.env?.production;
  const spec = input.productionSpec;
  const generated = input.generatedManifest;
  if (
    production?.name !== spec?.workerName
    || production?.preview_urls !== false
    || generated?.accountId !== spec?.accountId
    || generated?.zoneId !== spec?.zoneId
    || generated?.workerName !== spec?.workerName
    || generated?.resources?.d1?.name !== spec?.resources?.d1
  ) {
    throw new Error("production_candidate_contract_invalid");
  }
  const expected = new Map();
  for (const name of REQUIRED_PRODUCTION_VARS) {
    const value = production?.vars?.[name];
    if (typeof value !== "string") throw new Error("production_candidate_contract_invalid");
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
  expected.set("PLATFORM_CACHE", { namespace_id: generated?.resources?.platformCacheKv?.id, type: "kv_namespace" });
  expected.set("SESSION", { namespace_id: generated?.resources?.sessionKv?.id, type: "kv_namespace" });
  expected.set("PLATFORM_DB", {
    database_id: generated?.resources?.d1?.id,
    id: generated?.resources?.d1?.id,
    type: "d1",
  });
  if ([...expected.values()].some((binding) => Object.values(binding).some((value) => value === undefined))) {
    throw new Error("production_candidate_contract_invalid");
  }
  return expected;
}

export function validateProductionCandidateVersionView(view, candidateWorkerVersion, input) {
  const requiredHandlers = ["fetch", "queue", "scheduled"];
  if (
    view?.id !== candidateWorkerVersion
    || !WORKER_VERSION_PATTERN.test(candidateWorkerVersion ?? "")
    || !Array.isArray(view?.resources?.bindings)
    || !Array.isArray(view?.resources?.script?.handlers)
    || !isDeepStrictEqual([...view.resources.script.handlers].sort(), requiredHandlers)
  ) {
    throw new Error("production_candidate_view_invalid");
  }
  const expected = productionCandidateBindingContract(input);
  const observed = new Map();
  for (const binding of view.resources.bindings) {
    if (typeof binding?.name !== "string" || observed.has(binding.name)) {
      throw new Error("production_candidate_binding_inventory_invalid");
    }
    observed.set(binding.name, binding);
  }
  const missing = [...expected.keys()].find((name) => !observed.has(name));
  if (missing !== undefined) throw new Error(`production_candidate_binding_missing:${missing}`);
  const unexpected = [...observed.keys()].find((name) => !expected.has(name));
  if (unexpected !== undefined) throw new Error(`production_candidate_binding_unexpected:${unexpected}`);
  for (const [name, expectedBinding] of expected) {
    const observedBinding = observed.get(name);
    for (const [field, expectedValue] of Object.entries(expectedBinding)) {
      if (!isDeepStrictEqual(observedBinding?.[field], expectedValue)) {
        throw new Error(`production_candidate_binding_mismatch:${name}:${field}`);
      }
    }
  }
  return [...observed.keys()].sort();
}

export function validateProductionCandidateVersionProvenance(view, input) {
  if (
    view?.annotations?.["workers/message"] !== `normal release candidate ${input.commitSha}`
    || view?.annotations?.["workers/tag"] !== input.tag
    || view?.annotations?.["workers/triggered_by"] !== "version_upload"
    || view?.metadata?.source !== "wrangler"
  ) {
    throw new Error("production_candidate_provenance_invalid");
  }
  return {
    message: view.annotations["workers/message"],
    source: view.metadata.source,
    tag: view.annotations["workers/tag"],
    triggeredBy: view.annotations["workers/triggered_by"],
  };
}

export function assertProductionPreActivationVersions(initialAdmission, finalAdmission = initialAdmission) {
  if (initialAdmission?.activeWorkerVersion !== initialAdmission?.previousWorkerVersion) {
    throw new Error("production_deploy_previous_version_mismatch");
  }
  if (
    finalAdmission?.activeWorkerVersion !== finalAdmission?.previousWorkerVersion
    || finalAdmission.activeWorkerVersion !== initialAdmission.activeWorkerVersion
  ) {
    throw new Error("production_deploy_active_version_changed");
  }
  return finalAdmission.activeWorkerVersion;
}

export function buildProductionReleaseAuditEnvironment(environment, accountId, auditToken) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || typeof auditToken !== "string" || !auditToken.trim()) {
    throw new Error("production_release_audit_environment_invalid");
  }
  const child = {
    ...(environment ?? {}),
    CI: "1",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: auditToken.trim(),
  };
  for (const name of [
    "CF_API_KEY",
    "CF_API_TOKEN",
    "CF_API_BASE_URL",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_API_BASE_URL",
    "CLOUDFLARE_API_USER_SERVICE_KEY",
    "CLOUDFLARE_CANARY_AUDIT_API_TOKEN",
    "CLOUDFLARE_CANARY_ROUTE_API_TOKEN",
    "CLOUDFLARE_CANARY_WORKER_API_TOKEN",
    "CLOUDFLARE_EMAIL",
    "CLOUDFLARE_OAUTH_TOKEN",
    "CLOUDFLARE_PLATFORM_API_TOKEN",
    "CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN",
    "CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN",
    "CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN",
    "CLOUDFLARE_PRODUCTION_PROMOTION_ROUTE_API_TOKEN",
    "CLOUDFLARE_RELEASE_WORKER_API_TOKEN",
    "CLOUDFLARE_ROUTE_AUDIT_API_TOKEN",
  ]) delete child[name];
  return child;
}

export function buildProductionReleaseEditEnvironment(environment, accountId, editToken) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || typeof editToken !== "string" || !editToken.trim()) {
    throw new Error("production_release_edit_environment_invalid");
  }
  const child = {
    ...(environment ?? {}),
    CI: "1",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: editToken.trim(),
  };
  for (const name of [
    "CF_API_KEY",
    "CF_API_TOKEN",
    "CF_API_BASE_URL",
    "CLOUDFLARE_API_KEY",
    "CLOUDFLARE_API_BASE_URL",
    "CLOUDFLARE_API_USER_SERVICE_KEY",
    "CLOUDFLARE_CANARY_AUDIT_API_TOKEN",
    "CLOUDFLARE_CANARY_ROUTE_API_TOKEN",
    "CLOUDFLARE_CANARY_WORKER_API_TOKEN",
    "CLOUDFLARE_EMAIL",
    "CLOUDFLARE_OAUTH_TOKEN",
    "CLOUDFLARE_PLATFORM_API_TOKEN",
    "CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN",
    "CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN",
    "CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN",
    "CLOUDFLARE_PRODUCTION_PROMOTION_ROUTE_API_TOKEN",
    "CLOUDFLARE_RELEASE_WORKER_API_TOKEN",
    "CLOUDFLARE_ROUTE_AUDIT_API_TOKEN",
  ]) delete child[name];
  return child;
}

export async function writeProductionCandidateArtifacts(input) {
  const evidence = input.evidence;
  const report = input.report;
  if (
    evidence?.candidateWorkerVersion !== null
    || evidence?.candidateUpload != null
    || !RELEASE_ID_PATTERN.test(evidence?.releaseId ?? "")
    || report?.releaseId !== evidence.releaseId
    || report?.reviewedCommitSha !== evidence.commitSha
    || !WORKER_VERSION_PATTERN.test(report?.candidateWorkerVersion ?? "")
  ) {
    throw new Error("production_candidate_evidence_transition_invalid");
  }
  const root = input.repositoryRoot ?? repositoryRoot;
  const directory = resolve(root, ".wrangler", "releases", evidence.releaseId);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const reportPath = resolve(directory, "candidate-upload.json");
  const reportText = `${JSON.stringify(report, null, 2)}\n`;
  const reportSha256 = createHash("sha256").update(reportText).digest("hex");
  const updatedEvidence = {
    ...evidence,
    candidateUpload: {
      completedAt: report.createdAt,
      reportRef: `.wrangler/releases/${evidence.releaseId}/candidate-upload.json`,
      reportSha256,
      reviewedCommitSha: report.reviewedCommitSha,
    },
    candidateWorkerVersion: report.candidateWorkerVersion,
  };
  await writeFile(reportPath, reportText, { mode: 0o600 });
  await chmod(reportPath, 0o600);
  await writeFile(input.evidencePath, `${JSON.stringify(updatedEvidence, null, 2)}\n`, { mode: 0o600 });
  await chmod(input.evidencePath, 0o600);
  return {
    candidateWorkerVersion: report.candidateWorkerVersion,
    evidence: updatedEvidence,
    reportRef: updatedEvidence.candidateUpload.reportRef,
  };
}

function readRepositoryGitState(root) {
  const commit = runProductionReleaseGit(["rev-parse", "--verify", "HEAD"], { cwd: root });
  if (commit.error || commit.status !== 0) {
    throw new Error("production_release_commit_unavailable");
  }
  const status = runProductionReleaseGit(["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root });
  if (status.error || status.status !== 0) {
    throw new Error("production_release_source_status_unavailable");
  }
  const tree = runProductionReleaseGit(["rev-parse", "--verify", "HEAD^{tree}"], { cwd: root });
  if (tree.error || tree.status !== 0) {
    throw new Error("production_release_tree_unavailable");
  }
  return {
    commitSha: commit.stdout.trim(),
    clean: status.stdout.trim().length === 0,
    treeSha: tree.stdout.trim(),
  };
}

async function assertProductionCandidateReport(root, evidence, treeSha) {
  const expectedRef = `.wrangler/releases/${evidence?.releaseId ?? ""}/candidate-upload.json`;
  if (evidence?.candidateUpload?.reportRef !== expectedRef) {
    throw new Error("production_candidate_report_path_invalid");
  }
  const reportPath = resolve(root, expectedRef);
  let reportStat;
  let reportText;
  try {
    [reportStat, reportText] = await Promise.all([lstat(reportPath), readFile(reportPath, "utf8")]);
  } catch {
    throw new Error("production_candidate_report_missing");
  }
  if (!reportStat.isFile() || (reportStat.mode & 0o077) !== 0) {
    throw new Error("production_candidate_report_permissions_invalid");
  }
  if (createHash("sha256").update(reportText).digest("hex") !== evidence.candidateUpload.reportSha256) {
    throw new Error("production_candidate_report_fingerprint_mismatch");
  }
  let report;
  try {
    report = JSON.parse(reportText);
  } catch {
    throw new Error("production_candidate_report_invalid");
  }
  if (
    report?.schemaVersion !== 1
    || report?.mode !== "normal_release_candidate_upload"
    || report?.environment !== "production"
    || report?.releaseId !== evidence.releaseId
    || report?.reviewedCommitSha !== evidence.commitSha
    || report?.reviewedTreeSha !== treeSha
    || report?.candidateWorkerVersion !== evidence.candidateWorkerVersion
    || report?.previousWorkerVersion !== evidence.previousWorkerVersion
    || report?.createdAt !== evidence.candidateUpload.completedAt
    || !/^[a-f0-9]{64}$/u.test(report?.artifactSha256 ?? "")
    || !Array.isArray(report?.bindingNames)
    || typeof report?.tag !== "string"
  ) {
    throw new Error("production_candidate_report_invalid");
  }
  return report;
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
  const candidateReport = await assertProductionCandidateReport(root, evidence, gitState.treeSha);
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
  return { ...admission, candidateReport };
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
  const [productionSpec, stagingSpec, wranglerConfig, generatedManifest] = await Promise.all([
    input.productionSpec === undefined
      ? readOptionalJson(resolve(root, "infra/environments/production.json"))
      : input.productionSpec,
    input.stagingSpec === undefined
      ? readOptionalJson(resolve(root, "infra/environments/staging.json"))
      : input.stagingSpec,
    input.wranglerConfig === undefined
      ? readFile(resolve(root, "wrangler.jsonc"), "utf8").then((text) => JSON.parse(text))
      : input.wranglerConfig,
    input.generatedManifest === undefined
      ? readOptionalJson(resolve(root, "infra/generated/production.json"))
      : input.generatedManifest,
  ]);
  if (productionSpec === null) throw new Error("production_spec_missing");
  if (stagingSpec === null) throw new Error("staging_spec_missing");
  if (generatedManifest === null) throw new Error("production_generated_manifest_missing");
  const auditToken = input.token === undefined
    ? requireCloudflareRouteAuditToken(input.environment)
    : requireCloudflareRouteAuditToken({ CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: input.token });
  const auditEnvironment = buildProductionReleaseAuditEnvironment(
    input.environment,
    productionSpec.accountId,
    auditToken,
  );
  const workerAdmission = await (
    input.workerIdentityImplementation ?? assertProductionWorkerIdentityAdmission
  )({
    environment: auditEnvironment,
    fetchImplementation: input.fetchImplementation,
    productionSpec,
    repositoryRoot: root,
    runWranglerImplementation: input.runWranglerImplementation,
    stagingSpec,
    token: auditToken,
    wranglerConfig,
  });
  const deploymentResult = await (
    input.deploymentInventoryImplementation
      ?? ((accountId, workerName) => cloudflareApiRequest(
        auditToken,
        `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/deployments`,
        { fetchImplementation: input.fetchImplementation },
      ))
  )(workerAdmission.accountId, workerAdmission.workerName);
  const deployments = Array.isArray(deploymentResult) ? deploymentResult : deploymentResult?.deployments;
  const activeWorkerVersion = productionDeploymentVersion(deployments);
  if (![releaseAdmission.previousWorkerVersion, releaseAdmission.candidateWorkerVersion].includes(activeWorkerVersion)) {
    throw new Error("production_release_active_version_unapproved");
  }
  let candidateView;
  try {
    candidateView = await (
      input.candidateVersionViewImplementation
        ?? ((accountId, workerName, versionId) => cloudflareApiRequest(
          auditToken,
          `/accounts/${accountId}/workers/scripts/${encodeURIComponent(workerName)}/versions/${versionId}`,
          { fetchImplementation: input.fetchImplementation },
        ))
    )(workerAdmission.accountId, workerAdmission.workerName, releaseAdmission.candidateWorkerVersion);
  } catch {
    throw new Error("production_candidate_version_unavailable");
  }
  const bindingNames = validateProductionCandidateVersionView(
    candidateView,
    releaseAdmission.candidateWorkerVersion,
    { generatedManifest, productionSpec, wranglerConfig },
  );
  const report = releaseAdmission.candidateReport;
  validateProductionCandidateVersionProvenance(candidateView, {
    commitSha: releaseAdmission.commitSha,
    tag: report?.tag,
  });
  if (
    report?.accountId !== workerAdmission.accountId
    || report?.workerName !== workerAdmission.workerName
    || report?.zoneId !== workerAdmission.zoneId
    || report?.previousWorkerVersion !== releaseAdmission.previousWorkerVersion
    || report?.candidateWorkerVersion !== releaseAdmission.candidateWorkerVersion
    || !isDeepStrictEqual(report?.bindingNames, bindingNames)
  ) {
    throw new Error("production_candidate_report_live_identity_mismatch");
  }
  if (input.verifyLocalArtifact === true) {
    const artifactSha256 = await fingerprintProductionUploadInputs(root);
    if (artifactSha256 !== report.artifactSha256) {
      throw new Error("production_candidate_local_artifact_mismatch");
    }
  }
  return {
    ...releaseAdmission,
    activeWorkerVersion,
    bindingNames,
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
