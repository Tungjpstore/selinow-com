import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppBindings } from "../../src/lib/platform/bindings";
import { hmacToken } from "../../src/lib/core/crypto";
import { buildPlatformAdminBootstrapSql } from "../../scripts/lib/platform-admin-bootstrap.mjs";

const routeDependencies = vi.hoisted<{ env: AppBindings | null; warnings: unknown[] }>(() => ({ env: null, warnings: [] }));

vi.mock("../../src/lib/platform/bindings", () => ({
  getBindings: () => routeDependencies.env,
}));
vi.mock("../../src/lib/operations/logger", () => ({
  loggerFor: () => ({ warn: (event: unknown) => { routeDependencies.warnings.push(event); } }),
}));

import {
  claimProvisioningAdmission,
  cloudflareRequesterAddress,
  magicLinkRequesterAddress,
  purgeAuthRequestAdmissions,
} from "../../src/lib/auth/admission";
import {
  authenticateRequest,
  consumeMagicLink,
  listSessions,
  magicLinkConfirmationCookieName,
  magicLinkInitiationCookieName,
  requestMagicLink,
  revokeAllSessions,
} from "../../src/lib/auth/session";
import {
  GET as consumeMagicLinkRoute,
  POST as consumeMagicLinkPostRoute,
} from "../../src/pages/api/auth/magic-link/consume";
import { POST as requestMagicLinkRoute } from "../../src/pages/api/auth/magic-link/request";

const NOW = new Date("2026-07-26T04:00:00.000Z");

function tokenFromMagicLink(link: string | undefined, origin: string): string {
  const url = new URL(link ?? "", origin);
  return new URLSearchParams(url.hash.slice(1)).get("magic") ?? url.searchParams.get("token") ?? "";
}

