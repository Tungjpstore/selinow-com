# Frontend security contract

- Dashboard mutations include CSRF and existing auth context.
- Never render raw provider/database errors.
- Use stable safe error code and request ID.
- Clear secret input from DOM/UI state after successful submission.
- Do not prefill saved secret.
- Do not log request body containing credential, key, payment identity, or order token.
- Checkout/order/key/login/dashboard/admin use noindex/no-store according to route contract.
- Destructive actions use permission check, recent auth where required, impact copy, and confirmation.
- Storefront tenant resolution never accepts buyer-provided shop authority.
- Key reveal requires verified payment + completed fulfillment + valid access.
