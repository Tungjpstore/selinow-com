import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDodoWebhook, fingerprintDodoWebhookReference } from "../../scripts/lib/dodo-webhook-registration.mjs";

const API_BASE_URL = "https://test.dodopayments.com";
const ENDPOINT_URL = "https://api-staging.selinow.com/api/webhooks/billing/dodo/ddowh_00000000-0000-4000-8000-000000000081";
const REQUIRED_EVENTS = [
  "payment.cancelled",
  "payment.failed",
  "payment.processing",
  "payment.succeeded",
  "subscription.active",
  "subscription.cancelled",
  "subscription.expired",
  "subscription.failed",
  "subscription.on_hold",
  "subscription.paused",
  "subscription.plan_changed",
  "subscription.renewed",
  "subscription.unpaused",
  "subscription.update_payment_method",
  "subscription.updated",
];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

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

  it("searches every provider page before deciding whether to create an endpoint", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [{ id: "wh_other", url: "https://api-staging.selinow.com/other" }], done: false, iterator: "page-two" }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "wh_test_existing", url: ENDPOINT_URL }], done: true, iterator: null }))
      .mockResolvedValueOnce(Response.json({ secret: "whsec_dGVzdC13ZWJob29rLXNlY3JldA==" }));

    await expect(ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher }))
      .resolves.toMatchObject({ created: false });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[0]).toBe(`${API_BASE_URL}/webhooks?iterator=page-two`);
    expect(fetcher.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === "POST")).toBe(false);
  });

  it("fails closed instead of creating when the provider list envelope is malformed", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: "temporarily_unavailable" }));

    await expect(ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher }))
      .rejects.toThrow("dodo_webhook_provider_response_invalid");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("fails closed when provider pagination repeats an iterator", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ data: [], done: false, iterator: "repeated" }))
      .mockResolvedValueOnce(Response.json({ data: [], done: false, iterator: "repeated" }));

    await expect(ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher }))
      .rejects.toThrow("dodo_webhook_provider_response_invalid");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent list-create registrations into exactly one provider POST", async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), "selinow-dodo-registration-lock-"));
    temporaryDirectories.push(lockDirectory);
    const lockPath = join(lockDirectory, "registration.lock");
    const providerWebhooks: Array<{ id: string; url: string }> = [];
    let postCount = 0;
    const fetcher = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const path = new URL(requestUrl).pathname;
      if (path === "/webhooks" && init?.method === "GET") return Promise.resolve(Response.json({ items: providerWebhooks }));
      if (path === "/webhooks" && init?.method === "POST") {
        postCount += 1;
        const created = { id: "wh_test_race", url: ENDPOINT_URL };
        providerWebhooks.push(created);
        return Promise.resolve(Response.json(created));
      }
      if (path === "/webhooks/wh_test_race/secret") return Promise.resolve(Response.json({ secret: "whsec_dGVzdC13ZWJob29rLXNlY3JldA==" }));
      throw new Error(`unexpected ${path}`);
    });

    const input = { apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher: fetcher as typeof fetch, lockPath };
    const results = await Promise.all([ensureDodoWebhook(input), ensureDodoWebhook(input)]);

    expect(postCount).toBe(1);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(1);
  });

  it("reclaims a stale private lease but rejects a symlinked or group-readable one", async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), "selinow-dodo-registration-stale-"));
    const externalDirectory = await mkdtemp(join(tmpdir(), "selinow-dodo-registration-external-"));
    temporaryDirectories.push(lockDirectory, externalDirectory);
    const lockPath = join(lockDirectory, "registration.lock");
    await writeFile(lockPath, `${JSON.stringify({
      acquiredAt: "2026-08-11T06:00:00.000Z",
      expiresAt: "2026-08-11T06:00:01.000Z",
      id: "stale-owner",
      mode: "dodo_webhook_registration_lease",
      schemaVersion: 1,
    })}\n`, { mode: 0o600 });
    const staleFetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [] }))
      .mockResolvedValueOnce(Response.json({ id: "wh_test_stale", url: ENDPOINT_URL }))
      .mockResolvedValueOnce(Response.json({ secret: "whsec_dGVzdC13ZWJob29rLXNlY3JldA==" }));
    await expect(ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher: staleFetcher, lockPath }))
      .resolves.toMatchObject({ created: true });

    const externalLock = join(externalDirectory, "registration.lock");
    await writeFile(externalLock, "{}\n", { mode: 0o600 });
    await symlink(externalLock, lockPath);
    await expect(ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher: staleFetcher, lockPath }))
      .rejects.toThrow("dodo_webhook_registration_lock_invalid");
    await rm(lockPath);
    await writeFile(lockPath, "{}\n", { mode: 0o600 });
    await chmod(lockPath, 0o644);
    await expect(ensureDodoWebhook({ apiBaseUrl: API_BASE_URL, apiKey: "test-api-key-value", endpointUrl: ENDPOINT_URL, fetcher: staleFetcher, lockPath }))
      .rejects.toThrow("dodo_webhook_registration_lock_invalid");
  });

  it("does not unlink a replacement lease that wins immediately before stale cleanup", async () => {
    const lockDirectory = await mkdtemp(join(tmpdir(), "selinow-dodo-registration-swap-"));
    const externalDirectory = await mkdtemp(join(tmpdir(), "selinow-dodo-registration-swap-external-"));
    temporaryDirectories.push(lockDirectory, externalDirectory);
    const lockPath = join(lockDirectory, "registration.lock");
    const externalLock = join(externalDirectory, "replacement.lock");
    await writeFile(lockPath, `${JSON.stringify({
      acquiredAt: "2026-08-11T06:00:00.000Z",
      expiresAt: "2026-08-11T06:00:01.000Z",
      id: "stale-owner",
      mode: "dodo_webhook_registration_lease",
      schemaVersion: 1,
    })}\n`, { mode: 0o600 });
    await writeFile(externalLock, "do-not-remove\n", { mode: 0o600 });
    await expect(ensureDodoWebhook({
      apiBaseUrl: API_BASE_URL,
      apiKey: "test-api-key-value",
      endpointUrl: ENDPOINT_URL,
      fetcher: vi.fn(),
      fileSystemHooks: {
        async beforeLeaseUnlink() {
          await rm(lockPath);
          await symlink(externalLock, lockPath);
        },
      },
      lockPath,
    })).rejects.toThrow("dodo_webhook_registration_lock_invalid");
    await expect(readFile(externalLock, "utf8")).resolves.toBe("do-not-remove\n");
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

  it("reuses an endpoint configured to receive all events", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [{
        id: "wh_test_all_events",
        url: ENDPOINT_URL,
        enabled: true,
        events: [],
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

  it.each([
    "payment.cancelled",
    "payment.processing",
    "subscription.paused",
    "subscription.unpaused",
    "subscription.update_payment_method",
  ])("fails closed when an existing endpoint omits required event %s", async (missingEvent) => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ items: [{
        id: "wh_test_missing_events",
        url: ENDPOINT_URL,
        filter_types: REQUIRED_EVENTS.filter((eventType) => eventType !== missingEvent),
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
