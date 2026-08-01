import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

export const FRONTEND_ONLY_RELEASE_MODE = "production_frontend_only_v1";
export const FRONTEND_ONLY_BASELINE_COMMIT = "3838b4724936ae1f9cafbd0df53a51a9adb3124b";
export const FRONTEND_ONLY_ROLLBACK_VERSION = "6ca9c890-ed04-44dc-ac32-44b36881f2dc";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE_ID = /^release_[0-9]{8}_[a-z0-9]{8,48}$/u;
const MIGRATION = /^[0-9]{4}_[a-z0-9_]+\.sql$/u;

const ALLOWED_PATHS = new Set([
  "docs/IMPLEMENTATION_STATUS.md",
  "docs/PRODUCTION_RELEASE.md",
  "infra/release/production-evidence.example.json",
  "infra/release/production-frontend-only-evidence.example.json",
  "package.json",
  "public/brand/selinow-kit/architecture.core.png",
  "public/brand/selinow-kit/decorative.network-nodes.png",
  "public/brand/selinow-kit/hero.selinow-core.png",
  "public/brand/selinow-kit/illustration.bot.png",
  "public/brand/selinow-kit/illustration.delivery-cloud.png",
  "public/brand/selinow-kit/illustration.notification-bell.png",
  "public/brand/selinow-kit/illustration.payment-card.png",
  "public/brand/selinow-kit/illustration.product-box.png",
  "public/brand/selinow-kit/illustration.shopping-bag.png",
  "public/brand/selinow-kit/provider.api-card.png",
  "public/brand/selinow-kit/provider.discord-card.png",
  "public/brand/selinow-kit/provider.website-card.png",
  "public/brand/selinow-kit/provider.whatsapp-card.png",
  "public/brand/selinow-kit/provider.zalo-card.png",
  "scripts/deploy.mjs",
  "scripts/release-candidate.mjs",
  "scripts/production-frontend-release.mjs",
  "scripts/lib/frontend-only-release.d.mts",
  "scripts/lib/frontend-only-release.mjs",
  "scripts/lib/production-canary.d.mts",
  "scripts/lib/production-canary.mjs",
  "scripts/lib/release.d.mts",
  "scripts/lib/release.mjs",
  "src/components/marketing/MarketingHeader.astro",
  "src/lib/i18n/catalogs/marketing.ts",
  "src/pages/index.astro",
  "src/styles/platform.css",
  "tests/unit/deploy-guard.test.ts",
  "tests/unit/frontend-only-release.test.ts",
  "tests/unit/marketing-surface-contracts.test.ts",
  "tests/unit/production-canary.test.ts",
  "tests/unit/release-readiness.test.ts",
  "tests/visual/local-public.spec.ts",
  "tests/visual/local-public.spec.ts-snapshots/public-marketing-home-public-desktop-1440-darwin.png",
  "tests/visual/local-public.spec.ts-snapshots/public-marketing-home-public-mobile-390-darwin.png",
  "tests/visual/local-zoom.spec.ts",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => [key, canonical(child)]));
}

