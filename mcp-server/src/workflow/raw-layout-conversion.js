import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractImmutableSourceTexts } from './immutable-source-texts.js'
import { buildNodeStyleFacts } from './node-style-facts.js'

const VERSION = {
  normalized: 'mastergo2html.raw-normalized.v1',
  assetIndex: 'mastergo2html.asset-index.v1',
  designTokens: 'mastergo2html.design-tokens.v1',
  pageLayout: 'mastergo2html.page-layout.v1',
  fontAvailability: 'mastergo2html.font-availability.v1',
}

const CONTAINER_TYPES = new Set(['FRAME', 'GROUP', 'COMPONENT', 'INSTANCE', 'SECTION'])
const TEXT_TYPES = new Set(['TEXT'])
const DECORATIVE_NAME_RE = /(decor|decoration|bg|background|背景|装饰|圆形|波点|矩形|路径|直线|shape|ellipse|line)/i
const BACKGROUND_DECOR_MASK_NAME_RE = /(?=.*(?:背景装饰|background\s*decor|decor|decoration|bg|背景|装饰|波点|点阵|网格|dots?|grid|pattern))(?=.*(?:蒙版|mask))/i
const MODULE_NAME_RE = /(header|nav|navigation|hero|banner|section|content|footer|form|list|card|导航|页头|头部|首页|横幅|内容|模块|区块|页尾|底部|表单|列表|卡片|详情)/i
const SYSTEM_FONT_FAMILIES = new Set([
  '-apple-system',
  'arial',
  'blinkmacsystemfont',
  'helvetica',
  'microsoft yahei',
  'pingfang sc',
  'sans-serif',
  'segoe ui',
  'serif',
  'system-ui',
])

export function runRawLayoutConversion(jobId, jobDir) {
  const inputDir = join(jobDir, '00-input')
  const normalizedDir = join(jobDir, '01-normalized')
  const layoutDir = join(jobDir, '02-layout')
  mkdirSync(normalizedDir, { recursive: true })
  mkdirSync(layoutDir, { recursive: true })

  const input = readPhase4Input(inputDir)
  const root = selectRootFrame(input.raw)
  const warnings = []
  const rootBounds = toBounds(root)
  if (!rootBounds) {
    warnings.push(createWarning('missing-root-bounds', root?.id, '根 Frame 缺少可用边界，布局推导置信度会降低。'))
  }

  const normalizedTree = normalizeNode(root, rootBounds, null, 0, warnings)
  const flatNodes = []
  flattenNodes(normalizedTree, flatNodes)

  const assetIndex = buildAssetIndex(input.assetManifest, inputDir, flatNodes, warnings)
  const designTokens = buildDesignTokens(input.raw, flatNodes, warnings)
  const fontAvailability = buildFontAvailabilityReport(flatNodes)
  if (fontAvailability.missingFonts.length > 0) {
    warnings.push(createWarning(
      'font-assets-required',
      null,
      `发现 ${fontAvailability.missingFonts.length} 个字体族不是系统通用字体，建议安装字体包或随 HTML 产物嵌入 @font-face。`,
    ))
  }
  const pageLayout = buildPageLayout({
    jobId,
    raw: input.raw,
    exportOptions: input.exportOptions,
    root: normalizedTree,
    flatNodes,
    assetIndex,
    designTokens,
    warnings,
  })

  const normalizedPayload = {
    version: VERSION.normalized,
    generatedAt: new Date().toISOString(),
    source: {
      rawVersion: input.raw?.version,
      page: input.raw?.page ?? null,
      selectionCount: Array.isArray(input.raw?.selection) ? input.raw.selection.length : 0,
      inputDir,
    },
    rootId: normalizedTree?.id ?? null,
    nodes: normalizedTree ? [normalizedTree] : [],
    flatNodeCount: flatNodes.length,
    warnings,
  }
  const nodeStyleFacts = buildNodeStyleFacts(normalizedPayload)

  const normalizationReport = buildNormalizationReport({
    jobId,
    normalizedPayload,
    assetIndex,
    designTokens,
    fontAvailability,
    pageLayout,
  })
  const aiLayoutContext = buildAiLayoutContext({
    raw: input.raw,
    exportOptions: input.exportOptions,
    root: normalizedTree,
    flatNodes,
    assetIndex,
    designTokens,
    fontAvailability,
    pageLayoutDraft: pageLayout,
    warnings,
  })
  const aiLayoutContextPath = join(layoutDir, 'ai-layout-context.json')

  writeJson(join(normalizedDir, 'raw.normalized.json'), normalizedPayload)
  writeJson(join(normalizedDir, 'source-texts.json'), extractImmutableSourceTexts(normalizedPayload))
  writeJson(join(normalizedDir, 'node-style-facts.json'), nodeStyleFacts)
  writeJson(join(normalizedDir, 'asset-index.json'), assetIndex)
  writeJson(join(normalizedDir, 'design-tokens.json'), designTokens)
  writeJson(join(normalizedDir, 'font-availability.json'), fontAvailability)
  writeFileSync(join(normalizedDir, 'missing-fonts.md'), buildMissingFontsMarkdown(fontAvailability), 'utf8')
  writeFileSync(join(normalizedDir, 'normalization-report.md'), normalizationReport, 'utf8')
  writeJson(join(layoutDir, 'page-layout.json'), pageLayout)
  writeJson(aiLayoutContextPath, aiLayoutContext)
  writeFileSync(join(layoutDir, 'page-layout.md'), buildPendingPageLayoutMarkdown(), 'utf8')

  return {
    normalizedDir,
    layoutDir,
    aiLayoutContextPath,
    summary: {
      rootId: normalizedTree?.id ?? null,
      nodeCount: flatNodes.length,
      assetCount: assetIndex.assets.length,
      moduleCount: pageLayout.modules.length,
      warningCount: warnings.length,
    },
  }
}

function readPhase4Input(inputDir) {
  const requiredFiles = [
    'raw.json',
    'asset-manifest.json',
    'export-options.json',
    'frame-screenshot.png',
  ]
  for (const file of requiredFiles) {
    const filePath = join(inputDir, file)
    if (!existsSync(filePath)) {
      throw new Error(`阶段四输入缺少 ${filePath}`)
    }
  }

  return {
    raw: readJson(join(inputDir, 'raw.json')),
    assetManifest: readJson(join(inputDir, 'asset-manifest.json')),
    exportOptions: readJson(join(inputDir, 'export-options.json')),
  }
}

function selectRootFrame(raw) {
  const selection = Array.isArray(raw?.selection) ? raw.selection : []
  return selection.find((node) => node?.type === 'FRAME') ?? selection[0] ?? null
}

