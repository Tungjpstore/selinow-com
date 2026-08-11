import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { runWrangler } from "./cli.mjs";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptsDirectory, "../..");
const cloudflareApiOrigin = "https://api.cloudflare.com/client/v4";
const cloudflareResponseLimit = 256 * 1024;
const cloudflareTimeoutMs = 10_000;
const cloudflareAccountIdPattern = /^[a-f0-9]{32}$/u;
const d1DatabaseIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const kvNamespaceIdPattern = /^[a-f0-9]{32}$/u;
const workerVersionIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const productionCron = "*/15 * * * *";
const productionCustomDomainInventorySql = `SELECT
  shop_id,
  hostname_normalized,
  cloudflare_hostname_id,
  status,
  is_primary,
  hostname_status,
  ssl_status,
  dns_status,
  ownership_verified_at,
  delete_requested_at,
  deleted_at,
  validation_metadata_json
FROM shop_domains
WHERE type = 'custom'
  AND deleted_at IS NULL
  AND status <> 'deleted'
ORDER BY hostname_normalized, shop_id;`;
export const CLOUDFLARE_WORKER_DEPLOY_TOKEN_NAME = "CLOUDFLARE_WORKER_DEPLOY_API_TOKEN";
export const CLOUDFLARE_D1_TOKEN_NAME = "CLOUDFLARE_D1_API_TOKEN";
export const CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_TOKEN_NAME = "CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN";

const SAFE_BUILD_ENVIRONMENT_NAMES = new Set([
  "CI",
  "COREPACK_HOME",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
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

export class CloudflareApiError extends Error {
  constructor(status, code) {
    super(`cloudflare_api_failed:${status}:${code}`);
    this.name = "CloudflareApiError";
    this.status = status;
    this.code = code;
  }
}

function parseJson(output, label) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`invalid_json_from_${label}`);
  }
}

function safeCloudflareErrorCode(payload) {
  const code = payload?.errors?.[0]?.code;
  return typeof code === "number" && Number.isSafeInteger(code) ? String(code) : "unknown";
}

export function requireCloudflarePlatformToken(environment = process.env) {
  const token = environment.CLOUDFLARE_PLATFORM_API_TOKEN?.trim();
  if (!token) {
    throw new Error("cloudflare_platform_api_token_missing");
  }
  return token;
}

export function requireCloudflareRouteAuditToken(environment = process.env) {
  const token = environment.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN?.trim();
  if (!token) {
    throw new Error("cloudflare_route_audit_api_token_missing");
  }
  return token;
}

export function requireCloudflareWorkerDeployToken(environment = process.env) {
  const token = environment[CLOUDFLARE_WORKER_DEPLOY_TOKEN_NAME]?.trim();
  if (!token) {
    throw new Error("cloudflare_worker_deploy_api_token_missing");
  }
  return token;
}

export function requireCloudflareD1Token(environment = process.env) {
  const token = environment[CLOUDFLARE_D1_TOKEN_NAME]?.trim();
  if (!token) {
    throw new Error("cloudflare_d1_api_token_missing");
  }
  return token;
}

/** Worker version/deployment inventory requires account-level promotion-read scope. */
function requireCloudflareProductionPromotionAuditToken(environment = process.env) {
  const token = environment[CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_TOKEN_NAME]?.trim();
  if (!token) {
    throw new Error("cloudflare_production_promotion_audit_api_token_missing");
  }
  return token;
}

/** Keep application builds and Worker sinks free of operator credentials. */
export function buildWorkerBuildEnvironment(environment = process.env, environmentName) {
  if (!new Set(["local", "staging", "production"]).has(environmentName)) {
    throw new Error("worker_build_environment_invalid");
  }
  const child = Object.fromEntries(Object.entries(environment ?? {}).filter(([name, value]) => (
    SAFE_BUILD_ENVIRONMENT_NAMES.has(name) && typeof value === "string"
  )));
  child.CI = "1";
  if (environmentName === "local") delete child.CLOUDFLARE_ENV;
  else child.CLOUDFLARE_ENV = environmentName;
  return child;
}

export function buildWorkerDeployEnvironment(environment = process.env, accountId) {
  if (!cloudflareAccountIdPattern.test(accountId ?? "")) {
    throw new Error("worker_deploy_account_identity_invalid");
  }
  const token = requireCloudflareWorkerDeployToken(environment);
  const child = {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: token,
  };
  for (const name of SAFE_BUILD_ENVIRONMENT_NAMES) {
    if (typeof environment?.[name] === "string") child[name] = environment[name];
  }
  delete child[CLOUDFLARE_WORKER_DEPLOY_TOKEN_NAME];
  delete child.CLOUDFLARE_OAUTH_TOKEN;
  delete child.CLOUDFLARE_API_KEY;
  delete child.CLOUDFLARE_API_USER_SERVICE_KEY;
  delete child.CLOUDFLARE_EMAIL;
  delete child.CF_API_KEY;
  delete child.CF_API_TOKEN;
  delete child.CLOUDFLARE_PLATFORM_API_TOKEN;
  delete child.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN;
  return child;
}

export function assertStagingAccountIdentity(whoamiOutput, accountId) {
  if (typeof accountId !== "string" || !cloudflareAccountIdPattern.test(accountId)) {
    throw new Error("staging_account_identity_invalid");
  }
  const observed = String(whoamiOutput ?? "")
    .match(/(?<![a-f0-9])[a-f0-9]{32}(?![a-f0-9])/giu)
    ?.map((value) => value.toLowerCase()) ?? [];
  if (!observed.includes(accountId.toLowerCase())) {
    throw new Error("staging_account_identity_mismatch");
  }
}

function hasAuthenticatedUserTokenWithoutAccountInventory(whoamiOutput) {
  try {
    const parsed = JSON.parse(String(whoamiOutput ?? ""));
    return parsed?.loggedIn === true
      && parsed?.authType === "User API Token"
      && Array.isArray(parsed?.accounts)
      && parsed.accounts.length === 0;
  } catch {
    return false;
  }
}

function accountIdentityMatches(whoamiOutput, accountId) {
  try {
    assertStagingAccountIdentity(whoamiOutput, accountId);
    return true;
  } catch {
    return hasAuthenticatedUserTokenWithoutAccountInventory(whoamiOutput);
  }
}

export function assertStagingDatabaseIdentity(d1ListOutput, databaseId, databaseName) {
  let databases;
  try {
    databases = JSON.parse(String(d1ListOutput ?? ""));
  } catch {
    throw new Error("staging_database_identity_invalid");
  }
  if (!Array.isArray(databases)) {
    throw new Error("staging_database_identity_invalid");
  }

  const rows = databases.map((database) => ({
    id: database?.uuid,
    name: database?.name,
  }));
  if (rows.some((database) => (
    typeof database.id !== "string"
      || !d1DatabaseIdPattern.test(database.id)
      || typeof database.name !== "string"
      || database.name.length < 1
      || database.name.length > 128
  ))) {
    throw new Error("staging_database_identity_invalid");
  }

  const matchingNames = rows.filter((database) => database.name === databaseName);
  if (matchingNames.length !== 1 || matchingNames[0]?.id !== databaseId) {
    throw new Error("staging_database_identity_mismatch");
  }
}

export function buildPinnedCloudflareEnvironment(environment, accountId) {
  if (typeof accountId !== "string" || !cloudflareAccountIdPattern.test(accountId)) {
    throw new Error("staging_account_identity_invalid");
  }
  const token = requireCloudflareD1Token(environment);
  const childEnvironment = Object.fromEntries(Object.entries(environment ?? {}).filter(([name, value]) => (
    SAFE_BUILD_ENVIRONMENT_NAMES.has(name) && typeof value === "string"
  )));
  childEnvironment.CLOUDFLARE_API_TOKEN = token;
  if (typeof environment?.CLOUDFLARE_ENV === "string") {
    childEnvironment.CLOUDFLARE_ENV = environment.CLOUDFLARE_ENV;
  }
  childEnvironment.CLOUDFLARE_ACCOUNT_ID = accountId;
  delete childEnvironment.CLOUDFLARE_PLATFORM_API_TOKEN;
  delete childEnvironment.CLOUDFLARE_ROUTE_AUDIT_API_TOKEN;
  delete childEnvironment[CLOUDFLARE_D1_TOKEN_NAME];
  delete childEnvironment.CLOUDFLARE_API_KEY;
  delete childEnvironment.CLOUDFLARE_API_USER_SERVICE_KEY;
  delete childEnvironment.CLOUDFLARE_EMAIL;
  delete childEnvironment.CLOUDFLARE_OAUTH_TOKEN;
  delete childEnvironment.CF_API_KEY;
  delete childEnvironment.CF_API_TOKEN;
  return childEnvironment;
}

export function validateStagingRuntimeIdentity(spec, manifest, wranglerConfig) {
  const manifestDatabase = manifest?.resources?.d1;
  if (
    spec?.environment !== "staging"
    || manifest?.environment !== "staging"
    || manifest?.accountId !== spec.accountId
    || manifest?.workerName !== spec.workerName
    || manifest?.zoneId !== spec.zoneId
    || manifest?.zoneName !== spec.zoneName
    || manifestDatabase?.name !== spec?.resources?.d1
    || typeof manifestDatabase?.id !== "string"
    || !d1DatabaseIdPattern.test(manifestDatabase.id)
  ) {
    throw new Error("staging_runtime_manifest_invalid");
  }

  const configuredDatabases = wranglerConfig?.env?.staging?.d1_databases;
  const platformDatabases = Array.isArray(configuredDatabases)
    ? configuredDatabases.filter((database) => database?.binding === "PLATFORM_DB")
    : [];
  const [configuredDatabase] = platformDatabases;
  if (
    wranglerConfig?.env?.staging?.name !== spec.workerName
    || platformDatabases.length !== 1
    || configuredDatabase?.database_name !== manifestDatabase.name
    || configuredDatabase?.database_id !== manifestDatabase.id
    || configuredDatabase?.migrations_dir !== "./migrations"
    || wranglerConfig?.env?.staging?.vars?.RESOURCE_MANIFEST_VERSION !== manifest.version
  ) {
    throw new Error("staging_database_target_mismatch");
  }

  return {
    databaseId: manifestDatabase.id,
    databaseName: manifestDatabase.name,
  };
}

async function loadStagingRuntimeIdentity(spec) {
  const [manifest, wranglerConfig] = await Promise.all([
    readFile(resolve(repositoryRoot, "infra/generated/staging.json"), "utf8")
      .then((text) => parseJson(text, "generated_staging")),
    readFile(resolve(repositoryRoot, "wrangler.jsonc"), "utf8")
      .then((text) => parseJson(text, "wrangler_config")),
  ]);
  return validateStagingRuntimeIdentity(spec, manifest, wranglerConfig);
}

export async function cloudflareApiRequest(token, path, options = {}) {
  if (!token?.trim()) {
    throw new Error("cloudflare_api_token_missing");
  }

  const fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
  let response;
  try {
    response = await fetchImplementation(`${cloudflareApiOrigin}${path}`, {
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      method: options.method ?? "GET",
      signal: globalThis.AbortSignal.timeout(cloudflareTimeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("cloudflare_api_timeout", { cause: error });
    }
    throw new Error("cloudflare_api_unavailable", { cause: error });
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > cloudflareResponseLimit) {
    throw new Error("cloudflare_api_response_too_large");
  }

  const responseText = await response.text();
  if (new globalThis.TextEncoder().encode(responseText).byteLength > cloudflareResponseLimit) {
    throw new Error("cloudflare_api_response_too_large");
  }

  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error("cloudflare_api_invalid_json");
  }

  if (!response.ok || payload?.success !== true) {
    throw new CloudflareApiError(response.status, safeCloudflareErrorCode(payload));
  }
  if (options.includeEnvelope === true) {
    return {
      result: payload.result,
      resultInfo: payload.result_info ?? null,
    };
  }
  return payload.result;
}

export function parseSecretNames(output) {
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) {
      return parsed
        .map((secret) => secret?.name)
        .filter((name) => typeof name === "string");
    }
  } catch {
    // Wrangler versions may render a table instead of JSON.
  }

  return [...output.matchAll(/\b[A-Z][A-Z0-9_]+\b/gu)].map((match) => match[0]);
}

function normalizeDnsValue(type, value) {
  const normalized = String(value ?? "").trim();
  if (type === "CNAME") {
    return normalized.toLowerCase().replace(/\.$/u, "");
  }
  return normalized.toLowerCase();
}

