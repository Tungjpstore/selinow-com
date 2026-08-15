import { hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";
import { toBase64Url } from "../core/ids";
import { resolveEncryptionKey, type KeyringBindings } from "../crypto/keyring";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_KEY_VERSION = /^v[1-9][0-9]{0,3}$/u;
const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/iu;

export type DiscordBotCredential = {
  publicKeyHex: string;
};

export type DiscordBotCredentialEnvelope = {
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

function requirePublicKey(value: unknown): string {
  if (typeof value !== "string" || !PUBLIC_KEY_HEX.test(value)) invalid("public_key_invalid");
  return value.toLowerCase();
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

async function aesKey(kek: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const bytes = bytesFromBase64Url(kek, "key_invalid");
  if (bytes.byteLength !== 32) invalid("key_invalid");
  try {
    return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, usages);
  } catch {
    invalid("key_invalid");
  }
}

function aad(input: CredentialContext): Uint8Array<ArrayBuffer> {
  return encoder.encode(`provider-credential\0discord.bot\0${input.keyVersion}\0${input.shopId}\0${input.connectionId}\0${input.credentialId}\0envelope`);
}

function assertContext(input: CredentialContext): void {
  requireReference(input.shopId, "shop_id_invalid");
  requireReference(input.connectionId, "connection_id_invalid");
  requireReference(input.credentialId, "credential_id_invalid");
  if (!SAFE_KEY_VERSION.test(input.keyVersion)) invalid("key_version_invalid");
}

function parseEnvelope(value: string): DiscordBotCredential {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("envelope_invalid");
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 1 || keys[0] !== "publicKeyHex") invalid("envelope_invalid");
    return { publicKeyHex: requirePublicKey(record.publicKeyHex) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid("envelope_invalid");
  }
}

export async function decryptDiscordBotCredential(input: {
  env: KeyringBindings;
  row: DiscordBotCredentialEnvelope & CredentialContext;
}): Promise<DiscordBotCredential> {
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
    return parseEnvelope(decoder.decode(plaintext));
  } catch (error) {
    if (error instanceof AppError && error.code === "channel_credential_decryption_failed") throw error;
    throw new AppError("channel_credential_decryption_failed", 500);
  }
}

export async function encryptDiscordBotCredential(input: DiscordBotCredential & CredentialContext & { hmacSecret: string; kek: string }): Promise<DiscordBotCredentialEnvelope> {
  assertContext(input);
  const publicKeyHex = requirePublicKey(input.publicKeyHex);
  const key = await aesKey(input.kek, ["decrypt", "encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({ publicKeyHex }));
  const ciphertext = await crypto.subtle.encrypt({ additionalData: aad(input), iv, name: "AES-GCM", tagLength: 128 }, key, plaintext);
  return {
    credentialEnvelopeCiphertextB64: toBase64Url(new Uint8Array(ciphertext)),
    credentialEnvelopeIvB64: toBase64Url(iv),
    credentialFingerprint: await hmacToken(input.hmacSecret, `discord-credential:${input.shopId}:${input.connectionId}`, publicKeyHex),
    keyVersion: input.keyVersion,
  };
}
