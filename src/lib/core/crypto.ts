import { toBase64Url } from "./ids";

const encoder = new TextEncoder();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
}

export async function hmacToken(secret: string, purpose: string, value: string): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}\0${value}`));
  return toBase64Url(new Uint8Array(signature));
}

export async function sha256Json(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(value)));
  return toBase64Url(new Uint8Array(digest));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const maxLength = Math.max(leftBytes.length, rightBytes.length);

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

async function derivePbkdf2Bits(password: string, salt: Uint8Array, iterations = 100000): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      hash: "SHA-256",
      iterations,
      name: "PBKDF2",
      salt: new Uint8Array(salt).buffer,
    },
    baseKey,
    256
  );

  return new Uint8Array(derivedBits);
}

// Password hashing functions (PBKDF2 - secure, widely supported)
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltBase64 = toBase64Url(salt);
  const hashBytes = await derivePbkdf2Bits(password, salt);
  return `pbkdf2:${saltBase64}:${toBase64Url(hashBytes)}`;
}

export async function verifyPassword(password: string, storedHash: string | null | undefined): Promise<boolean> {
  if (!storedHash || !storedHash.startsWith("pbkdf2:")) return false;
  const parts = storedHash.split(":");
  if (parts.length !== 3) return false;
  const [, saltBase64, expectedHashBase64] = parts;
  if (!saltBase64 || !expectedHashBase64) return false;


  let salt: Uint8Array;
  try {
    salt = new Uint8Array(Buffer.from(saltBase64, "base64url"));
  } catch {
    return false;
  }

  const computedHashBytes = await derivePbkdf2Bits(password, salt);
  const computedHashBase64 = toBase64Url(computedHashBytes);

  return constantTimeEqual(computedHashBase64, expectedHashBase64);
}

/**
 * Runs a dummy verification calculation to mitigate timing attacks when a user email is not found.
 */
export async function dummyVerifyPassword(password: string): Promise<boolean> {
  const dummySalt = new Uint8Array(16);
  await derivePbkdf2Bits(password, dummySalt);
  return false;
}

/**
 * Generates a cryptographically secure 6-digit OTP code using CSPRNG.
 */
export function generateSecureOtp(length = 6): string {
  const randomBytes = crypto.getRandomValues(new Uint32Array(1));
  const max = 10 ** length;
  const min = 10 ** (length - 1);
  const seed = randomBytes[0] ?? 0;
  const code = (seed % (max - min)) + min;
  return code.toString().padStart(length, "0");
}


/**
 * Hashes an OTP code with HMAC-SHA256 bound to purpose and normalized email.
 */
export async function hashOtp(secret: string, purpose: string, email: string, otp: string): Promise<string> {
  return hmacToken(secret, `otp:${purpose}:${email}`, otp);
}