function assertSaasSpec(spec) {
  if (!/^[a-f0-9]{32}$/u.test(spec.zoneId ?? "")) {
    throw new Error("cloudflare_zone_id_invalid");
  }
  if (!spec.saas || !Array.isArray(spec.saas.dnsRecords)) {
    throw new Error("cloudflare_saas_spec_missing");
  }

  const zoneSuffix = `.${spec.zoneName}`;
  for (const record of spec.saas.dnsRecords) {
    if (!record.name.endsWith(zoneSuffix)) {
      throw new Error(`dns_record_outside_zone:${record.name}`);
    }
  }
  if (!spec.saas.fallbackOrigin.endsWith(zoneSuffix)
    || !spec.saas.cnameTarget.endsWith(zoneSuffix)) {
    throw new Error("cloudflare_saas_hostname_outside_zone");
  }
  if (spec.saas.fallbackOrigin !== `proxy-fallback.${spec.zoneName}`
    || spec.saas.cnameTarget !== `customers.${spec.zoneName}`) {
    throw new Error("cloudflare_saas_hostname_invalid");
  }

  const fallbackRecord = spec.saas.dnsRecords.find(
    (record) => record.key === "fallbackOrigin",
  );
  const cnameRecord = spec.saas.dnsRecords.find((record) => record.key === "cnameTarget");
  if (fallbackRecord?.name !== spec.saas.fallbackOrigin
    || fallbackRecord.type !== "AAAA"
    || fallbackRecord.content !== "100::"
    || fallbackRecord.proxied !== true
    || fallbackRecord.ttl !== 1
    || cnameRecord?.name !== spec.saas.cnameTarget
    || cnameRecord.type !== "CNAME"
    || normalizeDnsValue("CNAME", cnameRecord.content)
      !== normalizeDnsValue("CNAME", spec.saas.fallbackOrigin)
    || cnameRecord.proxied !== true
    || cnameRecord.ttl !== 1) {
    throw new Error("cloudflare_saas_contract_invalid");
  }
}

function planDnsRecord(desired, records) {
  const matchingName = records.filter(
    (record) => String(record.name).toLowerCase() === desired.name.toLowerCase(),
  );
  if (matchingName.length === 0) {
    return { action: "create", key: desired.key, kind: "dns", name: desired.name };
  }
  if (matchingName.length !== 1 || matchingName[0].type !== desired.type) {
    return { action: "conflict", key: desired.key, kind: "dns", name: desired.name };
  }

  const existing = matchingName[0];
  const matches = normalizeDnsValue(desired.type, existing.content)
      === normalizeDnsValue(desired.type, desired.content)
    && existing.proxied === desired.proxied
    && existing.ttl === desired.ttl;
  return {
    action: matches ? "reuse" : "update",
    key: desired.key,
    kind: "dns",
    name: desired.name,
    recordId: existing.id,
  };
}

export function planSaasConfiguration(spec, state) {
  assertSaasSpec(spec);
  const actions = spec.saas.dnsRecords.map((record) => (
    planDnsRecord(record, state.dnsRecords[record.key] ?? [])
  ));
  const fallback = state.fallbackOrigin;
  actions.push({
    action: !fallback
      ? "create"
      : normalizeDnsValue("CNAME", fallback.origin)
          === normalizeDnsValue("CNAME", spec.saas.fallbackOrigin)
        ? "reuse"
        : "update",
    key: "fallbackOrigin",
    kind: "fallback_origin",
    name: spec.saas.fallbackOrigin,
    status: fallback?.status ?? "missing",
  });
  return actions;
}

export async function discoverSaasState(spec, token, fetchImplementation = globalThis.fetch) {
  assertSaasSpec(spec);
  const dnsEntries = await Promise.all(spec.saas.dnsRecords.map(async (record) => {
    const result = await cloudflareApiRequest(
      token,
      `/zones/${spec.zoneId}/dns_records?name=${encodeURIComponent(record.name)}`,
      { fetchImplementation },
    );
    if (!Array.isArray(result)) {
      throw new Error("cloudflare_dns_response_invalid");
    }
    return [record.key, result];
  }));

  let fallbackOrigin = null;
  try {
    fallbackOrigin = await cloudflareApiRequest(
      token,
      `/zones/${spec.zoneId}/custom_hostnames/fallback_origin`,
      { fetchImplementation },
    );
  } catch (error) {
    if (!(error instanceof CloudflareApiError && error.status === 404)) {
      throw error;
    }
  }

  return { dnsRecords: Object.fromEntries(dnsEntries), fallbackOrigin };
}

async function applySaasConfiguration(spec, state, token, fetchImplementation = globalThis.fetch) {
  const actions = planSaasConfiguration(spec, state);
  const conflict = actions.find((action) => action.action === "conflict");
  if (conflict) {
    throw new Error(`cloudflare_dns_conflict:${conflict.name}`);
  }

  for (const action of actions) {
    if (action.action === "reuse") {
      continue;
    }
    if (action.kind === "fallback_origin") {
      await cloudflareApiRequest(
        token,
        `/zones/${spec.zoneId}/custom_hostnames/fallback_origin`,
        { body: { origin: spec.saas.fallbackOrigin }, fetchImplementation, method: "PUT" },
      );
      continue;
    }

    const desired = spec.saas.dnsRecords.find((record) => record.key === action.key);
    if (!desired) {
      throw new Error(`cloudflare_dns_spec_missing:${action.key}`);
    }
    const body = {
      content: desired.content,
      name: desired.name,
      proxied: desired.proxied,
      ttl: desired.ttl,
      type: desired.type,
    };
    const path = action.action === "create"
      ? `/zones/${spec.zoneId}/dns_records`
      : `/zones/${spec.zoneId}/dns_records/${action.recordId}`;
    await cloudflareApiRequest(token, path, {
      body,
      fetchImplementation,
      method: action.action === "create" ? "POST" : "PATCH",
    });
  }
}

export async function loadEnvironment(environment) {
  if (environment === "local") {
    return {
      environment: "local",
      resources: {},
      workerName: "selinow-com",
      zoneName: "localhost",
    };
  }

  const filePath = resolve(repositoryRoot, `infra/environments/${environment}.json`);
  return parseJson(await readFile(filePath, "utf8"), `environment_${environment}`);
}

export function assertOwnedName(name) {
  if (!/^selinow-[a-z0-9-]+$/u.test(name)) {
    throw new Error(`resource_name_outside_product_boundary:${name}`);
  }
}

export function parseR2Names(output) {
  return [...output.matchAll(/^name:\s+([^\s]+)$/gmu)].map((match) => match[1]);
}

export function parseQueueNames(output) {
  const names = new Set();
  for (const line of output.split("\n")) {
    const normalized = line.trim();
    const match = normalized.match(/selinow-[a-z0-9-]+/u);
    if (match) {
      names.add(match[0]);
    }
  }
  return [...names];
}

export async function discoverRemoteResources(input = {}) {
  const runner = input.runWranglerImplementation ?? runWrangler;
  const runnerOptions = {
    cwd: repositoryRoot,
    ...(input.environment === undefined ? {} : { env: input.environment }),
  };
  const d1 = parseJson(
    runner(["d1", "list", "--json"], runnerOptions).stdout,
    "d1_list",
  );
  const kv = parseJson(
    runner(["kv", "namespace", "list"], runnerOptions).stdout,
    "kv_list",
  );
  const r2 = parseR2Names(
    runner(["r2", "bucket", "list"], runnerOptions).stdout,
  );
  const queues = parseQueueNames(
    runner(["queues", "list"], runnerOptions).stdout,
  );

  return { d1, kv, queues, r2 };
}

function findResourceState(spec, remote) {
  return {
    d1: remote.d1.find((database) => database.name === spec.resources.d1) ?? null,
    platformCacheKv: remote.kv.find((namespace) => namespace.title === spec.resources.platformCacheKv) ?? null,
    privateExports: remote.r2.includes(spec.resources.privateExports) ? { name: spec.resources.privateExports } : null,
    sessionKv: remote.kv.find((namespace) => namespace.title === spec.resources.sessionKv) ?? null,
    r2: remote.r2.includes(spec.resources.r2) ? { name: spec.resources.r2 } : null,
    integrationQueue: remote.queues.includes(spec.resources.integrationQueue) ? { name: spec.resources.integrationQueue } : null,
    notificationQueue: remote.queues.includes(spec.resources.notificationQueue) ? { name: spec.resources.notificationQueue } : null,
    deadLetterQueue: remote.queues.includes(spec.resources.deadLetterQueue) ? { name: spec.resources.deadLetterQueue } : null,
  };
}

function desiredResources(spec) {
  return [
    { key: "d1", name: spec.resources.d1, type: "d1" },
    { key: "r2", name: spec.resources.r2, type: "r2" },
    { key: "privateExports", name: spec.resources.privateExports, type: "r2" },
    { key: "platformCacheKv", name: spec.resources.platformCacheKv, type: "kv" },
    { key: "sessionKv", name: spec.resources.sessionKv, type: "kv" },
    { key: "integrationQueue", name: spec.resources.integrationQueue, type: "queue" },
    { key: "notificationQueue", name: spec.resources.notificationQueue, type: "queue" },
    { key: "deadLetterQueue", name: spec.resources.deadLetterQueue, type: "queue" },
  ];
}

function createRemoteResource(resource, input = {}) {
  assertOwnedName(resource.name);
  const runner = input.runWranglerImplementation ?? runWrangler;
  const runnerOptions = {
    cwd: repositoryRoot,
    ...(input.environment === undefined ? {} : { env: input.environment }),
  };

  if (resource.type === "d1") {
    runner(["d1", "create", resource.name, "--location", "apac"], runnerOptions);
  } else if (resource.type === "r2") {
    runner(["r2", "bucket", "create", resource.name, "--location", "apac"], runnerOptions);
  } else if (resource.type === "kv") {
    runner(["kv", "namespace", "create", resource.name], runnerOptions);
  } else if (resource.type === "queue") {
    runner([
      "queues",
      "create",
      resource.name,
      "--message-retention-period-secs",
      "1209600",
    ], runnerOptions);
  } else {
    throw new Error(`unsupported_resource_type:${resource.type}`);
  }
}

function buildManifest(spec, state) {
  if (!state.d1 || !state.platformCacheKv || !state.privateExports || !state.sessionKv || !state.r2
    || !state.integrationQueue || !state.notificationQueue || !state.deadLetterQueue) {
    throw new Error("resource_discovery_incomplete");
  }

  const identity = {
    accountId: spec.accountId,
    environment: spec.environment,
    resources: {
      d1: { id: state.d1.uuid, name: state.d1.name },
      deadLetterQueue: state.deadLetterQueue,
      integrationQueue: state.integrationQueue,
      notificationQueue: state.notificationQueue,
      platformCacheKv: { id: state.platformCacheKv.id, name: state.platformCacheKv.title },
      privateExports: state.privateExports,
      r2: state.r2,
      sessionKv: { id: state.sessionKv.id, name: state.sessionKv.title },
    },
    saas: {
      cnameTarget: spec.saas.cnameTarget,
      fallbackOrigin: spec.saas.fallbackOrigin,
    },
    workerName: spec.workerName,
    zoneId: spec.zoneId,
    zoneName: spec.zoneName,
  };
  const version = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
  return { ...identity, version };
}

export function buildStagingVars(spec, manifest) {
  return {
    API_ORIGIN: `https://${spec.hostnames[2]}`,
    APP_ENV: "staging",
    CLOUDFLARE_ZONE_ID: spec.zoneId,
    CREDENTIAL_KEY_VERSION: "v1",
    DASHBOARD_ORIGIN: `https://${spec.hostnames[1]}`,
    DEFAULT_CURRENCY: "VND",
    DEFAULT_LOCALE: "en",
    DEFAULT_TIMEZONE: "Asia/Ho_Chi_Minh",
    EMAIL_FROM_ADDRESS: `no-reply@${spec.zoneName}`,
    EMAIL_FROM_NAME: "Selinow",
    INVENTORY_KEY_VERSION: "v1",
    LOG_LEVEL: "info",
    PLATFORM_BASE_DOMAIN: `staging.${spec.zoneName}`,
    PLATFORM_NAME: "Selinow Staging",
    PLATFORM_ORIGIN: `https://${spec.hostnames[0]}`,
    RESOURCE_MANIFEST_VERSION: manifest.version,
    SAAS_CNAME_TARGET: spec.saas.cnameTarget,
    SESSION_COOKIE_NAME: "selinow_staging_session",
  };
}

