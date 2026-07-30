import type { AppError } from "../core/errors";

/**
 * The only buyer identity visible to commerce. Provider identifiers stay in
 * the channel adapter and are resolved to this principal before dispatch.
 */
export type CommerceActor =
  | { kind: "anonymous" }
  | { customerId: string; kind: "customer" };

export type CommerceChannel = {
  code: string;
  connectionId: string | null;
};

export type CommerceContext = {
  actor: CommerceActor;
  channel: CommerceChannel;
  locale: string;
  requestId: string;
  shopId: string;
};

export type CommerceCartItem = {
  quantity: number;
  variantId: string;
};

export type CommerceCartAccess =
  | { kind: "opaque_token"; token: string }
  | { kind: "principal" };

export type CommerceCartReference = {
  access: CommerceCartAccess;
  cartId: string;
};

export type CommerceCreateCartCommand = {
  items: readonly CommerceCartItem[];
};

export type CommerceCreateCartView = CommerceCartReference & {
  expiresAt: string;
};

export type CommerceQuoteItem = {
  lineTotalMinor: number;
  productTitle: string;
  quantity: number;
  unitPriceMinor: number;
  variantId: string;
  variantTitle: string;
  variantVersion: number;
};

export type CommerceQuoteView = {
  currency: string;
  discountMinor: number;
  expiresAt: string;
  items: readonly CommerceQuoteItem[];
  /** Signed server evidence that binds this quote to the cart and expiry. */
  quoteEvidence?: string;
  subtotalMinor: number;
  totalMinor: number;
};

export type CommerceQuoteCommand = {
  cart: CommerceCartReference;
};

export type CommerceCartMutation =
  | { kind: "item.increment"; quantity: number; variantId: string }
  | { code: string; kind: "discount.apply" };

export type CommerceCartMutationTarget =
  | { access: { kind: "opaque_token"; token: string }; cartId: string }
  | { access: { kind: "principal" }; cartId: null };

export type CommerceCartMutationCommand = {
  cart: CommerceCartMutationTarget;
  idempotencyKey: string;
  mutation: CommerceCartMutation;
};

export type CommerceCartMutationView = {
  cart: CommerceCartReference;
  replayed: boolean;
};

export type CommerceExpectedItem = {
  /** Canonical checkout evidence must bind the requested quantity. */
  quantity: number;
  unitPriceMinor: number;
  variantId: string;
  variantVersion: number;
};

export type CommerceCheckoutCommand = {
  cart: CommerceCartReference;
  customerEmail: string | null;
  expected: readonly CommerceExpectedItem[];
  idempotencyKey: string;
  /** Signed evidence is required by channels that expose quote-based checkout. */
  quoteEvidence?: string;
};

/** A quote-bound, retry-safe checkout intent/recovery capability. */
export type CommerceCheckoutRecoveryPrepareCommand = {
  cart: CommerceCartReference;
  customerEmail: string | null;
  expected: readonly CommerceExpectedItem[];
  idempotencyKey: string;
  quoteEvidence: string;
};

export type CommerceCheckoutRecoveryPrepareView = {
  evidence: string;
  expiresAt: string;
};

export type CommerceCheckoutRecoveryCommand = {
  cart: CommerceCartReference;
  customerEmail: string | null;
  expected: readonly CommerceExpectedItem[];
  idempotencyKey: string;
  recoveryEvidence: string;
};

export type CommerceCheckoutRecoveryView = {
  access: { kind: "opaque_token"; token: string };
  currency: string;
  expiresAt: string;
  fulfillmentStatus: string;
  orderId: string;
  orderNumber: string;
  paymentStatus: string;
  status: string;
  totalMinor: number;
};

export type CommerceOrderAccess =
  | { kind: "opaque_token"; token: string }
  | { kind: "principal" };

export type CommerceOrderReference = {
  access: CommerceOrderAccess;
  orderId: string;
};

export type CommerceOrderItem = {
  fulfillmentType: string;
  lineTotalMinor: number;
  productTitle: string;
  quantity: number;
  variantTitle: string;
};

export type CommerceOrderView = {
  currency: string;
  expiresAt: string;
  fulfillmentStatus: string;
  items: readonly CommerceOrderItem[];
  orderNumber: string;
  paymentStatus: string;
  status: string;
  totalMinor: number;
};

export type CommerceCheckoutView = {
  access: CommerceOrderAccess;
  currency: string;
  expiresAt: string;
  fulfillmentStatus: string;
  orderId: string;
  orderNumber: string | null;
  paymentStatus: string;
  status: string;
  totalMinor: number;
};

export type CommerceListOrdersCommand = Record<string, never>;

export type CommerceOrderSummaryView = {
  currency: string;
  fulfillmentStatus: string;
  orderId: string;
  orderNumber: string;
  paymentStatus: string;
  status: string;
  totalMinor: number;
};

export type CommerceListOrdersView = readonly CommerceOrderSummaryView[];

/**
 * Provider-neutral payment handoff. Provider request/response fields stay in
 * the adapter; commerce only exposes a redirect and optional QR presentation.
 */
export type CommercePaymentHandoffView = {
  expiresAt: string;
  handoffId: string;
  presentation: { kind: "qr"; payload: string } | null;
  redirectUrl: string;
  status: string;
};

export type CommercePaymentHandoffCommand = {
  order: CommerceOrderReference;
  origin: string;
};

export type CommerceFulfillmentEligibilityReason =
  | "fulfillment_pending"
  | "order_expired"
  | "order_ineligible"
  | "payment_unconfirmed"
  | "ready";

