# Admin Sellers & Shops Context Plan

Updated: 2026-07-29

## Scope

Add the missing platform-admin shop directory without widening the existing
moderation or operations mutation contracts. The surface is read-only and is
intended for platform `owner`, `risk` and `support` roles.

## Source of truth

- Authorization: `platform_admins` through `getPlatformAdminRole()`.
- Shop identity/state: `shops`.
- Subscription/plan: latest `shop_subscriptions` row and `plans.code`.
- Seller coverage: active `shop_members` aggregate counts only.
- Catalog posture: active `products` aggregate count only.
- Channel posture: active/pending/degraded `channel_connections` counts only.

## Safe projection

The API returns only public shop ID, slug, display name, lifecycle state,
locale/currency, plan/state labels, aggregate counts and timestamps. It never
selects platform-user email/display name, internal shop ID, credential tables,
inventory key material, buyer identity/token, payment payload or provider
metadata.

## Query contract

- `GET /api/admin/shops` is private/no-store and role-guarded server-side.
- `q` is a bounded allowlist search over shop public ID, slug and name.
- `status` and `subscription` use explicit enum parsing.
- Results use an opaque updated-at/public-shop-ID cursor and a maximum page size of
  25 in the UI (50 hard service ceiling).
- No offset pagination or client-side filtering is used.

## UI states

The route covers authenticated, forbidden, role lookup failure, invalid filter,
D1 unavailable, empty and populated states. Mobile converts each row into a
labeled record list at the existing 320px/390px admin breakpoints. The page
offers no impersonation, suspend, restore or payment remediation shortcut.

## Acceptance

- The service rejects non-admin callers and invalid cursor/filter input.
- Search/filter/cursor results remain tenant-safe and deterministic for a static
  D1 snapshot.
- Focusable controls remain at least 44px high and use the existing dark admin
  design tokens.
- Security QA confirms no secret, token, credential, key, raw provider payload or
  plaintext PII appears in the projection or rendered page.
