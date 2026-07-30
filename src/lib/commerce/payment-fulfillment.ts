import { AppError } from "../core/errors";
import { WEBSITE_CHANNEL_CODE } from "../channels/builtins";
import { matchSupportedLocale } from "../i18n/locale";
import {
  createOrRecoverPaymentLink,
  createOrRecoverPrincipalPaymentHandoff,
  getPaymentFulfillmentEligibility,
  getPrincipalPaymentFulfillmentEligibility,
  type PaymentLinkView,
} from "../payments/store";
import type { AppBindings } from "../platform/bindings";
import type { StorefrontShop } from "../storefront/store";
import type {
  CommerceContext,
  CommerceFulfillmentCommand,
  CommerceFulfillmentEligibilityReason,
  CommerceFulfillmentEligibilityView,
  CommerceFulfillmentView,
  CommerceOrderReference,
  CommercePaymentHandoffCommand,
  CommercePaymentHandoffView,
} from "./contracts";
import { revealPrincipalDigitalFulfillment, revealWebsiteDigitalFulfillment } from "./digital-fulfillment";

export type {
  CommerceFulfillmentCommand,
  CommerceFulfillmentEligibilityReason,
  CommerceFulfillmentEligibilityView,
  CommerceFulfillmentView,
  CommercePaymentHandoffCommand,
  CommercePaymentHandoffView,
} from "./contracts";

export interface CommercePaymentFulfillmentPort {
  createPaymentHandoff(input: { command: CommercePaymentHandoffCommand; context: CommerceContext }): Promise<CommercePaymentHandoffView>;
  getFulfillmentEligibility(input: { command: CommerceFulfillmentCommand; context: CommerceContext }): Promise<CommerceFulfillmentEligibilityView>;
  revealFulfillment(input: { command: CommerceFulfillmentCommand; context: CommerceContext }): Promise<CommerceFulfillmentView>;
}

function assertWebsiteContext(context: CommerceContext, shop: StorefrontShop): void {
  if (context.shopId !== shop.id) throw new AppError("commerce_context_mismatch", 403, ["shop_id_mismatch"]);
  if (context.channel.code !== WEBSITE_CHANNEL_CODE || context.channel.connectionId !== null) {
    throw new AppError("commerce_context_mismatch", 403, ["website_channel_required"]);
  }
  if (context.actor.kind !== "anonymous") throw new AppError("commerce_context_mismatch", 403, ["anonymous_actor_required"]);
}

function orderToken(reference: CommerceOrderReference): string {
  if (reference.access.kind !== "opaque_token" || reference.access.token.length < 20 || reference.access.token.length > 512) {
    throw new AppError("commerce_context_mismatch", 403, ["opaque_access_required"]);
  }
  return reference.access.token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], issue: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new AppError("validation_failed", 400, [issue]);
}

function assertOrderReference(reference: CommerceOrderReference): void {
  const value: unknown = reference;
  if (!isRecord(value)) throw new AppError("validation_failed", 400, ["order_reference_invalid"]);
  assertExactKeys(value, ["access", "orderId"], "order_reference_invalid");
  if (typeof value.orderId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value.orderId)) {
    throw new AppError("validation_failed", 400, ["order_id_invalid"]);
  }
  if (!isRecord(value.access)) throw new AppError("validation_failed", 400, ["order_access_invalid"]);
  if (value.access.kind === "opaque_token") {
    assertExactKeys(value.access, ["kind", "token"], "order_access_invalid");
    if (typeof value.access.token !== "string" || value.access.token.length < 20 || value.access.token.length > 512) {
      throw new AppError("validation_failed", 400, ["order_access_invalid"]);
    }
    return;
  }
  if (value.access.kind === "principal") {
    assertExactKeys(value.access, ["kind"], "order_access_invalid");
    return;
  }
  throw new AppError("validation_failed", 400, ["order_access_invalid"]);
}

