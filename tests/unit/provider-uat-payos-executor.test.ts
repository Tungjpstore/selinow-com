import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executePayosProviderUat } from "../../scripts/provider-uat-payos-executor.mjs";
import { assertPayosUnsignedProviderExecutionArtifact, serializePayosRunnerAttestationPayload } from "../../scripts/lib/payos-uat-evidence.mjs";
import { verify } from "node:crypto";

const RELEASE_ID = "stg_20260826T100000Z_aaaaaaaaaaaa";
const WORKER_VERSION = "11111111-1111-4111-8111-111111111111";
const roots: string[] = [];

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" }, status });
}

function d1Response(row: Record<string, unknown>) {
  return response({ result: [{ results: [row], success: true }], success: true });
}

function snapshot(options: { attemptPublicId: string; paid?: boolean; reconciled?: boolean }) {
  return {
    attemptId: options.attemptPublicId.replace("pay_", "attempt-"),
    attemptPublicId: options.attemptPublicId,
    attemptState: options.paid === true ? "paid_exact" : "pending",
    eventId: options.paid === true ? "pev_00000000-0000-4000-8000-000000000010" : null,
    eventPayloadHash: options.paid === true ? "a".repeat(64) : null,
    eventProcessResult: options.paid === true ? "fulfilled" : null,
    eventProcessedAt: options.paid === true ? "2026-08-26T10:00:01.000Z" : null,
    eventReceivedAt: options.paid === true ? "2026-08-26T10:00:00.500Z" : null,
    eventState: options.paid === true ? "paid_exact" : null,
    fulfillmentState: options.paid === true ? "fulfilled" : "reserved",
    lastReconciledAt: options.reconciled === true ? "2026-08-26T10:00:01.000Z" : null,
    orderPaymentStatus: options.paid === true ? "paid" : "pending",
    orderState: options.paid === true ? "completed" : "pending_payment",
    paidEventId: options.paid === true ? "pev_00000000-0000-4000-8000-000000000010" : null,
    providerEventReference: options.paid === true ? "provider-safe-reference" : null,
    providerIdentityFingerprint: "A".repeat(43),
    reconcileAttempts: options.reconciled === true ? 1 : 0,
    signatureVerified: options.paid === true ? 1 : null,
  };
}

