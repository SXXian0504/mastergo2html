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

## Decomposition order

1. Identify page landmarks: header, main, sections, footer, dialogs.
2. Compare all pages before extracting shared components.
3. Establish layout components and route skeletons.
4. Move page sections into route-aligned `in-page` components.
5. Move repeated content to typed constants; do not over-generalize one-off markup.
6. Add client boundaries for interactions only after the server structure renders.
7. Replace placeholder links and source script behavior.
8. Refine styles and responsive states after all routes coexist.

## Source-to-React rules

- `class` -> `className`; `for` -> `htmlFor`; void elements are self-closing.
- Remove generator-only `data-*` attributes unless they support traceability or testing.
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

A safe two-pass strategy:

1. Fidelity pass: scope each generated stylesheet to a unique route root and render the converted DOM.
2. Engineering pass: move common layout/type/color to Tailwind; retain only justified complex selectors/animations in SCSS Modules.

Never concatenate raw source styles without scoping. Preserve keyframe names and font-face declarations when using `scope_css.py`.

## Interaction migration

Inventory forms, buttons, menus, carousels, tabs, filters, accordions, hover/focus states, and script listeners. For each interaction, decide:

- Server-only navigation/content;
- small Client Component with local state;
- client request via same-origin BFF and query library;
- intentionally disabled pending product behavior.

Document anything not implemented and make its disabled state accessible.
