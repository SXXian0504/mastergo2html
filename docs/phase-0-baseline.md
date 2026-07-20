# 阶段 0 基线复盘

## 1. 结论摘要

阶段 0 的核心结论是：当前仓库已有“插件导出能力”和一个“业务语义模块 JSON 样例”，但还没有足以支撑高保真 HTML/CSS 生成的正式 schema。

`job-list.modules.example.json` 可以保留为业务语义样例，用于说明页面模块、文案、列表数据、筛选项、链接和资源引用。但它不能作为完整 schema，因为它缺少 CSS 生成必需的视觉实现信息。mentor 提供的 HTML 成品反而暴露了最终生成所需的另一层信息：视觉 token、布局约束、状态样式、交互逻辑和响应式策略。

后续 schema 需要拆成两层：

- 业务语义层：页面是什么，包含模块、文案、列表、筛选、链接、分页、业务交互含义。
- 视觉实现层：页面如何被 CSS/HTML 实现，包含颜色、字体、字号、圆角、阴影、边框、模糊、z-index、布局约束、状态样式、响应式策略。

## 2. 当前导出格式说明

当前插件代码中已经定义的导出包结构如下：

```text
export.zip
  raw.json
  asset-manifest.json
  assets/
    original/*.png
    rendered/*.png
```

### 2.1 `raw.json`

来源：插件主进程扫描当前选中节点生成。

当前字段：

- `version`：固定为 `mastergo2json.raw.v1`。
- `generatedAt`：导出时间。
- `page.id`：当前 MasterGo 页面 ID。
- `page.name`：当前 MasterGo 页面名称。
- `selection`：选中根节点的序列化结果。
- `assetManifestFile`：固定指向 `asset-manifest.json`。

节点快照当前保留：

- 基础信息：`id`、`name`、`type`、`children`。
- 布局信息：`x`、`y`、`width`、`height`、`absoluteBoundingBox`、`absoluteRenderBounds`、`relativeTransform`、`rotation`。
- Auto Layout 相关：`flexMode`、`flexWrap`、`itemSpacing`、`mainAxisAlignItems`、`crossAxisAlignItems`、`mainAxisSizingMode`、`crossAxisSizingMode`、`paddingTop`、`paddingRight`、`paddingBottom`、`paddingLeft`。
- 视觉样式：`fills`、`strokes`、`effects`、`opacity`、`blendMode`、`cornerRadius`、`cornerSmooth`、四角圆角、描边属性。
- 文本信息：`characters`、`textAlignHorizontal`、`textAlignVertical`、`textAutoResize`、`paragraphSpacing`、`textRuns`。
- 其他：`clipsContent`、`overflowDirection`、`hyperlinks`。

阶段 0 判断：

- `raw.json` 是后续标准化的可靠来源。
- 它包含很多 CSS 源字段，但仍是 MasterGo 节点语义，不是 HTML 生成语义。
- 下一阶段不能直接让 AI 从 `raw.json` 生成 HTML，应先转换为 `raw.normalized.json`、`design-tokens.json`、`page-layout.json` 和模块切片。

### 2.2 `asset-manifest.json`

来源：插件扫描图片填充的 `imageRef` 并去重生成。

当前字段：

- `version`：固定为 `mastergo2json.asset-manifest.v1`。
- `generatedAt`：导出时间。
- `source.pageId`、`source.pageName`、`source.selectionIds`。
- `assets[]`：图片资源记录。
- `files[]`：已导出或预期导出的文件清单。

`assets[]` 当前保留：

- `assetId`
- `kind`
- `imageRef`
- `status`
- `sourceNodes`
- `suggestedFile`
- `copiedPath`
- `originalFileName`
- `scaleMode`
- `ratio`
- `alpha`
- `renderedAssets`
- `error`

阶段 0 判断：

