# ADR 0009: No-tech onboarding and automation boundary

## Status

Accepted

## Date

2026-07-26

## Context

Selinow serves sellers who may not understand DNS, webhooks, API tokens, command-line tools or secret management. Providers can still require account ownership, business review, OAuth consent, merchant agreements or an action in their own application. Claiming that these external decisions can always be removed would be misleading and unsafe.

The platform needs a consistent definition of full automation and a resumable workflow that does not hard-code Telegram and PayOS steps.

## Decision

- Define the product goal as zero technical configuration after required consent or ownership confirmation.
- A seller must never run a CLI, edit a Worker configuration, construct a webhook URL, handle a platform infrastructure token or diagnose a provider payload.
- Support two connection modes:
  - `managed`: Selinow owns or operates the provider resource and can provision a tenant binding automatically;
  - `bring_your_own`: the seller authorizes an existing provider resource, preferably through OAuth or an equivalent one-click grant.
- Treat copied credentials as a bounded fallback only when the provider offers no delegated authorization. Encrypt immediately, never redisplay and provide rotation and revocation.
- Represent onboarding as server-side tasks, not a fixed client-only wizard. Task states are `pending`, `running`, `waiting_user`, `waiting_provider`, `retryable`, `succeeded`, `failed` or `canceled`.
- Every task executor is idempotent, leased or version-guarded, auditable and safe to resume after refresh, Worker failure or provider timeout.
- Task manifests declare whether a step is automatic, requires consent, requires an external ownership action or is unsupported. The UI presents a safe action, deep link or exact record rather than provider jargon.
- Derive readiness from selected required capabilities and fresh provider evidence. Do not trust cached browser state or require Telegram-specific checks when Telegram is not selected.
- Offer an instant website/subdomain preview and controlled test mode before live payment or provider approval is complete. Test mode must not allocate real keys, create a real charge or mark an order paid.
- Measure time to first preview, time to live, completion without support and failure by safe blocking code.

## Trade-offs

- Managed connections reduce seller setup but increase platform responsibility for abuse, quotas, rate limits, branding and provider policy compliance.
- Bring-your-own connections preserve seller branding and account ownership but cannot eliminate provider consent or account review.
- A durable task engine adds schema and operational work compared with a linear form wizard.
- Some providers, including tenant-owned Telegram bots, do not expose an API that creates the external resource; full automation for those providers requires a managed shared resource or an honest external action.

## Consequences

- "100% automated" means Selinow performs every technical step it is authorized to perform, while clearly isolating irreducible legal, consent and ownership actions.
- Provider setup, webhook registration, capability discovery, health checks, retries and repair can share one orchestration model.
- Onboarding can add new connectors without adding another fixed database enum step.
- Managed shared channels require explicit tenant routing, per-shop rate limits, abuse controls and cross-tenant isolation tests before release.

## Revisit triggers

Revisit the managed-versus-bring-your-own default for each provider after measuring seller completion, provider approval time, support load, abuse rate, branding demand and per-tenant cost.
