import { describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import {
  evaluateReadinessSnapshot,
  publishReadyStorefront,
  type ReadinessSnapshot,
} from "../../src/lib/tenants/readiness";

const CHECKED_AT = "2026-07-26T00:00:00.000Z";
const TEST_POLICY_VERSION = 7;

function readySnapshot(overrides: Partial<ReadinessSnapshot> = {}): ReadinessSnapshot {
  return {
    canonicalDomainReady: true,
    catalogReady: true,
    criticalIntegrationError: false,
    customDomainPreference: "later",
    customDomainReady: false,
    fulfillmentReady: true,
    payosLastCheckedAt: CHECKED_AT,
    payosLastWebhookVerifiedAt: CHECKED_AT,
    payosStatus: "active",
    payosWebhookStatus: "verified",
    platformDomainReady: true,
    policyAttestationVersion: TEST_POLICY_VERSION,
    policyAttestedAt: CHECKED_AT,
    privacyUrl: "https://seller.example/privacy",
    readinessVersion: 4,
    refundPolicyUrl: "https://seller.example/refunds",
    shopStatus: "draft",
    storefrontEntitled: true,
    subscriptionState: "active",
    currentPeriodEnd: "2026-08-04T00:00:00.000Z",
    supportContact: "support@example.com",
    telegramEnabled: false,
    telegramEntitled: true,
    telegramLastHealthUpdateAt: null,
    telegramStatus: null,
    telegramWebhookStatus: null,
    termsUrl: "https://seller.example/terms",
    websiteEnabled: true,
    ...overrides,
  };
}

function checkStatus(snapshot: ReadinessSnapshot, code: string) {
  return evaluateReadinessSnapshot(snapshot, CHECKED_AT, TEST_POLICY_VERSION).checks.find((item) => item.code === code);
}

describe("tenant readiness policy", () => {
  it("allows a website-only seller with a healthy canonical storefront", () => {
    const result = evaluateReadinessSnapshot(readySnapshot(), CHECKED_AT, TEST_POLICY_VERSION);
    expect(result.ready).toBe(true);
    expect(checkStatus(readySnapshot(), "telegram_ready")).toMatchObject({ required: false, status: "pass" });
  });

  it("allows a Telegram-only entitled seller without requiring a canonical website", () => {
    const result = evaluateReadinessSnapshot(readySnapshot({
      canonicalDomainReady: false,
      telegramEnabled: true,
      telegramLastHealthUpdateAt: CHECKED_AT,
      telegramStatus: "active",
      telegramWebhookStatus: "verified",
      websiteEnabled: false,
    }), CHECKED_AT, TEST_POLICY_VERSION);
    expect(result.ready).toBe(true);
    expect(result.checks.find((item) => item.code === "storefront_ready")).toMatchObject({ required: false, status: "pass" });
  });

  it("requires both selected channels to be entitled and healthy", () => {
    const result = evaluateReadinessSnapshot(readySnapshot({
      telegramEnabled: true,
      telegramEntitled: false,
      telegramLastHealthUpdateAt: CHECKED_AT,
      telegramStatus: "active",
      telegramWebhookStatus: "verified",
    }), CHECKED_AT, TEST_POLICY_VERSION);
    expect(result.ready).toBe(false);
    expect(result.checks.find((item) => item.code === "channel_entitlements")?.status).toBe("fail");
  });

  it("fails stale PayOS and Telegram provider health", () => {
    const result = evaluateReadinessSnapshot(readySnapshot({
      payosLastCheckedAt: "2026-07-24T23:59:59.000Z",
      telegramEnabled: true,
      telegramLastHealthUpdateAt: "2026-06-25T23:59:59.000Z",
      telegramStatus: "active",
      telegramWebhookStatus: "verified",
    }), CHECKED_AT, TEST_POLICY_VERSION);
    expect(result.ready).toBe(false);
    expect(result.checks.filter((item) => item.status === "fail").map((item) => item.code)).toEqual(expect.arrayContaining([
      "payos_ready",
      "telegram_ready",
    ]));
  });

  it.each(["grace_period", "suspended", "canceled"])("blocks subscription state %s", (subscriptionState) => {
    expect(checkStatus(readySnapshot({ subscriptionState }), "subscription_publishable")?.status).toBe("fail");
  });

  it("allows past-due within provider policy but surfaces a warning", () => {
    const result = evaluateReadinessSnapshot(readySnapshot({
      graceEndsAt: "2026-07-29T00:00:00.000Z",
      subscriptionState: "past_due",
    }), CHECKED_AT, TEST_POLICY_VERSION);
    expect(result.ready).toBe(true);
    expect(result.checks.find((item) => item.code === "subscription_publishable")?.status).toBe("warning");
  });

  it("requires support, policy URLs and current seller attestation", () => {
    const result = evaluateReadinessSnapshot(readySnapshot({ policyAttestationVersion: null, supportContact: null }), CHECKED_AT, TEST_POLICY_VERSION);
    expect(result.ready).toBe(false);
    expect(result.checks.find((item) => item.code === "policies_ready")?.status).toBe("fail");
  });

  it("keeps a requested custom domain optional while warning about its state", () => {
    const result = evaluateReadinessSnapshot(readySnapshot({ customDomainPreference: "connect" }), CHECKED_AT, TEST_POLICY_VERSION);
    expect(result.ready).toBe(true);
    expect(result.checks.find((item) => item.code === "custom_domain_ready")).toMatchObject({ required: false, status: "warning" });
  });

  it("fails closed on critical integration state even when cached health fields look valid", () => {
    const result = evaluateReadinessSnapshot(readySnapshot({ criticalIntegrationError: true }), CHECKED_AT, TEST_POLICY_VERSION);
    expect(result.ready).toBe(false);
    expect(result.checks.find((item) => item.code === "integration_health")?.status).toBe("fail");
  });

  it("blocks readiness when a shop has no current platform attestation", () => {
    const result = evaluateReadinessSnapshot(readySnapshot(), CHECKED_AT);
    expect(result.ready).toBe(false);
    expect(result.checks.find((item) => item.code === "policies_ready")).toMatchObject({ required: true, status: "fail" });
  });
});

type FakeStatement = {
  all: () => Promise<{ results: unknown[] }>;
  first: () => Promise<unknown>;
  run: () => Promise<{ meta: { changes: number } }>;
};

class PublishDatabase {
  guardChanges = 1;
  memberRole = "owner";
  readonly queries: string[] = [];
  readinessRuns = 0;

  prepare(sql: string) {
    this.queries.push(sql);
    return {
      bind: (...values: unknown[]): FakeStatement => {
        void values;
        return {
          all: () => Promise.resolve({ results: [] }),
          first: () => {
            if (sql.includes("FROM shops") && sql.includes("INNER JOIN shop_members") && sql.includes("plans.feature_flags_json")) {
              return Promise.resolve({
                currency: "VND",
                default_locale: "vi",
                feature_flags_json: '{"storefront":true,"telegram":true}',
                limits_json: "{}",
                name: "Shop A",
                plan_code: "business",
                public_id: "shop_public_a",
                role: this.memberRole,
                shop_id: "shop-a",
                shop_status: "draft",
                slug: "shop-a",
                subscription_state: "active",
                current_period_end: "2099-01-01T00:00:00.000Z",
                timezone: "Asia/Ho_Chi_Minh",
              });
            }
            if (sql.includes("AS storefrontEntitled") && sql.includes("AS criticalIntegrationError")) {
              return Promise.resolve({
                canonicalDomainReady: 1,
                catalogReady: 1,
                criticalIntegrationError: 0,
                customDomainPreference: "later",
                customDomainReady: 0,
                currentPeriodEnd: "2099-01-01T00:00:00.000Z",
                fulfillmentReady: 1,
                payosLastCheckedAt: new Date().toISOString(),
                payosLastWebhookVerifiedAt: new Date().toISOString(),
                payosStatus: "active",
                payosWebhookStatus: "verified",
                platformDomainReady: 1,
                policyAttestationVersion: TEST_POLICY_VERSION,
                policyAttestedAt: new Date().toISOString(),
                privacyUrl: "https://seller.example/privacy",
                readinessVersion: 4,
                refundPolicyUrl: "https://seller.example/refunds",
                shopId: "shop-a",
                shopStatus: "draft",
                storefrontEntitled: 1,
                subscriptionState: "active",
                supportContact: "support@example.com",
                telegramEnabled: 0,
                telegramEntitled: 1,
                telegramLastHealthUpdateAt: null,
                telegramStatus: null,
                telegramWebhookStatus: null,
                termsUrl: "https://seller.example/terms",
                websiteEnabled: 1,
              });
            }
            return Promise.resolve(null);
          },
          run: () => {
            if (sql.includes("INSERT INTO shop_readiness_runs")) this.readinessRuns += 1;
            const changes = sql.includes("SET status = 'active'") ? this.guardChanges : 1;
            return Promise.resolve({ meta: { changes } });
          },
        };
      },
    };
  }

  async batch(statements: FakeStatement[]) {
    return Promise.all(statements.map(async (statement) => statement.run()));
  }
}

function testEnv(database: PublishDatabase): AppBindings {
  return { PLATFORM_DB: database } as unknown as AppBindings;
}

describe("guarded publish transition", () => {
  it("publishes only after a fresh persisted readiness run", async () => {
    const database = new PublishDatabase();
    const result = await publishReadyStorefront({
      env: testEnv(database),
      platformPolicyVersion: TEST_POLICY_VERSION,
      requestId: "request-test-1",
      shopPublicId: "shop_public_a",
      userId: "user-a",
    });
    expect(database.readinessRuns).toBe(1);
    expect(result.ready).toBe(true);
    expect(result.readinessVersion).toBe(5);
    const readinessQuery = database.queries.find((sql) => sql.includes("AS canonicalDomainReady"));
    const publishGuard = database.queries.find((sql) => sql.includes("UPDATE shops") && sql.includes("shop_onboarding_profiles.website_enabled = 1"));
    for (const sql of [readinessQuery, publishGuard]) {
      expect(sql).toContain("canonical.ownership_verified_at IS NOT NULL");
      expect(sql).toContain("json_extract(canonical.validation_metadata_json, '$.turnstile.status') = 'active'");
      expect(sql).toContain("json_extract(canonical.validation_metadata_json, '$.turnstile.hostname') = canonical.hostname_normalized");
      expect(sql).toContain("json_extract(canonical.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'");
      expect(sql).toContain("json_extract(canonical.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'");
      expect(sql).toContain("json_extract(canonical.validation_metadata_json, '$.turnstile.checkedAt')");
      expect(sql).toContain("-12 hours");
    }
    expect(readinessQuery).toContain("shop_domains.ownership_verified_at IS NOT NULL");
    expect(readinessQuery).toContain("json_extract(shop_domains.validation_metadata_json, '$.turnstile.hostname') = shop_domains.hostname_normalized");
  });

  it("rejects a manager even when all technical checks pass", async () => {
    const database = new PublishDatabase();
    database.memberRole = "manager";
    await expect(publishReadyStorefront({
      env: testEnv(database),
      platformPolicyVersion: TEST_POLICY_VERSION,
      requestId: "request-test-2",
      shopPublicId: "shop_public_a",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "authorization_denied", status: 403 });
    expect(database.readinessRuns).toBe(0);
  });

  it("fails when a provider disconnect wins the final guarded transition", async () => {
    const database = new PublishDatabase();
    database.guardChanges = 0;
    await expect(publishReadyStorefront({
      env: testEnv(database),
      platformPolicyVersion: TEST_POLICY_VERSION,
      requestId: "request-test-3",
      shopPublicId: "shop_public_a",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "readiness_changed", issues: ["rerun_readiness_required"] });
    expect(database.readinessRuns).toBe(1);
  });

  it("rejects publish before persisting readiness when the platform policy is explicitly unpublished", async () => {
    const database = new PublishDatabase();
    await expect(publishReadyStorefront({
      env: testEnv(database),
      platformPolicyVersion: null,
      requestId: "request-policy-unpublished",
      shopPublicId: "shop_public_a",
      userId: "user-a",
    })).rejects.toMatchObject({ code: "policy_unpublished", status: 409 });
    expect(database.readinessRuns).toBe(0);
  });
});
