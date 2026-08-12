---
name: mastergo2html
description: Convert MasterGo frames or 00-input exports into HTML/CSS/JS by using the local mastergo2html CLI. For current selections, first read the selected Frame with MasterGo MCP get_selection_node, then use Magic MCP getDesignSections. Use when the user asks Codex to generate HTML from a MasterGo frame/page, use the current MasterGo selection, convert a 00-input.zip export, process an exported 00-input directory, or inspect/check the local MasterGo2HTML CLI path.
---

# Mastergo2html

## Default Workflow: Legacy CLI + Codex SDK

Use the local repository CLI to control the complete legacy analysis and generation workflow. Set `LLM_BACKEND=codex-sdk` so every model-backed phase uses an independent Codex SDK thread as a text-only backend. The CLI is not assumed to be installed globally; run it from the project root with `npm run --silent cli -- ...`.

This route uses the local Codex CLI login and does not require `OPENAI_API_KEY`. Verify it before generation:

```bash
LLM_BACKEND=codex-sdk npm run --silent cli:doctor -- --json
```

```text
input adapter -> normalize-raw -> layout-analysis
  -> component/static-asset/interaction analyses
  -> plan-and-generate
  -> validation + 05-output publication
```

1. For one selected Frame, run `generate-from-mastergo`; for an existing `00-input`, run `generate --input`.
2. For multiple Frames, run `generate-from-mastergo` and let it auto-detect the page bundle, or run `generate-pages --input` for an existing bundle.
3. Apply the complete timeout prefix below to generation, resume, and retry commands.
4. Preserve and retry the same `jobId` or `batchId`; do not switch to the direct Agent workflow as error recovery.
5. Report `jobId`, `outputDir`, `htmlPath`, `zipPath`, and validation. For a page bundle also report `batchId`, quality-gate state, and per-route status.

## Codex SDK Backend Policy

This policy applies to the default `generate*`, `resume-pages`, and `retry` route.

Use this backend configuration. `CODEX_MODEL` may remain empty to use the local Codex default model:

```dotenv
LLM_BACKEND=codex-sdk
CODEX_MODEL=
CODEX_REASONING_EFFORT=high
CODEX_SANDBOX_MODE=read-only
CODEX_REUSE_THREAD=true
```

Hard rule for this workflow: keep `LLM_BACKEND=codex-sdk` on every initial, resume, and retry command. Do not silently switch to an OpenAI-compatible/Anthropic backend or to the direct Codex Agent workflow when the SDK is overloaded, slow, or temporarily unavailable. Recovery must reuse the existing job and backend through the CLI retry commands.

## Legacy Command Timeout Policy

For every CLI command that can enter a model-backed phase, use this complete timeout prefix:

```bash
LLM_CONNECT_TIMEOUT_MS=900000 \
LLM_IDLE_TIMEOUT_MS=900000 \
LAYOUT_ANALYSIS_TIMEOUT_MS=2400000 \
PAGE_PLAN_TIMEOUT_MS=2400000 \
PLAN_AND_GENERATE_TIMEOUT_MS=2400000 \
LLM_BACKEND=codex-sdk \
npm run --silent cli -- <generate-resume-or-retry-command>
```

The connection and stream-idle windows are both 15 minutes. They are independent: after the first SDK or gateway event, the connection timer no longer protects a long silent reasoning interval, so never set `LLM_CONNECT_TIMEOUT_MS` without also setting `LLM_IDLE_TIMEOUT_MS`.

The three phase-specific variables give each model-backed phase a 40-minute total timeout. `PAGE_PLAN_TIMEOUT_MS` covers the page-plan analyses, including `component-structure-analysis`; the other variables cover layout analysis and the combined planning/code-generation phase. Apply the complete prefix unchanged to initial generation and every retry.

MasterGo to HTML generation can spend more than 10 minutes in `plan-and-generate`. When Codex runs any foreground CLI command that may execute this phase, keep the tool call timeout above the 40-minute phase limit; use at least 50 minutes (`timeout_ms: 3000000`) and prefer 60 minutes (`timeout_ms: 3600000`) for very large frames or late-phase retries.

This applies to:

