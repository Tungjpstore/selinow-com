import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertDodoBootstrapCandidateAdmission,
  assertDodoBootstrapResumeClaimOwnership,
  assertDodoBootstrapReleaseBinding,
  assertDodoSecretVersionClone,
  assertDodoSignedHealthProbe,
  assertDodoWebhookEndpointInventory,
  acquireDodoBootstrapResumeClaim,
  buildDodoBootstrapArtifact,
  buildDodoBootstrapReservation,
  buildDodoBootstrapRollbackArtifact,
  buildDodoSignedHealthProbe,
  DODO_BOOTSTRAP_ARTIFACT_FILES,
  DODO_BOOTSTRAP_SECRET_NAMES,
  fingerprintDodoBootstrapApiKey,
  readCanonicalPrivateJson,
  readPrivateDodoArtifact,
  releaseDodoBootstrapResumeClaim,
  replacePrivateDodoArtifact,
  renewDodoBootstrapResumeClaim,
  updateDodoBootstrapReservation,
  writePrivateDodoArtifact,
} from "../../scripts/lib/dodo-webhook-bootstrap.mjs";
import { assertDodoCanonicalRouteProbe } from "../../scripts/lib/payment-provider-mutation-admission.mjs";

const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const rollbackCommitSha = "c".repeat(40);
const rollbackTreeSha = "d".repeat(40);
const releaseId = "release_20260811_bootstrap";
const previousWorkerVersion = "11111111-1111-4111-8111-111111111111";
const sourceWorkerVersion = "22222222-2222-4222-8222-222222222222";
const candidateWorkerVersion = "33333333-3333-4333-8333-333333333333";
const rollbackWorkerVersion = "44444444-4444-4444-8444-444444444444";
const manifestRef = `.wrangler/releases/${releaseId}/release-manifest.json`;
const endpointUrl = "https://api.selinow.com/api/webhooks/billing/dodo/ddowh_00000000-0000-4000-8000-000000000001";

const evidence = {
  candidateWorkerVersion: sourceWorkerVersion,
  commitSha,
  environment: "production",
  previousWorkerVersion,
  releaseId,
  rollback: {
    candidate: {
      commitSha: rollbackCommitSha,
      treeSha: rollbackTreeSha,
      workerVersion: rollbackWorkerVersion,
    },
  },
  schemaVersion: 2,
  treeSha,
};

function versionBinding(role: "candidate" | "rollback", rollback = false) {
  return {
    commitSha: rollback ? rollbackCommitSha : commitSha,
    manifestRef,
    manifestSha256: null,
    releaseId,
    role,
    treeSha: rollback ? rollbackTreeSha : treeSha,
  };
}

function worker(currentWorkerVersion = previousWorkerVersion) {
  return {
    accountId: "e".repeat(32),
    currentWorkerVersion,
    deployableWorkerVersionIds: [previousWorkerVersion, sourceWorkerVersion, candidateWorkerVersion, rollbackWorkerVersion],
    deployableWorkerVersionInventory: [
      { binding: null, id: previousWorkerVersion },
      { binding: versionBinding("candidate"), id: sourceWorkerVersion },
      { binding: versionBinding("candidate"), id: candidateWorkerVersion },
      { binding: versionBinding("rollback", true), id: rollbackWorkerVersion },
    ],
    ok: true,
    workerName: "selinow-com-production",
  };
}

