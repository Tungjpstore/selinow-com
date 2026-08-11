# Dodo Payments Release Lane

This runbook records the platform-subscription lane separately from PayOS seller
payments. It is intentionally evidence-first: local tests prove source behavior,
while only a final staging release can produce accepted provider evidence.

## Current State

- Four approved test/live offers exist: Starter/Pro in VN/VND and Global/USD.
- Staging uses `DODO_PAYMENTS_ENVIRONMENT=test_mode` and production uses
  `live_mode`. The current staging Worker has the API-key and webhook-key
  secret names configured. Production provider secrets remain subject to the
  production release ceremony and are not implied by staging state.
- Both test and live catalogs are tax-inclusive SaaS subscriptions with a
  provider-managed 7-day trial. Four products are used per environment so a
  webhook lookup cannot ambiguously cross currency or amount.
- The canonical staging webhook route is live and rejects an unsigned probe
  with `401 webhook_signature_invalid`. The Dodo test account has exactly one
  usable webhook for that endpoint with the required event contract. This
  proves registration and signature admission only, not end-to-end UAT.
- No migration, staging deploy, production deploy, or live charge is authorized
  by this document.

## Evidence Contract

After a guarded staging deploy, collect each scenario into a private,
release-bound artifact. The collector input is an exact mode-`0600` JSON file
with these keys only: `release`, `endpointFingerprintSha256`, `offers`,
`scenarios`, `createdAt`, and `completedAt`. Every scenario has only `status`,
`observedAt`, and nullable opaque `request:`, `event:`, or `session:`
references. Unknown fields fail closed, including raw payloads, credentials,
customer data, checkout URLs, and payment details.

Build the canonical evidence file and its 32 scenario artifacts:

```bash
chmod 0600 .wrangler/releases/staging/<release-id>/dodo-uat-collector-input.json
node scripts/dodo-uat-collect.mjs \
  --input .wrangler/releases/staging/<release-id>/dodo-uat-collector-input.json \
  --json
```

The collector writes only under
`.wrangler/releases/staging/<release-id>/`: one canonical
`dodo-uat-evidence.json` plus
`dodo-uat-scenarios/<scenario-id>.json`. Every output is mode `0600`, bound to
the exact release commit/tree/manifest/Worker version, and contains safe opaque
references rather than raw provider material. Re-running the same input is
idempotent; conflicting content is rejected instead of overwriting evidence.

Validate it against the exact release manifest and Worker version:

```bash
npm run dodo:uat:validate -- \
  --evidence .wrangler/releases/staging/<release-id>/dodo-uat-evidence.json \
  --manifest .wrangler/releases/staging/<release-id>/release-manifest.json \
  --worker-version <provider-worker-version> \
  --json
```

The standalone validator requires the evidence file and all 32 canonical
scenario artifacts to exist as exact mode-`0600` files. It recomputes every
artifact SHA-256, checks the safe schema and release binding, then requires all
32 scenarios to be `passed`, exact four-offer commercial values, unique
provider-reference fingerprints, complete redaction checks, and an exact
commit/tree/manifest/Worker binding. Hash-shaped claims, direct opaque
references without their scenario artifacts, source test passes, and the
placeholder example are not staging evidence. Release admission performs the
same artifact checks.

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
