import { AppError } from "../core/errors";
import type { AppBindings } from "../platform/bindings";
import { getProviderRuntimeContract, type RawBody } from "./provider-contracts";
import { upsertChannelCustomerIdentity, type ChannelCustomerIdentity } from "./customer-identities";

const SUPPORTED_PROVIDER_CODES = ["whatsapp.cloud", "discord.bot"] as const;
type SupportedProviderCode = typeof SUPPORTED_PROVIDER_CODES[number];

const SAFE_LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const MAX_SUBJECT_LENGTH = 512;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_DISPLAY_HANDLE_LENGTH = 128;
const encoder = new TextEncoder();

/**
 * A provider subject is deliberately available only in memory while a
 * resolver maps it to a canonical tenant customer. It is never part of the
 * projection result or the default persistence payload.
 */
export type ProviderCustomerIdentityCandidate = Readonly<{
  displayHandle: string | null;
  displayName: string | null;
  externalSubject: string;
  languageCode: string | null;
  providerCode: SupportedProviderCode;
}>;

export type ProviderCustomerResolver = (input: {
  candidate: ProviderCustomerIdentityCandidate;
  connectionId: string;
  providerCode: SupportedProviderCode;
  shopId: string;
}) => Promise<string | null>;

export type ProviderCustomerIdentityPersistence = (input: {
  candidate: ProviderCustomerIdentityCandidate;
  connectionId: string;
  customerId: string;
  env: Pick<AppBindings, "IDENTIFIER_HMAC_SECRET" | "PLATFORM_DB">;
  now?: Date | string;
  providerCode: SupportedProviderCode;
  shopId: string;
}) => Promise<ChannelCustomerIdentity>;

export type ProviderCustomerIdentityProjection = Readonly<{
  customerId: string;
  identityId: string;
  providerCode: SupportedProviderCode;
  status: "projected";
}>;

function invalid(issue: string, status = 400): never {
  throw new AppError("channel_identity_payload_invalid", status, [issue]);
}

function providerCode(value: string): SupportedProviderCode {
  if (typeof value !== "string") throw new AppError("channel_identity_provider_unsupported", 400);
  if ((SUPPORTED_PROVIDER_CODES as readonly string[]).includes(value)) {
    const code = value as SupportedProviderCode;
    const contract = getProviderRuntimeContract(code);
    if (contract.stage === "provider_pending") throw new AppError("channel_provider_pending", 409, [code]);
    return code;
  }
  // Resolve known pending contracts to preserve the provider-pending gate.
  if (value === "zalo.mini_app" || value === "zalo.oa") {
    throw new AppError("channel_provider_pending", 409, [value]);
  }
  throw new AppError("channel_identity_provider_unsupported", 400, [value]);
}

function requireVerified(verified: boolean): void {
  if (!verified) throw new AppError("channel_identity_unverified", 401);
}

function objectValue(value: unknown, issue: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(issue);
  return value as Record<string, unknown>;
}

function payloadObject(rawBody: RawBody, provider: SupportedProviderCode): Record<string, unknown> {
  const bytes = typeof rawBody === "string" ? encoder.encode(rawBody) : rawBody;
  const maximum = getProviderRuntimeContract(provider).maxInboundBodyBytes;
  if (bytes.byteLength > maximum) invalid("body_too_large", 413);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid("payload_encoding_invalid");
  }
  try {
    return objectValue(JSON.parse(text) as unknown, "payload_object_required");
  } catch (error) {
    if (error instanceof AppError) throw error;
    invalid("payload_json_invalid");
  }
}

function optionalText(value: unknown, maximum: number, issue: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") invalid(issue);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) invalid(issue);
  for (let index = 0; index < normalized.length; index += 1) {
    const codeUnit = normalized.charCodeAt(index);
    if (codeUnit < 32 || codeUnit === 127) invalid(issue);
  }
  return normalized;
}

function subject(value: unknown, issue: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) invalid(issue);
    return String(value);
  }
  if (typeof value !== "string") invalid(issue);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_SUBJECT_LENGTH) invalid(issue);
  for (let index = 0; index < normalized.length; index += 1) {
    const codeUnit = normalized.charCodeAt(index);
    if (codeUnit < 32 || codeUnit === 127) invalid(issue);
  }
  return normalized;
}

