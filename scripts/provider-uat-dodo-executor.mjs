#!/usr/bin/env node

import { Buffer } from "node:buffer";
import {
  createHash,
  createHmac,
  createPrivateKey,
  sign,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import {
  DODO_SCENARIO_EXECUTION_CONTRACTS,
  serializeDodoUatExecutionProofPayload,
} from "./lib/dodo-uat-evidence.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;
const RELEASE_ID = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const WORKER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const CONTROL_PATH = "/api/internal/uat/providers/dodo";
const PROVIDER_ORIGIN = "https://test.dodopayments.com";
const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUIRED_CLAIMS = Object.freeze([
  "artifactRef", "artifactSha256", "providerEventSha256", "providerSignatureSha256",
  "d1BeforeSha256", "d1AfterSha256", "d1TransitionSha256", "executionTranscriptSha256",
]);

const OFFERS = Object.freeze({
  starter_vn: Object.freeze({ amountMinor: 99_000, currency: "VND", marketCode: "vn", planCode: "starter" }),
  pro_vn: Object.freeze({ amountMinor: 299_000, currency: "VND", marketCode: "vn", planCode: "pro" }),
  starter_global: Object.freeze({ amountMinor: 500, currency: "USD", marketCode: "global", planCode: "starter" }),
  pro_global: Object.freeze({ amountMinor: 1_500, currency: "USD", marketCode: "global", planCode: "pro" }),
});

function fail(code) {
  throw new Error(code);
}

function object(value, issue) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(issue);
  return value;
}

function exactKeys(value, expected, issue) {
  object(value, issue);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(issue);
}

function text(value, pattern, issue, maximum = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum
    || [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f)
    || (pattern !== null && !pattern.test(value))) fail(issue);
  return value;
}

