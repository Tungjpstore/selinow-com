export const PHASE7_PREFLIGHT_SQL: string;
export const PAYMENT_PROVIDER_SCHEMA_TABLES: readonly string[];
export const PAYMENT_PROVIDER_SCHEMA_SQL: string;
export const PAYMENT_PROVIDER_PREFLIGHT_SQL: string;
export const PAYOS_RELATIONSHIP_PREFLIGHT_SQL: string;

export type Phase7PreflightCounts = {
  canonicalNullShops: number;
  duplicatePrimaryShops: number;
  duplicateProviderIds: number;
  invalidCanonicalLinks: number;
  legacyCustomDomains: number;
  unresolvedActiveAttemptOrigins: number;
};

export type Phase7PreflightCheck = {
  code: string;
  detail: string;
  ok: boolean;
};

export type PaymentProviderPreflightCounts = {
  invalidPayosCapabilityGrants: number;
  invalidPayosConnectionLinks: number;
  invalidPayosCurrencyGrants: number;
  invalidPayosMethodGrants: number;
  invalidPayosReferenceCodes: number;
  missingPayosConnections: number;
  stalePayosDisconnectProjectionState: number;
  staleEffectiveAuthorizations: number;
};

export type PayosRelationshipPreflightCounts = {
  invalidPayosActiveCredentialLinks: number;
  invalidPayosAttemptLinks: number;
  invalidPayosCredentialIntegrationLinks: number;
  invalidPayosEventLinks: number;
  invalidPayosExceptionLinks: number;
  invalidPayosPaidEventLinks: number;
};

export function parseD1PreflightOutput(output: string): Phase7PreflightCounts;
export function evaluatePhase7Preflight(counts: Phase7PreflightCounts): {
  checks: Phase7PreflightCheck[];
  ok: boolean;
};
export function parsePaymentProviderSchemaOutput(output: string): {
  applied: boolean;
  tables: readonly string[];
};
export function parsePaymentProviderPreflightOutput(output: string): PaymentProviderPreflightCounts;
export function evaluatePaymentProviderPreflight(counts: PaymentProviderPreflightCounts): {
  checks: Phase7PreflightCheck[];
  ok: boolean;
};
export function parsePayosRelationshipPreflightOutput(output: string): PayosRelationshipPreflightCounts;
export function evaluatePayosRelationshipPreflight(counts: PayosRelationshipPreflightCounts): {
  checks: Phase7PreflightCheck[];
  ok: boolean;
};
