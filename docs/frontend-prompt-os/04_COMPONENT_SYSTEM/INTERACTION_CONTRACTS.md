# Interaction contracts

- Retry buttons use operation/idempotency keys from existing API.
- Save state is explicit: saving, saved, failed, retry.
- Optimistic UI must roll back on authoritative failure.
- Copy actions show inline feedback for 2–3 seconds.
- Drawer/dialog cannot duplicate mutation on double click.
- Table row itself is not the only click target; provide a semantic link/action.
- Destructive controls are visually separated.
- External-action steps (BotFather, DNS, PayOS consent) say exactly what the user must do outside Selinow.
