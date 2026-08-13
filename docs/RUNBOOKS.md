# Runbooks

These procedures use reference IDs, safe error codes and aggregate counts only. Never paste credentials, webhook signatures, customer tokens, license-key plaintext, raw queue bodies or database exports into logs, tickets or chat. Confirm the environment, shop scope and current row version before every mutation. Production changes, real D1 restores and provider-side revocations require an assigned incident owner and explicit approval.

## Staging Live-Route Preflight

- **Run:** Temporarily export least-privilege `CLOUDFLARE_D1_API_TOKEN` and `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN`, then execute `npm run platform:route-preflight -- --json`. The command is hard-limited to staging and rejects local or production targets.
- **Read-only boundary:** The preflight reads the checked-in staging spec/manifest/Wrangler config, runs `wrangler whoami`, lists staging D1 databases and performs one `GET /zones/{zoneId}/workers/routes`. It never provisions, backs up, migrates, seeds, deploys or writes a report file.
- **Acceptance:** Require the authenticated account and exact live D1 name+UUID to match the checked-in staging identity; `selinow.com/*`, `*.selinow.com/*` and `*/*` must point only to `selinow-com-production`, while `staging.selinow.com/*`, `app-staging.selinow.com/*`, `api-staging.selinow.com/*` and `*.staging.selinow.com/*` must point only to `selinow-com-staging`; malformed, duplicate, missing or extra bindings fail closed.
- **Secret boundary:** The D1 identity token is mapped to `CLOUDFLARE_API_TOKEN` only for pinned Wrangler `whoami`/D1 listing, while the route token is used only for the route API authorization header. Neither is printed or forwarded to unrelated children; the runtime Worker secret is never operator input.
- **Next gate:** A passing result is early read-only evidence only. Before any real staging backup, migration, seed or deploy, run the full `platform:doctor` with the platform, D1 identity and route-audit tokens, then follow the fresh report-v2 backup admission sequence in `docs/RELEASE.md`.

## Public Browser Regression Gate

- **Run:** Execute `npm run test:visual:staging` from the repository on a machine with Google Chrome. The default targets are the controlled Signal storefront and unauthenticated staging app boundary; override them only with `SELINOW_VISUAL_BASE_URL` and `SELINOW_VISUAL_APP_ORIGIN` pointing to an approved non-production environment.
- **Coverage:** The gate compares desktop and mobile screenshots, checks horizontal geometry and runs axe WCAG A/AA scans for storefront home, product, cart, safe mocked checkout and login. Checkout cart/quote responses are intercepted locally, the submit button is never pressed and PayOS is never called.
- **Baseline update:** Run `npm run test:visual:staging:update` only for an intentional reviewed design change. Inspect every changed PNG before accepting it; do not update snapshots merely to silence an unexplained difference.
- **Failure:** Treat geometry, screenshot and axe failures as release blockers until the responsible UI change is understood. Keep `test-results/` and `playwright-report/` local because they can contain rendered tenant content.

## Phase A Read-Only Staging Smoke

- **Run:** After an admitted staging deploy, execute `npm run staging:phase-a:smoke -- --json`. The command reads `infra/environments/staging.json` and refuses local or production targets; it does not accept a base-URL override.
- **Read-only boundary:** Every request is an HTTPS `GET` with no body, credentials, cookies or provider calls. Responses are bounded to 256 KiB, redirects are not followed, response bodies are never printed and only safe check names/statuses/codes are emitted.
- **Coverage:** The gate checks `/api/health` for the `principal-channel-canonical-v1` Website/Telegram runtime marker, the Signal storefront catalog and home/product HTML, then verifies the Website checkout and Telegram webhook paths reject `GET` with `404` or `405`. The catalog check is a read-only D1 projection; it does not create a cart, quote, order, payment attempt, reservation, webhook update or fulfillment.
- **Acceptance:** Require every action to pass, the health `Cache-Control: no-store` contract, catalog `shop.slug=signal` and an active `signal-editor-lifetime` variant, storefront `200 text/html` responses, and mutation endpoints remaining GET-blocked. This is bounded post-deploy evidence only; it does not replace route inventory, platform doctor, fresh report-v2 backup, migration status or visual/browser gates.
- **Failure:** Keep the staging change paused on any status/content/health mismatch, redirect, oversized response or request failure. Do not retry with `POST`, provider health checks, Telegram updates, checkout, payment or seed actions; investigate from safe request IDs and logs instead.

## Authenticated Local Browser Gate

- **Run:** Execute `npm run test:browser:auth:local` on a machine with Google Chrome. The runner creates a random disposable D1/KV state directory, applies every repository migration and starts Astro with `--background`; it refuses to run while another Astro dev server is active.
- **Flow:** The test submits the local login form, clicks the rendered `mở magic link` link and verifies the current authenticated seller/admin route set with 21 surface IDs. The 7/7 gate covers exact 1440x1024 desktop and 390x844 mobile screenshots plus 768/320px responsive checks, 200% geometry, runtime, horizontal overflow, console/page errors and axe WCAG A/AA results.
- **Token boundary:** The test does not read the debug-link `href`, response body, cookies, storage state or token-bearing URL. The runner uses a temporary Wrangler config outside the repository, a mode-0600 `.dev.vars` containing only disposable secrets, an explicit local child-environment allowlist, disabled remote bindings and a loopback-only base URL; it removes the temporary state after the run.
- **Baseline update:** Run `npm run test:browser:auth:local -- --update-snapshots` only for an intentional reviewed UI change. Inspect every changed authenticated PNG before accepting it; the auth config keeps trace, video and HTML reporters disabled.
- **Failure:** Treat authentication, geometry, screenshot, console/page-error and axe failures as release blockers. A mode-0600 redacted assertion summary is written to ignored `test-results/authenticated-safe-failures.json`; it excludes token query values, cookies, secret bindings and long opaque values. Keep all local output under ignored `test-results/` and never attach rendered seller data to chat or tickets.

## Credential Compromise

