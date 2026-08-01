# Production Release

Phase 10 uses a prepare, backup, deploy, verify, confirm-or-rollback sequence. Repository tooling is fail-closed: production configuration, secret names, backup evidence, security status, monitoring ownership and pilot evidence must be complete before a release manifest can be written.

The normal Phase 10 release remains NO-GO for changes that depend on pilot, signed PayOS, Telegram, fulfillment or custom-domain acceptance. Production already has an active rollback Worker version and live apex/wildcard Worker routes; do not treat it as an empty first-production target. The narrow frontend-only lane below exists specifically to preserve that live runtime while changing reviewed landing assets and markup.

Treat every saved production inventory as historical until the operator lane refreshes it with short-lived read-only credentials. Never infer D1 migration state, route state or active version from the retired bootstrap notes: capture the live D1 ledger, routes, domains, queues, cron, deployments and complete paginated version inventory immediately before upload and activation.

The planning commands in this document do not mutate Cloudflare. The explicitly confirmed backup/restore/migration commands are separate production actions and remain fail-closed behind exact target and evidence checks.

## Release artifacts

Start from these non-secret templates:

- `infra/environments/production.example.json`: intended production resource and hostname names. Copy to `infra/environments/production.json` only after the production account and resource plan are approved.
- `infra/release/production-evidence.example.json`: checklist schema. Keep the completed file at `.wrangler/release/production-evidence.json`; do not add customer IDs, credentials or secret values.
- `infra/release/pilot-smoke.production.example.json`: GET-only production smoke plan. Keep the completed plan private when it identifies pilot hostnames.

Completed manifests are written with mode `0600` under `.wrangler/releases/<release-id>/` and must not be committed.

## Frontend-only production operator lane

`production_frontend_only_v1` is a narrow, one-release operator lane for the reviewed landing-page change. It does not waive or fabricate the normal backup, pilot, PayOS, Telegram, fulfillment or custom-domain evidence. It is admitted only when the exact release diff is limited to the checked-in frontend/release-tooling allowlist and all normal runtime surfaces remain unchanged.

The lane is bound in code to:

- Baseline commit `3838b4724936ae1f9cafbd0df53a51a9adb3124b`.
- Rollback Worker version `6ca9c890-ed04-44dc-ac32-44b36881f2dc`.
- Mode `production_frontend_only_v1` and a clean, non-merge reviewed HEAD/tree/diff fingerprint.

Start from `infra/release/production-frontend-only-evidence.example.json`. Store the completed evidence at `.wrangler/release/production-frontend-only-evidence.json` and four mode-`0600` receipts at the exact paths named by the template. The automated admission checks each receipt's permissions, content hash, `schemaVersion: 1`, exact mode/release/commit/tree identity, `section` name and `passed: true`. An operator must also review the section-specific fields before execution: full quality gates, desktop/mobile/200%-zoom browser checks, axe/console/page-error results, visual acceptance and the exact-commit security scan with zero open HIGH/CRITICAL findings.

The source qualifier rejects deletes, renames, copies, mode changes, symlinks, submodules and every path outside its explicit allowlist. In particular it rejects `migrations/**`, `wrangler.jsonc`, lockfiles/dependency changes, API/commerce/tenant/runtime files, routes, DNS and Cloudflare resource configuration. `package.json` may differ from the baseline only by the two reviewed release-tooling script entries.

Plan locally before any Cloudflare access:

```bash
npm run release:production:frontend-only -- --env production --mode plan --json
```

Upload requires separate short-lived credentials: `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` for read-only account/Worker/D1/route/domain/queue/cron/version inventory, and `CLOUDFLARE_RELEASE_WORKER_API_TOKEN` for Workers Scripts Edit only. Do not grant route, DNS, D1 write, queue write, domain write or account-wide edit permissions to the edit token.

```bash
npm run release:production:frontend-only -- \
  --env production --mode upload --execute --confirm-production --json
```

