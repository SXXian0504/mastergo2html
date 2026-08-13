import { createHash } from 'node:crypto'

const PROTOTYPE_VERSION = 'mastergo2html.html-prototype.v3'
const CONTAINER_TYPES = new Set(['FRAME', 'SECTION', 'GROUP', 'COMPONENT', 'INSTANCE'])
const SIMPLE_SHAPE_TYPES = new Set(['RECTANGLE', 'ELLIPSE', 'LINE', 'POLYGON', 'STAR'])
const UNSUPPORTED_TYPES = new Set(['BOOLEAN_OPERATION', 'VECTOR', 'PATH'])
const EXCLUDED_POLICIES = new Set(['review-only', 'forbidden-final'])
const REQUIRED_STYLE_FACT_KEYS = ['bindingRequired', 'textBindingRequired', 'compactSurfaceRequired', 'rasterEffect']

export function renderHtmlPrototype({
  normalizedRaw,
  layoutSketch,
  assetIndex = {},
  nodeStyleFacts = {},
  sourceTexts = {},
  fontAssets = {},
  inputHash = '',
} = {}) {
  const roots = Array.isArray(normalizedRaw?.nodes) ? normalizedRaw.nodes.filter(Boolean) : []
  const root = roots[0] || null
  if (!root) throw new Error('HTML prototype requires one normalized root Frame')
  const rootBounds = boundsOf(root)
  if (!rootBounds) throw new Error('HTML prototype root Frame is missing bounds')

  const state = createRenderState({ assetIndex, nodeStyleFacts, sourceTexts, layoutSketch })
  state.nodeCount = countNodes(roots)
  state.flowSkeletonEnabled = state.modules.some(moduleUsesFlowSkeleton)
  const renderedRoot = renderNode(root, null, state, { isRoot: true })
  const sourceContract = renderSourceContract(state)
  const body = [renderedRoot, sourceContract].filter(Boolean).join('\n')
  const fontCss = buildFontCss(fontAssets)
  const width = px(rootBounds.width)
  const height = px(rootBounds.height)
  const files = {
    indexHtml: [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '  <meta charset="utf-8">',
      '  <meta name="viewport" content="width=device-width, initial-scale=1">',
      `  <title>${escapeHtml(root.name || layoutSketch?.page?.name || 'MasterGo prototype')}</title>`,
      '  <link rel="stylesheet" href="styles.css">',
      '</head>',
      '<body>',
      body,
      '  <script src="script.js"></script>',
      '</body>',
      '</html>',
      '',
    ].join('\n'),
    stylesCss: [
      '*,*::before,*::after{box-sizing:border-box}',
      'html,body{margin:0;min-height:100%;letter-spacing:0}',
      'body{background:#f2f3f5;color:#111;font-family:Arial,"PingFang SC","Microsoft YaHei",sans-serif;overflow:auto}',
      'img{display:block}',
      '.visually-hidden{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}',
      '.mg-source-contract{position:absolute!important;width:1px!important;height:1px!important;overflow:hidden!important;clip-path:inset(50%)!important;contain:size layout paint!important;pointer-events:none!important}',
      `.mg-prototype-root{position:relative;width:${width};height:${height};min-width:${width};min-height:${height};margin:0 auto;overflow:hidden;isolation:isolate;background:#fff}`,
      `.mg-prototype-root.mg-flow-skeleton{width:100%;max-width:${width};height:auto;min-width:0;min-height:100vh}`,
      '.mg-module{position:absolute;isolation:isolate}',
      '.mg-module[data-layout-mode="flow"]{position:relative}',
      '.mg-node{position:absolute;transform-origin:center center}',
      '.mg-flow-collection{position:absolute;display:grid;align-content:start}',
      '.mg-flow-item{position:relative}',
      '.mg-auto-layout{display:flex}',
      '.mg-placeholder{background:transparent}',
      '.mg-asset{object-fit:contain}',
      '.mg-prototype-root :where(h1,h2,h3,h4,h5,h6,p,figure){margin:0}',
      fontCss,
      '',
    ].filter(Boolean).join('\n'),
    scriptJs: 'document.documentElement.dataset.mastergoPrototypeReady = "true";\n',
  }
  const prototypeManifest = {
    version: PROTOTYPE_VERSION,
    inputHash,
    rootFrame: {
      sourceNodeId: sourceId(root),
      name: root.name || '',
      width: number(rootBounds.width),
      height: number(rootBounds.height),
    },
    layoutSketchVersion: layoutSketch?.version || null,
    nodeCount: state.nodeCount,
    renderedNodeCount: state.renderedNodeCount,
    compositeReplacementCount: state.compositeReplacementCount,
    moduleCoverage: buildModuleCoverage(state),
    flowSkeleton: buildFlowSkeletonCoverage(state),
    heroForegroundPromotions: state.heroForegroundPromotions,
    renderedSliceGeometry: buildRenderedSliceGeometryCoverage(state),
    prototypeSafety: buildPrototypeSafety(state),
    skippedNodes: state.skippedNodes,
    missingAssets: state.missingAssets,
    degradations: state.degradations,
    warnings: state.warnings,
    textCoverage: buildTextCoverage(state),
    styleBindingCoverage: buildStyleBindingCoverage(state),
    files: Object.fromEntries(Object.entries(files).map(([key, value]) => [key, {
      sizeBytes: Buffer.byteLength(value),
      sha256: createHash('sha256').update(value).digest('hex'),
    }])),
  }
  return { files, prototypeManifest }
}

