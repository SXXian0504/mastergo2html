---
name: mastergo2html
description: Convert MasterGo frames, current selections, page bundles, or plugin 00-input exports into HTML/CSS/JS with the local mastergo2html CLI. Use for MasterGo design-to-HTML generation, current-selection conversion, output inspection, static validation reporting, or the first stage of the MasterGo2Code pipeline.
---

# MasterGo2HTML

Read and follow [mastergo2html_CLI.md](mastergo2html_CLI.md) before taking action.

Run CLI commands from the repository that contains `cli/src/index.js` and the `mastergo2html-plugin` package. On this machine, use this default repository when the current workspace does not contain the CLI:

```text
/Users/xiansongxin/Documents/MasterGo/code/mastergo_plugin/mastergo2json
```

Treat the CLI workflow document as the source of truth for input selection, prerequisites, timeouts, retries, output paths, validation, preview, and reporting.

## 模型失败重试策略

- **模型网关连接最长等待 120 秒**：所有会进入模型阶段的 CLI 调用统一使用 `LLM_CONNECT_TIMEOUT_MS=120000`；不得设置更短的连接超时。120 秒内尚未建立连接时继续等待，达到 120 秒后才按可恢复连接超时处理并复用原 `jobId` 重试。
- **禁止使用或切换到 Codex SDK**：不得为生成、恢复或规避模型网关故障设置 `LLM_BACKEND=codex-sdk`，也不得调用本地 Codex CLI 作为备用模型后端。
- 保持 `cli:doctor` 检查通过的当前模型后端配置。模型过载、连接超时、流空闲超时、连接重置、429 或 5xx 等可恢复错误发生后，先确认原 `jobId` 状态，然后直接执行：

```bash
npm run --silent cli -- retry <jobId> --json
```

- `retry` 必须复用同一 `jobId` 并从失败阶段继续；不得重新采集当前选择、不得新建重复任务，也不得通过切换模型后端恢复。
- 重试命令使用至少 60 分钟超时。无需在重试前加入固定 `sleep`；只有 CLI 自身的退避/重试机制可以等待。若 CLI 明确达到重试上限或错误被判定为不可恢复，再向用户报告失败。

After HTML generation, inspect and report `05-output/static-validation.json`. Preserve the generated output for screenshot review and downstream React conversion unless the normal CLI workflow explicitly requires regeneration or retry.

## 装饰 SVG 尺寸完整性约束

首次生成光晕/波点背景前，必须按[装饰光晕 SVG 首次生成约束](../../docs/DECORATIVE_GLOW_SVG_PLAYBOOK.md)执行资源拆分、画布解析、CSS 抗压缩和静态验收；这不是生成后的可选微调。

- 光晕、波点、模糊圆、阴影等装饰 SVG 必须先读取真实 `width`、`height`、`viewBox` 以及 filter/blur 扩散范围；设计节点的 nominal width/height 不能直接作为 SVG 画布尺寸。
- 若磁盘 PNG 已被 `clipsContent` Frame 预裁切，资源坐标必须取 `absoluteRenderBounds` 与裁切祖先边界交集的左上角，尺寸取实测 PNG 画布；禁止围绕 nominal bounds 或完整 render bounds 再做中心对齐。
- 需要超出父容器并由 `overflow` 裁切的装饰，必须保留完整画布比例，并显式设置明确的 `width`/`height`、`flex: none`、`max-width: none`，避免被全局 `img { max-width: 100% }` 或 Flex shrink 压缩。
- 光晕、波点与背景渐变/纯色层要分别核对并叠加实现；生成后必须在设计稿基准视口截图检查颜色覆盖面积、核心位置和裁切边界。

## 紧凑圆角视觉面与 Hover 约束

徽标、chip、状态标签、按钮、分段导航活动胶囊与整卡交互面必须按[紧凑圆角视觉面与 Hover 还原手册](../../docs/COMPACT_ROUNDED_SURFACE_PLAYBOOK.md)执行节点识别、样式绑定和验收。