function cookieValue(setCookie: string | null, name: string): string {
  const match = setCookie?.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`, "u"));
  return match?.[1] ?? "";
}

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
  "MAGIC_LINK_EMAIL_RATE_LIMIT" | "MAGIC_LINK_GLOBAL_RATE_LIMIT" | "MAGIC_LINK_RATE_LIMIT_WINDOW_SECONDS" | "MAGIC_LINK_REQUESTER_RATE_LIMIT"
  | "TURNSTILE_SECRET_KEY" | "TURNSTILE_SITE_KEY",
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
    TURNSTILE_SECRET_KEY: overrides.TURNSTILE_SECRET_KEY,
    TURNSTILE_SITE_KEY: overrides.TURNSTILE_SITE_KEY,
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

  it("requires a server-verified adaptive challenge after the per-email delivery budget", async () => {
    const currentWindow = new Date();
    for (let index = 0; index < 5; index += 1) {
      await requestMagicLink({
        displayName: "Seller",
        email: "challenge@example.test",
        env,
        requesterAddress: "203.0.113.12",
        now: currentWindow,
      });
    }

    const routeContext = (turnstileToken?: string) => ({
      locals: { locale: "en-US", requestId: "request-adaptive-challenge" },
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/request`, {
        body: JSON.stringify({
          displayName: "Seller",
          email: "challenge@example.test",
          ...(turnstileToken === undefined ? {} : { turnstileToken }),
        }),
        headers: {
          "CF-Connecting-IP": "203.0.113.12",
          "Content-Type": "application/json",
          Origin: env.DASHBOARD_ORIGIN,
        },
        method: "POST",
      }),
    } as unknown as Parameters<typeof requestMagicLinkRoute>[0]);

    const challenged = await requestMagicLinkRoute(routeContext());
    expect(challenged.status).toBe(202);
    await expect(challenged.json()).resolves.toMatchObject({
      accepted: true,
      challengeRequired: true,
      requestId: "request-adaptive-challenge",
    });
    expect(challenged.headers.get("Set-Cookie")).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens").get()).toEqual({ count: 5 });

    env = bindings(database, {
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    });
    routeDependencies.env = env;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      action: "magic_link_request",
      hostname: "app-staging.selinow.com",
      success: true,
    }), { status: 200 }));

    const admitted = await requestMagicLinkRoute(routeContext("turnstile-token-123"));
    expect(admitted.status).toBe(202);
    await expect(admitted.json()).resolves.toMatchObject({ accepted: true, challengeRequired: false });
    expect(admitted.headers.get("Set-Cookie")).toContain(`${magicLinkInitiationCookieName(env)}=`);
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens").get()).toEqual({ count: 6 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const verificationRequest = fetchMock.mock.calls[0]?.[1];
    expect(verificationRequest?.body).toBeInstanceOf(FormData);
    expect((verificationRequest?.body as FormData).get("remoteip")).toBe("203.0.113.12");
    fetchMock.mockRestore();
  });

  it("fails a challenged production request closed when Turnstile configuration is missing", async () => {
    const currentWindow = new Date();
    for (let index = 0; index < 5; index += 1) {
      await requestMagicLink({
        displayName: "Seller",
        email: "production-challenge@example.test",
        env,
        requesterAddress: "203.0.113.13",
        now: currentWindow,
      });
    }
    env = bindings(database, { APP_ENV: "production" });
    routeDependencies.env = env;

    const requestContext = (turnstileToken?: string) => ({
      locals: { locale: "en-US", requestId: "request-missing-turnstile" },
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/request`, {
        body: JSON.stringify({
          email: "production-challenge@example.test",
          ...(turnstileToken === undefined ? {} : { turnstileToken }),
        }),
        headers: {
          "CF-Connecting-IP": "203.0.113.13",
          "Content-Type": "application/json",
          Origin: env.DASHBOARD_ORIGIN,
        },
        method: "POST",
      }),
    } as unknown as Parameters<typeof requestMagicLinkRoute>[0]);

    const unchallengedResponse = await requestMagicLinkRoute(requestContext());
    expect(unchallengedResponse.status).toBe(503);
    await expect(unchallengedResponse.json()).resolves.toMatchObject({
      code: "turnstile_unavailable",
      requestId: "request-missing-turnstile",
    });

    const challengedResponse = await requestMagicLinkRoute(requestContext("turnstile-token-123"));
    expect(challengedResponse.status).toBe(503);
    await expect(challengedResponse.json()).resolves.toMatchObject({
      code: "turnstile_unavailable",
      requestId: "request-missing-turnstile",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens").get()).toEqual({ count: 5 });
    expect(JSON.stringify(routeDependencies.warnings)).not.toContain("production-challenge@example.test");
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

    const fulfilled = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(fulfilled).toHaveLength(8);
    expect(fulfilled.filter((result) => result.debugMagicLink !== undefined)).toHaveLength(3);
    expect(fulfilled.filter((result) => result.challengeRequired)).toHaveLength(5);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
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

    const fulfilled = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    expect(fulfilled).toHaveLength(8);
    expect(fulfilled.filter((result) => result.debugMagicLink !== undefined)).toHaveLength(5);
    expect(fulfilled.filter((result) => result.challengeRequired)).toHaveLength(3);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_request_admissions").get()).toEqual({ count: 5 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM platform_users").get()).toEqual({ count: 5 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens").get()).toEqual({ count: 5 });
  });

  it("offers a verified adaptive lane after distributed ordinary exhaustion", async () => {
    env = bindings(database, {
      APP_ENV: "production",
      MAGIC_LINK_GLOBAL_RATE_LIMIT: "3",
      MAGIC_LINK_REQUESTER_RATE_LIMIT: "3",
      TURNSTILE_SECRET_KEY: "0x12345678901234567890123456789012",
      TURNSTILE_SITE_KEY: "0x12345678901234567890",
    });
    routeDependencies.env = env;
    const currentWindow = new Date();
    for (let index = 0; index < 3; index += 1) {
      await requestMagicLink({
        displayName: `Ordinary ${String(index)}`,
        email: `ordinary-${String(index)}@example.test`,
        env,
        requesterAddress: `203.0.113.${String(index + 50)}`,
        now: currentWindow,
      });
    }

    const routeContext = (turnstileToken?: string) => ({
      locals: { locale: "en-US", requestId: "request-global-adaptive" },
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/request`, {
        body: JSON.stringify({
          email: "legitimate-after-exhaustion@example.test",
          ...(turnstileToken === undefined ? {} : { turnstileToken }),
        }),
        headers: {
          "CF-Connecting-IP": "203.0.113.99",
          "Content-Type": "application/json",
          Origin: env.DASHBOARD_ORIGIN,
        },
        method: "POST",
      }),
    } as unknown as Parameters<typeof requestMagicLinkRoute>[0]);

    const challenged = await requestMagicLinkRoute(routeContext());
    expect(challenged.status).toBe(202);
    await expect(challenged.json()).resolves.toMatchObject({
      accepted: true,
      challengeRequired: true,
      requestId: "request-global-adaptive",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_request_admissions").get()).toEqual({ count: 3 });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      action: "magic_link_request",
      hostname: "app-staging.selinow.com",
      success: true,
    }), { status: 200 }));
    const admitted = await requestMagicLinkRoute(routeContext("turnstile-token-verified"));
    expect(admitted.status).toBe(202);
    await expect(admitted.json()).resolves.toMatchObject({ accepted: true, challengeRequired: false });
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_request_admissions").get()).toEqual({ count: 4 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens").get()).toEqual({ count: 4 });
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockRestore();
  });

  it("bounds the verified adaptive lane across distributed requesters", async () => {
    env = bindings(database, {
      MAGIC_LINK_GLOBAL_RATE_LIMIT: "20",
      MAGIC_LINK_REQUESTER_RATE_LIMIT: "20",
    });
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => requestMagicLink({
      challengePassed: true,
      displayName: `Adaptive ${String(index)}`,
      email: `adaptive-${String(index)}@example.test`,
      env,
      requesterAddress: `198.51.100.${String(index + 10)}`,
      now: NOW,
    })));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_request_admissions").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM magic_link_tokens").get()).toEqual({ count: 2 });

    await expect(requestMagicLink({
      displayName: "Ordinary remains independent",
      email: "ordinary-after-adaptive@example.test",
      env,
      requesterAddress: "198.51.100.250",
      now: NOW,
    })).resolves.toHaveProperty("debugMagicLink");
  });

  it("bounds verified adaptive requests by requester and email", async () => {
    const sameEmail = await Promise.allSettled([
      requestMagicLink({
        challengePassed: true,
        displayName: "Adaptive Subject A",
        email: "adaptive-subject@example.test",
        env,
        requesterAddress: "198.51.100.90",
        now: NOW,
      }),
      requestMagicLink({
        challengePassed: true,
        displayName: "Adaptive Subject B",
        email: "adaptive-subject@example.test",
        env,
        requesterAddress: "198.51.100.91",
        now: NOW,
      }),
    ]);
    expect(sameEmail.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(sameEmail.filter((result) => result.status === "rejected")).toHaveLength(1);

    const sameRequester = await Promise.allSettled(Array.from({ length: 3 }, (_, index) => requestMagicLink({
      challengePassed: true,
      displayName: `Adaptive Requester ${String(index)}`,
      email: `adaptive-requester-${String(index)}@example.test`,
      env,
      requesterAddress: "198.51.100.100",
      now: NOW,
    })));
    expect(sameRequester.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(sameRequester.filter((result) => result.status === "rejected")).toHaveLength(1);
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
      .resolves.toMatchObject({ challengeRequired: true });

    const nextWindow = new Date(NOW.getTime() + 60_000);
    await expect(requestMagicLink({ displayName: "Seller C", email: "c@example.test", env, requesterAddress: "203.0.113.42", now: nextWindow }))
      .resolves.toHaveProperty("debugMagicLink");
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_request_admissions").get()).toEqual({ count: 3 });

    expect(await purgeAuthRequestAdmissions(env, nextWindow)).toBe(2);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_request_admissions").get()).toEqual({ count: 1 });
  });

  it("uses only the bounded Cloudflare client-address signal for requester identity", () => {
    expect(cloudflareRequesterAddress(new Request("https://app.example.test", {
      headers: {
        "CF-Connecting-IP": " 203.0.113.50 ",
        "X-Forwarded-For": "198.51.100.1",
      },
    }))).toBe("203.0.113.50");
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

  it("atomically enforces requester, subject, and global provisioning budgets", async () => {
    const limits = { global: 5, requester: 2, subject: 2, windowSeconds: 60 } as const;
    const claim = (requesterAddress: string, subject: string) => claimProvisioningAdmission({
      action: "shop_create",
      env,
      limits,
      now: NOW,
      requesterAddress,
      subject,
    });

    await expect(claim("203.0.113.70", "user-a")).resolves.toBeUndefined();
    await expect(claim("203.0.113.70", "user-b")).resolves.toBeUndefined();
    await expect(claim("203.0.113.70", "user-c"))
      .rejects.toMatchObject({ code: "rate_limited", status: 429 });

    await expect(claim("203.0.113.71", "user-a")).resolves.toBeUndefined();
    await expect(claim("203.0.113.72", "user-a"))
      .rejects.toMatchObject({ code: "rate_limited", status: 429 });

    const distributed = await Promise.allSettled([
      claim("203.0.113.73", "user-d"),
      claim("203.0.113.74", "user-e"),
      claim("203.0.113.75", "user-f"),
    ]);
    expect(distributed.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(distributed.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM auth_request_admissions
      WHERE action = 'shop_create' AND window_started_at = '2026-07-26T04:00:00.000Z'
    `).get()).toEqual({ count: 5 });
  });

  it("stores only keyed provisioning identities and fails closed when admission is unavailable", async () => {
    await claimProvisioningAdmission({
      action: "shop_create",
      env,
      limits: { global: 5, requester: 5, subject: 5, windowSeconds: 60 },
      now: NOW,
      requesterAddress: "198.51.100.77",
      subject: "user-sensitive-subject",
    });
    const stored = database.prepare(`
      SELECT requester_hash AS requesterHash, subject_hash AS subjectHash
      FROM auth_request_admissions WHERE action = 'shop_create'
    `).get() as { requesterHash: string; subjectHash: string };
    expect(stored.requesterHash).not.toBe("198.51.100.77");
    expect(stored.subjectHash).not.toBe("user-sensitive-subject");
    expect(JSON.stringify(stored)).not.toContain("198.51.100.77");

    const unavailable = {
      ...env,
      PLATFORM_DB: {
        prepare() {
          throw new Error("database connection contains 198.51.100.88");
        },
      } as unknown as D1Database,
    };
    await expect(claimProvisioningAdmission({
      action: "shop_create",
      env: unavailable,
      limits: { global: 5, requester: 5, subject: 5, windowSeconds: 60 },
      now: NOW,
      requesterAddress: "198.51.100.88",
      subject: "user-a",
    })).rejects.toMatchObject({ code: "provisioning_admission_unavailable", status: 503 });
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
    expect(new URL(link ?? "").pathname).toBe("/login");
    expect(new URL(link ?? "").search).toBe("");
    expect(new URLSearchParams(new URL(link ?? "").hash.slice(1)).get("magic")).toHaveLength(43);
    expect(message.html).toContain("app-staging.selinow.com/login#magic=");
    expect(JSON.stringify(result)).not.toContain(new URLSearchParams(new URL(link ?? "").hash.slice(1)).get("magic") ?? "");
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

  it("redirects legacy GET links into the fragment flow without consuming the token", async () => {
    const requested = await requestMagicLink({
      displayName: "Legacy",
      email: "legacy-link@example.test",
      env,
      requesterAddress: "203.0.113.65",
      now: new Date(),
    });
    const token = tokenFromMagicLink(requested.debugMagicLink, env.DASHBOARD_ORIGIN);

    const response = await consumeMagicLinkRoute({
      locals: { requestId: "request-legacy-fragment" },
      redirect: (location: string, status: number) => new Response(null, { headers: { Location: location }, status }),
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/consume?token=${encodeURIComponent(token)}`),
    } as unknown as Parameters<typeof consumeMagicLinkRoute>[0]);

    expect(response.status).toBe(303);
    const location = response.headers.get("Location") ?? "";
    expect(new URL(location, env.DASHBOARD_ORIGIN).pathname).toBe("/login");
    expect(new URL(location, env.DASHBOARD_ORIGIN).search).toBe("");
    expect(new URLSearchParams(new URL(location, env.DASHBOARD_ORIGIN).hash.slice(1)).get("magic")).toBe(token);
    expect(database.prepare("SELECT consumed_at AS consumedAt FROM magic_link_tokens").get()).toEqual({ consumedAt: null });
  });

  it("consumes a fragment token immediately only with the matching initiation cookie and no existing session", async () => {
    const requested = await requestMagicLink({
      displayName: "Same Browser",
      email: "same-browser@example.test",
      env,
      requesterAddress: "203.0.113.66",
      now: new Date(),
    });
    const token = tokenFromMagicLink(requested.debugMagicLink, env.DASHBOARD_ORIGIN);
    const response = await consumeMagicLinkPostRoute({
      locals: { requestId: "request-same-browser-consume" },
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/consume`, {
        body: JSON.stringify({ token }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `${magicLinkInitiationCookieName(env)}=${requested.initiationBinding}`,
          Origin: env.DASHBOARD_ORIGIN,
        },
        method: "POST",
      }),
    } as unknown as Parameters<typeof consumeMagicLinkPostRoute>[0]);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ authenticated: true, ok: true, redirectTo: "/app" });
    expect(response.headers.get("Set-Cookie")).toContain(`${env.SESSION_COOKIE_NAME}=`);
    expect(database.prepare("SELECT consumed_at IS NOT NULL AS consumed FROM magic_link_tokens").get()).toEqual({ consumed: 1 });
  });

  it("invalidates every older unconsumed link when a replacement is issued", async () => {
    const first = await requestMagicLink({
      displayName: "Replacement",
      email: "replacement@example.test",
      env,
      requesterAddress: "203.0.113.161",
      now: new Date(),
    });
    const replacement = await requestMagicLink({
      displayName: "Replacement",
      email: "replacement@example.test",
      env,
      requesterAddress: "203.0.113.161",
      now: new Date(Date.now() + 1),
    });
    const firstToken = tokenFromMagicLink(first.debugMagicLink, env.DASHBOARD_ORIGIN);
    const replacementToken = tokenFromMagicLink(replacement.debugMagicLink, env.DASHBOARD_ORIGIN);

    await expect(consumeMagicLink({ env, initiationBinding: first.initiationBinding, token: firstToken }))
      .rejects.toMatchObject({ code: "authentication_required", status: 401 });
    expect(database.prepare(`
      SELECT consumed_at AS consumedAt, expires_at <= ? AS expired
      FROM magic_link_tokens WHERE token_hash = ?
    `).get(new Date().toISOString(), await hmacToken(env.MAGIC_LINK_SECRET, "magic-link", firstToken)))
      .toEqual({ consumedAt: null, expired: 1 });
    await expect(consumeMagicLink({ env, initiationBinding: replacement.initiationBinding, token: replacementToken }))
      .resolves.toMatchObject({ auth: { email: "replacement@example.test" } });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM magic_link_tokens
      WHERE user_id = (SELECT id FROM platform_users WHERE email_normalized = 'replacement@example.test')
        AND consumed_at IS NULL AND expires_at > ?
    `).get(new Date().toISOString())).toEqual({ count: 0 });
  });

  it("leaves exactly one usable link after concurrent replacement requests", async () => {
    const issuedAt = new Date();
    const messages: Array<{ text?: string } | undefined> = [];
    const controlledDeliveries = Array.from({ length: 4 }, (_, index) => {
      let markSendStarted = (): void => {};
      let releaseDelivery = (): void => {};
      const sendStarted = new Promise<void>((resolve) => { markSendStarted = resolve; });
      const deliveryReleased = new Promise<void>((resolve) => { releaseDelivery = resolve; });
      const requestEnv = bindings(database, {
        APP_ENV: "staging",
        EMAIL: {
          send(message) {
            messages[index] = message as { text?: string };
            markSendStarted();
            return deliveryReleased.then(() => ({ messageId: `message-${String(index)}` }));
          },
        },
      });
      return { releaseDelivery, requestEnv, sendStarted };
    });
    const requestPromises = controlledDeliveries.map(({ requestEnv }) => requestMagicLink({
      displayName: "Concurrent Replacement",
      email: "concurrent-replacement@example.test",
      env: requestEnv,
      requesterAddress: "203.0.113.162",
      now: issuedAt,
    }));
    await Promise.all(controlledDeliveries.map(({ sendStarted }) => sendStarted));

    const completionOrder = [2, 0, 1, 3] as const;
    for (const index of completionOrder) {
      const delivery = controlledDeliveries[index];
      const request = requestPromises[index];
      if (delivery === undefined || request === undefined) throw new Error("concurrent_replacement_fixture_missing");
      delivery.releaseDelivery();
      await request;
    }
    const requests = await Promise.all(requestPromises);
    const usableRows = database.prepare(`
      SELECT id, created_at AS createdAt, expires_at AS expiresAt FROM magic_link_tokens
      WHERE user_id = (SELECT id FROM platform_users WHERE email_normalized = 'concurrent-replacement@example.test')
        AND consumed_at IS NULL AND expires_at > ?
      ORDER BY created_at, id
    `).all(new Date().toISOString());
    expect(usableRows).toHaveLength(1);

    const tokens = messages.map((message) => {
      const link = message?.text?.split("\n").find((line) => line.startsWith(env.DASHBOARD_ORIGIN));
      return tokenFromMagicLink(link, env.DASHBOARD_ORIGIN);
    });
    const lastRequest = requests[3];
    const lastToken = tokens[3];
    if (lastRequest === undefined || lastToken === undefined) throw new Error("concurrent_replacement_winner_missing");
    await expect(consumeMagicLink({
      env,
      initiationBinding: lastRequest.initiationBinding,
      token: lastToken,
    })).resolves.toMatchObject({ auth: { email: "concurrent-replacement@example.test" } });
    const superseded = await Promise.allSettled([0, 1, 2].map((index) => {
      const request = requests[index];
      const token = tokens[index];
      if (request === undefined || token === undefined) throw new Error("concurrent_replacement_token_missing");
      return consumeMagicLink({
        env,
        initiationBinding: request.initiationBinding,
        token,
      });
    }));
    expect(superseded.filter((result) => result.status === "rejected")).toHaveLength(3);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });
  });

  it("keeps the current link usable when replacement delivery fails", async () => {
    const current = await requestMagicLink({
      displayName: "Delivery Recovery",
      email: "delivery-recovery@example.test",
      env,
      requesterAddress: "203.0.113.163",
      now: new Date(),
    });
    const currentToken = tokenFromMagicLink(current.debugMagicLink, env.DASHBOARD_ORIGIN);
    env = bindings(database, {
      APP_ENV: "staging",
      EMAIL: { send: () => Promise.reject(new Error("delivery unavailable")) },
    });
    routeDependencies.env = env;

    await expect(requestMagicLink({
      displayName: "Delivery Recovery",
      email: "delivery-recovery@example.test",
      env,
      requesterAddress: "203.0.113.163",
      now: new Date(),
    })).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    await expect(consumeMagicLink({ env, initiationBinding: current.initiationBinding, token: currentToken }))
      .resolves.toMatchObject({ auth: { email: "delivery-recovery@example.test" } });
  });

  it("requires an explicit short-lived confirmation for cross-browser consumption and rejects replay", async () => {
    const requested = await requestMagicLink({
      displayName: "Cross Browser",
      email: "cross-browser@example.test",
      env,
      requesterAddress: "203.0.113.67",
      now: new Date(),
    });
    const token = tokenFromMagicLink(requested.debugMagicLink, env.DASHBOARD_ORIGIN);
    const post = (confirm: boolean, cookie?: string) => consumeMagicLinkPostRoute({
      locals: { requestId: "request-cross-browser-consume" },
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/consume`, {
        body: JSON.stringify({ confirm, token }),
        headers: {
          "Content-Type": "application/json",
          ...(cookie === undefined ? {} : { Cookie: cookie }),
          Origin: env.DASHBOARD_ORIGIN,
        },
        method: "POST",
      }),
    } as unknown as Parameters<typeof consumeMagicLinkPostRoute>[0]);

    const confirmation = await post(false);
    expect(confirmation.status).toBe(202);
    const confirmationBody: Record<string, unknown> = await confirmation.json();
    expect(confirmationBody).toMatchObject({ confirmationRequired: true, ok: true });
    expect(confirmationBody.maskedDestination).toMatch(/^c\*+@e\*+\.test$/u);
    expect(JSON.stringify(confirmationBody)).not.toContain("cross-browser@example.test");
    expect(database.prepare("SELECT consumed_at AS consumedAt FROM magic_link_tokens").get()).toEqual({ consumedAt: null });
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 0 });

    const confirmationCookieName = magicLinkConfirmationCookieName(env);
    const confirmationCookie = cookieValue(confirmation.headers.get("Set-Cookie"), confirmationCookieName);
    expect(confirmationCookie.length).toBeGreaterThan(40);
    const expiredAt = 1_000_000_000;
    const expiredSignature = await hmacToken(
      env.MAGIC_LINK_SECRET,
      "magic-link-confirmation",
      `${String(expiredAt)}:${token}`,
    );
    const expiredConfirmation = await post(true, `${confirmationCookieName}=${String(expiredAt)}.${expiredSignature}`);
    expect(expiredConfirmation.status).toBe(401);
    expect(database.prepare("SELECT consumed_at AS consumedAt FROM magic_link_tokens").get()).toEqual({ consumedAt: null });

    const consumed = await post(true, `${confirmationCookieName}=${confirmationCookie}`);
    expect(consumed.status).toBe(200);
    expect(consumed.headers.get("Set-Cookie")).toContain(`${env.SESSION_COOKIE_NAME}=`);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });

    const replay = await post(true, `${confirmationCookieName}=${confirmationCookie}`);
    expect(replay.status).toBe(401);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });
  });

  it("never replaces an existing session without explicit confirmation", async () => {
    const existingLink = await requestMagicLink({
      displayName: "Existing",
      email: "existing-session@example.test",
      env,
      requesterAddress: "203.0.113.68",
      now: new Date(),
    });
    const existing = await consumeMagicLink({
      env,
      initiationBinding: existingLink.initiationBinding,
      token: tokenFromMagicLink(existingLink.debugMagicLink, env.DASHBOARD_ORIGIN),
    });
    const replacementLink = await requestMagicLink({
      displayName: "Replacement",
      email: "replacement-session@example.test",
      env,
      requesterAddress: "203.0.113.68",
      now: new Date(),
    });
    const replacementToken = tokenFromMagicLink(replacementLink.debugMagicLink, env.DASHBOARD_ORIGIN);
    const firstResponse = await consumeMagicLinkPostRoute({
      locals: { requestId: "request-existing-session-confirm" },
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/consume`, {
        body: JSON.stringify({ token: replacementToken }),
        headers: {
          "Content-Type": "application/json",
          Cookie: [
            `${env.SESSION_COOKIE_NAME}=${existing.credentials.sessionToken}`,
            `${magicLinkInitiationCookieName(env)}=${replacementLink.initiationBinding}`,
          ].join("; "),
          Origin: env.DASHBOARD_ORIGIN,
        },
        method: "POST",
      }),
    } as unknown as Parameters<typeof consumeMagicLinkPostRoute>[0]);

    expect(firstResponse.status).toBe(202);
    await expect(firstResponse.json()).resolves.toMatchObject({ confirmationRequired: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT consumed_at AS consumedAt FROM magic_link_tokens WHERE token_hash = ?")
      .get(await hmacToken(env.MAGIC_LINK_SECRET, "magic-link", replacementToken))).toEqual({ consumedAt: null });

    const confirmationCookieName = magicLinkConfirmationCookieName(env);
    const confirmationCookie = cookieValue(firstResponse.headers.get("Set-Cookie"), confirmationCookieName);
    const confirmedResponse = await consumeMagicLinkPostRoute({
      locals: { requestId: "request-existing-session-confirmed" },
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/consume`, {
        body: JSON.stringify({ confirm: true, token: replacementToken }),
        headers: {
          "Content-Type": "application/json",
          Cookie: [
            `${env.SESSION_COOKIE_NAME}=${existing.credentials.sessionToken}`,
            `${confirmationCookieName}=${confirmationCookie}`,
          ].join("; "),
          Origin: env.DASHBOARD_ORIGIN,
        },
        method: "POST",
      }),
    } as unknown as Parameters<typeof consumeMagicLinkPostRoute>[0]);
    expect(confirmedResponse.status).toBe(200);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 2 });
  });

  it("rejects login CSRF and expired fragment tokens before session creation", async () => {
    const requested = await requestMagicLink({
      displayName: "Expired",
      email: "expired-fragment@example.test",
      env,
      requesterAddress: "203.0.113.69",
      now: new Date(),
    });
    const token = tokenFromMagicLink(requested.debugMagicLink, env.DASHBOARD_ORIGIN);
    const routeContext = (origin: string) => ({
      locals: { requestId: "request-fragment-security" },
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/consume`, {
        body: JSON.stringify({ token }),
        headers: { "Content-Type": "application/json", Origin: origin },
        method: "POST",
      }),
    } as unknown as Parameters<typeof consumeMagicLinkPostRoute>[0]);

    const csrfResponse = await consumeMagicLinkPostRoute(routeContext("https://evil.example.test"));
    expect(csrfResponse.status).toBe(403);
    expect(database.prepare("SELECT consumed_at AS consumedAt FROM magic_link_tokens").get()).toEqual({ consumedAt: null });

    database.prepare("UPDATE magic_link_tokens SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const expiredResponse = await consumeMagicLinkPostRoute(routeContext(env.DASHBOARD_ORIGIN));
    expect(expiredResponse.status).toBe(401);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 0 });
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
    const victimToken = tokenFromMagicLink(victimRequest.debugMagicLink, env.DASHBOARD_ORIGIN);
    const attackerToken = tokenFromMagicLink(attackerRequest.debugMagicLink, env.DASHBOARD_ORIGIN);

    const victimSession = await consumeMagicLink({
      env,
      initiationBinding: victimRequest.initiationBinding,
      token: victimToken,
    });
    expect(victimSession.auth.email).toBe("victim@example.test");
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });

    const forcedLoginResponse = await consumeMagicLinkPostRoute({
      locals: { requestId: "request-forced-login" },
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/consume`, {
        body: JSON.stringify({ token: attackerToken }),
        headers: {
          "Content-Type": "application/json",
          Cookie: [
            `${env.SESSION_COOKIE_NAME}=${victimSession.credentials.sessionToken}`,
            `${magicLinkInitiationCookieName(env)}=${victimRequest.initiationBinding}`,
          ].join("; "),
          Origin: env.DASHBOARD_ORIGIN,
        },
        method: "POST",
      }),
    } as unknown as Parameters<typeof consumeMagicLinkPostRoute>[0]);
    expect(forcedLoginResponse.status).toBe(202);
    await expect(forcedLoginResponse.json()).resolves.toMatchObject({ confirmationRequired: true });
    expect(forcedLoginResponse.headers.get("Set-Cookie")).toContain(`${magicLinkConfirmationCookieName(env)}=`);
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 1 });

    const legitimateResponse = await consumeMagicLinkPostRoute({
      locals: { requestId: "request-legitimate-login" },
      request: new Request(`${env.DASHBOARD_ORIGIN}/api/auth/magic-link/consume`, {
        body: JSON.stringify({ token: attackerToken }),
        headers: {
          "Content-Type": "application/json",
          Cookie: `${magicLinkInitiationCookieName(env)}=${attackerRequest.initiationBinding}`,
          Origin: env.DASHBOARD_ORIGIN,
        },
        method: "POST",
      }),
    } as unknown as Parameters<typeof consumeMagicLinkPostRoute>[0]);
    expect(legitimateResponse.status).toBe(200);
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
    const firstSession = await consumeMagicLink({
      env,
      initiationBinding: firstLink.initiationBinding,
      token: tokenFromMagicLink(firstLink.debugMagicLink, env.DASHBOARD_ORIGIN),
    });
    const secondLink = await requestMagicLink({
      displayName: "Seller",
      email: "sessions@example.test",
      env,
      requesterAddress: "203.0.113.80",
      now: new Date(now.getTime() + 1),
    });
    const current = await consumeMagicLink({
      env,
      initiationBinding: secondLink.initiationBinding,
      token: tokenFromMagicLink(secondLink.debugMagicLink, env.DASHBOARD_ORIGIN),
    });
    const auth = { ...current.auth, csrfTokenHash: "test-csrf-hash" };

    const sessions = await listSessions(auth, env);
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((session) => session.isCurrent)).toHaveLength(1);
    expect(sessions.some((session) => session.sessionId === firstSession.auth.sessionId)).toBe(true);
    expect(sessions.every((session) => !Object.hasOwn(session, "tokenHash"))).toBe(true);

    expect(await revokeAllSessions(auth, env)).toBe(2);
    expect(await listSessions(auth, env)).toEqual([]);
  });

  it("denies every pre-bootstrap session and accepts only a fresh post-bootstrap login", async () => {
    const now = new Date();
    const requested = await requestMagicLink({
      displayName: "Platform Owner",
      email: "platform-owner@example.test",
      env,
      requesterAddress: "203.0.113.82",
      now,
    });
    const priorSession = await consumeMagicLink({
      env,
      initiationBinding: requested.initiationBinding,
      token: tokenFromMagicLink(requested.debugMagicLink, env.DASHBOARD_ORIGIN),
    });
    database.exec(buildPlatformAdminBootstrapSql({
      requestId: "platform-admin-bootstrap-session-revocation",
      userEmail: priorSession.auth.email,
      userId: priorSession.auth.userId,
    }));

    const priorRequest = new Request(`${env.DASHBOARD_ORIGIN}/admin`, {
      headers: { Cookie: `${env.SESSION_COOKIE_NAME}=${priorSession.credentials.sessionToken}` },
    });
    await expect(authenticateRequest(priorRequest, env))
      .rejects.toMatchObject({ code: "authentication_required", status: 401 });

    const freshRequested = await requestMagicLink({
      displayName: "Platform Owner",
      email: "platform-owner@example.test",
      env,
      requesterAddress: "203.0.113.82",
      now: new Date(now.getTime() + 1_000),
    });
    const freshSession = await consumeMagicLink({
      env,
      initiationBinding: freshRequested.initiationBinding,
      token: tokenFromMagicLink(freshRequested.debugMagicLink, env.DASHBOARD_ORIGIN),
    });
    const bootstrap = database.prepare(`
      SELECT created_at AS createdAt
      FROM platform_admins
      WHERE user_id = ? AND role = 'owner' AND status = 'active'
    `).get(priorSession.auth.userId) as { createdAt: string };
    const postBootstrapAuthenticatedAt = new Date(Date.parse(bootstrap.createdAt) + 1).toISOString();
    database.prepare(`
      UPDATE auth_sessions
      SET authenticated_at = ?, created_at = ?, last_seen_at = ?
      WHERE id = ?
    `).run(
      postBootstrapAuthenticatedAt,
      postBootstrapAuthenticatedAt,
      postBootstrapAuthenticatedAt,
      freshSession.auth.sessionId,
    );
    const freshRequest = new Request(`${env.DASHBOARD_ORIGIN}/admin`, {
      headers: { Cookie: `${env.SESSION_COOKIE_NAME}=${freshSession.credentials.sessionToken}` },
    });
    await expect(authenticateRequest(freshRequest, env))
      .resolves.toMatchObject({ sessionId: freshSession.auth.sessionId });
    database.exec(buildPlatformAdminBootstrapSql({
      requestId: "platform-admin-bootstrap-session-revocation-retry",
      userEmail: priorSession.auth.email,
      userId: priorSession.auth.userId,
    }));
    await expect(authenticateRequest(freshRequest, env))
      .resolves.toMatchObject({ sessionId: freshSession.auth.sessionId });
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
    const magicToken = tokenFromMagicLink(requested.debugMagicLink, env.DASHBOARD_ORIGIN);
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
