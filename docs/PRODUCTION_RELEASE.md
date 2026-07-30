# Production Release

Phase 10 uses a prepare, backup, deploy, verify, confirm-or-rollback sequence. Repository tooling is fail-closed: production configuration, secret names, backup evidence, security status, monitoring ownership and pilot evidence must be complete before a release manifest can be written.

The repository currently provides readiness tooling and templates only. Phase 10 remains NO-GO and production remains untouched until every completion gate below has real evidence and the separate production mutation is explicitly approved.

The scripts in this document do not provision production resources, migrate a remote database, deploy a Worker, change DNS, create a payment or contact Telegram unless a later operator step explicitly authorizes that separate action.

## Release artifacts

Start from these non-secret templates:

- `infra/environments/production.example.json`: intended production resource and hostname names. Copy to `infra/environments/production.json` only after the production account and resource plan are approved.
- `infra/release/production-evidence.example.json`: checklist schema. Keep the completed file at `.wrangler/release/production-evidence.json`; do not add customer IDs, credentials or secret values.
- `infra/release/pilot-smoke.production.example.json`: GET-only production smoke plan. Keep the completed plan private when it identifies pilot hostnames.

Completed manifests are written with mode `0600` under `.wrangler/releases/<release-id>/` and must not be committed.

## First-production bootstrap ceremony

The first production Worker cannot honestly provide a previous Worker version. It therefore uses a separate, fail-closed three-phase ceremony instead of putting a fabricated rollback version into the normal release evidence:

1. `resources`: admit the exact account, zone, Git commit/tree, staging traffic inventory, production names and secret names; plan only create/reuse actions for the eight named production resources.
2. `canary`: require the reconciled resource manifest, a fresh empty-D1 baseline backup/bookmark, a successful isolated restore drill and the exact forward-only migration list before the first Worker version may bind only `canary.selinow.com`.
3. `promote`: require accepted canary smoke and monitoring evidence before any stable production Worker domain may be added. Before the first stable version exists, rollback means restoring the private pre-bootstrap traffic inventory, not naming a nonexistent previous Worker version. After successful promotion, the first stable version becomes the rollback baseline for normal releases.

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

### Current cutover blockers

The planner deliberately allows resource and canary preparation while listing stable-cutover blockers, but `promote` fails closed while any blocker remains:

- The checked-in staging contract keeps `*.selinow.com/*` as a null-script guard. A production configuration containing only `selinow.com`, `app.selinow.com` and `api.selinow.com` therefore does not serve tenant slug storefronts.
- The checked-in staging `*/*` route still sends otherwise unmatched external custom domains to the staging Worker. Production promotion requires a reviewed per-hostname production routing strategy and retirement/replacement of that global staging catch-all without losing the explicit staging hosts.
- The current Turnstile production hostname coverage is limited to `selinow.com` subdomains. External custom domains require an admitted enterprise hostname-management or tenant-scoped widget-key strategy before live checkout cutover.

Do not remove these blockers by broadening a shared-zone wildcard or disabling Turnstile. Update the staging and production route contracts together, capture a fresh read-only inventory, rerun staging acceptance and add tenant-routing/Turnstile regression evidence first.

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

## 3. Release manifest and rollback matrix

Validate evidence without writing artifacts:

```bash
npm run release:manifest -- --json
```

Write the private manifest and rollback matrix only after every prerequisite passes:

```bash
npm run release:manifest -- --write --json
```

The manifest records the reviewed commit, previous/candidate Worker versions, migration filenames, config fingerprint, quality gates, backup timestamps and the count of pilot shops. It excludes credentials, bookmark values, customer identifiers and exported data.

Before any real Worker deploy, temporarily provide the least-privilege `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN`. The deploy admission runs only read operations: account-pinned `wrangler whoami --json`, production D1 inventory, the shared-zone Worker Routes inventory and the account Worker Domains inventory. It requires the exact reviewed production account, D1 name+UUID, Worker name and domains while explicitly preserving the checked-in staging route/guard contract in the same `selinow.com` zone. It repeats the full gate after build, rejects target drift, strips the audit token from child environments and pins the final Wrangler process with the admitted `CLOUDFLARE_ACCOUNT_ID`. Production dry-runs remain offline and do not require this token.

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