export type CommerceFulfillmentEligibilityView = {
  eligible: boolean;
  orderId: string;
  reason: CommerceFulfillmentEligibilityReason;
};

export type CommerceFulfillmentView = {
  items: readonly { productTitle: string; value: string; variantTitle: string }[];
  orderId: string;
};

export type CommerceFulfillmentCommand = { order: CommerceOrderReference };

export type CommercePrivateDownloadListCommand = {
  order: CommerceOrderReference;
};

export type CommercePrivateDownloadGrantCommand = {
  assetVersionId: string;
  idempotencyKey: string;
  order: CommerceOrderReference;
  orderItemId: string;
};

export type CommercePrivateDownloadConsumeCommand = {
  grantId: string;
  grantToken: string;
  order: CommerceOrderReference;
};

export type CommercePrivateDownloadView = {
  assetVersionId: string;
  downloadCount: number;
  entitlementExpiresAt: string | null;
  entitlementStatus: string | null;
  filename: string;
  maxDownloads: number;
  orderItemId: string;
  remainingDownloads: number;
};

export type CommercePrivateDownloadGrantView = {
  assetVersionId: string;
  expiresAt: string;
  grantId: string;
  grantToken: string;
  remainingDownloads: number;
};

export type CommercePrivateDownloadPayload = {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  filename: string;
};

/** Application-shaped capability used to compose payment and fulfillment. */
export interface CommercePaymentFulfillmentApplication {
  createPaymentHandoff(context: CommerceContext, command: CommercePaymentHandoffCommand): Promise<CommercePaymentHandoffView>;
  getFulfillmentEligibility(context: CommerceContext, command: CommerceFulfillmentCommand): Promise<CommerceFulfillmentEligibilityView>;
  revealFulfillment(context: CommerceContext, command: CommerceFulfillmentCommand): Promise<CommerceFulfillmentView>;
}

export interface CommerceApplicationPort {
  checkoutCart(input: { command: CommerceCheckoutCommand; context: CommerceContext }): Promise<CommerceCheckoutView>;
  createCart(input: { command: CommerceCreateCartCommand; context: CommerceContext }): Promise<CommerceCreateCartView>;
  getOrder(input: { command: { order: CommerceOrderReference }; context: CommerceContext }): Promise<CommerceOrderView>;
  prepareCheckoutRecovery?(input: { command: CommerceCheckoutRecoveryPrepareCommand; context: CommerceContext }): Promise<CommerceCheckoutRecoveryPrepareView>;
  recoverCheckout?(input: { command: CommerceCheckoutRecoveryCommand; context: CommerceContext }): Promise<CommerceCheckoutRecoveryView>;
  listPrivateDownloads?(input: { command: CommercePrivateDownloadListCommand; context: CommerceContext }): Promise<readonly CommercePrivateDownloadView[]>;
  issuePrivateDownloadGrant?(input: { command: CommercePrivateDownloadGrantCommand; context: CommerceContext }): Promise<CommercePrivateDownloadGrantView>;
  consumePrivateDownloadGrant?(input: { command: CommercePrivateDownloadConsumeCommand; context: CommerceContext }): Promise<CommercePrivateDownloadPayload>;
  listOrders?(input: { command: CommerceListOrdersCommand; context: CommerceContext }): Promise<CommerceListOrdersView>;
  mutateCart?(input: { command: CommerceCartMutationCommand; context: CommerceContext }): Promise<CommerceCartMutationView>;
  quoteCart(input: { command: CommerceQuoteCommand; context: CommerceContext }): Promise<CommerceQuoteView>;
}

/** Capability-specific adapters may implement only the commands they expose. */
export type CommercePort = Partial<CommerceApplicationPort>;

export type CommerceCommand =
  | { kind: "cart.create"; input: CommerceCreateCartCommand }
  | { kind: "cart.mutate"; input: CommerceCartMutationCommand }
  | { kind: "cart.quote"; input: CommerceQuoteCommand }
  | { kind: "checkout.create"; input: CommerceCheckoutCommand }
  | { kind: "checkout.recovery.prepare"; input: CommerceCheckoutRecoveryPrepareCommand }
  | { kind: "checkout.recovery.recover"; input: CommerceCheckoutRecoveryCommand }
  | { kind: "fulfillment.eligibility.get"; input: CommerceFulfillmentCommand }
  | { kind: "fulfillment.reveal"; input: CommerceFulfillmentCommand }
  | { kind: "private_download.list"; input: CommercePrivateDownloadListCommand }
  | { kind: "private_download.grant"; input: CommercePrivateDownloadGrantCommand }
  | { kind: "private_download.consume"; input: CommercePrivateDownloadConsumeCommand }
  | { kind: "order.get"; input: { order: CommerceOrderReference } }
  | { kind: "order.list"; input: CommerceListOrdersCommand }
  | { kind: "payment.handoff.create"; input: CommercePaymentHandoffCommand };

export type CommerceView =
  | CommerceCartMutationView
  | CommerceCheckoutRecoveryPrepareView
  | CommerceCheckoutRecoveryView
  | CommerceCheckoutView
  | CommerceCreateCartView
  | CommerceFulfillmentEligibilityView
  | CommerceFulfillmentView
  | CommerceListOrdersView
  | CommerceOrderView
  | CommercePaymentHandoffView
  | CommercePrivateDownloadGrantView
  | CommercePrivateDownloadPayload
  | readonly CommercePrivateDownloadView[]
  | CommerceQuoteView;

// Kept as a type-only reference so consumers can map internal failures without
// coupling the contract to a provider error or transport response.
export type CommerceContractError = Pick<AppError, "code" | "issues" | "status">;