function assertContextContract(context: CommerceContext): void {
  const value: unknown = context;
  if (!isRecord(value)) throw new AppError("validation_failed", 400, ["commerce_context_invalid"]);
  assertExactKeys(value, ["actor", "channel", "locale", "requestId", "shopId"], "commerce_context_invalid");
  if (!isRecord(value.actor) || !isRecord(value.channel)) throw new AppError("validation_failed", 400, ["commerce_context_invalid"]);
  if (value.actor.kind === "anonymous") {
    assertExactKeys(value.actor, ["kind"], "commerce_actor_invalid");
  } else if (value.actor.kind === "customer") {
    assertExactKeys(value.actor, ["customerId", "kind"], "commerce_actor_invalid");
    if (typeof value.actor.customerId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value.actor.customerId)) throw new AppError("validation_failed", 400, ["commerce_customer_id_invalid"]);
  } else {
    throw new AppError("validation_failed", 400, ["commerce_actor_invalid"]);
  }
  assertExactKeys(value.channel, ["code", "connectionId"], "commerce_channel_invalid");
  if (typeof value.channel.code !== "string" || !/^[a-z][a-z0-9._-]{1,63}$/u.test(value.channel.code)
    || (value.channel.connectionId !== null && (typeof value.channel.connectionId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value.channel.connectionId)))) {
    throw new AppError("validation_failed", 400, ["commerce_channel_invalid"]);
  }
  if (matchSupportedLocale(value.locale) === null) throw new AppError("validation_failed", 400, ["locale_invalid"]);
  if (typeof value.requestId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value.requestId)) throw new AppError("validation_failed", 400, ["request_id_invalid"]);
  if (typeof value.shopId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value.shopId)) throw new AppError("validation_failed", 400, ["shop_id_invalid"]);
}

function normalizeHandoff(value: unknown): CommercePaymentHandoffView {
  if (!isRecord(value)
    || typeof value.expiresAt !== "string" || Number.isNaN(Date.parse(value.expiresAt))
    || typeof value.handoffId !== "string" || value.handoffId.length === 0
    || typeof value.redirectUrl !== "string" || value.redirectUrl.length === 0
    || typeof value.status !== "string" || value.status.length === 0) {
    throw new AppError("commerce_contract_invalid", 500, ["payment_handoff_invalid"]);
  }
  if (value.presentation !== null) {
    if (!isRecord(value.presentation) || value.presentation.kind !== "qr" || typeof value.presentation.payload !== "string" || value.presentation.payload.length === 0) {
      throw new AppError("commerce_contract_invalid", 500, ["payment_presentation_invalid"]);
    }
    return {
      expiresAt: value.expiresAt,
      handoffId: value.handoffId,
      presentation: { kind: "qr", payload: value.presentation.payload },
      redirectUrl: value.redirectUrl,
      status: value.status,
    };
  }
  return {
    expiresAt: value.expiresAt,
    handoffId: value.handoffId,
    presentation: null,
    redirectUrl: value.redirectUrl,
    status: value.status,
  };
}

function normalizeEligibility(value: unknown, orderId: string): CommerceFulfillmentEligibilityView {
  const reasons: CommerceFulfillmentEligibilityReason[] = ["fulfillment_pending", "order_expired", "order_ineligible", "payment_unconfirmed", "ready"];
  if (!isRecord(value) || typeof value.eligible !== "boolean" || value.orderId !== orderId
    || typeof value.reason !== "string" || !reasons.includes(value.reason as CommerceFulfillmentEligibilityReason)) {
    throw new AppError("commerce_contract_invalid", 500, ["fulfillment_eligibility_invalid"]);
  }
  const reason = value.reason as CommerceFulfillmentEligibilityReason;
  if (value.eligible !== (reason === "ready")) throw new AppError("commerce_contract_invalid", 500, ["fulfillment_eligibility_invalid"]);
  return { eligible: value.eligible, orderId, reason };
}

function normalizeFulfillment(value: unknown, orderId: string): CommerceFulfillmentView {
  if (!isRecord(value) || value.orderId !== orderId || !Array.isArray(value.items)) {
    throw new AppError("commerce_contract_invalid", 500, ["fulfillment_view_invalid"]);
  }
  return {
    items: value.items.map((item) => {
      if (!isRecord(item)
        || typeof item.productTitle !== "string" || typeof item.variantTitle !== "string" || typeof item.value !== "string") {
        throw new AppError("commerce_contract_invalid", 500, ["fulfillment_item_invalid"]);
      }
      return { productTitle: item.productTitle, value: item.value, variantTitle: item.variantTitle };
    }),
    orderId,
  };
}

/**
 * Capability seam for payment handoff and fulfillment. Website and Telegram
 * can adopt it independently without exposing provider-specific payloads.
 */
export class CommercePaymentFulfillmentService {
  constructor(private readonly port: CommercePaymentFulfillmentPort) {}