function createRenderState({ assetIndex, nodeStyleFacts, sourceTexts, layoutSketch }) {
  const assets = assetIndex?.assets || []
  const assetBySourceNode = new Map()
  const assetById = new Map()
  const assetByImageRef = new Map()
  for (const asset of assets) {
    if (asset?.assetId) assetById.set(String(asset.assetId), asset)
    if (asset?.imageRef) assetByImageRef.set(String(asset.imageRef), asset)
    for (const source of asset?.sourceNodes || []) {
      const id = String(source?.sourceNodeId || source?.nodeId || '')
      if (id && !assetBySourceNode.has(id)) assetBySourceNode.set(id, asset)
    }
  }
  const styleFacts = new Map((nodeStyleFacts?.facts || []).map((fact) => [String(fact?.sourceNodeId || ''), fact]))
  const textMap = new Map()
  for (const item of (Array.isArray(sourceTexts) ? sourceTexts : sourceTexts?.texts || sourceTexts?.items || sourceTexts?.entries || [])) {
    const id = String(item?.sourceNodeId || item?.nodeId || item?.id || '')
    if (id) textMap.set(id, String(item?.text ?? item?.characters ?? ''))
  }
  return {
    assetBySourceNode,
    assetById,
    assetByImageRef,
    styleFacts,
    textMap,
    renderedTextIds: new Set(),
    textBindingIds: new Set(),
    styleBindingIds: new Set(),
    contractTextIds: new Set(),
    modules: normalizeModules(layoutSketch?.modules),
    globalDecorationIds: new Set((layoutSketch?.globalDecorations || []).map((item) => String(item?.sourceNodeId || '')).filter(Boolean)),
    renderedModuleIds: new Set(),
    renderedSliceIds: new Set(),
    renderedSliceGeometryIds: new Set(),
    renderedSliceGeometryErrors: [],
    safetyErrors: [],
    reviewItemKeys: new Set(),
    heroForegroundPromotions: [],
    flowSkeletonEnabled: false,
    flowModuleIds: new Set(),
    absoluteModuleIds: new Set(),
    flowCollections: [],
    autoLayoutNodeIds: new Set(),
    nodeCount: 0,
    renderedNodeCount: 0,
    compositeReplacementCount: 0,
    skippedNodes: [],
    missingAssets: [],
    degradations: [],
    warnings: [],
  }
}

function renderNode(node, positionedParent, state, options = {}) {
  if (!node || node.visible === false) return ''
  const id = sourceId(node)
  const nodeBounds = boundsOf(node)
  const isContainer = CONTAINER_TYPES.has(String(node.type || '').toUpperCase())
  if (!nodeBounds) {
    if (!isContainer) {
      state.skippedNodes.push({ sourceNodeId: id, reason: 'missing-bounds' })
      state.warnings.push(`Skipped leaf ${id || node.name || 'unknown'} because it has no bounds.`)
      if (String(node.type || '').toUpperCase() === 'TEXT' && state.textMap.has(id)) {
        state.contractTextIds.add(id)
        state.degradations.push({ sourceNodeId: id, reason: 'text-preserved-in-source-contract-missing-bounds' })
      }
      return ''
    }
    state.degradations.push({ sourceNodeId: id, reason: 'promoted-children-from-unpositioned-container' })
    return orderedChildren(node).map((child) => renderNode(child, positionedParent, state)).join('\n')
  }

  const indexedAsset = resolveAsset(node, state)
  const policy = indexedAsset?.renderPolicy || null
  const asset = EXCLUDED_POLICIES.has(policy) ? null : indexedAsset
  if (indexedAsset && !asset) state.degradations.push({ sourceNodeId: id, assetId: indexedAsset.assetId || null, reason: `${policy}-asset-suppressed` })
  const requiredComposite = policy === 'required-final' && Boolean(assetPath(asset))
  const autoLayout = !options.isRoot && isExplicitAutoLayout(node)
  const classes = [
    options.isRoot ? 'mg-prototype-root' : 'mg-node',
    options.isRoot && state.flowSkeletonEnabled ? 'mg-flow-skeleton' : '',
    options.flowItem ? 'mg-flow-item' : '',
    autoLayout ? 'mg-auto-layout' : '',
    requiredComposite ? 'mg-asset' : '',
  ].filter(Boolean)
  const attributes = [
    `class="${classes.join(' ')}"`,
    `data-source-node-id="${escapeAttribute(id)}"`,
    `data-source-node-type="${escapeAttribute(node.type || 'UNKNOWN')}"`,
  ]
  const globalDecoration = state.globalDecorationIds.has(id)
  if (globalDecoration) attributes.push('data-global-decoration="true"')
  if (state.styleFacts.has(id)) {
    attributes.push(`data-style-source-node-id="${escapeAttribute(id)}"`)
    state.styleBindingIds.add(id)
  }
  if (indexedAsset?.assetId) attributes.push(`data-asset-id="${escapeAttribute(indexedAsset.assetId)}"`)
  const renderedAssetBounds = requiredComposite ? renderedCanvasBounds(asset) : null
  const style = buildInlineStyle(node, positionedParent, state.styleFacts.get(id), {
    ...options,
    autoLayout,
    globalDecoration,
    renderedAssetBounds,
    renderedComposite: requiredComposite,
  })
  if (style) attributes.push(`style="${escapeAttribute(style)}"`)

  if (requiredComposite) {
    state.renderedNodeCount += 1
    state.compositeReplacementCount += 1
    if (asset?.croppingPolicy === 'preserve-rendered-slice') {
      state.renderedSliceIds.add(String(asset.assetId || id))
      if (renderedAssetBounds) state.renderedSliceGeometryIds.add(String(asset.assetId || id))
      else state.renderedSliceGeometryErrors.push({ assetId: asset.assetId || null, sourceNodeId: id, reason: 'missing-rendered-canvas-bounds' })
    }
    recordCompositeSemanticReview(node, state)
    const path = assetPath(asset)
    const hiddenBindings = renderHiddenDescendantBindings(node, state)
    return `<div ${attributes.join(' ')}><img class="mg-asset" src="${escapeAttribute(path)}" alt="" data-source-node-id="${escapeAttribute(id)}" data-asset-id="${escapeAttribute(asset.assetId || '')}" style="width:100%;height:100%;object-fit:fill">${hiddenBindings}</div>`
  }

  const type = String(node.type || '').toUpperCase()
  if (type === 'TEXT') {
    state.renderedNodeCount += 1
    state.renderedTextIds.add(id)
    state.textBindingIds.add(id)
    attributes.push(`data-text-source-node-id="${escapeAttribute(id)}"`)
    return `<div ${attributes.join(' ')}>${escapeHtml(exactText(node, state))}</div>`
  }

  if (asset && assetPath(asset) && policy !== 'css-preferred') {
    state.renderedNodeCount += 1
    if (isContainer) {
      const hiddenBindings = renderHiddenDescendantBindings(node, state)
      return `<div ${attributes.join(' ')}><img class="mg-asset" src="${escapeAttribute(assetPath(asset))}" alt="" style="width:100%;height:100%;object-fit:fill">${hiddenBindings}</div>`
    }
    return `<img ${attributes.join(' ')} src="${escapeAttribute(assetPath(asset))}" alt="">`
  }

  const hasImageIntent = (node.images || []).length > 0
  if (hasImageIntent && !assetPath(asset) && !EXCLUDED_POLICIES.has(policy)) {
    state.missingAssets.push({ sourceNodeId: id, assetId: indexedAsset?.assetId || null, imageRef: node.images?.[0]?.imageRef || null })
    state.warnings.push(`Missing indexed asset for image node ${id}.`)
  }
  const unsupported = UNSUPPORTED_TYPES.has(type) || hasComplexVisual(node)
  if (unsupported && !isContainer && !SIMPLE_SHAPE_TYPES.has(type)) {
    state.renderedNodeCount += 1
    state.degradations.push({ sourceNodeId: id, reason: 'unsupported-complex-visual-placeholder' })
    return `<div ${attributes.join(' ')} aria-hidden="true"></div>`
  }

  state.renderedNodeCount += 1
  if (autoLayout) state.autoLayoutNodeIds.add(id)
  const children = options.isRoot
    ? renderRootChildren(node, state)
    : renderPositionedChildren(node, state, { autoLayout })
  const tag = type === 'SECTION' ? 'section' : 'div'
  return `<${tag} ${attributes.join(' ')}>${children}</${tag}>`
}

