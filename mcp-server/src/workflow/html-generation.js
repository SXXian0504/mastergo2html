import http from 'node:http'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { generateTextDetailed, generateTextStreamDetailed } from '../llm/openai-compatible.js'
import { appendDesignToHtmlSkillPrompt } from './design-to-html-skill.js'
import { generateWorkflowText } from './generate-workflow-text.js'
import { readOrCreateImmutableSourceTexts } from './immutable-source-texts.js'
import { readOrCreateNodeStyleFacts, requiredBackgroundFacts, requiredTypographyFacts } from './node-style-facts.js'
import { createStreamProgressReporter } from './stream-progress.js'
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_LONG_LLM_TIMEOUT_MS } from '../timeouts.js'

const REQUIRED_FILES = ['index.html', 'styles.css', 'script.js']

export async function runHtmlGeneration({
  config,
  jobId,
  jobDir,
  timeoutMs = Number(process.env.HTML_GENERATION_TIMEOUT_MS || DEFAULT_LONG_LLM_TIMEOUT_MS),
  connectTimeoutMs = Number(process.env.LLM_CONNECT_TIMEOUT_MS || DEFAULT_CONNECT_TIMEOUT_MS),
  firstEventTimeoutMs = Number(process.env.LLM_FIRST_EVENT_TIMEOUT_MS || 0),
  idleTimeoutMs = Number(process.env.LLM_IDLE_TIMEOUT_MS || DEFAULT_IDLE_TIMEOUT_MS),
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
          maxTokens: Number(process.env.HTML_GENERATION_MAX_TOKENS || 32000),
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
      if (isLikelyTruncatedJsonError(error, result.text)) {
        throw new Error(`html-generation 输出解析失败：模型输出疑似被截断（${error.message}）。已保留原始响应，请提高 HTML_GENERATION_MAX_TOKENS 或改用更大输出上限的模型后重试。`)
      }
      if (attempt === 1) throw new Error(`html-generation 输出解析失败：${error.message}`)
      const missingFiles = extractMissingFilesFromError(error)
      prompt = `${basePrompt}\n\n上一次输出无法解析为包含 index.html、styles.css、script.js 的 JSON。${missingFiles.length > 0 ? `缺少文件：${missingFiles.join('、')}。` : ''}请只输出 JSON 对象，不要 Markdown 代码围栏或解释文字。三个键必须同时出现，且 styles.css 不能省略。`
      continue
    }
    finalValidation = validateGeneratedFiles(payload, context)
    if (!finalValidation.ok) {
      if (attempt === 1) break
      prompt = buildValidationRepairPrompt(basePrompt, finalValidation.errors, context)
      continue
    }
    break
  }

  writeGeneratedFiles(tempDir, payload)
  copyAssets(context.assetsDir, join(tempDir, 'assets'))
  finalValidation ||= validateGeneratedFiles(payload, context)
  writeFileSync(join(tempDir, 'static-validation.json'), JSON.stringify(finalValidation, null, 2), 'utf8')
  // Static validation checks visual fidelity and implementation conventions. A parseable,
  // smoke-testable page is still useful when those checks cannot be fully repaired, so keep
  // the report as warnings instead of blocking publication of the generated HTML.
  await smokeTestFn(tempDir)

  publishOutput(tempDir, outputDir)
  const validationWarnings = summarizeStaticValidationWarnings(finalValidation)
  return {
    outputPath: outputDir,
    promptPath,
    responsePath,
    validationPath,
    staticValidation: finalValidation,
    validationWarnings,
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
  const assetIndex = readJson(join(normalizedDir, 'asset-index.json'))
  const context = {
    pageLayout: readJson(join(layoutDir, 'page-layout.json')),
    pageLayoutDescription: readText(join(layoutDir, 'page-layout.md')),
    componentStructurePlan: readText(join(plansDir, 'component-structure.plan.md')),
    staticAssetsPlan: readText(join(plansDir, 'static-assets.plan.md')),
    interactionPlan: readText(join(plansDir, 'interaction.plan.md')),
    assemblyPlan: readText(assemblyPath),
    assetIndex,
    fontAssets: readJson(join(normalizedDir, 'font-assets.json'), { version: 'mastergo2html.font-assets.v1', fonts: [], files: [] }),
    designTokens: readJson(join(normalizedDir, 'design-tokens.json')),
    sourceTexts: readOrCreateImmutableSourceTexts(sourceTextsPath, join(normalizedDir, 'raw.normalized.json')),
    nodeStyleFacts: readOrCreateNodeStyleFacts(nodeStyleFactsPath, join(normalizedDir, 'raw.normalized.json'), assetIndex),
    assetsDir: join(jobDir, '00-input', 'assets'),
  }
  if (!existsSync(context.assetsDir)) throw new Error('阶段八缺少资源目录：00-input/assets')
  return context
}

