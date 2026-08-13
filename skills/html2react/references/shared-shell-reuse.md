# Shared shell reuse gate

Apply this gate to every merge with two or more routes, in both `default` and `engineering` profiles. It implements the repository requirement that repeated Header, Nav, and Footer structures must become reusable React components without material style drift.

## 1. Build the family matrix

Inventory `header`, `nav`, and `footer` for every route after the one-to-one React baseline exists. Compare:

- semantic DOM order and landmark ownership;
- visible text, active state, optional actions, and link intent;
- asset identity and asset-root differences;
- outer/inner geometry, positioning context, stacking, and CSS specificity;
- desktop/mobile structure, menu state, keyboard behavior, and breakpoint resets;
- full-bleed background, centered inner container, and decorative clipping.

Classify each route/region as exactly one of:

- `shared`: belongs to a family used by at least two routes;
- `singleton`: no second compatible consumer exists;
- `incompatible`: superficially similar, but structural/behavioral differences cannot be expressed safely with bounded variants;
- `absent`: the route has no such region.

Do not use cosmetic class-name or source-node-ID differences as evidence of incompatibility. Active item, theme, text, asset root, optional content, and small layout variants normally become typed props, slots, tokens, or explicit variants.

## 2. Extract every reusable family

For every family with at least two consumers:

1. Create a component under `src/components/layouts/`, such as `SiteHeader`, `PrimaryNav`, or `SiteFooter`.
2. Move the common DOM and behavior into that component. Every listed consumer must import and render it; a component that exists but is unused does not satisfy the gate.
3. Keep route-specific facts in props or slots. Prefer bounded unions such as `variant: 'home' | 'content'` over boolean collections or route-name conditionals.
4. Preserve the original positioned parent and DOM order. Do not introduce wrappers that change containing blocks, flex/grid participation, overflow, stacking contexts, or selector specificity.
5. Keep source-node and asset trace attributes when CSS or validation still depends on them. Avoid forcing one route's asset files onto another route unless hashes prove them identical.
6. Share interaction logic with the markup when behavior is the same. Preserve same-DOM mobile navigation, `aria-expanded`, Escape/focus handling, and cross-breakpoint state reset.

## 3. Run blocking before/after regression

Capture only the affected shell region, not an approximate reconstruction:

```text
visual/shared-shell-before/<family>/<route-key>-<viewport>.png
visual/shared-shell-after/<family>/<route-key>-<viewport>.png
visual/shared-shell-after/<family>/<route-key>-<viewport>.json
visual/shared-shell-after/<family>/<route-key>-<viewport>.diff.png
```

Use identical route data, viewport, device scale, font state, animation disabling, and clip bounds before and after extraction. For MasterGo responsive-contract inputs, cover `390 / 768 / 1280 / 1920 / 2560`. Otherwise cover the source Frame width plus every breakpoint that changes the region's layout.

Run `compare_screenshots.mjs` with:

```bash
node scripts/compare_screenshots.mjs \
  --reference <before.png> \
  --actual <after.png> \
  --report <report.json> \
  --diff <diff.png> \
  --route <route> \
  --mode react-before-vs-react-after-shared-shell \
  --channel-threshold 16 \
  --max-changed-ratio 0.005
```

Dimensions must match and every report must pass. Use a stricter repository threshold when one exists. Do not relax the threshold to accept drift. Fix selector ownership, wrappers, props, assets, or responsive state; if safe parity is not achievable, revert that family and record each route as `incompatible` with concrete evidence.

## 4. Write `shared-shell-audit.json`

Use this schema:

```json
{
  "schema_version": 1,
  "required_viewports": [390, 768, 1280, 1920, 2560],
  "max_changed_ratio": 0.005,
  "regions": {
    "header": {
      "families": [
        {
          "id": "site-header-content",
          "classification": "parameterized",
          "component": "src/components/layouts/SiteHeader.tsx",
          "consumers": [
            { "route": "/news", "file": "src/components/in-page/news/NewsPage.tsx" },
            { "route": "/legal", "file": "src/components/in-page/legal/LegalPage.tsx" }
          ],
          "reports": [
            { "route": "/news", "viewport": 390, "path": "visual/shared-shell-after/site-header-content/news-390.json" }
          ]
        }
      ],
      "exceptions": [
        { "route": "/landing", "status": "incompatible", "reason": "Immersive overlay header uses a different DOM and focus model." }
      ]
    },
    "nav": { "families": [], "exceptions": [] },
    "footer": { "families": [], "exceptions": [] }
  }
}
```

Requirements:

- Cover every manifest route exactly once per region through a family consumer or exception.
- Use `classification: identical` or `parameterized` for a shared family.
- List at least two consumers per family.
- Use `status: singleton`, `incompatible`, or `absent` for exceptions and provide a concrete reason.
- Include one passing report for every family consumer at every required viewport.
- Store paths relative to the React project or as absolute paths.

Run:

```bash
python3 scripts/validate_project.py \
  --profile <profile> \
  --project <target-project> \
  --manifest <source-manifest.json> \
  --require-shared-shell-audit \
  --shared-shell-audit <shared-shell-audit.json>
```

Do not claim completion when the audit is missing, a reusable family remains duplicated, a listed consumer does not render the shared component, or any shell regression fails.
