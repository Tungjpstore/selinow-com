import { describe, expect, it } from "vitest";

import {
  applyPrivatePageHeaders,
  applySecurityHeaders,
  createErrorResponse,
  isPrivatePagePath,
  resolveRequestId,
} from "../../src/lib/http/security";

describe("HTTP security foundation", () => {
  it("keeps a safe upstream request ID", () => {
    expect(resolveRequestId("edge-request_1234")).toBe("edge-request_1234");
  });

  it("replaces an unsafe request ID", () => {
    expect(resolveRequestId("bad request id\nsecret")).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("applies baseline security headers", () => {
    const headers = new Headers();
    applySecurityHeaders(headers, "request-1234");

    expect(headers.get("X-Request-Id")).toBe("request-1234");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("does not weaken an endpoint-specific referrer policy", () => {
    const headers = new Headers({ "Referrer-Policy": "no-referrer" });
    applySecurityHeaders(headers, "request-1234");

    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("classifies only private HTML surfaces as private page paths", () => {
    for (const pathname of [
      "/app",
      "/app/products",
      "/app/store/settings",
      "/onboarding",
      "/admin",
      "/admin/operations",
      "/admin/shops",
      "/login",
    ]) {
      expect(isPrivatePagePath(pathname), pathname).toBe(true);
    }

    for (const pathname of ["/", "/pricing", "/api/app/shops/shop_a", "/api/admin/operations", "/login-help"]) {
      expect(isPrivatePagePath(pathname), pathname).toBe(false);
    }
  });

  it("prevents private pages and redirects from being cached or indexed", () => {
    const headers = new Headers({ "Referrer-Policy": "strict-origin-when-cross-origin" });
    applyPrivatePageHeaders(headers);

    expect(headers.get("Cache-Control")).toBe("private, no-store, max-age=0");
    expect(headers.get("Expires")).toBe("0");
    expect(headers.get("Pragma")).toBe("no-cache");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("returns stable errors without stack traces", async () => {
    const response = createErrorResponse("validation_failed", "request-1234", 400, ["slug_invalid"]);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: "validation_failed",
      requestId: "request-1234",
      issues: ["slug_invalid"],
    });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
