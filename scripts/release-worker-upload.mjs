import { spawnSync } from "node:child_process";
import process from "node:process";
import { resolve } from "node:path";

import { run, runWrangler } from "./lib/cli.mjs";
import {
  assertProductionWorkerUploadResult,
  buildProductionWorkerVersionMessage,
  readOptionalJson,
} from "./lib/release.mjs";
import {
  assertProductionWorkerIdentityAdmission,
  buildWorkerBuildEnvironment,
  buildWorkerDeployEnvironment,
  repositoryRoot,
} from "./lib/platform.mjs";

const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{7,80}$/u;

function parseArguments(argv) {
  const options = {
    confirmProduction: false,
    evidencePath: resolve(repositoryRoot, ".wrangler/release/production-evidence.json"),
    execute: false,
    json: false,
    role: null,
    sourceRoot: repositoryRoot,
    tag: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm-production") options.confirmProduction = true;
    else if (argument === "--evidence") options.evidencePath = resolve(repositoryRoot, argv[++index] ?? "");
    else if (argument === "--execute") options.execute = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--role") options.role = argv[++index] ?? "";
    else if (argument === "--source-root") options.sourceRoot = resolve(argv[++index] ?? "");
    else if (argument === "--tag") options.tag = argv[++index] ?? "";
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (!new Set(["candidate", "rollback"]).has(options.role)) throw new Error("production_worker_upload_role_required");
  if (!TAG_PATTERN.test(options.tag ?? "")) throw new Error("production_worker_upload_tag_invalid");
  if (options.execute && !options.confirmProduction) throw new Error("production_confirmation_required");
  return options;
}

function gitValue(root, args, code) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(code);
  return result.stdout.trim();
}

function assertSourceIdentity(root, binding) {
  if (gitValue(root, ["status", "--porcelain=v1", "--untracked-files=all"], "production_worker_upload_source_status_unavailable") !== "") {
    throw new Error("production_worker_upload_source_dirty");
  }
  if (gitValue(root, ["rev-parse", "--verify", "HEAD"], "production_worker_upload_commit_unavailable") !== binding.commitSha
    || gitValue(root, ["rev-parse", "--verify", "HEAD^{tree}"], "production_worker_upload_tree_unavailable") !== binding.treeSha) {
    throw new Error("production_worker_upload_source_mismatch");
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const [evidence, productionSpec, stagingSpec, wranglerConfig] = await Promise.all([
    readOptionalJson(options.evidencePath),
    readOptionalJson(resolve(repositoryRoot, "infra/environments/production.json")),
    readOptionalJson(resolve(repositoryRoot, "infra/environments/staging.json")),
    readOptionalJson(resolve(repositoryRoot, "wrangler.jsonc")),
  ]);
  if (evidence === null) throw new Error("production_evidence_missing");
  if (productionSpec === null) throw new Error("production_spec_missing");
  if (stagingSpec === null) throw new Error("staging_spec_missing");
  if (wranglerConfig === null) throw new Error("wrangler_config_missing");
  const source = options.role === "candidate" ? evidence : evidence?.rollback?.candidate;
  const binding = {
    commitSha: source?.commitSha,
    manifestRef: `.wrangler/releases/${evidence.releaseId}/release-manifest.json`,
    releaseId: evidence.releaseId,
    treeSha: source?.treeSha,
  };
  const message = buildProductionWorkerVersionMessage({ ...binding, role: options.role });
  assertSourceIdentity(options.sourceRoot, binding);
  if (!options.execute) {
    const result = {
      actions: [
        { code: "build_clean_source", ok: true },
        { code: "upload_route_neutral_version", ok: true },
        { code: "verify_single_bound_version", ok: true },
      ],
      binding,
      environment: "production",
      executed: false,
      ok: true,
      role: options.role,
      tag: options.tag,
    };
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `PASS production Worker ${options.role} upload plan\n`);
  } else {
    const identityInput = {
      environment: process.env,
      productionSpec,
      repositoryRoot,
      requireCurrentWorkerVersion: true,
      stagingSpec,
      wranglerConfig,
    };
    const before = await assertProductionWorkerIdentityAdmission(identityInput);
    run("npm", ["run", "build"], {
      capture: false,
      cwd: options.sourceRoot,
      env: buildWorkerBuildEnvironment(process.env, "production"),
    });
    runWrangler([
      "versions", "upload", "--env", "production", "--strict", "--tag", options.tag, "--message", message,
    ], {
      capture: false,
      cwd: options.sourceRoot,
      env: buildWorkerDeployEnvironment(process.env, productionSpec.accountId),
    });
    const after = await assertProductionWorkerIdentityAdmission(identityInput);
    if (after.currentWorkerVersion !== before.currentWorkerVersion) {
      throw new Error("production_worker_upload_changed_active_version");
    }
    const admission = assertProductionWorkerUploadResult({
      after: after.deployableWorkerVersionInventory,
      before: before.deployableWorkerVersionInventory,
      expectedBinding: binding,
    });
    const result = {
      binding,
      environment: "production",
      executed: true,
      ok: true,
      role: options.role,
      tag: options.tag,
      workerVersion: admission.workerVersion,
    };
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `PASS uploaded ${options.role} Worker version ${admission.workerVersion}\n`);
  }
} catch (error) {
  const code = error instanceof Error && /^[a-z0-9_:.-]{1,220}$/u.test(error.message)
    ? error.message
    : "production_worker_upload_failed";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
