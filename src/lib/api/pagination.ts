import { AppError } from "../core/errors";
import { toBase64Url } from "../core/ids";

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{16,512}$/u;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export type PublicApiCursor = {
  createdAt: string;
  id: string;
};

export type PublicApiPage = {
  cursor: PublicApiCursor | null;
  limit: number;
};

function invalid(issue: string): never {
  throw new AppError("validation_failed", 400, [issue]);
}

function decodeCursor(value: string): PublicApiCursor {
  if (!CURSOR_PATTERN.test(value)) invalid("cursor_invalid");
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid("cursor_invalid");
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== "createdAt" || keys[1] !== "id"
      || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
      || new Date(record.createdAt).toISOString() !== record.createdAt
      || typeof record.id !== "string" || !REFERENCE_PATTERN.test(record.id)) {
      invalid("cursor_invalid");
    }
    return { createdAt: record.createdAt, id: record.id };
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid("cursor_invalid");
  }
}

export function encodePublicApiCursor(cursor: PublicApiCursor): string {
  if (!Number.isFinite(Date.parse(cursor.createdAt))
    || new Date(cursor.createdAt).toISOString() !== cursor.createdAt
    || !REFERENCE_PATTERN.test(cursor.id)) {
    throw new AppError("validation_failed", 400, ["cursor_invalid"]);
  }
  return toBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

export function parsePublicApiPage(url: URL): PublicApiPage {
  for (const key of new Set(url.searchParams.keys())) {
    if (key !== "cursor" && key !== "limit") invalid("query_field_unknown");
  }
  const rawLimit = url.searchParams.get("limit");
  const rawCursor = url.searchParams.get("cursor");
  if (url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("cursor").length > 1) {
    invalid("duplicate_query_field");
  }
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d{1,3}$/u.test(rawLimit)) invalid("limit_invalid");
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) invalid("limit_invalid");
  }
  return { cursor: rawCursor === null ? null : decodeCursor(rawCursor), limit };
}
