# MasterGo2HTML 项目 Skill 沉淀

本文用于沉淀本项目开发过程中可复用的工程 skill。这里的 skill 不是泛泛的经验总结，而是面对相似任务时可以直接执行的一组判断规则、输入输出约定、流程步骤和验收标准。

## 1. Design Raw 到 HTML 友好布局转换

### 适用场景

当输入来自 MasterGo、Figma 或类似设计工具，原始数据以绝对坐标、节点树和视觉样式为主，而目标是生成可维护的 HTML/CSS/JS 页面。

### 核心判断

- `raw.json` 是设计稿事实源，不是 HTML 布局方案。
- 绝对坐标只能作为推导依据，不能机械转换成 `position:absolute`。
- 普通内容优先使用文档流、Flex、Grid；absolute 只用于背景装饰、浮层、蒙层、吸附和有证据的重叠。
- 大面积背景层、装饰矩形、蒙版 bounds 不得转成内容区的 `padding`、`margin`、`min-height`。

### 输入

- `00-input/raw.json`
- `00-input/asset-manifest.json`
- `00-input/frame-screenshot.png`
- `00-input/assets/`

### 输出

- `01-normalized/raw.normalized.json`
- `01-normalized/design-tokens.json`
- `02-layout/page-layout.json`
- `02-layout/page-layout.md`

### 执行流程

1. 清洗节点树，保留 `sourceNodeId`、父子关系、可见性、bounds、文本和样式。
2. 提取页面级 token，包括颜色、字体、字号、圆角、阴影、边框和主要间距。
3. 根据非 decorative 内容节点推导模块顺序和内容流。
4. 将背景层标记为 `backgroundLayers`，并设置 `affectsFlow=false`。
5. 生成机器可读的 `page-layout.json` 和给 AI/人工审查的 `page-layout.md`。

### 验收标准

- `page-layout.json` 可被后续 workflow 稳定读取。
- 大部分模块不依赖页面级绝对定位。
- 背景与装饰节点不会制造内容空洞或异常大间距。
- 不确定区域有明确标记，而不是静默猜测。

### 项目落点

- `mcp-server/src/workflow/ai-layout-analysis.js`
- `mcp-server/src/workflow/page-plan-analysis.js`
- `mcp-server/src/workflow/design-to-html-skill.js`
- `mcp-server/test/page-plan-analysis.test.js`

## 2. 多角色页面计划与组装裁决

### 适用场景

当单个 AI 直接生成页面容易遗漏结构、资源或交互细节，需要把页面开发拆成多个职责计划，再统一裁决。

### 核心判断

- 组件结构、静态资源、动态交互是不同职责，应该分别分析。
- 最终代码生成前必须有一个单页面组装计划，统一冲突、命名、资源引用、状态和开发顺序。
- 组装计划不能简单拼接三份计划，必须给出唯一实现决策。

### 输入

- `02-layout/page-layout.json`
- `02-layout/page-layout.md`
- `03-page-plans/component-structure.plan.md`
- `03-page-plans/static-assets.plan.md`
- `03-page-plans/interaction.plan.md`
- `01-normalized/asset-index.json`
- `01-normalized/design-tokens.json`

### 输出

- `04-assembly/assembly.plan.md`

### 执行流程

1. 分别生成组件结构、静态资源、动态交互计划。
2. 汇总三份计划与布局、资源、token 事实。
3. 对节点归属、布局方式、资源路径、交互语义和共享样式做最终裁决。
4. 明确 `index.html`、`styles.css`、`script.js` 和 `assets/` 的职责边界。
5. 输出代码生成步骤的明确指令，避免生成阶段重新做架构决策。

### 验收标准

- `assembly.plan.md` 包含固定一级标题，便于格式校验。
- 冲突有裁决，低置信度区域有复核点。
- 资源路径只来自 `asset-index.json`。
- 后续 HTML 生成可以直接执行该计划，不需要重新规划页面结构。

### 项目落点

- `mcp-server/src/workflow/component-structure-analysis.js`
- `mcp-server/src/workflow/static-asset-analysis.js`
- `mcp-server/src/workflow/interaction-analysis.js`
- `mcp-server/src/workflow/assembly-planning.js`
- `mcp-server/test/assembly-planning.test.js`