function recordCompositeSemanticReview(node, state) {
  const id = sourceId(node)
  const module = state.modules.find((item) => item.sourceNodeIds.has(id))
  if (module?.type !== 'header' || collectTextNodes(node).length === 0) return
  const key = `${module.moduleId}:semantic-navigation`
  if (state.reviewItemKeys.has(key)) return
  state.reviewItemKeys.add(key)
  state.degradations.push({
    moduleId: module.moduleId,
    sourceNodeId: id,
    reason: 'semantic-navigation-reconstruction-required',
  })
  state.warnings.push(`Header module ${module.moduleId} is a composite preview; Agent must replace its navigation labels and controls with visible semantic DOM.`)
}

function renderRootChildren(root, state) {
  const children = orderedChildren(root)
  if (state.modules.length === 0) return children.map((child) => renderNode(child, root, state)).filter(Boolean).join('\n')
  const moduleByRootChildId = new Map()
  for (const module of state.modules) {
    for (const child of children) {
      if (module.sourceNodeIds.has(sourceId(child))) moduleByRootChildId.set(sourceId(child), module)
    }
  }
  for (const child of children) {
    if (moduleByRootChildId.has(sourceId(child))) continue
    if (containsGlobalDecoration(child, state.globalDecorationIds)) continue
    const module = findSpatialModule(child, state.modules)
    if (module) moduleByRootChildId.set(sourceId(child), module)
  }
  // MasterGo commonly stores hero overlays (headline artwork, search, carousel controls)
  // as root siblings instead of descendants of the banner group. Layout clustering can then
  // place them in a broad content module underneath the hero bitmap. Spatial containment and
  // source draw order are the reliable facts for restoring that foreground ownership.
  for (const child of children) {
    const current = moduleByRootChildId.get(sourceId(child))
    if (!current || !['content-section', 'main', 'content'].includes(current.type)) continue
    const hero = findForegroundHeroModule(child, state.modules)
    if (hero) {
      moduleByRootChildId.set(sourceId(child), hero)
      state.heroForegroundPromotions.push({
        sourceNodeId: sourceId(child),
        fromModuleId: current.moduleId,
        heroModuleId: hero.moduleId,
      })
    }
  }
  const output = children
    .filter((child) => !moduleByRootChildId.has(sourceId(child)))
    .map((child) => renderNode(child, root, state))
  const moduleEntries = state.modules.map((module) => ({
    module,
    children: children.filter((candidate) => moduleByRootChildId.get(sourceId(candidate))?.moduleId === module.moduleId),
  })).filter((entry) => entry.children.length > 0)
  const absoluteEntries = moduleEntries.filter((entry) => !moduleUsesFlowSkeleton(entry.module))
  const flowEntries = moduleEntries.filter((entry) => moduleUsesFlowSkeleton(entry.module)).sort(compareFlowModules)

  for (const entry of absoluteEntries) output.push(renderModule(entry.module, entry.children, state, null))
  let flowCursorY = 0
  for (const entry of flowEntries) {
    output.push(renderModule(entry.module, entry.children, state, flowCursorY))
    flowCursorY = entry.module.bounds.y + entry.module.bounds.height
  }
  return output.filter(Boolean).join('\n')
}

function renderModule(module, children, state, flowCursorY) {
  const flow = flowCursorY !== null
  state.renderedModuleIds.add(module.moduleId)
  if (flow) state.flowModuleIds.add(module.moduleId)
  else state.absoluteModuleIds.add(module.moduleId)
  const moduleChildren = renderChildCollection(children, module.positioningNode, state)
  const tag = moduleTag(module.type)
  const mode = flow ? 'flow' : 'absolute'
  const style = flow ? buildFlowModuleStyle(module, flowCursorY) : buildAbsoluteModuleStyle(module)
  return `<${tag} class="mg-module" data-module-id="${escapeAttribute(module.moduleId)}" data-module-type="${escapeAttribute(module.type)}" data-layout-mode="${mode}" style="${escapeAttribute(style)}">${moduleChildren}</${tag}>`
}

