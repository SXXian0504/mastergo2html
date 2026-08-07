---
name: html2react
description: Convert multiple standalone HTML/CSS/JS or MasterGo-generated pages into a route-aware Next.js App Router project. Defaults to a fast one-to-one conversion with scoped source CSS and no screenshot-driven repair loop; use engineering mode for visual correction, shared-component extraction, Tailwind/SCSS/Ant Design migration, and repeated visual regression.
---

# HTML2React

Convert source pages without mutating them. Preserve source structure and styles; in default mode, Frame screenshots are reporting references rather than a correction loop.

## Profile contract

Default to `default`. Select `engineering` only when the user explicitly requests engineering mode, a reusable component architecture, Tailwind/SCSS/Ant Design migration, design-system modernization, or release-grade repeated visual regression.

| Profile | Styling | Reuse | Screenshot policy |
| --- | --- | --- | --- |
| `default` | Preserve and scope generated/page CSS | Keep page-specific implementations | At most one informational final capture; no repair loop |
| `engineering` | Migrate to Tailwind + SCSS Modules + Ant Design | Extract proven shared components | Baseline plus post-refactor and final regression captures |

Do not ask for a profile on every run. In `default`, do not install three-track dependencies, run a shared-component phase, capture intermediate React stages, or make screenshot-driven correction edits.

## Required reading

1. If the user names engineering documents, read them first and treat them as canonical.
2. Read [conversion-playbook.md](references/conversion-playbook.md) and [visual-fidelity.md](references/visual-fidelity.md).
3. In profile `engineering`, also read [engineering-profile.md](references/engineering-profile.md).
4. In this repository, `docs/工程规范.md` overrides bundled references when it applies to the selected profile.

When documents conflict, prefer the user's current requirements, then repository engineering documents, then bundled references.

## Common workflow

### 1. Isolate and inventory inputs

- Never edit source exports in place.
- Copy every input page into a task workspace under `sources/<page-id>/`.
- Assign an explicit application route to every page before implementation.
- Run:

```bash
python3 scripts/prepare_inputs.py \
  --workspace <task-workspace> \
  --require-frame-screenshot \
  --page '/home=<html-output-dir>' \
  --frame-screenshot '/home=<frame-screenshot.png>' \
  --page '/position=<html-output-dir>' \
  --frame-screenshot '/position=<frame-screenshot.png>'
```

For MasterGo outputs, require one valid `frame-screenshot.png` per route. Review `source-manifest.json` for screenshot dimensions/hashes, routes, missing assets, and external dependencies.

### 2. Write a profile-aware conversion plan

Create a minimal `conversion-plan.md` containing:

- `profile: default` or `profile: engineering`;
- route-to-source mapping and any dynamic-route sample URLs;
- unresolved asset, CSS, interaction, or route deviations.

In `default`, skip verbose architecture analysis, consumer matrices, and visual threshold calibration.

Only in `engineering`, add candidate shared-component consumers, three-track migration batches, and intermediate screenshot stages.

### 3. Scaffold the target

- Use a supported stable Next.js App Router setup with TypeScript, `src/`, and `@/*` alias.
- Prefer the repository's package manager.
- Use Server Components by default; add `'use client'` only at interaction boundaries.
- Keep route files focused and avoid HTML-string or iframe embedding.
- In `default`, install only dependencies needed by the converted source. Tailwind, Sass, and Ant Design are optional and are not prerequisites.
- In `engineering`, follow the scaffold and dependency requirements in [engineering-profile.md](references/engineering-profile.md).

### 4. Convert every route one-to-one

- Convert semantic HTML to JSX; do not use `dangerouslySetInnerHTML`, iframe wrappers, or runtime loading of the original HTML.
- The optional draft converter may accelerate unusually large or mechanically difficult pages, but skip it for ordinary default pages:

```bash
python3 scripts/html_to_jsx_draft.py \
  --manifest <task-workspace>/source-manifest.json \
  --output <task-workspace>/drafts
```

- Preserve each source page's DOM hierarchy, complete content, assets, CSS behavior, and placement.
- Copy assets to `public/design/<page-id>/...` and rewrite URLs to root-relative paths.
- Scope generated styles to a unique route root with `scope_css.py`; never concatenate unscoped page styles.
- Translate source JavaScript into React state, refs, handlers, and effects. Replace fake navigation with working routes, accessible disabled controls, or documented TODOs.
- Keep page-specific implementations in `default`; do not pause conversion to search for reuse candidates.

### 5. Respect data and interaction boundaries

- Browser components must not call backend microservice hosts directly. Use same-origin Route Handlers or an approved Server Action boundary.
- Keep backend URLs and secrets in server-only configuration.
- Prefer Server Component fetching. Use client caching/query libraries only when their behavior is required.
- Preserve labels, keyboard behavior, loading/error states, responsive behavior, and source interaction intent.

## Default completion path

### 6. Optionally emit one final visual report

