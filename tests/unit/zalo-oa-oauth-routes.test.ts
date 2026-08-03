import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { startZaloOfficialAccountOAuth } from "../../src/lib/channels/zalo-oa-oauth-routes";
import type { AppBindings } from "../../src/lib/platform/bindings";

const NOW = new Date("2026-08-02T12:00:00.000Z");
const SHOP_ID = "shop-zalo-route";
const SHOP_PUBLIC_ID = "shop_00000000-0000-4000-8000-0000000000b1";
const USER_ID = "user-zalo-route";
const CONNECTOR_ID = "connector-zalo-route";
const CONNECTOR_PUBLIC_ID = "creq_00000000-0000-4000-8000-0000000000b2";
const SECRET = "zalo-route-session-secret-123456";
const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

class Statement {
  constructor(private readonly database: DatabaseSync, private readonly sql: string, private readonly values: SQLInputValue[] = []) {}

  bind(...values: unknown[]): Statement {
    return new Statement(this.database, this.sql, values as SQLInputValue[]);
  }

  // D1's generic row methods are required by the service under test.
  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  all<T>(): Promise<{ results: T[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) as T[] });
  }

  run(): Promise<{ meta: { changes: number } }> {
    const result = this.database.prepare(this.sql).run(...this.values);
    return Promise.resolve({ meta: { changes: Number(result.changes) } });
  }
}

class D1 {
  constructor(readonly database: DatabaseSync) {}

  prepare(sql: string): Statement {
    return new Statement(this.database, sql);
  }

  async batch(statements: Statement[]): Promise<Array<{ meta: { changes: number } }>> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function setup(): { database: DatabaseSync; env: AppBindings } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(join(process.cwd(), "migrations"))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(process.cwd(), "migrations", filename), "utf8"));
  }
  const now = NOW.toISOString();
  database.exec(`
    INSERT INTO plans (id, code, name, feature_flags_json, limits_json, created_at, updated_at)
    VALUES ('plan-zalo-route', 'zalo_route', 'Route plan', '{}', '{}', '${now}', '${now}');
    INSERT INTO shops (id, public_id, slug, name, status, default_locale, currency, timezone, readiness_version, created_at, updated_at)
    VALUES ('${SHOP_ID}', '${SHOP_PUBLIC_ID}', 'zalo-route-shop', 'Zalo route shop', 'active', 'en', 'VND', 'Asia/Ho_Chi_Minh', 1, '${now}', '${now}');
    INSERT INTO shop_subscriptions (id, shop_id, plan_id, state, created_at, updated_at)
    VALUES ('sub-zalo-route', '${SHOP_ID}', 'plan-zalo-route', 'active', '${now}', '${now}');
    INSERT INTO platform_users (id, email_normalized, display_name, status, created_at, updated_at)
    VALUES ('${USER_ID}', 'zalo-route@example.com', 'Zalo route owner', 'active', '${now}', '${now}');
    INSERT INTO shop_members (shop_id, user_id, role, status, created_at, updated_at)
    VALUES ('${SHOP_ID}', '${USER_ID}', 'owner', 'active', '${now}', '${now}');
    INSERT INTO channel_connector_requests (
      id, public_id, shop_id, channel_code, provider_code, requested_by_user_id,
      status, provider_reference_hash, reviewed_by_user_id, reviewed_at,
      idempotency_key_hash, request_hash, created_at, updated_at, version
    ) VALUES (
      '${CONNECTOR_ID}', '${CONNECTOR_PUBLIC_ID}', '${SHOP_ID}', 'zalo.oa', 'zalo.oa', '${USER_ID}',
      'active', 'provider-ref', '${USER_ID}', '${now}', 'idempotency', 'request', '${now}', '${now}', 1
    );
  `);
  const d1 = new D1(database);
  return {
    database,
    env: {
      ACTIVE_CREDENTIAL_KEY_VERSION: "v1",
      API_ORIGIN: "https://api.selinow.com",
      APP_ENV: "local",
      CREDENTIAL_KEK_V1: KEK,
      DASHBOARD_ORIGIN: "https://app.selinow.com",
      IDENTIFIER_HMAC_SECRET: "zalo-route-identity-hmac-secret",
      PLATFORM_DB: d1,
      SESSION_SECRET: SECRET,
    } as unknown as AppBindings,
  };
}

describe("Zalo OA OAuth routes", () => {
  it("starts tenant-bound OAuth while keeping the public callback provider-pending", async () => {
    const { database, env } = setup();
    const started = await startZaloOfficialAccountOAuth({
      appId: "zalo-app-route",
      connectorRequestPublicId: CONNECTOR_PUBLIC_ID,
      env,
      redirectUri: "https://app.selinow.com/api/channels/zalo-oa/callback",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    });
    const callback = await import("../../src/lib/channels/zalo-oa-oauth-routes");
    await expect(callback.completeZaloOfficialAccountOAuth({
      authorizationCode: "one-use-code",
      env,
      receivedState: started.state,
    })).rejects.toMatchObject({ code: "channel_provider_pending", status: 409 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM channel_credentials").get()).toMatchObject({ count: 0 });
    expect(database.prepare("SELECT status FROM channel_oauth_states").get()).toMatchObject({ status: "pending" });
  });

  it("does not allow a connector from another tenant", async () => {
    const { env } = setup();
    await expect(startZaloOfficialAccountOAuth({
      appId: "zalo-app-route",
      connectorRequestPublicId: "creq_00000000-0000-4000-8000-0000000000c1",
      env,
      redirectUri: "https://app.selinow.com/api/channels/zalo-oa/callback",
      shopPublicId: SHOP_PUBLIC_ID,
      userId: USER_ID,
    })).rejects.toMatchObject({ code: "channel_connector_request_not_found", status: 404 });
  });
});
