# ADR 0002: Secret and environment boundaries

- Status: Accepted
- Date: 2026-07-25

## Context

The platform will handle global infrastructure secrets, thousands of tenant provider credentials and sensitive license-key inventory across local, staging and production environments.

## Decision

Store global secrets as Cloudflare Worker secrets. Store tenant credentials and inventory keys as application-encrypted D1 records with explicit key versions and AAD. Keep local, staging and production resources separate. Local provider integrations use fakes unless explicitly enabled with dedicated test credentials.

## Consequences

No production resource ID or secret belongs in source control. Provisioning, doctor and deployment commands must redact secrets and require explicit production targeting for mutations.