function normalizeNode(node, rootBounds, parentId, depth, warnings) {
  if (!node || typeof node !== 'object') return null
  const bounds = toBounds(node)
  const relativeBounds = bounds && rootBounds ? offsetBounds(bounds, rootBounds) : fallbackRelativeBounds(node)
  const children = Array.isArray(node.children)
    ? node.children.map((child) => normalizeNode(child, rootBounds, node.id, depth + 1, warnings)).filter(Boolean)
    : []
  const visible = node.isVisible !== false
  const text = typeof node.characters === 'string' ? preserveSourceText(node.characters) : undefined
  const fills = Array.isArray(node.fills) ? node.fills : []
  const strokes = Array.isArray(node.strokes) ? node.strokes : []
  const effects = Array.isArray(node.effects) ? node.effects : []
  const imageRefs = fills.filter((paint) => paint?.type === 'IMAGE' && paint.imageRef).map((paint) => ({
    imageRef: paint.imageRef,
    assetId: paint.assetId,
    scaleMode: paint.scaleMode,
    alpha: paint.alpha,
  }))

  if (!bounds && visible) {
    warnings.push(createWarning('missing-node-bounds', node.id, `节点 ${node.name || node.id} 缺少边界，后续布局可能忽略它。`))
  }

  return compact({
    id: String(node.id ?? ''),
    sourceNodeId: String(node.id ?? ''),
    parentId,
    depth,
    name: String(node.name ?? ''),
    type: String(node.type ?? 'UNKNOWN'),
    visible,
    role: inferNodeRole(node, children),
    bounds,
    relativeBounds,
    text,
    layout: compact({
      sourceFlexMode: node.flexMode,
      sourceFlexWrap: node.flexWrap,
      itemSpacing: toNumber(node.itemSpacing),
      padding: readPadding(node),
      htmlPosition: inferPositionStrategy(node, bounds, parentId, children),
    }),
    style: compact({
      opacity: node.opacity,
      fills,
      strokes,
      effects,
      cornerRadius: firstNumber(node.cornerRadius, node.topLeftRadius, node.topRightRadius, node.bottomLeftRadius, node.bottomRightRadius),
      strokeWeight: toNumber(node.strokeWeight),
      text: extractTextStyle(node),
    }),
    images: imageRefs,
    childIds: children.map((child) => child.id),
    children,
  })
}

function buildAssetIndex(assetManifest, inputDir, flatNodes, warnings) {
  const nodeById = new Map(flatNodes.map((node) => [node.id, node]))
  const assets = Array.isArray(assetManifest?.assets) ? assetManifest.assets : []
  const indexedAssets = assets.map((asset) => {
    const original = compact({
      kind: 'original-image',
      assetId: asset.assetId,
      path: asset.copiedPath,
      suggestedFile: asset.suggestedFile,
      status: asset.status,
      exists: asset.copiedPath ? existsSync(join(inputDir, asset.copiedPath)) : false,
    })
    const rendered = Array.isArray(asset.renderedAssets) ? asset.renderedAssets.map((item) => compact({
      kind: 'rendered-image',
      assetId: item.assetId,
      nodeId: item.nodeId,
      path: item.copiedPath,
      suggestedFile: item.suggestedFile,
      status: item.status,
      width: item.width,
      height: item.height,
      exists: item.copiedPath ? existsSync(join(inputDir, item.copiedPath)) : false,
      error: item.error,
    })) : []
    const preferred = choosePreferredAssetPath(original, rendered)
    const sourceNodes = Array.isArray(asset.sourceNodes) ? asset.sourceNodes.map((source) => {
      const node = nodeById.get(source.nodeId)
      const ancestors = collectAncestors(node, nodeById)
      return compact({
        sourceNodeId: source.nodeId,
        sourceNodeName: source.nodeName,
        paintPath: source.paintPath,
        usageHint: source.usageHint,
        renderReason: source.renderReason,
        scaleMode: source.scaleMode,
        alpha: source.alpha,
        nodeType: node?.type,
        ancestorNodeIds: ancestors.map((ancestor) => ancestor.id),
        ancestorNodeNames: ancestors.map((ancestor) => ancestor.name).filter(Boolean),
        insideBackgroundDecorMask: isBackgroundDecorMaskNode(node) || ancestors.some(isBackgroundDecorMaskNode),
      })
    }) : []

    if (!preferred?.copiedPath) {
      warnings.push(createWarning('asset-missing-copied-path', asset.assetId, `资源 ${asset.assetId} 没有可用 copiedPath，后续需要 AI 或人工降级处理。`))
    }
    const usage = inferAssetUsage(asset, sourceNodes)

    return compact({
      assetId: asset.assetId,
      kind: asset.kind ?? 'image',
      usageHint: asset.usageHint,
      imageRef: asset.imageRef,
      status: asset.status,
      preferred,
      original,
      rendered,
      sourceNodes,
      usage,
      layer: usage.startsWith('background-decor') || usage === 'background' ? 'background' : undefined,
      renderingStrategy: usage === 'background-decor-mask' ? 'use-rendered-node-slice' : undefined,
      mustUseRenderedSlice: usage === 'background-decor-mask' ? true : undefined,
      mustNotEnterDocumentFlow: usage.startsWith('background-decor') ? true : undefined,
      zIndexGroup: usage.startsWith('background-decor') ? 'background' : undefined,
      uncertainty: preferred?.copiedPath ? 'low' : 'high',
      error: asset.error,
    })
  })

  return {
    version: VERSION.assetIndex,
    generatedAt: new Date().toISOString(),
    sourceManifestVersion: assetManifest?.version ?? null,
    inputDir,
    assets: indexedAssets,
    warnings: warnings.filter((warning) => warning.code.startsWith('asset-')),
  }
}

function buildDesignTokens(raw, flatNodes, warnings) {
  const colors = new Map()
  const fontSizes = new Map()
  const fontFamilies = new Map()
  const fontWeights = new Map()
  const radii = new Map()
  const shadows = new Map()
  const borders = new Map()
  const spacings = new Map()

  for (const node of flatNodes) {
    collectPaintColors(node.style?.fills, colors)
    collectPaintColors(node.style?.strokes, colors)
    collectTextTokens(node.style?.text, fontSizes, fontFamilies, fontWeights)
    addToken(radii, node.style?.cornerRadius)
    addToken(borders, node.style?.strokeWeight)
    collectShadowTokens(node.style?.effects, shadows)
    collectSpacingTokens(node.layout?.padding, spacings)
    addToken(spacings, node.layout?.itemSpacing)
  }
  collectSiblingGaps(flatNodes, spacings)

  const colorTokens = makeTokenList(colors, 'color', (value, index) => inferColorTokenName(value, index))
  if (colorTokens.some((token) => token.confidence !== 'high')) {
    warnings.push(createWarning('token-semantic-uncertain', null, '颜色 token 已做语义命名，但仍需要后续 AI 校准 primary/accent/background 的真实语义。'))
  }

  return {
    version: VERSION.designTokens,
    generatedAt: new Date().toISOString(),
    source: {
      page: raw?.page ?? null,
      nodeCount: flatNodes.length,
    },
    tokens: {
      colors: colorTokens,
      fontSizes: makeTokenList(fontSizes, 'font-size', (value, index) => inferFontSizeTokenName(value, index)),
      fontFamilies: makeTokenList(fontFamilies, 'font-family', (value, index) => `font-family-${index + 1}`),
      fontWeights: makeTokenList(fontWeights, 'font-weight', (value, index) => `font-weight-${value}`),
      spacing: makeTokenList(spacings, 'space', (value, index) => inferSpacingTokenName(value, index)),
      radii: makeTokenList(radii, 'radius', (value, index) => inferRadiusTokenName(value, index)),
      shadows: makeTokenList(shadows, 'shadow', (value, index) => `shadow-${index + 1}`),
      borders: makeTokenList(borders, 'border-width', (value, index) => `border-width-${value}`),
    },
    responsive: {
      baseOnly: true,
      confidence: 'single-frame-low',
      note: '当前阶段只读取一个 Frame，无法确认真实移动端设计；仅输出保守响应式提示。',
    },
  }
}

