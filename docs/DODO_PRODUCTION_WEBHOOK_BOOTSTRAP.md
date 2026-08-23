# Dodo production webhook bootstrap

This runbook breaks the first production webhook circular dependency without
weakening the normal registration command. The normal command still probes the
canonical route and rejects an old-runtime `404` before any provider mutation.

The bootstrap path is narrower. It may register only the configured canonical
live endpoint and create one new, route-neutral Worker version containing the
provider-validated `DODO_PAYMENTS_API_KEY` together with the new
`DODO_PAYMENTS_WEBHOOK_KEY`. It does not deploy a Worker, change routes, enable
checkout, change products, or authorize replay. Normal production registration
is rejected so the command cannot fall back to `wrangler secret put`.

## Preconditions

1. Use a clean reviewed production candidate and a private mode-`0600`
   `.wrangler/release/production-evidence.json`.
2. Upload the route-neutral candidate and rollback versions with the existing
   production Worker upload tooling. Record their exact UUIDs in the evidence.
3. Keep the provider API key, Worker mutation token, route audit token, and
   promotion audit token outside repository files. The command prints names,
   hashes, and opaque fingerprints only.
4. Do not proceed if a different Dodo endpoint exists under
   `https://api.selinow.com/api/webhooks/billing/dodo/`. Resolve the conflict
   with provider-owner review instead of creating another endpoint.

## Route-neutral bootstrap

Review the dry-run first:

```bash
node scripts/dodo-webhook-register.mjs \
  --env=production \
  --bootstrap-candidate
```

Execute only inside the approved provider/Worker mutation window:

```bash
node scripts/dodo-webhook-register.mjs \
  --env=production \
  --bootstrap-candidate \
  --execute \
  --ack-live \
  --evidence .wrangler/release/production-evidence.json
```

The command verifies the active Worker remains the recorded previous version,
the source candidate and rollback versions have exact release provenance, and
the repository matches the reviewed commit/tree. This pre-bootstrap admission
allows only the already-known empty cron/queue-consumer inventory; account,
Worker, D1, critical bindings, routes/domains, SaaS mappings, Turnstile,
candidate/rollback UUIDs and release provenance remain exact. Signed-health and
rollback verification return to the normal strict infrastructure admission. It
then:

1. rejects a conflicting canonical Dodo endpoint;
2. creates or reuses the exact endpoint and retrieves its signing key;
3. performs a credential-free production build, writes the validated API key
   and signing key to one mode-`0600` temporary file, and uses route-neutral
   `wrangler versions upload --secrets-file` to create a new candidate without
   deploying it; the temporary file is removed in a `finally` block;
4. proves the new version is a resource-for-resource clone of the reviewed
   source candidate except for the named webhook secret;
5. proves the active deployment did not change; and
6. writes a private, exclusive-create bootstrap manifest at
   `.wrangler/releases/<release-id>/dodo-webhook-bootstrap.json`.

Before step 1, the command atomically reserves the release using mode-`0600`
`.wrangler/releases/<release-id>/dodo-webhook-bootstrap-reservation.json`.
Every remote-risk boundary updates this file before the action. A failure marks
the state `failed_recoverable`, records only a safe error code, whether an
endpoint/version may exist, and whether cleanup is required. A concurrent first
attempt loses the exclusive create and performs no provider/version mutation.

Resume only the same commit/tree/release/candidate binding and supply the exact
current reservation hash:

```bash
shasum -a 256 .wrangler/releases/<release-id>/dodo-webhook-bootstrap-reservation.json

node scripts/dodo-webhook-register.mjs \
  --env=production \
  --bootstrap-candidate \
  --resume-bootstrap \
  --reservation-sha256 <exact-reservation-sha256> \
  --execute \
  --ack-live \
  --evidence .wrangler/release/production-evidence.json
```

Resume reconciles the version inventory against the IDs captured before the
first mutation. Zero additions permits one upload, one exact bound clone is
reused, and any ambiguous addition set fails closed for operator cleanup.
Before changing the reservation back to `in_progress`, resume atomically creates
an immutable mode-`0600` per-attempt `owner.json` and hard-links the canonical
`dodo-webhook-bootstrap-resume-claim.json` to that same inode. The claim is
bound to the supplied reservation hash and a unique attempt ID. A concurrent
resume receives
`dodo_webhook_bootstrap_resume_in_progress` before provider reconciliation.
Claims expire after 15 minutes. Heartbeats are append-only, uniquely named
mode-`0600` records under the owning attempt directory; they never replace the
owner inode. Release is also append-only through `released.json` and never
unlinks the canonical claim. The next attempt hard-links an expired or released
canonical claim to
`dodo-webhook-bootstrap-resume-claim-stale-<attempt-id>.json`, verifies the
loaded owner, canonical claim, and stale evidence are the same inode, then
unlinks only that exact canonical inode before acquiring a new claim. Canonical
claim link/unlink operations are serialized by an exclusive, empty mutation
lock directory; releasing it uses one atomic `rmdir`, after which the prior
holder performs no further canonical-path mutation. A contender therefore
cannot install a replacement between inode proof and unlink. A losing worker
cannot release, delete, or renew a newer owner's claim. A crashed mutation lock
fails closed for operator inspection instead of attempting an unsafe takeover.

