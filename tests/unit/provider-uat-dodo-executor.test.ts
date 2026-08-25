import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { runDodoUatExecutor } from "../../scripts/provider-uat-dodo-executor.mjs";

const RELEASE_ID = "stg_20260826T100000Z_aaaaaaaaaaaa";
const WORKER_VERSION = "11111111-1111-4111-8111-111111111111";
const RELEASE = {
  commitSha: "a".repeat(40),
  manifestRef: `.wrangler/releases/staging/${RELEASE_ID}/release-manifest.json`,
  manifestSha256: "b".repeat(64),
  releaseId: RELEASE_ID,
  treeSha: "c".repeat(40),
  workerVersion: WORKER_VERSION,
};

const roots: string[] = [];

type DodoUatReceipt = {
  provider: string;
  providerEventSha256: string | null;
};

type DodoUatExecutor = (args: {
  environment: Record<string, string>;
  fetcher: typeof fetch;
  inputStream: Readable;
  repositoryRoot: string;
}) => Promise<DodoUatReceipt>;

const runDodoUatExecutorTyped = runDodoUatExecutor as unknown as DodoUatExecutor;

function contextFixture(root: string) {
  const keys = generateKeyPairSync("ed25519");
  const privateKeyPem = keys.privateKey.export({ format: "pem", type: "pkcs8" });
  const paths = {
    auth: join(root, "auth.json"),
    d1: join(root, "d1.json"),
    dodo: join(root, "dodo.json"),
  };
  writeFileSync(paths.auth, JSON.stringify({
    accessToken: "auth-token-value-that-is-only-a-fixture",
    controlPath: "/api/internal/uat/providers/dodo",
    environment: "staging",
    runtimeOrigin: "https://staging.selinow.com",
    schemaVersion: 1,
  }) + "\n", { mode: 0o600 });
  writeFileSync(paths.d1, JSON.stringify({
    accountId: "a".repeat(32),
    apiToken: "d1-token-value-that-is-only-a-fixture",
    databaseId: "11111111-1111-4111-8111-111111111111",
    environment: "staging",
    schemaVersion: 1,
    shopPublicId: "shop_11111111-1111-4111-8111-111111111111",
  }) + "\n", { mode: 0o600 });
  writeFileSync(paths.dodo, JSON.stringify({
    apiBaseUrl: "https://test.dodopayments.com",
    apiKey: "dodo-api-key-value-that-is-only-a-fixture",
    environment: "staging",
    offers: {
      pro_global: "pdt_pro_global",
      pro_vn: "pdt_pro_vn",
      starter_global: "pdt_starter_global",
      starter_vn: "pdt_starter_vn",
    },
    provider: "dodo",
    providerEnvironment: "test_mode",
    runner: { keyId: "fixture-runner-key", privateKeyPem },
    schemaVersion: 1,
    webhookSecret: "webhook-secret-value-that-is-only-a-fixture",
  }) + "\n", { mode: 0o600 });
  return paths;
}

function inputStream(scenarioId = "plan_catalog_offers") {
  return Readable.from([JSON.stringify({
    provider: "dodo",
    providerEnvironment: "test_mode",
    release: RELEASE,
    requiredClaims: [
      "artifactRef", "artifactSha256", "providerEventSha256", "providerSignatureSha256",
      "d1BeforeSha256", "d1AfterSha256", "d1TransitionSha256", "executionTranscriptSha256",
    ],
    scenarioId,
    schemaVersion: 1,
  })]);
}

function d1Rows() {
  return {
    catalog: [
      { amount_minor: 99_000, currency: "VND", interval: "month", is_active: 1, market_code: "vn", plan_code: "starter", provider_price_ref: "pdt_starter_vn", tax_behavior: "inclusive" },
      { amount_minor: 500, currency: "USD", interval: "month", is_active: 1, market_code: "global", plan_code: "starter", provider_price_ref: "pdt_starter_global", tax_behavior: "inclusive" },
      { amount_minor: 299_000, currency: "VND", interval: "month", is_active: 1, market_code: "vn", plan_code: "pro", provider_price_ref: "pdt_pro_vn", tax_behavior: "inclusive" },
      { amount_minor: 1_500, currency: "USD", interval: "month", is_active: 1, market_code: "global", plan_code: "pro", provider_price_ref: "pdt_pro_global", tax_behavior: "inclusive" },
    ],
    subscription: [{ state: null }],
    checkouts: [],
    invoices: [],
    events: [],
  };
}