function optionalReference(value, required, issue) {
  if (value === null && !required) return null;
  return text(value, REFERENCE, issue, 160);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function bytes(value) {
  return Buffer.from(JSON.stringify(canonical(value)), "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function opaqueReference(kind, value) {
  return `${kind}:${sha256(Buffer.from(`${kind}:v1:${value}`, "utf8")).slice(0, 32)}`;
}

function parseIso(value, issue) {
  if (typeof value !== "string") fail(issue);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) fail(issue);
  return value;
}

async function readPrivateJson(path, issue) {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (descriptor === null) fail(`${issue}_missing`);
  try {
    const opened = await descriptor.stat({ bigint: true });
    const current = await stat(path, { bigint: true });
    if (!opened.isFile() || (opened.mode & 0o777n) !== 0o600n || opened.dev !== current.dev || opened.ino !== current.ino) {
      fail(`${issue}_permissions_invalid`);
    }
    if (opened.size < 2n || opened.size > BigInt(MAX_CONTEXT_BYTES)) fail(`${issue}_size_invalid`);
    const content = await descriptor.readFile();
    const after = await descriptor.stat({ bigint: true });
    if (opened.size !== after.size || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs) {
      fail(`${issue}_changed_during_read`);
    }
    try { return JSON.parse(content.toString("utf8")); } catch { fail(`${issue}_invalid`); }
  } finally {
    await descriptor.close();
  }
}

async function readInput(stream = process.stdin) {
  let input = "";
  for await (const chunk of stream) {
    input += chunk;
    if (Buffer.byteLength(input) > MAX_CONTEXT_BYTES) fail("dodo_uat_executor_input_too_large");
  }
  let value;
  try { value = JSON.parse(input); } catch { fail("dodo_uat_executor_input_invalid"); }
  exactKeys(value, ["provider", "providerEnvironment", "release", "requiredClaims", "scenarioId", "schemaVersion"], "dodo_uat_executor_input_invalid");
  exactKeys(value.release, ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha", "workerVersion"], "dodo_uat_executor_release_invalid");
  if (value.schemaVersion !== 1 || value.provider !== "dodo" || value.providerEnvironment !== "test_mode"
    || !RELEASE_ID.test(value.release.releaseId ?? "") || !GIT_SHA.test(value.release.commitSha ?? "")
    || !GIT_SHA.test(value.release.treeSha ?? "") || !SHA256.test(value.release.manifestSha256 ?? "")
    || !WORKER_VERSION.test(value.release.workerVersion ?? "")
    || value.release.manifestRef !== `.wrangler/releases/staging/${value.release.releaseId}/release-manifest.json`
    || !Array.isArray(value.requiredClaims)
    || value.requiredClaims.length !== REQUIRED_CLAIMS.length
    || value.requiredClaims.some((claim, index) => claim !== REQUIRED_CLAIMS[index])) fail("dodo_uat_executor_release_invalid");
  const contract = DODO_SCENARIO_EXECUTION_CONTRACTS[value.scenarioId];
  if (contract === undefined) fail("dodo_uat_executor_scenario_invalid");
  return { ...value, contract };
}

function validateAuthContext(value) {
  exactKeys(value, ["accessToken", "controlPath", "environment", "runtimeOrigin", "schemaVersion"], "dodo_uat_executor_auth_context_invalid");
  if (value.schemaVersion !== 1 || value.environment !== "staging" || value.controlPath !== CONTROL_PATH) fail("dodo_uat_executor_auth_context_invalid");
  text(value.accessToken, null, "dodo_uat_executor_auth_context_invalid", 4096);
  let origin;
  try { origin = new URL(value.runtimeOrigin); } catch { fail("dodo_uat_executor_auth_context_invalid"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || origin.hostname === "localhost" || origin.hostname.endsWith(".localhost")) fail("dodo_uat_executor_auth_context_invalid");
  return { ...value, runtimeOrigin: origin.origin };
}

function validateD1Context(value) {
  exactKeys(value, ["accountId", "apiToken", "databaseId", "environment", "schemaVersion", "shopPublicId"], "dodo_uat_executor_d1_context_invalid");
  if (value.schemaVersion !== 1 || value.environment !== "staging"
    || !/^[a-f0-9]{32}$/u.test(value.accountId ?? "")
    || !/^[a-f0-9-]{32,36}$/u.test(value.databaseId ?? "")
    || !/^shop_[a-f0-9-]{36}$/u.test(value.shopPublicId ?? "")) fail("dodo_uat_executor_d1_context_invalid");
  text(value.apiToken, null, "dodo_uat_executor_d1_context_invalid", 4096);
  return value;
}

function validateDodoContext(value) {
  exactKeys(value, ["apiBaseUrl", "apiKey", "environment", "offers", "provider", "providerEnvironment", "runner", "schemaVersion", "webhookSecret"], "dodo_uat_executor_dodo_context_invalid");
  exactKeys(value.runner, ["keyId", "privateKeyPem"], "dodo_uat_executor_dodo_context_invalid");
  exactKeys(value.offers, Object.keys(OFFERS), "dodo_uat_executor_dodo_context_invalid");
  if (value.schemaVersion !== 1 || value.provider !== "dodo" || value.environment !== "staging"
    || value.providerEnvironment !== "test_mode" || value.apiBaseUrl !== PROVIDER_ORIGIN
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u.test(value.runner.keyId ?? "")) fail("dodo_uat_executor_dodo_context_invalid");
  text(value.apiKey, null, "dodo_uat_executor_dodo_context_invalid", 4096);
  text(value.webhookSecret, null, "dodo_uat_executor_dodo_context_invalid", 4096);
  if (typeof value.runner.privateKeyPem !== "string" || value.runner.privateKeyPem.length < 32
    || value.runner.privateKeyPem.length > 16 * 1024 || !/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\n?$/u.test(value.runner.privateKeyPem)) {
    fail("dodo_uat_executor_dodo_context_invalid");
  }
  for (const reference of Object.values(value.offers)) optionalReference(reference, true, "dodo_uat_executor_dodo_context_invalid");
  if (new Set(Object.values(value.offers)).size !== Object.keys(OFFERS).length) fail("dodo_uat_executor_dodo_context_invalid");
  let privateKey;
  try { privateKey = createPrivateKey(value.runner.privateKeyPem); } catch { fail("dodo_uat_executor_attestation_key_invalid"); }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("dodo_uat_executor_attestation_key_invalid");
  return { ...value, privateKey };
}

async function responseBytes(response, issue) {
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_RESPONSE_BYTES) fail(`${issue}_too_large`);
  return body;
}

async function requestJson(fetcher, url, init, issue) {
  let response;
  try { response = await fetcher(url, init); } catch { fail(`${issue}_unavailable`); }
  const body = await responseBytes(response, issue);
  if (!response.ok) {
    if (response.status === 409 || response.status === 501) fail("dodo_uat_executor_scenario_unsupported_safely");
    fail(`${issue}_http_${response.status}`);
  }
  try { return JSON.parse(body.toString("utf8")); } catch { fail(`${issue}_response_invalid`); }
}

function cloudflareRows(payload, issue) {
  object(payload, issue);
  if (payload.success !== true) fail(issue);
  const envelopes = Array.isArray(payload.result) ? payload.result : [payload.result];
  if (envelopes.length !== 1 || envelopes[0]?.success !== true || !Array.isArray(envelopes[0].results)) fail(issue);
  return envelopes[0].results;
}

const SNAPSHOT_QUERIES = Object.freeze([
  Object.freeze({
    name: "subscription",
    sql: `SELECT subscriptions.state, plans.code AS plan_code, subscriptions.market_code,
      subscriptions.price_currency, subscriptions.current_period_start, subscriptions.current_period_end,
      subscriptions.grace_ends_at, scheduled.code AS scheduled_plan_code,
      subscriptions.scheduled_effective_at, subscriptions.version
    FROM shops
    LEFT JOIN shop_subscriptions AS subscriptions ON subscriptions.shop_id = shops.id
      AND subscriptions.state != 'canceled'
    LEFT JOIN plans ON plans.id = subscriptions.plan_id
    LEFT JOIN plans AS scheduled ON scheduled.id = subscriptions.scheduled_plan_id
    WHERE shops.public_id = ?
    ORDER BY subscriptions.created_at DESC, subscriptions.id DESC LIMIT 1`,
  }),
  Object.freeze({
    name: "checkouts",
    sql: `SELECT sessions.status, plans.code AS plan_code, prices.market_code, prices.currency,
      sessions.version, sessions.reconciliation_attempts
    FROM shops INNER JOIN billing_checkout_sessions AS sessions ON sessions.shop_id = shops.id
    INNER JOIN plans ON plans.id = sessions.plan_id INNER JOIN plan_prices AS prices ON prices.id = sessions.price_id
    WHERE shops.public_id = ? ORDER BY sessions.created_at DESC, sessions.id DESC LIMIT 8`,
  }),
  Object.freeze({
    name: "invoices",
    sql: `SELECT invoices.status, invoices.amount_minor, invoices.currency, invoices.period_start,
      invoices.period_end, invoices.version FROM shops
    INNER JOIN billing_invoices AS invoices ON invoices.shop_id = shops.id
    WHERE shops.public_id = ? ORDER BY invoices.created_at DESC, invoices.id DESC LIMIT 8`,
  }),
  Object.freeze({
    name: "events",
    sql: `SELECT events.event_type, events.status, events.payload_hash, events.occurred_at,
      events.processed_at FROM shops INNER JOIN billing_provider_events AS events ON events.shop_id = shops.id
    WHERE shops.public_id = ? AND events.provider_code = 'dodo'
    ORDER BY events.created_at DESC, events.id DESC LIMIT 16`,
  }),
  Object.freeze({
    name: "catalog",
    sql: `SELECT plans.code AS plan_code, prices.market_code, prices.currency, prices.amount_minor,
      prices.interval, prices.tax_behavior, prices.is_active, prices.provider_price_ref
    FROM plan_prices AS prices INNER JOIN plans ON plans.id = prices.plan_id
    WHERE prices.provider_code = 'dodo' AND prices.effective_to IS NULL
    ORDER BY CASE plans.code WHEN 'starter' THEN 0 ELSE 1 END,
      CASE prices.market_code WHEN 'vn' THEN 0 ELSE 1 END`,
    params: [],
  }),
]);

async function snapshotD1(fetcher, context) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${context.accountId}/d1/database/${context.databaseId}/query`;
  const snapshot = {};
  for (const query of SNAPSHOT_QUERIES) {
    const payload = await requestJson(fetcher, endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${context.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ params: query.params ?? [context.shopPublicId], sql: query.sql }),
    }, "dodo_uat_executor_d1_query");
    snapshot[query.name] = cloudflareRows(payload, "dodo_uat_executor_d1_response_invalid");
  }
  if (snapshot.subscription.length !== 1) fail("dodo_uat_executor_d1_shop_missing");
  return canonical(snapshot);
}

function subscription(snapshot) {
  const row = snapshot.subscription[0] ?? {};
  return row.state === null || row.state === undefined ? null : row;
}

function catalogConfigured(snapshot, dodo) {
  if (snapshot.catalog.length !== 4) return false;
  const expected = [OFFERS.starter_vn, OFFERS.starter_global, OFFERS.pro_vn, OFFERS.pro_global];
  return snapshot.catalog.every((row, index) => {
    const offer = expected[index];
    const offerKey = offer === undefined ? null : `${offer.planCode}_${offer.marketCode}`;
    return offer !== undefined && row.plan_code === offer.planCode && row.market_code === offer.marketCode
      && row.currency === offer.currency && row.amount_minor === offer.amountMinor && row.interval === "month"
      && row.tax_behavior === "inclusive" && row.is_active === 1
      && offerKey !== null && row.provider_price_ref === dodo.offers[offerKey];
  });
}

function assertStateLabel(label, snapshot, other, dodo, issue) {
  const current = subscription(snapshot);
  const latestCheckout = snapshot.checkouts[0] ?? null;
  const is = (state, plan = null) => current?.state === state && (plan === null || current?.plan_code === plan);
  const valid = label === "no_subscription" ? current === null
    : label === "pending_payment" ? is("pending_payment")
      : label === "starter_pending_payment" ? is("pending_payment", "starter") && latestCheckout?.plan_code === "starter"
        : label === "pro_pending_payment" ? is("pending_payment", "pro") && latestCheckout?.plan_code === "pro"
          : label === "vn_vnd_pending_payment" ? is("pending_payment") && current?.market_code === "vn" && current?.price_currency === "VND"
            : label === "global_usd_pending_payment" ? is("pending_payment") && current?.market_code === "global" && current?.price_currency === "USD"
              : label === "active" ? is("active")
                : label === "suspended" ? is("suspended")
                  : label === "grace" ? is("grace_period")
                    : label === "active_starter" ? is("active", "starter")
                      : label === "active_pro" ? is("active", "pro")
                        : label === "active_pro_downgrade_scheduled" ? is("downgrade_scheduled", "pro") && current?.scheduled_plan_code === "starter"
                          : label === "cancel_at_period_end" ? is("cancel_scheduled")
                            : label === "catalog_configured" ? catalogConfigured(snapshot, dodo)
                              : label === "active_current_period" ? is("active")
                                : label === "active_renewed_period" ? is("active") && typeof current.current_period_end === "string"
                                  && new Date(current.current_period_end).getTime() > new Date(subscription(other)?.current_period_end ?? 0).getTime()
                                  : label === "runtime_state" || label === "tenant_state";
  if (!valid) fail(issue);
}

function assertStateTransition(contract, before, after, dodo) {
  assertStateLabel(contract.stateBefore, before, after, dodo, "dodo_uat_executor_d1_before_state_invalid");
  assertStateLabel(contract.stateAfter, after, before, dodo, "dodo_uat_executor_d1_after_state_invalid");
  const beforeHash = sha256(bytes(before));
  const afterHash = sha256(bytes(after));
  if (contract.stateEffect === "no_op" && beforeHash !== afterHash) fail("dodo_uat_executor_d1_no_op_invalid");
  if (contract.stateEffect === "transition" && beforeHash === afterHash) fail("dodo_uat_executor_d1_transition_missing");
  return { afterHash, beforeHash };
}

async function control(fetcher, auth, input, phase, runId = null) {
  const result = await requestJson(fetcher, `${auth.runtimeOrigin}${auth.controlPath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      phase,
      provider: "dodo",
      releaseId: input.release.releaseId,
      runId,
      scenarioId: input.scenarioId,
      schemaVersion: 1,
      workerVersion: input.release.workerVersion,
    }),
  }, "dodo_uat_executor_control");
  if (phase === "prepare") {
    exactKeys(result, ["phase", "provider", "releaseId", "runId", "scenarioId", "schemaVersion", "workerVersion"], "dodo_uat_executor_prepare_invalid");
    if (result.schemaVersion !== 1 || result.phase !== "prepared") fail("dodo_uat_executor_prepare_invalid");
  } else {
    exactKeys(result, ["event", "observedAt", "outcome", "phase", "provider", "providerCheckoutId", "releaseId", "requestId", "runId", "runtimeCode", "runtimeStatus", "scenarioId", "schemaVersion", "sessionId", "workerVersion"], "dodo_uat_executor_execution_invalid");
    if (result.schemaVersion !== 1 || result.phase !== "executed") fail("dodo_uat_executor_execution_invalid");
  }
  if (result.provider !== "dodo" || result.releaseId !== input.release.releaseId || result.workerVersion !== input.release.workerVersion
    || result.scenarioId !== input.scenarioId || (runId !== null && result.runId !== runId)) fail("dodo_uat_executor_control_binding_invalid");
  text(result.runId, REFERENCE, "dodo_uat_executor_control_binding_invalid", 160);
  return result;
}

