import { beforeEach, describe, expect, it, vi } from "vitest";

const decryptMocks = vi.hoisted(() => ({
  credential: vi.fn(),
  recipient: vi.fn(),
}));

vi.mock("../../src/lib/telegram/credentials", () => ({
  decryptTelegramCredentialRow: decryptMocks.credential,
  decryptTelegramRecipientRow: decryptMocks.recipient,
}));

import { AppError } from "../../src/lib/core/errors";
import {
  deliverTelegramJob,
  type TelegramDeliveryJobReference,
} from "../../src/lib/delivery/telegram";
import type { AppBindings } from "../../src/lib/platform/bindings";

type QueryKind = "connection" | "credential" | "job" | "recipient";

type QueryRecord = {
  sql: string;
  values: readonly unknown[];
};

const JOB: TelegramDeliveryJobReference = {
  connectionId: "connection-telegram-a",
  eventId: "event-order-paid-a",
  id: "delivery-order-paid-a",
  purpose: "order.paid",
  shopId: "shop-telegram-a",
};

const VALID_JOB_ROW = {
  aggregateId: "order-internal-a",
  aggregateType: "order",
  attributionChannelCode: "telegram",
  attributionConnectionId: JOB.connectionId,
  connectionId: JOB.connectionId,
  customerId: "customer-a",
  eventId: JOB.eventId,
  eventSchemaVersion: 1,
  eventStatus: "published",
  eventType: "order.paid",
  jobStatus: "processing",
  orderId: "order-internal-a",
  orderNumber: "ORDER-A",
  orderLocale: null,
  orderPaymentStatus: "paid",
  orderPublicId: "order-public-a",
  orderSourceChannel: "telegram",
  preferredLocale: null,
  purpose: JOB.purpose,
  queueKind: "notification",
  identityLocale: "en-US",
  shopDefaultLocale: "vi",
  shopStatus: "active",
};

const VALID_CONNECTION_ROW = {
  activeCredentialId: "credential-a",
  channelCode: "telegram",
  channelStatus: "enabled",
  connectionStatus: "active",
  hasOutboundGrant: 1,
  integrationId: "integration-a",
  integrationStatus: "active",
  providerCode: "telegram",
};

const VALID_CREDENTIAL_ROW = {
  botTokenCiphertextB64: "encrypted-token",
  botTokenIvB64: "token-iv",
  credentialId: "credential-a",
  integrationId: "integration-a",
  keyVersion: "v1",
  shopId: JOB.shopId,
  status: "active",
  tokenFingerprint: "fingerprint-a",
  webhookSecretCiphertextB64: "encrypted-secret",
  webhookSecretDigest: "secret-digest",
  webhookSecretIvB64: "secret-iv",
};

const VALID_RECIPIENT_ROW = {
  chatIdCiphertextB64: "encrypted-chat-id",
  chatIdIvB64: "chat-id-iv",
  identityId: "identity-a",
  keyVersion: "v1",
  recipientId: "recipient-a",
  status: "active",
};

function queryKind(sql: string): QueryKind {
  if (sql.includes("FROM delivery_jobs")) return "job";
  if (sql.includes("FROM channel_connections")) return "connection";
  if (sql.includes("FROM telegram_credentials")) return "credential";
  if (sql.includes("FROM customer_identities")) return "recipient";
  throw new Error("unexpected_query");
}

class FakeStatement {
  private values: readonly unknown[] = [];

  constructor(
    private readonly runtime: FakeD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): this {
    this.values = values;
    return this;
  }

  first<T>(): Promise<T | null> {
    const kind = queryKind(this.sql);
    this.runtime.queries.push({ sql: this.sql, values: this.values });
    if (this.runtime.failures.has(kind)) return Promise.reject(new Error("d1_unavailable"));
    return Promise.resolve((this.runtime.rows[kind] ?? null) as T | null);
  }
}

class FakeD1 {
  readonly failures = new Set<QueryKind>();
  readonly queries: QueryRecord[] = [];