- **Detect:** Treat a provider warning, unexplained credential rotation, repeated PayOS/Telegram 401 responses, invalid webhook signatures, unexpected admin audit events or a redaction failure as compromise. Record the environment, shop public ID, integration reference, first/last seen time and request IDs; never record the secret value.
- **Contain:** Revoke a compromised PayOS key or Telegram bot token at the provider first. Then have the shop owner use `DELETE /api/app/shops/{shopPublicId}/payments/payos` or `DELETE /api/app/shops/{shopPublicId}/integrations/telegram`; both require recent authentication and CSRF. If the seller cannot act and exposure is ongoing, a platform admin can apply `shop_suspend` through `POST /api/admin/moderation/actions` with a unique `Idempotency-Key`. Replace a compromised global Worker secret with `wrangler secret put <SECRET_NAME> --env <environment>` from an approved secret manager, never a command argument.
- **Recover:** Connect newly issued PayOS or Telegram credentials through the existing owner `PUT` endpoint. Successful provider verification activates the new credential; PayOS retains the previous credential in a 24-hour webhook grace state, so the provider-side revocation is mandatory when the old key is compromised. Use the encryption-rotation procedure below for `CREDENTIAL_KEK_*` or `INVENTORY_KEK_*`; never replace a KEK in place or remove the source version while encrypted rows still use it.
- **Verify:** Confirm the integration `GET` endpoint reports the expected active credential and verified webhook. Run the PayOS health-check endpoint or a private Telegram `/start` health check as appropriate, confirm old credentials fail at the provider, review active incidents/audit records, and verify logs contain only safe codes and references.
- **Communicate:** Notify the security owner, affected seller and provider contact with impact, containment time, credential class and follow-up actions. Notify buyers only when their order or delivery data was actually exposed; do not include secrets or key plaintext.

## PayOS or Webhook Outage

- **Detect:** Correlate PayOS webhook failure/signature metrics, scheduled reconciliation lag, provider errors, payment exception age and the shop-scoped `GET /api/app/shops/{shopPublicId}/payments/payos` and `/payments/exceptions` views. Distinguish provider unavailability from invalid credentials and rejected signatures.
- **Contain:** Never mark an order paid from a return URL, cancel URL, QR display or buyer screenshot. Leave ambiguous attempts pending or in their recorded exception state. If new checkouts would increase harm, the owner may disconnect PayOS through the existing `DELETE` endpoint; use platform `shop_suspend` only when the whole storefront must stop.
- **Recover:** Restore provider connectivity without changing order state manually. Use `POST /api/app/shops/{shopPublicId}/payments/payos/health-checks` to re-verify the current integration. The scheduled Worker runs `reconcilePendingPayments` every cron interval and may confirm only a response-signature-verified exact payment. Do not replay an untrusted raw webhook body.
- **Verify:** Confirm signed webhooks return normally, reconciliation lag falls, exact payments reach one `paid_exact` attempt and one fulfillment path, and partial, overpaid, late, identity-mismatched or inconsistent payments remain open exceptions without fulfillment.
- **Communicate:** Publish provider status, affected time range and whether checkout is paused. Give support the safe order/payment attempt references and an update cadence; never request provider credentials or webhook payloads in chat.

## Suspected Duplicate Fulfillment

- **Detect:** Start from the order, payment-attempt and fulfillment references. Check tenant-scoped counts for payment events, `fulfillments.idempotency_key`, fulfillment items and sold inventory rows. An exact replay should be recorded as `already_fulfilled`, not create another allocation.
- **Contain:** Suspend the affected shop if duplicate delivery is still possible. Stop manual resend/refund actions until one incident owner has reconstructed the sequence. Do not set a sold or disclosed inventory key back to `available`, and do not expose its plaintext while investigating.
- **Recover:** Select the single authoritative payment and fulfillment record, preserve all conflicting references, and remediate the buyer through an approved support/refund process. The repository has no general-purpose undo or re-fulfill admin endpoint; database edits require a separate reviewed data-correction procedure and backup.
- **Verify:** Confirm one paid state, one fulfillment idempotency key per fulfillment type, no inventory key linked to multiple fulfillment items, no new `order_paid` outbox/DLQ recurrence and no cross-shop rows in the investigation.
- **Communicate:** Notify payment, support and security owners. Contact only affected buyers, describe the remedy without sending license-key plaintext through support systems, and record the incident and audit references.

## D1 Failure and Real Recovery

- **Detect:** Treat sustained D1 errors, failed health checks, migration ledger drift, failed integrity/FK checks or an unusable backup/restore drill as a high-severity data incident. Capture safe error codes, environment, release version and first/last seen time.
- **Contain:** Stop deploys, migrations and non-essential mutations. Do not point another environment at the affected database, import into it, or use KV/R2 as transactional authority. Create a protected backup only if the source is readable and the operation will not worsen the incident.
- **Recover:** Use the D1 Backup and D1 Restore Drill procedures below to select and validate a snapshot. A real Time Travel restore is intentionally outside repository scripts and requires separate approval, exact database name/ID validation, an assigned data owner, a rollback point and a post-restore plan.
- **Verify:** Run migration status, integrity and foreign-key checks, tenant/order/inventory/provider count comparisons, then smoke health, login, storefront and a controlled non-production order flow. Keep writes paused until the restored state and reconciliation boundaries are accepted.
- **Communicate:** Notify the incident commander, data owner, release owner and support. Report the recovery point and possible data-loss window without attaching database artifacts or row contents.

## Custom Domain Misroute

- **Detect:** Reproduce with the exact hostname and compare the rendered shop with `GET /api/app/shops/{shopPublicId}/domains`, customer DNS, Cloudflare hostname/SSL state and the canonical/primary domain. A ready domain requires hostname, SSL and DNS status all `active`.
- **Contain:** Prefer platform `shop_suspend` when a hostname is serving the wrong tenant or checkout cannot be trusted. An owner may `DELETE /api/app/shops/{shopPublicId}/domains/{domainId}` to remove routing, but deletion is deliberately blocked while an active payment depends on the domain. Do not patch authoritative routing in KV and do not change the broad shared-zone Worker routes during incident response.
- **Recover:** Correct the customer CNAME to `SAAS_CNAME_TARGET`, then use `POST /api/app/shops/{shopPublicId}/domains/{domainId}/checks`. Restore primary status only with `PUT /api/app/shops/{shopPublicId}/domains/{domainId}/primary` after all readiness signals pass. Provider deletion retries are handled by scheduled domain reconciliation.
- **Verify:** Test external HTTPS, tenant identity, canonical redirects, cart/checkout origin behavior and the platform subdomain. If removing a hostname, verify it no longer resolves through the shop and cannot be made primary.
- **Communicate:** Notify the domain owner, affected seller, support and security owner with the hostname, safe domain ID, impact window and DNS action. Never request registrar or Cloudflare credentials in a ticket.

## Encryption-Key Rotation