export function fingerprintFrontendOnly(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export async function discoverFrontendOnlyWorkerVersions(input) {
  const versions = [];
  const fetchImplementation = input.fetchImplementation ?? globalThis.fetch;
  let expectedTotalCount = null;
  for (let page = 1; page <= 100; page += 1) {
    const url = new globalThis.URL(`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/workers/scripts/${encodeURIComponent(input.workerName)}/versions`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "100");
    let response;
    try {
      response = await fetchImplementation(url, {
        headers: { authorization: `Bearer ${input.token}` },
        method: "GET",
        signal: globalThis.AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("production_frontend_only_full_version_inventory_unavailable");
    }
    if (!response.ok) throw new Error("production_frontend_only_full_version_inventory_unavailable");
    const envelope = await response.json();
    const items = envelope?.result?.items;
    if (envelope?.success !== true || !Array.isArray(items)) {
      throw new Error("production_frontend_only_full_version_inventory_invalid");
    }
    for (const version of items) {
      if (!UUID.test(version?.id ?? "")) throw new Error("production_frontend_only_full_version_inventory_invalid");
      versions.push({
        annotations: typeof version.annotations === "object" && version.annotations !== null ? version.annotations : {},
        id: version.id,
        metadata: typeof version.metadata === "object" && version.metadata !== null ? version.metadata : {},
        number: Number.isSafeInteger(version.number) ? version.number : null,
      });
    }
    const info = envelope?.result_info;
    if (info === undefined || info === null) {
      if (items.length < 100) break;
      if (page === 100) throw new Error("production_frontend_only_full_version_inventory_incomplete");
      continue;
    }
    const count = Number(info.count);
    const reportedPage = Number(info.page);
    const perPage = Number(info.per_page);
    const totalCount = Number(info.total_count);
    const reportedTotalPages = info.total_pages === undefined ? null : Number(info.total_pages);
    const derivedTotalPages = Number.isSafeInteger(totalCount) && Number.isSafeInteger(perPage) && perPage > 0
      ? Math.ceil(totalCount / perPage)
      : null;
    if (!Number.isSafeInteger(count) || count !== items.length
      || !Number.isSafeInteger(reportedPage) || reportedPage !== page
      || !Number.isSafeInteger(perPage) || perPage < 1 || perPage > 100
      || !Number.isSafeInteger(totalCount) || totalCount < items.length
      || !Number.isSafeInteger(derivedTotalPages) || derivedTotalPages < 1 || derivedTotalPages > 100
      || (reportedTotalPages !== null
        && (!Number.isSafeInteger(reportedTotalPages) || reportedTotalPages !== derivedTotalPages))
      || (expectedTotalCount !== null && expectedTotalCount !== totalCount)) {
      throw new Error("production_frontend_only_full_version_inventory_invalid");
    }
    expectedTotalCount = totalCount;
    if (page === derivedTotalPages) break;
    if (page > derivedTotalPages || items.length === 0 || page === 100) {
      throw new Error("production_frontend_only_full_version_inventory_incomplete");
    }
  }
  if (versions.length === 0
    || (expectedTotalCount !== null && versions.length !== expectedTotalCount)
    || new Set(versions.map((version) => version.id)).size !== versions.length) {
    throw new Error("production_frontend_only_full_version_inventory_invalid");
  }
  return versions.sort((left, right) => {
    if (left.number !== null && right.number !== null && left.number !== right.number) return right.number - left.number;
    return left.id.localeCompare(right.id);
  });
}

export async function waitForFrontendOnlyActiveVersion(input) {
  const attempts = input.attempts ?? 15;
  const delayImplementation = input.delayImplementation ?? delay;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await input.inventoryImplementation();
    const active = current?.deployments?.[0]?.versionId;
    if (active === input.expectedVersion) return current;
    if (!input.allowedVersions.has(active)) throw new Error("production_frontend_only_active_version_ambiguous");
    if (attempt < attempts - 1) await delayImplementation(2_000);
  }
  throw new Error("production_frontend_only_active_version_propagation_timeout");
}

function safeFrontendOnlyErrorCode(error) {
  const message = error instanceof Error ? error.message : "unknown";
  return /^[a-z0-9_:.-]{1,240}$/u.test(message) ? message : "unknown";
}

export async function compensateFrontendOnlyActivation(input) {
  const originalCode = safeFrontendOnlyErrorCode(input.originalError);
  let freshInventory;
  try {
    freshInventory = await input.inventoryImplementation();
  } catch {
    throw new Error(
      `production_frontend_only_automatic_rollback_admission_unavailable:${originalCode}`,
      { cause: input.originalError },
    );
  }
  let freshActiveVersion;
  try {
    freshActiveVersion = activeVersion(freshInventory);
  } catch {
    throw new Error(
      `production_frontend_only_automatic_rollback_active_version_ambiguous:${originalCode}`,
      { cause: input.originalError },
    );
  }
  if (!UUID.test(input.candidateWorkerVersion ?? "")
    || input.candidateWorkerVersion === FRONTEND_ONLY_ROLLBACK_VERSION
    || (freshActiveVersion !== input.candidateWorkerVersion
      && freshActiveVersion !== FRONTEND_ONLY_ROLLBACK_VERSION)) {
    throw new Error(
      `production_frontend_only_automatic_rollback_active_version_ambiguous:${originalCode}`,
      { cause: input.originalError },
    );
  }
  let rollbackInvocationFailed = false;
  if (freshActiveVersion === input.candidateWorkerVersion) {
    let preMutationActiveVersion;
    try {
      preMutationActiveVersion = activeVersion(await input.inventoryImplementation());
    } catch {
      throw new Error(
        `production_frontend_only_automatic_rollback_admission_unavailable:${originalCode}`,
        { cause: input.originalError },
      );
    }
    if (preMutationActiveVersion !== input.candidateWorkerVersion) {
      throw new Error(
        `production_frontend_only_automatic_rollback_active_version_ambiguous:${originalCode}`,
        { cause: input.originalError },
      );
    }
    try {
      await input.deployRollbackImplementation();
    } catch {
      rollbackInvocationFailed = true;
    }
  }

  const [inventoryResult, ledgerResult] = await Promise.allSettled([
    waitForFrontendOnlyActiveVersion({
      allowedVersions: input.allowedVersions,
      expectedVersion: FRONTEND_ONLY_ROLLBACK_VERSION,
      inventoryImplementation: input.inventoryImplementation,
      ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
      ...(input.delayImplementation === undefined ? {} : { delayImplementation: input.delayImplementation }),
    }),
    Promise.resolve().then(() => input.migrationLedgerImplementation()),
  ]);

  try {
    if (inventoryResult.status !== "fulfilled" || ledgerResult.status !== "fulfilled") {
      throw new Error("production_frontend_only_automatic_rollback_fresh_verification_unavailable");
    }
    await input.verifyRestoredImplementation(inventoryResult.value, ledgerResult.value);
  } catch {
    const status = rollbackInvocationFailed ? "attempted" : "sent";
    throw new Error(
      `production_frontend_only_automatic_rollback_${status}_verification_failed:${originalCode}`,
      { cause: input.originalError },
    );
  }

  throw new Error(
    `production_frontend_only_automatic_rollback_complete:${originalCode}`,
    { cause: input.originalError },
  );
}

export function validateFrontendOnlyEvidence(evidence) {
  if (evidence?.schemaVersion !== 1
    || evidence?.mode !== FRONTEND_ONLY_RELEASE_MODE
    || evidence?.environment !== "production"
    || !RELEASE_ID.test(evidence?.releaseId ?? "")
    || evidence?.baselineCommitSha !== FRONTEND_ONLY_BASELINE_COMMIT
    || evidence?.rollbackWorkerVersion !== FRONTEND_ONLY_ROLLBACK_VERSION
    || !SHA.test(evidence?.commitSha ?? "")
    || !SHA.test(evidence?.treeSha ?? "")
    || !SHA256.test(evidence?.diffSha256 ?? "")) {
    throw new Error("production_frontend_only_evidence_invalid");
  }
  if (!evidence?.quality?.check || !evidence.quality.lint || !evidence.quality.test
    || !evidence.quality.build || !evidence.quality.deployDryRun) {
    throw new Error("production_frontend_only_quality_incomplete");
  }
  if (!evidence?.browser?.desktop || !evidence.browser.mobile || !evidence.browser.zoom200
    || evidence.browser.axeViolations !== 0 || evidence.browser.consoleErrors !== 0
    || evidence.browser.pageErrors !== 0 || evidence?.visual?.accepted !== true) {
    throw new Error("production_frontend_only_browser_incomplete");
  }
  if (evidence?.security?.criticalOpen !== 0 || evidence.security.highOpen !== 0) {
    throw new Error("production_frontend_only_security_incomplete");
  }
  for (const name of ["quality", "browser", "visual", "security"]) {
    const report = evidence[name];
    if (typeof report?.reportRef !== "string"
      || report.reportRef !== `.wrangler/releases/${evidence.releaseId}/${name}-report.json`
      || !SHA256.test(report?.reportSha256 ?? "")) {
      throw new Error(`production_frontend_only_report_invalid:${name}`);
    }
  }
  return evidence;
}

function packageWithoutReleaseScripts(value) {
  const copy = globalThis.structuredClone(value);
  const commands = {
    "release:candidate": "node scripts/release-candidate.mjs",
    "release:production:frontend-only": "node scripts/production-frontend-release.mjs",
  };
  for (const [name, command] of Object.entries(commands)) {
    if (copy.scripts?.[name] !== undefined && copy.scripts[name] !== command) {
      throw new Error(`production_frontend_only_package_script_invalid:${name}`);
    }
    delete copy.scripts?.[name];
  }
  return copy;
}

export function qualifyFrontendOnlySource(input) {
  const evidence = validateFrontendOnlyEvidence(input.evidence);
  const source = input.source;
  if (source?.clean !== true || source.commitSha !== evidence.commitSha
    || source.treeSha !== evidence.treeSha || source.diffSha256 !== evidence.diffSha256
    || source.baselineCommitSha !== FRONTEND_ONLY_BASELINE_COMMIT
    || source.baselineIsAncestor !== true || source.mergeCommits?.length !== 0
    || source.storefrontSuffixUnchanged !== true
    || !Array.isArray(source?.changes) || source.changes.length === 0) {
    throw new Error("production_frontend_only_source_identity_invalid");
  }
  for (const change of source.changes) {
    if (!new Set(["A", "M"]).has(change?.status) || !ALLOWED_PATHS.has(change?.path)
      || !new Set(["000000", "100644"]).has(change?.oldMode) || change?.newMode !== "100644"
      || (change.status === "M" && change.oldMode !== change.newMode)) {
      throw new Error(`production_frontend_only_source_change_forbidden:${change?.path ?? "unknown"}`);
    }
  }
  if (!isDeepStrictEqual(canonical(packageWithoutReleaseScripts(input.currentPackage)), canonical(input.baselinePackage))) {
    throw new Error("production_frontend_only_package_boundary_invalid");
  }
  return {
    baselineCommitSha: FRONTEND_ONLY_BASELINE_COMMIT,
    commitSha: source.commitSha,
    diffSha256: source.diffSha256,
    mode: FRONTEND_ONLY_RELEASE_MODE,
    paths: source.changes.map((change) => change.path).sort(),
    rollbackWorkerVersion: FRONTEND_ONLY_ROLLBACK_VERSION,
    treeSha: source.treeSha,
  };
}

export function normalizeFrontendOnlyMigrationLedger(output) {
  if (!Array.isArray(output) || output.length !== 1 || output[0]?.success !== true
    || !Array.isArray(output[0]?.results)) {
    throw new Error("production_frontend_only_migration_ledger_invalid");
  }
  const ledger = output[0].results.map((row) => {
    const id = Number(row?.id);
    if (!Number.isSafeInteger(id) || id < 1 || !MIGRATION.test(row?.name ?? "")
      || typeof row?.applied_at !== "string" || Number.isNaN(Date.parse(row.applied_at))) {
      throw new Error("production_frontend_only_migration_ledger_invalid");
    }
    return { appliedAt: row.applied_at, id, name: row.name };
  }).sort((a, b) => a.id - b.id);
  if (new Set(ledger.map((row) => row.id)).size !== ledger.length
    || new Set(ledger.map((row) => row.name)).size !== ledger.length) {
    throw new Error("production_frontend_only_migration_ledger_invalid");
  }
  return ledger;
}

function activeVersion(inventory) {
  const version = inventory?.deployments?.[0]?.versionId;
  if (!UUID.test(version ?? "")) throw new Error("production_frontend_only_active_version_invalid");
  return version;
}

function inventoryWithout(inventory, names) {
  return canonical(Object.fromEntries(Object.entries(inventory ?? {}).filter(([name]) => !names.has(name))));
}

export function assertFrontendOnlyControlInventory(inventory) {
  if (activeVersion(inventory) !== FRONTEND_ONLY_ROLLBACK_VERSION
    || !inventory?.versions?.some((version) => version?.id === FRONTEND_ONLY_ROLLBACK_VERSION)) {
    throw new Error("production_frontend_only_rollback_version_not_active");
  }
  return FRONTEND_ONLY_ROLLBACK_VERSION;
}

export function assertFrontendOnlyUploadTransition(before, after) {
  assertFrontendOnlyControlInventory(before);
  assertFrontendOnlyControlInventory(after);
  if (!isDeepStrictEqual(inventoryWithout(before, new Set(["observedAt", "versions"])),
    inventoryWithout(after, new Set(["observedAt", "versions"])))) {
    throw new Error("production_frontend_only_upload_inventory_drift");
  }
  const beforeIds = new Set(before.versions.map((version) => version.id));
  const added = after.versions.filter((version) => !beforeIds.has(version.id));
  const removed = before.versions.filter((version) => !after.versions.some((item) => item.id === version.id));
  const changed = before.versions.find((version) => {
    const observed = after.versions.find((item) => item.id === version.id);
    return observed !== undefined && !isDeepStrictEqual(canonical(version), canonical(observed));
  });
  if (added.length !== 1 || removed.length !== 0 || changed !== undefined || activeVersion(after) === added[0]?.id) {
    throw new Error("production_frontend_only_candidate_transition_invalid");
  }
  return added[0].id;
}

function versionContract(view) {
  if (!UUID.test(view?.id ?? "") || !Array.isArray(view?.resources?.bindings)
    || !Array.isArray(view?.resources?.script?.handlers)
    || typeof view?.resources?.script_runtime !== "object" || view.resources.script_runtime === null) {
    throw new Error("production_frontend_only_version_view_invalid");
  }
  const assets = view.resources.bindings.filter((binding) => binding?.type === "assets");
  if (assets.length !== 1 || assets[0]?.name !== "ASSETS") {
    throw new Error("production_frontend_only_assets_binding_invalid");
  }
  const bindings = view.resources.bindings.filter((binding) => binding?.type !== "assets")
    .map(canonical).sort((a, b) => String(a?.name).localeCompare(String(b?.name)));
  if (bindings.some((binding) => typeof binding?.name !== "string")
    || new Set(bindings.map((binding) => binding.name)).size !== bindings.length) {
    throw new Error("production_frontend_only_binding_inventory_invalid");
  }
  const handlers = [...view.resources.script.handlers].sort();
  if (!isDeepStrictEqual(handlers, ["fetch", "queue", "scheduled"])) throw new Error("production_frontend_only_handler_inventory_invalid");
  const namedHandlers = (view.resources.script.named_handlers ?? []).map((entry) => ({
    handlers: [...(entry?.handlers ?? [])].sort(),
    name: entry?.name ?? null,
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return {
    bindings,
    handlers,
    namedHandlers,
    runtime: canonical(view.resources.script_runtime),
  };
}

export function assertFrontendOnlyVersionParity(previousView, candidateView) {
  if (previousView?.id !== FRONTEND_ONLY_ROLLBACK_VERSION || previousView.id === candidateView?.id) {
    throw new Error("production_frontend_only_version_identity_invalid");
  }
  const previous = versionContract(previousView);
  const candidate = versionContract(candidateView);
  if (!isDeepStrictEqual(previous, candidate)) throw new Error("production_frontend_only_version_runtime_drift");
  return {
    bindingNames: previous.bindings.map((binding) => binding.name),
    runtimeSha256: fingerprintFrontendOnly(previous),
  };
}

export function assertFrontendOnlyActivationTransition(before, after, candidateVersionId) {
  if (!UUID.test(candidateVersionId ?? "")) throw new Error("production_frontend_only_candidate_invalid");
  assertFrontendOnlyControlInventory(before);
  if (activeVersion(after) !== candidateVersionId
    || !isDeepStrictEqual(inventoryWithout(before, new Set(["observedAt", "deployments"])),
      inventoryWithout(after, new Set(["observedAt", "deployments"])))) {
    throw new Error("production_frontend_only_activation_inventory_drift");
  }
  const retainedHistory = after.deployments.slice(1);
  const expectedHistory = before.deployments.slice(0, retainedHistory.length);
  if (!UUID.test(after.deployments[0]?.id ?? "")
    || after.deployments.length !== Math.min(before.deployments.length + 1, 10)
    || !isDeepStrictEqual(canonical(retainedHistory), canonical(expectedHistory))) {
    throw new Error("production_frontend_only_deployment_transition_invalid");
  }
  return candidateVersionId;
}

export const FRONTEND_ONLY_SMOKE_CHECKS = Object.freeze([
  { allowedStatuses: [200], method: "GET", name: "marketing", url: "https://selinow.com/" },
  { allowedStatuses: [200], method: "GET", name: "pricing", url: "https://selinow.com/pricing" },
  { allowedStatuses: [200], method: "GET", name: "login", url: "https://selinow.com/login" },
  { allowedStatuses: [200], method: "GET", name: "api_health", url: "https://api.selinow.com/api/health" },
  { allowedStatuses: [404], method: "GET", name: "not_found", url: "https://selinow.com/products/frontend-release-invalid" },
]);

export async function runFrontendOnlySmoke(fetchImplementation = globalThis.fetch) {
  const results = [];
  for (const check of FRONTEND_ONLY_SMOKE_CHECKS) {
    let response;
    try {
      response = await fetchImplementation(check.url, {
        headers: { "user-agent": "selinow-production-frontend-only-smoke/1" },
        method: "GET",
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`production_frontend_only_smoke_request_failed:${check.name}`);
    }
    if (!check.allowedStatuses.includes(response.status)) {
      throw new Error(`production_frontend_only_smoke_status_invalid:${check.name}:${response.status}`);
    }
    results.push({ name: check.name, status: response.status, url: check.url });
  }
  return results;
}
