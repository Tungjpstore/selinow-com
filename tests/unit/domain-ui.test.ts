import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  deriveDomainLifecycle,
  domainStatusLabel,
  isDomainReady,
  validateHostnameDraft,
} from "../../src/lib/dashboard/domain-ui";

describe("seller custom-domain UI policy", () => {
  it("accepts and normalizes a hostname-only custom subdomain", () => {
    expect(validateHostnameDraft("  Store.Example.COM. ")).toEqual({
      code: null,
      hostname: "store.example.com",
    });
  });

  it.each([
    "https://store.example.com",
    "store.example.com/path",
    "user@store.example.com",
    "*.example.com",
    "127.0.0.1",
  ])("rejects non-hostname input %s", (value) => {
    expect(validateHostnameDraft(value)).toEqual({ code: "hostname_invalid", hostname: null });
  });

  it.each(["example.com", "example.com.vn"])('warns that apex hostname "%s" is unsupported', (value) => {
    expect(validateHostnameDraft(value)).toEqual({ code: "hostname_apex_unsupported", hostname: null });
  });

  it("requires every Cloudflare readiness signal before enabling primary", () => {
    const active = {
      dnsStatus: "active",
      hostnameStatus: "active",
      sslStatus: "active",
      status: "active",
      turnstileStatus: "active",
      type: "custom" as const,
    };

    expect(isDomainReady(active)).toBe(true);
    expect(isDomainReady({ ...active, sslStatus: "pending_validation" })).toBe(false);
    expect(isDomainReady({ ...active, dnsStatus: "pending" })).toBe(false);
    expect(isDomainReady({ ...active, turnstileStatus: "pending" })).toBe(false);
  });

  it("treats an active platform subdomain as ready without provider checks", () => {
    expect(isDomainReady({
      dnsStatus: null,
      hostnameStatus: null,
      sslStatus: null,
      status: "active",
      turnstileStatus: null,
      type: "platform_subdomain",
    })).toBe(true);
  });

  it("derives the PromptOS lifecycle in the authoritative order", () => {
    const steps = deriveDomainLifecycle({
      dnsStatus: "active",
      hostnameStatus: "active",
      isPrimary: false,
      ownershipStatus: "verified",
      sslStatus: "active",
      status: "active",
      turnstileStatus: "active",
      type: "custom",
    });

    expect(steps.map((step) => step.key)).toEqual([
      "ownership",
      "hostname",
      "dns",
      "ssl",
      "turnstile",
      "primary",
      "routing",
    ]);
    expect(steps.map((step) => step.status)).toEqual([
      "verified",
      "active",
      "active",
      "active",
      "active",
      "available",
      "active",
    ]);
  });

  it("keeps primary and routing pending until every backend readiness signal is active", () => {
    const steps = deriveDomainLifecycle({
      dnsStatus: "pending",
      hostnameStatus: "active",
      isPrimary: false,
      ownershipStatus: "verified",
      sslStatus: "pending_validation",
      status: "validating",
      turnstileStatus: "pending",
      type: "custom",
    });

    expect(steps.find((step) => step.key === "primary")?.status).toBe("pending");
    expect(steps.find((step) => step.key === "routing")?.status).toBe("pending");
    expect(domainStatusLabel("pending_validation")).toBe("Verifying");
    expect(domainStatusLabel("pending_validation", "vi-VN")).toBe("Đang xác minh");
    expect(domainStatusLabel("provider_safe_pending", "fr-FR")).toBe("Processing (provider_safe_pending)");
    expect(steps.find((step) => step.key === "ownership")?.label).toBe("Ownership");
    expect(deriveDomainLifecycle({
      dnsStatus: "pending",
      hostnameStatus: "active",
      isPrimary: false,
      ownershipStatus: "verified",
      sslStatus: "pending_validation",
      status: "validating",
      turnstileStatus: "pending",
      type: "custom",
    }, "vi-VN").find((step) => step.key === "ownership")?.label).toBe("Quyền sở hữu");
  });

  it("keeps reusable domain presentation copy in the dashboard catalog", async () => {
    const source = await readFile("src/lib/dashboard/domain-ui.ts", "utf8");
    expect(source).toContain("createDashboardTranslator");
    expect(source).not.toMatch(/[À-ỹĐđ]/u);
  });
});
