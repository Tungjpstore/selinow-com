# ADR 0003: Opaque sessions and tenant-scoped authorization

## Status

Accepted

## Context

Phase 2 introduces seller authentication, shop membership, subscriptions and platform administration on a shared D1 database. Session fixation, CSRF and cross-tenant access are primary risks. Staging uses a restricted Cloudflare Email Service binding for magic-link delivery, and production authorization must not depend on client-provided roles or shop IDs.

## Decision

- Use one-time magic-link tokens and opaque session tokens; store only purpose-bound HMAC values in D1.
- Rotate to a new session and CSRF token after every successful magic-link consumption.
- Require the exact dashboard origin plus a session-bound double-submit CSRF token for cookie-authenticated mutations.
- Resolve seller authorization through active `(shop_id, user_id)` membership rows and keep every resource mutation scoped by the resolved shop ID.
- Keep platform-admin authorization in a separate table rather than elevating seller roles.
- Use direct D1 transaction scripts for Phase 2 instead of introducing an ORM or generic repository layer.

## Trade-offs

- Magic-link delivery depends on the onboarded sender domain and the per-environment `EMAIL` binding; the Worker does not store a provider API key.
- Session authentication performs a D1 lookup; caching authorization state is deferred until measurements justify it.
- Direct SQL creates more explicit code, but keeps tenant predicates and conditional updates visible during the security-sensitive foundation phase.

## Consequences

- Replayed magic links and revoked/expired sessions fail closed.
- Client-provided role or shop identifiers never become authorization authority.
- Future catalog, inventory and order modules can reuse the same session, membership and entitlement guards.