function buildPageLayout({ jobId, raw, exportOptions, root, flatNodes, assetIndex, designTokens, warnings }) {
  const visibleNodes = flatNodes.filter((node) => node.visible && node.bounds && node.id !== root?.id)
  const modules = inferModules(root, visibleNodes, assetIndex, warnings)
  const page = compact({
    sourcePage: raw?.page ?? null,
    rootFrameId: root?.id,
    rootFrameName: root?.name,
    baseViewport: root?.relativeBounds ? {
      width: root.relativeBounds.width,
      height: root.relativeBounds.height,
    } : null,
    background: inferPageBackground(root),
    screenshot: '00-input/frame-screenshot.png',
    exportOptions,
  })

  return {
    version: VERSION.pageLayout,
    generatedAt: new Date().toISOString(),
    jobId,
    schema: {
      purpose: 'HTML-friendly page layout for module slicing and code generation.',
      moduleFields: ['moduleId', 'name', 'type', 'order', 'bounds', 'layoutStrategy', 'positionStrategy', 'sourceNodeIds', 'assetIds', 'warnings'],
    },
    page,
    layoutStrategy: {
      baseline: 'single-frame-desktop',
      coordinateSystem: 'relative-to-root-frame',
      moduleDetectionPriority: [
        'mastergo-node-hierarchy-and-name',
        'vertical-visual-sections',
        'background-or-container-boundaries',
        'large-spacing-separators',
      ],
      absolutePositionPolicy: 'direct-decision',
    },
    responsive: {
      baseViewport: page.baseViewport,
      confidence: 'single-frame-low',
      hints: inferResponsiveHints(modules, page.baseViewport),
      blockedReason: 'Only one selected Frame is available in 00-input, so exact PC/mobile mapping is unknown.',
    },
    tokenRefs: {
      designTokens: '../01-normalized/design-tokens.json',
      assetIndex: '../01-normalized/asset-index.json',
    },
    modules,
    globalDecorations: inferGlobalDecorations(visibleNodes, modules),
    uncertainties: warnings,
    nextAiReview: {
      required: warnings.length > 0,
      focus: warnings.map((warning) => warning.message),
    },
  }
}

function buildAiLayoutContext({ raw, exportOptions, root, flatNodes, assetIndex, designTokens, fontAvailability, pageLayoutDraft, warnings }) {
  const visibleNodes = flatNodes.filter((node) => node.visible && node.relativeBounds)
  const directChildren = (root?.children || []).filter((node) => node.visible && node.relativeBounds)
  const textNodes = visibleNodes
    .filter((node) => node.role === 'text' && node.text)
    .sort(byVisualOrder)
    .map((node) => summarizeNodeForAgent(node, { includeText: true, textMaxLength: 320 }))
  const containerNodes = visibleNodes
    .filter((node) => node.role === 'container' || node.type === 'FRAME' || node.type === 'GROUP')
    .sort(byVisualOrder)
    .filter((node) => node.depth <= 2 || hasMeaningfulContainerName(node))
    .slice(0, 40)
    .map((node) => summarizeNodeForAgent(node))
  const visualLayers = directChildren
    .sort(byVisualOrder)
    .map((node) => ({
      ...summarizeNodeForAgent(node, { includeText: node.role === 'text' }),
      descendantText: collectDescendants(node)
        .filter((item) => item.role === 'text' && item.text)
        .sort(byVisualOrder)
        .map((item) => ({
          sourceNodeId: item.id,
          name: item.name,
          text: truncate(item.text, 120),
          bounds: item.relativeBounds,
        })),
      descendantAssetIds: collectAssetIds(collectDescendants(node).map((item) => item.id), assetIndex),
    }))

  return {
    version: 'mastergo2html.ai-layout-context.v1',
    generatedAt: new Date().toISOString(),
    purpose: 'Input for AI layout analysis. Rules provide normalized facts only; page-layout.md must be authored by AI.',
    inputFiles: {
      raw: '00-input/raw.json',
      assetManifest: '00-input/asset-manifest.json',
      exportOptions: '00-input/export-options.json',
      frameScreenshot: '00-input/frame-screenshot.png',
      normalizedRaw: '01-normalized/raw.normalized.json',
      assetIndex: '01-normalized/asset-index.json',
      designTokens: '01-normalized/design-tokens.json',
      fontAvailability: '01-normalized/font-availability.json',
      pageLayoutDraft: '02-layout/page-layout.json',
    },
    page: {
      sourcePage: raw?.page ?? null,
      rootFrame: root ? summarizeNodeForAgent(root) : null,
      baseViewport: pageLayoutDraft.page?.baseViewport ?? null,
      background: pageLayoutDraft.page?.background ?? null,
      exportOptions,
    },
    responsive: {
      confidence: 'single-frame-low',
      rule: 'Only one Frame is exported. Do not invent exact mobile layout; provide conservative hints only.',
    },
    visualLayers,
    visibleTexts: textNodes,
    containers: containerNodes,
    assets: assetIndex.assets.map((asset) => ({
      assetId: asset.assetId,
      preferred: asset.preferred,
      usage: asset.usage,
      layer: asset.layer,
      renderingStrategy: asset.renderingStrategy,
      mustUseRenderedSlice: asset.mustUseRenderedSlice,
      mustNotEnterDocumentFlow: asset.mustNotEnterDocumentFlow,
      zIndexGroup: asset.zIndexGroup,
      sourceNodes: asset.sourceNodes?.map((source) => ({
        sourceNodeId: source.sourceNodeId,
        sourceNodeName: source.sourceNodeName,
        nodeType: source.nodeType,
        usageHint: source.usageHint,
        insideBackgroundDecorMask: source.insideBackgroundDecorMask,
        ancestorNodeIds: source.ancestorNodeIds,
        ancestorNodeNames: source.ancestorNodeNames,
      })),
    })),
    designTokenSummary: {
      colors: designTokens.tokens.colors.slice(0, 20),
      fontSizes: designTokens.tokens.fontSizes.slice(0, 20),
      fontFamilies: designTokens.tokens.fontFamilies.slice(0, 20),
      spacing: designTokens.tokens.spacing.slice(0, 20),
      radii: designTokens.tokens.radii.slice(0, 20),
    },
    fontAvailability: {
      missingFonts: fontAvailability.missingFonts,
      reportPath: '01-normalized/font-availability.json',
    },
    ruleDraft: {
      warning: 'This is only a machine-readable draft. Do not trust it as final layout intent.',
      modules: pageLayoutDraft.modules.map((module) => ({
        moduleId: module.moduleId,
        name: truncate(module.name, 80),
        type: module.type,
        bounds: module.bounds,
        sourceNodeIds: module.sourceNodeIds,
        assetIds: module.assetIds,
        layoutStrategy: module.layoutStrategy,
        positionStrategy: module.positionStrategy,
        warnings: module.warnings,
      })),
      globalDecorations: pageLayoutDraft.globalDecorations,
    },
    warnings,
  }
}

