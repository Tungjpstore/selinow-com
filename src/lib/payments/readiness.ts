import type { AppBindings } from "../platform/bindings";
import { PAYOS_PROVIDER_DESCRIPTOR } from "./payos";
import {
  PAYMENT_PROVIDER_CAPABILITIES,
  isSupportedPaymentSettlementPolicy,
  type PaymentConnectionMode,
  type PaymentProviderCapability,
  type PaymentProviderDescriptor,
} from "./provider";

const DEFAULT_HEALTH_TTL_MS = 24 * 60 * 60_000;
const FUTURE_SKEW_MS = 5 * 60_000;
const DEFAULT_REQUIRED_CAPABILITIES = ["checkout.create", "webhook.verify"] as const satisfies readonly PaymentProviderCapability[];

export type PaymentConnectionStatus = "pending" | "active" | "degraded" | "disconnected";
export type PaymentWebhookStatus = "pending" | "verified" | "error" | "disconnected";

export type PaymentProviderConnectionReadiness = {
  capabilityPolicyVersion: number;
  credentialOwnership: string;
  connectionMode: string;
  lastCheckedAt: string | null;
  lastWebhookVerifiedAt: string | null;
  merchantCountryCode: string | null;
  providerAccountVerified: boolean | number;
  providerAttestedCountryCode: string | null;
  providerCode: string;
  providerDescriptorVersion: number;
  providerEnvironment: string;
  settlementMode: string;
  shopId: string;
  status: string;
  webhookStatus: string;
};

export type PaymentCapabilityReadiness = {
  capabilityCode: string;
  capabilityPolicyVersion: number;
  effectiveEnabled: boolean | number;
  expiresAt?: string | null;
  evaluatedAt?: string | null;
  providerGranted: boolean | number;
  providerDescriptorVersion: number;
  revokedAt?: string | null;
};

export type PaymentSupportReadiness = {
  capabilityPolicyVersion: number;
  code: string;
  effectiveEnabled: boolean | number;
  providerSupported: boolean | number;
  providerDescriptorVersion: number;
};

export type PaymentReadinessReason =
  | "capability_expired"
  | "capability_missing"
  | "capability_plan_unentitled"
  | "capability_policy_blocked"
  | "capability_revoked"
  | "connection_degraded"
  | "connection_disconnected"
  | "connection_pending"
  | "connection_state_invalid"
  | "country_unsupported"
  | "currency_unsupported"
  | "health_stale"
  | "missing_connection"
  | "method_unsupported"
  | "mode_unsupported"
  | "provider_account_unverified"
  | "provider_country_unverified"
  | "provider_environment_invalid"
  | "projection_invalid"
  | "projection_version_mismatch"
  | "provider_unregistered"
  | "settlement_mode_mismatch"
  | "settlement_policy_unsupported"
  | "tenant_mismatch"
  | "webhook_stale"
  | "webhook_unverified";

/**
 * Safe payment readiness output. It intentionally omits connection IDs,
 * fingerprints, external account references, evidence references, and errors.
 */
export type PaymentProviderReadinessProjection = {
  connectionStatus: PaymentConnectionStatus | null;
  configured: boolean;
  effectiveCapabilities: readonly PaymentProviderCapability[];
  effectiveCurrencies: readonly string[];
  effectivePaymentMethods: readonly string[];
  healthFresh: boolean;
  providerCode: string;
  ready: boolean;
  reasons: readonly PaymentReadinessReason[];
  registered: boolean;
  webhookFresh: boolean;
  webhookStatus: PaymentWebhookStatus | null;
};

export type ProjectPaymentProviderReadinessInput = {
  capabilityRows?: readonly PaymentCapabilityReadiness[] | undefined;
  checkedAt?: string | undefined;
  connection: PaymentProviderConnectionReadiness | null;
  currency?: string | null | undefined;
  descriptors: readonly PaymentProviderDescriptor[];
  healthTtlMs?: number | undefined;
  method?: string | null | undefined;
  permittedConnectionModes?: readonly PaymentConnectionMode[] | undefined;
  planEntitlements?: readonly PaymentProviderCapability[] | undefined;
  policyBlockedCapabilities?: readonly PaymentProviderCapability[] | undefined;
  providerSupportedCountries?: readonly string[] | undefined;
  requiredCapabilities?: readonly PaymentProviderCapability[] | undefined;
  providerCode: string;
  supportCurrencyRows?: readonly PaymentSupportReadiness[] | undefined;
  supportMethodRows?: readonly PaymentSupportReadiness[] | undefined;
  tenantShopId: string;
};

