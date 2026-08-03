import { describe, expect, it, vi } from "vitest";

import {
  extractProviderCustomerIdentities,
  projectProviderCustomerIdentities,
} from "../../src/lib/channels/provider-identities";

describe("provider customer identity projection", () => {
  it("extracts WhatsApp message subjects and optional contact profile names", () => {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{
        changes: [{
          value: {
            contacts: [{ wa_id: "84900111222", profile: { name: "Buyer One" } }],
            messages: [{ from: "84900111222", id: "wamid-1" }],
            statuses: [{ id: "status-1", status: "read" }],
          },
        }],
      }],
    });
    expect(extractProviderCustomerIdentities({
      providerCode: "whatsapp.cloud",
      rawBody: body,
      verified: true,
    })).toEqual([{
      displayHandle: null,
      displayName: "Buyer One",
      externalSubject: "84900111222",
      languageCode: null,
      providerCode: "whatsapp.cloud",
    }]);
  });

  it("ignores WhatsApp status/account changes without messages", () => {
    expect(extractProviderCustomerIdentities({
      providerCode: "whatsapp.cloud",
      rawBody: JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ changes: [{ value: { statuses: [{ id: "status-1", status: "delivered" }] } }] }],
      }),
      verified: true,
    })).toEqual([]);
  });

  it("extracts Discord member and direct-message user identity metadata", () => {
    expect(extractProviderCustomerIdentities({
      providerCode: "discord.bot",
      rawBody: JSON.stringify({
        application_id: "123456789012345678",
        member: { user: { global_name: "Buyer Global", id: "9001", locale: "vi-VN", username: "buyer_1" } },
        type: 2,
      }),
      verified: true,
    })).toEqual([{
      displayHandle: "buyer_1",
      displayName: "Buyer Global",
      externalSubject: "9001",
      languageCode: "vi-VN",
      providerCode: "discord.bot",
    }]);
    expect(extractProviderCustomerIdentities({
      providerCode: "discord.bot",
      rawBody: JSON.stringify({ type: 1 }),
      verified: true,
    })).toEqual([]);
  });

  it("requires verified proof and rejects malformed or pending providers", () => {
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    expect(() => extractProviderCustomerIdentities({ providerCode: "whatsapp.cloud", rawBody: body, verified: false }))
      .toThrow(expect.objectContaining({ code: "channel_identity_unverified", status: 401 }));
    expect(() => extractProviderCustomerIdentities({ providerCode: "whatsapp.cloud", rawBody: "{", verified: true }))
      .toThrow(expect.objectContaining({ code: "channel_identity_payload_invalid", status: 400 }));
    expect(() => extractProviderCustomerIdentities({ providerCode: "zalo.oa", rawBody: body, verified: true }))
      .toThrow(expect.objectContaining({ code: "channel_provider_pending", status: 409 }));
    expect(() => extractProviderCustomerIdentities({ providerCode: "unsupported", rawBody: body, verified: true }))
      .toThrow(expect.objectContaining({ code: "channel_identity_provider_unsupported", status: 400 }));
  });

  it("resolves and persists identities without returning raw provider subjects", async () => {
    const resolveCustomer = vi.fn(({ candidate }: { candidate: { externalSubject: string } }) => {
      expect(candidate.externalSubject).toBe("84900111222");
      return Promise.resolve("customer-001");
    });
    const persist = vi.fn(({ candidate, customerId }: { candidate: { externalSubject: string }; customerId: string }) => {
      expect(candidate.externalSubject).toBe("84900111222");
      expect(customerId).toBe("customer-001");
      return Promise.resolve({ id: "identity-001" } as never);
    });
    const result = await projectProviderCustomerIdentities({
      connectionId: "connection-001",
      persist,
      providerCode: "whatsapp.cloud",
      rawBody: JSON.stringify({
        object: "whatsapp_business_account",
        entry: [{ changes: [{ value: { messages: [{ from: "84900111222" }] } }] }],
      }),
      resolveCustomer,
      shopId: "shop-001",
      verified: true,
    });
    expect(result).toEqual([{ customerId: "customer-001", identityId: "identity-001", providerCode: "whatsapp.cloud", status: "projected" }]);
    expect(JSON.stringify(result)).not.toContain("84900111222");
    expect(resolveCustomer).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
  });

  it("does not persist when the customer resolver has no canonical match", async () => {
    const persist = vi.fn();
    await expect(projectProviderCustomerIdentities({
      connectionId: "connection-001",
      persist: persist as never,
      providerCode: "discord.bot",
      rawBody: JSON.stringify({ type: 2, user: { id: "9001" } }),
      resolveCustomer: () => Promise.resolve(null),
      shopId: "shop-001",
      verified: true,
    })).resolves.toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });
});
