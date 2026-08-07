# 响应式设计生成提示词沉淀与稳定性手册

> 基于任务 `96457db1-f5b3-4a0a-8854-66e61f20bf4d` 的复盘。该任务来自页面批次 `f33de85d-125b-478a-a358-eb2811441aaf`，输入为单个 PC Frame `114:71104`，基准画布 `1920×4037`。
>
> 复盘目标：提炼各阶段真正影响响应式结果的提示词，区分“事实分析”“结构规划”“组装裁决”“代码执行”的责任边界，并把可复用规则固化为后续生成的稳定契约。

## 1. 结论先行

### 1.1 对本次结果影响最大的阶段

**影响最大的是 `04-assembly / assembly-planning`，其次是 `05-output / html-generation`；不是 `02-layout` 单独决定的。**

原因不是 assembly 的 token 最多，而是它第一次把前面互相独立的判断合并成了**唯一可执行的页面级裁决**：

1. 把 Header、Nav、Main、Footer 明确拆成四个响应式责任模块。
2. 把视口固定为 `390 / 768 / 1280 / 1920 / 2560` 五档，而不是泛泛地说“支持移动端”。
3. 对 `390/768` 规定“内容撑高、导航完整折叠、隐藏分支不留空位”。
4. 对 `1280` 规定“从桌面绝对坐标切换为受限容器 + Flex”。
5. 对 `2560` 规定“全宽外层 + 居中内容组”，避免 1920 画布坐标把内容甩到屏幕两端。
6. 规定 CSS 级联顺序：基础/source-bounds 规则在前，响应式覆盖在最后，并显式清除桌面几何属性。
7. 把最终验收条件写成可检查的约束：页面横向溢出、Header 空白带、导航隐藏分支、Footer 宽屏孤岛、长文本裁切。

`05-output / html-generation` 的作用是把这份裁决落成 HTML/CSS/JS，并通过 prompt 和静态/运行时校验阻止明显回归。因此可以把影响链理解为：

```text
02-layout 事实模型
    ↓
03-page-plans 结构/资源/交互候选方案
    ↓
04-assembly 唯一响应式裁决（最大规划影响）
    ↓
05-output 代码执行 + 静态/运行时校验（最大实现影响）
```

### 1.2 本次任务的证据

| 阶段 | 输入/输出 | 本次 token 使用 | 对响应式的实际贡献 |
|---|---|---:|---|
| `02-layout` | `page-layout.md` | 31,915 → 3,491 | 建立 `1920px` 坐标系、模块边界、Q&A 可增长流；响应式只保守提示，明确不能凭空创造移动设计 |
| `03 component` | `component-structure.plan.md` | 46,105 → 11,503 | 提出 Header/Nav 窄屏重排、Footer outer/inner、CSS 显式重置，是最重要的候选结构方案 |
| `03 interaction` | `interaction.plan.md` | 17,671 → 7,132 | 规定移动菜单、Escape、焦点返回、跨断点状态重置等行为 |
| `03 assets` | `static-assets.plan.md` | 48,242 → 11,505 | 固定装饰/切片不重排、不缩放，避免响应式把背景资源错误地拉伸或带入文档流 |
| **`04 assembly`** | **`assembly.plan.md`** | **124,914 → 14,929** | **合并冲突并锁定五档视口、模块策略、级联顺序、验收标准；是规划层最大影响源** |
| **`05 html`** | **`html-generation.prompt.md`** | **151,407 → 20,619** | **按 assembly 实现，生成完整媒体查询与移动菜单；是实现层最大影响源** |

> 注意：本次 `static-validation.json` 仍为 `ok:false`，主要是 Q&A 文本的 source-bounds/对齐验收与“可增长流”策略存在冲突。这里的结论是“响应式结构生成得好”，不是“整页高保真验证已通过”。后续应分别看响应式契约与视觉高保真契约，不能用一个总状态掩盖两类问题。

## 2. 各阶段提示词提炼

下面的片段不是要求模型死记页面坐标，而是要固定每个阶段的**判断方法和输出格式**。页面坐标、sourceNodeId、assetId 仍必须来自当前任务输入。

