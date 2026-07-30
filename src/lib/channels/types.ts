export const CHANNEL_CAPABILITIES = [
  "conversation.inbound",
  "conversation.outbound",
  "message.rich_ui",
  "message.template_outside_window",
  "catalog.read",
  "catalog.publish",
  "cart.interactive",
  "checkout.external_link",
  "checkout.native",
  "orders.import",
  "orders.status_push",
  "fulfillment.push",
  "fulfillment.inline_secret",
  "identity.private",
  "provisioning.managed",
] as const;

export type ChannelCapability = typeof CHANNEL_CAPABILITIES[number];

export type ChannelConnectionHealth = "active" | "degraded" | "disconnected" | "pending";

export type ChannelCredentialStatus = "active" | "error" | "grace" | "pending" | "revoked";

export type ShopChannelStatus = "disabled" | "enabled" | "pending";

export type ShopChannelRecord = {
  channelCode: string;
  createdAt: string;
  id: string;
  settings: Readonly<Record<string, unknown>>;
  shopId: string;
  status: ShopChannelStatus;
  updatedAt: string;
  version: number;
};

export type ChannelConnectionRecord = {
  channelCode: string;
  connectedAt: string | null;
  createdAt: string;
  disconnectedAt: string | null;
  displayName: string | null;
  externalAccountId: string | null;
  id: string;
  lastHealthAt: string | null;
  lastSafeErrorCode: string | null;
  providerCode: string;
  publicId: string;
  settings: Readonly<Record<string, unknown>>;
  shopChannelId: string;
  shopId: string;
  status: ChannelConnectionHealth;
  updatedAt: string;
  version: number;
};

export type ChannelConnectionCapabilityProjection = {
  capabilities: ReadonlySet<ChannelCapability>;
  connection: ChannelConnectionRecord;
  providerGrants: ReadonlySet<ChannelCapability>;
};

export type ChannelCredentialRecord = {
  connectionId: string;
  createdAt: string;
  createdByUserId: string;
  credentialFingerprint: string;
  id: string;
  keyVersion: string;
  providerCode: string;
  shopId: string;
  status: ChannelCredentialStatus;
  version: number;
};

export type ChannelAdapterManifest = {
  capabilities: readonly ChannelCapability[];
  code: string;
  version: number;
};

export type ChannelRegistryHealthReport = {
  adapters: readonly {
    capabilityCount: number;
    code: string;
    version: number;
  }[];
  referencedProviderCodes: readonly string[];
  status: "healthy" | "unhealthy";
  unknownProviderCodes: readonly string[];
};

export type ChannelCapabilityContext = {
  adapterCode: string;
  connectionHealth: ChannelConnectionHealth;
  planEntitlements: ReadonlySet<ChannelCapability>;
  policyBlockedCapabilities?: ReadonlySet<ChannelCapability>;
  providerGrants: ReadonlySet<ChannelCapability>;
};

export type ChannelConnectionContext = {
  connectionId: string;
  shopId: string;
};

export type NormalizedChannelEvent = {
  action: string;
  channelCode: string;
  connectionId: string;
  eventId: string;
  idempotencyKey: string;
  payloadReference: string;
  receivedAt: string;
  shopId: string;
};

export type ChannelCommerceView = {
  kind: "cart" | "checkout" | "fulfillment" | "order" | "product_list";
  referenceId: string;
  shopId: string;
};

export type ChannelOutboundCommand = {
  bodyReference: string;
  connectionId: string;
  idempotencyKey: string;
  purpose: string;
  recipientReference: string;
};

export type ChannelDeliveryReceipt = {
  deliveredAt: string;
  providerMessageReference: string | null;
  status: "accepted" | "delivered";
};

export interface ChannelLifecycleAdapter {
  connect(context: ChannelConnectionContext, inputReference: string): Promise<{ connectionId: string }>;
  disconnect(context: ChannelConnectionContext): Promise<void>;
  healthCheck(context: ChannelConnectionContext): Promise<ChannelConnectionHealth>;
}

export interface ChannelInboundAdapter {
  verifyAndNormalize(request: Request, context: ChannelConnectionContext): Promise<readonly NormalizedChannelEvent[]>;
}

export interface ChannelOutboundAdapter {
  classifyError(error: unknown): "recipient_unavailable" | "retry" | "terminal";
  deliver(context: ChannelConnectionContext, command: ChannelOutboundCommand): Promise<ChannelDeliveryReceipt>;
  render(view: ChannelCommerceView, capabilities: ReadonlySet<ChannelCapability>): readonly ChannelOutboundCommand[];
}

export type ChannelAdapter = ChannelLifecycleAdapter & ChannelInboundAdapter & ChannelOutboundAdapter & {
  manifest: ChannelAdapterManifest;
};