type ConnectionRow = PaymentProviderConnectionReadiness & { id: string };
type CapabilityRow = PaymentCapabilityReadiness;
type SupportRow = PaymentSupportReadiness;

function asBoolean(value: boolean | number): boolean {
  return value === true || value === 1;
}

function isFreshTimestamp(value: string | null | undefined, nowMs: number, ttlMs: number): boolean {
  if (value === null || value === undefined) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && timestamp <= nowMs + FUTURE_SKEW_MS
    && timestamp >= nowMs - ttlMs;
}

function addReason(reasons: PaymentReadinessReason[], reason: PaymentReadinessReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function validDescriptor(descriptor: PaymentProviderDescriptor): boolean {
  const known = new Set<string>(PAYMENT_PROVIDER_CAPABILITIES);
  return descriptor.code.length >= 2
    && descriptor.code.length <= 64
    && /^[a-z][a-z0-9._-]*$/u.test(descriptor.code)
    && descriptor.capabilities.length > 0
    && new Set(descriptor.capabilities).size === descriptor.capabilities.length
    && descriptor.capabilities.every((capability) => known.has(capability))
    && descriptor.capabilities.includes("webhook.verify")
    && descriptor.connectionModes.length > 0
    && new Set(descriptor.connectionModes).size === descriptor.connectionModes.length
    && descriptor.supportedCurrencies.length > 0
    && new Set(descriptor.supportedCurrencies).size === descriptor.supportedCurrencies.length
    && descriptor.supportedCurrencies.every((currency) => /^[A-Z]{3}$/u.test(currency))
    && descriptor.supportedPaymentMethods.length > 0
    && new Set(descriptor.supportedPaymentMethods).size === descriptor.supportedPaymentMethods.length
    && descriptor.supportedPaymentMethods.every((method) => /^[a-z][a-z0-9._-]{1,63}$/u.test(method));
}

function findDescriptor(
  descriptors: readonly PaymentProviderDescriptor[],
  providerCode: string,
): PaymentProviderDescriptor | null {
  const matches = descriptors.filter((descriptor) => descriptor.code === providerCode);
  const descriptor = matches[0];
  if (matches.length !== 1 || descriptor === undefined || !validDescriptor(descriptor)) return null;
  return descriptor;
}

function normalizeConnectionStatus(value: string): PaymentConnectionStatus | null {
  if (value === "pending" || value === "active" || value === "degraded" || value === "disconnected") return value;
  return null;
}

function normalizeWebhookStatus(value: string): PaymentWebhookStatus | null {
  if (value === "pending" || value === "verified" || value === "error" || value === "disconnected") return value;
  return null;
}

function freezeProjection(projection: PaymentProviderReadinessProjection): PaymentProviderReadinessProjection {
  return Object.freeze({
    ...projection,
    effectiveCapabilities: Object.freeze([...projection.effectiveCapabilities]),
    effectiveCurrencies: Object.freeze([...projection.effectiveCurrencies]),
    effectivePaymentMethods: Object.freeze([...projection.effectivePaymentMethods]),
    reasons: Object.freeze([...projection.reasons]),
  });
}

/**
 * Project a tenant-owned provider connection into safe effective capabilities.
 * Every invalid, stale, revoked, or unregistered state yields `ready: false`.
 */
export function projectPaymentProviderReadiness(
  input: ProjectPaymentProviderReadinessInput,
): PaymentProviderReadinessProjection {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const checkedAtMs = Date.parse(checkedAt);
  const nowMs = Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now();
  const healthTtlMs = input.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS;
  const descriptor = findDescriptor(input.descriptors, input.providerCode);
  const reasons: PaymentReadinessReason[] = [];
  const checkedAtValid = Number.isFinite(checkedAtMs);
  if (!checkedAtValid || !Number.isFinite(healthTtlMs) || healthTtlMs < 0) addReason(reasons, "projection_invalid");
  const connection = input.connection;
  const registered = descriptor !== null;

  if (!registered) addReason(reasons, "provider_unregistered");
  if (connection === null) {
    addReason(reasons, "missing_connection");
    return freezeProjection({
      connectionStatus: null,
      configured: false,
      effectiveCapabilities: [],
      effectiveCurrencies: [],
      effectivePaymentMethods: [],
      healthFresh: false,
      providerCode: input.providerCode,
      ready: false,
      reasons,
      registered,
      webhookFresh: false,
      webhookStatus: null,
    });
  }

  if (connection.shopId !== input.tenantShopId) addReason(reasons, "tenant_mismatch");
  if (connection.providerCode !== input.providerCode) addReason(reasons, "projection_invalid");
  const connectionStatus = normalizeConnectionStatus(connection.status);
  const webhookStatus = normalizeWebhookStatus(connection.webhookStatus);
  if (connectionStatus === null || webhookStatus === null) addReason(reasons, "connection_state_invalid");
  if (connectionStatus === "pending") addReason(reasons, "connection_pending");
  if (connectionStatus === "degraded") addReason(reasons, "connection_degraded");
  if (connectionStatus === "disconnected") addReason(reasons, "connection_disconnected");
  if (webhookStatus !== "verified") addReason(reasons, "webhook_unverified");

  const healthFresh = isFreshTimestamp(connection.lastCheckedAt, nowMs, healthTtlMs);
  const webhookFresh = isFreshTimestamp(connection.lastWebhookVerifiedAt, nowMs, healthTtlMs);
  if (!healthFresh) addReason(reasons, "health_stale");
  if (!webhookFresh) addReason(reasons, "webhook_stale");

  const capabilityRows = input.capabilityRows ?? [];
  const currencyRows = input.supportCurrencyRows ?? [];
  const methodRows = input.supportMethodRows ?? [];
  const knownCapabilities = new Set<string>(PAYMENT_PROVIDER_CAPABILITIES);
  const validRows = capabilityRows.every((row) => knownCapabilities.has(row.capabilityCode));
  const validCurrencyRows = currencyRows.every((row) => /^[A-Z]{3}$/u.test(row.code));
  const validMethodRows = methodRows.every((row) => /^[a-z][a-z0-9._-]{1,63}$/u.test(row.code));
  const planEntitlements = new Set(input.planEntitlements ?? []);
  const policyBlockedCapabilities = new Set(input.policyBlockedCapabilities ?? []);
  const validPolicy = [...planEntitlements, ...policyBlockedCapabilities].every((capability) => knownCapabilities.has(capability));
  const providerSupportedCountries = new Set(input.providerSupportedCountries ?? []);
  const validCountries = [...providerSupportedCountries].every((country) => /^[A-Z]{2}$/u.test(country));
  if (!validRows || !validCurrencyRows || !validMethodRows || !validPolicy || !validCountries) {
    addReason(reasons, "projection_invalid");
  }

  const versionsValid = Number.isSafeInteger(connection.providerDescriptorVersion)
    && connection.providerDescriptorVersion > 0
    && Number.isSafeInteger(connection.capabilityPolicyVersion)
    && connection.capabilityPolicyVersion > 0;
  if (!versionsValid) addReason(reasons, "projection_invalid");
  const rowsMatchVersions = [...capabilityRows, ...currencyRows, ...methodRows].every((row) => (
    row.providerDescriptorVersion === connection.providerDescriptorVersion
    && row.capabilityPolicyVersion === connection.capabilityPolicyVersion
  ));
  if (!rowsMatchVersions) addReason(reasons, "projection_version_mismatch");

  const providerEnvironmentValid = connection.providerEnvironment === "sandbox"
    || connection.providerEnvironment === "live";
  if (!providerEnvironmentValid) addReason(reasons, "provider_environment_invalid");
  const providerAccountVerified = asBoolean(connection.providerAccountVerified);
  if (!providerAccountVerified) addReason(reasons, "provider_account_unverified");

  const connectionMode: PaymentConnectionMode | null = connection.connectionMode === "bring_your_own"
    || connection.connectionMode === "managed"
    ? connection.connectionMode
    : null;
  const modeSupported = descriptor !== null
    && connectionMode !== null
    && descriptor.connectionModes.includes(connectionMode)
    && (input.permittedConnectionModes === undefined || input.permittedConnectionModes.includes(connectionMode));
  if (!modeSupported) addReason(reasons, "mode_unsupported");
  if (descriptor !== null && connection.settlementMode !== descriptor.settlementMode) {
    addReason(reasons, "settlement_mode_mismatch");
  }
  const settlementPolicySupported = isSupportedPaymentSettlementPolicy(connection);
  if (!settlementPolicySupported) addReason(reasons, "settlement_policy_unsupported");
  const countrySupported = connection.merchantCountryCode !== null
    && /^[A-Z]{2}$/u.test(connection.merchantCountryCode)
    && providerSupportedCountries.has(connection.merchantCountryCode);
  if (!countrySupported) addReason(reasons, "country_unsupported");
  const providerCountryVerified = connection.providerAttestedCountryCode !== null
    && /^[A-Z]{2}$/u.test(connection.providerAttestedCountryCode)
    && providerSupportedCountries.has(connection.providerAttestedCountryCode);
  if (!providerCountryVerified) addReason(reasons, "provider_country_unverified");

  const healthyConnection = connectionStatus === "active"
    && webhookStatus === "verified"
    && healthFresh
    && webhookFresh
    && checkedAtValid
    && versionsValid
    && rowsMatchVersions
    && providerEnvironmentValid
    && providerAccountVerified
    && connection.shopId === input.tenantShopId
    && connection.providerCode === input.providerCode
    && descriptor !== null
    && modeSupported
    && connection.settlementMode === descriptor.settlementMode
    && settlementPolicySupported
    && countrySupported
    && providerCountryVerified;

  const effectiveCapabilities: PaymentProviderCapability[] = [];
  const effectiveCurrencies: string[] = [];
  const effectivePaymentMethods: string[] = [];
  if (healthyConnection) {
    for (const capability of descriptor.capabilities) {
      const row = capabilityRows.find((candidate) => candidate.capabilityCode === capability);
      if (row === undefined || !asBoolean(row.providerGranted) || !asBoolean(row.effectiveEnabled)) continue;
      if (row.revokedAt !== null && row.revokedAt !== undefined) continue;
      if (row.expiresAt !== null && row.expiresAt !== undefined) {
        const expiresAtMs = Date.parse(row.expiresAt);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs < nowMs) continue;
      }
      if (!planEntitlements.has(capability) || policyBlockedCapabilities.has(capability)) continue;
      effectiveCapabilities.push(capability);
    }
    for (const currency of descriptor.supportedCurrencies) {
      const row = currencyRows.find((candidate) => candidate.code === currency);
      if (row !== undefined && asBoolean(row.providerSupported) && asBoolean(row.effectiveEnabled)) effectiveCurrencies.push(currency);
    }
    for (const method of descriptor.supportedPaymentMethods) {
      const row = methodRows.find((candidate) => candidate.code === method);
      if (row !== undefined && asBoolean(row.providerSupported) && asBoolean(row.effectiveEnabled)) effectivePaymentMethods.push(method);
    }
  }

  const requiredCapabilities = input.requiredCapabilities ?? DEFAULT_REQUIRED_CAPABILITIES;
  for (const capability of requiredCapabilities) {
    if (effectiveCapabilities.includes(capability)) continue;
    const row = capabilityRows.find((candidate) => candidate.capabilityCode === capability);
    if (row?.revokedAt !== null && row?.revokedAt !== undefined) addReason(reasons, "capability_revoked");
    else if (row?.expiresAt !== null && row?.expiresAt !== undefined
      && (!Number.isFinite(Date.parse(row.expiresAt)) || Date.parse(row.expiresAt) < nowMs)) {
      addReason(reasons, "capability_expired");
    } else if (!planEntitlements.has(capability)) addReason(reasons, "capability_plan_unentitled");
    else if (policyBlockedCapabilities.has(capability)) addReason(reasons, "capability_policy_blocked");
    else addReason(reasons, "capability_missing");
  }
  if (effectiveCurrencies.length === 0) addReason(reasons, "currency_unsupported");
  if (effectivePaymentMethods.length === 0) addReason(reasons, "method_unsupported");
  if (input.currency !== null && input.currency !== undefined && !effectiveCurrencies.includes(input.currency)) {
    addReason(reasons, "currency_unsupported");
  }
  if (input.method !== null && input.method !== undefined && !effectivePaymentMethods.includes(input.method)) {
    addReason(reasons, "method_unsupported");
  }

  return freezeProjection({
    connectionStatus,
    configured: connection.shopId === input.tenantShopId && connectionStatus !== "disconnected",
    effectiveCapabilities,
    effectiveCurrencies,
    effectivePaymentMethods,
    healthFresh,
    providerCode: input.providerCode,
    ready: reasons.length === 0,
    reasons,
    registered,
    webhookFresh,
    webhookStatus,
  });
}

