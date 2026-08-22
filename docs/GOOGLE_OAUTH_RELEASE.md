# Google OAuth production release

Google sign-in uses the server-side Authorization Code flow with PKCE. D1 is
authoritative for one-use OAuth state and the Google-to-Selinow identity link.
Google access and refresh tokens are not persisted.

## Required configuration

- Google Cloud project: `selinow-auth`.
- Production callback: `https://app.selinow.com/api/auth/google/callback`.
- Worker secrets: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`.
- Worker variable: `GOOGLE_OAUTH_REDIRECT_URI` with the exact production callback.
- Existing `SESSION_SECRET`, `IDENTIFIER_HMAC_SECRET`, and credential KEK bindings.

Never place OAuth credentials in tracked Wrangler configuration, logs, release
evidence, queue payloads, or database rows.

## Release order

1. Capture the required protected production D1 backup/bookmark and release evidence.
2. Apply forward-only migration `0112_google_auth_foundation.sql`.
3. Run the post-migration object, column, trigger, and live-data invariant checks.
4. Confirm the required Worker secret names and exact redirect variable are present.
5. Deploy the Worker candidate.
6. Run staging browser acceptance for login, registration, explicit linking,
   account collision, cancellation, replay rejection, and enabled-2FA login.
7. In Google Auth Platform, verify branding, authorized domain, homepage, privacy
   policy, terms, support email, contact email, and all registered callbacks.
8. Publish the external consent application from `Testing` to `Production`.
9. Run a production canary with a dedicated test account before broad availability.

## Acceptance checks

- Login and registration with an unknown Google identity create one active
  platform user and one Google identity from the verified Google profile.
- A matching existing email is attached to that platform user atomically; a
  pending account is activated because Google has verified the email.
- Explicit linking remains available from account security for users who want
  to attach a Google identity after signing in with another method.
- Linking a Google identity already owned by another user fails closed.
- Replaying or moving a callback to another browser fails without a session.
- A user with 2FA receives no session until the email OTP succeeds.
- Cancellation revokes the one-use state and removes encrypted transient fields.
- D1 contains only the HMAC subject, never raw Google `sub` or provider tokens.

## Rollback

Rollback the Worker code to the previous candidate if the canary fails. Migration
`0112` is additive and remains applied; do not delete its tables or edit the applied
migration. Old code does not depend on the new objects, while the scheduled purge can
be restored with the Google-enabled Worker after the incident is resolved.

## Current external gate

Live signed-in Chrome inspection on 2026-08-22 confirms:

- Publication status is `External / Testing`.
- The production Web client has the exact production callback.
- `selinow.com` is an authorized domain.
- The test-user list is empty.
- Homepage, privacy-policy, terms-of-service, and logo fields are empty.
- The Data Access page lists no configured scopes.

Public launch is not complete. Owner-approved legal content and branding must exist
before those fields are transmitted to Google or the app is published. Then add a
dedicated test user, review the basic `openid email profile` scope set, complete the
staging matrix, publish deliberately, and run the production canary.
