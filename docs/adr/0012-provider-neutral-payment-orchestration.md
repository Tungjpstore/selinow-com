# ADR 0012: Provider-neutral payment orchestration

## Status

Accepted

## Date

2026-07-26

## Context

PayOS is the first tenant payment provider and the current implementation correctly protects its signature, credential ownership, reconciliation and payment-decision invariants. Future sales channels may use another direct-to-seller payment provider or a marketplace-native checkout. Provider-specific request and credential types must not become the definition of payment state.

## Decision

- Keep the payment domain authoritative for payment attempts, evidence, decisions, exceptions and fulfillment eligibility.
- Define small provider ports for:
  - credential authorization and health;
  - create or recover payment intent/link;
  - verify and normalize webhook evidence;
  - reconcile provider state;
  - optional cancel or refund capabilities when explicitly supported.
- Keep PayOS as the first adapter. Preserve its exact signing, order-code, credential-version, webhook and reconciliation contracts inside the PayOS module.
- Normalize provider evidence into the existing conservative decision vocabulary. A provider adapter cannot mark an order paid directly.
- Describe every adapter with a validated provider code, explicit capabilities, connection/settlement modes, supported currencies and supported payment methods. Descriptor validation must reject duplicate, malformed or overstated capability metadata before it reaches connection/readiness projection.
- Require adapters to authenticate provider-specific webhook/reconciliation input and return a bounded `NormalizedPaymentEvidence` projection. The adapter contract receives no D1 binding; the payment domain compares normalized evidence with authoritative attempt expectations and owns the conservative decision.
- Distinguish Selinow checkout from marketplace-native checkout. Marketplace payment status is imported only from authenticated provider evidence and remains linked to the owning external order and connection.
- Resolve effective payment capabilities through the same connection and entitlement model as sales channels. Do not assume every shop or channel can create external payment links, refunds or native checkout.
- Persist the provider-neutral projection additively. Migration `0035_payment_provider_connections.sql` introduces tenant-scoped connections, capability/currency/method grants and immutable provider metadata, with a deterministic PayOS bridge. Migration `0036_payos_identity_claim_hardening.sql` removes unverified legacy ownership claims. Migration `0037_legacy_payos_tenant_guards.sql` validates and guards exact tenant/provider relationships across the authoritative PayOS integration, credential, attempt, event and exception tables. Migration `0039_payment_provider_identity_shred.sql` permits only deletion-fenced crypto-shredding of generic provider identity claims. Those legacy tables remain authoritative until an explicitly reviewed runtime cutover.
- Preserve direct-to-seller settlement as the default product boundary. Adding platform custody, split payments, payouts or balance accounting requires a separate legal and architectural decision.
- Keep return and cancel URLs informational. Only verified provider evidence or direct reconciliation can confirm payment.

## Trade-offs

- A provider port adds indirection around a currently working PayOS integration.
- Payment providers expose different identity, amount, refund and webhook semantics, so the port cannot erase provider-specific validation.
- Marketplace-native payments need separate settlement and exception views even when they share order and fulfillment records.
- A second payment adapter should not be implemented until merchant demand and provider access justify its operational cost.
- A fake provider proves portability of evidence/decision contracts but does not prove provider credentials, webhook operations, reconciliation reliability, policy eligibility or settlement behavior.

## Consequences

- Commerce channels request a payment capability or handoff rather than call a PayOS-specific function.
- Existing PayOS security decisions remain intact while future providers can reuse payment state and fulfillment gates.
- Provider contract tests remain adapter-specific; payment decision and fulfillment tests remain provider-neutral.
- Platform billing credentials, tenant sales credentials and marketplace settlement evidence stay in separate trust and accounting boundaries.
- The first bounded implementation publishes a truthful PayOS descriptor, maps the legacy PayOS decision API into the normalized conservative decision and runs a fake second provider through authentication and mismatch tests. The persistence/hardening slice is additive and source/local-only (`0035`-`0037`, `0039`); it does not add provider credentials, webhooks, checkout, reconciliation or fulfillment runtime, does not alter the active PayOS runtime, and does not claim Stripe support.

## Revisit triggers

Revisit the payment boundary before introducing refunds, subscriptions paid through seller channels, platform-held funds, split settlement, payouts or a provider whose consistency model cannot be represented by the current attempt and evidence lifecycle.
