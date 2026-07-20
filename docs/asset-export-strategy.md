# 静态资源导出策略

## 1. 背景

真实使用中已经确认：大图片通过 MasterGo 插件导出会很慢。当前 `结构 + 原图` 模式处理 1 个根节点、265 个总节点、18 个原图资源时，最终预估 ZIP 只有 10.1 MB，但总耗时达到 641.4 s，主要卡在一张约 9 MB 的图片上。

如果后续做“一键导出当前页面所有 Frame 的结构和静态资源”，问题会被放大：

- 单页资源数会变成多 Frame 资源数。
- 多个 Frame 之间可能重复引用同一图片。
- 原图和渲染切片都依赖 MasterGo 插件 API，无法保证稳定吞吐。
- 插件内 Promise timeout 对大图读取只能作为 best-effort，不能保证及时中断原生资源读取。
- 当前切片逻辑基于 `imageRef` 来源节点生成 PNG，不是完整页面切片，因此会遗漏无图片填充的矢量、组合、遮罩、复杂装饰节点，也可能因裁切和渲染边界不准导致视觉不准确。
- ZIP 会越来越大，UI 线程和内存压力也会上升。
- 用户无法判断是插件卡住、图片过大、API 慢，还是资源失败。

因此，未来不能把“全量静态资源导出”作为插件主路径。

## 2. 核心结论

插件主路径应改为：

```text
结构优先导出 -> AI/规则分析资源用途 -> 按需补导关键资源 -> 生成 HTML -> 视觉 QA 再补缺失资源
```

也就是说：

- 一键导出所有 Frame 时，默认只导出结构、资源索引和少量必要截图。
- 原图、切片、大图资源不默认全量导出。
- 切片必须从“自动按 imageRef 批量导出”改为“由资源计划指定节点导出”。
- 图片资源导出从“同步全量任务”改为“异步补导任务”。
- 原图文件优先交给本地 workflow 通过 `imageRef` 下载，使用 Content-Length、流式写入、硬超时和重试控制。
- AI 工作流先根据 `imageRef`、`assetId`、节点语义、模块计划判断哪些资源真的需要。

## 3. 插件和本地 workflow 的职责边界

### 3.1 插件负责

- 扫描当前页面或选中 Frame。
- 导出 `raw.json`。
- 导出 `asset-manifest.json`，保留 `imageRef`、`assetId`、`sourceNodes`、`suggestedFile`。
- 记录资源状态：`reference-only`、`present`、`export-error`。
- 导出低成本元信息：节点尺寸、图片引用次数、来源节点、用途候选。
- 提供按需补导能力，例如按 `assetId`、模块、Frame 或资源用途导出。
- 提供按节点 ID 的计划型切片能力，而不是只按图片引用来源节点切片。
- 对每个补导任务显示进度、失败数、耗时和报告。

### 3.2 本地 workflow 负责

- 读取结构和资源索引。
- 标准化 `raw.json`。
- 判断资源用途：background、logo、icon、content-image、decorative、slice-candidate。
- 判断切片候选节点，明确切片原因、期望边界和降级策略。
- 决定资源优先级。
- 生成 `asset-export-plan.json`。
- 基于 `imageRef` 在本地下载原图，并在下载前检查资源大小。
- 告诉用户或插件下一批需要补导哪些资源。
- 在缺失资源时生成可接受降级，例如纯色背景、CSS 绘制、占位图、忽略非关键装饰。

## 4. 推荐资源状态机

```text
reference-only
  -> planned
  -> exporting
  -> present
  -> export-error
  -> skipped
```

字段建议：

- `status`：当前状态。
- `priority`：`critical`、`high`、`normal`、`low`。
- `usage`：资源用途。
- `sourceNodeIds`：来源节点。
- `frameIds`：涉及 Frame。
- `estimatedCost`：导出成本估计。
- `attempts`：导出尝试次数。
- `lastError`：最近错误。
- `copiedPath`：成功导出后的路径。

## 5. 资源优先级

### 5.1 必须优先补导

- 页面 Hero 背景图。
- Logo 和品牌图形。
- 内容主体图片。
- 影响布局尺寸的图片。
- AI/规则判断无法用 CSS 替代的关键视觉图。

### 5.2 可延后补导

- 社交 icon。
- 小型装饰图。
- 流程连接线。
- 可以用 CSS 绘制的简单形状。
- 非首屏模块中的图片。

