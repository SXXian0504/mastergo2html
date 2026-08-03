import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateTextDetailed, generateTextStreamDetailed } from '../llm/openai-compatible.js'
import { buildAssemblyPlanningContext } from './assembly-planning-context.js'
import { appendDesignToHtmlSkillPrompt } from './design-to-html-skill.js'
import { appendGenerationTargetPrompt } from './generation-target.js'
import { createFallbackMetrics, createStreamProgressReporter } from './stream-progress.js'
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_LONG_LLM_TIMEOUT_MS } from '../timeouts.js'

const REQUIRED_HEADINGS = [
  '组装结论',
  '冲突裁决',
  '文件与命名约定',
  '全局样式与设计 Token',
  '节点样式裁决',
  '页面渲染顺序与区域衔接',
  '共享组件',
  '资源复制与引用',
  '交互与共享数据',
  '布局约束与定位规则',
  '代码开发顺序',
  '风险与视觉复核',
  '给代码生成步骤的指令',
]

export async function runAssemblyPlanning({
  config,
  jobId,
  jobDir,
  timeoutMs = Number(process.env.ASSEMBLY_LLM_TIMEOUT_MS || DEFAULT_LONG_LLM_TIMEOUT_MS),
  maxTokens = Number(process.env.ASSEMBLY_LLM_MAX_TOKENS || 24000),
  connectTimeoutMs = Number(process.env.ASSEMBLY_LLM_CONNECT_TIMEOUT_MS || process.env.LLM_CONNECT_TIMEOUT_MS || DEFAULT_CONNECT_TIMEOUT_MS),
  firstEventTimeoutMs = Number(process.env.ASSEMBLY_LLM_FIRST_EVENT_TIMEOUT_MS || process.env.LLM_FIRST_EVENT_TIMEOUT_MS || 0),
  idleTimeoutMs = Number(process.env.ASSEMBLY_LLM_IDLE_TIMEOUT_MS || process.env.LLM_IDLE_TIMEOUT_MS || DEFAULT_IDLE_TIMEOUT_MS),
  streamingEnabled = process.env.WORKFLOW_STREAMING_ENABLED !== 'false' && process.env.ASSEMBLY_STREAMING_ENABLED !== 'false',
  onProgress = () => {},
  generateStream = generateTextStreamDetailed,
  generateNonStream = generateTextDetailed,
}) {
  const outputDir = join(jobDir, '04-assembly')
  mkdirSync(outputDir, { recursive: true })

  const context = buildAssemblyPlanningContext(jobDir)
  const system = appendGenerationTargetPrompt(buildSystemPrompt(), 'assembly', context)
  const basePrompt = buildUserPrompt(jobId, context)
  const promptPath = join(outputDir, 'assembly-planning.prompt.md')
  const outputPath = join(outputDir, 'assembly.plan.md')
  const partialPath = join(outputDir, 'assembly.plan.partial.md')
  if (existsSync(partialPath)) unlinkSync(partialPath)
  writeFileSync(promptPath, renderPromptLog(system, basePrompt), 'utf8')

  const startedAt = Date.now()
  const reportProgress = createStreamProgressReporter(onProgress)
  let result
  try {
    if (streamingEnabled) {
      result = await generateStream({
        config,
        system,
        prompt: basePrompt,
        temperature: 0.1,
        maxTokens,
        connectTimeoutMs,
        firstEventTimeoutMs,
        idleTimeoutMs,
        totalTimeoutMs: timeoutMs,
        onProgress: reportProgress,
      })
    } else {
      reportProgress(createFallbackMetrics('connecting', 1), true)
      result = await generateNonStream({
        config,
        system,
        prompt: basePrompt,
        temperature: 0.1,
        maxTokens,
        timeoutMs,
      })
      reportProgress(createFallbackMetrics('validating', 1), true)
    }
  } catch (error) {
    if (error?.partialText) writeFileSync(partialPath, normalizeMarkdown(error.partialText), 'utf8')
    throw error
  }

  const markdown = normalizeMarkdown(result.text)
  const missingHeadings = getMissingHeadings(markdown)
  const validationWarnings = missingHeadings.length > 0
    ? [`assembly-planning 输出格式校验未通过，缺少一级标题：${missingHeadings.join('、')}；已保留第一轮生成结果，不再重新请求模型。`]
    : []

  writeFileSync(outputPath, markdown, 'utf8')
  if (existsSync(partialPath)) unlinkSync(partialPath)

  return {
    outputPath,
    promptPath,
    streamMode: result.streamMode || (streamingEnabled ? 'stream' : 'non-stream-fallback'),
    durationMs: Date.now() - startedAt,
    tokenUsage: result.usage || emptyUsage(),
    validationWarnings,
  }
}