- **Detect:** Rotate after confirmed/suspected KEK exposure, cryptographic policy change, or count-only evidence that rows remain on a retiring version. Scope the run to one of `inventory`, `generated_license_artifacts`, `payment_credentials`, `generated_license_credentials`, `telegram_credentials` or `telegram_recipient_ids` and to a shop or global scope.
- **Contain:** Provision the new versioned Worker secret and keep the source KEK available. Set the corresponding active version to the target before a live run so new writes cannot recreate source-version rows. Never overlap global and shop runs for the same key family, and never edit ciphertext, IV, AAD or key-version columns manually.
- **Recover:** Use the authenticated Operations UI or `POST /api/admin/operations/rotations` to create a dry-run first, review `totalItems`/`oldVersionRows`, then create the confirmed live run. Process resumable batches through `POST /api/admin/operations/rotations/{runId}/process` until complete; each request is capped at 100 records. The routes require a platform owner, recent authentication, CSRF and unique idempotency keys, with explicit phrases for global/live runs. Export-key rotation is not covered by this service.
- **Verify:** Require `status=completed`, `failedItems=0` and `oldVersionRows=0`; repeat processing if source-version rows reappear. Round-trip decrypt payment, Telegram credential, Telegram recipient, inventory, generated-license credential and generated-license artifact samples in the correct tenant scope, and confirm `encryption_rotation.created` and `.completed` audit events before retiring the source KEK. Keep `generated_license_credentials` on the credential key family and `generated_license_artifacts` on the inventory key family; do not combine their runs.
- **Communicate:** Security owns the run ID, source/target versions, scope, counts, failures and retirement decision. Communicate versions and references only, never key material or decrypted samples.

## Queue or DLQ Backlog

- **Detect:** Monitor integration/notification queue depth, oldest age, retries and `selinow-dlq-{environment}` growth. Also monitor `generated_license_requests` in `retryable|reconcile_pending|failed|manual_review` and the tenant-scoped `generated_license_dead_letters` ledger. `/admin/operations` or `GET /api/admin/operations` lists active reference-only dead letters and their linked incidents.
- **Contain:** Acknowledge the incident/dead letter to establish ownership, then pause the producing feature or suspend the affected shop when repeated work can create customer harm. Do not copy raw messages between queues; valid queue envelopes contain references only. For generated licenses, never manually set a request to `succeeded` or reveal an artifact while the provider outcome is uncertain.
- **Recover:** Fix the referenced domain operation idempotently. For a generated-license request, reconcile an ambiguous outcome before permitting another generate attempt; a retry may enqueue only the canonical shop/request/operation reference envelope through the owning service. The admin `request_retry` action records an audited retry request but currently does **not** enqueue a replacement message. Re-dispatch therefore requires the owning domain's approved idempotent service; if none is exposed, leave the item acknowledged/retry-requested and escalate instead of crafting a queue message manually.
- **Verify:** Confirm queue depth and oldest age decline, the referenced order/provider/outbox state is correct, no duplicate side effect occurred, and no new occurrence reopens the dead letter. Resolve it with a specific safe `resolutionCode` only after verification.
- **Communicate:** Queue, integration and support owners receive the queue name, dead-letter/incident/reference IDs, safe failure code, backlog size and next update time. Never send payload bodies or credentials.

## Incident Lifecycle

- **Detect:** Use `/admin/operations` for severity-sorted active incidents and dead letters. Repeated occurrences update and may escalate an active incident; a recurrence after resolution creates a new incident rather than rewriting history.
- **Contain:** A platform admin with recent authentication acknowledges through the page or `POST /api/admin/operations/incidents/{incidentId}` using `action=acknowledge`, the exact `shopId` (or `null`) and current `expectedVersion`. Use the linked resource reference to apply the relevant runbook.
- **Recover:** Record remediation in the incident system of record outside sensitive payloads. Resolve through the same endpoint with `action=resolve` and a concise safe `resolutionCode`; optimistic version conflicts require reloading current state, not forcing an update.
- **Verify:** Require the source symptom to be absent for its monitoring window, linked dead letters/exceptions to be handled, and audit events `operations.incident_acknowledged` and `operations.incident_resolved` to exist. Resolution is not a substitute for service verification.
- **Communicate:** Assign incident commander, technical owner, support owner, severity, impact, cadence and next checkpoint. Use request/resource IDs and aggregate counts only, then publish a post-incident review for high/critical incidents.

## Abuse Report and Takedown

- **Detect:** Review storefront reports and platform-admin `GET /api/admin/abuse-reports`, correlating shop/product references, report status and immutable audit history. Preserve only the evidence already accepted by the bounded reporting flow; do not collect credentials or license-key plaintext.
- **Contain:** A platform admin uses `POST /api/admin/moderation/actions` with recent authentication, CSRF and a unique `Idempotency-Key`. Supported actions are `product_suspend`, `shop_suspend`, `product_restore` and `shop_restore`; use the narrowest sufficient suspension. Transition the report through `POST /api/admin/abuse-reports/{reportPublicId}`.
- **Recover:** Restore only after policy/legal review confirms the issue is corrected and the target still belongs to the same shop. Reuse neither a prior idempotency key nor an unverified target ID. Domain suspension and evidence-preservation action kinds are represented in the database schema but are not exposed by the current moderation API; deletion legal holds use the separate owner/risk operations endpoint described below.
- **Verify:** Confirm suspended shops/products are absent or safely blocked on storefront surfaces, checkout cannot proceed for a suspended shop, report/action states are tenant-correct and moderation audit events exist. After restoration, run storefront and checkout smoke checks.
- **Communicate:** Notify trust/safety, legal, support and the seller according to policy. Give reporters only the permitted status outcome; do not disclose other customers, internal evidence or security controls.

## Resumable Shop Deletion and Legal Hold