Upload rebuilds without operator credentials, stages the generated complete module graph immutably, and invokes only `wrangler versions upload --strict`. It paginates the Worker Versions API rather than relying on Wrangler's 10-version display window, then proves that the D1 migration ledger and full live inventory are unchanged except for exactly one inactive candidate. It requires the rollback and candidate version views to have identical non-ASSETS bindings, handlers, named handlers, compatibility date/flags, limits, exports, migration tag and usage model. The private result is `.wrangler/releases/<release-id>/frontend-only-upload.json`.

Activation invokes only `wrangler versions deploy <candidate>@100%`, repeats inventory and D1-ledger checks, runs fixed GET-only smoke checks for `/`, `/pricing`, `/login`, API health and the resolvable storefront rejection path `/products/frontend-release-invalid` (404), then repeats them after a minimum 15-minute monitor window:

```bash
npm run release:production:frontend-only -- \
  --env production --mode activate --execute --confirm-production --json
```

Failures before the activation sink return without mutating production. From the moment candidate activation is invoked, every activation, propagation, smoke, monitor, inventory or ledger failure sends the exact rollback version at 100% unconditionally, then uses fresh inventory and D1-ledger reads to verify restoration; a failed or ambiguous rollback verification remains a fail-closed operator incident. Explicit `--mode rollback` is available only when the admitted candidate is active and its receipt, provenance, runtime parity, inventory and ledger checks still pass. Neither path changes D1, routes, DNS, Worker Domains, queues, cron, KV, R2 or secrets. Revoke both temporary tokens and remove token-bearing temporary files after the final receipt is captured.

## Historical first-production bootstrap ceremony (retired)

This section records the original first-production ceremony for audit history only. It is not the current production runbook: production now has live apex/wildcard Worker routes and rollback version `6ca9c890-ed04-44dc-ac32-44b36881f2dc`. Do not run these bootstrap commands for the frontend-only release.

At the time of first bootstrap, the Worker could not honestly provide a previous version. The retired flow therefore used a separate, fail-closed three-phase ceremony instead of putting a fabricated rollback version into the normal release evidence:

1. `resources`: admit the exact account, zone, Git commit/tree, staging traffic inventory, production names and secret names; plan only create/reuse actions for the eight named production resources.
2. `canary`: require the reconciled resource manifest, a fresh empty-D1 baseline backup/bookmark, a successful isolated restore drill and the exact forward-only migration list before the first Worker version may bind only `canary.selinow.com`.
3. `promote`: require accepted canary smoke and monitoring evidence before the route-only shared-zone handoff may move the production apex and platform wildcard to the accepted Worker version while preserving exact staging exceptions and the existing `*/* -> selinow-com-staging` fallback. This release uses platform-only routing: it does not claim an external custom-domain cutover or Turnstile admission, and it does not add or mutate a Worker Domain. Before the first stable version exists, rollback means restoring the private pre-bootstrap traffic inventory, not naming a nonexistent previous Worker version. After successful promotion, the first stable version becomes the rollback baseline for normal releases.

Start from these additional non-secret templates:

- `infra/release/production-bootstrap-inventory.example.json`: normalized read-only account, zone, resource, Worker Route and Worker Domain inventory. Store the completed snapshot at `.wrangler/bootstrap/production-inventory.json`.
- `infra/release/production-bootstrap-evidence.example.json`: private ceremony evidence. Store it at `.wrangler/bootstrap/production-evidence.json` and change `phase` as the ceremony advances.
- A private JSON array containing Worker secret names only. Never put secret values, `NAME=value` entries or provider credentials in this file.

The default command is a local dry-run planner. It performs no network request and no Cloudflare mutation:

```bash
npm run release:production:bootstrap -- --phase resources --secret-names .wrangler/bootstrap/production-secret-names.json --json
```

Writing the private mode-`0600` admitted plan requires both confirmations. The command reloads Git/spec/evidence/inventory and requires an identical final fingerprint immediately before writing:

```bash
npm run release:production:bootstrap -- \
  --phase resources \
  --secret-names .wrangler/bootstrap/production-secret-names.json \
  --write \
  --confirm-production \
  --confirm-first-production-bootstrap \
  --json
```

