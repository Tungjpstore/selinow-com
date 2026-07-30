# Domains

Platform storefronts use `{slug}.selinow.com` through wildcard routing. Paid custom domains use Cloudflare for SaaS and are not active until hostname, DNS and SSL checks pass.

## Current implementation status

Phase 6 platform routing is implemented and live on Selinow staging. Worker `selinow-com-staging` is deployed, the staging custom domains and wildcard TLS are active, and the current accepted deployment was observed at version `049009b4-9683-4c7f-8638-df859d50a0c8`:

- Platform hosts serve marketing/application surfaces instead of entering the tenant resolver.
- `{slug}.staging.selinow.com` resolves the seeded active shops; controlled draft, suspended and unknown hosts return their expected fail-closed states.
- Reserved and unknown storefront hostnames return 404 without falling back to another tenant.
- Public catalog cache keys include the normalized hostname and immutable domain incarnation; cart, checkout, order and key routes remain uncached. Mutable domain/published versions remain invalidation dimensions, not tenant identity.
- The `selinow-staging-storefront` Turnstile binding/secret and HTTPS certificate are active on staging; provider-backed checkout acceptance remains separate from the hostname smoke.

Phase 7 implementation and the shared-zone route matrix are accepted on staging. The `selinow.com` zone, Selinow-owned storage/queues, proxied wildcard DNS, fallback/CNAME records, Worker bindings/secrets and Cloudflare for SaaS fallback origin are provisioned. The external `selinow-lab.vnecs.store` lifecycle completed ownership verification, pending -> active hostname/SSL readiness, primary selection, HTTPS tenant rendering, platform-host redirect, deletion, fallback-primary restoration and authoritative DNS cleanup. Temporary acceptance resources were removed.

Production routing remains intentionally unchanged.

## Staging SaaS contract

| Item | Required value |
| --- | --- |
| Zone | `selinow.com` |
| Zone binding | `CLOUDFLARE_ZONE_ID` |
| Originless fallback DNS | Proxied `AAAA proxy-fallback.selinow.com -> 100::` |
| Friendly target DNS | Proxied `CNAME customers.selinow.com -> proxy-fallback.selinow.com` |
| Fallback origin | `proxy-fallback.selinow.com`, Cloudflare status `active` |
| Customer instruction | `shop.customer.example CNAME customers.selinow.com` |
| Runtime API secret | `CLOUDFLARE_API_TOKEN` as a least-privilege staging Worker secret |

`CLOUDFLARE_ZONE_ID` and `SAAS_CNAME_TARGET` are identifiers, not credentials, and are stored in staging `vars`. The API token must never be written to `wrangler.jsonc`, environment manifests, generated manifests, source, test fixtures with real values or command output.

Local configuration uses a zero zone ID and `customers.localhost`; local development must never call the live custom-hostname API.

## Provision and doctor behavior

The platform provisioner reads the desired SaaS records from `infra/environments/staging.json` and uses the Cloudflare v4 API only when an operator supplies a separate `CLOUDFLARE_PLATFORM_API_TOKEN` temporarily:

- Exact records and fallback origin are reused on repeated runs.
- Missing owned records are created.
- Drift on an owned record with the expected DNS type is reconciled.
- Multiple records or a different DNS type at either owned hostname fail closed for operator review.
- A fallback-origin update may be accepted while Cloudflare is still deploying it; `platform:doctor` remains failed until the reported status is `active`.
- Doctor verifies the staging Worker has a secret named `CLOUDFLARE_API_TOKEN`, but never reads or prints its value.

Recommended operator sequence:

```bash
# Supply the token through the shell prompt or an approved secret manager.
export CLOUDFLARE_PLATFORM_API_TOKEN
export CLOUDFLARE_ROUTE_AUDIT_API_TOKEN
npm run platform:provision -- --env staging --dry-run --json
npm run platform:provision -- --env staging --json
npm run platform:doctor -- --env staging --json
unset CLOUDFLARE_PLATFORM_API_TOKEN
unset CLOUDFLARE_ROUTE_AUDIT_API_TOKEN
```

