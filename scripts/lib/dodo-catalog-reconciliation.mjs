import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { runWrangler } from "./cli.mjs";

const PROVIDER_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;
const ENVIRONMENTS = new Set(["staging", "production"]);
const DODO_API_BASE_URLS = Object.freeze({
  live_mode: "https://live.dodopayments.com",
  test_mode: "https://test.dodopayments.com",
});

export const DODO_CATALOG_OFFERS = Object.freeze([
  Object.freeze({
    amountMinor: 99_000,
    currency: "VND",
    id: "price_starter_vn_v1",
    marketCode: "vn",
    pendingRef: "pending:dodo:starter:vn:month:v1",
    planCode: "starter",
    referenceEnv: "DODO_STARTER_VN_PRODUCT_ID",
    rotatedId: "price_starter_vn_v2",
  }),
  Object.freeze({
    amountMinor: 299_000,
    currency: "VND",
    id: "price_pro_vn_v1",
    marketCode: "vn",
    pendingRef: "pending:dodo:pro:vn:month:v1",
    planCode: "pro",
    referenceEnv: "DODO_PRO_VN_PRODUCT_ID",
    rotatedId: "price_pro_vn_v2",
  }),
  Object.freeze({
    amountMinor: 500,
    currency: "USD",
    id: "price_starter_global_v1",
    marketCode: "global",
    pendingRef: "pending:dodo:starter:global:month:v1",
    planCode: "starter",
    referenceEnv: "DODO_STARTER_GLOBAL_PRODUCT_ID",
    rotatedId: "price_starter_global_v2",
  }),
  Object.freeze({
    amountMinor: 1500,
    currency: "USD",
    id: "price_pro_global_v1",
    marketCode: "global",
    pendingRef: "pending:dodo:pro:global:month:v1",
    planCode: "pro",
    referenceEnv: "DODO_PRO_GLOBAL_PRODUCT_ID",
    rotatedId: "price_pro_global_v2",
  }),
]);

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeReference(value, field) {
  if (typeof value !== "string" || !PROVIDER_REF_PATTERN.test(value) || value.startsWith("pending:")) {
    throw new Error(`${field}_invalid`);
  }
  return value;
}

export function parseDodoCatalogArguments(argv) {
  const options = {
    apply: false,
    confirmCatalogUpdate: false,
    confirmProduction: false,
    confirmProductionLiveCatalog: false,
    confirmStagingTestCatalog: false,
    explicitDryRun: false,
    environment: null,
    inspect: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--dry-run") options.explicitDryRun = true;
    else if (argument === "--inspect") options.inspect = true;
    else if (argument === "--confirm-catalog-update") options.confirmCatalogUpdate = true;
    else if (argument === "--confirm-production") options.confirmProduction = true;
    else if (argument === "--confirm-production-live-catalog") options.confirmProductionLiveCatalog = true;
    else if (argument === "--confirm-staging-test-catalog") options.confirmStagingTestCatalog = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--env") {
      options.environment = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--env=")) options.environment = argument.slice("--env=".length);
    else throw new Error("unknown_argument");
  }
  if (options.apply && options.explicitDryRun) throw new Error("dodo_catalog_mode_conflict");
  if (options.inspect && (options.apply || options.explicitDryRun)) throw new Error("dodo_catalog_mode_conflict");
  if (!ENVIRONMENTS.has(options.environment)) throw new Error("dodo_catalog_environment_required");
  if (options.environment === "production" && options.apply && !options.confirmProduction) {
    throw new Error("production_confirmation_required");
  }
  if (options.apply && !options.confirmCatalogUpdate) throw new Error("dodo_catalog_confirmation_required");
  if (options.environment === "staging" && options.apply && !options.confirmStagingTestCatalog) {
    throw new Error("staging_test_catalog_confirmation_required");
  }
  if (options.environment === "production" && options.apply && !options.confirmProductionLiveCatalog) {
    throw new Error("production_live_catalog_confirmation_required");
  }
  return options;
}

export function readDodoCatalogReferences(environment = process.env) {
  const values = Object.fromEntries(DODO_CATALOG_OFFERS.map((offer) => [
    offer.id,
    safeReference(environment[offer.referenceEnv], offer.referenceEnv.toLowerCase()),
  ]));
  const references = Object.values(values);
  if (new Set(references).size !== references.length) throw new Error("dodo_catalog_references_not_unique");
  return values;
}

export function readOptionalDodoCatalogReferences(environment = process.env) {
  const present = DODO_CATALOG_OFFERS.filter((offer) => environment[offer.referenceEnv] !== undefined);
  if (present.length === 0) return null;
  if (present.length !== DODO_CATALOG_OFFERS.length) throw new Error("dodo_catalog_references_incomplete");
  return readDodoCatalogReferences(environment);
}