### 2.1 `02-layout`：先建立事实模型，不在这里拍板移动端

**职责：**识别桌面坐标系、模块顺序、内容流与装饰层，并给出低置信度响应式差量。

**推荐稳定提示词：**

> 你是页面布局分析 Agent。先从上到下识别页面整体模块，而不是复述 TEXT 节点。以设计稿坐标、section bbox、层级、layoutMode、flexContainerInfo 和重复结构为事实依据，逐模块输出边界、布局方式、定位策略、间距规则、资源引用和风险。
>
> 只有源事实明确支持时才把普通内容转为 flow/Flex/Grid；没有可靠 Auto Layout 证据时，PC 首版保留 absolute/source-bounds。将背景、装饰、漂浮资源与内容模块分开，并明确 `affectsFlow=false` 的层不得产生内容 padding、margin、min-height 或 Header 高度。
>
> 设计稿只有 PC Frame 时，不要虚构精确移动端设计；只输出保守差量：`768px` 以下将可增长内容改为正常流、允许换行/堆叠，禁止两套 DOM 和整页等比缩小。把响应式不确定项写入风险与复核点。

**本次结果中真正有用的布局知识：**

- PC 以 `1920px` 为高保真基准。
- 主内容轴是 `1088px`；回答有效宽约 `1046px`。
- 19 个 Q&A 是重复结构，适合内容增长；长回答必须下推后续 section。
- 顶部装饰 `114:71600` 独立背景层，不进入文档流。
- Header/导语区保持 source-bounds；Q&A 只在窄屏降级为流式。

### 2.2 `03-page-plans/component-structure`：提出结构性响应式方案

**职责：**把布局事实翻译成 DOM、容器、流式降级和 CSS 级联方案。

**推荐稳定提示词：**

> 你是组件结构分析 AI。覆盖整页的语义 DOM、组件边界、容器宽度、布局方式、层叠关系和响应式降级，不输出代码。
>
> 对单个 PC Frame，先保证 `1920px` 高保真，再定义相对 PC 的差量。必须逐一说明 Header、Nav、Main、Footer 在 `390/768/1280/1920/2560` 的行为：
> - `390/768`：普通内容改为流式，Header/Nav 内容撑高；桌面导航要么完整换行/纵向排列，要么 wrapper 完整折叠并显示菜单按钮；隐藏分支不能留下固定高度、min-height、padding、margin 或 top/left 空位。
> - `1280`：使用受限居中容器 + Flex，不能继续依赖 1920 视口坐标。
> - `1920`：严格按 source bounds 还原高保真基准。
> - `2560`：保持全宽背景与居中内容组，不能把普通内容绝对定位到视口远端。
>
> 明确 CSS 级联顺序：基础规则和 `[data-source-node-id]` / `[data-text-source-node-id]` 精确规则在前，所有 `@media` 在后；每个窄屏断点显式重置 `position/inset/width/height/min-height/margin/padding/white-space/transform`。

**本次结果中真正影响输出的结构裁决：**

- `.site-header`、`.page-main`、`.site-footer` 分层。
- `.site-footer` 使用全宽 outer，内容放在居中 `max-width≈1610px` 的 inner。
- Q&A 采用可增长单列流；每个 item 内保留局部 Q/A 标记关系。
- 窄屏重置桌面坐标，而不是使用 `overflow:hidden` 掩盖桌面宽度。

### 2.3 `03-page-plans/interaction`：只补最小交互，不破坏结构

**职责：**确定移动菜单、键盘、焦点和跨断点状态，不重新设计布局。

**推荐稳定提示词：**

> 你是动态交互分析 AI。只规划设计稿能够支持的最小可信行为。静态资讯页默认不添加 Q&A 折叠、搜索、筛选、分页、弹窗或异步业务状态。
>
> 若存在桌面导航，必须给出同一份导航 DOM 的移动增强方案：无 JS 时导航仍可见；JS 初始化后在窄屏可关闭；菜单按钮同步 `aria-expanded`，`Escape` 关闭并把焦点返回按钮；通过 `matchMedia` 在跨断点时清除桌面/移动残留状态。所有未知 URL 使用安全 pending 占位，不虚构跳转。
>
> 逐类判断 `default / hover / focus-visible / active / selected-or-open / disabled`，但状态反馈不得改变布局尺寸。使用 `prefers-reduced-motion` 降级。

