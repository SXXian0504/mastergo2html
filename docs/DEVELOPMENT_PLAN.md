# MasterGo2HTML Workflow 开发计划

## 0. 当前定位

MasterGo 插件已经完成从设计稿提取结构的基础能力，MCP 与 AI 模型链路也已经打通。后续开发重点不再是单点能力验证，而是把“插件采集数据、MCP 编排任务、AI 分工规划、最终生成 HTML”串成可重复、可调试、可恢复的完整 workflow。

核心目标：

- 用户在插件中点击“一键生成 HTML”后，系统自动采集当前 Frame 的结构、图片资源和资源映射。
- 将 `raw.json` 从 MasterGo 绝对布局数据转换为适合 HTML 开发的页面布局描述。
- 让不同职责的 AI 分别对整个单页面分析组件结构、静态资源和动态交互。
- 汇总三份页面计划，形成可直接执行的单页面开发方案。
- 由 AI 生成 `index.html`、`styles.css`、`script.js` 和 `assets/`，最终打包为 ZIP。
- 在开发和验证阶段支持使用设计稿整体截图与生成页面截图进行比对。

## 1. 总体工作流

```text
MasterGo 插件
  -> 一键生成 HTML
  -> 选择图片策略：原图 / 切片
  -> 提取 raw.json
  -> 导出 assets/
  -> 生成 asset-manifest.json
  -> 提交 MCP workflow job

MCP / CCH / AI workflow
  -> raw 标准化
  -> 生成 HTML 友好的页面整体布局文件
  -> 组件结构 AI 分析
  -> 静态资源 AI 分析
  -> 动态交互 AI 分析
  -> 生成单页面开发方案
  -> 生成 HTML/CSS/JS
  -> 视觉比对与修正
  -> 打包 ZIP
```

推荐产物目录：

```text
mcp-server/data/jobs/{jobId}/
  00-input/
    raw.json
    asset-manifest.json
    export-options.json
    frame-screenshot.png
    assets/
      original/
      rendered/

  01-normalized/
    raw.normalized.json
    asset-index.json
    design-tokens.json
    normalization-report.md

  02-layout/
    page-layout.json
    page-layout.md

  03-page-plans/
    component-structure.plan.md
    static-assets.plan.md
    interaction.plan.md

  04-assembly/
    assembly.plan.md

  05-output/
    index.html
    styles.css
    script.js
    assets/

  06-review/
    generated-screenshot.png
    visual-diff.json
    review-report.md
    fix-plan.md

  final/
    {frameName}.html.zip
```

## 2. 阶段一：插件初步开发与结构提取

状态：基本完成。

目标：让插件稳定提取当前设计稿的结构数据，并形成后续 workflow 可消费的基础输入。

已完成或接近完成的能力：

- 扫描用户当前选中的 MasterGo 节点。
- 导出 `raw.json`，保留节点树、绝对坐标、尺寸、文本、样式、图片引用等设计稿原始信息。
- 生成图片资源映射表，例如 `asset-manifest.json`。
- 导出图片相关资源到 `assets/`。
- 提供 ZIP 导出能力，方便离线调试和基线验证。

后续补强点：

- 固化 `raw.json` 字段说明，标注哪些字段可稳定依赖，哪些字段只是调试信息。
- 确保每个节点都保留 `sourceNodeId`、父子关系、绝对边界和可见性信息。
- 确保图片节点能回链到资源映射表。
- 建立至少 1 个真实 Frame 的导出样例，作为 workflow 回归输入。

验收标准：

- 可以从当前选中 Frame 稳定导出 `raw.json`。
- 可以得到 `assets/` 和图片映射表。
- 图片映射表至少包含 `imageRef` 和 `copiedPath`，并尽量保留 `sourceNodeId`、`assetId`、`nodeName`、`exportType`。
- 导出结果可以脱离 MasterGo 环境被 MCP workflow 读取。

## 3. 阶段二：接入 MCP 与 AI 模型

状态：完成。

目标：打通插件、MCP、本地服务、CCH 和大模型之间的调用链路，证明后续 AI workflow 可以被外部任务编排驱动。

已完成能力：

- 插件可以接入 MCP 任务链路。
- MCP 可以通过 CCH 接入大模型。
- 本地服务可以作为插件与 MCP/AI workflow 之间的桥接层。
- 已具备后续任务状态、日志、产物路径等能力的基础。

