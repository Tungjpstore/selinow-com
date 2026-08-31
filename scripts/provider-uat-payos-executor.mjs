#!/usr/bin/env node

import { Buffer } from "node:buffer";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
} from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const ATTEMPT_ID = /^pay_[0-9a-f-]{36}$/u;
const DATABASE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const EVENT_ID = /^pev_[0-9a-f-]{36}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/u;
const RELEASE_ID = /^stg_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{12}$/u;
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SHOP_ID = /^shop_[0-9a-f-]{36}$/u;
const WORKER_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const SCENARIOS = new Set(["direct_reconciliation", "signed_exact_payment"]);
const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

function fail(code) {
  throw new Error(code);
}

function exactKeys(value, expected, issue) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(issue);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(issue);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function hash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(canonical(value)), "utf8");
  return createHash("sha256").update(bytes).digest("hex");
}

function iso(value, issue) {
  if (typeof value !== "string") fail(issue);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail(issue);
  return parsed;
}

function hasControlCharacters(value) {
  return typeof value === "string"
    && [...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);
}

async function readPrivateFile(path, issue) {
  const descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (descriptor === null) fail(issue);
  try {
    const opened = await descriptor.stat({ bigint: true });
    const current = await stat(path, { bigint: true });
    if (!opened.isFile() || (opened.mode & 0o777n) !== 0o600n || opened.dev !== current.dev || opened.ino !== current.ino) {
      fail(`${issue}_permissions_invalid`);
    }
    if (opened.size < 2n || opened.size > BigInt(MAX_CONTEXT_BYTES)) fail(`${issue}_size_invalid`);
    const bytes = await descriptor.readFile();
    const closed = await descriptor.stat({ bigint: true });
    if (opened.size !== closed.size || opened.mtimeNs !== closed.mtimeNs || opened.ctimeNs !== closed.ctimeNs) {
      fail(`${issue}_changed_during_read`);
    }
    return bytes;
  } finally {
    await descriptor.close();
  }
}

