import { describe, expect, it } from "vitest";

import type { AppBindings } from "../../src/lib/platform/bindings";
import { loadTelegramShop } from "../../src/lib/telegram/commerce";

function fakeEnvironment(row: Record<string, unknown> | null): { env: AppBindings; query: () => { sql: string; values: unknown[] } } {
  let captured = { sql: "", values: [] as unknown[] };
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          captured = { sql, values };
          return { first: () => Promise.resolve(row) };
        },
      };
    },
  };
  return {
    env: { PLATFORM_DB: database } as unknown as AppBindings,
    query: () => captured,
  };
}

describe("Telegram shop routing", () => {
  it("uses the shop canonical domain instead of a drifting primary flag", async () => {
    const { env, query } = fakeEnvironment({
      currency: "VND",
      defaultLocale: "vi",
      hostname: "store.example.com",
      id: "shop_internal",
      name: "Store",
      orderExpiryMinutes: 30,
      status: "active",
      subscriptionState: "active",
    });

    await expect(loadTelegramShop(env, "shop_internal")).resolves.toMatchObject({
      id: "shop_internal",
      origin: "https://store.example.com",
    });
    expect(query().sql).toContain("canonical_domain.id = shops.canonical_domain_id");
    expect(query().sql).toContain("canonical_domain.shop_id = shops.id");
    expect(query().sql).toContain("canonical_domain.status = 'active'");
    expect(query().sql).toContain("canonical_domain.type = 'platform_subdomain'");
    expect(query().sql).toContain("canonical_domain.ownership_verified_at IS NOT NULL");
    expect(query().sql).toContain("canonical_domain.hostname_status = 'active'");
    expect(query().sql).toContain("canonical_domain.ssl_status = 'active'");
    expect(query().sql).toContain("canonical_domain.dns_status = 'active'");
    expect(query().sql).toContain("json_extract(canonical_domain.validation_metadata_json, '$.turnstile.status') = 'active'");
    expect(query().sql).toContain("json_extract(canonical_domain.validation_metadata_json, '$.turnstile.hostname') = canonical_domain.hostname_normalized");
    expect(query().sql).toContain("json_extract(canonical_domain.validation_metadata_json, '$.turnstile.mode') = 'operator_managed'");
    expect(query().sql).toContain("json_extract(canonical_domain.validation_metadata_json, '$.turnstile.source') = 'cloudflare_widget_domains'");
    expect(query().sql).toContain("json_extract(canonical_domain.validation_metadata_json, '$.turnstile.checkedAt')");
    expect(query().sql).toContain("canonical_domain.deleted_at IS NULL");
    expect(query().sql).toContain("canonical_domain.delete_requested_at IS NULL");
    expect(query().sql).toContain("-12 hours");
    expect(query().sql).not.toContain("is_primary");
    expect(query().values).toEqual(["shop_internal"]);
  });

  it("rejects a shop without an active canonical domain", async () => {
    const { env } = fakeEnvironment(null);
    await expect(loadTelegramShop(env, "shop_internal")).rejects.toMatchObject({ code: "tenant_not_found", status: 404 });
  });
});
