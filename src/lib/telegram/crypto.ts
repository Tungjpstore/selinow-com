import { hmacToken } from "../core/crypto";
import { AppError } from "../core/errors";
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

type EncryptionContext = {
  field: string;
  integrationId: string;
  keyVersion: string;
  recordId: string;
  shopId: string;
};

function aad(input: EncryptionContext): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(`provider-credential\0telegram\0${input.keyVersion}\0${input.shopId}\0${input.integrationId}\0${input.recordId}\0${input.field}`));
}

async function encrypt(value: string, kek: string, input: EncryptionContext): Promise<{ ciphertextB64: string; ivB64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ additionalData: aad(input), iv, name: "AES-GCM", tagLength: 128 }, await importKey(kek), encoder.encode(value));
  return { ciphertextB64: toBase64Url(new Uint8Array(ciphertext)), ivB64: toBase64Url(iv) };
}

async function decrypt(ciphertextB64: string, ivB64: string, kek: string, input: EncryptionContext): Promise<string> {
  try {
    const plaintext = await crypto.subtle.decrypt({ additionalData: aad(input), iv: fromBase64Url(ivB64), name: "AES-GCM", tagLength: 128 }, await importKey(kek), fromBase64Url(ciphertextB64));
    return decoder.decode(plaintext);
  } catch (error) {
    if (error instanceof AppError && error.code === "configuration_invalid") throw error;
    throw new AppError("credential_decryption_failed", 500);
  }
}

export type EncryptedTelegramCredential = {
  botTokenCiphertextB64: string;
  botTokenIvB64: string;
  tokenFingerprint: string;
  webhookSecretCiphertextB64: string;
  webhookSecretDigest: string;
  webhookSecretIvB64: string;
};

export async function encryptTelegramCredential(input: {
  botToken: string;
  credentialId: string;
  hmacSecret: string;
  integrationId: string;
  kek: string;
  keyVersion: string;
  shopId: string;
  webhookSecret: string;
}): Promise<EncryptedTelegramCredential> {
  const [botToken, webhookSecret, tokenFingerprint, webhookSecretDigest] = await Promise.all([
    encrypt(input.botToken, input.kek, { field: "bot-token", integrationId: input.integrationId, keyVersion: input.keyVersion, recordId: input.credentialId, shopId: input.shopId }),
    encrypt(input.webhookSecret, input.kek, { field: "webhook-secret", integrationId: input.integrationId, keyVersion: input.keyVersion, recordId: input.credentialId, shopId: input.shopId }),
    hmacToken(input.hmacSecret, "telegram-bot-token", input.botToken),
    hmacToken(input.hmacSecret, `telegram-webhook:${input.integrationId}`, input.webhookSecret),
  ]);
  return {
    botTokenCiphertextB64: botToken.ciphertextB64,
    botTokenIvB64: botToken.ivB64,
    tokenFingerprint,
    webhookSecretCiphertextB64: webhookSecret.ciphertextB64,
    webhookSecretDigest,
    webhookSecretIvB64: webhookSecret.ivB64,
  };
}

export async function decryptTelegramCredential(row: EncryptedTelegramCredential, input: { credentialId: string; integrationId: string; kek: string; keyVersion: string; shopId: string }): Promise<{ botToken: string; webhookSecret: string }> {
  const [botToken, webhookSecret] = await Promise.all([
    decrypt(row.botTokenCiphertextB64, row.botTokenIvB64, input.kek, { field: "bot-token", integrationId: input.integrationId, keyVersion: input.keyVersion, recordId: input.credentialId, shopId: input.shopId }),
    decrypt(row.webhookSecretCiphertextB64, row.webhookSecretIvB64, input.kek, { field: "webhook-secret", integrationId: input.integrationId, keyVersion: input.keyVersion, recordId: input.credentialId, shopId: input.shopId }),
  ]);
  return { botToken, webhookSecret };
}

export async function encryptTelegramChatId(input: { chatId: string; hmacSecret: string; identityId: string; integrationId: string; kek: string; keyVersion: string; shopId: string }): Promise<{ ciphertextB64: string; ivB64: string; subjectHash: string }> {
  const [encrypted, subjectHash] = await Promise.all([
    encrypt(input.chatId, input.kek, { field: "chat-id", integrationId: input.integrationId, keyVersion: input.keyVersion, recordId: input.identityId, shopId: input.shopId }),
    hmacToken(input.hmacSecret, `telegram-subject:${input.shopId}`, input.chatId),
  ]);
  return { ...encrypted, subjectHash };
}

export function decryptTelegramChatId(row: { ciphertextB64: string; ivB64: string }, input: { identityId: string; integrationId: string; kek: string; keyVersion: string; shopId: string }): Promise<string> {
  return decrypt(row.ciphertextB64, row.ivB64, input.kek, { field: "chat-id", integrationId: input.integrationId, keyVersion: input.keyVersion, recordId: input.identityId, shopId: input.shopId });
}
