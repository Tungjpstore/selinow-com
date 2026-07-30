import { createId } from "../core/ids";

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function hmacSha256Hex(secret: string, purpose: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}\0${value}`)));
}

export async function prepareDomainEventAppend(input: {
  aggregateId: string;
  aggregateType: string;
  createdAt: string;
  database: D1Database;
  eventType: string;
  idempotencyKeyHash: string;
  occurredAt: string;
  schemaVersion?: number;
  shopId: string;
  sourceConnectionId?: string | null;
}): Promise<D1PreparedStatement> {
  const hash = await sha256Hex(input.idempotencyKeyHash);
  return input.database.prepare(`
    INSERT INTO domain_events (
      id, shop_id, event_type, aggregate_type, aggregate_id, schema_version,
      idempotency_key_hash, source_connection_id, status, attempts,
      next_attempt_at, occurred_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)
  `).bind(
    createId("evt"),
    input.shopId,
    input.eventType,
    input.aggregateType,
    input.aggregateId,
    input.schemaVersion ?? 1,
    hash,
    input.sourceConnectionId ?? null,
    input.createdAt,
    input.occurredAt,
    input.createdAt,
    input.createdAt,
  );
}
