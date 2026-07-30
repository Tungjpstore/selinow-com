import { constantTimeEqual, hmacToken, sha256Json } from "../core/crypto";
import { AppError } from "../core/errors";

const MAX_IMPORT_ROWS = 1_000;
const MAX_KEY_CHARACTERS = 1_024;
const MAX_KEY_BYTES = 2_048;
const PREVIEW_TTL_MILLISECONDS = 15 * 60_000;
const TOKEN_VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type InventoryImportSource = "csv" | "paste";

export type InventoryImportEntry = {
  fingerprint: string;
  plaintext: string;
};

export type InventoryImportAnalysis = {
  duplicateWithinPayloadCount: number;
  entries: InventoryImportEntry[];
  payloadHash: string;
  rejectedCount: number;
  totalCount: number;
};

export type InventoryImportPlan = {
  acceptedEntries: InventoryImportEntry[];
  summary: InventoryImportSummary;
};

export type InventoryImportSummary = {
  acceptedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  totalCount: number;
};

type InventoryPreviewClaims = InventoryImportSummary & {
  acceptedFingerprintHash: string;
  expiresAt: string;
  issuedAt: string;
  payloadHash: string;
  shopId: string;
  source: InventoryImportSource;
  userId: string;
  variantId: string;
  version: number;
};

