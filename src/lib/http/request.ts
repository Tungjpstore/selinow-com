import { AppError } from "../core/errors";

const DEFAULT_MAX_JSON_BYTES = 16 * 1024;

async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive safe integer");
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("request_body_too_large").catch(() => undefined);
        throw new AppError("validation_failed", 413, ["request_body_too_large"]);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("validation_failed", 400, ["request_body_unreadable"]);
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new AppError("validation_failed", 400, ["json_invalid"]);
  }
}

export async function readBoundedBytes(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive safe integer");
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
    throw new AppError("validation_failed", 413, ["request_body_too_large"]);
  }
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel("request_body_too_large").catch(() => undefined);
        throw new AppError("validation_failed", 413, ["request_body_too_large"]);
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("validation_failed", 400, ["request_body_unreadable"]);
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJsonObject(
  request: Request,
  maxBytes = DEFAULT_MAX_JSON_BYTES,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive safe integer");
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new AppError("validation_failed", 415, ["content_type_json_required"]);
  }

  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AppError("validation_failed", 413, ["request_body_too_large"]);
  }

  const text = await readBoundedBody(request, maxBytes);

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new AppError("validation_failed", 400, ["json_invalid"]);
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("validation_failed", 400, ["json_object_required"]);
  }

  return value as Record<string, unknown>;
}

export function rejectUnknownFields(
  value: Record<string, unknown>,
  allowedFields: readonly string[],
): void {
  const allowed = new Set(allowedFields);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length > 0) {
    throw new AppError("validation_failed", 400, unknown.map((field) => `unknown_field:${field}`));
  }
}
