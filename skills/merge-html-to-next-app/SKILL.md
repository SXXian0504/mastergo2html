---
name: merge-html-to-next-app
description: Convert multiple standalone HTML/CSS/JS or MasterGo-generated page outputs into one engineering-standard Next.js App Router project while preserving every page against its Frame screenshot. Use for route-aware HTML-to-React migration, screenshot-gated component reuse, Header/Footer deduplication, scoped style migration, interaction conversion, and final visual regression validation.
---

# Merge HTML to Next App

Convert source pages without mutating them. Treat each design Frame screenshot as the authoritative visual result; maintainability work is valid only when every affected route still matches its own Frame.

## Required reading

1. If the user names engineering documents, read them first and treat them as canonical.
2. In this repository, read `docs/工程规范.md`; consult `docs/ARCHITECTURE.md`, `docs/STANDARDS.md`, `docs/ROUTES.md`, and `docs/DECISIONS.md` for inherited details.
3. Read [visual-fidelity.md](references/visual-fidelity.md) for screenshot artifacts, comparison commands, and refactor gates.
4. Otherwise read [engineering-profile.md](references/engineering-profile.md) and [conversion-playbook.md](references/conversion-playbook.md).

When documents conflict, prefer the user's current requirements, then `工程规范.md`, then the bundled references. Preserve the architecture pattern; do not copy historical framework versions.

## Workflow

### 1. Isolate and inventory inputs

- Never edit source exports in place.
- Copy every input page into a new task workspace under `sources/<page-id>/`.
- Assign an explicit application route to every page before implementation. Do not rely on titles alone for dynamic routes.
- Run:

```bash
python3 scripts/prepare_inputs.py \
  --workspace <task-workspace> \
  --require-frame-screenshot \
  --page '/home=<html-output-dir>' \
  --frame-screenshot '/home=<frame-screenshot.png>' \
  --page '/position=<html-output-dir>' \
  --frame-screenshot '/position=<frame-screenshot.png>' \
  --page '/position/[id]=<html-output-dir>'
```

For MasterGo outputs, never continue without one valid `frame-screenshot.png` per route. Review `source-manifest.json` and `source-inventory.md`; confirm screenshot dimensions/hashes, routes, missing assets, and external dependencies before conversion.

### 2. Plan the merged application

Write `conversion-plan.md` in the task workspace. It must cover:

- route-to-source mapping and dynamic-route sample URLs;
- global shell candidates such as Header, Footer, SEO, and providers;
- page-only sections versus genuinely reused components;
- asset collision strategy;
- CSS and interaction migration risks;
- exact Frame viewport widths, dynamic-route test URLs, screenshot stages, and documented diff thresholds;
- candidate shared components and the full list of routes that must be rechecked after each extraction.

Do not decide reuse from names or visual intuition. Compare source DOM, assets, content, styles, responsive behavior, and Frame screenshots. A shared implementation may use evidence-based props or variants, but it must reproduce every consuming Frame exactly; otherwise keep page-specific implementations.

### 3. Scaffold the target

- Use a currently supported stable Next.js release, App Router, TypeScript, `src/`, and `@/*` alias. Confirm current versions from official documentation or the package registry when creating a new project.
- Prefer the repository's existing package manager; otherwise choose one and document it.
- **Style three-track precondition (mandatory before any React synthesis).** The engineering spec splits styling across three tools (see Step 7). Before building components, verify the scaffold has all three installed; install any missing one before continuing:
  - `tailwindcss` (+ its PostCSS plugin, e.g. `@tailwindcss/postcss` v4) — layout/spacing/typography/color/responsive.
  - `sass` (devDependency) — `*.module.scss` for keyframes/pseudo-elements/nesting/complex states.
  - `antd` (dependency) — behavior-heavy controls (Form/Modal/Drawer/Select).
