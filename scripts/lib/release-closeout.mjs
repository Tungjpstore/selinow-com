import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  inspectProductionReadiness,
  readOptionalJson,
} from "./release.mjs";
import { assertFreshProductionContinuationEvidence } from "./backup.mjs";
import { repositoryRoot } from "./platform.mjs";

const STAGING_RELEASE_ROOT = resolve(repositoryRoot, ".wrangler/releases/staging");

const CHECK_GROUPS = [
  {
    prefix: "evidence.approvals.",
    category: "owner_approval",
    nextAction: "Obtain the named owner approval and record its private, reviewable reference.",
  },
  {
    prefix: "evidence.backup.",
    category: "production_backup_restore",
    nextAction: "Run a fresh protected production backup and isolated restore drill for the exact reviewed tree.",
  },
  {
    prefix: "evidence.continuationFiles",
    category: "production_backup_restore",
    nextAction: "Verify the release-bound production backup and isolated restore artifacts before admission.",
  },
  {
    prefix: "evidence.commerceAcceptance.",
    category: "provider_uat",
    nextAction: "Run genuine provider UAT and write a redacted, release-bound acceptance artifact.",
  },
  {
    prefix: "evidence.providerAcceptance.",
    category: "channel_acceptance",
    nextAction: "Run provider acceptance for this active channel, or keep it deferred and fail closed.",
  },
  {
    prefix: "evidence.manualAcceptance.",
    category: "manual_acceptance",
    nextAction: "Complete the applicable read-only/manual acceptance flow and record a private evidence reference.",
  },
  {
    prefix: "evidence.monitoring.",
    category: "monitoring",
    nextAction: "Configure production dashboards, alerts and budget alerts, then record external evidence.",
  },
  {
    prefix: "evidence.pilot.",
    category: "controlled_pilot",
    nextAction: "Complete a controlled pilot with at least two shops and retain the redacted report.",
  },
  {
    prefix: "evidence.quality.",
    category: "quality_evidence",
    nextAction: "Run the required quality commands on the clean reviewed tree and record their results.",
  },
  {
    prefix: "evidence.staging.",
    category: "staging_acceptance",
    nextAction: "Deploy the exact reviewed tree to staging and bind migration, route, health and acceptance evidence.",
  },
  {
    prefix: "evidence.releaseScope.",
    category: "release_scope",
    nextAction: "Partition all channels explicitly; leave unsupported channels deferred and unaccepted.",
  },
  {
    prefix: "evidence.rollback.",
    category: "rollback_rehearsal",
    nextAction: "Rehearse rollback for the exact candidate and retain the private, redacted report.",
  },
  {
    prefix: "evidence.candidateWorkerVersion",
    category: "worker_version_admission",
    nextAction: "Upload the admitted candidate version and record the exact immutable Worker version ID.",
  },
  {
    prefix: "evidence.previousWorkerVersion",
    category: "worker_version_admission",
    nextAction: "Read the current stable production Worker version and retain it as the rollback target.",
  },
  {
    prefix: "evidence.commitSha",
    category: "candidate_identity",
    nextAction: "Record the exact clean reviewed commit SHA for this release candidate.",
  },
  {
    prefix: "evidence.environment",
    category: "candidate_identity",
    nextAction: "Set the evidence environment to production.",
  },
  {
    prefix: "evidence.releaseId",
    category: "candidate_identity",
    nextAction: "Create a unique non-placeholder production release ID bound to this candidate.",
  },
  {
    prefix: "evidence.schemaVersion",
    category: "candidate_identity",
    nextAction: "Use production release evidence schema version 2.",
  },
  {
    prefix: "evidence.migrationLedgerPrefix",
    category: "migration_admission",
    nextAction: "Record the exact source migration prefix observed in the target database.",
  },
  {
    prefix: "evidence.security.",
    category: "security_review",
    nextAction: "Resolve or formally review open critical/high findings before production admission.",
  },
  {
    prefix: "evidence.legalSupport.",
    category: "legal_support_approval",
    nextAction: "Obtain owner-approved legal/support decisions and retain the private, candidate-bound checklist.",
  },
  {
    prefix: "evidence.secretInventory.",
    category: "production_secret_inventory",
    nextAction: "Verify the name-only production Worker secret inventory and retain its candidate-bound artifact.",
  },
  {
    prefix: "evidence.",
    category: "release_evidence",
    nextAction: "Populate this release-bound field from an auditable non-secret artifact; do not use placeholders.",
  },
  {
    prefix: "secret.",
    category: "production_secret_inventory",
    nextAction: "Verify the name-only production Worker secret inventory and install values through the approved secret channel.",
  },
  {
    prefix: "productionSpec.",
    category: "production_spec",
    nextAction: "Correct the reviewed production resource/hostname specification and rerun the doctor.",
  },
  {
    prefix: "alignment.",
    category: "configuration_alignment",
    nextAction: "Correct the production/staging route, binding or variable alignment and rerun the doctor.",
  },
  {
    prefix: "binding.",
    category: "configuration_alignment",
    nextAction: "Verify the required production Worker binding and queue consumer contract.",
  },
  {
    prefix: "var.",
    category: "configuration_alignment",
    nextAction: "Verify the required non-secret production variable in the reviewed environment spec.",
  },
  {
    prefix: "wrangler.",
    category: "configuration_alignment",
    nextAction: "Correct the reviewed Wrangler production environment contract and rerun the doctor.",
  },
];