Repeat for `canary` only after baseline backup/restore and forward-only migration evidence are complete. Repeat for `promote` only after canary acceptance. These plan artifacts authorize only the mutation class named in `safeguards.allowedMutations`; they do not authorize DNS, payment, Telegram, secret-value, database down-migration or unrelated resource changes.

### First-production migration execution

After the named production resources exist, create the protected production report-v2 backup and isolated restore evidence. Then use the dedicated migration executor below. It validates the exact `infra/environments/production.json`, generated `infra/generated/production.json` resource manifest, production `PLATFORM_DB` binding, clean reviewed Git commit/tree, name-only secret inventory and the fresh backup artifact before it asks Wrangler to apply the ordered repository migration set:

The migration sink requires `CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN`; the isolated empty-baseline drill separately requires `CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN`. Neither may be replaced with the application runtime secret `CLOUDFLARE_API_TOKEN` or a general operator token, and each child Wrangler environment receives only its dedicated value.

```bash
npm run release:production:bootstrap:migrate -- \
  --env production \
  --secret-names .wrangler/bootstrap/production-secret-names.json \
  --confirm-production \
  --confirm-first-production-bootstrap \
  --execute \
  --json
```

The command performs an account-pinned `whoami`, verifies the exact generated D1/KV/R2/queue inventory, runs only `d1 migrations apply PLATFORM_DB --remote --env production`, then repeats the complete identity check. It never reads secret values, requires no regular release manifest or previous Worker version, and contains no Worker deploy, route, DNS, seed, payment or Telegram sink. Use the default dry-run first:

```bash
npm run release:production:bootstrap:migrate -- --env production --dry-run --json
```

If backup, generated-manifest, Git, account, D1, migration-ledger or confirmation evidence changes between checks, the command stops before Wrangler. Record the migration completion timestamp and exact applied ledger in the private bootstrap evidence before moving to the canary phase.

### First-production Worker canary

The first production Worker canary uses `npm run release:production:canary`. It is deliberately separate from the normal deploy path: **do not use `wrangler deploy --env production` for the first canary** because it can publish the script and configured routes/triggers as one broad operation. Do not use `wrangler triggers deploy` or a bulk Worker Routes `PUT` either; both can replace unrelated routes, schedules or queue consumers in the shared account/zone.

The command must receive the reviewed `canary-plan.json` produced by `npm run release:production:bootstrap -- --phase canary`; its fingerprints bind the ceremony to the exact clean source tree, production spec, saved inventory and allowed mutation classes (`production_candidate_worker_version` plus `production_canary_worker_route`). A plan that authorizes a Worker Domain or a different route class is rejected.

Keep three temporary, least-privilege operator tokens separate from the runtime Worker secret named `CLOUDFLARE_API_TOKEN`:

| Environment variable | Required permission and use |
| --- | --- |
| `CLOUDFLARE_CANARY_AUDIT_API_TOKEN` | Read-only access to account identity, D1 inventory, production Worker secret names, routes, Worker Domains, schedules, versions, deployments and queue consumers. It is used for fresh admission and post-action verification only. |
| `CLOUDFLARE_CANARY_WORKER_API_TOKEN` | Workers Scripts edit access for the approved production account/Worker. It is mapped to Wrangler only for `versions upload` and `versions deploy`. |
| `CLOUDFLARE_CANARY_ROUTE_API_TOKEN` | Workers Routes edit access limited to the `selinow.com` zone. It is used only to create the exact canary route and delete the captured route ID during rollback. |

Do not combine these into one broad token, store them in repository files or pass them to the application build. The command strips all Cloudflare/operator tokens from the build environment and emits safe error codes rather than token values. The audit phase only reads queue consumers and cron schedules; this ceremony never creates, updates or removes either trigger type.

Before upload, the private bootstrap evidence must be in phase `canary`, name the exact clean reviewed commit/tree, record the fresh backup and restore drill, and list the complete forward-only migration ledger. The live inventory must match the reviewed account, zone, D1 UUID/name, Worker and saved route/domain snapshot; the production Worker must have every required secret name and must have no existing route, Worker Domain, cron schedule or queue consumer.

