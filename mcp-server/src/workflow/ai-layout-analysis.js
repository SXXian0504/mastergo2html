import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateTextDetailed, generateTextStreamDetailed } from '../llm/index.js'
import { appendDesignToHtmlSkillPrompt } from './design-to-html-skill.js'
import { generateWorkflowText } from './generate-workflow-text.js'
import { appendGenerationTargetPrompt, appTargetContext } from './generation-target.js'
import { appendImmutableTextContractSection, buildImmutableTextContract } from './immutable-source-texts.js'
import { createStreamProgressReporter } from './stream-progress.js'
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_SHORT_LLM_TIMEOUT_MS } from '../timeouts.js'

export async function runAiLayoutAnalysis({
  config,
  jobId,
  jobDir,
  contextPath,
  timeoutMs = Number(process.env.LAYOUT_ANALYSIS_TIMEOUT_MS || DEFAULT_SHORT_LLM_TIMEOUT_MS),
  connectTimeoutMs = Number(process.env.LLM_CONNECT_TIMEOUT_MS || DEFAULT_CONNECT_TIMEOUT_MS),
  firstEventTimeoutMs = Number(process.env.LLM_FIRST_EVENT_TIMEOUT_MS || 0),
  idleTimeoutMs = Number(process.env.LLM_IDLE_TIMEOUT_MS || DEFAULT_IDLE_TIMEOUT_MS),
  streamingEnabled = process.env.WORKFLOW_STREAMING_ENABLED !== 'false',
  onProgress = () => {},
  generateStream = generateTextStreamDetailed,
  generateNonStream = generateTextDetailed,
}) {
  const layoutDir = join(jobDir, '02-layout')
  const context = JSON.parse(readFileSync(contextPath, 'utf8'))
  const system = buildAiLayoutAnalysisSystemPrompt(context.page?.exportOptions)
  const prompt = buildAiLayoutAnalysisUserPrompt({ jobId, context })
  const partialPath = join(layoutDir, 'ai-layout-analysis.partial.md')
  if (existsSync(partialPath)) unlinkSync(partialPath)
  writeFileSync(join(layoutDir, 'ai-layout-analysis.prompt.md'), renderPromptLog(system, prompt), 'utf8')

  const startedAt = Date.now()
  const reportProgress = createStreamProgressReporter(onProgress)
  let result
  try {
    result = await generateWorkflowText({
      streamingEnabled,
      generateStream,
      generateNonStream,
      request: { config, system, prompt, temperature: 0.15, maxTokens: 2600 },
      timeoutMs,
      connectTimeoutMs,
      firstEventTimeoutMs,
      idleTimeoutMs,
      reportProgress,
    })
  } catch (error) {
    if (error?.partialText) writeFileSync(partialPath, normalizeMarkdown(error.partialText), 'utf8')
    throw error
  }
  const durationMs = Date.now() - startedAt
  const markdown = appendImmutableTextContractSection(result.text, buildImmutableTextContract(
    (context.visibleTexts || [])
      .filter((node) => typeof node.text === 'string' && node.text.trim())
      .map((node) => ({ sourceNodeId: node.sourceNodeId })),
  ))

  writeFileSync(join(layoutDir, 'page-layout.md'), normalizeMarkdown(markdown), 'utf8')
  writeFileSync(join(layoutDir, 'ai-layout-analysis.response.md'), normalizeMarkdown(markdown), 'utf8')
  if (existsSync(partialPath)) unlinkSync(partialPath)

  return {
    outputPath: join(layoutDir, 'page-layout.md'),
    promptPath: join(layoutDir, 'ai-layout-analysis.prompt.md'),
    responsePath: join(layoutDir, 'ai-layout-analysis.response.md'),
    streamMode: result.streamMode,
    durationMs,
    tokenUsage: result.usage,
  }
}

