import { AppError } from "../../src/lib/core/errors";
import type {
  ChannelAdapter,
  ChannelAdapterManifest,
  ChannelCapability,
  ChannelCommerceView,
  ChannelConnectionContext,
  ChannelDeliveryReceipt,
  ChannelOutboundCommand,
  ChannelConnectionHealth,
  NormalizedChannelEvent,
} from "../../src/lib/channels/types";

export const FAKE_CHANNEL_CODE = "fake.third";
export const FAKE_CHANNEL_MANIFEST: ChannelAdapterManifest = Object.freeze({
  capabilities: Object.freeze([
    "conversation.inbound",
    "conversation.outbound",
    "message.rich_ui",
    "catalog.read",
    "cart.interactive",
    "checkout.external_link",
    "orders.status_push",
    "fulfillment.push",
  ] satisfies readonly ChannelCapability[]),
  code: FAKE_CHANNEL_CODE,
  version: 1,
});

const SAFE_REFERENCE = /^[A-Za-z0-9._:/-]{1,256}$/u;
const SAFE_ACTION = /^[a-z][a-z0-9._:-]{1,96}$/u;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/u;

export type FakeInboundEnvelope = {
  action: string;
  eventReference: string;
  idempotencyKey: string;
  payloadReference: string;
  receivedAt?: string;
};

export type FakeChannelTarget = {
  connectionId: string;
  recipientReference: string;
  shopId: string;
};

export type FakeDeliveryPlan = "accepted" | "delivered" | "recipient_unavailable" | "retry" | "terminal";

export type FakeAdapterTranscriptEntry =
  | { connectionId: string; operation: "connect"; reference: string; shopId: string }
  | { connectionId: string; operation: "disconnect"; shopId: string }
  | { connectionId: string; health: ChannelConnectionHealth; operation: "health"; shopId: string }
  | { connectionId: string; eventId: string; idempotencyKey: string; operation: "inbound"; shopId: string }
  | { connectionId: string; idempotencyKey: string; operation: "deliver"; recipientReference: string; shopId: string; status: "error" | "success" };

export class FakeChannelAdapterError extends Error {
  readonly classification: "recipient_unavailable" | "retry" | "terminal";
  readonly safeCode: string;

  constructor(safeCode: string, classification: FakeChannelAdapterError["classification"]) {
    super(safeCode);
    this.name = "FakeChannelAdapterError";
    this.classification = classification;
    this.safeCode = safeCode;
  }
}

type ConnectionState = {
  health: ChannelConnectionHealth;
  connectReference: string;
};

type InboundReplay = {
  fingerprint: string;
  event: NormalizedChannelEvent;
};

type DeliveryReplay = {
  fingerprint: string;
  receipt: ChannelDeliveryReceipt;
};

function contextKey(context: ChannelConnectionContext): string {
  return `${context.shopId}\0${context.connectionId}`;
}

function assertReference(value: unknown, issue: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_REFERENCE.test(value)) throw new AppError("validation_failed", 400, [issue]);
}

function assertAction(value: unknown, issue: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_ACTION.test(value)) throw new AppError("validation_failed", 400, [issue]);
}

function assertIdempotencyKey(value: unknown, issue: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_IDEMPOTENCY_KEY.test(value)) throw new AppError("validation_failed", 400, [issue]);
}

function assertContext(context: ChannelConnectionContext): void {
  assertReference(context.shopId, "shop_id_invalid");
  assertReference(context.connectionId, "connection_id_invalid");
}

function parseInboundEnvelope(value: unknown, now: string): FakeInboundEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AppError("fake_inbound_invalid", 400);
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !["action", "eventReference", "idempotencyKey", "payloadReference", "receivedAt"].includes(key))) {
    throw new AppError("fake_inbound_invalid", 400);
  }
  assertAction(record.action, "fake_action_invalid");
  assertReference(record.eventReference, "fake_event_reference_invalid");
  assertIdempotencyKey(record.idempotencyKey, "fake_idempotency_key_invalid");
  assertReference(record.payloadReference, "fake_payload_reference_invalid");
  const receivedAt = record.receivedAt === undefined ? now : record.receivedAt;
  if (typeof receivedAt !== "string" || Number.isNaN(Date.parse(receivedAt))) throw new AppError("fake_received_at_invalid", 400);
  return {
    action: record.action,
    eventReference: record.eventReference,
    idempotencyKey: record.idempotencyKey,
    payloadReference: record.payloadReference,
    receivedAt,
  };
}

