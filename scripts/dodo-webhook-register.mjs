import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";

import {
  assertDodoBootstrapCandidateAdmission,
  assertDodoBootstrapArtifact,
  assertDodoBootstrapReleaseBinding,
  assertDodoBootstrapResumeClaimOwnership,
  assertDodoSecretVersionClone,
  assertDodoSignedHealthProbe,
  acquireDodoBootstrapResumeClaim,
  buildDodoBootstrapArtifact,
  buildDodoBootstrapHealthArtifact,
  buildDodoBootstrapReservation,
  buildDodoBootstrapRollbackArtifact,
  buildDodoSignedHealthProbe,
  DODO_BOOTSTRAP_ARTIFACT_FILES,
  DODO_BOOTSTRAP_API_KEY_SECRET_NAME,
  DODO_BOOTSTRAP_WEBHOOK_SECRET_NAME,
  fingerprintDodoBootstrapApiKey,
  inspectDodoWebhookEndpoint,
  readCanonicalPrivateJson,
  readDodoWebhookSigningSecret,
  readPrivateDodoArtifact,
  releaseDodoBootstrapResumeClaim,
  renewDodoBootstrapResumeClaim,
  replacePrivateDodoArtifact,
  updateDodoBootstrapReservation,
  writePrivateDodoArtifact,
} from "./lib/dodo-webhook-bootstrap.mjs";
import { ensureDodoWebhook, fingerprintDodoWebhookReference } from "./lib/dodo-webhook-registration.mjs";
import { buildPaymentMutationChildEnvironment, assertDodoCanonicalRouteProbe, assertPaymentProviderMutationAdmission } from "./lib/payment-provider-mutation-admission.mjs";
import { assertProductionWorkerIdentityAdmission, buildWorkerBuildEnvironment, repositoryRoot } from "./lib/platform.mjs";
import { assertProductionWorkerUploadResult, buildProductionWorkerVersionMessage } from "./lib/release.mjs";
import { readStagingRepositoryState } from "./lib/staging-release.mjs";

const PROVIDER_TIMEOUT_MS = 15_000;
const WRANGLER_READ_TIMEOUT_MS = 60_000;
const MUTATION_TIMEOUT_MS = 10 * 60_000;

