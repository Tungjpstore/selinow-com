# STAGING_MUTATION_REVIEW_PACKAGE

## Phase 5 read-only execution update (2026-08-04)

Current decision: `staging_execution_blocked`. Read-only commands were attempted,
but no timestamped private report/checksum/reference was retained, so their
account/resource, migration-status, and database-preflight observations are not
accepted as evidence. Complete route/custom-domain/SaaS inventory and direct
manifest-grade identity/ledger capture also remain blocked by absent scoped audit
token contexts. Gate B was not granted, so no backup, restore, manifest,
migration, deploy, provider action, or pilot action occurred. See
`docs/PHASE_5_REVIEW_PACKAGE_R0.md`.

## Phase 4 review update (2026-08-04)

Current decision: `local_ready_remote_blocked` for candidate
`bff69f9d26a04b1318fd9862afa6eaffb8c003f4` (tree
`c5c52c0b7ed9f174b65fb5969b3f5beeaa4c386`). No explicit staging
mutation approval was supplied for P4, so no remote command was executed.

The mutation contract now requires a live ledger that is an exact ordered prefix
before staging migration, and a complete ledger plus passing preflight before
staging seed. The same private schema-3 release manifest, candidate-bound
backup/restore evidence, account ID, D1 name/UUID, clean commit/tree, and final
rechecks remain mandatory for migration, seed, and deploy. The full external
entry checklist and monitoring evidence contract are in
`docs/PHASE_4_STAGING_ACCEPTANCE.md`; missing approval, owner, acknowledgement,
credential, backup/restore, OAuth disposition, previous Worker version, provider
readiness, or observation window fails closed.

Status: `prepared_only` — approval required before any remote mutation.

## Decision requested

Review and approve or reject the exact staging migration/deploy window for the
clean Phase 4 pilot candidate. This document is a package template until all
fields are filled from fresh read-only evidence and a private staging release
manifest is generated from the final clean HEAD. It does not authorize execution.

## Reviewed candidate

- Historical Phase 2 runtime commit: `ec50cde50c1ecdc8264a07c3261e2962c7e568d6`
- Historical Phase 2 runtime tree: `a35e2c871d2db97b392910fb04f51b7aaa27313c`
- Historical P3 local implementation candidate:
  `ec66a7a909319ac0a4b5b4b8c777836e636e56a5`; execution uses the P4 candidate
  above and never substitutes an historical commit.
- Baseline commit: `4d3081a03a320ea84fdf66c31cf22e97f041a386`
- Source migration ledger: current candidate `0001`-`0080`
- Exact P4 changed-file manifest and local verification:
  `docs/PHASE_4_REVIEW_PACKAGE_R0.md`
- Candidate-bound local restore report:
  `.wrangler/restore-drills/local/rdr_20260804091903_1127db4c1b34.json`
- Execution identity: generated, not hand-copied. `release:staging:manifest`
  binds the final clean commit/tree, full source ledger, non-empty observed
  baseline, staging D1 identity, and exact backup/restore fingerprints after
  fresh evidence exists. The manifest
  is schema version `3`, private, and ignored under
  `.wrangler/releases/staging/<release-id>/release-manifest.json`.

## Remote identity

- Cloudflare account: `TBD from read-only admission`
- Zone: `selinow.com`
- Worker: `selinow-com-staging`
- D1 name/UUID: `TBD from platform:doctor output`
- R2/KV/Queue resources: `TBD from manifest and live inventory`
- Routes/domains: `TBD from route preflight and doctor`
- Confirmation: no production resources, routes, domains, queues, or secrets

## Migration and backup

- Historical remote ledger note: `0028` (not re-verified for P4)
- Exact pending range: captured as a non-empty ordered prefix in the private
  schema-3 manifest; no current staging ledger is claimed until fresh read-only
  evidence exists
- Backup command: repository `backup:create` guarded script, exact env only
- Backup evidence: report-v2, non-empty artifact, checksum, bookmark, freshness
  <= 60 minutes, exact account/D1 identity
- Restore drill: isolated disposable target from the exact reviewed tree and
  complete `0001`-`0080` ledger; integrity/FK/schema/count checks required;
  every non-local drill requires `--reviewed-commit`
- Pre-`0066` OAuth pending-row policy: revoke/expire or explicitly resolve
- Dodo `0070`-`0079` and activation timestamp migration `0080`: local
  source/tests are recorded in R2; remote cutover review remains `TBD`

## Commands after approval

Use only repository guarded scripts and the exact reviewed environment:

1. Recheck account, D1, routes, domains, queues, cron and private `MEDIA`.
2. Create and verify the protected staging backup.
3. Run the isolated restore drill bound to the exact clean commit:
   `npm run restore:drill -- --env staging --reviewed-commit "$(git rev-parse HEAD)" --json`.
4. Generate the private manifest only after the fresh backup and restore pass:
   `npm run release:staging:manifest -- --write --json`.
5. Apply the exact forward-only range derived from the manifest-bound baseline with
   `npm run db:migrate -- --env staging --release-manifest <manifest-ref>`.
6. Verify ledger, preflight, integrity/FK checks and supported smoke paths. Real
   staging deploy repeats the complete ordered ledger and database preflight both
   before and after build and fails before Wrangler on drift.
7. Deploy with
   `npm run deploy:staging -- --release-manifest <manifest-ref>`.
8. Run public/auth browser gates and controlled PayOS/Telegram UAT.

Staging seed, if separately approved and actually required, uses the same
`--release-manifest`; never seed implicitly as part of migration or deploy.
Migration, seed, and deploy admissions revalidate the clean commit/tree,
migration ledger, exact D1 identity, backup artifact checksum/size/freshness,
restore integrity/FK/ledger, and unchanged evidence immediately before Wrangler.

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

Local command results, restore report, test counts, prior browser evidence and
dry-run artifacts are recorded in `docs/PHASE_4_REVIEW_PACKAGE_R0.md`; the Phase
3 package remains historical.
Remote URLs, timestamps, checksums, account/D1 identity and protected backup
reports remain `TBD`. No package is accepted until the exact committed candidate
and fresh remote admission evidence are recorded.

## Approval gate

Stop here and obtain written owner/reviewer approval before backup, migration,
seed, deploy, provider registration, route/DNS changes, or secret mutation.
