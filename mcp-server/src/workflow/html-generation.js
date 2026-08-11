import http from 'node:http'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { generateTextDetailed, generateTextStreamDetailed } from '../llm/index.js'
import { appendDesignToHtmlSkillPrompt } from './design-to-html-skill.js'
import { appendGenerationTargetPrompt, appTargetContext, isAppGenerationTarget } from './generation-target.js'
import { generateWorkflowText } from './generate-workflow-text.js'
import { readOrCreateImmutableSourceTexts } from './immutable-source-texts.js'
import { readOrCreateNodeStyleFacts, requiredBackgroundFacts, requiredCompactSurfaceFacts, requiredRasterEffectFacts, requiredTypographyFacts } from './node-style-facts.js'
import { runResponsiveRuntimeValidation } from './responsive-runtime-validation.js'
import { createStreamProgressReporter } from './stream-progress.js'
import { DEFAULT_CONNECT_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_LONG_LLM_TIMEOUT_MS } from '../timeouts.js'
import { buildLegacyConstraintCoverage } from '../../../core/src/constraint-service.js'

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
  responsiveRuntimeTestFn = runResponsiveRuntimeValidation,
}) {
  const outputDir = join(jobDir, '05-output')
  const tempDir = join(jobDir, '.05-output-tmp')
  rmSync(tempDir, { recursive: true, force: true })
  mkdirSync(tempDir, { recursive: true })

  const context = buildHtmlGenerationContext(jobDir)
  const system = appendGenerationTargetPrompt(buildHtmlGenerationSystemPrompt(context?.targetPlatform === 'app' ? 'app' : 'web'), 'html', context)
  const basePrompt = buildUserPrompt(jobId, context)
  const promptPath = join(outputDir, 'html-generation.prompt.md')
  const responsePath = join(outputDir, 'html-generation.response.md')
  const validationPath = join(outputDir, 'static-validation.json')
  writeFileSync(join(tempDir, 'html-generation.prompt.md'), `# html-generation Prompt\n\n## System\n\n${system}\n\n## User\n\n${basePrompt}\n`, 'utf8')

  const startedAt = Date.now()
  const reportProgress = createStreamProgressReporter(onProgress)
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
        prompt: basePrompt,
        temperature: Number(process.env.HTML_GENERATION_TEMPERATURE || 0.15),
        maxTokens: Number(process.env.HTML_GENERATION_MAX_TOKENS || 32000),
      },
      timeoutMs,
      connectTimeoutMs,
      firstEventTimeoutMs,
      idleTimeoutMs,
      reportProgress,
      workflowAttempt: 1,
    })
  } catch (error) {
    if (error?.partialText) writeFileSync(join(tempDir, 'html-generation.partial.attempt-1.md'), error.partialText, 'utf8')
    throw error
  }

  writeFileSync(join(tempDir, 'html-generation.response.attempt-1.md'), result.text, 'utf8')
  writeFileSync(join(tempDir, 'html-generation.response.md'), result.text, 'utf8')

  let payload
  try {
    payload = parseGeneratedFiles(result.text)
  } catch (error) {
    if (isLikelyTruncatedJsonError(error, result.text)) {
      throw new Error(`html-generation 输出解析失败：模型输出疑似被截断（${error.message}）。已保留第一轮原始响应，未重新请求模型；请提高 HTML_GENERATION_MAX_TOKENS 或改用更大输出上限的模型后重试。`)
    }
    throw new Error(`html-generation 输出解析失败：${error.message}。已保留第一轮原始响应，未重新请求模型。`)
  }

  const safeFixResult = applySafeStaticFixes(payload, context)
  payload = safeFixResult.files
  const finalValidation = validateGeneratedFiles(payload, context)
  finalValidation.autoFixes = safeFixResult.fixes

  writeGeneratedFiles(tempDir, payload)
  copyAssets(context.assetsDir, join(tempDir, 'assets'))
  // Static validation checks visual fidelity and implementation conventions. A parseable,
  // smoke-testable page is still useful when those checks cannot be fully repaired, so keep
  // the report as warnings instead of blocking publication of the generated HTML.
  await smokeTestFn(tempDir)
  const responsiveRuntime = await responsiveRuntimeTestFn({
    outputDir: tempDir,
    contract: context.pageLayout?.responsiveContract,
  })
  finalValidation.responsiveRuntime = responsiveRuntime
  finalValidation.warnings = [...new Set([
    ...(finalValidation.warnings || []),
    ...(responsiveRuntime?.warnings || []).map((warning) => `响应式运行时检测：${warning}`),
  ])]
  finalValidation.constraintCoverage = buildLegacyConstraintCoverage({
    workflow: context.implementationManifest ? 'plan-and-generate' : 'html',
    target: context?.targetPlatform === 'app' ? 'app' : 'web',
    validationOk: finalValidation.ok,
  })
  writeFileSync(join(tempDir, 'static-validation.json'), JSON.stringify(finalValidation, null, 2), 'utf8')

  publishOutput(tempDir, outputDir)
  const validationWarnings = summarizeStaticValidationWarnings(finalValidation)
  if (!finalValidation.ok) {
    validationWarnings.unshift('第一轮 HTML 已生成，但本地静态校验未通过；已保留第一轮结果，不再重新请求模型。')
  }
  return {
    outputPath: outputDir,
    promptPath,
    responsePath,
    validationPath,
    staticValidation: finalValidation,
    responsiveRuntime,
    validationWarnings,
    streamMode: result.streamMode || (streamingEnabled ? 'stream' : 'non-stream-fallback'),
    durationMs: Date.now() - startedAt,
    tokenUsage: result.usage || emptyUsage(),
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
  const normalized = readJson(join(normalizedDir, 'raw.normalized.json'))
  const interactionStates = normalized.interactionStates?.stateCount > 1 ? normalized.interactionStates : null
  const exportOptions = readJson(join(jobDir, '00-input', 'export-options.json'), {})
  const context = {
    ...appTargetContext(exportOptions),
    ...(interactionStates ? { interactionStates } : {}),
    pageLayout: readJson(join(layoutDir, 'page-layout.json')),
    pageLayoutDescription: readText(join(layoutDir, 'page-layout.md')),
    componentStructurePlan: readText(join(plansDir, 'component-structure.plan.md')),
    staticAssetsPlan: readText(join(plansDir, 'static-assets.plan.md')),
    interactionPlan: readText(join(plansDir, 'interaction.plan.md')),
    assemblyPlan: existsSync(assemblyPath) ? readText(assemblyPath) : '',
    implementationManifest: readJson(join(jobDir, '05-output', 'implementation-manifest.json'), null),
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

export function buildHtmlGenerationSystemPrompt(target = 'web', { workflow = 'html', includeImplementationManifest = false } = {}) {
  return appendDesignToHtmlSkillPrompt([
    '角色：你是单页面 HTML/CSS/JS 代码生成 AI。',
    '只生成可双击运行的原生 index.html、styles.css、script.js，不引入 React、构建工具、CDN、网络资源或输出目录之外的外部字体。允许且必须使用 font-assets.json 中已经落盘到 assets/fonts 的字体文件。按 Header、Main、Section、Footer 等清晰边界组织 React 友好的 DOM 与 BEM class，方便后续转换为 React 组件。',
    '响应式覆盖硬约束：Web 页面必须完整实现 page-layout.json 的 responsiveContract。Header、Nav、Main、Footer 都是必检模块，390/768/1280/1920/2560 五档视口都必须可用；不得只改 Footer 或只让局部内容看似收缩。页面以及任何结构组件均不得发生横向内容溢出或横向滚动，禁止用 overflow-x:hidden/auto/scroll 掩盖固定宽度、固定 left/right 或绝对定位问题。窄屏时结构内容应改为流式宽度、换行、Flex/Grid 重排或纵向堆叠；1920px 等固定宽度只允许用于明确的装饰背景画布，并放在不扩大 Header/Nav/Footer scrollWidth 的裁切层中。',
    'Header/Nav 响应式硬约束：390/768px 下必须选择一种完整方案：A. Logo 与所有导航项在正常文档流中紧凑换行/纵向排列；B. 桌面导航及其 wrapper 整体 display:none，并显示可操作的菜单按钮。禁止只隐藏文字、只移动 nav、或保留桌面 header/nav 的 height、min-height、top、padding、margin 和空占位。Header 高度必须由当前可见内容撑开，Logo 与首个可见导航/菜单控件之间不得出现超过 72px 或 Header 高度 28% 的无内容空白带。',
    'Header/Nav 中间视口硬约束：769/1024/1280/1440/1600 必须逐档检查。桌面 absolute 布局降级时，header inner、Logo、Nav 必须同步切换为同一 Flex 布局系统：inner display:flex，Logo position:static/flex:none，Nav position:static 且 margin-left:auto；禁止仅把 Nav 改为 static。Nav 的 width 必须覆盖全部 item+gap，不得靠父容器裁切溢出；断点必须包含 1280，禁止 max-width:1279px 留出断点空洞。最终必须满足 brand.right < nav.left、nav.right <= inner.right、scrollWidth <= clientWidth + 2。',
    '移动端分段导航硬约束：如果源设计是单一圆角/胶囊外框包裹多个横向选项，且 390px 仍能容纳标签，则移动端必须保留同一横向分段控件；使用一个整体 border + 大圆角、活动项独立胶囊背景、必要的内部短分隔线。禁止把每个选项改成独立矩形边框，禁止仅因进入 480px 断点就纵向堆叠。窄屏视觉密度异常时，优先保持桌面活动面占单个槽位的宽度比例，并依据整体外框资源的实际可见描边边界校准胶囊 top/height/radius；禁止在没有设计证据时同时缩窄和缩矮。具体 top/height/radius 只能来自源设计或外框资产的可见边界证据，不得把任一修复页面的像素值复制成全局常量。按钮继续覆盖完整槽位，胶囊中心必须与当前选中项中心重合，切换时移动同一个视觉面。整体控件使用 role="tablist" 和 data-segmented-control，选项使用 role="tab"，独立活动胶囊添加 data-segmented-active-surface，便于运行时依次点击所有选项并检查中心误差、外框边界、单槽位宽度比例和点击区覆盖。菜单图标按钮可移除静态边框和底色，但必须保留 focus-visible 键盘焦点轮廓。',
    'Footer 响应式硬约束：Footer 外层背景在所有桌面宽度（含大于 1920px）必须覆盖完整视口；普通内容统一放入 margin-inline:auto 的流式/max-width inner 容器。Footer 的 Logo、链接、版权、社交和友情链接必须用 Flex/Grid/正常流组织，禁止直接相对 viewport/footer 外层使用 source left/right 的绝对定位；2560px 下不得出现主体内容聚在一侧、少量链接被甩到远端的断裂孤岛。',
    '响应式级联硬约束：先输出全部基础/source-bounds/data-source/data-text 精确规则，最后输出响应式 @media；或确保断点选择器能明确覆盖它们。断点中必须重置会锁死桌面几何的 position、inset/left/right/top/bottom、width/max-width、height/min-height、transform、white-space。严禁在最后一个移动端 @media 之后再写会把 Header/Nav/Footer 子节点改回 absolute 和桌面 left/top/width 的通用 data-text/data-source 规则。',
    '移动卡片流式排版硬约束：窄屏将标题、摘要改为 relative/static 正常流时，桌面 absolute 的徽标/tag 也必须同步重置为 relative/static，并通过 flex/grid/gap/margin 留出垂直间距；禁止标签悬浮在标题首行之上。',
    '纵向滚动硬约束：页面只允许 html/body 作为纵向滚动根，page-shell/main/content 等结构容器不得设置 overflow-y:auto/scroll 形成第二根滚动条。嵌入式预览若要求隐藏内侧滚动条，只能用 scrollbar-width:none 与 ::-webkit-scrollbar 隐藏页面根滚动条视觉，不能禁用滚轮、触控、键盘滚动或对页面根使用 overflow-y:hidden。absolute/fixed 装饰裁切层若写 overflow-x:hidden，必须同时显式写 overflow-y:hidden/clip，避免 CSS 将另一轴计算为 auto 并产生装饰层滚动条。',
    '高保真布局硬约束：优先还原设计稿桌面基准和源节点 bounds。对 Magic DSL/插件 00-input 中带 absoluteBoundingBox、layoutStyle、section bbox、z-order 的节点，默认使用 page/root 相对定位或局部 relative+absolute 保留尺寸与位置；只有节点事实或三角色计划明确要求 source-flex/flow/grid 时才改用文档流、Flex、Grid。响应式只做保守降级，不得破坏桌面像素还原。页面内容高于视口时必须能正常纵向滚动；html、body 以及应用在 body 上的页面根 class/id 禁止设置 overflow:hidden、overflow:clip、overflow-y:hidden 或 overflow-y:clip。需要裁剪横向装饰时只设置 overflow-x:hidden。',
    '布局防空洞硬约束：page-layout.json 的 backgroundLayers、role=decorative 的大面积背景节点、纯背景矩形和面板只允许作为 absolute 背景层、伪元素或父容器背景使用，默认 affectsFlow=false。不得把这些节点的 height、y 差值或 bounds 差值转换为内容容器 padding-top、margin-top、min-height、height 或列表间距。内容起点、列表间距和模块衔接必须由 contentFlow、非 decorative 文本/控件/卡片/图片 bounds 推导。',
    '背景层绑定硬约束：如果为背景/装饰节点生成独立 DOM（例如模糊圆、背景图、footer 背景矩形），该 DOM 必须添加 data-source-node-id 或 data-style-source-node-id 绑定原 sourceNodeId。背景节点自身可以使用自己的 width/height/left/top；但任何未绑定该 sourceNodeId 的普通内容 class（例如 CTA、正文、footer 内容容器）不得使用背景节点的 height、y 差值或内容 delta 作为 height、min-height、margin-top、padding-top。',
    '结构容器硬约束：header、main、footer 及其 __inner / __content / __body 包裹层的尺寸只能来自 pageLayout 的模块 bounds、contentFlow 或正常文档流，不得再从背景层 bounds 反推。像 `114:68724`、`114:68740`、`114:73525` 这类纯背景节点只负责自身纯色底或绝对装饰层，不能在结构容器上制造额外空白。',
    '纯色背景节点必须使用 `background-color` 或等价纯色背景，不得在其上叠加 `linear-gradient(...)`、`radial-gradient(...)` 或其他可见渐变；如果节点事实给出的是纯白/纯蓝这类单一填充，就保持单色，不要为了层次感自行加过渡。',
    '整体切片边界硬约束：node-style-facts 中 coveredByRenderedSlice 存在的节点只用于解释整体切片内部构成，不得再绑定到外层 section/card，也不得产生独立 background、fill、mask 或布局盒；其视觉已经包含在对应 required-final 切片中。',
    '预渲染切片画布硬约束：croppingPolicy=preserve-rendered-slice 的 PNG/SVG 已经包含 MasterGo 的蒙版、阴影/模糊 bleed、透明区域和最终裁切。存在 renderedLocalBounds 时，必须在 anchorNodeId 坐标容器内按 renderedLocalBounds 的 px left/top/width/height 显示完整导出画布；若 PNG 已被 clipsContent Frame 预裁切，renderedLocalBounds 表示 render bounds 与裁切 Frame 的交集左上角，严禁再按 nominal/source bounds 中心对齐。sourceBounds/localBounds 只表示节点视觉主体，严禁把带 bleed 的整张资源压缩回该主体尺寸。禁止 object-fit:cover、background-size:cover、inset:0 二次裁切，也不得在透明区域下补内部蒙版节点的底色。只有没有预渲染切片、且内容照片 source bounds 超出 Hero 容器或存在负坐标时，才允许 inset:0; width:100%; height:100%; object-fit:cover 并用 object-position 校准。',
    '栅格敏感效果硬约束：asset-index 中 renderPolicy=required-final、format=png，且 sourceNodes.renderReason 标记 LAYER_BLUR、BACKGROUND_BLUR、DROP_SHADOW、INNER_SHADOW 或“栅格敏感效果”的切片，已经包含 MasterGo 的真实效果核、透明度合成和 render-bounds bleed。该 PNG 必须作为对应 sourceNodeId 的唯一可见视觉；禁止再对同一源节点使用 filter:blur、backdrop-filter、box-shadow、radial-gradient/linear-gradient 或伪元素重画，禁止把 PNG 压回 sourceBounds。',
    'Hero/Banner 前景切片硬约束：asset-index 中 positioningPolicy=source-bounds 的标题切片、箭头、图标和前景装饰必须放在 anchorNodeId 对应的 position:relative 坐标容器内，优先使用 renderedLocalBounds，否则使用 localBounds 的 px left/top/width/height 与 position:absolute。禁止用 right、bottom、百分比、vw/vh、Flex/Grid 对齐或自适应缩放近似其位置；Banner 照片发生 cover 裁剪时，前景切片仍以设计稿基准坐标平面居中锚定，不得随视口百分比漂移。',
    '背景装饰固定锚点硬约束：asset-index/page-layout 中 usage=background-decor、background-decor-mask、decorative、role=decorative 的波点、符号、圆形、光晕、公式、蒙版装饰必须作为 page/module 坐标系中的 absolute 装饰节点渲染，使用源 bounds 的 px left/top/width/height 和稳定 z-index。禁止对这些装饰使用 object-fit:cover、background-size:cover、inset:0、width/height:100%、vw/vh/百分比尺寸，禁止在 @media 中改变其相对页面结构的位置；响应式只能裁剪、隐藏或保持原坐标。',
    '最高优先级硬约束：设计稿中出现的所有可见文字必须逐字使用 source-texts.json 的 characters，并在承载该文字的唯一 HTML 元素上添加 data-text-source-node-id="对应 sourceNodeId"。严禁让 AI 总结、改写、概括、纠错、删减、扩写、同义替换、重新断句、调整字符顺序或生成替代文案；标题、正文、标签、导航、按钮、页尾和其他文案均无例外。允许用 HTML 标签承载原有结构，但所有后代文本拼接后必须与 characters 完全一致。',
    'characters 中的换行、连续空格和制表符是设计稿显式排版事实，不是可忽略空白。characters 包含这些保真空白时，承载元素必须同时添加 data-text-preserve-whitespace="true"；CSS 必须提供 [data-text-preserve-whitespace="true"] { white-space: pre-wrap; }，不得将换行替换为空格、折叠连续空格或仅依靠容器自动折行模拟。',
    '单行文字硬约束：node-style-facts 中 singleLineRequired=true 表示设计稿文本框只有一行。即使原字体不可用、fallback 字体字宽更大，也不得让按钮、标签、导航或短标题逐字换行，更不得通过缩小字号/行高规避。承载 data-text-source-node-id 的元素必须显式设置 white-space:nowrap、word-break:keep-all、overflow-wrap:normal，并继续保留源 font-size、line-height 和文本框 bounds。',
    '透明背景约束适用于所有元素，不仅是图片：当节点事实显示 fills 为空、填充透明或该节点仅为透明容器时，生成的对应元素及其容器必须保持 background:transparent，不得自行添加背景色、渐变、背景图片、遮罩或其他产生可见底色的效果。只有资源/节点事实、design-tokens 或三角色计划明确给出非透明填充、毛玻璃或模糊装饰时，才允许设置对应背景；不得为了增强层次、可读性或补全视觉而猜测填充色。',
    '模糊与毛玻璃还原：单一填充且仅含 LAYER_BLUR 的独立 ELLIPSE 光晕优先使用 asset-index 中的 required-final SVG，按完整 viewBox/renderedLocalBounds 显示 filter bleed；毛玻璃、复杂阴影、多效果混合和不可拆分组合才使用 PNG rendered slice。只有没有可用资源时，才允许 CSS filter:blur(...)、backdrop-filter 或半透明渐变降级。',
    '交互状态实现硬约束：必须完整落实 interaction.plan.md，并在当前阶段内部裁决冲突。Web 页面中的导航、按钮、链接、表单/筛选控件、分页，以及被判定为详情入口的岗位/新闻/产品等重复结果卡片，必须具有明确的 hover、focus-visible 和 active/pressed 反馈；不得仅因真实 URL 缺失就删掉计划中的卡片 hover，可使用 data-route-pending 安全占位并阻止虚假跳转。普通静态内容不得添加 pointer cursor 或伪交互。',
    'hover 与动效硬约束：hover 规则优先放在 @media (hover: hover) and (pointer: fine) 中；视觉变化使用颜色、边框、阴影、透明度或不超过 2px 的 transform，transition 通常为 120–240ms ease/ease-out，不得改变布局尺寸、造成文本跳动或遮挡。hover 不得承载关键信息，触屏与键盘必须能完成相同操作；focus-visible 必须清晰，active/pressed 必须有即时反馈。',
    '减少动态效果硬约束：只要 styles.css 使用 transition 或 animation，就必须提供 @media (prefers-reduced-motion: reduce) 降级，关闭或显著缩短非必要运动；不得为了 hover 复制节点、替换不可变文字或引入额外网络资源。',
    'node-style-facts.json 是节点视觉样式的最高优先级事实源。已有 resolvedBackgroundColor、textColor、stroke 或 cornerRadius 时必须逐值使用；design-tokens 只允许复用相同值，不得用文字色、常见网站配色或其他语义 token 替换节点事实。',
    '对 node-style-facts 中 bindingRequired=true 的背景节点：承载该背景的 HTML 元素必须添加 data-style-source-node-id="对应 sourceNodeId"，CSS 必须包含精确的 [data-style-source-node-id="对应 sourceNodeId"] 选择器并设置与 resolvedBackgroundColor 相同的 background-color；背景矩形可以作为父 section/header/footer 的样式来源，无需额外创建空 DOM。',
    '紧凑圆角视觉面硬约束：徽标、chip、状态标签、按钮、分段导航活动项等“小面积但有 SOLID fill + cornerRadius”的非文本节点不可因面积小或被文本覆盖而省略。必须为承载整个圆角面的元素绑定该容器/矩形的 data-style-source-node-id，并逐值实现背景色、描边、圆角和源 bounds；禁止只输出彩色文字、透明空 div、或把文字节点自身的 fill 误当成背景。',
    'Hover 视觉证据硬约束：若 input/interactionStates 没有提供独立 hover 状态，不得凭空新增 border/outline 或改变描边粗细。需要整卡反馈时，应在不重排的 wrapper/伪元素上扩大视觉热区并保留圆角与内容留白，优先使用源色背景、阴影、透明度或不超过 2px 位移；hover 面不得紧贴文字或图片。',
    'asset-index.renderPolicy 是资源最终使用策略：required-final 必须使用 copiedPath 并绑定 sourceNodeId/data-asset-id；wholeNodePng=true 通常表示命中 MasterGo“整体导出/整体显示”命名约束，必须以单个 PNG <img> 按源坐标和源尺寸显示。唯一例外是 decomposable background decoration：名称含背景/bg 与整体导出/整体显示、无文字且由多个独立光晕/波点组成时，导出阶段不会保留 wholeNodePng，代码必须使用底色/渐变 + 独立光晕 SVG + 独立波点/蒙版切片分层，禁止回退到整体背景 PNG。review-only/forbidden-final 只能用于视觉复核；fallback-only 只在风险触发时使用；css-preferred 优先 CSS。普通业务组件、Logo、复杂蒙版卡片仍必须使用整体切片。',
    '静态资源完整性硬约束：asset-index 中 status=present 且 copiedPath 存在的资源必须优先按原位置使用；status=reference-only 的图片、SVG、node-slice 或 renderedAssets 不得编造路径、不得用 CSS 形状或近似图标替代。缺资源时保留透明占位并绑定 data-source-node-id/data-asset-id，同时在静态校验提示中暴露缺口，方便回到插件导出补齐。',
    '图片 src 只能使用 asset-index 的 copiedPath。同一 asset 有多个 rendered slice 时，优先按 sourceNodeId 选择精确切片，再使用 preferred。关键元素按计划添加 data-source-node-id、data-asset-id、data-action。透明图片正常加载时不得有黑色底；图片容器默认背景必须透明，只有 img 触发真实 error 后才允许通过 is-missing 等失败态显示保留原尺寸的纯黑色块。',
    '禁止在 HTML 中手绘 inline SVG/path，也禁止用 CSS clip-path、border 拼形状或任意曲线近似设计图里的矢量。矢量视觉必须来自 asset-index.copiedPath；若输入包没有对应资源，只能保留透明占位并暴露资源缺口。',
    '字体注入硬约束：如果 font-assets.json 中某个字体 status=downloaded，styles.css 顶部必须为其每个 assets/fonts 文件生成 @font-face，font-family、font-weight、font-style、src url 和 format 必须逐项使用 font-assets.json；正文样式优先使用原 font family，并追加 fallbackStack。status=fallback-required 的字体不得编造文件路径，只能使用 fallbackStack。',
    'Banner/大标题排版硬约束：node-style-facts 中 textBindingRequired=true 的可见文字必须使用 typography 的 font-size、font-weight、line-height、水平对齐和源文本框 bounds；不得把相邻标题合并成一个文本节点，不得用 Grid/Flex 自动挤压改变它们的相对位置。若 asset-index 存在 fontFallbackRequired=true 的 fallback-only 切片，必须以该切片作为唯一可见文字视觉并按 source-bounds 定位；原 data-text-source-node-id 元素仍逐字保留，但添加 data-font-fallback-accessible="true" 并用统一 visually-hidden 规则移出视觉布局，防止缺失字体改变字宽后重叠。',
    '效果资源硬约束：node-style-facts.rasterEffect 记录 LAYER_BLUR/BACKGROUND_BLUR/DROP_SHADOW/INNER_SHADOW。assetMode=required-final-svg 时，必须使用对应独立光晕 SVG，按 renderedLocalBounds 的完整透明画布 absolute 定位，并显式设置 flex:none、max-width:none；assetMode=required-final-png 时使用对应 PNG。两者都禁止再叠加 CSS blur、shadow、gradient 或源色块。assetMode=css-fallback 仅表示旧输入包缺少效果资源的降级路径，才按 localBounds 和效果 radius 用 CSS 还原；后续应优先用修复后的插件重新导出 required-final 资源。',
    '分隔线真实性硬约束：不得凭空添加设计稿没有的 <hr>、border-top/border-bottom、inset box-shadow、渐变分隔线或伪元素线条。所有 divider/separator/hairline/rule 都必须通过 data-source-node-id 或 data-style-source-node-id 绑定真实线节点。asset-index 中 renderPolicy=css-preferred 且 sourceNodes.hairlineStyle 存在的真实分割线不得省略，必须逐条渲染；对应 SVG 只供复核，禁止作为 <img> 或 background-image 进入最终页面。必须使用 hairlineStyle.color、cssThickness、cssOpacity，以及源 localBounds/renderedLocalBounds 的长度和位置生成 CSS 线。例如源 #D0D8E5、0.4px 线应渲染为 1px、#D0D8E5、opacity:0.4 的浅灰线，绝不能升级成不透明 1px 黑/深灰线，也不能完全删除。',
    '跨模块层级硬约束：page-layout.json 的 stackingFacts 是设计稿绘制顺序事实。每条关系的 lowerSourceNodeId 与 upperSourceNodeId 对应模块都必须建立独立 stacking context（position 非 static、isolation:isolate、数值 z-index），且 upper 的 z-index 必须严格大于 lower。Hero/Banner 与白色内容面板重叠时，Banner 背景和人物图不得覆盖面板的白底、圆角或面板内容。',
    '主 CTA 必须使用 button；未知链接不得使用 alert，采用页面内锚点或非阻塞的页面内提示。',
    '文件引用硬约束：index.html 必须在 head 中引用本地样式 `<link rel="stylesheet" href="styles.css">`，并在 body 结束前引用本地脚本 `<script src="script.js"></script>`；不得内联完整 CSS/JS 后省略这两个本地文件引用。',
    includeImplementationManifest
      ? '输出必须是 JSON 对象，键仅为 implementationManifest、index.html、styles.css、script.js。implementationManifest 只记录实际冲突、交互布尔值、source-bounds 策略和未决风险；不得输出逐模块规划、推理过程、Markdown、解释文字或额外键。'
      : '输出必须是 JSON 对象，键仅为 index.html、styles.css、script.js，值为完整代码字符串；不要 Markdown、解释文字或额外键。',
  ], workflow, { target }).join('\n')
}

function buildUserPrompt(jobId, context) {
  return [
    `jobId: ${jobId}`,
    ...(isAppGenerationTarget(context) ? ['generationTarget: app（移动 App 页面 HTML 预览）'] : []),
    ...(context.interactionStates ? [
      `interactionStates（同一页面多状态，禁止并排或拆成多个 HTML）：${JSON.stringify(context.interactionStates)}`,
    ] : []),
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

export function applySafeStaticFixes(files, context = {}) {
  const next = {
    indexHtml: String(files?.indexHtml || ''),
    stylesCss: String(files?.stylesCss || ''),
    scriptJs: String(files?.scriptJs || ''),
  }
  const fixes = []
  const contract = context.pageLayout?.responsiveContract
  if (contract?.enabled !== false && !/<meta\b[^>]*\bname=["']viewport["'][^>]*>/i.test(next.indexHtml)) {
    const viewportMeta = '<meta name="viewport" content="width=device-width, initial-scale=1">'
    if (/<head\b[^>]*>/i.test(next.indexHtml)) {
      next.indexHtml = next.indexHtml.replace(/<head\b[^>]*>/i, (head) => `${head}\n  ${viewportMeta}`)
      fixes.push({
        code: 'add-responsive-viewport-meta',
        file: 'index.html',
        description: '补充 width=device-width 的 viewport meta。',
      })
    }
  }
  return { files: next, fixes }
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
  validateResponsiveContract(html, css, context.pageLayout?.responsiveContract, warnings)
  validateAppPageOutput(html, css, context, errors, warnings)
  validateCssPerformanceBudget(css, errors, warnings)
  validateInteractionFeedback(html, css, context, warnings)
  validateLayoutSpacing(html, css, context, errors, warnings)
  validateSourceTexts(html, css, context.sourceTexts, errors)
  validateRequiredNodeStyles(html, css, context.nodeStyleFacts, errors)
  validateRequiredCompactSurfaces(html, css, context.nodeStyleFacts, errors)
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
  validateCssPreferredHairlines(html, css, context.assetIndex, errors)
  validateSeparatorFidelity(html, context.assetIndex, context.nodeStyleFacts, errors)
  validateRequiredRenderedAssets(html, css, context.pageLayout, context.assetIndex, errors)
  validateMaskedCompositeChildAssets(html, css, context.assetIndex, errors)
  validateRasterEffectAssets(html, css, context.assetIndex, errors)
  validateRasterEffectFallbacks(html, css, context.nodeStyleFacts, errors)
  validateDecorativeAssetAnchoring(html, css, context.assetIndex, errors)
  validateSourceBoundsAssets(html, css, context.assetIndex, errors)
  validateDecorativeSvgCanvasIntegrity(html, css, context.assetIndex, errors)
  validateFontFallbackAssets(html, css, context.assetIndex, errors)
  validateModuleStacking(html, css, context.pageLayout, errors)
  validateFontAssets(css, context.fontAssets, errors)
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], checkedAt: new Date().toISOString() }
}

function validateInteractionFeedback(html, css, context, warnings) {
  if (isAppGenerationTarget(context)) return
  const source = stripCssComments(css)
  const interactiveCount = (String(html).match(/<(?:a|button|select|textarea)\b|<input\b(?![^>]*\btype=["']hidden["'])|\brole=["'](?:button|link|menuitem|checkbox|radio|tab)["']/gi) || []).length
  const hoverCount = (source.match(/:hover\b/gi) || []).length
  const hasTransition = /\btransition(?:-property|-duration|-timing-function|-delay)?\s*:/i.test(source)
  const hasAnimation = /\banimation(?:-name|-duration|-timing-function|-delay|-iteration-count|-direction|-fill-mode|-play-state)?\s*:/i.test(source)
  const assemblyPlan = String(context?.assemblyPlan || '')
  const manifestHoverRequirement = context?.implementationManifest?.hoverRequired
  const manifestMotionRequirement = context?.implementationManifest?.motionRequired
  const explicitHoverRequirement = assemblyPlan.match(/\bhoverRequired\s*:\s*(true|false)\b/i)?.[1]?.toLowerCase()
  const explicitMotionRequirement = assemblyPlan.match(/\bmotionRequired\s*:\s*(true|false)\b/i)?.[1]?.toLowerCase()
  const planRequiresHover = typeof manifestHoverRequirement === 'boolean'
    ? manifestHoverRequirement
    : explicitHoverRequirement
      ? explicitHoverRequirement === 'true'
      : /(?:hover\s*(?:必须实现|required)|(?:必须|需要|应当|补齐)(?:保留|实现|具有|提供|补齐)?[^\n]{0,40}hover|hover[^\n]{0,24}(?:必须实现|不得删除|不能取消|需要补齐))/i.test(assemblyPlan)
  const planRequiresMotion = typeof manifestMotionRequirement === 'boolean'
    ? manifestMotionRequirement
    : explicitMotionRequirement
      ? explicitMotionRequirement === 'true'
      : planRequiresHover

  if ((interactiveCount >= 2 || planRequiresHover) && hoverCount === 0) {
    warnings.push('交互反馈缺失：页面包含多个可操作元素或组装计划要求 hover，但 styles.css 未检测到 :hover 规则')
  }
  if (planRequiresMotion && !hasTransition && !hasAnimation) {
    warnings.push('交互动效缺失：实施清单要求动效，但 styles.css 未检测到 transition 或 animation')
  }
  if (hoverCount > 0 && !/@media\s*\([^)]*hover\s*:\s*hover[^)]*\)/i.test(source)) {
    warnings.push('hover 适配提示：建议将非关键 hover 动效限制在 @media (hover: hover) and (pointer: fine) 中')
  }
  if (!context?.interactionStates && hasUnevidencedHoverBorder(source)) {
    warnings.push('Hover 视觉越界：未提供独立 hover 状态证据时不得新增 border/outline 或改变描边；请改用不重排的背景、阴影、透明度或轻微位移')
  }
  if ((hasTransition || hasAnimation) && !/@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce[^)]*\)/i.test(source)) {
    warnings.push('减少动态效果缺失：检测到 transition/animation，但未提供 prefers-reduced-motion: reduce 降级')
  }
}

function hasUnevidencedHoverBorder(css) {
  for (const match of String(css || '').matchAll(/([^{}]*:hover[^{}]*)\{([^{}]*)\}/gi)) {
    if (/(?:^|;)\s*(?:border(?:-(?:top|right|bottom|left))?(?:-(?:width|style|color))?|outline(?:-(?:width|style|color|offset))?)\s*:/i.test(match[2])) return true
  }
  return false
}

function validateResponsiveContract(html, css, contract, warnings) {
  if (!contract || contract.enabled === false) return
  const modulePatterns = {
    header: /<(?:header)\b|\brole=["']banner["']|\bclass=["'][^"']*\b(?:site-|page-)?header\b/i,
    nav: /<(?:nav)\b|\brole=["']navigation["']|\bclass=["'][^"']*\b(?:primary-|site-|page-)?nav(?:igation)?\b/i,
    main: /<(?:main)\b|\brole=["']main["']|\bclass=["'][^"']*\b(?:page-|site-)?main\b/i,
    footer: /<(?:footer)\b|\brole=["']contentinfo["']|\bclass=["'][^"']*\b(?:site-|page-)?footer\b/i,
  }
  for (const module of contract.requiredModules || []) {
    if (module?.required === false) continue
    const role = String(module?.role || '')
    const pattern = modulePatterns[role]
    if (pattern && !pattern.test(html)) warnings.push(`响应式契约缺少必检模块：${role}`)
  }
  if (!/<meta\b[^>]*\bname=["']viewport["'][^>]*\bcontent=["'][^"']*width\s*=\s*device-width/i.test(html)) {
    warnings.push('响应式页面缺少 width=device-width 的 viewport meta，且无法执行安全自动修复')
  }
  const horizontalScrollDeclarations = [...String(css).matchAll(/\boverflow-x\s*:\s*(auto|scroll)\b/gi)]
  if (horizontalScrollDeclarations.length > 0) {
    warnings.push(`响应式契约禁止组件横向滚动，但 CSS 中存在 ${horizontalScrollDeclarations.length} 处 overflow-x:auto/scroll`)
  }
  const genericScrollDeclarations = [...String(css).matchAll(/(?:^|[;{])\s*overflow\s*:\s*(auto|scroll)(?:\s+[^;}]*)?[;}]/gi)]
  if (genericScrollDeclarations.length > 0) {
    warnings.push(`响应式契约禁止组件横向滚动，但 CSS 中存在 ${genericScrollDeclarations.length} 处可能产生横向滚动的 overflow:auto/scroll`)
  }

  const nestedVerticalScrollRules = extractCssRules(css).filter((rule) =>
    /(?:^|[.#])(?:page-shell|site-main|page-main|content-shell|app-shell)\b|(?:^|,)\s*main\b/i.test(rule.selector)
    && /\boverflow-y\s*:\s*(?:auto|scroll)\b/i.test(rule.declarations))
  if (nestedVerticalScrollRules.length > 0) {
    warnings.push(`响应式页面出现嵌套纵向滚动容器：${nestedVerticalScrollRules.map((rule) => rule.selector).join('、')}；页面应只保留 html/body 一个纵向滚动根`)
  }

  const implicitDecorativeVerticalScrollRules = extractCssRules(css).filter((rule) =>
    isDecorativeLayerRule(rule)
    && /\boverflow-x\s*:\s*hidden\b/i.test(rule.declarations)
    && !/\boverflow-y\s*:/i.test(rule.declarations)
    && !/(?:^|;)\s*overflow\s*:/i.test(rule.declarations))
  if (implicitDecorativeVerticalScrollRules.length > 0) {
    warnings.push(`装饰裁切层可能产生隐式纵向滚动条：${implicitDecorativeVerticalScrollRules.map((rule) => rule.selector).join('、')}；overflow-x:hidden 会让未显式设置的另一轴计算为 auto，请补充 overflow-y:hidden/clip`)
  }

  const mediaBlocks = extractCssAtRuleBlocks(css, 'media')
  const narrowMaxWidth = Number(contract?.layoutIntegrity?.narrowMaxWidth || 768)
  const narrowViewportWidths = [...new Set((contract?.viewports || [])
    .map((viewport) => Math.round(Number(viewport?.width)))
    .filter((width) => width > 0 && width <= narrowMaxWidth))]
  const requiredNarrowWidths = narrowViewportWidths.length > 0 ? narrowViewportWidths : [390, 768]
  const allNarrowBlocks = []
  for (const width of requiredNarrowWidths) {
    const viewportBlocks = mediaBlocks.filter((block) => mediaConditionAppliesAtWidth(block.prelude, width))
    allNarrowBlocks.push(...viewportBlocks)
    if (viewportBlocks.length === 0) {
      warnings.push(`未检测到覆盖 ${width}px 的窄屏媒体查询，Header/Nav/Footer 可能仍沿用桌面几何`)
      continue
    }
    for (const role of ['header', 'nav', 'footer']) {
      if (!viewportBlocks.some((block) => mediaBlockHasStructuralOverride(block.body, role))) {
        warnings.push(`${width}px 窄屏媒体查询未检测到 ${role} 的结构重排或几何重置`)
      }
    }
  }
  if (allNarrowBlocks.length > 0) {
    const trailingCss = String(css).slice(Math.max(...allNarrowBlocks.map((block) => block.end)))
    if (hasTrailingSourceGeometryRules(trailingCss)) {
      warnings.push('最后一个窄屏 @media 之后仍存在 data-text/data-source 的绝对定位或固定几何规则，可能反向覆盖 Header/Nav/Footer 响应式')
    }
  }

  const baseWidth = Number(contract?.baseViewport?.width)
  const fixedDesktopShell = /(?:\.page-canvas|\bheader\b|\bfooter\b|[.#][\w-]*(?:header|footer)[\w-]*)\s*\{[^{}]*\bwidth\s*:\s*(?:1920|1440|1366|1280)px\b/is.test(stripCssComments(css))
  const wideThreshold = Number(contract?.layoutIntegrity?.wideShell?.minViewportWidth || (Number.isFinite(baseWidth) ? Math.round(baseWidth + 1) : 1921))
  const hasWideShellRule = mediaBlocks.some((block) => mediaConditionAppliesAtWidth(block.prelude, wideThreshold))
  if (fixedDesktopShell && !hasWideShellRule) {
    warnings.push(`检测到固定桌面画布，但缺少 >=${wideThreshold}px 的超宽屏 Header/Footer 全宽与居中 inner 规则`)
  }
}

const RESPONSIVE_STRUCTURAL_PROPERTY_RE = /\b(?:display|position|inset|left|right|top|bottom|width|max-width|min-width|height|min-height|flex|flex-direction|flex-wrap|grid|grid-template-columns|justify-content|align-items|gap|padding|margin|white-space|transform)\s*:/i

function extractCssAtRuleBlocks(css, atRuleName) {
  const source = String(css || '')
  const blocks = []
  const pattern = new RegExp(`@${escapeRegExp(atRuleName)}\\s*([^\\{]*)\\{`, 'gi')
  let match
  while ((match = pattern.exec(source))) {
    const open = source.indexOf('{', match.index)
    if (open < 0) break
    const close = findMatchingCssBrace(source, open)
    if (close < 0) break
    blocks.push({
      prelude: String(match[1] || '').trim(),
      body: source.slice(open + 1, close),
      start: match.index,
      end: close + 1,
    })
    pattern.lastIndex = close + 1
  }
  return blocks
}

function findMatchingCssBrace(source, openIndex) {
  let depth = 0
  let quote = ''
  let comment = false
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (comment) {
      if (char === '*' && next === '/') { comment = false; index += 1 }
      continue
    }
    if (!quote && char === '/' && next === '*') { comment = true; index += 1; continue }
    if (quote) {
      if (char === '\\') { index += 1; continue }
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function mediaConditionAppliesAtWidth(condition, viewportWidth) {
  const text = String(condition || '').toLowerCase()
  const target = Number(viewportWidth)
  if (!Number.isFinite(target)) return false
  const lowerBounds = [
    ...[...text.matchAll(/min-width\s*:\s*([\d.]+)px/g)].map((match) => Number(match[1])),
    ...[...text.matchAll(/width\s*>=\s*([\d.]+)px/g)].map((match) => Number(match[1])),
    ...[...text.matchAll(/([\d.]+)px\s*<=\s*width/g)].map((match) => Number(match[1])),
  ].filter(Number.isFinite)
  const upperBounds = [
    ...[...text.matchAll(/max-width\s*:\s*([\d.]+)px/g)].map((match) => Number(match[1])),
    ...[...text.matchAll(/width\s*<=\s*([\d.]+)px/g)].map((match) => Number(match[1])),
    ...[...text.matchAll(/width\s*<\s*([\d.]+)px/g)].map((match) => Number(match[1]) - 0.01),
    ...[...text.matchAll(/([\d.]+)px\s*>=\s*width/g)].map((match) => Number(match[1])),
  ].filter(Number.isFinite)
  if (lowerBounds.length === 0 && upperBounds.length === 0) return false
  const minimum = lowerBounds.length > 0 ? Math.max(...lowerBounds) : Number.NEGATIVE_INFINITY
  const maximum = upperBounds.length > 0 ? Math.min(...upperBounds) : Number.POSITIVE_INFINITY
  return target >= minimum && target <= maximum
}

function mediaBlockHasStructuralOverride(body, role) {
  const selectorPatterns = {
    header: /(?:^|[\s>+~,.#_-])(?:site-|page-)?header(?:\b|__|[-_])|\bheader\b/i,
    nav: /(?:^|[\s>+~,.#_-])(?:primary-|site-|page-)?nav(?:igation)?(?:\b|__|[-_])|\bnav\b/i,
    footer: /(?:^|[\s>+~,.#_-])(?:site-|page-)?footer(?:\b|__|[-_])|\bfooter\b/i,
  }
  const pattern = selectorPatterns[role]
  return extractCssRules(body).some((rule) => pattern.test(rule.selector) && RESPONSIVE_STRUCTURAL_PROPERTY_RE.test(rule.declarations))
}

function hasTrailingSourceGeometryRules(css) {
  for (const rule of extractCssRules(css)) {
    if (!/\[data-(?:text-source-node-id|source-node-id|style-source-node-id)/i.test(rule.selector)) continue
    if (/\bposition\s*:\s*absolute\b/i.test(rule.declarations)) return true
    if (/\b(?:left|right|top|bottom|width|height|min-height)\s*:\s*-?[\d.]+px\b/i.test(rule.declarations)) return true
  }
  return false
}

function validateAppPageOutput(html, css, context, errors, warnings) {
  if (!isAppGenerationTarget(context)) return

  const viewportMeta = html.match(/<meta\b[^>]*\bname=["']viewport["'][^>]*>/i)?.[0] || ''
  if (!viewportMeta || !/width\s*=\s*device-width/i.test(viewportMeta)) {
    errors.push('App 页面缺少 width=device-width 的 viewport meta')
  }
  const disablesZoom = /user-scalable\s*=\s*no/i.test(viewportMeta)
    || /maximum-scale\s*=\s*1(?:\.0+)?(?=\s*(?:[,;"']|>))/i.test(viewportMeta)
  if (disablesZoom) {
    errors.push('App 页面不得禁止用户缩放')
  }
  if (/\bheight\s*:\s*100vh\b/i.test(css) && !/\b(?:height|min-height)\s*:\s*100dvh\b/i.test(css)) {
    warnings.push('App 页面使用了 100vh，但没有提供 100dvh 以适配移动浏览器动态视口')
  }
}

export function summarizeStaticValidationWarnings(validation = {}) {
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

function validateCssPreferredHairlines(html, css, assetIndex = {}, errors) {
  const combined = `${html}
${css}`
  const rules = extractCssRules(css)
  const variables = collectCssVariables(css)
  for (const asset of assetIndex.assets || []) {
    if (!isCssPreferredHairlineAsset(asset)) continue
    const paths = [asset.preferred?.copiedPath, ...(asset.rendered || []).map((item) => item.path)].filter(Boolean)
    for (const path of paths) {
      if (!combined.includes(path)) continue
      errors.push(`超细分隔线不得通过 SVG/图片渲染，必须使用源节点绑定的 CSS hairline：${asset.assetId} -> ${path}`)
    }

    for (const source of asset.sourceNodes || []) {
      if (!isCssPreferredHairlineSource(source)) continue
      const sourceNodeId = String(source?.sourceNodeId || '')
      if (!sourceNodeId) continue
      const style = source?.hairlineStyle
      const boundTags = findAllTagsBySourceNodeId(html, sourceNodeId)
      if (boundTags.length === 0) {
        errors.push(`设计稿真实分隔线不得省略：${asset.assetId} -> ${sourceNodeId}`)
        continue
      }
      if (boundTags.length > 1) {
        errors.push(`设计稿分隔线不得重复渲染：${asset.assetId} -> ${sourceNodeId}（${boundTags.length} 个绑定元素）`)
      }
      if (!style) continue

      const bound = boundTags[0]
      const declarations = collectElementDeclarations(bound.tag, rules, variables)
      const label = `分隔线 ${sourceNodeId}`
      if (['img', 'svg', 'canvas'].includes(String(bound.tagName || '').toLowerCase())) {
        errors.push(`${label} 必须使用 CSS 实色元素渲染，不得使用图片或画布`)
      }
      if (String(declarations.get('display') || '').trim().toLowerCase() === 'none'
        || String(declarations.get('visibility') || '').trim().toLowerCase() === 'hidden') {
        errors.push(`${label} 不得隐藏或省略`)
      }
      if (String(declarations.get('position') || '').trim().toLowerCase() !== 'absolute') {
        errors.push(`${label} 必须按源坐标 absolute 定位`)
      }

      const localBounds = source.localBounds || source.renderLocalBounds
      const orientation = String(style.orientation || '').toLowerCase()
      const cssThickness = Number(style.cssThickness)
      if (localBounds) {
        validateExactPixelDeclaration(declarations, 'left', localBounds.x, `${label} 横坐标`, errors)
        validateExactPixelDeclaration(declarations, 'top', localBounds.y, `${label} 纵坐标`, errors)
        if (orientation === 'vertical') {
          validateHairlinePixelDeclaration(declarations, 'width', cssThickness, `${label} 视觉厚度`, errors)
          validateExactPixelDeclaration(declarations, 'height', localBounds.height, `${label} 长度`, errors)
        } else {
          validateExactPixelDeclaration(declarations, 'width', localBounds.width, `${label} 长度`, errors)
          validateHairlinePixelDeclaration(declarations, 'height', cssThickness, `${label} 视觉厚度`, errors)
        }
        validateCoordinateAnchor(html, bound, source.anchorNodeId, rules, variables, label, errors)
      }

      validateHairlineColor(declarations, style, label, errors)
      validateHairlineDoesNotUseBorderOrEffects(declarations, label, errors)
    }
  }
}

function validateHairlineColor(declarations, style, label, errors) {
  const rawColor = declarations.get('background-color')
  const actualColor = parseCssColor(extractCssColor(rawColor))
  const expectedColor = parseCssColor(extractCssColor(style?.color))
  if (!rawColor || !actualColor || !expectedColor) {
    errors.push(`${label} 必须使用 background-color:${style?.color || '源颜色'} 渲染浅灰实线`)
    return
  }
  if (!actualColor.slice(0, 3).every((value, index) => Math.abs(value - expectedColor[index]) < 0.002)) {
    errors.push(`${label} 颜色错误：应为 ${style.color}，实际为 ${rawColor}`)
  }

  const rawOpacity = declarations.get('opacity')
  const elementOpacity = rawOpacity === undefined ? 1 : parseCssNumber(rawOpacity)
  const effectiveAlpha = actualColor[3] * elementOpacity
  const expectedAlpha = Number(style?.cssOpacity)
  if (!Number.isFinite(elementOpacity) || !Number.isFinite(expectedAlpha)
    || Math.abs(effectiveAlpha - expectedAlpha) > 0.02) {
    errors.push(`${label} 透明度错误：有效 opacity 应为 ${roundNumber(expectedAlpha)}，实际为 ${Number.isFinite(effectiveAlpha) ? roundNumber(effectiveAlpha) : rawOpacity || 'missing'}`)
  }
}

function validateHairlinePixelDeclaration(declarations, property, expected, label, errors) {
  const expectedNumber = Number(expected)
  if (!Number.isFinite(expectedNumber)) return
  const actualValue = declarations.get(property)
  const actualNumber = parsePixelValue(actualValue)
  if (!Number.isFinite(actualNumber) || Math.abs(actualNumber - expectedNumber) > 0.05) {
    errors.push(`${label}必须为 ${roundNumber(expectedNumber)}px，实际为 ${actualValue || 'missing'}`)
  }
}

function validateHairlineDoesNotUseBorderOrEffects(declarations, label, errors) {
  for (const property of ['border', 'border-top', 'border-right', 'border-bottom', 'border-left']) {
    const value = String(declarations.get(property) || '').trim()
    if (value && !/^(?:0(?:px)?|none)$/i.test(value)) {
      errors.push(`${label} 不得使用 ${property} 叠加或替代源浅灰线：${value}`)
    }
  }
  const boxShadow = String(declarations.get('box-shadow') || '').trim()
  if (boxShadow && !/^none$/i.test(boxShadow)) errors.push(`${label} 不得使用 box-shadow 加重分隔线：${boxShadow}`)
  const backgroundImage = String(declarations.get('background-image') || '').trim()
  if (backgroundImage && !/^none$/i.test(backgroundImage)) errors.push(`${label} 不得使用渐变或图片重画分隔线：${backgroundImage}`)
}

function validateSeparatorFidelity(html, assetIndex = {}, nodeStyleFacts = {}, errors) {
  const lineSourceNodeIds = collectLineSourceNodeIds(assetIndex, nodeStyleFacts)
  for (const match of String(html || '').matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)) {
    const tag = match[0]
    const tagName = String(match[1] || '').toLowerCase()
    const classNames = String(extractAttributeValue(tag, 'class') || '').split(/\s+/).filter(Boolean)
    if (tagName !== 'hr' && !classNames.some(isSeparatorClassName)) continue
    const sourceNodeId = extractAttributeValue(tag, 'data-source-node-id')
      || extractAttributeValue(tag, 'data-style-source-node-id')
    const label = tagName === 'hr' ? '<hr>' : `分隔线 class=${classNames.filter(isSeparatorClassName).join(',')}`
    if (!sourceNodeId) {
      errors.push(`${label} 缺少真实线节点绑定；禁止凭空添加分隔线`)
      continue
    }
    if (lineSourceNodeIds.size > 0 && !lineSourceNodeIds.has(String(sourceNodeId))) {
      errors.push(`${label} 绑定的不是已知线节点：${sourceNodeId}`)
    }
  }
}

function validateRasterEffectAssets(html, css, assetIndex = {}, errors) {
  const rules = extractCssRules(css)
  const variables = collectCssVariables(css)
  for (const asset of assetIndex.assets || []) {
    if (!isRasterEffectAsset(asset)) continue
    const copiedPath = asset.preferred?.copiedPath
    const sourceNodeIds = (asset.sourceNodes || []).map((source) => String(source.sourceNodeId || '')).filter(Boolean)
    const tag = copiedPath ? findBoundImageTag(html, asset, copiedPath) : null
    if (!copiedPath || !tag) {
      errors.push(`栅格敏感效果必须使用 MasterGo PNG 切片：${asset.assetId} -> ${copiedPath || 'missing copiedPath'}`)
      continue
    }
    const boundSourceNodeId = extractAttributeValue(tag.tag, 'data-source-node-id')
      || extractAttributeValue(tag.tag, 'data-style-source-node-id')
    if (sourceNodeIds.length > 0 && !sourceNodeIds.includes(String(boundSourceNodeId || ''))) {
      errors.push(`栅格敏感效果 PNG 缺少对应 sourceNodeId 绑定：${asset.assetId} -> ${sourceNodeIds.join(',')}`)
    }
    for (const sourceNodeId of sourceNodeIds) {
      for (const bound of findAllTagsBySourceNodeId(html, sourceNodeId)) {
        const declarations = collectElementDeclarations(bound.tag, rules, variables)
        if (hasRasterEffectRedraw(declarations)) {
          errors.push(`栅格敏感效果不得对同一源节点再次用 CSS 模糊/阴影/渐变重画：${asset.assetId} -> ${sourceNodeId}`)
          break
        }
      }
    }
  }
}

function isCssPreferredHairlineAsset(asset) {
  if (asset?.renderPolicy !== 'css-preferred') return false
  return (asset.sourceNodes || []).some(isCssPreferredHairlineSource)
}

function isCssPreferredHairlineSource(source) {
  if (source?.hairlineStyle) return true
  if (/hairline|超细分隔线|0\.xpx SVG/i.test(String(source?.renderReason || ''))) return true
  return isHairlineGeometry(source?.bounds || source?.localBounds, source?.nodeType)
}

function isRasterEffectAsset(asset) {
  if (asset?.renderPolicy !== 'required-final' || String(asset?.format || '').toLowerCase() !== 'png') return false
  return (asset.sourceNodes || []).some((source) => /栅格敏感效果|LAYER_BLUR|BACKGROUND_BLUR|DROP_SHADOW|INNER_SHADOW/i.test(String(source?.renderReason || '')))
}

function collectLineSourceNodeIds(assetIndex = {}, nodeStyleFacts = {}) {
  const ids = new Set()
  for (const asset of assetIndex.assets || []) {
    for (const source of asset.sourceNodes || []) {
      if (isCssPreferredHairlineAsset(asset) || isHairlineGeometry(source?.bounds || source?.localBounds, source?.nodeType)) {
        if (source?.sourceNodeId) ids.add(String(source.sourceNodeId))
      }
    }
  }
  for (const fact of nodeStyleFacts.facts || []) {
    if (!isHairlineGeometry(fact?.bounds || fact?.localBounds, fact?.type)) continue
    if (fact?.sourceNodeId) ids.add(String(fact.sourceNodeId))
  }
  return ids
}

function isHairlineGeometry(bounds, nodeType) {
  const width = Math.abs(Number(bounds?.width))
  const height = Math.abs(Number(bounds?.height))
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false
  const longSide = Math.max(width, height)
  const shortSide = Math.min(width, height)
  const vectorLike = /^(?:LINE|PEN|VECTOR|BOOLEAN_OPERATION|BOOLEANOPERATION)$/i.test(String(nodeType || ''))
  return vectorLike && longSide >= 4 && shortSide <= 1
}

function isSeparatorClassName(className) {
  return /(?:divider|separator|hairline)/i.test(String(className || ''))
    || /(?:^|[-_])rule(?:$|[-_])/i.test(String(className || ''))
}

function findAllTagsBySourceNodeId(html, sourceNodeId) {
  const results = []
  for (const match of String(html || '').matchAll(/<([a-z][\w:-]*)\b[^>]*>/gi)) {
    const source = extractAttributeValue(match[0], 'data-source-node-id')
      || extractAttributeValue(match[0], 'data-style-source-node-id')
    if (String(source || '') !== String(sourceNodeId)) continue
    results.push({ tag: match[0], tagName: match[1], index: match.index })
  }
  return results
}

function hasRasterEffectRedraw(declarations) {
  const filter = String(declarations.get('filter') || '')
  const backdropFilter = String(declarations.get('backdrop-filter') || declarations.get('-webkit-backdrop-filter') || '')
  const boxShadow = String(declarations.get('box-shadow') || '')
  const background = `${declarations.get('background') || ''} ${declarations.get('background-image') || ''}`
  return /blur\s*\(/i.test(filter)
    || /blur\s*\(/i.test(backdropFilter)
    || (boxShadow.trim() && !/^none$/i.test(boxShadow.trim()))
    || /(?:radial|linear|conic)-gradient\s*\(/i.test(background)
}

function validateRequiredRenderedAssets(html, css, pageLayout = {}, assetIndex = {}, errors) {
  const requiredAssetIds = new Set((pageLayout.modules || []).flatMap((module) => Array.isArray(module.assetIds) ? module.assetIds : []))
  const hasUnplannedRequiredComposite = (assetIndex.assets || []).some((asset) => asset.wholeNodePng || isRequiredMaskedCompositeAsset(asset))
  if (requiredAssetIds.size === 0 && !hasUnplannedRequiredComposite) return
  const combined = `${html}\n${css}`
  for (const asset of assetIndex.assets || []) {
    const mustValidateWithoutPagePlan = asset.wholeNodePng || isRequiredMaskedCompositeAsset(asset)
    if (!requiredAssetIds.has(asset.assetId) && !mustValidateWithoutPagePlan) continue
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

function validateMaskedCompositeChildAssets(html, css, assetIndex = {}, errors) {
  const requiredCompositeIds = new Set((assetIndex.assets || [])
    .filter((asset) => isRequiredMaskedCompositeAsset(asset) && asset.preferred?.copiedPath)
    .flatMap((asset) => asset.sourceNodes || [])
    .map((source) => String(source.sourceNodeId || ''))
    .filter(Boolean))
  if (requiredCompositeIds.size === 0) return

  const combined = `${html}
${css}`
  for (const asset of assetIndex.assets || []) {
    const coveredSources = (asset.sourceNodes || []).filter((source) =>
      source.insideForcedRenderedSlice
      && (source.ancestorNodeIds || []).some((ancestorId) => requiredCompositeIds.has(String(ancestorId))))
    if (coveredSources.length === 0) continue

    const paths = [asset.preferred?.copiedPath, ...(asset.rendered || []).map((item) => item.path)].filter(Boolean)
    const used = paths.some((path) => combined.includes(path))
      || new RegExp(`\\bdata-asset-id=["']${escapeRegExp(asset.assetId)}["']`, 'i').test(html)
    if (!used) continue
    const sourceIds = coveredSources.map((source) => source.sourceNodeId).filter(Boolean).join('、')
    errors.push(`蒙版整体切片的内部子资源不得单独显示：${asset.assetId}${sourceIds ? ` -> ${sourceIds}` : ''}`)
  }
}

function isRequiredMaskedCompositeAsset(asset) {
  const usage = asset?.usage || asset?.usageHint
  return asset?.renderPolicy === 'required-final'
    && asset?.mustUseRenderedSlice
    && (usage === 'masked-composite' || asset?.usageHint === 'masked-composite')
}

function isRequiredFinalRenderedAsset(asset) {
  if (asset?.renderPolicy) return asset.renderPolicy === 'required-final'
  if (!asset?.mustUseRenderedSlice) return false
  const usage = asset.usage || asset.usageHint
  return ['logo', 'icon', 'masked-composite', 'background-decor-mask'].includes(usage)
    || ['logo', 'icon', 'masked-composite', 'background-decor-mask'].includes(asset.usageHint)
}

function requiresHtmlAssetBinding(asset) {
  if (asset?.wholeNodePng) return true
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


function validateRasterEffectFallbacks(html, css, nodeStyleFacts = {}, errors) {
  const rules = extractCssRules(css)
  const variables = collectCssVariables(css)
  for (const fact of requiredRasterEffectFacts(nodeStyleFacts)) {
    const rasterEffect = fact.rasterEffect || {}
    if (/^required-final-(?:png|svg)$/.test(String(rasterEffect.assetMode || '')) && rasterEffect.assetAvailable) continue
    const sourceNodeId = String(fact.sourceNodeId || '')
    const label = `栅格敏感效果 CSS 降级节点 ${sourceNodeId}`
    const bound = findTagBySourceNodeId(html, sourceNodeId)
    if (!bound) {
      errors.push(`${label} 不得省略；旧输入缺少 PNG 时仍须保留源节点绑定，并提示重新导出 required-final PNG`)
      continue
    }

    const declarations = collectElementDeclarations(bound.tag, rules, variables)
    const display = String(declarations.get('display') || '').trim().toLowerCase()
    const visibility = String(declarations.get('visibility') || '').trim().toLowerCase()
    const opacityValue = declarations.get('opacity')
    const opacity = opacityValue === undefined ? 1 : parseCssNumber(opacityValue)
    const expectedOpacity = Number.isFinite(Number(fact.opacity)) ? Number(fact.opacity) : 1
    if (display === 'none' || visibility === 'hidden' || visibility === 'collapse' || !Number.isFinite(opacity) || opacity <= 0) {
      errors.push(`${label} 不得隐藏或设置 opacity:0`)
    } else if (opacity + 0.01 < expectedOpacity) {
      errors.push(`${label} 不得在源填充 alpha 之外再次降低 opacity：应为 ${roundNumber(expectedOpacity)}，实际为 ${roundNumber(opacity)}`)
    }
    if (String(declarations.get('position') || '').trim().toLowerCase() !== 'absolute') {
      errors.push(`${label} 必须按源坐标 absolute 定位`)
    }

    const localBounds = fact.localBounds || fact.bounds
    if (localBounds) {
      validateExactPixelDeclaration(declarations, 'left', localBounds.x, `${label} 横坐标`, errors)
      validateExactPixelDeclaration(declarations, 'top', localBounds.y, `${label} 纵坐标`, errors)
      validateExactPixelDeclaration(declarations, 'width', localBounds.width, `${label} 宽度`, errors)
      validateExactPixelDeclaration(declarations, 'height', localBounds.height, `${label} 高度`, errors)
      validateCoordinateAnchor(html, bound, fact.anchorNodeId, rules, variables, label, errors)
    }

    if (fact.resolvedBackgroundColor) {
      const background = declarations.get('background-color') || declarations.get('background')
      if (!colorsEqual(background, fact.resolvedBackgroundColor)) {
        errors.push(`${label} 背景色错误：应为 ${fact.resolvedBackgroundColor}，实际为 ${background || 'missing'}`)
      }
    }
    if (String(fact.type || '').toUpperCase() === 'ELLIPSE') {
      const radius = String(declarations.get('border-radius') || '').trim().toLowerCase()
      if (!/^50(?:\.0+)?%$/.test(radius)) errors.push(`${label} 的 ELLIPSE 必须使用 border-radius:50%`)
    }

    validateRasterFallbackEffects(declarations, rasterEffect.effects || [], label, errors)
    validateRasterFallbackOverflow(html, bound, fact.anchorNodeId, rules, variables, label, errors)
  }
}

function validateRasterFallbackEffects(declarations, effects, label, errors) {
  for (const effect of effects) {
    const type = String(effect?.type || '').toUpperCase()
    const radius = Number(effect?.radius)
    if (!Number.isFinite(radius)) continue
    if (type === 'LAYER_BLUR') {
      const actual = extractBlurRadius(declarations.get('filter'))
      if (!Number.isFinite(actual) || Math.abs(actual - radius) > 0.1) {
        errors.push(`${label} 模糊半径错误：LAYER_BLUR 应为 ${roundNumber(radius)}px，实际为 ${declarations.get('filter') || 'missing'}`)
      }
    } else if (type === 'BACKGROUND_BLUR') {
      const actual = extractBlurRadius(declarations.get('backdrop-filter') || declarations.get('-webkit-backdrop-filter'))
      if (!Number.isFinite(actual) || Math.abs(actual - radius) > 0.1) {
        errors.push(`${label} 模糊半径错误：BACKGROUND_BLUR 应为 ${roundNumber(radius)}px，实际为 ${declarations.get('backdrop-filter') || declarations.get('-webkit-backdrop-filter') || 'missing'}`)
      }
    }
  }
}

function extractBlurRadius(value) {
  const match = String(value || '').match(/\bblur\(\s*([\d.]+)px\s*\)/i)
  return match ? Number(match[1]) : Number.NaN
}

function validateRasterFallbackOverflow(html, bound, anchorNodeId, rules, variables, label, errors) {
  if (!bound || !Number.isFinite(bound.index)) return
  const ancestors = findOpenElementStack(html, bound.index)
  const anchorIndex = anchorNodeId ? findLastArrayIndex(ancestors, (ancestor) =>
    extractAttributeValue(ancestor.tag, 'data-source-node-id') === String(anchorNodeId)
    || extractAttributeValue(ancestor.tag, 'data-style-source-node-id') === String(anchorNodeId)) : -1
  const relevantAncestors = anchorIndex >= 0 ? ancestors.slice(anchorIndex) : ancestors.slice(-1)
  for (const ancestor of relevantAncestors) {
    const declarations = collectElementDeclarations(ancestor.tag, rules, variables)
    const overflow = `${declarations.get('overflow') || ''} ${declarations.get('overflow-x') || ''} ${declarations.get('overflow-y') || ''}`
    const clip = `${declarations.get('clip') || ''} ${declarations.get('clip-path') || ''}`
    if (/\b(?:hidden|clip)\b/i.test(overflow) || (clip.trim() && !/\b(?:auto|none)\b/i.test(clip))) {
      const source = extractAttributeValue(ancestor.tag, 'data-source-node-id')
        || extractAttributeValue(ancestor.tag, 'data-style-source-node-id')
        || ancestor.tagName
      errors.push(`${label} 的源坐标锚点或中间祖先不得裁切 blur bleed：${source}`)
    }
  }
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

function validateDecorativeSvgCanvasIntegrity(html, css, assetIndex = {}, errors) {
  const rules = extractCssRules(css)
  const variables = collectCssVariables(css)
  for (const asset of assetIndex.assets || []) {
    if (!isFilterBleedDecorativeSvg(asset)) continue
    const copiedPath = asset.preferred?.copiedPath
    const tag = copiedPath ? findBoundImageTag(html, asset, copiedPath) : null
    if (!tag) continue
    const declarations = collectElementDeclarations(tag.tag, rules, variables)
    const label = `光晕 SVG ${asset.assetId}`
    const position = String(declarations.get('position') || '').trim().toLowerCase()
    if (position !== 'absolute') errors.push(`${label} 必须 position:absolute，实际为 ${position || 'missing'}`)
    const flex = String(declarations.get('flex') || '').trim().toLowerCase().replace(/\s+/g, ' ')
    const flexShrink = String(declarations.get('flex-shrink') || '').trim()
    if (flex !== 'none' && flex !== '0 0 auto' && flexShrink !== '0') {
      errors.push(`${label} 必须显式设置 flex:none（或等价 flex-shrink:0），防止完整画布被压缩`)
    }
    const maxWidth = String(declarations.get('max-width') || '').trim().toLowerCase()
    if (maxWidth !== 'none') errors.push(`${label} 必须显式设置 max-width:none，覆盖全局 img 限宽`)
    const objectFit = String(declarations.get('object-fit') || '').trim().toLowerCase()
    if (objectFit === 'cover') errors.push(`${label} 不得使用 object-fit:cover`)
  }
}

function isFilterBleedDecorativeSvg(asset) {
  if (asset?.renderPolicy !== 'required-final' || String(asset?.format || '').toLowerCase() !== 'svg') return false
  if (!isDecorativeAsset(asset)) return false
  const rendered = asset?.renderedLocalBounds
  const nominal = asset?.localBounds || asset?.sourceBounds
  const hasExpandedCanvas = rendered && nominal
    && (Number(rendered.width) > Number(nominal.width) + 1 || Number(rendered.height) > Number(nominal.height) + 1)
  const hasGlowReason = (asset.sourceNodes || []).some((source) => /LAYER_BLUR|filter bleed|完整 viewBox|光晕/i.test(String(source?.renderReason || '')))
  return Boolean(hasExpandedCanvas || hasGlowReason)
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
    const expected = asset.croppingPolicy === 'preserve-rendered-slice'
      ? asset.renderedLocalBounds || asset.localBounds || asset.sourceBounds
      : asset.localBounds || asset.sourceBounds
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

function validateLayoutSpacing(html, css, context = {}, errors, warnings) {
  const rules = extractCssRules(css)
  validateBackgroundLayerFlowUsage(html, rules, context.pageLayout, context.nodeStyleFacts, errors)
  validateExcessiveModuleSpacing(rules, context.pageLayout, errors)
  validateHeroBackgroundSizing(rules, context, errors, warnings)
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

function validateHeroBackgroundSizing(rules, context, errors, warnings) {
  const manifestValue = context?.implementationManifest?.preserveSourceBounds
  const preserveSourceBounds = typeof manifestValue === 'boolean'
    ? manifestValue
    : /preserveSourceBounds\s*=\s*true/i.test(String(context?.assemblyPlan || ''))
  for (const module of context?.pageLayout?.modules || []) {
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

function validateRequiredCompactSurfaces(html, css, nodeStyleFacts, errors) {
  const rules = extractCssRules(css)
  const variables = collectCssVariables(css)
  for (const fact of requiredCompactSurfaceFacts(nodeStyleFacts)) {
    const sourceNodeId = String(fact.sourceNodeId)
    const bound = findTagByAttribute(html, 'data-style-source-node-id', sourceNodeId)
    if (!bound) {
      errors.push(`紧凑圆角视觉面缺少 HTML 样式绑定：${sourceNodeId}`)
      continue
    }
    const declarations = collectElementDeclarations(bound.tag, rules, variables)
    const background = declarations.get('background-color') || declarations.get('background')
    if (!background || !colorsEqual(background, fact.resolvedBackgroundColor)) {
      errors.push(`紧凑圆角视觉面背景色不一致：${sourceNodeId} 应为 ${fact.resolvedBackgroundColor}，实际为 ${background || 'missing'}`)
    }

    const expectedRadius = Number(fact.cornerRadius)
    const actualRadius = parsePixelValue(declarations.get('border-radius'))
    if (Number.isFinite(expectedRadius) && (!Number.isFinite(actualRadius) || Math.abs(actualRadius - expectedRadius) > 0.01)) {
      errors.push(`紧凑圆角视觉面圆角不一致：${sourceNodeId} 应为 ${roundNumber(expectedRadius)}px，实际为 ${declarations.get('border-radius') || 'missing'}`)
    }

    const expectedStroke = fact.strokes?.find((stroke) => stroke.type === 'SOLID')?.color
    if (!expectedStroke) continue
    const borderValue = declarations.get('border') || ''
    const actualStroke = declarations.get('border-color') || extractCssColor(borderValue)
    if (!actualStroke || !colorsEqual(actualStroke, expectedStroke)) {
      errors.push(`紧凑圆角视觉面描边色不一致：${sourceNodeId} 应为 ${expectedStroke}，实际为 ${actualStroke || 'missing'}`)
    }
    const expectedWeight = Number(fact.strokeWeight)
    const actualWeight = parsePixelValue(declarations.get('border-width'))
    const shorthandWeight = String(borderValue).match(/(?:^|\s)([\d.]+px)(?:\s|$)/i)?.[1]
    const resolvedWeight = Number.isFinite(actualWeight) ? actualWeight : parsePixelValue(shorthandWeight)
    if (Number.isFinite(expectedWeight) && (!Number.isFinite(resolvedWeight) || Math.abs(resolvedWeight - expectedWeight) > 0.01)) {
      errors.push(`紧凑圆角视觉面描边宽度不一致：${sourceNodeId} 应为 ${roundNumber(expectedWeight)}px，实际为 ${declarations.get('border-width') || borderValue || 'missing'}`)
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
    if (fact.singleLineRequired) validateSingleLineTypography(declarations, sourceNodeId, errors)
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

function validateSingleLineTypography(declarations, sourceNodeId, errors) {
  const whiteSpace = String(declarations.get('white-space') || '').trim().toLowerCase()
  const wordBreak = String(declarations.get('word-break') || '').trim().toLowerCase()
  const overflowWrap = String(declarations.get('overflow-wrap') || '').trim().toLowerCase()
  if (whiteSpace !== 'nowrap') errors.push(`单行文字 ${sourceNodeId} 必须设置 white-space:nowrap，实际为 ${whiteSpace || 'missing'}`)
  if (wordBreak !== 'keep-all') errors.push(`单行文字 ${sourceNodeId} 必须设置 word-break:keep-all，实际为 ${wordBreak || 'missing'}`)
  if (overflowWrap !== 'normal') errors.push(`单行文字 ${sourceNodeId} 必须设置 overflow-wrap:normal，实际为 ${overflowWrap || 'missing'}`)
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

export function writeGeneratedFiles(dir, files) {
  writeFileSync(join(dir, 'index.html'), files.indexHtml, 'utf8')
  writeFileSync(join(dir, 'styles.css'), files.stylesCss, 'utf8')
  writeFileSync(join(dir, 'script.js'), files.scriptJs, 'utf8')
}

export function copyAssets(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true })
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const source = join(sourceDir, entry.name)
    const target = join(targetDir, entry.name)
    if (entry.isDirectory()) copyAssets(source, target)
    else cpSync(source, target)
  }
}

export async function smokeTestOutput(outputDir) {
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

export function publishOutput(tempDir, outputDir) {
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
