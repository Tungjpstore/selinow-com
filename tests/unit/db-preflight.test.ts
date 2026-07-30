import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  evaluatePaymentProviderPreflight,
  evaluatePayosRelationshipPreflight,
  evaluatePhase7Preflight,
  parseD1PreflightOutput,
  parsePaymentProviderPreflightOutput,
  parsePaymentProviderSchemaOutput,
  parsePayosRelationshipPreflightOutput,
  PAYMENT_PROVIDER_PREFLIGHT_SQL,
  PAYMENT_PROVIDER_SCHEMA_TABLES,
  PAYOS_RELATIONSHIP_PREFLIGHT_SQL,
} from "../../scripts/lib/db-preflight.mjs";

describe("phase 7 D1 preflight", () => {
  it("parses Wrangler JSON and allows repairable legacy state", () => {
    const counts = parseD1PreflightOutput(JSON.stringify([{
      results: [{
        canonical_null_shops: 4,
        duplicate_primary_shops: 1,
        duplicate_provider_ids: 0,
        invalid_canonical_links: 2,
        legacy_custom_domains: 3,
        unresolved_active_attempt_origins: 0,
      }],
    }]));
    expect(evaluatePhase7Preflight(counts).ok).toBe(true);
  });

  it("fails closed for provider identity collisions or unresolved live payment origins", () => {
    const result = evaluatePhase7Preflight({
      canonicalNullShops: 0,
      duplicatePrimaryShops: 0,
      duplicateProviderIds: 1,
      invalidCanonicalLinks: 0,
      legacyCustomDomains: 0,
      unresolvedActiveAttemptOrigins: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.checks.filter((check) => !check.ok).map((check) => check.code)).toEqual([
      "duplicate_provider_ids",
      "unresolved_active_attempt_origins",
    ]);
  });
});

describe("legacy PayOS relationship D1 preflight", () => {
  it("parses aggregate counts and fails closed for every guarded relationship", () => {
    const counts = parsePayosRelationshipPreflightOutput(JSON.stringify([{
      results: [{
        invalid_payos_active_credential_links: 1,
        invalid_payos_attempt_links: 2,
        invalid_payos_credential_integration_links: 3,
        invalid_payos_event_links: 4,
        invalid_payos_exception_links: 5,
        invalid_payos_paid_event_links: 6,
      }],
    }]));
    const result = evaluatePayosRelationshipPreflight(counts);
    expect(result.ok).toBe(false);
    expect(result.checks.filter((check) => !check.ok).map((check) => check.code)).toEqual([
      "invalid_payos_active_credential_links",
      "invalid_payos_credential_integration_links",
      "invalid_payos_attempt_links",
      "invalid_payos_event_links",
      "invalid_payos_exception_links",
      "invalid_payos_paid_event_links",
    ]);
  });

  it("executes the read-only aggregate query without exposing row data", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      for (const filename of readdirSync(join(process.cwd(), "migrations"))
        .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
        .sort()) {
        database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
      }
      expect(database.prepare(PAYOS_RELATIONSHIP_PREFLIGHT_SQL).get()).toEqual({
        invalid_payos_active_credential_links: 0,
        invalid_payos_attempt_links: 0,
        invalid_payos_credential_integration_links: 0,
        invalid_payos_event_links: 0,
        invalid_payos_exception_links: 0,
        invalid_payos_paid_event_links: 0,
      });
    } finally {
      database.close();
    }
  });
});

describe("payment provider D1 preflight", () => {
  it("skips post-0035 SQL only when none of its tables exist", () => {
    expect(parsePaymentProviderSchemaOutput(JSON.stringify([{ results: [] }]))).toEqual({
      applied: false,
      tables: [],
    });
    expect(parsePaymentProviderSchemaOutput(JSON.stringify([{
      results: PAYMENT_PROVIDER_SCHEMA_TABLES.map((name) => ({ name })),
    }]))).toEqual({
      applied: true,
      tables: PAYMENT_PROVIDER_SCHEMA_TABLES,
    });
  });

  it("fails closed for a partially applied provider schema", () => {
    expect(() => parsePaymentProviderSchemaOutput(JSON.stringify([{
      results: [{ name: "payment_provider_connections" }],
    }]))).toThrow("db_preflight_payment_provider_schema_partial");
    expect(() => parsePaymentProviderSchemaOutput(JSON.stringify([{}])))
      .toThrow("db_preflight_schema_invalid_result");
  });

  it("parses safe aggregate counts and rejects broken PayOS projections", () => {
    const counts = parsePaymentProviderPreflightOutput(JSON.stringify([{
      results: [{
        invalid_payos_capability_grants: 1,
        invalid_payos_connection_links: 0,
        invalid_payos_currency_grants: 0,
        invalid_payos_method_grants: 0,
        invalid_payos_reference_codes: 0,
        missing_payos_connections: 0,
        stale_effective_authorizations: 2,
      }],
    }]));
    const result = evaluatePaymentProviderPreflight(counts);
    expect(result.ok).toBe(false);
    expect(result.checks.filter((check) => !check.ok).map((check) => check.code)).toEqual([
      "invalid_payos_capability_grants",
      "stale_effective_authorizations",
    ]);
  });

  it("executes the post-0035 aggregate query without exposing row data", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec("PRAGMA foreign_keys = ON");
      for (const filename of readdirSync(join(process.cwd(), "migrations"))
        .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
        .sort()) {
        database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
      }
      expect(database.prepare(PAYMENT_PROVIDER_PREFLIGHT_SQL).get()).toEqual({
        invalid_payos_capability_grants: 0,
        invalid_payos_connection_links: 0,
        invalid_payos_currency_grants: 0,
        invalid_payos_method_grants: 0,
        invalid_payos_reference_codes: 0,
        missing_payos_connections: 0,
        stale_effective_authorizations: 0,
      });
    } finally {
      database.close();
    }
  });
});
