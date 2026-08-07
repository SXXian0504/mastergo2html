---
name: mastergo2code
description: Run the MasterGo multi-Frame pipeline from design inputs to per-Frame HTML and a route-aware Next.js React project. Defaults to a fast one-to-one React conversion with no screenshot-driven repair loop; use engineering mode only when the user explicitly requests visual correction, shared-component extraction, Tailwind/SCSS/Ant Design migration, or release-grade visual regression.
---

# MasterGo2Code

Orchestrate `MasterGo Frame -> HTML -> React project`. Each Frame remains an independent page truth source.

## Profile contract

Use `default` unless the user explicitly requests `engineering` mode, pixel-level visual correction, design-system/style modernization, shared-component extraction, or release-grade visual regression.

- `default`: preserve page-specific structure and scoped generated CSS, convert routes one-to-one, and do not run screenshot-driven React correction rounds. A single final Frame-width capture/report is informational and non-blocking.
- `engineering`: after the one-to-one baseline, extract shared components, migrate styles to Tailwind + SCSS Modules + Ant Design, and run visual correction/regression screenshots before and after those refactors.

Do not ask which profile to use on every run. Do not install three-track dependencies or perform reuse analysis in `default` mode.

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

`mastergo-pages.json` uses `mastergo2html.page-bundle.v1`. Every page needs a unique `id`, explicit `route`, `name`, and `inputDir`. Treat routes as editable intent; verify dynamic-route mappings before final implementation.

## Responsive contract handoff

The responsive knowledge distilled in `docs/RESPONSIVE_DESIGN_PROMPT_PLAYBOOK.md` applies to this entire pipeline, not only to the HTML generation step. `mastergo2html` is the source of the page-level responsive contract; React conversion must preserve that contract rather than redesigning it during migration.

- Carry `mastergo2html.responsive-contract.v1` from the HTML/page-layout result into `conversion-plan.md` and the React validation context.
- Preserve the five HTML-stage viewports: `390 / 768 / 1280 / 1920 / 2560`, plus the required `Header / Nav / Main / Footer` checks. In default React conversion, inherit the passing HTML result instead of re-running a five-viewport screenshot suite.
- Treat the generated HTML responsive runtime result as an input quality gate. If it fails, fix or report the HTML stage before React conversion; do not hide the failure through React-only CSS changes.
- During React migration, preserve the same-DOM mobile navigation behavior, content-driven narrow Header height, centered Footer inner container, full-bleed wide Header/Footer shells, source-bounds decorative assets, and the no-horizontal-scrolling tolerance.
- Default React validation relies on preserved DOM/CSS plus lint, typecheck, structural validation, and production build. Run five-viewport React screenshot inspection only when the user explicitly requests visual correction or `engineering` mode.

### Default pipeline

### 1. Generate one HTML page per Frame

Read `../mastergo2html/mastergo2html_CLI.md`, run doctor, then generate:

```bash
npm run --silent cli -- generate-pages --input <page-bundle.zip-or-dir> --json
```

Use a timeout of at least 60 minutes. The batch record is saved under `.mastergo2html/page-batches/<batchId>/batch.json`. Retry failed pages from their `inputPath`; preserve successful results and never silently omit failures.

Model recovery policy for the HTML stage:

- Set `LLM_CONNECT_TIMEOUT_MS=120000` for every model-backed MasterGo CLI command. Allow the configured model gateway up to 120 seconds to establish a connection; never use a shorter connect timeout. Only after the full 120 seconds should a missing connection be handled as a recoverable timeout on the existing job.
- **Never use or switch to the Codex SDK backend.** Do not set `LLM_BACKEND=codex-sdk` and do not invoke the local Codex CLI as a fallback for page generation.
- Keep the backend that passed `cli:doctor`. For overload, connection timeout, idle timeout, connection reset, 429, or 5xx failures, directly retry the existing page job with `npm run --silent cli -- retry <jobId> --json`; for a page batch, use its documented `resume-pages <batchId>` recovery so failed pages resume their existing jobs.
- Reuse the same `jobId`/`inputPath` and resume from the failed phase. Do not recollect the MasterGo selection, create replacement jobs, switch backends, or add a fixed `sleep` before retrying. Use a timeout of at least 60 minutes and let only the CLI scheduler perform backoff.

Verify every expected Frame has a successful page record, unique route, `inputPath`, `htmlPath`, and `outputDir`.

### 2. Establish or reuse the HTML fidelity result

Use an existing valid HTML-vs-Frame screenshot/report when it belongs to the same immutable input and output hashes. Otherwise render each `05-output/index.html` at its Frame width and compare it with `frame-screenshot.png` once. Fix HTML generation issues before React migration. The Frame remains authoritative.

### 3. Carry immutable inputs into the React workspace