- `asset-manifest.json` 是图片引用回链的核心。
- 后续 `asset-index.json` 应在它的基础上补充资源用途判断，例如 background、logo、icon、decorative、content-image、rendered-slice。
- HTML 生成时必须优先使用 `copiedPath`，缺失时按照资源计划降级。

### 2.3 `assets/original/*.png`

含义：由 `mg.getImageByHref(imageRef).getBytesAsync()` 读取的原始图片。

当前策略：

- 默认关闭。
- 单张图片读取超时为 8000 ms。
- 导出失败时资源状态会写入 `reference-only` 或 `export-error`。

阶段 0 判断：

- 原图适合 logo、icon、背景图和可直接复用的图片。
- 大图会导致用户感知变慢，应在阶段 1 做按需补导、失败重试和大资源提示。

### 2.4 `assets/rendered/*.png`

含义：由节点 `exportAsync({ format: 'PNG' })` 生成的渲染切片。

当前策略：

- 默认关闭。
- 单个切片导出超时为 12000 ms。
- 输出 `assetId` 为 `slice_0001` 形式。
- 记录切片来源节点、尺寸、导出 scale 和错误。

阶段 0 判断：

- 渲染切片适合复杂组合图、无法可靠拆成 DOM/CSS 的装饰图、特殊视觉层。
- 不应滥用切片，否则会降低 HTML 可维护性和响应式能力。

## 3. 样例文件基线

当前可用样例：

- `job-list.modules.example.json`
- `/Users/xiansongxin/Documents/MasterGo/设计页面/校招官网-岗位列表/应届生-岗位列表-实验.html`

当前缺失样例：

- 真实导出的 `raw.json`。
- 真实导出的 `asset-manifest.json`。
- 真实导出的 `assets/original` 和 `assets/rendered` 文件夹。
- 页面整体设计稿截图。

建议补齐：

```text
fixtures/job-list-export/
  raw.json
  asset-manifest.json
  assets/
    original/
    rendered/
  reference/
    mentor-output.html
    design-screenshot.png
```

说明：阶段 0 暂不复制 mentor HTML 到仓库，避免引入外部资源路径和字体依赖问题。后续如要做自动回归，应把它整理成 fixture，并补齐资源。

## 4. `job-list.modules.example.json` 字段复盘

### 4.1 文件统计

- 文件大小：12227 bytes。
- `version`：`mastergo2json.modules.v1`。
- 模块数量：5。
- 模块 ID：`header`、`hero`、`process`、`job-search`、`footer`。
- 模块类型：`Header`、`HeroBanner`、`RecruitmentProcess`、`JobSearchSection`、`Footer`。
- `assetId` 引用数量：17。
- 唯一 `assetId` 数量：17。
- `sourceNodeId` 数量：19。
- 职位条目数量：8。

### 4.2 建议保留字段

这些字段适合作为业务语义层或模块索引的一部分保留：

- `version`
- `source`
- `page.route`
- `page.title`
- `page.layout.width`
- `page.layout.height`
- `page.layout.contentWidth`
- `modules[].id`
- `modules[].type`
- `modules[].sourceNodeId`
- `modules[].layout`
- `navItems`
- `copy`
- `steps`
- `sidebar.search`
- `sidebar.filters`
- `results.total`
- `results.summaryText`
- `results.selectedFilters`
- `results.clearAction`
- `results.items`
- `results.pagination`
- `footer` 中的链接、logo、社交资源和版权字段
- `renderHints.componentOrder`
- `renderHints.assetResolution`
- `renderHints.jobCardPattern`

### 4.3 需要扩展字段

这些字段现在不足，需要进入正式 schema：

