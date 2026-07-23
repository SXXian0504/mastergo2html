import http from 'node:http'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { generateTextDetailed, generateTextStreamDetailed } from '../llm/openai-compatible.js'
import { generateWorkflowText } from './generate-workflow-text.js'
import { readOrCreateImmutableSourceTexts } from './immutable-source-texts.js'
import { readOrCreateNodeStyleFacts, requiredBackgroundFacts } from './node-style-facts.js'
import { createStreamProgressReporter } from './stream-progress.js'

const REQUIRED_FILES = ['index.html', 'styles.css', 'script.js']

export async function runHtmlGeneration({
  config,
  jobId,
  jobDir,
  timeoutMs = Number(process.env.HTML_GENERATION_TIMEOUT_MS || 900000),
  connectTimeoutMs = Number(process.env.LLM_CONNECT_TIMEOUT_MS || 30000),
  firstEventTimeoutMs = Number(process.env.LLM_FIRST_EVENT_TIMEOUT_MS || 0),
  idleTimeoutMs = Number(process.env.LLM_IDLE_TIMEOUT_MS || 120000),
  streamingEnabled = process.env.WORKFLOW_STREAMING_ENABLED !== 'false',
  onProgress = () => {},
  generateTextFn,
  generateStream = generateTextFn || generateTextStreamDetailed,
  generateNonStream = generateTextFn || generateTextDetailed,
  smokeTestFn = smokeTestOutput,
}) {
  const outputDir = join(jobDir, '05-output')
  const tempDir = join(jobDir, '.05-output-tmp')
  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(tempDir, { recursive: true })

  const context = buildHtmlGenerationContext(jobDir)
  const system = buildSystemPrompt()
  const basePrompt = buildUserPrompt(jobId, context)
  const promptPath = join(outputDir, 'html-generation.prompt.md')
  const responsePath = join(outputDir, 'html-generation.response.md')
  const validationPath = join(outputDir, 'static-validation.json')
  writeFileSync(join(tempDir, 'html-generation.prompt.md'), `# html-generation Prompt\n\n## System\n\n${system}\n\n## User\n\n${basePrompt}\n`, 'utf8')

  const startedAt = Date.now()
  const tokenUsage = emptyUsage()
  let prompt = basePrompt
  let payload
  let finalValidation
  let streamMode = streamingEnabled ? 'stream' : 'non-stream-fallback'
  const reportProgress = createStreamProgressReporter(onProgress)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const generationConfig = {
      ...config,
      model: process.env.HTML_GENERATION_MODEL || config.model,
    }
    let result
    try {
      result = await generateWorkflowText({
        streamingEnabled,
        generateStream,
        generateNonStream,
        request: {
          config: generationConfig,
          system,
          prompt,
          temperature: Number(process.env.HTML_GENERATION_TEMPERATURE || 0.15),
          maxTokens: Number(process.env.HTML_GENERATION_MAX_TOKENS || 14000),
        },
        timeoutMs,
        connectTimeoutMs,
        firstEventTimeoutMs,
        idleTimeoutMs,
        reportProgress,
        workflowAttempt: attempt + 1,
      })
    } catch (error) {
      if (error?.partialText) writeFileSync(join(tempDir, `html-generation.partial.attempt-${attempt + 1}.md`), error.partialText, 'utf8')
      throw error
    }
    streamMode = result.streamMode || streamMode
    addUsage(tokenUsage, result.usage)
    writeFileSync(join(tempDir, `html-generation.response.attempt-${attempt + 1}.md`), result.text, 'utf8')
    writeFileSync(join(tempDir, 'html-generation.response.md'), result.text, 'utf8')
    try {
      payload = parseGeneratedFiles(result.text)
    } catch (error) {
      if (attempt === 1) throw new Error(`html-generation 输出解析失败：${error.message}`)
      prompt = `${basePrompt}\n\n上一次输出无法解析为包含 index.html、styles.css、script.js 的 JSON。请只输出 JSON 对象，不要 Markdown 代码围栏或解释文字。`
      continue
    }
    finalValidation = validateGeneratedFiles(payload, context)
    if (!finalValidation.ok) {
      if (attempt === 1) break
      prompt = `${basePrompt}\n\n上一次输出未通过静态校验，请修正以下错误后重新输出三个完整文件：\n- ${finalValidation.errors.join('\n- ')}`
      continue
    }
    break
  }

  writeGeneratedFiles(tempDir, payload)
  copyAssets(context.assetsDir, join(tempDir, 'assets'))
  finalValidation ||= validateGeneratedFiles(payload, context)
  writeFileSync(join(tempDir, 'static-validation.json'), JSON.stringify(finalValidation, null, 2), 'utf8')
  if (!finalValidation.ok) throw new Error(`html-generation 静态校验失败：${finalValidation.errors.join('；')}`)
  await smokeTestFn(tempDir)

  publishOutput(tempDir, outputDir)
  return {
    outputPath: outputDir,
    promptPath,
    responsePath,
    validationPath,
    streamMode,
    durationMs: Date.now() - startedAt,
    tokenUsage,
    artifacts: [outputDir, promptPath, responsePath, validationPath],
  }
}

