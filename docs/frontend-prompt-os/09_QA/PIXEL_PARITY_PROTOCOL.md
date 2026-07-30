# Pixel parity protocol

## Definition

“100% detailed” means deterministic parity against this Prompt OS specification, not blindly reproducing AI-image artifacts.

## Fixed viewports

- Mobile: 390 × 844
- Tablet: 768 × 1024
- Desktop: 1440 × 1024
- Landing long-page: 1440px width, full page

## Environment

- deterministic fixtures;
- frozen timezone and locale `vi-VN`;
- animations disabled;
- stable fonts loaded before capture;
- network mocked only with contract-accurate fixtures;
- no timestamps that change between runs.

## Tolerances

- Major container position: ≤ 2px.
- Internal spacing: exact token or ≤ 1px rendering variance.
- Radius: exact token.
- Color: exact CSS token.
- Typography: exact size/line-height/weight/tracking.
- Screenshot diff target: ≤ 0.5% after excluding approved dynamic masks.
- No mismatch accepted in payment, fulfillment, permission, key, or destructive states.

## Review order

1. product/state correctness;
2. accessibility;
3. responsive layout;
4. typography;
5. spacing and alignment;
6. colors/borders/radii;
7. shadows and motion.