- `generate --source codex-mastergo`
- `generate-from-codex-mastergo`
- `generate --source magic-dsl`
- `export-from-magic-dsl` when only exporting a 00-input package
- `generate --input`
- `generate --source mastergo-mcp` or `generate-from-mastergo-mcp` when explicitly requested for diagnostics
- `generate-from-mastergo`
- `retry <jobId>` or `retry --latest`

If a Codex shell/tool call times out locally, do not assume the input must be collected again. First run `status <jobId>` or `status --latest`. If the job is `error` or stopped at a failed phase, directly continue with `retry <jobId>` using the same configured backend and the same extended command timeout.

For model overload, connection timeout, stream idle timeout, connection reset, 429, 502, 503, 504, and similar transient errors:

- run `npm run --silent cli -- retry <jobId> --json` immediately against the existing job;
- do not recollect the input or create a replacement job;
- do not switch away from Codex SDK or change execution mode;
- do not add an arbitrary fixed `sleep` before retrying—allow only the CLI's built-in retry/backoff policy to wait;
- stop and report the CLI error only after the documented retry limit is exhausted or the failure is non-recoverable.

## Codex App Hosted MasterGo Snapshot Workflow

Use this path only as a fallback or quality comparison path when the preferred MasterGo Magic DSL workflow cannot be used or when the user explicitly asks for the Codex hosted snapshot workflow. The Codex App managed MCP connection is responsible for syncing the selected frame/node to `.mastergo/design/...`; the repository CLI then reads that local snapshot and converts it into the standard `00-input` package before continuing the existing HTML generation pipeline.

Do not run this older direct-endpoint command as the default:

```bash
npm run --silent cli -- generate --source mastergo-mcp --mcp-url http://localhost:50678 --json
```

Before running the generation command, make sure:

1. MasterGo is open and connected to the Codex App managed MasterGo MCP.
2. The target Frame is selected in MasterGo, unless the user provides an exact `--node-id`.
3. Use tool discovery for the Codex App hosted MasterGo MCP, then call the hosted selection-sync tool (for example, `get_selection_node` when available) before running the CLI. This step should create or refresh files under `.mastergo/design/...`. This sync step is performed by the Codex App managed MCP, not by `npm run --silent cli -- generate --source mastergo-mcp --mcp-url http://localhost:50678 --json`.
4. If a previous snapshot exists, the CLI uses the newest matching `.html` snapshot. Pass `--node-id`, `--frame`, `--snapshot-html`, or `--design-root` when needed to select a specific snapshot.

Run:

```bash
npm run --silent cli -- generate --source codex-mastergo --json
```

Equivalent explicit command:

```bash
npm run --silent cli -- generate-from-codex-mastergo --json
```

When the user provides or asks to use an exact MasterGo node id:

```bash
npm run --silent cli -- generate --source codex-mastergo --node-id "<node-id>" --json
```

Use `--node-id` when available; it is more reliable than name matching. If no selector is provided, the CLI reads the newest hosted snapshot under `.mastergo/design`.

The hosted snapshot workflow first writes a generated `00-input` directory under `.mastergo2html/codex-mastergo/<timestamp>/00-input`, then runs the existing CLI analysis and HTML generation phases. The generated input should contain `raw.json`, `asset-manifest.json`, `export-options.json`, `frame-screenshot.png`, and optional `assets/**`.

Optional flags:

```bash
--design-root <dir>
--snapshot-html <file>
--screenshot <png>
--frame <frame-name>
--node-id <node-id>
--output <00-input-dir>
```

If generation fails with `没有找到 Codex MasterGo 快照 HTML`, use the Codex App managed MCP to sync the current selection to `.mastergo/design/...` first, then rerun `generate --source codex-mastergo`. If the user did not explicitly request the hosted snapshot path, return to the preferred Magic DSL workflow instead.

## MasterGo Magic DSL 00-input Workflow

Use this path by default for MasterGo frame/page/node HTML generation. It avoids the lossy `.mastergo/design` HTML snapshot reverse-parse path and preserves the `getDesignSections` fields that `magic-dsl-input` keeps for high-fidelity HTML generation.

Hard rule: use `mcp__getDesignSections` first. Do not use `mcp__getDsl` as the default source for page-level conversion. `getDsl` is allowed only if `getDesignSections` returns an error or the Magic MCP server version does not provide it.

Important boundary:

