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
- Both test and live catalogs are tax-inclusive monthly SaaS subscriptions with
  provider trials disabled. Selinow's seven-day trial is local D1 entitlement
  state; opening Dodo checkout must not replace or extend it. Four products are
  used per environment so a webhook lookup cannot ambiguously cross currency or
  amount.
- The canonical staging webhook route is live and rejects an unsigned probe
  with `401 webhook_signature_invalid`. The Dodo test account has exactly one
  usable webhook for that endpoint with the required event contract. This
  proves registration and signature admission only, not end-to-end UAT.
- No migration, staging deploy, production deploy, or live charge is authorized
  by this document.

## Evidence Contract

After a guarded staging deploy, a separately controlled runner must write one
private execution-proof artifact for every scenario under
`.wrangler/releases/staging/<release-id>/dodo-uat-execution-proofs/`. The
collector no longer accepts operator-authored `status: passed` claims. Its
input contains only the release/offer/endpoint bindings, the collection window,
and an exact `proofArtifacts` map of canonical artifact references and expected
SHA-256 values.

Every execution proof is exact mode `0600`, has the strict
`dodo_uat_execution_proof` schema, is bound to the exact commit/tree/manifest/
Worker version, and carries:

- the scenario's fixed execution mode and verification method;
- unique opaque request/delivery references and a unique redacted execution
  transcript hash;
- hashes of D1 state before, after, and the asserted transition;
- the fixed scenario outcome plus explicit before/after state and `no_op` or
  `transition` semantics from `DODO_SCENARIO_EXECUTION_CONTRACTS`;
- for genuine provider webhook scenarios, hashes of the provider event and
  provider signature with `signatureAuthority: dodo`;
- for deliberately malformed signed cases, the controlled runner authority and
  the exact negative-injection scenario ID;
- an Ed25519 signature from an independently approved staging-runner key;
- affirmative redaction flags covering raw payloads, credentials, customer data
  and payment-instrument data.

Raw webhook bodies/headers, provider IDs, hosted checkout URLs, customer data,
card data and credentials may exist only in an ephemeral runner workspace. They
must never enter the canonical artifact, logs, D1, queues or audit payloads.
The runner hashes them before writing proof and securely discards the temporary
material after the proof is signed.

The trusted public-key file is a separate exact mode-`0600` JSON keyring. It is
only a source of public-key material and is not itself a trust anchor. The
approved key ID and SHA-256 fingerprint of the key's DER SPKI must come from a
separate owner-approved CI/release input. Neither value may be accepted from
the collector JSON or inferred from the sibling keyring:

```json
{
  "schemaVersion": 1,
  "environment": "staging",
  "provider": "dodo",
  "keys": [{ "keyId": "approved-runner-key-id", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n" }]
}
```

Build the canonical evidence file and its 32 scenario artifacts:

```bash
chmod 0600 .wrangler/releases/staging/<release-id>/dodo-uat-collector-input.json
chmod 0600 .wrangler/releases/staging/<release-id>/dodo-uat-trusted-public-keys.json
node scripts/dodo-uat-collect.mjs \
  --input .wrangler/releases/staging/<release-id>/dodo-uat-collector-input.json \
  --trusted-public-keys .wrangler/releases/staging/<release-id>/dodo-uat-trusted-public-keys.json \
  --approved-key-id "$DODO_UAT_APPROVED_RUNNER_KEY_ID" \
  --approved-spki-sha256 "$DODO_UAT_APPROVED_RUNNER_SPKI_SHA256" \
  --json
```

The two approved values above are non-secret trust metadata, but they are
release-owner controlled. The canonical evidence records only the approved
SPKI fingerprint for audit binding; that recorded value never grants trust by
itself. Every later validator and release-admission caller must receive the
same out-of-band key ID/fingerprint and compare it again.

The collector verifies file permissions, canonical paths, exact hashes, release
binding, scenario policy, outcome/state semantics, pairwise replay/order
relationships, redaction, trusted Ed25519 signatures, required
provider signature/event hashes, required D1 transition hashes, and cross-proof
reference/transcript uniqueness before writing one mode-`0600`
`dodo-uat-evidence.json`. Missing, blocked, unsigned, untrusted, conflicting or
non-private proof fails closed. Re-running identical input is idempotent;
conflicting content is never overwritten.

Validate it against the exact release manifest and Worker version:

```bash
npm run dodo:uat:validate -- \
  --evidence .wrangler/releases/staging/<release-id>/dodo-uat-evidence.json \
  --manifest .wrangler/releases/staging/<release-id>/release-manifest.json \
  --trusted-public-keys .wrangler/releases/staging/<release-id>/dodo-uat-trusted-public-keys.json \
  --approved-key-id "$DODO_UAT_APPROVED_RUNNER_KEY_ID" \
  --approved-spki-sha256 "$DODO_UAT_APPROVED_RUNNER_SPKI_SHA256" \
  --worker-version <provider-worker-version> \
  --json
```

Standalone validation and release admission must call
`readDodoUatExecutionProofArtifacts` with the public-key map plus the explicit
`approvedExecutionProofTrust: { keyId, spkiSha256 }`, then pass its
`verifiedExecutionProofs` result to
`assertDodoStagingUatEvidence`. A hash-shaped claim, an artifact signed by a key
provided only by the same sibling keyring or untrusted collector payload,
source tests, dashboard
screenshots, unsigned probes, and the contract-gap example are not accepted
staging evidence.

