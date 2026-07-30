# CSS architecture

```text
selinow-tokens.css   canonical variables
selinow-a11y.css     focus, sr-only, reduced motion, skip link
base.css             reset and typography
primitives.css       buttons, fields, badge, alert, dialog
authoring surface files:
  platform.css
  app-shell.css
  storefront.css
  admin.css
feature component CSS colocated only when repository convention supports it
```

Rules:

- No random hex outside token file unless merchant theme value is server-provided.
- No more than two radii in one component family.
- Prefer border and tonal surface over heavy shadow.
- No `!important` except accessibility/reduced-motion escape hatches.
