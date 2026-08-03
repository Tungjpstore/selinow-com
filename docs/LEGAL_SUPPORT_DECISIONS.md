# Platform Legal and Support Decision Checklist

Status: `legal_review_required` and not customer-facing.

This checklist records decisions that must be owned before Selinow publishes
platform legal pages or claims a public support commitment. It intentionally
contains no legal entity, address, jurisdiction, tax, refund, support email,
or service-level placeholders.

## Required Decisions

| Decision | Required owner | Current state | Evidence required |
| --- | --- | --- | --- |
| Contracting legal entity and public business name | Product + legal | `pending` | Approved entity record and public display name |
| Registered address and tax identity | Legal + finance | `pending` | Approved public disclosure and tax treatment |
| Governing law and dispute forum | Legal | `pending` | Counsel-approved Terms language |
| Digital goods, license key, and private-file refund rules | Product + legal | `pending` | Per-product and platform policy decision, including exceptions |
| Abuse, copyright, malware, and takedown handling | Legal + trust/safety | `pending` | Notice requirements, response authority, evidence retention, and seller notice rules |
| Seller responsibility for catalog, rights, taxes, and customer support | Product + legal | `pending` | Approved seller responsibility statement |
| PayOS seller-owned settlement and platform responsibility boundary | Payments + legal | `pending` | Approved settlement and payment-dispute wording |
| Dodo merchant-of-record, tax, invoice, and subscription responsibility | Billing + legal | `pending` | Provider-verified terms and approved customer copy |
| Privacy controller/processor roles and data-subject request handling | Legal + security | `pending` | Approved Privacy Policy and request workflow |
| Data retention periods and deletion exceptions | Legal + security | `pending` | Retention schedule covering orders, payment evidence, audit, abuse, and legal holds |
| Platform support contact and response guidance | Support owner | `pending` | Owner-approved contact route and safe response guidance |
| Seller versus buyer support boundary | Support + product | `pending` | Escalation matrix and order/payment request-ID guidance |

## Publication Gate

Do not publish platform Terms, Privacy, Acceptable Use, Digital Goods/Refund,
Abuse/Takedown, or Support pages until every applicable decision has an owner,
approved evidence, and a recorded effective date. Never render unresolved
values as customer-facing defaults.

After approval, the implementation should provide:

- Footer links from marketing pages.
- Terms and Privacy links from login.
- Seller/platform policy links at checkout where applicable.
- Abuse-report policy context next to the existing report form.
- Support guidance that asks for request IDs, never passwords, tokens,
  credentials, payment secrets, or license-key plaintext.

## Current Implemented Boundary

Seller storefronts may expose seller-owned support, Terms, Privacy, and refund
URLs when configured. The storefront abuse report form warns reporters not to
send passwords, tokens, license keys, or payment details. These seller-owned
surfaces do not substitute for Selinow platform policies or a named platform
support owner.
