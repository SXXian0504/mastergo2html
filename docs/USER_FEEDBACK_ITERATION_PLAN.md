# 基于用户反馈的本轮迭代开发计划

## 1. 背景

近期用户反馈集中在资源还原、复杂视觉导出、交互动效、服务启动、字体缺失、资源分类和响应式生成几个方向。当前项目已经具备 MasterGo 结构提取、资源索引、字体检测、本地 MCP workflow、静态资源分析、交互分析和 HTML 生成的基础能力，本轮迭代的重点不是重建流程，而是提升一键生成的可用性和高保真稳定性。

核心判断：后续不能继续主要依赖图层命名来约束生成结果。命名规则只能作为兜底线索，主路径应升级为“结构事实 + 视觉特征 + 资源计划 + 按需补导 + 生成校验”。

## 2. 用户反馈与问题归类

| 编号 | 反馈 | 问题归类 | 影响 |
| --- | --- | --- | --- |
| 1 | 仅靠 MasterGo 图层命名无法覆盖所有情况，用户使用不便 | 资源语义识别不足 | Logo、导航、页尾、装饰资源容易漏识别 |
| 2 | 使用蒙版的图层需要将整个组作为图片导出 | 复杂视觉资源还原不足 | 蒙版、裁切、叠加效果在 HTML 中丢失 |
| 3 | 动效只能靠用户写详细 prompt 引导 Codex | 交互和动效信息缺口 | 项目价值点尚未产品化 |
| 4 | 一键生成 HTML 依赖用户手动启动 `npm run mcp:dev` | 本地服务体验门槛高 | 普通用户无法顺利使用 |
| 5 | 字体未安装时只有检测结果，没有可视化和降级策略 | 字体还原不稳定 | 大标题、Banner、正文表现不一致 |
| 6 | SVG、icon、img 需要分类清楚 | 资源组织和引用策略不足 | 清晰度、性能、生成准确性受影响 |
| 7 | 没有响应式设计能力，无法识别 PC 和移动端两个页面 | 多端输入和布局配对缺失 | 生成页面只适合单一视口 |

## 3. 优先级

| 优先级 | 任务 | 原因 | 建议阶段 |
| --- | --- | --- | --- |
| P0 | 蒙版和复杂组合整体切片 | 直接影响视觉还原，用户已多次遇到 | 阶段 1 |
| P0 | 资源提取规则升级，减少依赖图层命名 | Logo、导航、页尾、复杂装饰是核心质量问题 | 阶段 1-2 |
| P0 | SVG 和 PNG 资源目录拆分 | 影响清晰度、资源组织和模型引用准确性，应在资源提取阶段完成 | 阶段 1 |
| P1 | 字体缺失处理 | 大标题不准会非常明显，正文需要稳定 fallback，本阶段暂不处理 | 阶段 2 |
| P1 | 响应式识别 PC/移动端 | 影响最终可用性，但依赖多 Frame 输入 | 阶段 3 |
| P2 | 动效和交互还原 | 价值高，但设计稿信息缺失最大 | 阶段 3-4 |
| P2 | MCP 服务启动体验改进 | 会影响用户使用门槛，但不直接影响 HTML 生成效果 | 阶段 4 |

## 4. SVG 与 IMG 加载负荷说明

SVG 和 IMG 的负载不能简单比较谁更轻，需要按资源类型判断。

| 类型 | 加载负荷 | 渲染负荷 | 适合场景 |
| --- | --- | --- | --- |
| SVG 文件作为 `img` 引用 | 通常体积小，可缓存，网络负担低 | 简单矢量很轻，复杂路径多时增加 CPU | Icon、Logo、简单线性图形 |
| 内联 SVG | 少一次请求，但增加 HTML 体积 | 可直接改色、做状态和动效，复杂时 DOM 变重 | 需要 CSS 控制颜色和状态的小图标 |
| PNG/JPG/WebP 图片 | 文件可能较大，尤其 PNG | 浏览器解码位图，显示成本稳定，但高分辨率占内存 | 照片、内容图、Banner、复杂视觉 |
| PNG 渲染切片 | 视觉最稳定，但体积通常大于 SVG | 高清屏需要 2x 或 3x，否则可能发糊 | 蒙版组合、复杂渐变、阴影、不可拆视觉 |

结论：