function signatureKey(secret) {
  const stripped = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  try {
    const decoded = Buffer.from(stripped, "base64");
    if (decoded.length >= 16) return decoded;
  } catch { /* fall through */ }
  return Buffer.from(secret, "utf8");
}

function verifyWebhookEvent(event, secret, expectedAuthority) {
  if (event === null) fail("dodo_uat_executor_provider_event_missing");
  exactKeys(event, ["bodyBase64", "source", "webhookId", "webhookSignature", "webhookTimestamp"], "dodo_uat_executor_provider_event_invalid");
  if ((expectedAuthority === "dodo" && event.source !== "dodo_capture")
    || (expectedAuthority === "controlled_runner" && event.source !== "controlled_injection")) fail("dodo_uat_executor_provider_event_authority_invalid");
  const webhookId = optionalReference(event.webhookId, true, "dodo_uat_executor_provider_event_invalid");
  const timestamp = text(event.webhookTimestamp, /^\d{10}$/u, "dodo_uat_executor_provider_event_invalid", 10);
  const signatureHeader = text(event.webhookSignature, null, "dodo_uat_executor_provider_event_invalid", 4096);
  let body;
  try { body = Buffer.from(text(event.bodyBase64, /^[A-Za-z0-9+/]+={0,2}$/u, "dodo_uat_executor_provider_event_invalid", MAX_RESPONSE_BYTES), "base64"); } catch { fail("dodo_uat_executor_provider_event_invalid"); }
  if (body.length === 0 || body.length > MAX_RESPONSE_BYTES) fail("dodo_uat_executor_provider_event_invalid");
  const signed = Buffer.from(`${webhookId}.${timestamp}.${body.toString("utf8")}`, "utf8");
  const expected = createHmac("sha256", signatureKey(secret)).update(signed).digest();
  const verified = signatureHeader.split(/\s+/u).some((entry) => {
    const raw = entry.startsWith("v1,") ? entry.slice(3) : entry;
    let candidate;
    try { candidate = Buffer.from(raw, "base64"); } catch { return false; }
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
  if (!verified) fail("dodo_uat_executor_provider_signature_invalid");
  return {
    eventReference: opaqueReference("event", webhookId),
    providerEventSha256: sha256(body),
    providerSignatureSha256: sha256(Buffer.from(signatureHeader, "utf8")),
  };
}

async function verifyProviderCheckout(fetcher, dodo, checkoutId, scenarioId) {
  const reference = optionalReference(checkoutId, true, "dodo_uat_executor_checkout_reference_invalid");
  const payload = await requestJson(fetcher, `${PROVIDER_ORIGIN}/checkouts/${encodeURIComponent(reference)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${dodo.apiKey}` },
  }, "dodo_uat_executor_provider_checkout");
  const record = object(payload, "dodo_uat_executor_provider_checkout_invalid");
  const observedId = record.session_id ?? record.checkout_id ?? record.id;
  if (observedId !== reference) fail("dodo_uat_executor_provider_checkout_invalid");
  const expectedOfferKey = scenarioId === "starter_checkout" ? "starter_global"
    : scenarioId === "pro_checkout" ? "pro_global"
      : scenarioId === "vn_vnd_checkout" ? "starter_vn"
        : scenarioId === "global_usd_checkout" ? "starter_global" : null;
  if (expectedOfferKey !== null) {
    const productId = record.product_id ?? record.price_id ?? record.product?.product_id ?? record.product?.id;
    if (productId !== dodo.offers[expectedOfferKey]) fail("dodo_uat_executor_provider_checkout_offer_mismatch");
  }
  return sha256(bytes(record));
}

