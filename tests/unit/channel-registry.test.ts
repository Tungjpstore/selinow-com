import { describe, expect, it } from "vitest";

import { ChannelAdapterRegistry } from "../../src/lib/channels/registry";
import type {
  ChannelAdapter,
  ChannelAdapterManifest,
  ChannelCapability,
  ChannelConnectionContext,
} from "../../src/lib/channels/types";

const CAPABILITIES = {
  catalog: "catalog.read",
  checkout: "checkout.external_link",
  inbound: "conversation.inbound",
  secret: "fulfillment.inline_secret",
} as const satisfies Record<string, ChannelCapability>;

const manifest: ChannelAdapterManifest = {
  capabilities: [CAPABILITIES.inbound, CAPABILITIES.catalog, CAPABILITIES.checkout, CAPABILITIES.secret],
  code: "fake",
  version: 1,
};

function capabilitySet(...capabilities: ChannelCapability[]): ReadonlySet<ChannelCapability> {
  return new Set(capabilities);
}

describe("channel adapter registry", () => {
  it("computes effective capabilities from adapter, provider, plan, health and policy", () => {
    const registry = new ChannelAdapterRegistry([manifest]);
    const effective = registry.effectiveCapabilities({
      adapterCode: "fake",
      connectionHealth: "active",
      planEntitlements: capabilitySet(CAPABILITIES.catalog, CAPABILITIES.checkout, CAPABILITIES.secret),
      policyBlockedCapabilities: capabilitySet(CAPABILITIES.secret),
      providerGrants: capabilitySet(CAPABILITIES.inbound, CAPABILITIES.catalog, CAPABILITIES.secret),
    });

    expect([...effective]).toEqual([CAPABILITIES.catalog]);
  });

  it("fails closed when the connection is not healthy", () => {
    const registry = new ChannelAdapterRegistry([manifest]);
    const effective = registry.effectiveCapabilities({
      adapterCode: "fake",
      connectionHealth: "degraded",
      planEntitlements: capabilitySet(...manifest.capabilities),
      providerGrants: capabilitySet(...manifest.capabilities),
    });

    expect(effective.size).toBe(0);
  });

  it("rejects a capability that is unavailable after intersection", () => {
    const registry = new ChannelAdapterRegistry([manifest]);
    const context = {
      adapterCode: "fake",
      connectionHealth: "active" as const,
      planEntitlements: capabilitySet(CAPABILITIES.catalog),
      providerGrants: capabilitySet(CAPABILITIES.catalog),
    };

    expect(() => {
      registry.requireCapability(context, CAPABILITIES.checkout);
    })
      .toThrow(expect.objectContaining({ code: "channel_capability_unavailable", status: 403 }));
  });

  it("rejects duplicate adapter definitions", () => {
    expect(() => new ChannelAdapterRegistry([manifest, manifest]))
      .toThrow(expect.objectContaining({ code: "channel_registry_invalid" }));
  });

  it("bounds provider codes before they can enter operational evidence", () => {
    expect(() => new ChannelAdapterRegistry([{
      ...manifest,
      code: `a${"b".repeat(64)}`,
    }])).toThrow(expect.objectContaining({
      code: "channel_registry_invalid",
      issues: ["adapter_code_invalid"],
    }));
  });

  it("reports deterministic registry health without provider payloads", () => {
    const registry = new ChannelAdapterRegistry([
      { capabilities: [CAPABILITIES.catalog], code: "zeta", version: 3 },
      manifest,
    ]);

    expect(registry.health(["unknown.provider", "fake", "unknown.provider"])).toEqual({
      adapters: [
        { capabilityCount: 4, code: "fake", version: 1 },
        { capabilityCount: 1, code: "zeta", version: 3 },
      ],
      referencedProviderCodes: ["fake", "unknown.provider"],
      status: "unhealthy",
      unknownProviderCodes: ["unknown.provider"],
    });
    expect(registry.health(["fake"]).status).toBe("healthy");
  });
});

describe("channel adapter contract", () => {
  it("keeps provider transport behind a normalized fake adapter", async () => {
    const adapter: ChannelAdapter = {
      classifyError: () => "retry",
      connect: () => Promise.resolve({ connectionId: "conn-fake" }),
      deliver: () => Promise.resolve({ deliveredAt: "2026-07-26T00:00:00.000Z", providerMessageReference: "message-ref", status: "accepted" }),
      disconnect: () => Promise.resolve(),
      healthCheck: () => Promise.resolve("active"),
      manifest,
      render: (view) => [{
        bodyReference: `view:${view.referenceId}`,
        connectionId: "conn-fake",
        idempotencyKey: `deliver:${view.referenceId}`,
        purpose: view.kind,
        recipientReference: "recipient-ref",
      }],
      verifyAndNormalize: (_request, context) => Promise.resolve([{
        action: "catalog.open",
        channelCode: "fake",
        connectionId: context.connectionId,
        eventId: "event-ref",
        idempotencyKey: "event:fake:1",
        payloadReference: "payload-ref",
        receivedAt: "2026-07-26T00:00:00.000Z",
        shopId: context.shopId,
      }]),
    };
    const context: ChannelConnectionContext = { connectionId: "conn-fake", shopId: "shop-a" };

    const events = await adapter.verifyAndNormalize(new Request("https://example.com/webhook"), context);
    const commands = adapter.render({ kind: "product_list", referenceId: "view-1", shopId: "shop-a" }, capabilitySet(CAPABILITIES.catalog));

    expect(events[0]).toEqual(expect.objectContaining({ channelCode: "fake", payloadReference: "payload-ref", shopId: "shop-a" }));
    expect(commands[0]).toEqual(expect.objectContaining({ bodyReference: "view:view-1", purpose: "product_list" }));
  });
});
