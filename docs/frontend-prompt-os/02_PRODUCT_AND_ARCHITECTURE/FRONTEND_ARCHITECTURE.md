# Frontend architecture

## Existing target structure

```text
src/
  layouts/
    PlatformLayout.astro
    AppLayout.astro
    StorefrontLayout.astro
    AdminLayout.astro                 # add only if repository benefits
  components/
    primitives/
    states/
    platform/
    workspace/
    commerce/
    storefront/
    integrations/
    admin/
  pages/
  scripts/
    shared/
    dashboard/
    storefront/
  styles/
    selinow-tokens.css
    selinow-a11y.css
    primitives.css
    platform.css
    app-shell.css
    storefront.css
    admin.css
```

## Rendering

- Marketing/storefront: HTML/CSS-first.
- Hydrate only interactive islands that truly require it.
- Dashboard: Astro-rendered structure with TypeScript DOM modules.
- Important business state is server-derived.
- Client localStorage is acceptable for cart convenience, never authority.

## CSS architecture

1. tokens;
2. reset/base;
3. accessibility helpers;
4. primitives;
5. surface layout;
6. feature components;
7. responsive overrides;
8. utilities kept minimal.
