# MasterGo2JSON AI 工作流开发计划

## 阶段 0：现状固化与样例基线

目标：把当前插件能力和样例页面固定为后续开发基线。

交付内容：

- 当前导出格式说明：`raw.json`、`asset-manifest.json`、`assets/original`、`assets/rendered`。
- 至少 1 个真实页面导出包，作为回归样例。
- 当前 `job-list.modules.example.json` 的字段复盘，明确它只覆盖业务语义和部分模块结构，不能直接作为完整 CSS 生成 schema。
- mentor HTML 成品反向复盘，提取其中已经存在但 example JSON 缺失的视觉字段、状态样式、交互逻辑和响应式策略。
- 导出性能基线：节点数量、图片数量、原图导出耗时、切片导出耗时、ZIP 大小。
- 阶段 0 基线文档：`docs/phase-0-baseline.md`。

验收标准：

- 可以用同一份样例数据重复运行后续 workflow。
- 所有关键字段都能追溯到 `raw.json` 或 `asset-manifest.json`。
- 明确哪些字段属于业务语义层，哪些字段属于视觉实现层。
- 能列出从 mentor HTML 反推得到的 CSS 必备字段清单。

## 阶段 1：导出性能与体验优化

目标：先解决“大图导出慢、像卡住”的体验问题，保证插件是稳定的数据入口。

开发任务：

- 优化导出策略：默认只导出结构和资源引用。
- 增强进度反馈：显示当前阶段、已完成数量、总数、当前资源名称、失败数量。
- 增加导出配置：仅结构、原图、渲染切片、全部导出。
- 增加资源超时与失败记录：失败不阻断整体导出。
- 增加大图提示：资源数量或预计体积较大时提醒用户。
- 设计增量补导方案：先导出 `reference-only`，后续按需补导指定 asset。
- 明确禁止把“当前页面所有 Frame 的全量静态资源导出”作为默认同步主路径。
- 明确当前自动切片不可靠，只能作为实验性辅助能力，后续改为计划型节点切片。

交付内容：

- 插件 UI 导出状态升级。
- 资源导出错误报告字段。
- 导出结果 summary。
- 性能测试记录。
- 阶段 1 实施记录：`docs/phase-1-export-ux.md`。
- 静态资源导出策略：`docs/asset-export-strategy.md`。

验收标准：

- 大图或多图导出时 UI 持续有进度变化。
- 单个资源失败不会导致整个导出失败。
- 用户可以选择跳过耗时图片导出，仅保留资源引用。
- 一键导出当前页面所有 Frame 时，默认导出结构和资源引用，静态资源走后续补导计划。

## 阶段 2：中间产物 Schema 设计

目标：定义 AI 工作流的稳定数据契约。

开发任务：

- 定义 `raw.normalized.json` schema。
- 定义 `asset-index.json` schema。
- 定义 `asset-export-plan.json` schema。
- 定义 `design-tokens.json` schema。
- 定义 `page-layout.json` schema。
- 定义 `modules.index.json` 和 `*.module.json` schema。
- 定义 `assembly.plan.json` schema。
- 明确 Markdown 文件模板：`page-layout.md`、`*.plan.md`、`assembly.plan.md`、`review-report.md`。
- 增加 schema 校验脚本。

推荐格式：

- `*.json`：所有需要程序消费、切片、校验、合并、重试的产物。
- `*.md`：所有需要 AI 阅读、人工审查、表达判断依据的产物。

交付内容：

- `docs/schemas.md` 或 `schemas/*.schema.json`。
- Markdown 模板。
- 基于样例页面的完整 workflow 目录样例。
- `job-list.modules.example.json` 字段取舍报告，区分保留、扩展、废弃和迁移字段。

验收标准：

- 每个中间 JSON 都能通过 schema 校验。
- Markdown 中的模块 ID、节点 ID、资产 ID 能回链到 JSON。
- schema 能表达 CSS 生成所需的核心设计信息，包括字体、颜色、间距、圆角、阴影、边框、背景、模糊、层级、状态样式和响应式策略。

## 阶段 3：Raw 标准化与资源索引

目标：把插件原始输出转成更适合分析和切片的数据。

开发任务：

