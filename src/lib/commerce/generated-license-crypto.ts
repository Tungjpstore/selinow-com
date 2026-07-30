import { hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";
import { toBase64Url } from "../core/ids";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const IV_BYTES = 12;
const TAG_LENGTH = 128;
const PROVIDER_PURPOSE = "generated-license-provider-secret:v1";
const ARTIFACT_PURPOSE = "generated-license-artifact:v1";

type EncryptedValue = {
  ciphertextB64: string;
  ivB64: string;
};

function fromBase64Url(value: string, errorCode: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new AppError(errorCode, 500);
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return new Uint8Array(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    throw new AppError(errorCode, 500);
  }
}

async function importAesKey(kek: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(kek, "configuration_invalid");
  if (bytes.byteLength !== 32) throw new AppError("configuration_invalid", 500);
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["decrypt", "encrypt"]);
}

function providerAad(input: { shopId: string; connectionId: string; credentialId: string; keyVersion: string }, field: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${PROVIDER_PURPOSE}\0${input.keyVersion}\0${input.shopId}\0${input.connectionId}\0${input.credentialId}\0${field}`);
}

function artifactAad(input: { shopId: string; requestId: string; artifactId: string; keyVersion: string; format: string }): Uint8Array<ArrayBuffer> {
  return encoder.encode(`${ARTIFACT_PURPOSE}\0${input.keyVersion}\0${input.shopId}\0${input.requestId}\0${input.artifactId}\0${input.format}`);
}

async function encryptValue(value: string, key: CryptoKey, additionalData: Uint8Array<ArrayBuffer>): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ additionalData, iv, name: "AES-GCM", tagLength: TAG_LENGTH }, key, encoder.encode(value));
  return { ciphertextB64: toBase64Url(new Uint8Array(ciphertext)), ivB64: toBase64Url(iv) };
}

async function decryptValue(input: EncryptedValue, key: CryptoKey, additionalData: Uint8Array<ArrayBuffer>, failureCode: string): Promise<string> {
  try {
    const iv = fromBase64Url(input.ivB64, failureCode);
    if (iv.byteLength !== IV_BYTES) throw new AppError(failureCode, 500);
    const ciphertext = fromBase64Url(input.ciphertextB64, failureCode);
    const plaintext = await crypto.subtle.decrypt({ additionalData, iv, name: "AES-GCM", tagLength: TAG_LENGTH }, key, ciphertext);
    return decoder.decode(plaintext);
  } catch (error) {
    if (error instanceof AppError && error.code === "configuration_invalid") throw error;
    throw new AppError(failureCode, 500);
  }
}

export type GeneratedLicenseProviderSecrets = {
  endpoint: string;
  credential: string;
};

export type GeneratedLicenseProviderSecretsContext = {
  shopId: string;
  connectionId: string;
  credentialId: string;
  keyVersion: string;
  kek: string;
};

export type EncryptedGeneratedLicenseProviderSecrets = {
  keyVersion: string;
  endpointCiphertextB64: string;
  endpointIvB64: string;
  credentialCiphertextB64: string;
  credentialIvB64: string;
  endpointFingerprint: string;
  credentialFingerprint: string;
};

export async function encryptGeneratedLicenseProviderSecrets(input: GeneratedLicenseProviderSecrets & GeneratedLicenseProviderSecretsContext & { hmacSecret: string }): Promise<EncryptedGeneratedLicenseProviderSecrets> {
  const key = await importAesKey(input.kek);
  const [endpoint, credential, endpointFingerprint, credentialFingerprint] = await Promise.all([
    encryptValue(input.endpoint, key, providerAad(input, "endpoint")),
    encryptValue(input.credential, key, providerAad(input, "credential")),
    hmacToken(input.hmacSecret, `generated-license-provider-endpoint:${input.shopId}:${input.connectionId}`, input.endpoint),
    hmacToken(input.hmacSecret, `generated-license-provider-credential:${input.shopId}:${input.connectionId}`, input.credential),
  ]);
  return {
    keyVersion: input.keyVersion,
    endpointCiphertextB64: endpoint.ciphertextB64,
    endpointIvB64: endpoint.ivB64,
    credentialCiphertextB64: credential.ciphertextB64,
    credentialIvB64: credential.ivB64,
    endpointFingerprint,
    credentialFingerprint,
  };
}

export async function decryptGeneratedLicenseProviderSecrets(row: EncryptedGeneratedLicenseProviderSecrets, input: GeneratedLicenseProviderSecretsContext): Promise<GeneratedLicenseProviderSecrets> {
  if (row.keyVersion !== input.keyVersion) throw new AppError("credential_decryption_failed", 500);
  const key = await importAesKey(input.kek);
  const [endpoint, credential] = await Promise.all([
    decryptValue({ ciphertextB64: row.endpointCiphertextB64, ivB64: row.endpointIvB64 }, key, providerAad(input, "endpoint"), "credential_decryption_failed"),
    decryptValue({ ciphertextB64: row.credentialCiphertextB64, ivB64: row.credentialIvB64 }, key, providerAad(input, "credential"), "credential_decryption_failed"),
  ]);
  return { endpoint, credential };
}

export type GeneratedLicenseArtifactContext = {
  shopId: string;
  requestId: string;
  artifactId: string;
  keyVersion: string;
  kek: string;
  format?: "text" | "json";
};

export type EncryptedGeneratedLicenseArtifact = {
  keyVersion: string;
  format: "text" | "json";
  ciphertextB64: string;
  ivB64: string;
  artifactFingerprint: string;
};

export async function encryptGeneratedLicenseArtifact(input: { plaintext: string; format: "text" | "json"; hmacSecret: string } & GeneratedLicenseArtifactContext): Promise<EncryptedGeneratedLicenseArtifact> {
  const key = await importAesKey(input.kek);
  const [encrypted, artifactFingerprint] = await Promise.all([
    encryptValue(input.plaintext, key, artifactAad(input)),
    hmacToken(input.hmacSecret, `generated-license-artifact:${input.shopId}:${input.requestId}:${input.format}`, input.plaintext),
  ]);
  return {
    keyVersion: input.keyVersion,
    format: input.format,
    ciphertextB64: encrypted.ciphertextB64,
    ivB64: encrypted.ivB64,
    artifactFingerprint,
  };
}

export async function decryptGeneratedLicenseArtifact(row: EncryptedGeneratedLicenseArtifact, input: GeneratedLicenseArtifactContext): Promise<string> {
  if (row.keyVersion !== input.keyVersion || (input.format !== undefined && row.format !== input.format)) {
    throw new AppError("inventory_decryption_failed", 500);
  }
  const key = await importAesKey(input.kek);
  return decryptValue({ ciphertextB64: row.ciphertextB64, ivB64: row.ivB64 }, key, artifactAad({ ...input, format: row.format }), "inventory_decryption_failed");
}