export function readDodoCatalogProviderMode(environment = process.env) {
  const value = environment.DODO_PAYMENTS_ENVIRONMENT;
  if (value !== "test_mode" && value !== "live_mode") throw new Error("dodo_catalog_provider_mode_required");
  return value;
}

export function validateDodoCatalogProviderEnvironment(input) {
  if (input.environment === "staging") {
    if (input.providerMode !== "test_mode") throw new Error("dodo_catalog_staging_live_mode_forbidden");
    return;
  }
  if (input.environment !== "production") throw new Error("dodo_catalog_environment_required");
  if (input.providerMode !== "live_mode") throw new Error("dodo_catalog_production_test_mode_forbidden");
}

function dodoCatalogApiBaseUrl(providerMode) {
  const apiBaseUrl = DODO_API_BASE_URLS[providerMode];
  if (apiBaseUrl === undefined) throw new Error("dodo_catalog_provider_mode_required");
  return apiBaseUrl;
}

function validateDodoCatalogApiBaseUrl(apiBaseUrl, providerMode) {
  if (apiBaseUrl !== dodoCatalogApiBaseUrl(providerMode)) throw new Error("dodo_catalog_provider_api_base_invalid");
}

export function validateDodoCatalogTarget(input) {
  if (input.environment === "staging") {
    if (input.confirmStagingTestCatalog !== true) throw new Error("staging_test_catalog_confirmation_required");
  } else {
    if (input.environment !== "production") throw new Error("dodo_catalog_environment_required");
    if (input.confirmProduction !== true) throw new Error("production_confirmation_required");
    if (input.confirmProductionLiveCatalog !== true) throw new Error("production_live_catalog_confirmation_required");
  }
  validateDodoCatalogProviderEnvironment(input);
}

function readPublishedSourceReferences(rows) {
  return Object.fromEntries(DODO_CATALOG_OFFERS.map((offer) => {
    const row = rows.find((candidate) => candidate?.id === offer.id);
    return [offer.id, row?.provider_price_ref];
  }));
}

export function dodoCatalogReadSql() {
  const ids = DODO_CATALOG_OFFERS.flatMap((offer) => [offer.id, offer.rotatedId]).map(sqlString).join(", ");
  return `
SELECT prices.id, plans.code AS plan_code, prices.market_code, prices.currency,
  prices.amount_minor, prices.interval, prices.tax_behavior, prices.provider_code,
  prices.provider_price_ref, prices.effective_from, prices.effective_to,
  prices.version, prices.is_active, prices.created_at, prices.updated_at
FROM plan_prices AS prices
INNER JOIN plans ON plans.id = prices.plan_id
WHERE prices.id IN (${ids})
ORDER BY prices.id;
`;
}

export function dodoCatalogCompletionReadSql() {
  return `
SELECT CASE json_extract(value_json, '$.value')
    WHEN 1 THEN 1
    WHEN 0 THEN 0
    ELSE NULL
  END AS reconciliation_required
FROM platform_settings
WHERE key = 'dodo_catalog_reconciliation_required';
`;
}

function expectedRow(offer, input = {}) {
  return {
    amount_minor: offer.amountMinor,
    currency: offer.currency,
    effective_to: input.effectiveTo ?? null,
    id: input.id ?? offer.id,
    interval: "month",
    is_active: input.isActive ?? 1,
    market_code: offer.marketCode,
    plan_code: offer.planCode,
    provider_code: "dodo",
    tax_behavior: "inclusive",
    version: input.version ?? 1,
  };
}

function isExactOfferRow(row, offer, input = {}) {
  const expected = expectedRow(offer, input);
  return Object.entries(expected).every(([key, value]) => row?.[key] === value);
}