export function buildStagingRoutes(spec) {
  const expectedProductionWorkerName = typeof spec.workerName === "string"
    ? spec.workerName.replace(/-staging$/u, "-production")
    : null;
  const expectedDisabledRoutes = [
    `${spec.zoneName}/*`,
    `*.${spec.zoneName}/*`,
    "*/*",
  ];
  const expectedStagingRouteExceptions = [
    ...spec.hostnames.slice(0, 3).map((hostname) => `${hostname}/*`),
    spec.wildcardRoute,
  ];
  const expectedRoutes = [
    ...spec.hostnames.map((hostname) => ({ custom_domain: true, pattern: hostname })),
    ...expectedStagingRouteExceptions
      .filter((pattern) => pattern !== spec.wildcardRoute)
      .map((pattern) => ({ pattern, zone_name: spec.zoneName })),
    { pattern: spec.wildcardRoute, zone_name: spec.zoneName },
  ];
  if (expectedProductionWorkerName === spec.workerName
    || spec.productionWorkerName !== expectedProductionWorkerName
    || spec.productionWorkerName === spec.workerName
    || JSON.stringify(spec.sharedZoneDisabledRoutes) !== JSON.stringify(expectedDisabledRoutes)
    || JSON.stringify(spec.stagingRouteExceptions) !== JSON.stringify(expectedStagingRouteExceptions)
    || JSON.stringify(spec.workerRoutes) !== JSON.stringify(expectedRoutes)) {
    throw new Error("cloudflare_staging_route_contract_invalid");
  }
  return spec.workerRoutes;
}

export function validateStagingRouteInventory(spec, liveRoutes) {
  buildStagingRoutes(spec);
  if (!Array.isArray(liveRoutes)) {
    throw new Error("cloudflare_staging_route_inventory_invalid_response");
  }

  const routePatterns = liveRoutes.map((route) => (
    route !== null
      && typeof route === "object"
      && typeof route.pattern === "string"
      && Object.prototype.hasOwnProperty.call(route, "script")
      && (route.script === null || typeof route.script === "string")
      ? route.pattern
      : null
  ));
  const sharedZonePatterns = new Set(spec.sharedZoneDisabledRoutes);
  const stagingExceptionPatterns = new Set(spec.stagingRouteExceptions);
  const expectedBindings = new Map([
    ...[...sharedZonePatterns].map((pattern) => [pattern, spec.productionWorkerName]),
    ...[...stagingExceptionPatterns].map((pattern) => [pattern, spec.workerName]),
  ]);
  const inventoryAllowlistOk = routePatterns.every((pattern) => pattern !== null)
    && new Set(routePatterns).size === routePatterns.length
    && liveRoutes.length === expectedBindings.size
    && liveRoutes.every((route) => (
      expectedBindings.has(route.pattern)
      && route.script === expectedBindings.get(route.pattern)
    ));

  // A required route can be correct while an additional, higher-priority
  // script-bound route still diverts staging traffic to another Worker. Keep
  // the allowlist tied to the checked-in staging route contract and fail closed
  // on any extra or conflicting script binding.
  const allowedScriptPatterns = new Set([
    ...spec.sharedZoneDisabledRoutes,
    ...spec.stagingRouteExceptions,
  ]);
  const scriptBindingChecks = liveRoutes
    .filter((route) => (
      route !== null
      && typeof route === "object"
      && typeof route.pattern === "string"
      && Object.prototype.hasOwnProperty.call(route, "script")
      && route.script !== null
      && route.script !== undefined
    ))
    .map((route) => {
      const ok = typeof route.script === "string"
        && allowedScriptPatterns.has(route.pattern)
        && (route.script === spec.workerName
          || (sharedZonePatterns.has(route.pattern) && route.script === spec.productionWorkerName));
      return {
        code: "cloudflare_staging_route_script_binding",
        detail: ok
          ? `${route.pattern} is bound to ${route.script}`
          : `${route.pattern} has an unapproved staging Worker binding`,
        ok,
      };
    });

  const expectedRoutes = [
    {
      code: "cloudflare_staging_route_guard_apex",
      detail: `${spec.zoneName}/* is bound to the approved production Worker`,
      pattern: `${spec.zoneName}/*`,
      script: spec.productionWorkerName,
    },
    {
      code: "cloudflare_staging_route_guard_wildcard",
      detail: `*.${spec.zoneName}/* is bound to the approved production Worker`,
      pattern: `*.${spec.zoneName}/*`,
      script: spec.productionWorkerName,
    },
    {
      code: "cloudflare_staging_route_wildcard",
      detail: `${spec.wildcardRoute} points only to ${spec.workerName}`,
      pattern: spec.wildcardRoute,
      script: spec.workerName,
    },
    {
      code: "cloudflare_staging_route_catch_all",
      detail: `*/* points only to ${spec.productionWorkerName} outside staging exceptions`,
      pattern: "*/*",
      script: spec.productionWorkerName,
    },
  ];

  for (const pattern of spec.stagingRouteExceptions) {
    if (pattern === spec.wildcardRoute) continue;
    expectedRoutes.splice(expectedRoutes.length - 1, 0, {
      code: `cloudflare_staging_route_exception_${pattern.replace(/[^a-z0-9]+/giu, "_").replace(/^_|_$/gu, "")}`,
      detail: `${pattern} points only to ${spec.workerName}`,
      pattern,
      script: spec.workerName,
    });
  }

  const checks = expectedRoutes.map((expected) => {
    const matchingRoutes = liveRoutes.filter((route) => (
      route !== null
      && typeof route === "object"
      && route.pattern === expected.pattern
    ));
    const ok = matchingRoutes.length === 1
      && matchingRoutes[0].script === expectedBindings.get(expected.pattern);
    return {
      code: expected.code,
      detail: ok
        ? expected.detail
        : `${expected.pattern} does not match the required staging route contract`,
      ok,
    };
  });

  checks.push(...scriptBindingChecks);
  checks.push({
    code: "cloudflare_staging_route_inventory_allowlist",
    detail: inventoryAllowlistOk
      ? "Live routes contain only unique, well-formed bindings and the approved shared-zone boundary"
      : "Live routes contain malformed, duplicate, missing, or unapproved bindings",
    ok: inventoryAllowlistOk,
  });
  return { checks, ok: checks.every((check) => check.ok) };
}

export async function auditStagingRouteInventory(
  spec,
  token,
  fetchImplementation = globalThis.fetch,
) {
  const liveRoutes = await cloudflareApiRequest(
    token,
    `/zones/${spec.zoneId}/workers/routes`,
    { fetchImplementation },
  );
  return validateStagingRouteInventory(spec, liveRoutes);
}

function productionWorkerRouteContract(productionSpec, stagingSpec, wranglerConfig) {
  const production = wranglerConfig?.env?.production;
  const productionHostnames = Object.values(productionSpec?.hostnames ?? {});
  const canaryHostname = productionSpec?.bootstrap?.canaryHostname;
  const productionDatabases = Array.isArray(production?.d1_databases)
    ? production.d1_databases.filter((database) => database?.binding === "PLATFORM_DB")
    : [];
  const [productionDatabase] = productionDatabases;
  if (
    productionSpec?.environment !== "production"
    || stagingSpec?.environment !== "staging"
    || productionSpec?.accountId !== stagingSpec?.accountId
    || productionSpec?.zoneId !== stagingSpec?.zoneId
    || productionSpec?.zoneName !== stagingSpec?.zoneName
    || canaryHostname !== `canary.${productionSpec?.zoneName}`
    || production?.name !== productionSpec?.workerName
    || stagingSpec?.productionWorkerName !== productionSpec?.workerName
    || !cloudflareAccountIdPattern.test(productionSpec?.accountId ?? "")
    || !cloudflareAccountIdPattern.test(productionSpec?.zoneId ?? "")
    || typeof productionSpec?.workerName !== "string"
    || !/^selinow-[a-z0-9-]+-production$/u.test(productionSpec.workerName)
    || productionHostnames.length !== 3
    || productionHostnames.some((hostname) => (
      typeof hostname !== "string"
      || (!hostname.endsWith(`.${productionSpec.zoneName}`) && hostname !== productionSpec.zoneName)
    ))
    || productionDatabases.length !== 1
    || productionDatabase?.database_name !== productionSpec?.resources?.d1
    || !d1DatabaseIdPattern.test(productionDatabase?.database_id ?? "")
    || !Array.isArray(production?.routes)
  ) {
    throw new Error("production_worker_route_contract_invalid");
  }

  buildStagingRoutes(stagingSpec);
  const routeKeys = production.routes.map((route) => {
    if (
      route === null
      || typeof route !== "object"
      || typeof route.pattern !== "string"
      || route.pattern.length === 0
      || route.pattern.length > 253
      || (route.custom_domain !== undefined && route.custom_domain !== true)
      || (route.zone_name !== undefined && route.zone_name !== productionSpec.zoneName)
      || (route.custom_domain === true && route.zone_name !== undefined)
    ) {
      throw new Error("production_worker_route_contract_invalid");
    }
    return `${route.pattern}\u0000${route.custom_domain === true ? "domain" : route.zone_name === undefined && !route.pattern.includes("/") && !route.pattern.includes("*") ? "domain" : "route"}`;
  });
  if (new Set(routeKeys).size !== routeKeys.length) {
    throw new Error("production_worker_route_contract_invalid");
  }

  const customDomains = new Set();
  const zoneRoutes = new Set();
  for (const key of routeKeys) {
    const [pattern, kind] = key.split("\u0000");
    if (kind === "domain") customDomains.add(pattern);
    else zoneRoutes.add(pattern);
  }
  const marketingHostname = productionSpec.hostnames.marketing;
  const requiredProductionDomains = productionHostnames.filter((hostname) => hostname !== marketingHostname);
  if (requiredProductionDomains.some((hostname) => !customDomains.has(hostname))
    || (!customDomains.has(marketingHostname) && !zoneRoutes.has(`${marketingHostname}/*`))) {
    throw new Error("production_worker_route_contract_invalid");
  }

  const stagingCustomDomains = new Set(stagingSpec.workerRoutes
    .filter((route) => route.custom_domain === true)
    .map((route) => route.pattern));
  const stagingZoneRoutes = new Map(stagingSpec.stagingRouteExceptions
    .map((pattern) => [pattern, stagingSpec.workerName]));
  if ([...zoneRoutes].some((pattern) => stagingZoneRoutes.has(pattern))) {
    throw new Error("production_worker_route_contract_invalid");
  }
  const stagingAndProductionDomains = [
    ...customDomains,
    ...stagingCustomDomains,
  ];
  if (
    new Set(stagingAndProductionDomains).size !== stagingAndProductionDomains.length
    || customDomains.has(canaryHostname)
    || stagingCustomDomains.has(canaryHostname)
  ) {
    throw new Error("production_worker_route_contract_invalid");
  }
  return {
    canaryDnsCarrier: { hostname: canaryHostname, service: stagingSpec.workerName },
    customDomains,
    databaseId: productionDatabase.database_id,
    databaseName: productionDatabase.database_name,
    productionWorkerName: productionSpec.workerName,
    stagingCustomDomains,
    stagingWorkerName: stagingSpec.workerName,
    stagingZoneRoutes,
    zoneId: productionSpec.zoneId,
    zoneName: productionSpec.zoneName,
    zoneRoutes,
  };
}

export function assertProductionWorkerDatabaseIdentity(
  d1ListOutput,
  databaseId,
  databaseName,
) {
  let databases;
  try {
    databases = JSON.parse(String(d1ListOutput ?? ""));
  } catch {
    throw new Error("production_worker_database_identity_invalid");
  }
  if (!Array.isArray(databases)) {
    throw new Error("production_worker_database_identity_invalid");
  }
  const rows = databases.map((database) => ({
    id: database?.uuid,
    name: database?.name,
  }));
  if (rows.some((database) => (
    typeof database.id !== "string"
    || !d1DatabaseIdPattern.test(database.id)
    || typeof database.name !== "string"
    || database.name.length < 1
    || database.name.length > 128
  ))) {
    throw new Error("production_worker_database_identity_invalid");
  }
  const matchingNames = rows.filter((database) => database.name === databaseName);
  if (matchingNames.length !== 1 || matchingNames[0]?.id !== databaseId) {
    throw new Error("production_worker_database_identity_mismatch");
  }
}