function inferModules(root, visibleNodes, assetIndex, warnings) {
  if (!root) return []
  const directChildren = (root.children || []).filter((node) => node.visible && node.bounds)
  const explicitModules = directChildren.filter((node) => isExplicitModuleCandidate(node, root))
  const explicitIds = new Set(explicitModules.map((node) => node.id))
  const remaining = directChildren.filter((node) => !explicitIds.has(node.id) && !isLikelyGlobalDecoration(node, root))
  const clusteredModules = clusterVerticalSections(remaining.length > 0 ? remaining : visibleNodes, root, warnings)
  const candidates = [...explicitModules, ...clusteredModules]
    .filter((candidate) => candidate.relativeBounds || candidate.clusterBounds)
    .sort((a, b) => {
      const aBounds = a.clusterBounds ?? a.relativeBounds
      const bBounds = b.clusterBounds ?? b.relativeBounds
      return aBounds.y - bBounds.y || aBounds.x - bBounds.x
    })

  return candidates.map((candidate, index) => buildModule(candidate, index, visibleNodes, assetIndex))
}

function buildModule(candidate, index, visibleNodes, assetIndex) {
  const sourceNodes = candidate.clusterNodes ?? collectDescendants(candidate)
  const sourceNodeIds = unique(sourceNodes.map((node) => node.id))
  const bounds = candidate.clusterBounds ?? candidate.relativeBounds
  const assetIds = collectAssetIds(sourceNodeIds, assetIndex)
  const type = inferModuleType(candidate, index)
  const layoutMode = inferModuleLayout(sourceNodes, bounds)
  const positionStrategy = inferModulePositionStrategy(sourceNodes, bounds, type)
  const warnings = []
  if (positionStrategy === 'absolute') {
    warnings.push(createWarning('module-absolute-layout', candidate.id, '模块包含复杂重叠或装饰元素，第一版判定为 absolute。'))
  }

  return compact({
    moduleId: `module_${String(index + 1).padStart(2, '0')}_${slugify(type)}`,
    name: candidate.name || type,
    type,
    order: index + 1,
    bounds: roundBounds(bounds),
    sourceNodeIds,
    assetIds,
    layoutStrategy: layoutMode,
    positionStrategy,
    container: inferContentContainer(sourceNodes, bounds),
    backgroundLayers: inferBackgroundLayers(sourceNodes, bounds),
    contentFlow: inferContentFlow(sourceNodes),
    internalRegions: inferInternalRegions(sourceNodes, bounds),
    spacing: inferModuleSpacing(sourceNodes, bounds),
    riskLevel: warnings.length > 0 ? 'medium' : 'low',
    warnings,
  })
}

function clusterVerticalSections(nodes, root, warnings) {
  const usable = nodes
    .filter((node) => node.visible && node.relativeBounds && node.relativeBounds.height > 1 && !isLikelyGlobalDecoration(node, root))
    .sort((a, b) => a.relativeBounds.y - b.relativeBounds.y || a.relativeBounds.x - b.relativeBounds.x)
  if (usable.length === 0) return []

  const clusters = []
  let current = []
  let currentBounds = null
  const largeGap = Math.max(160, Math.round((root?.relativeBounds?.height ?? 1000) * 0.09))
  for (const node of usable) {
    if (!currentBounds) {
      current = [node]
      currentBounds = { ...node.relativeBounds }
      continue
    }
    const gap = node.relativeBounds.y - (currentBounds.y + currentBounds.height)
    if (gap > largeGap && current.length > 0 && !shouldKeepInSameContentSection(current, node)) {
      clusters.push({ current, currentBounds })
      current = [node]
      currentBounds = { ...node.relativeBounds }
    } else {
      current.push(node)
      currentBounds = unionBounds(currentBounds, node.relativeBounds)
    }
  }
  if (current.length > 0 && currentBounds) clusters.push({ current, currentBounds })

  warnings.push(createWarning('module-regrouped-by-vertical-clusters', root?.id, '未完全依赖 MasterGo 原始层级，已按纵向视觉分区重组模块。'))

  return clusters.map((cluster, index) => ({
    id: `cluster:${index + 1}`,
    name: inferClusterName(cluster.current, index),
    type: 'CLUSTER',
    visible: true,
    relativeBounds: cluster.currentBounds,
    clusterBounds: cluster.currentBounds,
    clusterNodes: cluster.current.flatMap((node) => collectDescendants(node)),
  }))
}

function shouldKeepInSameContentSection(current, nextNode) {
  const currentTextCount = current.filter((node) => node.role === 'text').length
  const nextIsAction = /button|btn|按钮|投递|提交|立即/i.test(nextNode.name || '')
  return currentTextCount >= 1 && nextIsAction
}

function inferNodeRole(node, children) {
  if (node.isVisible === false) return 'ignored'
  if (TEXT_TYPES.has(node.type)) return 'text'
  if (Array.isArray(node.fills) && node.fills.some((paint) => paint?.type === 'IMAGE')) return 'image'
  if (DECORATIVE_NAME_RE.test(String(node.name || ''))) return 'decorative'
  if (CONTAINER_TYPES.has(node.type) && children.length > 0) return 'container'
  return 'content'
}

function inferPositionStrategy(node, bounds, parentId, children) {
  if (!parentId) return 'flow'
  if (node.flexMode && node.flexMode !== 'NONE') return 'flex'
  if (children.length >= 4 && looksLikeGrid(children)) return 'grid'
  if (node.rotation && Math.abs(Number(node.rotation)) > 0.5) return 'absolute'
  if (bounds && (bounds.width <= 2 || bounds.height <= 2)) return 'absolute'
  if (DECORATIVE_NAME_RE.test(String(node.name || ''))) return 'absolute'
  return 'flow'
}

function inferModuleLayout(nodes, bounds) {
  const contentNodes = nodes.filter((node) => node.visible && node.relativeBounds && node.role !== 'decorative')
  if (contentNodes.some((node) => node.layout?.sourceFlexMode && node.layout.sourceFlexMode !== 'NONE')) return 'flex'
  if (looksLikeGrid(contentNodes)) return 'grid'
  const columns = countVisualColumns(contentNodes, bounds)
  if (columns >= 2) return 'flex'
  return 'flow'
}

