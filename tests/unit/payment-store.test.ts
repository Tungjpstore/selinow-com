import { describe, expect, it } from "vitest";

import { encryptPayOSCredentials } from "../../src/lib/payments/crypto";
import { createPayOSObjectSignature } from "../../src/lib/payments/payos";
import { createOrRecoverTelegramPaymentLink } from "../../src/lib/payments/store";
import type { AppBindings } from "../../src/lib/platform/bindings";

const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
type Attempt = {
  cancelOrigin: string | null;
  checkoutDomainId: string | null;
  checkoutUrl: string | null;
  credentialId: string;
  currency: string;
  expectedAmountMinor: number;
  expectedDescription: string;
  expiresAt: string;
  id: string;
  leaseExpiresAt: string | null;
  leaseToken: string | null;
  nextReconcileAt: string | null;
  paymentLinkId: string | null;
  providerOrderCode: number;
  qrCode: string | null;
  returnOrigin: string | null;
  reconcileAttempts: number;
  shopId: string;
  state: string;
};

type ProviderBindingOverride = Partial<{
  amount: number;
  checkoutUrl: string;
  currency: string;
  description: string;
  id: string;
  orderCode: number;
  paymentLinkId: string;
}>;

async function paymentEnvironment(options: { concurrentWinner?: boolean; concurrentWinnerCheckoutUrl?: string; errorDueAt?: string; existingError?: boolean; existingLease?: boolean; orderCurrency?: string; pauseCreatingReread?: boolean; pauseProviderCreate?: boolean; providerCreateOverride?: ProviderBindingOverride; providerGetFails?: boolean; providerRecoveryOverride?: ProviderBindingOverride } = {}) {
  const context = {
    credentialId: "credential-a",
    hmacSecret: "identifier-secret",
    integrationId: "integration-a",
    kek: KEK,
    keyVersion: "v1",
    shopId: "shop-a",
  };
  const encrypted = await encryptPayOSCredentials({
    apiKey: "api-key-test",
    checksumKey: "checksum-key-test",
    clientId: "client-id-test",
  }, context);
  let attempt: Attempt | null = null;
  if (options.existingError === true) {
    attempt = {
      cancelOrigin: "https://primary.customer.com",
      checkoutDomainId: "domain-primary",
      checkoutUrl: null,
      credentialId: "credential-a",
      currency: "VND",
      expectedAmountMinor: 100_000,
      expectedDescription: "SEL123456",
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      id: "attempt-error",
      leaseExpiresAt: options.existingLease === true ? new Date(Date.now() + 60_000).toISOString() : null,
      leaseToken: options.existingLease === true ? "existing-lease" : null,
      nextReconcileAt: options.errorDueAt ?? new Date(Date.now() - 1_000).toISOString(),
      paymentLinkId: null,
      providerOrderCode: 123456,
      qrCode: null,
      reconcileAttempts: 2,
      returnOrigin: "https://primary.customer.com",
      shopId: "shop-a",
      state: "error",
    };
  }
  let providerCalls = 0;
  let insertSql = "";
  let providerRequest: Record<string, unknown> | null = null;
  let creatingReads = 0;
  let resolveCreatingReread: (() => void) | undefined;
  let resolveProviderCreate: (() => void) | undefined;
  let releaseCreatingReread: (() => void) | undefined;
  let releaseProviderCreate: (() => void) | undefined;
  const creatingRereadEntered = new Promise<void>((resolve) => { resolveCreatingReread = resolve; });
  const providerCreateEntered = new Promise<void>((resolve) => { resolveProviderCreate = resolve; });
  const creatingRereadReleased = new Promise<void>((resolve) => { releaseCreatingReread = resolve; });
  const providerCreateReleased = new Promise<void>((resolve) => { releaseProviderCreate = resolve; });

  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first() {
              if (sql.includes("source_channel = 'telegram'")) {
                return Promise.resolve({
                  currency: options.orderCurrency ?? "VND",
                  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
                  id: "order-a",
                  orderPublicId: "order-public-a",
                  orderTokenHash: "unused",
                  paymentStatus: "unpaid",
                  shopId: "shop-a",
                  status: "pending_payment",
                  totalMinor: 100_000,
                });
              }
              if (sql.includes("FROM payment_integrations") && !sql.includes("UPDATE")) {
                return Promise.resolve({ activeCredentialId: "credential-a", id: "integration-a", publicId: "payos-public-a" });
              }
              if (sql.includes("FROM payment_credentials")) {
                return Promise.resolve({
                  ...encrypted,
                  credentialId: "credential-a",
                  integrationId: "integration-a",
                  keyVersion: "v1",
                  shopId: "shop-a",
                  status: "active",
                });
              }
              if (sql.includes("FROM payment_attempts")) {
                if (attempt?.state === "creating") {
                  creatingReads += 1;
                  if (options.pauseCreatingReread === true && creatingReads === 2) {
                    resolveCreatingReread?.();
                    return creatingRereadReleased.then(() => attempt);
                  }
                }
                return Promise.resolve(attempt);
              }
              return Promise.resolve(null);
            },
            run() {
              if (sql.includes("SET lease_token = ?")) {
                if (attempt?.leaseToken !== null && attempt?.leaseToken !== undefined
                  && attempt.leaseExpiresAt !== null && attempt.leaseExpiresAt > (typeof values[6] === "string" ? values[6] : "")) {
                  return Promise.resolve({ meta: { changes: 0 } });
                }
                if (attempt !== null) {
                  attempt = { ...attempt, leaseExpiresAt: String(values[1]), leaseToken: String(values[0]) };
                }
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("SET reconcile_attempts = ?")) {
                if (attempt !== null && attempt.leaseToken === String(values[6])) {
                  attempt = { ...attempt, leaseExpiresAt: null, leaseToken: null, nextReconcileAt: String(values[1]), reconcileAttempts: Number(values[0]) };
                  return Promise.resolve({ meta: { changes: 1 } });
                }
                return Promise.resolve({ meta: { changes: 0 } });
              }
              if (sql.includes("INSERT INTO payment_attempts")) {
                insertSql = sql;
                const next: Attempt = {
                  cancelOrigin: "https://primary.customer.com",
                  checkoutDomainId: "domain-primary",
                  checkoutUrl: options.concurrentWinner === true ? options.concurrentWinnerCheckoutUrl ?? "https://pay.payos.vn/web/winner" : null,
                  credentialId: "credential-a",
                  currency: String(values[7]),
                  expectedAmountMinor: Number(values[6]),
                  expectedDescription: String(values[8]),
                  expiresAt: String(values[9]),
                  id: options.concurrentWinner === true ? "attempt-winner" : String(values[0]),
                  leaseExpiresAt: null,
                  leaseToken: null,
                  nextReconcileAt: null,
                  paymentLinkId: options.concurrentWinner === true ? "winner" : null,
                  providerOrderCode: Number(values[5]),
                  qrCode: null,
                  reconcileAttempts: 0,
                  returnOrigin: "https://primary.customer.com",
                  shopId: "shop-a",
                  state: options.concurrentWinner === true ? "pending" : "creating",
                };
                attempt = next;
                if (options.concurrentWinner === true) throw new Error("unique_order_attempt");
                return Promise.resolve({ meta: { changes: 1 } });
              }
              if (sql.includes("UPDATE payment_attempts SET provider_payment_link_id")) {
                if (attempt !== null) {
                  attempt = {
                    ...attempt,
                    checkoutUrl: String(values[2]),
                    paymentLinkId: String(values[0]),
                    qrCode: String(values[3]),
                    leaseExpiresAt: null,
                    leaseToken: null,
                    nextReconcileAt: String(values[4]),
                    reconcileAttempts: attempt.reconcileAttempts,
                    state: "pending",
                  };
                }
                return Promise.resolve({ meta: { changes: 1 } });
              }
              return Promise.resolve({ meta: { changes: 1 } });
            },
          };
        },
      };
    },
    batch(statements: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };

  const fetcher: typeof fetch = async (_input, init) => {
    providerCalls += 1;
    if (typeof init?.body !== "string") {
      if (options.providerGetFails === true) return new Response(JSON.stringify({ code: "01", desc: "provider unavailable" }), { status: 503 });
      const data = {
        amount: attempt?.expectedAmountMinor ?? 100_000,
        amountPaid: 0,
        amountRemaining: attempt?.expectedAmountMinor ?? 100_000,
        currency: attempt?.currency ?? "VND",
        description: attempt?.expectedDescription ?? "SEL123456",
        id: "recovered-link",
        orderCode: attempt?.providerOrderCode ?? 123456,
        status: "PENDING",
        transactions: [],
        ...options.providerRecoveryOverride,
      };
      const signature = await createPayOSObjectSignature(data, "checksum-key-test");
      return new Response(JSON.stringify({ code: "00", data, signature }), { status: 200 });
    }
    if (options.pauseProviderCreate === true) {
      resolveProviderCreate?.();
      await providerCreateReleased;
    }
    const parsedRequest = JSON.parse(init.body) as Record<string, unknown>;
    providerRequest = parsedRequest;
    const orderCode = Number(parsedRequest.orderCode);
    const data = {
      accountName: "Test merchant",
      accountNumber: "123456789",
      amount: 100_000,
      bin: "9704",
      checkoutUrl: "https://pay.payos.vn/web/created",
      currency: "VND",
      description: parsedRequest.description,
      orderCode,
      paymentLinkId: "created",
      qrCode: "qr-created",
      status: "PENDING",
      ...options.providerCreateOverride,
    };
    const signature = await createPayOSObjectSignature(data, "checksum-key-test");
    return new Response(JSON.stringify({ code: "00", data, signature }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    });
  };

  const env = {
    APP_ENV: "staging",
    CREDENTIAL_KEK_V1: KEK,
    IDENTIFIER_HMAC_SECRET: "identifier-secret",
    PLATFORM_DB: database,
  } as unknown as AppBindings;

  return {
    env,
    fetcher,
    getAttempt: () => attempt,
    getInsertSql: () => insertSql,
    getProviderCalls: () => providerCalls,
    getProviderRequest: () => providerRequest,
    releaseCreatingReread: () => { releaseCreatingReread?.(); },
    releaseProviderCreate: () => { releaseProviderCreate?.(); },
    waitForCreatingReread: () => creatingRereadEntered,
    waitForProviderCreate: () => providerCreateEntered,
  };
}

