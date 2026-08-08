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

For production, use the same command with `--env production` only inside an owner-approved mutation window after backup and migration verification. The command emits safe result codes only. It does not print credentials, session values, tokens, or provider secrets. It cannot add a second admin; later admin management requires a separately reviewed authenticated workflow.

Require the execution result code `first_platform_admin_created`, then sign in again and verify the protected admin boundary through the application. If the command returns `platform_admin_bootstrap_exact_empty_state_required`, stop: do not delete or rewrite either the admin row or the receipt. Recheck the exact environment, candidate identity and current counts through an approved read-only operator process, then investigate any partial or pre-existing state as an incident before another attempt.