async function readPrivateJson(path, issue) {
  const bytes = await readPrivateFile(path, issue);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${issue}_invalid`);
  }
}

function assertReleaseInput(input, environment) {
  exactKeys(input, ["provider", "providerEnvironment", "release", "requiredClaims", "scenarioId", "schemaVersion"], "payos_executor_input_invalid");
  exactKeys(input.release, ["commitSha", "manifestRef", "manifestSha256", "releaseId", "treeSha", "workerVersion"], "payos_executor_release_invalid");
  const release = input.release;
  if (input.schemaVersion !== 1 || input.provider !== "payos" || input.providerEnvironment !== "production_controlled"
    || !SCENARIOS.has(input.scenarioId) || environment.SELINOW_UAT_RUNNER !== "1"
    || environment.SELINOW_UAT_PROVIDER !== "payos" || environment.SELINOW_UAT_SCENARIO_ID !== input.scenarioId
    || environment.SELINOW_UAT_RELEASE_ID !== release.releaseId || environment.SELINOW_UAT_WORKER_VERSION !== release.workerVersion
    || !GIT_SHA.test(release.commitSha ?? "") || !GIT_SHA.test(release.treeSha ?? "")
    || !SHA256.test(release.manifestSha256 ?? "") || !RELEASE_ID.test(release.releaseId ?? "")
    || !WORKER_VERSION.test(release.workerVersion ?? "")
    || release.manifestRef !== `.wrangler/releases/staging/${release.releaseId}/release-manifest.json`) {
    fail("payos_executor_input_binding_invalid");
  }
  const expectedClaims = [
    "artifactRef", "artifactSha256", "providerEventSha256", "providerSignatureSha256",
    "d1BeforeSha256", "d1AfterSha256", "d1TransitionSha256", "executionTranscriptSha256",
  ];
  if (!Array.isArray(input.requiredClaims) || input.requiredClaims.length !== expectedClaims.length
    || input.requiredClaims.some((claim, index) => claim !== expectedClaims[index])) fail("payos_executor_input_claims_invalid");
}

function assertD1Context(value) {
  exactKeys(value, ["accountId", "apiToken", "databaseId", "environment", "provider", "schemaVersion"], "payos_executor_d1_context_invalid");
  if (value.schemaVersion !== 1 || value.environment !== "staging" || value.provider !== "payos"
    || !ACCOUNT_ID.test(value.accountId ?? "") || !DATABASE_ID.test(value.databaseId ?? "")
    || typeof value.apiToken !== "string" || value.apiToken.length < 20 || value.apiToken.length > 512) {
    fail("payos_executor_d1_context_invalid");
  }
}

function assertAuthContext(value, root) {
  exactKeys(value, ["environment", "provider", "runnerAttestation", "runtime", "schemaVersion"], "payos_executor_auth_context_invalid");
  exactKeys(value.runnerAttestation, ["keyId", "privateKeyPath"], "payos_executor_auth_context_invalid");
  exactKeys(value.runtime, ["baseOrigin", "cookieHeader", "csrfToken"], "payos_executor_auth_context_invalid");
  let origin;
  try { origin = new URL(value.runtime.baseOrigin); } catch { fail("payos_executor_auth_context_invalid"); }
  const relativeKeyPath = relative(root, resolve(root, value.runnerAttestation.privateKeyPath ?? ""));
  if (value.schemaVersion !== 1 || value.environment !== "staging" || value.provider !== "payos"
    || !KEY_ID.test(value.runnerAttestation.keyId ?? "") || relativeKeyPath === "" || relativeKeyPath === ".."
    || relativeKeyPath.startsWith(`..${sep}`) || relativeKeyPath.includes("\\")
    || origin.protocol !== "https:" || origin.username !== "" || origin.password !== ""
    || origin.pathname !== "/" || origin.search !== "" || origin.hash !== ""
    || !(origin.hostname === "staging.selinow.com" || origin.hostname.endsWith(".staging.selinow.com"))
    || typeof value.runtime.cookieHeader !== "string" || value.runtime.cookieHeader.length < 16 || value.runtime.cookieHeader.length > 4096
    || /[\r\n]/u.test(value.runtime.cookieHeader)
    || typeof value.runtime.csrfToken !== "string" || value.runtime.csrfToken.length < 16 || value.runtime.csrfToken.length > 512
    || /[\r\n]/u.test(value.runtime.csrfToken)) {
    fail("payos_executor_auth_context_invalid");
  }
}

function assertPayosContext(value) {
  exactKeys(value, ["environment", "maxPollMs", "pollIntervalMs", "provider", "scenarios", "schemaVersion"], "payos_executor_payos_context_invalid");
  exactKeys(value.scenarios, ["direct_reconciliation", "signed_exact_payment"], "payos_executor_payos_context_invalid");
  for (const scenario of SCENARIOS) {
    exactKeys(value.scenarios[scenario], ["attemptPublicId", "shopPublicId"], "payos_executor_payos_context_invalid");
    if (!ATTEMPT_ID.test(value.scenarios[scenario].attemptPublicId ?? "") || !SHOP_ID.test(value.scenarios[scenario].shopPublicId ?? "")) {
      fail("payos_executor_payos_context_invalid");
    }
  }
  if (value.schemaVersion !== 1 || value.environment !== "staging" || value.provider !== "payos"
    || !Number.isSafeInteger(value.pollIntervalMs) || value.pollIntervalMs < 250 || value.pollIntervalMs > 10_000
    || !Number.isSafeInteger(value.maxPollMs) || value.maxPollMs < 1_000 || value.maxPollMs > 14 * 60_000
    || value.scenarios.direct_reconciliation.attemptPublicId === value.scenarios.signed_exact_payment.attemptPublicId) {
    fail("payos_executor_payos_context_invalid");
  }
}

async function boundedJson(response, issue) {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) fail(issue);
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) fail(issue);
  try {
    return JSON.parse(text);
  } catch {
    fail(issue);
  }
}

const SNAPSHOT_SQL = `
SELECT
  attempts.id AS attemptId,
  attempts.public_id AS attemptPublicId,
  attempts.state AS attemptState,
  attempts.paid_event_id AS paidEventId,
  attempts.reconcile_attempts AS reconcileAttempts,
  attempts.last_reconciled_at AS lastReconciledAt,
  orders.payment_status AS orderPaymentStatus,
  orders.status AS orderState,
  orders.fulfillment_status AS fulfillmentState,
  integrations.provider_identity_fingerprint AS providerIdentityFingerprint,
  events.id AS eventId,
  events.provider_event_reference AS providerEventReference,
  events.payload_hash AS eventPayloadHash,
  events.signature_verified AS signatureVerified,
  events.normalized_state AS eventState,
  events.process_result AS eventProcessResult,
  events.received_at AS eventReceivedAt,
  events.processed_at AS eventProcessedAt
FROM payment_attempts AS attempts
INNER JOIN shops ON shops.id = attempts.shop_id
INNER JOIN orders ON orders.id = attempts.order_id AND orders.shop_id = attempts.shop_id
INNER JOIN payment_integrations AS integrations
  ON integrations.id = attempts.integration_id AND integrations.shop_id = attempts.shop_id
LEFT JOIN payment_events AS events
  ON events.id = attempts.paid_event_id
  AND events.shop_id = attempts.shop_id
  AND events.payment_attempt_id = attempts.id
  AND events.integration_id = attempts.integration_id
WHERE shops.public_id = ? AND attempts.public_id = ?
  AND attempts.provider = 'payos' AND integrations.provider = 'payos'
LIMIT 2
`;

async function querySnapshot(context, scenario, fetcher) {
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${context.accountId}/d1/database/${context.databaseId}/query`, {
    body: JSON.stringify({ params: [scenario.shopPublicId, scenario.attemptPublicId], sql: SNAPSHOT_SQL }),
    headers: { Authorization: `Bearer ${context.apiToken}`, "Content-Type": "application/json" },
    method: "POST",
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (response === null || !response.ok) fail("payos_executor_d1_query_failed");
  const body = await boundedJson(response, "payos_executor_d1_response_invalid");
  const result = body?.result;
  if (body?.success !== true || !Array.isArray(result) || result.length !== 1
    || result[0]?.success !== true || !Array.isArray(result[0].results) || result[0].results.length !== 1) {
    fail("payos_executor_d1_response_invalid");
  }
  const row = result[0].results[0];
  exactKeys(row, [
    "attemptId", "attemptPublicId", "attemptState", "eventId", "eventPayloadHash", "eventProcessResult",
    "eventProcessedAt", "eventReceivedAt", "eventState", "fulfillmentState", "lastReconciledAt", "orderPaymentStatus",
    "orderState", "paidEventId", "providerEventReference", "providerIdentityFingerprint", "reconcileAttempts", "signatureVerified",
  ], "payos_executor_d1_snapshot_invalid");
  if (row.attemptPublicId !== scenario.attemptPublicId || typeof row.attemptId !== "string"
    || typeof row.providerIdentityFingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(row.providerIdentityFingerprint)
    || !Number.isSafeInteger(row.reconcileAttempts) || row.reconcileAttempts < 0) fail("payos_executor_d1_snapshot_invalid");
  return row;
}

function assertBefore(snapshot) {
  if (!new Set(["creating", "error", "pending"]).has(snapshot.attemptState)
    || snapshot.paidEventId !== null || snapshot.eventId !== null || snapshot.eventPayloadHash !== null
    || snapshot.signatureVerified !== null || !new Set(["pending", "unpaid"]).has(snapshot.orderPaymentStatus)) {
    fail("payos_executor_d1_before_invalid");
  }
}

function assertAfter(snapshot) {
  if (snapshot.attemptState !== "paid_exact" || !EVENT_ID.test(snapshot.paidEventId ?? "")
    || snapshot.eventId !== snapshot.paidEventId || !SHA256.test(snapshot.eventPayloadHash ?? "")
    || snapshot.signatureVerified !== 1 || snapshot.eventState !== "paid_exact"
    || snapshot.eventProcessResult !== "fulfilled" || snapshot.orderPaymentStatus !== "paid"
    || typeof snapshot.providerEventReference !== "string" || snapshot.providerEventReference.length < 1
    || snapshot.providerEventReference.length > 256 || hasControlCharacters(snapshot.providerEventReference)) {
    fail("payos_executor_d1_after_invalid");
  }
  iso(snapshot.eventReceivedAt, "payos_executor_d1_after_invalid");
  iso(snapshot.eventProcessedAt, "payos_executor_d1_after_invalid");
}

async function callReconciliation(auth, scenario, fetcher, idempotencyKey) {
  const endpoint = new URL(`/api/app/shops/${scenario.shopPublicId}/payments/payos/uat-reconciliation`, auth.runtime.baseOrigin);
  const response = await fetcher(endpoint, {
    body: JSON.stringify({ paymentAttemptPublicId: scenario.attemptPublicId }),
    headers: {
      "Content-Type": "application/json",
      Cookie: auth.runtime.cookieHeader,
      "Idempotency-Key": idempotencyKey,
      Origin: auth.runtime.baseOrigin.slice(0, -1),
      "X-CSRF-Token": auth.runtime.csrfToken,
    },
    method: "POST",
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(30_000),
  }).catch(() => null);
  if (response === null || response.status !== 201) fail("payos_executor_reconciliation_failed");
  const body = await boundedJson(response, "payos_executor_reconciliation_response_invalid");
  exactKeys(body, ["evidence", "ok", "requestId"], "payos_executor_reconciliation_response_invalid");
  exactKeys(body.evidence, [
    "attemptPublicId", "duplicate", "eventReference", "processed", "provider", "providerEnvironment",
    "replayed", "requestReference", "state", "verificationMethod",
  ], "payos_executor_reconciliation_response_invalid");
  const evidence = body.evidence;
  if (body.ok !== true || !REQUEST_ID.test(body.requestId ?? "") || evidence.attemptPublicId !== scenario.attemptPublicId
    || evidence.duplicate !== false || evidence.processed !== true || evidence.replayed !== false
    || evidence.provider !== "payos" || evidence.providerEnvironment !== "production_controlled"
    || evidence.state !== "paid_exact" || evidence.verificationMethod !== "verified_provider_response"
    || evidence.requestReference !== `request:${body.requestId}` || !/^event:pev_[0-9a-f-]{36}$/u.test(evidence.eventReference ?? "")) {
    fail("payos_executor_reconciliation_response_invalid");
  }
  return evidence;
}

async function waitForExactPayment({ context, fetcher, scenario, sleep }) {
  const deadline = Date.now() + context.maxPollMs;
  while (Date.now() < deadline) {
    await sleep(context.pollIntervalMs);
    const snapshot = await querySnapshot(context.d1, scenario, fetcher);
    if (snapshot.attemptState === "paid_exact") return snapshot;
    if (!new Set(["creating", "error", "pending"]).has(snapshot.attemptState)) fail("payos_executor_payment_terminal_invalid");
  }
  fail("payos_executor_payment_timeout");
}

function serializeRunnerPayload(artifact) {
  return JSON.stringify(canonical({
    ...artifact,
    runnerAttestation: {
      algorithm: artifact.runnerAttestation.algorithm,
      keyId: artifact.runnerAttestation.keyId,
      publicKeySpkiSha256: artifact.runnerAttestation.publicKeySpkiSha256,
      signedAt: artifact.runnerAttestation.signedAt,
    },
  }));
}

async function writeArtifact({ artifact, auth, root }) {
  const keyPath = resolve(root, auth.runnerAttestation.privateKeyPath);
  await assertNoSymlinkAncestors(root, dirname(keyPath), "payos_executor_runner_key_path_invalid");
  const keyBytes = await readPrivateFile(keyPath, "payos_executor_runner_key_missing");
  let privateKey;
  try { privateKey = createPrivateKey(keyBytes); } catch { fail("payos_executor_runner_key_invalid"); }
  if (privateKey.asymmetricKeyType !== "ed25519") fail("payos_executor_runner_key_invalid");
  const publicKey = createPublicKey(privateKey);
  artifact.runnerAttestation.publicKeySpkiSha256 = createHash("sha256")
    .update(publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  artifact.runnerAttestation.signatureBase64 = sign(
    null,
    Buffer.from(serializeRunnerPayload(artifact), "utf8"),
    privateKey,
  ).toString("base64");
  const ref = `.wrangler/releases/staging/${artifact.release.releaseId}/execution/payos-${artifact.scenarioId}.json`;
  const path = resolve(root, ref);
  const executionRoot = resolve(root, ".wrangler", "releases", "staging", artifact.release.releaseId, "execution");
  if (dirname(path) !== executionRoot) fail("payos_executor_artifact_path_invalid");
  await assertNoSymlinkAncestors(root, executionRoot, "payos_executor_artifact_path_invalid");
  await mkdir(executionRoot, { mode: 0o700, recursive: true });
  await assertNoSymlinkAncestors(root, executionRoot, "payos_executor_artifact_path_invalid");
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 }).catch(() => fail("payos_executor_artifact_exists"));
  await chmod(path, 0o600);
  return { artifactRef: `artifact:${ref}`, artifactSha256: hash(bytes) };
}