export function buildHtmlGenerationContext(jobDir) {
  const normalizedDir = join(jobDir, '01-normalized')
  const layoutDir = join(jobDir, '02-layout')
  const plansDir = join(jobDir, '03-page-plans')
  const assemblyPath = join(jobDir, '04-assembly', 'assembly.plan.md')
  const sourceTextsPath = join(normalizedDir, 'source-texts.json')
  const nodeStyleFactsPath = join(normalizedDir, 'node-style-facts.json')
  const context = {
    pageLayout: readJson(join(layoutDir, 'page-layout.json')),
    pageLayoutDescription: readText(join(layoutDir, 'page-layout.md')),
    componentStructurePlan: readText(join(plansDir, 'component-structure.plan.md')),
    staticAssetsPlan: readText(join(plansDir, 'static-assets.plan.md')),
    interactionPlan: readText(join(plansDir, 'interaction.plan.md')),
    assemblyPlan: readText(assemblyPath),
    assetIndex: readJson(join(normalizedDir, 'asset-index.json')),
    designTokens: readJson(join(normalizedDir, 'design-tokens.json')),
    sourceTexts: readOrCreateImmutableSourceTexts(sourceTextsPath, join(normalizedDir, 'raw.normalized.json')),
    nodeStyleFacts: readOrCreateNodeStyleFacts(nodeStyleFactsPath, join(normalizedDir, 'raw.normalized.json')),
    assetsDir: join(jobDir, '00-input', 'assets'),
  }
  if (!existsSync(context.assetsDir)) throw new Error('阶段八缺少资源目录：00-input/assets')
  return context
}