function buildAbsoluteModuleStyle(module) {
  return `left:${px(module.bounds.x)};top:${px(module.bounds.y)};width:${px(module.bounds.width)};height:${px(module.bounds.height)};z-index:${module.sourceDrawOrder}`
}

function buildFlowModuleStyle(module, flowCursorY) {
  const marginTop = number(module.bounds.y) - number(flowCursorY)
  const width = px(module.bounds.width)
  const left = px(Math.max(0, module.bounds.x))
  return `margin-top:${px(marginTop)};margin-left:max(0px,min(${left},calc(100% - min(${width},100%))));width:min(${width},100%);height:${px(module.bounds.height)};z-index:${module.sourceDrawOrder}`
}

function compareFlowModules(left, right) {
  const leftModule = left.module || left
  const rightModule = right.module || right
  return number(leftModule.bounds.y) - number(rightModule.bounds.y)
    || moduleFlowPriority(leftModule.type) - moduleFlowPriority(rightModule.type)
    || leftModule.sourceDrawOrder - rightModule.sourceDrawOrder
}

function moduleFlowPriority(type) {
  if (type === 'header') return 0
  if (type === 'footer') return 3
  return 2
}

function moduleUsesFlowSkeleton(module) {
  return module?.positionStrategy !== 'absolute' && module?.riskLevel !== 'high'
}

function renderPositionedChildren(node, state, { autoLayout = false } = {}) {
  const children = orderedChildren(node)
  if (!autoLayout) return renderChildCollection(children, node, state)
  return children.map((child) => renderNode(child, node, state, {
    flowItem: child?.layout?.htmlPosition !== 'absolute',
    flowItemFill: false,
  })).filter(Boolean).join('\n')
}

function renderChildCollection(children, positionedParent, state) {
  const collections = detectRepeatedFlowCollections(children)
  if (collections.length === 0) return children.map((child) => renderNode(child, positionedParent, state)).filter(Boolean).join('\n')
  const collectionByNodeId = new Map(collections.flatMap((collection) => collection.nodes.map((node) => [sourceId(node), collection])))
  const renderedCollections = new Set()
  const output = []
  for (const child of children) {
    const collection = collectionByNodeId.get(sourceId(child))
    if (!collection) {
      output.push(renderNode(child, positionedParent, state))
      continue
    }
    if (renderedCollections.has(collection.id)) continue
    renderedCollections.add(collection.id)
    state.flowCollections.push({
      collectionId: collection.id,
      axis: collection.axis,
      sourceNodeIds: collection.nodes.map(sourceId),
    })
    const parentBounds = boundsOf(positionedParent)
    const left = collection.bounds.x - number(parentBounds?.x)
    const top = collection.bounds.y - number(parentBounds?.y)
    const items = collection.nodes.map((node) => renderNode(node, node, state, { flowItem: true, flowItemFill: true })).filter(Boolean).join('\n')
    const style = `left:${px(left)};top:${px(top)};width:${px(collection.bounds.width)};height:${px(collection.bounds.height)};grid-template-columns:${collection.axis === 'vertical' ? 'minmax(0,1fr)' : `repeat(${collection.nodes.length},minmax(0,1fr))`};gap:${px(collection.gap)}`
    output.push(`<div class="mg-flow-collection" data-layout-skeleton="repeated-list" data-layout-axis="${collection.axis}" style="${escapeAttribute(style)}">${items}</div>`)
  }
  return output.filter(Boolean).join('\n')
}

function findForegroundHeroModule(node, modules) {
  const bounds = boundsOf(node)
  const sourceOrder = finite(node?.sourceOrder)
  if (!bounds || sourceOrder === null) return null
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  return modules
    .filter((module) => module.type === 'hero'
      && sourceOrder > module.sourceDrawOrder
      && center.x >= module.bounds.x
      && center.x <= module.bounds.x + module.bounds.width
      && center.y >= module.bounds.y
      && center.y <= module.bounds.y + module.bounds.height)
    .sort((a, b) => (a.bounds.width * a.bounds.height) - (b.bounds.width * b.bounds.height))[0] || null
}

function moduleTag(type) {
  if (type === 'header') return 'header'
  if (type === 'footer') return 'footer'
  if (['content-section', 'main', 'content'].includes(type)) return 'main'
  return 'section'
}

function findSpatialModule(node, modules) {
  const bounds = boundsOf(node)
  if (!bounds) return null
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  const candidates = modules.filter((module) => (
    center.x >= module.bounds.x
    && center.x <= module.bounds.x + module.bounds.width
    && center.y >= module.bounds.y
    && center.y <= module.bounds.y + module.bounds.height
  ))
  return candidates.sort((a, b) => (a.bounds.width * a.bounds.height) - (b.bounds.width * b.bounds.height))[0] || null
}

function containsGlobalDecoration(node, globalDecorationIds) {
  if (globalDecorationIds.has(sourceId(node))) return true
  return (node?.children || []).some((child) => containsGlobalDecoration(child, globalDecorationIds))
}

function renderSourceContract(state) {
  const ids = [...state.contractTextIds].filter((id) => !state.textBindingIds.has(id)).sort()
  if (ids.length === 0) return ''
  const children = ids.map((id) => {
    state.renderedTextIds.add(id)
    state.textBindingIds.add(id)
    const styleBinding = state.styleFacts.has(id)
      ? ` data-style-source-node-id="${escapeAttribute(id)}"`
      : ''
    if (styleBinding) state.styleBindingIds.add(id)
    return `<span data-source-node-id="${escapeAttribute(id)}" data-text-source-node-id="${escapeAttribute(id)}"${styleBinding}>${escapeHtml(state.textMap.get(id))}</span>`
  }).join('')
  return `<div class="mg-source-contract" aria-hidden="true">${children}</div>`
}

