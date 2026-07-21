# MasterGo2JSON HTML 生成 Workflow 开发计划

## 0. 当前定位

MasterGo 插件已经完成从设计稿提取结构的基础能力，MCP 与 AI 模型链路也已经打通。后续开发重点不再是单点能力验证，而是把“插件采集数据、MCP 编排任务、AI 分工规划、最终生成 HTML”串成可重复、可调试、可恢复的完整 workflow。

核心目标：

- 用户在插件中点击“一键生成 HTML”后，系统自动采集当前 Frame 的结构、图片资源和资源映射。
- 将 `raw.json` 从 MasterGo 绝对布局数据转换为适合 HTML 开发的页面布局描述。
- 按页面模块切片，并让不同职责的 AI 分别分析组件结构、静态资源和动态交互。
- 汇总模块计划，形成页面级整合组装方案。
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
  -> 模块切片
  -> 三角色 AI 生成模块开发计划
  -> 生成模块整合计划
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
    layout-analysis-report.md

  03-modules/
    modules.index.json
    {moduleId}.module.json

  04-module-plans/
    {moduleId}.component.plan.md
    {moduleId}.asset.plan.md
    {moduleId}.interaction.plan.md

  05-assembly/
    assembly.plan.json
    assembly.plan.md

  06-output/
    index.html
    styles.css
    script.js
    assets/

  07-review/
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
- 这一阶段以 AI 布局分析模块为主，由规则负责输出结构化上下文、基础清洗和兜底草稿，最终的 `page-layout.md` 由 AI 生成。对外汇报时可称为“布局分析 Agent”，但代码层面按职责命名为 AI layout analysis。

核心产物：

- `raw.normalized.json`：清洗后的节点结构。
- `asset-index.json`：标准化图片索引。
- `design-tokens.json`：颜色、字体、字号、间距、圆角、阴影、边框等视觉 token。
- `page-layout.json`：页面整体布局结构，供程序切片和校验。
- `ai-layout-context.json`：AI 布局分析模块的输入上下文，包含节点摘要、资源索引、视觉层级和规则草稿。
- `page-layout.md`：页面布局说明，由 AI 布局分析模块生成，供后续模块切片和开发计划使用。

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

## 6. 阶段五：模块切片

目标：基于页面整体布局文件，把页面拆成适合 AI 单独分析和开发的模块。

输入：

- `raw.normalized.json`
- `asset-index.json`
- `design-tokens.json`
- `page-layout.json`
- `page-layout.md`

输出：

- `modules.index.json`
- `{moduleId}.module.json`

`modules.index.json` 应包含：

- 模块 ID。
- 模块名称。
- 模块顺序。
- 模块边界。
- 对应源节点 ID 列表。
- 对应资源 ID 列表。
- 模块类型，例如 header、hero、content-section、card-list、form、footer。
- 是否依赖跨模块背景或全局装饰。

`{moduleId}.module.json` 应包含：

- 模块内部节点树。
- 文本内容。
- 图片引用。
- 样式摘要。
- 布局约束。
- 组件候选结构。
- 重复项模式，例如列表、卡片、步骤、导航项。
- 状态候选，例如 hover、active、selected、expanded。
- 需要保留的源节点 ID 和图片映射。

开发任务：

- 根据 `page-layout.json` 切分模块。
- 保留每个模块的视觉实现信息，而不只是业务文案。
- 处理跨模块背景、浮层、装饰元素。
- 识别重复结构并抽象为 `itemPattern`。
- 对每个节点标记归属：module、global、decorative、ignored。

验收标准：

- 页面关键节点都有明确归属。
- 每个模块 JSON 可以独立供 AI 生成开发计划。
- 模块切片不会丢失字体、颜色、间距、图片、圆角、阴影等 HTML 生成关键信息。
- 重复结构不会只表现为大量静态 DOM 节点。

## 7. 阶段六：三角色 AI 生成模块开发计划

目标：对每个模块分别生成组件、静态资源、动态交互三个方向的开发计划。

三个 AI 职责：

1. 组件结构 AI
   - 分析模块 DOM 结构。
   - 决定语义标签、组件层级、Flex/Grid 布局方式。
   - 输出模块 HTML/CSS 实现建议。

