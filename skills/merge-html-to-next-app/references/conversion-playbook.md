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

For dynamic routes, record at least one visual-test URL such as `/position/demo` in `conversion-plan.md`.

## Fidelity-first decomposition order

1. Identify page landmarks: header, main, sections, footer, dialogs.
2. Convert every page one-to-one and establish a passing React screenshot baseline before reuse work.
3. Compare all source implementations and Frame regions before extracting one shared component family.
4. Re-run every consuming route after each extraction; reject abstractions that introduce visual drift.
5. Move page sections into route-aligned `in-page` components and proven reuse into `universal/` or `layouts/`.
6. Move repeated content to typed constants only when order, text, and rendering remain exact.
7. Add client boundaries after the static structure passes visual comparison.
8. Replace placeholder links and source script behavior.
9. Migrate styles incrementally and run final Frame comparison after all routes coexist.

## Source-to-React rules

- `class` -> `className`; `for` -> `htmlFor`; void elements are self-closing.
- Do not remove generator attributes before checking CSS/runtime dependencies. Replace attribute selectors first, then remove pure provenance.
- Keep useful source-node provenance in the manifest/report rather than every DOM node.
- Convert repeated cards/list items to typed arrays and `.map()` only when it improves clarity.
- Keep static decorative images as `<img>` when intrinsic optimization adds no value; use `next/image` for meaningful raster content when dimensions and loading behavior are known.
- Avoid hydration differences: no random values, current time, viewport reads, or browser globals during server render.

## Assets

Namespace by page ID first to eliminate filename collisions:

```text
public/design/home/assets/...
public/design/position/assets/...
public/design/position-id/assets/...
```

Deduplicate only after hashing confirms identical bytes and imports are updated. Preserve fonts and licenses. Record missing/external assets.

## CSS migration

A safe three-pass strategy:

1. Fidelity pass: scope each generated stylesheet to a unique route root and render the converted DOM.
2. Reuse pass: extract one component family and visually recheck all consumers.
3. Engineering pass: move common layout/type/color to Tailwind; retain justified complex selectors/animations in SCSS Modules and recheck affected routes.

Never concatenate raw source styles without scoping. Preserve keyframe names and font-face declarations when using `scope_css.py`.

## Interaction migration

Inventory forms, buttons, menus, carousels, tabs, filters, accordions, hover/focus states, and script listeners. For each interaction, decide:

- Server-only navigation/content;
- small Client Component with local state;
- client request via same-origin BFF and query library;
- intentionally disabled pending product behavior.

Document anything not implemented and make its disabled state accessible.