export function parseProductionWorkerDeploymentVersion(value) {
  const deployments = Array.isArray(value) ? value : value?.deployments;
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("production_worker_deployment_inventory_invalid");
  }
  const normalized = deployments.map((deployment) => {
    const createdOn = deployment?.created_on ?? deployment?.createdOn;
    if (typeof deployment?.id !== "string"
      || !workerVersionIdPattern.test(deployment.id)
      || typeof createdOn !== "string"
      || !Number.isFinite(Date.parse(createdOn))) {
      throw new Error("production_worker_deployment_inventory_invalid");
    }
    return { createdOn, deployment };
  }).sort((left, right) => Date.parse(right.createdOn) - Date.parse(left.createdOn));
  const latest = normalized[0].deployment;
  const rawVersion = Array.isArray(latest?.versions) && latest.versions.length === 1
    ? latest.versions[0]
    : null;
  const versionId = latest?.versionId ?? rawVersion?.version_id;
  if (typeof versionId !== "string"
    || !workerVersionIdPattern.test(versionId)
    || rawVersion === null
    || rawVersion?.percentage !== 100
    || rawVersion?.version_id !== versionId) {
    throw new Error("production_worker_deployment_inventory_invalid");
  }
  return versionId;
}

function workerVersionMessageBinding(annotations) {
  const message = annotations?.["workers/message"];
  if (typeof message !== "string") return {};
  try {
    const value = JSON.parse(message);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // Wrangler messages also support a compact key=value provenance format.
  }
  return Object.fromEntries([...message.matchAll(/\b(commitSha|manifestRef|manifestSha256|releaseId|role|treeSha)=([^\s]+)\b/gu)]
    .map((match) => [match[1], match[2]]));
}

function normalizeWorkerVersionBinding(version) {
  if (version === null || typeof version !== "object") return null;
  const metadata = version.metadata;
  const annotations = version.annotations ?? metadata?.annotations;
  const messageBinding = workerVersionMessageBinding(annotations);
  const annotation = (names) => names
    .map((name) => annotations?.[name])
    .find((value) => typeof value === "string");
  const metadataValue = (names) => names
    .map((name) => metadata?.[name])
    .find((value) => typeof value === "string");
  return {
    commitSha: metadataValue(["commitSha", "commit_sha", "reviewedCommitSha", "reviewed_commit_sha"])
      ?? annotation(["selinow/commit-sha", "selinow_commit_sha", "commitSha", "commit_sha"])
      ?? messageBinding.commitSha
      ?? null,
    manifestSha256: metadataValue(["manifestSha256", "manifest_sha256", "releaseManifestSha256", "release_manifest_sha256"])
      ?? annotation(["selinow/manifest-sha256", "selinow_manifest_sha256", "manifestSha256", "manifest_sha256"])
      ?? messageBinding.manifestSha256
      ?? null,
    manifestRef: metadataValue(["manifestRef", "manifest_ref", "releaseManifestRef", "release_manifest_ref"])
      ?? annotation(["selinow/manifest-ref", "selinow_manifest_ref", "manifestRef", "manifest_ref"])
      ?? messageBinding.manifestRef
      ?? null,
    releaseId: metadataValue(["releaseId", "release_id"])
      ?? annotation(["selinow/release-id", "selinow_release_id", "releaseId", "release_id"])
      ?? messageBinding.releaseId
      ?? null,
    role: metadataValue(["role", "workerRole", "worker_role", "releaseRole", "release_role"])
      ?? annotation(["selinow/role", "selinow_role", "selinow/worker-role", "selinow_worker_role", "role", "workerRole"])
      ?? messageBinding.role
      ?? null,
    treeSha: metadataValue(["treeSha", "tree_sha", "reviewedTreeSha", "reviewed_tree_sha"])
      ?? annotation(["selinow/tree-sha", "selinow_tree_sha", "treeSha", "tree_sha"])
      ?? messageBinding.treeSha
      ?? null,
  };
}

export function parseProductionWorkerDeployableVersionInventory(value) {
  const versions = Array.isArray(value) ? value : value?.items;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error("production_worker_deployable_version_inventory_invalid");
  }
  const normalized = versions.map((version) => {
    if (typeof version?.id !== "string" || !workerVersionIdPattern.test(version.id)) {
      throw new Error("production_worker_deployable_version_inventory_invalid");
    }
    return {
      id: version.id,
      binding: normalizeWorkerVersionBinding(version),
    };
  });
  if (new Set(normalized.map((version) => version.id)).size !== normalized.length) {
    throw new Error("production_worker_deployable_version_inventory_invalid");
  }
  return normalized.sort((left, right) => left.id.localeCompare(right.id));
}

export function parseProductionWorkerDeployableVersions(value) {
  return parseProductionWorkerDeployableVersionInventory(value).map((version) => version.id);
}

function assertWorkerVersionBinding(actual, expected, issue) {
  if (expected === undefined) return;
  if (expected === null || typeof expected !== "object") throw new Error(`${issue}_invalid`);
  const required = ["commitSha", "treeSha", "releaseId"];
  if (expected.manifestSha256 !== undefined) required.push("manifestSha256");
  if (expected.manifestRef !== undefined) required.push("manifestRef");
  if (expected.role !== undefined) {
    if (!new Set(["candidate", "rollback"]).has(expected.role)) throw new Error(`${issue}_invalid`);
    required.push("role");
  }
  if (actual === null || typeof actual !== "object" || required.some((key) => typeof expected[key] !== "string" || expected[key].length === 0
    || actual[key] !== expected[key])) {
    throw new Error(`${issue}_mismatch`);
  }
}

export function assertProductionWorkerVersionAdmission(input) {
  const admissionMode = input.workerVersionAdmissionMode ?? "pre_candidate";
  if (!new Set(["pre_candidate", "candidate_active"]).has(admissionMode)) {
    throw new Error("production_worker_version_admission_mode_invalid");
  }
  if (typeof input.currentWorkerVersion !== "string"
    || !workerVersionIdPattern.test(input.currentWorkerVersion)) {
    throw new Error("production_worker_current_version_invalid");
  }
  if (typeof input.previousWorkerVersion !== "string"
    || !workerVersionIdPattern.test(input.previousWorkerVersion)) {
    throw new Error("production_previous_worker_version_invalid");
  }
  if (admissionMode === "pre_candidate" && input.previousWorkerVersion !== input.currentWorkerVersion) {
    throw new Error("production_previous_worker_version_mismatch");
  }
  if (typeof input.candidateWorkerVersion !== "string"
    || !workerVersionIdPattern.test(input.candidateWorkerVersion)) {
    throw new Error("production_candidate_worker_version_invalid");
  }
  if (typeof input.rollbackCandidateWorkerVersion !== "string"
    || !workerVersionIdPattern.test(input.rollbackCandidateWorkerVersion)) {
    throw new Error("production_rollback_candidate_version_invalid");
  }
  if (admissionMode === "pre_candidate" && input.candidateWorkerVersion === input.currentWorkerVersion) {
    throw new Error("production_candidate_worker_version_is_current");
  }
  if (admissionMode === "candidate_active" && input.currentWorkerVersion !== input.candidateWorkerVersion) {
    throw new Error("production_candidate_worker_version_not_active");
  }
  if (admissionMode === "candidate_active" && input.previousWorkerVersion === input.currentWorkerVersion) {
    throw new Error("production_previous_worker_version_not_distinct");
  }
  if (input.rollbackCandidateWorkerVersion === input.currentWorkerVersion) {
    throw new Error("production_rollback_candidate_is_current_worker");
  }
  if (input.candidateWorkerVersion === input.rollbackCandidateWorkerVersion) {
    throw new Error("production_candidate_and_rollback_versions_match");
  }
  if (!Array.isArray(input.deployableWorkerVersionIds)
    || input.deployableWorkerVersionIds.length === 0
    || input.deployableWorkerVersionIds.some((id) => typeof id !== "string" || !workerVersionIdPattern.test(id))) {
    throw new Error("production_worker_deployable_version_inventory_invalid");
  }
  const deployable = new Set(input.deployableWorkerVersionIds);
  if (deployable.size !== input.deployableWorkerVersionIds.length) {
    throw new Error("production_worker_deployable_version_inventory_invalid");
  }
  if (!deployable.has(input.candidateWorkerVersion)) {
    throw new Error("production_candidate_worker_version_not_deployable");
  }
  if (!deployable.has(input.rollbackCandidateWorkerVersion)) {
    throw new Error("production_rollback_candidate_version_not_deployable");
  }
  const versionInventory = Array.isArray(input.deployableWorkerVersionInventory)
    ? input.deployableWorkerVersionInventory
    : [];
  if (versionInventory.length > 0) {
    const entries = new Map(versionInventory.map((entry) => [entry?.id, entry?.binding]));
    assertWorkerVersionBinding(
      entries.get(input.candidateWorkerVersion),
      input.candidateWorkerVersionBinding,
      "production_candidate_worker_version_binding",
    );
    assertWorkerVersionBinding(
      entries.get(input.rollbackCandidateWorkerVersion),
      input.rollbackWorkerVersionBinding,
      "production_rollback_worker_version_binding",
    );
  } else if (input.candidateWorkerVersionBinding !== undefined || input.rollbackWorkerVersionBinding !== undefined) {
    throw new Error("production_worker_version_inventory_binding_unavailable");
  }
  return {
    candidateWorkerVersion: input.candidateWorkerVersion,
    currentWorkerVersion: input.currentWorkerVersion,
    rollbackCandidateWorkerVersion: input.rollbackCandidateWorkerVersion,
  };
}

function liveWorkerDomainIdentity(domain) {
  if (
    domain === null
    || typeof domain !== "object"
    || typeof domain.hostname !== "string"
    || typeof domain.service !== "string"
  ) {
    return null;
  }
  return {
    hostname: domain.hostname,
    service: domain.service,
    zoneId: typeof domain.zone_id === "string" ? domain.zone_id : null,
    zoneName: typeof domain.zone_name === "string" ? domain.zone_name : null,
  };
}

export function validateProductionWorkerRouteInventory(
  productionSpec,
  stagingSpec,
  wranglerConfig,
  liveRoutes,
  liveDomains,
  options = {},
) {
  const contract = productionWorkerRouteContract(productionSpec, stagingSpec, wranglerConfig);
  if (!Array.isArray(liveRoutes)) {
    throw new Error("cloudflare_production_worker_route_inventory_invalid_response");
  }
  if (!Array.isArray(liveDomains)) {
    throw new Error("cloudflare_production_worker_domain_inventory_invalid_response");
  }

  const allowedRoutes = new Map([
    ...contract.stagingZoneRoutes,
    ...[...contract.zoneRoutes].map((pattern) => [pattern, contract.productionWorkerName]),
  ]);
  const routeKeys = new Set();
  const admissionMode = options.admissionMode ?? "exact";
  if (!new Set(["exact", "pre_candidate"]).has(admissionMode)) {
    throw new Error("cloudflare_production_worker_route_admission_mode_invalid");
  }
  let routeInventoryOk = true;
  for (const route of liveRoutes) {
    if (
      route === null
      || typeof route !== "object"
      || typeof route.pattern !== "string"
      || !Object.prototype.hasOwnProperty.call(route, "script")
      || (route.script !== null && typeof route.script !== "string")
      || routeKeys.has(route.pattern)
      || !allowedRoutes.has(route.pattern)
      || (admissionMode === "exact"
        ? allowedRoutes.get(route.pattern) !== route.script
        : contract.stagingZoneRoutes.has(route.pattern)
          ? allowedRoutes.get(route.pattern) !== route.script
          : !new Set([contract.productionWorkerName, contract.stagingWorkerName, null]).has(route.script))
    ) {
      routeInventoryOk = false;
    } else {
      routeKeys.add(route.pattern);
    }
  }
  const requiredRoutesPresent = admissionMode === "exact"
    ? [...allowedRoutes].every(([pattern, script]) => (
      liveRoutes.some((route) => route?.pattern === pattern && route?.script === script)
    ))
    : [...contract.stagingZoneRoutes].every(([pattern, script]) => (
      liveRoutes.some((route) => route?.pattern === pattern && route?.script === script)
    ));

  const domainsInZone = liveDomains
    .map(liveWorkerDomainIdentity)
    .filter((domain) => domain !== null)
    .filter((domain) => (
      domain.zoneId === contract.zoneId
      || domain.zoneName === contract.zoneName
      || domain.hostname === contract.zoneName
      || domain.hostname.endsWith(`.${contract.zoneName}`)
    ));
  const requiredDomains = new Map([
    ...[...contract.customDomains].map((hostname) => [hostname, contract.productionWorkerName]),
    ...[...contract.stagingCustomDomains].map((hostname) => [hostname, contract.stagingWorkerName]),
  ]);
  const allowedDomains = new Map([
    ...requiredDomains,
    [contract.canaryDnsCarrier.hostname, contract.canaryDnsCarrier.service],
  ]);
  const domainKeys = new Set();
  let domainInventoryOk = liveDomains.every((domain) => {
    const identity = liveWorkerDomainIdentity(domain);
    return identity !== null && (
      identity.zoneId === contract.zoneId
      || identity.zoneName === contract.zoneName
      || identity.hostname === contract.zoneName
      || identity.hostname.endsWith(`.${contract.zoneName}`)
    );
  });
  for (const domain of domainsInZone) {
    if (
      domainKeys.has(domain.hostname)
      || !allowedDomains.has(domain.hostname)
      || allowedDomains.get(domain.hostname) !== domain.service
    ) {
      domainInventoryOk = false;
    } else {
      domainKeys.add(domain.hostname);
    }
  }
  const requiredDomainsPresent = [...requiredDomains].every(([hostname, service]) => (
    domainsInZone.some((domain) => domain.hostname === hostname && domain.service === service)
  ));

  const checks = [
    {
      code: "cloudflare_production_worker_route_inventory_allowlist",
      detail: routeInventoryOk && requiredRoutesPresent
        ? admissionMode === "exact"
          ? "Live shared-zone routes match the reviewed production and staging contracts"
          : "Live shared-zone routes are owned by the reviewed production/staging Workers"
        : "Live shared-zone routes contain a missing, duplicate, malformed, or unapproved binding",
      ok: routeInventoryOk && requiredRoutesPresent,
    },
    {
      code: "cloudflare_production_worker_domain_inventory_allowlist",
      detail: domainInventoryOk && requiredDomainsPresent
        ? "Live Worker domains match the reviewed production and staging contracts"
        : "Live Worker domains contain a missing, duplicate, malformed, or unapproved binding",
      ok: domainInventoryOk && requiredDomainsPresent,
    },
  ];
  return { checks, ok: checks.every((check) => check.ok) };
}

