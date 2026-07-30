import { AppError } from "../core/errors";

export const PAYMENT_PROVIDER_CAPABILITIES = [
  "checkout.create",
  "credential.health",
  "payment.reconcile",
  "refund.create",
  "webhook.verify",
] as const;

export type PaymentProviderCapability = typeof PAYMENT_PROVIDER_CAPABILITIES[number];
export type PaymentConnectionMode = "bring_your_own" | "managed";
export type PaymentSettlementMode = "direct" | "mor_partner";
export type PaymentCredentialOwnership = "seller" | "platform" | "provider_partner";
export type PaymentProviderEnvironment = "sandbox" | "live";

export const PAYMENT_PROVIDER_DEFINITION_VERSION = 1 as const;

export const PAYMENT_PROVIDER_OPERATION_BY_CAPABILITY = {
  "checkout.create": "createCheckout",
  "credential.health": "checkCredentialHealth",
  "payment.reconcile": "reconcile",
  "refund.create": "createRefund",
  "webhook.verify": "verifyAndNormalizeWebhook",
} as const satisfies Record<PaymentProviderCapability, string>;

export type PaymentProviderDefinitionVersion = typeof PAYMENT_PROVIDER_DEFINITION_VERSION;
export type PaymentProviderOperationName = typeof PAYMENT_PROVIDER_OPERATION_BY_CAPABILITY[PaymentProviderCapability];

export type PaymentProviderDescriptor = {
  capabilities: readonly PaymentProviderCapability[];
  code: string;
  connectionModes: readonly PaymentConnectionMode[];
  settlementMode: PaymentSettlementMode;
  supportedCurrencies: readonly string[];
  supportedPaymentMethods: readonly string[];
};

/**
 * Selinow does not support platform-owned credentials for direct settlement.
 * Direct connections remain seller-owned; managed connections require a
 * provider partner acting as merchant of record.
 */
export function isSupportedPaymentSettlementPolicy(input: Readonly<{
  connectionMode: string;
  credentialOwnership: string;
  settlementMode: string;
}>): boolean {
  return (input.connectionMode === "bring_your_own"
      && input.credentialOwnership === "seller"
      && input.settlementMode === "direct")
    || (input.connectionMode === "managed"
      && input.credentialOwnership === "provider_partner"
      && input.settlementMode === "mor_partner");
}

/** Verified provider evidence after provider-specific parsing and authentication. */
export type PaymentProviderEvidenceBinding = Readonly<{
  /** D1-authoritative tenant and order identity; never sourced from a buyer redirect. */
  shopId: string;
  orderId: string;
  providerCode: string;
  providerEnvironment: PaymentProviderEnvironment;
  connectionId: string;
  credentialId: string;
  credentialVersion: number;
  /** HMAC/fingerprint only; raw provider account identifiers are not accepted. */
  providerAccountFingerprint: string;
  settlementMode: PaymentSettlementMode;
}>;

export type NormalizedPaymentEvidence = {
  amountMinor: number;
  attemptReference: string;
  currency: string;
  description: string;
  occurredAt: string;
  paymentReference: string | null;
  providerStatus: string;
  reference: string;
  success: boolean;
  binding: PaymentProviderEvidenceBinding;
};

/** Authoritative attempt fields used by the conservative payment decision. */
export type PaymentAttemptExpectation = {
  amountMinor: number;
  attemptReference: string;
  currency: string;
  description: string;
  expiresAt: string;
  paymentReference: string | null;
  binding: PaymentProviderEvidenceBinding;
};

export function samePaymentProviderEvidenceBinding(
  evidence: PaymentProviderEvidenceBinding,
  expectation: PaymentProviderEvidenceBinding,
): boolean {
  return evidence.shopId === expectation.shopId
    && evidence.orderId === expectation.orderId
    && evidence.providerCode === expectation.providerCode
    && evidence.providerEnvironment === expectation.providerEnvironment
    && evidence.connectionId === expectation.connectionId
    && evidence.credentialId === expectation.credentialId
    && evidence.credentialVersion === expectation.credentialVersion
    && evidence.providerAccountFingerprint === expectation.providerAccountFingerprint
    && evidence.settlementMode === expectation.settlementMode;
}

/**
 * Provider adapters own provider I/O only. They do not receive a D1 binding
 * and cannot mark orders paid or trigger fulfillment.
 */
export interface PaymentProviderAdapter<
  WebhookInput,
  ReconciliationInput,
  CheckoutInput = never,
  CredentialHealthInput = never,
  RefundInput = never,
  CheckoutOutput = unknown,
  CredentialHealthOutput = unknown,
  RefundOutput = unknown,
> {
  readonly descriptor: PaymentProviderDescriptor;
  checkCredentialHealth?(input: CredentialHealthInput): Promise<CredentialHealthOutput>;
  createCheckout?(input: CheckoutInput): Promise<CheckoutOutput>;
  createRefund?(input: RefundInput): Promise<RefundOutput>;
  reconcile?(input: ReconciliationInput): Promise<NormalizedPaymentEvidence>;
  verifyAndNormalizeWebhook(input: WebhookInput): Promise<NormalizedPaymentEvidence>;
}

type ProviderOperation = (...args: never[]) => unknown;
type ProviderAdapterBoundary = Readonly<{ descriptor: PaymentProviderDescriptor }>
  & Readonly<Partial<Record<PaymentProviderOperationName, ProviderOperation>>>;
