# ADR 0014: Public API credential boundary

## Status

Accepted

## Date

2026-07-29

## Context

Selinow needs a versioned server-to-server API for tenant integrations without reusing seller browser sessions, storefront hostname authority or provider webhook identities. A client-supplied tenant ID cannot be trusted, and a recoverable token stored in D1 would turn a database disclosure into direct API access.

The first useful integration surfaces are read-only shop and catalog projections. Inventory, order, payment, fulfillment, entitlement and outbound webhook contracts still require their own scope, idempotency, concurrency and lifecycle decisions. The credential model must therefore start narrowly and must not imply authority that the current runtime does not implement.

## Options considered

1. Reuse seller sessions and membership capabilities for server-to-server clients.
2. Issue broad tenant API keys and store encrypted recoverable plaintext in D1.
3. Add owner-managed, scoped credentials whose keyed digest is stored and whose tenant is derived only after successful token authentication.

## Decision

- Keep public API credentials separate from seller sessions, channel/provider credentials, storefront order tokens and webhook secrets.
- Only an active owner with recent authentication may list, issue or revoke credentials. Mutations require CSRF protection and an idempotency key; revocation also requires the expected credential version and records one tenant-scoped security audit event.
- Return the full bearer token once on successful issuance. Store only a purpose-bound HMAC digest under `IDENTIFIER_HMAC_SECRET`; never log or redisplay the plaintext token or any digest. Seller-facing exports omit token and revocation digests. Protected full database backups retain the keyed token/revocation digests and lifecycle state required to preserve credential authentication and revocation after restore, but never contain raw bearer tokens or other raw secret values.
- Bind the token format to the application environment and an opaque credential public ID. Compare the computed digest in constant time.
- Make credential ID, public ID, tenant, name, scope grant, token digest, expiry, creator and creation time immutable. Allow only `active -> revoked`, prohibit physical deletion and retain safe lifecycle metadata for audit and deletion evidence.
- Begin with `shop:read` for `GET /api/v1/shop` and `catalog:read` for `GET /api/v1/catalog`. The catalog route returns only active tenant catalog projections and derived stock state, with private non-cacheable responses.
- Derive the authoritative `shop_id` exclusively from the authenticated credential. Ignore or reject tenant selectors supplied through the path, query, body or auxiliary headers.
- Recheck credential status/expiry, required scope, shop lifecycle and subscription eligibility on every request. Apply a D1-backed fixed-window rate limit per credential; KV is not quota authority.
- Cap each shop at ten active, unexpired credentials. Expired credentials remain visible lifecycle evidence but do not consume active capacity.
- Include safe credential metadata in tenant export and deletion validation while excluding token and revocation hashes from seller-facing exports. Protected full database backups include the keyed digests and lifecycle state needed for authentication, revocation and audit continuity; they never include raw bearer tokens or other raw secret values. Shop deletion revokes active credentials instead of deleting the audit history.

## Rationale

A narrow, hash-only credential boundary limits the blast radius of both database disclosure and future scope mistakes. Deriving tenant authority from the credential removes confused-deputy paths in which a valid key could be paired with another shop ID. Keeping management on the existing owner/session boundary preserves recent-auth, CSRF, idempotency and audit controls without making browser sessions valid public API credentials.

## Trade-offs

- A lost token cannot be recovered; the owner must issue a replacement and revoke the old credential.
- The first slices support read-only shop metadata and catalog projections; integrations needing inventory, orders or webhooks must wait for reviewed scope expansion.
- A D1 rate-limit write adds latency and database load to each public API request, but it keeps the enforcement boundary authoritative and tenant-scoped.
- Fixed immutable grants require issuing a new credential when scopes expand instead of mutating an existing credential in place.
- Full disaster-recovery and point-in-time snapshots retain keyed credential digests rather than a sanitized export. Restoring a point before a later revocation can therefore restore that credential's earlier active state. A restore must reconcile and rotate or revoke API credentials before admitting API traffic; automated post-restore invalidation remains an unresolved design requirement.

## Consequences

- Seller browser sessions, public API clients and provider webhooks have distinct authentication and tenant-resolution paths.
- A credential for one shop cannot select another shop by changing request input.
- Credential issuance/revocation is replay-safe and auditable, while token use does not advance the optimistic revocation version.
- New public resources require an explicit scope/operation matrix, tenant-leading queries, idempotency and concurrency behavior, rate-limit policy, redaction rules, lifecycle integration and contract tests before release.
- Migrations `0038_api_credentials.sql` and `0040_api_catalog_scope.sql`, plus `GET /api/v1/shop` and `GET /api/v1/catalog`, form a source/local-only foundation. They do not claim staging application, broader public API completeness, outbound webhook subscriptions or production readiness.

## Revisit triggers

Revisit this decision before adding write scopes, delegated non-owner issuance, machine-to-machine OAuth, fine-grained resource grants, IP or mTLS constraints, outbound webhook subscriptions, a distributed rate limiter, automated post-restore credential invalidation or an independently deployed API service.