**本次结果中真正影响输出的交互知识：**

- 菜单按钮使用同一导航 DOM，不生成第二套导航。
- JS 只实现 pending 链接拦截、移动菜单、Escape、焦点返回和 matchMedia 重置。
- Q&A 保持静态展开，因此长文本高度交给布局流处理。

### 2.4 `03-page-plans/static-asset-analysis`：固定视觉资产，避免响应式误伤

**职责：**决定哪些资源必须按 source-bounds 固定，哪些装饰可以由 CSS 等效，哪些资源不能进入文档流。

**推荐稳定提示词：**

> 你是静态资源分析 AI。对每个资源输出 `assetId / sourceNodeId / copiedPath / usage / renderPolicy / sourceBounds / renderedBounds / anchorNodeId / sizingPolicy / positioningPolicy / croppingPolicy`。
>
> 对背景、光晕、波点、Banner 前景和复合切片，必须区分“固定视觉资产”和“普通内容”。固定资产按 source-bounds 的 px 坐标、尺寸和 z-index 定位；不得使用 `cover`、百分比尺寸、`inset:0`、vw/vh 或 Flex/Grid 近似定位。窄屏只允许整体裁切/隐藏，不允许重新缩放重排。需要超出父容器并裁切的资源必须保留真实 SVG 画布比例，并设置 `flex:none; max-width:none`。

**本次结果中真正影响输出的资产知识：**

- `node_0001` 顶部装饰保持固定 `left/top/width/height`，不参与 flow。
- Header 背景使用静态合成 PNG，正常路径不额外叠加 blur。
- Footer 资源组按整体 composite 使用，禁止把 child 切片重复渲染。
- 资源的“固定”与普通内容的“流式”被明确分开，这是避免移动端视觉漂移的关键。

### 2.5 `04-assembly`：把候选方案变成唯一响应式契约

**职责：**跨计划冲突裁决，并把响应式规则写成代码生成器不可再解释的硬约束。

**推荐稳定提示词：**

> 你是单页面组装 AI。不要简单拼接三份计划；必须形成唯一页面级决策。对 Header/Nav/Main/Footer 分别输出 `390/768/1280/1920/2560` 五档布局、宽度、定位、可见性、内容撑高、溢出和层级规则。
>
> `390/768` 必须选择明确方案：流式换行/纵向排列，或桌面导航 wrapper 完整折叠并提供菜单按钮。任何隐藏分支都必须同时清除 `position/inset/width/height/min-height/margin/padding/white-space/transform` 等桌面几何，禁止大块空白带。
>
> `1280` 使用受限居中 inner + Flex；`1920` 保留 source bounds；`2560` 使用全宽 outer + 居中内容组，禁止普通内容相对视口两端 absolute。明确 Q&A 长文本如何下推分隔线和 Footer。
>
> 明确 CSS 级联顺序：基础规则、节点精确规则、状态规则在前，全部媒体查询在最后。把每项决策写成“输入事实 → 冲突 → 最终裁决 → 依据”，引用 sourceNodeId/assetId。
>
> 在计划末尾给出代码生成硬指令和五档验收条件：页面横向滚动不超过 `2px`；Header 窄屏无桌面空白带；导航隐藏分支完全折叠；Footer 在宽屏不形成远端孤岛；长文本不裁切。

**本次结果中影响最大的 assembly 内容：**

- `Header/Nav/Footer` 的五档裁决（assembly plan 约第 403–418 行）。
- “断点显式重置”清单（约第 420–433 行）。
- “代码生成步骤的指令”中的最终五档验收（约第 543–589 行）。
- `hoverRequired / hoverTargets / motionRequired` 三行机器可检摘要，保证交互要求不会在组装时丢失。