function groupForCheck(name) {
  return CHECK_GROUPS.find((group) => name.startsWith(group.prefix))
    ?? { category: "release_evidence", nextAction: "Resolve this failed release-doctor check and rerun the doctor." };
}

export function classifyReleaseCheck(check) {
  const name = typeof check?.name === "string" ? check.name : "unknown";
  const group = groupForCheck(name);
  return {
    name,
    ok: check?.ok === true,
    category: group.category,
    nextAction: group.nextAction,
  };
}

async function loadStagingManifests(root = STAGING_RELEASE_ROOT) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u.test(entry.name)) continue;
    const path = join(root, entry.name, "release-manifest.json");
    const manifest = await readOptionalJson(path);
    if (manifest === null) continue;
    let manifestSha256;
    try {
      manifestSha256 = createHash("sha256").update(await readFile(path)).digest("hex");
    } catch {
      continue;
    }
    manifests.push({
      path: path.replace(`${repositoryRoot}/`, ""),
      releaseId: typeof manifest.releaseId === "string" ? manifest.releaseId : null,
      commitSha: typeof manifest.commitSha === "string" ? manifest.commitSha : null,
      treeSha: typeof manifest.treeSha === "string" ? manifest.treeSha : null,
      createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : null,
      expiresAt: typeof manifest.expiresAt === "string" ? manifest.expiresAt : null,
      manifestSha256,
      schemaVersion: manifest.schemaVersion ?? null,
    });
  }
  return manifests.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

