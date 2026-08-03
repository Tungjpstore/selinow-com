# STAGING_MUTATION_REVIEW_PACKAGE

Status: `prepared_only` — approval required before any remote mutation.

## Decision requested

Review and approve or reject the exact staging migration/deploy window for a
clean Phase 1 candidate. This document is a package template until all fields
are filled from fresh read-only evidence. It does not authorize execution.

## Reviewed candidate

- Commit/tree: `TBD after R1 clean review`
- Source migration ledger: current candidate `0001`-`0077`
- Exact changed-file manifest: `TBD`
- Local verification artifact paths: `TBD`

## Remote identity

- Cloudflare account: `TBD from read-only admission`
- Zone: `selinow.com`
- Worker: `selinow-com-staging`
- D1 name/UUID: `TBD from `platform:doctor``
- R2/KV/Queue resources: `TBD from manifest and live inventory`
- Routes/domains: `TBD from route preflight and doctor`
- Confirmation: no production resources, routes, domains, queues, or secrets

## Migration and backup

- Current remote ledger: `0028` unless fresh evidence proves otherwise
- Exact pending range: `0029`-`0077`
- Backup command: repository `backup:create` guarded script, exact env only
- Backup evidence: report-v2, non-empty artifact, checksum, bookmark, freshness
  <= 60 minutes, exact account/D1 identity
- Restore drill: isolated disposable target from the exact reviewed tree and
  complete `0001`-`0077` ledger; integrity/FK/schema/count checks required
- Pre-`0066` OAuth pending-row policy: revoke/expire or explicitly resolve
- Dodo `0070`-`0076` and activation analytics `0077` schema review: `TBD`

## Commands after approval

Use only repository guarded scripts and the exact reviewed environment:

1. Recheck account, D1, routes, domains, queues, cron and private `MEDIA`.
2. Create and verify the protected staging backup.
3. Run the isolated restore drill and record its artifact.
4. Apply forward-only migrations with `npm run db:migrate -- --env staging`.
5. Verify ledger, preflight, integrity/FK checks and supported smoke paths.
6. Deploy with `npm run deploy:staging` through its admission guard.
7. Run public/auth browser gates and controlled PayOS/Telegram UAT.

## Rollback/forward fix

- Runtime rollback: exact accepted staging Worker version only.
- Schema rollback: forward fix or approved restore from the fresh backup; never
  edit or delete an applied migration and never use ad-hoc remote SQL.
- Provider rollback: disconnect/disable through the owning service and preserve
  reference-only evidence.

## External requirements

Secret names only: `CLOUDFLARE_PLATFORM_API_TOKEN`,
`CLOUDFLARE_ROUTE_AUDIT_API_TOKEN`, staging Dodo webhook secret and any existing
repository-required provider secret names. Never record values here.

## Verification and evidence paths

All command results, URLs, timestamps, checksums and private reports: `TBD`.
No package is accepted until the exact candidate and evidence are recorded.

## Approval gate

Stop here and obtain written owner/reviewer approval before backup, migration,
seed, deploy, provider registration, route/DNS changes, or secret mutation.