- **Detect:** The owner reads `GET /api/app/shops/{shopPublicId}/deletion`. Track request status, each step, `lastSafeErrorCode`, the 30-day `graceEndsAt`, seven-year financial retention marker, provider cleanup, secret destruction and completion timestamps.
- **Contain:** `POST /api/app/shops/{shopPublicId}/deletion` requires recent authentication, CSRF, `confirmation: "DELETE SHOP"` and a supported reason code. It immediately blocks checkout, suspends the shop and removes primary routing. Do not initiate deletion as a substitute for moderation, and create/verify a protected backup before an approved production request.
- **Recover:** Before irreversible work starts, the owner may cancel the exact request through `POST /api/app/shops/{shopPublicId}/deletion/cancel` with its request ID, expected version, safe reason code and a unique idempotency key. Otherwise re-run `POST /api/app/shops/{shopPublicId}/deletion/resume` with an empty JSON object. Leased steps resume safely through active-payment drain, grace/hold wait, custom-domain cleanup, Telegram cleanup, payment cleanup, crypto-shred and finalization. A blocked active payment, grace window, legal hold or provider failure must be cleared at its source before resuming; never skip or reorder steps.
- **Verify:** Completion requires every step completed/skipped, provider cleanup recorded, tenant export jobs revoked and their exact `PRIVATE_EXPORTS` objects deleted before `secretMaterialDestroyedAt`, generated-license non-terminal work canceled, generated-license credentials/artifacts destroyed, secret material destroyed, the shop archived, routing absent and retained financial/audit records still present. Repeated resume calls must remain idempotent and tenant-scoped. A live generated-license processing lease blocks the destructive step; export-object or provider failures leave the destructive marker unset and are retried; legal holds preserve the export object and block crypto-shred. Immutable generated-license requirement, request, attempt and DLQ evidence remains retained.
- **Communicate:** Give the seller the request ID, grace deadline, retention boundary and current safe blocker. A platform `owner` or `risk` operator can set/release a hold through `POST /api/admin/operations/deletions/{deletionRequestId}/legal-hold` with the exact shop ID, expected version, safe reason/evidence reference and unique idempotency key. Never use ad-hoc D1 edits; cancellation/hold attempts must reload current state after a version conflict.

## Staging Mutation Admission

Run the staging sequence only from the independent Selinow Cloudflare account. It does not authorize production access or production mutation.

1. Export temporary least-privilege operator credentials from the approved secret manager, then run the read-only gates:

   ```bash
   # D1-capable operator token mapped to CLOUDFLARE_API_TOKEN only inside
   # backup/restore/migration child Wrangler commands.
   export CLOUDFLARE_D1_API_TOKEN
   export CLOUDFLARE_PLATFORM_API_TOKEN
   export CLOUDFLARE_ROUTE_AUDIT_API_TOKEN
   # Dedicated Workers Scripts token used only by the final Worker deploy sink.
   export CLOUDFLARE_WORKER_DEPLOY_API_TOKEN
   npm run deploy:staging:dry-run
   npm run platform:route-preflight -- --json
   npm run platform:doctor -- --env staging --json
   npm run db:migrate:status -- --env staging
   npm run db:preflight -- --env staging --json
   npm run backup:create -- --env staging --dry-run --json
   ```

   `CLOUDFLARE_D1_API_TOKEN` exists only in the operator environment and is
   mapped to Wrangler's `CLOUDFLARE_API_TOKEN` for the D1 child process. The
   runtime Worker secret named `CLOUDFLARE_API_TOKEN` is never operator input.

2. Stop without mutation unless the doctor proves the authenticated Wrangler account matches `infra/environments/staging.json`, the SaaS DNS/fallback contract is ready, the shared-zone apex/wildcard and `*/*` fallback point only to `selinow-com-production`, and all four explicit staging exceptions point only to `selinow-com-staging`. Shared mutation admission additionally requires the live D1 list to contain exactly the generated-manifest database name and UUID. Missing credentials, unreadable inventory or any drift is a failed admission.
3. After an approved staging change window, use the exact ceremony below. The pre-migration manifest binds the clean commit/tree, exact live ledger prefix, backup checksum/target and isolated restore report. After migration and any separately approved seed, create a second protected backup and restore drill, then run `db:complete-release`; that command writes the immutable post-migration evidence required by `deploy:staging`. The post-migration snapshot must be different from and newer than the manifest-bound pre-migration snapshot. `db:migrate` applies every pending numbered migration in filename order; for the current tree the complete source ledger ends at `0096_telegram_runtime_rollback_compatibility.sql`. Review the whole pending chain before opening the window and never deploy current source against a partially applied schema.

   ```bash
   HEAD_SHA="$(git rev-parse HEAD)"

   npm run backup:create -- --env staging --json
   npm run restore:drill -- --env staging --reviewed-commit "$HEAD_SHA" --json
   npm run release:staging:manifest -- --write --json

   # Set this to the exact manifestRef emitted by the previous command.
   MANIFEST_REF=".wrangler/releases/staging/<release-id>/release-manifest.json"
   npm run db:migrate -- --env staging --confirm-maintenance-drain --release-manifest "$MANIFEST_REF"
   npm run db:migrate:status -- --env staging
   npm run db:preflight -- --env staging --json

   # Run only when the reviewed release explicitly requires a seed.
   npm run db:seed -- --env staging --release-manifest "$MANIFEST_REF"

   npm run backup:create -- --env staging --json
   npm run restore:drill -- --env staging --reviewed-commit "$HEAD_SHA" --json
   npm run db:complete-release -- --env staging --release-manifest "$MANIFEST_REF" --json

   npm run platform:doctor -- --env staging --json
   npm run deploy:staging -- --release-manifest "$MANIFEST_REF"

   # Read-only post-deploy binding; requires the three audit tokens documented below.
   node scripts/staging-deployment-evidence.mjs \
     --manifest "$MANIFEST_REF" --write --json
   ```
4. Staging mutation subprocesses are pinned with the admitted `CLOUDFLARE_ACCOUNT_ID`. Neither temporary operator token is forwarded into the application build, D1 mutation or deploy child process.
5. Re-run migration status, D1 preflight, route/platform admission and bounded staging smoke checks after the change. Require no pending migration from the approved chain, `payment_provider_projection` and generated-license schema checks to reflect the applied ledger, and the same exact route inventory. The immutable deployment evidence must be created within two hours of the observed 100% deployment and before the manifest expires. Unset all temporary operator tokens when the window closes.

`db:migrate:status`, `db:preflight`, backup dry-run, staging build-only and deploy dry-run remain read-only/non-deploying checks and do not require route admission. Do not treat their success as permission to mutate staging.

After deployment, run `npm run trigger:inventory -- --env staging --json` with a
temporary read-only account token in `CLOUDFLARE_STAGING_TRIGGER_AUDIT_API_TOKEN`.
The helper reads only the three configured queue consumers and the exact Worker
schedule, compares them with `wrangler.jsonc`, and emits redacted checks without
consumer IDs or raw provider responses. For production use the same command with
`--env production` and `CLOUDFLARE_PRODUCTION_TRIGGER_AUDIT_API_TOKEN`; neither
mode creates, updates or deletes a trigger.

