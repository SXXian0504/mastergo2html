# Visual fidelity workflow

## Authority order

1. The MasterGo `frame-screenshot.png` is the final visual authority for its route.
2. Raw node/style/asset facts explain the screenshot and help fix differences.
3. The accepted HTML render is an intermediate baseline for locating HTML-to-React drift; it never overrides the Frame.
4. Engineering conventions apply only when they do not change the required visual result.

## Required stages

Capture every page at these points:

```text
visual/html/<page-id>.png              generated HTML baseline
visual/react-initial/<page-id>.png     one-to-one React migration
visual/react-post-reuse/<page-id>.png  after shared component extraction
visual/react-final/<page-id>.png       final implementation
```

Store each comparison report and diff beside its screenshot. The final report name must be `<page-id>.json` so `validate_project.py --require-visual` can validate it.

## Capture contract

- Use the Frame screenshot width as the browser viewport width.
- Capture the full page with animations and transitions disabled.
- Wait for fonts, images, and network activity to settle.
- Use a deterministic dynamic-route sample URL.
- Record browser/device scale and do not compare screenshots captured with different scale factors.
- Treat width or full-page-height mismatch as a visual failure to investigate.

## Comparison contract

Run `scripts/compare_screenshots.mjs` for machine-readable metrics and a visible diff. Set `--mode` to the stage, for example `frame-vs-html`, `html-vs-react-initial`, `frame-vs-react-post-reuse`, or `frame-vs-react-final`.

There is no universal acceptable changed-pixel ratio. Record a project threshold in `conversion-plan.md` before final validation, account for font anti-aliasing, and do not loosen it merely to make a report pass. A metric pass still requires inspection for missing assets, shifted sections, clipping, wrong colors, text reflow, overlays, and footer/page-height drift.

## Shared component gate

For each candidate component:

1. List every route and source node/frame region that would consume it.
2. Compare structure, content, assets, dimensions, responsive rules, and interaction states.
3. Preserve common structure and encode only observed differences as typed props, slots, tokens, or variants.
4. Capture all consuming routes after extraction.
5. Compare each route directly against its own Frame, not against another route.
6. Reject or revise the extraction if any consumer regresses.

Reuse is an implementation property, not a visual compromise. Components that look identical in the Frames must remain identical; screenshot-proven differences must also remain exact.

## Trace attribute cleanup

- Keep `data-style-source-node-id` while generated CSS still selects it.
- Keep action/filter/test attributes that have runtime value.
- Move pure provenance (`data-source-node-id`, `data-text-source-node-id`, `data-asset-id`) into the source manifest or reports after visual stabilization.
- Remove placeholder metadata such as `data-pending-url` after route/action resolution.
- Run final Frame comparison after cleanup.