function buildSystemPrompt() {
  return [
    '角色：你是单页面 HTML/CSS/JS 代码生成 AI。',
    '只生成可双击运行的原生 index.html、styles.css、script.js，不引入 React、构建工具、CDN、网络资源或外部字体。按 Header、Main、Section、Footer 等清晰边界组织 React 友好的 DOM 与 BEM class，方便后续转换为 React 组件。',
    '普通内容使用文档流、Flex、Grid；仅装饰可使用 absolute。优先还原 1920px 桌面基准，并提供一个 768px 保守断点，保证无横向滚动。页面内容高于视口时必须能正常纵向滚动；html、body 以及应用在 body 上的页面根 class/id 禁止设置 overflow:hidden、overflow:clip、overflow-y:hidden 或 overflow-y:clip。需要裁剪横向装饰时只设置 overflow-x:hidden。',
    '最高优先级硬约束：设计稿中出现的所有可见文字必须逐字使用 source-texts.json 的 characters，并在承载该文字的唯一 HTML 元素上添加 data-text-source-node-id="对应 sourceNodeId"。严禁让 AI 总结、改写、概括、纠错、删减、扩写、同义替换、重新断句、调整字符顺序或生成替代文案；标题、正文、标签、导航、按钮、页尾和其他文案均无例外。允许用 HTML 标签承载原有结构，但所有后代文本拼接后必须与 characters 完全一致。',
    'characters 中的换行、连续空格和制表符是设计稿显式排版事实，不是可忽略空白。characters 包含这些保真空白时，承载元素必须同时添加 data-text-preserve-whitespace="true"；CSS 必须提供 [data-text-preserve-whitespace="true"] { white-space: pre-wrap; }，不得将换行替换为空格、折叠连续空格或仅依靠容器自动折行模拟。',
    '透明背景约束适用于所有元素，不仅是图片：当节点事实显示 fills 为空、填充透明或该节点仅为透明容器时，生成的对应元素及其容器必须保持 background:transparent，不得自行添加背景色、渐变、背景图片、遮罩、backdrop-filter 或其他产生可见底色的效果。只有资源/节点事实、design-tokens 或 assembly.plan.md 明确给出非透明填充时，才允许设置对应背景；不得为了增强层次、可读性或补全视觉而猜测填充色。',
    'node-style-facts.json 是节点视觉样式的最高优先级事实源。已有 resolvedBackgroundColor、textColor、stroke 或 cornerRadius 时必须逐值使用；design-tokens 只允许复用相同值，不得用文字色、常见网站配色或其他语义 token 替换节点事实。',
    '对 node-style-facts 中 bindingRequired=true 的背景节点：承载该背景的 HTML 元素必须添加 data-style-source-node-id="对应 sourceNodeId"，CSS 必须包含精确的 [data-style-source-node-id="对应 sourceNodeId"] 选择器并设置与 resolvedBackgroundColor 相同的 background-color；背景矩形可以作为父 section/header/footer 的样式来源，无需额外创建空 DOM。',
    '图片 src 只能使用 asset-index 的 copiedPath。同一 asset 有多个 rendered slice 时，优先按 sourceNodeId 选择精确切片，再使用 preferred。关键元素按计划添加 data-source-node-id、data-asset-id、data-action。透明图片正常加载时不得有黑色底；图片容器默认背景必须透明，只有 img 触发真实 error 后才允许通过 is-missing 等失败态显示保留原尺寸的纯黑色块。',
    '主 CTA 必须使用 button；未知链接不得使用 alert，采用页面内锚点或非阻塞的页面内提示。',
    '输出必须是 JSON 对象，键仅为 index.html、styles.css、script.js，值为完整代码字符串；不要 Markdown、解释文字或额外键。',
  ].join('\n')
}

function buildUserPrompt(jobId, context) {
  return [
    `jobId: ${jobId}`,
    '请根据以下阶段二至阶段七产物生成最终单页面代码。不得重新做架构决策。事实优先级为：node-style-facts.json > 资源/节点切片事实 > assembly.plan.md > 三角色计划 > page-layout.md > design-token 语义推断。',
    `## node-style-facts.json\n${JSON.stringify(context.nodeStyleFacts)}`,
    `## page-layout.json\n${JSON.stringify(context.pageLayout)}`,
    `## page-layout.md\n${context.pageLayoutDescription}`,
    `## component-structure.plan.md\n${context.componentStructurePlan}`,
    `## static-assets.plan.md\n${context.staticAssetsPlan}`,
    `## interaction.plan.md\n${context.interactionPlan}`,
    `## assembly.plan.md\n${context.assemblyPlan}`,
    `## source-texts.json\n${JSON.stringify(context.sourceTexts)}`,
    `## asset-index.json\n${JSON.stringify(context.assetIndex)}`,
    `## design-tokens.json\n${JSON.stringify(context.designTokens)}`,
  ].join('\n\n')
}