function buildSystemPrompt() {
  return appendDesignToHtmlSkillPrompt([
    '角色：你是单页面 HTML/CSS/JS 代码生成 AI。',
    '只生成可双击运行的原生 index.html、styles.css、script.js，不引入 React、构建工具、CDN、网络资源或输出目录之外的外部字体。允许且必须使用 font-assets.json 中已经落盘到 assets/fonts 的字体文件。按 Header、Main、Section、Footer 等清晰边界组织 React 友好的 DOM 与 BEM class，方便后续转换为 React 组件。',
    '高保真布局硬约束：优先还原设计稿桌面基准和源节点 bounds。对 Magic DSL/插件 00-input 中带 absoluteBoundingBox、layoutStyle、section bbox、z-order 的节点，默认使用 page/root 相对定位或局部 relative+absolute 保留尺寸与位置；只有 assembly.plan.md 或节点事实明确要求 source-flex/flow/grid 时才改用文档流、Flex、Grid。响应式只做保守降级，不得破坏桌面像素还原。页面内容高于视口时必须能正常纵向滚动；html、body 以及应用在 body 上的页面根 class/id 禁止设置 overflow:hidden、overflow:clip、overflow-y:hidden 或 overflow-y:clip。需要裁剪横向装饰时只设置 overflow-x:hidden。',
    '布局防空洞硬约束：page-layout.json 的 backgroundLayers、role=decorative 的大面积背景节点、纯背景矩形和面板只允许作为 absolute 背景层、伪元素或父容器背景使用，默认 affectsFlow=false。不得把这些节点的 height、y 差值或 bounds 差值转换为内容容器 padding-top、margin-top、min-height、height 或列表间距。内容起点、列表间距和模块衔接必须由 contentFlow、非 decorative 文本/控件/卡片/图片 bounds 推导。',
    '背景层绑定硬约束：如果为背景/装饰节点生成独立 DOM（例如模糊圆、背景图、footer 背景矩形），该 DOM 必须添加 data-source-node-id 或 data-style-source-node-id 绑定原 sourceNodeId。背景节点自身可以使用自己的 width/height/left/top；但任何未绑定该 sourceNodeId 的普通内容 class（例如 CTA、正文、footer 内容容器）不得使用背景节点的 height、y 差值或内容 delta 作为 height、min-height、margin-top、padding-top。',
    '结构容器硬约束：header、main、footer 及其 __inner / __content / __body 包裹层的尺寸只能来自 pageLayout 的模块 bounds、contentFlow 或正常文档流，不得再从背景层 bounds 反推。像 `114:68724`、`114:68740`、`114:73525` 这类纯背景节点只负责自身纯色底或绝对装饰层，不能在结构容器上制造额外空白。',
    '纯色背景节点必须使用 `background-color` 或等价纯色背景，不得在其上叠加 `linear-gradient(...)`、`radial-gradient(...)` 或其他可见渐变；如果节点事实给出的是纯白/纯蓝这类单一填充，就保持单色，不要为了层次感自行加过渡。',
    '整体切片边界硬约束：node-style-facts 中 coveredByRenderedSlice 存在的节点只用于解释整体切片内部构成，不得再绑定到外层 section/card，也不得产生独立 background、fill、mask 或布局盒；其视觉已经包含在对应 required-final 切片中。',
    'Hero/Banner 图片裁剪硬约束：croppingPolicy=preserve-rendered-slice 的 PNG/SVG 已经包含 MasterGo 的蒙版、透明区域和最终裁切，必须直接按 source-bounds/source-size 显示，禁止 object-fit:cover、background-size:cover、inset:0 二次裁切，也不得在透明区域下补内部蒙版节点的底色。只有没有预渲染切片、且内容照片 source bounds 超出 Hero 容器或存在负坐标时，才允许 inset:0; width:100%; height:100%; object-fit:cover 并用 object-position 校准。',
    'Hero/Banner 前景切片硬约束：asset-index 中 positioningPolicy=source-bounds 的标题切片、箭头、图标和前景装饰必须放在 anchorNodeId 对应的 position:relative 坐标容器内，使用 localBounds 的 px left/top/width/height 与 position:absolute。禁止用 right、bottom、百分比、vw/vh、Flex/Grid 对齐或自适应缩放近似其位置；Banner 照片发生 cover 裁剪时，前景切片仍以设计稿基准坐标平面居中锚定，不得随视口百分比漂移。',
    '背景装饰固定锚点硬约束：asset-index/page-layout 中 usage=background-decor、background-decor-mask、decorative、role=decorative 的波点、符号、圆形、光晕、公式、蒙版装饰必须作为 page/module 坐标系中的 absolute 装饰节点渲染，使用源 bounds 的 px left/top/width/height 和稳定 z-index。禁止对这些装饰使用 object-fit:cover、background-size:cover、inset:0、width/height:100%、vw/vh/百分比尺寸，禁止在 @media 中改变其相对页面结构的位置；响应式只能裁剪、隐藏或保持原坐标。',
    '最高优先级硬约束：设计稿中出现的所有可见文字必须逐字使用 source-texts.json 的 characters，并在承载该文字的唯一 HTML 元素上添加 data-text-source-node-id="对应 sourceNodeId"。严禁让 AI 总结、改写、概括、纠错、删减、扩写、同义替换、重新断句、调整字符顺序或生成替代文案；标题、正文、标签、导航、按钮、页尾和其他文案均无例外。允许用 HTML 标签承载原有结构，但所有后代文本拼接后必须与 characters 完全一致。',
    'characters 中的换行、连续空格和制表符是设计稿显式排版事实，不是可忽略空白。characters 包含这些保真空白时，承载元素必须同时添加 data-text-preserve-whitespace="true"；CSS 必须提供 [data-text-preserve-whitespace="true"] { white-space: pre-wrap; }，不得将换行替换为空格、折叠连续空格或仅依靠容器自动折行模拟。',
    '透明背景约束适用于所有元素，不仅是图片：当节点事实显示 fills 为空、填充透明或该节点仅为透明容器时，生成的对应元素及其容器必须保持 background:transparent，不得自行添加背景色、渐变、背景图片、遮罩或其他产生可见底色的效果。只有资源/节点事实、design-tokens 或 assembly.plan.md 明确给出非透明填充、毛玻璃或模糊装饰时，才允许设置对应背景；不得为了增强层次、可读性或补全视觉而猜测填充色。',
    '模糊与毛玻璃还原：模糊光晕、毛玻璃、复杂阴影和多层半透明装饰优先使用 asset-index 中的 rendered slice/copiedPath 静态化；没有可用资源时，允许使用 CSS filter: blur(...)、backdrop-filter、-webkit-backdrop-filter 或半透明渐变还原设计稿。运行时模糊应放在装饰层或需要毛玻璃的局部表面，避免遮挡正文和交互控件，并保留合理 z-index。',
    'node-style-facts.json 是节点视觉样式的最高优先级事实源。已有 resolvedBackgroundColor、textColor、stroke 或 cornerRadius 时必须逐值使用；design-tokens 只允许复用相同值，不得用文字色、常见网站配色或其他语义 token 替换节点事实。',
    '对 node-style-facts 中 bindingRequired=true 的背景节点：承载该背景的 HTML 元素必须添加 data-style-source-node-id="对应 sourceNodeId"，CSS 必须包含精确的 [data-style-source-node-id="对应 sourceNodeId"] 选择器并设置与 resolvedBackgroundColor 相同的 background-color；背景矩形可以作为父 section/header/footer 的样式来源，无需额外创建空 DOM。',
    'asset-index.renderPolicy 是资源最终使用策略：required-final 必须使用 copiedPath 并绑定 sourceNodeId/data-asset-id；review-only/forbidden-final 只能用于视觉复核，禁止出现在 HTML/CSS；fallback-only 只在缺字体或视觉风险触发时作为可访问文本的视觉替代层；css-preferred 优先使用 CSS 还原。asset-index 中 usage=background-decor-mask、masked-composite 或 rendered-visual 且 mustUseRenderedSlice=true 的资源代表 MasterGo 组合节点的整体合成切片，不得改用 insideBackgroundDecorMask=true、insideForcedRenderedSlice=true 或 usage=rendered-slice-child 的内部 image 子资源。背景装饰切片不得放入 header/nav/main 文档流，不得设置高于导航或内容的 z-index；普通 icon/logo 组合切片应按其语义放在原位置。',
    '静态资源完整性硬约束：asset-index 中 status=present 且 copiedPath 存在的资源必须优先按原位置使用；status=reference-only 的图片、SVG、node-slice 或 renderedAssets 不得编造路径、不得用 CSS 形状或近似图标替代。缺资源时保留透明占位并绑定 data-source-node-id/data-asset-id，同时在静态校验提示中暴露缺口，方便回到插件导出补齐。',
    '图片 src 只能使用 asset-index 的 copiedPath。同一 asset 有多个 rendered slice 时，优先按 sourceNodeId 选择精确切片，再使用 preferred。关键元素按计划添加 data-source-node-id、data-asset-id、data-action。透明图片正常加载时不得有黑色底；图片容器默认背景必须透明，只有 img 触发真实 error 后才允许通过 is-missing 等失败态显示保留原尺寸的纯黑色块。',
    '禁止在 HTML 中手绘 inline SVG/path，也禁止用 CSS clip-path、border 拼形状或任意曲线近似设计图里的矢量。矢量视觉必须来自 asset-index.copiedPath；若输入包没有对应资源，只能保留透明占位并暴露资源缺口。',
    '字体注入硬约束：如果 font-assets.json 中某个字体 status=downloaded，styles.css 顶部必须为其每个 assets/fonts 文件生成 @font-face，font-family、font-weight、font-style、src url 和 format 必须逐项使用 font-assets.json；正文样式优先使用原 font family，并追加 fallbackStack。status=fallback-required 的字体不得编造文件路径，只能使用 fallbackStack。',
    'Banner/大标题排版硬约束：node-style-facts 中 textBindingRequired=true 的可见文字必须使用 typography 的 font-size、font-weight、line-height、水平对齐和源文本框 bounds；不得把相邻标题合并成一个文本节点，不得用 Grid/Flex 自动挤压改变它们的相对位置。若 asset-index 存在 fontFallbackRequired=true 的 fallback-only 切片，必须以该切片作为唯一可见文字视觉并按 source-bounds 定位；原 data-text-source-node-id 元素仍逐字保留，但添加 data-font-fallback-accessible="true" 并用统一 visually-hidden 规则移出视觉布局，防止缺失字体改变字宽后重叠。',
    '跨模块层级硬约束：page-layout.json 的 stackingFacts 是设计稿绘制顺序事实。每条关系的 lowerSourceNodeId 与 upperSourceNodeId 对应模块都必须建立独立 stacking context（position 非 static、isolation:isolate、数值 z-index），且 upper 的 z-index 必须严格大于 lower。Hero/Banner 与白色内容面板重叠时，Banner 背景和人物图不得覆盖面板的白底、圆角或面板内容。',
    '主 CTA 必须使用 button；未知链接不得使用 alert，采用页面内锚点或非阻塞的页面内提示。',
    '文件引用硬约束：index.html 必须在 head 中引用本地样式 `<link rel="stylesheet" href="styles.css">`，并在 body 结束前引用本地脚本 `<script src="script.js"></script>`；不得内联完整 CSS/JS 后省略这两个本地文件引用。',
    '输出必须是 JSON 对象，键仅为 index.html、styles.css、script.js，值为完整代码字符串；不要 Markdown、解释文字或额外键。',
  ], 'html').join('\n')
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
    `## font-assets.json\n${JSON.stringify(context.fontAssets)}`,
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
  if (!/<link\b[^>]*\bhref=["'](?:\.\/)?styles\.css["'][^>]*>/i.test(html)) errors.push('index.html 未引用 styles.css')
  if (!/<script\b[^>]*\bsrc=["'](?:\.\/)?script\.js["'][^>]*>/i.test(html)) errors.push('index.html 未引用 script.js')
  if (!/<html\b/i.test(html) || !/<body\b/i.test(html)) errors.push('HTML 缺少 html/body 结构')
  if (!balanced(stripCommentsAndStrings(css), '{', '}')) errors.push('CSS 花括号不平衡')
  try { new Function(js) } catch (error) { errors.push(`JS 语法错误：${error.message}`) }
  validateImageFallback(css, js, errors)
  validateRootScrolling(html, css, errors)
  validateCssPerformanceBudget(css, errors, warnings)
  validateLayoutSpacing(html, css, context.pageLayout, context.nodeStyleFacts, context.assemblyPlan, errors, warnings)
  validateSourceTexts(html, css, context.sourceTexts, errors)
  validateRequiredNodeStyles(html, css, context.nodeStyleFacts, errors)
  validateRequiredTypography(html, css, context.nodeStyleFacts, context.assetIndex, errors)
  validateNoFabricatedInlineSvg(html, errors)
  if (/<(?:img|script|link|source|video|audio)\b[^>]*(?:src|href)=["']https?:\/\//i.test(html) || /(?:url\(|@import\s+)[^;\n]*https?:\/\//i.test(css)) errors.push('禁止引用网络资源')
  if (/(?:src|href)=["'](?:\.\.\/|\/)/i.test(html) || /url\(\s*["']?(?:\.\.\/|\/)/i.test(css)) errors.push('禁止引用输出目录之外的路径')
  const assetsByPath = new Map()
  for (const asset of context.assetIndex.assets || []) {
    for (const path of [asset.preferred?.copiedPath, ...(asset.rendered || []).map((item) => item.path)].filter(Boolean)) assetsByPath.set(path, asset)
  }
  const allowed = new Set(assetsByPath.keys())
  for (const file of context.fontAssets?.files || []) allowed.add(file)
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
      if (!allowed.has(value)) errors.push(`CSS 资源路径不在资源清单：${value}`)
      else if (!existsSync(join(context.assetsDir, value.slice('assets/'.length)))) reportMissingAsset(value, assetsByPath.get(value), errors, warnings)
    }
  }
  validateForbiddenRenderPolicyAssets(html, css, context.assetIndex, errors)
  validateRequiredRenderedAssets(html, css, context.pageLayout, context.assetIndex, errors)
  validateDecorativeAssetAnchoring(html, css, context.assetIndex, errors)
  validateSourceBoundsAssets(html, css, context.assetIndex, errors)
  validateFontFallbackAssets(html, css, context.assetIndex, errors)
  validateModuleStacking(html, css, context.pageLayout, errors)
  validateFontAssets(css, context.fontAssets, errors)
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], checkedAt: new Date().toISOString() }
}

function summarizeStaticValidationWarnings(validation = {}) {
  const warnings = [...new Set([
    ...(validation.ok ? [] : validation.errors || []),
    ...(validation.warnings || []),
  ].filter(Boolean))]
  if (warnings.length === 0) return []
  return warnings.map((item) => `静态校验提示：${item}`)
}

function validateForbiddenRenderPolicyAssets(html, css, assetIndex = {}, errors) {
  const combined = `${html}\n${css}`
  for (const asset of assetIndex.assets || []) {
    if (!['review-only', 'forbidden-final'].includes(asset.renderPolicy)) continue
    const paths = [asset.preferred?.copiedPath, ...(asset.rendered || []).map((item) => item.path)].filter(Boolean)
    for (const path of paths) {
      if (!combined.includes(path)) continue
      errors.push(`资源仅供复核不得进入最终 HTML/CSS：${asset.assetId} (${asset.renderPolicy}) -> ${path}`)
    }
  }
}

function validateRequiredRenderedAssets(html, css, pageLayout = {}, assetIndex = {}, errors) {
  const requiredAssetIds = new Set((pageLayout.modules || []).flatMap((module) => Array.isArray(module.assetIds) ? module.assetIds : []))
  if (requiredAssetIds.size === 0) return
  const combined = `${html}\n${css}`
  for (const asset of assetIndex.assets || []) {
    if (!requiredAssetIds.has(asset.assetId)) continue
    if (!isRequiredFinalRenderedAsset(asset)) continue
    const copiedPath = asset.preferred?.copiedPath
    if (!copiedPath) continue
    if (!combined.includes(copiedPath)) {
      errors.push(`必须使用整体切片资源：${asset.assetId} -> ${copiedPath}`)
      continue
    }
    if (!requiresHtmlAssetBinding(asset)) continue
    if (hasBoundImageForAsset(html, copiedPath, asset)) continue
    errors.push(`整体切片资源缺少 HTML 绑定：${asset.assetId} -> ${copiedPath}`)
  }
}

function isRequiredFinalRenderedAsset(asset) {
  if (asset?.renderPolicy) return asset.renderPolicy === 'required-final'
  if (!asset?.mustUseRenderedSlice) return false
  const usage = asset.usage || asset.usageHint
  return ['logo', 'icon', 'masked-composite', 'background-decor-mask'].includes(usage)
    || ['logo', 'icon', 'masked-composite', 'background-decor-mask'].includes(asset.usageHint)
}

function requiresHtmlAssetBinding(asset) {
  const usage = asset.usage || asset.usageHint
  return ['logo', 'icon', 'masked-composite'].includes(usage)
    || ['logo', 'icon', 'masked-composite'].includes(asset.usageHint)
}

function hasBoundImageForAsset(html, copiedPath, asset) {
  const pathPattern = escapeRegExp(copiedPath)
  const assetPattern = escapeRegExp(asset.assetId)
  for (const tag of String(html || '').matchAll(/<img\b[^>]*>/gi)) {
    const sourceNodeIds = (asset.sourceNodes || []).map((source) => String(source.sourceNodeId)).filter(Boolean)
    const hasPath = new RegExp(`\\bsrc=["']${pathPattern}["']`, 'i').test(tag[0])
    const hasAsset = new RegExp(`\\bdata-asset-id=["']${assetPattern}["']`, 'i').test(tag[0])
    const hasSource = sourceNodeIds.length === 0 || sourceNodeIds.some((nodeId) => {
      const sourcePattern = escapeRegExp(nodeId)
      return new RegExp(`\\bdata-source-node-id=["']${sourcePattern}["']`, 'i').test(tag[0])
    })
    if (hasPath && hasAsset && hasSource) return true
  }
  return false
}

function validateDecorativeAssetAnchoring(html, css, assetIndex = {}, errors) {
  const rules = extractCssRules(css)
  const combined = `${html}\n${css}`
  for (const asset of assetIndex.assets || []) {
    if (!isDecorativeAsset(asset)) continue
    const paths = [asset.preferred?.copiedPath, ...(asset.rendered || []).map((item) => item.path)].filter(Boolean)
    if (paths.length === 0) continue
    const source = asset.sourceNodes?.[0]?.sourceNodeId || asset.assetId
    for (const path of paths) {
      if (!combined.includes(path)) continue
      for (const rule of rules) {
        if (!rule.declarations.includes(path)) continue
        if (hasFluidDecorativeSizing(rule.declarations)) {
          errors.push(`背景装饰资源不得流体铺满或 cover 缩放：${source} / ${asset.assetId} -> ${path}（${rule.selector}）`)
        }
      }
      for (const tag of html.matchAll(/<img\b[^>]*>/gi)) {
        if (!tag[0].includes(path) && !tag[0].includes(`data-asset-id="${asset.assetId}"`) && !tag[0].includes(`data-asset-id='${asset.assetId}'`)) continue
        const classNames = (tag[0].match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || '').split(/\s+/).filter(Boolean)
        for (const rule of rules) {
          if (!selectorTargetsAssetImage(rule.selector, asset.assetId, classNames)) continue
          if (hasFluidDecorativeSizing(rule.declarations)) {
            errors.push(`背景装饰资源不得流体铺满或 cover 缩放：${source} / ${asset.assetId} -> ${path}（${rule.selector}）`)
          }
        }
      }
    }
  }
}

function validateSourceBoundsAssets(html, css, assetIndex = {}, errors) {
  const rules = extractCssRules(css)
  const variables = collectCssVariables(css)
  for (const asset of assetIndex.assets || []) {
    const mustUse = asset.renderPolicy === 'required-final' || asset.fontFallbackRequired
    const copiedPath = asset.preferred?.copiedPath
    if (!copiedPath || (!mustUse && !`${html}\n${css}`.includes(copiedPath))) continue
    if (!asset.sizingPolicy && !asset.positioningPolicy) continue
    const tag = findBoundImageTag(html, asset, copiedPath)
    if (!tag) continue
    const declarations = collectElementDeclarations(tag.tag, rules, variables)
    const expected = asset.localBounds || asset.sourceBounds
    if (!expected) continue

    if (asset.croppingPolicy === 'preserve-rendered-slice') {
      const objectFit = String(declarations.get('object-fit') || '').trim().toLowerCase()
      const inset = String(declarations.get('inset') || '').trim().toLowerCase()
      if (objectFit === 'cover') errors.push(`预裁切资源不得再次 cover：${asset.assetId} -> ${copiedPath}`)
      if (/^0(?:px)?$/.test(inset)) errors.push(`预裁切资源不得使用 inset:0 铺满：${asset.assetId} -> ${copiedPath}`)
    }

    if (asset.sizingPolicy === 'source-size' || asset.positioningPolicy === 'source-bounds') {
      validateExactPixelDeclaration(declarations, 'width', expected.width, `资源 ${asset.assetId} 宽度`, errors)
      validateExactPixelDeclaration(declarations, 'height', expected.height, `资源 ${asset.assetId} 高度`, errors)
    }
    if (asset.positioningPolicy !== 'source-bounds') continue
    if (String(declarations.get('position') || '').trim().toLowerCase() !== 'absolute') {
      errors.push(`源坐标资源必须 absolute 定位：${asset.assetId}`)
    }
    validateExactPixelDeclaration(declarations, 'left', expected.x, `资源 ${asset.assetId} 横坐标`, errors)
    validateExactPixelDeclaration(declarations, 'top', expected.y, `资源 ${asset.assetId} 纵坐标`, errors)
    for (const property of ['right', 'bottom']) {
      const value = String(declarations.get(property) || '').trim()
      if (value && !/^auto$/i.test(value)) errors.push(`源坐标资源不得使用 ${property} 定位：${asset.assetId} -> ${value}`)
    }
    validateCoordinateAnchor(html, tag, asset.anchorNodeId, rules, variables, `资源 ${asset.assetId}`, errors)
  }
}

function validateFontFallbackAssets(html, css, assetIndex = {}, errors) {
  const requiredAssets = (assetIndex.assets || []).filter((asset) => asset.fontFallbackRequired)
  if (requiredAssets.length === 0) return
  if (!hasAccessibleFontFallbackRule(css)) {
    errors.push('缺字大标题兜底缺少统一 visually-hidden 规则：[data-font-fallback-accessible="true"]')
  }
  for (const asset of requiredAssets) {
    const copiedPath = asset.preferred?.copiedPath
    const tag = copiedPath ? findBoundImageTag(html, asset, copiedPath) : null
    if (!copiedPath || !tag) {
      errors.push(`缺字大标题必须使用渲染切片：${asset.assetId} -> ${copiedPath || 'missing copiedPath'}`)
      continue
    }
    const fallbackIds = new Set(splitAttributeTokens(extractAttributeValue(tag.tag, 'data-font-fallback-for')))
    for (const sourceNodeId of asset.fallbackForTextNodeIds || []) {
      if (!fallbackIds.has(String(sourceNodeId))) {
        errors.push(`缺字切片未声明覆盖文本：${asset.assetId} -> ${sourceNodeId}`)
      }
      const bindings = extractTextBindings(html, sourceNodeId)
      if (bindings.length !== 1) continue
      if (!/\bdata-font-fallback-accessible\s*=\s*["']true["']/i.test(bindings[0].attributes)) {
        errors.push(`缺字大标题原文必须移出视觉布局：${sourceNodeId}`)
      }
    }
  }
}

function validateModuleStacking(html, css, pageLayout = {}, errors) {
  const facts = Array.isArray(pageLayout.stackingFacts) ? pageLayout.stackingFacts : []
  if (facts.length === 0) return
  const rules = extractCssRules(css)
  const variables = collectCssVariables(css)
  for (const fact of facts) {
    const lowerTag = findTagBySourceNodeId(html, fact.lowerSourceNodeId)
    const upperTag = findTagBySourceNodeId(html, fact.upperSourceNodeId)
    if (!lowerTag || !upperTag) {
      errors.push(`重叠模块缺少 sourceNodeId 绑定：${fact.lowerSourceNodeId} < ${fact.upperSourceNodeId}`)
      continue
    }
    const lowerDeclarations = collectElementDeclarations(lowerTag.tag, rules, variables)
    const upperDeclarations = collectElementDeclarations(upperTag.tag, rules, variables)
    const lowerZ = parseCssNumber(lowerDeclarations.get('z-index'))
    const upperZ = parseCssNumber(upperDeclarations.get('z-index'))
    if (!Number.isFinite(lowerZ) || !Number.isFinite(upperZ)) {
      errors.push(`重叠模块必须声明数值 z-index：${fact.lowerSourceNodeId} < ${fact.upperSourceNodeId}`)
      continue
    }
    if (upperZ <= lowerZ) {
      errors.push(`重叠模块层级错误：${fact.upperSourceNodeId} 的 z-index(${upperZ}) 必须高于 ${fact.lowerSourceNodeId}(${lowerZ})`)
    }
    for (const [sourceNodeId, declarations] of [[fact.lowerSourceNodeId, lowerDeclarations], [fact.upperSourceNodeId, upperDeclarations]]) {
      if (/^static$/i.test(String(declarations.get('position') || 'static'))) {
        errors.push(`重叠模块 z-index 不生效：${sourceNodeId} 必须 position 非 static`)
      }
      if (!/^isolate$/i.test(String(declarations.get('isolation') || '').trim())) {
        errors.push(`重叠模块必须隔离 stacking context：${sourceNodeId} 缺少 isolation:isolate`)
      }
    }
  }
}

function isDecorativeAsset(asset) {
  const values = [
    asset?.usage,
    asset?.usageHint,
    ...(asset?.usageCandidates || []).map((candidate) => candidate?.usage),
    ...(asset?.sourceNodes || []).flatMap((source) => [source?.usageHint, ...(source?.semanticHints || []).map((hint) => hint?.usage)]),
  ].filter(Boolean)
  return values.some((value) => ['background-decor', 'background-decor-mask', 'decorative'].includes(value))
}

function selectorTargetsAssetImage(selector, assetId, classNames) {
  if (selector.includes(`[data-asset-id="${assetId}"]`) || selector.includes(`[data-asset-id='${assetId}']`)) return true
  return classNames.some((className) => selector.includes(`.${className}`))
}

function hasFluidDecorativeSizing(declarations) {
  const objectFit = lastDeclaration(declarations, 'object-fit')
  const backgroundSize = lastDeclaration(declarations, 'background-size')
  const width = lastDeclaration(declarations, 'width')
  const height = lastDeclaration(declarations, 'height')
  const inset = lastDeclaration(declarations, 'inset')
  return /\bcover\b/i.test(objectFit || '')
    || /\bcover\b|100%\s+100%/i.test(backgroundSize || '')
    || /^100%$/i.test(String(width || '').trim()) && /^100%$/i.test(String(height || '').trim())
    || /^0(?:px)?$/i.test(String(inset || '').trim())
}

function validateLayoutSpacing(html, css, pageLayout = {}, nodeStyleFacts = {}, assemblyPlan = '', errors, warnings) {
  const rules = extractCssRules(css)
  validateBackgroundLayerFlowUsage(html, rules, pageLayout, nodeStyleFacts, errors)
  validateExcessiveModuleSpacing(rules, pageLayout, errors)
  validateHeroBackgroundSizing(rules, pageLayout, assemblyPlan, errors, warnings)
}

function validateBackgroundLayerFlowUsage(html, rules, pageLayout, nodeStyleFacts, errors) {
  const fallbackLayers = inferBackgroundLayerFacts(nodeStyleFacts)
  const structuralSelectors = collectStructuralSelectors(html)
  for (const module of pageLayout?.modules || []) {
    const moduleLayers = module.backgroundLayers?.length > 0
      ? module.backgroundLayers
      : fallbackLayers.filter((layer) => layer.bounds && boundsOverlap(layer.bounds, module.bounds))
    for (const layer of moduleLayers) {
      if (layer.affectsFlow !== false || !layer.bounds) continue
      const selectorHints = sourceNodeSelectorHints(layer.sourceNodeId)
      const suspiciousValues = new Set([
        Math.round(Number(layer.bounds.height)),
        Math.round(Number(layer.bounds.y - (module.bounds?.y ?? 0))),
        ...((module.contentFlow?.items || []).map((item) => Math.round(Number(item.bounds?.y) - Number(layer.bounds.y)))),
        Math.round(Number(module.contentFlow?.firstContentY) - Number(layer.bounds.y)),
        ...inferContentDeltasFromFacts(layer, nodeStyleFacts),
      ].filter((value) => Number.isFinite(value) && value > 0))
      for (const rule of rules) {
        const selectorMentionsLayer = selectorHints.some((hint) => rule.selector.includes(hint))
        const selectorTargetsLayerElement = selectorMentionsLayer || selectorHasHtmlSourceBinding(html, rule.selector, layer.sourceNodeId)
        for (const property of ['padding-top', 'margin-top']) {
          for (const declaration of getDeclarations(rule.declarations, property)) {
            const pixels = extractPixelValues(declaration)
            for (const value of pixels) {
              if (!suspiciousValues.has(Math.round(value))) continue
              if (isStructuralSelector(rule.selector, structuralSelectors)) continue
              errors.push(`背景层不得制造内容流空间：${layer.sourceNodeId} 的 ${Math.round(value)}px 被用于 ${property}（${rule.selector}）`)
            }
          }
        }
        for (const property of ['height', 'min-height']) {
          for (const declaration of getDeclarations(rule.declarations, property)) {
            const pixels = extractPixelValues(declaration)
            for (const value of pixels) {
              if (Math.round(value) !== Math.round(Number(layer.bounds.height))) continue
              if (isStructuralSelector(rule.selector, structuralSelectors)) continue
              if (selectorTargetsLayerElement || isDecorativeLayerRule(rule) || /::?(?:before|after)\b/i.test(rule.selector)) continue
              errors.push(`背景层不得制造内容流空间：${layer.sourceNodeId} 的 ${Math.round(value)}px 被用于 ${property}（${rule.selector}）`)
            }
          }
        }
        for (const declaration of getDeclarations(rule.declarations, 'padding')) {
          const top = extractBoxTopPixelValue(declaration)
          if (top === undefined || !suspiciousValues.has(Math.round(top))) continue
          if (isStructuralSelector(rule.selector, structuralSelectors)) continue
          errors.push(`背景层不得制造内容流空间：${layer.sourceNodeId} 的 ${Math.round(top)}px 被用于 padding-top（${rule.selector}）`)
        }
      }
    }
  }
}

function collectStructuralSelectors(html) {
  const selectors = new Set()
  for (const tag of String(html || '').matchAll(/<[^/!][^>]*>/g)) {
    const classValue = tag[0].match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1]
    if (!classValue) continue
    for (const className of classValue.split(/\s+/).filter(Boolean)) {
      if (/^(page|site|job|hero|footer|header|main)(?:-|$)/i.test(className)) selectors.add(`.${className}`)
    }
  }
  return selectors
}

function isStructuralSelector(selector, structuralSelectors) {
  const normalized = String(selector || '').trim()
  return structuralSelectors.has(normalized) || [...structuralSelectors].some((item) => normalized.startsWith(`${item} `) || normalized.includes(`${item}__`))
}

export function isLikelyTruncatedJsonError(error, text) {
  const message = error instanceof Error ? error.message : String(error || '')
  if (/Unterminated string|Unexpected end of JSON input|Expected ',' or '}' after property value|Bad control character/i.test(message)) return true

  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  if (!cleaned) return false
  const last = cleaned.at(-1)
  return (cleaned.startsWith('{') || cleaned.startsWith('[')) && last !== '}' && last !== ']'
}

function buildValidationRepairPrompt(basePrompt, errors, context) {
  const repairNotes = []
  const textIds = [
    ...extractErrorSourceNodeIds(errors, /设计稿原文字符或空白不一致：(.+)$/),
    ...extractErrorSourceNodeIds(errors, /缺少或改写设计稿原文：(.+)$/),
    ...extractErrorSourceNodeIds(errors, /设计稿原文缺少文本节点绑定：(.+)$/),
  ]
  const duplicateTextIds = extractErrorSourceNodeIds(errors, /设计稿原文存在重复文本节点绑定：(.+)$/)
  if (duplicateTextIds.length > 0) {
    repairNotes.push('以下文本 sourceNodeId 在 HTML 中只能绑定一次：删除重复的 data-text-source-node-id，只保留承载真实可见文字的那个元素；如果需要嵌套 span，只有最内层或最外层一个元素带该绑定，不要父子同时绑定。')
    for (const id of duplicateTextIds) repairNotes.push(`- ${id}`)
  }
  if (textIds.length > 0) {
    repairNotes.push('以下文本必须逐字逐空白替换为 source-texts.json 原文；不要拆成多个 data-text-source-node-id 绑定，不要改写分隔符、空格、版权符号或全角竖线：')
    for (const item of context.sourceTexts || []) {
      if (textIds.includes(String(item.sourceNodeId))) repairNotes.push(`- ${item.sourceNodeId}: ${JSON.stringify(item.characters)}`)
    }
  }

  const whitespaceIds = [
    ...extractErrorSourceNodeIds(errors, /文本缺少 white-space: pre-wrap 规则：(.+)$/),
    ...textIds.filter((id) => {
      const item = (context.sourceTexts || []).find((sourceText) => String(sourceText.sourceNodeId) === String(id))
      return item && requiresWhitespacePreservation(item.characters)
    }),
  ]
  if (whitespaceIds.length > 0) {
    repairNotes.push('styles.css 必须包含这一条全局规则，且不能写成 pre-line/normal：')
    repairNotes.push('- [data-text-preserve-whitespace="true"] { white-space: pre-wrap; }')
  }

  const styleIds = extractErrorSourceNodeIds(errors, /关键节点样式缺少可审计 CSS 背景规则：(.+)$/)
  if (styleIds.length > 0) {
    repairNotes.push('以下关键背景节点必须在 HTML 绑定 data-style-source-node-id，并在 CSS 使用同一个属性选择器直接声明 background-color：')
    for (const id of styleIds) {
      const fact = findNodeStyleFact(context.nodeStyleFacts, id)
      repairNotes.push(`- [data-style-source-node-id="${id}"] { background-color: ${fact?.resolvedBackgroundColor || '对应 resolvedBackgroundColor'}; }`)
    }
  }
  if (errors.includes('index.html 未引用 styles.css') || errors.includes('index.html 未引用 script.js')) {
    repairNotes.push('index.html 必须显式引用生成的本地文件，不能只输出文件内容而不挂载：')
    repairNotes.push('- 在 <head> 内加入 <link rel="stylesheet" href="styles.css">')
    repairNotes.push('- 在 </body> 前加入 <script src="script.js"></script>')
  }
  const missingRenderedAssetIds = extractErrorSourceNodeIds(errors, /必须使用整体切片资源：(.+?) -> /)
  const unboundRenderedAssetIds = extractErrorSourceNodeIds(errors, /整体切片资源缺少 HTML 绑定：(.+?) -> /)
  const renderedAssetIds = [...new Set([...missingRenderedAssetIds, ...unboundRenderedAssetIds])]
  if (renderedAssetIds.length > 0) {
    repairNotes.push('以下强制切片/Logo/蒙版合成资源必须作为最终视觉使用；使用 asset-index 的 preferred.copiedPath，HTML img 同时绑定 data-asset-id 和对应 data-source-node-id，不要用空 span、CSS 猜测或内部子图替代：')
    for (const asset of context.assetIndex.assets || []) {
      if (!renderedAssetIds.includes(String(asset.assetId))) continue
      const sourceIds = (asset.sourceNodes || []).map((source) => source.sourceNodeId).filter(Boolean).join('、')
      repairNotes.push(`- ${asset.assetId}: ${asset.preferred?.copiedPath || '缺少 copiedPath'}${sourceIds ? `；sourceNodeId=${sourceIds}` : ''}`)
    }
  }
  if (errors.some((error) => /缺字大标题|缺字切片/.test(error))) {
    repairNotes.push('缺失字体的大标题必须使用 asset-index 中 fontFallbackRequired=true 的 fallback-only 切片：img 绑定 data-asset-id、data-source-node-id 和 data-font-fallback-for；对应原文节点添加 data-font-fallback-accessible="true"，并使用 1px absolute/overflow:hidden/clip-path 的统一 visually-hidden 规则。')
  }
  if (errors.some((error) => /源坐标资源|横坐标|纵坐标|不得使用 (?:right|bottom) 定位/.test(error))) {
    repairNotes.push('positioningPolicy=source-bounds 的资源必须在 anchorNodeId 容器内 position:absolute，并逐项使用 localBounds 的 px left/top/width/height；删除 right、bottom、百分比和 viewport 单位。')
  }
  if (errors.some((error) => /预裁切资源/.test(error))) {
    repairNotes.push('croppingPolicy=preserve-rendered-slice 的资源已经包含最终蒙版和透明裁切：删除 object-fit:cover 与 inset:0，按 localBounds 的原始 px 尺寸直接显示，并保持承载容器透明。')
  }
  if (errors.some((error) => /源坐标容器|中间容器改变了源坐标系/.test(error))) {
    repairNotes.push('anchorNodeId 对应元素必须绑定 data-source-node-id 并设置 position:relative；资源/文字与该 anchor 之间不得存在 position 非 static 的中间容器。')
  }
  if (errors.some((error) => /inline SVG/.test(error))) {
    repairNotes.push('删除所有内联 svg/path 和手绘曲线。只允许通过 <img src="asset-index.copiedPath"> 使用输入包中的真实 SVG；输入包缺少资源时保留透明占位。')
  }
  if (errors.some((error) => /重叠模块/.test(error))) {
    repairNotes.push('按 page-layout.stackingFacts 修复跨模块层级：lower/upper 元素都绑定对应 sourceNodeId，设置 position:relative、isolation:isolate 和数值 z-index，upper 的值严格大于 lower。')
  }
  if (errors.some((error) => /大标题/.test(error))) {
    repairNotes.push('未使用字体切片的大标题必须直接按 node-style-facts.typography 和 localBounds 声明 font-size、font-weight、line-height、text-align、position:absolute、left/top/width/height。')
  }

  return [
    basePrompt,
    '',
    '上一次输出未通过静态校验，请修正以下错误后重新输出三个完整文件：',
    `- ${errors.join('\n- ')}`,
    repairNotes.length > 0 ? ['', '定向修复要求：', ...repairNotes].join('\n') : '',
  ].filter(Boolean).join('\n')
}

function extractErrorSourceNodeIds(errors, pattern) {
  return [...new Set((errors || [])
    .map((error) => String(error || '').match(pattern)?.[1])
    .filter(Boolean))]
}

function findNodeStyleFact(nodeStyleFacts, sourceNodeId) {
  return (Array.isArray(nodeStyleFacts?.facts) ? nodeStyleFacts.facts : [])
    .find((fact) => String(fact.sourceNodeId) === String(sourceNodeId))
}

function validateExcessiveModuleSpacing(rules, pageLayout, errors) {
  for (const module of pageLayout?.modules || []) {
    const outerTop = Number(module.spacing?.outer?.top)
    if (!Number.isFinite(outerTop) || outerTop <= 0) continue
    const limit = Math.max(96, outerTop * 1.5 + 24)
    const moduleSlug = module.moduleId ? module.moduleId.split('_').slice(2).join('-') : ''
    for (const rule of rules) {
      if (moduleSlug && !rule.selector.toLowerCase().includes(moduleSlug.toLowerCase())) continue
      for (const property of ['padding-top', 'margin-top']) {
        for (const declaration of getDeclarations(rule.declarations, property)) {
          const excessive = extractPixelValues(declaration).find((value) => value > limit)
          if (excessive !== undefined) {
            errors.push(`内容区域顶部间距异常：${rule.selector} 的 ${property}:${Math.round(excessive)}px 超过非装饰内容推导上限 ${Math.round(limit)}px`)
          }
        }
      }
      for (const declaration of getDeclarations(rule.declarations, 'padding')) {
        const top = extractBoxTopPixelValue(declaration)
        if (top !== undefined && top > limit) {
          errors.push(`内容区域顶部间距异常：${rule.selector} 的 padding-top:${Math.round(top)}px 超过非装饰内容推导上限 ${Math.round(limit)}px`)
        }
      }
    }
  }
}

function validateHeroBackgroundSizing(rules, pageLayout, assemblyPlan, errors, warnings) {
  const preserveSourceBounds = /preserveSourceBounds\s*=\s*true/i.test(String(assemblyPlan || ''))
  for (const module of pageLayout?.modules || []) {
    if (module.type !== 'hero' || preserveSourceBounds) continue
    const heroBounds = module.bounds
    if (!heroBounds) continue
    const mediaRegions = (module.internalRegions || []).filter((region) => region.kind === 'media' && region.bounds)
    const oversizedMedia = mediaRegions.some((region) => isOversizedOrOffset(region.bounds, heroBounds))
    if (!oversizedMedia) continue
    for (const rule of rules) {
      if (!/(?:^|[^a-z0-9-])hero(?:$|[^a-z0-9-])/i.test(rule.selector) || !/(?:photo|image|bg|background|media)/i.test(rule.selector)) continue
      const width = lastDeclaration(rule.declarations, 'width')
      const height = lastDeclaration(rule.declarations, 'height')
      const left = lastDeclaration(rule.declarations, 'left')
      const top = lastDeclaration(rule.declarations, 'top')
      const overWide = cssSizeExceedsPercent(width, 120)
      const overHigh = cssSizeExceedsPercent(height, 120)
      const usesNegativeOffset = cssSizeIsNegative(left) || cssSizeIsNegative(top)
      if (overWide && overHigh && usesNegativeOffset) {
        errors.push(`Hero 背景图疑似机械套用源负坐标：${rule.selector} 使用 ${width}/${height}/${left}/${top}，应按 Banner cover 语义渲染`)
      } else if (overWide || overHigh || usesNegativeOffset) {
        warnings.push(`Hero 背景图存在超比例或负偏移，请截图复核：${rule.selector}`)
      }
    }
  }
}

function sourceNodeSelectorHints(sourceNodeId) {
  if (!sourceNodeId) return []
  return [
    `data-source-node-id="${sourceNodeId}"`,
    `data-style-source-node-id="${sourceNodeId}"`,
  ]
}

function isDecorativeLayerRule(rule) {
  return /(?:^|[.\s_-])(?:decor|decoration|ornament|blur|glow|circle|orb|halo|bg-layer)(?:$|[.\s_-])/i.test(rule.selector)
    && /(?:^|;)\s*position\s*:\s*(?:absolute|fixed)\s*(?:;|$)/i.test(rule.declarations)
}

function selectorHasHtmlSourceBinding(html, selector, sourceNodeId) {
  if (!sourceNodeId) return false
  const classNames = extractSelectorClasses(selector)
  if (classNames.length === 0) return false
  const wantedClasses = new Set(classNames)
  for (const tag of String(html || '').matchAll(/<[^/!][^>]*>/g)) {
    const classValue = tag[0].match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1]
    if (!classValue) continue
    const tagClasses = new Set(classValue.split(/\s+/).filter(Boolean))
    if (!Array.from(wantedClasses).some((className) => tagClasses.has(className))) continue
    const boundSourceNodeId = tag[0].match(/\bdata-(?:source|style-source)-node-id\s*=\s*["']([^"']+)["']/i)?.[1]
    if (boundSourceNodeId === sourceNodeId) return true
  }
  return false
}

function extractSelectorClasses(selector) {
  return [...String(selector || '').matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)]
    .map((match) => match[1])
}

function inferBackgroundLayerFacts(nodeStyleFacts) {
  const facts = Array.isArray(nodeStyleFacts?.facts) ? nodeStyleFacts.facts : []
  const pageArea = Math.max(...facts.map((fact) => area(fact.bounds)), 1)
  return facts
    .filter((fact) => fact.role === 'decorative' && fact.bounds && fact.resolvedBackgroundColor && area(fact.bounds) / pageArea > 0.08)
    .map((fact) => ({
      sourceNodeId: fact.sourceNodeId,
      bounds: fact.bounds,
      cornerRadius: fact.cornerRadius,
      affectsFlow: false,
    }))
}

function inferContentDeltasFromFacts(layer, nodeStyleFacts) {
  if (!(Number(layer.cornerRadius) > 0)) return []
  const facts = Array.isArray(nodeStyleFacts?.facts) ? nodeStyleFacts.facts : []
  return facts
    .filter((fact) => fact.bounds && fact.role !== 'decorative' && fact.bounds.y > layer.bounds.y && horizontalOverlapRatio(fact.bounds, layer.bounds) > 0.2)
    .map((fact) => Math.round(Number(fact.bounds.y) - Number(layer.bounds.y)))
    .filter((value) => Number.isFinite(value) && value > 0 && value < 720)
}

function boundsOverlap(a, b) {
  if (!a || !b) return true
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function area(bounds) {
  return Math.max(0, Number(bounds?.width) || 0) * Math.max(0, Number(bounds?.height) || 0)
}

function horizontalOverlapRatio(a, b) {
  const left = Math.max(Number(a?.x) || 0, Number(b?.x) || 0)
  const right = Math.min((Number(a?.x) || 0) + (Number(a?.width) || 0), (Number(b?.x) || 0) + (Number(b?.width) || 0))
  return Math.max(0, right - left) / Math.max(1, Number(a?.width) || 0)
}

function extractPixelValues(value) {
  return [...String(value || '').matchAll(/(-?[\d.]+)\s*px\b/gi)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite)
}

function extractBoxTopPixelValue(value) {
  const pixels = extractPixelValues(value)
  return pixels.length > 0 ? pixels[0] : undefined
}

function isOversizedOrOffset(mediaBounds, containerBounds) {
  return mediaBounds.x < containerBounds.x
    || mediaBounds.y < containerBounds.y
    || mediaBounds.x + mediaBounds.width > containerBounds.x + containerBounds.width
    || mediaBounds.y + mediaBounds.height > containerBounds.y + containerBounds.height
    || mediaBounds.width > containerBounds.width * 1.2
    || mediaBounds.height > containerBounds.height * 1.2
}

function cssSizeExceedsPercent(value, limit) {
  const match = String(value || '').match(/(-?[\d.]+)\s*%/)
  return Boolean(match && Number(match[1]) > limit)
}

function cssSizeIsNegative(value) {
  return /^-\s*[\d.]+(?:px|%|rem|em|vh|vw)?/i.test(String(value || '').trim())
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

function validateRequiredTypography(html, css, nodeStyleFacts, assetIndex, errors) {
  const fallbackTextIds = new Set((assetIndex?.assets || [])
    .filter((asset) => asset.fontFallbackRequired)
    .flatMap((asset) => asset.fallbackForTextNodeIds || [])
    .map(String))
  const rules = extractCssRules(css)
  const variables = collectCssVariables(css)
  for (const fact of requiredTypographyFacts(nodeStyleFacts)) {
    const sourceNodeId = String(fact.sourceNodeId)
    if (fallbackTextIds.has(sourceNodeId)) continue
    const bound = findTagByAttribute(html, 'data-text-source-node-id', sourceNodeId)
    if (!bound) continue
    const declarations = collectElementDeclarations(bound.tag, rules, variables)
    const typography = fact.typography || {}
    validateExactPixelDeclaration(declarations, 'font-size', typography.fontSize, `大标题 ${sourceNodeId} 字号`, errors)
    validateExactPixelDeclaration(declarations, 'line-height', typography.lineHeight, `大标题 ${sourceNodeId} 行高`, errors)
    validateExactNumericDeclaration(declarations, 'font-weight', typography.fontWeight, `大标题 ${sourceNodeId} 字重`, errors)
    const expectedAlign = cssTextAlign(typography.textAlignHorizontal)
    if (expectedAlign) {
      const actualAlign = String(declarations.get('text-align') || '').trim().toLowerCase()
      if (actualAlign !== expectedAlign) errors.push(`大标题 ${sourceNodeId} 对齐错误：应为 ${expectedAlign}，实际为 ${actualAlign || 'missing'}`)
    }
    if (fact.localBounds) {
      if (String(declarations.get('position') || '').trim().toLowerCase() !== 'absolute') {
        errors.push(`大标题必须按源文本框 absolute 定位：${sourceNodeId}`)
      }
      validateExactPixelDeclaration(declarations, 'left', fact.localBounds.x, `大标题 ${sourceNodeId} 横坐标`, errors)
      validateExactPixelDeclaration(declarations, 'top', fact.localBounds.y, `大标题 ${sourceNodeId} 纵坐标`, errors)
      validateExactPixelDeclaration(declarations, 'width', fact.localBounds.width, `大标题 ${sourceNodeId} 文本框宽度`, errors)
      validateExactPixelDeclaration(declarations, 'height', fact.localBounds.height, `大标题 ${sourceNodeId} 文本框高度`, errors)
      validateCoordinateAnchor(html, bound, fact.anchorNodeId, rules, variables, `文字 ${sourceNodeId}`, errors)
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

function validateCssPerformanceBudget(css, errors, warnings) {
  const rules = extractCssRules(css)
  for (const rule of rules) {
    const declarations = rule.declarations
    const selector = rule.selector
    for (const value of getDeclarations(declarations, 'filter')) {
      if (!value || /\bnone\b/i.test(value)) continue
      const blurValues = [...value.matchAll(/blur\(\s*([\d.]+)\s*(px|rem|em|vh|vw)?\s*\)/gi)]
      if (blurValues.length === 0) {
        warnings.push(`CSS filter 可能增加绘制成本，请确认仅用于小元素：${selector}`)
        continue
      }
      for (const match of blurValues) {
        const unit = (match[2] || 'px').toLowerCase()
        if (unit !== 'px') {
          warnings.push(`CSS blur 使用非 px 单位，请视觉复核跨视口效果：${selector}`)
        }
      }
    }
  }
}

function extractCssRules(css) {
  const rules = []
  for (const match of stripCssComments(css).matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)) {
    rules.push({ selector: match[1].trim().replace(/\s+/g, ' '), declarations: match[2] })
  }
  return rules
}

function findBoundImageTag(html, asset, copiedPath) {
  for (const match of String(html || '').matchAll(/<img\b[^>]*>/gi)) {
    if (extractAttributeValue(match[0], 'src') !== copiedPath) continue
    if (extractAttributeValue(match[0], 'data-asset-id') !== String(asset.assetId)) continue
    return { tag: match[0], tagName: 'img', index: match.index }
  }
  return null
}

function findTagBySourceNodeId(html, sourceNodeId) {
  return findTagByAttribute(html, 'data-source-node-id', sourceNodeId)
    || findTagByAttribute(html, 'data-style-source-node-id', sourceNodeId)
}

function findTagByAttribute(html, attribute, value) {
  const escapedAttribute = escapeRegExp(attribute)
  const escapedValue = escapeRegExp(value)
  const pattern = new RegExp(`<([a-z][\\w:-]*)\\b[^>]*\\b${escapedAttribute}\\s*=\\s*["']${escapedValue}["'][^>]*>`, 'i')
  const match = String(html || '').match(pattern)
  return match ? { tag: match[0], tagName: match[1], index: match.index } : null
}

function collectElementDeclarations(tag, rules, variables) {
  const declarations = new Map()
  for (const rule of rules) {
    if (!selectorTargetsTag(rule.selector, tag)) continue
    for (const declaration of String(rule.declarations || '').split(';')) {
      const colon = declaration.indexOf(':')
      if (colon <= 0) continue
      const property = declaration.slice(0, colon).trim().toLowerCase()
      const rawValue = declaration.slice(colon + 1).trim()
      if (!property || !rawValue) continue
      declarations.set(property, resolveCssValue(rawValue, variables))
    }
  }
  const inline = extractAttributeValue(tag, 'style')
  for (const declaration of String(inline || '').split(';')) {
    const colon = declaration.indexOf(':')
    if (colon <= 0) continue
    declarations.set(declaration.slice(0, colon).trim().toLowerCase(), resolveCssValue(declaration.slice(colon + 1).trim(), variables))
  }
  return declarations
}

function selectorTargetsTag(selector, tag) {
  const tagName = String(tag || '').match(/^<([a-z][\w:-]*)/i)?.[1]?.toLowerCase()
  const id = extractAttributeValue(tag, 'id')
  const classes = new Set((extractAttributeValue(tag, 'class') || '').split(/\s+/).filter(Boolean))
  const attributes = new Map([...String(tag || '').matchAll(/\b([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1], match[2]]))
  return String(selector || '').split(',').some((part) => {
    const compound = part.trim().split(/\s+|>|\+|~/).at(-1)?.replace(/::?[\w-]+(?:\([^)]*\))?$/g, '') || ''
    if (!compound) return false
    const selectorTag = compound.match(/^([a-z][\w-]*)/i)?.[1]?.toLowerCase()
    if (selectorTag && selectorTag !== tagName) return false
    const selectorId = compound.match(/#([\w-]+)/)?.[1]
    if (selectorId && selectorId !== id) return false
    const selectorClasses = [...compound.matchAll(/\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g)].map((match) => match[1])
    if (selectorClasses.some((className) => !classes.has(className))) return false
    const attributeMatches = [...compound.matchAll(/\[([\w:-]+)(?:\s*=\s*["']?([^\]"']+)["']?)?\]/g)]
    for (const match of attributeMatches) {
      if (!attributes.has(match[1])) return false
      if (match[2] !== undefined && attributes.get(match[1]) !== match[2].trim()) return false
    }
    return Boolean(selectorTag || selectorId || selectorClasses.length > 0 || attributeMatches.length > 0)
  })
}

function validateCoordinateAnchor(html, bound, anchorNodeId, rules, variables, label, errors) {
  if (!anchorNodeId || !bound || !Number.isFinite(bound.index)) return
  const ancestors = findOpenElementStack(html, bound.index)
  const anchorIndex = findLastArrayIndex(ancestors, (ancestor) =>
    extractAttributeValue(ancestor.tag, 'data-source-node-id') === String(anchorNodeId)
    || extractAttributeValue(ancestor.tag, 'data-style-source-node-id') === String(anchorNodeId))
  if (anchorIndex < 0) {
    errors.push(`${label} 缺少源坐标容器绑定：${anchorNodeId}`)
    return
  }
  const anchor = ancestors[anchorIndex]
  const anchorDeclarations = collectElementDeclarations(anchor.tag, rules, variables)
  if (/^static$/i.test(String(anchorDeclarations.get('position') || 'static').trim())) {
    errors.push(`${label} 的源坐标容器必须 position 非 static：${anchorNodeId}`)
  }
  for (const ancestor of ancestors.slice(anchorIndex + 1)) {
    const declarations = collectElementDeclarations(ancestor.tag, rules, variables)
    const position = String(declarations.get('position') || 'static').trim().toLowerCase()
    if (position === 'static') continue
    const source = extractAttributeValue(ancestor.tag, 'data-source-node-id') || ancestor.tagName
    errors.push(`${label} 的中间容器改变了源坐标系：${source} (${position})`)
  }
}

function findOpenElementStack(html, endIndex) {
  const stack = []
  const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
  const source = String(html || '').slice(0, Math.max(0, endIndex))
  for (const match of source.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)) {
    const tagName = match[1].toLowerCase()
    if (match[0].startsWith('</')) {
      const openIndex = findLastArrayIndex(stack, (item) => item.tagName === tagName)
      if (openIndex >= 0) stack.splice(openIndex)
      continue
    }
    if (voidElements.has(tagName) || /\/>$/.test(match[0])) continue
    stack.push({ tag: match[0], tagName, index: match.index })
  }
  return stack
}

function findLastArrayIndex(items, predicate) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index], index)) return index
  }
  return -1
}

function validateNoFabricatedInlineSvg(html, errors) {
  if (/<svg\b/i.test(String(html || ''))) {
    errors.push('禁止在 HTML 中手绘 inline SVG；必须使用 asset-index.copiedPath 对应的静态矢量资源')
  }
}

function validateExactPixelDeclaration(declarations, property, expected, label, errors) {
  const expectedNumber = Number(expected)
  if (!Number.isFinite(expectedNumber)) return
  const actualValue = declarations.get(property)
  const actualNumber = parsePixelValue(actualValue)
  if (!Number.isFinite(actualNumber) || Math.abs(actualNumber - expectedNumber) > 1) {
    errors.push(`${label}必须使用源值 ${roundNumber(expectedNumber)}px，实际为 ${actualValue || 'missing'}`)
  }
}

function validateExactNumericDeclaration(declarations, property, expected, label, errors) {
  const expectedNumber = Number(expected)
  if (!Number.isFinite(expectedNumber)) return
  const actualValue = declarations.get(property)
  const actualNumber = parseCssNumber(actualValue)
  if (!Number.isFinite(actualNumber) || Math.abs(actualNumber - expectedNumber) > 0.01) {
    errors.push(`${label}必须使用源值 ${roundNumber(expectedNumber)}，实际为 ${actualValue || 'missing'}`)
  }
}

function parsePixelValue(value) {
  const normalized = String(value ?? '').trim()
  // CSS allows zero lengths without a unit (`left: 0` is equivalent to `left: 0px`).
  // Treating that form as invalid creates noisy false positives without improving fidelity.
  if (/^[+-]?(?:0+(?:\.0*)?|\.0+)$/.test(normalized)) return 0
  const match = normalized.match(/^(-?[\d.]+)px$/i)
  return match ? Number(match[1]) : Number.NaN
}

function parseCssNumber(value) {
  const match = String(value || '').trim().match(/^-?[\d.]+$/)
  return match ? Number(match[0]) : Number.NaN
}

function roundNumber(value) {
  return Math.round(Number(value) * 100) / 100
}

function cssTextAlign(value) {
  const mapping = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }
  return mapping[String(value || '').toUpperCase()]
}