function buildTextCoverage(state) {
  const requiredIds = [...state.textMap.entries()].filter(([, text]) => text.length > 0).map(([id]) => id).sort()
  return {
    required: requiredIds.length,
    rendered: requiredIds.filter((id) => state.renderedTextIds.has(id)).length,
    bound: requiredIds.filter((id) => state.textBindingIds.has(id)).length,
    contract: requiredIds.filter((id) => state.contractTextIds.has(id)).length,
    missingSourceNodeIds: requiredIds.filter((id) => !state.textBindingIds.has(id)),
  }
}

function buildStyleBindingCoverage(state) {
  const requiredIds = [...state.styleFacts.entries()]
    .filter(([, fact]) => REQUIRED_STYLE_FACT_KEYS.some((key) => Boolean(fact?.[key])))
    .map(([id]) => id)
    .filter(Boolean)
    .sort()
  return {
    required: requiredIds.length,
    bound: requiredIds.filter((id) => state.styleBindingIds.has(id)).length,
    missingSourceNodeIds: requiredIds.filter((id) => !state.styleBindingIds.has(id)),
  }
}

function buildModuleCoverage(state) {
  const requiredIds = state.modules.map((module) => module.moduleId)
  return {
    required: requiredIds.length,
    rendered: requiredIds.filter((id) => state.renderedModuleIds.has(id)).length,
    missingModuleIds: requiredIds.filter((id) => !state.renderedModuleIds.has(id)),
  }
}

function buildFlowSkeletonCoverage(state) {
  return {
    enabled: state.flowSkeletonEnabled,
    flowModuleIds: [...state.flowModuleIds].sort(),
    absoluteFallbackModuleIds: [...state.absoluteModuleIds].sort(),
    repeatedCollections: state.flowCollections,
    autoLayoutNodeIds: [...state.autoLayoutNodeIds].sort(),
  }
}

function buildRenderedSliceGeometryCoverage(state) {
  const requiredIds = [...state.renderedSliceIds].sort()
  return {
    required: requiredIds.length,
    applied: requiredIds.filter((id) => state.renderedSliceGeometryIds.has(id)).length,
    missingAssetIds: requiredIds.filter((id) => !state.renderedSliceGeometryIds.has(id)),
    errors: state.renderedSliceGeometryErrors,
  }
}

function buildPrototypeSafety(state) {
  const errors = [
    ...state.safetyErrors,
    ...state.renderedSliceGeometryErrors.map((item) => `Rendered slice geometry is missing: ${item.assetId || item.sourceNodeId}`),
  ]
  return { ok: errors.length === 0, errors }
}

function buildInlineStyle(node, parent, fact, {
  isRoot = false,
  flowItem = false,
  flowItemFill = false,
  autoLayout = false,
  globalDecoration = false,
  renderedAssetBounds = null,
  renderedComposite = false,
} = {}) {
  const sourceBounds = boundsOf(node)
  const parentBounds = boundsOf(parent)
  const bounds = renderedAssetBounds || normalizedLineBounds(node) || sourceBounds
  const declarations = []
  if (!isRoot) {
    if (!flowItem) {
      declarations.push(`left:${px(number(bounds.x) - number(parentBounds?.x))}`)
      declarations.push(`top:${px(number(bounds.y) - number(parentBounds?.y))}`)
    }
    declarations.push(`width:${flowItemFill ? '100%' : px(bounds.width)}`)
    declarations.push(`height:${px(bounds.height)}`)
  }
  if (autoLayout) declarations.push(...autoLayoutDeclarations(node))
  const inferredGlowClipRadius = renderedComposite ? null : containedGlowClipRadius(node)
  if ((node.clipsContent || inferredGlowClipRadius !== null) && !renderedComposite) declarations.push('overflow:hidden')
  const opacity = finite(node?.style?.opacity)
  if (opacity !== null && opacity !== 1) declarations.push(`opacity:${trim(opacity)}`)
  const rotation = renderedComposite || normalizedLineBounds(node) ? 0 : finite(node.rotation)
  if (rotation !== null && rotation !== 0) declarations.push(`transform:rotate(${trim(rotation)}deg)`)
  if (renderedComposite) {
    declarations.push(`z-index:${Number(node.sourceOrder || 0)}`)
    return declarations.join(';')
  }
  const sourceRadius = finite(node?.style?.cornerRadius ?? fact?.cornerRadius)
  const radius = sourceRadius !== null && sourceRadius > 0 ? sourceRadius : inferredGlowClipRadius
  if (radius !== null && radius > 0) declarations.push(`border-radius:${px(radius)}`)
  const type = String(node.type || '').toUpperCase()
  const background = globalDecoration ? serializeSafeBackgroundStack(node?.style?.fills) : null
  const fill = firstSolidPaint(node?.style?.fills)
  if (type !== 'TEXT' && background) declarations.push(`background:${background}`)
  else if (fill && type !== 'TEXT') declarations.push(`background:${paintColor(fill)}`)
  const stroke = firstSolidPaint(node?.style?.strokes)
  if (stroke) declarations.push(`border:${px(node?.style?.strokeWeight || 1)} solid ${paintColor(stroke)}`)
  const shadow = firstShadow(node?.style?.effects)
  if (shadow) declarations.push(`box-shadow:${shadow}`)
  const backgroundBlur = firstBackgroundBlur(node?.style?.effects)
  if (backgroundBlur !== null && backgroundBlur > 0) {
    declarations.push(`backdrop-filter:blur(${px(backgroundBlur)})`)
    declarations.push(`-webkit-backdrop-filter:blur(${px(backgroundBlur)})`)
  }
  if (type === 'ELLIPSE') declarations.push('border-radius:50%')
  if (isLineLike(node)) {
    declarations.push('background:transparent')
    declarations.push(`border:0;border-left:${px(node?.style?.strokeWeight || 1)} solid ${paintColor(stroke || {})}`)
  }
  if (type === 'TEXT') {
    const text = node?.style?.text || fact?.typography || {}
    const family = text.fontFamily || text.family
    if (family) declarations.push(`font-family:${quoteCss(family)},Arial,sans-serif`)
    if (finite(text.fontSize) !== null) declarations.push(`font-size:${px(text.fontSize)}`)
    if (text.fontWeight !== undefined) declarations.push(`font-weight:${escapeCssValue(text.fontWeight)}`)
    if (finite(text.lineHeightPx ?? text.lineHeight) !== null) declarations.push(`line-height:${px(text.lineHeightPx ?? text.lineHeight)}`)
    if (text.textAlignHorizontal) declarations.push(`text-align:${String(text.textAlignHorizontal).toLowerCase()}`)
    const textFill = firstSolidPaint(node?.style?.fills)
    if (textFill) declarations.push(`color:${paintColor(textFill)}`)
    declarations.push('white-space:pre-wrap')
    declarations.push('overflow-wrap:normal')
    if (fact?.singleLineRequired === true) declarations.push('white-space:pre')
  }
  declarations.push(`z-index:${Number(node.sourceOrder || 0)}`)
  return declarations.join(';')
}