export function parseGeneratedFiles(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const parsed = JSON.parse(cleaned)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('模型输出不是 JSON 对象')
  const extraKeys = Object.keys(parsed).filter((key) => !REQUIRED_FILES.includes(key))
  if (extraKeys.length > 0) throw new Error(`包含不允许的字段：${extraKeys.join('、')}`)
  for (const file of REQUIRED_FILES) if (typeof parsed[file] !== 'string' || !parsed[file].trim()) throw new Error(`缺少有效文件：${file}`)
  return { indexHtml: parsed['index.html'], stylesCss: parsed['styles.css'], scriptJs: parsed['script.js'] }
}

export function validateGeneratedFiles(files, context) {
  const errors = []
  const warnings = []
  const html = files?.indexHtml || ''
  const css = files?.stylesCss || ''
  const js = files?.scriptJs || ''
  if (!/<link[^>]+href=["']styles\.css["']/i.test(html)) errors.push('index.html 未引用 styles.css')
  if (!/<script[^>]+src=["']script\.js["']/i.test(html)) errors.push('index.html 未引用 script.js')
  if (!/<html\b/i.test(html) || !/<body\b/i.test(html)) errors.push('HTML 缺少 html/body 结构')
  if (!balanced(stripCommentsAndStrings(css), '{', '}')) errors.push('CSS 花括号不平衡')
  try { new Function(js) } catch (error) { errors.push(`JS 语法错误：${error.message}`) }
  validateImageFallback(css, js, errors)
  validateRootScrolling(html, css, errors)
  validateSourceTexts(html, css, context.sourceTexts, errors)
  validateRequiredNodeStyles(html, css, context.nodeStyleFacts, errors)
  if (/<(?:img|script|link|source|video|audio)\b[^>]*(?:src|href)=["']https?:\/\//i.test(html) || /(?:url\(|@import\s+)[^;\n]*https?:\/\//i.test(css)) errors.push('禁止引用网络资源')
  if (/(?:src|href)=["'](?:\.\.\/|\/)/i.test(html) || /url\(\s*["']?(?:\.\.\/|\/)/i.test(css)) errors.push('禁止引用输出目录之外的路径')
  const assetsByPath = new Map()
  for (const asset of context.assetIndex.assets || []) {
    for (const path of [asset.preferred?.copiedPath, ...(asset.rendered || []).map((item) => item.path)].filter(Boolean)) assetsByPath.set(path, asset)
  }
  const allowed = new Set(assetsByPath.keys())
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) {
    const value = match[1]
    if (value.startsWith('assets/')) {
      if (!allowed.has(value)) errors.push(`资源路径不在 asset-index：${value}`)
      else if (!existsSync(join(context.assetsDir, value.slice('assets/'.length)))) reportMissingAsset(value, assetsByPath.get(value), errors, warnings)
    }
  }
  for (const match of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    const value = match[1]
    if (value.startsWith('assets/')) {
      if (!allowed.has(value)) errors.push(`CSS 资源路径不在 asset-index：${value}`)
      else if (!existsSync(join(context.assetsDir, value.slice('assets/'.length)))) reportMissingAsset(value, assetsByPath.get(value), errors, warnings)
    }
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], checkedAt: new Date().toISOString() }
}

function validateRequiredNodeStyles(html, css, nodeStyleFacts, errors) {
  const variables = collectCssVariables(css)
  for (const fact of requiredBackgroundFacts(nodeStyleFacts)) {
    const nodeId = String(fact.sourceNodeId)
    const escaped = escapeRegExp(nodeId)
    const htmlBinding = new RegExp(`\\bdata-style-source-node-id=["']${escaped}["']`, 'i')
    if (!htmlBinding.test(html)) {
      errors.push(`关键节点样式缺少 HTML 绑定：${nodeId}`)
      continue
    }

    const selectorBinding = new RegExp(`\\[data-style-source-node-id\\s*=\\s*["']${escaped}["']\\]`, 'i')
    let declaration
    for (const rule of stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!selectorBinding.test(rule[1])) continue
      const backgroundColor = lastDeclaration(rule[2], 'background-color')
      const background = lastDeclaration(rule[2], 'background')
      declaration = backgroundColor || background || declaration
    }
    if (!declaration) {
      errors.push(`关键节点样式缺少可审计 CSS 背景规则：${nodeId}`)
      continue
    }

    const actual = resolveCssValue(declaration, variables)
    if (!colorsEqual(actual, fact.resolvedBackgroundColor)) {
      errors.push(`关键节点背景色不一致：${nodeId} 应为 ${fact.resolvedBackgroundColor}，实际为 ${actual || declaration}`)
    }
  }
}

function collectCssVariables(css) {
  const variables = new Map()
  for (const match of stripCssComments(css).matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) variables.set(match[1], match[2].trim())
  return variables
}

function lastDeclaration(block, property) {
  const escaped = escapeRegExp(property)
  let value
  for (const match of String(block).matchAll(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, 'gi'))) value = match[1].trim()
  return value
}

function resolveCssValue(value, variables, seen = new Set()) {
  const input = String(value || '').trim()
  const variable = input.match(/^var\(\s*(--[\w-]+)(?:\s*,[^)]*)?\s*\)$/i)?.[1]
  if (!variable || seen.has(variable)) return input
  seen.add(variable)
  return resolveCssValue(variables.get(variable) || input, variables, seen)
}

function colorsEqual(actual, expected) {
  const actualColor = parseCssColor(extractCssColor(actual))
  const expectedColor = parseCssColor(extractCssColor(expected))
  return Boolean(actualColor && expectedColor && actualColor.every((value, index) => Math.abs(value - expectedColor[index]) < 0.002))
}

function extractCssColor(value) {
  return String(value || '').match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\btransparent\b/i)?.[0]
}

function parseCssColor(value) {
  const input = String(value || '').trim().toLowerCase()
  if (input === 'transparent') return [0, 0, 0, 0]
  if (input.startsWith('#')) {
    const raw = input.slice(1)
    const expanded = raw.length === 3 || raw.length === 4 ? [...raw].map((char) => char + char).join('') : raw
    if (expanded.length !== 6 && expanded.length !== 8) return null
    return [0, 2, 4].map((index) => Number.parseInt(expanded.slice(index, index + 2), 16) / 255)
      .concat(expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1)
  }
  const rgb = input.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/)
  if (!rgb) return null
  return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, rgb[4] === undefined ? 1 : Number(rgb[4])]
}

