import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateTextDetailed, generateTextStreamDetailed } from '../llm/openai-compatible.js'
import { generateWorkflowText } from './generate-workflow-text.js'
import { appendImmutableTextContractSection } from './immutable-source-texts.js'
import { buildPagePlanningContext } from './page-planning-context.js'
import { createStreamProgressReporter } from './stream-progress.js'

export async function runPagePlanAnalysis({
  config,
  jobId,
  jobDir,
  analysisName,
  outputName,
  system,
  focus,
  contextProfile,
  requiredHeadings,
  includeImmutableTextSection = false,
  timeoutMs = Number(process.env.PAGE_PLAN_TIMEOUT_MS || 0),
  connectTimeoutMs = Number(process.env.LLM_CONNECT_TIMEOUT_MS || 30000),
  firstEventTimeoutMs = Number(process.env.LLM_FIRST_EVENT_TIMEOUT_MS || 0),
  idleTimeoutMs = Number(process.env.LLM_IDLE_TIMEOUT_MS || 120000),
  streamingEnabled = process.env.WORKFLOW_STREAMING_ENABLED !== 'false',
  onProgress = () => {},
  generateStream = generateTextStreamDetailed,
  generateNonStream = generateTextDetailed,
}) {
  const outputDir = join(jobDir, '03-page-plans')
  mkdirSync(outputDir, { recursive: true })
  const context = selectContext(buildPagePlanningContext(jobDir), contextProfile)
  const basePrompt = buildUserPrompt({ jobId, focus, context })
  const promptPath = join(outputDir, `${analysisName}.prompt.md`)
  const outputPath = join(outputDir, outputName)
  const partialPath = join(outputDir, `${analysisName}.partial.md`)
  if (existsSync(partialPath)) unlinkSync(partialPath)
  writeFileSync(promptPath, renderPromptLog(analysisName, system, basePrompt), 'utf8')

  const startedAt = Date.now()
  const usage = emptyUsage()
  let prompt = basePrompt
  let markdown = ''
  let streamMode = streamingEnabled ? 'stream' : 'non-stream-fallback'
  const reportProgress = createStreamProgressReporter(onProgress)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result
    try {
      result = await generateWorkflowText({
        streamingEnabled,
        generateStream,
        generateNonStream,
        request: { config, system, prompt, temperature: 0.15, maxTokens: 3200 },
        timeoutMs,
        connectTimeoutMs,
        firstEventTimeoutMs,
        idleTimeoutMs,
        reportProgress,
        workflowAttempt: attempt + 1,
      })
    } catch (error) {
      if (error?.partialText) writeFileSync(partialPath, normalizeMarkdown(error.partialText), 'utf8')
      throw error
    }
    streamMode = result.streamMode || streamMode
    markdown = normalizeMarkdown(result.text)
    addUsage(usage, result.usage)
    const firstLevelHeadings = new Set(
      markdown
        .split(/\r?\n/)
        .filter((line) => line.startsWith('# '))
        .map((line) => line.slice(2).trim()),
    )
    const missingHeadings = requiredHeadings.filter((heading) => !firstLevelHeadings.has(heading))
    if (missingHeadings.length === 0) break
    if (attempt === 1) {
      throw new Error(`${analysisName} 输出格式校验失败，缺少一级标题：${missingHeadings.join('、')}`)
    }
    prompt = `${basePrompt}\n\n上一次输出缺少必要一级标题：${missingHeadings.join('、')}。请完整重写并严格满足输出格式。`
  }

  if (includeImmutableTextSection) {
    markdown = appendImmutableTextContractSection(markdown, context.immutableTextContract)
  }
  writeFileSync(outputPath, markdown, 'utf8')
  if (existsSync(partialPath)) unlinkSync(partialPath)

  return {
    outputPath,
    promptPath,
    streamMode,
    durationMs: Date.now() - startedAt,
    tokenUsage: usage,
  }
}

function selectContext(context, profile) {
  const common = {
    source: context.source,
    rootId: context.rootId,
    frameScreenshotPath: context.frameScreenshotPath,
    pageLayout: context.pageLayout,
    immutableTextContract: context.immutableTextContract,
  }

  if (profile === 'assets') {
    return {
      ...common,
      nodes: context.nodes.filter((node) =>
        node.images?.length > 0 ||
        node.role === 'decorative' ||
        /logo|icon|图标|图片|背景|装饰|二维码|公众号|视频号|小红书|抖音|微博/i.test(node.name || ''),
      ),
      assets: context.assets,
      designTokens: {
        colors: context.designTokens?.colors,
        radii: context.designTokens?.radii,
      },
    }
  }

  if (profile === 'interaction') {
    return {
      ...common,
      nodes: context.nodes
        .filter((node) => node.text || isInteractionCandidate(node))
        .map(({ sourceNodeId, parentId, name, type, role, bounds, text }) => ({
          sourceNodeId,
          parentId,
          name,
          type,
          role,
          bounds,
          text,
        })),
    }
  }

  return {
    ...common,
    nodes: context.nodes.filter((node) =>
      node.role === 'container' ||
      node.role === 'text' ||
      node.images?.length > 0 ||
      isInteractionCandidate(node),
    ),
    assets: context.assets.map(({ assetId, usage, copiedPath, sourceNodes }) => ({
      assetId,
      usage,
      copiedPath,
      sourceNodeIds: sourceNodes.map((node) => node.sourceNodeId),
    })),
    designTokens: context.designTokens,
  }
}

function isInteractionCandidate(node) {
  return /button|input|select|checkbox|radio|tab|nav|link|按钮|导航|筛选|搜索|分页|轮播|展开|收起|提交|投递|登录|注册/i.test(`${node.type || ''} ${node.name || ''}`)
}

function buildUserPrompt({ jobId, focus, context }) {
  return [
    `jobId: ${jobId}`,
    '',
    '请针对整个单页面完成本角色的开发分析。当前 MVP 不进行模块切片，你的计划必须覆盖整页，并能直接交给后续页面代码生成步骤使用。',
    '',
    `本角色重点：${focus}`,
    '',
    'frame-screenshot.png 是必要输入，路径已列入上下文。当前模型调用为文本通道，因此不得声称已经读取截图像素；需要截图确认的事项必须明确列为后续视觉比对项。',
    '',
    '硬约束：immutableTextContract.path 指向设计稿全部可见文字的唯一不可变事实源。任何标题、正文、标签、导航、按钮、页尾或其他文案都不得总结、改写、纠错、删减、扩写、同义替换或调整字符顺序；计划只能引用 sourceNodeId，不得复制整段 characters 或让 AI 生成替代文案。workflow 会程序化追加轻量契约章节，模型不得自行创建或重写该章节。',
    '',
    '页面上下文：',
    '',
    '```json',
    JSON.stringify(context),
    '```',
  ].join('\n')
}

function renderPromptLog(analysisName, system, prompt) {
  return [
    `# ${analysisName} Prompt`,
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
