# Production GO Audit - 2026-08-25

Status: **NO-GO**

This audit is a read-only release decision for the current candidate. It does
not authorize a Cloudflare, Dodo, PayOS, database, secret, route, DNS, pilot,
or payment mutation.

## Confirmed state

- Cloudflare account: `ef250a88911fd24073cb73d1c07e0218`, operator session
  observed as `tungbipdz@gmail.com`.
- Production D1 `selinow-production` is applied through
  `0112_google_auth_foundation.sql`; source migrations `0113`-`0119` are not
  applied in production.
- Staging D1 `selinow-staging` is applied through
  `0119_payos_provider_projection_lifecycle.sql`.
- Production Worker has a live historical version, but this candidate has no
  clean commit/tree, exact release manifest, candidate Worker upload, or
  candidate-bound rollback rehearsal.
- Dry-run backup, isolated restore, and production release planners pass.
  Dry-run output is planning evidence only and is not a backup or restore.

## Gate decision

| Gate | Decision | Missing authoritative proof |
| --- | --- | --- |
| Dodo subscription checkout | BLOCKED | Fresh exact-candidate staging manifest, signed runner proofs for all 32 scenarios, and provider/D1 binding |
| PayOS seller payment | BLOCKED | Controlled low-value transfer, valid signed webhook or tenant-correct reconciliation, idempotent fulfillment proof |
| Production backup | BLOCKED | Scoped D1 operator token, fresh protected report-v2 snapshot, provider bookmark, checksum, and exact target identity |
| Restore drill | BLOCKED | Candidate-bound isolated restore report with integrity, FK, schema, count, and ledger checks |
| Monitoring | BLOCKED | Named owners, dashboards, thresholds, destinations, test acknowledgements, and 5m/15m/1h/next-day records |
| Pilot | BLOCKED | Two real pilot shops, one controlled custom domain, signed payment acceptance, and private redacted scorecard |
| Rollback | BLOCKED | Clean schema-compatible rollback source, uploaded version, maintenance-drain evidence, live rehearsal, and smoke report |

## Required continuation order

1. Revoke the OAuth credential that was exposed in the terminal during this
   audit; issue short-lived scoped operator and runner credentials out of band.
2. Commit the reviewed candidate and generate a fresh staging manifest from the
   exact clean tree.
3. Execute genuine Dodo TEST and PayOS controlled UAT; retain only signed,
   redacted, reference-safe artifacts.
4. Create protected production backup and candidate-bound restore evidence.
5. Configure and test monitoring, run the two-shop pilot, then rehearse the
   exact rollback candidate.
6. Regenerate production evidence and require `npm run release:doctor -- --json`
   and closeout audit to return `ok: true` before any production promotion.

No provider, backup, monitoring, pilot, or rollback gate may be marked passed by
copying historical artifacts, dashboard screenshots, unsigned probes, or
synthetic JSON.
