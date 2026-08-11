import { describe, expect, it, vi } from "vitest";

import { ensureDodoWebhook, fingerprintDodoWebhookReference } from "../../scripts/lib/dodo-webhook-registration.mjs";

const API_BASE_URL = "https://test.dodopayments.com";
const ENDPOINT_URL = "https://api-staging.selinow.com/api/webhooks/billing/dodo/ddowh_00000000-0000-4000-8000-000000000081";
const REQUIRED_EVENTS = [
  "payment.failed",
  "payment.succeeded",
  "subscription.active",
  "subscription.cancelled",
  "subscription.expired",
  "subscription.failed",
  "subscription.on_hold",
  "subscription.plan_changed",
  "subscription.renewed",
  "subscription.updated",
];

describe("Dodo webhook registration", () => {
  it("reuses an exact existing endpoint and retrieves its signing key", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [{ id: "wh_test_existing", url: ENDPOINT_URL }] }))
      .mockResolvedValueOnce(Response.json({ secret: "whsec_dGVzdC13ZWJob29rLXNlY3JldA==" }));

    const result = await ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher });

    expect(result.created).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[0]).toBe(`${API_BASE_URL}/webhooks/wh_test_existing/secret`);
    expect(result.endpointFingerprintSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("creates the endpoint once when no exact URL exists", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [] }))
      .mockResolvedValueOnce(Response.json({ id: "wh_test_created", url: ENDPOINT_URL }))
      .mockResolvedValueOnce(Response.json({ signing_key: "whsec_dGVzdC13ZWJob29rLXNlY3JldA==" }));

    const result = await ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher });

    expect(result.created).toBe(true);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ body: JSON.stringify({ url: ENDPOINT_URL }), method: "POST" });
    expect(result.providerWebhookFingerprintSha256).toBe(fingerprintDodoWebhookReference("provider_webhook", "wh_test_created"));
  });

  it("reuses an explicitly usable endpoint when the provider declares its event contract", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [{
        id: "wh_test_declared",
        url: ENDPOINT_URL,
        enabled: true,
        events: REQUIRED_EVENTS,
      }] }))
      .mockResolvedValueOnce(Response.json({ secret: "whsec_dGVzdC13ZWJob29rLXNlY3JldA==" }));

    await expect(ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher })).resolves.toMatchObject({ created: false });
  });

  it.each([
    ["disabled flag", { disabled: true }],
    ["disabled status", { status: "disabled" }],
    ["disabled enabled flag", { enabled: false }],
  ])("fails closed when an existing endpoint is explicitly unusable (%s)", async (_label, usability) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [{ id: "wh_test_unusable", url: ENDPOINT_URL, ...usability }] }))
      .mockResolvedValueOnce(Response.json({ secret: "whsec_dGVzdC13ZWJob29rLXNlY3JldA==" }));

    await expect(ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher })).rejects.toThrow("dodo_webhook_endpoint_unusable");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed when an existing endpoint declares an incomplete event list", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [{
        id: "wh_test_missing_events",
        url: ENDPOINT_URL,
        filter_types: REQUIRED_EVENTS.filter((eventType) => eventType !== "subscription.expired"),
      }] }))
      .mockResolvedValueOnce(Response.json({ secret: "whsec_dGVzdC13ZWJob29rLXNlY3JldA==" }));

    await expect(ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher })).rejects.toThrow("dodo_webhook_event_contract_incomplete");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed on duplicate endpoints, insecure URLs and missing secrets", async () => {
    const duplicate = vi.fn().mockResolvedValue(Response.json({ items: [
      { id: "wh_test_a", url: ENDPOINT_URL },
      { id: "wh_test_b", url: ENDPOINT_URL },
    ] }));
    await expect(ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher: duplicate })).rejects.toThrow("dodo_webhook_endpoint_duplicate");
    await expect(ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: "http://example.test/hook", fetcher: duplicate })).rejects.toThrow("dodo_webhook_endpoint_invalid");
    const missingSecret = vi.fn()
      .mockResolvedValueOnce(Response.json([{ id: "wh_test_existing", url: ENDPOINT_URL }]))
      .mockResolvedValueOnce(Response.json({ secret: "redacted" }));
    await expect(ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher: missingSecret })).rejects.toThrow("dodo_webhook_signing_key_invalid");
  });
});