function normalizeModules(modules) {
  return (modules || []).flatMap((module) => {
    const bounds = validBounds(module?.bounds || module?.container?.bounds)
    if (!module?.moduleId || !bounds) return []
    return [{
      moduleId: String(module.moduleId),
      type: String(module.type || 'section'),
      bounds,
      positioningNode: { relativeBounds: bounds },
      sourceDrawOrder: Number(module.sourceDrawOrder || 0),
      layoutStrategy: String(module.layoutStrategy || 'absolute'),
      positionStrategy: String(module.positionStrategy || 'absolute'),
      riskLevel: String(module.riskLevel || 'medium'),
      sourceNodeIds: new Set((module.sourceNodeIds || []).map(String)),
    }]
  })
}

function isExplicitAutoLayout(node) {
  const mode = String(node?.layout?.sourceFlexMode || '').toUpperCase()
  return mode !== '' && mode !== 'NONE'
}

function autoLayoutDeclarations(node) {
  const layout = node?.layout || {}
  const mode = String(layout.sourceFlexMode || '').toUpperCase()
  const declarations = [`flex-direction:${mode === 'HORIZONTAL' ? 'row' : 'column'}`]
  if (String(layout.sourceFlexWrap || '').toUpperCase() === 'WRAP') declarations.push('flex-wrap:wrap')
  if (finite(layout.itemSpacing) !== null) declarations.push(`gap:${px(layout.itemSpacing)}`)
  const padding = layout.padding || {}
  if ([padding.top, padding.right, padding.bottom, padding.left].every((value) => finite(value) !== null)) {
    declarations.push(`padding:${px(padding.top)} ${px(padding.right)} ${px(padding.bottom)} ${px(padding.left)}`)
  }
  return declarations
}

function detectRepeatedFlowCollections(children) {
  const candidates = children.filter((node) => isRepeatableContainer(node) && boundsOf(node))
  const groups = new Map()
  for (const node of candidates) {
    const bounds = boundsOf(node)
    const key = [
      String(node.type || '').toUpperCase(),
      normalizedRepeatName(node.name),
      repeatStructureSignature(node),
      Math.round(bounds.width / 4),
      Math.round(bounds.height / 4),
    ].join(':')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(node)
  }
  const collections = []
  for (const nodes of groups.values()) {
    if (nodes.length < 3) continue
    const vertical = buildRepeatedCollection(nodes, 'vertical')
    const horizontal = buildRepeatedCollection(nodes, 'horizontal')
    const collection = [vertical, horizontal].filter(Boolean).sort((a, b) => b.confidence - a.confidence)[0]
    if (collection) collections.push(collection)
  }
  return collections.sort((left, right) => left.bounds.y - right.bounds.y || left.bounds.x - right.bounds.x)
}

function buildRepeatedCollection(nodes, axis) {
  const vertical = axis === 'vertical'
  const sorted = [...nodes].sort((left, right) => {
    const leftBounds = boundsOf(left)
    const rightBounds = boundsOf(right)
    return vertical
      ? leftBounds.y - rightBounds.y || leftBounds.x - rightBounds.x
      : leftBounds.x - rightBounds.x || leftBounds.y - rightBounds.y
  })
  const first = boundsOf(sorted[0])
  const crossStarts = sorted.map((node) => vertical ? boundsOf(node).x : boundsOf(node).y)
  const crossSizes = sorted.map((node) => vertical ? boundsOf(node).width : boundsOf(node).height)
  const aligned = spread(crossStarts) <= 4 && spread(crossSizes) <= 4
  if (!aligned) return null
  const gaps = []
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = boundsOf(sorted[index - 1])
    const current = boundsOf(sorted[index])
    const gap = vertical
      ? current.y - (previous.y + previous.height)
      : current.x - (previous.x + previous.width)
    if (gap < 0) return null
    gaps.push(gap)
  }
  if (gaps.length === 0 || spread(gaps) > 4) return null
  const bounds = sorted.map(boundsOf).reduce(unionBounds)
  return {
    id: `repeat:${sourceId(sorted[0])}`,
    axis,
    nodes: sorted,
    bounds,
    gap: average(gaps),
    confidence: 1 - Math.min(0.5, (spread(crossStarts) + spread(gaps)) / 100),
  }
}

function isRepeatableContainer(node) {
  const type = String(node?.type || '').toUpperCase()
  return CONTAINER_TYPES.has(type)
    && (node.children || []).length > 0
    && !Boolean(node?.maskType || node?.isMask)
    && Math.abs(number(node.rotation)) <= 0.01
}

function normalizedRepeatName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\d\s_\-]+/g, '')
    .slice(0, 48)
}