A healthy attempt heartbeats before and verifies exact inode ownership after
every external provider or Worker-version mutation, and around long read/build
phases. Each heartbeat uses the same attempt ID and exact reservation ID/hash.
Every reservation replacement requires the exact current SHA-256, rechecks the
target inode and hash before rename, uses a unique `.next-<uuid>` file, and
removes that temporary file on failure. A stale legacy fixed `.next` file cannot
wedge an update. Private artifacts, reservations, claims, heartbeats, release
markers, and production evidence reject symlinked files or in-repository
ancestor directories and recheck target inodes around reads and replacement.
Exclusive writes open an empty mode-`0600` file first, then prove the opened
descriptor is the same inode as the canonical in-tree target before writing any
artifact bytes. A validation-to-open ancestor swap therefore fails without
copying private evidence into the substituted tree, and the descriptor/path
identity is checked again after sync before success is returned.

Provider HTTP requests abort after 15 seconds. Wrangler inventory reads abort
after 60 seconds, while the credential-free build and route-neutral version
upload abort after 10 minutes, which remains below the 15-minute lease TTL.
Consequently a live bounded operation cannot silently outlast its last
heartbeat. A worker that loses ownership fails closed without writing the
shared reservation; the current owner must reconcile the already-recorded
provider/version risk markers before it advances recovery.

The returned `candidateWorkerVersion` is the only candidate UUID that may be
copied into the canonical production evidence and release manifest. Re-running
the bootstrap after its artifact exists fails with
`dodo_webhook_bootstrap_replay`.

The bootstrap artifact always records:

- `checkoutActivationAuthorized: false`;
- `deploymentAuthorized: false`;
- `signedWebhookHealthProven: false`;
- `routeMutationPerformed: false`; and
- `secretNames: ["DODO_PAYMENTS_API_KEY", "DODO_PAYMENTS_WEBHOOK_KEY"]`.

It stores only a domain-separated SHA-256 fingerprint of the validated API key;
it never stores either secret value, provider webhook ID, payload, or
authorization header. Signed-health verification requires the same API-key
fingerprint before contacting Dodo.

## Candidate-bound signed health

After the canonical production release manifest binds the exact bootstrap
candidate UUID and the normal release ceremony makes that candidate active,
run the signed health verifier immediately:

```bash
node scripts/dodo-webhook-register.mjs \
  --env=production \
  --verify-bootstrap \
  --execute \
  --ack-live \
  --bootstrap-manifest .wrangler/releases/<release-id>/dodo-webhook-bootstrap.json \
  --bootstrap-manifest-sha256 <exact-bootstrap-sha256> \
  --release-manifest .wrangler/releases/<release-id>/release-manifest.json \
  --release-manifest-sha256 <exact-release-manifest-sha256>
```

The verifier rechecks the clean commit/tree, canonical manifest, exact active
Worker version, rollback version, endpoint inventory, and provider signing key.
It sends a signed, deliberately invalid JSON body and accepts only the real safe
error envelope: status `400`, code `billing_webhook_invalid`, matching request
ID and `issues: ["json_invalid"]`, with no additional keys. This proves the candidate route and
Worker secret agree without creating an order, checkout, subscription, payment,
or fulfillment event.

Both paths must be canonical repository-relative references under the same
`.wrangler/releases/<release-id>/` directory, mode `0600`, and match the exact
operator-supplied SHA-256 hashes. Absolute paths, `/tmp` copies, traversal and a
release manifest belonging to another release are rejected.

The resulting private health artifact still records
`checkoutActivationAuthorized: false` and
`separateReleaseAcceptanceRequired: true`. Genuine signed-event UAT, manual
acceptance, monitoring, payment-owner approval, and the normal release doctor
remain independent gates. The bootstrap evidence alone never authorizes live
checkout or a claim that the SaaS can collect money.

## Rollback evidence

If the candidate is rolled back, first restore the exact previous Worker
version through the normal release rollback procedure. Then record the bounded
observation:

```bash
node scripts/dodo-webhook-register.mjs \
  --env=production \
  --record-bootstrap-rollback \
  --execute \
  --ack-live \
  --bootstrap-manifest .wrangler/releases/<release-id>/dodo-webhook-bootstrap.json \
  --bootstrap-manifest-sha256 <exact-bootstrap-sha256> \
  --release-manifest .wrangler/releases/<release-id>/release-manifest.json \
  --release-manifest-sha256 <exact-release-manifest-sha256>
```

This command performs no provider or Cloudflare mutation. It writes a private
rollback artifact only when the recorded previous Worker version is active and
marks provider cleanup as required. Do not delete or replace the provider
webhook during incident handling until the payment owner decides whether the
same exact candidate will be retried; an uncoordinated delete can discard
delivery evidence.