function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new AppError("inventory_preview_invalid", 400);
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return new Uint8Array(Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)));
  } catch {
    throw new AppError("inventory_preview_invalid", 400);
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function normalizeRows(data: unknown, source: InventoryImportSource): { normalizedRows: string[]; validRows: string[]; rejectedCount: number } {
  if (typeof data !== "string") throw new AppError("validation_failed", 400, ["inventory_payload_required"]);
  const normalizedRows = data.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");

  // A terminal newline is a text-file convention, not an additional inventory row.
  while (normalizedRows.at(-1) === "") normalizedRows.pop();
  if (normalizedRows.length === 0 || normalizedRows.length > MAX_IMPORT_ROWS) {
    throw new AppError("validation_failed", 400, ["inventory_count_invalid"]);
  }

  const validRows: string[] = [];
  let rejectedCount = 0;
  for (const row of normalizedRows) {
    const key = source === "csv" ? (row.split(",", 1)[0] ?? "").trim() : row.trim();
    const byteLength = encoder.encode(key).byteLength;
    if (
      key.length === 0
      || key.length > MAX_KEY_CHARACTERS
      || byteLength > MAX_KEY_BYTES
      || containsControlCharacter(key)
    ) {
      rejectedCount += 1;
      continue;
    }
    validRows.push(key);
  }

  return { normalizedRows, rejectedCount, validRows };
}

export async function analyzeInventoryImport(input: {
  data: unknown;
  filename: string | null;
  hmacSecret: string;
  shopId: string;
  source: InventoryImportSource;
  variantId: string;
}): Promise<InventoryImportAnalysis> {
  const normalized = normalizeRows(input.data, input.source);
  const payloadHash = await hmacToken(
    input.hmacSecret,
    `inventory-import-payload:${input.shopId}:${input.variantId}`,
    JSON.stringify({ filename: input.filename, rows: normalized.normalizedRows, source: input.source }),
  );
  const fingerprinted = await Promise.all(normalized.validRows.map(async (plaintext) => ({
    fingerprint: await hmacToken(
      input.hmacSecret,
      `inventory-fingerprint:${input.shopId}:${input.variantId}`,
      plaintext,
    ),
    plaintext,
  })));
  const uniqueFingerprints = new Set<string>();
  const entries: InventoryImportEntry[] = [];
  let duplicateWithinPayloadCount = 0;
  for (const entry of fingerprinted) {
    if (uniqueFingerprints.has(entry.fingerprint)) {
      duplicateWithinPayloadCount += 1;
    } else {
      uniqueFingerprints.add(entry.fingerprint);
      entries.push(entry);
    }
  }

  return {
    duplicateWithinPayloadCount,
    entries,
    payloadHash,
    rejectedCount: normalized.rejectedCount,
    totalCount: normalized.normalizedRows.length,
  };
}

export function createInventoryImportPlan(
  analysis: InventoryImportAnalysis,
  existingFingerprints: ReadonlySet<string>,
): InventoryImportPlan {
  const acceptedEntries = analysis.entries.filter((entry) => !existingFingerprints.has(entry.fingerprint));
  const existingDuplicateCount = analysis.entries.length - acceptedEntries.length;
  return {
    acceptedEntries,
    summary: {
      acceptedCount: acceptedEntries.length,
      duplicateCount: analysis.duplicateWithinPayloadCount + existingDuplicateCount,
      rejectedCount: analysis.rejectedCount,
      totalCount: analysis.totalCount,
    },
  };
}

async function acceptedFingerprintHash(entries: readonly InventoryImportEntry[]): Promise<string> {
  return sha256Json(entries.map((entry) => entry.fingerprint));
}

export async function createInventoryPreviewToken(input: {
  analysis: InventoryImportAnalysis;
  now?: Date;
  plan: InventoryImportPlan;
  sessionSecret: string;
  shopId: string;
  source: InventoryImportSource;
  userId: string;
  variantId: string;
}): Promise<{ expiresAt: string; previewToken: string }> {
  const now = input.now ?? new Date();
  const claims: InventoryPreviewClaims = {
    ...input.plan.summary,
    acceptedFingerprintHash: await acceptedFingerprintHash(input.plan.acceptedEntries),
    expiresAt: new Date(now.getTime() + PREVIEW_TTL_MILLISECONDS).toISOString(),
    issuedAt: now.toISOString(),
    payloadHash: input.analysis.payloadHash,
    shopId: input.shopId,
    source: input.source,
    userId: input.userId,
    variantId: input.variantId,
    version: TOKEN_VERSION,
  };
  const encodedClaims = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await hmacToken(input.sessionSecret, "inventory-import-preview:v1", encodedClaims);
  return { expiresAt: claims.expiresAt, previewToken: `${encodedClaims}.${signature}` };
}

function parseClaims(encodedClaims: string): InventoryPreviewClaims {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(fromBase64Url(encodedClaims))) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("inventory_preview_invalid", 400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("inventory_preview_invalid", 400);
  }
  const claims = value as Partial<InventoryPreviewClaims>;
  const counts = [claims.acceptedCount, claims.duplicateCount, claims.rejectedCount, claims.totalCount];
  if (
    claims.version !== TOKEN_VERSION
    || claims.source !== "csv" && claims.source !== "paste"
    || typeof claims.shopId !== "string"
    || typeof claims.userId !== "string"
    || typeof claims.variantId !== "string"
    || typeof claims.payloadHash !== "string"
    || typeof claims.acceptedFingerprintHash !== "string"
    || typeof claims.issuedAt !== "string"
    || typeof claims.expiresAt !== "string"
    || counts.some((count) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
  ) {
    throw new AppError("inventory_preview_invalid", 400);
  }
  return claims as InventoryPreviewClaims;
}

export async function verifyInventoryPreviewToken(input: {
  analysis: InventoryImportAnalysis;
  enforcePlan?: boolean;
  now?: Date;
  plan: InventoryImportPlan;
  previewToken: string;
  sessionSecret: string;
  shopId: string;
  source: InventoryImportSource;
  userId: string;
  variantId: string;
}): Promise<void> {
  if (input.previewToken.length < 40 || input.previewToken.length > 4_096) {
    throw new AppError("inventory_preview_invalid", 400);
  }
  const parts = input.previewToken.split(".");
  if (parts.length !== 2) throw new AppError("inventory_preview_invalid", 400);
  const [encodedClaims, suppliedSignature] = parts;
  if (encodedClaims === undefined || suppliedSignature === undefined) {
    throw new AppError("inventory_preview_invalid", 400);
  }
  const expectedSignature = await hmacToken(input.sessionSecret, "inventory-import-preview:v1", encodedClaims);
  if (!constantTimeEqual(suppliedSignature, expectedSignature)) {
    throw new AppError("inventory_preview_invalid", 400);
  }
  const claims = parseClaims(encodedClaims);
  const now = input.now ?? new Date();
  if (!Number.isFinite(Date.parse(claims.expiresAt)) || Date.parse(claims.expiresAt) <= now.getTime()) {
    throw new AppError("inventory_preview_expired", 409);
  }
  if (
    claims.shopId !== input.shopId
    || claims.userId !== input.userId
    || claims.variantId !== input.variantId
    || claims.source !== input.source
    || claims.payloadHash !== input.analysis.payloadHash
  ) {
    throw new AppError("inventory_preview_mismatch", 409);
  }
  if (input.enforcePlan === false) return;
  const currentFingerprintHash = await acceptedFingerprintHash(input.plan.acceptedEntries);
  if (
    claims.acceptedFingerprintHash !== currentFingerprintHash
    || claims.totalCount !== input.plan.summary.totalCount
    || claims.acceptedCount !== input.plan.summary.acceptedCount
    || claims.rejectedCount !== input.plan.summary.rejectedCount
    || claims.duplicateCount !== input.plan.summary.duplicateCount
  ) {
    throw new AppError("inventory_preview_mismatch", 409);
  }
}