- The repository CLI cannot call `mcp__mastergo_magic_mcp` tools directly. Codex must call those MCP tools, save their raw responses to disk, then run the CLI converter on the saved package.
- For current-selection requests, Codex must call `mcp__mastergo.get_selection_node` first with the project root and `syncToBase: true` unless the user has provided a specific target. Treat that response as the selected Frame source of truth.
- Resolve the Magic MCP target from `get_selection_node` output before using Magic MCP. Prefer an explicit `shortLink` when present; otherwise use the selected document/file identifier as `fileId` and the selected root/frame node id as `layerId`. If the response includes a distinct `sourceLayerId`, pass it as `sourceLayerId`.
- The Magic DSL path needs a resolvable Magic MCP target: `shortLink`, or `fileId` + `layerId`/`sourceLayerId`. If a current-selection response does not contain enough information to resolve that target, ask the user for a MasterGo short link or exact `fileId` + `layerId`; do not silently switch to the hosted snapshot path.
- This path preserves DSL structure, text, colors, PATH nodes, image references, and source-node provenance better than HTML snapshot parsing.
- It still cannot fully replace legacy plugin runtime-only exports (`mg.getImageByHref(...)`, `node.exportAsync(...)`, render-bounds PNG/SVG slices) unless the Magic MCP data package includes the actual image/SVG files. Missing runtime-only resources are preserved in `asset-manifest.json` as `reference-only`.

First, resolve the Magic MCP target:

1. For the current selection, call `mcp__mastergo.get_selection_node`:

```json
{
  "projectDir": "<absolute-project-root>",
  "syncToBase": true
}
```

2. Inspect the returned selected Frame metadata and local `.mastergo` baseline information for `shortLink`, `documentId`/`fileId`, `rootId`, `nodeId`, `layerId`, or `sourceLayerId`.
3. Normalize the target for Magic MCP:
   - `shortLink` if available.
   - Otherwise `fileId` from `fileId` or `documentId`, and `layerId` from the selected Frame/root/node id.
   - Include `sourceLayerId` only when the selection response explicitly provides it.

Then fetch and save Magic DSL data with the MasterGo Magic MCP section workflow:

1. Call `mcp__getDesignSections` without `sectionIndex` to get the overview.
2. Save the exact response to:

```text
.mastergo2html/magic-dsl/<name>/source/overview.json
```

3. Read `totalSections` from the overview.
4. Call `mcp__getDesignSections` with every `sectionIndex` from `0` to `totalSections - 1`, in batches of 3-5 calls.
5. Save each exact response to:

```text
.mastergo2html/magic-dsl/<name>/source/sections/section-<index>.json
```

Do not skip any section. If `totalSections` is 48, save exactly 48 files from `section-0.json` through `section-47.json`. Fetch sections in batches of 3-5 MCP calls to avoid timeouts.

Optional resources:

```text
.mastergo2html/magic-dsl/<name>/source/svg-assets.json
.mastergo2html/magic-dsl/<name>/source/assets/img/**
.mastergo2html/magic-dsl/<name>/source/assets/icon/**
.mastergo2html/magic-dsl/<name>/source/frame-screenshot.png
```

`svg-assets.json` is an optional object mapping `svgShortKey` or `svgKey` to a real SVG string or `{ "svg": "<svg...>" }`. If SVG/image files are unavailable, the converter keeps manifest records as `reference-only` instead of fabricating assets.

### Static Resource Parity Gate

Magic DSL preserves structure and provenance, but it may not include the same runtime-exported files that the plugin can produce with `mg.getImageByHref(...)`, `node.exportAsync(...)`, original image export, and rendered node slices. Before generating final HTML from a Magic DSL package, always create or validate the standard `00-input` package and inspect `asset-manifest.json`.

Hard rules:

- If `asset-manifest.json` contains `status: "reference-only"` for any visible image, SVG, PATH icon, node slice, rendered slice, logo, background decoration, or masked composite, treat the package as resource-incomplete.
- Resource-incomplete Magic DSL packages are acceptable only for diagnostics, layout-only previews, or when the user explicitly accepts degraded assets.
- For plugin-equivalent visual output, first use the legacy MasterGo plugin export workflow to produce a plugin `00-input` package with real `assets/**`, then generate from that plugin package or use it to backfill the Magic DSL package before final generation.
- Do not fabricate missing images, icons, SVG paths, backgrounds, masks, or rendered slices in HTML/CSS. Missing runtime-only resources must remain transparent placeholders with source-node/asset metadata until a plugin/static package supplies the actual file.
- When comparing Magic DSL vs plugin quality, report both `assetCount` and the number of `reference-only` assets. A Magic DSL result with missing rendered slices should not be described as “plugin-equivalent”.
- SVG node slices must never include visible text. When exporting SVG for a PATH/vector icon, choose the smallest visible ancestor group/container that contains no `TEXT` descendants and whose visible tree is vector-only. If the nearest visual ancestor contains text, continue downward and export the smaller no-text group or the vector node itself. Navigation bars, buttons, tabs, menu rows, and other structural groups that contain text are review-only structure, not final SVG assets.

Suggested check after export:

```bash
npm run --silent cli -- validate-input --input .mastergo2html/magic-dsl/<name>/00-input --json
```

Then inspect the manifest:

```text
00-input/asset-manifest.json
```

If resource parity is required and the manifest still has `reference-only` assets, stop before final generation and run the Legacy MasterGo Plugin Export Workflow below while MasterGo and the local plugin window are open.

### Layout Fidelity Gate

For high-fidelity MasterGo restoration, the generated HTML must treat the design frame as the source coordinate system unless there is explicit source evidence for Auto Layout or flow.

Hard rules:

- Preserve the root frame width/height/minHeight/background from `rootMetadata` or `rootContainer`.
- Preserve every section bbox from the `getDesignSections` overview. Sections must be positioned relative to the root using their page-absolute `x`, `y`, `width`, and `height`; do not restack sections as a guessed column.
- Inside each section, preserve `layoutStyle.relativeX/relativeY`, `absoluteBoundingBox`, `absoluteRenderBounds`, `flexContainerInfo`, `layoutMode`, padding, gap, `flexGrow`, and `flexShrink` from the raw nodes.
- Use Flex/Grid only when the DSL or plugin raw data proves the container is Auto Layout, repeated grid/table structure, or a true document-flow group. Otherwise, use `position: relative` on the container and absolute children.
- Tables, sidebars, toolbars, pagination, icon buttons, switches, badges, overlays, decorative layers, masks, and small fixed controls should be source-bounds first. Do not “simplify” them into generic semantic blocks if it changes position or size.
- Banner/Hero foreground slices such as arrows, icons, title marks, and decorative composites must share the Banner source coordinate plane. Preserve their source `left/top/width/height` in px relative to the recorded anchor; do not replace those values with `right`, `bottom`, percentages, viewport units, Flex/Grid alignment, or independent responsive scaling.
- Display-critical text (Banner/Hero/brand/title text at 32px or larger) must preserve its source text box, font size, weight, line height, and alignment. When its source font is unavailable and the input contains a matching rendered group slice, use that slice as the only visible text visual while retaining the exact source text as visually-hidden accessible DOM. Do not allow fallback font metrics to reflow or overlap adjacent title nodes.
- Preserve root sibling drawing order for overlapping modules. Both sides of a cross-module overlap must establish isolated stacking contexts with explicit numeric `z-index`; the later source layer must have the larger value. In particular, a Hero/Banner image must never cover a later overlapping content panel's background, rounded corners, or content.
- Background decorations such as formula symbols, dotted patterns, circles, glows, masks, and decorative rendered slices are fixed relative to the page/module structure. Render them with source `left/top/width/height` in px inside a relative page/module wrapper. Do not convert them to `object-fit: cover`, `background-size: cover`, `inset: 0`, `width/height: 100%`, `vw/vh`, or breakpoint-specific repositioning. Only content photos/Banner images may use cover semantics.
- Responsive behavior is secondary. First match the desktop frame; only add conservative mobile rules after the desktop layout is locked.

Fallback only: if `mcp__getDesignSections` fails, call `mcp__getDsl` once and save the exact response to:

```text
.mastergo2html/magic-dsl/<name>/source/magic-dsl.json
```

Then run the same CLI converter with `--dsl-root .mastergo2html/magic-dsl/<name>/source` or pass the JSON file path directly. Report that the fallback was used and that section-level bbox/repeat metadata may be less complete than the preferred `getDesignSections` package.

Export standard 00-input only:

```bash
npm run --silent cli -- export-from-magic-dsl \
  --dsl-root .mastergo2html/magic-dsl/<name>/source \
  --output .mastergo2html/magic-dsl/<name>/00-input \
  --json
```

Validate and generate from that static input:

```bash
npm run --silent cli -- validate-input --input .mastergo2html/magic-dsl/<name>/00-input --json
npm run --silent cli -- generate --input .mastergo2html/magic-dsl/<name>/00-input --json
```

Equivalent one-step generation after saving DSL data:

```bash
npm run --silent cli -- generate --source magic-dsl \
  --dsl-root .mastergo2html/magic-dsl/<name>/source \
  --json
```

When reporting, include the converter result (`inputPath`, `assetCount`, `nodeCount`) and the final generation result (`jobId`, `htmlPath`, `outputDir`, `zipPath`).

## Direct MasterGo MCP Endpoint Workflow

Use this path only when the user explicitly asks to test the direct official MCP endpoint, compare quality, list MCP tools, or debug endpoint/key issues. It is no longer the default path for converting the current selection.

Before running the direct endpoint command, make sure:

1. MasterGo is open and connected to Codex through the official MasterGo MCP.
2. The official MCP local endpoint is reachable. The current default endpoint is `http://localhost:50678`.
3. The target Frame is selected in MasterGo, unless the user provides an exact `--node-id`.
4. If the official MCP endpoint requires a key, configure it globally for Codex or pass it with `--mcp-access-key`.

Inspect tools first when diagnosing endpoint behavior:

```bash
npm run --silent cli -- mcp:list-tools --mcp-url http://localhost:50678 --json
```

Run direct endpoint generation only when explicitly requested:

```bash
npm run --silent cli -- generate --source mastergo-mcp \
  --mcp-url http://localhost:50678 \
  --code-tool "<selection-tool>" \
  --image-tool "<selection-image-tool>" \
  --original-image-tool "<image-ref-export-tool>" \
  --node-slice-tool "<node-export-tool>" \
  --json
```

Optional flags:

```bash
--mcp-access-key <key>
--no-original-images
--no-rendered-slices
--output <00-input-dir>
```

If `mcp:list-tools` or `generate --source mastergo-mcp` fails because the spawned `@mastergo/vibe-mcp` process exits, tell the user to verify the Codex global MasterGo MCP configuration and access key. The Codex app may already have a working managed MCP connection, while this repository CLI still needs the same endpoint/key to spawn its own MCP client process.

## Static Input Workflow

Use this path when the user already has a static input package. Prefer a `*-00-input.zip` file. Also accept an already extracted `00-input/` directory.

Optionally validate the export before generation:

```bash
npm run --silent cli -- validate-input --input <00-input.zip-or-directory> --json
```

Generate with:

```bash
npm run --silent cli -- generate --input <00-input.zip-or-directory> --json
```

## Current-selection MasterGo Plugin Bridge Workflow

Use this path for a current selection when multiple website Frames may be selected, when the managed MCP cannot enumerate all selected Frames, or as a high-resource-parity fallback. The MasterGo plugin window must remain open because the plugin polls the local bridge for export requests.

```text
Codex CLI -> local bridge -> MasterGo plugin -> mg.document.currentPage.selection
  -> one visible node: 00-input -> one HTML job
  -> multiple visible Frames: mastergo-pages.json + one 00-input per Frame
  -> page-batch scheduler -> one independent HTML job per Frame
```

Before running the legacy command, make sure:

1. MasterGo is open.
2. The local MasterGo plugin window is open.
3. Select one full-page Frame or multiple visible website Frames. Every node in a multi-selection must be a Frame. `--frame` or `--node-id` forces a single target and therefore uses the single-page path.

Run the unified auto-detect command:

```bash
npm run --silent codex:generate-from-mastergo
```

When Codex runs this current-selection command, it must make this the first bridge-touching command and request scoped elevated execution immediately. Use the reusable prefix `["npm", "run", "--silent", "codex:generate-from-mastergo"]`; do not first retry inside the sandbox or infer Node socket access from `curl /health`. The wrapper injects the required Codex SDK backend/timeouts and defaults to `--export-timeout-ms 600000 --json`.