Upload a route-neutral candidate with a unique reviewed tag:

```bash
npm run release:production:canary -- \
  --env production \
  --mode upload \
  --plan .wrangler/bootstrap/<ceremony-id>/canary-plan.json \
  --tag bootstrap-<release-id> \
  --execute \
  --confirm-production \
  --confirm-first-production-bootstrap \
  --json
```

The upload phase builds without operator credentials and invokes only `wrangler versions upload --env production --strict`; it never invokes `wrangler deploy`, writes a route or changes triggers. It then requires exactly one new Worker version, treats that version's `metadata.has_preview` value as informational, verifies the live Worker subdomain configuration remains `enabled=false` and `previews_enabled=false`, inspects the candidate bindings and proves that routes, Worker Domains, deployments, queue consumers and cron schedules did not drift. The private report is written mode `0600` at `.wrangler/bootstrap/<ceremony-id>/canary-upload.json`. Record its `candidateVersionId` as `candidateWorkerVersion` in the private bootstrap evidence before apply.

Apply the candidate only from that exact upload report:

```bash
npm run release:production:canary -- \
  --env production \
  --mode apply \
  --plan .wrangler/bootstrap/<ceremony-id>/canary-plan.json \
  --upload-report .wrangler/bootstrap/<ceremony-id>/canary-upload.json \
  --execute \
  --confirm-production \
  --confirm-first-production-bootstrap \
  --json
```

Apply first performs a read-only public DNS admission for the exact `canary.selinow.com` hostname. The hostname must resolve to at least one address and every returned A/AAAA address must be in Cloudflare's published anycast ranges; an empty answer, non-Cloudflare answer or resolver failure stops before the candidate deploy. The live inventory also reads the production Worker's subdomain configuration and requires both `enabled=false` and `previews_enabled=false`; this is the authoritative preview gate because Wrangler version metadata `has_preview` is informational and may remain true when the Worker subdomain is disabled. The DNS and subdomain checks are repeated after candidate deployment immediately before the route mutation, so drift fails closed and triggers the existing compensation path. Apply then runs `wrangler versions deploy <candidate-version>@100%`, verifies that the captured route/domain/subdomain/queue/cron inventory is unchanged, and only then creates exactly `canary.selinow.com/* -> selinow-com-production` with a single route `POST`. It does not add a Worker Custom Domain and does not hand off `selinow.com`, `*.selinow.com` or `*/*`. The captured route ID, control version, DNS admission addresses and before/after route snapshots are stored at `.wrangler/bootstrap/<ceremony-id>/canary-applied.json`.

If canary acceptance fails, rollback from the captured state rather than rediscovering or guessing a route ID:

```bash
npm run release:production:canary -- \
  --env production \
  --mode rollback \
  --plan .wrangler/bootstrap/<ceremony-id>/canary-plan.json \
  --state .wrangler/bootstrap/<ceremony-id>/canary-applied.json \
  --execute \
  --confirm-production \
  --confirm-first-production-bootstrap \
  --json
```

Rollback verifies that the candidate, disabled Worker subdomain and exact post-apply route snapshot are still active, deletes only the captured canary route ID, verifies the original routes and disabled subdomain state are restored, and then deploys the exact captured control version at 100%. The final private report is `.wrangler/bootstrap/<ceremony-id>/canary-rollback.json`. Any route, version, domain, subdomain, queue or cron drift fails closed for operator review; the tool never repairs drift with a full route replacement.

Worker rollback does **not** roll back D1. Production migrations remain forward-only: fix forward when possible, or follow the separately approved backup/isolated-restore and controlled database cutover procedure. Never run a down migration as part of canary rollback.

### First-production platform route promotion