describe("payment origin snapshots", () => {
  it("rejects a non-VND PayOS handoff before attempt creation or provider access", async () => {
    const runtime = await paymentEnvironment({ orderCurrency: "USD" });

    await expect(createOrRecoverTelegramPaymentLink({
      customerId: "customer-a",
      env: runtime.env,
      fetcher: runtime.fetcher,
      orderPublicId: "order-public-a",
      origin: "https://alias.customer.com",
      shopId: "shop-a",
    })).rejects.toMatchObject({
      code: "payment_currency_unsupported",
      issues: ["payos_currency_unsupported"],
      status: 409,
    });
    expect(runtime.getInsertSql()).toBe("");
    expect(runtime.getAttempt()).toBeNull();
    expect(runtime.getProviderCalls()).toBe(0);
  });

  it("authorizes the entry hostname but snapshots the active canonical domain", async () => {
    const runtime = await paymentEnvironment();
    const link = await createOrRecoverTelegramPaymentLink({
      customerId: "customer-a",
      env: runtime.env,
      fetcher: runtime.fetcher,
      orderPublicId: "order-public-a",
      origin: "https://alias.customer.com",
      shopId: "shop-a",
    });

    expect(link.checkoutUrl).toBe("https://pay.payos.vn/web/created");
    expect(runtime.getInsertSql()).toContain("request_domain.hostname_normalized = ?");
    expect(runtime.getInsertSql()).toContain("request_domain.type = 'platform_subdomain'");
    expect(runtime.getInsertSql()).toContain("request_domain.ownership_verified_at IS NOT NULL");
    expect(runtime.getInsertSql()).toContain("canonical_domain.id = shops.canonical_domain_id");
    expect(runtime.getInsertSql()).toContain("canonical_domain.type = 'platform_subdomain'");
    expect(runtime.getInsertSql()).toContain("canonical_domain.ownership_verified_at IS NOT NULL");
    expect(runtime.getAttempt()).toMatchObject({
      checkoutDomainId: "domain-primary",
      returnOrigin: "https://primary.customer.com",
      cancelOrigin: "https://primary.customer.com",
    });
    expect(runtime.getProviderRequest()).toMatchObject({
      cancelUrl: "https://primary.customer.com/orders/order-public-a?payment=cancel",
      returnUrl: "https://primary.customer.com/orders/order-public-a?payment=return",
    });
  });

  it.each([
    ["amount", { amount: 99_999 }],
    ["currency", { currency: "USD" }],
    ["description", { description: "WRONG" }],
    ["orderCode", { orderCode: 654321 }],
    ["paymentLinkId", { paymentLinkId: "unsafe/link" }],
    ["checkoutUrl", { checkoutUrl: "https://example.test/not-payos" }],
  ] as const)("does not persist a signed create response with mismatched %s", async (_field, providerCreateOverride) => {
    const runtime = await paymentEnvironment({ providerCreateOverride });

    await expect(createOrRecoverTelegramPaymentLink({
      customerId: "customer-a",
      env: runtime.env,
      fetcher: runtime.fetcher,
      orderPublicId: "order-public-a",
      origin: "https://alias.customer.com",
      shopId: "shop-a",
    })).resolves.toMatchObject({
      checkoutUrl: "https://pay.payos.vn/web/recovered-link",
      state: "pending",
    });
    expect(runtime.getProviderCalls()).toBe(2);
    expect(runtime.getAttempt()).toMatchObject({
      checkoutUrl: "https://pay.payos.vn/web/recovered-link",
      paymentLinkId: "recovered-link",
      state: "pending",
    });
  });

  it.each([
    ["amount", { amount: 99_999 }],
    ["currency", { currency: "USD" }],
    ["description", { description: "WRONG" }],
    ["orderCode", { orderCode: 654321 }],
    ["paymentLinkId", { id: "unsafe/link" }],
  ] as const)("rejects a signed recovery response with mismatched %s", async (_field, providerRecoveryOverride) => {
    const runtime = await paymentEnvironment({ existingError: true, providerRecoveryOverride });

    await expect(createOrRecoverTelegramPaymentLink({
      customerId: "customer-a",
      env: runtime.env,
      fetcher: runtime.fetcher,
      orderPublicId: "order-public-a",
      origin: "https://alias.customer.com",
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "provider_identity_mismatch", status: 409 });
    expect(runtime.getProviderCalls()).toBe(1);
    expect(runtime.getAttempt()).toMatchObject({ checkoutUrl: null, leaseToken: null, state: "error" });
  });

  it("rejects an unsafe persisted PayOS checkout URL before rendering", async () => {
    const runtime = await paymentEnvironment({
      concurrentWinner: true,
      concurrentWinnerCheckoutUrl: "https://example.test/not-payos",
    });

    await expect(createOrRecoverTelegramPaymentLink({
      customerId: "customer-a",
      env: runtime.env,
      fetcher: runtime.fetcher,
      orderPublicId: "order-public-a",
      origin: "https://alias.customer.com",
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "provider_identity_mismatch", status: 409 });
    expect(runtime.getProviderCalls()).toBe(0);
  });

  it("recovers the concurrent winning attempt instead of creating a second provider link", async () => {
    const runtime = await paymentEnvironment({ concurrentWinner: true });
    const link = await createOrRecoverTelegramPaymentLink({
      customerId: "customer-a",
      env: runtime.env,
      fetcher: runtime.fetcher,
      orderPublicId: "order-public-a",
      origin: "https://alias.customer.com",
      shopId: "shop-a",
    });

    expect(link).toMatchObject({
      checkoutUrl: "https://pay.payos.vn/web/winner",
      paymentAttemptId: "attempt-winner",
      state: "pending",
    });
    expect(runtime.getProviderCalls()).toBe(0);
  });

  it("does not query PayOS while a creating winner is still publishing its link", async () => {
    const runtime = await paymentEnvironment({ pauseProviderCreate: true });
    const input = {
      customerId: "customer-a",
      env: runtime.env,
      fetcher: runtime.fetcher,
      orderPublicId: "order-public-a",
      origin: "https://alias.customer.com",
      shopId: "shop-a",
    };
    const winner = createOrRecoverTelegramPaymentLink(input);
    await runtime.waitForProviderCreate();

    await expect(createOrRecoverTelegramPaymentLink(input)).rejects.toMatchObject({ code: "payment_pending", status: 409 });
    expect(runtime.getProviderCalls()).toBe(1);

    runtime.releaseProviderCreate();
    await expect(winner).resolves.toMatchObject({ checkoutUrl: "https://pay.payos.vn/web/created", state: "pending" });
  });

  it("returns the winner when creating transitions to pending during the bounded reread", async () => {
    const runtime = await paymentEnvironment({ pauseCreatingReread: true, pauseProviderCreate: true });
    const input = {
      customerId: "customer-a",
      env: runtime.env,
      fetcher: runtime.fetcher,
      orderPublicId: "order-public-a",
      origin: "https://alias.customer.com",
      shopId: "shop-a",
    };
    const winner = createOrRecoverTelegramPaymentLink(input);
    await runtime.waitForProviderCreate();
    const loser = createOrRecoverTelegramPaymentLink(input);
    await runtime.waitForCreatingReread();

    runtime.releaseProviderCreate();
    const winningLink = await winner;
    runtime.releaseCreatingReread();

    await expect(loser).resolves.toEqual(winningLink);
    expect(runtime.getProviderCalls()).toBe(1);
  });

  it("does not recover an error attempt before its durable retry time", async () => {
    const runtime = await paymentEnvironment({
      errorDueAt: new Date(Date.now() + 60_000).toISOString(),
      existingError: true,
    });
    await expect(createOrRecoverTelegramPaymentLink({
      customerId: "customer-a",
      env: runtime.env,
      fetcher: runtime.fetcher,
      orderPublicId: "order-public-a",
      origin: "https://alias.customer.com",
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "payment_pending", status: 409 });
    expect(runtime.getProviderCalls()).toBe(0);
    expect(runtime.getAttempt()).toMatchObject({ leaseToken: null });
  });

  it("allows only one concurrent due recovery to call PayOS", async () => {
    const runtime = await paymentEnvironment({ existingError: true });
    const input = {
      customerId: "customer-a",
      env: runtime.env,
      fetcher: runtime.fetcher,
      orderPublicId: "order-public-a",
      origin: "https://alias.customer.com",
      shopId: "shop-a",
    };
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => createOrRecoverTelegramPaymentLink(input)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(9);
    expect(runtime.getProviderCalls()).toBe(1);
    expect(runtime.getAttempt()).toMatchObject({ leaseToken: null, state: "pending" });
  });

  it("does not call PayOS while another recovery lease is active", async () => {
    const runtime = await paymentEnvironment({ existingError: true, existingLease: true });
    await expect(createOrRecoverTelegramPaymentLink({
      customerId: "customer-a",
      env: runtime.env,
      fetcher: runtime.fetcher,
      orderPublicId: "order-public-a",
      origin: "https://alias.customer.com",
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "payment_pending", status: 409 });
    expect(runtime.getProviderCalls()).toBe(0);
  });

  it("releases a due recovery lease with bounded backoff after provider failure", async () => {
    const runtime = await paymentEnvironment({ existingError: true, providerGetFails: true });
    await expect(createOrRecoverTelegramPaymentLink({
      customerId: "customer-a",
      env: runtime.env,
      fetcher: runtime.fetcher,
      orderPublicId: "order-public-a",
      origin: "https://alias.customer.com",
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "provider_unavailable", status: 503 });
    expect(runtime.getProviderCalls()).toBe(1);
    expect(runtime.getAttempt()).toMatchObject({ leaseToken: null, state: "error" });
    expect(Date.parse(runtime.getAttempt()?.nextReconcileAt ?? "")).toBeGreaterThan(Date.now());
  });
});