function inboundFingerprint(envelope: FakeInboundEnvelope, context: ChannelConnectionContext): string {
  return JSON.stringify({
    action: envelope.action,
    connectionId: context.connectionId,
    eventReference: envelope.eventReference,
    payloadReference: envelope.payloadReference,
    receivedAt: envelope.receivedAt,
    shopId: context.shopId,
  });
}

function deliveryFingerprint(command: ChannelOutboundCommand, context: ChannelConnectionContext): string {
  return JSON.stringify({
    bodyReference: command.bodyReference,
    connectionId: context.connectionId,
    purpose: command.purpose,
    recipientReference: command.recipientReference,
    shopId: context.shopId,
  });
}

function safeMessageReference(command: ChannelOutboundCommand): string {
  return `message:${command.connectionId}:${command.idempotencyKey}`;
}

/**
 * Reference-only third-channel adapter used by contract and acceptance tests.
 * It deliberately has no provider payload, credentials, network, or commerce
 * state writes; those concerns remain outside the adapter boundary.
 */
export class FakeChannelAdapter implements ChannelAdapter {
  readonly manifest = FAKE_CHANNEL_MANIFEST;
  readonly transcript: FakeAdapterTranscriptEntry[] = [];

  private readonly connections = new Map<string, ConnectionState>();
  private readonly inboundReplays = new Map<string, InboundReplay>();
  private readonly deliveryReplays = new Map<string, DeliveryReplay>();
  private readonly deliveryPlans = new Map<string, FakeDeliveryPlan[]>();
  private readonly targets: readonly FakeChannelTarget[];
  private readonly now: string;

  constructor(options: { now?: string; targets?: readonly FakeChannelTarget[] } = {}) {
    this.now = options.now ?? "2026-07-29T00:00:00.000Z";
    if (Number.isNaN(Date.parse(this.now))) throw new AppError("fake_now_invalid", 500);
    this.targets = Object.freeze([...(options.targets ?? [])].map((target) => ({ ...target })));
    for (const target of this.targets) {
      assertContext({ connectionId: target.connectionId, shopId: target.shopId });
      assertReference(target.recipientReference, "recipient_reference_invalid");
    }
  }

  connect(context: ChannelConnectionContext, inputReference: string): Promise<{ connectionId: string }> {
    assertContext(context);
    assertReference(inputReference, "connect_reference_invalid");
    const key = contextKey(context);
    const existing = this.connections.get(key);
    if (existing !== undefined) {
      if (existing.connectReference !== inputReference) throw new AppError("fake_connect_conflict", 409);
      if (existing.health === "disconnected") throw new AppError("fake_reconnect_not_allowed", 409);
      this.transcript.push({ connectionId: context.connectionId, operation: "connect", reference: inputReference, shopId: context.shopId });
      return Promise.resolve({ connectionId: context.connectionId });
    }
    this.connections.set(key, { connectReference: inputReference, health: "active" });
    this.transcript.push({ connectionId: context.connectionId, operation: "connect", reference: inputReference, shopId: context.shopId });
    return Promise.resolve({ connectionId: context.connectionId });
  }

  disconnect(context: ChannelConnectionContext): Promise<void> {
    assertContext(context);
    const state = this.connections.get(contextKey(context));
    if (state === undefined) throw new AppError("fake_connection_not_found", 404);
    state.health = "disconnected";
    this.transcript.push({ connectionId: context.connectionId, operation: "disconnect", shopId: context.shopId });
    return Promise.resolve();
  }

  healthCheck(context: ChannelConnectionContext): Promise<ChannelConnectionHealth> {
    assertContext(context);
    const health = this.connections.get(contextKey(context))?.health ?? "disconnected";
    this.transcript.push({ connectionId: context.connectionId, health, operation: "health", shopId: context.shopId });
    return Promise.resolve(health);
  }