function runBounded(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    stdio: options.capture === false ? "inherit" : "pipe",
    timeout: options.timeout ?? WRANGLER_READ_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) throw new Error(options.issue ?? "command_failed");
  return { stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

function runWranglerBounded(args, options = {}) {
  return runBounded("npx", ["--no-install", "wrangler", ...args], options);
}

function boundedFetch(fetcher = globalThis.fetch, timeoutMs = PROVIDER_TIMEOUT_MS) {
  return (url, init = {}) => fetcher(url, {
    ...init,
    signal: globalThis.AbortSignal.timeout(timeoutMs),
  });
}

async function heartbeatResumeClaim(claim) {
  if (claim === null) return null;
  return renewDodoBootstrapResumeClaim(repositoryRoot, { claim: claim.claim, now: new Date() });
}

async function assertResumeClaim(claim) {
  if (claim === null) return;
  await assertDodoBootstrapResumeClaimOwnership(repositoryRoot, { claim: claim.claim, now: new Date() });
}

function parse(argv) {
  const options = {
    acknowledgeLive: false,
    bootstrapManifestPath: null,
    bootstrapManifestSha256: null,
    environment: null,
    evidencePath: ".wrangler/release/production-evidence.json",
    execute: false,
    manifestPath: null,
    manifestSha256: null,
    mode: "normal",
    reservationSha256: null,
    resumeBootstrap: false,
  };
  let modeSelected = false;
  const selectMode = (mode) => {
    if (modeSelected) throw new Error("dodo_webhook_mode_conflict");
    options.mode = mode;
    modeSelected = true;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") options.execute = true;
    else if (argument === "--ack-live") options.acknowledgeLive = true;
    else if (argument === "--bootstrap-candidate") selectMode("bootstrap");
    else if (argument === "--verify-bootstrap") selectMode("verify");
    else if (argument === "--record-bootstrap-rollback") selectMode("rollback");
    else if (argument === "--resume-bootstrap") options.resumeBootstrap = true;
    else if (argument === "--evidence") options.evidencePath = argv[++index] ?? "";
    else if (argument.startsWith("--evidence=")) options.evidencePath = argument.slice("--evidence=".length);
    else if (argument === "--bootstrap-manifest") options.bootstrapManifestPath = argv[++index] ?? "";
    else if (argument.startsWith("--bootstrap-manifest=")) options.bootstrapManifestPath = argument.slice("--bootstrap-manifest=".length);
    else if (argument === "--bootstrap-manifest-sha256") options.bootstrapManifestSha256 = argv[++index] ?? "";
    else if (argument.startsWith("--bootstrap-manifest-sha256=")) options.bootstrapManifestSha256 = argument.slice("--bootstrap-manifest-sha256=".length);
    else if (argument === "--release-manifest") options.manifestPath = argv[++index] ?? "";
    else if (argument.startsWith("--release-manifest=")) options.manifestPath = argument.slice("--release-manifest=".length);
    else if (argument === "--release-manifest-sha256") options.manifestSha256 = argv[++index] ?? "";
    else if (argument.startsWith("--release-manifest-sha256=")) options.manifestSha256 = argument.slice("--release-manifest-sha256=".length);
    else if (argument === "--reservation-sha256") options.reservationSha256 = argv[++index] ?? "";
    else if (argument.startsWith("--reservation-sha256=")) options.reservationSha256 = argument.slice("--reservation-sha256=".length);
    else if (argument === "--env=staging") options.environment = "staging";
    else if (argument === "--env=production") options.environment = "production";
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (options.environment === null) throw new Error("dodo_webhook_environment_required");
  if (options.mode !== "normal" && options.environment !== "production") throw new Error("dodo_webhook_bootstrap_production_only");
  if (options.execute && !options.acknowledgeLive && options.environment === "production") throw new Error("dodo_webhook_live_ack_required");
  if (options.mode === "normal" && options.execute && (options.manifestPath === null || options.manifestPath.length === 0)) throw new Error("dodo_webhook_release_manifest_required");
  if (options.resumeBootstrap && (options.mode !== "bootstrap" || options.reservationSha256 === null || options.reservationSha256.length === 0)) {
    throw new Error("dodo_webhook_bootstrap_resume_evidence_required");
  }
  if (new Set(["verify", "rollback"]).has(options.mode)
    && (options.bootstrapManifestPath === null || options.bootstrapManifestPath.length === 0
      || options.bootstrapManifestSha256 === null || options.bootstrapManifestSha256.length === 0
      || options.manifestPath === null || options.manifestPath.length === 0
      || options.manifestSha256 === null || options.manifestSha256.length === 0)) {
    throw new Error("dodo_webhook_bootstrap_evidence_required");
  }
  return options;
}

function safeError(error) {
  return error instanceof Error && /^[a-z0-9_:.-]{1,180}$/u.test(error.message)
    ? error.message
    : "dodo_webhook_registration_failed";
}

async function uploadRouteNeutralWorkerSecretVersion(apiKey, webhookSecret, childEnvironment, message, tag) {
  if (typeof apiKey !== "string" || apiKey.length < 16 || typeof webhookSecret !== "string" || webhookSecret.length < 16) {
    throw new Error("dodo_webhook_bootstrap_secret_input_invalid");
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "selinow-dodo-webhook-"));
  const secretFile = join(temporaryDirectory, "worker-secrets.json");
  try {
    await writeFile(secretFile, `${JSON.stringify({
      [DODO_BOOTSTRAP_API_KEY_SECRET_NAME]: apiKey,
      [DODO_BOOTSTRAP_WEBHOOK_SECRET_NAME]: webhookSecret,
    })}\n`, { flag: "wx", mode: 0o600 });
    await chmod(secretFile, 0o600);
    runWranglerBounded([
      "versions", "upload", "--env", "production", "--strict", "--secrets-file", secretFile,
      "--message", message, "--tag", tag,
    ], {
      capture: true,
      cwd: repositoryRoot,
      env: childEnvironment,
      issue: "dodo_webhook_worker_secret_version_failed",
      timeout: MUTATION_TIMEOUT_MS,
    });
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

function putWorkerSecret(environment, secret, childEnvironment) {
  if (environment === "production") throw new Error("dodo_webhook_production_bootstrap_required");
  const result = spawnSync("npx", ["--no-install", "wrangler", "secret", "put", DODO_BOOTSTRAP_WEBHOOK_SECRET_NAME, "--env", environment], {
    encoding: "utf8",
    input: `${secret}\n`,
    env: childEnvironment,
    stdio: ["pipe", "ignore", "pipe"],
    timeout: MUTATION_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) throw new Error("dodo_webhook_worker_secret_failed");
}

async function privateJson(path, issue) {
  return readCanonicalPrivateJson(
    repositoryRoot,
    path,
    ".wrangler/release/production-evidence.json",
    issue,
  );
}

async function productionWorkerAdmission(wrangler, infrastructureAdmissionMode = "exact") {
  const [productionSpec, stagingSpec] = await Promise.all([
    readFile(resolve(repositoryRoot, "infra/environments/production.json"), "utf8").then(JSON.parse),
    readFile(resolve(repositoryRoot, "infra/environments/staging.json"), "utf8").then(JSON.parse),
  ]);
  return assertProductionWorkerIdentityAdmission({
    environment: process.env,
    productionSpec,
    repositoryRoot,
    requireCurrentWorkerVersion: true,
    stagingSpec,
    infrastructureAdmissionMode,
    runWranglerImplementation: runWranglerBounded,
    wranglerConfig: wrangler,
  });
}

function workerVersionView(version, childEnvironment) {
  const result = runWranglerBounded(["versions", "view", version, "--env", "production", "--json"], {
    capture: true,
    cwd: repositoryRoot,
    env: childEnvironment,
    issue: "dodo_webhook_bootstrap_version_view_unavailable",
    timeout: WRANGLER_READ_TIMEOUT_MS,
  });
  try { return JSON.parse(result.stdout); } catch { throw new Error("dodo_webhook_bootstrap_version_view_invalid"); }
}

async function endpointContract(wrangler, environment) {
  const vars = wrangler.env?.[environment]?.vars;
  const apiOrigin = vars?.API_ORIGIN;
  const publicId = vars?.DODO_PAYMENTS_WEBHOOK_PUBLIC_ID;
  const providerEnvironment = vars?.DODO_PAYMENTS_ENVIRONMENT;
  if (typeof apiOrigin !== "string" || typeof publicId !== "string" || !/^(?:ddowh|dodow)_[0-9a-f-]{36}$/u.test(publicId)) throw new Error("dodo_webhook_runtime_contract_invalid");
  if ((environment === "staging" && providerEnvironment !== "test_mode") || (environment === "production" && providerEnvironment !== "live_mode")) throw new Error("dodo_webhook_provider_environment_invalid");
  return {
    apiBaseUrl: providerEnvironment === "live_mode" ? "https://live.dodopayments.com" : "https://test.dodopayments.com",
    endpointUrl: `${apiOrigin.replace(/\/+$/u, "")}/api/webhooks/billing/dodo/${publicId}`,
    providerEnvironment,
  };
}

async function executeNormal(options, contract) {
  if (options.environment === "production") throw new Error("dodo_webhook_production_bootstrap_required");
  const admission = await assertPaymentProviderMutationAdmission({ environment: options.environment, manifestPath: options.manifestPath });
  const apiKey = process.env.DODO_PAYMENTS_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length < 16) throw new Error("dodo_webhook_api_key_required");
  const requestId = `dodo-webhook-probe-${admission.releaseId.replace(/[^A-Za-z0-9._-]/gu, "-")}`.slice(0, 120);
  const providerFetch = boundedFetch();
  const probe = await providerFetch(contract.endpointUrl, { body: "{}", headers: { "Content-Type": "application/json", "X-Request-Id": requestId }, method: "POST", redirect: "manual" });
  let probePayload;
  try { probePayload = await probe.json(); } catch { throw new Error("dodo_webhook_route_contract_invalid"); }
  assertDodoCanonicalRouteProbe(probe, probePayload, requestId);
  const result = await ensureDodoWebhook({ ...contract, apiKey, fetcher: providerFetch });
  putWorkerSecret(options.environment, result.secret, admission.childEnvironment);
  return { created: result.created, endpointFingerprintSha256: result.endpointFingerprintSha256, environment: options.environment, providerWebhookFingerprintSha256: result.providerWebhookFingerprintSha256, workerSecretName: DODO_BOOTSTRAP_WEBHOOK_SECRET_NAME };
}

async function executeBootstrap(options, contract, wrangler) {
  const evidence = await privateJson(options.evidencePath, "dodo_webhook_bootstrap_release_evidence_invalid");
  const repository = readStagingRepositoryState(repositoryRoot);
  const before = await productionWorkerAdmission(wrangler, "pre_candidate");
  const admission = assertDodoBootstrapCandidateAdmission({ evidence, repository, worker: before });
  const reservationRef = `.wrangler/releases/${admission.releaseId}/${DODO_BOOTSTRAP_ARTIFACT_FILES.reservation}`;
  let reservation;
  let reservationArtifactSha256;
  let resumeClaim = null;
  if (options.resumeBootstrap) {
    const loaded = await readPrivateDodoArtifact(
      repositoryRoot,
      reservationRef,
      DODO_BOOTSTRAP_ARTIFACT_FILES.reservation,
      options.reservationSha256,
    );
    reservation = loaded.value;
    reservationArtifactSha256 = loaded.artifactSha256;
    if (reservation.state?.status !== "failed_recoverable"
      || reservation.release?.releaseId !== admission.releaseId
      || reservation.release?.commitSha !== admission.commitSha
      || reservation.release?.treeSha !== admission.treeSha
      || reservation.release?.candidateSourceWorkerVersion !== admission.candidateSourceWorkerVersion
      || reservation.worker?.accountId !== admission.accountId
      || reservation.worker?.workerName !== admission.workerName) {
      throw new Error("dodo_webhook_bootstrap_resume_binding_mismatch");
    }
    resumeClaim = await acquireDodoBootstrapResumeClaim(repositoryRoot, {
      now: new Date(),
      releaseId: admission.releaseId,
      reservationId: reservation.reservationId,
      reservationSha256: reservationArtifactSha256,
    });
  } else {
    reservation = buildDodoBootstrapReservation({
      admission,
      beforeWorkerVersionIds: before.deployableWorkerVersionIds,
      observedAt: new Date().toISOString(),
    });
    const reserved = await writePrivateDodoArtifact(repositoryRoot, admission.releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, reservation);
    reservationArtifactSha256 = reserved.artifactSha256;
  }
  try {
    if (options.resumeBootstrap) {
      resumeClaim = await heartbeatResumeClaim(resumeClaim);
      reservation = updateDodoBootstrapReservation(reservation, {
        observedAt: new Date().toISOString(),
        state: { cleanupRequired: false, lastErrorCode: null, status: "in_progress" },
      });
      const updated = await replacePrivateDodoArtifact(repositoryRoot, admission.releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, reservation, reservationArtifactSha256);
      reservationArtifactSha256 = updated.artifactSha256;
      await assertResumeClaim(resumeClaim);
    }
    const apiKey = process.env.DODO_PAYMENTS_API_KEY;
    if (typeof apiKey !== "string" || apiKey.length < 16) throw new Error("dodo_webhook_api_key_required");
    const childEnvironment = buildPaymentMutationChildEnvironment(process.env, admission.accountId);
    resumeClaim = await heartbeatResumeClaim(resumeClaim);
    const sourceVersion = workerVersionView(admission.candidateSourceWorkerVersion, childEnvironment);
    await assertResumeClaim(resumeClaim);
    resumeClaim = await heartbeatResumeClaim(resumeClaim);
    runBounded("npm", ["run", "build"], {
      capture: false,
      cwd: repositoryRoot,
      env: buildWorkerBuildEnvironment(process.env, "production"),
      issue: "dodo_webhook_bootstrap_build_failed",
      timeout: MUTATION_TIMEOUT_MS,
    });
    await assertResumeClaim(resumeClaim);
    reservation = updateDodoBootstrapReservation(reservation, {
      observedAt: new Date().toISOString(),
      state: { phase: "provider_mutation_pending", providerEndpointMayExist: true },
    });
    let updatedReservation = await replacePrivateDodoArtifact(repositoryRoot, admission.releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, reservation, reservationArtifactSha256);
    reservationArtifactSha256 = updatedReservation.artifactSha256;
    const providerFetch = boundedFetch();
    resumeClaim = await heartbeatResumeClaim(resumeClaim);
    await inspectDodoWebhookEndpoint({ ...contract, apiKey, fetcher: providerFetch });
    await assertResumeClaim(resumeClaim);
    resumeClaim = await heartbeatResumeClaim(resumeClaim);
    const registered = await ensureDodoWebhook({ ...contract, apiKey, fetcher: providerFetch });
    await assertResumeClaim(resumeClaim);
    resumeClaim = await heartbeatResumeClaim(resumeClaim);
    await inspectDodoWebhookEndpoint({ ...contract, apiKey, fetcher: providerFetch });
    await assertResumeClaim(resumeClaim);
    reservation = updateDodoBootstrapReservation(reservation, {
      observedAt: new Date().toISOString(),
      state: {
        phase: "provider_registered",
        providerWebhookFingerprintSha256: registered.providerWebhookFingerprintSha256,
      },
    });
    updatedReservation = await replacePrivateDodoArtifact(repositoryRoot, admission.releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, reservation, reservationArtifactSha256);
    reservationArtifactSha256 = updatedReservation.artifactSha256;

    resumeClaim = await heartbeatResumeClaim(resumeClaim);
    let current = await productionWorkerAdmission(wrangler, "pre_candidate");
    await assertResumeClaim(resumeClaim);
    if (current.currentWorkerVersion !== before.currentWorkerVersion) throw new Error("dodo_webhook_bootstrap_changed_active_version");
    const baselineIds = new Set(reservation.worker.beforeWorkerVersionIds);
    let additions = current.deployableWorkerVersionInventory.filter((entry) => !baselineIds.has(entry.id));
    if (additions.length === 0) {
      reservation = updateDodoBootstrapReservation(reservation, {
        observedAt: new Date().toISOString(),
        state: { candidateVersionMayExist: true, phase: "version_upload_pending" },
      });
      updatedReservation = await replacePrivateDodoArtifact(repositoryRoot, admission.releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, reservation, reservationArtifactSha256);
      reservationArtifactSha256 = updatedReservation.artifactSha256;
      const tag = `dodo-secret-${admission.releaseId}`.slice(0, 80);
      resumeClaim = await heartbeatResumeClaim(resumeClaim);
      await uploadRouteNeutralWorkerSecretVersion(apiKey, registered.secret, childEnvironment, buildProductionWorkerVersionMessage(admission.binding), tag);
      await assertResumeClaim(resumeClaim);
      resumeClaim = await heartbeatResumeClaim(resumeClaim);
      current = await productionWorkerAdmission(wrangler, "pre_candidate");
      await assertResumeClaim(resumeClaim);
      if (current.currentWorkerVersion !== before.currentWorkerVersion) throw new Error("dodo_webhook_bootstrap_changed_active_version");
      additions = current.deployableWorkerVersionInventory.filter((entry) => !baselineIds.has(entry.id));
    }
    if (additions.length !== 1) throw new Error("dodo_webhook_bootstrap_recovery_version_ambiguous");
    const baseline = current.deployableWorkerVersionInventory.filter((entry) => baselineIds.has(entry.id));
    const uploaded = assertProductionWorkerUploadResult({
      after: current.deployableWorkerVersionInventory,
      before: baseline,
      expectedBinding: admission.binding,
    });
    resumeClaim = await heartbeatResumeClaim(resumeClaim);
    const candidateVersion = workerVersionView(uploaded.workerVersion, childEnvironment);
    await assertResumeClaim(resumeClaim);
    assertDodoSecretVersionClone({
      candidateVersion,
      candidateWorkerVersion: uploaded.workerVersion,
      sourceVersion,
      sourceWorkerVersion: admission.candidateSourceWorkerVersion,
    });
    reservation = updateDodoBootstrapReservation(reservation, {
      observedAt: new Date().toISOString(),
      state: { candidateWorkerVersion: uploaded.workerVersion, phase: "version_uploaded" },
    });
    updatedReservation = await replacePrivateDodoArtifact(repositoryRoot, admission.releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, reservation, reservationArtifactSha256);
    reservationArtifactSha256 = updatedReservation.artifactSha256;
    const artifact = buildDodoBootstrapArtifact({
      admission,
      apiKeyFingerprintSha256: fingerprintDodoBootstrapApiKey(apiKey),
      candidateWorkerVersion: uploaded.workerVersion,
      created: registered.created,
      endpointFingerprintSha256: registered.endpointFingerprintSha256,
      observedAt: new Date().toISOString(),
      providerWebhookFingerprintSha256: registered.providerWebhookFingerprintSha256,
    });
    let written;
    try {
      written = await writePrivateDodoArtifact(repositoryRoot, admission.releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap, artifact);
    } catch (error) {
      if (!(options.resumeBootstrap && error instanceof Error && error.message === "dodo_webhook_bootstrap_replay")) throw error;
      const existing = await readPrivateDodoArtifact(
        repositoryRoot,
        `.wrangler/releases/${admission.releaseId}/${DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap}`,
        DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap,
      );
      const existingArtifact = assertDodoBootstrapArtifact(existing.value);
      if (existingArtifact.release.candidateWorkerVersion !== uploaded.workerVersion
        || existingArtifact.provider.endpointFingerprintSha256 !== registered.endpointFingerprintSha256
        || existingArtifact.provider.providerWebhookFingerprintSha256 !== registered.providerWebhookFingerprintSha256
        || existingArtifact.release.commitSha !== admission.commitSha
        || existingArtifact.release.treeSha !== admission.treeSha) {
        throw new Error("dodo_webhook_bootstrap_recovery_artifact_conflict", { cause: error });
      }
      written = { artifactSha256: existing.artifactSha256, evidenceRef: existing.evidenceRef };
    }
    reservation = updateDodoBootstrapReservation(reservation, {
      observedAt: new Date().toISOString(),
      state: {
        bootstrapArtifactSha256: written.artifactSha256,
        bootstrapEvidenceRef: written.evidenceRef,
        cleanupRequired: false,
        phase: "completed",
        status: "completed",
      },
    });
    const reservationWritten = await replacePrivateDodoArtifact(repositoryRoot, admission.releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, reservation, reservationArtifactSha256);
    reservationArtifactSha256 = reservationWritten.artifactSha256;
    await assertResumeClaim(resumeClaim);
    return {
      artifactSha256: written.artifactSha256,
      candidateWorkerVersion: uploaded.workerVersion,
      checkoutActivationAuthorized: false,
      endpointFingerprintSha256: registered.endpointFingerprintSha256,
      environment: "production",
      evidenceRef: written.evidenceRef,
      providerWebhookFingerprintSha256: registered.providerWebhookFingerprintSha256,
      reservationEvidenceRef: reservationWritten.evidenceRef,
      reservationSha256: reservationWritten.artifactSha256,
      routeMutationPerformed: false,
      workerSecretNames: [DODO_BOOTSTRAP_API_KEY_SECRET_NAME, DODO_BOOTSTRAP_WEBHOOK_SECRET_NAME],
    };
  } catch (error) {
    if (resumeClaim !== null) {
      try { await assertResumeClaim(resumeClaim); } catch (ownershipError) {
        throw new Error("dodo_webhook_bootstrap_resume_claim_ownership_lost", { cause: ownershipError });
      }
    }
    const failureCode = safeError(error);
    reservation = updateDodoBootstrapReservation(reservation, {
      observedAt: new Date().toISOString(),
      state: {
        cleanupRequired: reservation.state.providerEndpointMayExist || reservation.state.candidateVersionMayExist,
        lastErrorCode: failureCode,
        phase: "failed",
        status: "failed_recoverable",
      },
    });
    await replacePrivateDodoArtifact(repositoryRoot, admission.releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, reservation, reservationArtifactSha256);
    throw error;
  } finally {
    if (resumeClaim !== null) await releaseDodoBootstrapResumeClaim(repositoryRoot, resumeClaim);
  }
}

async function boundBootstrapInput(options, wrangler, mode) {
  const bootstrapLoaded = await readPrivateDodoArtifact(
    repositoryRoot,
    options.bootstrapManifestPath,
    DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap,
    options.bootstrapManifestSha256,
  );
  const bootstrap = bootstrapLoaded.value;
  if (bootstrapLoaded.releaseId !== bootstrap.release?.releaseId || options.manifestPath !== bootstrap.release?.manifestRef) {
    throw new Error("dodo_webhook_bootstrap_manifest_path_binding_mismatch");
  }
  const manifestLoaded = await readPrivateDodoArtifact(
    repositoryRoot,
    options.manifestPath,
    "release-manifest.json",
    options.manifestSha256,
  );
  if (manifestLoaded.releaseId !== bootstrap.release.releaseId) throw new Error("dodo_webhook_bootstrap_manifest_path_binding_mismatch");
  const manifest = manifestLoaded.value;
  const repository = readStagingRepositoryState(repositoryRoot);
  const worker = await productionWorkerAdmission(wrangler);
  assertDodoBootstrapReleaseBinding({ artifact: bootstrap, manifest, mode, repository, worker });
  return {
    bootstrap,
    bootstrapArtifactSha256: bootstrapLoaded.artifactSha256,
    manifest,
    manifestSha256: manifestLoaded.artifactSha256,
    worker,
  };
}

async function executeVerify(options, contract, wrangler) {
  const { bootstrap, bootstrapArtifactSha256, manifestSha256 } = await boundBootstrapInput(options, wrangler, "candidate_active");
  const apiKey = process.env.DODO_PAYMENTS_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length < 16) throw new Error("dodo_webhook_api_key_required");
  if (fingerprintDodoBootstrapApiKey(apiKey) !== bootstrap.provider.apiKeyFingerprintSha256) {
    throw new Error("dodo_webhook_bootstrap_api_key_binding_mismatch");
  }
  const providerFetch = boundedFetch();
  const secret = await readDodoWebhookSigningSecret({ ...contract, apiKey, fetcher: providerFetch });
  const requestId = `dodo-signed-health-${bootstrap.release.releaseId}`.slice(0, 120);
  const signed = buildDodoSignedHealthProbe({ requestId, secret, timestamp: Math.floor(Date.now() / 1000) });
  const response = await providerFetch(contract.endpointUrl, { body: signed.body, headers: signed.headers, method: "POST", redirect: "manual" });
  let payload;
  try { payload = await response.json(); } catch { throw new Error("dodo_webhook_signed_health_invalid"); }
  assertDodoSignedHealthProbe(response, payload, requestId);
  const artifact = buildDodoBootstrapHealthArtifact({
    bootstrap,
    bootstrapArtifactSha256,
    observedAt: new Date().toISOString(),
    releaseManifestSha256: manifestSha256,
  });
  const written = await writePrivateDodoArtifact(repositoryRoot, bootstrap.release.releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.health, artifact);
  return {
    artifactSha256: written.artifactSha256,
    checkoutActivationAuthorized: false,
    environment: "production",
    evidenceRef: written.evidenceRef,
    separateReleaseAcceptanceRequired: true,
    signedWebhookHealthProven: true,
    workerSecretNames: [DODO_BOOTSTRAP_API_KEY_SECRET_NAME, DODO_BOOTSTRAP_WEBHOOK_SECRET_NAME],
  };
}

async function executeRollback(options, wrangler) {
  const { bootstrap, bootstrapArtifactSha256, manifestSha256, worker } = await boundBootstrapInput(options, wrangler, "pre_candidate");
  const artifact = buildDodoBootstrapRollbackArtifact({
    bootstrap,
    bootstrapArtifactSha256,
    observedAt: new Date().toISOString(),
    releaseManifestSha256: manifestSha256,
    worker,
  });
  const written = await writePrivateDodoArtifact(repositoryRoot, bootstrap.release.releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.rollback, artifact);
  return {
    artifactSha256: written.artifactSha256,
    checkoutActivationAuthorized: false,
    environment: "production",
    evidenceRef: written.evidenceRef,
    providerCleanupRequired: true,
    rollbackObserved: true,
  };
}

try {
  const options = parse(process.argv.slice(2));
  const wrangler = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  const contract = await endpointContract(wrangler, options.environment);
  if (!options.execute) {
    const action = options.mode === "normal" ? "would_register_and_store_signing_key"
      : options.mode === "bootstrap" ? "would_register_and_create_route_neutral_secret_version"
        : options.mode === "verify" ? "would_verify_candidate_bound_signed_webhook_health"
          : "would_record_candidate_bootstrap_rollback";
    process.stdout.write(`${JSON.stringify({
      action,
      checkoutActivationAuthorized: false,
      endpointFingerprintSha256: fingerprintDodoWebhookReference("endpoint", contract.endpointUrl),
      environment: options.environment,
      providerEnvironment: contract.providerEnvironment,
      routeMutationPerformed: false,
      workerSecretNames: options.mode === "normal"
        ? [DODO_BOOTSTRAP_WEBHOOK_SECRET_NAME]
        : [DODO_BOOTSTRAP_API_KEY_SECRET_NAME, DODO_BOOTSTRAP_WEBHOOK_SECRET_NAME],
    }, null, 2)}\n`);
  } else {
    const result = options.mode === "normal" ? await executeNormal(options, contract)
      : options.mode === "bootstrap" ? await executeBootstrap(options, contract, wrangler)
        : options.mode === "verify" ? await executeVerify(options, contract, wrangler)
          : await executeRollback(options, wrangler);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
}
