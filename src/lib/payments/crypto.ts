import { AppError } from "../core/errors";
import { hmacToken } from "../core/crypto";
import { toBase64Url } from "../core/ids";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new AppError("configuration_invalid", 500);
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return new Uint8Array(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    throw new AppError("configuration_invalid", 500);
  }
}

async function importKey(kek: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(kek);
  if (bytes.byteLength !== 32) throw new AppError("configuration_invalid", 500);
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["decrypt", "encrypt"]);
}

function aad(shopId: string, integrationId: string, credentialId: string, field: string, version: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(`provider-credential\0payos\0${version}\0${shopId}\0${integrationId}\0${credentialId}\0${field}`));
}

async function encryptField(value: string, input: CredentialContext, field: string): Promise<{ ciphertextB64: string; ivB64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ additionalData: aad(input.shopId, input.integrationId, input.credentialId, field, input.keyVersion), iv, name: "AES-GCM", tagLength: 128 }, await importKey(input.kek), encoder.encode(value));
  return { ciphertextB64: toBase64Url(new Uint8Array(ciphertext)), ivB64: toBase64Url(iv) };
}

async function decryptField(ciphertextB64: string, ivB64: string, input: CredentialContext, field: string): Promise<string> {
  try {
    const plaintext = await crypto.subtle.decrypt({ additionalData: aad(input.shopId, input.integrationId, input.credentialId, field, input.keyVersion), iv: fromBase64Url(ivB64), name: "AES-GCM", tagLength: 128 }, await importKey(input.kek), fromBase64Url(ciphertextB64));
    return decoder.decode(plaintext);
  } catch (error) {
    if (error instanceof AppError && error.code === "configuration_invalid") throw error;
    throw new AppError("credential_decryption_failed", 500);
  }
}

type CredentialContext = { credentialId: string; integrationId: string; kek: string; keyVersion: string; shopId: string };
export type PayOSCredentials = { apiKey: string; checksumKey: string; clientId: string };
export type EncryptedPayOSCredentials = {
  apiKeyCiphertextB64: string;
  apiKeyIvB64: string;
  checksumKeyCiphertextB64: string;
  checksumKeyIvB64: string;
  clientIdCiphertextB64: string;
  clientIdIvB64: string;
  fingerprint: string;
};

export async function encryptPayOSCredentials(credentials: PayOSCredentials, input: CredentialContext & { hmacSecret: string }): Promise<EncryptedPayOSCredentials> {
  const [clientId, apiKey, checksumKey, fingerprint] = await Promise.all([
    encryptField(credentials.clientId, input, "client-id"),
    encryptField(credentials.apiKey, input, "api-key"),
    encryptField(credentials.checksumKey, input, "checksum-key"),
    hmacToken(input.hmacSecret, `payos-credential:${input.shopId}`, `${credentials.clientId}\0${credentials.apiKey}\0${credentials.checksumKey}`),
  ]);
  return {
    apiKeyCiphertextB64: apiKey.ciphertextB64,
    apiKeyIvB64: apiKey.ivB64,
    checksumKeyCiphertextB64: checksumKey.ciphertextB64,
    checksumKeyIvB64: checksumKey.ivB64,
    clientIdCiphertextB64: clientId.ciphertextB64,
    clientIdIvB64: clientId.ivB64,
    fingerprint,
  };
}

export async function decryptPayOSCredentials(row: EncryptedPayOSCredentials, input: CredentialContext): Promise<PayOSCredentials> {
  const [clientId, apiKey, checksumKey] = await Promise.all([
    decryptField(row.clientIdCiphertextB64, row.clientIdIvB64, input, "client-id"),
    decryptField(row.apiKeyCiphertextB64, row.apiKeyIvB64, input, "api-key"),
    decryptField(row.checksumKeyCiphertextB64, row.checksumKeyIvB64, input, "checksum-key"),
  ]);
  return { apiKey, checksumKey, clientId };
}
