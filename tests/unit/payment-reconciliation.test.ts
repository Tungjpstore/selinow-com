import { beforeEach, describe, expect, it, vi } from "vitest";

import { encryptPayOSCredentials } from "../../src/lib/payments/crypto";
import { createPayOSObjectSignature } from "../../src/lib/payments/payos";
import { decidePayment } from "../../src/lib/payments/decision";
import { normalizeReconciliation } from "../../src/lib/payments/store";
import type { AppBindings } from "../../src/lib/platform/bindings";

const mocked = vi.hoisted(() => ({ processPayOSWebhook: vi.fn() }));

vi.mock("../../src/lib/payments/webhooks", () => ({ processPayOSWebhook: mocked.processPayOSWebhook }));

import { parsePaymentExceptionEvidence, reconcilePendingPayments } from "../../src/lib/payments/reconciliation";

const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = new Date("2026-07-26T00:00:00.000Z");

async function reconciliationEnvironment(providerOrderCode: number) {
  const encrypted = await encryptPayOSCredentials({
    apiKey: "api-key-test",
    checksumKey: "checksum-key-test",
    clientId: "client-id-test",
  }, {
    credentialId: "credential-a",
    hmacSecret: "identifier-secret",
    integrationId: "integration-a",
    kek: KEK,
    keyVersion: "v1",
    shopId: "shop-a",
  });
  const sqlCalls: string[] = [];
  const attempt = {
    credentialId: "credential-a",
    id: "attempt-a",
    integrationId: "integration-a",
    providerOrderCode: 111,
    shopId: "shop-a",
    webhookPublicId: "webhook-a",
  };
  const database = {
    prepare(sql: string) {
      sqlCalls.push(sql);
      return {
        bind(...values: unknown[]) {
          void values;
          return {
            all: () => sql.includes("SELECT payment_attempts.id") ? { results: [attempt] } : { results: [] },
            first: () => {
              if (sql.includes("FROM payment_credentials")) return { ...encrypted, credentialId: "credential-a", integrationId: "integration-a", keyVersion: "v1", shopId: "shop-a", status: "active" };
              if (sql.includes("SELECT reconcile_attempts")) return { attempts: 0 };
              return null;
            },
            run: () => ({ meta: { changes: 1 } }),
          };
        },
      };
    },
  };
  const status = {
    amount: 100_000,
    amountPaid: 100_000,
    amountRemaining: 0,
    currency: "VND",
    description: "SELINOW000111",
    id: "link-a",
    orderCode: providerOrderCode,
    status: "PAID",
    transactions: [{ description: "SELINOW000111", reference: "reference-a", transactionDateTime: NOW.toISOString() }],
  };
  const signature = await createPayOSObjectSignature(status, "checksum-key-test");
  const fetcher = vi.fn(() => new Response(JSON.stringify({ code: "00", data: status, signature }), { headers: { "Content-Type": "application/json" }, status: 200 }));
  const env = { CREDENTIAL_KEK_V1: KEK, PLATFORM_DB: database } as unknown as AppBindings;
  return { env, fetcher, sqlCalls, status };
}