function timestampMillis(value) {
  if (typeof value !== "string") return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseWranglerRows(output, issue) {
  let payload;
  try {
    payload = JSON.parse(String(output ?? ""));
  } catch {
    throw new Error(`${issue}_invalid_json`);
  }
  const envelopes = Array.isArray(payload) ? payload : [payload];
  if (envelopes.length === 0 || envelopes.some((envelope) => envelope?.success !== true || !Array.isArray(envelope.results))) {
    throw new Error(`${issue}_invalid_result`);
  }
  return envelopes.flatMap((envelope) => envelope.results);
}

export function classifyDodoCatalogRows(rows, references = null) {
  if (!Array.isArray(rows)) throw new Error("dodo_catalog_baseline_row_count");
  if (rows.length !== DODO_CATALOG_OFFERS.length && rows.length !== DODO_CATALOG_OFFERS.length * 2) {
    throw new Error("dodo_catalog_baseline_row_count");
  }
  const expectedIds = new Set(DODO_CATALOG_OFFERS.flatMap((offer) => [offer.id, offer.rotatedId]));
  const rowById = new Map();
  for (const row of rows) {
    if (typeof row?.id !== "string" || !expectedIds.has(row.id) || rowById.has(row.id)) {
      throw new Error("dodo_catalog_baseline_mismatch");
    }
    rowById.set(row.id, row);
  }
  const sourceReferences = {};
  let pendingCount = 0;
  let publishedCount = 0;
  let rotatedCount = 0;
  const publishedAt = new Set();
  const publishedReferences = new Set();
  const rotatedReferences = new Set();
  for (const offer of DODO_CATALOG_OFFERS) {
    const row = rowById.get(offer.id);
    if (row === undefined) throw new Error("dodo_catalog_baseline_row_count");
    const createdAtMillis = timestampMillis(row.created_at);
    const updatedAtMillis = timestampMillis(row.updated_at);
    if (createdAtMillis === null || updatedAtMillis === null || row.effective_from !== row.created_at
      || updatedAtMillis < createdAtMillis || row.plan_code !== offer.planCode
      || row.market_code !== offer.marketCode || row.currency !== offer.currency
      || row.amount_minor !== offer.amountMinor || row.interval !== "month"
      || row.tax_behavior !== "inclusive" || row.provider_code !== "dodo"
      || row.version !== 1) throw new Error("dodo_catalog_baseline_mismatch");
    const reference = row.provider_price_ref;
    sourceReferences[offer.id] = reference;
    if (row.is_active === 1 && row.effective_to === null) {
      if (reference === offer.pendingRef) pendingCount += 1;
      else if (references !== null && reference === references[offer.id]) {
        publishedAt.add(row.updated_at);
        publishedCount += 1;
        publishedReferences.add(reference);
      } else if (typeof reference === "string" && PROVIDER_REF_PATTERN.test(reference) && !reference.startsWith("pending:")) {
        publishedAt.add(row.updated_at);
        publishedCount += 1;
        publishedReferences.add(reference);
      } else throw new Error("dodo_catalog_published_reference_conflict");
      continue;
    }
    if (row.is_active !== 0 || row.effective_to === null || row.effective_to !== row.updated_at) {
      throw new Error("dodo_catalog_baseline_mismatch");
    }
    if (typeof reference !== "string" || !PROVIDER_REF_PATTERN.test(reference)
      || reference.startsWith("pending:") || (references !== null && reference === references[offer.id])) {
      throw new Error("dodo_catalog_baseline_mismatch");
    }
    const rotated = rowById.get(offer.rotatedId);
    if (rotated === undefined || !isExactOfferRow(rotated, offer, {
      effectiveTo: null,
      id: offer.rotatedId,
      isActive: 1,
      version: 2,
    }) || (references !== null && rotated.provider_price_ref !== references[offer.id])
      || typeof rotated.provider_price_ref !== "string"
      || !PROVIDER_REF_PATTERN.test(rotated.provider_price_ref)
      || rotated.provider_price_ref.startsWith("pending:")
      || rotated.effective_from !== row.effective_to || rotated.created_at !== row.effective_to
      || rotated.updated_at !== row.effective_to || timestampMillis(row.effective_to) === null
      || timestampMillis(row.effective_to) <= createdAtMillis) throw new Error("dodo_catalog_baseline_mismatch");
    rotatedReferences.add(rotated.provider_price_ref);
    rotatedCount += 1;
    publishedCount += 1;
    publishedAt.add(row.updated_at);
    publishedReferences.add(reference);
  }
  if (publishedReferences.size !== publishedCount && publishedCount !== 0) {
    throw new Error("dodo_catalog_baseline_mismatch");
  }
  if (rotatedCount !== 0 && (rotatedReferences.size !== rotatedCount
    || new Set([...publishedReferences, ...rotatedReferences]).size !== publishedReferences.size + rotatedReferences.size)) {
    throw new Error("dodo_catalog_baseline_mismatch");
  }
  if (pendingCount !== 0 && publishedCount !== 0) throw new Error("dodo_catalog_partial_configuration");
  if (publishedCount !== 0 && publishedAt.size !== 1) throw new Error("dodo_catalog_baseline_mismatch");
  if (pendingCount !== 0 && rows.length !== DODO_CATALOG_OFFERS.length) throw new Error("dodo_catalog_baseline_mismatch");
  if (rotatedCount !== 0 && rotatedCount !== DODO_CATALOG_OFFERS.length) throw new Error("dodo_catalog_baseline_mismatch");
  if (rotatedCount === 0 && rows.length !== DODO_CATALOG_OFFERS.length) throw new Error("dodo_catalog_baseline_mismatch");
  if (rotatedCount === DODO_CATALOG_OFFERS.length) {
    return { mode: references === null ? "rotated_unverified" : "rotated", pendingCount: 0, publishedCount };
  }
  if (pendingCount === DODO_CATALOG_OFFERS.length) {
    return { mode: "pending", pendingCount, publishedCount };
  }
  if (publishedCount !== DODO_CATALOG_OFFERS.length) throw new Error("dodo_catalog_partial_configuration");
  if (references === null) return { mode: "published_unverified", pendingCount, publishedCount };
  const allTargets = DODO_CATALOG_OFFERS.every((offer) => sourceReferences[offer.id] === references[offer.id]);
  const allPending = DODO_CATALOG_OFFERS.every((offer) => sourceReferences[offer.id] === offer.pendingRef);
  const allPrevious = DODO_CATALOG_OFFERS.every((offer) => sourceReferences[offer.id] !== references[offer.id]);
  if (!allTargets && !allPending && allPrevious) {
    return { mode: "rotation_required", pendingCount, publishedCount };
  }
  if (allTargets) return { mode: "already_configured", pendingCount, publishedCount };
  if (allPending) return { mode: "pending", pendingCount, publishedCount };
  throw new Error("dodo_catalog_partial_configuration");
}

function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function validateDodoCatalogProduct(product, offer, reference) {
  const payload = object(product);
  const price = object(payload.price);
  if (payload.product_id !== reference
    || payload.is_recurring !== true
    || payload.tax_category !== "saas"
    || payload.pricing_mode !== null
    || price.type !== "recurring_price"
    || price.price !== offer.amountMinor
    || price.currency !== offer.currency
    || price.payment_frequency_count !== 1
    || price.payment_frequency_interval !== "Month"
    || price.subscription_period_count !== 1
    || price.subscription_period_interval !== "Month"
    || price.tax_inclusive !== true
    || price.trial_period_days !== 0
    || price.discount !== 0) {
    throw new Error("dodo_catalog_product_contract_mismatch");
  }
}

async function fetchDodoCatalogProduct(input, offer, reference) {
  let response;
  try {
    response = await input.fetcher(`${input.apiBaseUrl}/products/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${input.apiKey}` },
      method: "GET",
      signal: globalThis.AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("dodo_catalog_provider_unavailable");
  }
  if (!response.ok) throw new Error(`dodo_catalog_provider_http_${response.status}`);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("dodo_catalog_provider_response_invalid");
  }
  validateDodoCatalogProduct(payload, offer, reference);
}