function stripCssComments(value) {
  return String(value || '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function validateRootScrolling(html, css, errors) {
  const bodyTag = html.match(/<body\b([^>]*)>/i)?.[1] || ''
  const bodyClasses = new Set((bodyTag.match(/\bclass=["']([^"']*)["']/i)?.[1] || '').split(/\s+/).filter(Boolean))
  const bodyId = bodyTag.match(/\bid=["']([^"']+)["']/i)?.[1]
  const rootSelectors = new Set(['html', 'body', ':root'])
  for (const className of bodyClasses) {
    rootSelectors.add(`.${className}`)
    rootSelectors.add(`body.${className}`)
  }
  if (bodyId) {
    rootSelectors.add(`#${bodyId}`)
    rootSelectors.add(`body#${bodyId}`)
  }

  const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const rule of cssWithoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].split(',').map((selector) => selector.trim().replace(/::?[\w-]+(?:\([^)]*\))?$/g, ''))
    if (!selectors.some((selector) => rootSelectors.has(selector))) continue
    const declarations = rule[2]
    const locksBothAxes = /(?:^|;)\s*overflow\s*:\s*(?:hidden|clip)(?:\s*;|\s*$)/i.test(declarations)
    const locksVerticalAxis = /(?:^|;)\s*overflow-y\s*:\s*(?:hidden|clip)(?:\s*;|\s*$)/i.test(declarations)
    if (locksBothAxes || locksVerticalAxis) {
      errors.push(`页面根滚动容器不得禁用纵向滚动：${selectors.filter((selector) => rootSelectors.has(selector)).join('、')}`)
    }
  }
}