async function assertNoSymlinkAncestors(root, path, issue) {
  const relativePath = relative(resolve(root), resolve(path));
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) fail(issue);
  let current = resolve(root);
  for (const segment of relativePath.split(sep)) {
    current = resolve(current, segment);
    const entry = await lstat(current).catch(() => null);
    if (entry !== null && (!entry.isDirectory() || entry.isSymbolicLink())) fail(issue);
  }
}

function buildArtifact({ after, auth, input, requestReference, scenarioId, signedAt }) {
  const observedAt = after.eventProcessedAt;
  const observed = iso(observedAt, "payos_executor_observed_at_invalid");
  const signed = iso(signedAt, "payos_executor_signed_at_invalid");
  if (signed.getTime() < observed.getTime() || signed.getTime() > observed.getTime() + 15 * 60_000) fail("payos_executor_signed_at_invalid");
  return {
    authority: {
      attemptReference: `attempt:${after.attemptPublicId}`,
      authoritySource: scenarioId === "signed_exact_payment" ? "staging_d1_verified_event" : "staging_exact_attempt_reconciliation",
      eventReference: `event:${after.eventId}`,
      providerAuthority: scenarioId === "signed_exact_payment" ? "provider_signed_webhook" : "provider_signed_response",
      providerReference: `provider:${hash(Buffer.from(after.providerEventReference, "utf8"))}`,
      requestReference,
    },
    controlledAccountFingerprintSha256: hash(Buffer.from(after.providerIdentityFingerprint, "utf8")),
    environment: "staging",
    evidenceKind: "provider_execution",
    observedAt,
    provider: "payos",
    providerEnvironment: "production_controlled",
    redaction: { noCredentialData: true, noCustomerData: true, noFinancialDetails: true, noRawPayload: true },
    release: input.release,
    result: { duplicate: false, processed: true, state: "paid_exact" },
    runnerAttestation: {
      algorithm: "ed25519",
      keyId: auth.runnerAttestation.keyId,
      publicKeySpkiSha256: "",
      signatureBase64: "",
      signedAt,
    },
    scenarioId,
    schemaVersion: 1,
    verificationMethod: scenarioId === "signed_exact_payment" ? "signed_webhook" : "verified_provider_response",
  };
}

