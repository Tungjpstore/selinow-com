import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import {
  inspectProductionReadiness,
  readOptionalJson,
} from "./release.mjs";
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
    manifests.push({
      path: path.replace(`${repositoryRoot}/`, ""),
      releaseId: typeof manifest.releaseId === "string" ? manifest.releaseId : null,
      commitSha: typeof manifest.commitSha === "string" ? manifest.commitSha : null,
      treeSha: typeof manifest.treeSha === "string" ? manifest.treeSha : null,
      createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : null,
      expiresAt: typeof manifest.expiresAt === "string" ? manifest.expiresAt : null,
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
  stagingReleaseRoot = STAGING_RELEASE_ROOT,
} = {}) {
  const readiness = inspectProductionReadiness({
    evidence,
    now,
    productionSpec,
    repositoryRoot,
    workerSecretNames,
    wranglerConfig,
  });
  const checks = readiness.checks.map(classifyReleaseCheck);
  const failedChecks = checks.filter((check) => !check.ok);
  const categoryCounts = Object.fromEntries(
    [...new Set(checks.map((check) => check.category))]
      .sort()
      .map((category) => [category, {
        failed: checks.filter((check) => check.category === category && !check.ok).length,
        passed: checks.filter((check) => check.category === category && check.ok).length,
      }]),
  );
  const stagingManifests = await loadStagingManifests(stagingReleaseRoot);
  const headSha = gitValue(["rev-parse", "HEAD"]);
  const treeSha = gitValue(["rev-parse", "HEAD^{tree}"]);
  const dirty = gitValue(["status", "--porcelain"]);
  const latestStaging = stagingManifests[0] ?? null;
  return {
    generatedAt: now.toISOString(),
    ok: readiness.ok,
    summary: {
      failed: failedChecks.length,
      passed: checks.length - failedChecks.length,
      total: checks.length,
      categoryCounts,
    },
    repository: {
      headSha,
      treeSha,
      clean: dirty === "",
    },
    staging: {
      latestManifest: latestStaging,
      manifestCount: stagingManifests.length,
      candidateMatchesLatestStaging: latestStaging?.commitSha === headSha,
    },
    failedChecks,
    missing: readiness.missing,
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
  const workerSecretNames = secretNamesPath
    ? await readOptionalJson(secretNamesPath)
    : (process.env.SELINOW_WORKER_SECRET_NAMES ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  return { evidence, productionSpec, workerSecretNames, wranglerConfig };
}
