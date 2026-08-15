import { hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";
import { toBase64Url } from "../core/ids";
import { resolveEncryptionKey, type KeyringBindings } from "../crypto/keyring";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_KEY_VERSION = /^v[1-9][0-9]{0,3}$/u;

export type ZaloOfficialAccountCredential = {
  appId: string;
  oaId: string;
  secretKey: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
};

export type ZaloOfficialAccountCredentialEnvelope = {
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

function requireReference(value: unknown, issue: string): string {
  if (typeof value !== "string" || !SAFE_REFERENCE.test(value)) invalid(issue);
  return value;
}

function requireSecret(value: unknown, issue: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096) invalid(issue);
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) invalid(issue);
  }
  return value;
}

function requireSecretKey(value: unknown): string {
  const secret = requireSecret(value, "secret_key_invalid");
  if (secret.length < 16) invalid("secret_key_invalid");
  return secret;
}

function requireKeyVersion(value: unknown): string {
  if (typeof value !== "string" || !SAFE_KEY_VERSION.test(value)) invalid("key_version_invalid");
  return value;
}

function requireExpiry(value: unknown, issue: string): string {
  if (typeof value !== "string") invalid(issue);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid(issue);
  const normalized = new Date(parsed).toISOString();
  if (normalized !== value) invalid(issue);
  return value;
}

function bytesFromBase64Url(value: unknown, issue: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) invalid(issue);
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    return new Uint8Array(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    invalid(issue);
  }
}

async function aesKey(kek: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const bytes = bytesFromBase64Url(kek, "key_invalid");
  if (bytes.byteLength !== 32) invalid("key_invalid");
  try {
    return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usages);
  } catch {
    invalid("key_invalid");
  }
}

function assertContext(input: CredentialContext): void {
  requireReference(input.shopId, "shop_id_invalid");
  requireReference(input.connectionId, "connection_id_invalid");
  requireReference(input.credentialId, "credential_id_invalid");
  requireKeyVersion(input.keyVersion);
}

function aad(input: CredentialContext): Uint8Array<ArrayBuffer> {
  return encoder.encode(`provider-credential\0zalo.oa\0${input.keyVersion}\0${input.shopId}\0${input.connectionId}\0${input.credentialId}\0envelope`);
}

function parseEnvelope(value: string): ZaloOfficialAccountCredential {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("envelope_invalid");
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 7 || keys[0] !== "accessToken" || keys[1] !== "accessTokenExpiresAt"
      || keys[2] !== "appId" || keys[3] !== "oaId" || keys[4] !== "refreshToken"
      || keys[5] !== "refreshTokenExpiresAt" || keys[6] !== "secretKey") {
      invalid("envelope_invalid");
    }
    return {
      accessToken: requireSecret(record.accessToken, "access_token_invalid"),
      accessTokenExpiresAt: requireExpiry(record.accessTokenExpiresAt, "access_token_expiry_invalid"),
      appId: requireReference(record.appId, "app_id_invalid"),
      oaId: requireReference(record.oaId, "oa_id_invalid"),
      refreshToken: requireSecret(record.refreshToken, "refresh_token_invalid"),
      refreshTokenExpiresAt: requireExpiry(record.refreshTokenExpiresAt, "refresh_token_expiry_invalid"),
      secretKey: requireSecretKey(record.secretKey),
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid("envelope_invalid");
  }
}

export async function decryptZaloOfficialAccountCredential(input: {
  env: KeyringBindings;
  row: ZaloOfficialAccountCredentialEnvelope & CredentialContext;
}): Promise<ZaloOfficialAccountCredential> {
  assertContext(input.row);
  const key = resolveEncryptionKey(input.env, "credential", input.row.keyVersion);
  const ciphertext = bytesFromBase64Url(input.row.credentialEnvelopeCiphertextB64, "ciphertext_invalid");
  const iv = bytesFromBase64Url(input.row.credentialEnvelopeIvB64, "iv_invalid");
  if (iv.byteLength !== 12 || ciphertext.byteLength < 16) invalid("envelope_invalid");
  try {
    const plaintext = await crypto.subtle.decrypt(
      { additionalData: aad(input.row), iv, name: "AES-GCM", tagLength: 128 },
      await aesKey(key.kek, ["decrypt"]),
      ciphertext,
    );
    return Object.freeze(parseEnvelope(decoder.decode(plaintext)));
  } catch (error) {
    if (error instanceof AppError && error.code === "channel_credential_decryption_failed") throw error;
    throw new AppError("channel_credential_decryption_failed", 500);
  }
}

export async function encryptZaloOfficialAccountCredential(input: ZaloOfficialAccountCredential & CredentialContext & { hmacSecret: string; kek: string }): Promise<ZaloOfficialAccountCredentialEnvelope> {
  assertContext(input);
  const credential: ZaloOfficialAccountCredential = {
    accessToken: requireSecret(input.accessToken, "access_token_invalid"),
    accessTokenExpiresAt: requireExpiry(input.accessTokenExpiresAt, "access_token_expiry_invalid"),
    appId: requireReference(input.appId, "app_id_invalid"),
    oaId: requireReference(input.oaId, "oa_id_invalid"),
    refreshToken: requireSecret(input.refreshToken, "refresh_token_invalid"),
    refreshTokenExpiresAt: requireExpiry(input.refreshTokenExpiresAt, "refresh_token_expiry_invalid"),
    secretKey: requireSecretKey(input.secretKey),
  };
  const key = await aesKey(input.kek, ["decrypt", "encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(credential));
  const ciphertext = await crypto.subtle.encrypt({ additionalData: aad(input), iv, name: "AES-GCM", tagLength: 128 }, key, plaintext);
  return {
    credentialEnvelopeCiphertextB64: toBase64Url(new Uint8Array(ciphertext)),
    credentialEnvelopeIvB64: toBase64Url(iv),
    credentialFingerprint: await hmacToken(input.hmacSecret, `zalo-oa-credential:${input.shopId}:${input.connectionId}`, `${credential.appId}\0${credential.oaId}`),
    keyVersion: input.keyVersion,
  };
}
