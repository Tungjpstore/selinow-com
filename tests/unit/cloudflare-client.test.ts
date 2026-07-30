import { describe, expect, it } from "vitest";

import { CLOUDFLARE_MAX_RESPONSE_BYTES, CloudflareSaaSClient } from "../../src/lib/domains/cloudflare";

const TOKEN = "cloudflare-secret-token";
const ZONE_ID = "0123456789abcdef0123456789abcdef";

function hostnameResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hostname: "shop.customer.com",
    id: "custom-hostname-id",
    ssl: { status: "pending_validation" },
    status: "pending",
    ...overrides,
  };
}

function success(result: unknown): Response {
  return new Response(JSON.stringify({ errors: [], messages: [], result, success: true }), { status: 200 });
}

describe("Cloudflare for SaaS client", () => {
  it("invokes the fetch dependency without rebinding its receiver", async () => {
    const fetcher = function (this: unknown): Promise<Response> {
      expect(this).toBeUndefined();
      return Promise.resolve(success(hostnameResult()));
    } as typeof fetch;

    await expect(new CloudflareSaaSClient(TOKEN, ZONE_ID, fetcher).getCustomHostname("custom-hostname-id")).resolves.toMatchObject({
      id: "custom-hostname-id",
    });
  });

  it("uses the fixed API origin, bearer authorization and documented create contract", async () => {
    const fetcher: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/custom_hostnames`);
      expect(url).not.toContain(TOKEN);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(typeof init?.body === "string" ? init.body : "{}")).toEqual({
        hostname: "shop.customer.com",
        ssl: { method: "http", settings: { min_tls_version: "1.2" }, type: "dv" },
      });
      return Promise.resolve(success(hostnameResult({
        ownership_verification: { name: "_cf-custom-hostname.shop.customer.com", type: "txt", value: "verification" },
        ssl: {
          status: "pending_validation",
          validation_records: [{ http_body: "body", http_url: "http://shop.customer.com/.well-known/pki-validation/token" }],
        },
      })));
    };

    await expect(new CloudflareSaaSClient(`  ${TOKEN}\n`, ` ${ZONE_ID} `, fetcher).createCustomHostname("shop.customer.com")).resolves.toMatchObject({
      hostname: "shop.customer.com",
      ownership_verification: { type: "txt" },
      ssl: { status: "pending_validation" },
      status: "pending",
    });
  });

  it("rejects embedded control characters in bearer credentials", () => {
    expect(() => new CloudflareSaaSClient(`cloudflare\nsecret`, ZONE_ID)).toThrow(expect.objectContaining({ code: "cloudflare_config_invalid" }));
  });

  it("recovers an existing hostname through an exact encoded list query", async () => {
    const fetcher: typeof fetch = (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/custom_hostnames?hostname=shop.customer.com`);
      return Promise.resolve(success([hostnameResult()]));
    };
    await expect(new CloudflareSaaSClient(TOKEN, ZONE_ID, fetcher).findCustomHostname("shop.customer.com")).resolves.toMatchObject({ id: "custom-hostname-id" });
  });

  it("uses a bounded timeout signal and maps network failures safely", async () => {
    const fetcher: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("secret network detail", "AbortError"));
      });
    });
    await expect(new CloudflareSaaSClient(TOKEN, ZONE_ID, fetcher, 5).getCustomHostname("id")).rejects.toMatchObject({ code: "provider_timeout" });

    const networkFetcher: typeof fetch = () => Promise.reject(new TypeError("safe network failure"));
    await expect(new CloudflareSaaSClient(TOKEN, ZONE_ID, networkFetcher).getCustomHostname("id")).rejects.toMatchObject({ code: "provider_network_error" });
  });

  it("rejects oversized or malformed provider responses", async () => {
    const oversizedFetcher: typeof fetch = () => Promise.resolve(new Response("x".repeat(CLOUDFLARE_MAX_RESPONSE_BYTES + 1), { status: 200 }));
    const invalidFetcher: typeof fetch = () => Promise.resolve(new Response("not-json", { status: 200 }));
    await expect(new CloudflareSaaSClient(TOKEN, ZONE_ID, oversizedFetcher).getCustomHostname("id")).rejects.toMatchObject({ code: "provider_response_too_large" });
    await expect(new CloudflareSaaSClient(TOKEN, ZONE_ID, invalidFetcher).getCustomHostname("id")).rejects.toMatchObject({ code: "provider_response_invalid" });
  });

  it("does not expose provider messages or API tokens in errors", async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
      errors: [{ code: 10000, message: `invalid token ${TOKEN}` }],
      result: null,
      success: false,
    }), { status: 403 }));
    const request = new CloudflareSaaSClient(TOKEN, ZONE_ID, fetcher).getCustomHostname("id");
    await expect(request).rejects.toMatchObject({ code: "cloudflare_unauthorized", providerCode: 10000, providerStatus: 403 });
    await request.catch((error: unknown) => {
      expect(String(error)).not.toContain(TOKEN);
      expect(String(error)).not.toContain("invalid token");
    });
  });

  it("preserves a bounded Retry-After hint for rate limits", async () => {
    const fetcher: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({ errors: [{ code: 1015 }], result: null, success: false }), {
      headers: { "Retry-After": "17" },
      status: 429,
    }));
    await expect(new CloudflareSaaSClient(TOKEN, ZONE_ID, fetcher).getCustomHostname("id")).rejects.toMatchObject({
      code: "cloudflare_rate_limited",
      retryAfter: 17,
    });
  });
});
