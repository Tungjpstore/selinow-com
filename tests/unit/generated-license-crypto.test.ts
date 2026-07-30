import { describe, expect, it } from "vitest";

import {
  decryptGeneratedLicenseArtifact,
  decryptGeneratedLicenseProviderSecrets,
  encryptGeneratedLicenseArtifact,
  encryptGeneratedLicenseProviderSecrets,
} from "../../src/lib/commerce/generated-license-crypto";

const CREDENTIAL_KEK = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const INVENTORY_KEK = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function base64UrlBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

describe("generated-license crypto", () => {
  it("encrypts provider endpoint and credential with tenant, connection, record and field AAD", async () => {
    const context = {
      credentialId: "credential-a",
      connectionId: "connection-a",
      hmacSecret: "fingerprint-secret",
      keyVersion: "v1",
      kek: CREDENTIAL_KEK,
      shopId: "shop-a",
    };
    const encrypted = await encryptGeneratedLicenseProviderSecrets({
      ...context,
      endpoint: "https://seller.example.test/api",
      credential: "seller-secret-value",
    });

    await expect(decryptGeneratedLicenseProviderSecrets(encrypted, context)).resolves.toEqual({
      endpoint: "https://seller.example.test/api",
      credential: "seller-secret-value",
    });
    expect(base64UrlBytes(encrypted.endpointIvB64)).toHaveLength(12);
    expect(base64UrlBytes(encrypted.credentialIvB64)).toHaveLength(12);
    expect(encrypted.endpointFingerprint).toHaveLength(43);
    expect(encrypted.credentialFingerprint).toHaveLength(43);
    expect(JSON.stringify(encrypted)).not.toContain("seller-secret-value");
    expect(JSON.stringify(encrypted)).not.toContain("seller.example.test");

    await expect(decryptGeneratedLicenseProviderSecrets(encrypted, { ...context, shopId: "shop-b" })).rejects.toMatchObject({ code: "credential_decryption_failed" });
    await expect(decryptGeneratedLicenseProviderSecrets(encrypted, { ...context, connectionId: "connection-b" })).rejects.toMatchObject({ code: "credential_decryption_failed" });
    await expect(decryptGeneratedLicenseProviderSecrets(encrypted, { ...context, credentialId: "credential-b" })).rejects.toMatchObject({ code: "credential_decryption_failed" });
  });

  it("keeps provider fingerprints stable while scoping them to the connection", async () => {
    const input = {
      credential: "same-secret",
      credentialId: "credential-a",
      connectionId: "connection-a",
      endpoint: "https://seller.example.test/api",
      hmacSecret: "fingerprint-secret",
      keyVersion: "v1",
      kek: CREDENTIAL_KEK,
      shopId: "shop-a",
    };
    const first = await encryptGeneratedLicenseProviderSecrets(input);
    const second = await encryptGeneratedLicenseProviderSecrets(input);
    const otherConnection = await encryptGeneratedLicenseProviderSecrets({ ...input, connectionId: "connection-b" });

    expect(first.endpointFingerprint).toBe(second.endpointFingerprint);
    expect(first.credentialFingerprint).toBe(second.credentialFingerprint);
    expect(first.endpointCiphertextB64).not.toBe(second.endpointCiphertextB64);
    expect(first.credentialCiphertextB64).not.toBe(second.credentialCiphertextB64);
    expect(first.endpointFingerprint).not.toBe(otherConnection.endpointFingerprint);
    expect(first.credentialFingerprint).not.toBe(otherConnection.credentialFingerprint);
  });

  it("fails closed when provider ciphertext uses another exact key version", async () => {
    const encrypted = await encryptGeneratedLicenseProviderSecrets({
      credential: "seller-secret-value",
      credentialId: "credential-a",
      connectionId: "connection-a",
      endpoint: "https://seller.example.test/api",
      hmacSecret: "fingerprint-secret",
      keyVersion: "v1",
      kek: CREDENTIAL_KEK,
      shopId: "shop-a",
    });

    await expect(decryptGeneratedLicenseProviderSecrets(encrypted, {
      credentialId: "credential-a",
      connectionId: "connection-a",
      keyVersion: "v2",
      kek: CREDENTIAL_KEK,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "credential_decryption_failed" });
    await expect(decryptGeneratedLicenseProviderSecrets(encrypted, {
      credentialId: "credential-a",
      connectionId: "connection-a",
      keyVersion: "v1",
      kek: INVENTORY_KEK,
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "credential_decryption_failed" });
  });

  it("encrypts generated artifacts with inventory KEK and format-bound AAD", async () => {
    const context = {
      artifactId: "artifact-a",
      hmacSecret: "fingerprint-secret",
      keyVersion: "v2",
      kek: INVENTORY_KEK,
      requestId: "request-a",
      shopId: "shop-a",
    };
    const encrypted = await encryptGeneratedLicenseArtifact({
      ...context,
      format: "json",
      plaintext: JSON.stringify({ license: "generated-secret" }),
    });

    await expect(decryptGeneratedLicenseArtifact(encrypted, context)).resolves.toBe(JSON.stringify({ license: "generated-secret" }));
    expect(base64UrlBytes(encrypted.ivB64)).toHaveLength(12);
    expect(encrypted.artifactFingerprint).toHaveLength(43);
    expect(JSON.stringify(encrypted)).not.toContain("generated-secret");

    await expect(decryptGeneratedLicenseArtifact(encrypted, { ...context, shopId: "shop-b" })).rejects.toMatchObject({ code: "inventory_decryption_failed" });
    await expect(decryptGeneratedLicenseArtifact(encrypted, { ...context, requestId: "request-b" })).rejects.toMatchObject({ code: "inventory_decryption_failed" });
    await expect(decryptGeneratedLicenseArtifact(encrypted, { ...context, artifactId: "artifact-b" })).rejects.toMatchObject({ code: "inventory_decryption_failed" });
    await expect(decryptGeneratedLicenseArtifact({ ...encrypted, format: "text" }, context)).rejects.toMatchObject({ code: "inventory_decryption_failed" });
  });

  it("scopes artifact fingerprints to the request and representation", async () => {
    const input = {
      artifactId: "artifact-a",
      format: "text" as const,
      hmacSecret: "fingerprint-secret",
      keyVersion: "v1",
      kek: INVENTORY_KEK,
      plaintext: "same-license",
      requestId: "request-a",
      shopId: "shop-a",
    };
    const first = await encryptGeneratedLicenseArtifact(input);
    const second = await encryptGeneratedLicenseArtifact(input);
    const otherRequest = await encryptGeneratedLicenseArtifact({ ...input, requestId: "request-b" });
    const otherFormat = await encryptGeneratedLicenseArtifact({ ...input, format: "json" });

    expect(first.artifactFingerprint).toBe(second.artifactFingerprint);
    expect(first.ciphertextB64).not.toBe(second.ciphertextB64);
    expect(first.artifactFingerprint).not.toBe(otherRequest.artifactFingerprint);
    expect(first.artifactFingerprint).not.toBe(otherFormat.artifactFingerprint);
  });

  it("rejects malformed encryption configuration without exposing plaintext", async () => {
    await expect(encryptGeneratedLicenseArtifact({
      artifactId: "artifact-a",
      format: "text",
      hmacSecret: "fingerprint-secret",
      keyVersion: "v1",
      kek: "not-a-key",
      plaintext: "secret",
      requestId: "request-a",
      shopId: "shop-a",
    })).rejects.toMatchObject({ code: "configuration_invalid" });
  });
});
