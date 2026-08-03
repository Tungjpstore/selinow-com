import { hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";
import { toBase64Url } from "../core/ids";
import { resolveEncryptionKey, type KeyringBindings } from "../crypto/keyring";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_KEY_VERSION = /^v[1-9][0-9]{0,3}$/u;

export type WhatsAppCloudCredential = {
  appSecret: string;
  businessAccountId: string;
  phoneNumberId: string;
  verifyToken: string;
};

export type WhatsAppCloudCredentialEnvelope = {
  credentialEnvelopeCiphertextB64: string;
  credentialEnvelopeIvB64: string;
  credentialFingerprint: string;
  keyVersion: string;
};

type CredentialContext = {
  connectionId: string;
  credentialId: string;
  keyVersion: string;
  shopId: string;
};

function invalid(issue: string): never {
  throw new AppError("channel_credential_decryption_failed", 500, [issue]);
}

function requireReference(value: string, issue: string): void {
  if (!SAFE_REFERENCE.test(value)) invalid(issue);
}

function requireSecret(value: unknown, issue: string): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 512) invalid(issue);
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) invalid(issue);
  }
  return value;
}

function requireProviderReference(value: unknown, issue: string): string {
  if (typeof value !== "string" || !SAFE_REFERENCE.test(value)) invalid(issue);
  return value;
}

function bytesFromBase64Url(value: string, issue: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) invalid(issue);
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return new Uint8Array(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    invalid(issue);
  }
}

async function aesKey(kek: string): Promise<CryptoKey> {
  const bytes = bytesFromBase64Url(kek, "key_invalid");
  if (bytes.byteLength !== 32) invalid("key_invalid");
  try {
    return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  } catch {
    invalid("key_invalid");
  }
}

function aad(input: CredentialContext): Uint8Array<ArrayBuffer> {
  return encoder.encode(`provider-credential\0whatsapp.cloud\0${input.keyVersion}\0${input.shopId}\0${input.connectionId}\0${input.credentialId}\0envelope`);
}

function assertContext(input: CredentialContext): void {
  requireReference(input.shopId, "shop_id_invalid");
  requireReference(input.connectionId, "connection_id_invalid");
  requireReference(input.credentialId, "credential_id_invalid");
  if (!SAFE_KEY_VERSION.test(input.keyVersion)) invalid("key_version_invalid");
}

function parseEnvelope(value: string): WhatsAppCloudCredential {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("envelope_invalid");
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 4 || keys[0] !== "appSecret" || keys[1] !== "businessAccountId"
      || keys[2] !== "phoneNumberId" || keys[3] !== "verifyToken") invalid("envelope_invalid");
    return {
      appSecret: requireSecret(record.appSecret, "app_secret_invalid"),
      businessAccountId: requireProviderReference(record.businessAccountId, "business_account_id_invalid"),
      phoneNumberId: requireProviderReference(record.phoneNumberId, "phone_number_id_invalid"),
      verifyToken: requireSecret(record.verifyToken, "verify_token_invalid"),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid("envelope_invalid");
  }
}

export async function decryptWhatsAppCloudCredential(input: {
  env: KeyringBindings;
  row: WhatsAppCloudCredentialEnvelope & CredentialContext;
}): Promise<WhatsAppCloudCredential> {
  assertContext(input.row);
  const key = resolveEncryptionKey(input.env, "credential", input.row.keyVersion);
  const ciphertext = bytesFromBase64Url(input.row.credentialEnvelopeCiphertextB64, "ciphertext_invalid");
  const iv = bytesFromBase64Url(input.row.credentialEnvelopeIvB64, "iv_invalid");
  if (iv.byteLength !== 12 || ciphertext.byteLength < 16) invalid("envelope_invalid");
  try {
    const plaintext = await crypto.subtle.decrypt({ additionalData: aad(input.row), iv, name: "AES-GCM", tagLength: 128 }, await aesKey(key.kek), ciphertext);
    return parseEnvelope(decoder.decode(plaintext));
  } catch (error) {
    if (error instanceof AppError && error.code === "channel_credential_decryption_failed") throw error;
    throw new AppError("channel_credential_decryption_failed", 500);
  }
}

export async function encryptWhatsAppCloudCredential(input: WhatsAppCloudCredential & CredentialContext & { hmacSecret: string; kek: string }): Promise<WhatsAppCloudCredentialEnvelope> {
  assertContext(input);
  const appSecret = requireSecret(input.appSecret, "app_secret_invalid");
  const businessAccountId = requireProviderReference(input.businessAccountId, "business_account_id_invalid");
  const phoneNumberId = requireProviderReference(input.phoneNumberId, "phone_number_id_invalid");
  const verifyToken = requireSecret(input.verifyToken, "verify_token_invalid");
  const key = await aesKey(input.kek);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({ appSecret, businessAccountId, phoneNumberId, verifyToken }));
  const ciphertext = await crypto.subtle.encrypt({ additionalData: aad(input), iv, name: "AES-GCM", tagLength: 128 }, key, plaintext);
  return {
    credentialEnvelopeCiphertextB64: toBase64Url(new Uint8Array(ciphertext)),
    credentialEnvelopeIvB64: toBase64Url(iv),
    credentialFingerprint: await hmacToken(
      input.hmacSecret,
      `whatsapp-credential:${input.shopId}:${input.connectionId}`,
      `${businessAccountId}\0${phoneNumberId}\0${appSecret}\0${verifyToken}`,
    ),
    keyVersion: input.keyVersion,
  };
}