  async createPaymentHandoff(context: CommerceContext, command: CommercePaymentHandoffCommand): Promise<CommercePaymentHandoffView> {
    assertContextContract(context);
    const value: unknown = command;
    if (!isRecord(value)) throw new AppError("validation_failed", 400, ["payment_handoff_invalid"]);
    assertExactKeys(value, ["order", "origin"], "payment_handoff_invalid");
    assertOrderReference(command.order);
    if (typeof command.origin !== "string" || command.origin.length === 0) throw new AppError("validation_failed", 400, ["payment_origin_invalid"]);
    return normalizeHandoff(await this.port.createPaymentHandoff({ command, context }));
  }

  async getFulfillmentEligibility(context: CommerceContext, command: CommerceFulfillmentCommand): Promise<CommerceFulfillmentEligibilityView> {
    assertContextContract(context);
    const value: unknown = command;
    if (!isRecord(value)) throw new AppError("validation_failed", 400, ["fulfillment_command_invalid"]);
    assertExactKeys(value, ["order"], "fulfillment_command_invalid");
    assertOrderReference(command.order);
    return normalizeEligibility(await this.port.getFulfillmentEligibility({ command, context }), command.order.orderId);
  }

  async revealFulfillment(context: CommerceContext, command: CommerceFulfillmentCommand): Promise<CommerceFulfillmentView> {
    const eligibility = await this.getFulfillmentEligibility(context, command);
    if (!eligibility.eligible) throw new AppError("order_not_ready", 409);
    return normalizeFulfillment(await this.port.revealFulfillment({ command, context }), command.order.orderId);
  }
}

type WebsitePaymentFulfillmentDependencies = {
  createPaymentLink: typeof createOrRecoverPaymentLink;
  getEligibility: typeof getPaymentFulfillmentEligibility;
  revealFulfillment: typeof revealWebsiteDigitalFulfillment;
};

const defaultDependencies: WebsitePaymentFulfillmentDependencies = {
  createPaymentLink: createOrRecoverPaymentLink,
  getEligibility: getPaymentFulfillmentEligibility,
  revealFulfillment: revealWebsiteDigitalFulfillment,
};

function mapPaymentLink(link: PaymentLinkView): CommercePaymentHandoffView {
  return {
    expiresAt: link.expiresAt,
    handoffId: link.paymentAttemptId,
    presentation: link.qrCode.length > 0 ? { kind: "qr", payload: link.qrCode } : null,
    redirectUrl: link.checkoutUrl,
    status: link.state,
  };
}

/** Website adapter around the existing D1/PayOS and digital-key stores. */
export class WebsitePaymentFulfillmentPort implements CommercePaymentFulfillmentPort {
  private readonly dependencies: WebsitePaymentFulfillmentDependencies;

  constructor(private readonly env: AppBindings, private readonly shop: StorefrontShop, dependencies?: Partial<WebsitePaymentFulfillmentDependencies>) {
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  private assertContext(context: CommerceContext): void {
    assertWebsiteContext(context, this.shop);
  }

  async createPaymentHandoff(input: { command: CommercePaymentHandoffCommand; context: CommerceContext }): Promise<CommercePaymentHandoffView> {
    this.assertContext(input.context);
    const token = orderToken(input.command.order);
    const link = await this.dependencies.createPaymentLink({
      env: this.env,
      orderPublicId: input.command.order.orderId,
      orderToken: token,
      origin: input.command.origin,
      shopId: this.shop.id,
    });
    return mapPaymentLink(link);
  }

  async getFulfillmentEligibility(input: { command: CommerceFulfillmentCommand; context: CommerceContext }): Promise<CommerceFulfillmentEligibilityView> {
    this.assertContext(input.context);
    const token = orderToken(input.command.order);
    const decision = await this.dependencies.getEligibility({ env: this.env, orderPublicId: input.command.order.orderId, orderToken: token, shopId: this.shop.id });
    return { eligible: decision.eligible, orderId: input.command.order.orderId, reason: decision.reason };
  }

  async revealFulfillment(input: { command: CommerceFulfillmentCommand; context: CommerceContext }): Promise<CommerceFulfillmentView> {
    this.assertContext(input.context);
    const token = orderToken(input.command.order);
    return this.dependencies.revealFulfillment({ env: this.env, orderPublicId: input.command.order.orderId, orderToken: token, shopId: this.shop.id });
  }
}

export function createWebsitePaymentFulfillmentApplication(env: AppBindings, shop: StorefrontShop): CommercePaymentFulfillmentService {
  return new CommercePaymentFulfillmentService(new WebsitePaymentFulfillmentPort(env, shop));
}

type PrincipalPaymentFulfillmentDependencies = {
  createPaymentHandoff: typeof createOrRecoverPrincipalPaymentHandoff;
  getEligibility: typeof getPrincipalPaymentFulfillmentEligibility;
  revealFulfillment: typeof revealPrincipalDigitalFulfillment;
};

const defaultPrincipalDependencies: PrincipalPaymentFulfillmentDependencies = {
  createPaymentHandoff: createOrRecoverPrincipalPaymentHandoff,
  getEligibility: getPrincipalPaymentFulfillmentEligibility,
  revealFulfillment: revealPrincipalDigitalFulfillment,
};

/** Customer-principal adapter for Telegram and future authenticated channels. */
export class PrincipalPaymentFulfillmentPort implements CommercePaymentFulfillmentPort {
  private readonly env: AppBindings;
  private readonly shopId: string;
  private readonly sourceChannel: "telegram" | null;
  private readonly dependencies: PrincipalPaymentFulfillmentDependencies;

