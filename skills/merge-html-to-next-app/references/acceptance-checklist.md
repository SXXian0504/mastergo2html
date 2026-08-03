# Acceptance checklist

## Source coverage

- [ ] Every source page has one explicit final route.
- [ ] Every route renders source content without iframe/HTML-string embedding.
- [ ] Assets, fonts, and source behaviors are accounted for.
- [ ] Dynamic routes have a sample URL and fallback/not-found behavior.
- [ ] Every MasterGo route has an immutable Frame screenshot recorded by path, dimensions, and hash.

## Architecture

- [ ] App Router + TypeScript + `src/` + `@/*` alias.
- [ ] Thin `page.tsx` files.
- [ ] Layouts, in-page, and universal boundaries follow the reuse rules.
- [ ] Every shared component has a consumer list and all consumers passed post-extraction Frame comparison.
- [ ] Client directives exist only at interaction boundaries.
- [ ] Backend access, if any, goes through BFF/server-only configuration.

## Styles and UX

- [ ] Generated styles are page-scoped; no cross-route leakage.
- [ ] Tailwind handles ordinary layout/spacing/type/color/responsiveness.
- [ ] Complex legacy CSS is isolated and explained.
- [ ] Navigation is real; no silent `href="#"` placeholders.
- [ ] Forms and async actions have labels, errors, keyboard support, and loading states.
- [ ] Desktop and responsive layouts have been checked.
- [ ] Trace attributes were removed only after their CSS/runtime dependencies were replaced.

## Visual gates

- [ ] Every generated HTML page was rendered and compared with its own Frame.
- [ ] Every one-to-one React route was compared before shared component extraction.
- [ ] Every affected route was compared again after component and style refactors.
- [ ] Final screenshots use the Frame width, deterministic content, loaded fonts/assets, and full-page capture.
- [ ] Every final `<page-id>.json` report is `frame-vs-react-final`, uses the manifest Frame hash, matches dimensions, and passes the documented threshold.
- [ ] Actual and diff images were inspected; metric pass was not used as the sole visual judgment.

## Quality gates

- [ ] Structural validator passes.
- [ ] Install and lockfile succeed.
- [ ] Lint succeeds.
- [ ] Typecheck succeeds.
- [ ] Tests succeed, when present.
- [ ] Production build succeeds.
- [ ] `validate_project.py --require-visual` succeeds for all routes.
- [ ] ARCHITECTURE, STANDARDS, ROUTES, and DECISIONS are current.