function fetchFixture({ unsupported = false } = {}) {
  const rows = d1Rows();
  return (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/internal/uat/providers/dodo")) {
      if (unsupported) return new Response(JSON.stringify({ error: "unsupported" }), { status: 501 });
      const rawBody = init?.body;
      if (typeof rawBody !== "string") throw new Error("fixture_request_body_invalid");
      const body = JSON.parse(rawBody) as { phase?: string; scenarioId?: string };
      if (body.phase === "prepare") return Response.json({
        phase: "prepared", provider: "dodo", releaseId: RELEASE_ID, runId: "run_fixture_catalog", scenarioId: body.scenarioId, schemaVersion: 1, workerVersion: WORKER_VERSION,
      });
      return Response.json({
        event: null, observedAt: "2026-08-26T10:00:01.000Z", outcome: "catalog_verified", phase: "executed", provider: "dodo",
        providerCheckoutId: null, releaseId: RELEASE_ID, requestId: "req_fixture_catalog", runId: "run_fixture_catalog", runtimeCode: "uat_catalog_verified",
        runtimeStatus: 200, scenarioId: body.scenarioId, schemaVersion: 1, sessionId: null, workerVersion: WORKER_VERSION,
      });
    }
    if (url.includes("api.cloudflare.com")) {
      const rawBody = init?.body;
      if (typeof rawBody !== "string") throw new Error("fixture_request_body_invalid");
      const body = JSON.parse(rawBody) as { sql?: string };
      if (typeof body.sql !== "string") throw new Error("fixture_sql_invalid");
      const sql = body.sql;
      const name: keyof ReturnType<typeof d1Rows> = sql.includes("plan_prices") && sql.includes("provider_code") ? "catalog"
        : sql.includes("billing_checkout_sessions") ? "checkouts"
          : sql.includes("billing_invoices") ? "invoices"
            : sql.includes("billing_provider_events") ? "events" : "subscription";
      return Response.json({ result: [{ results: rows[name], success: true }], success: true });
    }
    if (url.includes("/products/")) {
      const productId = url.slice(url.lastIndexOf("/") + 1);
      const offer = productId === "pdt_starter_vn" ? ["VND", 99_000] : productId === "pdt_starter_global" ? ["USD", 500] : productId === "pdt_pro_vn" ? ["VND", 299_000] : ["USD", 1_500];
      return Response.json({ is_recurring: true, price: { currency: offer[0], payment_frequency_count: 1, payment_frequency_interval: "month", price: offer[1], tax_inclusive: true, trial_period_days: 0, type: "recurring_price" }, product_id: productId });
    }
    throw new Error("unexpected_fixture_request");
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    // Test fixtures are private and isolated; the harness removes them after each test.
    for (const path of [join(root, "auth.json"), join(root, "d1.json"), join(root, "dodo.json")]) {
      try { writeFileSync(path, ""); } catch { /* already removed */ }
    }
  }
});

describe("Dodo provider UAT executor", () => {
  it("proves a real catalog observation with private artifact and receipt claims", async () => {
    const root = mkdtempSync(join(tmpdir(), "selinow-dodo-executor-"));
    roots.push(root);
    const contexts = contextFixture(root);
    const result = await runDodoUatExecutorTyped({
      environment: {
        SELINOW_UAT_AUTH_CONTEXT_PATH: contexts.auth,
        SELINOW_UAT_D1_CONTEXT_PATH: contexts.d1,
        SELINOW_UAT_DODO_CONTEXT_PATH: contexts.dodo,
        SELINOW_UAT_PROVIDER: "dodo",
        SELINOW_UAT_RELEASE_ID: RELEASE_ID,
        SELINOW_UAT_RUNNER: "1",
        SELINOW_UAT_SCENARIO_ID: "plan_catalog_offers",
        SELINOW_UAT_WORKER_VERSION: WORKER_VERSION,
      },
      fetcher: fetchFixture(),
      inputStream: inputStream(),
      repositoryRoot: root,
    });
    expect(result.provider).toBe("dodo");
    expect(result.providerEventSha256).toBeNull();
    expect(statSync(join(root, ".wrangler", "releases", "staging", RELEASE_ID, "dodo-uat-execution-proofs", "plan_catalog_offers.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, ".wrangler", "releases", "staging", RELEASE_ID, "dodo-uat-execution-proofs", "plan_catalog_offers.json"), "utf8")).toContain("dodo_uat_execution_proof");
  });

  it("fails closed when the staging control plane cannot execute safely", async () => {
    const root = mkdtempSync(join(tmpdir(), "selinow-dodo-executor-"));
    roots.push(root);
    const contexts = contextFixture(root);
    await expect(runDodoUatExecutorTyped({
      environment: {
        SELINOW_UAT_AUTH_CONTEXT_PATH: contexts.auth,
        SELINOW_UAT_D1_CONTEXT_PATH: contexts.d1,
        SELINOW_UAT_DODO_CONTEXT_PATH: contexts.dodo,
        SELINOW_UAT_PROVIDER: "dodo",
        SELINOW_UAT_RELEASE_ID: RELEASE_ID,
        SELINOW_UAT_RUNNER: "1",
        SELINOW_UAT_SCENARIO_ID: "plan_catalog_offers",
        SELINOW_UAT_WORKER_VERSION: WORKER_VERSION,
      },
      fetcher: fetchFixture({ unsupported: true }),
      inputStream: inputStream(),
      repositoryRoot: root,
    })).rejects.toThrow("dodo_uat_executor_scenario_unsupported_safely");
  });

  it("rejects context files that are not mode 0600", async () => {
    const root = mkdtempSync(join(tmpdir(), "selinow-dodo-executor-"));
    roots.push(root);
    const contexts = contextFixture(root);
    chmodSync(contexts.dodo, 0o644);
    await expect(runDodoUatExecutorTyped({
      environment: {
        SELINOW_UAT_AUTH_CONTEXT_PATH: contexts.auth,
        SELINOW_UAT_D1_CONTEXT_PATH: contexts.d1,
        SELINOW_UAT_DODO_CONTEXT_PATH: contexts.dodo,
        SELINOW_UAT_PROVIDER: "dodo",
        SELINOW_UAT_RELEASE_ID: RELEASE_ID,
        SELINOW_UAT_RUNNER: "1",
        SELINOW_UAT_SCENARIO_ID: "plan_catalog_offers",
        SELINOW_UAT_WORKER_VERSION: WORKER_VERSION,
      },
      fetcher: fetchFixture(),
      inputStream: inputStream(),
      repositoryRoot: root,
    })).rejects.toThrow("dodo_uat_executor_dodo_context_permissions_invalid");
  });
});