After all routes build and coexist, capture each route at its Frame screenshot width at most once. If requested by the delivery workflow, compare it with the Frame using mode `frame-vs-react-final` and save the metrics/diff as informational artifacts.

Do not inspect the diff to trigger code changes, manual visual correction, or another capture in `default` mode. Report material drift as a known deviation. Do not create `react-initial`, `react-post-reuse`, or per-style-batch screenshots. Reuse an existing final report when route code, relevant assets/fonts, viewport, and Frame hash are unchanged.

### 7. Validate and report

Run:

```bash
python3 scripts/validate_project.py \
  --profile default \
  --project <target-project> \
  --manifest <task-workspace>/source-manifest.json
```

Then run install only when dependencies are not already installed, run lint, and run production build. Do not run a separate typecheck command by default because `next build` performs the TypeScript check. Report route coverage, any one-shot visual metrics, validation results, missing behaviors/assets, and deliberate deviations. A visual report is non-blocking in default mode.

Default completion does not require:

- `tailwindcss`, `sass`, or `antd` unless the converted source actually needs them;
- emptying `src/styles/generated/*.css`;
- Header/Footer/common-component extraction;
- consumer matrices;
- screenshots before and after reuse/style refactors.

## Engineering completion path

For profile `engineering`, complete the common one-to-one conversion, then follow [engineering-profile.md](references/engineering-profile.md). It owns:

- shared component discovery and extraction;
- Tailwind + SCSS Modules + Ant Design migration;
- baseline, post-reuse, post-style, and final screenshot regression;
- stricter architecture/style documentation and audits.

Validate with:

```bash
python3 scripts/validate_project.py \
  --profile engineering \
  --project <target-project> \
  --manifest <task-workspace>/source-manifest.json \
  --require-visual \
  --visual-report-dir <task-workspace>/visual/react-final
```

Use [acceptance-checklist.md](references/acceptance-checklist.md) for the selected profile. Do not claim completion while routes fail, assets 404, source interactions are missing without documentation, or required build checks fail. Final visual pass/fail is blocking only in `engineering` or when the user explicitly requests visual correction.

## MasterGo page-batch handoff

If sources come from `mastergo2html generate-pages`, read `.mastergo2html/page-batches/<batchId>/batch.json` and run its `mergePrepareCommand`. Do not silently omit failed pages; retry or report them. Preserve generated HTML and Frame screenshots as immutable sources.

## 响应式契约继承约束

HTML 到 React 迁移必须继承 `mastergo2html.responsive-contract.v1`，而不是在 React 阶段重新发明响应式架构。详细阶段责任和提示词见 `docs/RESPONSIVE_DESIGN_PROMPT_PLAYBOOK.md`。

- 保留 `390 / 768 / 1280 / 1920 / 2560` 五档验收，以及 Header、Nav、Main、Footer 四个必检模块。
- 迁移 CSS 时，保持基础/source/data 精确规则在前、响应式覆盖在后；不要让 CSS scope、选择器重写或组件抽取把窄屏重置规则覆盖掉。
- `390/768px` 必须保持内容撑高、导航完整换行或同一 DOM 菜单折叠；隐藏分支不得留下桌面固定高度、min-height、margin、padding 或坐标空位。
- `2560px` 下 Header/Footer 继续使用全宽外层和居中 inner 内容组；普通内容不得被绝对定位甩到视口两端。
- 页面及普通内容组件不得出现横向滚动；装饰资源可以在独立裁切层中溢出，但不得把装饰层的裁切规则扩散到内容层。

## 装饰 SVG/背景视觉保真约束

迁移前读取并执行[装饰光晕 SVG 首次生成约束](../../docs/DECORATIVE_GLOW_SVG_PLAYBOOK.md)，尤其保护 required-final SVG 的 `renderedLocalBounds`、`flex:none`、`max-width:none` 和父层裁切关系。

HTML 到 React 的迁移必须把光晕、波点、模糊圆、阴影及背景渐变视为 source visual facts，而不是可随意响应式重排的普通图片。

- 保留 SVG 的真实 `width`、`height`、`viewBox`、filter/blur bleed 以及原始画布比例；不得按设计节点 nominal width/height 重新压缩。
- 对需要溢出并裁切的装饰，保留明确 `width`/`height`、`flex: none`、`max-width: none`，由父容器负责 `overflow` 裁切；不得让全局 `img` 规则、Flex shrink、`object-fit: cover` 或 `background-size: cover` 改变其视觉覆盖面积。
- 迁移或 CSS scope 时必须同时保留背景渐变/纯色层、光晕、波点的层级与 source-node 绑定；不能只保留其中一层。
- 默认模式最多生成一次最终 React 截图/对比报告，并将差异作为非阻塞信息交付；不得据此继续人工修正或重复截图。只有 `engineering` 或用户明确要求视觉修正时，才检查并修正颜色覆盖面积、装饰核心位置、扩散 bleed 和裁切边界。