function repeatStructureSignature(node) {
  const counts = new Map()
  const visit = (value, depth) => {
    if (depth > 3) return
    const type = String(value?.type || 'UNKNOWN').toUpperCase()
    counts.set(type, (counts.get(type) || 0) + 1)
    for (const child of value?.children || []) visit(child, depth + 1)
  }
  visit(node, 0)
  return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([type, count]) => `${type}${count}`).join('-')
}

function spread(values) {
  const usable = values.filter((value) => finite(value) !== null).map(number)
  return usable.length === 0 ? Infinity : Math.max(...usable) - Math.min(...usable)
}

function average(values) {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + number(value), 0) / values.length
}

function unionBounds(left, right) {
  const x = Math.min(number(left.x), number(right.x))
  const y = Math.min(number(left.y), number(right.y))
  const maxX = Math.max(number(left.x) + number(left.width), number(right.x) + number(right.width))
  const maxY = Math.max(number(left.y) + number(left.height), number(right.y) + number(right.height))
  return { x, y, width: maxX - x, height: maxY - y }
}

function renderedCanvasBounds(asset) {
  if (asset?.croppingPolicy !== 'preserve-rendered-slice') return null
  const source = asset?.sourceNodes?.[0] || {}
  const bounds = validBounds(asset?.renderedBounds || source?.renderBounds || source?.clippedRenderBounds)
  if (!bounds) return null
  const width = finite(asset?.preferred?.width) ?? finite(asset?.rendered?.[0]?.width) ?? bounds.width
  const height = finite(asset?.preferred?.height) ?? finite(asset?.rendered?.[0]?.height) ?? bounds.height
  return { x: bounds.x, y: bounds.y, width, height }
}

function normalizedLineBounds(node) {
  if (!isLineLike(node)) return null
  const bounds = boundsOf(node)
  const rotation = Math.abs(finite(node.rotation) || 0) % 180
  if (!bounds || bounds.height > 1 || Math.abs(rotation - 90) > 0.01) return null
  return { x: bounds.x, y: bounds.y, width: Math.max(1, number(node?.style?.strokeWeight) || 1), height: bounds.width }
}

function isLineLike(node) {
  return ['LINE', 'PEN'].includes(String(node?.type || '').toUpperCase()) && boundsOf(node)?.height <= 1
}

function validBounds(value) {
  if (!value || [value.x, value.y, value.width, value.height].some((item) => finite(item) === null)) return null
  return { x: number(value.x), y: number(value.y), width: number(value.width), height: number(value.height) }
}

function resolveAsset(node, state) {
  const id = sourceId(node)
  if (state.assetBySourceNode.has(id)) return state.assetBySourceNode.get(id)
  for (const image of node.images || []) {
    if (image?.assetId && state.assetById.has(String(image.assetId))) return state.assetById.get(String(image.assetId))
  }
  for (const image of node.images || []) {
    if (image?.imageRef && state.assetByImageRef.has(String(image.imageRef))) return state.assetByImageRef.get(String(image.imageRef))
  }
  return null
}

function assetPath(asset) {
  const path = asset?.preferred?.copiedPath || asset?.copiedPath || null
  return path && String(path).startsWith('assets/') ? String(path) : null
}

function orderedChildren(node) {
  return [...(node?.children || [])].sort((a, b) => Number(a?.sourceOrder || 0) - Number(b?.sourceOrder || 0))
}

function collectTextNodes(node) {
  const result = []
  const visit = (value) => {
    if (!value) return
    if (String(value.type).toUpperCase() === 'TEXT') result.push(value)
    for (const child of value.children || []) visit(child)
  }
  visit(node)
  return result
}

function collectRequiredStyleNodes(node, state) {
  const result = []
  const visit = (value) => {
    if (!value) return
    const fact = state.styleFacts.get(sourceId(value))
    if (fact && REQUIRED_STYLE_FACT_KEYS.some((key) => Boolean(fact?.[key]))) result.push(value)
    for (const child of value.children || []) visit(child)
  }
  visit(node)
  return result
}

function renderHiddenDescendantBindings(node, state) {
  const nodeId = sourceId(node)
  const hiddenTexts = collectTextNodes(node).map((textNode) => {
    const textId = sourceId(textNode)
    state.renderedTextIds.add(textId)
    state.textBindingIds.add(textId)
    const styleBinding = state.styleFacts.has(textId)
      ? ` data-style-source-node-id="${escapeAttribute(textId)}"`
      : ''
    if (styleBinding) state.styleBindingIds.add(textId)
    return `<span class="visually-hidden" data-source-node-id="${escapeAttribute(textId)}" data-text-source-node-id="${escapeAttribute(textId)}"${styleBinding}>${escapeHtml(exactText(textNode, state))}</span>`
  }).join('')
  const hiddenStyleBindings = collectRequiredStyleNodes(node, state)
    .filter((styleNode) => String(styleNode.type || '').toUpperCase() !== 'TEXT')
    .filter((styleNode) => sourceId(styleNode) !== nodeId)
    .map((styleNode) => {
      const styleId = sourceId(styleNode)
      state.styleBindingIds.add(styleId)
      return `<span class="visually-hidden" aria-hidden="true" data-source-node-id="${escapeAttribute(styleId)}" data-style-source-node-id="${escapeAttribute(styleId)}"></span>`
    }).join('')
  return `${hiddenTexts}${hiddenStyleBindings}`
}

function countNodes(nodes) {
  let count = 0
  const visit = (node) => { if (node) { count += 1; for (const child of node.children || []) visit(child) } }
  for (const node of nodes) visit(node)
  return count
}

function exactText(node, state) {
  return state.textMap.has(sourceId(node)) ? state.textMap.get(sourceId(node)) : String(node?.text ?? '')
}

function boundsOf(node) {
  const value = node?.relativeBounds || node?.bounds || null
  if (!value || [value.x, value.y, value.width, value.height].some((item) => finite(item) === null)) return null
  return value
}

function sourceId(node) {
  return String(node?.sourceNodeId || node?.id || '')
}