## 3. 不可变设计稿文案契约

### 适用场景

当 AI 生成页面代码时，设计稿中的标题、导航、按钮、标签和正文必须逐字保留，不能被模型总结、润色或改写。

### 核心判断

- 可见文字是设计稿事实，不是可自由生成的内容。
- Prompt 中重复塞入长文案容易增加 token，也容易诱导模型改写；应建立单独的不可变文字事实源。
- HTML 中承载文字的元素必须能回链到 `sourceNodeId`。

### 输入

- `01-normalized/raw.normalized.json`

### 输出

- `01-normalized/source-texts.json`
- HTML 中的 `data-text-source-node-id`
- 必要时添加 `data-text-preserve-whitespace="true"`

### 执行流程

1. 从标准化节点中提取所有可见文本。
2. 为每段文本记录 `sourceNodeId`、`characters` 和空白保真需求。
3. 在代码生成 prompt 中声明不可改写契约。
4. 静态校验 HTML 文本是否逐字匹配 `source-texts.json`。
5. 对显式换行、连续空格、制表符使用 `white-space: pre-wrap`。

### 验收标准

- 设计稿中所有可见文字都出现在 HTML 中。
- 文案不被总结、纠错、删减、扩写、同义替换或重新断句。
- 每个承载文本的元素都有对应 `data-text-source-node-id`。
- 空白保真文本有明确 CSS 策略。

### 项目落点

- `mcp-server/src/workflow/immutable-source-texts.js`
- `mcp-server/src/workflow/html-generation.js`
- `mcp-server/test/immutable-source-texts.test.js`
- `mcp-server/test/text-preservation.test.js`

## 4. 节点视觉事实优先级

### 适用场景

当生成页面出现颜色、背景、描边、圆角被 AI 按常见网页风格替换，导致设计稿还原失真。

### 核心判断

- 节点真实样式比语义 token 和 AI 推断优先级更高。
- 大面积纯色背景矩形必须绑定源节点，避免被误当成普通内容尺寸依据。
- 透明节点和透明容器不得被 AI 自行补背景。

### 输入

- `01-normalized/raw.normalized.json`

### 输出

- `01-normalized/node-style-facts.json`
- HTML/CSS 中的 `data-style-source-node-id`

### 执行流程

1. 从节点样式中提取填充、描边、文字色、圆角、透明度和 bounds。
2. 对大面积、不透明、无子节点背景矩形标记 `bindingRequired=true`。
3. 在组装计划中把关键节点样式裁决为 sourceNodeId、CSS 属性、最终值。
4. 在 HTML/CSS 中使用 `data-style-source-node-id` 精确绑定。
5. 静态校验必需绑定是否存在，以及颜色是否逐值一致。

### 验收标准

- 有节点事实时，不用语义 token 或常见网站配色替代精确值。
- 大面积背景节点不会参与内容流间距计算。
- 透明背景不会被自行补色、渐变或遮罩。

### 项目落点

- `mcp-server/src/workflow/node-style-facts.js`
- `mcp-server/src/workflow/html-generation.js`
- `mcp-server/test/node-style-facts.test.js`
- `mcp-server/test/background-decor-mask-assets.test.js`

## 5. 资源导出与引用闭环

### 适用场景

当设计稿包含原图、渲染切片、蒙版、复杂背景、模糊装饰或图片节点，需要保证导出、索引、复制和 HTML 引用一致。

### 核心判断

- 资源路径必须来自 `asset-index.json`，不能让 AI 编造路径。
- 简单图形、纯色块、圆角、阴影优先 CSS；复杂照片、材质、蒙版和渲染切片使用 PNG 资源。
- MasterGo 中“背景装饰 蒙版”类资源应作为背景装饰层，不进入文档流。

### 输入

- `00-input/asset-manifest.json`
- `00-input/assets/`
- `01-normalized/raw.normalized.json`

### 输出

- `01-normalized/asset-index.json`
- `05-output/assets/`
- HTML/CSS 中引用的 `assets/...` 路径

### 执行流程

1. 标准化 `asset-manifest.json` 为 `asset-index.json`。
2. 记录 `imageRef`、`assetId`、`sourceNodeId`、`copiedPath`、`usage` 和 preferred 资源。
3. 为复杂背景、蒙版和切片明确 usage。
4. HTML 生成时只允许引用 `asset-index.json` 中存在的路径。
5. 输出前复制实际资源，并校验引用路径存在。