function language(value: unknown, issue: string): string | null {
  const normalized = optionalText(value, 35, issue);
  if (normalized !== null && !SAFE_LANGUAGE.test(normalized)) invalid(issue);
  return normalized;
}

function candidate(input: {
  displayHandle?: string | null;
  displayName?: string | null;
  externalSubject: string;
  languageCode?: string | null;
  providerCode: SupportedProviderCode;
}): ProviderCustomerIdentityCandidate {
  return Object.freeze({
    displayHandle: input.displayHandle ?? null,
    displayName: input.displayName ?? null,
    externalSubject: input.externalSubject,
    languageCode: input.languageCode ?? null,
    providerCode: input.providerCode,
  });
}

function whatsappCandidates(payload: Record<string, unknown>): readonly ProviderCustomerIdentityCandidate[] {
  if (payload.object !== "whatsapp_business_account") invalid("whatsapp_object_invalid");
  if (!Array.isArray(payload.entry) || payload.entry.length === 0) invalid("whatsapp_entry_invalid");
  const identities = new Map<string, ProviderCustomerIdentityCandidate>();
  for (const rawEntry of payload.entry) {
    const entry = objectValue(rawEntry, "whatsapp_entry_invalid");
    if (!Array.isArray(entry.changes) || entry.changes.length === 0) invalid("whatsapp_changes_invalid");
    for (const rawChange of entry.changes) {
      const change = objectValue(rawChange, "whatsapp_change_invalid");
      const value = objectValue(change.value, "whatsapp_value_invalid");
      const rawContacts = value.contacts;
      const contacts = new Map<string, { displayName: string | null }>();
      if (rawContacts !== undefined && rawContacts !== null) {
        if (!Array.isArray(rawContacts)) invalid("whatsapp_contacts_invalid");
        for (const rawContact of rawContacts) {
          const contact = objectValue(rawContact, "whatsapp_contact_invalid");
          const contactSubject = subject(contact.wa_id, "whatsapp_contact_subject_invalid");
          const profileValue = contact.profile;
          let displayName: string | null = null;
          if (profileValue !== undefined && profileValue !== null) {
            const profile = objectValue(profileValue, "whatsapp_profile_invalid");
            displayName = optionalText(profile.name, MAX_DISPLAY_NAME_LENGTH, "whatsapp_profile_name_invalid");
          }
          contacts.set(contactSubject, { displayName });
        }
      } else if (rawContacts === null) {
        invalid("whatsapp_contacts_invalid");
      }

      const rawMessages = value.messages;
      if (rawMessages === undefined || rawMessages === null) continue;
      if (!Array.isArray(rawMessages)) invalid("whatsapp_messages_invalid");
      for (const rawMessage of rawMessages) {
        const message = objectValue(rawMessage, "whatsapp_message_invalid");
        const externalSubject = subject(message.from, "whatsapp_message_subject_invalid");
        if (identities.has(externalSubject)) continue;
        const profile = contacts.get(externalSubject);
        identities.set(externalSubject, candidate({
          displayName: profile?.displayName ?? null,
          externalSubject,
          providerCode: "whatsapp.cloud",
        }));
      }
    }
  }
  return Object.freeze([...identities.values()]);
}

function discordCandidates(payload: Record<string, unknown>): readonly ProviderCustomerIdentityCandidate[] {
  const type = payload.type;
  if (typeof type !== "number" || !Number.isSafeInteger(type) || type < 1 || type > 5) {
    invalid("discord_type_invalid");
  }
  // Discord ping and provider account/status events do not carry a customer.
  if (type === 1) return Object.freeze([]);

  const rawMember = payload.member;
  if (rawMember !== undefined && rawMember !== null && (typeof rawMember !== "object" || Array.isArray(rawMember))) {
    invalid("discord_member_invalid");
  }
  const member = rawMember === undefined || rawMember === null ? null : rawMember as Record<string, unknown>;
  const rawMemberUser = member?.user;
  const rawUser = rawMemberUser ?? payload.user;
  if (rawMemberUser !== undefined && rawMemberUser !== null
    && (typeof rawMemberUser !== "object" || Array.isArray(rawMemberUser))) {
    invalid("discord_user_invalid");
  }
  if (payload.user !== undefined && payload.user !== null
    && (typeof payload.user !== "object" || Array.isArray(payload.user))) {
    invalid("discord_user_invalid");
  }
  if (rawUser === undefined || rawUser === null) return Object.freeze([]);
  const user = objectValue(rawUser, "discord_user_invalid");
  const externalSubject = subject(user.id, "discord_user_id_invalid");
  const username = optionalText(user.username, MAX_DISPLAY_HANDLE_LENGTH, "discord_username_invalid");
  const globalName = optionalText(user.global_name, MAX_DISPLAY_NAME_LENGTH, "discord_global_name_invalid");
  const languageCode = language(user.locale, "discord_locale_invalid");
  return Object.freeze([candidate({
    displayHandle: username,
    displayName: globalName ?? username,
    externalSubject,
    languageCode,
    providerCode: "discord.bot",
  })]);
}

