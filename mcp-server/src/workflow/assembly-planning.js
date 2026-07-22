import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateTextDetailed, generateTextStreamDetailed } from '../llm/openai-compatible.js'
import { buildAssemblyPlanningContext } from './assembly-planning-context.js'
import { createFallbackMetrics, createStreamProgressReporter } from './stream-progress.js'

const REQUIRED_HEADINGS = [
  '组装结论',
  '冲突裁决',
  '文件与命名约定',
  '全局样式与设计 Token',
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
  timeoutMs = Number(process.env.ASSEMBLY_LLM_TIMEOUT_MS || 900000),
  connectTimeoutMs = Number(process.env.ASSEMBLY_LLM_CONNECT_TIMEOUT_MS || 30000),
  firstEventTimeoutMs = Number(process.env.ASSEMBLY_LLM_FIRST_EVENT_TIMEOUT_MS || 0),
  idleTimeoutMs = Number(process.env.ASSEMBLY_LLM_IDLE_TIMEOUT_MS || 120000),
  streamingEnabled = process.env.WORKFLOW_STREAMING_ENABLED !== 'false' && process.env.ASSEMBLY_STREAMING_ENABLED !== 'false',
  onProgress = () => {},
  generateStream = generateTextStreamDetailed,
  generateNonStream = generateTextDetailed,
}) {
  const outputDir = join(jobDir, '04-assembly')
  mkdirSync(outputDir, { recursive: true })

  const context = buildAssemblyPlanningContext(jobDir)
  const system = buildSystemPrompt()
  const basePrompt = buildUserPrompt(jobId, context)
  const promptPath = join(outputDir, 'assembly-planning.prompt.md')
  const outputPath = join(outputDir, 'assembly.plan.md')
  const partialPath = join(outputDir, 'assembly.plan.partial.md')
  if (existsSync(partialPath)) unlinkSync(partialPath)
  writeFileSync(promptPath, renderPromptLog(system, basePrompt), 'utf8')

  const startedAt = Date.now()
  const tokenUsage = emptyUsage()
  let prompt = basePrompt
  let markdown = ''
  let streamMode = streamingEnabled ? 'stream' : 'non-stream-fallback'
  const reportProgress = createStreamProgressReporter(onProgress)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt)
    if (remainingTimeoutMs <= 0) throw new Error('页面组装模型调用总时长超时。')
    let result
    try {
      if (streamingEnabled) {
        result = await generateStream({
          config,
          system,
          prompt,
          temperature: 0.1,
          maxTokens: 4800,
          connectTimeoutMs,
          firstEventTimeoutMs,
          idleTimeoutMs,
          totalTimeoutMs: remainingTimeoutMs,
          onProgress: (metrics) => reportProgress({
            ...metrics,
            attempt: attempt * 2 + metrics.attempt,
          }),
        })
      } else {
        reportProgress(createFallbackMetrics('connecting', attempt + 1), true)
        result = await generateNonStream({
          config,
          system,
          prompt,
          temperature: 0.1,
          maxTokens: 4800,
          timeoutMs: remainingTimeoutMs,
        })
        reportProgress(createFallbackMetrics('validating', attempt + 1), true)
      }
    } catch (error) {
      if (error?.partialText) writeFileSync(partialPath, normalizeMarkdown(error.partialText), 'utf8')
      throw error
    }
    streamMode = result.streamMode || streamMode
    markdown = normalizeMarkdown(result.text)
    addUsage(tokenUsage, result.usage)

    const missingHeadings = getMissingHeadings(markdown)
    if (missingHeadings.length === 0) break
    if (attempt === 1) {
      throw new Error(`assembly-planning 输出格式校验失败，缺少一级标题：${missingHeadings.join('、')}`)
    }
    prompt = `${basePrompt}\n\n上一次输出缺少必要一级标题：${missingHeadings.join('、')}。请完整重写，并严格使用要求的一级标题。`
  }

  writeFileSync(outputPath, markdown, 'utf8')
  if (existsSync(partialPath)) unlinkSync(partialPath)

  return {
    outputPath,
    promptPath,
    streamMode,
    durationMs: Date.now() - startedAt,
    tokenUsage,
  }
}

export function getMissingAssemblyHeadings(markdown) {
  return getMissingHeadings(markdown)
}

function buildSystemPrompt() {
  return [
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
    '9. 普通内容必须使用文档流、Flex 或 Grid；只允许装饰层、浮层和有证据的重叠区域使用 absolute，并说明定位参照与层级。',
    '10. 输出具体开发顺序、每步输入和完成条件，使代码生成 AI 无需再次做架构决策。',
    '11. 不输出 JSON，不输出完整 HTML/CSS/JS 代码。',
    '12. immutableTextContract.path 指向不可变文字的唯一事实源。设计稿出现的所有可见文字都必须逐字保留，严禁总结、改写、纠错、删减、扩写、同义替换、重新断句或调整字符顺序，也不得让后续 AI 生成替代文案。计划只引用 sourceNodeId，不得复制长段 characters，以避免后续输入 token 重复增长。',
    '',
    `输出：只输出中文 Markdown，必须包含这些一级标题：${REQUIRED_HEADINGS.join('、')}。`,
  ].join('\n')
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

function addUsage(target, source = {}) {
  target.inputTokens += source.inputTokens || 0
  target.outputTokens += source.outputTokens || 0
  target.totalTokens += source.totalTokens || 0
  target.estimated = target.estimated || Boolean(source.estimated)
}
