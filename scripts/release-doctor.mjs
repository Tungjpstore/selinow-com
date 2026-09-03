import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import {
  assertProductionContinuationDeployAdmission,
  inspectLiveCandidateWorkerVersionEvidence,
  inspectProductionReadiness,
  readOptionalJson,
  validateCandidateWorkerVersionEvidence,
} from "./lib/release.mjs";
import { resolveDatabaseTarget } from "./lib/backup.mjs";
import { validateCommerceUatArtifacts } from "./lib/commerce-uat-evidence.mjs";
import { repositoryRoot } from "./lib/platform.mjs";

function parseArguments(argv) {
  const options = {
    evidencePath: resolve(repositoryRoot, ".wrangler/release/production-evidence.json"),
    json: false,
    secretNamesPath: null,
    specPath: resolve(repositoryRoot, "infra/environments/production.json"),
    stagingSpecPath: resolve(repositoryRoot, "infra/environments/staging.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--spec") options.specPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--staging-spec") options.stagingSpecPath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--secret-names") options.secretNamesPath = resolve(repositoryRoot, argv[++index] ?? "");
    else throw new Error(`unknown_argument:${argument}`);
  }
  return options;
}

function mergeChecks(result, additional) {
  const checks = [...new Map([...result.checks, ...additional.checks]
    .map((check) => [check.name, check])).values()]
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    checks,
    missing: checks.filter((check) => !check.ok).map((check) => check.name),
    ok: checks.every((check) => check.ok),
  };
}

async function enforceCandidateWorkerVersionEvidence(result, input) {
  if (!result.ok) return result;
  try {
    const validation = await inspectLiveCandidateWorkerVersionEvidence({
      environment: process.env,
      evidence: input.evidence,
      productionSpec: input.productionSpec,
      repositoryRoot,
      stagingSpec: input.stagingSpec,
      wranglerConfig: input.wranglerConfig,
    });
    return mergeChecks(result, validation);
  } catch {
    return mergeChecks(result, validateCandidateWorkerVersionEvidence({
      evidence: input.evidence,
    }));
  }
}

async function loadSecretNames(path) {
  if (path !== null) {
    const value = await readOptionalJson(path);
    if (!Array.isArray(value)) throw new Error("worker_secret_names_invalid");
    return value.filter((name) => typeof name === "string");
  }
  return (process.env.SELINOW_WORKER_SECRET_NAMES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function writeResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({
      checks: result.checks,
      environment: "production",
      missing: result.missing,
      ok: result.ok,
    }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"} production\n`);
  for (const check of result.checks) process.stdout.write(`${check.ok ? "=" : "x"} ${check.name}\n`);
}

async function enforceContinuationEvidence(result, input) {
  if (!result.ok) return result;
  try {
    const target = resolveDatabaseTarget(input.wranglerConfig, "production");
    await assertProductionContinuationDeployAdmission({
      accountId: input.productionSpec.accountId,
      databaseId: target.databaseId,
      databaseName: target.databaseName,
      repositoryRoot,
      reviewedCommitSha: input.evidence.commitSha,
    });
    return result;
  } catch {
    const checks = [...result.checks, { name: "evidence.continuationFiles", ok: false }]
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      checks,
      missing: [...result.missing, "evidence.continuationFiles"].sort(),
      ok: false,
    };
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const wranglerConfig = JSON.parse(await readFile(resolve(repositoryRoot, "wrangler.jsonc"), "utf8"));
  const productionSpec = await readOptionalJson(options.specPath);
  const stagingSpec = await readOptionalJson(options.stagingSpecPath);
  const evidence = await readOptionalJson(options.evidencePath);
  const now = new Date();
  const commerceEvidenceValidation = evidence === null
    ? undefined
    : await validateCommerceUatArtifacts({
        environment: process.env,
        evidence,
        now,
        repositoryRoot,
      });
  const result = inspectProductionReadiness({
    commerceEvidenceValidation,
    evidence,
    now,
    productionSpec,
    requireReleaseHardening: true,
    workerSecretNames: await loadSecretNames(options.secretNamesPath),
    wranglerConfig,
  });
  const candidateBoundResult = productionSpec === null || evidence === null
    ? result
    : await enforceCandidateWorkerVersionEvidence(result, {
        evidence,
        productionSpec,
        stagingSpec,
        wranglerConfig,
      });
  const finalResult = productionSpec === null || evidence === null
    ? candidateBoundResult
    : await enforceContinuationEvidence(candidateBoundResult, { evidence, productionSpec, wranglerConfig });
  writeResult(finalResult, options.json);
  process.exitCode = finalResult.ok ? 0 : 1;
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message)
    ? error.message
    : "release_doctor_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
