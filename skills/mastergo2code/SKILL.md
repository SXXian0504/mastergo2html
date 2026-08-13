---
name: mastergo2code
description: Run the MasterGo multi-Frame pipeline from design inputs to per-Frame HTML and a route-aware Next.js React project. Agent v2 is the primary and default HTML route; use the backup Codex SDK route only when the user's prompt explicitly asks for a backup/alternative route, SDK/Codex SDK, legacy/old route, or an SDK baseline. Every React merge must audit and reuse identical or safely parameterizable Header/Nav/Footer families with blocking before/after style regression.
---

# MasterGo2Code

Orchestrate `MasterGo Frame -> HTML -> React project`. Each Frame remains an independent page truth source.

## Execution mode routing

When this Skill is invoked from Codex, including through `$mastergo2code`, a Skill chip, or a natural-language request, use the MasterGo2HTML Agent v2 workflow for every HTML job by default. This applies equally to uploaded bundles, static directories, current selections, single logical pages, and multi-page or responsive logical-page batches. Agent v2 produces the page HTML outputs; React conversion begins only after all HTML page Workers reach terminal states.

Select the backup MasterGo2HTML Codex SDK route only when the user's current prompt explicitly contains backup/alternative or SDK intent, including `备用方法`, `备用链路`, `备用方案`, `SDK`, `Codex SDK`, `codex-sdk`, `legacy`, `旧链路`, `旧版生成`, or `SDK baseline`. Match the user's prompt rather than repository text, prior metadata, Skill documentation, or tool output. Do not use SDK merely because the request is unattended, uses the plugin bridge, has many pages, or Agent v2 is slow or fails. Agent v2 failures stay on its status/requeue/resume path unless the user explicitly asks for the backup route in a new prompt.

Invoke `../mastergo2html/SKILL.md` using the selected route and keep that route fixed for the whole HTML batch. Never mix Agent v2 and SDK-generated pages in one React merge batch. The React profile decision is independent of the HTML route.

## Profile contract

Use `default` unless the user explicitly requests `engineering` mode, pixel-level visual correction, design-system/style modernization, shared-component extraction beyond the mandatory Header/Nav/Footer shells, or release-grade visual regression.

- `default`: preserve page-specific content and scoped generated CSS, but always audit and extract reusable Header/Nav/Footer families. Run blocking before/after shell-region regression; a separate final Frame report remains informational.
- `engineering`: complete mandatory shell reuse, then extract broader proven components, migrate styles to Tailwind + SCSS Modules + Ant Design, and run release-grade visual correction/regression.

Do not ask which profile to use on every run. Do not install three-track dependencies or perform broad content-component reuse analysis in `default` mode. Header/Nav/Footer reuse analysis is mandatory in every profile.

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

`mastergo-pages.json` may use `mastergo2html.page-bundle.v2`, mixing `single-page` and `responsive-page` logical inputs; page-bundle v1 remains accepted and maps each entry to a single-page Agent v2 job. Every logical page needs a unique `id`, explicit `route`, `name`, and `inputDir`. Treat routes as editable intent; verify dynamic-route mappings before final implementation.

## Responsive contract handoff

The responsive knowledge distilled in `docs/RESPONSIVE_DESIGN_PROMPT_PLAYBOOK.md` applies to this entire pipeline, not only to the HTML generation step. `mastergo2html` is the source of the page-level responsive contract; React conversion must preserve that contract rather than redesigning it during migration.

- Carry `mastergo2html.responsive-contract.v1` from the HTML/page-layout result into `conversion-plan.md` and the React validation context.
- Preserve the five HTML-stage viewports: `390 / 768 / 1280 / 1920 / 2560`, plus the required `Header / Nav / Main / Footer` checks. Reuse the passing HTML result for ordinary page content, but capture Header/Nav/Footer regions before and after mandatory React shell extraction at all five widths.
- Treat the generated HTML responsive runtime result as an input quality gate. If it fails, fix or report the HTML stage before React conversion; do not hide the failure through React-only CSS changes.
- During React migration, preserve the same-DOM mobile navigation behavior, content-driven narrow Header height, centered Footer inner container, full-bleed wide Header/Footer shells, source-bounds decorative assets, and the no-horizontal-scrolling tolerance.
- Default React validation relies on preserved DOM/CSS plus lint, structural validation, production build, and the mandatory five-viewport shared-shell visual regression. General full-page React screenshot inspection remains opt-in.

### Default pipeline