Stable promotion is a separate route-only ceremony. It consumes the reviewed `promote-plan.json`, the post-canary traffic snapshot used to fingerprint that plan, the exact `canary-applied.json` state, the complete repository migration ledger, and a private acceptance record based on the accepted candidate version and monitoring acknowledgements. The acceptance record must use schema `promotion_acceptance`, repeat the evidence file's candidate/smoke/accepted-at values, pin the canary-state hash, and include separate alert and dashboard evidence references. The checked-in shape is shown at `infra/release/production-promotion-acceptance.example.json`.

First capture the normalized post-canary inventory at the exact private path used for the plan, then preview and write the fingerprint-bound promotion plan:

```bash
npm run release:production:bootstrap -- \
  --phase promote \
  --inventory .wrangler/bootstrap/<ceremony-id>/promote-inventory.json \
  --secret-names .wrangler/bootstrap/production-secret-names.json \
  --json

npm run release:production:bootstrap -- \
  --phase promote \
  --inventory .wrangler/bootstrap/<ceremony-id>/promote-inventory.json \
  --secret-names .wrangler/bootstrap/production-secret-names.json \
  --write \
  --confirm-production \
  --confirm-first-production-bootstrap \
  --json
```

The write command produces `.wrangler/bootstrap/<ceremony-id>/promote-plan.json`. Do not substitute the pre-canary resource inventory: the executor requires the exact post-canary route/domain/trigger snapshot whose fingerprint is stored in this plan.

`--phase promote` is pinned to `infra/release/production-promotion-staging.json`. That checked-in release contract must remain an exact derivation of `infra/environments/staging.json` with only `sharedZoneDisabledRoutes` changed to an empty array. Both the planner and executor verify this relationship before admission and reject a `--staging-spec` override that differs from the canonical promotion contract. Do not remove the apex/wildcard guards from the normal staging spec: staging doctor, preflight, provisioning and deploy continue to require them.

The executor recomputes cutover blockers, requires a fresh live route/domain/trigger inventory to match the saved canary state, and rejects every route pattern outside `buildProductionRouteHandoff`. In the current platform-only mode, the initial `*/*` route must already point to `selinow-com-staging`; the executor fails closed on fallback drift and leaves that route untouched. It changes only the production apex and platform wildcard to `selinow-com-production` while preserving the exact staging exceptions. Creates use one-route `POST`, replacements use ID-bound per-route `PUT`, and deletions use captured-ID `DELETE`; it never sends a zone-wide Worker Routes replacement and never changes Worker Domains, DNS, queues, cron, versions, secrets or D1:

Use separate temporary tokens for this route-only ceremony:

| Environment variable | Required permission and use |
| --- | --- |
| `CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN` | Read-only access to the approved production account, D1, Worker routes/domains, active versions/deployments, queue consumers and cron schedules. It is stripped to the minimal inventory environment and never authorizes a mutation. |
| `CLOUDFLARE_PRODUCTION_PROMOTION_ROUTE_API_TOKEN` | Workers Routes edit access limited to the `selinow.com` zone. It is used only for exact approved per-route `POST` creates, ID-bound `PUT` replacements, and captured-route-ID `DELETE` operations during apply, compensation or rollback. |

Neither token is a Worker secret, neither is passed to a build, and neither may be replaced with the runtime `CLOUDFLARE_API_TOKEN`, a canary token or a broad general-purpose operator token.

```bash
npm run release:production:promote -- \
  --env production \
  --mode apply \
  --plan .wrangler/bootstrap/<ceremony-id>/promote-plan.json \
  --traffic-snapshot .wrangler/bootstrap/<ceremony-id>/promote-inventory.json \
  --canary-state .wrangler/bootstrap/<ceremony-id>/canary-applied.json \
  --acceptance .wrangler/bootstrap/<ceremony-id>/promotion-acceptance.json \
  --execute \
  --confirm-production \
  --confirm-first-production-bootstrap \
  --json
```

The default mode is a read-only plan against a supplied saved live inventory (`--inventory`). On mutation, each route is re-inventoried before and after the explicit create/update/delete, route IDs and scripts are captured in `promotion-applied.json`, and any failure triggers compensating reverse operations. A successful compensation restores the exact route pattern/script matrix and preserves unaffected route IDs. Cloudflare does not expose a transaction for the complete multi-route handoff, and a deleted canary route cannot be recreated with its original ID, so the executor fails closed on ambiguous or unverifiable responses and requires operator review. The captured state can be explicitly reversed with `--mode rollback` and `--state .../promotion-applied.json`.

