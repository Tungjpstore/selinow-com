# Production Continuation Gate Audit

Status: `NO-GO` (`prepared_only`, historical observation). This is a non-secret,
read-only audit for the tree observed on 2026-08-09; it is not current-candidate
release evidence and does not authorize a
Cloudflare, D1, DNS, Worker, queue, cron, provider, or secret mutation.

## Release identity

- Historical reviewed source tree: commit `1eab0f62c5a338884d2f9a48d85c660d07c22259`.
- Historical reviewed Git tree: `66b753e5b245dbb915d28e14ab8d4ba605e21430`.
- Current source migration chain: contiguous `0001` through `0094` (94 files).
- Production Worker expected by source: `selinow-com-production`.
- Production D1 expected by source: `selinow-production`, UUID
  `75102e37-45f6-40ed-a32a-9e700fd184db`.
- Cloudflare account/zone expected by source: account
  `ef250a88911fd24073cb73d1c07e0218`, zone `selinow.com`.

## Live Cloudflare observation

The authenticated Cloudflare dashboard was inspected without reading cookies,
browser storage, or secret values.

| Surface | Observed state | Gate |
| --- | --- | --- |
| Worker | `selinow-com-production`; dashboard overview showed `app.selinow.com`, 9 bindings, Workers Logs enabled at 100% sampling, Traces disabled, no export destination and no Tail Worker. Latest visible deployment was only the short prefix `f8cee1ef` (about 5 hours old); no full version ID was captured. | **Blocked** until a candidate-bound full version/deployment inventory is captured. |
| Zone routes | Exactly seven routes were visible: `*/*`, `selinow.com/*`, and `*.selinow.com/*` -> `selinow-com-production`; `staging.selinow.com/*`, `*.staging.selinow.com/*`, `api-staging.selinow.com/*`, and `app-staging.selinow.com/*` -> `selinow-com-staging`. | **Pass** for route shape; still require post-candidate recheck. |
| Worker bindings | Production overview/bindings showed D1 `selinow-production`; queue producer bindings `selinow-integration-production` and `selinow-notification-production`; R2 buckets `selinow-media-production` and `selinow-private-exports-production`; KV namespaces for cache and session; assets and email bindings. | **Blocked**: producer bindings do not prove consumers. |
| Trigger events | The overview reported `Queues 0`; Worker settings displayed the trigger-events section with only `Add` and no cron row. The latest retained Cloudflare trigger inventory also records empty consumer arrays for integration, notification, and DLQ queues, plus `schedules: []`. | **Blocked**: source requires three queue consumers and cron `*/15 * * * *`; current evidence proves they are absent. |
| Public health | `https://selinow.com/api/health`, `https://app.selinow.com/api/health`, and `https://api.selinow.com/api/health` returned HTTP 200 JSON with `phase: 6`, Website/Telegram channels, and `principal-channel-canonical-v1`. | **Blocked**: this is an older production runtime, not the phase-10 staging candidate. |

## D1 and backup evidence

The last checked-in production export remains the authoritative local evidence
available to this audit. The SQL contains exactly 52 `d1_migrations` rows and
ends at `0052_generated_license_request_hardening.sql`. This is not a live
query and must not be treated as current remote proof.

- Latest retained production backup: `.wrangler/backups/production/bkp_20260804113931_e87d7ee5bfa1/` (completed 2026-08-04; source ledger through `0052`).
- Latest retained passed isolated restore: `.wrangler/restore-drills/production/rdr_20260804114401_67010b1e6913.json` (reviewed commit `72248cc...`; isolated verification through `0080`, not the current `0094` tree).
- A fresh production backup and isolated restore bound to the current clean HEAD do not exist.
- A live remote migration-ledger query was not performed because no dedicated
  read/migration token was available to the audit session; no production D1
  mutation was attempted.

**Schema gate: blocked.** Before applying any continuation migration, capture a
fresh protected production backup, run the isolated restore drill against the
exact reviewed tree, query the live ledger, verify integrity/FK/preflight, and
bind all reports to one release manifest. The first irreversible sink is the
forward-only application of `0053` through `0097` via the guarded migration
executor.

## Production Worker names and secret admission

Dashboard names observed (values were not read):

