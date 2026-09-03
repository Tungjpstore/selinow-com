import type { APIRoute } from "astro";

import { hmacToken, constantTimeEqual } from "../../../../../lib/core/crypto";
import { AppError } from "../../../../../lib/core/errors";
import { readJsonObject, rejectUnknownFields } from "../../../../../lib/http/request";
import { createCaughtErrorResponse, PRIVATE_RESPONSE_HEADERS } from "../../../../../lib/http/security";
import { getBindings } from "../../../../../lib/platform/bindings";
import { getDodoConfig } from "../../../../../lib/billing/dodo";

const GIT_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE_ID = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const WORKER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;
const SCENARIO = /^[a-z0-9_]{3,80}$/u;
const RUN_ID = /^run_[0-9]{13}_[A-Za-z0-9_-]{20,160}$/u;
const CATALOG_SCENARIO = "plan_catalog_offers";
const MAX_BODY_BYTES = 16 * 1024;

type UatBindings = ReturnType<typeof getBindings> & {
  DODO_UAT_COMMIT_SHA?: string;
  DODO_UAT_CONTROL_TOKEN?: string;
  DODO_UAT_MANIFEST_SHA256?: string;
  DODO_UAT_RELEASE_ID?: string;
  DODO_UAT_TREE_SHA?: string;
  DODO_UAT_WORKER_VERSION?: string;
  CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
};

type UatRequest = {
  commitSha: string;
  manifestRef: string;
  manifestSha256: string;
  phase: "prepare" | "execute";
  provider: "dodo";
  releaseId: string;
  runId: string | null;
  scenarioId: string;
  schemaVersion: 1;
  treeSha: string;
  workerVersion: string;
};

const EXPECTED_CATALOG = [
  { amountMinor: 99_000, currency: "VND", marketCode: "vn", planCode: "starter" },
  { amountMinor: 299_000, currency: "VND", marketCode: "vn", planCode: "pro" },
  { amountMinor: 500, currency: "USD", marketCode: "global", planCode: "starter" },
  { amountMinor: 1_500, currency: "USD", marketCode: "global", planCode: "pro" },
] as const;

function text(value: unknown, pattern: RegExp, issue: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new AppError("validation_failed", 400, [issue]);
  return value;
}

function configured(value: unknown, pattern: RegExp, issue: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new AppError("uat_release_binding_missing", 503, [issue]);
  return value;
}

function bearerToken(request: Request): string {
  const value = request.headers.get("Authorization") ?? "";
  if (!value.startsWith("Bearer ")) throw new AppError("authentication_required", 401);
  return value.slice(7);
}

function parseRequest(value: Record<string, unknown>): UatRequest {
  rejectUnknownFields(value, ["commitSha", "manifestRef", "manifestSha256", "phase", "provider", "releaseId", "runId", "scenarioId", "schemaVersion", "treeSha", "workerVersion"]);
  if (value.phase !== "prepare" && value.phase !== "execute") throw new AppError("validation_failed", 400, ["phase_invalid"]);
  if (value.provider !== "dodo" || value.schemaVersion !== 1) throw new AppError("validation_failed", 400, ["contract_invalid"]);
  const runId = value.runId === null ? null : text(value.runId, REFERENCE, "run_id_invalid");
  if (value.phase === "prepare" && runId !== null) throw new AppError("validation_failed", 400, ["run_id_invalid"]);
  if (value.phase === "execute" && (runId === null || !RUN_ID.test(runId))) throw new AppError("validation_failed", 400, ["run_id_invalid"]);
  return {
    commitSha: text(value.commitSha, GIT_SHA, "commit_sha_invalid"),
    manifestRef: text(value.manifestRef, /^\.wrangler\/releases\/staging\/stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}\/release-manifest\.json$/u, "manifest_ref_invalid"),
    manifestSha256: text(value.manifestSha256, SHA256, "manifest_sha256_invalid"),
    phase: value.phase,
    provider: "dodo",
    releaseId: text(value.releaseId, RELEASE_ID, "release_id_invalid"),
    runId,
    scenarioId: text(value.scenarioId, SCENARIO, "scenario_id_invalid"),
    schemaVersion: 1,
    treeSha: text(value.treeSha, GIT_SHA, "tree_sha_invalid"),
    workerVersion: text(value.workerVersion, WORKER_VERSION, "worker_version_invalid"),
  };
}

function assertReleaseBinding(env: UatBindings, input: UatRequest): void {
  const expected = {
    commitSha: configured(env.DODO_UAT_COMMIT_SHA, GIT_SHA, "commit_sha"),
    manifestSha256: configured(env.DODO_UAT_MANIFEST_SHA256, SHA256, "manifest_sha256"),
    releaseId: configured(env.DODO_UAT_RELEASE_ID, RELEASE_ID, "release_id"),
    treeSha: configured(env.DODO_UAT_TREE_SHA, GIT_SHA, "tree_sha"),
    workerVersion: env.CF_VERSION_METADATA?.id ?? configured(env.DODO_UAT_WORKER_VERSION, WORKER_VERSION, "worker_version"),
  };
  if (input.commitSha !== expected.commitSha || input.manifestSha256 !== expected.manifestSha256
    || input.releaseId !== expected.releaseId || input.treeSha !== expected.treeSha
    || input.workerVersion !== expected.workerVersion
    || input.manifestRef !== `.wrangler/releases/staging/${expected.releaseId}/release-manifest.json`) {
    throw new AppError("uat_release_binding_mismatch", 409);
  }
}

