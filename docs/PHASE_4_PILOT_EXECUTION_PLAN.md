# Phase 4 Controlled Pilot Execution Plan

P5 execution note (2026-08-04): pilot admission is blocked before staging
acceptance. No seller, provider, traffic, order, or fulfillment action occurred.

Overall status: `not_started`

Use `infra/release/phase-4-pilot-scorecard.example.json` only as an
example/non-evidence schema. Initialize one private scorecard per exact candidate
and release. Allowed statuses are `not_started`, `pending_user`,
`waiting_provider`, `projection_unavailable`, `passed`, `failed`, `stopped`, and
`reconciled`.

## Entry and scope

Entry requires accepted staging, an opaque eligible seller/shop reference,
Website-first provider scope, named release/data/payment/integration/security/
support/rollback owners, tested acknowledgement paths, private evidence storage,
an approved observation window, and zero unresolved P0/P1. Telegram and Dodo are
separate lanes and may not inherit Website or PayOS acceptance.

Traffic is limited to the approved seller and cases. No automatic expansion is
permitted. First run login/membership, shop selection/switch, catalog/variant,
inventory preview/import, safe readiness, publish, exact order/payment,
duplicates/exceptions, race/replay, outage/recovery, support, rollback rehearsal,
ledger reconciliation, cleanup, then observe through `T+15m`, `T+60m`, and
`T+24h`.

## Evidence rules

Each `passed` or `reconciled` scenario requires candidate commit, release ID,
opaque pilot/shop ID, scenario code, canonical observed timestamp, safe request
or event references, private evidence references, and owner acknowledgement.
Never store identity/contact/address data, tokens, secrets, signatures/raw
payloads, provider credentials, payment URLs, license plaintext, private object
keys, or raw inventory. Queue, outbox, audit, and scorecard records use references.

## Stop and completion

Any tenant mismatch, false paid state, exception auto-fulfillment, oversell,
duplicate delivery, plaintext leakage, ambiguous mutation, missing owner/alert,
or monitoring stop threshold sets the pilot to `stopped`. Pause new checkout and
fulfillment, reconcile authoritative ledgers, then either record `reconciled` or
execute the captured rollback/fix-forward plan. `pilot_accepted` requires all
required terminal evidence and cleanup; it never implies production GO.
