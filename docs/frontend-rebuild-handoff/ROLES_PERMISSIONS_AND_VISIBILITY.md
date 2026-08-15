# Roles, permissions va visibility

## Seller roles

Source authority: `src/lib/tenants/policy.ts`. Active membership trong dung shop la dieu kien truoc moi capability.

| Capability | Owner | Manager | Support | Viewer | Vi du surface/action |
| --- | --- | --- | --- | --- | --- |
| `shop:read` | yes | yes | yes | yes | Dashboard, orders, customers, integrations projection |
| `shop:update` | yes | yes | no | no | Shop name/country/currency/locale, storefront draft |
| `team:manage` | yes | no | no | no | Owner member ledger plus invite/resend/revoke, role-change and suspension APIs; owner/self protection applies |
| `billing:manage` | yes | no | no | no | Owner billing projection plus audited plan-change/cancel request intents; provider settlement remains pending |
| `customers:manage` | yes | yes | no | no | Customer detail, allowlisted profile/status update, internal notes and irreversible note redaction |
| `catalog:manage` | yes | yes | no | no | Category/product/variant, inventory import |
| `checkout:create` | yes | yes | no | no | Controlled seller test order/onboarding |
| `automation:manage` | yes | yes | no | no | Automation read/control; domain task co fence rieng |
| `domains:manage` | yes | no | no | no | Custom domain create/check/primary/delete |
| `fulfillment:manage` | yes | yes | no | no | Seller manual fulfillment |
| `integrations:manage` | yes | yes | no | no | Telegram connect/health; provider configuration |
| `payments:manage` | yes | yes | no | no | PayOS connect/health, payment exceptions |

Luu y: `support` va `viewer` hien co cung capability server la `shop:read`; UI co the khac copy/intent nhung khong duoc cap mutation action. `manager` co `customers:manage` nhung khong co team, billing hoac domain management. Owner member and billing mutations remain source/local contracts with recent-auth, CSRF, idempotency, optimistic-version and audit fences; billing requests stay provider-pending until external settlement evidence exists.

## Platform admin roles

Source roles: `owner`, `risk`, `support`, active trong `platform_admins`.

| Action | Owner | Risk | Support |
| --- | --- | --- | --- |
| Doc shop directory safe projection | yes | yes | yes |
| Doc abuse reports/recent moderation | yes | yes | yes |
| Transition `received -> triaged` | yes | yes | yes |
| Investigate/dismiss/close abuse report | yes | yes | no |
| Suspend/restore shop or product | yes | yes | no |
| Doc active deletion/incident/DLQ/rotation | yes | yes | yes |
| Acknowledge/resolve incident | yes | yes | yes |
| Acknowledge/request-retry/resolve unlinked DLQ | yes | yes | yes |
| Replay linked generic delivery/event target | yes | yes | no |
| Set/release legal hold | yes | yes | no |
| Create/process encryption rotation | owner-only cho high-risk service boundary | no | no |

Frontend phai dung role projection de quyet dinh co render action hay khong, nhung backend van la authority cuoi. Khong co impersonation shortcut.

## Visibility rules

1. Khong render action neu role khong co capability, ngay ca khi API se tra 403.
2. Khong xoa thong tin trang thai can thiet chi vi user khong co mutation permission. Read-only user can biet vi sao he thong blocked/degraded neu projection cho phep.
3. Neu role lookup loi, render `permission_unavailable`/503; khong fallback ve role cu hoac owner.
4. Neu user khong co active membership, khong hien shop trong switcher va khong cho query `shop` ep chon tenant do.
5. Shop switch phai xoa order ID, filter, cursor va draft state cua shop cu.
6. Plan/feature/limit visibility phai den tu server. Khong hard-code so luong domain, product, member, order hay automation quota.
7. Suspended/archived shop van co the can projection van hanh theo endpoint, nhung checkout/publication/action phai theo server guard; UI khong tu mo khoa.

## Action policy cho component

Moi action component can nhan mot projection ro rang:

```ts
type ActionPolicy = {
  visible: boolean;
  enabled: boolean;
  reasonCode?: string;
  requiresRecentAuth?: boolean;
  requiresConfirmation?: boolean;
  expectedVersion?: number;
};
```

`visible=false` dung cho role/capability khong co. `visible=true, enabled=false` dung cho state blocked, plan-limited, provider-pending, stale version hoac readiness fail. Khong suy ra policy tu mau badge.

## Recent authentication

Sensitive action su dung `requireRecentAuth`, mac dinh phien dang nhap khong qua 15 phut. UI phai:

- giu input khong nhay cam neu server tra `recent_auth_required`;
- huong user dang nhap lai, khong loop retry;
- khong luu credential/secret form vao localStorage/sessionStorage;
- tao idempotency key moi sau khi payload thuc su thay doi, giu key cu khi retry cung payload.