- 有色底和圆角属于父级 Frame/Rectangle 时，必须绑定该视觉节点的 `data-style-source-node-id`，保留 fill/alpha、stroke、radius、bounds 与 padding；禁止退化为只有彩色文字或透明空层。
- 分段导航必须同时保留整体外框、活动胶囊、文本和源分隔线；活动项切换时移动同一个活动胶囊。窄屏应优先保持桌面等分宽度比例，并按整体外框实际可见描边边界校准活动胶囊的高度和垂直位置；没有设计证据时不得同时缩窄、缩矮，也不得把单个页面的 top/height/radius 像素值固化为通用规则。按钮必须继续覆盖完整点击区，胶囊中心必须与选中项中心对齐。生成时给整体控件添加 `data-segmented-control`，给独立活动视觉面添加 `data-segmented-active-surface`，用于运行时逐项切换验收。
- 没有独立 hover/focus 状态证据时，**禁止新增 border/outline 或改变描边**。整卡反馈需要留白时，用不参与布局的圆角 wrapper/伪元素扩大背景和阴影面，不能紧贴文字或图片。
- 源节点明确存在的 stroke 必须按颜色、alpha 和宽度保留；禁止新增边框不等于删除设计稿已有描边。

## 响应式生成稳定性约束

响应式不是在 HTML 生成阶段临时补几条 `@media`，而是必须沿 workflow 分阶段传递：布局阶段保留事实，组件阶段提出降级，资源阶段保护固定视觉，交互阶段补齐移动状态，组装阶段锁定唯一五档契约，代码阶段只执行并验证。详细提示词、阶段责任和复盘证据见：[响应式设计生成提示词沉淀与稳定性手册](../../docs/RESPONSIVE_DESIGN_PROMPT_PLAYBOOK.md)。

后续 Web 页面生成必须默认携带以下硬约束：

- 视口验收固定为 `390 / 768 / 1280 / 1920 / 2560`；必检模块为 Header、Nav、Main、Footer。
- 页面和普通组件不得出现横向滚动；横向滚动容差不超过 `2px`，禁止使用 `overflow-x:hidden/auto/scroll` 掩盖桌面固定几何。
- `390/768px`：Header/Nav 内容撑高；桌面导航必须完整折叠并通过同一 DOM 的菜单按钮展开，或完整换行/纵向排列；隐藏分支不得留下固定高度、min-height、padding、margin 或桌面坐标空位。
- 源设计为单一圆角胶囊外框的分段导航，在 `390px` 标签仍可容纳时必须保留横向胶囊：一个整体边框、活动项独立圆角底、内部短分隔线；不得改成三块独立矩形或无条件纵向堆叠。菜单按钮可去掉静态边框/底色，但必须保留 `:focus-visible` 焦点轮廓。
- `1280px`：从 1920 设计坐标切换到受限居中容器和 Flex/正常流；`2560px`：Header/Footer 背景全宽，普通内容组保持居中，不能相对视口两端绝对定位。
- CSS 先写 reset、基础规则、source/data 精确规则和状态规则，最后写全部响应式 `@media`；断点内显式重置 `position/inset/width/height/min-height/margin/padding/white-space/transform`。
- 窄屏把卡片标题/摘要转为正常流时，桌面绝对定位的徽标/tag 也必须同步改为 `relative/static`，并通过 Flex/Grid、`gap` 或 margin 留出间距，禁止标签覆盖标题首行。
- 页面只保留 `html/body` 一个纵向滚动根；`.page-shell`、Main、内容容器不得使用 `overflow-y:auto/scroll` 产生第二根滚动条。嵌入预览要求隐藏内侧滚动条时，只隐藏页面根 scrollbar 视觉，不得关闭滚轮、触控和键盘滚动。
- `absolute/fixed` 装饰裁切层如果使用 `overflow-x:hidden`，必须同步显式设置 `overflow-y:hidden/clip`；否则 CSS 会把另一轴计算为 `auto`，装饰层会意外生成内侧纵向滚动条。该规则只适用于不承载内容的装饰层，不得用于页面根或正文容器。
- 固定背景/装饰资源可以独立裁切，但不得缩放重排、进入内容流或被普通内容容器的 `max-width`/Flex shrink 压缩。
- 输出后必须检查五档视口的 `scrollWidth`、Header 空白带、导航隐藏分支、Footer 宽屏孤岛、长文本换行和资源裁切，并把异常写入 `static-validation.json`。
