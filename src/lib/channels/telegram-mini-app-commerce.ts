import { CommerceApplicationService } from "../commerce/application";
import {
  createTelegramCheckoutApplication,
  createTelegramOrderApplication,
  TelegramCartMutationPort,
  type TelegramCheckoutShop,
  type TelegramCartSnapshot,
} from "../commerce/telegram-port";
import type { CommerceContext } from "../commerce/contracts";
import { AppError } from "../core/errors";
import { loadTelegramShop } from "../telegram/commerce";
import { TELEGRAM_CHANNEL_CODE } from "./builtins";
import type { AppBindings } from "../platform/bindings";
import type { TelegramMiniAppSessionContext } from "./telegram-mini-app-session";
import { hmacToken } from "../core/crypto";

export type TelegramMiniAppCommerceRuntime = {
  context: CommerceContext;
  identity: { customerId: string; subjectHash: string };
  integrationId: string;
  orderApplication: CommerceApplicationService;
  shop: TelegramCheckoutShop;
  updateId: number;
};

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function updateIdFromKey(input: { env: AppBindings; integrationId: string; shopId: string; value: string }): Promise<number> {
  // The legacy Telegram port stores a numeric update id in its replay ledger.
  // Mini App requests carry an opaque idempotency key, so derive a keyed,
  // deterministic 53-bit scope. A keyed digest prevents an attacker from
  // deliberately finding the 32-bit collisions of the old FNV projection.
  const digest = decodeBase64Url(await hmacToken(
    input.env.IDENTIFIER_HMAC_SECRET,
    `telegram-mini-app-update:${input.shopId}:${input.integrationId}`,
    input.value,
  ));
  let result = (digest[0] ?? 0) & 0x1f;
  for (let index = 1; index < 7; index += 1) result = result * 256 + (digest[index] ?? 0);
  return result;
}

function assertIdempotencyKey(value: string | null): string {
  if (value === null || !/^[A-Za-z0-9._:-]{16,128}$/u.test(value)) {
    throw new AppError("validation_failed", 400, ["idempotency_key_required"]);
  }
  return value;
}

export async function createTelegramMiniAppCommerceRuntime(input: {
  env: AppBindings;
  idempotencyKey: string | null;
  session: TelegramMiniAppSessionContext;
}): Promise<TelegramMiniAppCommerceRuntime> {
  const connectionId = input.session.channelConnectionId;
  if (connectionId === null) throw new AppError("channel_mini_app_commerce_unavailable", 409, ["telegram_connection_required"]);
  const idempotencyKey = assertIdempotencyKey(input.idempotencyKey ?? "telegram-mini-app-read-0001");
  const shop = await loadTelegramShop(input.env, input.session.shopId);
  const updateId = await updateIdFromKey({ env: input.env, integrationId: input.session.integrationId, shopId: input.session.shopId, value: idempotencyKey });
  const identity = { customerId: input.session.customerId, subjectHash: input.session.subjectHash };
  const context: CommerceContext = {
    actor: { customerId: identity.customerId, kind: "customer" },
    channel: { code: TELEGRAM_CHANNEL_CODE, connectionId },
    locale: shop.defaultLocale,
    requestId: idempotencyKey,
    shopId: shop.id,
  };
  // Build the canonical Telegram order application once per request. Payment
  // handoff is deliberately not attached here; a later provider-specific
  // boundary must create it without ever marking an order paid.
  const orderApplication = createTelegramOrderApplication({
    connectionId,
    env: input.env,
    identity: { ...identity, integrationId: input.session.integrationId },
    shop,
    updateId,
  });
  return {
    context,
    identity,
    integrationId: input.session.integrationId,
    orderApplication,
    shop,
    updateId,
  };
}

export function createTelegramMiniAppCartApplication(input: {
  env: AppBindings;
  runtime: TelegramMiniAppCommerceRuntime;
  idempotencyKey: string;
}): CommerceApplicationService {
  return new CommerceApplicationService(new TelegramCartMutationPort({
    connectionId: input.runtime.context.channel.connectionId,
    env: input.env,
    expectedIdempotencyKey: input.idempotencyKey,
    identity: input.runtime.identity,
    integrationId: input.runtime.integrationId,
    shop: input.runtime.shop,
    updateId: input.runtime.updateId,
  }));
}

export function createTelegramMiniAppCheckoutApplication(input: {
  env: AppBindings;
  runtime: TelegramMiniAppCommerceRuntime;
  idempotencyKey: string;
  requestedSnapshot: TelegramCartSnapshot | null;
}): CommerceApplicationService {
  if (input.requestedSnapshot === null) throw new AppError("cart_empty", 409);
  return createTelegramCheckoutApplication({
    connectionId: input.runtime.context.channel.connectionId,
    env: input.env,
    expectedIdempotencyKey: input.idempotencyKey,
    identity: { ...input.runtime.identity, integrationId: input.runtime.integrationId },
    requestedSnapshot: input.requestedSnapshot,
    shop: input.runtime.shop,
    updateId: input.runtime.updateId,
  });
}
