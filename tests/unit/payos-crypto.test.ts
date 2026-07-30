import { describe, expect, it } from "vitest";

import { decryptPayOSCredentials, encryptPayOSCredentials } from "../../src/lib/payments/crypto";
import { createPaymentRequestSignature, createPayOSObjectSignature, PayOSClient, verifyPayOSWebhook } from "../../src/lib/payments/payos";

const KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("PayOS crypto contract", () => {
  it("invokes the fetch dependency without rebinding its receiver", async () => {
    const credentials = { apiKey: "api-key-test", checksumKey: "checksum-test-key", clientId: "client-id-test" };
    const fetcher = function (this: unknown): Promise<Response> {
      expect(this).toBeUndefined();
      return Promise.resolve(new Response(JSON.stringify({ code: "00", data: true }), { status: 200 }));
    } as typeof fetch;

    await expect(new PayOSClient(credentials, fetcher).confirmWebhook("https://api.example.test/webhooks/payos/test")).resolves.toBeUndefined();
  });

  it("matches the official payment request canonical field order", async () => {
    await expect(createPaymentRequestSignature({
      amount: 10_000,
      cancelUrl: "https://shop.test/cancel",
      description: "SELINOW123456",
      orderCode: 123_456,
      returnUrl: "https://shop.test/return",
    }, "checksum-test-key")).resolves.toBe("36fc4974a145c5e0bfa7e3aeb8f6361f8fe88fcb0faea7f63380b2e82647282f");
  });

  it("sorts webhook fields and verifies HMAC-SHA256", async () => {
    const data = { transactionDateTime: "2026-07-25T00:00:00Z", reference: "FT123", orderCode: 123_456, description: "SELINOW123456", amount: 10_000 };
    const signature = await createPayOSObjectSignature(data, "checksum-test-key");
    expect(signature).toBe("9bec25b1488374d42fba3fe460b5d07d6d458a8294010ad72bd568a9e14abc48");
    await expect(verifyPayOSWebhook(data, signature, "checksum-test-key")).resolves.toBe(true);
    await expect(verifyPayOSWebhook({ ...data, amount: 9_999 }, signature, "checksum-test-key")).resolves.toBe(false);
  });

  it("encrypts each credential with field and tenant-bound AAD", async () => {
    const context = { credentialId: "credential-a", hmacSecret: "fingerprint-test", integrationId: "integration-a", kek: KEK, keyVersion: "v1", shopId: "shop-a" };
    const encrypted = await encryptPayOSCredentials({ apiKey: "api-key-test", checksumKey: "checksum-test", clientId: "client-test" }, context);
    await expect(decryptPayOSCredentials(encrypted, context)).resolves.toEqual({ apiKey: "api-key-test", checksumKey: "checksum-test", clientId: "client-test" });
    await expect(decryptPayOSCredentials(encrypted, { ...context, shopId: "shop-b" })).rejects.toMatchObject({ code: "credential_decryption_failed" });
    expect(JSON.stringify(encrypted)).not.toContain("api-key-test");
  });

  it("sends merchant headers and rejects an unsigned provider response", async () => {
    const credentials = { apiKey: "api-key-test", checksumKey: "checksum-test-key", clientId: "client-id-test" };
    const fetcher: typeof fetch = (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-client-id")).toBe(credentials.clientId);
      expect(headers.get("x-api-key")).toBe(credentials.apiKey);
      return Promise.resolve(new Response(JSON.stringify({ code: "00", data: { accountName: "Test", accountNumber: "12345678", amount: 10_000, bin: "9704", checkoutUrl: "https://pay.payos.vn/web/test", currency: "VND", description: "SELINOW123456", orderCode: 123_456, paymentLinkId: "test", qrCode: "qr", status: "PENDING" }, signature: "invalid" }), { headers: { "Content-Type": "application/json" }, status: 200 }));
    };
    const client = new PayOSClient(credentials, fetcher);
    await expect(client.createPaymentLink({ amount: 10_000, cancelUrl: "https://shop.test/cancel", description: "SELINOW123456", expiredAt: 1_800_000_000, orderCode: 123_456, returnUrl: "https://shop.test/return" })).rejects.toMatchObject({ code: "provider_signature_invalid" });
  });
});