Run `mergePrepareCommand` from the CLI result. It must pass every successful route's `outputDir` and `inputPath/frame-screenshot.png` to `prepare_inputs.py --require-frame-screenshot`. Verify `source-manifest.json` records screenshot path, dimensions, and hash for every route.

### 4. Build React routes one-to-one

Invoke `../html2react/SKILL.md` with profile `default`.

- Preserve each page's DOM structure, assets, interactions, and scoped generated CSS.
- Keep route implementations page-specific; do not schedule Header/Footer/common-component extraction.
- Install only dependencies required by the converted pages. Tailwind, Sass, and Ant Design are not default prerequisites.
- Do not create an intermediate React screenshot baseline solely to support later refactors.

### 5. Validate once and emit an informational final report

After all routes build and coexist:

1. Run structural validation with `--profile default` **without** `--require-visual`.
2. Run lint and production build. Do not run a separate `typecheck` command by default because `next build` already performs the TypeScript check; run it separately only when the build is unavailable or explicitly requested.
3. Skip `html_to_jsx_draft.py` unless the source page is unusually large or mechanically difficult.
4. Capture each final route at its Frame width only when a visual report is requested; otherwise omit React screenshots entirely. If captured, generate at most one informational `frame-vs-react-final` report.
5. Do not inspect the diff to start another React edit/capture cycle. Do not manually correct screenshot drift in default mode. Record visual differences as known deviations instead.
6. If the one-shot capture/report fails, report that failure without blocking delivery of an otherwise valid build.

Only enter a visual correction loop when the user explicitly asks for pixel-level/high-fidelity correction, visual regression, or `engineering` mode.

Report `batchId`, route-to-Frame-to-HTML mapping, React project path, any final report paths, structural/build validation results, visual deviations, and blocked/failed pages.

## Engineering extension

Run this extension only for profile `engineering`:

1. Invoke `../html2react/SKILL.md` with profile `engineering`.
2. Establish a passing one-to-one React baseline before refactors.
3. Extract shared component families and recheck every consuming route after each extraction batch.
4. Migrate styles to Tailwind + SCSS Modules + Ant Design according to `../html2react/references/engineering-profile.md`.
5. Re-capture affected routes after component/style ownership changes and run the final all-route Frame comparison.
6. Run structural validation with `--profile engineering --require-visual` plus the engineering style/dependency audit.

## Guardrails

- Never merge multiple Frames into one raw HTML generation job. Each website Frame is an independent page input and job.
- Do not treat App multi-state Frames as website routes. App target exports remain one page with interaction states.
- Do not use iframes, HTML strings, or `dangerouslySetInnerHTML` as the final React migration.
- Do not mutate generated HTML source outputs while building React.
- Do not infer dynamic route semantics solely from Frame names; confirm or document the mapping.
- Default mode forbids screenshot-driven repair loops. A final Frame report, when generated, is informational and does not need to pass; only explicit visual-correction or `engineering` requests make visual fidelity a blocking gate.

## Direct current-selection workflow

If multiple website Frames are already selected in MasterGo, prefer the direct plugin bridge command:

```bash
npm run --silent cli -- generate-pages-from-mastergo --json
```

The MasterGo2HTML plugin window must remain open. Continue with the returned `batch.json` and `mergePrepareCommand`, using `default` profile unless engineering mode was explicitly requested.

## 跨阶段装饰视觉约束

HTML 首次生成与 React 迁移统一遵循[装饰光晕 SVG 首次生成约束](../../docs/DECORATIVE_GLOW_SVG_PLAYBOOK.md)。上游应输出独立光晕 SVG/波点切片，React 阶段必须原样继承完整画布与 source coordinate system。

本规则不仅适用于 MasterGo2HTML 生成阶段，也适用于 HTML 到 React 的迁移阶段：光晕、波点、模糊圆、阴影和背景渐变属于不可变的视觉事实，React 转换不得因组件化、CSS scope、资源搬迁或样式迁移而改变其画布尺寸、比例、位置、层级或裁切边界。

- 保留装饰资源文件的真实 `width`、`height`、`viewBox` 和 filter/blur bleed；不得把 SVG 画布压回设计节点的 nominal 尺寸。
- 需要溢出父容器后裁切的装饰必须保留明确 `width`/`height`、`flex: none`、`max-width: none`，并由父容器 `overflow` 裁切；不得被 React 全局样式、Flex shrink、`object-fit` 或 `background-size` 二次压缩。
- 默认模式下不得重绘或抽象这类装饰；应原样保留生成 HTML 的 DOM、资源引用和 scoped CSS。Engineering 模式下只有在截图证明视觉等价后才允许提取共享装饰组件。
- 默认模式只允许在 React 完成后按同一 Frame 视口生成一次非阻塞截图/报告，不根据 diff 继续人工修正或重复截图。只有用户明确要求视觉修正或 `engineering` 模式时，才复核并修正颜色覆盖面积、核心位置和裁切边界。
