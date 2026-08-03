# Phase 2 Unit Economics

Status: variable model only; actual cost and conversion inputs are not claimed

This model supports a controlled-pilot commercial decision. It does not change
prices in source and does not fill unknown costs with estimates presented as
facts.

## Inputs

| Variable | Meaning | Starter | Pro | Evidence/owner |
| --- | --- | ---: | ---: | --- |
| `P` | monthly price | 99,000 VND / 5 USD | 299,000 VND / 15 USD | Source catalog; provider/tax approval pending |
| `f_tx` | provider transaction fee rate | TBD | TBD | PayOS/Dodo merchant terms |
| `f_fixed` | provider fixed transaction fee | TBD | TBD | Provider terms |
| `c_cf` | Cloudflare allocation per seller/month | TBD | TBD | Owner finance decision |
| `c_email` | email sending allocation | TBD | TBD | Owner finance decision |
| `c_queue` | queue/worker execution allocation | TBD | TBD | Owner finance decision |
| `c_storage` | D1/R2/storage allocation | TBD | TBD | Owner finance decision |
| `m_support` | support minutes per seller/month | TBD | TBD | Pilot support log |
| `c_minute` | fully loaded support cost/minute | TBD | TBD | Owner finance decision |
| `r_loss` | refund/chargeback loss rate | TBD | TBD | Provider/legal policy |
| `conv` | trial-to-paid conversion | TBD | TBD | Pilot evidence only |
| `churn` | monthly paid churn | TBD | TBD | Pilot evidence only |
| `CAC` | acquisition cost per paid seller | TBD | TBD | Acquisition owner |

Prices are source-backed list prices only. VND support, tax behavior, invoice,
refund policy, and provider settlement still require owner/provider decisions.

## Formulas

```text
gross_revenue = P * paid_sellers
transaction_cost = paid_volume * f_tx + transaction_count * f_fixed
support_cost = m_support * c_minute
gross_cost = transaction_cost + c_cf + c_email + c_queue + c_storage + support_cost
loss_cost = gross_revenue * r_loss
gross_margin = gross_revenue - gross_cost - loss_cost
gross_margin_rate = gross_margin / gross_revenue
ARPA = gross_revenue / paid_sellers
LTV = ARPA * gross_margin_rate / churn
CAC_payback_months = CAC / (ARPA * gross_margin_rate)
break_even_sellers = fixed_monthly_cost / (ARPA * gross_margin_rate)
```

`paid_volume`, `transaction_count`, and fixed monthly cost must be supplied by
the owner from reviewed evidence. If a denominator is zero, report
`not_computable`, never `0`.

## Scenarios

The scenario labels below are proposed planning cases, not actual observations.
Every TBD must be approved before use in an acquisition or pricing decision.

| Scenario | Conversion | Churn | Support minutes | Provider/infra cost | Decision use |
| --- | --- | --- | --- | --- | --- |
| Conservative | TBD | TBD | TBD | TBD | Downside capacity and support planning |
| Base | TBD | TBD | TBD | TBD | Owner-approved operating plan |
| Upside | TBD | TBD | TBD | TBD | Sensitivity only; never a forecast claim |

Run the model separately for Starter and Pro, then compare plan mix rather than
blending currencies. Do not aggregate VND and USD revenue without an approved
FX policy.

## Commercial interpretation

- Initial ICP: sellers of digital products, license keys, or private files who
  need a Website checkout and seller-owned PayOS settlement; exact segment size
  is TBD.
- Primary value proposition: reach a publishable, verified payment-to-delivery
  flow with a small, tenant-isolated setup path.
- Starter is the low-complexity entry for a Website-first seller with modest
  catalog/support needs; Pro is justified only when its server-backed limits or
  operational capacity remove a measured bottleneck.
- Likely activation bottlenecks are catalog/inventory readiness, policy setup,
  PayOS proof, and the time between provider waiting states and verified
  readiness.
- Features that reduce failed setup, payment ambiguity, or support handling can
  improve conversion. Expansion connectors without provider acceptance add
  complexity and support cost but do not yet belong in the launch claim.
- Acquisition scale requires reviewed pilot conversion, support burden, gross
  margin, incident rate, provider acceptance, legal/support ownership, and a
  tested rollback/monitoring path.

## Owner decisions required

Merchant-of-record and tax treatment, provider fees, Cloudflare allocation,
support staffing rate, refund/chargeback reserve, pilot cohort size, minimum
sample thresholds, conversion/churn observation window, CAC budget, and the
Starter/Pro feature boundary remain owner decisions.
