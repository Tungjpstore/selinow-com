# Platform Legal and Support Decision Checklist

Status: `owner_approved_for_publication` (V1 effective `2026-08-25`).

## V1 publication record

The owner supplied and approved the following identity details for the V1 policy package:

- Public name supplied: `Nguyễn Công Tùng`
- Address supplied: `Xóm Tân Mỹ, Vân Tụ, Nghệ An, Việt Nam`
- Tax identifier supplied: `040099014422`

These values are recorded as the owner's approved public policy inputs. The
owner is responsible for correcting them if the registration or tax record
changes.

The consolidated Vietnamese policy is in
[`docs/LEGAL_SUPPORT_POLICY_V1.md`](./LEGAL_SUPPORT_POLICY_V1.md). The owner has
approved the commercial defaults in that document and asked for publication.
Provider-specific checkout/invoice language remains conditional on what the
provider displays for the individual transaction.

This checklist records the decisions behind the published V1 policy. Future
changes must create a new policy version, effective date and release evidence.

## Required Decisions

| Decision | Required owner | Current state | Evidence required |
| --- | --- | --- | --- |
| Contracting legal entity and public business name | Product + legal | `owner_approved` | Owner-approved public policy identity |
| Registered address and tax identity | Legal + finance | `owner_approved` | Owner-approved public policy identity |
| Governing law and dispute forum | Legal | `owner_approved` | V1 Terms section |
| Digital goods, license key, and private-file refund rules | Product + legal | `owner_approved` | V1 refund section |
| Abuse, copyright, malware, and takedown handling | Legal + trust/safety | `owner_approved` | V1 abuse section |
| Seller responsibility for catalog, rights, taxes, and customer support | Product + legal | `owner_approved` | V1 Terms section |
| PayOS seller-owned settlement and platform responsibility boundary | Payments + legal | `owner_approved` | V1 provider boundary section |
| Dodo merchant-of-record, tax, invoice, and subscription responsibility | Billing + legal | `owner_approved` | V1 provider boundary section; checkout/invoice controls provider-specific facts |
| Privacy controller/processor roles and data-subject request handling | Legal + security | `owner_approved` | V1 privacy section |
| Data retention periods and deletion exceptions | Legal + security | `owner_approved` | V1 privacy section |
| Platform support contact and response guidance | Support owner | `owner_approved` | V1 support section; `tungbipdz@gmail.com` |
| Seller versus buyer support boundary | Support + product | `owner_approved` | V1 support matrix |

## Publication Gate

The V1 policy pages may be published because the owner has approved every
applicable decision and recorded the effective date. Provider-specific facts are
rendered conditionally and are never invented when a provider checkout/invoice
states a different role.

The V1 implementation provides:

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

The authenticated seller buyer-privacy endpoint can produce an allowlisted
export or perform guarded anonymization after active operational records are
settled. It is an internal tenant operation, not a published Selinow privacy
policy, public data-subject intake promise, deletion deadline, or statement
that legally retained financial and audit records will be erased.