function bootstrap() {
  const admission = assertDodoBootstrapCandidateAdmission({
    evidence,
    repository: { clean: true, commitSha, treeSha },
    worker: worker(),
  });
  return buildDodoBootstrapArtifact({
    admission,
    apiKeyFingerprintSha256: fingerprintDodoBootstrapApiKey("dodo_live_approved_key_material"),
    candidateWorkerVersion,
    created: true,
    endpointFingerprintSha256: "f".repeat(64),
    observedAt: "2026-08-11T06:00:00.000Z",
    providerWebhookFingerprintSha256: "9".repeat(64),
  });
}

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Dodo production webhook bootstrap", () => {
  it("keeps the normal registration probe fail-closed on the old 404 runtime", () => {
    const requestId = "dodo-webhook-probe-release";
    const response = {
      headers: new Headers({ "Cache-Control": "private, no-store, max-age=0", "X-Request-Id": requestId }),
      redirected: false,
      status: 404,
      url: endpointUrl,
    } as unknown as Response;
    expect(() => { assertDodoCanonicalRouteProbe(response, { code: "webhook_not_found", ok: false, requestId }, requestId); })
      .toThrow("dodo_webhook_route_contract_invalid");
  });

  it("rejects a conflicting canonical endpoint instead of creating another webhook", () => {
    expect(() => { assertDodoWebhookEndpointInventory({
      items: [{ id: "wh_existing", url: endpointUrl.replace(/0001$/u, "0002") }],
    }, endpointUrl); }).toThrow("dodo_webhook_endpoint_conflict");
  });

  it("creates a route-neutral clone containing only the new secret binding", () => {
    const commonBindings = [{ name: "PLATFORM_DB", namespace_id: "db", type: "d1" }];
    const apiKeyBinding = { name: "DODO_PAYMENTS_API_KEY", type: "secret_text" };
    expect(() => { assertDodoSecretVersionClone({
      candidateVersion: {
        id: candidateWorkerVersion,
        resources: { bindings: [...commonBindings, apiKeyBinding, { name: "DODO_PAYMENTS_WEBHOOK_KEY", type: "secret_text" }], script: { etag: "same-code" } },
      },
      candidateWorkerVersion,
      sourceVersion: { id: sourceWorkerVersion, resources: { bindings: [...commonBindings, apiKeyBinding], script: { etag: "same-code" } } },
      sourceWorkerVersion,
    }); }).not.toThrow();
    expect(() => { assertDodoSecretVersionClone({
      candidateVersion: {
        id: candidateWorkerVersion,
        resources: { bindings: [...commonBindings, { name: "DODO_PAYMENTS_WEBHOOK_KEY", type: "secret_text" }], script: { etag: "same-code" } },
      },
      candidateWorkerVersion,
      sourceVersion: { id: sourceWorkerVersion, resources: { bindings: [...commonBindings, apiKeyBinding], script: { etag: "same-code" } } },
      sourceWorkerVersion,
    }); }).toThrow("dodo_webhook_bootstrap_secret_binding_invalid");
    expect(() => { assertDodoSecretVersionClone({
      candidateVersion: {
        id: candidateWorkerVersion,
        resources: { bindings: [...commonBindings, apiKeyBinding, { name: "DODO_PAYMENTS_WEBHOOK_KEY", type: "secret_text" }], script: { etag: "different-code" } },
      },
      candidateWorkerVersion,
      sourceVersion: { id: sourceWorkerVersion, resources: { bindings: [...commonBindings, apiKeyBinding], script: { etag: "same-code" } } },
      sourceWorkerVersion,
    }); }).toThrow("dodo_webhook_bootstrap_version_clone_mismatch");
  });

  it("rejects bootstrap replay and retains a private name-only artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-bootstrap-"));
    temporaryRoots.push(root);
    const artifact = bootstrap();
    const first = await writePrivateDodoArtifact(root, releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap, artifact);
    await expect(writePrivateDodoArtifact(root, releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap, artifact))
      .rejects.toThrow("dodo_webhook_bootstrap_replay");
    const path = join(root, first.evidenceRef);
    expect((await stat(path)).mode & 0o077).toBe(0);
    const text = await readFile(path, "utf8");
    expect(text).toContain('"secretNames": [');
    expect(artifact.worker.secretNames).toEqual(DODO_BOOTSTRAP_SECRET_NAMES);
    expect(artifact.provider.apiKeyFingerprintSha256).toBe(fingerprintDodoBootstrapApiKey("dodo_live_approved_key_material"));
    expect(text).not.toMatch(/whsec_|Bearer |webhook_secret/iu);
  });

  it("rejects the wrong release or candidate version during signed-health admission", () => {
    const artifact = bootstrap();
    const manifest = {
      candidateWorkerVersion,
      commitSha,
      environment: "production",
      previousWorkerVersion,
      releaseId,
      rollbackCandidate: { commitSha: rollbackCommitSha, treeSha: rollbackTreeSha, workerVersion: rollbackWorkerVersion },
      schemaVersion: 2,
      treeSha,
    };
    expect(() => assertDodoBootstrapReleaseBinding({
      artifact,
      manifest: { ...manifest, releaseId: "release_wrong_20260811" },
      repository: { clean: true, commitSha, treeSha },
      worker: worker(candidateWorkerVersion),
    })).toThrow("dodo_webhook_bootstrap_release_binding_mismatch");
    expect(() => assertDodoBootstrapReleaseBinding({
      artifact,
      manifest: { ...manifest, candidateWorkerVersion: sourceWorkerVersion },
      repository: { clean: true, commitSha, treeSha },
      worker: worker(candidateWorkerVersion),
    })).toThrow("dodo_webhook_bootstrap_release_binding_mismatch");
  });

  it("proves the signing key with a harmless invalid payload contract", () => {
    const requestId = "dodo-signed-health-release";
    const probe = buildDodoSignedHealthProbe({
      requestId,
      secret: "whsec_dGVzdC13ZWJob29rLXNlY3JldA==",
      timestamp: 1_786_422_400,
    });
    expect(probe.body).toBe("{");
    expect(probe.headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/=]+$/u);
    const response = {
      headers: new Headers({ "Cache-Control": "private, no-store, max-age=0", "X-Request-Id": requestId }),
      redirected: false,
      status: 400,
      url: endpointUrl,
    } as unknown as Response;
    expect(() => { assertDodoSignedHealthProbe(response, {
      code: "billing_webhook_invalid",
      issues: ["json_invalid"],
      ok: false,
      requestId,
    }, requestId); }).not.toThrow();
    expect(() => { assertDodoSignedHealthProbe(response, {
      code: "billing_webhook_invalid",
      details: ["json_invalid"],
      ok: false,
      requestId,
    }, requestId); }).toThrow("dodo_webhook_signed_health_invalid");
  });

  it("records rollback only after the previous Worker version is active again", () => {
    const artifact = bootstrap();
    expect(() => buildDodoBootstrapRollbackArtifact({
      bootstrap: artifact,
      bootstrapArtifactSha256: "1".repeat(64),
      observedAt: "2026-08-11T06:05:00.000Z",
      releaseManifestSha256: "2".repeat(64),
      worker: worker(candidateWorkerVersion),
    })).toThrow("dodo_webhook_bootstrap_rollback_not_observed");
    expect(buildDodoBootstrapRollbackArtifact({
      bootstrap: artifact,
      bootstrapArtifactSha256: "1".repeat(64),
      observedAt: "2026-08-11T06:05:00.000Z",
      releaseManifestSha256: "2".repeat(64),
      worker: worker(previousWorkerVersion),
    })).toMatchObject({
      gates: { checkoutActivationAuthorized: false, providerCleanupRequired: true },
      worker: { activeWorkerVersion: previousWorkerVersion },
    });
  });

  it("reserves bootstrap atomically before mutations and records recoverable failure state", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-reservation-"));
    temporaryRoots.push(root);
    const admission = assertDodoBootstrapCandidateAdmission({
      evidence,
      repository: { clean: true, commitSha, treeSha },
      worker: worker(),
    });
    const reservation = buildDodoBootstrapReservation({
      admission,
      beforeWorkerVersionIds: worker().deployableWorkerVersionIds,
      observedAt: "2026-08-11T06:00:00.000Z",
    });
    const writes = await Promise.allSettled([
      writePrivateDodoArtifact(root, releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, reservation),
      writePrivateDodoArtifact(root, releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, reservation),
    ]);
    expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(writes.find((result) => result.status === "rejected")).toMatchObject({ reason: { message: "dodo_webhook_bootstrap_replay" } });
    expect(reservation.state).toMatchObject({
      cleanupRequired: false,
      phase: "reserved",
      retryMode: "explicit_same_binding_only",
      status: "in_progress",
    });
    expect(updateDodoBootstrapReservation(reservation, {
      observedAt: "2026-08-11T06:01:00.000Z",
      state: {
        candidateVersionMayExist: true,
        cleanupRequired: true,
        lastErrorCode: "command_failed",
        phase: "failed",
        providerEndpointMayExist: true,
        status: "failed_recoverable",
      },
    }).state).toMatchObject({
      candidateVersionMayExist: true,
      cleanupRequired: true,
      lastErrorCode: "command_failed",
      providerEndpointMayExist: true,
      retryMode: "explicit_same_binding_only",
      status: "failed_recoverable",
    });
  });

  it("requires canonical repository-relative artifact paths and exact hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-canonical-"));
    temporaryRoots.push(root);
    const artifact = bootstrap();
    const written = await writePrivateDodoArtifact(root, releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap, artifact);
    await expect(readPrivateDodoArtifact(
      root,
      written.evidenceRef,
      DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap,
      written.artifactSha256,
    )).resolves.toMatchObject({ releaseId, value: artifact });
    await expect(readPrivateDodoArtifact(
      root,
      join(root, written.evidenceRef),
      DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap,
      written.artifactSha256,
    )).rejects.toThrow("dodo_webhook_bootstrap_artifact_path_invalid");
    await expect(readPrivateDodoArtifact(
      root,
      written.evidenceRef,
      DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap,
      "0".repeat(64),
    )).rejects.toThrow("dodo_webhook_bootstrap_artifact_hash_mismatch");
  });

  it("uses exact reservation CAS so a stale owner cannot overwrite and a fixed temp file cannot wedge", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-reservation-cas-"));
    temporaryRoots.push(root);
    const admission = assertDodoBootstrapCandidateAdmission({
      evidence,
      repository: { clean: true, commitSha, treeSha },
      worker: worker(),
    });
    const reservation = buildDodoBootstrapReservation({
      admission,
      beforeWorkerVersionIds: worker().deployableWorkerVersionIds,
      observedAt: "2026-08-11T06:00:00.000Z",
    });
    const written = await writePrivateDodoArtifact(root, releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, reservation);
    const reservationPath = join(root, written.evidenceRef);
    await writeFile(`${reservationPath}.next`, "stale fixed temp\n", { mode: 0o600 });
    const updatedReservation = updateDodoBootstrapReservation(reservation, {
      observedAt: "2026-08-11T06:01:00.000Z",
      state: { phase: "provider_mutation_pending", providerEndpointMayExist: true },
    });
    const updated = await replacePrivateDodoArtifact(
      root,
      releaseId,
      DODO_BOOTSTRAP_ARTIFACT_FILES.reservation,
      updatedReservation,
      written.artifactSha256,
    );
    await expect(replacePrivateDodoArtifact(
      root,
      releaseId,
      DODO_BOOTSTRAP_ARTIFACT_FILES.reservation,
      reservation,
      written.artifactSha256,
    )).rejects.toThrow("dodo_webhook_bootstrap_artifact_cas_mismatch");
    await expect(readPrivateDodoArtifact(
      root,
      updated.evidenceRef,
      DODO_BOOTSTRAP_ARTIFACT_FILES.reservation,
      updated.artifactSha256,
    )).resolves.toMatchObject({ value: updatedReservation });
    const names = await readdir(join(root, ".wrangler", "releases", releaseId));
    expect(names).toContain(`${DODO_BOOTSTRAP_ARTIFACT_FILES.reservation}.next`);
    expect(names.filter((name) => name.includes(".next-")).length).toBe(0);
  });

  it("rejects symlinked artifact, reservation, claim, and production-evidence paths", async () => {
    const external = await mkdtemp(join(tmpdir(), "selinow-dodo-symlink-external-"));
    temporaryRoots.push(external);
    const externalFile = join(external, "private.json");
    await writeFile(externalFile, "{}\n", { mode: 0o600 });

    for (const filename of [DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation]) {
      const root = await mkdtemp(join(tmpdir(), "selinow-dodo-file-symlink-"));
      temporaryRoots.push(root);
      const written = await writePrivateDodoArtifact(root, releaseId, filename, {});
      const path = join(root, written.evidenceRef);
      await rm(path);
      await symlink(externalFile, path);
      await expect(readPrivateDodoArtifact(root, written.evidenceRef, filename))
        .rejects.toThrow("dodo_webhook_bootstrap_artifact_permissions_invalid");

      const ancestorRoot = await mkdtemp(join(tmpdir(), "selinow-dodo-ancestor-symlink-"));
      temporaryRoots.push(ancestorRoot);
      await symlink(external, join(ancestorRoot, ".wrangler"));
      await expect(writePrivateDodoArtifact(ancestorRoot, releaseId, filename, {}))
        .rejects.toThrow("dodo_webhook_bootstrap_artifact_ancestor_invalid");
    }

    const claimRoot = await mkdtemp(join(tmpdir(), "selinow-dodo-claim-ancestor-symlink-"));
    temporaryRoots.push(claimRoot);
    await symlink(external, join(claimRoot, ".wrangler"));
    await expect(acquireDodoBootstrapResumeClaim(claimRoot, {
      now: new Date("2026-08-11T06:00:00.000Z"),
      releaseId,
      reservationId: "4".repeat(64),
      reservationSha256: "5".repeat(64),
    })).rejects.toThrow("dodo_webhook_bootstrap_resume_claim_failed");

    const evidenceRoot = await mkdtemp(join(tmpdir(), "selinow-dodo-evidence-ancestor-symlink-"));
    temporaryRoots.push(evidenceRoot);
    await mkdir(join(external, "release"), { recursive: true });
    await writeFile(join(external, "release", "production-evidence.json"), "{}\n", { mode: 0o600 });
    await symlink(external, join(evidenceRoot, ".wrangler"));
    await expect(readCanonicalPrivateJson(
      evidenceRoot,
      ".wrangler/release/production-evidence.json",
      ".wrangler/release/production-evidence.json",
      "dodo_webhook_bootstrap_release_evidence_invalid",
    )).rejects.toThrow("dodo_webhook_bootstrap_release_evidence_invalid");
  });

  it("does not write artifact bytes through an ancestor swapped after validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-write-swap-root-"));
    const external = await mkdtemp(join(tmpdir(), "selinow-dodo-write-swap-external-"));
    temporaryRoots.push(root, external);
    await mkdir(join(external, "releases", releaseId), { recursive: true });
    const originalWrangler = join(root, ".wrangler-original");
    await expect(writePrivateDodoArtifact(
      root,
      releaseId,
      DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap,
      bootstrap(),
      {
        fileSystemHooks: {
          async beforeOpen() {
            await rename(join(root, ".wrangler"), originalWrangler);
            await symlink(external, join(root, ".wrangler"));
          },
        },
      },
    )).rejects.toThrow("dodo_webhook_bootstrap_artifact_ancestor_invalid");
    const escapedPath = join(external, "releases", releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.bootstrap);
    await expect(stat(escapedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the original artifact intact when an atomic replacement cannot commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-replace-failure-"));
    temporaryRoots.push(root);
    const original = bootstrap();
    const written = await writePrivateDodoArtifact(root, releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, original);
    const replacement = updateDodoBootstrapReservation(buildDodoBootstrapReservation({
      admission: assertDodoBootstrapCandidateAdmission({ evidence, repository: { clean: true, commitSha, treeSha }, worker: worker() }),
      beforeWorkerVersionIds: worker().deployableWorkerVersionIds,
      observedAt: "2026-08-11T06:00:00.000Z",
    }), { observedAt: "2026-08-11T06:01:00.000Z", state: { phase: "provider_mutation_pending" } });

    await expect(replacePrivateDodoArtifact(
      root,
      releaseId,
      DODO_BOOTSTRAP_ARTIFACT_FILES.reservation,
      replacement,
      written.artifactSha256,
      { fileSystemHooks: { beforeReplaceCommit() { throw new Error("commit_blocked"); } } },
    )).rejects.toThrow("dodo_webhook_bootstrap_reservation_update_failed");
    await expect(readPrivateDodoArtifact(
      root,
      written.evidenceRef,
      DODO_BOOTSTRAP_ARTIFACT_FILES.reservation,
      written.artifactSha256,
    )).resolves.toMatchObject({ value: original });
  });

  it("serializes concurrent artifact CAS writers and never overwrites an interleaved replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-replace-race-"));
    temporaryRoots.push(root);
    const admission = assertDodoBootstrapCandidateAdmission({ evidence, repository: { clean: true, commitSha, treeSha }, worker: worker() });
    const original = buildDodoBootstrapReservation({
      admission,
      beforeWorkerVersionIds: worker().deployableWorkerVersionIds,
      observedAt: "2026-08-11T06:00:00.000Z",
    });
    const written = await writePrivateDodoArtifact(root, releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, original);
    const first = updateDodoBootstrapReservation(original, {
      observedAt: "2026-08-11T06:01:00.000Z",
      state: { phase: "provider_mutation_pending" },
    });
    const second = updateDodoBootstrapReservation(original, {
      observedAt: "2026-08-11T06:02:00.000Z",
      state: { phase: "provider_registered", providerWebhookFingerprintSha256: "a".repeat(64) },
    });
    const raced = await Promise.allSettled([
      replacePrivateDodoArtifact(root, releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, first, written.artifactSha256),
      replacePrivateDodoArtifact(root, releaseId, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, second, written.artifactSha256),
    ]);
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rejectedRace = raced.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejectedRace?.reason).toBeInstanceOf(Error);
    expect((rejectedRace?.reason as Error).message).toBe("dodo_webhook_bootstrap_artifact_cas_mismatch");

    const interleaved = updateDodoBootstrapReservation(first, {
      observedAt: "2026-08-11T06:03:00.000Z",
      state: { phase: "provider_registered", providerWebhookFingerprintSha256: "b".repeat(64) },
    });
    const winner = raced.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<{ artifactSha256: string }>;
    const current = await readPrivateDodoArtifact(root, written.evidenceRef, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation, winner.value.artifactSha256);
    await expect(replacePrivateDodoArtifact(
      root,
      releaseId,
      DODO_BOOTSTRAP_ARTIFACT_FILES.reservation,
      interleaved,
      current.artifactSha256,
      {
        fileSystemHooks: {
          async beforeReplaceCommit({ path }) {
            await rm(path);
            await writeFile(path, JSON.stringify(original), { mode: 0o600 });
          },
        },
      },
    )).rejects.toThrow("dodo_webhook_bootstrap_artifact_cas_mismatch");
    await expect(readPrivateDodoArtifact(root, written.evidenceRef, DODO_BOOTSTRAP_ARTIFACT_FILES.reservation))
      .resolves.toMatchObject({ value: original });
  });

  it("admits exactly one concurrent resume and recovers an expired claim with evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-resume-claim-"));
    temporaryRoots.push(root);
    const input = {
      now: new Date("2026-08-11T06:00:00.000Z"),
      releaseId,
      reservationId: "4".repeat(64),
      reservationSha256: "5".repeat(64),
    };
    const attempts = await Promise.allSettled([
      acquireDodoBootstrapResumeClaim(root, input),
      acquireDodoBootstrapResumeClaim(root, input),
    ]);
    const admitted = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { message: "dodo_webhook_bootstrap_resume_in_progress" } });
    const winner = (admitted[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireDodoBootstrapResumeClaim>>>).value;
    const winnerAttemptId = winner.claim.attemptId as string;

    const recovered = await acquireDodoBootstrapResumeClaim(root, {
      ...input,
      now: new Date("2026-08-11T06:16:00.000Z"),
    });
    const recoveredAttemptId = recovered.claim.attemptId as string;
    expect(recoveredAttemptId).not.toBe(winnerAttemptId);
    const files = await readdir(join(root, ".wrangler", "releases", releaseId));
    expect(files).toContain(`dodo-webhook-bootstrap-resume-claim-stale-${winnerAttemptId}.json`);
    await expect(releaseDodoBootstrapResumeClaim(root, winner)).resolves.toEqual({ ownershipLost: true, released: false });
    await expect(assertDodoBootstrapResumeClaimOwnership(root, {
      claim: recovered.claim,
      now: new Date("2026-08-11T06:16:00.000Z"),
    })).resolves.toMatchObject({ attemptId: recoveredAttemptId });
    await releaseDodoBootstrapResumeClaim(root, recovered);
  });

  it("releases append-only and cannot let the prior owner release the replacement claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-resume-release-"));
    temporaryRoots.push(root);
    const input = {
      now: new Date("2026-08-11T06:00:00.000Z"),
      releaseId,
      reservationId: "8".repeat(64),
      reservationSha256: "9".repeat(64),
    };
    const original = await acquireDodoBootstrapResumeClaim(root, input);
    await expect(releaseDodoBootstrapResumeClaim(root, {
      claim: original.claim,
      now: new Date("2026-08-11T06:01:00.000Z"),
    })).resolves.toEqual({ ownershipLost: false, released: true });
    const replacement = await acquireDodoBootstrapResumeClaim(root, {
      ...input,
      now: new Date("2026-08-11T06:02:00.000Z"),
    });
    const replacementAttemptId = replacement.claim.attemptId as string;
    await expect(releaseDodoBootstrapResumeClaim(root, original))
      .resolves.toEqual({ ownershipLost: true, released: false });
    await expect(assertDodoBootstrapResumeClaimOwnership(root, {
      claim: replacement.claim,
      now: new Date("2026-08-11T06:02:00.000Z"),
    })).resolves.toMatchObject({ attemptId: replacementAttemptId });
    await releaseDodoBootstrapResumeClaim(root, replacement);
  });

  it("serializes stale takeover so a paused owner cannot unlink a contender replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-resume-linearizable-"));
    temporaryRoots.push(root);
    const input = {
      now: new Date("2026-08-11T06:00:00.000Z"),
      releaseId,
      reservationId: "a".repeat(64),
      reservationSha256: "b".repeat(64),
    };
    await acquireDodoBootstrapResumeClaim(root, input);
    let continueUnlink: () => void = () => undefined;
    let markUnlinkPaused: () => void = () => undefined;
    let markContenderBlocked: () => void = () => undefined;
    const unlinkGate = new Promise<void>((resolveGate) => { continueUnlink = resolveGate; });
    const unlinkPaused = new Promise<void>((resolvePaused) => { markUnlinkPaused = resolvePaused; });
    const contenderBlocked = new Promise<void>((resolveBlocked) => { markContenderBlocked = resolveBlocked; });
    const takeoverNow = new Date("2026-08-11T06:16:00.000Z");
    const first = acquireDodoBootstrapResumeClaim(root, {
      ...input,
      fileSystemHooks: {
        async beforeCanonicalClaimUnlink() {
          markUnlinkPaused();
          await unlinkGate;
        },
      },
      now: takeoverNow,
    });
    await unlinkPaused;
    const contender = acquireDodoBootstrapResumeClaim(root, {
      ...input,
      fileSystemHooks: {
        onClaimMutationLockBlocked() { markContenderBlocked(); },
      },
      now: takeoverNow,
    });
    await contenderBlocked;
    continueUnlink();
    const results = await Promise.allSettled([first, contender]);
    const admitted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { message: "dodo_webhook_bootstrap_resume_in_progress" } });
    const winner = (admitted[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireDodoBootstrapResumeClaim>>>).value;
    const winnerAttemptId = winner.claim.attemptId as string;
    await expect(assertDodoBootstrapResumeClaimOwnership(root, { claim: winner.claim, now: takeoverNow }))
      .resolves.toMatchObject({ attemptId: winnerAttemptId });
    await releaseDodoBootstrapResumeClaim(root, winner);
  });

  it("recovers a stale empty mutation lease left by the pre-atomic writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-empty-mutation-lease-"));
    temporaryRoots.push(root);
    const releaseDirectory = join(root, ".wrangler", "releases", releaseId);
    await mkdir(releaseDirectory, { mode: 0o700, recursive: true });
    const leasePath = join(releaseDirectory, "dodo-webhook-bootstrap-resume-claim-mutation-lease.json");
    await writeFile(leasePath, "", { mode: 0o600 });
    const staleAt = new Date("2026-08-11T05:59:00.000Z");
    await utimes(leasePath, staleAt, staleAt);

    const acquired = await acquireDodoBootstrapResumeClaim(root, {
      now: new Date("2026-08-11T06:00:00.000Z"),
      releaseId,
      reservationId: "e".repeat(64),
      reservationSha256: "f".repeat(64),
    });

    await expect(assertDodoBootstrapResumeClaimOwnership(root, {
      claim: acquired.claim,
      now: new Date("2026-08-11T06:00:00.000Z"),
    })).resolves.toMatchObject({ attemptId: String(acquired.claim.attemptId) });
    await releaseDodoBootstrapResumeClaim(root, acquired);
  });

  it("retains a published claim when mutation-lease release loses ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-mutation-release-race-"));
    temporaryRoots.push(root);
    let replaced = false;
    const acquired = await acquireDodoBootstrapResumeClaim(root, {
      fileSystemHooks: {
        async beforeExactUnlink({ path }) {
          if (replaced || !path.endsWith("dodo-webhook-bootstrap-resume-claim-mutation-lease.json")) return;
          replaced = true;
          const replacement = await readFile(path);
          await rm(path);
          await writeFile(path, replacement, { mode: 0o600 });
        },
      },
      now: new Date("2026-08-11T06:00:00.000Z"),
      releaseId,
      reservationId: "1".repeat(64),
      reservationSha256: "2".repeat(64),
    });

    expect(replaced).toBe(true);
    await expect(assertDodoBootstrapResumeClaimOwnership(root, {
      claim: acquired.claim,
      now: new Date("2026-08-11T06:00:00.000Z"),
    })).resolves.toMatchObject({ attemptId: String(acquired.claim.attemptId) });
    await releaseDodoBootstrapResumeClaim(root, acquired);
  });

  it("does not recursively clean an attempt through a swapped ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-cleanup-swap-root-"));
    const external = await mkdtemp(join(tmpdir(), "selinow-dodo-cleanup-swap-external-"));
    temporaryRoots.push(root, external);
    const input = {
      now: new Date("2026-08-11T06:00:00.000Z"),
      releaseId,
      reservationId: "c".repeat(64),
      reservationSha256: "d".repeat(64),
    };
    await mkdir(join(external, ".wrangler", "releases", releaseId), { recursive: true });
    const externalAttempt = join(external, ".wrangler", "releases", releaseId, "dodo-webhook-bootstrap-resume-attempts", "external-attempt");
    await mkdir(externalAttempt, { recursive: true });
    await writeFile(join(externalAttempt, "sentinel.txt"), "keep\n", { mode: 0o600 });
    const originalWrangler = join(root, ".wrangler-original");
    await symlink(external, join(root, ".wrangler"));
    await expect(acquireDodoBootstrapResumeClaim(root, input)).rejects.toThrow("dodo_webhook_bootstrap_resume_claim_failed");
    await rename(join(root, ".wrangler"), originalWrangler).catch(() => undefined);
    expect(await readFile(join(externalAttempt, "sentinel.txt"), "utf8")).toBe("keep\n");
  });

  it("heartbeats a long-running resume so takeover remains blocked past the original expiry", async () => {
    const root = await mkdtemp(join(tmpdir(), "selinow-dodo-resume-heartbeat-"));
    temporaryRoots.push(root);
    const input = {
      now: new Date("2026-08-11T06:00:00.000Z"),
      releaseId,
      reservationId: "6".repeat(64),
      reservationSha256: "7".repeat(64),
    };
    const original = await acquireDodoBootstrapResumeClaim(root, input);
    const renewed = await renewDodoBootstrapResumeClaim(root, {
      claim: original.claim,
      now: new Date("2026-08-11T06:14:00.000Z"),
    });
    const renewedAttemptId = renewed.claim.attemptId as string;
    await expect(acquireDodoBootstrapResumeClaim(root, {
      ...input,
      now: new Date("2026-08-11T06:16:00.000Z"),
    })).rejects.toThrow("dodo_webhook_bootstrap_resume_in_progress");
    await expect(assertDodoBootstrapResumeClaimOwnership(root, {
      claim: renewed.claim,
      now: new Date("2026-08-11T06:28:00.000Z"),
    })).resolves.toMatchObject({ attemptId: renewedAttemptId });
    await releaseDodoBootstrapResumeClaim(root, renewed);
  });

  it("uses pre-candidate infrastructure admission only for bootstrap mutation", async () => {
    const source = await readFile("scripts/dodo-webhook-register.mjs", "utf8");
    expect(source).toContain('productionWorkerAdmission(wrangler, "pre_candidate")');
    expect(source).toContain("const worker = await productionWorkerAdmission(wrangler);");
    expect(source).not.toContain('boundBootstrapInput(options, wrangler, "pre_candidate",');
    expect(source).toContain("[DODO_BOOTSTRAP_API_KEY_SECRET_NAME]: apiKey");
    expect(source).toContain("[DODO_BOOTSTRAP_WEBHOOK_SECRET_NAME]: webhookSecret");
    expect(source).toContain("dodo_webhook_production_bootstrap_required");
  });

  it("uploads route-neutral production Worker versions under pre-candidate admission", async () => {
    const source = await readFile("scripts/release-worker-upload.mjs", "utf8");
    expect(source).toContain('infrastructureAdmissionMode: "pre_candidate"');
    expect(source).not.toContain('infrastructureAdmissionMode: "exact"');
  });
});