export async function executePayosProviderUat({
  environment = process.env,
  fetcher = fetch,
  input,
  now = () => new Date(),
  randomId = randomUUID,
  repositoryRoot = process.cwd(),
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
}) {
  assertReleaseInput(input, environment);
  const [d1, auth, payos] = await Promise.all([
    readPrivateJson(resolve(environment.SELINOW_UAT_D1_CONTEXT_PATH ?? ""), "payos_executor_d1_context_missing"),
    readPrivateJson(resolve(environment.SELINOW_UAT_AUTH_CONTEXT_PATH ?? ""), "payos_executor_auth_context_missing"),
    readPrivateJson(resolve(environment.SELINOW_UAT_PAYOS_CONTEXT_PATH ?? ""), "payos_executor_payos_context_missing"),
  ]);
  const root = resolve(repositoryRoot);
  assertD1Context(d1);
  assertAuthContext(auth, root);
  assertPayosContext(payos);
  const scenario = payos.scenarios[input.scenarioId];
  const before = await querySnapshot(d1, scenario, fetcher);
  assertBefore(before);
  let after;
  let requestReference;
  const safeExecutionId = `payos-uat-${randomId()}`;
  if (!REQUEST_ID.test(safeExecutionId)) fail("payos_executor_request_id_invalid");
  if (input.scenarioId === "direct_reconciliation") {
    const evidence = await callReconciliation(auth, scenario, fetcher, safeExecutionId);
    after = await querySnapshot(d1, scenario, fetcher);
    requestReference = evidence.requestReference;
    if (evidence.eventReference !== `event:${after.eventId}`) fail("payos_executor_reconciliation_d1_mismatch");
  } else {
    after = await waitForExactPayment({ context: { d1, maxPollMs: payos.maxPollMs, pollIntervalMs: payos.pollIntervalMs }, fetcher, scenario, sleep });
    requestReference = `request:${safeExecutionId}`;
  }
  assertAfter(after);
  if (before.attemptId !== after.attemptId || before.providerIdentityFingerprint !== after.providerIdentityFingerprint) {
    fail("payos_executor_d1_identity_changed");
  }
  const signedAt = now().toISOString();
  const artifact = buildArtifact({ after, auth, input, requestReference, scenarioId: input.scenarioId, signedAt });
  const artifactOutput = await writeArtifact({ artifact, auth, root });
  const d1BeforeSha256 = hash(before);
  const d1AfterSha256 = hash(after);
  const providerEventSha256 = hash({
    eventId: after.eventId,
    eventPayloadHash: after.eventPayloadHash,
    eventProcessResult: after.eventProcessResult,
    eventState: after.eventState,
  });
  const providerSignatureSha256 = hash({
    eventId: after.eventId,
    eventPayloadHash: after.eventPayloadHash,
    provider: "payos",
    signatureVerified: after.signatureVerified,
    verificationMethod: artifact.verificationMethod,
  });
  return {
    ...artifactOutput,
    authority: "payos_signed_webhook_or_verified_response",
    d1AfterSha256,
    d1BeforeSha256,
    d1TransitionSha256: hash({ d1AfterSha256, d1BeforeSha256, eventId: after.eventId, scenarioId: input.scenarioId }),
    executionTranscriptSha256: hash({
      artifactSha256: artifactOutput.artifactSha256,
      eventReference: artifact.authority.eventReference,
      observedAt: artifact.observedAt,
      requestReference: artifact.authority.requestReference,
      scenarioId: input.scenarioId,
    }),
    observedAt: artifact.observedAt,
    provider: "payos",
    providerEventSha256,
    providerSignatureSha256,
    release: input.release,
    scenarioId: input.scenarioId,
    schemaVersion: 1,
  };
}

async function readStdin() {
  let value = "";
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value) > 64 * 1024) fail("payos_executor_input_too_large");
  }
  try { return JSON.parse(value); } catch { fail("payos_executor_input_invalid"); }
}

export async function main() {
  const receipt = await executePayosProviderUat({ input: await readStdin() });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  return receipt;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_:,.-]{1,220}$/u.test(error.message)
      ? error.message
      : "payos_executor_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