function buildAiLayoutAnalysisSystemPrompt(exportOptions) {
  const system = appendDesignToHtmlSkillPrompt([
    '你是 MasterGo 设计稿转 HTML workflow 中的“AI 页面布局分析模块”。在 workflow 汇报中，也可以称为“布局分析 Agent”。',
    '',
    '你的职责不是写代码，也不是简单复述节点列表，而是把 MasterGo/Figma 类设计稿中的绝对坐标、节点树、文本、图片和视觉层级，转换成后续 HTML 开发可执行的页面整体布局说明。',
    '',
    '背景：',
    '- 输入来自 MasterGo 插件导出的 raw.json、Magic DSL 00-input 或静态 00-input，节点通常带有绝对坐标和可用的布局事实。',
    '- HTML 实现以高保真还原为第一目标：优先保留设计稿坐标、尺寸、层级、section bbox、layoutStyle 和 flexContainerInfo；只有明确存在 Auto Layout/重复结构/文本流关系时才转为文档流、Flex 或 Grid。',
    '- 设计稿可能只有一个 PC Frame，不能凭空还原移动端设计，只能输出低置信度响应式提示。',
    '- frame-screenshot.png 是必需输入，但当前文本通道只能拿到截图路径；如果节点信息和截图可能冲突，必须标记为待视觉复核。',
    '',
    '总任务：',
    '基于输入上下文，生成 page-layout.md。该文件要帮助后续组件结构分析、资源分析、交互分析和代码生成步骤理解页面从上到下的真实结构。',
    '',
    '详细规则：',
    '1. 先识别页面整体结构，不要被单个 TEXT 节点或单个 Group 误导。',
    '2. 必须找出同一视觉容器内的多个内容块。例如同一卡片/内容面板中存在多个“标题 + 正文”组合时，应描述为同一主内容模块内的多个上下排列 section，而不是拆成孤立文本模块。',
    '3. 对文字密集区域，必须说明标题、正文、分隔线、按钮、卡片背景、内边距、段落间距、内容宽度、纵向堆叠关系。',
    '4. 对背景、装饰图形、漂浮图片、波点、圆形等，必须与内容模块分开说明，标记为 background/decorative layer。',
    '5. 对导航、页尾、主内容、Hero、表单、卡片列表等模块，应说明模块类型、视觉目的和 HTML 实现建议。',
    '6. 必须判定 HTML 布局策略：absolute、source-flex、flow、grid 四类必须直接给出；当输入含 Magic DSL section bbox 或节点缺少可靠 flexContainerInfo 时，默认 absolute 高保真定位。',
    '7. 普通文本、按钮、列表、卡片只有在源节点存在 flexContainerInfo、layoutMode、重复行列结构或清晰内容流证据时才建议 flow/Flex/Grid；表格、侧边栏、工具栏、弹层、图标按钮和小控件优先保留源 bounds，避免语义化后偏移。',
    '8. 必须列出源节点 ID，方便后续页面开发步骤回链 raw.normalized.json。',
    '9. 如果布局判断不确定，不要假装确定，要写入“待 AI/人工复核”。',
    '10. 不要输出空泛描述，例如“这里是内容区域”。必须给出可执行的布局细节。',
    '11. 不要只出现某一个文本区块；同层级、同容器、相邻的标题正文都要覆盖。',
    '12. 不要生成 HTML/CSS/JS 代码。',
    '13. visibleTexts 中的所有 text 都是不可变原文。不得总结、改写、纠错、删减、扩写、同义替换或调整字符顺序；布局说明只能通过 sourceNodeId 引用，不得在正文重复长文本。轻量不可变文本契约由 workflow 程序化追加，禁止自行重写。',
    '',
    '输出要求：',
    '- 只输出 Markdown。',
    '- 使用中文。',
    '- 必须包含以下一级标题：页面概览、全局布局、模块清单、模块详细布局、资源与背景层、响应式判断、绝对定位清单、风险与复核点、给后续步骤的指令。',
    '- 模块清单必须是从上到下的顺序。',
    '- 模块详细布局中每个模块必须包含：moduleId、模块类型、视觉目的、边界、源节点、内部结构、布局方式、间距规则、定位策略、资源引用、风险。',
    '- 风险与复核点必须具体到节点或模块。',
    '- 输出要密集、可执行，控制在 1800 到 2600 个中文字符左右。',
  ], 'layout', { target: exportOptions?.targetPlatform === 'app' ? 'app' : 'web' }).join('\n')
  return appendGenerationTargetPrompt(system, 'layout', exportOptions)
}

function buildAiLayoutAnalysisUserPrompt({ jobId, context }) {
  const compactContext = compactContextForPrompt(context)
  return [
    `jobId: ${jobId}`,
    '',
    '请根据下面的设计稿结构上下文生成 page-layout.md。',
    '',
    '特别注意：',
    '- 必须覆盖所有可见的主要文本内容块，尤其是同一视觉容器内连续出现的多个标题-正文组合。',
    '- 不要把长正文的第一个 TEXT 节点当作模块名称。',
    '- 如果存在一个白色/浅色内容面板承载多个标题和正文，请识别为主内容卡片/内容面板，而不是多个孤立文本模块。',
    '- 如果存在顶部背景图形或装饰图层，不要把它当作 header 或正文模块。',
    '',
    '上下文 JSON：',
    '',
    '```json',
    JSON.stringify(compactContext),
    '```',
  ].join('\n')
}