### Empty-baseline restore drill

When the first production D1 contains only Cloudflare metadata and an empty migration ledger, the regular restore drill is intentionally inapplicable because it expects application tables. Use the dedicated empty-baseline drill instead. It validates the production spec, generated D1/account identity and fresh report-v2 backup artifact, checks the live source is still empty, creates one generated temporary D1, imports the protected export, verifies application-table absence, an empty migration ledger, SQLite integrity and foreign-key health, then re-proves the exact temporary name+UUID before the name-based Wrangler delete and verifies both are absent afterward. A create timeout is reconciled through bounded D1 relists so an uncertain temporary target is not silently orphaned. The private mode-`0600` report records metadata and safe error codes only; it never records provider bookmarks, credentials or exported SQL:

```bash
npm run release:production:bootstrap:empty-baseline -- \
  --env production \
  --confirm-production \
  --confirm-first-production-bootstrap \
  --execute \
  --json
```

Use the default network-free plan before any execution:

```bash
npm run release:production:bootstrap:empty-baseline -- --env production --dry-run --json
```

The command has no migration, Worker deploy, route, DNS, seed, payment or Telegram sink. Do not run it with a staging target or a regular non-empty restore artifact.

### Historical pre-promotion blockers

Before the completed platform route promotion, the planner allowed resource and canary preparation while listing stable-cutover blockers, and `promote` failed closed while any blocker remained. These notes describe that historical state; they do not override the live-inventory requirements of the current frontend-only lane.

For that platform-only promotion, the active blockers were the production apex/wildcard route guards, canary acceptance and the other explicit route-plan/evidence checks. The external-host inventory and Turnstile lifecycle items below remain mandatory gates for a future external-domain cutover, but are intentionally not represented as platform traffic admission.

- Cloudflare Routes take precedence over Worker Custom Domains. Before promotion, null guards (`selinow.com/*` and `*.selinow.com/*`) bypassed production Custom Domains and blocked stable apex/platform-wildcard traffic. They did not block the exact `canary.selinow.com/*` override, which was more specific and was the only route authorized during canary.
- The checked-in staging `*/*` route intentionally sends otherwise unmatched external custom domains to `selinow-com-staging`. The current platform-only handoff is: `selinow.com/*` and `*.selinow.com/*` point to `selinow-com-production`; exact in-zone staging exceptions (`staging.selinow.com/*`, `app-staging.selinow.com/*`, `api-staging.selinow.com/*`, and `*.staging.selinow.com/*`) point to `selinow-com-staging`; and `*/*` remains on `selinow-com-staging`. External custom-domain traffic therefore remains on staging. Because Worker route patterns must belong to the zone, a future external cutover still requires a fresh inventory proving that no external staging custom hostname is active, or a separate staging zone/dispatcher; that pending inventory is not silently treated as production admission in this platform-only release.
- The canary phase used the exact `canary.selinow.com/* -> selinow-com-production` override while the old null wildcard was still present; the override was removed only after the production wildcard became active.
- The production Turnstile widget is authorized for `selinow.com`, which covers its subdomains. Turnstile does not support wildcard hostnames; every external custom hostname must be admitted explicitly before activation (or the account must use Enterprise Any Hostname). The current application has no runtime hostname-admission lifecycle evidence, so external custom-domain checkout remains blocked and no external-domain activation is claimed by the platform-only handoff.

Do not remove these blockers by broadening a shared-zone wildcard without the exact in-zone staging exceptions, routing an external staging hostname through production, or disabling Turnstile. Keep the platform-only route contracts explicit, and before any future external-domain cutover capture a fresh read-only external-host inventory, rerun staging acceptance and add tenant-routing/Turnstile lifecycle evidence. The route handoff is documented in `buildProductionRouteHandoff`; it is a plan-only helper and performs no Cloudflare mutation.

