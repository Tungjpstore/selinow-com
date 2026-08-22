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

## LP Editorial Commerce motion additions (2026-08-22)

Allowlist additions shipped by the LP landing program, all token-driven and
fully inert under `prefers-reduced-motion` (final state renders without JS):

- `ed-hero-settle` — hero headline rises + variable-weight settle
  (`--mk-duration-hero`, `--mk-ease-editorial`); final state is the base style.
- `ed-hero-unveil` — hero art frame clip-path reveal on `data-reveal-state`
  (final state fully revealed).
- `ed-chip-float` — commerce chips gentle float loop (decorative only).
- `ed-ticker-scroll` — channel marquee (`--mk-duration-ticker`); static wrap
  under reduced motion (no scrollable region).
- Flow scrollytelling (`flow-scene.ts`) mirrors scroll onto
  `data-flow-active`; CSS cross-fades on `--mk-duration-scene`.
- Hero canvas: WebGL aurora runs only when motion is allowed; under
  reduced-motion the canvas is never initialized — a static CSS aurora shows.