- 读取 `raw.json` 和 `asset-manifest.json`。
- 过滤不可见节点和无效字段。
- 统一坐标、尺寸、颜色、字体、阴影、圆角等表示。
- 补全 `assetId`、`copiedPath`、`sourceNodes` 关系。
- 识别基础节点语义：container、text、image、background、icon、decorative、listCandidate。
- 抽取页面级设计 token：颜色、字体、字号、行高、字重、圆角、阴影、边框、背景模糊、间距、z-index。
- 判断图片资源用途和优先级，生成按需补导计划。
- 判断切片候选节点，生成计划型切片任务，而不是依赖首轮自动切片完整性。
- 输出 `raw.normalized.json`、`asset-index.json`、`asset-export-plan.json` 和 `design-tokens.json`。

交付内容：

- 标准化脚本或模块。
- `00-source/raw.normalized.json`。
- `00-source/asset-index.json`。
- `00-source/asset-export-plan.json`。
- `00-source/design-tokens.json`。
- 标准化日志。

验收标准：

- 所有图片节点都能找到 `assetId` 或明确标记缺失。
- 所有节点保留 `sourceNodeId`。
- 标准化结果体积低于原始 `raw.json`，且不丢失生成 HTML 必需信息。
- `design-tokens.json` 能覆盖 mentor HTML 中出现的主要 CSS 决策，例如 `#F8FAFD` 页面背景、`24px` 卡片圆角、`backdrop-filter: blur(20px)`、卡片 hover 阴影和 MiSans/FZLanTingHei 字体族。
- `asset-export-plan.json` 能把资源分为 critical/high/normal/low，并明确哪些需要补导，哪些可以降级或忽略。
- `asset-export-plan.json` 能明确哪些节点需要计划型切片、使用什么边界策略，以及切片失败时如何降级。

## 阶段 4：页面布局分析

目标：从绝对布局推导出 HTML 友好的页面结构。

开发任务：

- 基于规则识别纵向模块顺序。
- 基于节点边界识别 Header、Hero、内容区、Footer、浮层、背景层。
- 推导页面宽度、内容容器宽度、模块高度、模块间距。
- 识别相对布局模式：居中容器、左右栏、卡片列表、等距步骤、栅格。
- 结合 AI 生成布局解释和不确定项说明。

交付内容：

- `01-layout/page-layout.json`。
- `01-layout/page-layout.md`。
- 布局分析提示词模板。

验收标准：

- 页面模块顺序与设计稿视觉顺序一致。
- 大部分模块不再依赖页面级 absolute 定位描述。
- 不确定的布局判断有明确标记，而不是静默猜测。

## 阶段 5：模块切片

目标：按页面模块拆分上下文，降低 AI 单次输入复杂度。

开发任务：

- 根据 `page-layout.json` 生成 `modules.index.json`。
- 为每个模块生成 `*.module.json`。
- 模块内保留文本、图片、样式摘要、布局边界、布局约束、状态样式、子节点树。
- 识别重复结构并生成 `itemPattern`，例如职位卡片、流程步骤、导航项。
- 处理跨模块背景图和重叠装饰元素。

交付内容：

- `02-modules/modules.index.json`。
- 每个模块一个 `*.module.json`。
- 模块切片日志。

验收标准：

- 每个页面节点要么归属某个模块，要么被标记为 ignored/decorative/global。
- 重复列表不以大量静态 DOM 节点作为唯一表达。
- 模块 JSON 可独立供 AI 生成计划。
- 模块 JSON 不能只包含业务文字，还必须包含生成模块 CSS 所需的视觉属性和布局约束。

## 阶段 6：多角色 AI 模块计划

目标：让三个不同职责的 AI 分别给出模块开发方案。

开发任务：

- 设计组件计划 prompt。
- 设计静态资源计划 prompt。
- 设计动态交互计划 prompt。
- 增加计划结果校验：是否引用有效模块 ID、节点 ID、资产 ID。
- 为失败或低置信度计划增加重试机制。

交付内容：

- `03-plans/*.component.plan.md`。
- `03-plans/*.asset.plan.md`。
- `03-plans/*.interaction.plan.md`。
- prompt 模板和调用参数说明。

验收标准：