async function createRunId(token: string, input: UatRequest, now: number): Promise<string> {
  const timestamp = String(now);
  const signature = await hmacToken(token, "dodo-uat-run:v1", `${input.releaseId}:${input.workerVersion}:${input.scenarioId}:${timestamp}`);
  return `run_${timestamp}_${signature}`;
}

async function assertRunId(token: string, input: UatRequest, now: number): Promise<void> {
  if (input.runId === null || !RUN_ID.test(input.runId)) throw new AppError("validation_failed", 400, ["run_id_invalid"]);
  const match = /^run_(\d{13})_([A-Za-z0-9_-]+)$/u.exec(input.runId);
  if (match === null) throw new AppError("validation_failed", 400, ["run_id_invalid"]);
  const timestampText = match[1];
  const signature = match[2];
  if (timestampText === undefined || signature === undefined) throw new AppError("validation_failed", 400, ["run_id_invalid"]);
  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > 30 * 60_000) throw new AppError("uat_run_expired", 409);
  const expected = await hmacToken(token, "dodo-uat-run:v1", `${input.releaseId}:${input.workerVersion}:${input.scenarioId}:${timestampText}`);
  if (!constantTimeEqual(signature, expected)) throw new AppError("uat_run_invalid", 409);
}

async function verifyCatalog(env: UatBindings): Promise<void> {
  const rows = await env.PLATFORM_DB.prepare(`
    SELECT plans.code AS planCode, prices.market_code AS marketCode,
      prices.currency, prices.amount_minor AS amountMinor,
      prices.interval, prices.tax_behavior AS taxBehavior,
      prices.is_active AS isActive, prices.provider_price_ref AS providerPriceRef
    FROM plan_prices AS prices
    INNER JOIN plans ON plans.id = prices.plan_id
    WHERE prices.provider_code = 'dodo' AND prices.effective_to IS NULL
    ORDER BY plans.code, prices.market_code
  `).all<{
    amountMinor: number;
    currency: string;
    interval: string;
    isActive: number;
    marketCode: string;
    planCode: string;
    providerPriceRef: string;
    taxBehavior: string;
  }>();
  if (rows.results.length !== EXPECTED_CATALOG.length) throw new AppError("dodo_catalog_invalid", 409);
  const config = getDodoConfig(env);
  for (const expected of EXPECTED_CATALOG) {
    const row = rows.results.find((candidate) => candidate.planCode === expected.planCode && candidate.marketCode === expected.marketCode);
    if (row === undefined || row.amountMinor !== expected.amountMinor || row.currency !== expected.currency
      || row.interval !== "month" || row.taxBehavior !== "inclusive" || row.isActive !== 1
      || !REFERENCE.test(row.providerPriceRef)) throw new AppError("dodo_catalog_invalid", 409);
    let response: Response;
    try {
      response = await fetch(`${config.apiBaseUrl}/products/${encodeURIComponent(row.providerPriceRef)}`, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        method: "GET",
      });
    } catch {
      throw new AppError("billing_provider_unavailable", 503);
    }
    if (!response.ok) throw new AppError("billing_provider_unavailable", 503);
    let product: unknown;
    try { product = await response.json(); } catch { throw new AppError("billing_provider_invalid", 502, ["catalog_response_json"]); }
    const record = typeof product === "object" && product !== null && !Array.isArray(product) ? product as Record<string, unknown> : null;
    const price = record?.price && typeof record.price === "object" && !Array.isArray(record.price) ? record.price as Record<string, unknown> : null;
    if (record?.product_id !== row.providerPriceRef || record.is_recurring !== true
      || price?.type !== "recurring_price" || price.currency !== expected.currency
      || price.price !== expected.amountMinor || price.payment_frequency_count !== 1
      || String(price.payment_frequency_interval).toLowerCase() !== "month"
      || price.tax_inclusive !== true || price.trial_period_days !== 0) {
      throw new AppError("dodo_catalog_invalid", 409);
    }
  }
}

export const POST: APIRoute = async ({ locals, request }) => {
  try {
    const env: UatBindings = getBindings();
    if (env.APP_ENV !== "staging") throw new AppError("uat_environment_not_admitted", 409);
    const controlToken = configured(env.DODO_UAT_CONTROL_TOKEN, /^[A-Za-z0-9._~-]{32,4096}$/u, "control_token");
    if (!constantTimeEqual(bearerToken(request), controlToken)) throw new AppError("authentication_required", 401);
    const input = parseRequest(await readJsonObject(request, MAX_BODY_BYTES));
    assertReleaseBinding(env, input);
    if (input.scenarioId !== CATALOG_SCENARIO) throw new AppError("uat_scenario_unsupported", 501);
    const now = Date.now();
    if (input.phase === "prepare") {
      return Response.json({
        phase: "prepared", provider: "dodo", releaseId: input.releaseId,
        runId: await createRunId(controlToken, input, now), scenarioId: input.scenarioId,
        schemaVersion: 1, workerVersion: input.workerVersion,
      }, { headers: PRIVATE_RESPONSE_HEADERS });
    }
    await assertRunId(controlToken, input, now);
    await verifyCatalog(env);
    return Response.json({
      event: null, observedAt: new Date(now).toISOString(), outcome: "catalog_verified",
      phase: "executed", provider: "dodo", providerCheckoutId: null,
      releaseId: input.releaseId, requestId: locals.requestId, runId: input.runId,
      runtimeCode: "uat_catalog_verified", runtimeStatus: 200, scenarioId: input.scenarioId,
      schemaVersion: 1, sessionId: null, workerVersion: input.workerVersion,
    }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return createCaughtErrorResponse(error, locals.requestId);
  }
};