async function verifyCatalog(fetcher, dodo) {
  const observations = [];
  for (const [key, offer] of Object.entries(OFFERS)) {
    const reference = dodo.offers[key];
    const product = await requestJson(fetcher, `${PROVIDER_ORIGIN}/products/${encodeURIComponent(reference)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${dodo.apiKey}` },
    }, "dodo_uat_executor_provider_catalog");
    const price = object(product.price, "dodo_uat_executor_provider_catalog_invalid");
    if (product.product_id !== reference || product.is_recurring !== true || price.type !== "recurring_price"
      || price.currency !== offer.currency || price.price !== offer.amountMinor
      || price.payment_frequency_count !== 1 || String(price.payment_frequency_interval).toLowerCase() !== "month"
      || price.tax_inclusive !== true || price.trial_period_days !== 0) fail("dodo_uat_executor_provider_catalog_invalid");
    observations.push({ key, productSha256: sha256(bytes(product)) });
  }
  return sha256(bytes(observations));
}

function validateExecution(result, input) {
  parseIso(result.observedAt, "dodo_uat_executor_observed_at_invalid");
  if (result.outcome !== input.contract.outcome || !Number.isInteger(result.runtimeStatus)
    || result.runtimeStatus < 100 || result.runtimeStatus > 599
    || typeof result.runtimeCode !== "string" || !/^[a-z0-9_.:-]{2,96}$/u.test(result.runtimeCode)) fail("dodo_uat_executor_outcome_invalid");
  text(result.requestId, REFERENCE, "dodo_uat_executor_reference_invalid", 160);
  optionalReference(result.sessionId, input.contract.requiresSessionReference, "dodo_uat_executor_reference_invalid");
  if (input.scenarioId === "tenant_isolation" && result.runtimeStatus !== 403) fail("dodo_uat_executor_tenant_isolation_invalid");
  if (input.scenarioId === "invalid_signature" && result.runtimeStatus !== 401) fail("dodo_uat_executor_invalid_signature_probe_invalid");
}

