# Dodo Payments Release Lane

This runbook records the platform-subscription lane separately from PayOS seller
payments. It is intentionally evidence-first: local tests prove source behavior,
while only a final staging release can produce accepted provider evidence.

## Current State

- Four approved test/live offers exist: Starter/Pro in VN/VND and Global/USD.
- Staging uses `DODO_PAYMENTS_ENVIRONMENT=test_mode` and production uses
  `live_mode`; both have the API-key secret name configured and production now
  has a live API key secret. The webhook key and endpoint remain pending.
- Both test and live catalogs are tax-inclusive SaaS subscriptions with a
  provider-managed 7-day trial. Four products are used per environment so a
  webhook lookup cannot ambiguously cross currency or amount.
- The canonical staging webhook probe currently returns `404`; Cloudflare route
  ownership must be reconciled before any staging mutation.
- No migration, staging deploy, production deploy, or live charge is authorized
  by this document.

## Evidence Contract

After a guarded staging deploy, create a private evidence file from
`infra/release/dodo-uat-evidence.example.json`. Fill only safe fingerprints and
opaque request/event/session references. Never store secrets, raw payloads,
hosted checkout URLs, customer details, or payment details.

Validate it against the exact release manifest and Worker version:

```bash
npm run dodo:uat:validate -- \
  --evidence .wrangler/releases/staging/<release-id>/dodo-uat-evidence.json \
  --manifest .wrangler/releases/staging/<release-id>/release-manifest.json \
  --worker-version <provider-worker-version> \
  --json
```

The validator requires all 32 scenarios to be `passed`, exact four-offer
commercial values, unique provider-reference fingerprints, signed-event
references, complete redaction checks, and an exact commit/tree/manifest/Worker
binding. A source test pass or a placeholder example is not staging evidence.

## Mutation Order

1. Reconcile Cloudflare route inventory and pass `platform:route-preflight` and
   `platform:doctor`.
2. Create fresh protected backup and restore drill; write the exact staging
   release manifest.
3. Run the full forward-only migration chain with maintenance-drain confirmation,
   then create post-migration evidence and deploy that same manifest.
4. Reprobe the canonical webhook route; it must reject unsigned input rather than
   return `404`.
5. Register the environment-specific Dodo webhook, set the webhook secret through
   Cloudflare Worker secrets, reconcile the four staging provider references, and
   execute test-mode checkout -> signed webhook -> subscription UAT.
6. Revoke temporary audit credentials and preserve only reference-only evidence.

Production remains blocked until the non-Dodo admission contract, backup/restore,
monitoring, rollback, owner, pilot, PayOS and other provider gates are accepted.
