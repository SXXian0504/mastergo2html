# Conversion playbook

## Route manifest

Use one source entry per final route:

```json
{
  "pages": [
    { "page_id": "home", "route": "/home", "source_dir": "sources/home" },
    { "page_id": "position", "route": "/position", "source_dir": "sources/position" },
    { "page_id": "position-id", "route": "/position/[id]", "source_dir": "sources/position-id" }
  ]
}
```

Record at least one visual-test URL for every dynamic route.

## Default decomposition order

1. Identify page landmarks and route boundaries.
2. Convert every page one-to-one with page-specific React implementations; skip the optional JSX draft for ordinary pages.
3. Namespace assets by page ID and scope each generated stylesheet to its route root.
4. Add the smallest required client boundaries and migrate source interactions.
5. Build all routes together.
6. Run structural validation, lint, typecheck, tests when present, and production build.
7. Optionally capture each final route once for a non-blocking Frame comparison; report differences without editing or recapturing.

Default mode deliberately does not contain a shared-component pass, three-track style migration, intermediate React screenshot stages, or screenshot-driven repair rounds.

## Engineering decomposition order

After the one-to-one routes exist:

1. Establish a passing `react-initial` visual baseline.
2. Compare all source implementations and Frame regions before extracting one shared component family.
3. Re-run every consuming route after each extraction; reject abstractions that introduce drift.
4. Move proven reuse into `universal/` or `layouts/`.
5. Migrate styles in Tailwind, SCSS Module, and Ant Design batches.
6. Re-run affected routes after component/style ownership changes.
7. Run the final all-route Frame comparison and engineering audits.

See [engineering-profile.md](engineering-profile.md) for the complete opt-in workflow.

## Source-to-React rules

- `class` -> `className`; `for` -> `htmlFor`; void elements are self-closing.
- Do not remove generator attributes before checking CSS/runtime dependencies.
- Keep useful source-node provenance in the manifest/report rather than every DOM node.
- Convert repeated cards/list items to typed arrays and `.map()` only when it improves clarity; this is not a mandate to extract cross-route components.
- Keep static decorative images as `<img>` when intrinsic optimization adds no value; use `next/image` when dimensions and loading behavior are known.
- Avoid hydration differences from random values, current time, viewport reads, or browser globals during server render.

## Assets

Namespace by page ID first:

```text
public/design/home/assets/...
public/design/position/assets/...
public/design/position-id/assets/...
```

Deduplicate only after hashes prove identical bytes and imports are updated. Preserve fonts/licenses and record missing or external assets.

## CSS policy

Default:

1. Scope every generated stylesheet to a unique route root.
2. Preserve it as the primary fidelity source.
3. Make only targeted fixes required for React coexistence, responsiveness, or broken behavior.

Engineering:

1. Keep the scoped stylesheet for the fidelity baseline.
2. Extract shared components under regression.
3. Move ordinary rules to Tailwind, complex local rules to SCSS Modules, and suitable interaction controls to Ant Design.
4. Recheck affected routes after each migration batch.

Never concatenate raw source styles without scoping. Preserve keyframe names and font-face declarations when using `scope_css.py`.

## Interaction migration

Inventory forms, buttons, menus, carousels, tabs, filters, accordions, hover/focus states, and script listeners. For each interaction, choose:

- server-only navigation/content;
- a small Client Component with local state;
- a same-origin BFF request with client caching only when needed;
- an intentionally disabled, accessible state pending product behavior.

Document anything not implemented.

## Navigation and text completeness guardrails

Before converting placeholder links, create a route-intent table from the full clickable region and its product meaning. Do not infer routes from a single keyword: “实习生招聘” can be a recruitment card that belongs to the job list, while “实习生 Q&A” belongs to a Q&A route. Apply the table to cards, text links, buttons converted to links, desktop navigation, and mobile navigation.

A resolved anchor is authoritative. Delegated client handlers must let `<a href="/...">` navigate before generic `data-action` branches such as category/page selection call `preventDefault()`. Use buttons only for in-page state changes; use anchors for route changes.

When a source button/tab is converted into an anchor, do not assume the element swap is style-neutral. Explicitly reset anchor decoration and preserve the source hit-box layout (`display`, alignment, dimensions, and padding), otherwise labels can shift and browser underlines can leak through.

Verify hit testing, not just `href` presence. An anchor can be semantically correct but unclickable when a transparent absolute-positioned sibling or higher stacking context covers it. Keep route navigation above overlapping content, or make purely decorative/transparent overlays ignore pointer input with `pointer-events: none`. Remove stale pending/disabled route markers once an `href` is resolved.

Treat `data-text-source-node-id` as a content-completeness contract. If source HTML contains an empty tagged node, recover its exact characters from normalized `source-texts.json` using that node ID before JSX conversion. Do not assume that a successful build or visible background assets mean page content is complete.

Before completion, statically fail on:

- unresolved `href="#"` placeholders;
- empty paired elements carrying `data-text-source-node-id`;
- canonical navigation labels mapped to a route outside the route-intent table;
- shared click handlers that intercept resolved anchors;
- fixed root/page heights or trailing spacer elements that leave body-colored space after the footer.

For pages shorter than the viewport, prefer a `min-height: 100vh` flex-column shell with `main` absorbing spare height and the footer remaining the final in-flow element.