后续补强点：

- 将单次模型调用升级为可恢复的多阶段 workflow。
- 为每个阶段定义输入、输出、日志和失败处理方式。
- 支持从最近成功阶段继续执行，避免失败后从头重跑。
- 明确不同 AI 角色的 prompt、输入上下文和输出格式。

验收标准：

- 插件可以提交任务给 MCP/本地服务。
- MCP workflow 可以调用 AI 模型并写入产物文件。
- 任务执行状态可以被插件或外部面板查询。
- AI 调用失败时能记录错误阶段、错误信息和可重试上下文。

## 4. 阶段三：一键生成入口与输入包固化

状态：下一阶段优先开发。

目标：把用户点击“一键生成 HTML”后的输入采集流程固化为稳定任务包。

用户流程：

1. 用户选中一个完整页面 Frame。
2. 插件显示“一键生成 HTML”按钮。
3. 在按钮上方提供图片策略选项：
   - 原图：导出设计稿引用的原始图片，适合最终生成。
   - 切片：导出节点渲染后的截图切片，适合测试阶段，因为上下文更接近设计稿视觉结果。
4. 插件在选项旁标注推荐策略：
   - 测试阶段推荐使用切片。
   - 最终生成推荐使用原图。
5. 用户点击“一键生成 HTML”。
6. 插件生成 `raw.json`、`assets/`、`asset-manifest.json`，并提交 MCP workflow job。

输入包要求：

- `raw.json`：MasterGo 设计稿结构提取结果。
- `assets/`：根据用户选择导出的原图或切片。
- `asset-manifest.json`：图片映射表。
- `export-options.json`：记录本次导出使用原图还是切片，以及导出时间、Frame 信息。
- `frame-screenshot.png`：必需，当前 Frame 整体截图，用于后续视觉比对、布局校验和自动修正。

图片映射表关键字段：

```json
{
  "imageRef": "mastergo-image-ref",
  "copiedPath": "assets/rendered/node-xxx.png",
  "sourceNodeId": "node-id",
  "sourceNodeName": "node name",
  "exportType": "original | rendered-slice",
  "width": 320,
  "height": 180
}
```

开发任务：

- 调整插件 UI，把图片策略选项放到“一键生成 HTML”按钮上方。
- 图片策略文案明确区分“原图”和“切片”。
- 生成统一输入目录 `00-input/`。
- 将 `raw.json`、`asset-manifest.json`、`assets/`、`frame-screenshot.png` 和导出配置一起提交给 MCP workflow。
- 记录 `jobId`，便于插件重新打开后查询任务状态。
- 输入包写入完整性检查报告。

验收标准：

- 用户可以明确选择原图或切片。
- 点击“一键生成 HTML”后可以得到完整 `00-input/`。
- `00-input/` 必须包含 `frame-screenshot.png`，缺失时任务不能进入后续 AI workflow。
- `asset-manifest.json` 中所有已导出图片都具备 `imageRef` 和 `copiedPath`。
- MCP workflow 能直接读取输入包进入下一阶段。

## 5. 阶段四：Raw 标准化与 HTML 友好布局转换

目标：把 MasterGo 原始绝对布局数据，转换为适合 HTML 开发的页面整体布局文件。

关键判断：

- `raw.json` 只是 MasterGo 设计稿信息提取，不适合直接生成 HTML。
- `raw.json` 中大部分布局信息是绝对坐标。
- HTML 实际开发更需要相对定位、文档流、Flex/Grid、模块容器、间距规则和响应式约束。
- 这一阶段只由 AI 生成布局分析结论。确定性代码仅负责字段标准化、事实提取和上下文准备，不生成布局建议或规则版兜底报告。对外汇报时可称为“布局分析 Agent”，代码层面按职责命名为 AI layout analysis。

核心产物：

- `raw.normalized.json`：清洗后的节点结构。
- `asset-index.json`：标准化图片索引。
- `design-tokens.json`：颜色、字体、字号、间距、圆角、阴影、边框等视觉 token。
- `page-layout.json`：页面整体布局结构，供程序切片和校验。
- `ai-layout-context.json`：AI 布局分析模块的输入上下文，包含节点摘要、资源索引、视觉层级和机器提取事实。
- `page-layout.md`：页面布局说明，由 AI 布局分析模块生成，供后续单页面开发计划使用。