function inferModulePositionStrategy(nodes, bounds, type) {
  const absoluteNodes = nodes.filter((node) => node.layout?.htmlPosition === 'absolute')
  const area = Math.max(1, bounds.width * bounds.height)
  const absoluteArea = sumArea(absoluteNodes)
  if (type === 'hero' && absoluteNodes.length >= 3 && absoluteArea / area > 0.12) return 'absolute'
  if (absoluteNodes.length / Math.max(1, nodes.length) > 0.4) return 'absolute'
  return inferModuleLayout(nodes, bounds)
}

function inferModuleType(node, index) {
  const name = String(node.name || '').toLowerCase()
  if (/nav|navigation|导航|页头|头部/.test(name)) return 'header'
  if (/footer|页尾|底部/.test(name)) return 'footer'
  if (/hero|banner|首页|横幅/.test(name)) return 'hero'
  if (/form|表单/.test(name)) return 'form'
  if (/投递|按钮/.test(name) && (node.relativeBounds?.height ?? 0) < 180) return 'form'
  if (/card|list|列表|卡片/.test(name)) return 'card-list'
  if (index === 0 && (node.relativeBounds?.y ?? 0) <= 80) return 'header'
  return 'content-section'
}

function inferContentContainer(nodes, bounds) {
  const content = nodes.filter((node) => node.visible && node.relativeBounds && node.role !== 'decorative')
  if (content.length === 0) return null
  const contentBounds = content.map((node) => node.relativeBounds).reduce(unionBounds)
  return {
    bounds: roundBounds(contentBounds),
    maxWidth: Math.round(contentBounds.width),
    horizontalPadding: {
      left: Math.max(0, Math.round(contentBounds.x - bounds.x)),
      right: Math.max(0, Math.round(bounds.x + bounds.width - contentBounds.x - contentBounds.width)),
    },
  }
}

function inferBackgroundLayers(nodes, bounds) {
  const moduleArea = Math.max(1, area(bounds))
  return nodes
    .filter((node) => node.visible && node.relativeBounds && node.role === 'decorative' && isLikelySectionBackground(node, bounds, moduleArea))
    .sort((a, b) => area(b.relativeBounds) - area(a.relativeBounds))
    .map((node) => compact({
      sourceNodeId: node.id,
      name: node.name,
      bounds: roundBounds(node.relativeBounds),
      role: 'section-background',
      affectsFlow: false,
      reason: 'Large decorative/background layer overlaps module content and must not create document-flow spacing.',
    }))
}

function inferContentFlow(nodes) {
  const flowNodes = nodes
    .filter((node) => node.visible && node.relativeBounds && node.role !== 'decorative')
    .sort((a, b) => a.relativeBounds.y - b.relativeBounds.y || a.relativeBounds.x - b.relativeBounds.x)
  if (flowNodes.length === 0) return null
  const first = flowNodes[0].relativeBounds
  const last = flowNodes.at(-1).relativeBounds
  const anchorNodes = flowNodes
    .filter((node) => node.role === 'text' || node.role === 'image' || /card|list|列表|卡片|岗位|process|流程/i.test(node.name || ''))
    .slice(0, 32)
  return {
    startY: round(first.y),
    firstContentY: round(first.y),
    lastContentY: round(last.y + last.height),
    bounds: roundBounds(flowNodes.map((node) => node.relativeBounds).reduce(unionBounds)),
    items: anchorNodes.map((node) => compact({
      sourceNodeId: node.id,
      name: node.name,
      role: node.role,
      bounds: roundBounds(node.relativeBounds),
    })),
  }
}

function isLikelySectionBackground(node, moduleBounds, moduleArea) {
  if (!node?.relativeBounds || !moduleBounds) return false
  const nodeArea = area(node.relativeBounds)
  const areaRatio = nodeArea / moduleArea
  const coversWidth = node.relativeBounds.width >= moduleBounds.width * 0.72
  const coversHeight = node.relativeBounds.height >= moduleBounds.height * 0.35
  const hasBackgroundPaint = Array.isArray(node.style?.fills) && node.style.fills.length > 0
  const backgroundName = /bg|background|背景|面板|panel|矩形/i.test(String(node.name || ''))
  return hasBackgroundPaint && coversWidth && (coversHeight || areaRatio > 0.25 || backgroundName)
}

function inferInternalRegions(nodes, bounds) {
  const content = nodes.filter((node) => node.visible && node.relativeBounds && node.role !== 'decorative')
  const textNodes = content.filter((node) => node.role === 'text')
  const imageNodes = content.filter((node) => node.role === 'image')
  const regions = []
  if (textNodes.length > 0) {
    regions.push({ regionId: 'text-content', kind: 'text', bounds: roundBounds(textNodes.map((node) => node.relativeBounds).reduce(unionBounds)), sourceNodeIds: textNodes.map((node) => node.id) })
  }
  if (imageNodes.length > 0) {
    regions.push({ regionId: 'media', kind: 'media', bounds: roundBounds(imageNodes.map((node) => node.relativeBounds).reduce(unionBounds)), sourceNodeIds: imageNodes.map((node) => node.id) })
  }
  if (regions.length === 0 && content.length > 0) {
    regions.push({ regionId: 'content', kind: 'mixed', bounds: roundBounds(bounds), sourceNodeIds: content.map((node) => node.id) })
  }
  return regions
}

function inferModuleSpacing(nodes, bounds) {
  const sorted = nodes.filter((node) => node.visible && node.relativeBounds && node.role !== 'decorative')
    .sort((a, b) => a.relativeBounds.y - b.relativeBounds.y)
  const gaps = []
  for (let index = 1; index < sorted.length; index += 1) {
    const prev = sorted[index - 1].relativeBounds
    const next = sorted[index].relativeBounds
    const gap = Math.round(next.y - (prev.y + prev.height))
    if (gap > 0) gaps.push(gap)
  }
  return {
    verticalGaps: uniqueNumbers(gaps).slice(0, 8),
    outer: {
      top: Math.max(0, Math.round((sorted[0]?.relativeBounds?.y ?? bounds.y) - bounds.y)),
      bottom: Math.max(0, Math.round(bounds.y + bounds.height - ((sorted.at(-1)?.relativeBounds?.y ?? bounds.y) + (sorted.at(-1)?.relativeBounds?.height ?? bounds.height)))),
    },
  }
}

function inferResponsiveHints(modules, baseViewport) {
  const hints = [
    {
      scope: 'page',
      confidence: 'single-frame-low',
      rule: 'Use the exported Frame width as desktop baseline. Do not assume exact mobile layout without a mobile Frame.',
    },
  ]
  for (const module of modules) {
    if (module.layoutStrategy === 'grid') {
      hints.push({ scope: module.moduleId, confidence: 'low', rule: 'Grid-like content may wrap to fewer columns on narrow screens.' })
    }
    if (module.internalRegions?.length >= 2) {
      hints.push({ scope: module.moduleId, confidence: 'low', rule: 'Multi-region layout may stack vertically on narrow screens.' })
    }
  }
  if (baseViewport?.width >= 1200) {
    hints.push({ scope: 'page', confidence: 'low', rule: 'A common narrow breakpoint can be introduced later, but it must be visually checked against generated screenshots.' })
  }
  return hints
}

