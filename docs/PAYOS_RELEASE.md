# PayOS Release Evidence

## Current decision

PayOS has no separate sandbox or staging provider environment. The official
documentation requires low-value real bank transfers against the production
PayOS API: https://payos.vn/docs/moi-truong-test.

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

```bash
export SELINOW_PAYOS_UAT_ATTESTATION_KEY_ID="release-owner-2026"
export SELINOW_PAYOS_UAT_ATTESTATION_PUBLIC_KEY_PEM_BASE64="$(base64 < owner-public-key.pem | tr -d '\n')"
npm run payos:uat:validate -- \
  --manifest .wrangler/releases/staging/<release-id>/release-manifest.json \
  --worker-version <staging-worker-version>
```

For an explicit key file, pass `--owner-attestation-key-id` together with
`--owner-attestation-public-key <path>`. The private signing key and PayOS
provider credentials must remain outside the repository and are never read by
the validator. A provider acceptance claim is still blocked until a real,
controlled low-value transaction has been executed and the resulting artifact
has been signed by the release owner.

Until that handoff is accepted, the release doctor must report PayOS provider
acceptance as blocked even when local negative/security tests are green.
