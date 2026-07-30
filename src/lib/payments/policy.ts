import { AppError } from "../core/errors";
import type { PayOSCredentials } from "./crypto";

function normalizeSecret(value: unknown, field: string): string {
  if (typeof value !== "string") throw new AppError("validation_failed", 400, [`${field}_required`]);
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 512 || hasControlCharacter(normalized)) throw new AppError("validation_failed", 400, [`${field}_invalid`]);
  return normalized;
}

export function parsePayOSCredentials(body: Record<string, unknown>): PayOSCredentials {
  const allowed = new Set(["apiKey", "checksumKey", "clientId"]);
  if (Object.keys(body).some((field) => !allowed.has(field))) throw new AppError("validation_failed", 400, ["credential_fields_invalid"]);
  return {
    apiKey: normalizeSecret(body.apiKey, "api_key"),
    checksumKey: normalizeSecret(body.checksumKey, "checksum_key"),
    clientId: normalizeSecret(body.clientId, "client_id"),
  };
}

export function maskAccountNumber(value: string): string {
  const normalized = value.replace(/\s+/gu, "");
  if (normalized.length <= 4) return "****";
  return `${"*".repeat(Math.min(8, normalized.length - 4))}${normalized.slice(-4)}`;
}

export function sanitizeAccountName(value: string): string {
  return Array.from(value).filter((character) => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  }).join("").trim().replace(/\s+/gu, " ").slice(0, 120);
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
