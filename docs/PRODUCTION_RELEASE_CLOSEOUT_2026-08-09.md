# Production Release Closeout

This is an executable, non-secret closeout checklist for the production
candidate. It is intentionally separate from provider UAT and production
mutation procedures. A passing local check does not authorize a production
database migration, Worker deploy, route change, secret write, or payment
activation.

## Read-only audit

Run from the reviewed clean tree:

```bash
node scripts/release-closeout-audit.mjs --json
npm run release:doctor -- --json
```

`release-closeout-audit.mjs` reads only the Wrangler/spec/evidence files and
name-only Worker secret inventory. It reports the current Git identity, latest
staging manifest metadata, candidate drift, and every failed release-doctor
check grouped by the action that can close it. It never reads or prints secret
values, browser storage, provider payloads, customer identifiers, or database
exports.

The audit is expected to fail when `.wrangler/release/production-evidence.json`
has not been created. Do not make it pass with placeholders, old bootstrap
reports, synthetic webhooks, or local-only test output.

## Required closeout order

1. **Candidate identity**

   - Confirm a clean reviewed commit and tree (`git status --porcelain` is empty).
   - Deploy that exact commit to staging and create a fresh staging manifest.
   - Verify the staging manifest commit/tree, worker version, migration prefix,
     route inventory, health phase, and expiry all match the candidate.

2. **Quality and staging evidence**

   - Run `npm run check`, `npm run lint`, `npx tsc --noEmit`, `npm test`,
     `npm run build`, `npm run build:staging`, `npm audit --audit-level=high`,
     both deploy dry-runs, `npm run release:doctor -- --json`, and
     `git diff --check` sequentially.
   - Record command results in a private, release-bound evidence artifact.
   - Run staging migration/backup/restore admission and the relevant browser,
     route, health, domain, Website and Telegram smoke checks.
   - After migration (and any separately approved seed), create a newer,
     different staging backup, rerun the restore drill with the full reviewed
     commit, and run `npm run db:complete-release -- --env staging
     --release-manifest <manifest-ref> --json` before `deploy:staging`.

3. **Provider acceptance**

   - Run genuine Dodo TEST-mode and PayOS controlled-staging UAT using the
     provider dashboards and approved tenant-owner session.
   - Bind each redacted artifact to the same staging release ID, manifest hash,
     commit/tree and Worker version.
   - Synthetic signature probes and a `provider_pending` response are route
     evidence only; they cannot satisfy commerce acceptance.
   - Keep Telegram Mini App, WhatsApp, Discord, Zalo Mini App and Zalo OA
     deferred until real provider execution and acceptance exist.

4. **Production protection and operations**

   - Obtain data, payment, release, security and support owner approvals with
     private references.
   - Create a fresh protected production backup and provider bookmark, then run
     an isolated restore drill against the exact candidate tree.
   - Verify production secret names and install secret values only through the
     approved Cloudflare secret channel; never place values in evidence files.
   - Configure dashboards, error/latency/dead-letter alerts and budget alerts;
     record a fresh monitoring reference.
   - Complete the controlled pilot (at least two shops) and the manual Website,
     Telegram, signed-payment and custom-domain acceptance flows.

5. **Admission and mutation**

   - Create the production release evidence and run the closeout audit again.
   - Require `release:doctor` to return `ok: true` and the continuation-file
     admission to pass for the same commit/tree and migration ledger.
   - Bind a release manifest and rollback rehearsal to the candidate.
   - Before `release:manifest`, upload route-neutral candidate and rollback
     versions with `npm run release:worker:upload -- --role candidate --tag
     <candidate-tag> --execute --confirm-production --json` and
     `npm run release:worker:upload -- --role rollback --tag <rollback-tag>
     --source-root <clean-rollback-worktree> --execute --confirm-production
     --json`; record both full returned UUIDs. Then run
     `npm run release:rollback:rehearsal -- --write --json` and record its
     `evidenceRef`/`artifactSha256`. Deploy admission validates both Cloudflare
     version bindings.
   - Only after all approvals and provider/operations artifacts are accepted,
     execute the separately approved production migration and deploy ceremony.
   - Use a short-lived D1-capable `CLOUDFLARE_D1_API_TOKEN` for normal continuation
     (mapped to `CLOUDFLARE_API_TOKEN` only inside child Wrangler), read-only
     `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` for inventory admission, and dedicated
     `CLOUDFLARE_WORKER_DEPLOY_API_TOKEN` for the Worker deploy sink; the
     historical bootstrap migration token is never a continuation token and the
     runtime Worker secret is never operator input.
     The exact deploy command is
     `npm run deploy -- --env production --confirm-production --release-manifest <manifest-ref>`.
   - Recheck live routes, Worker version, health, queues, cron and tenant
     isolation after deployment; retain rollback references.

## Current audit interpretation

The current repository contains strong non-secret platform/staging artifacts,
but those artifacts are not production admission. In particular:

- A staging manifest exists under `.wrangler/releases/staging/`, but the latest
  recorded manifest is bound to the prior runtime commit until a fresh exact
  candidate deployment is performed.
- Existing production bootstrap smoke and empty-baseline restore reports are
  historical bootstrap evidence. They do not prove continuation migration,
  provider UAT, pilot, monitoring, or current-candidate rollback readiness.
- Missing owner approvals, genuine Dodo/PayOS acceptance, fresh production
  backup/restore, monitoring, pilot, manual acceptance, and production secret
  inventory must remain visible as blocked gates.

The only safe way to shorten this list is to produce the corresponding
auditable artifact through the real operator/provider workflow. Never edit the
doctor, evidence JSON, or release manifest to bypass an external gate.
