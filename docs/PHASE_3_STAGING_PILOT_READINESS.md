# Phase 3 Staging Admission and Controlled Pilot Readiness

Status: `local_ready_remote_blocked` (2026-08-04, Asia/Tokyo)

This index records what is enforced by source and local tests for a future,
separately approved staging window. The detailed admission/monitoring contract is
`docs/PHASE_3_STAGING_READINESS.md`; the safe scorecard and scenario matrix are
`docs/PHASE_3_PILOT_SCORECARD.md`; review findings are in
`docs/PHASE_3_REVIEW_PACKAGE_R0.md`. None of these artifacts authorizes a backup,
migration, deploy, provider call, secret change, route change, or seller pilot.

## Admission contract

The staging path is fail-closed and candidate-bound:

```text
clean HEAD
  -> protected report-v2 backup
  -> exact-commit isolated restore drill
  -> manifest binding D1 identity + backup/restore fingerprints
  -> complete ordered migration ledger read
  -> database preflight read
  -> build
  -> repeat manifest/evidence/ledger/preflight reads
  -> deploy
```

The private manifest is schema version `2` and records only non-secret identity,
checksums, sizes, timestamps, opaque report references, and migration names. The
deploy gate rejects replacement backup/restore evidence, D1 target drift, an
incomplete ledger, or any failed preflight. The final read is repeated after the
build and before Wrangler is invoked.

## Pilot operating boundary

- Website is the only default sales lane; Telegram requires a separately approved
  dedicated bot and provider UAT.
- Pilot evidence may contain only opaque pilot IDs, safe request IDs, milestone
  codes, timestamps, reason codes, and private report references.
- A safe readiness test must not create an order, payment, reservation, or
  fulfillment record.
- Exact signed payment, duplicate replay, partial/overpaid/late/mismatched
  handling, inventory races, fulfillment replay, provider outage, stale
  readiness, shop-switch cleanup and billing response loss have mapped local
  regression coverage. Provider/seller outcomes, support ownership, rollback
  ownership and monitoring acknowledgement remain external observations.
- Unit economics remain variable-only until owner/provider evidence supplies fees,
  infrastructure allocation, support burden, conversion, churn, CAC, and policy.

## Evidence classes

| Class | Current state | Allowed claim |
| --- | --- | --- |
| Source authority | `implemented` | Current committed source and migrations are authoritative locally |
| Local evidence | `locally_verified` | Unit/static/build/dry-run checks and isolated restore only |
| Historical staging | `blocked` | Historical ledger through `0028`; not proof of this candidate |
| Historical production | `blocked` | Historical platform handoff through `0052`; not proof of this candidate |
| Providers/pilot | `blocked` | No provider acceptance, seller observation, or commercial result exists |

## Required external records

Before admission, the owner must provide a separately recorded approval, fresh
read-only account/route/D1 inventory, protected backup and restore reports,
pre-`0066` OAuth decision, named release/data/payment/integration/domain/support
owners, monitoring and budget acknowledgement paths, legal/support decisions,
and controlled Website-first seller acceptance. Secret values never belong in
this repository or in chat.

## Local artifacts

- `scripts/lib/staging-release.mjs` — schema-2 manifest, evidence binding, ledger,
  and preflight admission helpers.
- `scripts/deploy.mjs` — admission and repeat-before-Wrangler enforcement.
- `tests/unit/staging-release-admission.test.ts` — evidence replacement and
  complete-ledger/preflight regression coverage.
- `tests/unit/phase-3-pilot-artifacts.test.ts` — status, scorecard, evidence,
  scenario, monitoring and traceability contract coverage.
- `docs/PHASE_3_STAGING_READINESS.md` — thresholds, observation windows, owners,
  stop rules and rollback boundary.
- `docs/PHASE_3_PILOT_SCORECARD.md` — safe evidence schema and full scenario
  matrix; checked-in status remains `not_started`.
- `docs/PHASE_2_PILOT_PLAN.md` and `docs/PHASE_2_PILOT_EVIDENCE.example.json` —
  controlled pilot procedure and safe evidence shape.

## P3 review findings and disposition

- **P0:** none found.
- **P1:** the staging manifest did not bind the exact backup/restore/D1 evidence;
  fixed with schema version `2` and exact evidence revalidation.
- **P1:** a staging Worker deploy could be attempted before the full candidate
  ledger and data preflight were proven; fixed with before/after-build ledger and
  preflight gates.
- **P1:** the final dependency audit found vulnerable transitive `fast-uri` and
  `undici`; exact patch-level npm overrides now resolve `3.1.5` and `7.29.0`
  without downgrading Astro/Wrangler.
- **P2:** pilot/monitoring readiness lacked a complete scorecard, explicit
  thresholds/windows/owners/stop conditions and scenario traceability; the new
  Phase 3 artifacts and contract test close the local documentation gap.
- **P3:** no additional local/source finding remains open. Remote operations,
  provider acceptance, named people, configured alerts and commercial
  observations remain external blockers rather than fabricated evidence.

## Verification

- `npm run check`: 694 files, 0 errors, 3 existing hints.
- `npm run lint` and `npx tsc --noEmit`: passed.
- `npm run test`: 248 files / 1,773 tests passed.
- `npm run build`, `npm run build:staging`, `npm run deploy:dry-run`, and
  `npm run deploy:staging:dry-run`: passed; both deploy commands stopped at
  Wrangler dry-run and performed no deployment.
- `npm audit --audit-level=high`: 0 vulnerabilities after the lockfile update.
- Isolated local restore drill:
  `.wrangler/restore-drills/local/rdr_20260803190826_c9161ace0c4b.json`;
  integrity `ok`, zero FK violations, 614 restored items, exact cleanup.
- `git diff --check`: passed.