function fixture(scenarioId: "direct_reconciliation" | "signed_exact_payment") {
  const root = mkdtempSync(join(tmpdir(), "selinow-payos-executor-"));
  roots.push(root);
  const privateRoot = join(root, ".wrangler", "private");
  mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPath = join(privateRoot, "runner.pem");
  writeFileSync(privateKeyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const signedAttempt = "pay_00000000-0000-4000-8000-000000000001";
  const reconcileAttempt = "pay_00000000-0000-4000-8000-000000000002";
  const contexts = {
    auth: {
      environment: "staging",
      provider: "payos",
      runnerAttestation: { keyId: "payos-runner-2026", privateKeyPath: ".wrangler/private/runner.pem" },
      runtime: { baseOrigin: "https://staging.selinow.com/", cookieHeader: "selinow_session=opaque-session", csrfToken: "opaque-csrf-value-0001" },
      schemaVersion: 1,
    },
    d1: { accountId: "a".repeat(32), apiToken: "opaque-cloudflare-token-value", databaseId: "00000000-0000-4000-8000-000000000001", environment: "staging", provider: "payos", schemaVersion: 1 },
    payos: {
      environment: "staging",
      maxPollMs: 1_000,
      pollIntervalMs: 250,
      provider: "payos",
      scenarios: {
        direct_reconciliation: { attemptPublicId: reconcileAttempt, shopPublicId: "shop_00000000-0000-4000-8000-000000000002" },
        signed_exact_payment: { attemptPublicId: signedAttempt, shopPublicId: "shop_00000000-0000-4000-8000-000000000001" },
      },
      schemaVersion: 1,
    },
  };
  const paths = Object.fromEntries(Object.entries(contexts).map(([name, value]) => {
    const path = join(root, `${name}.json`);
    writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return [name, path];
  }));
  const release = {
    commitSha: "b".repeat(40),
    manifestRef: `.wrangler/releases/staging/${RELEASE_ID}/release-manifest.json`,
    manifestSha256: "c".repeat(64),
    releaseId: RELEASE_ID,
    treeSha: "d".repeat(40),
    workerVersion: WORKER_VERSION,
  };
  return {
    attemptPublicId: scenarioId === "signed_exact_payment" ? signedAttempt : reconcileAttempt,
    environment: {
      SELINOW_UAT_AUTH_CONTEXT_PATH: paths.auth,
      SELINOW_UAT_D1_CONTEXT_PATH: paths.d1,
      SELINOW_UAT_PAYOS_CONTEXT_PATH: paths.payos,
      SELINOW_UAT_PROVIDER: "payos",
      SELINOW_UAT_RELEASE_ID: RELEASE_ID,
      SELINOW_UAT_RUNNER: "1",
      SELINOW_UAT_SCENARIO_ID: scenarioId,
      SELINOW_UAT_WORKER_VERSION: WORKER_VERSION,
    },
    input: {
      provider: "payos",
      providerEnvironment: "production_controlled",
      release,
      requiredClaims: [
        "artifactRef", "artifactSha256", "providerEventSha256", "providerSignatureSha256",
        "d1BeforeSha256", "d1AfterSha256", "d1TransitionSha256", "executionTranscriptSha256",
      ],
      scenarioId,
      schemaVersion: 1,
    },
    publicKey,
    root,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("PayOS provider UAT executor", () => {
  it("waits for a genuine signed webhook transition and emits a signed canonical artifact", async () => {
    const test = fixture("signed_exact_payment");
    let d1Calls = 0;
    const fetcher = async () => {
      d1Calls += 1;
      return d1Response(snapshot({ attemptPublicId: test.attemptPublicId, paid: d1Calls > 1 }));
    };
    const receipt = await executePayosProviderUat({
      environment: test.environment,
      fetcher: fetcher as typeof fetch,
      input: test.input,
      now: () => new Date("2026-08-26T10:00:02.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000099",
      repositoryRoot: test.root,
      sleep: () => Promise.resolve(),
    });

    expect(receipt).toMatchObject({ authority: "payos_signed_webhook_or_verified_response", provider: "payos", scenarioId: "signed_exact_payment" });
    expect(receipt.d1BeforeSha256).not.toBe(receipt.d1AfterSha256);
    expect(receipt.providerEventSha256).toMatch(/^[a-f0-9]{64}$/u);
    const artifactPath = join(test.root, receipt.artifactRef.slice("artifact:".length));
    expect(statSync(artifactPath).mode & 0o777).toBe(0o600);
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
    const unsigned = { ...artifact, runnerAttestation: null };
    expect(() => assertPayosUnsignedProviderExecutionArtifact(unsigned)).not.toThrow();
    expect(verify(null, Buffer.from(serializePayosRunnerAttestationPayload(artifact)), test.publicKey, Buffer.from(artifact.runnerAttestation.signatureBase64, "base64"))).toBe(true);
  });

  it("uses the staging reconciliation endpoint and binds its verified response to D1", async () => {
    const test = fixture("direct_reconciliation");
    let d1Calls = 0;
    let runtimeCalls = 0;
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.cloudflare.com")) {
        d1Calls += 1;
        return d1Response(snapshot({ attemptPublicId: test.attemptPublicId, paid: d1Calls > 1, reconciled: d1Calls > 1 }));
      }
      runtimeCalls += 1;
      expect(init?.headers).toMatchObject({ Origin: "https://staging.selinow.com" });
      return response({
        evidence: {
          attemptPublicId: test.attemptPublicId,
          duplicate: false,
          eventReference: "event:pev_00000000-0000-4000-8000-000000000010",
          processed: true,
          provider: "payos",
          providerEnvironment: "production_controlled",
          replayed: false,
          requestReference: "request:request-payos-uat-0001",
          state: "paid_exact",
          verificationMethod: "verified_provider_response",
        },
        ok: true,
        requestId: "request-payos-uat-0001",
      }, 201);
    };
    const receipt = await executePayosProviderUat({
      environment: test.environment,
      fetcher: fetcher as typeof fetch,
      input: test.input,
      now: () => new Date("2026-08-26T10:00:02.000Z"),
      randomId: () => "00000000-0000-4000-8000-000000000098",
      repositoryRoot: test.root,
    });

    expect(runtimeCalls).toBe(1);
    expect(d1Calls).toBe(2);
    expect(receipt.scenarioId).toBe("direct_reconciliation");
    const artifact = JSON.parse(readFileSync(join(test.root, receipt.artifactRef.slice("artifact:".length)), "utf8"));
    expect(artifact.authority.requestReference).toBe("request:request-payos-uat-0001");
    expect(artifact.authority.providerAuthority).toBe("provider_signed_response");
  });

  it("fails closed when a context is not mode 0600", async () => {
    const test = fixture("signed_exact_payment");
    const contextPath = test.environment.SELINOW_UAT_PAYOS_CONTEXT_PATH;
    if (contextPath === undefined) throw new Error("test_fixture_context_path_missing");
    chmodSync(contextPath, 0o644);
    await expect(executePayosProviderUat({
      environment: test.environment,
      fetcher: (() => Promise.reject(new Error("must not fetch"))) as typeof fetch,
      input: test.input,
      repositoryRoot: test.root,
    })).rejects.toThrow("payos_executor_payos_context_missing_permissions_invalid");
  });

  it("rejects a pre-paid attempt because no transition can be proven", async () => {
    const test = fixture("signed_exact_payment");
    await expect(executePayosProviderUat({
      environment: test.environment,
      fetcher: (() => Promise.resolve(d1Response(snapshot({ attemptPublicId: test.attemptPublicId, paid: true })))) as typeof fetch,
      input: test.input,
      repositoryRoot: test.root,
    })).rejects.toThrow("payos_executor_d1_before_invalid");
  });
});