- `moduleRole`：模块在页面中的语义角色，例如 navigation、hero、content、sidebar、list、footer。
- `layoutIntent`：从绝对坐标推导出的布局意图，例如 fixed、normal-flow、centered-container、two-column、card-list、overlay。
- `constraints`：宽高、最小宽度、最大宽度、内容宽度、间距、对齐、是否可流式。
- `visualStyle`：模块级背景、圆角、阴影、边框、模糊、透明度、z-index。
- `textStyles`：模块内文本 token，包含字体族、字号、行高、字重、颜色、对齐。
- `stateStyles`：hover、active、disabled、checked、indeterminate、collapsed、focus-within。
- `assetUsage`：图片资源用途，例如 background、logo、icon、decorative、connector、social-icon。
- `renderStrategy`：DOM/CSS 实现、图片实现、渲染切片实现、忽略或降级。
- `responsiveStrategy`：1920 设计宽缩放、断点、移动端降级。
- `interactionModel`：状态、事件、目标元素、DOM 更新、副作用。

### 4.4 不应直接进入正式 schema 的内容

- 过度业务定制的字段名，例如只适用于岗位列表页的 `recruitmentLogo` 可迁移为更通用的 `brandMarks` 或 `assets`。
- 仅靠自然语言表达的 `renderHints.assetResolution`，后续应拆成机器可读的资源策略。
- 缺少样式上下文的 `layout` 绝对坐标，后续应保留为 `sourceBounds`，并增加 `layoutIntent` 和 `constraints`。

## 5. mentor HTML 反向复盘

mentor HTML 文件大小为 59815 bytes。它不是理想最终架构，因为它仍大量使用 inline style 和绝对定位，但它提供了非常有价值的“最终 CSS 信息样本”。

### 5.1 HTML 统计

- inline style 数量：152。
- `data-node-id` 数量：114。
- `font-family` 数量：61。
- `position: absolute` 数量：99。
- `position: fixed` 数量：1。
- `display: flex` 数量：34。
- `border-radius` 数量：19。
- `backdrop-filter` 数量：4。
- `box-shadow` 数量：1。
- `transition` 数量：10。
- `addEventListener` 数量：10。
- `classList` 使用数量：28。

### 5.2 颜色 token

mentor HTML 中高频颜色：

- `#000E26`：主文字和深色图形。
- `#FFFFFF`：卡片和导航文字。
- `rgba(0,14,38,0.6)`：次级正文。
- `#0C70DB`：主蓝色交互态。
- `rgba(255,255,255,0.6)`：半透明白色背景。
- `#D0D8E5`：边框和分割线。
- `#F8FAFD`：页面背景。
- `#0057E8`：强调蓝色文字。
- `#EDF4FF`：Footer 背景。

正式 schema 需要把颜色抽成 `design-tokens.json.colors`，并保留每个 token 的来源节点或使用场景。

### 5.3 字体 token

mentor HTML 中出现的字体族：

- `FZLanTingHei-R-GBK`
- `MiSans`
- `FZLanTingHei-DB-GBK`
- `FZLanTingHei-M-GBK`
- `HarmonyOS Sans TC`

正式 schema 需要记录：

- 字体族。
- 字重。
- 字号。
- 行高。
- 字体缺失降级，例如 `MiSans, system-ui, sans-serif`。
- 字体包是否可用，字体资源路径是否存在。

### 5.4 布局和 CSS 必备字段

mentor HTML 暴露出的 CSS 生成必备字段：

- 页面基准宽度：`1920px`。
- 页面设计高度：`3491px`。
- 页面缩放策略：`window.innerWidth / 1920`，缩放 `.page-wrapper` 和 fixed nav。
- 导航：`position: fixed`、`z-index: 9999`、背景半透明、背景模糊。
- 主页面容器：固定设计宽度、相对定位、整体缩放。
- Hero 背景：全宽图片、`object-fit: cover`。
- 内容大背景：半透明白色、`border-radius: 24px`、`backdrop-filter: blur(20px)`。
- 左右栏：左侧筛选栏、右侧岗位列表、分割线。
- 卡片列表：卡片宽高、间距、圆角、hover 阴影和上移。
- 筛选标签：flex wrap、gap、边框、删除图标。
- Footer：固定高度、浅蓝背景、多列内容、社交图标。