## 1. Prepare

The doctor reads local files only. It reports required names and pass/fail state, never configuration or secret values.

Provide the names returned by the Worker secret inventory, not their values:

```bash
SELINOW_WORKER_SECRET_NAMES="SESSION_SECRET,MAGIC_LINK_SECRET,CREDENTIAL_KEK_V1,INVENTORY_KEK_V1,EXPORT_KEK_V1,IDENTIFIER_HMAC_SECRET,TURNSTILE_SECRET_KEY,CLOUDFLARE_API_TOKEN" npm run release:doctor -- --json
```

The command above is the current `v1` baseline, not a permanent rotation list. Before release, compare the inventory with the configured active credential and inventory key versions and with every version still referenced by D1 rows. Include `CREDENTIAL_KEK_V2` or `INVENTORY_KEK_V2` whenever `v2` is active or still referenced, and retain the old key name until the controlled rotation scan and backup-retention checks prove it can be retired. Private export objects currently remain `EXPORT_KEY_VERSION=v1` and require `EXPORT_KEK_V1`.

The production doctor must fail while `infra/environments/production.json`, production bindings, backup evidence or acceptance evidence are missing. Do not bypass a missing name by putting a placeholder into `wrangler.jsonc`.

Preview the complete production dry-run sequence without executing commands:

```bash
npm run release:production:plan -- --json
```

Run the safe local production dry-run wrapper only after the doctor passes:

```bash
npm run release:production:dry-run
```

It runs check, lint, tests, build, backup/restore plans, database status/preflight plans and Wrangler deploy dry-run. It does not apply migrations or deploy.

## 2. Backup prerequisite

Before any production migration or release mutation, record all of the following in the private evidence file:

- A successful production D1 export report reference created within 24 hours.
- A Cloudflare D1 time-travel bookmark recorded at backup time.
- A successful isolated restore-drill report completed within 30 days.
- The current Worker version used as the rollback target.

The doctor checks metadata and freshness only. It does not read the exported database, print a bookmark or contact Cloudflare.

Production mutation remains a separate operator-controlled procedure. The release owner must verify the exact database target before invoking any remote backup, migration or deploy command.

## 3. Normal release candidate and manifest

Keep `candidateWorkerVersion` and `candidateUpload` set to `null` while collecting the other release evidence. Validate the route-neutral candidate plan without network access:

```bash
npm run release:candidate -- --env production --json
```

The live upload requires a read-only route/script/D1 audit token and a separate Worker Scripts edit token. The audit token is pinned to every identity/version read and the edit token is pinned only to upload/activation; neither subprocess may fall back to OAuth or inherit the other token. The workflow builds with both credentials removed, rechecks the live account/D1/route/domain/deployment inventory, fingerprints `wrangler.jsonc` plus every built `dist` file immediately before and after the sink, invokes only `wrangler versions upload --strict`, requires exactly one new version, validates the complete fetch/queue/scheduled handler and binding contract, seals Wrangler upload provenance, and proves that the active deployment is still the recorded rollback version:

```bash
CLOUDFLARE_ROUTE_AUDIT_API_TOKEN=... \
CLOUDFLARE_RELEASE_WORKER_API_TOKEN=... \
npm run release:candidate -- --env production --execute --confirm-production --json
```

On success it writes `.wrangler/releases/<release-id>/candidate-upload.json` and advances the private evidence with the captured UUID and report fingerprint. It never runs `wrangler deploy`, activates a version, or mutates routes, domains, queues, schedules, D1, KV or R2.

### Release manifest and rollback matrix

Validate evidence without writing artifacts:

```bash
npm run release:manifest -- --json
```

Write the private manifest and rollback matrix only after every prerequisite passes:

```bash
npm run release:manifest -- --write --json
```

The manifest records the reviewed commit, previous/candidate Worker versions, candidate upload report fingerprint, migration filenames, config fingerprint, quality gates, backup timestamps and the count of pilot shops. It excludes credentials, bookmark values, customer identifiers and exported data.