function inferGlobalDecorations(nodes, modules) {
  const moduleNodeIds = new Set(modules.flatMap((module) => module.sourceNodeIds))
  return nodes
    .filter((node) => node.visible && !moduleNodeIds.has(node.id) && node.role === 'decorative')
    .map((node) => ({ sourceNodeId: node.id, name: node.name, bounds: roundBounds(node.relativeBounds), positionStrategy: 'absolute' }))
}

function inferPageBackground(root) {
  const fills = Array.isArray(root?.style?.fills) ? root.style.fills : []
  const solid = fills.find((paint) => paint?.type === 'SOLID')
  return solid ? { type: 'solid', color: colorToHex(solid.color, solid.alpha) } : null
}

function isExplicitModuleCandidate(node, root) {
  if (!node.relativeBounds) return false
  if (isLikelyGlobalDecoration(node, root)) return false
  const name = String(node.name || '')
  if (/nav|navigation|导航|页头|头部|footer|页尾|底部|hero|banner|横幅/i.test(name)) return true
  return false
}

function isLikelyGlobalDecoration(node, root) {
  if (!node.relativeBounds || !root?.relativeBounds) return false
  const areaRatio = area(node.relativeBounds) / Math.max(1, area(root.relativeBounds))
  const outOfFrame = node.relativeBounds.y < 0 || node.relativeBounds.x < 0 || node.relativeBounds.x + node.relativeBounds.width > root.relativeBounds.width
  const textCount = collectDescendants(node).filter((item) => item.role === 'text').length
  const imageCount = collectDescendants(node).filter((item) => item.role === 'image').length
  const decorativeCluster = imageCount > 0 && textCount === 0 && outOfFrame
  return (node.role === 'decorative' && (areaRatio > 0.25 || outOfFrame)) || decorativeCluster
}

function collectDescendants(node) {
  const output = []
  const stack = [node]
  while (stack.length > 0) {
    const current = stack.shift()
    if (!current) continue
    output.push(current)
    for (const child of current.children || []) stack.push(child)
  }
  return output
}

function flattenNodes(node, output) {
  if (!node) return
  output.push(node)
  for (const child of node.children || []) flattenNodes(child, output)
}

function collectAssetIds(sourceNodeIds, assetIndex) {
  const ids = new Set()
  for (const asset of assetIndex.assets) {
    if ((asset.sourceNodes || []).some((source) => sourceNodeIds.includes(source.sourceNodeId))) {
      ids.add(asset.assetId)
    }
  }
  return [...ids]
}

function summarizeNodeForAgent(node, options = {}) {
  return compact({
    sourceNodeId: node.id,
    name: node.name,
    type: node.type,
    role: node.role,
    bounds: node.relativeBounds,
    text: options.includeText ? truncate(node.text, options.textMaxLength ?? 500) : undefined,
    layout: compact({
      sourceFlexMode: node.layout?.sourceFlexMode,
      itemSpacing: node.layout?.itemSpacing,
      padding: node.layout?.padding,
      htmlPosition: node.layout?.htmlPosition,
    }),
    style: compact({
      cornerRadius: node.style?.cornerRadius,
      strokeWeight: node.style?.strokeWeight,
      text: node.style?.text ? compact({
        fontFamily: node.style.text.fontFamily,
        fontSize: node.style.text.fontSize,
        fontWeight: node.style.text.fontWeight,
        lineHeight: node.style.text.lineHeight,
      }) : undefined,
      fillTypes: Array.isArray(node.style?.fills) ? node.style.fills.map((paint) => paint?.type).filter(Boolean) : undefined,
    }),
    imageRefs: node.images?.map((image) => image.assetId || image.imageRef),
    childCount: node.children?.length ?? 0,
  })
}

function hasMeaningfulContainerName(node) {
  return MODULE_NAME_RE.test(node.name || '') || /容器|卡片|面板|按钮|列表|表单|内容|section|card|panel|button|list|form/i.test(node.name || '')
}

function byVisualOrder(a, b) {
  return (a.relativeBounds?.y ?? 0) - (b.relativeBounds?.y ?? 0)
    || (a.relativeBounds?.x ?? 0) - (b.relativeBounds?.x ?? 0)
}

