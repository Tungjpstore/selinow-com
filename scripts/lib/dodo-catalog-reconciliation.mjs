import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { runWrangler } from "./cli.mjs";

const PROVIDER_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/u;
const ENVIRONMENTS = new Set(["staging", "production"]);

export const DODO_CATALOG_OFFERS = Object.freeze([
  Object.freeze({
    amountMinor: 99_000,
    currency: "VND",
    id: "price_starter_vn_v1",
    marketCode: "vn",
    pendingRef: "pending:dodo:starter:vn:month:v1",
    planCode: "starter",
    referenceEnv: "DODO_STARTER_VN_PRODUCT_ID",
  }),
  Object.freeze({
    amountMinor: 299_000,
    currency: "VND",
    id: "price_pro_vn_v1",
    marketCode: "vn",
    pendingRef: "pending:dodo:pro:vn:month:v1",
    planCode: "pro",
    referenceEnv: "DODO_PRO_VN_PRODUCT_ID",
  }),
  Object.freeze({
    amountMinor: 500,
    currency: "USD",
    id: "price_starter_global_v1",
    marketCode: "global",
    pendingRef: "pending:dodo:starter:global:month:v1",
    planCode: "starter",
    referenceEnv: "DODO_STARTER_GLOBAL_PRODUCT_ID",
  }),
  Object.freeze({
    amountMinor: 1500,
    currency: "USD",
    id: "price_pro_global_v1",
    marketCode: "global",
    pendingRef: "pending:dodo:pro:global:month:v1",
    planCode: "pro",
    referenceEnv: "DODO_PRO_GLOBAL_PRODUCT_ID",
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
    explicitDryRun: false,
    environment: null,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--dry-run") options.explicitDryRun = true;
    else if (argument === "--confirm-catalog-update") options.confirmCatalogUpdate = true;
    else if (argument === "--confirm-production") options.confirmProduction = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--env") {
      options.environment = argv[index + 1] ?? null;
      index += 1;
    } else if (argument.startsWith("--env=")) options.environment = argument.slice("--env=".length);
    else throw new Error("unknown_argument");
  }
  if (options.apply && options.explicitDryRun) throw new Error("dodo_catalog_mode_conflict");
  if (!ENVIRONMENTS.has(options.environment)) throw new Error("dodo_catalog_environment_required");
  if (options.environment === "production" && options.apply && !options.confirmProduction) {
    throw new Error("production_confirmation_required");
  }
  if (options.apply && !options.confirmCatalogUpdate) throw new Error("dodo_catalog_confirmation_required");
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

export function dodoCatalogReadSql() {
  const ids = DODO_CATALOG_OFFERS.map((offer) => sqlString(offer.id)).join(", ");
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

function expectedRow(offer) {
  return {
    amount_minor: offer.amountMinor,
    currency: offer.currency,
    effective_to: null,
    id: offer.id,
    interval: "month",
    is_active: 1,
    market_code: offer.marketCode,
    plan_code: offer.planCode,
    provider_code: "dodo",
    tax_behavior: "inclusive",
    version: 1,
  };
}

function isExactOfferRow(row, offer) {
  const expected = expectedRow(offer);
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

export function classifyDodoCatalogRows(rows, references) {
  if (!Array.isArray(rows) || rows.length !== DODO_CATALOG_OFFERS.length) throw new Error("dodo_catalog_baseline_row_count");
  const seen = new Set();
  let pendingCount = 0;
  let publishedCount = 0;
  const publishedAt = new Set();
  for (const offer of DODO_CATALOG_OFFERS) {
    const matches = rows.filter((candidate) => candidate?.id === offer.id);
    const row = matches[0];
    if (matches.length !== 1 || row === undefined || seen.has(offer.id) || !isExactOfferRow(row, offer)) throw new Error("dodo_catalog_baseline_mismatch");
    seen.add(offer.id);
    const reference = row.provider_price_ref;
    const createdAtMillis = timestampMillis(row.created_at);
    const updatedAtMillis = timestampMillis(row.updated_at);
    if (createdAtMillis === null || updatedAtMillis === null
      || row.effective_from !== row.created_at
      || updatedAtMillis < createdAtMillis) throw new Error("dodo_catalog_baseline_mismatch");
    if (reference === offer.pendingRef) {
      // Migration 0076 can update individual rows in different SQLite
      // seconds. Each untouched pending row is validated independently.
      pendingCount += 1;
    } else if (reference === references[offer.id]) {
      publishedAt.add(row.updated_at);
      publishedCount += 1;
    }
    else throw new Error("dodo_catalog_published_reference_conflict");
  }
  if (pendingCount !== 0 && publishedCount !== 0) throw new Error("dodo_catalog_partial_configuration");
  if (publishedCount !== 0 && publishedAt.size !== 1) throw new Error("dodo_catalog_baseline_mismatch");
  return {
    mode: publishedCount === DODO_CATALOG_OFFERS.length ? "already_configured" : "pending",
    pendingCount,
    publishedCount,
  };
}

function exactPendingPredicate() {
  return DODO_CATALOG_OFFERS.map((offer) => {
    const expected = expectedRow(offer);
    return `(p.id = ${sqlString(offer.id)} AND p.plan_code = ${sqlString(offer.planCode)} AND p.market_code = ${sqlString(offer.marketCode)} AND p.currency = ${sqlString(offer.currency)} AND p.amount_minor = ${expected.amount_minor} AND p.interval = 'month' AND p.tax_behavior = 'inclusive' AND p.provider_code = 'dodo' AND p.provider_price_ref = ${sqlString(offer.pendingRef)} AND p.effective_from = p.created_at AND julianday(p.updated_at) >= julianday(p.created_at) AND datetime(p.effective_from) IS NOT NULL AND julianday(p.effective_from) <= julianday('now') AND p.effective_to IS NULL AND p.version = 1 AND p.is_active = 1)`;
  }).join(" OR ");
}

export function dodoCatalogUpdateSql(references) {
  const cases = DODO_CATALOG_OFFERS.map((offer) => `WHEN ${sqlString(offer.id)} THEN ${sqlString(references[offer.id])}`).join(" ");
  const ids = DODO_CATALOG_OFFERS.map((offer) => sqlString(offer.id)).join(", ");
  const rowPredicates = DODO_CATALOG_OFFERS.map((offer) => `(id = ${sqlString(offer.id)} AND provider_price_ref = ${sqlString(offer.pendingRef)})`).join(" OR ");
  return `
UPDATE plan_prices
SET provider_price_ref = CASE id ${cases} ELSE provider_price_ref END,
  updated_at = CURRENT_TIMESTAMP
WHERE (${rowPredicates})
  AND (
    SELECT COUNT(*)
    FROM (
      SELECT p.id, p.plan_id, p.market_code, p.currency, p.amount_minor,
        p.interval, p.tax_behavior, p.provider_code, p.provider_price_ref,
        p.effective_from, p.effective_to, p.version, p.is_active,
        p.created_at, p.updated_at, plans.code AS plan_code
      FROM plan_prices AS p
      INNER JOIN plans ON plans.id = p.plan_id
      WHERE p.id IN (${ids})
    ) AS p
    WHERE ${exactPendingPredicate()}
  ) = ${DODO_CATALOG_OFFERS.length};
SELECT changes() AS updated_count;
`;
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

export async function reconcileDodoCatalog(input) {
  const references = input.references;
  const rows = parseWranglerRows(runRemote(input.environment, ["--command", dodoCatalogReadSql(), "--json"], "dodo_catalog_read_failed"), "dodo_catalog_read");
  const before = classifyDodoCatalogRows(rows, references);
  if (before.mode === "already_configured") return { ...before, environment: input.environment, updatedCount: 0 };

  const privateSql = await writePrivateSqlFile(dodoCatalogUpdateSql(references));
  try {
    const output = runRemote(input.environment, ["--file", privateSql.file, "--yes", "--json"], "dodo_catalog_update_failed");
    const update = parseDodoCatalogCommandOutput(output);
    const afterRows = parseWranglerRows(runRemote(input.environment, ["--command", dodoCatalogReadSql(), "--json"], "dodo_catalog_verify_failed"), "dodo_catalog_verify");
    const after = classifyDodoCatalogRows(afterRows, references);
    if (after.mode !== "already_configured") throw new Error("dodo_catalog_pending_reference_remains");
    return { ...after, environment: input.environment, updatedCount: update.updatedCount };
  } finally {
    await rm(privateSql.directory, { force: true, recursive: true });
  }
}