- Icon 优先 SVG，特别是纯色、线性、可复用图标。
- Logo 如果是矢量且不依赖特殊字体、渐变或蒙版，优先 SVG。
- Logo 如果包含特殊字体、复杂渐变、蒙版或品牌视觉不可偏差，优先导出 PNG/WebP 切片。
- 内容图片、照片、Banner 背景优先 PNG/JPG/WebP。
- Mask、复杂组合、背景装饰、毛玻璃、叠加阴影优先整体导出为 rendered image。
- 资源提取阶段的 `00-input/assets/` 本轮只按文件类型拆分：SVG 放入 `assets/icon/`，PNG 放入 `assets/img/`。Logo、蒙版组合、复杂视觉等仍通过 manifest 中的 `usage`、`usageHint`、`mustUseRenderedSlice` 表达语义，不再额外拆 `assets/logo/` 或 `assets/rendered/` 目录。本阶段暂不处理字体缺失。

## 5. 阶段 1：资源提取效果优先闭环

### 5.1 目标

解决当前最影响 HTML 生成效果的资源提取问题。第一阶段所有改动都应发生在插件资源提取和 `00-input` 生成步骤，不依赖后续 MCP 阶段补救。

第一阶段范围：

- 蒙版和复杂组合整体切片。
- SVG/PNG 目录拆分：SVG 进入 `00-input/assets/icon/`，PNG 进入 `00-input/assets/img/`。
- 资源语义识别升级，减少对图层命名的依赖。

第一阶段暂不处理：

- 字体缺失处理。
- MCP server 启动体验优化。
- 响应式和多端识别。
- 动效和复杂交互还原。

### 5.2 任务 A：蒙版和复杂组合整体切片

#### 技术方案

当前项目已有 `background-decor-mask` 命名规则，但不应只依赖命名。需要在 MasterGo 插件资源提取阶段增加结构检测：

- 节点或子节点存在 mask 能力或 mask 语义。
- Group/Frame 内部存在裁切、遮罩、透明叠加、复杂混合模式。
- 子节点超出父级边界且父级承担裁切视觉。
- 节点视觉由多个子节点叠加形成，拆成原图后会破坏最终效果。

命中后，将整个父级 Group/Frame 标记为 `node-slice`，并在 `asset-manifest.json` 中写入：

```json
{
  "kind": "node-slice",
  "usageHint": "masked-composite",
  "mustUseRenderedSlice": true,
  "renderReason": "节点包含蒙版、裁切或复杂叠加，必须整体导出切片以保留视觉效果。",
  "sourceNodeIds": ["node-id"]
}
```

#### 开发步骤

1. 扩展 `messages/sender.ts` 中的 `usageHint` 类型，增加 `masked-composite`、`complex-vector` 等后续可复用类型。
2. 扩展 `lib/main.ts` 的强制切片判断，将命名检测升级为命名检测 + 结构检测。
3. 调整 `removeDescendantForcedSlices` 去重逻辑，避免父级整体切片后子节点重复导出。
4. 在 `asset-manifest.json` 中记录 `usageHint`、`mustUseRenderedSlice`、`renderReason`、`sourceNodeIds` 和实际 `copiedPath`。
5. 增加测试：蒙版组必须整体导出到 `00-input/assets/img/`，内部 image 不得被标记为优先使用资源。

#### 验收标准

- 有蒙版的组生成 HTML 后不再丢失遮罩效果。
- `asset-manifest.json` 能明确标记该资源必须使用整体切片。
- 整体切片 PNG 在资源提取阶段就进入 `00-input/assets/img/`。
- 后续 HTML 生成阶段不会引用蒙版组内部 image 代替整体切片。

### 5.3 任务 B：SVG 和 PNG 目录拆分

#### 技术方案

资源目录拆分在插件资源提取阶段完成，产物直接体现在 `00-input/assets/` 中。

目录规则：

- `00-input/assets/icon/*.svg`：所有 SVG 资源。
- `00-input/assets/img/*.png`：所有 PNG 资源，包括内容图、Logo PNG、蒙版整体切片、复杂视觉切片和背景装饰切片。
- 资源语义不通过目录表达，而通过 `asset-manifest.json` 中的 `usage`、`usageHint`、`mustUseRenderedSlice`、`sourceNodeIds`、`semanticHints` 表达。

处理原则：

- 能保留为 SVG 的资源不转成 PNG，避免清晰度损失。
- 必须整体渲染的复杂视觉统一导出 PNG，进入 `assets/img/`。
- 第一阶段只承诺 SVG/PNG 两类拆分。JPG/WebP/GIF 如后续遇到，先作为图片资源进入 `assets/img/` 并保留原扩展，避免强制转码。

#### 开发步骤

