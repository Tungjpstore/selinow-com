import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { completeTwoFactorLogin, loginWithPassword } from "../../src/lib/auth/session";
import type { AppBindings } from "../../src/lib/platform/bindings";

type MockOtpRow = {
  attempts_count: number;
  consumed_at: string | null;
  created_at: string;
  email_normalized: string;
  expires_at: string;
  id: string;
  max_attempts: number;
  otp_hash: string;
  purpose: string;
  user_id: string | null;
};

type UserAccountRow = {
  displayName: string;
  emailNormalized: string;
  failedLoginCount: number;
  lockedUntil: string | null;
  passwordHash: string;
  status: string;
  twoFactorEnabled: number;
  userId: string;
};

const EMAIL = "seller@selinow.com";
const USER_ID = "usr-2fa-login";
const SESSION_SECRET = "test-session-secret-entropy-123456789";

describe("auth two-factor login flow", () => {
  let otpDatabase: Map<string, MockOtpRow>;
  let history: Array<{ outcome: string; requesterHash: string; userId: string }>;
  let insertedSessions: string[];
  let user: UserAccountRow;
  let env: AppBindings;
  let password: string;

  function makeFixture() {
    const makeStatement = (query: string, boundArgs: readonly unknown[] = []) => ({
      all: () => Promise.resolve({ results: [] }),
      bind: (...args: readonly unknown[]) => makeStatement(query, args),
      first: <T>() => {
        if (query.includes("INSERT INTO auth_sessions")) {
          const [sessionId] = boundArgs as [string];
          insertedSessions.push(sessionId);
          return Promise.resolve({ id: sessionId } as T);
        }
        if (query.includes("FROM platform_users") && query.includes("email_normalized = ?")) {
          return Promise.resolve({ ...user } as T);
        }
        if (query.includes("FROM platform_users") && query.includes("WHERE id = ?")) {
          return Promise.resolve({ ...user } as T);
        }
        if (query.includes("SELECT created_at FROM auth_email_otps")) {
          const [email, purpose] = boundArgs as [string, string];
          const rows = Array.from(otpDatabase.values())
            .filter((r) => r.email_normalized === email && r.purpose === purpose)
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
          return Promise.resolve((rows[0] ?? null) as T);
        }
        if (query.includes("SELECT id, user_id, otp_hash")) {
          const [email, purpose, nowIso] = boundArgs as [string, string, string];
          const rows = Array.from(otpDatabase.values())
            .filter(
              (r) =>
                r.email_normalized === email &&
                r.purpose === purpose &&
                r.consumed_at === null &&
                r.expires_at > nowIso,
            )
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
          return Promise.resolve((rows[0] ?? null) as T);
        }
        return Promise.resolve(null as T);
      },
      run: () => {
        if (query.includes("INSERT INTO auth_email_otps")) {
          const [id, user_id, email_normalized, purpose, otp_hash, max_attempts, expires_at, created_at] = boundArgs as [
            string,
            string | null,
            string,
            string,
            string,
            number,
            string,
            string,
          ];
          otpDatabase.set(id, {
            attempts_count: 0,
            consumed_at: null,
            created_at,
            email_normalized,
            expires_at,
            id,
            max_attempts,
            otp_hash,
            purpose,
            user_id,
          });
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (query.includes("INSERT INTO auth_login_history")) {
          const [, userId, outcome, requesterHash] = boundArgs as [string, string, string, string];
          history.push({ outcome, requesterHash, userId });
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (query.includes("SET attempts_count = ?, consumed_at = ?")) {
          const [attempts, consumedAt, id] = boundArgs as [number, string, string];
          const existing = otpDatabase.get(id);
          if (existing) {
            existing.attempts_count = attempts;
            existing.consumed_at = consumedAt;
          }
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (query.includes("SET attempts_count = ?")) {
          const [attempts, id] = boundArgs as [number, string];
          const existing = otpDatabase.get(id);
          if (existing) existing.attempts_count = attempts;
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (query.includes("SET consumed_at = ?")) {
          const [consumedAt, id] = boundArgs as [string, string];
          const existing = otpDatabase.get(id);
          if (existing) existing.consumed_at = consumedAt;
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (query.includes("SET expires_at = ?") && query.includes("auth_email_otps")) {
          const [expiresAt, email, purpose] = boundArgs as [string, string, string];
          for (const row of otpDatabase.values()) {
            if (row.email_normalized === email && row.purpose === purpose && !row.consumed_at) {
              row.expires_at = expiresAt;
            }
          }
          return Promise.resolve({ meta: { changes: 1 } });
        }
        return Promise.resolve({ meta: { changes: 0 } });
      },
    });

    env = {
      APP_ENV: "local",
      EMAIL: { send: vi.fn().mockResolvedValue(undefined) },
      EMAIL_FROM_ADDRESS: "noreply@selinow.com",
      EMAIL_FROM_NAME: "Selinow Security",
      IDENTIFIER_HMAC_SECRET: "test-identifier-hmac-secret",
      PLATFORM_DB: {
        batch: vi.fn(async (statements: readonly { run: () => Promise<{ meta: { changes: number } }> }[]) => {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          return results;
        }),
        prepare: vi.fn((query: string) => makeStatement(query)),
      },
      SESSION_SECRET,
    } as unknown as AppBindings;
  }

  beforeEach(async () => {
    otpDatabase = new Map();
    history = [];
    insertedSessions = [];
    password = "CorrectHorse456!";
    const { hashPassword } = await import("../../src/lib/core/crypto");
    user = {
      displayName: "Seller",
      emailNormalized: EMAIL,
      failedLoginCount: 0,
      lockedUntil: null,
      passwordHash: await hashPassword(password),
      status: "active",
      twoFactorEnabled: 1,
      userId: USER_ID,
    };
    makeFixture();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a challenge instead of a session when two-factor is enabled", async () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    const result = await loginWithPassword({ email: EMAIL, env, now, password, requesterAddress: "203.0.113.9" });

    expect(result).toMatchObject({ cooldownSeconds: 60, twoFactorRequired: true });
    expect("auth" in result).toBe(false);
    if ("challengeToken" in result) {
      expect(result.challengeToken.length).toBeGreaterThanOrEqual(10);
      expect(result.expiresAt).toBeTruthy();
    }
    expect(insertedSessions).toHaveLength(0);
    expect(history.map((entry) => entry.outcome)).toEqual(["two_factor_required"]);
    // The OTP is only visible in local mode; it must never appear in the result.
    expect(JSON.stringify(result)).not.toMatch(/"otp"/u);
  });

  it("keeps the OTP cooldown between challenge requests", async () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    await loginWithPassword({ email: EMAIL, env, now, password });

    await expect(loginWithPassword({
      email: EMAIL,
      env,
      now: new Date("2026-08-15T12:00:30.000Z"),
      password,
    })).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  });

  it("issues a session after the correct OTP and records a success outcome", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-08-15T12:00:00.000Z");
    vi.setSystemTime(start);

    const challenge = await loginWithPassword({ email: EMAIL, env, now: start, password });
    expect("challengeToken" in challenge).toBe(true);
    if (!("challengeToken" in challenge)) return;

    const otpRow = Array.from(otpDatabase.values()).find((row) => row.purpose === "login_2fa");
    expect(otpRow).toBeDefined();

    // The real OTP travels by email; extract it via the local debug surface.
    const debugOtp = await extractDebugOtp(env, EMAIL, start);
    const result = await completeTwoFactorLogin({
      challengeToken: challenge.challengeToken,
      env,
      now: new Date("2026-08-15T12:02:00.000Z"),
      otp: debugOtp,
      requesterAddress: "203.0.113.9",
    });

    expect(result.auth.userId).toBe(USER_ID);
    expect(result.credentials.sessionToken.length).toBeGreaterThan(20);
    expect(insertedSessions).toHaveLength(1);
    expect(history.map((entry) => entry.outcome)).toContain("success");
  });

  it("burns the OTP after five wrong attempts and records every failure", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-08-15T12:00:00.000Z");
    vi.setSystemTime(start);

    const challenge = await loginWithPassword({ email: EMAIL, env, now: start, password });
    if (!("challengeToken" in challenge)) throw new Error("expected challenge");
    const debugOtp = await extractDebugOtp(env, EMAIL, start);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(completeTwoFactorLogin({
        challengeToken: challenge.challengeToken,
        env,
        now: start,
        otp: "000000",
      })).rejects.toMatchObject({ code: "validation_failed" });
    }

    await expect(completeTwoFactorLogin({
      challengeToken: challenge.challengeToken,
      env,
      now: start,
      otp: "000000",
    })).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["otp_max_attempts_exceeded"],
    });

    // Even the correct code is useless once the OTP is burned.
    await expect(completeTwoFactorLogin({
      challengeToken: challenge.challengeToken,
      env,
      now: start,
      otp: debugOtp,
    })).rejects.toMatchObject({ code: "validation_failed" });

    expect(insertedSessions).toHaveLength(0);
    expect(history.filter((entry) => entry.outcome === "two_factor_failed")).toHaveLength(6);
  });

  it("rejects tampered or malformed challenge tokens without verifying any OTP", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-08-15T12:00:00.000Z");
    vi.setSystemTime(start);

    const challenge = await loginWithPassword({ email: EMAIL, env, now: start, password });
    if (!("challengeToken" in challenge)) throw new Error("expected challenge");
    const [, signature] = challenge.challengeToken.split(".");

    const tamperedPayload = btoa(`${EMAIL}:${String(start.getTime() + 600_000)}:usr-attacker:1`);
    await expect(completeTwoFactorLogin({
      challengeToken: `${tamperedPayload}.${signature ?? ""}`,
      env,
      now: start,
      otp: "123456",
    })).rejects.toMatchObject({ code: "authentication_required", status: 401 });

    await expect(completeTwoFactorLogin({
      challengeToken: "garbage-token",
      env,
      now: start,
      otp: "123456",
    })).rejects.toMatchObject({ code: "authentication_required", status: 401 });

    expect(insertedSessions).toHaveLength(0);
  });

  it("rejects an expired challenge even with the correct OTP", async () => {
    vi.useFakeTimers();
    const start = new Date("2026-08-15T12:00:00.000Z");
    vi.setSystemTime(start);

    const challenge = await loginWithPassword({ email: EMAIL, env, now: start, password });
    if (!("challengeToken" in challenge)) throw new Error("expected challenge");
    const debugOtp = await extractDebugOtp(env, EMAIL, start);

    const afterExpiry = new Date(start.getTime() + 11 * 60_000);
    vi.setSystemTime(afterExpiry);

    await expect(completeTwoFactorLogin({
      challengeToken: challenge.challengeToken,
      env,
      now: afterExpiry,
      otp: debugOtp,
    })).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["two_factor_challenge_expired"],
    });
    expect(insertedSessions).toHaveLength(0);
  });
});

/**
 * createAndSendOtp returns the plaintext OTP only to its caller in local mode,
 * and loginWithPassword never exposes it. In production the code travels by
 * email; in tests we recreate that channel by requesting a fresh OTP through
 * the same purpose after the 60s cooldown.
 */
async function extractDebugOtp(env: AppBindings, email: string, now: Date): Promise<string> {
  const { createAndSendOtp } = await import("../../src/lib/auth/otp");
  const resendAt = new Date(now.getTime() + 61_000);
  const result = await createAndSendOtp({ email, env, now: resendAt, purpose: "login_2fa" });
  return result.debugOtp ?? "";
}