- 每个模块至少有三份计划。
- 组件计划说明 DOM 和 CSS 布局策略。
- 资源计划说明图片引用、缺失降级和装饰资源取舍。
- 交互计划说明状态、事件和模拟数据。

## 阶段 7：模块整合计划

目标：把模块级计划合并成可执行的页面级生成方案。

开发任务：

- 汇总所有模块计划。
- 统一全局 CSS 变量：字体、颜色、容器宽度、断点、z-index。
- 确定文件组织：`index.html`、`styles.css`、`script.js`、`assets/`。
- 处理模块间共享数据和交互。
- 处理背景连续、模块重叠、吸顶导航、页面滚动等页面级问题。

交付内容：

- `04-assembly/assembly.plan.json`。
- `04-assembly/assembly.plan.md`。
- 整合计划校验脚本。

验收标准：

- 代码生成 AI 可以只依赖整合计划、模块计划和资源文件生成页面。
- 全局样式和模块样式没有明显冲突。
- 图片资源路径明确可用。

## 阶段 8：HTML 代码生成

目标：生成可运行、高保真的单页 HTML。

开发任务：

- 基于整合计划生成 `index.html`、`styles.css`、`script.js`。
- 复制或引用静态资源。
- 实现模块 DOM、样式和基础交互。
- 使用正常文档流、flex、grid、相对定位作为主布局方式。
- 对装饰图、重叠视觉和特殊背景谨慎使用 absolute。

交付内容：

- `05-output/index.html`。
- `05-output/styles.css`。
- `05-output/script.js`。
- `05-output/assets/`。

验收标准：

- 页面可以本地预览。
- 主体模块顺序、文本、图片、颜色、间距接近设计稿。
- 核心交互可操作。
- 缺失资源有可接受降级。

## 阶段 9：截图比对与自动修正

目标：把“看起来像不像”变成可重复的验证流程。

开发任务：

- 支持保存设计稿整体截图。
- 使用浏览器自动打开生成页面并截图。
- 生成视觉差异报告：尺寸、模块位置、颜色、图片缺失、文本溢出、重叠。
- 将差异报告输入 AI，执行一轮修正。
- 保留每轮修正记录。

交付内容：

- `06-qa/generated-screenshot.png`。
- `06-qa/visual-diff.json`。
- `06-qa/review-report.md`。
- 修正后的输出文件。

验收标准：

- 可以定位明显错位、图片缺失、文本溢出。
- 至少支持一轮自动修正。
- 修正前后有可对比记录。

## 阶段 10：工作流编排与产品化

目标：把分散脚本变成稳定工作流。

开发任务：

- 提供一键运行命令：从导出包到最终 HTML。
- 支持从指定阶段恢复。
- 支持配置 AI provider、模型、温度、最大上下文、重试次数。
- 支持保存运行日志。
- 插件 UI 增加“下一步处理说明”或导出包使用提示。

交付内容：

- CLI 或本地工作流入口。
- 配置文件示例。
- 错误处理和恢复文档。
- 最小使用说明。

验收标准：

- 用户导出 ZIP 后，可以用一条命令生成 HTML。
- 任意阶段失败后，可以从最近成功产物继续。
- 日志足够定位是导出、标准化、AI 计划还是代码生成失败。

## 建议里程碑

M1：稳定导出与 schema

- 完成阶段 0、1、2。
- 结果：当前插件成为稳定数据入口，后续开发有明确数据契约。

M2：布局与模块计划

- 完成阶段 3、4、5、6。
- 结果：从 raw 数据生成页面布局、模块切片和多角色计划。

M3：组装与代码生成

- 完成阶段 7、8。
- 结果：能生成可预览的 HTML 页面。

M4：视觉 QA 与闭环

- 完成阶段 9、10。
- 结果：具备截图比对、自动修正、失败恢复和一键运行能力。

## 当前优先开发建议

下一步优先做三件事：

1. 固化 schema，尤其是 `page-layout.json`、`*.module.json`、`assembly.plan.json`。
2. 优化资源导出体验，避免大图导出阻塞用户信心。
3. 基于 `job-list.modules.example.json` 反推第一版模块切片器，先让一个真实页面跑通。
4. 基于 mentor HTML 反推 CSS 字段清单，补齐 `design-tokens.json` 和 `*.module.json` 的视觉实现层字段。