export async function validateDodoCatalogProducts(input) {
  if (typeof input.apiKey !== "string" || input.apiKey.length < 16 || input.apiKey.length > 4096) {
    throw new Error("dodo_catalog_provider_api_key_required");
  }
  const apiBaseUrl = input.apiBaseUrl ?? dodoCatalogApiBaseUrl(input.providerMode);
  validateDodoCatalogApiBaseUrl(apiBaseUrl, input.providerMode);
  const fetcher = input.fetcher ?? globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("dodo_catalog_provider_unavailable");
  await Promise.all(DODO_CATALOG_OFFERS.map((offer) => {
    const reference = safeReference(input.references?.[offer.id], `${offer.id}_target`);
    return fetchDodoCatalogProduct({ ...input, apiBaseUrl, fetcher }, offer, reference);
  }));
}

function exactPendingPredicate(alias = "p", planCode = `${alias}.plan_code`) {
  return DODO_CATALOG_OFFERS.map((offer) => {
    const expected = expectedRow(offer);
    return `(${alias}.id = ${sqlString(offer.id)} AND ${planCode} = ${sqlString(offer.planCode)} AND ${alias}.market_code = ${sqlString(offer.marketCode)} AND ${alias}.currency = ${sqlString(offer.currency)} AND ${alias}.amount_minor = ${expected.amount_minor} AND ${alias}.interval = 'month' AND ${alias}.tax_behavior = 'inclusive' AND ${alias}.provider_code = 'dodo' AND ${alias}.provider_price_ref = ${sqlString(offer.pendingRef)} AND ${alias}.effective_from = ${alias}.created_at AND julianday(${alias}.updated_at) >= julianday(${alias}.created_at) AND datetime(${alias}.effective_from) IS NOT NULL AND julianday(${alias}.effective_from) <= julianday('now') AND ${alias}.effective_to IS NULL AND ${alias}.version = 1 AND ${alias}.is_active = 1)`;
  }).join(" OR ");
}

