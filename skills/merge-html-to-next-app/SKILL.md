---
name: merge-html-to-next-app
description: Merge multiple standalone HTML/CSS/JS page exports into one engineering-standard React website, using a modern stable Next.js App Router + TypeScript structure, shared layouts, route-aligned in-page components, isolated assets/styles, and validation. Use when Codex must combine several generated HTML pages or MasterGo HTML outputs into one React/Next.js project, infer or implement routes, deduplicate headers/footers, preserve visual fidelity and interactions, or migrate static pages under the repository's 官网工程规范.
---

# Merge HTML to Next App

Convert source pages without mutating them. Produce one maintainable Next.js App Router project rather than wrapping HTML strings or iframe pages.

## Required reading

1. If the user names engineering documents, read them first and treat them as canonical.
2. In this repository, read `docs/工程规范.md`; consult `docs/ARCHITECTURE.md`, `docs/STANDARDS.md`, `docs/ROUTES.md`, and `docs/DECISIONS.md` for inherited details.
3. Otherwise read [engineering-profile.md](references/engineering-profile.md) and [conversion-playbook.md](references/conversion-playbook.md).

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
  --page '/home=<html-output-dir>' \
  --page '/position=<html-output-dir>' \
  --page '/position/[id]=<html-output-dir>'
```

Review `source-manifest.json` and `source-inventory.md`. Resolve duplicate routes, ambiguous pages, missing assets, and external dependencies before conversion.

### 2. Plan the merged application

Write `conversion-plan.md` in the task workspace. It must cover:

- route-to-source mapping and dynamic-route sample URLs;
- global shell candidates such as Header, Footer, SEO, and providers;
- page-only sections versus genuinely reused components;
- asset collision strategy;
- CSS and interaction migration risks;
- acceptance commands and visual comparison targets.

Only promote a component to `universal/` after confirming use by at least two pages. Similar names are not proof; compare semantics, content, states, and responsive behavior.

### 3. Scaffold the target

- Use a currently supported stable Next.js release, App Router, TypeScript, `src/`, and `@/*` alias. Confirm current versions from official documentation or the package registry when creating a new project.
- Prefer the repository's existing package manager; otherwise choose one and document it.
- Use Server Components by default. Add `'use client'` only to the smallest component that requires state, effects, browser APIs, or event handlers.
- Keep `src/app/**/page.tsx` thin; compose page implementations from `src/components/in-page/**`.
- Create the directory boundaries described in [engineering-profile.md](references/engineering-profile.md).

### 4. Migrate structure, assets, styles, and behavior

- Convert semantic HTML to JSX. Do not use `dangerouslySetInnerHTML`, iframe wrappers, or runtime loading of the original HTML.
- The optional draft converter may accelerate mechanical work:

```bash
python3 scripts/html_to_jsx_draft.py \
  --manifest <task-workspace>/source-manifest.json \
  --output <task-workspace>/drafts
```

Drafts are temporary: refactor them into typed components, remove generator metadata that has no runtime value, repair accessibility, and implement real routes.

- Copy assets to `public/design/<page-id>/...`; rewrite URLs to root-relative `/design/<page-id>/...` paths. Never depend on another source page's relative directory.
- Use Tailwind for layout, spacing, typography, colors, and breakpoints. Use SCSS Modules only for complex animations, pseudo-selectors, nested selectors, or highly coupled legacy fidelity work. Use Ant Design only for suitable interactive controls such as Form, Modal, and Drawer.
- When preserving generated CSS for the first fidelity pass, scope it to a page root. Use `scope_css.py`, keep it in a clearly named migration stylesheet, then reduce it while componentizing. Do not merge unscoped generated stylesheets.
- Translate source JavaScript into React behavior. Replace DOM queries and global listeners with component state, refs, handlers, and effects. Every user-triggered async action needs loading feedback.
- Replace `href="#"` and pending actions with working internal routes, disabled controls, or explicit TODOs listed in the report; do not leave fake navigation silently active.

### 5. Respect data and BFF boundaries

- Static source data may start in typed constants.
- Browser components must not call backend microservice hosts directly. Use same-origin Route Handlers under `src/app/api/**/route.ts` or an approved Server Action boundary.
- Keep backend URLs and secrets in server-only configuration. BFF code handles authentication, backend errors, and response normalization such as `{ status, data?, msg? }`.
- Prefer Server Component fetching. Use TanStack Query only for client caching, polling, or user-driven requests.

### 6. Preserve project knowledge

Create or update:

- `docs/ARCHITECTURE.md`
- `docs/STANDARDS.md`
- `docs/ROUTES.md`
- `docs/DECISIONS.md`

Record route mappings, component boundaries, CSS migration decisions, source-page provenance, unresolved behavior, and any deliberate deviation from the engineering profile.

### 7. Validate and report

Run the structural validator before package commands:

```bash
python3 scripts/validate_project.py \
  --project <target-project> \
  --manifest <task-workspace>/source-manifest.json
```

Then run the project's install, lint, typecheck, test, and production build commands. If browser tooling is available, capture each route at the source viewport and compare against source screenshots or HTML renders.

Do not claim completion while required routes fail, assets 404, source interactions are missing without documentation, or validation/build errors remain. Use [acceptance-checklist.md](references/acceptance-checklist.md) for the final audit.
