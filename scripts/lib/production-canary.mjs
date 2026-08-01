import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
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
const PUBLIC_DOH_ENDPOINTS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
];
const CLOUDFLARE_IPV4_RANGES = [
  ["173.245.48.0", 20],
  ["103.21.244.0", 22],
  ["103.22.200.0", 22],
  ["103.31.4.0", 22],
  ["141.101.64.0", 18],
  ["108.162.192.0", 18],
  ["190.93.240.0", 20],
  ["188.114.96.0", 20],
  ["197.234.240.0", 22],
  ["198.41.128.0", 17],
  ["162.158.0.0", 15],
  ["104.16.0.0", 13],
  ["104.24.0.0", 14],
  ["172.64.0.0", 13],
  ["131.0.72.0", 22],
].map(([address, prefix]) => ({ network: ipv4ToBigInt(address), mask: ipv4Mask(prefix) }));
const CLOUDFLARE_IPV6_RANGES = [
  ["2400:cb00::", 32],
  ["2606:4700::", 32],
  ["2803:f800::", 32],
  ["2405:b500::", 32],
  ["2405:8100::", 32],
  ["2a06:98c0::", 29],
  ["2c0f:f248::", 32],
].map(([address, prefix]) => ({ network: ipv6ToBigInt(address), mask: ipv6Mask(prefix) }));
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

function ipv4ToBigInt(address) {
  const octets = address.split(".").map((octet) => Number(octet));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    throw new Error("production_canary_cloudflare_range_invalid");
  }
  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv4Mask(prefix) {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error("production_canary_cloudflare_range_invalid");
  return prefix === 0 ? 0n : ((1n << 32n) - 1n) ^ ((1n << BigInt(32 - prefix)) - 1n);
}

function ipv6ToBigInt(address) {
  const value = address.toLowerCase();
  const pieces = value.split("::");
  if (pieces.length > 2) throw new Error("production_canary_cloudflare_range_invalid");
  const left = pieces[0] === "" ? [] : pieces[0].split(":");
  const right = pieces.length === 2 && pieces[1] !== "" ? pieces[1].split(":") : [];
  const groups = pieces.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) {
    throw new Error("production_canary_cloudflare_range_invalid");
  }
  return groups.reduce((result, group) => (result << 16n) | BigInt(parseInt(group, 16)), 0n);
}

function ipv6Mask(prefix) {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) throw new Error("production_canary_cloudflare_range_invalid");
  return prefix === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n);
}

function cloudflareAddress(address) {
  const normalized = normalizeIpAddress(address);
  const kind = isIP(normalized);
  if (kind === 4) {
    const value = ipv4ToBigInt(normalized);
    return CLOUDFLARE_IPV4_RANGES.some(({ network, mask }) => (value & mask) === network);
  }
  if (kind === 6) {
    const value = ipv6ToBigInt(normalized);
    return CLOUDFLARE_IPV6_RANGES.some(({ network, mask }) => (value & mask) === network);
  }
  return false;
}