2. 静态资源 AI
   - 分析图片、图标、背景、装饰元素的使用方式。
   - 决定使用原图、切片、CSS 绘制还是忽略。
   - 检查 `imageRef` 和 `copiedPath` 的对应关系。
   - 输出资源缺失或降级策略。

3. 动态交互 AI
   - 分析模块可能存在的交互。
   - 规划 hover、active、tab、筛选、展开、轮播、表单、分页等行为。
   - 明确哪些交互短期只做静态模拟。
   - 输出 JS 数据结构和事件绑定建议。

输出文件：

- `{moduleId}.component.plan.md`
- `{moduleId}.asset.plan.md`
- `{moduleId}.interaction.plan.md`

每份计划必须包含：

- 引用的 `moduleId`。
- 引用的源节点 ID。
- 引用的资源 `imageRef` 和 `copiedPath`。
- 实现策略。
- 风险与不确定项。
- 对最终代码生成的明确要求。

开发任务：

- 设计三套 prompt 模板。
- 控制每个 AI 角色的上下文输入，避免塞入整个 `raw.json`。
- 校验计划中引用的模块 ID、节点 ID、图片路径是否有效。
- 对低置信度或格式错误的计划执行重试。

验收标准：

- 每个模块都有三份计划。
- 组件计划能指导 HTML/CSS 结构开发。
- 资源计划能指导 assets 引用和缺失降级。
- 交互计划能指导 JS 行为开发。
- 计划文件可以被下一阶段汇总。

## 8. 阶段七：模块整合与组装计划

目标：把模块级计划汇总为页面级开发方案，解决全局样式、模块顺序、共享资源和最终文件组织。

输入：

- `page-layout.json`
- `page-layout.md`
- `modules.index.json`
- 所有 `{moduleId}.module.json`
- 所有模块三角色计划
- `asset-index.json`
- `design-tokens.json`

输出：

- `assembly.plan.json`
- `assembly.plan.md`

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

- 汇总所有模块计划。
- 检查模块间样式冲突。
- 统一全局 token 和命名规则。
- 生成代码开发顺序。
- 输出可直接供代码生成 AI 使用的开发指令。

验收标准：

- 代码生成阶段可以只依赖整合计划、模块计划和资源文件完成页面开发。
- 全局样式和模块样式没有明显冲突。
- 资源路径明确可用。
- 组装计划覆盖模块间关系，而不是简单拼接模块计划。

## 9. 阶段八：HTML/CSS/JS 实际开发

目标：根据模块计划和整合计划生成可本地运行的 HTML 页面。

输出：

- `06-output/index.html`
- `06-output/styles.css`
- `06-output/script.js`
- `06-output/assets/`

开发原则：

- 优先使用正常文档流、Flex、Grid 和相对定位。
- 只在装饰图、复杂重叠、浮层等场景使用绝对定位。
- 保持语义 HTML 结构清晰。
- CSS 变量来自 `design-tokens.json` 和 `assembly.plan.md`。
- 图片路径必须来自 `asset-index.json` 或 `asset-manifest.json` 的 `copiedPath`。
- JS 只实现设计稿可推导出的必要交互，不凭空扩展复杂业务逻辑。

开发任务：

- 调用代码生成 AI 生成初版 HTML/CSS/JS。
- 将 assets 复制到输出目录。
- 运行本地预览或静态检查。
- 检查资源路径是否存在。
- 检查 HTML 语义结构、CSS 命名和 JS 事件绑定。

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
- 修正后的 `06-output/`
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
- 支持从指定阶段重跑，例如只重跑 `layout-analysis`、`ai-planning` 或 `html-generation`。
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
module-slicing
module-planning
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

M2：布局转换与模块切片

- 完成阶段四、阶段五。
- 结果：从 `raw.json` 得到 HTML 友好的页面布局文件和模块 JSON。

M3：AI 计划链路

- 完成阶段六、阶段七。
- 结果：每个模块都有三角色开发计划，并能汇总为页面级整合计划。

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
4. 实现基于 `page-layout.json` 的模块切片，生成 `modules.index.json` 和 `{moduleId}.module.json`。
5. 设计三角色 AI prompt，并跑通一个模块的组件计划、资源计划和交互计划。
6. 生成第一版 `assembly.plan.md`，让 AI 能据此开发单页 HTML。
7. 打通从一个真实 Frame 到最终 ZIP 的最小闭环，再逐步提高还原质量。