export function getMissingAssemblyHeadings(markdown) {
  return getMissingHeadings(markdown)
}

function buildSystemPrompt() {
  return appendDesignToHtmlSkillPrompt([
    '角色：你是 MasterGo 转 HTML workflow 中的“单页面组装 AI”。',
    '',
    '背景：组件结构、静态资源和动态交互三个 AI 已分别生成整页开发计划。你负责把这些计划与页面布局、资源索引和设计 token 汇总成唯一、可执行的页面级开发方案。当前 MVP 生成纯 HTML、CSS 和 JavaScript，不进行模块切片。',
    '',
    '任务：裁决三份计划之间的冲突，统一全局样式、页面顺序、共享组件、资源引用、交互数据和最终文件组织，为下一步代码生成提供明确指令。',
    '',
    '详细规则：',
    '1. 不得简单拼接或复述三份计划；必须形成覆盖整页的一套统一决策。',
    '2. 对职责冲突、节点归属冲突、布局冲突、资源路径冲突和交互语义冲突逐项给出最终裁决，并说明依据。',
    '3. 证据不足时仍给出保守的最终实现决策，同时标注低置信度和后续视觉复核点，不把决策留给代码生成步骤。',
    '4. 明确 index.html、styles.css、script.js 和 assets/ 的职责、命名约定与依赖关系。',
    '5. 统一 CSS 变量、字体、颜色、基础排版、容器宽度、断点、间距、层级和 class 命名。所有值优先来自 design-tokens 和 page-layout。',
    '6. 按页面实际顺序描述所有主要区域，处理区域间距、背景连续性、重叠和滚动顺序。',
    '7. 共享组件只抽取真实重复结构；明确共享 JS 状态、数据和事件委托边界。',
    '8. 资源路径只能来自 asset-index；明确复制目标和代码引用路径，不得编造文件。',
    '9. 高保真 source-bounds 是默认裁决。只有源事实存在 flexContainerInfo/layoutMode/重复行列结构，或计划明确证明可无损语义化时，普通内容才裁决为文档流、Flex 或 Grid；表格、侧边栏、工具栏、图标按钮、弹层、叠层、复杂卡片和小尺寸控件优先使用 absolute 或局部 absolute，并说明定位参照与层级。',
    '9.1 页面性能预算是最终裁决的一部分：复杂模糊视觉优先裁决为静态图片资源；没有合适资源时允许使用 CSS filter: blur(...)、backdrop-filter 或半透明渐变还原设计稿，但必须限制在装饰层或需要毛玻璃的局部表面，明确层级、尺寸、透明度和可读性复核点。',
    '9.2 大面积 decorative/background 节点必须裁决为 backgroundLayer，且 affectsFlow=false；不得把这类节点的 y、height、bounds 差值转换为内容容器 padding、margin、min-height 或卡片间距。内容流起点、模块间距和列表间距必须优先由非 decorative 节点的 contentFlow、文本、控件、卡片和图片 bounds 推导。',
    '9.3 Hero/Banner 内容照片若源 bounds 超出 Hero 容器或存在负坐标，默认按 Banner 语义裁决为容器内 cover 铺图，并给出 object-position 复核点；不得要求代码生成机械套用超大 width/height/left/top。此规则只适用于内容照片/主视觉图，不适用于 decorative/background-decor layer。',
    '9.4 背景装饰、波点、符号、圆形、光晕、公式、蒙版装饰等 decorative layer 必须锚定在页面或所在模块的源坐标系：使用 source bounds 的 px left/top/width/height、position:absolute 和稳定 z-index；禁止 object-fit:cover、background-size:cover、inset:0、width/height:100%、vw/vh/百分比尺寸，禁止在响应式断点里改变其相对页面结构的位置。移动端如需隐藏或裁剪，只能整体 clip/overflow，不得重新缩放重排。',
    '9.5 asset-index 中 positioningPolicy=source-bounds 的 Banner 前景切片必须按 localBounds 的 px left/top/width/height 定位在 anchorNodeId 坐标容器内；禁止 right/bottom、百分比和 Flex/Grid 近似定位。fontFallbackRequired=true 的大标题组合切片必须成为唯一可见文字视觉，原文 DOM 只保留为 visually-hidden 无障碍文本。',
    '9.6 page-layout.stackingFacts 是跨模块层级硬事实。重叠模块双方都必须建立 isolation:isolate 的 stacking context 和数值 z-index，upper 必须严格高于 lower；内容面板白底、圆角和内容不得被 Hero/Banner 图片覆盖。',
    '10. 输出具体开发顺序、每步输入和完成条件，使代码生成 AI 无需再次做架构决策。',
    '11. 不输出 JSON，不输出完整 HTML/CSS/JS 代码。',
    '12. immutableTextContract.path 指向不可变文字的唯一事实源。设计稿出现的所有可见文字都必须逐字保留，严禁总结、改写、纠错、删减、扩写、同义替换、重新断句或调整字符顺序，也不得让后续 AI 生成替代文案。计划只引用 sourceNodeId，不得复制长段 characters，以避免后续输入 token 重复增长。',
    '13. nodeStyleFacts 是节点视觉样式的最高优先级事实源。必须在“节点样式裁决”中把关键背景、文字、边框等写成 sourceNodeId、CSS 属性、最终值和依据的表格；不得只写“取节点填充”或“按截图确认”。有节点事实时不得用常见网站模式或其他语义 token 替代其精确值。',
    '',
    `输出：只输出中文 Markdown，必须包含这些一级标题：${REQUIRED_HEADINGS.join('、')}。`,
    '输出顺序必须与标题清单完全一致。请先保证 13 个一级标题完整出现，再在各标题下填入要点；如果内容很多，优先压缩每节条目，不要省略任何一级标题。',
  ], 'assembly').join('\n')
}

function buildUserPrompt(jobId, context) {
  return [
    `jobId: ${jobId}`,
    '',
    '请根据以下完整输入生成单页面组装计划。冲突裁决必须引用发生冲突的计划结论、相关 sourceNodeId、assetId、imageRef 或 copiedPath；没有冲突时也要明确说明检查结果。',
    '',
    '```json',
    JSON.stringify(context),
    '```',
  ].join('\n')
}

function getMissingHeadings(markdown) {
  const headings = new Set(
    String(markdown || '')
      .split(/\r?\n/)
      .filter((line) => line.startsWith('# '))
      .map((line) => line.slice(2).trim()),
  )
  return REQUIRED_HEADINGS.filter((heading) => !headings.has(heading))
}

function renderPromptLog(system, prompt) {
  return [
    '# assembly-planning Prompt',
    '',
    '## System',
    '',
    system,
    '',
    '## User',
    '',
    prompt,
    '',
  ].join('\n')
}

function normalizeMarkdown(value) {
  const text = String(value || '').trim()
  return text.endsWith('\n') ? text : `${text}\n`
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false }
}