Every admitted staging deploy now writes a non-secret Cloudflare Worker version
message containing the exact release ID, commit/tree, canonical manifest
reference and manifest SHA-256. After deploy, run
`node scripts/staging-deployment-evidence.mjs --manifest "$MANIFEST_REF" --write --json`.
The collector performs only read-only Cloudflare inventory: deployment and
deployable-version reads with `CLOUDFLARE_STAGING_DEPLOYMENT_AUDIT_API_TOKEN`,
the zone Worker Routes read with `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN`, and the
queue/cron reads with `CLOUDFLARE_STAGING_TRIGGER_AUDIT_API_TOKEN`. It requires
the newest deployment to contain exactly one Worker version at 100%, verifies
the version message against the manifest hash, and verifies the exact staging
route and trigger contracts. It never accepts an operator-entered Worker
version as evidence.

The result is the immutable private mode-`0600` artifact
`.wrangler/releases/staging/<release-id>/deployment-evidence.json`. It records
the Cloudflare deployment ID, active Worker version, account/Worker, deployment
and observation timestamps, candidate identity, manifest hash, and canonical
route/trigger inventory fingerprints. The artifact hash is returned by the
command and is not embedded into either the artifact or manifest, avoiding a
self-reference. Noncanonical paths, any symlink ancestor, relaxed permissions,
stale observations, split traffic, version-message drift, or route/trigger drift
fail closed. An existing artifact is never overwritten; a stale or superseded
binding requires a new clean release manifest and deployment.

Release admission must call the exported
`verifyStagingDeploymentEvidence(...)` helper with the canonical manifest and
artifact paths plus all three read-only audit tokens. Verification never trusts
the private artifact alone: it repeats deployment/version, route and trigger
inventory, revalidates the Worker version message, and compares the fresh
deployment ID, exact 100% version and both inventory fingerprints. Unavailable
remote inventory or a forged self-consistent local artifact fails closed.

Each trigger/deployment audit token is account-restricted and read-only: Account
Settings Read, Queues Read and Workers Scripts Read, plus User Memberships Read
and User Details Read for Wrangler identity admission. Worker Routes Read remains
confined to the separate route-audit token. DNS write, D1, secret write and
trigger edit permissions are not required by either inventory helper.

The latest retained staging database evidence and source ledger are complete through `0094`. Every new candidate must still freshly admit that exact ordered ledger, complete its post-migration evidence and create a new immutable deployment binding. `db:migrate:status`, `db:preflight` and the post-migration schema contract are the read-only sources of truth for the remote ledger. Worker deploy and provider UAT remain separate gates. The route preflight remains fail-closed with `cloudflare_route_audit_api_token_missing` when the temporary audit token is absent. No production migration or provider activation is claimed; production remains `NO-GO` for full commerce/provider activation.

## Phase A Canonical Commerce Cutover Boundary

- Local acceptance is complete: the Website, Telegram and `fake.third` paths share the canonical checkout transaction; the dedicated five-file real-D1 seam refresh passed `106/106` focused tests, including canonical Website recovery with and without discounts, order-insensitive retry/recovery, replay/conflict, tenant isolation, cart concurrency and last-stock one-winner cases. This is source/local evidence only.
- Staging has retained database evidence through `0094`. Do not describe a Worker or provider UAT as accepted until the exact candidate has its own manifest, post-migration evidence, immutable deployment identity, health, route and provider evidence.
- The current database CLI has no migration-range selector: `npm run db:migrate -- --env staging` applies the entire pending numbered chain in order. A partial staging rollout therefore requires a separately reviewed migration/deploy design; never apply the complete chain and report only a subset cutover.
- The post-deploy evidence command is `npm run staging:phase-a:smoke -- --json`; it is GET-only and checks the canonical runtime marker plus read-only Website/catalog and Telegram method boundaries. A pass does not authorize mutation or imply that the pending migration chain was applied.
- The current broad Worker is not a valid partial-schema artifact: storefront resolution, scheduled cleanup, Telegram runtime/outbox, payment, buyer order recovery, privacy, PayOS claim fencing, custom-domain Turnstile admission and shop-creation admission depend on later schema/data guards. The supported reviewed cutover is the complete source chain through `0094`; provider activation still requires the combined payment/non-payment handoff.

## D1 Migration Compatibility

Cloudflare D1 staging currently accepts at most five terms in one compound `SELECT`; six terms fail with `too many terms in compound SELECT` (`SQLITE_ERROR`, provider code `7500`). Keep each `UNION`, `INTERSECT` or `EXCEPT` chain at five terms or fewer. The repository test `tests/unit/d1-migration-compatibility.test.ts` lexes every numbered migration and blocks a larger chain before deployment.

Before applying a new migration, run `npm test`, create a protected backup and confirm the exact pending migration list. If `wrangler d1 migrations apply` returns a timeout or SQL error, do not retry blindly: re-read the migration ledger and query the expected column/table/index/trigger names to prove whether the failed request committed anything. Edit an existing numbered migration only when every configured remote ledger proves it has never been applied; otherwise create a new forward-only migration.

### Payment projection and legacy PayOS guard checks

Migrations `0035_payment_provider_connections.sql` through `0052_generated_license_request_hardening.sql` are forward-only and remain staging-pending until the normal admission gate succeeds. `0039_payment_provider_identity_shred.sql` only releases generic provider identity claims inside the admitted deletion crypto-shred fence; `0040` widens API credential scopes for the bounded catalog read; `0041` adds the pre-R2 private-download lease; `0042` adds bounded security-rate-limit retention; `0043` enforces seller-owned direct settlement and provider-partner MoR policy; `0044` enforces immutable supported order/shop currency binding; `0045` persists a tenant-scoped Telegram buyer locale preference; `0046` adds immutable seller-attested manual execution and hash-only external-reference evidence; `0047` adds the generic entitlement resource/policy/requirement/state/grant/transition graph; `0048` adds the immutable verified payment-reversal ledger plus typed access revocation; `0049` adds generated-license provider configuration, request/attempt/artifact/DLQ state; `0050` adds deletion crypto-shred transitions; `0051` adds separate generated-license credential/artifact rotation families; and `0052` hardens generated-request initial state, terminal evidence and scheduler/rotation indexes. The legacy PayOS integration, credential, attempt and event tables remain runtime-authoritative; `0048` consumes only verified normalized evidence and the signed reversal branch now calls the same revocation service without adding a second provider.

This migration batch performs its own deterministic backfill/validation and does not require a seed. Do not run `db:seed` merely because `0035`-`0043` were applied.

