# ADR 0002: Secret, resource-identity and environment boundaries

- Status: Accepted (revised)
- Date: 2026-07-25
- Revised: 2026-07-30

## Context

The platform will handle global infrastructure secrets, thousands of tenant provider credentials and sensitive license-key inventory across local, staging and production environments.

## Decision

Store global secrets as Cloudflare Worker secrets. Store tenant credentials and inventory keys as application-encrypted D1 records with explicit key versions and AAD. Keep local, staging and production resources separate. Local provider integrations use fakes unless explicitly enabled with dedicated test credentials.

Reviewed non-secret Cloudflare identity may be stored in source-controlled environment, generated-manifest and Wrangler configuration when deterministic admission requires it. This narrow allowlist covers account and zone IDs, D1/KV resource IDs, resource names, Worker names, hostnames and route patterns. These identifiers are routing and identity metadata, not authentication material.

Production mutations still require explicit production targeting, ceremony/release evidence and live account-pinned reconciliation of the checked-in identity against Cloudflare immediately before every sink. A checked-in production resource manifest never proves that migrations, a Worker version, routes, domains or customer traffic were promoted.

## Consequences

No secret, API token, provider credential, webhook secret, session material, tenant ciphertext, private backup evidence or customer data belongs in source control. Provisioning, doctor and deployment commands must redact sensitive values and require explicit production targeting for mutations.

The former blanket prohibition on production resource IDs is superseded by the reviewed non-secret identity allowlist above. `infra/environments/production.json`, `infra/generated/production.json` and the production bindings in `wrangler.jsonc` may retain approved resource identity so release tooling can fail closed on account, D1, KV, R2, Queue, Worker and route drift. Changes to that identity require review and regeneration; discovery output must not be copied into arbitrary logs or documents.

Resource existence is not release acceptance. The current production bootstrap has provisioned identity and empty-baseline backup/restore evidence, but no production migration, Worker traffic deployment, route/domain promotion, payment, Telegram or seller-pilot action is implied by this ADR.