function exactPublishedPredicate(offer, reference, input = {}) {
  const alias = input.alias ?? "p";
  const planCode = input.planCode ?? "plans.code";
  const id = input.id ?? offer.id;
  const version = input.version ?? 1;
  const lifecycle = input.closed === true
    ? `${alias}.is_active = 0 AND ${alias}.effective_to IS NOT NULL AND ${alias}.effective_to = ${alias}.updated_at`
    : `${alias}.is_active = 1 AND ${alias}.effective_to IS NULL`;
  const timestampContract = input.rotated === true
    ? `${alias}.effective_from = ${alias}.created_at AND ${alias}.created_at = ${alias}.updated_at
      AND ${alias}.effective_from = (SELECT source.effective_to FROM plan_prices AS source WHERE source.id = ${sqlString(offer.id)})`
    : `${alias}.effective_from = ${alias}.created_at
      AND julianday(${alias}.updated_at) >= julianday(${alias}.created_at)`;
  return `(${alias}.id = ${sqlString(id)} AND ${planCode} = ${sqlString(offer.planCode)}
    AND ${alias}.market_code = ${sqlString(offer.marketCode)} AND ${alias}.currency = ${sqlString(offer.currency)}
    AND ${alias}.amount_minor = ${offer.amountMinor} AND ${alias}.interval = 'month'
    AND ${alias}.tax_behavior = 'inclusive' AND ${alias}.provider_code = 'dodo'
    AND ${alias}.provider_price_ref = ${sqlString(reference)}
    AND datetime(${alias}.effective_from) IS NOT NULL AND ${timestampContract}
    AND ${alias}.version = ${version} AND ${lifecycle})`;
}

export function dodoCatalogCompletionSql(references, mode, sourceReferences = null) {
  const targetValues = DODO_CATALOG_OFFERS.map((offer) => safeReference(references?.[offer.id], `${offer.id}_target`));
  if (new Set(targetValues).size !== DODO_CATALOG_OFFERS.length) throw new Error("dodo_catalog_references_not_unique");
  const targetPredicate = DODO_CATALOG_OFFERS.map((offer, index) => exactPublishedPredicate(
    offer,
    targetValues[index],
    mode === "rotated" ? { id: offer.rotatedId, rotated: true, version: 2 } : undefined,
  )).join(" OR ");
  const targetCount = `(SELECT COUNT(*) FROM plan_prices AS p INNER JOIN plans ON plans.id = p.plan_id WHERE ${targetPredicate})`;
  let completionPredicate;
  if (mode === "already_configured") {
    const v2Ids = DODO_CATALOG_OFFERS.map((offer) => sqlString(offer.rotatedId)).join(", ");
    completionPredicate = `${targetCount} = ${DODO_CATALOG_OFFERS.length}
      AND (SELECT COUNT(*) FROM plan_prices WHERE id IN (${v2Ids})) = 0`;
  } else if (mode === "rotated") {
    const sourceValues = DODO_CATALOG_OFFERS.map((offer) => safeReference(sourceReferences?.[offer.id], `${offer.id}_source`));
    if (new Set(sourceValues).size !== DODO_CATALOG_OFFERS.length
      || new Set([...sourceValues, ...targetValues]).size !== DODO_CATALOG_OFFERS.length * 2) {
      throw new Error("dodo_catalog_rotation_reference_overlap");
    }
    const sourcePredicate = DODO_CATALOG_OFFERS.map((offer, index) => exactPublishedPredicate(
      offer,
      sourceValues[index],
      { closed: true },
    )).join(" OR ");
    const sourceCount = `(SELECT COUNT(*) FROM plan_prices AS p INNER JOIN plans ON plans.id = p.plan_id WHERE ${sourcePredicate})`;
    completionPredicate = `${sourceCount} = ${DODO_CATALOG_OFFERS.length}
      AND ${targetCount} = ${DODO_CATALOG_OFFERS.length}`;
  } else {
    throw new Error("dodo_catalog_completion_mode_invalid");
  }
  return `
UPDATE platform_settings
SET value_json = '{"value":false}', version = version + 1, updated_at = CURRENT_TIMESTAMP
WHERE key = 'dodo_catalog_reconciliation_required'
  AND json_extract(value_json, '$.value') = 1
  AND ${completionPredicate};
SELECT changes() AS reconciliation_marker_updated;
`;
}

export function dodoCatalogUpdateSql(references) {
  for (const offer of DODO_CATALOG_OFFERS) safeReference(references?.[offer.id], `${offer.id}_target`);
  if (new Set(DODO_CATALOG_OFFERS.map((offer) => references[offer.id])).size !== DODO_CATALOG_OFFERS.length) {
    throw new Error("dodo_catalog_references_not_unique");
  }
  const cases = DODO_CATALOG_OFFERS.map((offer) => `WHEN ${sqlString(offer.id)} THEN ${sqlString(references[offer.id])}`).join(" ");
  const ids = DODO_CATALOG_OFFERS.map((offer) => sqlString(offer.id)).join(", ");
  return `
WITH exact_pending AS (
  SELECT p.id
  FROM plan_prices AS p
  INNER JOIN plans ON plans.id = p.plan_id
  WHERE p.id IN (${ids})
    AND (${exactPendingPredicate("p", "plans.code")})
), ready AS (
  SELECT COUNT(*) AS matched_count
  FROM exact_pending
)
UPDATE plan_prices
SET provider_price_ref = CASE id ${cases} ELSE provider_price_ref END,
  updated_at = CURRENT_TIMESTAMP
WHERE id IN (SELECT id FROM exact_pending)
  AND (SELECT matched_count FROM ready) = ${DODO_CATALOG_OFFERS.length};
SELECT changes() AS updated_count;
${dodoCatalogCompletionSql(references, "already_configured")}
`;
}

