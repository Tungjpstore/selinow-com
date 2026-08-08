import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBindings } from "../../src/lib/platform/bindings";

const routeDependencies = vi.hoisted<{ env: AppBindings | null; warnings: unknown[] }>(() => ({ env: null, warnings: [] }));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => routeDependencies.env,
}));
vi.mock("../../src/lib/operations/logger", () => ({
  loggerFor: () => ({ warn: (event: unknown) => { routeDependencies.warnings.push(event); } }),
}));

import { magicLinkRequesterAddress, purgeAuthRequestAdmissions } from "../../src/lib/auth/admission";
import {
  authenticateRequest,
  consumeMagicLink,
  listSessions,
  magicLinkInitiationCookieName,
  requestMagicLink,
  revokeAllSessions,
} from "../../src/lib/auth/session";
import { GET as consumeMagicLinkRoute } from "../../src/pages/api/auth/magic-link/consume";
import { POST as requestMagicLinkRoute } from "../../src/pages/api/auth/magic-link/request";

const NOW = new Date("2026-07-26T04:00:00.000Z");

class SqliteStatement {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.database, this.sql, values.map((value): SQLInputValue => {
      if (value === null || typeof value === "string" || typeof value === "number"
        || typeof value === "bigint" || value instanceof Uint8Array) return value;
      throw new TypeError("unsupported_sqlite_binding");
    }));
  }

  first<T>(): Promise<T | null> {
    return Promise.resolve((this.database.prepare(this.sql).get(...this.values) as T | undefined) ?? null);
  }

  all(): Promise<{ results: unknown[] }> {
    return Promise.resolve({ results: this.database.prepare(this.sql).all(...this.values) });
  }

  run(): Promise<{ meta: { changes: number } }> {
    return Promise.resolve(this.runSync());
  }

  runSync(): { meta: { changes: number } } {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}

function applyMigrations(database: DatabaseSync): void {
  const directory = join(process.cwd(), "migrations");
  for (const filename of readdirSync(directory).filter((name) => /^\d{4}_.+\.sql$/u.test(name)).sort()) {
    database.exec(readFileSync(join(directory, filename), "utf8"));
  }
}

type TestBindingOverrides = Partial<Record<
  "MAGIC_LINK_EMAIL_RATE_LIMIT" | "MAGIC_LINK_GLOBAL_RATE_LIMIT" | "MAGIC_LINK_RATE_LIMIT_WINDOW_SECONDS" | "MAGIC_LINK_REQUESTER_RATE_LIMIT",
  string
>> & {
  APP_ENV?: AppBindings["APP_ENV"];
  EMAIL?: SendEmail;
};