describe("payment reconciliation identity", () => {
  beforeEach(() => {
    mocked.processPayOSWebhook.mockReset();
    vi.restoreAllMocks();
  });

  it("preserves the order code from the provider-signed status", () => {
    const normalized = normalizeReconciliation({
      amount: 100_000,
      amountPaid: 100_000,
      amountRemaining: 0,
      currency: "VND",
      description: "SELINOW000222",
      id: "link-a",
      orderCode: 222,
      status: "PAID",
      transactions: [],
    });

    expect(normalized.orderCode).toBe(222);
    expect(normalized.currency).toBe("VND");
  });

  it("uses the latest transaction evidence for a cumulative payment", () => {
    const early = NOW.toISOString();
    const late = new Date(NOW.getTime() + 10 * 60_000).toISOString();
    const normalized = normalizeReconciliation({
      amount: 100_000,
      amountPaid: 100_000,
      amountRemaining: 0,
      currency: "VND",
      description: "SELINOW000111",
      id: "link-a",
      orderCode: 111,
      status: "PAID",
      transactions: [
        { description: "SELINOW000111", reference: "reference-early", transactionDateTime: early },
        { description: "SELINOW000111", reference: "reference-late", transactionDateTime: late },
      ],
    });

    expect(normalized.occurredAt).toBe(late);
    expect(normalized.reference).toBe("reference-late");
    expect(decidePayment({
      ...normalized,
      expectedAmount: 100_000,
      expectedCurrency: "VND",
      expectedDescription: "SELINOW000111",
      expectedPaymentLinkId: "link-a",
      providerOrderCode: 111,
      reservationExpiresAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
      paymentLinkId: normalized.paymentLinkId,
    })).toBe("late");
  });

  it("does not treat an incomplete PAID transaction list as actionable", () => {
    const normalized = normalizeReconciliation({
      amount: 100_000,
      amountPaid: 100_000,
      amountRemaining: 0,
      currency: "VND",
      description: "SELINOW000111",
      id: "link-a",
      orderCode: 111,
      status: "PAID",
      transactions: [{ description: "SELINOW000111", reference: "reference-a" }],
    });

    expect(normalized.success).toBe(false);
  });

  it("rejects a signed status for a different order before webhook processing", async () => {
    const runtime = await reconciliationEnvironment(222);
    vi.stubGlobal("fetch", runtime.fetcher);

    await expect(reconcilePendingPayments(runtime.env, NOW)).resolves.toEqual({ failed: 1, processed: 0 });
    expect(runtime.fetcher).toHaveBeenCalledTimes(1);
    expect(mocked.processPayOSWebhook).not.toHaveBeenCalled();
    expect(runtime.sqlCalls.some((sql) => sql.includes("INSERT INTO payment_events"))).toBe(false);
  });

  it("forwards the provider order code when the status identity matches", async () => {
    const runtime = await reconciliationEnvironment(111);
    mocked.processPayOSWebhook.mockResolvedValue({ duplicate: false, processed: true, state: "paid_exact" });
    vi.stubGlobal("fetch", runtime.fetcher);

    await expect(reconcilePendingPayments(runtime.env, NOW)).resolves.toEqual({ failed: 0, processed: 1 });
    expect(mocked.processPayOSWebhook).toHaveBeenCalledTimes(1);
    const call = mocked.processPayOSWebhook.mock.calls[0]?.[0] as { body: { data: { currency: string; orderCode: number } } };
    expect(call.body.data.orderCode).toBe(111);
    expect(call.body.data.currency).toBe("VND");
  });
});

describe("payment exception evidence projection", () => {
  it("keeps only allowlisted, render-safe fields", () => {
    expect(parsePaymentExceptionEvidence(JSON.stringify({
      amount: 97_000,
      expectedAmount: 100_000,
      occurredAt: "2026-07-29T01:02:03.000Z",
      expectedKeys: 2,
      reservedKeys: 1,
      reference: "provider-reference-must-not-escape",
      providerPayload: { checksumKey: "secret" },
    }))).toEqual({
      expectedAmount: 100_000,
      expectedKeys: 2,
      occurredAt: "2026-07-29T01:02:03.000Z",
      receivedAmount: 97_000,
      reservedKeys: 1,
    });
  });

  it("drops malformed values and invalid JSON without throwing", () => {
    expect(parsePaymentExceptionEvidence(JSON.stringify({
      amount: -1,
      expectedAmount: 1.5,
      occurredAt: "1",
      expectedKeys: "2",
      reservedKeys: Number.MAX_SAFE_INTEGER + 1,
    }))).toEqual({ expectedAmount: null, expectedKeys: null, occurredAt: null, receivedAmount: null, reservedKeys: null });
    expect(parsePaymentExceptionEvidence("not-json")).toEqual({ expectedAmount: null, expectedKeys: null, occurredAt: null, receivedAmount: null, reservedKeys: null });
  });
});