After a local migration/restore, and after any future admitted staging migration, run the conditional payment and generated-license checks through `npm run db:preflight -- --env {environment} --json`. The read-only preflight always reports zero for `invalid_payos_active_credential_links`, `invalid_payos_credential_integration_links`, `invalid_payos_attempt_links`, `invalid_payos_event_links`, `invalid_payos_exception_links` and `invalid_payos_paid_event_links`, even while `0035`-`0052` remain pending. A pre-`0035` database must report `payment_provider_projection=not_applied`; a post-`0035` database must report zero for `missing_payos_connections`, `invalid_payos_connection_links`, `invalid_payos_capability_grants`, `invalid_payos_currency_grants`, `invalid_payos_method_grants`, `stale_effective_authorizations` and `invalid_payos_reference_codes`. The checks must also prove that projection tables are complete (not partially present), every PayOS connection links to the same-tenant legacy integration, only VND/`bank_transfer_qr` and the four implemented capabilities are granted, effective rows are disabled when health, webhook, account identity or descriptor/policy versions are stale, and all eight generated-license tables plus the `0052` hardening trigger/index set have the expected schema, tenant-leading indexes, same-tenant guards and immutable evidence rules when `0049`-`0052` are present.

Migration `0037` validates legacy relationships before installing guards. If it aborts on any `*_scope_mismatch` or validation-table CHECK, stop and repair the source data through an audited forward migration; never bypass the guard with ad-hoc D1 edits. Verify active credential pointers, attempt/order/integration/credential links, event/attempt/integration links, exception/order/attempt links and paid-event pointers remain same-tenant and same-provider. Keep financial attempts, events and exceptions for audit/retention; the migration adds indexes/triggers and does not rewrite those rows.

The backup validator must include all `0035` projection tables, `api_credentials`, seller-operation ledgers (`shop_member_invitations`, `customer_notes`, `order_notes`, `subscription_change_requests`, `order_messages`, `payment_remediation_requests`), security-rate-limit retention state, order-currency and Telegram-locale preference state, the `0046` manual execution/reference ledgers, all six `0047` generic entitlement tables, `payment_reversal_events`, all eight `0049` generated-license tables, and the channel-expansion ledgers (`channel_connector_requests`, `telegram_mini_app_sessions`, `channel_provider_event_receipts`, `channel_customer_identities`, `channel_oauth_states`, `channel_provider_verification_evidence`, `catalog_channel_visibility`). Its authoritative row-count contract also covers `order_items`, `fulfillments`, `fulfillment_items`, `manual_fulfillment_executions`, `external_fulfillment_references`, `entitlement_resources`, `product_entitlement_policies`, `order_item_entitlement_requirements`, `entitlements`, `entitlement_grants`, `entitlement_transitions`, `payment_reversal_events`, `generated_license_provider_connections`, `generated_license_provider_credentials`, `generated_license_resource_bindings`, `generated_license_requirement_snapshots`, `generated_license_requests`, `generated_license_attempts`, `generated_license_artifacts`, `generated_license_dead_letters`, `channel_connector_requests`, `telegram_mini_app_sessions`, `channel_provider_event_receipts`, `channel_customer_identities`, `channel_oauth_states`, `channel_provider_verification_evidence`, `catalog_channel_visibility`, `data_export_jobs`, `shop_deletion_requests`, `shop_deletion_steps`, `encryption_rotation_runs` and `encryption_rotation_items`; losing even one row from any of these tables fails the isolated drill with `restore_count_mismatch`. The local restore drill must apply the exact repository ledger through the current numbered migration, pass integrity/FK/schema/count checks and emit a fresh safe report before any staging change is considered ready. The retained local report through `0048` is historical evidence only; the earlier `rdr_20260802093008_62fc355479ae.json` report is historical through `0059`, while no staging migration is claimed and no local report may be substituted for the fresh report-v2 staging backup gate.

The retained local report `.wrangler/restore-drills/local/rdr_20260802132434_f77680c70c88.json` applies the prior `0001`-`0066` source chain, restores 612 items, passes integrity/FK/schema/count checks, records the known alias normalization in the disposable copy and leaves the authoritative local D1 unchanged. Fresh candidate-bound staging restore evidence applies the contiguous `0001`-`0094` chain and passes integrity, foreign-key, schema and count checks. It proves the database continuation only; the Worker still requires the separate immutable deployment-binding artifact and none of this is production release evidence.

### Seller-attested manual fulfillment

`POST /api/app/shops/{shopPublicId}/orders/{orderPublicId}/manual-fulfillments` is an owner/manager mutation for one exact paid manual order item. Require the runtime CSRF contract, recent authentication, `fulfillment:manage`, a unique `Idempotency-Key` and the typed `seller_attested_delivery` payload. A private-file or generic-entitlement order-item requirement is never eligible for seller attestation; migrations `0046` and `0047` enforce the typed boundaries.

The optional external reference is accepted only to derive a tenant/type-bound HMAC. Never log, audit, queue, export or redisplay the plaintext or its digest. Same-key/same-payload retries return the existing execution, changed payloads fail closed, and concurrent different-key attempts permit one execution. The legacy fulfillment/order projection becomes fulfilled only after every eligible untyped manual item is recorded; private-file and generic-entitlement items are projected by their typed paths instead. Backup validation counts both immutable manual ledgers; standard export schema version 5 retains their safe metadata; shop deletion retains them as financial/audit evidence. Reference rotation is not applicable because no decryptable reference is retained; changing the identifier HMAC family requires a new versioned comparison/retention decision rather than rewriting the immutable rows.

### Generic entitlement foundation

Migration `0047_generic_entitlement_foundation.sql` is present in the admitted production baseline but remains staging-pending. Before any staging deploy that reads its schema, require migration status to show `0047` pending, complete the normal route/identity/fresh-backup admission, apply the full ordered chain, and verify all six tables plus their tenant-leading indexes and immutable guards. Never deploy code that depends on `0047` while the accepted staging ledger still ends at `0028`.

Website, Telegram and `fake.third` must use the canonical checkout batch so the exact active product policy is snapshotted into `order_item_entitlement_requirements`. Free checkout creates an active entitlement and immutable `free_checkout` grant. Paid checkout creates a pending entitlement; activate it only inside the exact signed payment-event transaction after verifying the claimed unprocessed event, `paid_exact` attempt and matching `paid_event_id`. Return URLs, QR rendering, partial, overpaid, late, mismatched, refunded or reversed evidence must not activate access.