function bindings(database: DatabaseSync, overrides: TestBindingOverrides = {}): AppBindings {
  return {
    APP_ENV: overrides.APP_ENV ?? "local",
    DASHBOARD_ORIGIN: "https://app-staging.selinow.com",
    EMAIL: overrides.EMAIL ?? { send: () => Promise.resolve({ messageId: "test-message" }) },
    EMAIL_FROM_ADDRESS: "no-reply@selinow.com",
    EMAIL_FROM_NAME: "Selinow",
    IDENTIFIER_HMAC_SECRET: "identifier-hmac-test-secret",
    MAGIC_LINK_GLOBAL_RATE_LIMIT: overrides.MAGIC_LINK_GLOBAL_RATE_LIMIT ?? "200",
    MAGIC_LINK_EMAIL_RATE_LIMIT: overrides.MAGIC_LINK_EMAIL_RATE_LIMIT ?? "5",
    MAGIC_LINK_RATE_LIMIT_WINDOW_SECONDS: overrides.MAGIC_LINK_RATE_LIMIT_WINDOW_SECONDS ?? "900",
    MAGIC_LINK_REQUESTER_RATE_LIMIT: overrides.MAGIC_LINK_REQUESTER_RATE_LIMIT ?? "20",
    MAGIC_LINK_SECRET: "magic-link-rate-limit-test-secret",
    PLATFORM_DB: {
      batch(statements: D1PreparedStatement[]) {
        database.exec("BEGIN IMMEDIATE");
        try {
          const results = (statements as unknown as SqliteStatement[]).map((statement) => statement.runSync());
          database.exec("COMMIT");
          return Promise.resolve(results);
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
      prepare(sql: string) {
        return new SqliteStatement(database, sql) as unknown as D1PreparedStatement;
      },
    } as D1Database,
    SESSION_COOKIE_NAME: "selinow_staging_session",
    SESSION_SECRET: "session-secret-for-magic-link-tests",
  } as unknown as AppBindings;
}

describe("magic-link issuance rate limit", () => {
  let database: DatabaseSync;
  let env: AppBindings;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    env = bindings(database);
    routeDependencies.env = env;
    routeDependencies.warnings = [];
  });

  afterEach(() => {
    database.close();
  });

  it("soft-suppresses mailbox abuse without returning an account-specific 429", async () => {
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => requestMagicLink({
      displayName: `Seller ${String(index)}`,
      email: "seller@example.test",
      env,
      requesterAddress: "203.0.113.10",
      now: NOW,
    })));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(8);
    expect(results.filter((result) => result.status === "fulfilled" && result.value.debugMagicLink !== undefined)).toHaveLength(5);
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens").get()).toEqual({ count: 5 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_request_admissions WHERE delivery_permitted = 0").get()).toEqual({ count: 3 });
  });

  it("allows exactly one request when four tokens already exist", async () => {
    for (let index = 0; index < 4; index += 1) {
      await requestMagicLink({ displayName: "Seller", email: "seller@example.test", env, requesterAddress: "203.0.113.10", now: NOW });
    }
    const results = await Promise.allSettled([
      requestMagicLink({ displayName: "Accepted", email: "seller@example.test", env, requesterAddress: "203.0.113.10", now: NOW }),
      requestMagicLink({ displayName: "Rejected", email: "seller@example.test", env, requesterAddress: "203.0.113.10", now: NOW }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "fulfilled" && result.value.debugMagicLink !== undefined)).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens").get()).toEqual({ count: 5 });
  });

  it("does not mutate an existing display name before mailbox verification", async () => {
    await requestMagicLink({ displayName: "Trusted Name", email: "seller@example.test", env, requesterAddress: "203.0.113.10", now: NOW });
    for (let index = 1; index < 5; index += 1) {
      await requestMagicLink({ displayName: `Untrusted ${String(index)}`, email: "seller@example.test", env, requesterAddress: "203.0.113.10", now: NOW });
    }
    await expect(requestMagicLink({ displayName: "Blocked Rename", email: "seller@example.test", env, requesterAddress: "203.0.113.10", now: NOW }))
      .resolves.not.toHaveProperty("debugMagicLink");

    expect(database.prepare("SELECT display_name AS displayName FROM platform_users WHERE email_normalized = 'seller@example.test'").get())
      .toEqual({ displayName: "Trusted Name" });
  });

  it("keeps independent budgets and excludes requests older than fifteen minutes", async () => {
    for (let index = 0; index < 5; index += 1) {
      await requestMagicLink({ displayName: "Seller A", email: "a@example.test", env, requesterAddress: "203.0.113.10", now: NOW });
      await requestMagicLink({ displayName: "Seller B", email: "b@example.test", env, requesterAddress: "203.0.113.11", now: NOW });
    }
    const later = new Date(NOW.getTime() + 15 * 60_000 + 1);
    await expect(requestMagicLink({ displayName: "Seller A", email: "a@example.test", env, requesterAddress: "203.0.113.10", now: later })).resolves.toHaveProperty("debugMagicLink");
    await expect(requestMagicLink({ displayName: "Seller B", email: "b@example.test", env, requesterAddress: "203.0.113.11", now: later })).resolves.toHaveProperty("debugMagicLink");
  });

  it("bounds many unique emails by one requester budget before durable auth writes", async () => {
    env = bindings(database, {
      MAGIC_LINK_GLOBAL_RATE_LIMIT: "50",
      MAGIC_LINK_REQUESTER_RATE_LIMIT: "3",
    });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => requestMagicLink({
      displayName: `Seller ${String(index)}`,
      email: `seller-${String(index)}@example.test`,
      env,
      requesterAddress: "203.0.113.20",
      now: NOW,
    })));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(5);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_request_admissions").get()).toEqual({ count: 3 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM platform_users").get()).toEqual({ count: 3 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens").get()).toEqual({ count: 3 });
    expect(database.prepare("SELECT requester_hash AS requesterHash FROM auth_request_admissions LIMIT 1").get())
      .not.toEqual({ requesterHash: "203.0.113.20" });
  });

  it("bounds distributed requester addresses by one global budget atomically", async () => {
    env = bindings(database, {
      MAGIC_LINK_GLOBAL_RATE_LIMIT: "5",
      MAGIC_LINK_REQUESTER_RATE_LIMIT: "10",
    });
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => requestMagicLink({
      displayName: `Seller ${String(index)}`,
      email: `seller-${String(index)}@example.test`,
      env,
      requesterAddress: `203.0.113.${String(index + 30)}`,
      now: NOW,
    })));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_request_admissions").get()).toEqual({ count: 5 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM platform_users").get()).toEqual({ count: 5 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens").get()).toEqual({ count: 5 });
  });

  it("rolls the admission budget into a new window and purges expired rows", async () => {
    env = bindings(database, {
      MAGIC_LINK_GLOBAL_RATE_LIMIT: "2",
      MAGIC_LINK_REQUESTER_RATE_LIMIT: "2",
      MAGIC_LINK_RATE_LIMIT_WINDOW_SECONDS: "60",
    });
    await requestMagicLink({ displayName: "Seller A", email: "a@example.test", env, requesterAddress: "203.0.113.40", now: NOW });
    await requestMagicLink({ displayName: "Seller B", email: "b@example.test", env, requesterAddress: "203.0.113.41", now: NOW });
    await expect(requestMagicLink({ displayName: "Seller C", email: "c@example.test", env, requesterAddress: "203.0.113.42", now: NOW }))
      .rejects.toMatchObject({ code: "rate_limited", status: 429 });

    const nextWindow = new Date(NOW.getTime() + 60_000);
    await expect(requestMagicLink({ displayName: "Seller C", email: "c@example.test", env, requesterAddress: "203.0.113.42", now: nextWindow }))
      .resolves.toHaveProperty("debugMagicLink");
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_request_admissions").get()).toEqual({ count: 3 });

    expect(await purgeAuthRequestAdmissions(env, nextWindow)).toBe(2);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_request_admissions").get()).toEqual({ count: 1 });
  });

  it("uses only the bounded Cloudflare client-address signal for requester identity", () => {
    expect(magicLinkRequesterAddress(new Request("https://app.example.test", {
      headers: {
        "CF-Connecting-IP": " 203.0.113.50 ",
        "X-Forwarded-For": "198.51.100.1",
      },
    }))).toBe("203.0.113.50");
    expect(magicLinkRequesterAddress(new Request("https://app.example.test", {
      headers: { "X-Forwarded-For": "198.51.100.1" },
    }))).toBe("unknown");
    expect(magicLinkRequesterAddress(new Request("https://app.example.test", {
      headers: { "CF-Connecting-IP": "x".repeat(129) },
    }))).toBe("unknown");
  });

  it("sends staging magic links through the canonical dashboard origin without disclosing the token", async () => {
    const messages: unknown[] = [];
    env = bindings(database, {
      APP_ENV: "staging",
      EMAIL: {
        send(message) {
          messages.push(message);
          return Promise.resolve({ messageId: "email-message-id" });
        },
      },
    });

    const result = await requestMagicLink({
      displayName: "Seller",
      email: "seller@example.test",
      env,
      requesterAddress: "203.0.113.60",
      now: NOW,
    });

    expect(result).toMatchObject({ expiresAt: "2026-07-26T04:15:00.000Z" });
    expect(result.initiationBinding).toHaveLength(43);
    expect(messages).toHaveLength(1);
    const message = messages[0] as { from: unknown; html: string; subject: string; text: string; to: string };
    expect(message).toMatchObject({
      from: { email: "no-reply@selinow.com", name: "Selinow" },
      subject: "Sign in to Selinow",
      to: "seller@example.test",
    });
    const link = message.text.split("\n").find((line) => line.startsWith("https://app-staging.selinow.com/"));
    expect(link).toBeDefined();
    expect(new URL(link ?? "").pathname).toBe("/api/auth/magic-link/consume");
    expect(new URL(link ?? "").searchParams.get("token")).toHaveLength(43);
    expect(message.html).toContain("app-staging.selinow.com/api/auth/magic-link/consume");
    expect(JSON.stringify(result)).not.toContain(new URL(link ?? "").searchParams.get("token") ?? "");
  });

  it("maps Cloudflare Email Sending failures to a safe provider error", async () => {
    env = bindings(database, {
      APP_ENV: "staging",
      EMAIL: {
        send() {
          return Promise.reject(new Error("provider secret and token must not escape"));
        },
      },
    });

    await expect(requestMagicLink({
      displayName: "Seller",
      email: "seller@example.test",
      env,
      requesterAddress: "203.0.113.61",
      now: NOW,
    })).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
  });

  it("requires the dashboard origin before issuing a browser initiation binding", async () => {
    const requestContext = (origin: string) => ({
      locals: { locale: "en-US", requestId: "request-magic-link-origin" },
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/request`, {
        body: JSON.stringify({ displayName: "Seller", email: "seller-origin@example.test" }),
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
        },
        method: "POST",
      }),
    } as unknown as Parameters<typeof requestMagicLinkRoute>[0]);

    const crossSiteResponse = await requestMagicLinkRoute(requestContext("https://evil.example"));
    expect(crossSiteResponse.status).toBe(403);
    expect(crossSiteResponse.headers.get("Set-Cookie")).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens").get()).toEqual({ count: 0 });

    const sameOriginResponse = await requestMagicLinkRoute(requestContext(env.DASHBOARD_ORIGIN));
    expect(sameOriginResponse.status).toBe(202);
    expect(sameOriginResponse.headers.get("Set-Cookie")).toContain(`${magicLinkInitiationCookieName(env)}=`);
    expect(sameOriginResponse.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(sameOriginResponse.headers.get("Set-Cookie")).toContain("SameSite=Lax");
    expect(sameOriginResponse.headers.get("Set-Cookie")).toContain("Max-Age=900");
    const body = await sameOriginResponse.json();
    expect(body).not.toHaveProperty("initiationBinding");
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens").get()).toEqual({ count: 1 });
  });

  it("records only safe request telemetry when magic-link initiation fails", async () => {
    const response = await requestMagicLinkRoute({
      locals: { requestId: "request-safe-auth-log" },
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/request`, {
        body: JSON.stringify({ email: "seller@example.test" }),
        headers: { "Content-Type": "application/json", Origin: "https://wrong.example.test" },
        method: "POST",
      }),
    } as unknown as Parameters<typeof requestMagicLinkRoute>[0]);

    expect(response.status).toBe(403);
    expect(routeDependencies.warnings).toEqual([{
      errorCode: "csrf_invalid",
      event: "auth.magic_link_request_failed",
      requestId: "request-safe-auth-log",
      source: "http",
      status: 403,
    }]);
    expect(JSON.stringify(routeDependencies.warnings)).not.toContain("seller@example.test");
  });

  it("binds consumption to the browser that requested the link", async () => {
    const now = new Date();
    const victimRequest = await requestMagicLink({
      displayName: "Victim",
      email: "victim@example.test",
      env,
      requesterAddress: "203.0.113.70",
      now,
    });
    const attackerRequest = await requestMagicLink({
      displayName: "Attacker",
      email: "attacker@example.test",
      env,
      requesterAddress: "203.0.113.71",
      now,
    });
    const tokenFrom = (link: string | undefined): string => new URL(link ?? "", env.DASHBOARD_ORIGIN)
      .searchParams.get("token") ?? "";
    const victimToken = tokenFrom(victimRequest.debugMagicLink);
    const attackerToken = tokenFrom(attackerRequest.debugMagicLink);

    const victimSession = await consumeMagicLink({
      env,
      initiationBinding: victimRequest.initiationBinding,
      token: victimToken,
    });
    expect(victimSession.auth.email).toBe("victim@example.test");
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });

    const forcedLoginResponse = await consumeMagicLinkRoute({
      locals: { requestId: "request-forced-login" },
      redirect: (location: string, status: number) => new Response(null, {
        headers: { Location: location },
        status,
      }),
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/consume?token=${encodeURIComponent(attackerToken)}`, {
        headers: {
          Cookie: [
            `${env.SESSION_COOKIE_NAME}=${victimSession.credentials.sessionToken}`,
            `${magicLinkInitiationCookieName(env)}=${victimRequest.initiationBinding}`,
          ].join("; "),
        },
      }),
    } as unknown as Parameters<typeof consumeMagicLinkRoute>[0]);
    expect(forcedLoginResponse.status).toBe(401);
    expect(forcedLoginResponse.headers.get("Set-Cookie")).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });

    const legitimateResponse = await consumeMagicLinkRoute({
      locals: { requestId: "request-legitimate-login" },
      redirect: (location: string, status: number) => new Response(null, {
        headers: { Location: location },
        status,
      }),
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/consume?token=${encodeURIComponent(attackerToken)}`, {
        headers: {
          Cookie: `${magicLinkInitiationCookieName(env)}=${attackerRequest.initiationBinding}`,
        },
      }),
    } as unknown as Parameters<typeof consumeMagicLinkRoute>[0]);
    expect(legitimateResponse.status).toBe(303);
    expect(legitimateResponse.headers.get("Location")).toBe("/app");
    expect(legitimateResponse.headers.get("Set-Cookie")).toContain(`${env.SESSION_COOKIE_NAME}=`);
    expect(legitimateResponse.headers.get("Set-Cookie")).toContain(`${magicLinkInitiationCookieName(env)}=`);
    expect(legitimateResponse.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 2 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM auth_sessions
      INNER JOIN platform_users ON platform_users.id = auth_sessions.user_id
      WHERE platform_users.email_normalized = 'attacker@example.test'
    `).get()).toEqual({ count: 1 });
  });

  it("lists only the user's active sessions and revokes them together", async () => {
    const now = new Date();
    const firstLink = await requestMagicLink({
      displayName: "Seller",
      email: "sessions@example.test",
      env,
      requesterAddress: "203.0.113.80",
      now,
    });
    const secondLink = await requestMagicLink({
      displayName: "Seller",
      email: "sessions@example.test",
      env,
      requesterAddress: "203.0.113.80",
      now,
    });
    const token = (link: string | undefined) => new URL(link ?? "", env.DASHBOARD_ORIGIN).searchParams.get("token") ?? "";
    await consumeMagicLink({ env, initiationBinding: firstLink.initiationBinding, token: token(firstLink.debugMagicLink) });
    const current = await consumeMagicLink({ env, initiationBinding: secondLink.initiationBinding, token: token(secondLink.debugMagicLink) });
    const auth = { ...current.auth, csrfTokenHash: "test-csrf-hash" };

    const sessions = await listSessions(auth, env);
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.isCurrent)).toHaveLength(1);
    expect(sessions.every((session) => !Object.hasOwn(session, "tokenHash"))).toBe(true);

    expect(await revokeAllSessions(auth, env)).toBe(2);
    expect(await listSessions(auth, env)).toEqual([]);
  });

  it("refreshes stale session activity without making it part of authentication authority", async () => {
    const activityStartedAt = new Date();
    const requested = await requestMagicLink({
      displayName: "Seller",
      email: "activity@example.test",
      env,
      requesterAddress: "203.0.113.81",
      now: activityStartedAt,
    });
    const magicToken = new URL(requested.debugMagicLink ?? "", env.DASHBOARD_ORIGIN).searchParams.get("token") ?? "";
    const session = await consumeMagicLink({ env, initiationBinding: requested.initiationBinding, token: magicToken });
    database.prepare("UPDATE auth_sessions SET last_seen_at = '2000-01-01T00:00:00.000Z' WHERE id = ?")
      .run(session.auth.sessionId);

    await expect(authenticateRequest(new Request(`${env.DASHBOARD_ORIGIN}/app`, {
      headers: { Cookie: `${env.SESSION_COOKIE_NAME}=${session.credentials.sessionToken}` },
    }), env)).resolves.toMatchObject({ sessionId: session.auth.sessionId });

    const activity = database.prepare("SELECT last_seen_at AS lastSeenAt FROM auth_sessions WHERE id = ?")
      .get(session.auth.sessionId) as { lastSeenAt: string };
    expect(activity.lastSeenAt).not.toBe("2000-01-01T00:00:00.000Z");
    expect(Date.parse(activity.lastSeenAt)).toBeGreaterThanOrEqual(activityStartedAt.getTime());
  });
});