function authority(input) {
  if (input.contract.signatureAuthority === "dodo") return "dodo_signed_webhook";
  if (input.contract.signatureAuthority === "controlled_runner") return "controlled_runner_signature";
  if (input.contract.eventSource === "dodo_test_api") return "dodo_test_api";
  return "staging_runtime";
}

async function writeArtifact(root, input, dodo, execution, fingerprints, references) {
  const artifactRef = `artifact:.wrangler/releases/staging/${input.release.releaseId}/dodo-uat-execution-proofs/${input.scenarioId}.json`;
  const path = resolve(root, artifactRef.slice("artifact:".length));
  const proof = {
    schemaVersion: 2,
    artifactKind: "dodo_uat_execution_proof",
    provider: "dodo",
    environment: "staging",
    providerEnvironment: "test_mode",
    scenarioId: input.scenarioId,
    release: input.release,
    observedAt: execution.observedAt,
    result: "passed",
    outcome: input.contract.outcome,
    executionMode: input.contract.executionMode,
    verificationMethod: input.contract.verificationMethod,
    authority: {
      runnerId: "selinow-dodo-staging-runner-v1",
      eventSource: input.contract.eventSource,
      signatureAuthority: input.contract.signatureAuthority,
      controlledInjection: input.contract.controlledInjection,
    },
    references,
    fingerprints,
    state: { before: input.contract.stateBefore, after: input.contract.stateAfter, effect: input.contract.stateEffect },
    relatedScenario: input.contract.relatedScenarioId === null ? null : {
      scenarioId: input.contract.relatedScenarioId,
      relationship: input.contract.relationship,
    },
    redaction: { noRawPayload: true, noSensitiveValues: true, noCustomerData: true, noPaymentInstrumentData: true },
    attestation: { algorithm: "ed25519", keyId: dodo.runner.keyId, signedAt: execution.observedAt, signatureBase64: "" },
  };
  proof.attestation.signatureBase64 = sign(null, Buffer.from(serializeDodoUatExecutionProofPayload(proof)), dodo.privateKey).toString("base64");
  const artifactBytes = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`, "utf8");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, artifactBytes, { flag: "wx", mode: 0o600 }).catch((error) => {
    if (error?.code === "EEXIST") fail("dodo_uat_executor_artifact_exists");
    fail("dodo_uat_executor_artifact_write_failed");
  });
  await chmod(path, 0o600);
  return { artifactRef, artifactSha256: sha256(artifactBytes) };
}

export async function runDodoUatExecutor({
  environment = process.env,
  fetcher = globalThis.fetch,
  inputStream = process.stdin,
  now = () => new Date(),
  repositoryRoot = process.cwd(),
} = {}) {
  if (typeof fetcher !== "function") fail("dodo_uat_executor_fetch_unavailable");
  if (environment.SELINOW_UAT_RUNNER !== "1" || environment.SELINOW_UAT_PROVIDER !== "dodo") fail("dodo_uat_executor_invocation_invalid");
  const input = await readInput(inputStream);
  if (environment.SELINOW_UAT_SCENARIO_ID !== input.scenarioId || environment.SELINOW_UAT_RELEASE_ID !== input.release.releaseId
    || environment.SELINOW_UAT_WORKER_VERSION !== input.release.workerVersion) fail("dodo_uat_executor_invocation_binding_invalid");
  const [authJson, d1Json, dodoJson] = await Promise.all([
    readPrivateJson(resolve(environment.SELINOW_UAT_AUTH_CONTEXT_PATH ?? ""), "dodo_uat_executor_auth_context"),
    readPrivateJson(resolve(environment.SELINOW_UAT_D1_CONTEXT_PATH ?? ""), "dodo_uat_executor_d1_context"),
    readPrivateJson(resolve(environment.SELINOW_UAT_DODO_CONTEXT_PATH ?? ""), "dodo_uat_executor_dodo_context"),
  ]);
  const auth = validateAuthContext(authJson);
  const d1 = validateD1Context(d1Json);
  const dodo = validateDodoContext(dodoJson);
  const prepared = await control(fetcher, auth, input, "prepare");
  const before = await snapshotD1(fetcher, d1);
  const execution = await control(fetcher, auth, input, "execute", prepared.runId);
  validateExecution(execution, input);
  const after = await snapshotD1(fetcher, d1);
  const stateHashes = assertStateTransition(input.contract, before, after, dodo);

  let providerProbeSha256 = null;
  if (input.scenarioId === "plan_catalog_offers") providerProbeSha256 = await verifyCatalog(fetcher, dodo);
  if (input.contract.executionMode === "provider_checkout_observation" || input.contract.executionMode === "controlled_checkout_fault") {
    providerProbeSha256 = await verifyProviderCheckout(fetcher, dodo, execution.providerCheckoutId, input.scenarioId);
  } else if (execution.providerCheckoutId !== null) fail("dodo_uat_executor_checkout_reference_unexpected");

  let provider = { eventReference: null, providerEventSha256: null, providerSignatureSha256: null };
  if (input.contract.signatureAuthority !== "none") {
    provider = verifyWebhookEvent(execution.event, dodo.webhookSecret, input.contract.signatureAuthority);
  } else if (execution.event !== null) fail("dodo_uat_executor_provider_event_unexpected");

  const requestReference = opaqueReference("request", execution.requestId);
  const sessionReference = execution.sessionId === null ? null : opaqueReference("session", execution.sessionId);
  const d1TransitionSha256 = sha256(bytes({ after: stateHashes.afterHash, before: stateHashes.beforeHash, scenarioId: input.scenarioId }));
  const executionTranscriptSha256 = sha256(bytes({
    d1TransitionSha256,
    eventReference: provider.eventReference,
    observedAt: execution.observedAt,
    outcome: execution.outcome,
    providerProbeSha256,
    requestReference,
    runReference: opaqueReference("request", prepared.runId),
    runtimeCode: execution.runtimeCode,
    runtimeStatus: execution.runtimeStatus,
    scenarioId: input.scenarioId,
    sessionReference,
  }));
  const fingerprints = {
    executionTranscriptSha256,
    providerEventSha256: provider.providerEventSha256,
    providerSignatureSha256: provider.providerSignatureSha256,
    d1BeforeSha256: stateHashes.beforeHash,
    d1AfterSha256: stateHashes.afterHash,
    d1TransitionSha256,
  };
  const references = { requestReference, eventReference: provider.eventReference, sessionReference };
  const artifact = await writeArtifact(repositoryRoot, input, dodo, execution, fingerprints, references);
  const observedNow = now();
  if (!(observedNow instanceof Date) || !Number.isFinite(observedNow.getTime())) fail("dodo_uat_executor_clock_invalid");
  return {
    schemaVersion: 1,
    artifactRef: artifact.artifactRef,
    artifactSha256: artifact.artifactSha256,
    authority: authority(input),
    d1AfterSha256: fingerprints.d1AfterSha256,
    d1BeforeSha256: fingerprints.d1BeforeSha256,
    d1TransitionSha256: fingerprints.d1TransitionSha256,
    executionTranscriptSha256: fingerprints.executionTranscriptSha256,
    observedAt: execution.observedAt,
    provider: "dodo",
    providerEventSha256: fingerprints.providerEventSha256,
    providerSignatureSha256: fingerprints.providerSignatureSha256,
    release: input.release,
    scenarioId: input.scenarioId,
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const receipt = await runDodoUatExecutor();
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:,.-]{1,220}$/u.test(error.message)
      ? error.message
      : "dodo_uat_executor_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