### 验收标准

- HTML/CSS 不引用网络资源、绝对路径或输出目录外路径。
- 所有 `assets/...` 引用都能在 `asset-index.json` 中找到。
- 蒙版背景资源使用合成切片，而不是误用内部子图片。

### 项目落点

- `mcp-server/src/workflow/static-asset-analysis.js`
- `mcp-server/src/workflow/html-generation.js`
- `mcp-server/src/output-zip.js`
- `docs/asset-export-strategy.md`
- `mcp-server/test/output-zip.test.js`


### 5.1 SVG 光晕与背景装饰的尺寸完整性

#### 适用场景

当设计稿使用 SVG/PNG 光晕、波点、模糊圆、阴影或其他带透明扩散范围的装饰资源，且资源需要超出卡片/模块边界后再裁切时。

#### 已确认的失败模式

- 设计节点的 nominal size 只是设计层级中的视觉节点尺寸，不一定等于导出 SVG 的真实画布尺寸。
- 光晕源 SVG 可能是约 `996×996` 的完整画布，内部核心椭圆和 blur/filter bleed 位于画布中部；若直接设置为 `304×304`，核心和扩散范围都会被压缩，最终表现为颜色覆盖面积过小、大面积留白。
- 页面级 `img { max-width: 100% }` 和 Flex item 默认 shrink 会继续压缩超出父容器的装饰，即使 CSS 已声明了较大的 width/height。
- 插件可能先按 `clipsContent` Frame 的可见区域裁切 PNG。此时文件真实宽高对应 `absoluteRenderBounds ∩ clipping frame bounds`；若仍围绕 nominal bounds 或完整 render bounds 做中心对齐，半出画布的光晕和波点会整体漂移。
- 只修复光晕图片而漏掉设计稿中的卡片底色渐变，仍会造成颜色占比不足。

#### 核心约束

1. **先读真实画布，再定 CSS 尺寸**：使用 SVG 前必须读取文件真实 `width`、`height`、`viewBox`，并检查 `filter`、`feGaussianBlur`、透明 bleed 与实际绘制区域。不得用设计节点 nominal width/height 代替 SVG canvas width/height。
2. **保持完整视觉画布**：真实画布与设计节点尺寸不一致时，优先按完整画布比例显示；若资源索引提供 `renderedLocalBounds`，按其 px `left/top/width/height` 在 `anchorNodeId` 坐标容器内显示。禁止把带 bleed 的整张资源压回主体 bounds，也禁止用 `object-fit: cover`、`background-size: cover` 或 `inset: 0` 二次裁切。
3. **识别 Frame 预裁切画布**：当磁盘 PNG 实测尺寸与 manifest nominal size 不一致时，先计算源节点 `absoluteRenderBounds` 与所有 `clipsContent` 祖先边界的交集。若交集宽高与 PNG 实测宽高一致（允许约 1px 栅格取整误差），PNG 的 `left/top` 必须取交集左上角；不得把 PNG 居中回完整 render bounds。仅在文件尺寸既不匹配完整 render bounds、也不匹配裁切交集时，才使用额外 exporter padding 的中心对齐兜底。
4. **阻断通用图片规则的压缩**：需要溢出并裁切的装饰节点必须显式写出明确 `width`/`height`、`flex: none`、`max-width: none`；必要时同时固定 `min-width`/`min-height`。父容器使用 `position: relative` 和 `overflow: hidden` 负责裁切，而不是缩小装饰本身。
5. **背景层与光晕叠加检查**：同时检查源节点是否存在独立的背景渐变/纯色矩形。背景渐变、光晕和波点属于不同视觉层，必须分别绑定 sourceNodeId 并叠加实现，不得因“光晕已存在”而省略底色渐变。
6. **位置和比例以截图验收**：至少在设计稿基准视口截图复核光晕核心位置、颜色覆盖面积、扩散边界、波点位置和父容器裁切边界；发现颜色占比明显低于设计稿时，优先排查预裁切坐标、画布压缩、`max-width`、Flex shrink 和漏实现背景层。

#### 推荐实现模板

