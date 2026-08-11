# PayOS Release Evidence

## Current decision

PayOS has no separate sandbox or staging provider environment. The official
documentation requires low-value real bank transfers against the production
PayOS API: https://payos.vn/docs/moi-truong-test.

The controlled staging channel identity fingerprint is installed and attested
for the current staging environment. This is readiness evidence only. No real
low-value VND transfer, provider-signed webhook, or direct-reconciliation UAT
artifact has been accepted yet.

This repository therefore must never label a synthetic or local fixture as
`providerEnvironment: "test_mode"`. The PayOS evidence schema is version 2:

- `provider_acceptance` is allowed only with `providerEnvironment:
  "production_controlled"`, a non-zero controlled-account fingerprint, a
  non-zero transaction evidence fingerprint, an observed real low-value
  transaction, and `syntheticSignatureUsed: false`.
- `contract_gap` records why provider acceptance is unavailable. It is
  intentionally rejected by `npm run payos:uat:validate` and by release
  admission.
- Provider-required scenarios are limited to the provider capabilities that
  can be evidenced: `signed_exact_payment` and `direct_reconciliation`.
- Local negative/security assurance is recorded separately and never promoted
  to provider evidence.
- Signed refund and chargeback are explicitly unsupported. PayOS public
  webhook schemas and APIs do not document either capability; they must remain
  `provider_unsupported` with machine-readable reason codes.

## Evidence rules

Every accepted provider artifact must bind to the exact staging release
manifest, commit, tree, and Worker version. Scenario records require a safe
artifact reference and a unique SHA-256 fingerprint. Raw webhook bodies,
provider credentials, customer data, checkout URLs, and payment details are
not allowed in evidence, D1, queues, audit metadata, or logs.

Create each normalized scenario artifact with the dedicated builder. It accepts
only scenario classification, timestamps, release identity and SHA-256 proof
fingerprints; it has no argument for a PayOS credential, raw payload, customer
record, checkout URL or bank detail. The output must be inside the exact
release directory and is created with mode `0600` without overwriting an
existing file:

```bash
npm run payos:uat:artifact -- \
  --manifest .wrangler/releases/staging/<release-id>/release-manifest.json \
  --worker-version <staging-worker-version> \
  --scenario-id signed_exact_payment \
  --classification provider_supported \
  --status passed \
  --verification-method signed_webhook \
  --observed-at <iso-8601-observation> \
  --controlled-account-fingerprint <sha256> \
  --proof-of-execution-fingerprint <sha256> \
  --output .wrangler/releases/staging/<release-id>/scenarios/payos-signed_exact_payment.json
```

Run the builder once for every scenario. Provider-required scenarios carry the
two SHA-256 proof fingerprints. Local-assurance and provider-unsupported
scenarios must omit them. Each top-level scenario record then references the
generated file with `artifact:<release-relative-path>` and uses the emitted
artifact fingerprint. The complete unsigned schema-v2 evidence remains a
private mode-`0600` file outside Git.

The provider execution block is the anti-fabrication fence:

```json
{
  "paymentInstrument": "controlled_real_bank",
  "realLowValueTransactionObserved": true,
  "signatureSource": "provider_signed_webhook_and_verified_response",
  "syntheticSignatureUsed": false
}
```

The shipped example at `infra/release/payos-uat-evidence.example.json` is a
`contract_gap` artifact with `providerEnvironment: "unavailable"`; it is not
staging acceptance evidence.

## Release integration

The commerce acceptance layer accepts only the version-2
`provider_acceptance` contract with `providerEnvironment:
"production_controlled"`. It rejects legacy `test_mode`, synthetic evidence,
and every `contract_gap` artifact. Do not weaken that check or bypass it with a
legacy field value.

Provider acceptance also carries a detached Ed25519 attestation from the
release owner. The verifier trusts only the public key explicitly supplied for
the handoff; it never treats a key embedded in the evidence as trusted. Set the
trust anchor through either the environment (recommended for CI) or the
validator CLI:

Sign the completed evidence with a private Ed25519 key that is itself a regular
mode-`0600` file. The signing command validates the release binding and evidence
contract before writing the canonical evidence file. It never reads PayOS
credentials or raw provider payloads and never prints the private key or
signature:

```bash
npm run payos:uat:sign -- \
  --evidence .wrangler/private/payos-uat-evidence.unsigned.json \
  --private-key .wrangler/private/payos-release-owner-ed25519.pem \
  --key-id release-owner-2026 \
  --signed-at <iso-8601-completion-time> \
  --output .wrangler/releases/staging/<release-id>/payos-uat-evidence.json
```

The validator requires an explicit, canonical release-specific evidence path.
It reads and SHA-verifies every referenced scenario artifact using the same
artifact contract as production release admission. A standalone `PASS` can no
longer be produced from missing, noncanonical or tampered scenario files:

```bash
export SELINOW_PAYOS_UAT_ATTESTATION_KEY_ID="release-owner-2026"
export SELINOW_PAYOS_UAT_ATTESTATION_PUBLIC_KEY_PEM_BASE64="$(base64 < owner-public-key.pem | tr -d '\n')"
npm run payos:uat:validate -- \
  --evidence .wrangler/releases/staging/<release-id>/payos-uat-evidence.json \
  --manifest .wrangler/releases/staging/<release-id>/release-manifest.json \
  --worker-version <staging-worker-version>
```

For an explicit key file, pass `--owner-attestation-key-id` together with
`--owner-attestation-public-key <path>`. The private signing key and PayOS
provider credentials must remain outside the repository and are never read by
the validator. The JSON output records `paymentLaneAccepted`,
`fullCommerceAccepted` and the machine-readable unsupported refund/chargeback
reason codes. A provider acceptance claim is still blocked until a real,
controlled low-value transaction has been executed, all required local
assurance artifacts pass, and the resulting evidence has been signed by the
release owner.

Until that handoff is accepted, the release doctor must report PayOS provider
acceptance as blocked even when local negative/security tests are green.