`CLOUDFLARE_API_TOKEN`, `CREDENTIAL_KEK_V1`, `DODO_PAYMENTS_API_KEY`,
`EXPORT_KEK_V1`, `IDENTIFIER_HMAC_SECRET`, `INVENTORY_KEK_V1`,
`MAGIC_LINK_SECRET`, `SESSION_SECRET`, `TURNSTILE_SECRET_KEY`.

The release contract additionally requires `DODO_PAYMENTS_WEBHOOK_KEY` and
the plaintext `TURNSTILE_SITE_KEY` variable. The webhook secret name was not
observed on the production Worker, so canonical Dodo webhook handling cannot
be admitted for production. PayOS controlled staging fingerprinting remains a
staging-only gate and is not production evidence.

Required short-lived operator variables and scopes are defined by
`docs/PRODUCTION_RELEASE.md`:

| Variable | Scope/use |
| --- | --- |
| `CLOUDFLARE_D1_API_TOKEN` | Short-lived least-privilege D1 token for normal continuation backup/restore/migration; mapped to `CLOUDFLARE_API_TOKEN` only inside the child Wrangler process. |
| `CLOUDFLARE_WORKER_DEPLOY_API_TOKEN` | Dedicated Workers Scripts token for the normal Worker deploy sink only. |
| `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` | Read-only route/domain/account inventory admission only. |
| `CLOUDFLARE_PRODUCTION_BOOTSTRAP_MIGRATION_API_TOKEN` | Historical first-bootstrap D1 migration access only; never reuse for continuation. |
| `CLOUDFLARE_PRODUCTION_EMPTY_BASELINE_API_TOKEN` | Separate, historical empty-baseline bootstrap/restore path only; never reuse for continuation. |
| `CLOUDFLARE_PRODUCTION_PROMOTION_AUDIT_API_TOKEN` | Read-only account/D1/Worker/routes/domains/versions/deployments/queues/cron inventory. |
| `CLOUDFLARE_PRODUCTION_PROMOTION_ROUTE_API_TOKEN` | Workers Routes edit limited to the `selinow.com` zone for exact ID-bound route operations. |
| `CLOUDFLARE_CANARY_AUDIT_API_TOKEN` | Read-only canary admission inventory. |
| `CLOUDFLARE_CANARY_WORKER_API_TOKEN` | Workers Scripts upload/deploy for the approved candidate only. |
| `CLOUDFLARE_CANARY_ROUTE_API_TOKEN` | Workers Routes edit limited to the `selinow.com` zone for the canary route only. |

These operator tokens must be short-lived, kept outside the repository/build,
and revoked after their specific ceremony. The runtime Worker secret named
`CLOUDFLARE_API_TOKEN` is never operator input. No token values are recorded here.

## Monitoring, budget, and rollback gates

- Worker Logs are enabled, but Traces, exports, and Tail Worker are disabled;
  no dashboard evidence was captured for D1, inventory, payment/provider,
  queue/DLQ, domain, security, or budget alerts.
- The production route/health observation is not a substitute for 5-minute,
  15-minute, 1-hour, and next-day watch records.
- Rollback requires a full candidate Worker version ID, captured route IDs,
  current trigger inventory, fresh production backup, and a forward-fix or
  controlled restore plan. None is bound to the current tree.

## Exact continuation sequence

1. Obtain named owner approval and create the dedicated least-privilege
   operator tokens listed above; do not use runtime secrets or broad tokens.
2. Capture account, zone, D1 UUID/name, Worker, routes, domains, queues,
   consumers, cron, and secret names immediately before mutation.
3. Create a fresh protected production backup and an isolated restore drill
   bound to the full reviewed commit `$(git rev-parse HEAD)`; query the live migration ledger and run D1
   integrity/preflight checks.
4. If and only if the evidence is accepted, apply `0053`-`0094` forward-only,
   then verify the complete ledger and restore evidence again.
5. Complete provider handoff/UAT and owner approvals separately; do not infer
   Dodo/PayOS acceptance from route, secret-name, or health checks.
6. Upload/deploy the candidate Worker through the guarded release path, verify
   the exact full version ID, trigger inventory, seven-route contract, health,
   and rollback state, then perform the required pilot/watch window.

## Decision

Production deployment and migration remain **NO-GO**. The exact next
irreversible action is not a Worker deploy or route change: it is the approved,
fresh production backup plus isolated restore/ledger admission required before
the forward-only `0053`-`0094` migration sink. Provider UAT, Dodo webhook secret
admission, PayOS acceptance, monitoring/budget ownership, and pilot evidence
remain independent blockers.