  setHealth(context: ChannelConnectionContext, health: ChannelConnectionHealth): void {
    assertContext(context);
    const state = this.connections.get(contextKey(context));
    if (state === undefined) throw new AppError("fake_connection_not_found", 404);
    if (state.health === "disconnected" && health !== "disconnected") throw new AppError("fake_reconnect_not_allowed", 409);
    state.health = health;
  }

  setDeliveryPlan(recipientReference: string, outcomes: readonly FakeDeliveryPlan[]): void {
    assertReference(recipientReference, "recipient_reference_invalid");
    if (outcomes.length === 0) throw new AppError("fake_delivery_plan_empty", 400);
    this.deliveryPlans.set(recipientReference, [...outcomes]);
  }

  verifyAndNormalize(request: Request, context: ChannelConnectionContext): Promise<readonly NormalizedChannelEvent[]> {
    assertContext(context);
    const state = this.connections.get(contextKey(context));
    if (state === undefined || state.health === "disconnected") throw new AppError("fake_connection_unavailable", 409);
    if (request.method !== "POST") throw new AppError("fake_inbound_method_invalid", 405);
    return request.clone().text().then((body) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body) as unknown;
      } catch {
        throw new AppError("fake_inbound_invalid", 400);
      }
      const envelope = parseInboundEnvelope(parsed, this.now);
      const key = `${contextKey(context)}\0${envelope.idempotencyKey}`;
      const fingerprint = inboundFingerprint(envelope, context);
      const replay = this.inboundReplays.get(key);
      if (replay !== undefined) {
        if (replay.fingerprint !== fingerprint) throw new AppError("fake_inbound_idempotency_conflict", 409);
        this.transcript.push({ connectionId: context.connectionId, eventId: replay.event.eventId, idempotencyKey: envelope.idempotencyKey, operation: "inbound", shopId: context.shopId });
        return [replay.event];
      }
      const event: NormalizedChannelEvent = Object.freeze({
        action: envelope.action,
        channelCode: FAKE_CHANNEL_CODE,
        connectionId: context.connectionId,
        eventId: envelope.eventReference,
        idempotencyKey: envelope.idempotencyKey,
        payloadReference: envelope.payloadReference,
        receivedAt: envelope.receivedAt ?? this.now,
        shopId: context.shopId,
      });
      this.inboundReplays.set(key, { fingerprint, event });
      this.transcript.push({ connectionId: context.connectionId, eventId: event.eventId, idempotencyKey: event.idempotencyKey, operation: "inbound", shopId: context.shopId });
      return [event];
    });
  }

  render(view: ChannelCommerceView, capabilities: ReadonlySet<ChannelCapability>): readonly ChannelOutboundCommand[] {
    assertReference(view.shopId, "shop_id_invalid");
    assertReference(view.referenceId, "view_reference_invalid");
    if (!capabilities.has("conversation.outbound")) return [];
    const requiredCapability: ChannelCapability = view.kind === "fulfillment"
      ? "fulfillment.push"
      : view.kind === "product_list"
        ? "catalog.read"
        : view.kind === "checkout"
          ? "checkout.external_link"
          : view.kind === "order"
            ? "orders.status_push"
            : "cart.interactive";
    if (!capabilities.has(requiredCapability)) return [];
    return this.targets
      .filter((target) => target.shopId === view.shopId)
      .map((target, index) => ({
        bodyReference: `view:${view.kind}:${view.referenceId}`,
        connectionId: target.connectionId,
        idempotencyKey: `deliver:${view.kind}:${view.referenceId}:${String(index + 1)}`,
        purpose: view.kind,
        recipientReference: target.recipientReference,
      }));
  }

  deliver(context: ChannelConnectionContext, command: ChannelOutboundCommand): Promise<ChannelDeliveryReceipt> {
    assertContext(context);
    assertReference(command.bodyReference, "body_reference_invalid");
    assertReference(command.connectionId, "connection_id_invalid");
    assertIdempotencyKey(command.idempotencyKey, "idempotency_key_invalid");
    assertReference(command.purpose, "purpose_invalid");
    assertReference(command.recipientReference, "recipient_reference_invalid");
    if (command.connectionId !== context.connectionId) throw new FakeChannelAdapterError("fake_connection_mismatch", "terminal");
    const state = this.connections.get(contextKey(context));
    if (state === undefined || state.health === "disconnected") throw new FakeChannelAdapterError("fake_connection_unavailable", "recipient_unavailable");
    const key = `${contextKey(context)}\0${command.idempotencyKey}`;
    const fingerprint = deliveryFingerprint(command, context);
    const replay = this.deliveryReplays.get(key);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) throw new FakeChannelAdapterError("fake_delivery_idempotency_conflict", "terminal");
      this.transcript.push({ connectionId: context.connectionId, idempotencyKey: command.idempotencyKey, operation: "deliver", recipientReference: command.recipientReference, shopId: context.shopId, status: "success" });
      return Promise.resolve(replay.receipt);
    }
    const outcomes = this.deliveryPlans.get(command.recipientReference) ?? ["delivered"];
    const outcome = outcomes.shift() ?? "delivered";
    this.deliveryPlans.set(command.recipientReference, outcomes);
    if (outcome === "recipient_unavailable") {
      this.transcript.push({ connectionId: context.connectionId, idempotencyKey: command.idempotencyKey, operation: "deliver", recipientReference: command.recipientReference, shopId: context.shopId, status: "error" });
      return Promise.reject(new FakeChannelAdapterError("fake_recipient_unavailable", "recipient_unavailable"));
    }
    if (outcome === "retry") {
      this.transcript.push({ connectionId: context.connectionId, idempotencyKey: command.idempotencyKey, operation: "deliver", recipientReference: command.recipientReference, shopId: context.shopId, status: "error" });
      return Promise.reject(new FakeChannelAdapterError("fake_transport_retryable", "retry"));
    }
    if (outcome === "terminal") {
      this.transcript.push({ connectionId: context.connectionId, idempotencyKey: command.idempotencyKey, operation: "deliver", recipientReference: command.recipientReference, shopId: context.shopId, status: "error" });
      return Promise.reject(new FakeChannelAdapterError("fake_transport_terminal", "terminal"));
    }
    const receipt: ChannelDeliveryReceipt = Object.freeze({
      deliveredAt: this.now,
      providerMessageReference: outcome === "delivered" ? safeMessageReference(command) : null,
      status: outcome,
    });
    this.deliveryReplays.set(key, { fingerprint, receipt });
    this.transcript.push({ connectionId: context.connectionId, idempotencyKey: command.idempotencyKey, operation: "deliver", recipientReference: command.recipientReference, shopId: context.shopId, status: "success" });
    return Promise.resolve(receipt);
  }

  classifyError(error: unknown): "recipient_unavailable" | "retry" | "terminal" {
    return error instanceof FakeChannelAdapterError ? error.classification : "retry";
  }
}

export type FakeOutboundAttempt = {
  classification: "delivered" | "recipient_unavailable" | "retry" | "terminal";
  command: ChannelOutboundCommand;
  receipt: ChannelDeliveryReceipt | null;
};

/**
 * Exercises the outbound fan-out boundary without implementing retries. A
 * caller owns retry scheduling; this helper only renders and classifies each
 * independent target delivery.
 */
export async function attemptFakeOutboundFanOut(input: {
  adapter: FakeChannelAdapter;
  capabilities: ReadonlySet<ChannelCapability>;
  contextByConnection: ReadonlyMap<string, ChannelConnectionContext>;
  view: ChannelCommerceView;
}): Promise<readonly FakeOutboundAttempt[]> {
  const commands = input.adapter.render(input.view, input.capabilities);
  return Promise.all(commands.map(async (command): Promise<FakeOutboundAttempt> => {
    const context = input.contextByConnection.get(command.connectionId);
    if (context === undefined) return { classification: "terminal", command, receipt: null };
    try {
      const receipt = await input.adapter.deliver(context, command);
      return { classification: "delivered", command, receipt };
    } catch (error) {
      return { classification: input.adapter.classifyError(error), command, receipt: null };
    }
  }));
}
