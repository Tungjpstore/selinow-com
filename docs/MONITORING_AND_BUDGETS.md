# Production Monitoring and Budgets

Complete this checklist before the Phase 10 change window. Every alert needs an owner, notification destination, threshold, evaluation window and tested acknowledgement path. Do not put API tokens, webhook secrets, customer identifiers or payload bodies into dashboards or notifications.

Current status (2026-08-02): **NO-GO** for full commerce/provider activation. The retained production alert/dashboard acknowledgements cover only the platform canary and route watchdog; service, D1, inventory, payment, provider, queue/DLQ, domain, security and budget evidence remains unchecked and must be completed for the current candidate.

## Service health

- [ ] Worker request volume, error rate, status family, CPU time and tail latency dashboard.
- [ ] Marketing, dashboard, API and representative storefront synthetic HTTPS checks.
- [ ] New release/version marker visible in redacted operational telemetry.
- [ ] Alert for sustained availability or latency regression with rollback owner assigned.
- [ ] Security-header and cache-policy smoke for public and private routes.

## D1 and data correctness

- [ ] D1 errors, query latency, reads, writes, storage and time-travel availability.
- [ ] Migration status and schema version visible without exposing row data.
- [ ] Inventory reservation age, unpaid-order expiry and fulfillment lag metrics.
- [ ] Payment exception count and oldest unresolved exception age.
- [ ] Backup recency and most recent isolated restore-drill result.

## Providers and background work

- [ ] PayOS signed webhook success/failure, reconciliation lag and mismatch categories.
- [ ] Telegram webhook rejection, provider 401/429, update replay and delivery retry metrics.
- [ ] Integration/notification queue depth, oldest message age, retries and DLQ growth.
- [ ] Custom-domain pending age, hostname/SSL/DNS failure and deletion retry metrics.
- [ ] Cloudflare Email Sending delivery success, bounce and provider-error metrics without recipient addresses.

## Security and abuse

- [ ] Authentication, CSRF, rate-limit, Turnstile and authorization-denial trends.
- [ ] Secret/key redaction canary test and alert pipeline verification.
- [ ] Platform/shop suspension activity and unusual admin action audit.
- [ ] Credential/key-version inventory showing active and retiring versions by count only.

## Budget controls

Set explicit warning and critical budgets for each billable service. Thresholds are an owner decision and must be recorded outside source control when they contain financial limits.

- [ ] Workers requests and CPU.
- [ ] D1 reads, writes, storage and backup/time-travel usage.
- [ ] R2 public media storage/operations and private export retention.
- [ ] KV reads, writes, lists and storage.
- [ ] Queue operations, retention and DLQ growth.
- [ ] Cloudflare for SaaS active custom hostnames and overage.
- [ ] Turnstile, Cloudflare Email Sending quota/overage and any external observability provider.
- [ ] PayOS/Telegram operational limits where provider dashboards expose them.

## Change-window watch

- [ ] Release owner, data owner, payment incident owner, integration incident owner and support owner are available.
- [ ] Dashboards and rollback matrix are open before deployment starts.
- [ ] Active watch at 5 minutes and 15 minutes after deployment.
- [ ] Stability review at 1 hour and next business day.
- [ ] A release is confirmed only after pilot traffic, queues, payment exceptions, domain readiness and budget alerts remain healthy.
