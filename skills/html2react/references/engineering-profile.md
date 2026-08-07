# Engineering profile

This profile is opt-in. Use it only when the user explicitly requests engineering mode, shared-component extraction, three-track style migration, design-system modernization, or release-grade repeated visual regression. The common/default conversion in `../SKILL.md` must remain usable without this profile.

In this repository, `docs/工程规范.md` remains canonical when it applies.

## Stack and boundaries

- Modern stable Next.js, App Router, TypeScript, `src/`, alias `@/* -> src/*`.
- Server Components by default; narrow Client Components for browser-only behavior.
- Keep `page.tsx` thin and use these boundaries:

```text
src/app/                       routes, layouts, loading, error
src/app/api/                   same-origin BFF Route Handlers
src/components/layouts/        global shell
src/components/in-page/        route-specific business components
src/components/universal/      reuse proven by at least two pages
src/hooks/                     UI/client-boundary hooks
src/utils/                     utilities and request wrappers
src/types/                     business types
src/constants/                 typed static content
src/styles/                    globals, tokens, migration styles
config/                        runtime/environment configuration
public/design/<page-id>/       migrated source assets
docs/                          architecture knowledge
```

New components start route-specific. Promote them only after observed reuse and passing regression on all consumers.

## Phase 1: establish the refactor baseline

Before extracting components or changing style ownership:

1. Complete every route one-to-one with scoped source CSS.
2. Capture every route at its Frame width as `visual/react-initial/<page-id>.png`.
3. Compare against its own Frame and, when available, the accepted HTML render.
4. Fix route-level regressions before engineering refactors.

This baseline is engineering-only; default mode proceeds directly to the final capture.

## Phase 2: extract shared components

- Compare source DOM, assets, content, dimensions, responsive rules, interactions, and Frame regions before declaring reuse.
- Extract one component family at a time, starting with repeated shell structures.
- Preserve screenshot-proven differences with typed props, slots, tokens, or variants.
- Capture and compare every consuming route after each extraction batch.
- Keep an extraction only when all consumers pass. Move to `universal/` only after at least two real consumers pass.
- Record the consumer matrix and deliberate exceptions.

## Phase 3: migrate the three style tracks

Install and verify:

- `tailwindcss` and its required PostCSS integration for layout, spacing, typography, color, and responsive rules;
- `sass` for `*.module.scss` keyframes, pseudo-elements, nesting, and complex page-specific fidelity;
- `antd` for behavior-heavy controls such as Form, Modal, Drawer, and Select.

Run typecheck after dependency setup. Do not require these packages in default mode.

Migrate in bounded batches:

1. Scope and stabilize globals, fonts, resets, and tokens.
2. Move ordinary layout/type/color/responsive rules to Tailwind.
3. Move complex selectors, keyframes, pseudo-elements, and local states to SCSS Modules.
4. Adopt Ant Design only where its behavior is beneficial; check reset/provider effects across all routes.
5. Replace trace-attribute selectors before removing their attributes.

After every component or style ownership batch, re-capture affected routes and compare against their Frames. Revert or revise batches that introduce visible drift.

A route's style migration is complete when generated CSS is empty or contains only documented retained rules, package checks pass, and the final Frame comparison shows no new drift. Record deviations rather than forcing migration at the expense of fidelity.

## Phase 4: engineering documentation and final regression

Create or update:

- `docs/ARCHITECTURE.md`
- `docs/STANDARDS.md`
- `docs/ROUTES.md`
- `docs/DECISIONS.md`

Record route mappings, component boundaries, route-to-track mappings, dependency versions, deferred batches, visual thresholds, consumer matrices, and deliberate deviations.

Capture every final route as `visual/react-final/<page-id>.png`, compare directly with its Frame, inspect diffs, then run lint, typecheck, tests, production build, and:

```bash
python3 scripts/validate_project.py \
  --profile engineering \
  --project <target-project> \
  --manifest <task-workspace>/source-manifest.json \
  --require-visual \
  --visual-report-dir <task-workspace>/visual/react-final
```

Audit `tailwindcss`, `sass`, and `antd` declarations; list SCSS Modules and Ant Design imports; document routes where a track was not applicable.

## Data, naming, and quality

- Browser code does not directly call backend service hosts; use same-origin BFF/server boundaries.
- User-triggered async work exposes loading and error states.
- Component: `PascalCase/index.tsx`; SCSS Module: `ComponentName.module.scss`; utilities/types/constants: `camelCase.ts`.
- Preserve accessible landmarks, labels, keyboard behavior, reduced motion, image alt intent, and responsive layouts.