### 2.6 `05-output/html-generation`：执行 assembly，不重新架构

**职责：**根据 assembly plan 生成文件，并对响应式契约做静态与运行时验证。

**推荐稳定提示词：**

> 你是 HTML/CSS/JS 代码生成 AI。严格执行 `04-assembly/assembly.plan.md`，不得重新裁决架构、资源或断点。只生成一套 DOM；PC 使用 source bounds，高度不稳定的 Q&A 使用内容流；窄屏使用同一 DOM 的流式重排或移动菜单增强。
>
> 先写 reset、变量、基础几何、source/data 精确规则和状态规则，最后写所有 `@media`。在每个窄屏断点显式重置桌面几何，禁止用 `overflow-x:hidden/auto/scroll` 掩盖溢出。必须包含 `width=device-width` viewport meta。
>
> 最终验证 `390/768/1280/1920/2560`：检查 `scrollWidth`、Header/Nav/Footer 结构、空白带、远端孤岛、文字换行、长文本裁切、装饰裁切和资源清晰度。静态验证失败时保留输出并把问题写入报告，不要悄悄改写文字或替换资源。

**本次生成中可观察到的实现信号：**

- `styles.css` 在基础规则之后集中出现 `@media (min-width:1921px)`、`769–1919px`、`max-width:1279px`、`max-width:768px`、`max-width:390px`。
- HTML 只有一个 `site-header__desktop-nav` 和一个 `site-header__menu-trigger`，没有第二套移动导航 DOM。
- JS 中存在移动菜单、Escape、焦点返回和 `matchMedia` 重置。
- 输出包含 `width=device-width` viewport meta。

## 3. 稳定响应式契约（后续每次都必须出现）

后续生成不能只在提示词里写“做好响应式”，必须让 `page-layout` 或等价上下文携带以下结构化信息：

```json
{
  "version": "mastergo2html.responsive-contract.v1",
  "enabled": true,
  "viewports": [390, 768, 1280, 1920, 2560],
  "requiredModules": ["header", "nav", "main", "footer"],
  "horizontalScrolling": {
    "pageAllowed": false,
    "componentAllowed": false,
    "tolerancePx": 2
  },
  "layoutIntegrity": {
    "narrowMaxWidth": 768,
    "header": {
      "contentDrivenHeight": true,
      "hiddenBranchesMustCollapse": true
    },
    "wideShell": {
      "minViewportWidth": 1921,
      "fullBleedRoles": ["header", "footer"],
      "minViewportCoverageRatio": 0.98
    },
    "footer": {
      "centeredInnerContainerRequired": true
    }
  }
}
```

### 3.1 模型输出的最小字段

每个模块在每个断点至少写清楚：

- `display / visibility / hiddenBranch`：是否存在、是否折叠、是否占位。
- `position / inset / width / height / min-height`：是否继承桌面值，窄屏如何重置。
- `container`：是否 full-bleed，是否有居中 inner，最大宽度是多少。
- `flow`：正常流、Flex、Grid、局部 absolute 的边界。
- `text`：换行、white-space、长文案下推和不可变文字约束。
- `overflow`：允许裁切的装饰层与禁止横向滚动的内容层必须分开。
- `validation`：五档视口的可检查条件。

### 3.2 生成器的固定执行顺序

1. 读取 `responsiveContract`，先列出五档验收矩阵。
2. 读取 assembly plan 的模块裁决，不再重新发明 Header/Nav/Footer 结构。
3. 写桌面基准规则。
4. 写交互状态规则。
5. 最后写全部媒体查询，并显式重置桌面几何。
6. 运行静态检查。
7. 运行五档运行时检查，记录 `scrollWidth`、模块边界、空白带、Footer 连续性。
8. 输出 `static-validation.json`；警告可以发布，但不得被静默吞掉。

## 4. 哪些规则不能混用

### 4.1 “高保真 absolute”与“可增长 flow”必须按模块分配

- Header、导语装饰、标题切片等固定视觉区域：保留 source-bounds。
- Q&A、长正文、列表内容：使用可增长流，分隔线跟随 section，而不是固定整页 y 坐标。
- Footer：外层 full-bleed，内部普通内容流式；只有低风险局部资源可在 inner 内 absolute。