1. 在 `createAssetIndex` 阶段根据资源格式生成 `suggestedFile`。
2. 将 SVG 原图路径从 `assets/original/*.svg` 调整为 `assets/icon/*.svg`。
3. 将 PNG 原图和 rendered slice 路径调整为 `assets/img/*.png`。
4. 在 `asset-manifest.json` 中增加 `format`、`targetDir`，并确保 `copiedPath` 指向新目录。
5. 调整 `exportAssets` 和 `exportRenderedAsset`，让文件实际写入对应目录。
6. 增加测试：SVG 应进入 `00-input/assets/icon/`；PNG 应进入 `00-input/assets/img/`；蒙版组合 PNG 也进入 `00-input/assets/img/`。

#### 验收标准

- `00-input/assets/icon/` 只放 SVG。
- `00-input/assets/img/` 放 PNG 图片和 PNG 切片。
- `asset-manifest.json` 中 `suggestedFile`、`copiedPath` 与实际文件路径一致。
- 后续 MCP workflow 不需要再移动资源目录。

### 5.4 任务 C：资源提取规则升级

#### 技术方案

资源语义从单纯命名规则升级为“位置 + 尺寸 + 上下文 + 命名”的候选判断。

候选规则：

- 顶部 15% 区域、靠左、尺寸较小、附近有导航文字：候选 `logo`。
- 页尾区域、靠左或居中、附近有版权/联系方式：候选 `footer-logo`。
- 小尺寸矢量或图片，重复出现在按钮、列表、导航中：候选 `icon`。
- 大面积图片或铺底节点：候选 `background` 或 `content-image`。
- 无文本、低透明度、层级靠后、超出画布边界：候选 `decorative`。

规则输出只作为 `usageCandidates` 和 `confidence`，最终仍由静态资源分析阶段结合上下文决策。

#### 开发步骤

1. 在插件资源提取阶段为资源来源节点生成 `semanticHints`。
2. 在 `asset-manifest.json` 中增加 `usageCandidates`、`confidence`、`reason`。
3. 调整 raw 节点序列化，保留资源语义提示和来源节点关系。
4. 增加导航 Logo、页尾 Logo、Icon、背景图测试样例。

#### 验收标准

- 未命名为 logo 的顶部品牌图形也能进入 Logo 资源计划。
- 页尾 Logo 能和普通内容图片区分。
- Icon 不再全部混入普通 img 资源。
- 上述语义提示在 `00-input/asset-manifest.json` 中即可查看。

## 6. 阶段 2：字体缺失处理

### 6.1 目标

提升生成页面的字体稳定性。字体缺失处理不进入第一阶段。

### 6.2 任务 A：字体缺失处理

#### 技术方案

保留现有 `font-availability.json`，新增 UI 展示和生成降级策略。

字体使用场景分类：

- `display-critical`：字号大于等于 32，Hero、Banner、主标题、品牌视觉、强视觉按钮。
- `body-text`：正文、说明、列表。
- `minor-text`：标签、辅助说明、弱视觉信息。

处理策略：

- 插件 UI 展示缺失字体列表，例如 `MiSans`、`Lantinghei SC`。
- `display-critical` 且字体缺失时，计划导出文本所在视觉组为 PNG rendered slice。
- 正文和辅助文字使用本机/浏览器 fallback 字体。
- 不自动联网下载字体包，避免授权和来源不确定问题。

推荐 fallback：

```css
font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif;
```

#### 开发步骤

1. raw 标准化阶段给 text node 增加 `fontRisk`。
2. 资源计划阶段增加 `font-render-slice-candidate`。
3. 插件 UI 增加缺失字体列表展示。
4. HTML 生成规则增加字体 fallback 要求。
5. 增加测试：大标题缺字体时触发切片候选，正文缺字体时使用 fallback。

#### 验收标准

- 用户可以在插件 UI 中看到缺失字体列表。
- 大标题缺失字体时有明确切片计划或风险提示。
- 正文不会因缺失字体导致生成失败。

## 7. 阶段 3：响应式和多端识别

### 7.1 目标

让模型明确识别 PC 和移动端两个设计稿，基于真实多端 Frame 生成响应式规则，而不是只根据一个 PC Frame 编造移动布局。

### 7.2 技术方案

支持用户选择两个或多个 Frame：

- PC Frame：宽度通常大于等于 900。
- Mobile Frame：宽度通常 320-480。
- Tablet Frame：可选。

建立 Frame pairing：

- 通过 Frame 名称，例如 `首页-PC`、`首页-Mobile`。
- 通过文本相似度。
- 通过模块顺序相似度。
- 通过主要图片和资源相似度。