  constructor(readonly rows: Record<QueryKind, unknown>) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }
}

function runtime(overrides: Partial<Record<QueryKind, unknown>> = {}): {
  database: FakeD1;
  env: AppBindings;
} {
  const database = new FakeD1({
    connection: VALID_CONNECTION_ROW,
    credential: VALID_CREDENTIAL_ROW,
    job: VALID_JOB_ROW,
    recipient: VALID_RECIPIENT_ROW,
    ...overrides,
  });
  return {
    database,
    env: {
      PLATFORM_DB: database as unknown as D1Database,
    } as AppBindings,
  };
}

function telegramFetcher(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : input.toString();
  if (typeof init?.body !== "string") throw new Error("telegram_body_missing");
  const body = JSON.parse(init.body) as Record<string, unknown>;
  expect(url).toBe("https://api.telegram.org/bot123456789:token/sendMessage");
  expect(body).toMatchObject({
    chat_id: "9007199254740991",
    text: "Order ORDER-A is paid and ready for delivery. Select View key to receive it in this private chat.",
  });
  return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
}

beforeEach(() => {
  decryptMocks.credential.mockReset().mockResolvedValue({
    botToken: "123456789:token",
    webhookSecret: "webhook-secret",
  });
  decryptMocks.recipient.mockReset().mockResolvedValue("9007199254740991");
});