`page-layout.json` 应表达：

- 页面整体尺寸、设计稿基准宽度、背景。
- 从上到下的模块顺序。
- 每个模块的边界、内容容器、上下间距、布局方式。
- 模块内部的主要区域，例如左文右图、卡片网格、列表、导航、表单、浮层。
- 从绝对定位推导出的相对布局策略。
- 哪些元素适合正常文档流，哪些元素需要 `position:absolute`。
- 哪些判断不确定，需要后续 AI 或人工重点审查。

`page-layout.md` 应说明：

- 页面从头到尾的整体结构。
- 每个模块的视觉目的和布局方式。
- 模块内部布局关系。
- 绝对布局转换为相对布局的依据。
- 高风险区域，例如重叠装饰、复杂背景、固定定位、图片裁剪、文本溢出。

开发任务：

- 实现 raw 清洗与字段标准化。
- 识别页面级 token。
- 根据节点边界推导模块顺序。
- 生成 `page-layout.json` 初稿和 `ai-layout-context.json` 上下文。
- 调用 AI 布局分析模块生成 `page-layout.md`，并回填布局不确定项。
- 对比 JSON 与 Markdown 两种布局输入在后续生成中的效果，保留测试记录。

验收标准：

- `page-layout.json` 可以被程序稳定读取和切片。
- `page-layout.md` 可以让后续 AI 准确理解页面整体布局。
- 大部分模块不再依赖页面级绝对定位。
- 不确定判断有显式标记，而不是静默猜测。

## 6. 阶段五：模块切片（MVP 暂缓）

当前决策：阶段五不进入现阶段主 workflow。先跑通“单页面整体分析 -> 单页面开发 -> 截图比对修复”的闭环。

模块切片在以下条件出现时再启用：

- 超长页面导致单次上下文过大。
- 多页面之间需要复用组件或模块。
- 重复列表、复杂交互区域需要独立迭代。
- 需要多个代码生成任务并行开发。

在此之前，不生成 `03-modules/`，阶段六也不依赖 `modules.index.json` 或 `{moduleId}.module.json`。

## 7. 阶段六：三角色 AI 生成单页面开发计划

目标：由三个职责清晰的 AI 分别对整个单页面生成组件、静态资源和动态交互开发计划。三个角色是 workflow 中三个独立阶段，分别记录状态、耗时、token 和产物，并在插件 UI 中独立展示。

共同输入：

- `raw.normalized.json`
- `asset-index.json`
- `design-tokens.json`
- `page-layout.md`
- 必须存在的 `frame-screenshot.png` 路径

三个 AI 职责：

1. 组件结构分析 AI（`component-structure-analysis`）
   - 分析整页语义 DOM、组件层级、文档流、Flex/Grid 和样式组织。
   - 识别必要的复用结构，但不为了形式过度拆分单页面。
   - 输出整页 HTML/CSS 实现建议、响应式策略和开发顺序。

2. 静态资源分析 AI（`static-asset-analysis`）
   - 分析整页图片、图标、Logo、背景和装饰元素。
   - 决定使用原图、切片、CSS 绘制还是忽略。
   - 检查 `imageRef`、`copiedPath`、源节点和文件存在状态。
   - 输出资源引用、裁剪、层级、缺失和降级策略。

3. 动态交互分析 AI（`interaction-analysis`）
   - 分析整页可由设计稿合理推导的交互和状态。
   - 明确必须实现、静态呈现和信息不足待确认的行为。
   - 输出最小 JS 数据结构、事件绑定和无障碍建议，不凭空扩展业务逻辑。

输出文件：

- `03-page-plans/component-structure.plan.md`
- `03-page-plans/static-assets.plan.md`
- `03-page-plans/interaction.plan.md`
- 每个角色对应的 `*.prompt.md`；模型正文只保留在最终 `*.plan.md`，不重复生成 `*.response.md`

每份计划必须包含：

- 覆盖整页的明确结论和开发顺序。
- 与本角色相关的源节点 ID。
- 资源角色必须引用 `imageRef` 和 `copiedPath`；其他角色按需引用。
- 实现策略、风险、不确定项、视觉复核项和对代码生成的明确指令。

开发任务：

