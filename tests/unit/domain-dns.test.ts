import { describe, expect, it } from "vitest";

import { resolveTxtRecords, verifyCustomDomainOwnership, verifyCustomHostnameDns } from "../../src/lib/domains/dns";

describe("custom domain DNS verification", () => {
  it("marks only the exact normalized SaaS CNAME target active", async () => {
    await expect(verifyCustomHostnameDns({
      expectedTarget: "customers.selinow.com",
      hostname: "SHOP.CUSTOMER.COM.",
      resolver: () => Promise.resolve(["CUSTOMERS.SELINOW.COM."]),
    })).resolves.toEqual({ observedTargets: ["customers.selinow.com"], status: "active" });
  });

  it("keeps absent and wrong CNAME targets pending", async () => {
    await expect(verifyCustomHostnameDns({
      expectedTarget: "customers.selinow.com",
      hostname: "shop.customer.com",
      resolver: () => Promise.resolve(["other.example.com"]),
    })).resolves.toEqual({ observedTargets: ["other.example.com"], status: "pending" });
    await expect(verifyCustomHostnameDns({
      expectedTarget: "customers.selinow.com",
      hostname: "shop.customer.com",
      resolver: () => Promise.resolve([]),
    })).resolves.toEqual({ observedTargets: [], status: "pending" });
  });

  it("maps resolver failures to a safe error state", async () => {
    await expect(verifyCustomHostnameDns({
      expectedTarget: "customers.selinow.com",
      hostname: "shop.customer.com",
      resolver: () => Promise.reject(new Error("resolver detail")),
    })).resolves.toEqual({ observedTargets: [], status: "error" });
  });

  it("accepts only TXT ownership proof at the exact challenge name", async () => {
    await expect(verifyCustomDomainOwnership({
      challengeName: "_selinow-verify.SHOP.CUSTOMER.COM.",
      expectedValue: "selinow-verification=expected-token",
      resolver: () => Promise.resolve([
        "wrong-token",
        "selinow-verification=expected-token",
        "selinow-verification=expected-token",
      ]),
    })).resolves.toEqual({
      observedValues: ["wrong-token", "selinow-verification=expected-token"],
      status: "active",
    });
  });

  it("keeps missing, wrong, oversized, and lookup-error TXT proofs safe", async () => {
    await expect(verifyCustomDomainOwnership({
      challengeName: "_selinow-verify.shop.customer.com",
      expectedValue: "expected",
      resolver: () => Promise.resolve(["other"]),
    })).resolves.toEqual({ observedValues: ["other"], status: "pending" });

    await expect(verifyCustomDomainOwnership({
      challengeName: "_selinow-verify.shop.customer.com",
      expectedValue: "expected",
      resolver: () => Promise.resolve(["x".repeat(513), "expected"]),
    })).resolves.toEqual({ observedValues: ["expected"], status: "active" });

    await expect(verifyCustomDomainOwnership({
      challengeName: "_selinow-verify.shop.customer.com",
      expectedValue: "expected",
      resolver: () => Promise.reject(new Error("resolver detail")),
    })).resolves.toEqual({ observedValues: [], status: "error" });
  });

  it("parses DNS JSON TXT answers only for the requested owner name", async () => {
    const fetcher: typeof fetch = (url) => {
      const requestedUrl = new URL(url instanceof Request ? url.url : String(url));
      expect(requestedUrl.searchParams.get("name")).toBe("_selinow-verify.shop.customer.com");
      expect(requestedUrl.searchParams.get("type")).toBe("TXT");
      return Promise.resolve(new Response(JSON.stringify({
        Status: 0,
        Answer: [
          { name: "other.customer.com.", type: 16, data: '"ignored"' },
          { name: "_selinow-verify.shop.customer.com.", type: 16, data: '"expected"' },
          { name: "_selinow-verify.shop.customer.com.", type: 1, data: "192.0.2.1" },
        ],
      }), { status: 200 }));
    };
    await expect(resolveTxtRecords("_selinow-verify.shop.customer.com", fetcher)).resolves.toEqual(["expected"]);
  });
});
