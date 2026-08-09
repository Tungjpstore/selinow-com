import { describe, expect, it } from "vitest";

import {
  CUSTOM_DOMAIN_TURNSTILE_ADMISSION_MAX_AGE_MS,
  customDomainTurnstileAdmissionSql,
  hasFreshExactTurnstileAdmission,
  turnstileAdmissionWindow,
} from "../../src/lib/domains/readiness";

const NOW = new Date("2026-08-09T12:00:00.000Z");

function metadata(checkedAt: string, overrides: Partial<{
  hostname: string;
  mode: string;
  source: string;
  status: string;
}> = {}): string {
  return JSON.stringify({
    turnstile: {
      checkedAt,
      hostname: "shop.customer.com",
      mode: "operator_managed",
      source: "cloudflare_widget_domains",
      status: "active",
      ...overrides,
    },
  });
}

describe("custom-domain Turnstile readiness", () => {
  it("accepts only exact active evidence inside the 12-hour window", () => {
    const boundary = new Date(NOW.getTime() - CUSTOM_DOMAIN_TURNSTILE_ADMISSION_MAX_AGE_MS).toISOString();
    expect(hasFreshExactTurnstileAdmission({
      hostname: "shop.customer.com",
      now: NOW,
      validationMetadataJson: metadata(boundary),
    })).toBe(true);
    expect(turnstileAdmissionWindow(NOW)).toEqual({ earliest: boundary, latest: NOW.toISOString() });
  });

  it.each([
    ["stale", new Date(NOW.getTime() - CUSTOM_DOMAIN_TURNSTILE_ADMISSION_MAX_AGE_MS - 1).toISOString(), {}],
    ["future", new Date(NOW.getTime() + 1).toISOString(), {}],
    ["wrong hostname", NOW.toISOString(), { hostname: "other.customer.com" }],
    ["pending", NOW.toISOString(), { status: "pending" }],
  ])("rejects %s admission evidence", (_label, checkedAt, overrides) => {
    expect(hasFreshExactTurnstileAdmission({
      hostname: "shop.customer.com",
      now: NOW,
      validationMetadataJson: metadata(checkedAt, overrides),
    })).toBe(false);
  });

  it("builds an exact and fresh fail-closed SQL predicate", () => {
    const sql = customDomainTurnstileAdmissionSql("shop_domains");
    expect(sql).toContain("shop_domains.validation_metadata_json");
    expect(sql).toContain("shop_domains.hostname_normalized");
    expect(sql).toContain("$.turnstile.checkedAt");
    expect(sql).toContain("julianday('now', '-12 hours')");
    expect(sql).toContain("<= julianday('now')");
    expect(() => customDomainTurnstileAdmissionSql("unsafe.alias")).toThrow(/invalid_sql_alias/u);
  });
});