type OperationsForCapabilities<Capabilities extends readonly PaymentProviderCapability[]> = {
  readonly [Operation in typeof PAYMENT_PROVIDER_OPERATION_BY_CAPABILITY[Capabilities[number]]]-?: ProviderOperation;
} & {
  readonly [Operation in Exclude<PaymentProviderOperationName, typeof PAYMENT_PROVIDER_OPERATION_BY_CAPABILITY[Capabilities[number]]>]?: never;
};

export type PaymentProviderDefinition<Adapter extends ProviderAdapterBoundary = ProviderAdapterBoundary> = Readonly<{
  adapter: Adapter;
  version: PaymentProviderDefinitionVersion;
}>;

const PROVIDER_CODE = /^[a-z][a-z0-9._-]{1,63}$/u;
const PAYMENT_METHOD = /^[a-z][a-z0-9._-]{1,63}$/u;
const CURRENCY = /^[A-Z]{3}$/u;

function uniqueValues(values: readonly string[], allowed?: ReadonlySet<string>): boolean {
  return values.length > 0
    && new Set(values).size === values.length
    && (allowed === undefined || values.every((value) => allowed.has(value)));
}

/** Validate static adapter metadata before it can be used for capability projection. */
export function definePaymentProviderDescriptor<const Descriptor extends PaymentProviderDescriptor>(input: Descriptor): Readonly<Descriptor> {
  const allowedCapabilities = new Set<string>(PAYMENT_PROVIDER_CAPABILITIES);
  const allowedConnectionModes = new Set<string>(["bring_your_own", "managed"]);
  const allowedSettlementModes = new Set<string>(["direct", "mor_partner"]);
  if (!PROVIDER_CODE.test(input.code)
    || !uniqueValues(input.capabilities, allowedCapabilities)
    || !input.capabilities.includes("webhook.verify")
    || !uniqueValues(input.connectionModes, allowedConnectionModes)
    || !allowedSettlementModes.has(input.settlementMode)
    || !uniqueValues(input.supportedCurrencies)
    || input.supportedCurrencies.some((currency) => !CURRENCY.test(currency))
    || !uniqueValues(input.supportedPaymentMethods)
    || input.supportedPaymentMethods.some((method) => !PAYMENT_METHOD.test(method))) {
    throw new AppError("payment_provider_descriptor_invalid", 500);
  }
  return Object.freeze({
    ...input,
    capabilities: Object.freeze([...input.capabilities]),
    connectionModes: Object.freeze([...input.connectionModes]),
    supportedCurrencies: Object.freeze([...input.supportedCurrencies]),
    supportedPaymentMethods: Object.freeze([...input.supportedPaymentMethods]),
  });
}

function definitionIssue(definition: { adapter: ProviderAdapterBoundary; version: number }): string | null {
  if (definition.version !== PAYMENT_PROVIDER_DEFINITION_VERSION) return "definition_version_invalid";
  for (const capability of PAYMENT_PROVIDER_CAPABILITIES) {
    const operation = PAYMENT_PROVIDER_OPERATION_BY_CAPABILITY[capability];
    const implemented = typeof definition.adapter[operation] === "function";
    const declared = definition.adapter.descriptor.capabilities.includes(capability);
    if (declared && !implemented) return `capability_operation_missing:${capability}`;
    if (!declared && implemented) return `operation_capability_missing:${capability}`;
  }
  return null;
}

function assertPaymentProviderDefinition(definition: { adapter: ProviderAdapterBoundary; version: number }): void {
  // Revalidate the descriptor because registry definitions may come from dynamic modules.
  definePaymentProviderDescriptor(definition.adapter.descriptor);
  const issue = definitionIssue(definition);
  if (issue !== null) throw new AppError("payment_provider_definition_invalid", 500, [issue]);
}

/** Bind provider metadata to the exact operations implemented by one adapter. */
export function definePaymentProvider<const Adapter extends ProviderAdapterBoundary>(input: Readonly<{
  adapter: Adapter & OperationsForCapabilities<Adapter["descriptor"]["capabilities"]>;
  version: PaymentProviderDefinitionVersion;
}>): PaymentProviderDefinition<Adapter> {
  assertPaymentProviderDefinition(input);
  return Object.freeze({ adapter: input.adapter, version: input.version });
}

/** Resolve only versioned provider definitions whose capabilities match their operations. */
export class PaymentProviderRegistry {
  private readonly definitions: ReadonlyMap<string, PaymentProviderDefinition>;

  constructor(definitions: readonly PaymentProviderDefinition[]) {
    const entries = new Map<string, PaymentProviderDefinition>();
    for (const definition of definitions) {
      assertPaymentProviderDefinition(definition);
      const { code } = definition.adapter.descriptor;
      if (entries.has(code)) throw new AppError("payment_provider_registry_invalid", 500, ["provider_duplicate"]);
      entries.set(code, definition);
    }
    this.definitions = entries;
  }

  get(code: string): PaymentProviderDefinition | null {
    return this.definitions.get(code) ?? null;
  }

  list(): readonly PaymentProviderDefinition[] {
    return Object.freeze([...this.definitions.values()]);
  }

  require(code: string): PaymentProviderDefinition {
    const definition = this.get(code);
    if (definition === null) throw new AppError("payment_provider_unknown", 404);
    return definition;
  }
}