function truncate(value, maxLength) {
  if (value === undefined || value === null) return value
  const text = String(value)
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function choosePreferredAssetPath(original, rendered) {
  const renderedPresent = rendered.find((item) => item.status === 'present' && item.path)
  if (renderedPresent) {
    return {
      kind: 'rendered-image',
      copiedPath: renderedPresent.path,
      assetId: renderedPresent.assetId,
      reason: 'Rendered slice is available and visually closest for MVP/testing.',
    }
  }
  if (original.status === 'present' && original.path) {
    return {
      kind: 'original-image',
      copiedPath: original.path,
      assetId: original.assetId,
      reason: 'Original image is available.',
    }
  }
  return {
    kind: 'missing',
    copiedPath: null,
    assetId: original.assetId,
    reason: 'No exported image path is available.',
  }
}

function collectAncestors(node, nodeById) {
  const ancestors = []
  let current = node
  const seen = new Set()
  while (current?.parentId && !seen.has(current.parentId)) {
    seen.add(current.parentId)
    const parent = nodeById.get(current.parentId)
    if (!parent) break
    ancestors.push(parent)
    current = parent
  }
  return ancestors
}

function isBackgroundDecorMaskNode(node) {
  return Boolean(node && BACKGROUND_DECOR_MASK_NAME_RE.test(String(node.name || '')))
}

function inferAssetUsage(asset, sourceNodes) {
  const names = sourceNodes.map((source) => source.sourceNodeName || '').join(' ')
  if (asset.usageHint === 'background-decor-mask' || sourceNodes.some((source) => source.usageHint === 'background-decor-mask')) return 'background-decor-mask'
  if (sourceNodes.some((source) => source.insideBackgroundDecorMask)) return 'background-decor-child'
  if (asset.usageHint === 'logo' || sourceNodes.some((source) => source.usageHint === 'logo')) return 'logo'
  if (asset.kind === 'node-slice') return 'logo'
  if (/logo|标志|品牌/i.test(names)) return 'logo'
  if (/bg|background|背景/i.test(names)) return 'background'
  if (/decor|decoration|装饰|波点|点阵|网格|dots?|grid|pattern/i.test(names)) return 'background-decor'
  if (/icon|图标/i.test(names)) return 'icon'
  if (/avatar|头像|image|图片/i.test(names)) return 'content-image'
  return asset.renderedAssets?.length > 0 ? 'rendered-visual' : 'image'
}

function buildNormalizationReport({ jobId, normalizedPayload, assetIndex, designTokens, fontAvailability, pageLayout }) {
  return [
    '# Phase 4 Normalization Report',
    '',
    `- jobId: ${jobId}`,
    `- normalized nodes: ${normalizedPayload.flatNodeCount}`,
    `- assets indexed: ${assetIndex.assets.length}`,
    `- layout modules: ${pageLayout.modules.length}`,
    `- warnings: ${normalizedPayload.warnings.length}`,
    '',
    '## Outputs',
    '',
    '- raw.normalized.json',
    '- source-texts.json',
    '- node-style-facts.json',
    '- asset-index.json',
    '- design-tokens.json',
    '- font-availability.json',
    '- missing-fonts.md',
    '- page-layout.json',
    '- ai-layout-context.json',
    '',
    '## Token Summary',
    '',
    `- colors: ${designTokens.tokens.colors.length}`,
    `- font sizes: ${designTokens.tokens.fontSizes.length}`,
    `- font families: ${designTokens.tokens.fontFamilies.length}`,
    `- fonts requiring package/install: ${fontAvailability.missingFonts.length}`,
    `- spacing values: ${designTokens.tokens.spacing.length}`,
    '',
    '## Warnings',
    '',
    ...(normalizedPayload.warnings.length > 0
      ? normalizedPayload.warnings.map((warning) => `- [${warning.code}] ${warning.message}`)
      : ['- none']),
    '',
  ].join('\n')
}

function buildPendingPageLayoutMarkdown() {
  return [
    '# Page Layout',
    '',
    '正式页面布局说明需要由 AI 布局分析模块生成。',
    '',
    '当前文件由 raw-layout-conversion 阶段创建，用于标记 AI 布局分析尚未完成。',
    '如果任务停在这里，说明 layout-analysis 阶段尚未完成或 AI 调用失败。',
    '',
  ].join('\n')
}

function collectPaintColors(paints, colors) {
  if (!Array.isArray(paints)) return
  for (const paint of paints) {
    if (paint?.type === 'SOLID') addToken(colors, colorToHex(paint.color, paint.alpha))
    if (typeof paint?.type === 'string' && paint.type.includes('GRADIENT')) {
      for (const stop of paint.gradientStops || []) addToken(colors, colorToHex(stop.color, stop.color?.a))
    }
  }
}

function collectTextTokens(text, fontSizes, fontFamilies, fontWeights) {
  if (!text) return
  addToken(fontSizes, text.fontSize)
  addToken(fontFamilies, text.fontFamily)
  addToken(fontWeights, text.fontWeight)
}

export function buildFontAvailabilityReport(flatNodes) {
  const usageByFamily = new Map()
  for (const node of flatNodes) {
    const text = node?.style?.text
    if (!text?.fontFamily) continue
    const family = String(text.fontFamily).trim()
    if (!family) continue
    const key = normalizeFontFamily(family)
    const usage = usageByFamily.get(key) ?? {
      family,
      usageCount: 0,
      styles: new Set(),
      weights: new Set(),
      sourceNodes: [],
    }
    usage.usageCount += 1
    if (text.fontStyle) usage.styles.add(String(text.fontStyle))
    if (text.fontWeight !== undefined && text.fontWeight !== null) usage.weights.add(String(text.fontWeight))
    usage.sourceNodes.push(compact({
      sourceNodeId: node.sourceNodeId ?? node.id,
      name: node.name,
      fontStyle: text.fontStyle,
      fontWeight: text.fontWeight,
    }))
    usageByFamily.set(key, usage)
  }

  const fonts = [...usageByFamily.entries()]
    .map(([key, usage]) => {
      const systemOrCommon = SYSTEM_FONT_FAMILIES.has(key)
      return {
        family: usage.family,
        status: systemOrCommon ? 'system-or-common' : 'requires-font-package',
        reason: systemOrCommon
          ? '系统或浏览器通用字体，HTML 可直接使用 fallback。'
          : '非系统通用字体；当前 workflow 不联网下载字体包，需要本机安装或在产物中嵌入字体文件。',
        usageCount: usage.usageCount,
        styles: [...usage.styles].sort(),
        weights: [...usage.weights].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)),
        sourceNodes: usage.sourceNodes.slice(0, 20),
      }
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'requires-font-package' ? -1 : 1
      return b.usageCount - a.usageCount || a.family.localeCompare(b.family)
    })

  return {
    version: VERSION.fontAvailability,
    generatedAt: new Date().toISOString(),
    strategy: 'static-family-check',
    note: '不尝试联网下载或探测操作系统字体文件；清单按设计稿字体族聚合，非系统通用字体统一标为需要安装或嵌入。',
    fonts,
    missingFonts: fonts.filter((font) => font.status === 'requires-font-package'),
  }
}

function buildMissingFontsMarkdown(report) {
  return [
    '# Missing Fonts',
    '',
    '当前 workflow 不自动联网下载字体包。以下字体不是系统/浏览器通用 fallback，建议确认授权后安装到本机或随 HTML 产物用 @font-face 嵌入。',
    '',
    ...(report.missingFonts.length > 0
      ? report.missingFonts.map((font) => [
        `## ${font.family}`,
        '',
        `- usageCount: ${font.usageCount}`,
        `- styles: ${font.styles.length > 0 ? font.styles.join(', ') : 'unknown'}`,
        `- weights: ${font.weights.length > 0 ? font.weights.join(', ') : 'unknown'}`,
        `- sourceNodes: ${font.sourceNodes.map((node) => node.sourceNodeId).join(', ') || 'unknown'}`,
        '',
      ].join('\n')).join('\n').split('\n')
      : ['- none']),
    '',
  ].join('\n')
}

function normalizeFontFamily(value) {
  return String(value).trim().replace(/^["']|["']$/g, '').toLowerCase()
}

function collectShadowTokens(effects, shadows) {
  if (!Array.isArray(effects)) return
  for (const effect of effects) {
    if (effect?.type && String(effect.type).includes('SHADOW')) {
      addToken(shadows, JSON.stringify(compact({ type: effect.type, color: colorToHex(effect.color, effect.color?.a), offset: effect.offset, radius: effect.radius, spread: effect.spread })))
    }
  }
}

function collectSpacingTokens(padding, spacings) {
  if (!padding) return
  addToken(spacings, padding.top)
  addToken(spacings, padding.right)
  addToken(spacings, padding.bottom)
  addToken(spacings, padding.left)
}

function collectSiblingGaps(flatNodes, spacings) {
  const byParent = new Map()
  for (const node of flatNodes) {
    if (!node.parentId || !node.visible || !node.relativeBounds) continue
    const values = byParent.get(node.parentId) ?? []
    values.push(node)
    byParent.set(node.parentId, values)
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.relativeBounds.y - b.relativeBounds.y)
    for (let index = 1; index < siblings.length; index += 1) {
      const prev = siblings[index - 1].relativeBounds
      const next = siblings[index].relativeBounds
      const gap = Math.round(next.y - (prev.y + prev.height))
      if (gap > 0 && gap < 320) addToken(spacings, gap)
    }
  }
}

function makeTokenList(map, type, nameFactory) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, 48)
    .map(([value, usageCount], index) => ({
      name: nameFactory(value, index),
      type,
      value,
      usageCount,
      confidence: type === 'color' ? 'medium' : 'high',
    }))
}