- Preflight check (do not skip): read `package.json` and `node_modules`. Install whatever is missing, e.g. `npm i -D sass @tailwindcss/postcss tailwindcss && npm i antd`. If a scaffold tool (create-next-app) just created the project, Tailwind is usually present but `sass` and `antd` are not — add them now. Confirm:
  - `npx tsc --noEmit` (or the scaffold's typecheck) still passes after installs.
  - `import 'antd'` and a `Component.module.scss` resolve without "Cannot find module" errors.
- Do not synthesize any `in-page` component or scoped CSS until the three-track deps are installed and typecheck passes. If a dep fails to install on the platform (e.g. Playwright on macOS 13 needs `playwright@1.49.1`), pin a compatible version and record it in `docs/DECISIONS.md`.
- Use Server Components by default. Add `'use client'` only to the smallest component that requires state, effects, browser APIs, or event handlers.
- Keep `src/app/**/page.tsx` thin; compose page implementations from `src/components/in-page/**`.
- Create the directory boundaries described in [engineering-profile.md](references/engineering-profile.md).

### 4. Build a one-to-one React fidelity baseline

- Convert semantic HTML to JSX. Do not use `dangerouslySetInnerHTML`, iframe wrappers, or runtime loading of the original HTML.
- The optional draft converter may accelerate mechanical work:

```bash
python3 scripts/html_to_jsx_draft.py \
  --manifest <task-workspace>/source-manifest.json \
  --output <task-workspace>/drafts
```

Drafts are temporary, but the first React pass must preserve each source page's DOM hierarchy, assets, CSS behavior, and placement closely enough to isolate conversion regressions. Do not extract shared Header/Footer or redesign generated structures during this pass. Defer generator metadata cleanup until dependent CSS selectors have migrated.

- Copy assets to `public/design/<page-id>/...`; rewrite URLs to root-relative `/design/<page-id>/...` paths. Never depend on another source page's relative directory.
- Preserve generated CSS for the first fidelity pass, scope it to a page root with `scope_css.py`, and do not merge unscoped stylesheets.
- Translate source JavaScript into React behavior. Replace DOM queries and global listeners with component state, refs, handlers, and effects. Every user-triggered async action needs loading feedback.
- Replace `href="#"` and pending actions with working internal routes, disabled controls, or explicit TODOs listed in the report; do not leave fake navigation silently active.

### 5. Gate the initial React baseline

- Render every route at its Frame screenshot width and capture a full-page screenshot.
- Compare React against the Frame screenshot. Also compare against an accepted HTML screenshot to identify HTML-to-React drift, but never treat HTML as more authoritative than the Frame.
- Fix every page before extracting shared components. One passing route cannot compensate for another failing route.
- Store initial screenshots, diffs, and JSON reports as described in `visual-fidelity.md`.

### 6. Extract reuse without visual drift

- Extract one candidate component family at a time, starting with repeated shell structures.
- Preserve complete source content and assets; never replace a designed Header/Footer with a simplified placeholder.
- Encode only screenshot-proven differences as typed props, slots, tokens, or variants. Do not invent a neutral design to force reuse.
- After each extraction, capture and compare every consuming route. Keep the extraction only when all those routes pass.
- Move a component to `universal/` only after at least two real consumers pass post-extraction visual regression.

### 7. Migrate styles to the Tailwind + SCSS + Antd three-track split

The goal is to decompose the page-scoped generated CSS (and source JS interactions) into the three style tracks defined by `docs/工程规范.md`: **Tailwind** (ordinary layout/spacing/typography/color/responsive), **SCSS Modules** (keyframes/pseudo-elements/nesting/complex states/brand-fidelity), and **Ant Design** (behavior-heavy controls). Do this only after the initial React baseline (Step 4–5) passes its screenshot gate, and migrate incrementally — every ownership change is a regression risk.

#### 7.1 Prerequisite check (re-confirm)

Before migrating, re-confirm the three-track deps from Step 3 are still present and typecheck passes: `tailwindcss` (+ PostCSS plugin), `sass`, `antd`. If a dep was removed or the scaffold was re-created, reinstall before continuing. Keep one decision log entry in `docs/DECISIONS.md` noting the installed versions.

#### 7.2 Classify every generated selector/interaction into a track

Walk the scoped generated CSS (`src/styles/generated/<page>.css`) and source JS, and tag each rule/interaction with exactly one target track. Use this decision table; when in doubt, prefer the track that keeps the visual result identical on the current route, and record the trade-off:

| Source pattern | Target track | How to migrate |
|---|---|---|
| `position/size/display/padding/margin/gap/grid/flex/width/height` for pure layout that maps cleanly to utilities | **Tailwind** | Replace `.route-x .foo{...}` with utility classes on the JSX element; remove the now-unused generated rule. |
| `font-size/line-height/font-weight/letter-spacing/color/text-align` that match the Tailwind theme scale | **Tailwind** | Use text/leading/tracking/`text-[color]` utilities; extend `theme` in the Tailwind config only if a design token recurs. |
| Responsive `@media (max-width:…)` that only adjusts layout/type/spacing | **Tailwind** | Convert to `sm:/md:/lg:/xl:` variants; preserve the exact breakpoints. |
| `@keyframes`, `animation`, `transition` beyond what Tailwind utilities cover | **SCSS Module** | Move into `ComponentName.module.scss` with the same keyframe name (preserve `scope_css.py`'s name preservation rule). |
| Pseudo-elements `::before/::after`, complex `:hover/:focus/:disabled/[data-style-source-node-id]` combos, deeply nested selectors | **SCSS Module** | Keep in `*.module.scss`; replace `[data-style-source-node-id="..."]` attribute selectors with composed `:global` or a stable local class first (see 7.6). |
| Brand-fidelity "tightly coupled" rules (decor offsets, SVG layer placement, exact design hex not in theme) | **SCSS Module** | Co-locate beside the owning component; do **not** force these into Tailwind utilities — rounding/fractional sub-pixels will drift. |
| Strict resets/`@font-face`/global CSS variables/fonts | **globals.css** | Keep in `src/styles/globals.css`; these are not component-scoped. |
| Behavior-heavy interactive control with its own state machine (Form submit, Modal/Dialog, Drawer, Select/Search dropdown, Tabs with async content, validation) | **Ant Design** | Replace the hand-rolled markup+JS with the Antd control; preserve branded chrome via Antd `theme` tokens / CSS variables, never by restyling inside the branded region. |
| Static text, decorative icons, branded footer/header | **do not Antd-ify** | Stay Tailwind/SCSS; Antd is only for behavior-heavy controls. |

Record the classification in `conversion-plan.md` as a table per route (or note that the full audit lives in a `style-migration.md` next to it), and update `docs/STANDARDS.md` with the migration rules added.

#### 7.3 Migration order (one track-batch at a time, smallest risk first)

1. **Globals/fonts/reset → `globals.css`**: move only truly global declarations; leave route-scoped rules untouched.
2. **Tailwind utilities**: migrate the easiest layout/type/spacing/color rules per component, starting from leaf components (cards, buttons, chips) and moving inward. After each component, re-capture that route and diff against the Frame (see 7.5).
3. **SCSS Modules**: migrate keyframes/pseudo-elements/nesting/brand-fidelity rules into `ComponentName.module.scss` co-located with the component. Import as `import styles from './ComponentName.module.scss'` and apply via `className={styles.foo}` (compose with utility classes via `clsx`/the project's `classNames` util).
4. **Ant Design**: last, only where 7.2 mandates a real interactive control. Replace the minimal Client Component subtree; keep the Server Component boundary above it.

Never run a full-file find/replace across all routes. Each batch must list the affected routes in `conversion-plan.md` and be re-verified before the next batch starts.

#### 7.4 Ant Design integration rules

- Add `antd` to the root `layout.tsx` only when actually needed (ConfigProvider + theme); until then it can stay as a peer dependency without a global provider, but prefer wrapping once you introduce the first Antd control.
- For Server-Component-heavy routes, keep Antd controls in the smallest Client island; the `Form`/`Modal` subtree is client, the page is server.
- Preserve the designed look of branded regions: do not restyle `Card`/`Button` chrome that overlaps the designed Header/Footer/hero. Use Antd's `theme`/`ConfigProvider` tokens or local CSS overrides via `*.module.scss` `:global(.ant-…)` only when the Frame demands it.
- Re-capture every route that now contains the new Antd control and confirm its own Frame still matches; Antd's reset/preflight can shift typography and spacing globally — check **all** routes, not just the touched one.

#### 7.5 Screenshot gate per ownership change

After finishing each batch (a component family, or one track region):

1. Re-capture the affected route(s) at their Frame width (same `scripts/capture.mjs` + `compare_screenshots.mjs` contract as Step 5).
2. Compare both **Frame-vs-React** and **HTML-vs-React**. The merge fidelity must still hold (HvsReact within the document threshold). If Frame-vs-React worsened, revert that batch and rethink the classification.
3. Inspect the diff image for clipping, font drift, moved decorations, lost assets, and antd reset fallout. A metric pass with visible drift is a fail.
4. Only after the batch passes, remove the corresponding generated CSS rules from `src/styles/generated/<page>.css` when no remaining JSX still references them. Do a final typecheck + build after each removal so dead CSS never accumulates.

#### 7.6 Trace-metadata cleanup order

Style migration touches provenance attributes. Clean them in this order only:

1. While generated CSS selects `[data-style-source-node-id="…"]`, keep the attribute on the JSX.
2. When migrating a selector that uses `[data-style-source-node-id="…"]` to a SCSS Module or Tailwind utility, first replace the selector with a stable local class (or `styles.foo`), then drop the attribute from the JSX in the same batch.
3. Move source-node provenance (`data-source-node-id`, `data-text-source-node-id`, `data-asset-id`) into `source-manifest.json`/reports only after no runtime or test dependency remains.
4. Remove `data-pending-url` placeholders only after route wiring is final (Step 4) and the route re-recapture passes.

Record every provenance move in `docs/ARCHITECTURE.md` or a `source-provenance.md` so the mapping from design node → React element stays auditable.

#### 7.7 Completion bar for style migration

A route's style migration is done when:
- Its `generated/<page>.css` is empty or only holds rules that are intentionally kept (documented in `conversion-plan.md`); the rest live in Tailwind utilities + `*.module.scss` files.
- `npx tsc --noEmit`, `npm run lint`, and `npm run build` pass with the migrated setup.
- The route's final Frame-vs-React screenshot still meets the recorded threshold and the diff image shows no new drift.
- `docs/STANDARDS.md` documents which patterns were migrated to which track for that route.

If a trade-off makes strict three-track migration visually worse for a route, record a deviation in `docs/DECISIONS.md` rather than silently keeping everything in generated CSS.

### 8. Respect data and BFF boundaries

- Static source data may start in typed constants.
- Browser components must not call backend microservice hosts directly. Use same-origin Route Handlers under `src/app/api/**/route.ts` or an approved Server Action boundary.
- Keep backend URLs and secrets in server-only configuration. BFF code handles authentication, backend errors, and response normalization such as `{ status, data?, msg? }`.
- Prefer Server Component fetching. Use TanStack Query only for client caching, polling, or user-driven requests.

### 9. Preserve project knowledge

Create or update:

- `docs/ARCHITECTURE.md`
- `docs/STANDARDS.md`
- `docs/ROUTES.md`
- `docs/DECISIONS.md`

Record route mappings, component boundaries, CSS migration decisions, source-page provenance, visual thresholds, shared-component consumer matrices, unresolved behavior, and deliberate deviations.

### 10. Run final Frame validation

Capture every final route again and compare directly with its Frame screenshot:

```bash
node scripts/compare_screenshots.mjs \
  --reference <task-workspace>/design-references/<page-id>/frame-screenshot.png \
  --actual <task-workspace>/visual/react-final/<page-id>.png \
  --report <task-workspace>/visual/react-final/<page-id>.json \
  --diff <task-workspace>/visual/react-final/<page-id>.diff.png \
  --route <route> \
  --mode frame-vs-react-final \
  --max-changed-ratio <documented-threshold>
```

Choose and record thresholds before final comparison. Metrics guide review; inspect the actual and diff images for clipping, missing assets, font drift, overlap, and wrong responsive behavior.

### 11. Validate and report

Run the structural validator before package commands:

```bash
python3 scripts/validate_project.py \
  --project <target-project> \
  --manifest <task-workspace>/source-manifest.json \
  --require-visual \
  --visual-report-dir <task-workspace>/visual/react-final
```

Then run install, lint, typecheck, tests, and the production build. Visual validation is mandatory for MasterGo conversion; unavailable browser tooling is a blocker, not a reason to declare success.

Style-split audit (additional): before declaring completion, confirm and report:
- `npm ls tailwindcss @tailwindcss/postcss sass antd` shows all three-track deps installed.
- `find src -name '*.module.scss'` lists the SCSS Modules produced by Step 7 (can be empty only if Step 7 was intentionally deferred — state this explicitly).
- `grep -rn "from 'antd'" src` lists the Antd controls adopted (can be empty only if no behavior-heavy control was migrated — state this).
- `src/styles/generated/<page>.css` is empty or only contains intentionally-kept rules (each kept rule documented in `conversion-plan.md`).
- The final Frame-vs-React reports still meet the recorded threshold after the last style migration batch.

Record the style-split status (installed versions, route→track mappings, deferred batches, deviations) in `docs/STANDARDS.md` / `docs/DECISIONS.md` and the final report.

Do not claim completion while required routes fail, assets 404, source interactions are missing without documentation, or validation/build errors remain. Use [acceptance-checklist.md](references/acceptance-checklist.md) for the final audit.

## MasterGo page-batch handoff

If sources come from `mastergo2html generate-pages`, read `.mastergo2html/page-batches/<batchId>/batch.json` and run its `mergePrepareCommand`. The command passes both each successful page's `outputDir` and its original `inputPath/frame-screenshot.png`. Do not silently omit failed pages; retry or report them. Preserve generated HTML and Frame screenshots as immutable sources.