### 5.3 默认跳过或降级

- 低透明度装饰。
- 重复出现且非关键的背景纹理。
- 对 HTML 结构无影响的切片。
- 可用颜色、渐变、边框、阴影替代的节点。

## 6. 切片准确性策略

当前插件里的 `assets/rendered/*.png` 只能视为实验性辅助资源，不能视为可靠完整静态资源集。

### 6.1 当前切片的限制

- 只从图片填充的 `imageRef` 来源节点生成任务。
- 无法覆盖没有图片填充的矢量图形、布尔组合、复杂阴影、遮罩和纯 CSS 可表达节点。
- 同一个 `imageRef` 可能出现在多个节点中，按来源节点切片会产生重复或不必要切片。
- `exportAsync` 的 render bounds 和裁切策略可能与最终 HTML 需要的视觉边界不一致。
- 自动切片无法判断该节点应作为真实 DOM、CSS 背景、图标、装饰图还是可忽略元素。

### 6.2 后续正确方向

切片应由 `asset-export-plan.json` 驱动，而不是插件在首轮自动批量生成。

计划型切片字段建议：

- `targetNodeId`
- `targetNodeName`
- `frameId`
- `moduleId`
- `reason`：为什么需要切片。
- `boundsPolicy`：`absoluteRenderBounds`、`absoluteBoundingBox`、`custom-padding`。
- `priority`：`critical`、`high`、`normal`、`low`。
- `expectedUsage`：background、decorative、icon、complex-vector、fallback。
- `fallback`：切片失败时的降级策略。

### 6.3 验收要求

- 首轮结构导出不得依赖切片完整性。
- AI 资源计划必须显式声明哪些节点需要切片。
- 切片失败或遗漏不能阻塞结构分析。
- 高保真 QA 阶段根据截图差异再补切关键节点。

## 7. 全页面多 Frame 导出策略

未来如果支持“一键导出当前页面所有 Frame”，建议拆成两个按钮或两个阶段：

### 7.1 阶段 A：导出页面结构索引

输出：

```text
page-export/
  frames.index.json
  raw/
    frame-a.raw.json
    frame-b.raw.json
  asset-manifest.json
  export-report.json
```

特点：

- 默认执行。
- 快速完成。
- 不导出原图和切片。
- 只收集 `imageRef`、节点、Frame、资源引用关系。

### 7.2 阶段 B：按需补导资源包

输入：

```text
asset-export-plan.json
```

输出：

```text
assets/
  original/
  rendered/
asset-manifest.patch.json
asset-export-report.json
```

特点：

- 用户确认后执行。
- 可分批。
- 可暂停和重试。
- 每批限制数量和耗时。
- 失败不影响结构导出。

## 8. 插件侧保护策略

建议阶段 1 后继续补以下保护：

- 当资源数超过阈值时，禁用或二次确认“全部导出”。
- 将插件内“结构 + 原图”和“全部导出”标记为不推荐能力。
- 增加“本次最多导出 N 个资源”的限制。
- 增加“跳过超过指定尺寸的节点切片”的限制。
- 增加取消导出按钮。
- 增加按失败资源重试。
- 增加按 `assetId` 补导。
- 增加按 `nodeId` 补导计划型切片。
- 增加按模块补导。
- 原图和切片导出始终串行或低并发，避免 MasterGo 环境卡死。

## 9. 对 AI 工作流的影响

AI 不应该假设所有图片已经存在本地文件。

资源计划必须处理三种情况：

- `present`：直接使用 `copiedPath`。
- `reference-only`：根据用途决定是否要求补导。
- `export-error`：给出降级方案或重试建议。

代码生成阶段也必须支持缺失资源降级：

- 背景图缺失时使用颜色、渐变或低保真占位。
- icon 缺失时优先使用 CSS 或内联 SVG 替代。
- 装饰图缺失时可以忽略。
- 关键图片缺失时在 QA 报告中标为阻塞项。

## 10. 决策

正式决策：

- 不在插件中默认全量导出当前页面所有 Frame 的静态资源。
- 当前页面多 Frame 一键导出的默认模式只能是结构和资源引用。
- 全量静态资源必须改为按需补导、可恢复、可诊断的后续任务。
- 自动渲染切片不能作为完整资源集，后续必须由 `asset-export-plan.json` 指定切片候选节点。
- 阶段 3 及以后必须把 `asset-index.json` 和 `asset-export-plan.json` 纳入 workflow。
