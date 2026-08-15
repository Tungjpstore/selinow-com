import { describe, expect, it } from "vitest";

import {
  constantTimeEqual,
  dummyVerifyPassword,
  generateSecureOtp,
  hashOtp,
  hashPassword,
  verifyPassword,
} from "../../src/lib/core/crypto";

describe("crypto: password hashing & secure OTP generation", () => {
  it("generates 6-digit numeric OTP with CSPRNG", () => {
    for (let i = 0; i < 50; i += 1) {
      const otp = generateSecureOtp(6);
      expect(otp).toHaveLength(6);
      expect(/^\d{6}$/.test(otp)).toBe(true);
    }
  });

  it("hashes password with PBKDF2 salt and correctly verifies matching password", async () => {
    const password = "SuperSecretPassword#2026";
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^pbkdf2:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword("WrongPassword123!", hash)).resolves.toBe(false);
  });

  it("produces deterministic HMAC hash for identical OTP inputs bound to email and purpose", async () => {
    const secret = "test-session-secret-key-12345";
    const hash1 = await hashOtp(secret, "register_verify", "user@example.test", "123456");
    const hash2 = await hashOtp(secret, "register_verify", "user@example.test", "123456");
    const hash3 = await hashOtp(secret, "password_reset", "user@example.test", "123456");
    const hash4 = await hashOtp(secret, "register_verify", "other@example.test", "123456");

    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).not.toBe(hash4);
  });

  it("executes dummyVerifyPassword safely without throwing", async () => {
    await expect(dummyVerifyPassword("AnyCandidatePassword")).resolves.toBe(false);
  });

  it("performs constant time string comparison correctly", () => {
    expect(constantTimeEqual("abc123xyz", "abc123xyz")).toBe(true);
    expect(constantTimeEqual("abc123xyz", "abc123xyw")).toBe(false);
    expect(constantTimeEqual("short", "longer_string")).toBe(false);
  });
});