describe("generic Telegram delivery adapter", () => {
  it("reloads tenant-bound state and encrypted material before delivering without settling the job", async () => {
    const { database, env } = runtime();

    await expect(deliverTelegramJob({
      env,
      fetcher: telegramFetcher,
      job: JOB,
      now: new Date("2026-07-27T00:00:00.000Z"),
    })).resolves.toEqual({ kind: "delivered" });

    expect(database.queries).toHaveLength(4);
    expect(database.queries.every((query) => query.sql.trimStart().startsWith("SELECT"))).toBe(true);
    expect(database.queries[0]?.values).toEqual([JOB.id, JOB.shopId]);
    expect(database.queries[1]?.values).toEqual([
      "2026-07-27T00:00:00.000Z",
      JOB.connectionId,
      JOB.shopId,
    ]);
    expect(database.queries[2]?.values).toEqual(["credential-a", "integration-a", JOB.shopId]);
    expect(database.queries[3]?.values).toEqual(["integration-a", JOB.shopId, "customer-a"]);
    expect(decryptMocks.credential).toHaveBeenCalledWith(env, VALID_CREDENTIAL_ROW);
    expect(decryptMocks.recipient).toHaveBeenCalledWith(env, {
      ciphertextB64: "encrypted-chat-id",
      identityId: "identity-a",
      integrationId: "integration-a",
      ivB64: "chat-id-iv",
      keyVersion: "v1",
      shopId: JOB.shopId,
    });
  });

  it("uses the verified identity locale before the order request snapshot", async () => {
    const { env } = runtime({ job: { ...VALID_JOB_ROW, orderLocale: "vi-VN", identityLocale: "en" } });
    const fetcher: typeof fetch = (_input, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { text?: string };
      expect(body.text).toContain("Order ORDER-A is paid");
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
    };

    await expect(deliverTelegramJob({ env, fetcher, job: JOB })).resolves.toEqual({ kind: "delivered" });
  });

  it("uses durable buyer preference before identity and order locale", async () => {
    const { env } = runtime({ job: { ...VALID_JOB_ROW, orderLocale: "en", identityLocale: "en", preferredLocale: "vi-VN" } });
    const fetcher: typeof fetch = (_input, init) => {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { text?: string };
      expect(body.text).toContain("Đơn ORDER-A đã thanh toán");
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
    };

    await expect(deliverTelegramJob({ env, fetcher, job: JOB })).resolves.toEqual({ kind: "delivered" });
  });

  it.each([
    ["inactive shop", { job: { ...VALID_JOB_ROW, shopStatus: "deleted" } }, "telegram_delivery_shop_unavailable"],
    ["cross-connection attribution", { job: { ...VALID_JOB_ROW, attributionConnectionId: "connection-other" } }, "telegram_delivery_attribution_mismatch"],
    ["unpublished event", { job: { ...VALID_JOB_ROW, eventStatus: "processing" } }, "telegram_delivery_event_not_published"],
    ["disconnected connection", { connection: { ...VALID_CONNECTION_ROW, connectionStatus: "disconnected" } }, "telegram_delivery_connection_unavailable"],
    ["expired outbound grant", { connection: { ...VALID_CONNECTION_ROW, hasOutboundGrant: 0 } }, "telegram_delivery_outbound_grant_missing"],
    ["disabled integration", { connection: { ...VALID_CONNECTION_ROW, integrationStatus: "disabled" } }, "telegram_delivery_integration_unavailable"],
    ["blocked recipient", { recipient: { ...VALID_RECIPIENT_ROW, status: "blocked" } }, "telegram_recipient_unavailable"],
  ])("fails closed for %s", async (_case, overrides, errorCode) => {
    const { env } = runtime(overrides);
    const fetcher = vi.fn<typeof fetch>();

    await expect(deliverTelegramJob({ env, fetcher, job: JOB })).resolves.toEqual({
      errorCode,
      kind: "failed",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when the caller supplies another tenant or job identity", async () => {
    const { database, env } = runtime({ job: null });

    await expect(deliverTelegramJob({
      env,
      job: { ...JOB, shopId: "shop-other" },
    })).resolves.toEqual({
      errorCode: "telegram_delivery_job_not_found",
      kind: "failed",
    });
    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]?.values).toEqual([JOB.id, "shop-other"]);
  });

  it("returns permanent results for missing or undecryptable delivery secrets", async () => {
    const missing = runtime({ credential: null });
    await expect(deliverTelegramJob({ env: missing.env, job: JOB })).resolves.toEqual({
      errorCode: "telegram_delivery_credential_unavailable",
      kind: "failed",
    });

    decryptMocks.credential.mockRejectedValueOnce(new AppError("credential_decryption_failed", 500));
    const invalid = runtime();
    await expect(deliverTelegramJob({ env: invalid.env, job: JOB })).resolves.toEqual({
      errorCode: "credential_decryption_failed",
      kind: "failed",
    });
  });

  it.each([
    [429, { error_code: 429, ok: false, parameters: { retry_after: 17 } }, { errorCode: "telegram_rate_limited", kind: "retryable", providerOutcome: "not_sent", retryAfterSeconds: 17 }],
    [500, { error_code: 500, ok: false }, { errorCode: "provider_unavailable", kind: "retryable", providerOutcome: "unknown" }],
    [401, { error_code: 401, ok: false }, { errorCode: "telegram_unauthorized", kind: "failed" }],
    [403, { error_code: 403, ok: false }, { errorCode: "telegram_recipient_unavailable", kind: "failed" }],
  ])("classifies Telegram HTTP %i without leaking provider detail", async (status, envelope, expected) => {
    const { env } = runtime();
    const fetcher: typeof fetch = () => Promise.resolve(new Response(JSON.stringify(envelope), { status }));

    await expect(deliverTelegramJob({ env, fetcher, job: JOB })).resolves.toEqual(expected);
  });

  it("returns retryable results for provider transport and D1 state failures", async () => {
    const transport = runtime();
    const fetcher: typeof fetch = () => Promise.reject(new Error("network detail"));
    await expect(deliverTelegramJob({ env: transport.env, fetcher, job: JOB })).resolves.toEqual({
      errorCode: "provider_timeout",
      kind: "retryable",
      providerOutcome: "unknown",
    });

    const state = runtime();
    state.database.failures.add("connection");
    await expect(deliverTelegramJob({ env: state.env, job: JOB })).resolves.toEqual({
      errorCode: "telegram_delivery_state_unavailable",
      kind: "retryable",
      providerOutcome: "unknown",
    });
  });
});
