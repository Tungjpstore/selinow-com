import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { assertProductionWorkerIdentityAdmission, assertStagingMutationAdmission, repositoryRoot } from "./platform.mjs";
import { assertStagingReleaseAdmission, readStagingRepositoryState } from "./staging-release.mjs";

const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const RELEASE_ID = /^(?:stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}|release_[A-Za-z0-9._-]{8,128})$/u;

async function json(path, issue) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(issue);
  }
}

export function buildPaymentMutationChildEnvironment(environment, accountId) {
  if (!ACCOUNT_ID.test(accountId) || typeof environment.CLOUDFLARE_PAYMENT_MUTATION_API_TOKEN !== "string" || environment.CLOUDFLARE_PAYMENT_MUTATION_API_TOKEN.trim().length === 0) {
    throw new Error("payment_provider_cloudflare_mutation_identity_invalid");
  }
  const child = {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_TOKEN: environment.CLOUDFLARE_PAYMENT_MUTATION_API_TOKEN,
  };
  for (const name of ["HOME", "PATH", "SHELL", "TMPDIR", "USER", "npm_config_cache"]) {
    if (typeof environment[name] === "string") child[name] = environment[name];
  }
  return child;
}

export function assertDodoCanonicalRouteProbe(response, payload, requestId) {
  const expected = new Map([
    [401, "webhook_signature_invalid"],
    [503, "billing_provider_unavailable"],
  ]);
  if (!expected.has(response.status)
    || response.url.length === 0
    || response.redirected
    || response.headers.get("X-Request-Id") !== requestId
    || response.headers.get("Cache-Control") !== "private, no-store, max-age=0"
    || payload?.ok !== false
    || payload?.code !== expected.get(response.status)
    || payload?.requestId !== requestId
    || Object.keys(payload).some((key) => !["code", "ok", "requestId"].includes(key))) {
    throw new Error("dodo_webhook_route_contract_invalid");
  }
}

async function assertProductionReleaseBinding(input) {
  const path = resolve(input.root, input.manifestPath);
  let stat;
  try { stat = await lstat(path); } catch { throw new Error("production_release_manifest_missing"); }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("production_release_manifest_permissions_invalid");
  const manifest = await json(path, "production_release_manifest_invalid");
  const repository = readStagingRepositoryState(input.root);
  if (!repository.clean) throw new Error("production_release_source_dirty");
  if (manifest?.schemaVersion !== 2 || manifest?.environment !== "production"
    || manifest?.commitSha !== repository.commitSha || !RELEASE_ID.test(manifest?.releaseId ?? "")) {
    throw new Error("production_release_manifest_binding_invalid");
  }
  const canonical = resolve(input.root, ".wrangler", "releases", manifest.releaseId, "release-manifest.json");
  if (path !== canonical) throw new Error("production_release_manifest_path_invalid");
  return { commitSha: repository.commitSha, releaseId: manifest.releaseId };
}

export async function assertPaymentProviderMutationAdmission(input) {
  const root = input.repositoryRoot ?? repositoryRoot;
  const operatorEnvironment = input.operatorEnvironment ?? process.env;
  const [spec, wrangler] = await Promise.all([
    json(resolve(root, "infra", "environments", `${input.environment}.json`), "payment_provider_environment_spec_invalid"),
    json(resolve(root, "wrangler.jsonc"), "payment_provider_wrangler_invalid"),
  ]);
  if (spec?.environment !== input.environment || !ACCOUNT_ID.test(spec?.accountId ?? "")
    || typeof spec?.workerName !== "string" || wrangler?.env?.[input.environment]?.name !== spec.workerName) {
    throw new Error("payment_provider_environment_contract_invalid");
  }
  const release = input.environment === "staging"
    ? await (input.stagingReleaseAdmissionImplementation ?? assertStagingReleaseAdmission)({
      manifestPath: input.manifestPath,
      repositoryRoot: root,
    })
    : await (input.productionReleaseAdmissionImplementation ?? assertProductionReleaseBinding)({
      manifestPath: input.manifestPath,
      root,
    });
  let worker;
  if (input.environment === "staging") {
    worker = await (input.stagingMutationAdmissionImplementation ?? assertStagingMutationAdmission)({
      environment: operatorEnvironment,
    });
  } else {
    const stagingSpec = await json(resolve(root, "infra", "environments", "staging.json"), "payment_provider_environment_spec_invalid");
    worker = await (input.productionWorkerAdmissionImplementation ?? assertProductionWorkerIdentityAdmission)({
      environment: operatorEnvironment,
      productionSpec: spec,
      repositoryRoot: root,
      stagingSpec,
      wranglerConfig: wrangler,
    });
  }
  if (worker?.accountId !== spec.accountId || worker?.workerName !== spec.workerName || worker?.ok !== true) {
    throw new Error("payment_provider_worker_admission_invalid");
  }
  return {
    accountId: spec.accountId,
    childEnvironment: buildPaymentMutationChildEnvironment(operatorEnvironment, spec.accountId),
    commitSha: release.commitSha,
    releaseId: release.releaseId,
    workerName: spec.workerName,
  };
}
