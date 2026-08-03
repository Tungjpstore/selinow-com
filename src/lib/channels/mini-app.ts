import { AppError } from "../core/errors";
import { constantTimeEqual } from "../core/crypto";

const MAX_INIT_DATA_BYTES = 16 * 1024;
const MAX_USER_JSON_BYTES = 8 * 1024;
const HEX_HASH = /^[0-9a-f]{64}$/u;
const TELEGRAM_ID_MAX = 4_503_599_627_370_495n;

export type TelegramMiniAppLaunch = {
  authDate: Date;
  dataCheckString: string;
  queryId: string | null;
  startParam: string | null;
  user: {
    firstName: string;
    id: string;
    languageCode: string | null;
    lastName: string | null;
    username: string | null;
  };
};

const encoder = new TextEncoder();

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

async function hmacBytes(keyBytes: Uint8Array, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", Uint8Array.from(keyBytes).buffer, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function hmacHex(keyBytes: Uint8Array, value: string): Promise<string> {
  const signature = await hmacBytes(keyBytes, value);
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rejectInvalid(issue = "telegram_mini_app_invalid"): never {
  throw new AppError(issue, 401);
}

function parseUser(value: string): TelegramMiniAppLaunch["user"] {
  if (encoder.encode(value).byteLength > MAX_USER_JSON_BYTES) rejectInvalid();
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) rejectInvalid();
    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== "number" && typeof record.id !== "string") rejectInvalid();
    if (typeof record.first_name !== "string" || record.first_name.length < 1 || record.first_name.length > 128) rejectInvalid();
    const id = String(record.id);
    if (!/^\d{1,20}$/u.test(id) || BigInt(id) > TELEGRAM_ID_MAX || containsControlCharacter(id) || containsControlCharacter(record.first_name)) rejectInvalid();
    const lastName = record.last_name;
    const username = record.username;
    const languageCode = record.language_code;
    if (lastName !== undefined && lastName !== null && (typeof lastName !== "string" || lastName.length > 128)) rejectInvalid();
    if (username !== undefined && username !== null && (typeof username !== "string" || username.length > 64)) rejectInvalid();
    if (languageCode !== undefined && languageCode !== null && (typeof languageCode !== "string" || languageCode.length > 32)) rejectInvalid();
    if (
      (typeof lastName === "string" && containsControlCharacter(lastName))
      || (typeof username === "string" && containsControlCharacter(username))
      || (typeof languageCode === "string" && containsControlCharacter(languageCode))
    ) rejectInvalid();
    return {
      firstName: record.first_name,
      id,
      languageCode: languageCode === undefined || languageCode === null ? null : languageCode,
      lastName: lastName === undefined || lastName === null ? null : lastName,
      username: username === undefined || username === null ? null : username,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    rejectInvalid();
  }
}

/**
 * Verifies Telegram Web App initData before binding a mini-app session to a
 * tenant. The bot token is supplied by the tenant credential boundary and is
 * never returned or persisted by this parser.
 */
export async function verifyTelegramMiniAppInitData(input: {
  botToken: string;
  initData: string;
  maxAgeSeconds?: number;
  now?: Date;
}): Promise<TelegramMiniAppLaunch> {
  if (typeof input.botToken !== "string" || input.botToken.length < 16 || input.botToken.length > 256) rejectInvalid();
  if (typeof input.initData !== "string" || encoder.encode(input.initData).byteLength > MAX_INIT_DATA_BYTES) rejectInvalid();
  const params = new URLSearchParams(input.initData);
  const entries = [...params.entries()];
  const seenKeys = new Set<string>();
  if (entries.length === 0 || entries.some(([key, value]) => {
    if (seenKeys.has(key)) return true;
    seenKeys.add(key);
    return key.length === 0 || value.length === 0 || containsControlCharacter(key) || containsControlCharacter(value);
  })) rejectInvalid();
  const hashValues = entries.filter(([key]) => key === "hash").map(([, value]) => value);
  if (hashValues.length !== 1 || !HEX_HASH.test(hashValues[0] ?? "")) rejectInvalid();
  const authDateValue = params.get("auth_date");
  if (authDateValue === null || !/^\d{1,12}$/u.test(authDateValue)) rejectInvalid();
  const authSeconds = Number(authDateValue);
  const now = input.now ?? new Date();
  const maxAgeSeconds = input.maxAgeSeconds ?? 300;
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 60 || maxAgeSeconds > 604_800 || !Number.isFinite(now.getTime())) rejectInvalid();
  const age = Math.floor(now.getTime() / 1000) - authSeconds;
  if (age < -300 || age > maxAgeSeconds) rejectInvalid("telegram_mini_app_expired");

  const dataCheckString = entries
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = await hmacBytes(encoder.encode("WebAppData"), input.botToken);
  const expectedHash = await hmacHex(secretKey, dataCheckString);
  if (!constantTimeEqual(expectedHash, (hashValues[0] ?? "").toLowerCase())) rejectInvalid();

  const userValue = params.get("user");
  if (userValue === null) rejectInvalid();
  return {
    authDate: new Date(authSeconds * 1000),
    dataCheckString,
    queryId: params.get("query_id"),
    startParam: params.get("start_param"),
    user: parseUser(userValue),
  };
}
