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

Production platform routing is live for the Selinow apex and wildcard surfaces after the platform-only handoff. External customer-domain traffic, Turnstile hostname admission and commerce/provider activation remain disabled pending their separate release gates; do not infer full production readiness from the route handoff.

## Production canary hostname

The exact production hostname `canary.selinow.com` is configured through `CANARY_HOSTNAME` and classifies as the public marketing surface. It does not enter storefront tenant resolution and does not grant access to seller or admin routes. Other subdomains continue through the normal reserved-platform or tenant-host rules; the canary behavior is not a suffix or wildcard match.

During first-production canary, the only approved route mutation is one exact `canary.selinow.com/* -> selinow-com-production` route. Live apply requires the exact hostname to resolve through the explicit public DNS-over-HTTPS resolvers used by the runner, with only Cloudflare anycast A/AAAA answers, before candidate deployment and checks it again immediately before the route `POST`; missing, malformed, non-public or non-Cloudflare DNS fails closed without creating DNS. The guarded runbook deploys the reviewed Worker version first, creates that route with one `POST`, reconciles the live route inventory if the API response is ambiguous, records the live route ID, and removes only that ID on rollback before restoring the captured control version. Queue consumers and cron schedules are inventory-only invariants throughout this workflow.

Do not use `wrangler deploy --env production`, `wrangler triggers deploy` or a bulk Worker Routes `PUT` for the first canary. Those operations can replace the shared-zone route/trigger contract and are outside the canary authorization boundary. See `docs/PRODUCTION_RELEASE.md` for the dedicated upload/apply/rollback commands and token separation.

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
| `selinow.com/*` | `selinow-com-production` |
| `*.selinow.com/*` | `selinow-com-production` |
| `staging.selinow.com/*` | `selinow-com-staging` |
| `app-staging.selinow.com/*` | `selinow-com-staging` |
| `api-staging.selinow.com/*` | `selinow-com-staging` |
| `*.staging.selinow.com/*` | `selinow-com-staging` |
| `*/*` | `selinow-com-production` |

The catch-all belongs to production so external Cloudflare for SaaS customer hostnames cannot fall through to the staging Worker. The exact staging host routes are required because a wildcard route does not match the bare `staging.selinow.com`, `app-staging.selinow.com` or `api-staging.selinow.com` hostnames. The seven named staging hostnames remain attached as Worker Custom Domains and their DNS records remain manual/operator-managed.

The staging environment specification validates the exact four staging-bound exceptions plus the three production-bound shared routes. Wrangler owns and regenerates the seven staging Worker Custom Domains plus `*.staging.selinow.com/*`; the exact shared-zone exceptions and production catch-all require a separately reviewed route handoff. `platform:doctor` and every non-dry staging deploy use a separate read-only `CLOUDFLARE_ROUTE_AUDIT_API_TOKEN` to require this seven-route inventory. A missing token, unreadable inventory or any drift fails closed before build and again immediately before Wrangler. Staging build-only and dry-run packaging remain offline. Any route change requires operator review because an incorrect broad route could intercept unrelated traffic.

### Production platform handoff matrix (historical baseline; revalidate before mutation)

The reviewed production platform-only handoff intentionally differs from the current staging inventory and was applied after this matrix was drafted. Cloudflare evaluates the most-specific route first; the historical handoff target was:

| Route | Worker |
| --- | --- |
| `selinow.com/*` | `selinow-com-production` |
| `*.selinow.com/*` | `selinow-com-production` |
| `staging.selinow.com/*` | `selinow-com-staging` |
| `app-staging.selinow.com/*` | `selinow-com-staging` |
| `api-staging.selinow.com/*` | `selinow-com-staging` |
| `*.staging.selinow.com/*` | `selinow-com-staging` |
| `*/*` | `selinow-com-staging` |

This was the initial handoff matrix. The three exact staging routes were later removed as redundant while their Worker Custom Domains remained active. The subsequent production handoff moved `*/*` to `selinow-com-production`; therefore this historical table must never be used as a rollback target or current route contract. The reviewed repair reapplied the three exact staging exceptions without changing DNS or Worker Custom Domains. Capture a fresh live inventory before every subsequent mutation.

The active fallback origin and deployed route matrix prove the shared-zone configuration exists. The accepted external customer-hostname lifecycle additionally proves staging resolution through `customers.selinow.com`, successful HTTPS, correct tenant rendering and removal that stops routing; it does not prove production external-host admission or Turnstile lifecycle. Every future route or SaaS-contract change must repeat the relevant checks rather than relying only on this baseline.

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
