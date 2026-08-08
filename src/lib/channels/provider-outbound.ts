import { AppError } from "../core/errors";
import { assertProviderEndpoint, getProviderRuntimeContract } from "./provider-contracts";
import { requireChannelExpansion } from "./expansion";
import type { ChannelOutboundCommand } from "./types";

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u;
const SAFE_PURPOSE = /^[a-z][a-z0-9._:-]{2,127}$/u;
const WHATSAPP_PATH = /^\/v\d+(?:\.\d+)?\/[A-Za-z0-9][A-Za-z0-9._:-]{2,127}\/messages$/u;
const DISCORD_PATH = /^\/api\/v\d+\/channels\/[A-Za-z0-9][A-Za-z0-9._:-]{2,127}\/messages$/u;

export type ProviderOutboundCode = "whatsapp.cloud" | "discord.bot";

export type ProviderOutboundPlan = Readonly<{
  authScheme: "bearer_access_token" | "bot_token";
  bodyReference: string;
  connectionId: string;
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  idempotencyKey: string;
  method: "POST";
  providerCode: ProviderOutboundCode;
  purpose: string;
  recipientReference: string;
  status: "prepared";
}>;

export type ProviderOutboundTransportInput = Readonly<{
  plan: ProviderOutboundPlan;
}>;

export type ProviderOutboundReceipt = Readonly<{
  providerMessageReference: string | null;
  status: "accepted" | "delivered";
}>;

export type ProviderOutboundTransport = (
  input: ProviderOutboundTransportInput,
) => Promise<ProviderOutboundReceipt>;

function requireReference(value: string, issue: string): string {
  if (typeof value !== "string" || !SAFE_REFERENCE.test(value)) {
    throw new AppError("channel_outbound_invalid", 400, [issue]);
  }
  return value;
}

function requirePurpose(value: string): string {
  if (typeof value !== "string" || !SAFE_PURPOSE.test(value)) {
    throw new AppError("channel_outbound_invalid", 400, ["purpose_invalid"]);
  }
  return value;
}

function requireEndpoint(providerCode: ProviderOutboundCode, value: string): string {
  const endpoint = assertProviderEndpoint(providerCode, value);
  if (endpoint.search.length > 0 || endpoint.hash.length > 0) {
    throw new AppError("channel_provider_endpoint_invalid", 400, [providerCode]);
  }
  const validPath = providerCode === "whatsapp.cloud"
    ? WHATSAPP_PATH.test(endpoint.pathname)
    : DISCORD_PATH.test(endpoint.pathname);
  if (!validPath) throw new AppError("channel_provider_endpoint_invalid", 400, [providerCode]);
  return endpoint.toString();
}

/**
 * Builds a reference-only outbound plan. No credential, payload or provider
 * call is included; an admitted transport must resolve those at execution.
 */
export function prepareProviderOutboundDelivery(input: {
  admission: { reasons?: readonly string[]; status: "blocked" | "ready" };
  command: ChannelOutboundCommand;
  endpoint: string;
  providerCode: ProviderOutboundCode;
}): ProviderOutboundPlan {
  const contract = getProviderRuntimeContract(input.providerCode);
  if (requireChannelExpansion(contract.code).providerExecution === "provider_pending") {
    throw new AppError("channel_provider_pending", 409, [input.providerCode]);
  }
  if (input.admission.status !== "ready") {
    throw new AppError("channel_provider_not_ready", 409, input.admission.reasons ?? ["admission_blocked"]);
  }
  const command = input.command;
  const connectionId = requireReference(command.connectionId, "connection_id_invalid");
  const idempotencyKey = requireReference(command.idempotencyKey, "idempotency_key_invalid");
  const bodyReference = requireReference(command.bodyReference, "body_reference_invalid");
  const recipientReference = requireReference(command.recipientReference, "recipient_reference_invalid");
  const purpose = requirePurpose(command.purpose);
  const endpoint = requireEndpoint(input.providerCode, input.endpoint);
  return Object.freeze({
    authScheme: input.providerCode === "whatsapp.cloud" ? "bearer_access_token" : "bot_token",
    bodyReference,
    connectionId,
    endpoint,
    headers: Object.freeze({ "content-type": "application/json" }),
    idempotencyKey,
    method: "POST",
    providerCode: input.providerCode,
    purpose,
    recipientReference,
    status: "prepared",
  });
}

/**
 * Executes only through an injected transport. There is deliberately no
 * default fetch implementation, so tests and provider_pending paths cannot
 * perform a real network call accidentally.
 */
export async function executeProviderOutboundDelivery(input: {
  plan: ProviderOutboundPlan;
  transport?: ProviderOutboundTransport;
}): Promise<ProviderOutboundReceipt> {
  if (input.transport === undefined) throw new AppError("channel_outbound_transport_unconfigured", 503);
  const rawResult: unknown = await input.transport({ plan: input.plan });
  // The transport is an untrusted provider boundary at runtime even though
  // its TypeScript signature is narrow. Reject malformed status values before
  // they can be persisted as delivery evidence or drive a retry transition.
  if (typeof rawResult !== "object" || rawResult === null || Array.isArray(rawResult)) {
    throw new AppError("channel_outbound_result_invalid", 502);
  }
  const result = rawResult as Record<string, unknown>;
  const status = result.status;
  const providerMessageReference = result.providerMessageReference;
  if ((status !== "accepted" && status !== "delivered")
    || (providerMessageReference !== null && typeof providerMessageReference !== "string")) {
    throw new AppError("channel_outbound_result_invalid", 502);
  }
  if (typeof providerMessageReference === "string" && !SAFE_REFERENCE.test(providerMessageReference)) {
    throw new AppError("channel_outbound_result_invalid", 502);
  }
  return Object.freeze({
    providerMessageReference,
    status,
  });
}