function normalizeIpAddress(address, expectedFamily = null) {
  if (typeof address !== "string" || address.length === 0 || address !== address.trim()) {
    throw new Error("production_canary_dns_lookup_invalid");
  }
  const mappedMatch = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  const normalized = mappedMatch?.[1] ?? address.toLowerCase();
  const family = isIP(normalized);
  if (
    family === 0
    || (expectedFamily === 4 && family !== 4)
    || (expectedFamily === 6 && family !== 6 && mappedMatch === null)
  ) {
    throw new Error("production_canary_dns_lookup_invalid");
  }
  return normalized;
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
  const evidenceSha256 = fingerprint({ ...input.evidence, candidateWorkerVersion: null });
  if (
    plan?.schemaVersion !== 1
    || plan?.phase !== "canary"
    || plan?.environment !== "production"
    || plan?.ceremonyId !== input.evidence?.ceremonyId
    || !isDeepStrictEqual(plan?.safeguards?.allowedMutations, allowedMutations)
    || plan?.fingerprints?.evidenceSha256 !== evidenceSha256
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

function normalizeCanaryHostname(hostname) {
  if (typeof hostname !== "string") throw new Error("production_canary_dns_hostname_invalid");
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(normalized)) {
    throw new Error("production_canary_dns_hostname_invalid");
  }
  return normalized;
}

function normalizeResolverAddresses(value, family) {
  if (!Array.isArray(value)) throw new Error("production_canary_dns_lookup_invalid");
  return value.map((address) => normalizeIpAddress(address, family));
}

function dnsLookupError(error) {
  return error && typeof error === "object" && ["ENODATA", "ENOTFOUND", "NODATA"].includes(error.code);
}

async function resolveAddressFamily(implementation, hostname, family) {
  try {
    const value = await implementation(hostname);
    return normalizeResolverAddresses(value, family);
  } catch (error) {
    if (dnsLookupError(error)) return [];
    if (error?.message === "production_canary_dns_lookup_invalid") throw error;
    throw new Error("production_canary_dns_lookup_failed", { cause: error });
  }
}

async function resolveDohEndpoint(fetchImplementation, endpoint, hostname, recordType, family) {
  const url = new globalThis.URL(endpoint);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", recordType);
  let response;
  try {
    response = await fetchImplementation(url, { headers: { accept: "application/dns-json" } });
  } catch (error) {
    throw new Error("production_canary_dns_lookup_failed", { cause: error });
  }
  if (!response?.ok) throw new Error("production_canary_dns_lookup_failed");
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error("production_canary_dns_lookup_invalid", { cause: error });
  }
  if (
    typeof payload !== "object"
    || payload === null
    || !Number.isInteger(payload.Status)
    || (payload.Answer !== undefined && !Array.isArray(payload.Answer))
  ) {
    throw new Error("production_canary_dns_lookup_invalid");
  }
  if (payload.Status === 3) return [];
  if (payload.Status !== 0) throw new Error("production_canary_dns_lookup_failed");
  const answerType = family === 4 ? 1 : 28;
  const answers = (payload.Answer ?? []).filter((answer) => answer?.type === answerType);
  if (answers.some((answer) => typeof answer?.data !== "string")) {
    throw new Error("production_canary_dns_lookup_invalid");
  }
  return normalizeResolverAddresses(answers.map((answer) => answer.data), family);
}

async function resolvePublicDohFamily(fetchImplementation, hostname, recordType, family) {
  const results = await Promise.allSettled(PUBLIC_DOH_ENDPOINTS.map((endpoint) => (
    resolveDohEndpoint(fetchImplementation, endpoint, hostname, recordType, family)
  )));
  const successful = results.filter((result) => result.status === "fulfilled");
  if (successful.length === 0) {
    if (results.some((result) => result.status === "rejected" && result.reason?.message === "production_canary_dns_lookup_invalid")) {
      throw new Error("production_canary_dns_lookup_invalid");
    }
    throw new Error("production_canary_dns_lookup_failed");
  }
  return successful.flatMap((result) => result.value);
}

/**
 * Resolve the exact canary host through public DNS and require Cloudflare anycast IPs.
 * This is intentionally read-only; it does not inspect or mutate Cloudflare DNS records.
 */
export async function resolveProductionCanaryDns(input) {
  const hostname = normalizeCanaryHostname(input?.hostname);
  const customResolvers = input?.resolve4Implementation !== undefined || input?.resolve6Implementation !== undefined;
  let ipv4;
  let ipv6;
  if (customResolvers) {
    if (typeof input.resolve4Implementation !== "function" || typeof input.resolve6Implementation !== "function") {
      throw new Error("production_canary_dns_resolver_missing");
    }
    [ipv4, ipv6] = await Promise.all([
      resolveAddressFamily(input.resolve4Implementation, hostname, 4),
      resolveAddressFamily(input.resolve6Implementation, hostname, 6),
    ]);
  } else {
    const fetchImplementation = input?.fetchImplementation ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") throw new Error("production_canary_dns_resolver_missing");
    [ipv4, ipv6] = await Promise.all([
      resolvePublicDohFamily(fetchImplementation, hostname, "A", 4),
      resolvePublicDohFamily(fetchImplementation, hostname, "AAAA", 6),
    ]);
  }
  const addresses = [...new Set([...ipv4, ...ipv6])];
  if (addresses.length === 0) throw new Error("production_canary_dns_unresolved");
  if (addresses.some((address) => !cloudflareAddress(address))) {
    throw new Error("production_canary_dns_not_cloudflare");
  }
  return { addresses, hostname };
}