The operator token scope should be restricted to the DNS and fallback-origin setup required for the `selinow.com` zone and should remain in an approved operator secret manager. Use a separate least-privilege custom-hostname token for the staging Worker:

```bash
wrangler secret put CLOUDFLARE_API_TOKEN --env staging
```

Do not pass either token as a Wrangler var, and do not reuse the broader operator token in the Worker.

## Worker routing safety

The deployed shared-zone configuration uses four explicit Worker routes:

| Route | Worker |
| --- | --- |
| `selinow.com/*` | Disabled |
| `*.selinow.com/*` | Disabled |
| `*.staging.selinow.com/*` | `selinow-com-staging` |
| `*/*` | `selinow-com-staging` |

Cloudflare applies the more specific disabled routes before the broad fallback route. This keeps the apex and normal platform subdomains out of the staging Worker while allowing arbitrary external custom hostnames to reach the Cloudflare for SaaS fallback. The disabled null-script guards were applied manually and verified against staging; production Worker resources and routes were not changed.

The staging environment specification validates the full reviewed contract. Wrangler owns and regenerates only the seven custom domains plus the active wildcard and `*/*` Worker routes; the two disabled null-script guards remain operator-managed because the Worker routes API does not accept them as script-owned routes. `platform:doctor` and every non-dry staging deploy now use a separate read-only `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` to require the exact two `script=null` guards and bind both `*.staging.selinow.com/*` and `*/*` to `selinow-com-staging`; a missing token, unreadable inventory or any drift fails closed before build and again immediately before Wrangler. Staging build-only and dry-run packaging remain offline. Any route change requires operator review because an incorrect broad route could intercept unrelated traffic.

The active fallback origin and deployed route matrix prove the shared-zone configuration exists. The accepted external customer-hostname lifecycle additionally proves resolution through `customers.selinow.com`, successful HTTPS, correct tenant rendering and removal that stops routing. Every future route or SaaS-contract change must repeat the relevant checks rather than relying only on this baseline.

## Customer readiness

A custom domain is ready only when all three conditions are true:

1. Cloudflare custom hostname status is `active`.
2. Cloudflare SSL status is `active`.
3. Customer DNS resolves to `SAAS_CNAME_TARGET`.

TLS success, fallback-origin status or a single successful provider poll is insufficient by itself. The platform subdomain remains available until the custom domain is fully ready and selected as primary.

## Seller lifecycle

- `POST /api/app/shops/{shopPublicId}/domains` normalizes and claims a hostname idempotently, then starts a leased provider check.
- `GET /api/app/shops/{shopPublicId}/domains` returns tenant-scoped DNS, hostname and SSL readiness plus the exact CNAME target.
- `POST /api/app/shops/{shopPublicId}/domains/{domainId}/checks` performs an owner-authorized leased retry.
- `PUT /api/app/shops/{shopPublicId}/domains/{domainId}/primary` atomically updates primary and canonical routing only after all readiness signals pass.
- `DELETE /api/app/shops/{shopPublicId}/domains/{domainId}` removes routing atomically, blocks while an active payment attempt depends on the domain and retries provider deletion through reconciliation.

All mutations require owner capability, recent authentication, JSON content type and CSRF. Provider checks persist only while holding the matching lease, so polling cannot reactivate a hostname after deletion begins.

Create and restore transitions use optimistic version compare-and-swap in addition to lease fencing. When a concurrent request commits first, the losing request re-reads and returns the current live domain instead of reporting a false conflict; transition audit is written only for the request that actually commits. Primary/canonical updates and domain deletion also re-check the current row version and active payment-origin dependency inside the guarded transition.

## Subscription downgrade policy

Existing custom domains enter a grace state when a shop loses the `customDomain` entitlement: routing and reconciliation may continue so active storefronts do not fail abruptly. The owner can still check or delete an existing domain, but cannot add a new custom domain or make a custom domain primary until entitlement is restored.
