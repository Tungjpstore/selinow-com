import { AppError } from "../core/errors";
import { readBoundedBytes } from "../http/request";
import type { AppBindings } from "../platform/bindings";
import type { ProviderReceiptStore } from "./ingress";
import { loadProviderRuntimeContext } from "./provider-context";
import { normalizeProviderEvent, verifyZaloMiniAppWebhook, getProviderRuntimeContract } from "./provider-contracts";
import { parseZaloMiniAppWebhook } from "./provider-routes";
import { D1ProviderReceiptStore } from "./provider-event-receipts";
import type { ZaloMiniAppCredential } from "./zalo-mini-app-credentials";

const PROVIDER_CODE = "zalo.mini_app" as const;
const SAFE_PUBLIC_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$/u;

type ZaloMiniAppConnectionContext = {
  connectionId: string;
  connectionPublicId: string;
  credentialFingerprint: string;
  credentialId: string;
  credentialKeyVersion: string;
  providerCode: typeof PROVIDER_CODE;
  shopId: string;
};

export type ZaloMiniAppWebhookContext = ZaloMiniAppConnectionContext & ZaloMiniAppCredential;

export type ZaloMiniAppWebhookResult = {
  action: string;
  eventId: string;
  result: "accepted" | "conflict" | "replay";
};

function publicId(value: string): string {
  if (!SAFE_PUBLIC_ID.test(value)) throw new AppError("webhook_not_found", 404);
  return value;
}

export async function loadZaloMiniAppWebhookContext(env: AppBindings, connectionPublicId: string): Promise<ZaloMiniAppWebhookContext> {
  const context = await loadProviderRuntimeContext(env, { connectionPublicId: publicId(connectionPublicId), providerCode: PROVIDER_CODE });
  if (context.providerCode !== PROVIDER_CODE || !("apiKey" in context.credential) || !("appId" in context.credential)) {
    throw new AppError("channel_provider_mismatch", 403);
  }
  return Object.freeze({
    apiKey: context.credential.apiKey,
    appId: context.credential.appId,
    connectionId: context.connectionId,
    connectionPublicId: context.connectionPublicId,
    credentialFingerprint: context.credentialFingerprint,
    credentialId: context.credentialId,
    credentialKeyVersion: context.credentialKeyVersion,
    providerCode: PROVIDER_CODE,
    shopId: context.shopId,
  });
}

export async function processZaloMiniAppWebhook(input: {
  env: AppBindings;
  connectionPublicId: string;
  now?: Date;
  receiptStore?: ProviderReceiptStore;
  request: Request;
}): Promise<ZaloMiniAppWebhookResult> {
  // Keep the public route's not-found contract independent of provider
  // admission while avoiding a tenant/credential lookup for pending adapters.
  publicId(input.connectionPublicId);
  // Zalo's signature contract is verified locally, but provider admission is
  // still a separate release gate. Do not consume a body while pending.
  const contract = getProviderRuntimeContract(PROVIDER_CODE);
  if (contract.stage === "provider_pending") throw new AppError("channel_provider_pending", 409, [PROVIDER_CODE]);
  const context = await loadZaloMiniAppWebhookContext(input.env, input.connectionPublicId);
  const rawBody = await readBoundedBytes(input.request, contract.maxInboundBodyBytes);
  await verifyZaloMiniAppWebhook({
    apiKey: context.apiKey,
    rawBody,
    signature: input.request.headers.get("X-ZEvent-Signature"),
  });
  const claims = await parseZaloMiniAppWebhook({
    connectionId: context.connectionId,
    expectedAppId: context.appId,
    rawBody,
    shopId: context.shopId,
  });
  const event = await normalizeProviderEvent({
    action: claims.event,
    connectionId: context.connectionId,
    eventId: claims.eventId,
    providerCode: PROVIDER_CODE,
    rawBody,
    shopId: context.shopId,
    ...(input.now === undefined ? {} : { receivedAt: input.now }),
  });
  const claim = await (input.receiptStore ?? new D1ProviderReceiptStore(input.env.PLATFORM_DB)).claim(event);
  if (claim.result === "conflict") {
    throw new AppError("channel_provider_event_conflict", 409);
  }
  return { action: event.action, eventId: event.eventId, result: claim.result };
}
