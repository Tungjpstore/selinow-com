# Current Release Handoff - 2026-08-17

This is the non-secret handoff contract for the 2026-08-17 production release
on branch `dashboard-redesign-takeover`. It records the verified pre-release
production state and the remaining deploy prerequisites. It does not by itself
authorize a production migration, deployment, route or DNS mutation, provider
activation, pilot, or live charge; those remain fail-closed behind the
execution plan and the standard admission gates.

## Candidate identity

- Release date: 2026-08-17.
- Branch: `dashboard-redesign-takeover`.
- Deploy commit: `9caf835` (contains the source migration chain through and
  including `0105`; `0104_remediation_completion.sql` is committed at
  `5f4bc71` and registered in `scripts/lib/release.mjs`).
- Source migration ledger: contiguous `0001`-`0105`, ending at
  `0105_ops_platform_indexes.sql`.
- Release scope: dashboard redesign takeover, Console v2, marketing v5,
  storefront-template verticals, account security hardening, and the platform
  admin console ops upgrade (mandatory 2FA fail-closed, per-IP admin rate
  limiting, keyset pagination, ops overview, appeals terminal remediation).
- Supersedes: `docs/release/CURRENT_HANDOFF_2026-08-11.md` and the dated
  operational checklist in `docs/DEPLOY_HANDOFF_DASHBOARD_CONSOLE_2026-08-16.md`
  (now banner-marked SUPERSEDED).

Documentation changes made after this identity require a fresh clean commit
and, if release admission binds the documentation commit, a regenerated
manifest and deployment. The release owner must reject any commit, tree,
manifest, or Worker-version mismatch.

## Production state before release (read-only live checks, 2026-08-17)

- Production D1 ledger: applied through `0098`
  (`0098_auth_email_otp_system.sql`). Migrations `0099`-`0105` are unapplied
  (7 pending). `0100` has NEVER been applied remotely, so the earlier in-place
  edit concern for that migration is resolved; the full current `0100` applies
  cleanly.
- Production Worker: version `c18f5738`, deployed 2026-08-15. This version is
  the rollback baseline for this release.
- Route ownership: `selinow.com/*`, `*.selinow.com/*`, and `*/*` on
  `selinow-com-production`, with only the exact staging exceptions on
  `selinow-com-staging`. No route mutation is part of this release.

## Migration scope (`0099`-`0105`, forward-only)

1. `0099_account_security_hardening.sql` — `platform_users.two_factor_enabled*`,
   append-only `auth_login_history`, tenant-leading indexes.
2. `0100_automation_rule_builder.sql` — automation rule tables/columns/indexes
   (full final schema; never applied remotely).
3. `0101_storefront_media_assets.sql` — storefront media assets.
4. `0102_physical_goods_vertical.sql` — physical goods vertical.
5. `0103_appointment_booking_vertical.sql` — booking vertical.
6. `0104_remediation_completion.sql` — rebuilds `payment_remediation_requests`
   to unblock terminal `completed`/`failed` states while preserving the
   approval trail (committed `5f4bc71`; mandatory part of this release).
7. `0105_ops_platform_indexes.sql` — additive platform-leading indexes for
   cross-tenant admin listings.

Application order is `0099` → `0105` after a fresh protected production
backup and an isolated restore drill bound to the reviewed commit, per
`docs/PRODUCTION_RELEASE.md` (continuation migration admission).

## Deploy prerequisites

- **Mandatory platform-admin 2FA (fail-closed).** The candidate denies console
  and API access to any platform admin without `platform_users.two_factor_enabled=1`.
  BEFORE promoting to production, verify every active platform admin has
  completed 2FA enrollment; otherwise admins are locked out of the
  console/API (with an actionable enrollment hint). This is a hard gate.
- Clean checkout of `9caf835`; nothing uncommitted is deployed.
- Verification gate rerun on the exact commit: `npm run check`,
  `npm run lint`, `npm run test`, `npm run build`, `npm run deploy:dry-run`.
- Protected production backup/bookmark before any migration apply.

## Execution plan

The operational execution plan (checklist, smoke scenarios, rollback notes) is
`docs/DEPLOY_HANDOFF_DASHBOARD_CONSOLE_2026-08-16.md` (updated 2026-08-17:
commit `9caf835`, migrations `0099`-`0105`), governed by the fail-closed
ceremony in `docs/PRODUCTION_RELEASE.md`. The smoke-test sequence in section 6
of that handoff must be executed on production after deploy.

## Post-deploy evidence (placeholders — fill after deploy)

- Deployed Worker version UUID: `TODO post-deploy`.
- Post-migration D1 ledger confirmation (`0001`-`0105` applied): `TODO post-deploy`.
- Backup/bookmark reference for the pre-migration production snapshot: `TODO post-deploy`.
- Smoke-test results (handoff section 6 scenarios): `TODO post-deploy`.
- Final test total on the exact deployed commit: `TODO post-deploy`
  (current documentation keeps the `2,689+` placeholder until finalized; do not
  invent totals).
- 2FA enrollment confirmation for all active platform admins: `TODO post-deploy`.

Until those placeholders are filled with real evidence, this release must not
be described as complete, and no provider activation or payment-collection
capability is claimed by it.