```css
.module {
  position: relative;
  overflow: hidden;
}

.module__halo,
.module__dots {
  position: absolute;
  flex: none;
  max-width: none;
  width: 996px;  /* 以 SVG 真实 canvas/viewBox 或 renderedLocalBounds 为准 */
  height: 996px;
}
```

#### 验收标准

- 装饰 SVG 的真实画布/viewBox 与 CSS 显示尺寸之间有可解释的映射。
- 光晕没有被全局 `img` 规则或 Flex shrink 压缩，颜色覆盖面积接近设计稿。
- 设计稿中的底色渐变、光晕、波点均存在，且层级、位置和裁切边界正确。
- 基准视口截图通过后，才允许继续做移动端裁切/隐藏等响应式降级。


## 6. LLM Workflow 可恢复与可观测执行

### 适用场景

当一个设计稿转 HTML 任务包含多阶段 AI 调用，单次失败成本高，需要能观察进度、保存中间产物、重试和定位问题。

### 核心判断

- 长任务不能留在 MasterGo 插件运行态中，应提交给本地服务执行。
- 每个阶段都要保存 prompt、response、输出产物、耗时、token 使用和错误信息。
- 流式输出要有连接、首 token、空闲和总超时控制。
- AI 输出必须经过格式与静态校验，不合格时最多自动修复一次。

### 输入

- job 输入包
- 模型配置与超时配置

### 输出

- 阶段目录产物
- prompt/response 日志
- job 状态、进度、错误和最终 ZIP

### 执行流程

1. 插件提交 job 后立即保存 `jobId`，长任务交给本地服务。
2. Workflow 按阶段写入目录：`00-input` 到 `05-output`，最终打包到 `final`。
3. LLM 调用优先流式执行，并上报 progress metrics。
4. 对 Markdown 输出做标题校验，对 JSON 代码输出做解析校验。
5. 对 HTML/CSS/JS 做静态校验和 smoke test。
6. 失败时保留 partial response 和失败阶段，方便重试。

### 验收标准

- 用户能通过 job 状态知道当前阶段和错误原因。
- 中间产物足够复现问题，不依赖 MasterGo 当前运行态。
- 生成文件缺失、资源路径错误、JS 语法错误等能在发布前被拦截。

### 项目落点

- `mcp-server/src/server.js`
- `mcp-server/src/workflow/generate-workflow-text.js`
- `mcp-server/src/workflow/stream-progress.js`
- `mcp-server/src/workflow/job-retry.js`
- `mcp-server/test/workflow-streaming.test.js`
- `mcp-server/test/job-retry.test.js`

## 7. Prompt 短规则注入与 Token 控制

### 适用场景

当团队从客户文档、人工经验或失败案例中总结了规则，但不希望每次把整份长文档塞进模型输入。

### 核心判断

- 长经验文档应拆成短规则，并按 workflow 阶段选择性注入。
- 规则要面向行为约束，而不是抽象口号。
- 每条规则都应能关联到某类失败，例如绝对定位滥用、文本溢出、资源编造、状态缺失。

### 输入

- 客户设计稿转 HTML 表述经验
- 历史失败案例
- 当前 workflow 阶段名

### 输出

- 阶段化短规则 prompt

### 执行流程

1. 将经验拆成布局、响应式、状态稳定、素材交付四类。
2. 为每个 workflow 阶段配置需要注入的规则类别。
3. 默认开启短规则注入。
4. 用环境变量支持关闭，便于 A/B 测试 token 与效果。

### 验收标准

- 不把完整客户文档注入每次 LLM 输入。
- 不同阶段只收到与职责相关的规则。
- 可通过测试确认规则开启/关闭行为稳定。

### 项目落点

- `docs/design-to-html-skill.md`
- `mcp-server/src/workflow/design-to-html-skill.js`
- `mcp-server/test/design-to-html-skill.test.js`

## 推荐下一步

优先把上述 7 个 skill 中的前 3 个沉淀成正式团队材料：

1. Design Raw 到 HTML 友好布局转换。
2. 多角色页面计划与组装裁决。
3. 不可变设计稿文案契约。

这三个最能体现本项目区别于普通“AI 生成页面”的工程价值：它们解决的是设计稿事实如何被保留、如何转成可维护页面、以及如何约束 AI 不偏离事实。
