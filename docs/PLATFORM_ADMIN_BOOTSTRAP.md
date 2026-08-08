# Platform admin bootstrap

This command is only for creating the first platform owner after migrations are applied. It fails closed unless `platform_admins` and the one-time bootstrap receipt table are both empty, and the exact supplied user ID and normalized email identify one active platform user.

Dry-run validation does not contact D1:

```bash
npm run platform:admin-bootstrap -- --env staging --user-id <user-id> --user-email <normalized-email> --dry-run --json
```

Execution requires explicit confirmation:

```bash
npm run platform:admin-bootstrap -- --env staging --user-id <user-id> --user-email <normalized-email> --confirm-first-admin-bootstrap --json
```

For production, use the same command with `--env production` only inside an owner-approved mutation window after backup and migration verification. The command emits safe result codes only. It does not print credentials, session values, tokens, or provider secrets. It cannot add a second admin; later admin management requires a separately reviewed authenticated workflow.
