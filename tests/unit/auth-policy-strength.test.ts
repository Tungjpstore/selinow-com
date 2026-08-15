import { describe, expect, it } from "vitest";

import { normalizeOtp, validatePasswordStrength } from "../../src/lib/auth/policy";

describe("auth policy: password strength & OTP validation", () => {
  it("accepts strong passwords meeting all complexity criteria", () => {
    expect(() => validatePasswordStrength("StrongP@ssw0rd!")).not.toThrow();
    expect(() => validatePasswordStrength("Secure#2026Selinow")).not.toThrow();
    expect(() => validatePasswordStrength("Abcdef1!")).not.toThrow();
  });

  it("rejects passwords shorter than 8 characters", () => {
    expect(() => validatePasswordStrength("Sh0rt!")).toThrow();
  });

  it("rejects common weak passwords regardless of length", () => {
    expect(() => validatePasswordStrength("password123")).toThrow();
    expect(() => validatePasswordStrength("12345678")).toThrow();
    expect(() => validatePasswordStrength("admin123")).toThrow();
  });

  it("rejects passwords lacking complexity (e.g. only lowercase letters)", () => {
    expect(() => validatePasswordStrength("onlylowercasewords")).toThrow();
    expect(() => validatePasswordStrength("1234567890123")).toThrow();
  });

  it("validates and normalizes 6-digit OTP codes", () => {
    expect(normalizeOtp("123456")).toBe("123456");
    expect(normalizeOtp(" 654 321 ")).toBe("654321");
    expect(normalizeOtp("000123")).toBe("000123");
  });

  it("rejects invalid OTP formats", () => {
    expect(() => normalizeOtp("12345")).toThrow();
    expect(() => normalizeOtp("1234567")).toThrow();
    expect(() => normalizeOtp("abcdef")).toThrow();
    expect(() => normalizeOtp("12a456")).toThrow();
    expect(() => normalizeOtp(null)).toThrow();
  });

});
