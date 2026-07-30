# ADR 0008: Extensible channel connections, identities and capabilities

## Status

Accepted

## Date

2026-07-26

## Context

The current runtime models website and Telegram explicitly. Fixed database checks, onboarding booleans and provider-specific identities make every additional channel a schema-wide change. Future channels also differ materially: a shop may connect multiple pages, bots, phone numbers or marketplace accounts, and each connection may receive a different set of provider grants.

Treating all providers as equivalent would either expose unsupported actions or spread provider conditionals across the application.

## Decision

- Introduce a versioned channel registry and migrate toward these generic concepts:
  - `shop_channels` for a logical sales channel selected by a shop;
  - `channel_connections` for a concrete provider account, page, bot, phone number or marketplace shop;
  - `channel_credentials` for an encrypted, versioned provider credential envelope;
  - channel-scoped customer identities and encrypted outbound recipients;
  - provider event receipts and action claims for deduplication and replay protection;
  - external order references and order attribution for native marketplace orders.
- Permit multiple connections of the same provider for one shop. Uniqueness applies to the provider's active external account identity, not blindly to `(shop_id, provider)`.
- Scope an external customer subject to its connection. Provider user IDs are not assumed globally stable across pages, apps, bots or business accounts.
- Keep provider codes open and validated by the server registry rather than by a closed SQL enum that requires rebuilding core tables for each new provider.
- Resolve effective capabilities as the intersection of:
  1. capabilities implemented by the adapter;
  2. scopes or grants returned by the provider;
  3. the shop plan entitlement;
  4. the seller's enabled settings;
  5. current connection health and policy state.
- Model capabilities as specific operations, for example inbound conversation, outbound transactional message, rich UI, catalog publish, interactive cart, external checkout link, native checkout, order import, status push, fulfillment push, private identity and managed provisioning.
- Store provider constraints separately from capability names, including message-size limits, media formats, messaging windows, approved-template requirements and secure-fulfillment restrictions.
- Preserve provider-specific tables when they carry useful constraints. Generic registry rows establish common identity and lifecycle; they do not require forcing every provider payload into one unvalidated JSON table.
- Migrate with forward-only schema changes, dual read or dual write where necessary, backfill, verification and explicit cutover. Existing numbered migrations are never edited.

## Trade-offs

- A registry and capability calculation are more complex than adding another boolean feature flag.
- Supporting multiple connections requires explicit connection selection and attribution in dashboard and job contracts.
- Open provider codes move validation from SQL checks into the application registry, so registry tests and migration preflight become release requirements.
- Provider-specific detail tables remain, which avoids a lowest-common-denominator schema but requires disciplined boundaries.

## Consequences

- The dashboard and onboarding can render connectors from server manifests instead of adding a new hard-coded page and readiness branch for every provider.
- Unsupported operations fail closed both in UI projection and server authorization.
- Identity, event and delivery deduplication remain tenant- and connection-scoped.
- Adding a new channel no longer requires expanding `web|telegram` checks throughout core commerce state.
- Data export, deletion, rotation and operations workflows must discover registered connection families rather than enumerate Telegram-specific resources forever.

## Revisit triggers

Revisit the registry shape after two non-Telegram provider families are live. Add further generic columns only when repeated provider implementations prove the concept is common; keep one-off fields in provider modules.
