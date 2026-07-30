# Motion

Motion explains state changes.

- Hover/focus: 120ms.
- Button/row feedback: 180ms.
- Drawer/dialog: 240ms.
- Marketing reveal: up to 400ms.
- Standard easing: `cubic-bezier(0.2, 0.8, 0.2, 1)`.

Allowed friendly moments:

- small logo arrow movement after completion;
- progress connector activation;
- 2–4 geometric spark particles after success;
- subtle product/order flow trace in marketing.

Forbidden:

- looping animation on checkout, payment, order, key, domain, or admin surfaces;
- bounce on destructive actions;
- animation that delays interaction.