function productionConsumerContract(resources) {
  return [
    {
      queue: resources.integrationQueue,
      script: null,
      settings: {
        batchSize: 10,
        batchTimeout: 5,
        deadLetterQueue: resources.deadLetterQueue,
        maxRetries: 5,
        retryDelaySecs: 60,
      },
    },
    {
      queue: resources.notificationQueue,
      script: null,
      settings: {
        batchSize: 10,
        batchTimeout: 5,
        deadLetterQueue: resources.deadLetterQueue,
        maxRetries: 5,
        retryDelaySecs: 60,
      },
    },
    {
      queue: resources.deadLetterQueue,
      script: null,
      settings: {
        batchSize: 10,
        batchTimeout: 5,
        maxRetries: 100,
      },
    },
  ];
}

function criticalBindingSort(left, right) {
  return `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`);
}

function configConsumerShape(consumer, workerName) {
  const settings = {
    batchSize: consumer?.max_batch_size,
    batchTimeout: consumer?.max_batch_timeout,
    deadLetterQueue: consumer?.dead_letter_queue,
    maxConcurrency: consumer?.max_concurrency,
    maxRetries: consumer?.max_retries,
    retryDelaySecs: consumer?.retry_delay,
  };
  for (const key of Object.keys(settings)) {
    if (settings[key] === undefined) delete settings[key];
  }
  return { queue: consumer?.queue, script: workerName, settings };
}

function productionWorkerResourceContract(productionSpec, wranglerConfig, productionManifest) {
  const production = wranglerConfig?.env?.production;
  const resources = productionSpec?.resources;
  const manifestResources = productionManifest?.resources;
  const resourceKeys = [
    "d1",
    "deadLetterQueue",
    "integrationQueue",
    "notificationQueue",
    "platformCacheKv",
    "privateExports",
    "r2",
    "sessionKv",
  ];
  const resourceNamesMatch = resourceKeys.every((key) => (
    typeof resources?.[key] === "string"
    && resources[key].length > 0
    && manifestResources?.[key]?.name === resources[key]
  ));
  const expectedManifestKeys = [
    "accountId",
    "environment",
    "resources",
    "saas",
    "version",
    "workerName",
    "zoneId",
    "zoneName",
  ];
  if (
    !isDeepStrictEqual(Object.keys(productionManifest ?? {}).sort(), expectedManifestKeys.sort())
    || !isDeepStrictEqual(Object.keys(manifestResources ?? {}).sort(), resourceKeys.sort())
    || !isDeepStrictEqual(Object.keys(resources ?? {}).sort(), resourceKeys.sort())
    || productionManifest?.environment !== "production"
    || productionManifest?.accountId !== productionSpec?.accountId
    || productionManifest?.workerName !== productionSpec?.workerName
    || productionManifest?.zoneId !== productionSpec?.zoneId
    || productionManifest?.zoneName !== productionSpec?.zoneName
    || typeof productionManifest?.version !== "string"
    || productionManifest.version.length < 8
    || productionManifest.version.length > 128
    || !resourceNamesMatch
    || !d1DatabaseIdPattern.test(manifestResources?.d1?.id ?? "")
    || !kvNamespaceIdPattern.test(manifestResources?.platformCacheKv?.id ?? "")
    || !kvNamespaceIdPattern.test(manifestResources?.sessionKv?.id ?? "")
    || productionManifest?.saas?.cnameTarget !== productionSpec?.saas?.cnameTarget
    || productionManifest?.saas?.fallbackOrigin !== productionSpec?.saas?.fallbackOrigin
    || productionSpec?.routing?.externalCustomDomainFallbackRoute !== "*/*"
    || productionSpec?.turnstile?.platformHostname !== productionSpec?.zoneName
    || productionSpec?.turnstile?.externalCustomDomainAdmission !== "verified_before_domain_activation"
    || productionSpec?.turnstile?.externalCustomDomainStrategy !== "exact_hostname_admission_before_activation"
    || production?.vars?.RESOURCE_MANIFEST_VERSION !== productionManifest.version
    || typeof production?.vars?.TURNSTILE_SITE_KEY !== "string"
    || production.vars.TURNSTILE_SITE_KEY.trim() !== production.vars.TURNSTILE_SITE_KEY
    || production.vars.TURNSTILE_SITE_KEY.length < 8
    || production.vars.TURNSTILE_SITE_KEY.length > 128
  ) {
    throw new Error("production_worker_resource_contract_invalid");
  }

  const expectedBindings = [
    { id: manifestResources.d1.id, name: "PLATFORM_DB", type: "d1" },
    { id: manifestResources.platformCacheKv.id, name: "PLATFORM_CACHE", type: "kv_namespace" },
    { id: manifestResources.sessionKv.id, name: "SESSION", type: "kv_namespace" },
    { id: manifestResources.r2.name, name: "MEDIA", type: "r2_bucket" },
    { id: manifestResources.privateExports.name, name: "PRIVATE_EXPORTS", type: "r2_bucket" },
    { id: manifestResources.integrationQueue.name, name: "INTEGRATION_QUEUE", type: "queue" },
    { id: manifestResources.notificationQueue.name, name: "NOTIFICATION_QUEUE", type: "queue" },
  ].sort(criticalBindingSort);
  const configuredBindings = [
    ...(Array.isArray(production?.d1_databases) ? production.d1_databases.map((binding) => ({
      id: binding?.database_id,
      name: binding?.binding,
      type: "d1",
    })) : []),
    ...(Array.isArray(production?.kv_namespaces) ? production.kv_namespaces.map((binding) => ({
      id: binding?.id,
      name: binding?.binding,
      type: "kv_namespace",
    })) : []),
    ...(Array.isArray(production?.r2_buckets) ? production.r2_buckets.map((binding) => ({
      id: binding?.bucket_name,
      name: binding?.binding,
      type: "r2_bucket",
    })) : []),
    ...(Array.isArray(production?.queues?.producers) ? production.queues.producers.map((binding) => ({
      id: binding?.queue,
      name: binding?.binding,
      type: "queue",
    })) : []),
  ].sort(criticalBindingSort);
  const expectedConsumers = productionConsumerContract(resources)
    .map((consumer) => ({ ...consumer, script: productionSpec.workerName }));
  const configuredConsumers = Array.isArray(production?.queues?.consumers)
    ? production.queues.consumers.map((consumer) => configConsumerShape(consumer, productionSpec.workerName))
    : [];
  if (
    !isDeepStrictEqual(configuredBindings, expectedBindings)
    || !isDeepStrictEqual(configuredConsumers, expectedConsumers)
    || !isDeepStrictEqual(production?.triggers?.crons, [productionCron])
  ) {
    throw new Error("production_worker_resource_contract_invalid");
  }

  return {
    consumers: expectedConsumers,
    criticalBindings: expectedBindings,
    cron: productionCron,
    fallbackOrigin: productionSpec.saas.fallbackOrigin,
    manifestVersion: productionManifest.version,
    platformTurnstileHostname: productionSpec.turnstile.platformHostname,
    turnstileSiteKey: production.vars.TURNSTILE_SITE_KEY,
  };
}

async function loadProductionManifest(input) {
  if (input.productionManifest !== undefined) return input.productionManifest;
  try {
    return await readFile(
      resolve(input.repositoryRoot ?? repositoryRoot, "infra/generated/production.json"),
      "utf8",
    ).then((text) => parseJson(text, "generated_production"));
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_json_from_generated_production") throw error;
    throw new Error("production_worker_resource_manifest_unavailable", { cause: error });
  }
}

