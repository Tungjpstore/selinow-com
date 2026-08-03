import { normalizeProviderEvent, type RawBody } from "./provider-contracts";
import type { NormalizedChannelEvent } from "./types";

export type ProviderReceiptClaim = {
  event: NormalizedChannelEvent;
  result: "accepted" | "conflict" | "replay";
};

export type ProviderReceiptStore = {
  claim(event: NormalizedChannelEvent): Promise<ProviderReceiptClaim>;
};

/**
 * Shared ingress sequencing for future provider routes. The caller supplies
 * the provider-specific proof and durable receipt store; this function keeps
 * the security order invariant: verify -> normalize -> durable claim.
 */
export async function processProviderIngress(input: {
  action: string;
  connectionId: string;
  eventId: string;
  providerCode: string;
  rawBody: RawBody;
  receivedAt?: Date;
  shopId: string;
  store: ProviderReceiptStore;
  verify: () => Promise<void>;
}): Promise<ProviderReceiptClaim> {
  await input.verify();
  const event = await normalizeProviderEvent({
    action: input.action,
    connectionId: input.connectionId,
    eventId: input.eventId,
    providerCode: input.providerCode,
    rawBody: input.rawBody,
    shopId: input.shopId,
    ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
  });
  return input.store.claim(event);
}
