# ADR 0001: Modular monolith on Cloudflare

- Status: Accepted
- Date: 2026-07-25

## Context

The product exposes marketing, seller dashboard, storefront, provider webhooks and background jobs. All channels must share tenant, order, inventory, payment and fulfillment invariants.

## Decision

Use one Astro application deployed to Cloudflare Workers with domain modules under `src/lib`. Use D1 for authoritative transactional state, R2 for media, KV for reconstructable cache and Queues for retryable reference-based work.

## Consequences

Transactions and invariants remain close together during the MVP. Modules must avoid provider types in domain code and accept database/runtime context so future D1 sharding does not change public contracts.
