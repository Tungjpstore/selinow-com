# Astro implementation rules

- Preserve existing Astro layouts and route contracts.
- Prefer `.astro` components for structure.
- Use TypeScript DOM modules for interaction.
- Do not create client-only rendering for catalog or critical content.
- Use `data-*` hooks instead of brittle class selectors for scripts.
- Keep component props typed.
- Keep server data serialization minimal and safe.
- Avoid duplicate listeners during page transitions/reinitialization.
- Explicitly mark private/sensitive routes noindex/no-store.