### 4.2 “装饰可裁切”不等于“内容可横向滚动”

- 装饰层可以有自己的 clip/overflow 容器。
- Header/Nav/Main/Footer 普通内容禁止用 `overflow-x:hidden`、`auto` 或 `scroll` 掩盖桌面几何。
- 全局页面横向滚动容差固定为 `2px`。

### 4.3 “移动端可用”不等于“整页缩小”

- 不写第二套 DOM。
- 不对整页使用 `transform: scale(...)`。
- 必须通过流式宽度、换行、纵向堆叠或导航折叠来获得可用布局。

## 5. 复盘后的工程落点

以下实现已经是后续生成应保持的基础，不要用单次 prompt 改回去：

- 共享短规则：`mcp-server/src/workflow/design-to-html-skill.js`
  - `responsive` section：PC 优先、Header/Nav 窄屏硬规则、Footer 宽屏硬规则、断点覆盖和溢出策略。
- 组件计划：`mcp-server/src/workflow/component-structure-analysis.js`
  - 要求五档 Header/Nav/Footer 裁决、Footer outer/inner 和显式 CSS 重置。
- 组装计划：`mcp-server/src/workflow/assembly-planning.js`
  - `9.7–9.12`：五档裁决、级联顺序、交互状态摘要和 hover/motion 稳定性。
- 结构化契约：`mcp-server/src/workflow/raw-layout-conversion.js`
  - `mastergo2html.responsive-contract.v1`。
- 代码与校验：`mcp-server/src/workflow/html-generation.js` 与 `mcp-server/src/workflow/responsive-runtime-validation.js`
  - 静态契约检查 + 五档运行时检查，采用 warn-and-publish 和安全自动修复策略。

## 6. 变更/回归检查清单

每次调整 prompt 或 workflow 时，至少检查：

- [ ] `02-layout` 仍然把响应式描述为低置信度差量，不虚构移动设计。
- [ ] `03 component` 仍然要求 Header/Nav/Footer 五档策略和 CSS 显式重置。
- [ ] `03 interaction` 仍然保留移动菜单、Escape、焦点返回和跨断点状态重置。
- [ ] `03 assets` 仍然禁止固定装饰在断点中缩放/重排，并保留真实 SVG 画布。
- [ ] `04 assembly` 仍然写出唯一五档裁决、冲突依据、级联顺序和验收标准。
- [ ] `05 html` 仍然执行 assembly，不重新裁决架构，不生成第二套 DOM。
- [ ] `responsiveContract` 仍包含 `390/768/1280/1920/2560`、`header/nav/main/footer`、横向滚动容差和宽屏 inner 约束。
- [ ] Header/Nav 中间视口仍检查 `769/1024/1280/1440/1600`，且断点连续覆盖 1280；Logo/Nav 成组释放，Nav 用 `margin-left:auto` 保持右对齐。
- [ ] CSS 的最后一个窄屏媒体查询之后没有重新出现 source-bounds 几何规则。
- [ ] 运行时检查仍能发现横向溢出、Header 空白带、Footer 远端孤岛和隐藏分支残留。
- [ ] 圆角分段控件运行时会逐项点击，检查胶囊中心误差、外框边界、单槽位宽度比例和完整点击区。
- [ ] 视觉高保真与响应式可用性分别统计，不能用 `static-validation.ok` 一个布尔值代替两类结论。

## 7. 一句话记忆版

> **布局阶段保留事实，组件阶段提出降级，资源阶段保护固定视觉，交互阶段补齐移动状态，组装阶段锁定五档契约，代码阶段只执行并验证。**

## 9. 窄屏单滚动根与标签/标题防重叠

### 9.1 页面只保留一个纵向滚动根