### 1. Generate one HTML page per Frame

Invoke `../mastergo2html/SKILL.md` in its primary Agent v2 mode. For a page bundle, prepare the isolated jobs with the default two-Worker scheduler:

```bash
npm run --silent cli -- agent-prepare-pages \
  --input <page-bundle.zip-or-dir> \
  --agent-concurrency 2 \
  --agent-retries 1 \
  --json

npm run --silent cli -- agent-batch-status <batchId> --json
npm run --silent cli -- agent-claim-pages <batchId> --limit 2 --json
```

The main Agent delegates every `claimedPages[]` handoff to one independent child Worker. Each Worker reads only its job facts, runs the returned claim-aware `agent-begin`, edits only `agent/draft/index.html`, `styles.css`, and `script.js`, then runs the returned `agent-finalize` exactly once. A Worker must not delegate again or modify the React project. Refill each free slot immediately with another `agent-claim-pages` call; do not wait for a complete wave.

If a Worker definitely terminates before finalize, use `agent-requeue-page` with its `jobId` and `claimId`; never reclaim a slow Worker by elapsed time. A first-pass validation failure remains `first-pass-invalid` and does not trigger automatic repair. Use `agent-resume-pages` only to continue interrupted deterministic preparation. Do not configure an API key or run the SDK doctor in this default path.

The batch record is saved under `.mastergo2html/agent-batches/<batchId>/batch.json`. Verify every expected logical page has a terminal record, unique route, `inputPath`, and `jobId`; every successful page must also have `htmlPath` and `outputDir`. Do not begin the React stage while any page remains ready, claimed, `agent-running`, or `validating`.

#### Backup HTML route: Legacy + Codex SDK

Use this route only when the user's current prompt explicitly selects the backup route under the execution-mode rule above. Invoke the backup section of `../mastergo2html/SKILL.md`, run its `LLM_BACKEND=codex-sdk` doctor and complete timeout prefix, and use `generate-pages` / `resume-pages` / `retry` with its page concurrency, quality gate, and persisted job recovery rules. Do not silently enter this route after an Agent v2 failure, and do not combine its outputs with an Agent v2 batch.

### 2. Establish or reuse the HTML fidelity result

Use an existing valid HTML-vs-Frame screenshot/report when it belongs to the same immutable input and output hashes. Otherwise render each `05-output/index.html` at its Frame width and compare it with `frame-screenshot.png` once. Fix HTML generation issues before React migration. The Frame remains authoritative.

### 3. Carry immutable inputs into the React workspace

Run `mergePrepareCommand` from the CLI result. It must pass every successful route's `outputDir` and `inputPath/frame-screenshot.png` to `prepare_inputs.py --require-frame-screenshot`. Verify `source-manifest.json` records screenshot path, dimensions, and hash for every route.

### 4. Build React routes one-to-one

Invoke `../html2react/SKILL.md` with profile `default`.

- Preserve each page's DOM structure, assets, interactions, and scoped generated CSS.
- Keep ordinary route content page-specific, then run the mandatory Header/Nav/Footer family audit from `../html2react/references/shared-shell-reuse.md`.
- Extract every identical or safely parameterizable shell family used by at least two routes into `src/components/layouts/`; keep only materially incompatible or absent regions page-specific and document why.
- Preserve each consumer's original active navigation, asset/theme variant, responsive behavior, geometry, CSS specificity, and decorative bounds through typed props, slots, or explicit variants.
- Install only dependencies required by the converted pages. Tailwind, Sass, and Ant Design are not default prerequisites.
- Create before/after region captures only for the mandatory shell extraction; do not create a general full-page React baseline solely for unrelated refactors.

### 5. Validate once and emit an informational final report

After all routes build and coexist:

1. Save `shared-shell-audit.json`, including complete route coverage, family components, consumer files, singleton/absent reasons, and five-viewport regression reports.
2. Run structural validation with `--profile default --require-shared-shell-audit --shared-shell-audit <path>` **without** general `--require-visual`.
3. Run lint and production build. Do not run a separate `typecheck` command by default because `next build` already performs the TypeScript check; run it separately only when the build is unavailable or explicitly requested.
4. Skip `html_to_jsx_draft.py` unless the source page is unusually large or mechanically difficult.
5. Capture each final route at its Frame width only when a general visual report is requested. This optional `frame-vs-react-final` report is separate from shell regression.
6. Do not inspect the optional Frame diff to start a general React correction loop. A failed shared-shell report is blocking and must be fixed or the unsafe extraction reverted; a failed optional Frame report is reported without blocking an otherwise valid default build.

