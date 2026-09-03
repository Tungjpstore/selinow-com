import { beforeEach, describe, expect, it, vi } from "vitest";

import { createAndSendOtp, verifyOtp } from "../../src/lib/auth/otp";
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

describe("auth OTP lifecycle service", () => {
  const secret = "test-session-secret-entropy-123456789";
  let mockDatabase: Map<string, MockOtpRow>;
  let env: AppBindings;

  beforeEach(() => {
    mockDatabase = new Map();

    const makeStatement = (query: string, boundArgs: readonly unknown[] = []) => ({
      all: () => Promise.resolve({ results: [] }),
      bind: (...args: readonly unknown[]) => makeStatement(query, args),
      first: <T>() => {
        if (query.includes("SELECT created_at FROM auth_email_otps")) {
          const [email, purpose] = boundArgs as [string, string];
          const rows = Array.from(mockDatabase.values())
            .filter((r) => r.email_normalized === email && r.purpose === purpose)
            .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
          return Promise.resolve((rows[0] ?? null) as T);
        }
        if (query.includes("SELECT id, user_id, otp_hash")) {
          const [email, purpose, nowIso] = boundArgs as [string, string, string];
          const rows = Array.from(mockDatabase.values())
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
            string,
            string,
            string,
          ];
          mockDatabase.set(id, {
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
        if (query.includes("SET attempts_count = ?, consumed_at = ?")) {
          const [attempts, consumedAt, id, expectedAttempts] = boundArgs as [number, string, string, number];
          const existing = mockDatabase.get(id);
          if (existing && existing.attempts_count === expectedAttempts && existing.consumed_at === null) {
            existing.attempts_count = attempts;
            existing.consumed_at = consumedAt;
          }
          return Promise.resolve({ meta: { changes: existing && existing.attempts_count === attempts ? 1 : 0 } });
        }
        if (query.includes("SET attempts_count = ?")) {
          const [attempts, id, expectedAttempts] = boundArgs as [number, string, number];
          const existing = mockDatabase.get(id);
          if (existing && existing.attempts_count === expectedAttempts && existing.consumed_at === null) {
            existing.attempts_count = attempts;
          }
          return Promise.resolve({ meta: { changes: existing && existing.attempts_count === attempts ? 1 : 0 } });
        }
        if (query.includes("SET consumed_at = ?")) {
          const [consumedAt, id] = boundArgs as [string, string];
          const existing = mockDatabase.get(id);
          if (existing) {
            existing.consumed_at = consumedAt;
          }
          return Promise.resolve({ meta: { changes: 1 } });
        }
        if (query.includes("SET expires_at = ?")) {
          const [expiresAt, email, purpose, , excludedId] = boundArgs as [string, string, string, string, string];
          for (const row of mockDatabase.values()) {
            if (row.id !== excludedId && row.email_normalized === email && row.purpose === purpose && !row.consumed_at) {
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
      PLATFORM_DB: {
        batch: vi.fn(async (statements: readonly { run: () => Promise<{ meta: { changes: number } }> }[]) => {
          const results = [];
          for (const s of statements) {
            results.push(await s.run());
          }
          return results;
        }),
        prepare: vi.fn((query: string) => makeStatement(query)),
      },
      SESSION_SECRET: secret,
    } as unknown as AppBindings;
  });

  it("creates and sends an OTP, returning debug OTP in local mode", async () => {
    const result = await createAndSendOtp({
      email: "seller@selinow.com",
      env,
      purpose: "register_verify",
      userId: "usr_123",
    });

    expect(result.cooldownSeconds).toBe(60);
    expect(result.debugOtp).toBeDefined();
    expect(result.debugOtp).toHaveLength(6);
    expect(mockDatabase.size).toBe(1);
  });

  it("enforces cooldown when requesting OTP too quickly", async () => {
    const now = new Date("2026-08-15T12:00:00.000Z");
    await createAndSendOtp({
      email: "seller@selinow.com",
      env,
      now,
      purpose: "register_verify",
      userId: "usr_123",
    });

    const tooSoon = new Date("2026-08-15T12:00:30.000Z"); // only 30s later
    await expect(
      createAndSendOtp({
        email: "seller@selinow.com",
        env,
        now: tooSoon,
        purpose: "register_verify",
        userId: "usr_123",
      }),
    ).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  });

  it("verifies valid OTP successfully and marks it consumed", async () => {
    const result = await createAndSendOtp({
      email: "seller@selinow.com",
      env,
      purpose: "register_verify",
      userId: "usr_123",
    });

    const otpCode = result.debugOtp ?? "";
    const verifyResult = await verifyOtp({
      email: "seller@selinow.com",
      env,
      otp: otpCode,
      purpose: "register_verify",
    });

    expect(verifyResult.email).toBe("seller@selinow.com");
    expect(verifyResult.userId).toBe("usr_123");

    // Cannot verify again (consumed)
    await expect(
      verifyOtp({
        email: "seller@selinow.com",
        env,
        otp: otpCode,
        purpose: "register_verify",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("tracks incorrect attempts and burns OTP after reaching max attempts", async () => {
    const result = await createAndSendOtp({
      email: "seller@selinow.com",
      env,
      purpose: "password_reset",
      userId: "usr_123",
    });

    // 4 wrong attempts
    for (let i = 1; i <= 4; i += 1) {
      await expect(
        verifyOtp({
          email: "seller@selinow.com",
          env,
          otp: "000000",
          purpose: "password_reset",
        }),
      ).rejects.toMatchObject({ code: "validation_failed" });
    }

    // 5th wrong attempt -> max attempts exceeded and burned
    await expect(
      verifyOtp({
        email: "seller@selinow.com",
        env,
        otp: "000000",
        purpose: "password_reset",
      }),
    ).rejects.toMatchObject({
      code: "validation_failed",
      issues: ["otp_max_attempts_exceeded"],
    });

    // Even if user now tries correct code, it's already burned
    await expect(
      verifyOtp({
        email: "seller@selinow.com",
        env,
        otp: result.debugOtp ?? "",
        purpose: "password_reset",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });
});