function hasComplexVisual(node) {
  const fills = node?.style?.fills || []
  const effects = node?.style?.effects || []
  return fills.some((paint) => !['SOLID', 'IMAGE'].includes(String(paint?.type || '').toUpperCase()))
    || effects.some((effect) => ['BACKGROUND_BLUR'].includes(String(effect?.type || '').toUpperCase()))
    || Boolean(node?.maskType || node?.isMask)
    || Boolean(node?.blendMode && !['NORMAL', 'PASS_THROUGH'].includes(String(node.blendMode).toUpperCase()))
}

function firstSolidPaint(paints) {
  return (paints || []).find((paint) => String(paint?.type || '').toUpperCase() === 'SOLID' && paint.visible !== false)
}

function serializeSafeBackgroundStack(paints) {
  const visible = (paints || []).filter((paint) => paint?.visible !== false && paint?.isVisible !== false)
  if (visible.length === 0 || visible.some((paint) => !['SOLID', 'GRADIENT_LINEAR'].includes(String(paint?.type || '').toUpperCase()))) return null
  if (visible.some((paint) => !['', 'NORMAL', 'PASS_THROUGH'].includes(String(paint?.blendMode || '').toUpperCase()))) return null
  const layers = [...visible].reverse().map((paint) => (
    String(paint.type).toUpperCase() === 'SOLID' ? paintColor(paint) : serializeLinearGradient(paint)
  ))
  return layers.every(Boolean) ? layers.join(',') : null
}

function serializeLinearGradient(paint) {
  const handles = paint?.gradientHandlePositions || []
  const stops = paint?.gradientStops || []
  if (handles.length < 2 || stops.length < 2) return null
  const dx = number(handles[1]?.x) - number(handles[0]?.x)
  const dy = number(handles[1]?.y) - number(handles[0]?.y)
  if (dx === 0 && dy === 0) return null
  const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90
  const cssStops = stops.map((stop) => {
    const position = finite(stop?.position)
    if (position === null || !stop?.color) return null
    return `${paintColor({ color: stop.color, alpha: paint?.alpha ?? paint?.opacity })} ${trim(position * 100)}%`
  })
  return cssStops.every(Boolean) ? `linear-gradient(${trim(angle)}deg,${cssStops.join(',')})` : null
}

function paintColor(paint) {
  const color = paint?.color || paint
  const r = channel(color?.r)
  const g = channel(color?.g)
  const b = channel(color?.b)
  const colorAlpha = finite(color?.a) ?? 1
  const paintAlpha = finite(paint?.opacity ?? paint?.alpha) ?? 1
  const alpha = Math.max(0, Math.min(1, colorAlpha * paintAlpha))
  if (alpha !== null && alpha < 1) return `rgba(${r},${g},${b},${trim(alpha)})`
  return `rgb(${r},${g},${b})`
}

function firstBackgroundBlur(effects) {
  const effect = (effects || []).find((item) => item?.visible !== false
    && item?.isVisible !== false
    && String(item?.type || '').toUpperCase() === 'BACKGROUND_BLUR')
  return effect ? finite(effect.radius) : null
}

function containedGlowClipRadius(node) {
  if (!CONTAINER_TYPES.has(String(node?.type || '').toUpperCase())) return null
  const bounds = boundsOf(node)
  if (!bounds || !hasLayerBlurDescendant(node)) return null
  let radius = null
  const visit = (value) => {
    for (const child of value?.children || []) {
      const childBounds = boundsOf(child)
      const childRadius = finite(child?.style?.cornerRadius)
      if (childBounds && childRadius !== null && childRadius > 0 && boundsNearlyMatch(bounds, childBounds)) {
        radius = radius === null ? childRadius : Math.max(radius, childRadius)
      }
      visit(child)
    }
  }
  visit(node)
  return radius
}

function hasLayerBlurDescendant(node) {
  for (const child of node?.children || []) {
    if ((child?.style?.effects || []).some((effect) => effect?.visible !== false
      && effect?.isVisible !== false
      && String(effect?.type || '').toUpperCase() === 'LAYER_BLUR')) return true
    if (hasLayerBlurDescendant(child)) return true
  }
  return false
}

function boundsNearlyMatch(left, right, tolerance = 1) {
  return Math.abs(number(left.x) - number(right.x)) <= tolerance
    && Math.abs(number(left.y) - number(right.y)) <= tolerance
    && Math.abs(number(left.width) - number(right.width)) <= tolerance
    && Math.abs(number(left.height) - number(right.height)) <= tolerance
}

function channel(value) {
  const numberValue = finite(value) ?? 0
  return Math.round(numberValue <= 1 ? numberValue * 255 : numberValue)
}

function firstShadow(effects) {
  const effect = (effects || []).find((item) => item?.visible !== false && ['DROP_SHADOW', 'INNER_SHADOW'].includes(String(item?.type || '').toUpperCase()))
  if (!effect) return null
  const offset = effect.offset || {}
  const inset = String(effect.type).toUpperCase() === 'INNER_SHADOW' ? 'inset ' : ''
  return `${inset}${px(offset.x || 0)} ${px(offset.y || 0)} ${px(effect.radius || 0)} ${px(effect.spread || 0)} ${paintColor(effect.color || {})}`
}

function buildFontCss(fontAssets) {
  return (fontAssets?.fonts || []).flatMap((font) => font?.css ? [font.css] : []).join('\n')
}

function quoteCss(value) {
  return `"${String(value).replace(/["\\]/g, '\\$&')}"`
}

function escapeCssValue(value) {
  return String(value).replace(/[^a-zA-Z0-9 .,%()-]/g, '')
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/\r?\n/g, '&#10;')
}

function finite(value) {
  const result = Number(value)
  return Number.isFinite(result) ? result : null
}

function number(value) {
  return finite(value) ?? 0
}

function trim(value) {
  return String(Math.round(number(value) * 1000) / 1000)
}

function px(value) {
  return `${trim(value)}px`
}