The bridge returns `inputKind: "single-page"` for one selected Frame and the CLI prints the normal `jobId`, `htmlPath`, `outputDir`, and `zipPath`. For multiple selected Frames it returns `inputKind: "page-bundle"`; the CLI writes `.mastergo2html/page-batches/<batchId>/batch.json` and runs one independent HTML generation job per Frame. The explicit `generate-pages-from-mastergo` command remains available when callers want to require a page bundle.

When the user names a frame:

```bash
npm run --silent codex:generate-from-mastergo -- --frame "<frame-name>"
```

When the user provides an exact MasterGo node id:

```bash
npm run --silent codex:generate-from-mastergo -- --node-id "<node-id>"
```

For manual bridge debugging only:

```bash
npm run mcp:dev
```

If the CLI reports `EPERM` or `EACCES`, treat it as a missing local-socket permission and rerun only through the scoped elevated wrapper after approval; do not restart the bridge. For an actual automatic bridge startup failure, tell the user to run `npm run mcp:dev` manually to inspect startup errors. If `generate-from-mastergo` times out, tell the user to keep the MasterGo plugin window open and select either one full-page Frame or multiple visible website Frames. If the bridge reports that auto Frame detection is unsupported, restart the bridge so `/health` advertises `mastergo-auto-frame-bundle-v1`.

## Task Management

Use these commands when needed:

```bash
npm run --silent cli -- list --json
npm run --silent cli -- status --latest --json
npm run --silent cli -- status <jobId> --json
npm run --silent cli -- cancel <jobId> --json
npm run --silent cli -- retry <jobId> --json
npm run --silent cli -- serve <jobId> --json
```

When the user wants to view the result, prefer the localhost preview server instead of opening `index.html` directly. Run `npm run cli -- serve <jobId>` in a foreground terminal and report the printed URL.

## Post-generation validation

After HTML generation, inspect `<jobDir>/05-output/static-validation.json` and report its errors, warnings, and responsive runtime findings. Preserve the generated files for preview, screenshot comparison, retry decisions, and downstream React conversion.

## Input Contract

The CLI D2C workflow consumes a `00-input` package. The input directory should contain:

```text
00-input/raw.json
00-input/asset-manifest.json
00-input/export-options.json
00-input/frame-screenshot.png
00-input/assets/**       # optional static assets
```

`asset-manifest.json` is the source of truth for resource paths. HTML generation must only reference resource paths that exist in the normalized asset index or manifest.

## Website Multi-Frame Page Bundle Workflow

When the MasterGo plugin exports multiple selected website Frames, it writes one page bundle instead of combining the Frames into one `raw.json`:

```text
mastergo-pages.json
pages/<page-id>/00-input/**
```

For a multi-page website, **collect/export every selected page input first**, then start generation once. Do not run a separate foreground CLI command for each Frame. The page-bundle scheduler owns page concurrency, model concurrency, retries, quality gating, pause, and resume.

Do not use website page bundles for App multi-state exports. App multi-state Frames remain one 00-input and one generated page.

### Required default scheduling policy

Unless the user explicitly requests another policy, use:

```text
page workers:                 2
process-wide model requests: 5 (hard maximum: 5)
transient retries per page:  2, exponential backoff + jitter
recovery:                    retry the existing jobId from its failed phase
quality gate:                2 representative pages, manual approval
fatal global error:          pause the batch immediately
repeated transient global error: pause after the configured threshold
```

The representative set prefers explicitly marked pages, the first page, and a page with high input complexity. The first CLI run generates only these representative pages. This is intentional: Codex must compare their generated HTML against each `frame-screenshot.png` before expanding to the remaining pages.

At batch startup, the CLI prints the effective page/model concurrency and where each value came from. Resolution order is:

```text
explicit CLI/API option
-> inherited batch.json value when resuming
-> environment variable
-> built-in default (2/5)
```

`batch.json` persists `schedulerDiagnostics`, `invocation`/`invocations`, and `schedulerRuntime`. Use these records to distinguish configured concurrency from the actual peak page/model concurrency observed during the run. A multi-page batch that resolves to `pageConcurrency=1` and `modelConcurrency=1` emits a `serial-multi-page-scheduler` warning before generation starts. Resume keeps the batch's existing scheduler settings unless `--page-concurrency` and/or `--model-concurrency` explicitly override them.

### Generate from an existing page bundle

Use a foreground timeout of at least 60 minutes:

