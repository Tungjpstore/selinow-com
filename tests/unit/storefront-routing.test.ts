import { describe, expect, it } from "vitest";

import { buildStorefrontCacheKey, classifyPlatformHost, getCanonicalStorefrontUrl, normalizeHostname } from "../../src/lib/storefront/routing";

const env = {
  API_ORIGIN: "https://api-staging.selinow.com",
  DASHBOARD_ORIGIN: "https://app-staging.selinow.com",
  PLATFORM_BASE_DOMAIN: "staging.selinow.com",
  PLATFORM_ORIGIN: "https://staging.selinow.com",
};

describe("storefront hostname routing", () => {
  it("keeps platform, reserved and tenant hosts in separate namespaces", () => {
    expect(classifyPlatformHost("staging.selinow.com", env)).toBe("marketing");
    expect(classifyPlatformHost("app-staging.selinow.com", env)).toBe("dashboard");
    expect(classifyPlatformHost("admin.staging.selinow.com", env)).toBe("reserved");
    expect(classifyPlatformHost("signal.staging.selinow.com", env)).toBe("tenant-candidate");
    expect(classifyPlatformHost("nested.signal.staging.selinow.com", env)).toBe("unknown");
  });

  it("treats the explicitly configured first-production canary as marketing", () => {
    expect(classifyPlatformHost("canary.selinow.com", {
      ...env,
      CANARY_HOSTNAME: "canary.selinow.com",
      PLATFORM_BASE_DOMAIN: "selinow.com",
      PLATFORM_ORIGIN: "https://selinow.com",
    })).toBe("marketing");
    expect(classifyPlatformHost("other.selinow.com", {
      ...env,
      CANARY_HOSTNAME: "canary.selinow.com",
      PLATFORM_BASE_DOMAIN: "selinow.com",
      PLATFORM_ORIGIN: "https://selinow.com",
    })).toBe("tenant-candidate");
  });

  it("rejects IP and malformed hostname input", () => {
    expect(normalizeHostname("127.0.0.1")).toBe("");
    expect(normalizeHostname("bad_host.example")).toBe("");
    expect(normalizeHostname("Signal.Staging.Selinow.com.")).toBe("signal.staging.selinow.com");
  });

  it("builds tenant-safe cache keys with hostname and locale", () => {
    const first = buildStorefrontCacheKey({ hostname: "signal.staging.selinow.com", incarnation: "domain-signal", locale: "vi", pathname: "/products/editor", version: 1 });
    const second = buildStorefrontCacheKey({ hostname: "canvas.staging.selinow.com", incarnation: "domain-canvas", locale: "vi", pathname: "/products/editor", version: 1 });
    const english = buildStorefrontCacheKey({ hostname: "signal.staging.selinow.com", incarnation: "domain-signal", locale: "en", pathname: "/products/editor", version: 1 });
    expect(first).not.toBe(second);
    expect(first).not.toBe(english);
    expect(first).toContain(encodeURIComponent("signal.staging.selinow.com"));
  });

  it("keeps reassigned hostname incarnations in separate cache namespaces", () => {
    const oldOwner = buildStorefrontCacheKey({ hostname: "shop.example.com", incarnation: "domain-old", locale: "vi", pathname: "/products/editor", version: "2-1" });
    const newOwner = buildStorefrontCacheKey({ hostname: "shop.example.com", incarnation: "domain-new", locale: "vi", pathname: "/products/editor", version: "2-1" });

    expect(oldOwner).not.toBe(newOwner);
    expect(oldOwner).toContain("/i/domain-old/v2-1/");
    expect(newOwner).toContain("/i/domain-new/v2-1/");
  });

  it("redirects only public catalog paths to the canonical hostname", () => {
    const publicUrl = getCanonicalStorefrontUrl({ canonicalHostname: "shop.example.com", request: new Request("https://signal.staging.selinow.com/products/editor?ref=telegram") });
    const privateUrl = getCanonicalStorefrontUrl({ canonicalHostname: "shop.example.com", request: new Request("https://signal.staging.selinow.com/orders/order_123?payment=return") });
    expect(publicUrl?.toString()).toBe("https://shop.example.com/products/editor?ref=telegram");
    expect(privateUrl).toBeNull();
  });
});