export function assertProductionCanaryDnsAdmission(admission, productionSpec) {
  const expected = normalizeCanaryHostname(productionSpec?.bootstrap?.canaryHostname);
  let addresses;
  try {
    addresses = admission?.addresses?.map((address) => normalizeIpAddress(address));
  } catch {
    throw new Error("production_canary_dns_admission_invalid");
  }
  if (
    typeof admission !== "object"
    || admission === null
    || admission.hostname !== expected
    || !Array.isArray(addresses)
    || addresses.length === 0
    || addresses.some((address) => !cloudflareAddress(address))
  ) {
    throw new Error("production_canary_dns_admission_invalid");
  }
  return { addresses: [...new Set(addresses)], hostname: expected };
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

export function isFirstProductionPlaceholderVersionView(view) {
  const bindings = view?.resources?.bindings;
  if (
    !Array.isArray(bindings)
    || view?.resources?.assets != null
    || view?.bindings != null
    || bindings.length !== REQUIRED_WORKER_SECRET_NAMES.length
  ) return false;
  const names = [];
  for (const binding of bindings) {
    if (binding?.type !== "secret_text" || typeof binding?.name !== "string") return false;
    names.push(binding.name);
  }
  const expectedNames = [...REQUIRED_WORKER_SECRET_NAMES].sort();
  return names.sort().every((name, index) => name === expectedNames[index]);
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
  delete child.CLOUDFLARE_RELEASE_WORKER_API_TOKEN;
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
    const createdOn = deployment?.created_on ?? deployment?.createdOn;
    const normalizedVersionId = deployment?.versionId;
    const rawVersion = Array.isArray(deployment?.versions) && deployment.versions.length === 1
      ? deployment.versions[0]
      : null;
    const versionId = normalizedVersionId ?? rawVersion?.version_id;
    if (
      typeof deployment?.id !== "string"
      || !UUID_PATTERN.test(deployment.id)
      || safeDate(createdOn) === null
      || typeof versionId !== "string"
      || !UUID_PATTERN.test(versionId)
      || (normalizedVersionId === undefined && rawVersion?.percentage !== 100)
    ) {
      throw new Error("production_canary_deployments_invalid");
    }
    return {
      createdOn,
      id: deployment.id,
      versionId,
    };
  }).sort((left, right) => Date.parse(right.createdOn) - Date.parse(left.createdOn));
}