function normalizeLiveCriticalBindings(value) {
  const rawBindings = Array.isArray(value)
    ? value
    : value?.bindings ?? value?.settings?.bindings;
  if (!Array.isArray(rawBindings)) {
    throw new Error("production_worker_binding_inventory_invalid");
  }
  const criticalTypes = new Set(["d1", "kv_namespace", "r2_bucket", "queue"]);
  const bindings = [];
  for (const binding of rawBindings) {
    if (!criticalTypes.has(binding?.type)) continue;
    const id = binding.type === "d1"
      ? binding.id ?? binding.database_id
      : binding.type === "kv_namespace"
        ? binding.namespace_id ?? binding.id
        : binding.type === "r2_bucket"
          ? binding.bucket_name
          : binding.queue_name ?? binding.queue;
    if (typeof binding?.name !== "string" || typeof id !== "string") {
      throw new Error("production_worker_binding_inventory_invalid");
    }
    bindings.push({ id, name: binding.name, type: binding.type });
  }
  const keys = bindings.map((binding) => `${binding.type}:${binding.name}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("production_worker_binding_inventory_invalid");
  }
  return bindings.sort(criticalBindingSort);
}

function normalizedSetting(value, aliases) {
  for (const alias of aliases) {
    if (value?.[alias] !== undefined) return value[alias];
  }
  return undefined;
}

function normalizeLiveConsumer(raw) {
  if (raw === null || typeof raw !== "object") {
    throw new Error("production_worker_queue_consumer_inventory_invalid");
  }
  const settingsSource = raw.settings ?? raw;
  const script = normalizedSetting(raw, ["script", "script_name", "scriptName", "worker", "worker_name"]);
  const settings = {
    batchSize: normalizedSetting(settingsSource, ["batchSize", "batch_size"]),
    batchTimeout: normalizedSetting(settingsSource, ["batchTimeout", "batch_timeout"]),
    deadLetterQueue: normalizedSetting(settingsSource, ["deadLetterQueue", "dead_letter_queue"]),
    maxConcurrency: normalizedSetting(settingsSource, ["maxConcurrency", "max_concurrency"]),
    maxRetries: normalizedSetting(settingsSource, ["maxRetries", "max_retries", "messageRetries"]),
    retryDelaySecs: normalizedSetting(settingsSource, ["retryDelaySecs", "retry_delay_secs", "retry_delay"]),
  };
  for (const key of Object.keys(settings)) {
    if (settings[key] === undefined) delete settings[key];
  }
  if (typeof script !== "string" || Object.entries(settings).some(([key, setting]) => (
    key === "deadLetterQueue"
      ? typeof setting !== "string"
      : !Number.isInteger(setting) || setting < 1
  ))) {
    throw new Error("production_worker_queue_consumer_inventory_invalid");
  }
  return { script, settings };
}

function parseLiveQueueConsumers(output, expected, admissionMode = "exact") {
  let parsed;
  try {
    parsed = JSON.parse(String(output ?? ""));
  } catch {
    throw new Error("production_worker_queue_consumer_inventory_invalid");
  }
  const consumers = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.consumers)
      ? parsed.consumers
      : parsed?.result;
  if (!Array.isArray(consumers)) {
    throw new Error("production_worker_queue_consumer_inventory_invalid");
  }
  const normalized = consumers.map(normalizeLiveConsumer);
  const expectedShape = [{ script: expected.script, settings: expected.settings }];
  const accepted = admissionMode === "pre_candidate"
    ? (normalized.length === 0 || isDeepStrictEqual(normalized, expectedShape))
    : isDeepStrictEqual(normalized, expectedShape);
  if (!accepted) {
    throw new Error("production_worker_queue_consumer_inventory_mismatch");
  }
  return { consumers: normalized, queue: expected.queue };
}

function normalizeLiveSchedules(value) {
  const schedules = Array.isArray(value) ? value : value?.schedules;
  if (!Array.isArray(schedules)) {
    throw new Error("production_worker_schedule_inventory_invalid");
  }
  const crons = schedules.map((schedule) => typeof schedule === "string" ? schedule : schedule?.cron);
  if (crons.some((cron) => typeof cron !== "string") || new Set(crons).size !== crons.length) {
    throw new Error("production_worker_schedule_inventory_invalid");
  }
  return crons.sort();
}

function parseProductionCustomDomainRows(output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output ?? ""));
  } catch {
    throw new Error("production_custom_domain_mapping_inventory_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length === 0
    || parsed.some((entry) => entry?.success !== true || !Array.isArray(entry?.results))) {
    throw new Error("production_custom_domain_mapping_inventory_invalid");
  }
  return parsed.flatMap((entry) => entry.results);
}

async function discoverProductionCustomHostnames(input) {
  const inventory = [];
  for (let page = 1; page <= 100; page += 1) {
    const envelope = await cloudflareApiRequest(
      input.token,
      `/zones/${input.zoneId}/custom_hostnames?page=${page}&per_page=100`,
      { fetchImplementation: input.fetchImplementation, includeEnvelope: true },
    );
    if (!Array.isArray(envelope?.result)) {
      throw new Error("production_saas_custom_hostname_inventory_invalid");
    }
    inventory.push(...envelope.result);
    const resultInfo = envelope.resultInfo;
    if (resultInfo === null) {
      if (envelope.result.length >= 100) {
        throw new Error("production_saas_custom_hostname_pagination_unverifiable");
      }
      return inventory;
    }
    const currentPage = resultInfo?.page;
    const totalPages = resultInfo?.total_pages;
    if (!Number.isInteger(currentPage) || !Number.isInteger(totalPages)
      || currentPage !== page || totalPages < page || totalPages > 100) {
      throw new Error("production_saas_custom_hostname_pagination_invalid");
    }
    if (page === totalPages) return inventory;
  }
  throw new Error("production_saas_custom_hostname_pagination_invalid");
}

function normalizeCustomHostname(hostname) {
  if (hostname === null || typeof hostname !== "object"
    || typeof hostname.id !== "string" || hostname.id.length === 0
    || typeof hostname.hostname !== "string" || hostname.hostname.length === 0
    || typeof hostname.status !== "string"
    || typeof hostname.ssl?.status !== "string") {
    throw new Error("production_saas_custom_hostname_inventory_invalid");
  }
  return {
    hostname: hostname.hostname.toLowerCase().replace(/\.$/u, ""),
    id: hostname.id,
    sslStatus: hostname.ssl.status,
    status: hostname.status,
  };
}

function normalizeCustomDomainRow(row) {
  if (row === null || typeof row !== "object"
    || typeof row.shop_id !== "string" || row.shop_id.length === 0
    || typeof row.hostname_normalized !== "string" || row.hostname_normalized.length === 0
    || typeof row.status !== "string"
    || !new Set([0, 1]).has(row.is_primary)
    || (row.cloudflare_hostname_id !== null && typeof row.cloudflare_hostname_id !== "string")) {
    throw new Error("production_custom_domain_mapping_inventory_invalid");
  }
  let metadata;
  try {
    metadata = JSON.parse(row.validation_metadata_json);
  } catch {
    throw new Error("production_custom_domain_mapping_inventory_invalid");
  }
  return {
    active: row.status === "active" || row.is_primary === 1,
    cloudflareHostnameId: row.cloudflare_hostname_id,
    deleteRequestedAt: row.delete_requested_at,
    deletedAt: row.deleted_at,
    dnsStatus: row.dns_status,
    hostname: row.hostname_normalized.toLowerCase().replace(/\.$/u, ""),
    hostnameStatus: row.hostname_status,
    ownershipVerifiedAt: row.ownership_verified_at,
    shopId: row.shop_id,
    sslStatus: row.ssl_status,
    status: row.status,
    turnstile: metadata?.turnstile,
  };
}

export function validateProductionLiveInfrastructure(input) {
  const admissionMode = input?.admissionMode ?? "exact";
  if (!new Set(["exact", "pre_candidate"]).has(admissionMode)) {
    throw new Error("production_worker_infrastructure_admission_mode_invalid");
  }
  if (!Array.isArray(input?.customHostnames)) {
    throw new Error("production_saas_custom_hostname_inventory_invalid");
  }
  if (!Array.isArray(input?.customDomainRows)) {
    throw new Error("production_custom_domain_mapping_inventory_invalid");
  }
  if (!Array.isArray(input?.queueConsumers)) {
    throw new Error("production_worker_queue_consumer_inventory_invalid");
  }
  if (input?.contract === null || typeof input?.contract !== "object") {
    throw new Error("production_worker_resource_contract_invalid");
  }
  const bindings = normalizeLiveCriticalBindings(input.workerSettings);
  const schedules = normalizeLiveSchedules(input.schedules);
  const hostnames = input.customHostnames.map(normalizeCustomHostname);
  const domainRows = input.customDomainRows.map(normalizeCustomDomainRow);
  const hostnameKeys = hostnames.map((entry) => entry.hostname);
  const hostnameIds = hostnames.map((entry) => entry.id);
  const domainKeys = domainRows.map((entry) => entry.hostname);
  const domainIds = domainRows
    .map((entry) => entry.cloudflareHostnameId)
    .filter((entry) => entry !== null);
  const uniqueInventory = new Set(hostnameKeys).size === hostnameKeys.length
    && new Set(hostnameIds).size === hostnameIds.length
    && new Set(domainKeys).size === domainKeys.length
    && new Set(domainIds).size === domainIds.length;
  const hostnamesById = new Map(hostnames.map((entry) => [entry.id, entry]));
  const domainsByName = new Map(domainRows.map((entry) => [entry.hostname, entry]));
  const liveMappingsComplete = uniqueInventory && hostnames.every((hostname) => {
    const domain = domainsByName.get(hostname.hostname);
    return domain?.cloudflareHostnameId === hostname.id;
  });
  const databaseMappingsComplete = uniqueInventory && domainRows.every((domain) => (
    domain.cloudflareHostnameId === null
      || (hostnamesById.get(domain.cloudflareHostnameId)?.hostname === domain.hostname)
  ));
  const activeDomains = domainRows.filter((domain) => domain.active);
  const nowMs = input.now instanceof Date
    ? input.now.getTime()
    : input.now === undefined
      ? Date.now()
      : Date.parse(input.now);
  if (!Number.isFinite(nowMs)) throw new Error("production_custom_domain_mapping_inventory_invalid");
  const activeDomainsReady = activeDomains.every((domain) => {
    const hostname = domain.cloudflareHostnameId === null
      ? null
      : hostnamesById.get(domain.cloudflareHostnameId);
    const checkedAtMs = Date.parse(domain.turnstile?.checkedAt ?? "");
    return domain.status === "active"
      && domain.ownershipVerifiedAt !== null
      && domain.hostnameStatus === "active"
      && domain.sslStatus === "active"
      && domain.dnsStatus === "active"
      && domain.deleteRequestedAt === null
      && domain.deletedAt === null
      && hostname?.hostname === domain.hostname
      && hostname.status === "active"
      && hostname.sslStatus === "active"
      && domain.turnstile?.status === "active"
      && domain.turnstile?.hostname === domain.hostname
      && domain.turnstile?.mode === "operator_managed"
      && domain.turnstile?.source === "cloudflare_widget_domains"
      && Number.isFinite(checkedAtMs)
      && checkedAtMs <= nowMs
      && nowMs - checkedAtMs <= 12 * 60 * 60_000;
  });
  const widgetDomains = input.turnstileWidget?.domains;
  const normalizedWidgetDomains = Array.isArray(widgetDomains)
    ? widgetDomains.map((hostname) => typeof hostname === "string"
      ? hostname.toLowerCase().replace(/\.$/u, "")
      : null)
    : [];
  const expectedWidgetDomains = [
    input.contract.platformTurnstileHostname,
    ...activeDomains.map((domain) => domain.hostname),
  ].sort();
  const widgetAllowlistExact = input.turnstileWidget?.sitekey === input.contract.turnstileSiteKey
    && normalizedWidgetDomains.every((hostname) => hostname !== null && !hostname.includes("*"))
    && new Set(normalizedWidgetDomains).size === normalizedWidgetDomains.length
    && isDeepStrictEqual([...normalizedWidgetDomains].sort(), expectedWidgetDomains);
  const fallbackExact = input.fallbackOrigin?.origin === input.contract.fallbackOrigin
    && input.fallbackOrigin?.status === "active";
  const expectedQueueNames = input.contract.consumers.map((consumer) => consumer.queue);
  const queueEntriesValid = Array.isArray(input.queueConsumers)
    && admissionMode === "pre_candidate"
    && input.queueConsumers.length === 0
    ? true
    : Array.isArray(input.queueConsumers)
      && new Set(input.queueConsumers.map((entry) => entry?.queue)).size === input.queueConsumers.length
      && input.queueConsumers.length === expectedQueueNames.length
      && input.queueConsumers.every((entry) => expectedQueueNames.includes(entry?.queue))
      && input.contract.consumers.every((consumer) => {
        const actual = input.queueConsumers.find((entry) => entry?.queue === consumer.queue);
        if (actual === undefined) return false;
        const consumers = Array.isArray(actual.consumers) ? actual.consumers : [];
        return admissionMode === "pre_candidate"
          ? (consumers.length === 0 || isDeepStrictEqual(consumers, [{ script: consumer.script, settings: consumer.settings }]))
          : isDeepStrictEqual(consumers, [{ script: consumer.script, settings: consumer.settings }]);
      });
  const queueInventoryExact = queueEntriesValid;
  const scheduleInventoryExact = admissionMode === "pre_candidate"
    ? (schedules.length === 0 || isDeepStrictEqual(schedules, [input.contract.cron]))
    : isDeepStrictEqual(schedules, [input.contract.cron]);
  const checks = [
    {
      code: "cloudflare_production_worker_binding_inventory_allowlist",
      detail: isDeepStrictEqual(bindings, input.contract.criticalBindings)
        ? "Live critical Worker bindings match the generated production identity"
        : "Live critical Worker bindings are missing, duplicated, extra, or drifted",
      ok: isDeepStrictEqual(bindings, input.contract.criticalBindings),
    },
    {
      code: "cloudflare_production_queue_consumer_inventory_allowlist",
      detail: queueInventoryExact
        ? admissionMode === "exact"
          ? "Live queue consumers and settings match the production contract"
          : "Live queue consumer inventory is empty or exactly production-shaped"
        : "Live queue consumers or settings are missing, extra, or drifted",
      ok: queueInventoryExact,
    },
    {
      code: "cloudflare_production_schedule_inventory_allowlist",
      detail: scheduleInventoryExact
        ? admissionMode === "exact"
          ? "Live cron schedule matches the production contract"
          : "Live cron inventory is empty or exactly the production schedule"
        : "Live cron schedule is missing, duplicated, extra, or drifted",
      ok: scheduleInventoryExact,
    },
    {
      code: "cloudflare_production_saas_fallback_origin",
      detail: fallbackExact
        ? "The production SaaS fallback origin is active and exact"
        : "The production SaaS fallback origin is missing, inactive, or drifted",
      ok: fallbackExact,
    },
    {
      code: "cloudflare_production_saas_hostname_mapping",
      detail: liveMappingsComplete && databaseMappingsComplete
        ? "Every live SaaS hostname maps uniquely to the authoritative tenant domain row"
        : "The live SaaS and tenant-domain inventories contain an unknown, duplicate, or mismatched mapping",
      ok: liveMappingsComplete && databaseMappingsComplete,
    },
    {
      code: "cloudflare_production_saas_active_domain_readiness",
      detail: activeDomainsReady
        ? "Every active tenant domain has live hostname, SSL, DNS, ownership, and Turnstile readiness"
        : "An active tenant domain is missing live provider or application readiness",
      ok: activeDomainsReady,
    },
    {
      code: "cloudflare_production_turnstile_hostname_allowlist",
      detail: widgetAllowlistExact
        ? "The Turnstile widget contains exactly the reviewed production hostnames"
        : "The Turnstile widget hostname allowlist is missing, extra, wildcarded, or drifted",
      ok: widgetAllowlistExact,
    },
  ];
  return { checks, ok: checks.every((check) => check.ok) };
}

export async function assertProductionWorkerIdentityAdmission(input) {
  const operatorEnvironment = input.environment ?? process.env;
  const routeAuditToken = input.token === undefined
    ? requireCloudflareRouteAuditToken(operatorEnvironment)
    : requireCloudflareRouteAuditToken({ CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: input.token });
  const promotionAuditToken = input.promotionAuditToken === undefined
    ? requireCloudflareProductionPromotionAuditToken(operatorEnvironment)
    : requireCloudflareProductionPromotionAuditToken({
      [CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_TOKEN_NAME]: input.promotionAuditToken,
    });
  const productionManifest = await loadProductionManifest(input);
  const contract = productionWorkerRouteContract(
    input.productionSpec,
    input.stagingSpec,
    input.wranglerConfig,
  );
  const resourceContract = productionWorkerResourceContract(
    input.productionSpec,
    input.wranglerConfig,
    productionManifest,
  );
  const pinnedEnvironment = buildPinnedCloudflareEnvironment(
    operatorEnvironment,
    input.productionSpec.accountId,
  );
  const promotionEnvironment = {
    ...pinnedEnvironment,
    CLOUDFLARE_API_TOKEN: promotionAuditToken,
  };
  const runner = input.runWranglerImplementation ?? runWrangler;
  const runnerOptions = {
    cwd: input.repositoryRoot ?? repositoryRoot,
    env: pinnedEnvironment,
  };
  let whoamiOutput;
  try {
    whoamiOutput = runner(["whoami", "--json"], runnerOptions).stdout;
  } catch {
    throw new Error("production_worker_account_identity_unavailable");
  }
  if (!accountIdentityMatches(whoamiOutput, input.productionSpec.accountId)) {
    throw new Error("production_worker_account_identity_mismatch");
  }

  let d1ListOutput;
  try {
    d1ListOutput = runner(["d1", "list", "--env", "production", "--json"], runnerOptions).stdout;
  } catch {
    throw new Error("production_worker_database_identity_unavailable");
  }
  assertProductionWorkerDatabaseIdentity(
    d1ListOutput,
    contract.databaseId,
    contract.databaseName,
  );

  const infrastructureAdmissionMode = input.infrastructureAdmissionMode ?? "exact";
  if (!new Set(["exact", "pre_candidate"]).has(infrastructureAdmissionMode)) {
    throw new Error("production_worker_infrastructure_admission_mode_invalid");
  }
  const queueConsumers = resourceContract.consumers.map((consumer) => {
    let output;
    try {
      output = runner([
        "queues", "consumer", "list", consumer.queue, "--env", "production", "--json",
      ], {
        cwd: input.repositoryRoot ?? repositoryRoot,
        env: promotionEnvironment,
      }).stdout;
    } catch {
      throw new Error("production_worker_queue_consumer_inventory_unavailable");
    }
    return parseLiveQueueConsumers(output, consumer, infrastructureAdmissionMode);
  });
  let customDomainRows;
  try {
    const output = runner([
      "d1", "execute", "PLATFORM_DB", "--env", "production", "--remote",
      "--command", productionCustomDomainInventorySql, "--json",
    ], runnerOptions).stdout;
    customDomainRows = parseProductionCustomDomainRows(output);
  } catch (error) {
    if (error instanceof Error && error.message === "production_custom_domain_mapping_inventory_invalid") {
      throw error;
    }
    throw new Error("production_custom_domain_mapping_inventory_unavailable", { cause: error });
  }

  const workerPath = `/accounts/${input.productionSpec.accountId}/workers/scripts/${encodeURIComponent(contract.productionWorkerName)}`;
  const [
    liveRoutes,
    liveDomains,
    workerSettings,
    schedules,
    customHostnames,
    fallbackOrigin,
    turnstileWidget,
    deploymentsResult,
    deployableVersionsResult,
  ] = await Promise.all([
    cloudflareApiRequest(routeAuditToken, `/zones/${contract.zoneId}/workers/routes`, {
      fetchImplementation: input.fetchImplementation,
    }),
    cloudflareApiRequest(routeAuditToken, `/accounts/${input.productionSpec.accountId}/workers/domains`, {
      fetchImplementation: input.fetchImplementation,
    }),
    cloudflareApiRequest(promotionAuditToken, `${workerPath}/settings`, {
      fetchImplementation: input.fetchImplementation,
    }),
    cloudflareApiRequest(promotionAuditToken, `${workerPath}/schedules`, {
      fetchImplementation: input.fetchImplementation,
    }),
    discoverProductionCustomHostnames({
      fetchImplementation: input.fetchImplementation,
      token: promotionAuditToken,
      zoneId: contract.zoneId,
    }),
    cloudflareApiRequest(
      promotionAuditToken,
      `/zones/${contract.zoneId}/custom_hostnames/fallback_origin`,
      { fetchImplementation: input.fetchImplementation },
    ),
    cloudflareApiRequest(
      promotionAuditToken,
      `/accounts/${input.productionSpec.accountId}/challenges/widgets/${encodeURIComponent(resourceContract.turnstileSiteKey)}`,
      { fetchImplementation: input.fetchImplementation },
    ),
    input.requireCurrentWorkerVersion === true
      ? cloudflareApiRequest(
        promotionAuditToken,
        `${workerPath}/deployments`,
        { fetchImplementation: input.fetchImplementation },
      )
      : Promise.resolve(null),
    input.requireCurrentWorkerVersion === true
      ? cloudflareApiRequest(
        promotionAuditToken,
        `${workerPath}/versions?deployable=true`,
        { fetchImplementation: input.fetchImplementation },
      )
      : Promise.resolve(null),
  ]);
  const routeAudit = validateProductionWorkerRouteInventory(
    input.productionSpec,
    input.stagingSpec,
    input.wranglerConfig,
    liveRoutes,
    liveDomains,
    { admissionMode: infrastructureAdmissionMode },
  );
  const liveAudit = validateProductionLiveInfrastructure({
    contract: resourceContract,
    customDomainRows,
    customHostnames,
    fallbackOrigin,
    queueConsumers,
    schedules,
    turnstileWidget,
    workerSettings,
    now: input.now,
    admissionMode: infrastructureAdmissionMode,
  });
  const audit = {
    checks: [...routeAudit.checks, ...liveAudit.checks],
    ok: routeAudit.ok && liveAudit.ok,
  };
  if (!audit.ok) {
    const failedChecks = audit.checks
      .filter((check) => !check.ok)
      .map((check) => check.code)
      .join(",");
    throw new Error(`cloudflare_production_worker_identity_invalid:${failedChecks}`);
  }
  const currentWorkerVersion = input.requireCurrentWorkerVersion === true
    ? parseProductionWorkerDeploymentVersion(deploymentsResult)
    : undefined;
  if (input.expectedCurrentWorkerVersion !== undefined
    && currentWorkerVersion !== input.expectedCurrentWorkerVersion) {
    throw new Error("production_worker_active_version_mismatch");
  }
  return {
    accountId: input.productionSpec.accountId,
    checks: audit.checks,
    ...(input.requireCurrentWorkerVersion === true
      ? {
        currentWorkerVersion,
        deployableWorkerVersionIds: parseProductionWorkerDeployableVersions(deployableVersionsResult),
        deployableWorkerVersionInventory: parseProductionWorkerDeployableVersionInventory(deployableVersionsResult),
      }
      : {}),
    databaseId: contract.databaseId,
    databaseName: contract.databaseName,
    ok: true,
    workerName: contract.productionWorkerName,
    zoneId: contract.zoneId,
    zoneName: contract.zoneName,
  };
}

export async function inspectStagingRoutePreflight(input = {}) {
  const spec = input.spec ?? await loadEnvironment("staging");
  if (spec.environment !== "staging") {
    throw new Error("staging_route_preflight_environment_invalid");
  }

  const operatorEnvironment = input.environment ?? process.env;
  const token = input.token === undefined
    ? requireCloudflareRouteAuditToken(operatorEnvironment)
    : requireCloudflareRouteAuditToken({ CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: input.token });
  const runtimeIdentity = await (input.runtimeIdentityImplementation ?? loadStagingRuntimeIdentity)(spec);
  const runner = input.runWranglerImplementation ?? runWrangler;
  const pinnedEnvironment = buildPinnedCloudflareEnvironment(
    operatorEnvironment,
    spec.accountId,
  );
  const runnerOptions = { cwd: repositoryRoot, env: pinnedEnvironment };
  const checks = [{
    code: "staging_runtime_identity",
    detail: `Checked-in ${spec.workerName} route and ${runtimeIdentity.databaseName} D1 targets align for ${spec.zoneName}`,
    ok: true,
  }];

  let whoamiOutput;
  try {
    whoamiOutput = runner(["whoami", "--json"], runnerOptions).stdout;
  } catch {
    throw new Error("staging_account_identity_unavailable");
  }
  // Wrangler can omit account inventory for scoped user tokens. The pinned D1
  // list immediately below remains the authoritative account/resource check.
  if (!accountIdentityMatches(whoamiOutput, spec.accountId)) {
    throw new Error("staging_account_identity_mismatch");
  }
  checks.push({
    code: "staging_account_identity",
    detail: "Authenticated Wrangler account matches the checked-in staging account",
    ok: true,
  });

  let d1ListOutput;
  try {
    d1ListOutput = runner(["d1", "list", "--env", "staging", "--json"], runnerOptions).stdout;
  } catch {
    throw new Error("staging_database_identity_unavailable");
  }
  assertStagingDatabaseIdentity(
    d1ListOutput,
    runtimeIdentity.databaseId,
    runtimeIdentity.databaseName,
  );
  checks.push({
    code: "staging_database_identity",
    detail: "Live staging D1 name and UUID match the checked-in runtime manifest",
    ok: true,
  });

  const audit = await auditStagingRouteInventory(
    spec,
    token,
    input.fetchImplementation,
  );
  checks.push(...audit.checks);
  return {
    accountId: spec.accountId,
    checks,
    databaseId: runtimeIdentity.databaseId,
    databaseName: runtimeIdentity.databaseName,
    environment: "staging",
    observedAt: new Date().toISOString(),
    ok: checks.every((check) => check.ok),
    workerName: spec.workerName,
    zoneId: spec.zoneId,
    zoneName: spec.zoneName,
  };
}

export async function assertStagingMutationAdmission(input = {}) {
  const spec = input.spec ?? await loadEnvironment("staging");
  if (spec.environment !== "staging") {
    throw new Error("staging_route_admission_environment_invalid");
  }
  const operatorEnvironment = input.environment ?? process.env;
  const token = input.token === undefined
    ? requireCloudflareRouteAuditToken(operatorEnvironment)
    : requireCloudflareRouteAuditToken({ CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: input.token });
  const platformToken = input.platformToken === undefined
    ? requireCloudflarePlatformToken(operatorEnvironment)
    : requireCloudflarePlatformToken({ CLOUDFLARE_PLATFORM_API_TOKEN: input.platformToken });
  const doctorImplementation = input.doctorImplementation ?? doctor;
  let doctorResult;
  try {
    doctorResult = await doctorImplementation("staging", {
      environment: {
        ...operatorEnvironment,
        CLOUDFLARE_PLATFORM_API_TOKEN: platformToken,
        CLOUDFLARE_ROUTE_AUDIT_API_TOKEN: token,
      },
      fetchImplementation: input.fetchImplementation,
      runWranglerImplementation: input.runWranglerImplementation,
      spec,
    });
  } catch {
    throw new Error("staging_platform_doctor_unavailable");
  }
  if (doctorResult?.ok !== true) {
    const failedChecks = Array.isArray(doctorResult?.checks)
      ? doctorResult.checks.filter((check) => check?.ok !== true).map((check) => check.code).join(",")
      : "unknown";
    throw new Error(`staging_platform_doctor_failed:${failedChecks || "unknown"}`);
  }
  const preflight = await inspectStagingRoutePreflight({
    environment: operatorEnvironment,
    fetchImplementation: input.fetchImplementation,
    runWranglerImplementation: input.runWranglerImplementation,
    runtimeIdentityImplementation: input.runtimeIdentityImplementation,
    spec,
    token,
  });
  if (!preflight.ok) {
    const failedChecks = preflight.checks
      .filter((check) => !check.ok)
      .map((check) => check.code)
      .join(",");
    throw new Error(`cloudflare_staging_route_inventory_invalid:${failedChecks}`);
  }
  return preflight;
}

export async function assertStagingDeployAdmission(input = {}) {
  return assertStagingMutationAdmission(input);
}

export function buildQueueBindings(resources, maxRetries) {
  return {
    producers: [
      { binding: "INTEGRATION_QUEUE", queue: resources.integrationQueue },
      { binding: "NOTIFICATION_QUEUE", queue: resources.notificationQueue },
    ],
    consumers: [
      {
        dead_letter_queue: resources.deadLetterQueue,
        max_batch_size: 10,
        max_batch_timeout: 5,
        max_retries: maxRetries,
        queue: resources.integrationQueue,
        retry_delay: 60,
      },
      {
        dead_letter_queue: resources.deadLetterQueue,
        max_batch_size: 10,
        max_batch_timeout: 5,
        max_retries: maxRetries,
        queue: resources.notificationQueue,
        retry_delay: 60,
      },
      {
        max_batch_size: 10,
        max_batch_timeout: 5,
        max_retries: 100,
        queue: resources.deadLetterQueue,
      },
    ],
  };
}

async function writeGeneratedConfig(spec, manifest) {
  const configPath = resolve(repositoryRoot, "wrangler.jsonc");
  const config = parseJson(await readFile(configPath, "utf8"), "wrangler_config");
  const resources = manifest.resources;
  const existingStagingVars = config.env?.staging?.vars ?? {};

  config.env ??= {};
  config.env.staging = {
    name: spec.workerName,
    workers_dev: true,
    routes: buildStagingRoutes(spec),
    assets: {
      binding: "ASSETS",
      directory: "./dist",
    },
    send_email: [
      {
        name: "EMAIL",
        remote: true,
        allowed_sender_addresses: [`no-reply@${spec.zoneName}`],
      },
    ],
    d1_databases: [
      {
        binding: "PLATFORM_DB",
        database_id: resources.d1.id,
        database_name: resources.d1.name,
        migrations_dir: "./migrations",
      },
    ],
    r2_buckets: [
      { binding: "MEDIA", bucket_name: resources.r2.name },
      { binding: "PRIVATE_EXPORTS", bucket_name: resources.privateExports.name },
    ],
    kv_namespaces: [
      { binding: "PLATFORM_CACHE", id: resources.platformCacheKv.id },
      { binding: "SESSION", id: resources.sessionKv.id },
    ],
    queues: buildQueueBindings({
      deadLetterQueue: resources.deadLetterQueue.name,
      integrationQueue: resources.integrationQueue.name,
      notificationQueue: resources.notificationQueue.name,
    }, 5),
    triggers: { crons: [spec.cron] },
    observability: { enabled: true, head_sampling_rate: 1 },
    vars: { ...existingStagingVars, ...buildStagingVars(spec, manifest) },
  };

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  const manifestPath = resolve(repositoryRoot, `infra/generated/${spec.environment}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function provision(environment, dryRun, input = {}) {
  if (environment !== "staging") {
    throw new Error(`provision_not_allowed_for_environment:${environment}`);
  }

  const spec = await loadEnvironment(environment);
  const operatorEnvironment = input.environment ?? process.env;
  const cloudflareApiToken = input.platformToken === undefined
    ? requireCloudflarePlatformToken(operatorEnvironment)
    : requireCloudflarePlatformToken({ CLOUDFLARE_PLATFORM_API_TOKEN: input.platformToken });
  for (const resource of desiredResources(spec)) {
    assertOwnedName(resource.name);
  }

  const runner = input.runWranglerImplementation ?? runWrangler;
  const pinnedEnvironment = buildPinnedCloudflareEnvironment(operatorEnvironment, spec.accountId);
  const runnerOptions = { cwd: repositoryRoot, env: pinnedEnvironment };
  let whoamiOutput;
  try {
    whoamiOutput = runner(["whoami", "--json"], runnerOptions).stdout;
  } catch {
    throw new Error("staging_provision_account_identity_unavailable");
  }
  if (!accountIdentityMatches(whoamiOutput, spec.accountId)) {
    throw new Error("staging_account_identity_mismatch");
  }

  let remote = await discoverRemoteResources({
    environment: pinnedEnvironment,
    runWranglerImplementation: runner,
  });
  let state = findResourceState(spec, remote);
  let saasState = await discoverSaasState(spec, cloudflareApiToken, input.fetchImplementation);
  const actions = desiredResources(spec).map((resource) => ({
    action: state[resource.key] ? "reuse" : "create",
    name: resource.name,
    type: resource.type,
  })).concat(planSaasConfiguration(spec, saasState).map((action) => ({
    action: action.action,
    name: action.name,
    type: action.kind,
  })));

  const conflict = actions.find((action) => action.action === "conflict");
  if (conflict) {
    throw new Error(`cloudflare_dns_conflict:${conflict.name}`);
  }

  if (!dryRun) {
    for (const resource of desiredResources(spec)) {
      if (!state[resource.key]) {
        createRemoteResource(resource, {
          environment: pinnedEnvironment,
          runWranglerImplementation: runner,
        });
      }
    }
    await applySaasConfiguration(spec, saasState, cloudflareApiToken, input.fetchImplementation);
    remote = await discoverRemoteResources({
      environment: pinnedEnvironment,
      runWranglerImplementation: runner,
    });
    state = findResourceState(spec, remote);
    saasState = await discoverSaasState(spec, cloudflareApiToken, input.fetchImplementation);
    const unresolvedDns = planSaasConfiguration(spec, saasState)
      .find((action) => action.kind === "dns" && action.action !== "reuse");
    if (unresolvedDns) {
      throw new Error(`cloudflare_dns_reconciliation_failed:${unresolvedDns.name}`);
    }
    const manifest = buildManifest(spec, state);
    await (input.writeGeneratedConfigImplementation ?? writeGeneratedConfig)(spec, manifest);
    return { actions, environment, manifest, ok: true };
  }

  return { actions, environment, ok: true };
}

export async function doctor(environment, input = {}) {
  const checks = [];
  const operatorEnvironment = input.environment ?? process.env;
  const runner = input.runWranglerImplementation ?? runWrangler;
  const spec = environment !== "local"
    ? input.spec ?? await loadEnvironment(environment)
    : null;
  const accountId = input.accountId ?? spec?.accountId ?? "00000000000000000000000000000000";
  const d1Environment = buildPinnedCloudflareEnvironment(
    operatorEnvironment,
    accountId,
  );
  let cloudflareApiToken = null;
  try {
    cloudflareApiToken = requireCloudflarePlatformToken(operatorEnvironment);
  } catch {
    // The check below keeps the missing operator context visible.
  }
  const wranglerEnvironment = cloudflareApiToken === null
    ? d1Environment
    : buildPinnedCloudflareEnvironment({
        ...operatorEnvironment,
        CLOUDFLARE_D1_API_TOKEN: cloudflareApiToken,
      }, accountId);
  const runnerOptions = { cwd: repositoryRoot, env: wranglerEnvironment };
  const nodeVersion = process.versions.node;
  checks.push({ code: "node_version", detail: `Node ${nodeVersion}`, ok: Number(nodeVersion.split(".")[0]) >= 22 });

  for (const fileName of ["wrangler.jsonc", ".dev.vars.example", "astro.config.ts", "migrations/0001_platform_foundation.sql"]) {
    try {
      await readFile(resolve(repositoryRoot, fileName), "utf8");
      checks.push({ code: `file_${fileName}`, detail: `${fileName} present`, ok: true });
    } catch {
      checks.push({ code: `file_${fileName}`, detail: `${fileName} missing`, ok: false });
    }
  }

  if (environment !== "local") {
    if (spec === null) throw new Error("doctor_environment_spec_missing");
    const whoami = runner(["whoami", "--json"], runnerOptions).stdout;
    const accountMatches = accountIdentityMatches(whoami, spec.accountId);
    checks.push({
      code: "cloudflare_account",
      detail: accountMatches ? "Authenticated account matches environment" : "Authenticated account mismatch",
      ok: accountMatches,
    });
    const remote = await discoverRemoteResources({
      environment: wranglerEnvironment,
      runWranglerImplementation: runner,
    });
    const state = findResourceState(spec, remote);
    for (const resource of desiredResources(spec)) {
      checks.push({
        code: `resource_${resource.key}`,
        detail: state[resource.key] ? `${resource.name} ready` : `${resource.name} missing`,
        ok: Boolean(state[resource.key]),
      });
    }

    const secretNames = parseSecretNames(
      runner(["secret", "list", "--env", environment], runnerOptions).stdout,
    );
    checks.push({
      code: "worker_secret_CLOUDFLARE_API_TOKEN",
      detail: secretNames.includes("CLOUDFLARE_API_TOKEN")
        ? "Custom-hostname API token binding is present"
        : "Set CLOUDFLARE_API_TOKEN as a Worker secret",
      ok: secretNames.includes("CLOUDFLARE_API_TOKEN"),
    });

    if (cloudflareApiToken !== null) {
      checks.push({
        code: "cloudflare_platform_api_token_context",
        detail: "Operator platform token is available for scoped SaaS checks",
        ok: true,
      });
    } else {
      checks.push({
        code: "cloudflare_platform_api_token_context",
        detail: "Export CLOUDFLARE_PLATFORM_API_TOKEN temporarily to run SaaS checks",
        ok: false,
      });
    }

    if (cloudflareApiToken !== null) {
      try {
        const saasState = await discoverSaasState(
          spec,
          cloudflareApiToken,
          input.fetchImplementation ?? globalThis.fetch,
        );
        const saasPlan = planSaasConfiguration(spec, saasState);
        for (const record of spec.saas.dnsRecords) {
          const action = saasPlan.find(
            (candidate) => candidate.kind === "dns" && candidate.key === record.key,
          );
          checks.push({
            code: `cloudflare_saas_dns_${record.key}`,
            detail: action?.action === "reuse"
              ? `${record.name} is proxied and matches the SaaS contract`
              : `${record.name} requires ${action?.action ?? "reconciliation"}`,
            ok: action?.action === "reuse",
          });
        }

        const fallbackAction = saasPlan.find(
          (candidate) => candidate.kind === "fallback_origin",
        );
        const fallbackActive = fallbackAction?.action === "reuse"
          && fallbackAction.status === "active";
        checks.push({
          code: "cloudflare_saas_fallback_origin",
          detail: fallbackActive
            ? `${spec.saas.fallbackOrigin} is the active fallback origin`
            : `${spec.saas.fallbackOrigin} is ${fallbackAction?.status ?? "missing"}`,
          ok: fallbackActive,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "cloudflare_saas_check_failed";
        checks.push({ code: "cloudflare_saas_api", detail, ok: false });
      }
    }

    if (environment === "staging") {
      let routeAuditToken;
      try {
        routeAuditToken = requireCloudflareRouteAuditToken(operatorEnvironment);
        checks.push({
          code: "cloudflare_route_audit_api_token_context",
          detail: "Read-only route-audit token is available for staging admission checks",
          ok: true,
        });
      } catch {
        checks.push({
          code: "cloudflare_route_audit_api_token_context",
          detail: "Export CLOUDFLARE_ROUTE_AUDIT_API_TOKEN temporarily to verify live staging routes",
          ok: false,
        });
      }

      if (routeAuditToken) {
        try {
          const routeAudit = await auditStagingRouteInventory(
            spec,
            routeAuditToken,
            input.fetchImplementation ?? globalThis.fetch,
          );
          checks.push(...routeAudit.checks);
        } catch (error) {
          const detail = error instanceof Error
            ? error.message
            : "cloudflare_staging_route_inventory_check_failed";
          checks.push({ code: "cloudflare_staging_route_inventory_api", detail, ok: false });
        }
      }
    }
  }

  return { checks, environment, ok: checks.every((check) => check.ok) };
}
