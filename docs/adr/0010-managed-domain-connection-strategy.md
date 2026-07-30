# ADR 0010: Managed domain connection strategy

## Status

Accepted

## Date

2026-07-26

## Context

Cloudflare for SaaS automates custom-hostname and certificate lifecycle on Selinow's side, but a customer normally still controls the authoritative DNS zone. Requiring a non-technical seller to understand TXT ownership and CNAME routing conflicts with the no-tech product goal. At the same time, requesting registrar passwords or broad permanent DNS credentials would create unacceptable security risk.

## Decision

- Keep the platform subdomain as the immediate, fully managed default for every shop.
- Support custom-domain connection through the safest available mode, in this order:
  1. a domain purchased or managed through an approved Selinow domain workflow;
  2. delegated DNS authorization or a standards-based/provider connector with least-privilege access;
  3. delegated subdomain or nameserver setup when the seller intentionally chooses it;
  4. exact manual TXT and CNAME instructions as the fallback.
- Automatically discover supported modes from the hostname and provider connector registry. Do not ask the seller to choose an infrastructure mechanism they do not understand.
- Use short-lived OAuth or provider authorization where available. Never request a registrar password. Encrypt revocable tenant DNS credentials and scope them to the minimum zone and record permissions.
- Preserve the existing ownership-first rule. Selinow does not create or route a custom hostname until the authoritative ownership claim is proven through the chosen connector.
- Make every DNS mutation idempotent, ownership-scoped, version-guarded and auditable. Conflicting records fail closed and are never overwritten unless the resource is demonstrably owned by the Selinow connection.
- Continue to reconcile Cloudflare custom-hostname, certificate and authoritative DNS state independently. A successful DNS write alone never makes a domain active.
- Describe a custom domain as one-click only when the selected connector can complete ownership and routing automatically. Manual fallback remains supported but is not marketed as full automation.

## Trade-offs

- Supporting multiple DNS providers creates connector and support work.
- Platform-managed domains may introduce renewal, billing, transfer, legal and support responsibilities outside the current SaaS boundary.
- Least-privilege delegated authorization may not exist for every registrar or DNS provider.
- Manual fallback remains necessary for the long tail of providers.

## Consequences

- Every seller can publish immediately on a Selinow subdomain without touching DNS.
- Sellers on supported providers can connect a domain through consent rather than copying records.
- Domain operations preserve the existing Cloudflare for SaaS security, payment-origin and deletion invariants.
- Domain connector credentials join the normal encrypted credential, rotation, export-exclusion, deletion and audit lifecycle.

## Revisit triggers

Add a domain purchase or reseller workflow only after legal ownership, renewal, transfer, billing, support and recovery responsibilities are approved. Prioritize DNS connectors using observed seller-domain distribution rather than speculative coverage.