function splitAttributeTokens(value) {
  return String(value || '').split(/[\s,]+/).filter(Boolean)
}

function hasAccessibleFontFallbackRule(css) {
  for (const rule of extractCssRules(css)) {
    if (!/\[data-font-fallback-accessible(?:\s*=|\])/i.test(rule.selector)) continue
    const width = parsePixelValue(lastDeclaration(rule.declarations, 'width'))
    const height = parsePixelValue(lastDeclaration(rule.declarations, 'height'))
    const position = lastDeclaration(rule.declarations, 'position')
    const overflow = lastDeclaration(rule.declarations, 'overflow')
    const clip = lastDeclaration(rule.declarations, 'clip') || lastDeclaration(rule.declarations, 'clip-path')
    if (position === 'absolute' && width === 1 && height === 1 && overflow === 'hidden' && clip) return true
  }
  return false
}

function getDeclarations(block, property) {
  const escaped = escapeRegExp(property)
  return [...String(block || '').matchAll(new RegExp(`(?:^|;)\\s*${escaped}\\s*:\\s*([^;]+)`, 'gi'))].map((match) => match[1].trim())
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
  const bindings = []
  const openTagPattern = new RegExp(`<([a-z][\\w:-]*)\\b([^>]*\\bdata-text-source-node-id\\s*=\\s*["']${escaped}["'][^>]*)>`, 'gi')
  for (const match of String(html || '').matchAll(openTagPattern)) {
    const tagName = match[1]
    const attributes = match[2]
    const afterOpenTag = match.index + match[0].length
    const closePattern = new RegExp(`<\\/${escapeRegExp(tagName)}\\s*>`, 'i')
    const closeMatch = String(html || '').slice(afterOpenTag).match(closePattern)
    const content = closeMatch ? String(html || '').slice(afterOpenTag, afterOpenTag + closeMatch.index) : extractTextAttributeValue(attributes)
    bindings.push({ attributes, content })
  }
  return bindings
}