type LegacyPayOSReadinessInput = {
  checkedAt?: string | undefined;
  lastCheckedAt: string | null;
  lastWebhookVerifiedAt: string | null;
  status: string | null;
  webhookStatus: string | null;
};

/** Preserve the existing PayOS readiness semantics during generic projection cutover. */
export function projectLegacyPayOSReadiness(input: LegacyPayOSReadinessInput): PaymentProviderReadinessProjection {
  if (input.status === null || input.webhookStatus === null) {
    return projectPaymentProviderReadiness({
      checkedAt: input.checkedAt,
      connection: null,
      descriptors: [PAYOS_PROVIDER_DESCRIPTOR],
      providerCode: PAYOS_PROVIDER_DESCRIPTOR.code,
      tenantShopId: "legacy-payos-tenant",
    });
  }
  const status = input.status === "error" ? "degraded" : input.status;
  const connection: PaymentProviderConnectionReadiness = {
    capabilityPolicyVersion: 1,
    connectionMode: "bring_your_own",
    credentialOwnership: "seller",
    lastCheckedAt: input.lastCheckedAt,
    lastWebhookVerifiedAt: input.lastWebhookVerifiedAt,
    merchantCountryCode: "VN",
    providerAccountVerified: true,
    providerAttestedCountryCode: "VN",
    providerCode: "payos",
    providerDescriptorVersion: 1,
    providerEnvironment: "live",
    settlementMode: "direct",
    shopId: "legacy-payos-tenant",
    status,
    webhookStatus: input.webhookStatus,
  };
  const capabilityRows: PaymentCapabilityReadiness[] = PAYOS_PROVIDER_DESCRIPTOR.capabilities.map((capability) => ({
    capabilityCode: capability,
    capabilityPolicyVersion: 1,
    effectiveEnabled: status === "active" && input.webhookStatus === "verified",
    providerGranted: true,
    providerDescriptorVersion: 1,
  }));
  const supportCurrencyRows: PaymentSupportReadiness[] = PAYOS_PROVIDER_DESCRIPTOR.supportedCurrencies.map((code) => ({
    capabilityPolicyVersion: 1,
    code,
    effectiveEnabled: status === "active" && input.webhookStatus === "verified",
    providerSupported: true,
    providerDescriptorVersion: 1,
  }));
  const supportMethodRows: PaymentSupportReadiness[] = PAYOS_PROVIDER_DESCRIPTOR.supportedPaymentMethods.map((code) => ({
    capabilityPolicyVersion: 1,
    code,
    effectiveEnabled: status === "active" && input.webhookStatus === "verified",
    providerSupported: true,
    providerDescriptorVersion: 1,
  }));
  return projectPaymentProviderReadiness({
    capabilityRows,
    checkedAt: input.checkedAt,
    connection,
    descriptors: [PAYOS_PROVIDER_DESCRIPTOR],
    planEntitlements: PAYOS_PROVIDER_DESCRIPTOR.capabilities,
    providerCode: "payos",
    providerSupportedCountries: ["VN"],
    supportCurrencyRows,
    supportMethodRows,
    tenantShopId: "legacy-payos-tenant",
  });
}

