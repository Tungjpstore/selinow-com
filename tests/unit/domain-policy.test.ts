import { describe, expect, it } from "vitest";

import { isCloudflareHostnameReady, normalizeCustomHostname } from "../../src/lib/domains/policy";

describe("custom domain policy", () => {
  it("normalizes case, a root dot and IDNA to stable ASCII", () => {
    expect(normalizeCustomHostname("  CỬA-HÀNG.Example.COM. ")).toBe("xn--ca-hng-lta4562d.example.com");
    expect(normalizeCustomHostname("xn--ca-hng-lta4562d.example.com")).toBe("xn--ca-hng-lta4562d.example.com");
  });

  it.each([
    "https://shop.example.com",
    "shop.example.com/path",
    "shop.example.com?next=1",
    "user@shop.example.com",
    "*.example.com",
    "127.0.0.1",
    "[::1]",
    "shop.localhost",
    "shop.internal",
    "shop.example.test",
    "shop.selinow.com",
    "selinow.com",
    "example.com",
    "customer.co.uk",
  ])("rejects unsafe or unsupported hostname %s", (hostname) => {
    expect(() => normalizeCustomHostname(hostname)).toThrow();
  });

  it("supports an explicit platform hostname boundary", () => {
    expect(() => normalizeCustomHostname("shop.platform.vendor", { platformHostnames: ["platform.vendor"] })).toThrow(
      expect.objectContaining({ issues: ["hostname_platform_not_allowed"] }),
    );
    expect(normalizeCustomHostname("shop.customer.vendor", { platformHostnames: ["platform.vendor"] })).toBe("shop.customer.vendor");
  });

  it("fails readiness closed unless hostname, SSL and DNS are exactly active", () => {
    expect(isCloudflareHostnameReady({ dnsStatus: "active", hostnameStatus: "active", sslStatus: "active" })).toBe(true);
    expect(isCloudflareHostnameReady({ dnsStatus: "active", hostnameStatus: "active_redeploying", sslStatus: "active" })).toBe(false);
    expect(isCloudflareHostnameReady({ dnsStatus: "active", hostnameStatus: "active", sslStatus: "pending_deployment" })).toBe(false);
    expect(isCloudflareHostnameReady({ dnsStatus: "pending", hostnameStatus: "active", sslStatus: "active" })).toBe(false);
  });
});
