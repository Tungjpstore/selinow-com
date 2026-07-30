# Admin operations

## Purpose

Điều tra và xử lý high-risk platform events.

## Layout

Dark admin shell. Dense filters, queue/ledger, severity, scope, evidence, owner, action.

## Exact hierarchy

Navigation: Overview, Sellers & Shops, Abuse & Reports, Orders & Payments, Appeals/Refunds, Systems & Integrations, Audit Logs.
Rows show severity, entity, safe code, evidence reference, age, assignee, state.


## Mandatory states

loading, empty queue, degraded provider, incident, forbidden, recent-auth required, action pending, action failed.

## Mobile 390px

Use record list with severity and safe action. Do not expose raw payload or contact/key.

## Acceptance criteria

- CSRF, role, recent auth, idempotency.
- Destructive action separate and explicit.
- No secrets/raw provider payload.