/** Read the additive provider projection with tenant-leading predicates. */
export async function loadPaymentProviderReadiness(input: {
  checkedAt?: string | undefined;
  currency?: string | null | undefined;
  descriptors: readonly PaymentProviderDescriptor[];
  env: Pick<AppBindings, "PLATFORM_DB">;
  healthTtlMs?: number | undefined;
  method?: string | null | undefined;
  permittedConnectionModes?: readonly PaymentConnectionMode[] | undefined;
  planEntitlements: readonly PaymentProviderCapability[];
  policyBlockedCapabilities?: readonly PaymentProviderCapability[] | undefined;
  providerCode: string;
  providerSupportedCountries: readonly string[];
  requiredCapabilities?: readonly PaymentProviderCapability[] | undefined;
  shopId: string;
}): Promise<PaymentProviderReadinessProjection> {
  try {
    const connection = await input.env.PLATFORM_DB.prepare(`
      SELECT id, shop_id AS shopId, provider_code AS providerCode,
        provider_environment AS providerEnvironment,
        provider_descriptor_version AS providerDescriptorVersion,
        capability_policy_version AS capabilityPolicyVersion,
        connection_mode AS connectionMode, settlement_mode AS settlementMode,
        credential_ownership AS credentialOwnership, merchant_country_code AS merchantCountryCode,
        provider_attested_country_code AS providerAttestedCountryCode,
        provider_account_fingerprint IS NOT NULL AS providerAccountVerified,
        status, webhook_status AS webhookStatus,
        last_checked_at AS lastCheckedAt, last_webhook_verified_at AS lastWebhookVerifiedAt
      FROM payment_provider_connections
      WHERE shop_id = ? AND provider_code = ?
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'degraded' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,
        updated_at DESC, id
      LIMIT 1
    `).bind(input.shopId, input.providerCode).first<ConnectionRow>();
    if (connection === null) {
      return projectPaymentProviderReadiness({
        checkedAt: input.checkedAt,
        connection: null,
        descriptors: input.descriptors,
        healthTtlMs: input.healthTtlMs,
        permittedConnectionModes: input.permittedConnectionModes,
        planEntitlements: input.planEntitlements,
        policyBlockedCapabilities: input.policyBlockedCapabilities,
        providerCode: input.providerCode,
        providerSupportedCountries: input.providerSupportedCountries,
        requiredCapabilities: input.requiredCapabilities,
        tenantShopId: input.shopId,
      });
    }
    const [capabilities, currencies, methods] = await Promise.all([
      input.env.PLATFORM_DB.prepare(`
        SELECT capability_code AS capabilityCode, provider_granted AS providerGranted,
          effective_enabled AS effectiveEnabled, expires_at AS expiresAt,
          revoked_at AS revokedAt, evaluated_at AS evaluatedAt,
          provider_descriptor_version AS providerDescriptorVersion,
          capability_policy_version AS capabilityPolicyVersion
        FROM payment_provider_connection_capabilities
        WHERE shop_id = ? AND connection_id = ?
        ORDER BY capability_code
      `).bind(input.shopId, connection.id).all<CapabilityRow>(),
      input.env.PLATFORM_DB.prepare(`
        SELECT currency_code AS code, provider_supported AS providerSupported,
          effective_enabled AS effectiveEnabled,
          provider_descriptor_version AS providerDescriptorVersion,
          capability_policy_version AS capabilityPolicyVersion
        FROM payment_provider_connection_currencies
        WHERE shop_id = ? AND connection_id = ?
        ORDER BY currency_code
      `).bind(input.shopId, connection.id).all<SupportRow>(),
      input.env.PLATFORM_DB.prepare(`
        SELECT method_code AS code, provider_supported AS providerSupported,
          effective_enabled AS effectiveEnabled,
          provider_descriptor_version AS providerDescriptorVersion,
          capability_policy_version AS capabilityPolicyVersion
        FROM payment_provider_connection_methods
        WHERE shop_id = ? AND connection_id = ?
        ORDER BY method_code
      `).bind(input.shopId, connection.id).all<SupportRow>(),
    ]);
    return projectPaymentProviderReadiness({
      capabilityRows: capabilities.results,
      checkedAt: input.checkedAt,
      connection,
      currency: input.currency,
      descriptors: input.descriptors,
      healthTtlMs: input.healthTtlMs,
      method: input.method,
      permittedConnectionModes: input.permittedConnectionModes,
      planEntitlements: input.planEntitlements,
      policyBlockedCapabilities: input.policyBlockedCapabilities,
      providerCode: input.providerCode,
      providerSupportedCountries: input.providerSupportedCountries,
      requiredCapabilities: input.requiredCapabilities,
      supportCurrencyRows: currencies.results,
      supportMethodRows: methods.results,
      tenantShopId: input.shopId,
    });
  } catch {
    return freezeProjection({
      connectionStatus: null,
      configured: false,
      effectiveCapabilities: [],
      effectiveCurrencies: [],
      effectivePaymentMethods: [],
      healthFresh: false,
      providerCode: input.providerCode,
      ready: false,
      reasons: ["projection_invalid"],
      registered: findDescriptor(input.descriptors, input.providerCode) !== null,
      webhookFresh: false,
      webhookStatus: null,
    });
  }
}