For shared release admission, map the independently approved values into
`SELINOW_DODO_UAT_RUNNER_KEY_ID` and
`SELINOW_DODO_UAT_RUNNER_SPKI_SHA256`. The standalone
`DODO_UAT_APPROVED_RUNNER_*` shell names in the examples are convenience
variables only; neither name nor an evidence-embedded fingerprint is trusted
unless the release environment supplies the `SELINOW_*` trust contract.

## Controlled Runner Contract

The exported `DODO_SCENARIO_EXECUTION_CONTRACTS` map is authoritative. The
runner must use it rather than choosing a weaker proof method:

- `provider_catalog_observation`: provider TEST API plus the matching D1 catalog
  projection.
- `provider_checkout_observation`: a real hosted TEST checkout response plus
  the exact pending D1 session transition.
- `provider_webhook_observation`: a genuine Dodo-signed delivery plus the exact
  before/after D1 transition. Dashboard mock events and locally generated
  signatures do not satisfy these scenarios.
- `controlled_negative_webhook`: a release-approved isolated runner may sign a
  deliberately malformed body only for the fixed negative scenario contract;
  it must prove rejection and no unauthorized D1 mutation.
- `controlled_runtime_probe` and `controlled_clock_transition`: the runner must
  prove the exact runtime response and D1 before/after state. Do not hand-edit
  shared staging rows.
- `controlled_checkout_fault`: response-loss and concurrent-checkout cases need
  deterministic fault/concurrency control and exact provider-call/D1 evidence;
  aborting a browser request or double-clicking is not proof.

`duplicate_webhook` must be a no-op replay of the exact accepted
`payment_succeeded_exactly_once` event and signature. The conflicting replay
uses the same event identity with a different event fingerprint and must be
rejected without changing the accepted state. `stale_timestamp` must be a
later-observed stale event against that same session and accepted state.
`out_of_order_webhook` must be later-observed than `renewal_success`, use a
different event identity, and leave the renewed state unchanged. The collector
checks these pairwise relationships; independent hash-shaped proofs do not
satisfy them.

Proof artifacts and `dodo-uat-evidence.json` must use their exact canonical
release paths. Symlinked files or symlinked ancestors are rejected even when
the final bytes and SHA-256 appear valid.

The controlled negative set is `conflicting_duplicate_event`,
`stale_timestamp`, `amount_mismatch`, `currency_mismatch`,
`provider_reference_mismatch`, `tenant_metadata_mismatch`, and
`invalid_webhook_body`. The controlled checkout-fault set is
`checkout_response_loss` and `concurrent_duplicate_checkout`. If the approved
runner cannot execute any one of these safely and deterministically, keep Dodo
UAT blocked and do not run the collector.

## Mutation Order

1. Reconcile Cloudflare route inventory and pass `platform:route-preflight` and
   `platform:doctor`.
2. Create fresh protected backup and restore drill; write the exact staging
   release manifest.
3. Run the full forward-only migration chain with maintenance-drain confirmation,
   then create post-migration evidence and deploy that same manifest.
4. Reprobe the canonical webhook route; it must reject unsigned input rather than
   return `404`.
5. Inspect D1 before mutation. Product IDs are intentionally optional for this
   read-only mode, so an operator without protected catalog references can still
   determine whether the four rows are pending or already published:

   ```bash
   DODO_PAYMENTS_ENVIRONMENT=test_mode npm run dodo:catalog:reconcile -- \
     --env=staging --inspect --json
   ```

   `--inspect` performs remote SELECT/classification only and never uses `--file`
   or `--yes`. Without product IDs, published states are deliberately reported
   as `published_unverified` or `rotated_unverified`; export all four IDs only
   when exact identity classification is required.
6. Register the environment-specific Dodo webhook, set the webhook secret through
   Cloudflare Worker secrets, export the API key and all four protected product
   IDs, then reconcile the staging provider references:

   ```bash
   DODO_PAYMENTS_ENVIRONMENT=test_mode npm run dodo:catalog:reconcile -- \
     --env=staging --apply --confirm-catalog-update \
     --confirm-staging-test-catalog --json
   ```

   Before any D1 write, apply fetches every product from the fixed Dodo test/live
   API origin using the protected API key. It requires the exact product identity,
   nested recurring price type, amount, currency, monthly frequency, inclusive
   tax, zero trial days, zero discount, `saas` tax category, and null pricing mode.
   HTTP, JSON, identity, schema, or configuration mismatch fails closed without
   logging credentials or provider response bodies.

   Dodo's detail schema permits `pricing_mode`, `tax_inclusive`, and
   `trial_period_days` to be omitted or nullable even when their provider
   defaults behave like null/true/zero. This release guard intentionally requires
   explicit `null`, `true`, and `0`; if Dodo omits any field in the selected
   account/API version, reconciliation remains blocked until an owner verifies
   the response contract and explicitly revises policy.

   The guarded apply marks `dodo_catalog_reconciliation_required=false` only in
   the same SQL execution that proves all four exact offers are published; the
   command then re-inspects D1 and fails closed if the marker or catalog disagrees.
7. Execute test-mode checkout -> signed webhook -> subscription UAT. Provider
   checkout must bill the first paid period; it must not create a second trial.
8. Revoke temporary audit credentials and preserve only reference-only evidence.

Production remains blocked until the non-Dodo admission contract, backup/restore,
monitoring, rollback, owner, pilot, PayOS and other provider gates are accepted.