- 设计三套独立 prompt 模板，明确角色、背景、任务、详细规则和输出。
- 从标准化数据构建精简的单页面上下文，不直接提交原始 `raw.json`。
- 将三个角色编排为三个串行、独立计量的 workflow 阶段。
- 校验必要一级标题，对格式缺失执行一次纠正重试。
- 插件 UI 分别展示三个阶段；运行中的阶段自动展开，完成后收起并允许用户再次展开。

验收标准：

- 单页面具备三份职责不重叠的开发计划。
- 三个 AI 调用在任务状态和插件 UI 中显示为三个独立阶段。
- 每个阶段独立记录输入 token、输出 token、总 token、耗时和产物路径。
- 三份计划能分别指导整页 HTML/CSS、assets 和 JS 开发，并可直接供后续单页面开发阶段汇总。

## 8. 阶段七：单页面整合与组装计划

目标：把三角色单页面计划汇总为可执行的页面级开发方案，解决全局样式、页面顺序、共享资源和最终文件组织。

输入：

- `page-layout.json`
- `page-layout.md`
- `component-structure.plan.md`
- `static-assets.plan.md`
- `interaction.plan.md`
- `asset-index.json`
- `design-tokens.json`

输出：

- `04-assembly/assembly.plan.md`

整合计划应明确：

- 页面文件结构：`index.html`、`styles.css`、`script.js`、`assets/`。
- 全局 CSS 变量。
- 字体、颜色、容器宽度、断点、基础排版。
- 模块渲染顺序。
- 模块之间的上下间距、背景衔接和重叠关系。
- 共享组件，例如按钮、卡片、标签、导航项。
- 共享 JS 数据与事件。
- 图片资源复制和引用规则。
- 哪些地方允许使用绝对定位。
- 哪些地方必须采用文档流、Flex 或 Grid。

开发任务：

- 汇总三份单页面计划。
- 检查三个角色之间的职责冲突和引用冲突，由组装 AI 给出最终裁决并说明依据。
- 统一全局 token 和命名规则。
- 生成代码开发顺序。
- 输出可直接供代码生成 AI 使用的开发指令。
- 将 `assembly-planning` 作为独立 workflow 阶段，记录状态、耗时、token 和产物路径。
- 校验必要一级标题，对格式缺失执行一次纠正重试。

验收标准：

- 代码生成阶段可以只依赖整合计划、三角色页面计划和资源文件完成页面开发。
- 全局样式和模块样式没有明显冲突。
- 资源路径明确可用。
- 组装计划覆盖页面各区域关系，而不是简单拼接三份角色计划。
- 组装阶段在插件 UI 和外部面板中独立展示。

## 9. 阶段八：HTML/CSS/JS 实际开发

目标：根据三角色单页面计划和整合计划生成可本地运行的 HTML 页面。

输出：

- `05-output/index.html`
- `05-output/styles.css`
- `05-output/script.js`
- `05-output/assets/`

开发原则：

- 优先使用正常文档流、Flex、Grid 和相对定位。
- 只在装饰图、复杂重叠、浮层等场景使用绝对定位。
- 保持语义 HTML 结构清晰。
- CSS 变量来自 `design-tokens.json` 和 `assembly.plan.md`。
- 图片路径必须来自 `asset-index.json` 或 `asset-manifest.json` 的 `copiedPath`。
- JS 只实现设计稿可推导出的必要交互，不凭空扩展复杂业务逻辑。
- 首版以设计稿 1920px 桌面基准为主要还原目标，并提供一个 768px 保守断点，窄屏只保证内容可读且无横向滚动。
- 产物使用 React 友好的语义区域和 BEM 命名，但仍为无需构建、可双击打开的原生 HTML/CSS/JS。
- 关键区域、资源和交互分别使用 `data-source-node-id`、`data-asset-id`、`data-action` 保留设计稿追踪关系。

开发任务：

- 调用代码生成 AI 生成初版 HTML/CSS/JS。
- 将 assets 复制到输出目录。
- 运行本地预览或静态检查。
- 检查资源路径是否存在。
- 检查 HTML 语义结构、CSS 命名和 JS 事件绑定。
- 执行 HTML/CSS/JS、资源路径、目录越界和网络引用静态校验，并运行本地 HTTP smoke test。

验收标准：

