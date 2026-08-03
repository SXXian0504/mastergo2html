---
name: mastergo-pages-to-react
description: Run the complete MasterGo multi-Frame website pipeline from design inputs to per-Frame HTML and then a route-aware Next.js React project, with each frame-screenshot preserved as the visual authority and mandatory screenshot gates before and after component reuse. Use for end-to-end design-to-HTML-to-React conversion and fidelity regression testing.
---

# MasterGo Pages to React

Orchestrate the complete `MasterGo Frame -> HTML -> React project` pipeline. Each Frame remains an independent page truth source throughout the workflow.

## Input contract

Accept a ZIP or directory containing:

```text
mastergo-pages.json
pages/<page-id>/00-input/raw.json
pages/<page-id>/00-input/asset-manifest.json
pages/<page-id>/00-input/export-options.json
pages/<page-id>/00-input/frame-screenshot.png
pages/<page-id>/00-input/assets/**
```

`mastergo-pages.json` uses `mastergo2html.page-bundle.v1`. Every page needs a unique `id`, explicit `route`, `name`, and `inputDir`. Treat the routes as editable intent: verify them with the user or the named engineering documents before final React implementation, especially for dynamic routes.

## Pipeline

### 1. Generate one HTML page per Frame

Read `../mastergo2html/mastergo2html_CLI.md`, run doctor, then generate:

```bash
npm run --silent cli -- generate-pages --input <page-bundle.zip-or-dir> --json
```

Use a timeout of at least 60 minutes. The batch record is saved under `.mastergo2html/page-batches/<batchId>/batch.json`. Retry failed pages from their `inputPath`; do not erase successful results or silently omit failures.

Verify every expected Frame has a successful page record, unique route, `inputPath`, `htmlPath`, and `outputDir`.

### 2. Establish the HTML fidelity gate

- Render each `05-output/index.html` at the corresponding `frame-screenshot.png` width and capture the full page.
- Compare every HTML screenshot directly against its Frame.
- Fix HTML generation issues before React migration. Record screenshots, diffs, and reports; never assume generator success means visual success.
- Treat the accepted HTML screenshot as a transition baseline only. The Frame remains authoritative.

### 3. Carry immutable inputs into the React workspace

Run `mergePrepareCommand` from the CLI result. It must pass each successful route's `outputDir` and `inputPath/frame-screenshot.png` to `prepare_inputs.py --require-frame-screenshot`. Verify `source-manifest.json` records screenshot path, dimensions, and hash for every route.

### 4. Build all React routes one-to-one

Read and invoke `../merge-html-to-next-app/SKILL.md`. Preserve each page's structure, assets, and scoped CSS first. Complete every route before extracting Header, Footer, or other shared components.

Before any React component synthesis, satisfy that skill's **style three-track precondition**: the React scaffold must have `tailwindcss` (+ its PostCSS plugin), `sass`, and `antd` installed (install any missing one now — e.g. `npm i -D sass @tailwindcss/postcss tailwindcss && npm i antd`). Do not begin the one-to-one React build until `npx tsc --noEmit` passes with all three available; the styles get migrated to the three tracks later (Step 7), but the deps must exist up front so the scaffold is ready for it.

### 5. Gate the initial React migration

Capture every React route and compare it both with its own Frame and with the accepted HTML render. Fix all route-level regressions before reuse or style modernization.

### 6. Extract shared components under regression

Analyze candidate components across all Frames. A shared component is accepted only when every consuming route still matches its own Frame after extraction. Use screenshot-proven props/variants where needed; never replace designed regions with generic placeholders.

### 7. Migrate engineering styles to the Tailwind + SCSS + Antd three-track split

Delegate to `../merge-html-to-next-app/SKILL.md` Step 7 (7.1 prerequisite check through 7.7 completion bar). In summary: classify every generated selector/interaction into Tailwind / SCSS Module / Ant Design using the decision table, migrate one track-batch at a time (globals → Tailwind → SCSS Modules → Antd), and re-run Frame-vs-React + HTML-vs-React comparisons after every ownership change. Do not introduce Antd global providers until the first behavior-heavy control is actually migrated, and check Antd preflight fallout across all routes. Keep `[data-style-source-node-id]` attributes until the selectors that use them are gone, then move provenance to the manifest. Report installed `tailwindcss/sass/antd` versions, route→track mappings, deferred batches, and any deviations in `docs/STANDARDS.md` / `docs/DECISIONS.md`.

### 8. Final Frame micro-adjustment and validation

Capture every final route, compare directly against each Frame, inspect diff images, fix remaining geometry/color/font/asset issues, then run structural validation with `--require-visual`, lint, typecheck, tests, and production build.

Report `batchId`, route-to-Frame-to-HTML mapping, React project path, all visual stages, thresholds, final report paths, validation results, and any blocked/failed pages.

## Guardrails

- Never merge multiple Frames into one raw HTML generation job. Each website Frame is an independent page input and job.
- Do not treat App multi-state Frames as website routes. App target exports remain one page with interaction states.
- Do not use iframes, HTML strings, or `dangerouslySetInnerHTML` as the final React migration.
- Do not mutate generated HTML source outputs while building the React project.
- Do not infer dynamic route semantics solely from Frame names; confirm or document the mapping.
- Do not declare completion without final Frame screenshots and passing visual reports for every route.
- Do not optimize component count at the expense of any Frame's visual result.

## Direct current-selection workflow

If the user says multiple website Frames are already selected in MasterGo, prefer the direct plugin bridge command instead of asking for a manually downloaded page-bundle ZIP:

```bash
npm run --silent cli -- generate-pages-from-mastergo --json
```

The MasterGo2HTML plugin window must remain open. The command collects the current multi-Frame selection into a persisted page bundle and then runs the normal per-page HTML batch. Continue with the React merge workflow using the returned `batch.json` and `mergePrepareCommand`.
