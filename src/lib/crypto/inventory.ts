import { AppError } from "../core/errors";
import { hmacToken } from "../core/crypto";
import { toBase64Url } from "../core/ids";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new AppError("configuration_invalid", 500);
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return new Uint8Array(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    throw new AppError("configuration_invalid", 500);
  }
}

async function importEncryptionKey(secret: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(secret);
  if (bytes.byteLength !== 32) {
    throw new AppError("configuration_invalid", 500);
  }
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function buildAad(shopId: string, variantId: string, version: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(`inventory-key\0${version}\0${shopId}\0${variantId}`));
}

export type EncryptedInventoryKey = {
  ciphertextB64: string;
  fingerprint: string;
  ivB64: string;
  keyVersion: string;
};

export async function encryptInventoryKey(input: {
  hmacSecret: string;
  keyVersion: string;
  kek: string;
  plaintext: string;
  shopId: string;
  variantId: string;
}): Promise<EncryptedInventoryKey> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(input.kek);
  const ciphertext = await crypto.subtle.encrypt({
    additionalData: buildAad(input.shopId, input.variantId, input.keyVersion),
    iv,
    name: "AES-GCM",
    tagLength: 128,
  }, key, encoder.encode(input.plaintext));
  const fingerprint = await hmacToken(
    input.hmacSecret,
    `inventory-fingerprint:${input.shopId}:${input.variantId}`,
    input.plaintext,
  );
  return {
    ciphertextB64: toBase64Url(new Uint8Array(ciphertext)),
    fingerprint,
    ivB64: toBase64Url(iv),
    keyVersion: input.keyVersion,
  };
}

export async function decryptInventoryKey(input: {
  ciphertextB64: string;
  ivB64: string;
  keyVersion: string;
  kek: string;
  shopId: string;
  variantId: string;
}): Promise<string> {
  try {
    const key = await importEncryptionKey(input.kek);
    const plaintext = await crypto.subtle.decrypt({
      additionalData: buildAad(input.shopId, input.variantId, input.keyVersion),
      iv: fromBase64Url(input.ivB64),
      name: "AES-GCM",
      tagLength: 128,
    }, key, fromBase64Url(input.ciphertextB64));
    return decoder.decode(plaintext);
  } catch (error) {
    if (error instanceof AppError && error.code === "configuration_invalid") {
      throw error;
    }
    throw new AppError("inventory_decryption_failed", 500);
  }
}