export function dodoCatalogRotationSql(sourceReferences, targetReferences) {
  const sourceValues = DODO_CATALOG_OFFERS.map((offer) => sourceReferences?.[offer.id]);
  const targetValues = DODO_CATALOG_OFFERS.map((offer) => targetReferences?.[offer.id]);
  for (const [index, offer] of DODO_CATALOG_OFFERS.entries()) {
    safeReference(sourceValues[index], `${offer.id}_source`);
    safeReference(targetValues[index], `${offer.id}_target`);
  }
  if (new Set(sourceValues).size !== DODO_CATALOG_OFFERS.length
    || new Set(targetValues).size !== DODO_CATALOG_OFFERS.length) {
    throw new Error("dodo_catalog_references_not_unique");
  }
  if (new Set([...sourceValues, ...targetValues]).size !== DODO_CATALOG_OFFERS.length * 2) {
    throw new Error("dodo_catalog_rotation_reference_overlap");
  }

  const v1Ids = DODO_CATALOG_OFFERS.map((offer) => sqlString(offer.id)).join(", ");
  const v2Ids = DODO_CATALOG_OFFERS.map((offer) => sqlString(offer.rotatedId)).join(", ");
  const openParts = DODO_CATALOG_OFFERS.map((offer, index) => `(
    p.id = ${sqlString(offer.id)} AND plans.code = ${sqlString(offer.planCode)}
    AND p.market_code = ${sqlString(offer.marketCode)} AND p.currency = ${sqlString(offer.currency)}
    AND p.amount_minor = ${offer.amountMinor} AND p.interval = 'month'
    AND p.tax_behavior = 'inclusive' AND p.provider_code = 'dodo'
    AND p.provider_price_ref = ${sqlString(sourceValues[index])}
    AND p.effective_from = p.created_at AND julianday(p.updated_at) >= julianday(p.created_at)
    AND datetime(p.effective_from) IS NOT NULL AND julianday(p.effective_from) <= julianday('now')
    AND p.effective_to IS NULL AND p.version = 1 AND p.is_active = 1
  )`).join(" OR ");
  const closedParts = DODO_CATALOG_OFFERS.map((offer, index) => `(
    p.id = ${sqlString(offer.id)} AND plans.code = ${sqlString(offer.planCode)}
    AND p.market_code = ${sqlString(offer.marketCode)} AND p.currency = ${sqlString(offer.currency)}
    AND p.amount_minor = ${offer.amountMinor} AND p.interval = 'month'
    AND p.tax_behavior = 'inclusive' AND p.provider_code = 'dodo'
    AND p.provider_price_ref = ${sqlString(sourceValues[index])}
    AND p.effective_from = p.created_at AND julianday(p.updated_at) >= julianday(p.created_at)
    AND datetime(p.effective_from) IS NOT NULL AND julianday(p.effective_from) <= julianday('now')
    AND p.effective_to IS NOT NULL AND p.effective_to = p.updated_at AND p.version = 1 AND p.is_active = 0
  )`).join(" OR ");
  const targetParts = DODO_CATALOG_OFFERS.map((offer, index) => `(
    p.id = ${sqlString(offer.rotatedId)} AND plans.code = ${sqlString(offer.planCode)}
    AND p.market_code = ${sqlString(offer.marketCode)} AND p.currency = ${sqlString(offer.currency)}
    AND p.amount_minor = ${offer.amountMinor} AND p.interval = 'month'
    AND p.tax_behavior = 'inclusive' AND p.provider_code = 'dodo'
    AND p.provider_price_ref = ${sqlString(targetValues[index])}
    AND p.effective_to IS NULL AND p.version = 2 AND p.is_active = 1
    AND p.effective_from = p.created_at AND p.created_at = p.updated_at
    AND p.effective_from = (SELECT source.effective_to FROM plan_prices AS source WHERE source.id = ${sqlString(offer.id)})
  )`).join(" OR ");
  const openCount = `(SELECT COUNT(*) FROM plan_prices AS p INNER JOIN plans ON plans.id = p.plan_id WHERE ${openParts})`;
  const closedCount = `(SELECT COUNT(*) FROM plan_prices AS p INNER JOIN plans ON plans.id = p.plan_id WHERE ${closedParts})`;
  const targetCount = `(SELECT COUNT(*) FROM plan_prices AS p INNER JOIN plans ON plans.id = p.plan_id WHERE ${targetParts})`;
  const v2Count = `(SELECT COUNT(*) FROM plan_prices WHERE id IN (${v2Ids}))`;
  const validState = `(${openCount} = ${DODO_CATALOG_OFFERS.length} AND ${v2Count} = 0)
    OR (${closedCount} = ${DODO_CATALOG_OFFERS.length} AND ${targetCount} = ${DODO_CATALOG_OFFERS.length} AND ${v2Count} = ${DODO_CATALOG_OFFERS.length})`;
  const openPredicate = DODO_CATALOG_OFFERS.map((offer, index) => `(
    plan_prices.id = ${sqlString(offer.id)} AND plan_prices.provider_price_ref = ${sqlString(sourceValues[index])}
    AND plan_prices.is_active = 1 AND plan_prices.effective_to IS NULL AND plan_prices.version = 1
  )`).join(" OR ");
  const insertStatements = DODO_CATALOG_OFFERS.map((offer, index) => `
SELECT ${sqlString(offer.rotatedId)}, p.plan_id, p.market_code, p.currency, p.amount_minor, p.interval,
  p.tax_behavior, p.provider_code, ${sqlString(targetValues[index])}, p.effective_to, NULL, 2, 1,
  p.effective_to, p.effective_to
FROM plan_prices AS p
WHERE p.id = ${sqlString(offer.id)} AND p.provider_price_ref = ${sqlString(sourceValues[index])}
  AND p.is_active = 0 AND p.effective_to IS NOT NULL AND p.effective_to = p.updated_at
  AND NOT EXISTS (SELECT 1 FROM plan_prices AS existing WHERE existing.id = ${sqlString(offer.rotatedId)})`).join("\nUNION ALL");
  return `
WITH state AS (SELECT CASE WHEN ${openCount} = ${DODO_CATALOG_OFFERS.length} AND ${v2Count} = 0 THEN 'rotated' ELSE 'already_rotated' END AS rotation_mode)
INSERT INTO plan_prices (id)
SELECT NULL FROM state WHERE NOT (${validState});
SELECT CASE WHEN ${openCount} = ${DODO_CATALOG_OFFERS.length} THEN 'rotated' ELSE 'already_rotated' END AS rotation_mode;
UPDATE plan_prices
SET effective_to = datetime('now', '+1 second'), is_active = 0, updated_at = datetime('now', '+1 second')
WHERE id IN (${v1Ids}) AND (${openPredicate});
SELECT changes() AS closed_count;
INSERT INTO plan_prices (id, plan_id, market_code, currency, amount_minor, interval, tax_behavior, provider_code, provider_price_ref, effective_from, effective_to, version, is_active, created_at, updated_at)
${insertStatements};
SELECT changes() AS inserted_count;
WITH state AS (SELECT 1 AS valid_state)
INSERT INTO plan_prices (id)
SELECT NULL FROM state WHERE NOT (${closedCount} = ${DODO_CATALOG_OFFERS.length} AND ${targetCount} = ${DODO_CATALOG_OFFERS.length} AND ${v2Count} = ${DODO_CATALOG_OFFERS.length});
${dodoCatalogCompletionSql(targetReferences, "rotated", sourceReferences)}
`;
}

