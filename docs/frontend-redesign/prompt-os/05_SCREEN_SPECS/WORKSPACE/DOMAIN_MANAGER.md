# Domain manager

## Purpose

Giải thích rõ platform subdomain và lifecycle custom domain.

## Layout

Standard address panel + custom domain lifecycle rail + DNS instruction + impact actions.

## Exact hierarchy

Platform subdomain: active automatically, no DNS.
Custom lifecycle: ownership → hostname → DNS → SSL → primary → routing.
DNS: type, name, value, copy feedback, last checked, `Kiểm tra lại`.
Primary/delete actions include impact and confirmation.


## Mandatory states

empty, requested, waiting user DNS, validating, waiting provider SSL, active, degraded, failed, removing, removed, forbidden, plan limited.

## Mobile 390px

One column. Lifecycle vertical. DNS values wrap safely and copy button remains reachable.

## Acceptance criteria

- Prefer custom subdomain guidance.
- Warn for unsupported apex.
- Do not promise one-click.
- Hostname uniqueness/authority server-side.
