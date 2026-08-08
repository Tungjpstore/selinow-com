# Security

## Secret policy

- Global secrets are Cloudflare Worker secrets and never appear in `wrangler.jsonc`.
- Tenant credentials and inventory keys are encrypted in D1 with AES-256-GCM, random 96-bit IVs, versioned keys and purpose-bound AAD.
- `.dev.vars.example` contains placeholders only; `.dev.vars` is ignored by Git.
- Logs, errors, queue payloads and audit metadata must use explicit allowlists and must not contain credentials, provider signatures or license-key plaintext.

## HTTP baseline

Phase 0 establishes request IDs, a restrictive default CSP, clickjacking protection, MIME sniffing protection, permissions policy and stable error responses. Sensitive feature routes added later must also use `private, no-store` and `noindex`.

Phase 2 adds one-time hashed magic links, opaque hashed sessions, session rotation, host-only secure cookies outside local development, exact-origin CSRF validation, session-bound double-submit tokens, membership authorization and a separate platform-admin boundary. The deployed Selinow staging Worker stores `SESSION_SECRET` and `MAGIC_LINK_SECRET` as Cloudflare Worker secrets; magic-link delivery uses the restricted Cloudflare Email Service `EMAIL` binding and the onboarded `no-reply@selinow.com` sender. Provider failures map to a safe error and never expose a magic-link token.

Magic-link admission applies one D1 fixed window across three independent controls: a global request ceiling, a keyed requester-address ceiling and a keyed normalized-email delivery ceiling. Global and requester exhaustion return a generic rate-limit error before user or token creation. Email identity is recorded only as a keyed subject hash, and email exhaustion returns the same accepted response while suppressing delivery, so the endpoint does not disclose whether an account exists. The trusted requester signal is the bounded Cloudflare connecting address; forwarded headers are not accepted as identity.

Seller sessions remain opaque and D1-authoritative. `GET /api/auth/sessions` returns only session IDs and lifecycle timestamps, marks the current session and excludes token hashes. Authenticated activity refreshes `last_seen_at` at a bounded interval without making that metadata part of admission. `DELETE /api/auth/sessions` requires CSRF and recent authentication, revokes every active session for the authenticated user and clears the current browser cookies. A revoked session cannot be restored by a later activity update.

Phase 3 scopes every catalog and inventory mutation by membership-resolved `shop_id`. License-key duplicate detection uses an independent keyed HMAC and returns generic errors without plaintext. Public catalog queries project only safe fields. Checkout ignores client price/stock authority, atomically reserves available rows, compensates only its opaque reservation token, and stores only purpose-bound HMAC order tokens. Private order/key responses are `no-store`, `noindex` and return 404 for invalid tokens to avoid enumeration.

Phase 4 encrypts PayOS client ID, API key and checksum key independently under `CREDENTIAL_KEK_V1`; plaintext exists only in bounded request/provider-call memory. Webhook paths use opaque random IDs, signatures are verified in constant time with the credential version belonging to that integration, and cross-tenant order-code resolution never falls back globally. Return/cancel URLs carry no payment authority. Only a valid signed event or a response-signature-verified reconciliation result can enter the payment decision engine.

Phase 5 uses the same credential KEK with a distinct Telegram AAD purpose for bot tokens, webhook secrets and recipient chat IDs. Token fingerprints are global keyed HMACs so a live bot cannot cross shops; buyer subjects are per-shop keyed HMACs so raw Telegram IDs are not authorization keys or log fields. The webhook secret header is verified in constant time before content type, body size or JSON parsing. Update replay, conflicting-payload audit, callback allowlists and private-chat checks occur before commerce or key access. Paid-notification jobs contain only order references and decrypt recipient/token data only while sending.

Generated-license provider credentials reuse the credential keyring, while generated artifacts reuse the inventory keyring. They do not reuse another feature's ciphertext contract: distinct AAD purposes bind provider secrets to the exact shop, connection and credential, and bind artifacts to the exact shop, request, artifact and format. Operator rotations expose separate `generated_license_credentials` and `generated_license_artifacts` families, retain keyed fingerprints across re-encryption, and write only resource references and safe error codes to rotation ledgers. Corrupt ciphertext enters manual review; fenced writes remain retryable. Old KEKs remain configured until the corresponding generated-license rotation reports zero source-version rows and backup-retention checks permit retirement.

## Privacy and operations controls

Buyer privacy mutations are authenticated, CSRF-protected, recent-authenticated, idempotent and tenant-bound through the resolved shop membership. Export uses an explicit projection rather than a table dump. Anonymization refuses active operational records, removes direct customer profile fields and provider identities, redacts customer notes, and retains only the financial, fulfillment and audit references required by the recorded lifecycle. This internal seller workflow does not publish a platform privacy policy or a public data-subject intake channel.

The first platform owner is never seeded by a migration. The bootstrap command requires an exact active platform user, explicit execution confirmation, empty `platform_admins` state and an empty one-time receipt table. A durable `first_platform_admin` receipt prevents the ceremony from being reused; later platform-admin management requires a separately reviewed authenticated workflow.

The admin operations surface exposes allowlisted incident, dead-letter and replay references only. Queue bodies, provider payloads and credentials are not selected. `retry_requested` records operator intent and is distinct from linked replay state such as `requested`, `enqueued`, `failed` or `completed`; a retry request alone does not prove delivery. Mutations require CSRF, recent authentication and optimistic versions, while linked replay additionally enforces owner/risk authorization, tenant binding and idempotency.

Request IDs are accepted only from the bounded safe character set or replaced with a UUID, returned as `X-Request-Id`, included in stable API errors and used to correlate audits. Structured runtime logs accept a fixed event schema and discard arbitrary fields, unsafe strings and sensitive metric names; request bodies, cookies, email addresses, tokens, signatures, credentials and provider payloads are not log fields.

Platform Legal, Privacy and Support pages remain explicit publication gates until owner and legal/support decisions are approved. They must not invent legal entity, address, jurisdiction, tax, refund, retention, contact or response-time values. The abuse-report workflow is the implemented intake exception and stores only bounded report content plus a keyed reporter-contact hash when contact is supplied.

## Verification priorities

Every tenant feature requires negative cross-tenant tests. Webhooks require forgery and replay tests. Inventory and fulfillment require concurrency tests.