```bash
npm run --silent cli -- generate-pages \
  --input <page-bundle.zip-or-directory> \
  --page-concurrency 2 \
  --model-concurrency 5 \
  --quality-gate-pages 2 \
  --page-retries 2 \
  --json
```

The normal first result is:

```json
{
  "status": "quality-gate",
  "qualityGate": {
    "status": "awaiting-approval"
  }
}
```

`quality-gate` is a successful checkpoint, not a CLI failure. Read `qualityGate.reviewPages`; inspect the representative `htmlPath` outputs and compare them with `frameScreenshotPath`. Check at least layout hierarchy, geometry, typography, colors, images, overflow, and interactive affordances.

If representative quality is acceptable, continue the same batch:

```bash
npm run --silent cli -- resume-pages <batchId> \
  --approve-quality \
  --json
```

Do not approve merely because static validation passed. Static validation only confirms that the output is structurally usable; the Frame screenshot remains the visual authority.

If representative quality is poor, fix the generation strategy/prompt/code first, then rerun only the representative pages from `plan-and-generate`:

```bash
npm run --silent cli -- resume-pages <batchId> \
  --retry-quality \
  --json
```

Review the regenerated representatives again. Do not allow the remaining pages to run until a later `quality-gate` checkpoint is explicitly approved.

### Codex-driven current multi-Frame selection

When the intended website Frames are selected and the MasterGo2HTML plugin window is open, prefer the unified command. It auto-detects one Frame versus multiple Frames and starts the correct generation path:

```bash
npm run --silent codex:generate-from-mastergo -- \
  --page-concurrency 2 \
  --model-concurrency 5 \
  --quality-gate-pages 2 \
  --page-retries 2 \
  --json
```

This command performs the full automated handoff:

```text
Codex CLI request
  -> local bridge creates one page-bundle export request
  -> open MasterGo plugin collects all selected website Frames and assets
  -> plugin exports mastergo-pages.json + pages/<id>/00-input/**
  -> bridge persists the complete page bundle
  -> two page workers run normal per-page jobs
  -> all model calls share a process-wide concurrency limit of five
  -> batch.json records checkpoints, jobIds, retries, routes, and outputs
```

Prerequisites:

- the intended Frames are selected in the current MasterGo page;
- every selected node is a visible `FRAME`;
- the MasterGo2HTML plugin window is open so it can poll the bridge request;
- the local bridge has been restarted after upgrading and advertises `mastergo-page-bundle-v1`.

Do not ask the user to manually download a ZIP when this direct bridge workflow is available. If the plugin window is closed or the bridge request times out, report that condition and fall back to the manually downloaded page-bundle ZIP with `generate-pages --input`.

### Pause, retry, and stage recovery

Each page persists its normal job under:

```text
.mastergo2html/page-batches/<batchId>/jobs/<jobId>/job.json
```

For timeout, connection reset, 429, 502, 503, 504, and similar transient errors, the scheduler waits with exponential backoff and retries the **same jobId from its failed phase**. It must not recollect the page input or restart completed phases.

If API authentication/configuration fails, Codex login is unavailable, or repeated global network/rate-limit failures indicate that continuing would damage the whole batch, the batch returns:

```json
{
  "status": "paused",
  "pause": {
    "category": "authentication-or-configuration"
  }
}
```

Diagnose and fix the shared cause, then continue without approving quality:

```bash
npm run --silent cli -- resume-pages <batchId> --json
```

If the batch returns `quality-failed`, use its normal `resume-pages <batchId>` recovery command. Pages that failed static validation are rerun from `plan-and-generate`; transport failures resume from their recorded failed phase. Approve only after a subsequent `quality-gate` checkpoint has been visually reviewed.

If the batch returns `partial`, successful page outputs remain preserved. Use `resume-pages` to retry failed pages from their existing jobs.

Useful explicit overrides:

```text
--retry-delay-ms <ms>
--global-error-threshold <n>
--auto-quality-gate       # only for trusted unattended runs
--no-quality-gate         # diagnostics only; not the default production flow
--fail-fast
```

The command creates `.mastergo2html/page-batches/<batchId>/batch.json`, preserves successful outputs, and returns `mergePrepareCommand` after pages are done. Only after the batch reaches `done` should Codex invoke the repository MasterGo2Code orchestration skill (`$mastergo2code`) or `HTML2React` skill (`$html2react`).