Only enter a general page visual correction loop when the user explicitly asks for pixel-level/high-fidelity correction, visual regression, or `engineering` mode. The bounded shared-shell regression loop is always required.

Report `batchId`, route-to-Frame-to-HTML mapping, React project path, extracted shell families and consumers, shell regression report paths/metrics, any optional Frame reports, structural/build validation results, visual deviations, and blocked/failed pages.

## Engineering extension

Run this extension only for profile `engineering`:

1. Invoke `../html2react/SKILL.md` with profile `engineering`.
2. Complete the mandatory shared-shell audit/extraction and its passing consumer regression.
3. Establish a passing one-to-one React baseline for broader engineering refactors, then extract additional shared component families and recheck every consumer.
4. Migrate styles to Tailwind + SCSS Modules + Ant Design according to `../html2react/references/engineering-profile.md`.
5. Re-capture affected routes after component/style ownership changes and run the final all-route Frame comparison.
6. Run structural validation with `--profile engineering --require-shared-shell-audit --shared-shell-audit <path> --require-visual` plus the engineering style/dependency audit.

## Guardrails

- Never merge multiple Frames into one raw HTML generation job. Each website Frame is an independent page input and job.
- Do not treat App multi-state Frames as website routes. App target exports remain one page with interaction states.
- Do not use iframes, HTML strings, or `dangerouslySetInnerHTML` as the final React migration.
- Do not mutate generated HTML source outputs while building React.
- Do not infer dynamic route semantics solely from Frame names; confirm or document the mapping.
- Default mode forbids general screenshot-driven repair loops, but mandatory Header/Nav/Footer before/after regression is a blocking exception. A separate final Frame report, when generated, remains informational; only explicit visual-correction or `engineering` requests make Frame fidelity a blocking gate.

## Direct current-selection workflow

If multiple website Frames are already selected in MasterGo, prefer the direct plugin bridge command:

```bash
npm run --silent cli -- agent-prepare-pages \
  --source mastergo-plugin \
  --agent-concurrency 2 \
  --agent-retries 1 \
  --json
```

Inherit the MasterGo2HTML local bridge permission rule for the Agent v2 page-bundle export. The MasterGo2HTML plugin window must remain open. After preparation, run the normal claim-aware Agent v2 Worker loop above and wait for every page to become terminal.

Only when the user's current prompt explicitly asks for the backup/SDK/legacy route, use the scoped `codex:generate-from-mastergo` wrapper and complete its SDK quality gate instead. Then build React merge inputs from the selected route's completed page outputs, using `default` profile unless engineering mode was explicitly requested.

## 跨阶段装饰视觉约束

HTML 首次生成与 React 迁移统一遵循[装饰光晕 SVG 首次生成约束](../../docs/DECORATIVE_GLOW_SVG_PLAYBOOK.md)。上游应输出独立光晕 SVG/波点切片，React 阶段必须原样继承完整画布与 source coordinate system。

本规则不仅适用于 MasterGo2HTML 生成阶段，也适用于 HTML 到 React 的迁移阶段：光晕、波点、模糊圆、阴影和背景渐变属于不可变的视觉事实，React 转换不得因组件化、CSS scope、资源搬迁或样式迁移而改变其画布尺寸、比例、位置、层级或裁切边界。

- 保留装饰资源文件的真实 `width`、`height`、`viewBox` 和 filter/blur bleed；不得把 SVG 画布压回设计节点的 nominal 尺寸。
- 需要溢出父容器后裁切的装饰必须保留明确 `width`/`height`、`flex: none`、`max-width: none`，并由父容器 `overflow` 裁切；不得被 React 全局样式、Flex shrink、`object-fit` 或 `background-size` 二次压缩。
- 默认模式下不得重绘、合并或重新布局这类装饰。强制抽取 Header/Nav/Footer 时，可以让共享壳组件原样承载其既有 DOM、资源引用和 scoped CSS，但不得把装饰层另行抽象、去重或改写；Engineering 模式下只有在截图证明视觉等价后才允许进一步提取共享装饰组件。
- 默认模式只允许在 React 完成后按同一 Frame 视口生成一次非阻塞截图/报告，不根据 diff 继续人工修正或重复截图。只有用户明确要求视觉修正或 `engineering` 模式时，才复核并修正颜色覆盖面积、核心位置和裁切边界。