function compactContextForPrompt(context) {
  return {
    ...appTargetContext(context.page?.exportOptions),
    ...(context.interactionStates ? { interactionStates: context.interactionStates } : {}),
    page: {
      sourcePage: context.page?.sourcePage,
      rootFrame: context.page?.rootFrame ? {
        id: context.page.rootFrame.sourceNodeId,
        name: context.page.rootFrame.name,
        bounds: context.page.rootFrame.bounds,
      } : null,
      baseViewport: context.page?.baseViewport,
      background: context.page?.background,
    },
    responsive: context.responsive,
    stackingFacts: context.stackingFacts,
    visualLayers: (context.visualLayers || []).map((layer) => ({
      id: layer.sourceNodeId,
      name: truncate(layer.name, 80),
      type: layer.type,
      role: layer.role,
      bounds: layer.bounds,
      childCount: layer.childCount,
      texts: (layer.descendantText || []).map((text) => ({
        id: text.sourceNodeId,
        name: truncate(text.name, 80),
        text: truncate(text.text, 180),
        bounds: text.bounds,
      })),
      assetIds: layer.descendantAssetIds,
    })),
    visibleTexts: (context.visibleTexts || []).map((node) => ({
      id: node.sourceNodeId,
      name: truncate(node.name, 80),
      text: truncate(node.text, 260),
      bounds: node.bounds,
      fontSize: node.style?.text?.fontSize,
      fontWeight: node.style?.text?.fontWeight,
    })),
    containers: (context.containers || []).map((node) => ({
      id: node.sourceNodeId,
      name: truncate(node.name, 80),
      type: node.type,
      role: node.role,
      bounds: node.bounds,
      childCount: node.childCount,
    })),
    assets: (context.assets || []).map((asset) => ({
      assetId: asset.assetId,
      path: asset.preferred?.copiedPath,
      usage: asset.usage,
      renderPolicy: asset.renderPolicy,
      fontFallbackRequired: asset.fontFallbackRequired,
      fallbackForTextNodeIds: asset.fallbackForTextNodeIds,
      layer: asset.layer,
      renderingStrategy: asset.renderingStrategy,
      mustUseRenderedSlice: asset.mustUseRenderedSlice,
      wholeNodePng: asset.wholeNodePng,
      mustNotEnterDocumentFlow: asset.mustNotEnterDocumentFlow,
      zIndexGroup: asset.zIndexGroup,
      sourceBounds: asset.sourceBounds,
      renderedBounds: asset.renderedBounds,
      anchorNodeId: asset.anchorNodeId,
      localBounds: asset.localBounds,
      renderedLocalBounds: asset.renderedLocalBounds,
      sizingPolicy: asset.sizingPolicy,
      positioningPolicy: asset.positioningPolicy,
      croppingPolicy: asset.croppingPolicy,
      sourceNodeIds: (asset.sourceNodes || []).map((source) => source.sourceNodeId),
    })),
    designTokenSummary: {
      colors: (context.designTokenSummary?.colors || []).slice(0, 10),
      fontSizes: (context.designTokenSummary?.fontSizes || []).slice(0, 10),
      spacing: (context.designTokenSummary?.spacing || []).slice(0, 10),
      radii: (context.designTokenSummary?.radii || []).slice(0, 8),
    },
    ruleDraft: {
      warning: context.ruleDraft?.warning,
      modules: (context.ruleDraft?.modules || []).map((module) => ({
        moduleId: module.moduleId,
        name: truncate(module.name, 80),
        type: module.type,
        bounds: module.bounds,
        sourceNodeCount: module.sourceNodeIds?.length ?? 0,
        assetIds: module.assetIds,
        layoutStrategy: module.layoutStrategy,
        positionStrategy: module.positionStrategy,
      })),
      globalDecorations: context.ruleDraft?.globalDecorations,
    },
    warnings: context.warnings,
  }
}

function truncate(value, maxLength) {
  if (value === undefined || value === null) return value
  const text = String(value)
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function renderPromptLog(system, prompt) {
  return [
    '# AI Layout Analysis Prompt',
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
