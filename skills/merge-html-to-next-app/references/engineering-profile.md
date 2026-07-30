# Engineering profile

This is the portable minimum. In this repository, `docs/工程规范.md` remains canonical.

## Stack and routing

- Modern stable Next.js, App Router, TypeScript, `src/` directory, alias `@/* -> src/*`.
- Server Components by default; narrow Client Components for browser-only behavior.
- Do not select an old Next.js version merely to match a reference repository.

## Required boundaries

```text
src/app/                       route layouts, pages, loading, error
src/app/api/                   same-origin BFF Route Handlers
src/components/layouts/        global shell
src/components/in-page/        route-specific business components
src/components/universal/      confirmed reuse by at least two pages
src/hooks/                     small UI/client-boundary hooks
src/utils/                     utilities and request wrappers
src/types/                     business types
src/constants/                 typed static content
src/styles/                    globals, tokens, migration styles
config/                        runtime/environment configuration
public/design/<page-id>/       migrated source assets
docs/                          architecture knowledge
```

`page.tsx` files stay thin. New components default to `in-page/`; promote only after observed reuse.

## Styles

- Tailwind: layout, spacing, type, color, responsive breakpoints.
- SCSS Module: keyframes, pseudo-selectors, nesting, complex page-specific fidelity.
- Ant Design: Form, Modal, Drawer, and similar interaction-heavy primitives.
- Global CSS is limited to reset, theme variables, fonts, and intentional migration sheets.
- Generated styles from different pages must be scoped before they coexist.

## Data

- Browser/page code does not directly call backend service hosts.
- Same-origin BFF handles configuration, authentication, backend invocation, errors, and normalized responses.
- Prefer server fetching; use client query libraries only when their cache/interaction behavior is required.
- User-triggered async work exposes loading state.

## Naming and quality

- Component: `PascalCase/index.tsx`.
- Component stylesheet: `ComponentName.module.scss`.
- Utility/type/constant: `camelCase.ts`.
- API path segments: kebab-case.
- Prettier baseline: single quotes, semicolons, 120 columns, avoid parentheses for one arrow parameter.
- Preserve accessible landmarks, labels, keyboard behavior, reduced motion, image alt intent, and responsive layouts.