- 页面可以直接本地预览。
- 主要模块顺序、文本、图片、颜色、间距接近设计稿。
- 关键交互可操作。
- 图片缺失时有可接受降级。
- 输出目录可以被直接打包。

## 10. 阶段九：截图比对、修正与 ZIP 打包

目标：把“生成结果是否接近设计稿”纳入可重复验证流程，并输出最终 ZIP。

输入：

- 设计稿整体截图 `frame-screenshot.png`。
- 生成页面截图 `generated-screenshot.png`。
- HTML/CSS/JS 输出目录。

输出：

- `visual-diff.json`
- `review-report.md`
- `fix-plan.md`
- 修正后的 `05-output/`
- `final/{frameName}.html.zip`

开发任务：

- 使用浏览器打开生成页面并截图。
- 与设计稿整体截图进行尺寸、模块位置、颜色、文本溢出、图片缺失、重叠问题比对。
- 生成视觉差异报告。
- 将差异报告输入 AI，执行至少一轮修正。
- 重新截图并记录修正前后差异。
- 打包 `index.html`、`styles.css`、`script.js` 和 `assets/` 为 ZIP。

验收标准：

- 可以定位明显错位、图片缺失、文本溢出和重叠问题。
- 至少支持一轮自动修正。
- 修正过程有日志和报告。
- 最终产物是一个包含 HTML、CSS、JS 和 assets 的 ZIP 包。

## 11. 阶段十：Workflow 编排与产品化

目标：把阶段三到阶段九编排成稳定可恢复的一键任务。

开发任务：

- 建立 workflow runner。
- 定义每个阶段的输入、输出、状态和失败恢复点。
- 支持从指定阶段重跑，例如只重跑 `layout-analysis`、三个角色分析之一或 `html-generation`。
- 记录每次 AI 调用的 prompt、模型、输入摘要、输出文件和错误信息。
- 支持配置 AI provider、模型、温度、最大上下文、重试次数。
- 外部面板展示阶段进度、中间产物路径、预览入口和下载入口。
- 插件重新打开后展示最近任务状态。
- 对最终 ZIP 提供下载或打开路径。

任务阶段建议：

```text
collect-input
normalize-raw
layout-analysis
component-structure-analysis
static-asset-analysis
interaction-analysis
assembly-planning
html-generation
visual-review
package-files
done
```

验收标准：

- 用户点击“一键生成 HTML”后，无需手动运行命令即可启动完整 workflow。
- 任务状态能准确显示当前阶段。
- 任意阶段失败后能定位失败原因和相关产物。
- 可以从最近成功阶段继续执行。
- 最终产物路径和 ZIP 下载入口明确。

## 12. 推荐里程碑

M1：输入包与一键入口

- 完成阶段三。
- 结果：插件可以按原图/切片策略提交完整 workflow 输入包。

M2：布局转换

- 完成阶段四，阶段五暂缓。
- 结果：从 `raw.json` 得到 HTML 友好的单页面布局文件。

M3：AI 计划链路

- 完成阶段六、阶段七。
- 结果：整个单页面具备三角色开发计划，并能汇总为页面级整合计划。

M4：代码生成闭环

- 完成阶段八、阶段九。
- 结果：可以生成可预览页面，并输出最终 ZIP。

M5：workflow 产品化

- 完成阶段十。
- 结果：插件、MCP、本地服务、外部面板和 AI workflow 形成完整闭环。

## 13. 当前优先级

近期优先做以下事情：

1. 修改插件 UI：在“一键生成 HTML”按钮上方增加图片策略选择，明确标注测试阶段推荐切片、最终生成推荐原图。
2. 固化 `00-input/` 输入包格式，确保 `raw.json`、`assets/`、`asset-manifest.json`、`frame-screenshot.png` 和 `export-options.json` 一起进入 MCP workflow。
3. 实现 `raw.normalized.json`、`asset-index.json`、`ai-layout-context.json`、`page-layout.json` 和 AI 版 `page-layout.md` 的第一版生成。
4. 暂缓模块切片，直接实现整页组件结构、静态资源、动态交互三角色 AI 分析。
5. 将三个角色作为独立 workflow 阶段接入插件 UI，分别显示 token、耗时和产物。
6. 生成第一版 `assembly.plan.md`，让 AI 能据此开发单页 HTML。
7. 打通从一个真实 Frame 到最终 ZIP 的最小闭环，再逐步提高还原质量。