Classify each manual order item before creating legacy fulfillment rows: a private-file requirement uses private delivery, a generic requirement uses the entitlement graph, and only an item with neither typed requirement enters seller-attested manual work. Preserve requirements, grants and transitions as immutable evidence. Standard export schema version 5 must omit buyer/replay/reference hashes and grant request IDs; deletion may retire resources/policies and revoke pending/active/suspended entitlements only behind the existing legal-hold and crypto-shred fence. Generated-license requirements use the seller webhook runbook below rather than seller attestation. See `docs/adr/0016-generic-entitlement-foundation.md` for the accepted boundary and deferred membership/community/seat/device provider execution.

### Verified payment reversal and entitlement revocation

Migration `0048_payment_reversal_entitlement_revocation.sql` is present in the admitted production baseline but remains staging-pending. Before deploying code that reads `payment_reversal_events`, require migration status to show `0048` pending, complete the normal route/account/D1/fresh-report-v2-backup admission, apply the full ordered chain and verify the table, tenant-leading indexes, immutable update/delete guards and exact payment-scope insert guard. Never deploy dependent code while staging still ends at `0028`.

Accept a reversal only from a verified signed webhook or direct reconciliation bound to the exact shop, order, `paid_exact` attempt, provider, integration, credential version and original fulfilled payment event. Never use a return URL, QR render, seller input or unverified webhook body. Do not log or ticket the provider reference, payload, credential, evidence hash, idempotency hash or request hash; use only the reversal ID, order public ID and safe decision/reason codes.

An exact full refund or chargeback must atomically set the order payment status to `refunded`, revoke generic pending/active/suspended entitlements with immutable `payment_reversal` transitions, revoke private active/suspended entitlements and revoke active delivery grants. Confirm sold keys, fulfillment rows, generic/private grants and delivery-consumption history were retained. Partial, currency/amount-mismatched or otherwise non-exact evidence must create one open `manual_review` payment exception and must not revoke access. Same provider reference and identical evidence replays the stored result; changed evidence or tenant/order/provider bindings fail closed.

Standard export schema version 5 exposes only safe normalized reversal metadata and excludes raw references, credential/integration IDs and all reversal hashes. Backup schema/count verification must include `payment_reversal_events`; shop deletion retains this immutable financial/audit ledger. An open reversal manual-review exception remains an active-payment deletion fence until resolved. See `docs/adr/0017-payment-reversal-entitlement-revocation.md`.

### Generated-license seller webhook fulfillment

Migrations `0049`-`0052` are present in the admitted production baseline. Before any staging deployment that reads current source tables or guards, require the exact migration status, live-route/account/D1 admission and two-phase report-v2 backup/restore sequence; apply the complete ordered chain through `0094`, then verify generated-license, activation, recovery, privacy, platform-admin, PayOS claim-fencing, buyer order recovery, custom-domain Turnstile admission and shop-creation admission tables/guards, tenant-leading indexes, same-tenant foreign keys, immutable request transitions, scheduler/key-version indexes and rotation resource types. Never deploy dependent code before `db:complete-release`, the post-migration contract and smoke gates pass.

Configure only the seller-owned `seller.webhook` adapter. D1 stores the provider connection, encrypted credential envelope, active resource binding and immutable requirement snapshot. Credential fields use the credential key family and purpose/key-version/shop/connection/credential/field AAD; artifacts use the inventory key family and separate purpose/key-version/shop/request/artifact/format AAD. AES-GCM ciphertext, IVs and HMAC fingerprints are safe stored projections; provider credentials and artifact plaintext must never enter queues, DLQs, logs, exports or tickets.

Create a generated request only after the entitlement is active and its grant is committed: free checkout after the `free_checkout` grant, or paid checkout after the exact signed/claimed unprocessed `paid_exact` event. Website, Telegram and `fake.third` must produce the same requirement snapshot, grant and request boundary. A request is one artifact (`grant_quantity=1`, ordinal `1`) and carries only a stable provider idempotency hash.

Process only the canonical reference envelope containing `shopId`, `requestId` and safe operation/reference fields. Retry `408`, `425`, `429` and `5xx` failures with bounded backoff. Treat network failure or an invalid successful response as ambiguous: persist `reconcile_pending`, then call provider `reconcile` before any new `generate`. Permanent or exhausted failures open the generated-license DLQ with safe context and retain immutable attempt evidence. Never mark an order paid from this worker or from a provider response alone; D1 entitlement/payment state remains authoritative.

For an exact verified refund or chargeback, use the payment-reversal transaction. It cancels pending, retryable, reconcile-pending and processing generated-license requests locally, revokes active artifacts and makes no provider call. Preserve request, attempt, fulfillment, grant and consumption evidence. Partial, mismatched or unverified reversal evidence remains `manual_review` and does not revoke access. During shop deletion, wait for active generated work to drain, then cancel non-terminal requests, resolve DLQ rows, retire bindings/connections and crypto-shred credential/artifact envelopes; retain immutable snapshots, requests, attempts, DLQ and financial/audit evidence.

### Public API credential foundation

Migration `0038_api_credentials.sql` adds owner-managed API credentials, `0040_api_catalog_scope.sql` widens the immutable allowlist to `shop:read`/`catalog:read`, and `0068_public_api_read_scopes.sql` forward-adds `inventory:read`/`orders:read` without rewriting token hashes or lifecycle state. The token is shown exactly once after `POST /api/app/shops/{shopPublicId}/api-credentials`; only its keyed hash is retained. Require recent session authentication, CSRF and a unique `Idempotency-Key` for issue/revoke; replaying the same request returns redacted metadata and never the token. `DELETE /api/app/shops/{shopPublicId}/api-credentials/{credentialPublicId}` uses an optimistic version and safe reason code, and revocation must be idempotent/audited exactly once. All `GET /api/v1/*` projections authenticate solely from the Bearer token, derive the tenant from D1 and apply the fixed-window rate limit. Catalog responses include active tenant categories/products/variants and derived stock state; inventory returns aggregate counts only; orders return safe status/amount/timestamp summaries with customer, provider, payment-attempt, fulfillment-internal and token data redacted. Never accept a client `shop_id`, log the token/hash, or place credentials in queues/audit metadata/exports. Standard exports may include only non-secret credential metadata; deletion revokes API credentials under the existing lease fence and retains financial attempts/events/exceptions. Fulfillment, entitlement and outbound webhook scopes are not yet implemented.

## D1 Backup

### Purpose and safety boundary

`backup:create` captures an environment's exact `PLATFORM_DB` target without printing database rows, credentials or the raw database artifact. The tool accepts only `local`, `staging` and `production`, validates the fixed `selinow-*` database name from `wrangler.jsonc`, and refuses an unconfigured or mismatched binding.

