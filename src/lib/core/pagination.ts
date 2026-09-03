import { AppError } from "./errors";

/**
 * Opaque keyset cursor for admin list services. The cursor pins a
 * `(created_at, id)` position for `ORDER BY created_at DESC, id DESC`
 * listings; both fields are ASCII-safe identifiers validated on decode.
 */
export type CreatedIdCursor = {
  createdAt: string;
  id: string;
};

const CURSOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): string {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function encodeCreatedIdCursor(cursor: CreatedIdCursor): string {
  return toBase64Url(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id }));
}

/**
 * Decodes and validates an optional cursor parameter. Empty/absent cursors
 * keep legacy first-page behavior; malformed cursors fail closed with a safe
 * validation error instead of degrading to an unbounded scan. The createdAt
 * position is parsed through `Date` and re-emitted as `toISOString()` so the
 * lexicographic SQL comparison always matches the stored ISO-8601 shape,
 * even if a caller supplies an equivalent offset or fractional form.
 */
export function parseCreatedIdCursor(value: string | null | undefined): CreatedIdCursor | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = JSON.parse(fromBase64Url(value)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid");
    const row = parsed as { createdAt?: unknown; id?: unknown };
    if (typeof row.createdAt !== "string") {
      throw new Error("invalid");
    }
    const createdAt = new Date(row.createdAt);
    if (!Number.isFinite(createdAt.getTime())) {
      throw new Error("invalid");
    }
    if (typeof row.id !== "string" || !CURSOR_ID_PATTERN.test(row.id)) {
      throw new Error("invalid");
    }
    return { createdAt: createdAt.toISOString(), id: row.id };
  } catch {
    throw new AppError("validation_failed", 400, ["cursor_invalid"]);
  }
}

export function requireListLimit(value: number | undefined, maximum = 100): number {
  const limit = value ?? maximum;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
    throw new AppError("operations_validation_failed", 400, ["limit_invalid"]);
  }
  return limit;
}