- 默认由 `html/body` 承担页面纵向滚动。
- `.page-shell`、`main`、`.content-shell` 等结构容器禁止使用 `height:100vh + overflow-y:auto/scroll` 创建第二根滚动条。
- 嵌入式预览同时显示宿主滚动条和页面滚动条、且产品要求隐藏内侧滚动条时，只隐藏页面根滚动条视觉：使用 `scrollbar-width:none` 与 `::-webkit-scrollbar`，仍保留滚轮、触控和键盘滚动。
- 禁止对 `html/body` 或正文结构容器使用 `overflow-y:hidden/clip` 解决双滚动条，因为这会截断长页面内容。
- 纯装饰的 `absolute/fixed` 裁切层是例外：仅写 `overflow-x:hidden` 时，CSS 会把原本 `visible` 的另一轴计算成 `auto`，从而产生一根意外的纵向滚动条。装饰层必须使用 `overflow:hidden`，或显式补齐 `overflow-y:hidden/clip`；该层不得承载正文或交互内容。

### 9.2 桌面 absolute 元素转移动流时必须成组释放

卡片桌面布局中，tag、标题、摘要可能分别使用 absolute 坐标。窄屏将标题和摘要改成正常流时，tag 也必须同步处理：

- tag 改为 `position:relative/static`；
- 父内容区改用纵向 Flex/Grid 或正常流；
- 使用 `gap` 或 margin 还原 tag 与标题间距；
- 移除桌面 `top/left/min-height` 对移动端的占位影响；
- 检查长标题换行后，tag 不覆盖第一行，摘要不覆盖标题末行。

五档验收中，390px 与 768px 必须额外检查：可见纵向滚动条数量、tag/title 包围盒是否相交、长标题两行时内容区是否自然撑高。

### 9.3 圆角分段控件必须逐项切换验收

- 整体控件使用 `role="tablist"` 并添加 `data-segmented-control`；按钮使用 `role="tab"`；独立活动胶囊添加 `data-segmented-active-surface`。视觉胶囊不能兼任按钮点击区。
- 运行时在 `390/768/1280/1920/2560` 依次点击每个选项，并记录选项与胶囊包围盒。中心误差必须不超过 `2px`，胶囊不得越出整体外框。
- 活动胶囊默认继承一个等分槽位的宽度比例；按钮本身仍覆盖完整槽位宽高。若设计证据明确存在内缩活动面，可在响应式契约中调整比例阈值，但不能仅凭主观观感缩窄、缩矮。
- 胶囊的 `top/height/radius` 逐页取自源节点或外框资产的实际可见边界。某个页面使用过的具体像素值不是生成模板，不能跨页面复制。
- 自动识别只针对有明显圆角、且活动面高度占控件一定比例的 tablist，避免把普通下划线 Tab 误判成胶囊分段控件；显式 `data-segmented-control` 标记则必须完成全部检查。

### 9.4 中间视口 Header/Nav 必须成组降级

桌面设计常把 Logo 与 Nav 都按 1920px source bounds 绝对定位。进入 769px 到设计基准宽度之间时，不能只将 Nav 改成 `position:static`；如果 Header inner 仍不是 Flex/Grid，Nav 会回到普通流左上角，与 Logo 叠在一起。

稳定实现必须把三层作为同一个布局系统同步切换：

- Header inner：`display:flex; align-items:center`，保留流式宽度与左右安全边距；
- Logo：清除 `position/left/top`，改为 `position:static; flex:none`；
- Nav：清除 `position/left/right/top`，改为 `position:static; margin-left:auto`，需要时保留右侧安全边距；
- Nav list：声明宽度必须不小于所有 item 宽度与 gap 的总和，不得依靠父容器裁切；
- Footer 等同一断点下仍残留的视口级 absolute 坐标也必须一起检查，避免它们制造整页横向滚动并干扰 Header 判断。

中间布局的回归视口固定为 `769/1024/1280/1440/1600`，每档都验证：

- `brand.right < nav.left`；
- `nav.right <= headerInner.right`；
- `document.scrollWidth <= document.clientWidth + 2`；
- 桌面 Nav 可见且移动菜单按钮未提前出现。

断点边界必须连续覆盖 1280px。禁止只写 `max-width:1279px`，让 1280px 意外回落到基于 1920px 画布的绝对坐标布局。
