# ADR 0011: Accessible design system and tenant theming

## Status

Accepted

## Date

2026-07-26

## Context

The current frontend has functional pages but inconsistent visual hierarchy and insufficiently explicit contrast, focus and theming acceptance. Sellers can also provide brand colors that may make text, controls or status states unreadable. A multi-channel platform needs a coherent seller workspace and storefront system before adding more connector screens.

## Decision

- Establish one semantic design-token system for the platform workspace and a constrained token projection for tenant storefront themes.
- Use purpose-based tokens such as canvas, surface, text, muted text, border, action, focus, success, warning and danger. Components do not select arbitrary raw colors.
- Meet WCAG AA contrast: at least 4.5:1 for normal text and 3:1 for large text, meaningful icons, focus indicators and user-interface boundaries where applicable.
- Derive or clamp seller theme colors when needed. A seller-provided color never overrides readable text, focus, error, payment or security states.
- Require visible keyboard focus, logical tab order, semantic landmarks, labeled controls, reduced-motion support, sufficiently large touch targets and non-color-only status communication.
- Standardize loading, empty, blocked, retry, success and destructive-confirmation states across onboarding, domains, integrations, payments and operations.
- Treat mobile and desktop as first-class acceptance targets. Avoid hiding critical setup state behind hover-only or wide-screen-only interactions.
- Add automated accessibility checks and deterministic visual regression coverage for representative dashboard and storefront states. Manual keyboard, contrast and 390px mobile review remains part of release acceptance.
- Keep motion purposeful and optional. Reduced-motion preferences disable nonessential transitions without hiding state changes.

## Trade-offs

- Theme constraints reduce the range of unrestricted seller color combinations.
- Visual regression baselines require review and maintenance.
- Automated accessibility tools cannot replace manual keyboard and usability testing.
- Refactoring existing pages into shared primitives must be staged to avoid blocking critical Phase 8 and Phase 9 workflows.

## Consequences

- New connector and onboarding screens reuse an intentional visual and interaction language instead of adding isolated forms.
- Tenant branding remains expressive while payment, error and security states stay legible.
- Contrast, keyboard behavior and responsive rendering become release gates rather than informal preferences.
- Frontend completion evidence must include accessibility and visual-state results, not only successful build and lack of horizontal overflow.

## Revisit triggers

Revisit tokens and component primitives when user research identifies recurring usability failures, when brand requirements cannot be represented safely, or when accessibility audits reveal systemic gaps.