/**
 * Extracts customer identity candidates from an already verified provider
 * payload. This function intentionally requires a literal `verified: true`
 * assertion so callers cannot accidentally parse unverified ingress.
 */
export function extractProviderCustomerIdentities(input: {
  providerCode: string;
  rawBody: RawBody;
  verified: boolean;
}): readonly ProviderCustomerIdentityCandidate[] {
  requireVerified(input.verified);
  const code = providerCode(input.providerCode);
  const payload = payloadObject(input.rawBody, code);
  return code === "whatsapp.cloud" ? whatsappCandidates(payload) : discordCandidates(payload);
}

/**
 * Resolves extracted provider subjects to canonical shop customers and
 * persists only the tenant-bound HMAC identity projection. The resolver is
 * required because this boundary must never invent a customer or cross a
 * tenant connection scope.
 */
export async function projectProviderCustomerIdentities(input: {
  connectionId: string;
  env?: Pick<AppBindings, "IDENTIFIER_HMAC_SECRET" | "PLATFORM_DB">;
  now?: Date | string;
  persist?: ProviderCustomerIdentityPersistence;
  providerCode: string;
  rawBody: RawBody;
  resolveCustomer: ProviderCustomerResolver;
  shopId: string;
  verified: boolean;
}): Promise<readonly ProviderCustomerIdentityProjection[]> {
  requireVerified(input.verified);
  const code = providerCode(input.providerCode);
  const identities = extractProviderCustomerIdentities({
    providerCode: code,
    rawBody: input.rawBody,
    verified: true,
  });
  const persist = input.persist ?? (async (value: Parameters<ProviderCustomerIdentityPersistence>[0]) => {
    if (input.env === undefined) throw new AppError("configuration_invalid", 500, ["platform_db_missing"]);
    return upsertChannelCustomerIdentity({
      connectionId: value.connectionId,
      customerId: value.customerId,
      displayHandle: value.candidate.displayHandle,
      displayName: value.candidate.displayName,
      env: input.env,
      externalSubject: value.candidate.externalSubject,
      languageCode: value.candidate.languageCode,
      providerCode: value.providerCode,
      shopId: value.shopId,
      ...(value.now === undefined ? {} : { now: value.now, verifiedAt: value.now }),
    });
  });
  const results: ProviderCustomerIdentityProjection[] = [];
  for (const identity of identities) {
    const resolvedCustomerId = await input.resolveCustomer({
      candidate: identity,
      connectionId: input.connectionId,
      providerCode: code,
      shopId: input.shopId,
    });
    if (resolvedCustomerId === null) continue;
    if (typeof resolvedCustomerId !== "string" || resolvedCustomerId.trim().length === 0) {
      throw new AppError("channel_identity_customer_invalid", 400);
    }
    const persisted = await persist({
      candidate: identity,
      connectionId: input.connectionId,
      customerId: resolvedCustomerId,
      env: input.env as Pick<AppBindings, "IDENTIFIER_HMAC_SECRET" | "PLATFORM_DB">,
      ...(input.now === undefined ? {} : { now: input.now }),
      providerCode: code,
      shopId: input.shopId,
    });
    if (typeof persisted.id !== "string" || persisted.id.length === 0) {
      throw new AppError("channel_identity_persistence_invalid", 502);
    }
    results.push(Object.freeze({
      customerId: resolvedCustomerId,
      identityId: persisted.id,
      providerCode: code,
      status: "projected",
    }));
  }
  return Object.freeze(results);
}

// Short aliases keep the generic seam easy to discover without changing the
// explicit provider/customer naming used by the public implementation.
export const extractProviderIdentities = extractProviderCustomerIdentities;
export const projectProviderIdentities = projectProviderCustomerIdentities;