function validateImageFallback(css, js, errors) {
  if (selectorHasBlackBackground(css, '.image-frame')) errors.push('透明图片容器 .image-frame 默认态不得使用黑色背景')
  const hasMissingBlack = selectorHasBlackBackground(css, '.image-frame.is-missing') || selectorHasBlackBackground(css, '.is-missing')
  if (css.includes('.image-frame') && !hasMissingBlack) errors.push('图片加载失败态缺少纯黑色占位背景')
  if (css.includes('.image-frame') && !selectorHidesElement(css, '.image-frame.is-missing img')) errors.push('图片加载失败态必须隐藏破损 img，只显示纯黑色占位')
  if (css.includes('.image-frame') && !/add\s*\(\s*["']is-missing["']\s*\)/.test(js)) errors.push('缺少 img error 后添加 is-missing 失败态的逻辑')
}

function selectorHasBlackBackground(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const ruleRe = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gi')
  for (const match of css.matchAll(ruleRe)) {
    if (/(?:^|;)\s*background(?:-color)?\s*:\s*(?:#000(?:000)?|black|rgb\s*\(\s*0\s*,\s*0\s*,\s*0\s*\))/i.test(match[1])) return true
  }
  return false
}

function selectorHidesElement(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const ruleRe = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gi')
  for (const match of css.matchAll(ruleRe)) {
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0)\s*(?:;|$)/i.test(match[1])) return true
  }
  return false
}

function validateSourceTexts(html, css, sourceTexts = [], errors) {
  const pageText = compactComparableText(extractHtmlText(html))
  const preservesWhitespace = hasPreservedWhitespaceRule(css)
  for (const item of sourceTexts) {
    const expected = compactComparableText(item.characters)
    const bindings = extractTextBindings(html, item.sourceNodeId)
    if (bindings.length === 0) {
      if (expected && pageText.includes(expected)) errors.push(`设计稿原文缺少文本节点绑定：${item.sourceNodeId}`)
      else if (expected) errors.push(`缺少或改写设计稿原文：${item.sourceNodeId}`)
      continue
    }
    if (bindings.length > 1) {
      errors.push(`设计稿原文存在重复文本节点绑定：${item.sourceNodeId}`)
      continue
    }
    const expectedExact = normalizeLineEndings(item.characters)
    const actualExact = normalizeLineEndings(extractHtmlFragmentText(bindings[0].content))
    if (actualExact !== expectedExact) {
      errors.push(`设计稿原文字符或空白不一致：${item.sourceNodeId}`)
      continue
    }
    if (requiresWhitespacePreservation(expectedExact)) {
      if (!/\bdata-text-preserve-whitespace\s*=\s*["']true["']/i.test(bindings[0].attributes)) {
        errors.push(`文本缺少空白保真绑定：${item.sourceNodeId}`)
      } else if (!preservesWhitespace) {
        errors.push(`文本缺少 white-space: pre-wrap 规则：${item.sourceNodeId}`)
      }
    }
  }
}

function extractTextBindings(html, sourceNodeId) {
  const escaped = escapeRegExp(sourceNodeId)
  const pattern = new RegExp(`<([a-z][\\w:-]*)\\b([^>]*\\bdata-text-source-node-id\\s*=\\s*["']${escaped}["'][^>]*)>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi')
  return [...String(html || '').matchAll(pattern)].map((match) => ({
    attributes: match[2],
    content: match[3],
  }))
}

function extractHtmlFragmentText(fragment) {
  return decodeHtmlEntities(String(fragment || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
}

function normalizeLineEndings(value) {
  return String(value || '').replace(/\r\n?/g, '\n')
}

function requiresWhitespacePreservation(value) {
  return /(?:\n|\t| {2,})/.test(value)
}

function hasPreservedWhitespaceRule(css) {
  for (const rule of stripCssComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!/\[data-text-preserve-whitespace(?:\s*=|\])/i.test(rule[1])) continue
    if (/(?:^|;)\s*white-space\s*:\s*pre-wrap\s*(?:;|$)/i.test(rule[2])) return true
  }
  return false
}

function extractHtmlText(html) {
  return decodeHtmlEntities(String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' '))
}

function decodeHtmlEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : _
    }
    return Object.prototype.hasOwnProperty.call(named, entity.toLowerCase()) ? named[entity.toLowerCase()] : _
  })
}

function compactComparableText(value) {
  return String(value || '').replace(/\s+/g, '')
}

function reportMissingAsset(path, asset, errors, warnings) {
  const message = `资源文件不存在：${path}`
  if (asset?.usage === 'logo' || asset?.usage === 'content-image') errors.push(message)
  else warnings.push(`${message}；按纯黑色块降级`)
}

function writeGeneratedFiles(dir, files) {
  writeFileSync(join(dir, 'index.html'), files.indexHtml, 'utf8')
  writeFileSync(join(dir, 'styles.css'), files.stylesCss, 'utf8')
  writeFileSync(join(dir, 'script.js'), files.scriptJs, 'utf8')
}

function copyAssets(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name)
    const target = join(targetDir, entry.name)
    if (entry.isDirectory()) copyAssets(source, target)
    else cpSync(source, target)
  }
}

async function smokeTestOutput(outputDir) {
  for (const file of REQUIRED_FILES) {
    if (!existsSync(join(outputDir, file))) throw new Error(`输出缺少文件：${file}`)
  }
  const html = readFileSync(join(outputDir, 'index.html'), 'utf8')
  if (html.includes('\\\\') || /(?:^|["'(])\/(?:Users|private|tmp)\//.test(html)) throw new Error('HTML 包含本机绝对路径')
  await new Promise((resolvePromise, reject) => {
    const server = http.createServer((req, res) => {
      const name = req.url === '/styles.css' ? 'styles.css' : req.url === '/script.js' ? 'script.js' : 'index.html'
      res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html' : 'text/plain' })
      res.end(readFileSync(join(outputDir, name)))
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      Promise.all(['/', '/styles.css', '/script.js'].map((path) => requestStatus(`http://127.0.0.1:${address.port}${path}`)))
        .then((statuses) => {
          const failed = statuses.find((status) => status !== 200)
          server.close(failed ? () => reject(new Error(`HTTP smoke test 返回 ${failed}`)) : resolvePromise)
        })
        .catch((error) => server.close(() => reject(error)))
    })
  })
}

function requestStatus(url) {
  return new Promise((resolvePromise, reject) => {
    http.get(url, (res) => { res.resume(); res.on('end', () => resolvePromise(res.statusCode)) }).on('error', reject)
  })
}

function publishOutput(tempDir, outputDir) {
  const backupDir = `${outputDir}.previous`
  rmSync(backupDir, { recursive: true, force: true })
  if (existsSync(outputDir)) renameSync(outputDir, backupDir)
  try {
    renameSync(tempDir, outputDir)
    rmSync(backupDir, { recursive: true, force: true })
  } catch (error) {
    if (existsSync(backupDir) && !existsSync(outputDir)) renameSync(backupDir, outputDir)
    throw error
  }
}

function readText(path) { if (!existsSync(path)) throw new Error(`阶段八缺少必要输入：${relative(process.cwd(), path)}`); return readFileSync(path, 'utf8') }
function readJson(path) { return JSON.parse(readText(path)) }
function balanced(value, open, close) { let depth = 0; for (const char of value) { if (char === open) depth += 1; if (char === close) depth -= 1; if (depth < 0) return false } return depth === 0 }
function stripCommentsAndStrings(value) { return String(value).replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '') }
function emptyUsage() { return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false } }
function addUsage(target, usage = {}) { target.inputTokens += Number(usage.inputTokens || 0); target.outputTokens += Number(usage.outputTokens || 0); target.totalTokens += Number(usage.totalTokens || 0); target.estimated ||= Boolean(usage.estimated) }