export function parseDodoCatalogRotationCommandOutput(output) {
  const rows = parseWranglerRows(output, "dodo_catalog_rotation");
  const modeRow = rows.find((row) => Object.hasOwn(row, "rotation_mode"));
  const closedRow = rows.find((row) => Object.hasOwn(row, "closed_count"));
  const insertedRow = rows.find((row) => Object.hasOwn(row, "inserted_count"));
  const mode = modeRow?.rotation_mode;
  if (mode !== "rotated" && mode !== "already_rotated" && mode !== "replayed") {
    throw new Error("dodo_catalog_rotation_mode_invalid");
  }
  const closedCount = modeRow?.closed_count ?? closedRow?.closed_count;
  const insertedCount = modeRow?.inserted_count ?? insertedRow?.inserted_count;
  if (!Number.isInteger(closedCount) || !Number.isInteger(insertedCount)
    || closedCount < 0 || insertedCount < 0
    || (mode === "rotated" && (closedCount !== DODO_CATALOG_OFFERS.length || insertedCount !== DODO_CATALOG_OFFERS.length))
    || ((mode === "already_rotated" || mode === "replayed") && (closedCount !== 0 || insertedCount !== 0))) {
    throw new Error("dodo_catalog_rotation_count_mismatch");
  }
  return {
    mode: mode === "replayed" ? "already_rotated" : mode,
    closedCount,
    insertedCount,
  };
}

