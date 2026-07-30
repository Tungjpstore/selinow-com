# Seller login

## Purpose

Passwordless magic-link login.

## Layout

Centered single panel on light canvas. Brand mark above. Maximum form width 420px.

## Exact hierarchy

- Title: `Đăng nhập để tiếp tục`.
- Email field.
- Display name optional only when current flow requires it.
- Primary button: `Gửi liên kết đăng nhập`.
- Help link.
- No password field.


## Mandatory states

idle, submitting, sent, local debug link, rate-limited, invalid email, provider unavailable.

## Mobile 390px

Full-width panel with 20px gutter. Keyboard email input and visible status.

## Acceptance criteria

- Redirect to `/app` after valid login.
- Magic link status announced by live region.
- Page noindex/no-store.
