# Platform admin bootstrap

This command is only for creating the first platform owner after migrations through `0086_platform_admin_bootstrap_receipt.sql` are applied. It fails closed unless `platform_admins` and the one-time bootstrap receipt table are both empty, and the exact supplied user ID and normalized email identify one active platform user. Obtain both identity values from an approved operator record after that user has completed magic-link authentication; do not copy session cookies, magic-link URLs or database output into the ceremony record.

Dry-run checks command admission only and does not contact D1 or prove that the remote admin tables are empty:

```bash
npm run platform:admin-bootstrap -- --env staging --user-id <user-id> --user-email <normalized-email> --dry-run --json
```

Execution requires explicit confirmation:

```bash
npm run platform:admin-bootstrap -- --env staging --user-id <user-id> --user-email <normalized-email> --confirm-first-admin-bootstrap --json
```

Production dry-run still performs command admission only, but requires the separate production acknowledgement:

```bash
npm run platform:admin-bootstrap -- --env production --user-id <user-id> --user-email <normalized-email> --confirm-production --dry-run --json
```

Production execution additionally requires the canonical release manifest for the exact clean candidate:

```bash
npm run platform:admin-bootstrap -- --env production --user-id <user-id> --user-email <normalized-email> --confirm-production --confirm-first-admin-bootstrap --release-manifest <manifest-ref> --json
```

Run production execution only inside an owner-approved mutation window. Before the D1 mutation, the command reuses production migration admission to verify the manifest and clean candidate, exact Cloudflare account and D1 identity, fresh candidate-bound backup and isolated restore evidence, database preflight, and the complete source ledger. For this privileged ceremony, both backup and restore must be no more than 24 hours old and the restore must follow the admitted backup. It then independently requires the applied ledger to contain `0086_platform_admin_bootstrap_receipt.sql` and pins the admitted account at the Wrangler sink. The command emits safe result codes only; unexpected command output is collapsed to `platform_admin_bootstrap_failed`, while other production-admission failures collapse to `platform_admin_bootstrap_production_admission_failed`. It does not print credentials, session values, tokens, or provider secrets. It cannot add a second admin; later admin management requires a separately reviewed authenticated workflow.

Require the execution result code `first_platform_admin_created`, then sign in again and verify the protected admin boundary through the application. If the command returns `platform_admin_bootstrap_exact_empty_state_required`, stop: do not delete or rewrite either the admin row or the receipt. Recheck the exact environment, candidate identity and current counts through an approved read-only operator process, then investigate any partial or pre-existing state as an incident before another attempt.