export function parseDodoCatalogCommandOutput(output) {
  const rows = parseWranglerRows(output, "dodo_catalog_update");
  const update = rows.find((row) => Object.hasOwn(row, "updated_count"));
  if (update?.updated_count !== DODO_CATALOG_OFFERS.length) throw new Error("dodo_catalog_update_count_mismatch");
  return { updatedCount: update.updated_count };
}

async function writePrivateSqlFile(sql) {
  const directory = await mkdtemp(join(tmpdir(), "selinow-dodo-catalog-"));
  const file = join(directory, "update.sql");
  await writeFile(file, sql, { encoding: "utf8", mode: 0o600 });
  await chmod(file, 0o600);
  return { directory, file };
}

function runRemote(environment, args, issue) {
  try {
    return runWrangler(["d1", "execute", "PLATFORM_DB", "--env", environment, "--remote", ...args], { capture: true }).stdout;
  } catch {
    throw new Error(issue);
  }
}

function readRemoteDodoCatalog(input) {
  validateDodoCatalogProviderEnvironment(input);
  const runRemoteImplementation = input.runRemoteImplementation ?? runRemote;
  const rows = parseWranglerRows(
    runRemoteImplementation(input.environment, ["--command", dodoCatalogReadSql(), "--json"], "dodo_catalog_read_failed"),
    "dodo_catalog_read",
  );
  const completionRows = parseWranglerRows(
    runRemoteImplementation(input.environment, ["--command", dodoCatalogCompletionReadSql(), "--json"], "dodo_catalog_completion_read_failed"),
    "dodo_catalog_completion_read",
  );
  if (completionRows.length !== 1 || (completionRows[0]?.reconciliation_required !== 0 && completionRows[0]?.reconciliation_required !== 1)) {
    throw new Error("dodo_catalog_completion_state_invalid");
  }
  return {
    ...classifyDodoCatalogRows(rows, input.references),
    reconciliationRequired: completionRows[0].reconciliation_required === 1,
    rows,
  };
}

export function inspectDodoCatalog(input) {
  const result = readRemoteDodoCatalog(input);
  return {
    environment: input.environment,
    mode: result.mode,
    pendingCount: result.pendingCount,
    publishedCount: result.publishedCount,
    reconciliationRequired: result.reconciliationRequired,
  };
}

export async function reconcileDodoCatalog(input) {
  validateDodoCatalogTarget(input);
  const references = input.references;
  const runRemoteImplementation = input.runRemoteImplementation ?? runRemote;
  const { rows, ...before } = readRemoteDodoCatalog({ ...input, runRemoteImplementation });
  await validateDodoCatalogProducts({
    apiBaseUrl: input.apiBaseUrl,
    apiKey: input.apiKey,
    fetcher: input.fetcher,
    providerMode: input.providerMode,
    references,
  });
  if (before.mode === "already_configured" || before.mode === "rotated") {
    if (before.reconciliationRequired) {
      const privateSql = await writePrivateSqlFile(dodoCatalogCompletionSql(
        references,
        before.mode,
        before.mode === "rotated" ? readPublishedSourceReferences(rows) : null,
      ));
      try {
        runRemoteImplementation(input.environment, ["--file", privateSql.file, "--yes", "--json"], "dodo_catalog_completion_update_failed");
      } finally {
        await rm(privateSql.directory, { force: true, recursive: true });
      }
    }
    const verified = inspectDodoCatalog({ ...input, runRemoteImplementation });
    if (verified.mode !== before.mode || verified.reconciliationRequired) throw new Error("dodo_catalog_completion_pending");
    return { ...verified, updatedCount: 0, closedCount: 0, insertedCount: 0 };
  }

  const rotation = before.mode === "rotation_required";
  const privateSql = await writePrivateSqlFile(rotation
    ? dodoCatalogRotationSql(readPublishedSourceReferences(rows), references)
    : dodoCatalogUpdateSql(references));
  try {
    runRemoteImplementation(input.environment, ["--file", privateSql.file, "--yes", "--json"], "dodo_catalog_update_failed");
    const after = inspectDodoCatalog({ ...input, runRemoteImplementation });
    if (rotation && after.mode !== "rotated") throw new Error("dodo_catalog_rotation_pending");
    if (!rotation && after.mode !== "already_configured") throw new Error("dodo_catalog_pending_reference_remains");
    if (after.reconciliationRequired) throw new Error("dodo_catalog_completion_pending");
    return {
      ...after,
      environment: input.environment,
      updatedCount: rotation ? 0 : DODO_CATALOG_OFFERS.length,
      closedCount: rotation ? DODO_CATALOG_OFFERS.length : 0,
      insertedCount: rotation ? DODO_CATALOG_OFFERS.length : 0,
    };
  } finally {
    await rm(privateSql.directory, { force: true, recursive: true });
  }
}
