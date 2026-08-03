import { AppError } from "../core/errors";
import { createId } from "../core/ids";
import { getProviderRuntimeContract } from "./provider-contracts";
import type { NormalizedChannelEvent } from "./types";
import type { ProviderReceiptClaim, ProviderReceiptStore } from "./ingress";

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_CODE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const PAYLOAD_REFERENCE = /^[A-Za-z0-9_-]{43}$/u;

type ReceiptRow = {
  action: string;
  id: string;
  payloadReference: string;
  status: "accepted" | "processing" | "processed" | "retryable" | "rejected";
};

function assertEvent(event: NormalizedChannelEvent): void {
  if (!SAFE_IDENTIFIER.test(event.shopId) || !SAFE_IDENTIFIER.test(event.connectionId)) {
    throw new AppError("channel_event_invalid", 400, ["scope_invalid"]);
  }
  getProviderRuntimeContract(event.channelCode);
  if (!SAFE_EVENT_ID.test(event.eventId) || !SAFE_CODE.test(event.action) || !PAYLOAD_REFERENCE.test(event.payloadReference)) {
    throw new AppError("channel_event_invalid", 400);
  }
  if (event.idempotencyKey !== `${event.channelCode}:${event.eventId}`) {
    throw new AppError("channel_event_invalid", 400, ["idempotency_invalid"]);
  }
  const receivedAt = new Date(event.receivedAt);
  if (Number.isNaN(receivedAt.getTime()) || receivedAt.toISOString() !== event.receivedAt) {
    throw new AppError("channel_event_invalid", 400, ["received_at_invalid"]);
  }
}

function changed(result: D1Result | undefined): number {
  return result?.meta.changes ?? 0;
}

/**
 * D1-backed receipt store for verified provider ingress. It intentionally
 * stores only the normalized reference envelope and never the raw payload.
 */
export class D1ProviderReceiptStore implements ProviderReceiptStore {
  constructor(private readonly database: D1Database) {}

  private async auditConflict(event: NormalizedChannelEvent, existing: ReceiptRow): Promise<void> {
    await this.database.prepare(`
      INSERT INTO audit_logs (
        id, shop_id, actor_type, actor_id, action, resource_type,
        resource_id, safe_metadata_json, request_id, created_at
      ) VALUES (?, ?, 'system', NULL, 'channel.provider_event_conflict',
        'channel_provider_event_receipt', ?, ?, ?, ?)
    `).bind(
      createId("aud"),
      event.shopId,
      existing.id,
      JSON.stringify({ channelCode: event.channelCode, connectionId: event.connectionId, eventId: event.eventId }),
      createId("provider"),
      event.receivedAt,
    ).run();
  }

  async claim(event: NormalizedChannelEvent): Promise<ProviderReceiptClaim> {
    assertEvent(event);
    const existing = await this.database.prepare(`
      SELECT id, action, payload_reference AS payloadReference, status
      FROM channel_provider_event_receipts
      WHERE shop_id = ? AND connection_id = ? AND provider_code = ?
        AND provider_event_id = ?
      LIMIT 1
    `).bind(event.shopId, event.connectionId, event.channelCode, event.eventId).first<ReceiptRow>();

    if (existing !== null) {
      if (existing.action !== event.action || existing.payloadReference !== event.payloadReference) {
        await this.auditConflict(event, existing);
        return { event, result: "conflict" };
      }
      if (existing.status === "retryable") {
        const retried = await this.database.prepare(`
          UPDATE channel_provider_event_receipts
          SET status = 'accepted', attempts = attempts + 1,
            safe_result_code = NULL, updated_at = ?
          WHERE id = ? AND status = 'retryable'
        `).bind(event.receivedAt, existing.id).run();
        if (changed(retried) === 1) return { event, result: "accepted" };
      }
      return { event, result: "replay" };
    }

    try {
      await this.database.prepare(`
        INSERT INTO channel_provider_event_receipts (
          id, shop_id, connection_id, provider_code, provider_event_id,
          action, payload_reference, status, attempts, received_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', 1, ?, ?, ?)
      `).bind(
        createId("cpev"),
        event.shopId,
        event.connectionId,
        event.channelCode,
        event.eventId,
        event.action,
        event.payloadReference,
        event.receivedAt,
        event.receivedAt,
        event.receivedAt,
      ).run();
      return { event, result: "accepted" };
    } catch {
      const raced = await this.database.prepare(`
        SELECT id, action, payload_reference AS payloadReference, status
        FROM channel_provider_event_receipts
        WHERE shop_id = ? AND connection_id = ? AND provider_code = ?
          AND provider_event_id = ?
        LIMIT 1
      `).bind(event.shopId, event.connectionId, event.channelCode, event.eventId).first<ReceiptRow>();
      if (raced === null) throw new AppError("channel_provider_event_claim_failed", 500);
      if (raced.action !== event.action || raced.payloadReference !== event.payloadReference) {
        await this.auditConflict(event, raced);
        return { event, result: "conflict" };
      }
      if (raced.status === "retryable") {
        const retried = await this.database.prepare(`
          UPDATE channel_provider_event_receipts
          SET status = 'accepted', attempts = attempts + 1,
            safe_result_code = NULL, updated_at = ?
          WHERE id = ? AND status = 'retryable'
        `).bind(event.receivedAt, raced.id).run();
        if (changed(retried) === 1) return { event, result: "accepted" };
      }
      return { event, result: "replay" };
    }
  }
}

export function providerReceiptStore(database: D1Database): ProviderReceiptStore {
  return new D1ProviderReceiptStore(database);
}