function inferColorTokenName(value, index) {
  const normalized = String(value).toLowerCase()
  if (normalized === '#ffffff' || normalized === '#fff') return 'color-background'
  if (normalized === '#000000' || normalized === '#000') return 'color-text-primary'
  if (index === 0) return 'color-primary-candidate'
  if (index === 1) return 'color-secondary-candidate'
  return `color-${index + 1}`
}

function inferFontSizeTokenName(value, index) {
  const size = Number(value)
  if (size >= 40) return 'font-size-heading-xl'
  if (size >= 28) return 'font-size-heading-lg'
  if (size >= 20) return 'font-size-heading-md'
  if (size >= 14) return 'font-size-body'
  return `font-size-${index + 1}`
}

function inferSpacingTokenName(value, index) {
  const size = Number(value)
  if (size >= 96) return 'space-section'
  if (size >= 32) return 'space-lg'
  if (size >= 16) return 'space-md'
  if (size >= 8) return 'space-sm'
  return `space-${index + 1}`
}

function inferRadiusTokenName(value, index) {
  const size = Number(value)
  if (size === 0) return 'radius-none'
  if (size <= 4) return 'radius-sm'
  if (size <= 8) return 'radius-md'
  if (size <= 16) return 'radius-lg'
  return `radius-${index + 1}`
}

function addToken(map, value) {
  if (value === undefined || value === null || value === '' || Number.isNaN(value)) return
  const key = typeof value === 'number' ? Math.round(value * 100) / 100 : String(value)
  map.set(key, (map.get(key) ?? 0) + 1)
}

function extractTextStyle(node) {
  const firstRun = Array.isArray(node.textRuns) ? node.textRuns[0] : null
  const fontName = firstRun?.fontName
  return compact({
    characters: typeof node.characters === 'string' ? preserveSourceText(node.characters) : undefined,
    fontFamily: typeof fontName?.family === 'string' ? fontName.family : undefined,
    fontStyle: typeof fontName?.style === 'string' ? fontName.style : undefined,
    fontSize: firstNumber(firstRun?.fontSize, node.fontSize),
    fontWeight: firstRun?.fontWeight,
    lineHeight: firstRun?.lineHeightByPx ?? firstRun?.lineHeight,
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
  })
}

function readPadding(node) {
  return compact({
    top: toNumber(node.paddingTop),
    right: toNumber(node.paddingRight),
    bottom: toNumber(node.paddingBottom),
    left: toNumber(node.paddingLeft),
  })
}

function toBounds(node) {
  const source = node?.absoluteBoundingBox && typeof node.absoluteBoundingBox === 'object'
    ? node.absoluteBoundingBox
    : node
  const x = toNumber(source?.x)
  const y = toNumber(source?.y)
  const width = toNumber(source?.width)
  const height = toNumber(source?.height)
  if ([x, y, width, height].some((value) => value === undefined)) return null
  return roundBounds({ x, y, width, height })
}

function fallbackRelativeBounds(node) {
  const x = toNumber(node?.x)
  const y = toNumber(node?.y)
  const width = toNumber(node?.width)
  const height = toNumber(node?.height)
  if ([x, y, width, height].some((value) => value === undefined)) return null
  return roundBounds({ x, y, width, height })
}

function offsetBounds(bounds, rootBounds) {
  return roundBounds({
    x: bounds.x - rootBounds.x,
    y: bounds.y - rootBounds.y,
    width: bounds.width,
    height: bounds.height,
  })
}

function unionBounds(a, b) {
  const left = Math.min(a.x, b.x)
  const top = Math.min(a.y, b.y)
  const right = Math.max(a.x + a.width, b.x + b.width)
  const bottom = Math.max(a.y + a.height, b.y + b.height)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function roundBounds(bounds) {
  if (!bounds) return null
  return {
    x: round(bounds.x),
    y: round(bounds.y),
    width: round(bounds.width),
    height: round(bounds.height),
  }
}

function round(value) {
  return Math.round(Number(value) * 100) / 100
}

function area(bounds) {
  return Math.max(0, Number(bounds?.width) || 0) * Math.max(0, Number(bounds?.height) || 0)
}

function sumArea(nodes) {
  return nodes.reduce((total, node) => total + area(node.relativeBounds), 0)
}

function looksLikeGrid(nodes) {
  const usable = nodes.filter((node) => node.visible && node.relativeBounds)
  if (usable.length < 4) return false
  const yBuckets = new Set(usable.map((node) => Math.round(node.relativeBounds.y / 24)))
  const xBuckets = new Set(usable.map((node) => Math.round(node.relativeBounds.x / 24)))
  return yBuckets.size >= 2 && xBuckets.size >= 2
}

function countVisualColumns(nodes, bounds) {
  if (!bounds) return 1
  const centers = nodes
    .filter((node) => node.relativeBounds && node.relativeBounds.width > 8 && node.relativeBounds.height > 8)
    .map((node) => node.relativeBounds.x + node.relativeBounds.width / 2)
    .sort((a, b) => a - b)
  if (centers.length < 2) return 1
  const left = centers.filter((x) => x < bounds.x + bounds.width * 0.45).length
  const right = centers.filter((x) => x > bounds.x + bounds.width * 0.55).length
  return left > 0 && right > 0 ? 2 : 1
}

function inferClusterName(nodes, index) {
  const named = nodes.find((node) => MODULE_NAME_RE.test(node.name || ''))
    ?? nodes.find((node) => node.role === 'text' && String(node.text || node.name || '').length <= 40)
    ?? nodes.find((node) => node.role === 'text' && String(node.text || node.name || '').length <= 80)
  return named?.name || `视觉分区 ${index + 1}`
}

export function preserveSourceText(value) {
  return String(value).replace(/\r\n?/g, '\n')
}

function colorToHex(color, alpha) {
  if (!color || typeof color !== 'object') return undefined
  const r = Math.round((Number(color.r) || 0) * 255)
  const g = Math.round((Number(color.g) || 0) * 255)
  const b = Math.round((Number(color.b) || 0) * 255)
  const a = alpha ?? color.a
  const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`
  return a !== undefined && Number(a) < 1 ? `${hex}${toHex(Math.round(Number(a) * 255))}` : hex
}

function toHex(value) {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')
}

function toNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function firstNumber(...values) {
  return values.map(toNumber).find((value) => value !== undefined)
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

function uniqueNumbers(values) {
  return [...new Set(values.map((value) => Math.round(value)).filter((value) => Number.isFinite(value)))].sort((a, b) => a - b)
}

function slugify(value) {
  return String(value || 'module').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'module'
}

function createWarning(code, sourceNodeId, message, severity = 'warning') {
  return compact({ code, sourceNodeId, message, severity })
}

function compact(input) {
  const output = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue
    output[key] = value
  }
  return output
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, payload) {
  writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8')
}
