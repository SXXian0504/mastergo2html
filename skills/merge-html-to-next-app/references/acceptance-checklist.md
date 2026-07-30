# Acceptance checklist

## Source coverage

- [ ] Every source page has one explicit final route.
- [ ] Every route renders source content without iframe/HTML-string embedding.
- [ ] Assets, fonts, and source behaviors are accounted for.
- [ ] Dynamic routes have a sample URL and fallback/not-found behavior.

## Architecture

- [ ] App Router + TypeScript + `src/` + `@/*` alias.
- [ ] Thin `page.tsx` files.
- [ ] Layouts, in-page, and universal boundaries follow the reuse rules.
- [ ] Client directives exist only at interaction boundaries.
- [ ] Backend access, if any, goes through BFF/server-only configuration.

## Styles and UX

- [ ] Generated styles are page-scoped; no cross-route leakage.
- [ ] Tailwind handles ordinary layout/spacing/type/color/responsiveness.
- [ ] Complex legacy CSS is isolated and explained.
- [ ] Navigation is real; no silent `href="#"` placeholders.
- [ ] Forms and async actions have labels, errors, keyboard support, and loading states.
- [ ] Desktop and responsive layouts have been checked.

## Quality gates

- [ ] Structural validator passes.
- [ ] Install and lockfile succeed.
- [ ] Lint succeeds.
- [ ] Typecheck succeeds.
- [ ] Tests succeed, when present.
- [ ] Production build succeeds.
- [ ] Route screenshots were compared or the lack of browser validation is explicitly reported.
- [ ] ARCHITECTURE, STANDARDS, ROUTES, and DECISIONS are current.