function gitValue(args) {
  try {
    return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export async function buildCloseoutReport({
  evidence,
  productionSpec,
  workerSecretNames,
  wranglerConfig,
  now = new Date(),
  continuationEvidenceImplementation = assertFreshProductionContinuationEvidence,
  inspectReadinessImplementation = inspectProductionReadiness,
  repositoryStateImplementation,
  stagingReleaseRoot = STAGING_RELEASE_ROOT,
} = {}) {
  const readiness = inspectReadinessImplementation({
    evidence,
    now,
    productionSpec,
    repositoryRoot,
    workerSecretNames,
    wranglerConfig,
  });
  const checks = readiness.checks.map(classifyReleaseCheck);
  const stagingManifests = await loadStagingManifests(stagingReleaseRoot);
  const repositoryState = repositoryStateImplementation?.() ?? {
    headSha: gitValue(["rev-parse", "HEAD"]),
    treeSha: gitValue(["rev-parse", "HEAD^{tree}"]),
    dirty: gitValue(["status", "--porcelain"]),
  };
  const headSha = repositoryState.headSha;
  const treeSha = repositoryState.treeSha;
  const dirty = repositoryState.dirty;
  const latestStaging = stagingManifests[0] ?? null;
  const latestStagingCreatedAt = Date.parse(latestStaging?.createdAt ?? "");
  const latestStagingExpiry = Date.parse(latestStaging?.expiresAt ?? "");
  const manifestFresh = latestStaging?.schemaVersion === 3
    && Number.isFinite(latestStagingCreatedAt)
    && Number.isFinite(latestStagingExpiry)
    && latestStagingCreatedAt <= now.getTime() + 5 * 60_000
    && latestStagingExpiry > now.getTime()
    && latestStagingExpiry > latestStagingCreatedAt
    && latestStagingExpiry - latestStagingCreatedAt <= 7 * 24 * 60 * 60_000;
  const candidateMatchesLatestStaging = latestStaging?.commitSha === headSha
    && latestStaging?.treeSha === treeSha;
  const repositoryClean = dirty === "";
  const stagingBindingMatchesLatest = latestStaging !== null
    && evidence?.staging?.releaseId === latestStaging.releaseId
    && evidence?.staging?.manifestRef === latestStaging.path
    && evidence?.staging?.manifestSha256 === latestStaging.manifestSha256;
  const stagingEligibleForCurrentCandidate = repositoryClean
    && manifestFresh
    && candidateMatchesLatestStaging
    && stagingBindingMatchesLatest;

  let continuationFiles = false;
  if (evidence !== null && productionSpec !== null) {
    try {
      const production = wranglerConfig?.env?.production;
      const database = Array.isArray(production?.d1_databases)
        ? production.d1_databases.find((item) => item?.binding === "PLATFORM_DB")
        : null;
      const continuation = await continuationEvidenceImplementation({
        accountId: productionSpec.accountId,
        databaseId: database?.database_id,
        databaseName: database?.database_name,
        now,
        repositoryRoot,
        reviewedCommitSha: evidence.commitSha,
      });
      const expectedBackupRef = resolve(repositoryRoot, evidence.backup?.snapshotReportRef ?? "");
      const expectedRestoreRef = resolve(repositoryRoot, evidence.backup?.restoreDrillReportRef ?? "");
      continuationFiles = resolve(continuation.backup?.reportRef ?? "") === expectedBackupRef
        && resolve(continuation.restore?.reportRef ?? "") === expectedRestoreRef
        && continuation.backup?.completedAt === evidence.backup?.completedAt
        && continuation.restore?.completedAt === evidence.backup?.restoreDrillCompletedAt;
    } catch {
      continuationFiles = false;
    }
  }
  const closeoutChecks = [
    { name: "evidence.staging.currentCandidate", ok: stagingEligibleForCurrentCandidate },
    { name: "evidence.continuationFiles", ok: continuationFiles },
  ].map(classifyReleaseCheck);
  const allChecks = [...checks, ...closeoutChecks];
  const allFailedChecks = allChecks.filter((check) => !check.ok);
  const allCategoryCounts = Object.fromEntries(
    [...new Set(allChecks.map((check) => check.category))]
      .sort()
      .map((category) => [category, {
        failed: allChecks.filter((check) => check.category === category && !check.ok).length,
        passed: allChecks.filter((check) => check.category === category && check.ok).length,
      }]),
  );
  return {
    generatedAt: now.toISOString(),
    ok: readiness.ok && allFailedChecks.length === 0,
    summary: {
      failed: allFailedChecks.length,
      passed: allChecks.length - allFailedChecks.length,
      total: allChecks.length,
      categoryCounts: allCategoryCounts,
    },
    repository: {
      headSha,
      treeSha,
      clean: repositoryClean,
    },
    staging: {
      latestManifest: latestStaging,
      manifestCount: stagingManifests.length,
      manifestFresh,
      candidateMatchesLatestStaging,
      bindingMatchesLatest: stagingBindingMatchesLatest,
      eligibleForCurrentCandidate: stagingEligibleForCurrentCandidate,
    },
    failedChecks: allFailedChecks,
    missing: [...readiness.missing, ...allFailedChecks.filter((check) => !readiness.missing.includes(check.name)).map((check) => check.name)],
  };
}

export async function loadCloseoutInputs({
  evidencePath = resolve(repositoryRoot, ".wrangler/release/production-evidence.json"),
  productionSpecPath = resolve(repositoryRoot, "infra/environments/production.json"),
  secretNamesPath = null,
  wranglerConfigPath = resolve(repositoryRoot, "wrangler.jsonc"),
} = {}) {
  const wranglerConfig = JSON.parse(await readFile(wranglerConfigPath, "utf8"));
  const evidence = await readOptionalJson(evidencePath);
  const productionSpec = await readOptionalJson(productionSpecPath);
  let workerSecretNames;
  if (secretNamesPath) {
    const value = await readOptionalJson(secretNamesPath);
    if (!Array.isArray(value)) throw new Error("worker_secret_names_invalid");
    workerSecretNames = value.filter((name) => typeof name === "string");
  } else {
    workerSecretNames = (process.env.SELINOW_WORKER_SECRET_NAMES ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  }
  return { evidence, productionSpec, workerSecretNames, wranglerConfig };
}