function normalizeWorkerSubdomain(value) {
  const previewsEnabled = value?.previewsEnabled ?? value?.previews_enabled;
  if (
    typeof value?.enabled !== "boolean"
    || typeof previewsEnabled !== "boolean"
    || (value?.previewsEnabled !== undefined
      && value?.previews_enabled !== undefined
      && value.previewsEnabled !== value.previews_enabled)
  ) {
    throw new Error("production_canary_worker_subdomain_inventory_invalid");
  }
  return { enabled: value.enabled, previewsEnabled };
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

  const [routes, domains, schedulesResult, deploymentsResult, workerSubdomain] = await Promise.all([
    cloudflareApiRequest(input.auditToken, `/zones/${spec.zoneId}/workers/routes`, {
      fetchImplementation: input.fetchImplementation,
    }),
    cloudflareApiRequest(input.auditToken, `/accounts/${spec.accountId}/workers/domains`, {
      fetchImplementation: input.fetchImplementation,
    }),
    cloudflareApiRequest(input.auditToken, `/accounts/${spec.accountId}/workers/scripts/${encodeURIComponent(spec.workerName)}/schedules`, {
      fetchImplementation: input.fetchImplementation,
    }),
    cloudflareApiRequest(input.auditToken, `/accounts/${spec.accountId}/workers/scripts/${encodeURIComponent(spec.workerName)}/deployments`, {
      fetchImplementation: input.fetchImplementation,
    }),
    cloudflareApiRequest(input.auditToken, `/accounts/${spec.accountId}/workers/scripts/${encodeURIComponent(spec.workerName)}/subdomain`, {
      fetchImplementation: input.fetchImplementation,
    }),
  ]);
  const schedules = Array.isArray(schedulesResult) ? schedulesResult : schedulesResult?.schedules;
  const deployments = Array.isArray(deploymentsResult)
    ? deploymentsResult
    : deploymentsResult?.deployments;
  if (!Array.isArray(deployments)) throw new Error("production_canary_deployments_invalid");
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
    workerSubdomain,
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
    workerSubdomain: normalizeWorkerSubdomain(input.workerSubdomain),
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

function assertWorkerSubdomainDisabled(inventory) {
  if (
    inventory.workerSubdomain.enabled !== false
    || inventory.workerSubdomain.previewsEnabled !== false
  ) {
    throw new Error("production_canary_worker_subdomain_enabled");
  }
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

function assertCanaryDnsCarrier(inventory, productionSpec, stagingWorkerName) {
  const hostname = normalizeCanaryHostname(productionSpec?.bootstrap?.canaryHostname);
  if (typeof stagingWorkerName !== "string" || stagingWorkerName.length === 0) {
    throw new Error("production_canary_staging_worker_invalid");
  }
  const carriers = inventory.domains.filter((domain) => domain.hostname === hostname);
  if (carriers.length > 1 || carriers.some((domain) => domain.service !== stagingWorkerName)) {
    throw new Error(`production_canary_dns_carrier_drift:${hostname}`);
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

function assertCandidateEvidence(evidence, migrationNames, now, candidateVersionId, expectedFingerprint = null) {
  if (evidence?.candidateWorkerVersion !== candidateVersionId) {
    throw new Error("production_canary_candidate_evidence_mismatch");
  }
  const baseline = { ...evidence, candidateWorkerVersion: null };
  assertUploadEvidence(baseline, migrationNames, now);
  if (expectedFingerprint !== null && fingerprint(baseline) !== expectedFingerprint) {
    throw new Error("production_canary_upload_evidence_drift");
  }
}

function activeVersionId(inventory) {
  return inventory.deployments[0].versionId;
}

function assertBaseInventory(input, inventory) {
  assertTargetIdentity(inventory, input);
  assertCanaryDnsCarrier(inventory, input.productionSpec, input.stagingWorkerName);
  assertNoProductionTraffic(inventory, input.productionSpec);
  assertSavedTrafficSnapshot(inventory, input.trafficSnapshot);
  assertIdleProductionTriggers(inventory);
  assertRuntimeSecrets(inventory);
  assertWorkerSubdomainDisabled(inventory);
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
    workerSubdomain: inventory.workerSubdomain,
    zoneId: inventory.zoneId,
    zoneName: inventory.zoneName,
  };
}

function nonDeploymentInvariantInventory(inventory) {
  const { deployments, ...invariant } = invariantInventory(inventory);
  void deployments;
  return invariant;
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
  return added[0];
}

function buildCandidateEvidencePatch(evidence, candidateVersionId) {
  if (evidence?.candidateWorkerVersion !== null || !UUID_PATTERN.test(candidateVersionId ?? "")) {
    throw new Error("production_canary_evidence_transition_invalid");
  }
  return { candidateWorkerVersion: candidateVersionId };
}

function candidateBindingContract(input) {
  const production = input.wranglerConfig?.env?.production;
  const spec = input.productionSpec;
  const manifest = input.generatedManifest;
  if (
    production?.name !== spec?.workerName
    || production?.preview_urls !== false
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
  const requiredHandlers = ["fetch", "queue", "scheduled"];
  if (
    view?.id !== candidateVersionId
    || !Array.isArray(view?.resources?.bindings)
    || !Array.isArray(view?.resources?.script?.handlers)
    || !isDeepStrictEqual([...view.resources.script.handlers].sort(), requiredHandlers)
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
  await input.uploadImplementation(activeVersionId(admitted));
  const after = normalizeCanaryInventory(await input.inventoryImplementation());
  assertWorkerSubdomainDisabled(after);
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
    candidateHasPreview: typeof candidate.metadata?.has_preview === "boolean"
      ? candidate.metadata.has_preview
      : null,
    candidateVersionId: candidate.id,
    ceremonyId: input.evidence.ceremonyId,
    controlVersionId: activeVersionId(admitted),
    createdAt: input.now.toISOString(),
    environment: "production",
    evidencePrerequisitesSha256: fingerprint(input.evidence),
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
    evidencePatch: buildCandidateEvidencePatch(input.evidence, candidate.id),
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
    || !/^[a-f0-9]{64}$/u.test(report?.evidencePrerequisitesSha256 ?? "")
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
  assertCandidateEvidence(
    input.evidence,
    input.migrationNames,
    input.now,
    report.candidateVersionId,
    report.evidencePrerequisitesSha256,
  );
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
    || !isDeepStrictEqual(before.workerSubdomain, after.workerSubdomain)
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
    || !isDeepStrictEqual(before.workerSubdomain, after.workerSubdomain)
  ) {
    throw new Error("production_canary_route_apply_changed_unapproved_state");
  }
}

function canaryRouteFromInventory(inventory, pattern, workerName) {
  const matches = inventory.routes.filter((route) => route.pattern === pattern);
  if (matches.length > 1) throw new Error("production_canary_route_compensation_duplicate");
  if (matches.length === 0) return null;
  if (matches[0].script !== workerName) throw new Error("production_canary_route_compensation_drift");
  return matches[0];
}

async function compensateCanaryApply(input, initial, report, originalError, createdRouteId = null) {
  let current;
  try {
    current = normalizeCanaryInventory(await input.inventoryImplementation());
    assertWorkerSubdomainDisabled(current);
  } catch (error) {
    throw new Error("production_canary_apply_compensation_failed", { cause: error });
  }

  const active = activeVersionId(current);
  if (
    active === report.controlVersionId
    && isDeepStrictEqual(nonDeploymentInvariantInventory(initial), nonDeploymentInvariantInventory(current))
  ) {
    // The ambiguous deploy call did not change control; do not issue a redundant mutation.
    throw originalError;
  }
  if (active !== report.candidateVersionId) {
    throw new Error("production_canary_apply_compensation_failed", { cause: originalError });
  }

  let routeCompensationError = null;
  try {
    const route = canaryRouteFromInventory(
      current,
      input.productionSpec.routing.canaryOverrideRoute,
      input.productionSpec.workerName,
    );
    const withoutRoute = { ...current, routes: current.routes.filter((candidate) => candidate.pattern !== input.productionSpec.routing.canaryOverrideRoute) };
    if (
      !isDeepStrictEqual(routeShape(withoutRoute.routes), routeShape(initial.routes))
      || !isDeepStrictEqual(withoutRoute.domains, initial.domains)
      || !isDeepStrictEqual(withoutRoute.queueConsumers, initial.queueConsumers)
      || !isDeepStrictEqual(withoutRoute.schedules, initial.schedules)
      || !isDeepStrictEqual(withoutRoute.secretNames, initial.secretNames)
      || !isDeepStrictEqual(withoutRoute.workerSubdomain, initial.workerSubdomain)
    ) {
      throw new Error("production_canary_route_compensation_drift");
    }
    if (route !== null) {
      if (createdRouteId === null || route.id !== createdRouteId) {
        throw new Error("production_canary_route_compensation_ownership_unknown");
      }
      if (typeof input.deleteRouteImplementation !== "function") {
        throw new Error("production_canary_route_compensation_unavailable");
      }
      let deleteError = null;
      try {
        await input.deleteRouteImplementation(route.id);
      } catch (error) {
        deleteError = error;
      }
      current = normalizeCanaryInventory(await input.inventoryImplementation());
      if (!isDeepStrictEqual(current.routes, initial.routes)) {
        throw deleteError ?? new Error("production_canary_route_compensation_state_drift");
      }
    }
  } catch (error) {
    routeCompensationError = error;
  }

  try {
    await input.deployVersionImplementation(report.controlVersionId);
  } catch (error) {
    // A thrown mutation remains ambiguous until the following live inventory read.
    void error;
  }
  try {
    const restored = normalizeCanaryInventory(await input.inventoryImplementation());
    assertWorkerSubdomainDisabled(restored);
    if (
      !isDeepStrictEqual(nonDeploymentInvariantInventory(initial), nonDeploymentInvariantInventory(restored))
      || activeVersionId(restored) !== report.controlVersionId
    ) {
      throw new Error("production_canary_apply_compensation_state_drift");
    }
  } catch (error) {
    throw new Error("production_canary_apply_compensation_failed", { cause: error });
  }
  if (routeCompensationError !== null) {
    throw new Error("production_canary_apply_compensation_failed", { cause: routeCompensationError });
  }
  throw originalError;
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
        { code: "canary_dns_admission", detail: input.productionSpec.bootstrap.canaryHostname, ok: true },
        { code: "candidate_deployment", detail: report.candidateVersionId, ok: true },
        { code: "canary_route_create", detail: input.productionSpec.routing.canaryOverrideRoute, ok: true },
      ],
      environment: "production",
      executed: false,
      ok: true,
    };
  }

  if (typeof input.dnsAdmissionImplementation !== "function") {
    throw new Error("production_canary_dns_admission_missing");
  }
  const dnsBeforeDeploy = assertProductionCanaryDnsAdmission(
    await input.dnsAdmissionImplementation(input.productionSpec.bootstrap.canaryHostname),
    input.productionSpec,
  );
  let candidateDeployed = false;
  let createdRouteId = null;
  try {
    let deployError = null;
    try {
      await input.deployVersionImplementation(report.candidateVersionId);
    } catch (error) {
      deployError = error;
    }
    const deployed = normalizeCanaryInventory(await input.inventoryImplementation());
    assertWorkerSubdomainDisabled(deployed);
    assertNonDeploymentInventoryUnchanged(initial, deployed, "production_canary_deploy_changed_live_state");
    assertIdleProductionTriggers(deployed);
    if (deployError !== null && activeVersionId(deployed) === report.controlVersionId) throw deployError;
    assertCandidateActive(deployed, report.candidateVersionId);
    candidateDeployed = true;
    if (deployError !== null) throw deployError;
    const dnsBeforeRoute = assertProductionCanaryDnsAdmission(
      await input.dnsAdmissionImplementation(input.productionSpec.bootstrap.canaryHostname),
      input.productionSpec,
    );
    const routePattern = input.productionSpec.routing.canaryOverrideRoute;
    const workerName = input.productionSpec.workerName;
    const createdRoute = await input.createRouteImplementation({
      pattern: routePattern,
      script: workerName,
    });
    if (
      typeof createdRoute?.id !== "string"
      || !SAFE_ID_PATTERN.test(createdRoute.id)
      || (createdRoute.pattern !== undefined && createdRoute.pattern !== routePattern)
      || (createdRoute.script !== undefined && createdRoute.script !== workerName)
    ) {
      throw new Error("production_canary_route_create_response_invalid");
    }
    createdRouteId = createdRoute.id;
    const after = normalizeCanaryInventory(await input.inventoryImplementation());
    assertWorkerSubdomainDisabled(after);
    assertCandidateActive(after, report.candidateVersionId);
    assertCanaryRouteApplied(deployed, after, routePattern, workerName, createdRoute.id);
    const state = {
      accountId: after.accountId,
      appliedAt: input.now.toISOString(),
      candidateVersionId: report.candidateVersionId,
      canaryRoute: { id: createdRoute.id, pattern: routePattern, script: workerName },
      ceremonyId: report.ceremonyId,
      controlVersionId: report.controlVersionId,
      dnsAdmission: {
        addressesBeforeDeploy: dnsBeforeDeploy.addresses,
        addressesBeforeRoute: dnsBeforeRoute.addresses,
        hostname: dnsBeforeRoute.hostname,
      },
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
        { code: "canary_dns_admitted", detail: input.productionSpec.bootstrap.canaryHostname, ok: true },
        { code: "canary_route_created", detail: routePattern, ok: true },
      ],
      environment: "production",
      executed: true,
      ok: true,
      state,
      stateRef,
    };
  } catch (error) {
    if (!candidateDeployed) {
      // A deploy failure is ambiguous: inventory reconciliation decides whether mutation is needed.
      return compensateCanaryApply(input, initial, report, error, createdRouteId);
    }
    return compensateCanaryApply(input, initial, report, error, createdRouteId);
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
  assertWorkerSubdomainDisabled(initial);
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

  let deleteError = null;
  try {
    await input.deleteRouteImplementation(state.canaryRoute.id);
  } catch (error) {
    deleteError = error;
  }
  const routeRestored = normalizeCanaryInventory(await input.inventoryImplementation());
  assertWorkerSubdomainDisabled(routeRestored);
  try {
    assertRouteSnapshot(routeRestored, state.routesBefore, "production_canary_rollback_routes_not_restored");
  } catch (error) {
    throw deleteError ?? error;
  }
  assertCandidateActive(routeRestored, state.candidateVersionId);
  assertIdleProductionTriggers(routeRestored);
  let deployError = null;
  try {
    await input.deployVersionImplementation(state.controlVersionId);
  } catch (error) {
    deployError = error;
  }
  const final = normalizeCanaryInventory(await input.inventoryImplementation());
  assertWorkerSubdomainDisabled(final);
  assertRouteSnapshot(final, state.routesBefore, "production_canary_rollback_final_route_drift");
  assertIdleProductionTriggers(final);
  if (activeVersionId(final) !== state.controlVersionId) {
    throw deployError ?? new Error("production_canary_control_version_not_restored");
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