Backup artifacts and reports are written beneath `.wrangler/backups/{environment}/` with directory mode `0700` and file mode `0600`. `.wrangler/` is git-ignored. Treat every SQLite copy or SQL export as sensitive customer data even though credentials and inventory keys are encrypted at the application layer.

For remote D1, the report stores a Time Travel bookmark privately and exposes only the snapshot ID, SHA-256 checksum, byte size and report path on stdout. The provider bookmark is not printed. The report contains a `backup_snapshots`-compatible record from migration `0011` when that schema is available.

### Procedure

1. Confirm the exact environment and planned source:

   ```bash
   npm run backup:create -- --env local --dry-run --json
   npm run backup:create -- --env staging --dry-run --json
   ```

2. For staging or production, verify Wrangler is authenticated to the independent Selinow Cloudflare account. Never paste an API token into command arguments or logs.
3. Create the backup:

   ```bash
   npm run backup:create -- --env local --json
   npm run backup:create -- --env staging --json
   npm run backup:create -- --env production --confirm-production --json
   ```

4. Record the safe snapshot ID, checksum and report reference in the release/incident record. Do not attach the database artifact to tickets or chat.
5. Before a risky production migration, retain both the D1 Time Travel bookmark and protected export. The report uses a conservative 29-day expiry reminder for remote Time Travel evidence.

### Failure handling

- `database_binding_missing:*` or `database_target_mismatch:*`: stop; fix the environment manifest/config before any database action.
- `production_confirmation_required`: obtain explicit production-change approval; do not bypass the guard.
- `cloudflare_credentials_missing`: authenticate Wrangler or supply a least-privilege operator context outside source control.
- `time_travel_info_failed` or `database_export_failed`: do not migrate/deploy. Preserve the safe error code and retry only after provider health and account context are verified.
- `database_export_empty`: treat the backup as failed; never use the artifact for recovery.

### Verification and communication

- A backup is usable only when status is `available`, its export is non-empty and the checksum is recorded.
- A checksum proves artifact stability, not recoverability. Run the isolated restore drill below before declaring the backup strategy healthy.
- For production backup failure, notify the release owner and suspend database mutation until a valid snapshot exists.

## D1 Restore Drill

### Non-destructive contract

`restore:drill` never calls `wrangler d1 time-travel restore` and never imports into the source database. Local drills use SQLite `VACUUM INTO` to create a consistent copy of the exact local D1 in a fresh database under the operating-system temp directory. Remote drills create a randomly named database matching `selinow-restore-drill-{environment}-*`, verify that it did not already exist, and delete only that exact generated target afterward.

Before any remote temporary directory or D1 target is created, the drill admits the environment only when `wrangler whoami --json` includes the account ID declared by both `infra/environments/{environment}.json` and `infra/generated/{environment}.json`, and `wrangler d1 list --env {environment} --json` contains exactly one source with the declared D1 name and UUID. Every subsequent remote Wrangler call is account-pinned with `CLOUDFLARE_ACCOUNT_ID`. An account mismatch returns `restore_account_mismatch:{environment}`; a source name/UUID mismatch returns `restore_database_mismatch:{environment}`.

Cleanup requires both the fixed temp-directory prefix and a marker containing the current drill ID. A missing/mismatched marker fails closed instead of recursively deleting an uncertain path.

### Procedure

1. Review the plan without credentials or mutation:

   ```bash
   npm run restore:drill -- --env local --dry-run --json
   npm run restore:drill -- --env staging --dry-run --json
   ```

2. Run the local isolated drill after migration changes and before every release candidate:

   ```bash
   npm run restore:drill -- --env local --json
   ```

3. Run staging only during an approved operations window. It creates and then deletes a temporary remote D1 database:

   ```bash
   npm run restore:drill -- --env staging --reviewed-commit "$(git rev-parse HEAD)" --json
   ```

4. Production drills require explicit confirmation and a provisioned exact production binding. The target remains a disposable, isolated production-account database; the production source is never overwritten:

   ```bash
   npm run restore:drill -- --env production --confirm-production --reviewed-commit "$(git rev-parse HEAD)" --json
   ```

5. Attach only the safe report from `.wrangler/restore-drills/{environment}/` to release evidence. Reports contain `backup_snapshots`- and `restore_drills`-compatible records, counts and safe status codes, never raw rows.

### Acceptance checks

The drill passes only when all checks succeed:

- The protected SQLite copy or remote SQL export imports into the isolated target.
- Every pending forward migration applies.
- `PRAGMA integrity_check` returns exactly `ok`.
- `PRAGMA foreign_key_check` returns zero violations.
- Required core, payment projection (`0035`), API credential/catalog-scope (`0038`/`0040`) and Phase 9 operations tables exist when those migrations are in the target ledger.
- The `0046` manual execution/reference ledgers, all six `0047` generic entitlement tables, `0048` `payment_reversal_events` and all eight `0049` generated-license tables exist with tenant-leading indexes, same-tenant guards and immutable update/delete triggers when the target ledger includes them. The `0051` rotation control tables include the generated-license credential and artifact families/resource types.
- Pre-existing application-table counts are unchanged after restore/migration; remote drills compare fixed tenant/order/inventory/provider core counts.
- The migration ledger exactly matches the repository migration set for local drills. If the default Wrangler database contains the known historical `0062_zalo_oa_oauth_state_reissue.sql` row alongside the canonical `0062_zalo_oa_oauth_state_retry.sql` row, the drill removes only that alias from its disposable copy, records the normalization in the private report and leaves the authoritative local database unchanged. Any alias without its canonical row, or any unknown extra row, fails closed.
- The exact temporary target is removed.

### Failure and containment

- Any `restore_*_failed`, schema/count mismatch, FK violation or integrity failure marks the drill failed and blocks release.
- `restore_cleanup_failed:{target}` means the disposable remote database may still exist. Verify that the name exactly matches the reported `selinow-restore-drill-*` target before deleting it manually; never substitute the source database name.
- Preserve the safe JSON report and command exit code. Do not preserve temporary raw exports outside the tool-managed lifecycle.
- Open a high-severity operations incident for a production-source backup that cannot pass an isolated drill.

### Real recovery authorization

Restoring the real staging or production source is intentionally outside these scripts. A real recovery requires separate approval after impact assessment, an exact database ID/name check, a verified snapshot/bookmark, support/on-call ownership and a post-restore validation plan. Never improvise a Time Travel restore from the drill command or reuse a generated temporary target name as the source.