Before a real Worker activation, temporarily provide the same read-only audit token and the separate `CLOUDFLARE_RELEASE_WORKER_API_TOKEN`. Both pre-activation admissions require the live version to remain exactly the rollback version, fetch the exact candidate from Cloudflare, and revalidate its bindings, handlers, upload annotations, report identity and local artifact fingerprint. It then activates only `<candidateWorkerVersion>@100%` through the repository-pinned no-install Wrangler helper; normal production release tooling never calls broad `wrangler deploy` or an install-capable `npx`. A final read-only admission must observe that exact candidate as active while the route/domain contract remains unchanged. Production dry-runs remain offline and do not require either token.

```bash
npm run deploy -- --env production --confirm-production \
  --release-manifest .wrangler/releases/<release-id>/release-manifest.json
```

## 4. Controlled pilot

The automated pilot runner is deliberately GET-only. Without `--execute` it validates and prints the plan without network access:

```bash
npm run release:pilot:smoke -- --plan .wrangler/release/pilot-smoke.production.json --json
```

Network execution requires both explicit flags:

```bash
npm run release:pilot:smoke -- --plan .wrangler/release/pilot-smoke.production.json --execute --confirm-production --json
```

The plan must contain two distinct pilot storefront hosts. URLs must use HTTPS and cannot contain credentials, query parameters, fragments or order access tokens. Responses are bounded and bodies are never printed.

The following acceptance remains manual and controlled; the runner never performs it:

- One low-value website checkout confirmed by a real signed PayOS event.
- Telegram checkout using the same inventory/order/payment/fulfillment state.
- Duplicate webhook/update replay proving no duplicate fulfillment.
- One external custom domain completing hostname, SSL and DNS readiness.
- Cross-shop verification showing pilot shop A cannot read or mutate pilot shop B.

Record only boolean evidence and private report references in the release evidence file.

## 5. Rollback decision matrix

| Signal | Immediate containment | Strategy | Verification |
| --- | --- | --- | --- |
| Worker errors or latency regression | Stop rollout | Restore previous Worker version | Health, storefront, dashboard and webhook smoke |
| D1 schema/data integrity regression | Stop writes and pilot traffic | Fix forward, or restore to an isolated database before controlled cutover; never run a down migration | Integrity, foreign keys, counts and tenant isolation |
| Payment or fulfillment correctness failure | Disable new checkout and pause fulfillment workers | Restore previous Worker version and review payment exceptions | Signed-event dedupe, inventory and fulfillment reconciliation |
| Telegram/provider webhook degradation | Pause affected integration jobs | Restore previous Worker or provider-specific fix forward | Secret validation, replay handling, queues and private-chat checks |
| Custom-domain misroute/certificate failure | Switch affected shop to platform subdomain and purge cache | Revert canonical mapping without broad DNS mutation | Hostname, SSL, DNS and tenant routing |
| Queue/DLQ growth | Pause consumers if retries amplify | Restore previous Worker, then bounded replay | Queue age, retries, DLQ and side-effect idempotency |

Rollback authority and support ownership must be named before the change window starts. If data restoration or DNS mutation is required, stop and obtain explicit production approval for that separate destructive or externally visible action.

## Completion gate

Phase 10 is not complete until:

- Staging acceptance for the candidate migrations and Worker version is recorded.
- The production doctor and reviewed release manifest pass for the exact candidate commit and rollback Worker version.
- A production D1 export/bookmark is less than 24 hours old and the isolated restore-drill evidence is less than 30 days old.
- Two isolated pilot shops pass.
- Website and Telegram share inventory and fulfillment correctly.
- A real signed PayOS event completes the payment-to-key path.
- Cloudflare Email Sending delivery and its tested acknowledgement path are active without exposing magic-link tokens.
- Custom-domain live acceptance passes.
- No critical or high security issue remains open.
- Monitoring and budget alerts have tested acknowledgement paths.
- Release, data, payment, integration, domain, rollback and support ownership are active for the change window.
- Required product, support and legal-policy approvals are recorded outside source control without customer or credential data.
