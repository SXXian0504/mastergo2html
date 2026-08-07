# Visual fidelity workflow

## Authority order

1. The MasterGo `frame-screenshot.png` is the visual reference for its route; it becomes a blocking authority only in engineering or explicit visual-correction mode.
2. Raw node/style/asset facts explain the screenshot and help fix differences.
3. An accepted HTML render is an optional intermediate diagnostic; it never overrides the Frame.
4. Engineering conventions apply only when they do not change the required visual result.

## Default screenshot contract

Default mode does not require a passing visual gate. It may emit at most one informational React capture per route after all routes build and coexist:

```text
visual/react-final/<page-id>.png
visual/react-final/<page-id>.json
visual/react-final/<page-id>.diff.png
```

Use comparison mode `frame-vs-react-final`. Do not create `react-initial`, `react-post-reuse`, or per-style-batch captures in default mode. Do not inspect the result to trigger manual corrections or recapture. Record drift as a known deviation.

A prior final report may be reused when the route code, relevant assets/fonts, viewport/device scale, and manifest Frame hash are unchanged. If it is stale, either replace it with one new capture or omit visual reporting; never start a correction loop in default mode.

## Engineering screenshot stages

Engineering mode adds regression stages because it performs risky refactors:

```text
visual/html/<page-id>.png                 optional accepted HTML diagnostic
visual/react-initial/<page-id>.png        one-to-one React baseline
visual/react-post-reuse/<page-id>.png     after shared-component extraction
visual/react-post-style/<page-id>.png     after style ownership migration
visual/react-final/<page-id>.png          final implementation
```

Capture only affected routes after each bounded refactor batch, then capture all final routes once. Store reports/diffs beside screenshots. The final report name remains `<page-id>.json` for `validate_project.py --require-visual`.

## Capture contract

- Use the Frame width and full-page capture.
- Disable animations/transitions and wait for fonts, images, and network activity to settle.
- Use deterministic dynamic-route URLs and content.
- Record browser/device scale; do not compare different scale factors.
- Investigate width or full-page-height mismatches.

## Comparison contract

When a default one-shot report is requested, run `scripts/compare_screenshots.mjs` for machine-readable metrics and a visible diff. Record the threshold and deviations in `conversion-plan.md`; do not tune thresholds or edit React to force a pass. In engineering or explicit visual-correction mode, inspect and correct missing assets, shifted sections, clipping, wrong colors, text reflow, overlays, and footer/page-height drift.

## Engineering-only shared component gate

For each candidate component:

1. List every consuming route and source Frame region.
2. Compare structure, content, assets, dimensions, responsive rules, and interaction states.
3. Encode only observed differences as typed props, slots, tokens, or variants.
4. Capture every consuming route after extraction.
5. Compare each route against its own Frame.
6. Reject or revise the extraction if any consumer regresses.

## Trace attribute cleanup

- Keep `data-style-source-node-id` while generated CSS still selects it.
- Keep action/filter/test attributes with runtime value.
- Move pure provenance into manifests/reports only after dependent selectors are gone.
- Remove placeholder metadata after route/action resolution.
- In default mode, do not perform cleanup or code changes solely to trigger another screenshot; there is no visual repair loop.