这些字段应该进入 `page-layout.json`、`design-tokens.json` 和 `*.module.json`，不能只放在 Markdown 解释里。

### 5.5 状态样式和交互逻辑

mentor HTML 中的状态样式：

- `.nav-hidden`
- `.page-arrow.disabled`
- `.job-card:hover`
- `.search-box:hover`
- `.search-box:focus-within`
- `.filter-tag:hover`
- `.cb-wrap.checked`
- `.cb-wrap.indeterminate`
- `.section-header.collapsed`
- `.section-content.collapsed`

mentor HTML 中的交互逻辑：

- 滚动时隐藏/显示导航。
- checkbox 勾选、取消、半选。
- 父级筛选项和子级筛选项联动。
- 已选筛选标签生成和删除。
- 清除全部筛选。
- 折叠/展开筛选分组。
- 导航点击移动下划线。
- 分页按钮 disabled 状态。
- 根据筛选标签高度重新定位岗位卡片和分割线。
- 根据窗口宽度整体缩放页面。

这些信息应进入 `interaction.plan.md` 和可机器读取的 `interactionModel`，其中状态样式应进入 `stateStyles`。

## 6. 性能基线

当前只能从代码中得到静态性能基线，缺少真实导出包运行数据。

已知配置：

- 原图导出默认关闭。
- 渲染切片默认关闭。
- 原图读取单资源超时：8000 ms。
- 渲染切片单资源超时：12000 ms。
- 扫描节点每 50 个节点上报一次进度。
- 序列化节点每 50 个节点上报一次进度。
- 每个资源处理后会 `yieldToUI()`，避免 UI 完全无响应。
- 当前资源导出为串行处理。

阶段 0 暂缺的实测指标：

- 真实 `raw.json` 文件大小。
- 真实 `asset-manifest.json` 文件大小。
- 节点数量。
- 图片资源数量。
- 原图导出总耗时。
- 渲染切片总耗时。
- ZIP 文件大小。
- 最大单图耗时。
- 失败资源数量。

建议阶段 1 开始前补一次真实导出测试，记录如下表格：

| 样例 | 节点数 | 图片数 | 原图导出 | 切片导出 | 总耗时 | ZIP 大小 | 失败数 | 备注 |
| --- | ---: | ---: | --- | --- | ---: | ---: | ---: | --- |
| 校招岗位列表 | 待补 | 待补 | 关闭/开启 | 关闭/开启 | 待补 | 待补 | 待补 | 需要真实导出包 |

## 7. 阶段 0 验收状态

| 验收项 | 状态 | 说明 |
| --- | --- | --- |
| 当前导出格式说明 | 已完成 | 基于当前 TypeScript 类型和 `lib/main.ts` 实现复盘。 |
| 至少 1 个真实页面导出包 | 待补齐 | 仓库中暂无 `raw.json` 和 `asset-manifest.json` fixture。 |
| `job-list.modules.example.json` 字段复盘 | 已完成 | 明确它只能作为业务语义样例，正式 schema 需要扩展视觉实现层。 |
| mentor HTML 成品反向复盘 | 已完成 | 已提取 CSS token、布局约束、状态样式和交互逻辑。 |
| 导出性能基线 | 部分完成 | 已记录代码静态配置，缺少真实样例运行数据。 |
| 字段分层 | 已完成 | 明确业务语义层和视觉实现层。 |

## 8. 对阶段 1 和阶段 2 的输入

阶段 1 应优先处理：

- 资源导出串行慢的问题。
- 大图导出前的风险提示。
- 真实导出耗时统计。
- 失败资源可诊断和可补导。

阶段 2 应优先定义：

- `design-tokens.json`
- `page-layout.json`
- `*.module.json`
- `interactionModel`
- `stateStyles`
- `assetUsage`
- `renderStrategy`

正式 schema 的最低要求是：仅凭中间产物和资源文件，AI 应能知道页面内容是什么，也能知道 CSS 应该如何接近设计稿，而不是从业务文字中猜测视觉样式。
