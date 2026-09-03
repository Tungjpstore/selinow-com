# Color and surfaces

## Action vs state

- Indigo: primary action, current navigation, active progress.
- Blue: focus, information, selected supporting controls.
- Teal: connection motif and non-critical supporting illustration.
- Green: verified success only.
- Orange: warning or waiting user/provider.
- Red: error, danger, destructive.

## Surface rules

- Canvas is `#F8FAFC`.
- Main panels use white with 1px slate border.
- Use tinted backgrounds for grouped information; avoid decorative gradients inside operational tables.
- Dark inverse is reserved for sidebar, admin, footer, and selective marketing section.


## Selinow Soft accent spine (EX0, 2026-08-22)

Marketing, auth, and onboarding share the `--sln-soft-*` family defined once in `src/styles/selinow-tokens.css` (accent `#7C6AF0`, fill-safe strong `#6957DE`, canvas `#EBE6F8`, tint `#EDE8FB`). Console projects its own `--sln-console-*` Soft layer. Raw Soft hex outside token files is a contract violation (`tests/unit/ex0-experience-contract.test.ts`).
