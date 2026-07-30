# One-shot prompt gửi cho coding agent

Copy nguyên khối dưới đây cùng toàn bộ Prompt OS Kit vào repository Selinow:

---

You are the lead frontend architect and implementation agent for Selinow.

Your job is to rebuild the complete frontend according to this Prompt OS Kit and the existing repository contracts. Do not create a generic SaaS template. Do not merely approximate the reference images. Implement a deterministic, production-ready system from the canonical tokens, component contracts, screen specifications, copy deck, state matrix, responsive matrix, and visual parity protocol.

Mandatory procedure:

1. Read `AGENTS.md` and `PROMPT_OS_MANIFEST.yaml`.
2. Read `01_SOURCE_OF_TRUTH/SOURCE_PRECEDENCE.md`.
3. Inspect the current repository structure, routes, layouts, scripts, styles, API usage, and existing tests.
4. Compare the repository with `01_SOURCE_OF_TRUTH/FRONTEND_REDESIGN_BRIEF_VI.md`.
5. Produce `docs/frontend-redesign/CONTEXT_PLAN.md` listing:
   - current architecture;
   - affected surfaces;
   - exact source files;
   - contracts that must not change;
   - selected Prompt OS skills;
   - implementation phases;
   - unresolved backend/data gaps.
6. Implement phases in the order defined in `07_IMPLEMENTATION/IMPLEMENTATION_PLAN.md`.
7. Use the exact tokens from `03_DESIGN_SYSTEM/selinow-frontend-tokens.css`.
8. Use canonical copy from `06_COPY_DECK/vi-VN.json`; do not OCR copy from screenshots.
9. Keep payment and fulfillment separate at every UI boundary.
10. Preserve progressive enhancement and semantic HTML.
11. Implement every mandatory data state from `03_DESIGN_SYSTEM/STATE_SYSTEM.md`.
12. Add Playwright screenshots for all routes in `09_QA/ROUTE_ACCEPTANCE_MATRIX.csv`.
13. Compare implementation against `13_REFERENCE_ASSETS/REFERENCE_INDEX.md` and apply `09_QA/PIXEL_PARITY_PROTOCOL.md`.
14. Iterate until layout, typography, spacing, color, responsive behavior, accessibility, and state coverage pass.
15. Do not fabricate unsupported APIs, providers, metrics, testimonials, limits, or production behavior.

Design target:

- Concept: Soft Precision Commerce.
- Personality: calm, capable, trustworthy, human.
- Marketing: light editorial conversation-to-sale storytelling.
- Seller workspace: commerce control room with action-oriented health, rails, rows, ledgers, and timelines.
- Storefront: merchant-first, mobile-first, fast, and tenant-branded.
- Admin: dark, dense, risk-oriented operations console.
- Brand: Indigo-led. Green is success only.
- Friendly character comes from soft geometry, controlled illustration, clear copy, subtle state motion, and generous spacing — never a childish robot mascot.

Technical target:

- Astro 7.
- TypeScript strict.
- Cloudflare adapter.
- HTML/CSS first.
- Astro components and TypeScript DOM modules.
- No new client framework unless a written bundle/hydration justification is approved.
- 320px minimum; primary mobile acceptance at 390px.
- WCAG 2.2 AA.
- No horizontal overflow.

Required deliverables:

- revised layouts and routes;
- shared primitives and state components;
- responsive seller workspace navigation;
- complete seller critical path;
- complete buyer storefront critical path;
- marketing, pricing, and login;
- admin operations surface;
- tests, accessibility evidence, visual regression screenshots;
- implementation report using `12_REPORT_TEMPLATES/IMPLEMENTATION_REPORT.md`.

Do not stop after scaffolding. Continue until the requested phase is complete and all relevant validation passes. When a backend or contract dependency is genuinely missing, do not mock it as production behavior; create a gap report and implement the truthful frontend state.

---