  constructor(env: AppBindings, shopId: string, sourceChannelOrDependencies: "telegram" | null | Partial<PrincipalPaymentFulfillmentDependencies> = null, dependencies?: Partial<PrincipalPaymentFulfillmentDependencies>) {
    this.env = env;
    this.shopId = shopId;
    this.sourceChannel = typeof sourceChannelOrDependencies === "string" ? sourceChannelOrDependencies : null;
    this.dependencies = {
      ...defaultPrincipalDependencies,
      ...(sourceChannelOrDependencies !== null && typeof sourceChannelOrDependencies === "object" ? sourceChannelOrDependencies : dependencies),
    };
  }

  private customerId(context: CommerceContext, order: CommerceOrderReference): string {
    if (context.shopId !== this.shopId) throw new AppError("commerce_context_mismatch", 403, ["shop_id_mismatch"]);
    if (context.actor.kind !== "customer") throw new AppError("commerce_context_mismatch", 403, ["customer_actor_required"]);
    if (order.access.kind !== "principal") throw new AppError("commerce_context_mismatch", 403, ["principal_access_required"]);
    if (this.sourceChannel !== null && context.channel.code !== this.sourceChannel) throw new AppError("commerce_context_mismatch", 403, ["channel_required"]);
    return context.actor.customerId;
  }

  private attribution(context: CommerceContext): { connectionId: string | null; sourceChannel: "telegram" } | Record<string, never> {
    return this.sourceChannel === "telegram"
      ? { connectionId: context.channel.connectionId, sourceChannel: "telegram" }
      : {};
  }

  async createPaymentHandoff(input: { command: CommercePaymentHandoffCommand; context: CommerceContext }): Promise<CommercePaymentHandoffView> {
    const customerId = this.customerId(input.context, input.command.order);
    return mapPaymentLink(await this.dependencies.createPaymentHandoff({
      customerId,
      env: this.env,
      orderPublicId: input.command.order.orderId,
      origin: input.command.origin,
      shopId: this.shopId,
      ...this.attribution(input.context),
    }));
  }

  async getFulfillmentEligibility(input: { command: CommerceFulfillmentCommand; context: CommerceContext }): Promise<CommerceFulfillmentEligibilityView> {
    const customerId = this.customerId(input.context, input.command.order);
    const decision = await this.dependencies.getEligibility({ customerId, env: this.env, orderPublicId: input.command.order.orderId, shopId: this.shopId, ...this.attribution(input.context) });
    return { eligible: decision.eligible, orderId: input.command.order.orderId, reason: decision.reason };
  }

  async revealFulfillment(input: { command: CommerceFulfillmentCommand; context: CommerceContext }): Promise<CommerceFulfillmentView> {
    const customerId = this.customerId(input.context, input.command.order);
    return this.dependencies.revealFulfillment({ customerId, env: this.env, orderPublicId: input.command.order.orderId, shopId: this.shopId, ...this.attribution(input.context) });
  }
}

export function createPrincipalPaymentFulfillmentApplication(env: AppBindings, shopId: string, sourceChannel: "telegram" | null = null): CommercePaymentFulfillmentService {
  return new CommercePaymentFulfillmentService(new PrincipalPaymentFulfillmentPort(env, shopId, sourceChannel));
}

export function createTelegramPaymentFulfillmentApplication(env: AppBindings, shopId: string): CommercePaymentFulfillmentService {
  return createPrincipalPaymentFulfillmentApplication(env, shopId, "telegram");
}