生成 responsive context：

```json
{
  "desktopFrame": "frame-id",
  "mobileFrame": "frame-id",
  "matchedSections": [],
  "changedLayoutPatterns": [],
  "hiddenOnMobile": [],
  "reorderedOnMobile": [],
  "responsiveBreakpoints": [767, 1023]
}
```

生成 CSS 时采用明确断点：

- Desktop baseline：设计稿 PC 宽度。
- Mobile breakpoint：`max-width: 767px`。
- Tablet breakpoint：`768px` 到 `1023px`，可选。

### 7.3 开发步骤

1. 插件允许选择多个 Frame 生成。
2. raw 输入包支持 `frames[]`。
3. 标准化阶段增加 Frame 类型识别和 pairing。
4. page-layout 输出多端结构。
5. html-generation prompt 明确使用 desktop/mobile 两份事实。
6. 增加测试：横向导航转移动端布局、多列卡片转单列、图片不溢出。

### 7.4 验收标准

- 同时选中 PC 和 Mobile Frame 时，生成结果包含真实响应式规则。
- 只有一个 PC Frame 时，只做保守自适应，不编造复杂移动布局。
- 生成 CSS 包含可追踪的 media query。

## 8. 阶段 4：交互和动效还原

### 8.1 目标

把“用户自己写 prompt 引导 Codex”升级为“设计稿信息 + 可选用户补充 + 模型规划”的交互动效 workflow。

### 8.2 技术方案

交互动效分三层处理。

确定性识别：

- Button hover、focus、active。
- Tab 或 segmented control。
- Accordion 展开收起。
- Carousel 指示器。
- 表单输入状态。
- 导航锚点滚动。
- Modal、Drawer 等多状态组件。

设计稿多状态识别：

- 如果存在 `default`、`hover`、`active`、`open`、`closed` 命名或多个相似 Frame，建立状态关系。
- 如果后续 MasterGo 插件 API 可以读取 prototype/interaction 数据，应优先消费该数据。

用户补充输入：

- 插件 UI 增加“交互/动效补充说明”输入框。
- 示例：`首屏按钮点击滚动到表单`、`卡片 hover 上浮`、`Tab 切换职位列表`。
- 补充说明进入 `interaction-analysis`，但代码生成仍必须受节点事实约束。

实现策略：

- CSS 动效优先，用于 hover、focus、opacity、transform、scroll behavior。
- JS 只用于状态切换，例如 tab、modal、accordion、carousel。
- 不默认引入重型动画库。

### 8.3 开发步骤

1. 插件 UI 增加交互说明输入框。
2. `export-options.json` 增加 `interactionPrompt`。
3. `interaction-analysis` prompt 接收用户补充说明。
4. HTML 生成阶段输出 `data-interaction-source-node-id`，方便追踪。
5. 增加测试：tab、按钮 hover、锚点滚动、无交互页面零 JS。

### 8.4 验收标准

- 用户不用在 Codex 中额外写长 prompt，也能在插件里补充动效要求。
- 可推导交互能自动生成。
- 不可推导业务行为明确标记，不凭空编造。

## 9. 推荐排期

### 第一周：P0 闭环

- 蒙版和复杂组合整体切片。
- SVG 在 `00-input/assets/icon/` 导出，PNG 在 `00-input/assets/img/` 导出。
- Logo、Icon、内容图片的语义候选规则。
- 对应测试补齐。

### 第二周：字体缺失处理

- 字体缺失 UI 展示。
- 大标题缺字体切片策略。
- 正文字体 fallback。

### 第三周：响应式 MVP

- 多 Frame 输入包。
- PC/Mobile Frame 识别。
- responsive context。
- media query 生成规则。

### 第四周：交互动效 MVP

- 插件 UI 交互说明输入。
- interaction plan 升级。
- hover、tab、accordion、modal、anchor 等基础实现规则。
- 交互回归样例。

## 10. 推荐开发顺序

建议先做“蒙版整体切片 + SVG/PNG 在 `00-input/assets/` 阶段拆分 + 资源语义规则”。这些事项会直接影响 HTML 生成效果和视觉还原质量，并且都属于资源提取阶段可完成的工作。

字体缺失、MCP 服务启动体验、响应式和动效先不进入第一阶段。MCP 服务启动体验会影响用户使用门槛，但不直接改变生成页面质量，本轮优先级下调到后续体验优化阶段。响应式和动效价值很高，但它们依赖更干净的结构、资源和多 Frame 输入。等资源语义和目录分类稳定后再做，多端和交互动效的实现会更可靠。
