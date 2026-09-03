import { describe, expect, it } from "vitest";

import {
  shouldEnforceHttps,
  toHttpsRedirect,
} from "../../src/lib/http/https";

describe("universal HTTPS redirect (BUG-001)", () => {
  it("redirects every plaintext platform and tenant host to the equivalent HTTPS URL", () => {
    for (const url of [
      "http://selinow.com/",
      "http://selinow.com/pricing",
      "http://api.selinow.com/api/health",
      "http://api.selinow.com/api/v1/shop",
      "http://app.selinow.com/api/auth/session",
      "http://app.selinow.com/login",
      "http://a-tung.selinow.com/",
      "http://a-tung.selinow.com/cart",
      "http://a-tung.selinow.com/checkout",
      "http://a-tung.selinow.com/orders/abc123",
      "http://a-tung.selinow.com/products/key?ref=x",
    ]) {
      const request = new Request(url);
      expect(shouldEnforceHttps(request, "production"), url).toBe(true);
      const redirect = toHttpsRedirect(request);
      expect(redirect, url).not.toBeNull();
      expect(redirect?.status).toBe(308);
      expect(redirect?.headers.get("Location")).toBe(
        `https://${new URL(url).hostname}${new URL(url).pathname}${new URL(url).search}`,
      );
      expect(redirect?.headers.get("X-Robots-Tag")).toContain("noindex");
    }
  });

  it("keeps local development and loopback testing on plain HTTP", () => {
    for (const env of ["local", "staging", "production"] as const) {
      for (const url of [
        "http://localhost:4321/",
        "http://127.0.0.1:8787/api/health",
        "http://app.localhost:4321/login",
        "http://[::1]:4321/",
      ]) {
        const request = new Request(url);
        if (env === "local") {
          expect(shouldEnforceHttps(request, env), `${env} ${url}`).toBe(false);
          expect(toHttpsRedirect(request)).toBeNull();
        }
      }
    }
  });

  it("does not touch already-secure requests", () => {
    for (const url of [
      "https://selinow.com/",
      "https://a-tung.selinow.com/checkout",
    ]) {
      const request = new Request(url);
      expect(shouldEnforceHttps(request, "production")).toBe(false);
      expect(toHttpsRedirect(request)).toBeNull();
    }
  });

  it("preserves the request method contract with 308 and never caches the redirect", () => {
    const post = new Request("http://a-tung.selinow.com/api/store/checkout", {
      body: "payload",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const redirect = toHttpsRedirect(post);
    expect(redirect?.status).toBe(308);
    expect(redirect?.headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
  });

  it("honors the platform edge proto header over the request URL", () => {
    const request = new Request("https://selinow.com/", {
      headers: { "X-Forwarded-Proto": "http" },
    });
    expect(shouldEnforceHttps(request, "production")).toBe(true);
  });

  it("ignores untrusted spoofed proto headers on direct https requests", () => {
    const request = new Request("https://selinow.com/", {
      headers: { "X-Forwarded-Proto": "https" },
    });
    expect(shouldEnforceHttps(request, "production")).toBe(false);
  });
});