function extractTextAttributeValue(attributes) {
  for (const name of ['placeholder', 'aria-label', 'value', 'alt', 'title']) {
    const value = extractAttributeValue(attributes, name)
    if (value !== undefined) return value
  }
  return ''
}

function extractAttributeValue(attributes, name) {
  const escaped = escapeRegExp(name)
  const match = String(attributes || '').match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))
  return match ? match[2] : undefined
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
  if (path.startsWith('assets/fonts/')) {
    errors.push(message)
    return
  }
  if (asset?.usage === 'logo' || asset?.usage === 'content-image') errors.push(message)
  else warnings.push(`${message}；按纯黑色块降级`)
}

function validateFontAssets(css, fontAssets = {}, errors) {
  const fontFaces = [...String(css || '').matchAll(/@font-face\s*{([^}]+)}/gi)].map((match) => match[1])
  for (const font of fontAssets.fonts || []) {
    if (font.status !== 'downloaded') continue
    for (const asset of font.assets || []) {
      const face = fontFaces.find((block) => block.includes(asset.path))
      if (!face) {
        errors.push(`缺少字体 @font-face 注入：${asset.path}`)
        continue
      }
      if (!new RegExp(`font-family\\s*:\\s*["']?${escapeRegExp(asset.family)}["']?`, 'i').test(face)) {
        errors.push(`字体 @font-face family 不一致：${asset.path}`)
      }
      if (!new RegExp(`font-weight\\s*:\\s*${escapeRegExp(asset.fontWeight)}`, 'i').test(face)) {
        errors.push(`字体 @font-face weight 不一致：${asset.path}`)
      }
      if (!new RegExp(`font-style\\s*:\\s*${escapeRegExp(asset.fontStyle)}`, 'i').test(face)) {
        errors.push(`字体 @font-face style 不一致：${asset.path}`)
      }
    }
  }
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
function readJson(path, fallback) {
  if (existsSync(path)) return JSON.parse(readText(path))
  if (arguments.length >= 2) return fallback
  return JSON.parse(readText(path))
}
function balanced(value, open, close) { let depth = 0; for (const char of value) { if (char === open) depth += 1; if (char === close) depth -= 1; if (depth < 0) return false } return depth === 0 }
function stripCommentsAndStrings(value) { return String(value).replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '') }
function emptyUsage() { return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false } }
function addUsage(target, usage = {}) { target.inputTokens += Number(usage.inputTokens || 0); target.outputTokens += Number(usage.outputTokens || 0); target.totalTokens += Number(usage.totalTokens || 0); target.estimated ||= Boolean(usage.estimated) }
function extractMissingFilesFromError(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  const match = message.match(/缺少有效文件：(.+)$/)
  if (!match) return []
  return match[1].split('、').map((item) => item.trim()).filter(Boolean)
}
