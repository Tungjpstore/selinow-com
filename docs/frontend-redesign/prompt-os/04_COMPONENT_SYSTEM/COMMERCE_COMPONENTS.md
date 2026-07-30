# Commerce components

## PaymentState

Never label paid until server/provider verification.

## FulfillmentState

Independent from payment. A paid order can still be processing or failed.

## OrderTimeline

Render two parallel or stacked timelines:

- Thanh toán
- Giao hàng

On mobile, stack them vertically but keep separate headings.

## KeyRevealCard

Default state is hidden. Reveal only after server authorization and fulfillment checks. Copy action gives local feedback without logging value.
