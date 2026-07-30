import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createStagingPhaseASmokePlan,
  runStagingPhaseASmoke,
  validateStagingPhaseASmokePlan,
} from "../../scripts/lib/staging-smoke.mjs";

const stagingSpec = JSON.parse(readFileSync("infra/environments/staging.json", "utf8")) as Record<string, unknown>;

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "cache-control": "no-store", "content-type": "application/json", ...headers },
    status: 200,
  });
}

describe("staging Phase A smoke gate", () => {
  it("builds only exact staging origins and read-only methods", () => {
    const plan = createStagingPhaseASmokePlan(stagingSpec);

    expect(plan.environment).toBe("staging");
    expect(plan.readOnly).toBe(true);
    expect(plan.checks).toHaveLength(6);
    for (const check of plan.checks) {
      const url = new URL(check.url);
      expect(url.protocol).toBe("https:");
      expect(new Set([
        "staging.selinow.com",
        "app-staging.selinow.com",
        "api-staging.selinow.com",
        "signal.staging.selinow.com",
        "canvas.staging.selinow.com",
        "coming-soon.staging.selinow.com",
        "paused.staging.selinow.com",
      ]).has(url.hostname)).toBe(true);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      expect(check.method).toBe("GET");
    }
    expect(plan.checks.map((check) => check.name)).toEqual([
      "platform_health",
      "website_catalog_read",
      "website_storefront_home",
      "website_product_read",
      "website_checkout_get_blocked",
      "telegram_webhook_get_blocked",
    ]);
  });

  it("passes health, catalog, storefront and method-boundary checks without a request body", async () => {
    const plan = createStagingPhaseASmokePlan(stagingSpec);
    const requests: Array<{ body: BodyInit | null | undefined; method: string | undefined; url: string }> = [];
    const fetchImplementation = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.toString() : input;
      requests.push({ body: init?.body, method: init?.method, url });
      if (url.endsWith("/api/health")) return Promise.resolve(jsonResponse({
        commerce: { channels: ["telegram", "website"], contract: "principal-channel-canonical-v1" },
        ok: true,
        service: "selinow.com",
      }));
      if (url.endsWith("/api/store/catalog")) return Promise.resolve(jsonResponse({
        categories: [],
        ok: true,
        products: [{ slug: "signal-editor-lifetime", variants: [{ id: "variant-1" }] }],
        shop: { slug: "signal" },
      }, { "cache-control": "public, max-age=30", vary: "Accept-Language, Host" }));
      if (url.endsWith("/api/store/checkout") || url.includes("/webhooks/telegram/")) return Promise.resolve(new Response("method not allowed", { status: 405 }));
      return Promise.resolve(new Response("<html><h1>Signal Editor Lifetime</h1></html>", { headers: { "cache-control": "private, no-store", "content-type": "text/html; charset=UTF-8" }, status: 200 }));
    };

    const result = await runStagingPhaseASmoke({ fetchImplementation, plan });

    expect(result.ok).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.actions.every((action) => action.ok)).toBe(true);
    expect(requests).toHaveLength(plan.checks.length);
    expect(requests.every((request) => request.method === "GET" && request.body === undefined)).toBe(true);
  });

  it("fails closed when the health cache contract is not no-store", async () => {
    const plan = createStagingPhaseASmokePlan(stagingSpec);
    const firstCheck = plan.checks[0];
    if (firstCheck === undefined) throw new Error("staging_smoke_check_missing");
    const result = await runStagingPhaseASmoke({
      fetchImplementation: () => Promise.resolve(jsonResponse({
        commerce: { channels: ["telegram", "website"], contract: "principal-channel-canonical-v1" },
        ok: true,
        service: "selinow.com",
      }, { "cache-control": "public, max-age=30" })),
      plan: { ...plan, checks: [firstCheck] },
    });

    expect(result.ok).toBe(false);
    expect(result.actions).toEqual([expect.objectContaining({
      code: "required_header_value_mismatch",
      name: "platform_health",
      ok: false,
      status: 200,
    })]);
  });

  it("fails closed for production URLs or mutation methods", () => {
    const plan = createStagingPhaseASmokePlan(stagingSpec);
    const firstCheck = plan.checks[0];
    if (firstCheck === undefined) throw new Error("staging_smoke_check_missing");
    expect(() => validateStagingPhaseASmokePlan({ ...plan, checks: [{ ...firstCheck, method: "POST" }] })).toThrow("staging_smoke_method_not_read_only");
    expect(() => validateStagingPhaseASmokePlan({ ...plan, checks: [{ ...firstCheck, url: "https://selinow.com/api/health" }] })).toThrow("staging_smoke_url_invalid");
  });

  it("does not expose response bodies when a bounded read-only check fails", async () => {
    const plan = createStagingPhaseASmokePlan(stagingSpec);
    const firstCheck = plan.checks[0];
    if (firstCheck === undefined) throw new Error("staging_smoke_check_missing");
    const secretLikeBody = "license-key-plaintext-should-never-appear-in-output";
    const result = await runStagingPhaseASmoke({
      fetchImplementation: () => Promise.resolve(new Response(secretLikeBody, { headers: { "cache-control": "no-store", "content-type": "text/plain" }, status: 503 })),
      plan: { ...plan, checks: [firstCheck] },
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secretLikeBody);
  });
});
