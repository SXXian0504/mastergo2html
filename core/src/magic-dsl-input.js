import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { assertSafeRelativePath } from './input.js'

const EMPTY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lwQnGAAAAABJRU5ErkJggg=='
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const SVG_EXTENSIONS = new Set(['.svg'])
const CONTAINER_TYPES = new Set(['FRAME', 'GROUP', 'COMPONENT', 'INSTANCE', 'SECTION'])
const TEXT_TYPES = new Set(['TEXT'])
const PATH_TYPES = new Set(['PATH', 'VECTOR'])
const EXPORT_SCALE = 2
const ROOT_METADATA_FIELDS = [
  'id', 'name', 'type', 'width', 'height', 'minHeight', 'fill', '_color', '_token',
  'background', 'backgroundColor', 'styles', 'allTexts',
]
const ROOT_CONTAINER_FIELDS = [
  'width', 'height', 'minHeight', 'background', 'backgroundColor', 'overflow', 'position',
  'layoutStyle', 'fill', '_color', '_token',
]
const SECTION_ENTRY_FIELDS = [
  'id', 'name', 'type', 'nodeCount', 'textTotal', 'textPreview', 'x', 'y', 'width', 'height',
  'structureHash', 'structureSiblingCount', 'containerId',
]
const SECTION_RESPONSE_FIELDS = [
  'id', 'name', 'type', 'nodeCount', 'textTotal', 'textPreview', 'x', 'y', 'width', 'height',
  'structureHash', 'structureSiblingCount', 'containerId', 'layoutStyle', 'rowTexts',
]
const SECTION_DSL_FIELDS = [
  'id', 'name', 'type', 'layoutStyle', 'flexContainerInfo', 'rowTexts', 'textTotal',
  'structureHash', 'structureSiblingCount', '_variantProps', '_componentProps',
]
const NODE_FIDELITY_FIELDS = [
  'layoutStyle', 'flexContainerInfo', 'constraints', 'effects', 'opacity', 'blendMode',
  'cornerRadius', 'strokeWeight', 'strokeAlign', 'layoutMode', 'itemSpacing', 'padding',
  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'primaryAxisAlignItems',
  'counterAxisAlignItems', 'layoutGrow', 'layoutAlign', 'flexGrow', 'flexShrink',
  'fontName', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'textAlignHorizontal', 'textAlignVertical', 'textCase', 'textDecoration',
  'fill', 'fillStyleId', '_color', '_token', 'strokes', 'stroke', 'strokeStyleId',
  'background', 'backgroundColor', 'backgrounds', 'imageRef', 'resourcePath', 'src', 'url', 'href',
  'svgShortKey', 'svgKey', 'svgName', '_variantProps', '_componentProps', '_placeholder',
  'visible', 'isVisible',
]

export function createInputFromMagicDsl(options = {}) {
  const rawSourcePath = options.input || options.dslRoot
  if (!rawSourcePath) throw new Error('缺少 Magic DSL 输入：请传 --dsl-root <dir> 或 --input <magic-dsl.json>')
  const sourcePath = resolve(rawSourcePath)
  if (!existsSync(sourcePath)) throw new Error(`Magic DSL 输入不存在：${sourcePath}`)
  const outputDir = resolve(options.output || '.mastergo2html/magic-dsl/00-input')
  const packageData = readMagicDslPackage(sourcePath)
  const createdAt = new Date().toISOString()
  const source = buildSource(packageData, options)
  const root = buildRootFrame(packageData, source)
  const assetContext = {
    sourceDir: statSync(sourcePath).isDirectory() ? sourcePath : dirname(sourcePath),
    svgAssets: readSvgAssetMap(packageData, sourcePath),
    imageIndex: 1,
    nodeSliceIndex: 1,
    assets: [],
    files: {},
  }

  attachSections(root, packageData, assetContext)
  writeInputDirectory(outputDir, {
    'raw.json': {
      version: 'mastergo2html.raw.v1',
      generatedAt: createdAt,
      sourceKind: 'magic-dsl',
      page: {
        id: source.pageId,
        name: source.pageName,
      },
      selection: [root],
      assetManifestFile: 'asset-manifest.json',
      magicDsl: {
        sourcePath,
        inputMode: packageData.inputMode,
        fileId: source.fileId,
        layerId: source.layerId,
        shortLink: source.shortLink,
        fidelityHints: buildPackageFidelityHints(packageData),
      },
    },
    'asset-manifest.json': {
      version: 'mastergo2html.asset-manifest.v1',
      generatedAt: createdAt,
      source,
      assets: assetContext.assets,
      files: buildManifestFiles(assetContext.assets),
      magicDsl: {
        note: packageData.inputMode === 'getDesignSections'
          ? 'Input built from MasterGo Magic MCP getDesignSections section data. Runtime-only node export gaps are preserved as reference-only assets.'
          : 'Input built from MasterGo Magic MCP getDsl fallback data. Section-level bbox/repeat metadata may be less complete.',
        sourcePath,
        inputMode: packageData.inputMode,
      },
    },
    'export-options.json': {
      exportOptions: {
        includeOriginalImages: false,
        includeRenderedSlices: false,
        rawProfile: 'html',
        sourceKind: 'magic-dsl',
        magicInputMode: packageData.inputMode,
      },
      source,
      createdAt,
    },
    'frame-screenshot.png': readScreenshotBase64(options, sourcePath),
    ...assetContext.files,
  })

  return {
    ok: true,
    inputDir: outputDir,
    source,
    assetCount: assetContext.assets.length,
    nodeCount: countNodes(root),
  }
}

function readMagicDslPackage(sourcePath) {
  const stat = statSync(sourcePath)
  if (stat.isFile()) return normalizePackage(JSON.parse(readFileSync(sourcePath, 'utf8')))

  const overviewPath = join(sourcePath, 'overview.json')
  const packagePath = join(sourcePath, 'magic-dsl.json')
  const overview = existsSync(overviewPath)
    ? JSON.parse(readFileSync(overviewPath, 'utf8'))
    : existsSync(packagePath)
      ? JSON.parse(readFileSync(packagePath, 'utf8')).overview
      : null
  const packageJson = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, 'utf8')) : {}
  const sectionsDir = join(sourcePath, 'sections')
  const sections = existsSync(sectionsDir)
    ? readdirSync(sectionsDir)
      .filter((name) => name.endsWith('.json'))
      .sort(compareSectionFileNames)
      .map((name) => JSON.parse(readFileSync(join(sectionsDir, name), 'utf8')))
    : packageJson.sections || []
  return normalizePackage({
    ...packageJson,
    overview: overview || packageJson.overview,
    sections,
  })
}

function normalizePackage(input) {
  const overview = input.overview || input.sectionList || input.sectionsOverview || input
  const sections = Array.isArray(input.sections) ? input.sections : []
  const fullDslRoot = sections.length > 0
    ? null
    : extractSectionDsl(input)
  return {
    source: input.source || {},
    inputMode: sections.length > 0 ? 'getDesignSections' : 'getDsl-fallback',
    overview,
    sectionEntries: Array.isArray(overview?.sections) ? overview.sections : [],
    rootMetadata: overview?.rootMetadata || overview?.root || {},
    rootContainer: overview?.rootContainer || {},
    splitContainers: overview?.splitContainers || [],
    sections,
    fullDslRoot,
    svgAssets: input.svgAssets || input.svg || {},
  }
}

function buildSource(packageData, options) {
  const rootMetadata = packageData.rootMetadata || {}
  return {
    pageId: options.fileId || packageData.source.fileId || rootMetadata.fileId || 'magic-dsl-page',
    pageName: options.pageName || packageData.source.pageName || rootMetadata.name || 'Magic DSL',
    selectionIds: [options.layerId || packageData.source.layerId || rootMetadata.id || 'magic-dsl-root'],
    selectionCount: 1,
    fileId: options.fileId || packageData.source.fileId,
    layerId: options.layerId || packageData.source.layerId || rootMetadata.id,
    shortLink: options.shortLink || packageData.source.shortLink,
  }
}

function buildPackageFidelityHints(packageData) {
  return compactObject({
    inputMode: packageData.inputMode,
    rootMetadata: pickFidelityFields(packageData.rootMetadata, ROOT_METADATA_FIELDS),
    rootContainer: pickFidelityFields(packageData.rootContainer, ROOT_CONTAINER_FIELDS),
    splitContainers: Array.isArray(packageData.splitContainers)
      ? packageData.splitContainers.map((container) => pickFidelityFields(container, [
        ...SECTION_ENTRY_FIELDS,
        'layoutMode', 'itemSpacing', 'padding', 'paddingLeft', 'paddingRight',
        'paddingTop', 'paddingBottom', 'background', 'backgroundColor', 'fill',
        '_color', '_token',
      ])).filter((container) => Object.keys(container).length > 0)
      : undefined,
    sections: packageData.sectionEntries.map((entry) => pickFidelityFields(entry, SECTION_ENTRY_FIELDS)),
  })
}

function buildNodeFidelityHints(node, style = {}) {
  const picked = pickFidelityFields(node, NODE_FIDELITY_FIELDS)
  const pickedStyle = pickFidelityFields(style, [
    'width', 'height', 'relativeX', 'relativeY', 'x', 'y', 'left', 'top',
    'display', 'position', 'overflow', 'background', 'backgroundColor', 'color',
    'borderRadius', 'borderWidth', 'fontFamily', 'fontSize', 'fontWeight',
    'lineHeight', 'letterSpacing', 'textAlign', 'opacity',
  ])
  return compactObject({
    sourceKind: 'node',
    sourceType: node.type || node.nodeType || node.kind,
    layoutStyle: picked.layoutStyle,
    style: Object.keys(pickedStyle).length > 0 ? pickedStyle : undefined,
    flexContainerInfo: picked.flexContainerInfo,
    constraints: picked.constraints,
    variants: picked._variantProps,
    componentProps: picked._componentProps,
    placeholder: picked._placeholder,
    tokens: compactObject({
      fill: picked.fill,
      fillStyleId: picked.fillStyleId,
      color: picked._color,
      token: picked._token,
      stroke: picked.stroke,
      strokeStyleId: picked.strokeStyleId,
    }),
    typography: compactObject({
      fontName: picked.fontName,
      fontFamily: picked.fontFamily,
      fontSize: picked.fontSize,
      fontWeight: picked.fontWeight,
      lineHeight: picked.lineHeight,
      letterSpacing: picked.letterSpacing,
      textAlignHorizontal: picked.textAlignHorizontal,
      textAlignVertical: picked.textAlignVertical,
      textCase: picked.textCase,
      textDecoration: picked.textDecoration,
    }),
    layout: compactObject({
      layoutMode: picked.layoutMode,
      itemSpacing: picked.itemSpacing,
      padding: picked.padding,
      paddingLeft: picked.paddingLeft,
      paddingRight: picked.paddingRight,
      paddingTop: picked.paddingTop,
      paddingBottom: picked.paddingBottom,
      primaryAxisAlignItems: picked.primaryAxisAlignItems,
      counterAxisAlignItems: picked.counterAxisAlignItems,
      layoutGrow: picked.layoutGrow,
      layoutAlign: picked.layoutAlign,
      flexGrow: picked.flexGrow,
      flexShrink: picked.flexShrink,
    }),
    visual: compactObject({
      effects: picked.effects,
      opacity: picked.opacity,
      blendMode: picked.blendMode,
      cornerRadius: picked.cornerRadius,
      strokeWeight: picked.strokeWeight,
      strokeAlign: picked.strokeAlign,
      background: picked.background,
      backgroundColor: picked.backgroundColor,
      backgrounds: picked.backgrounds,
      strokes: picked.strokes,
    }),
    resource: compactObject({
      imageRef: picked.imageRef,
      resourcePath: picked.resourcePath,
      src: picked.src,
      url: picked.url,
      href: picked.href,
      svgShortKey: picked.svgShortKey,
      svgKey: picked.svgKey,
      svgName: picked.svgName,
    }),
  })
}

function pickFidelityFields(source, fields) {
  if (!source || typeof source !== 'object') return {}
  const output = {}
  for (const field of fields) {
    if (source[field] !== undefined) output[field] = cloneJsonValue(source[field])
  }
  return compactObject(output)
}

function collectRowTexts(sectionResponse, sectionDsl) {
  const rowTexts = sectionResponse?.rowTexts || sectionResponse?.dsl?.rowTexts || sectionDsl?.rowTexts
  return Array.isArray(rowTexts) ? cloneJsonValue(rowTexts) : undefined
}

function compactObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const output = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      const items = value.map(cloneJsonValue).filter((item) => item !== undefined)
      if (items.length > 0) output[key] = items
      continue
    }
    if (value && typeof value === 'object') {
      const child = compactObject(value)
      if (Object.keys(child).length > 0) output[key] = child
      continue
    }
    output[key] = value
  }
  return output
}

function cloneJsonValue(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneJsonValue).filter((item) => item !== undefined)
  return compactObject(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)])))
}

function buildRootFrame(packageData, source) {
  const meta = packageData.rootMetadata || {}
  const rootContainer = packageData.rootContainer || {}
  const width = firstNumber(meta.width, rootContainer.width, rootContainer.layoutStyle?.width) ?? 1440
  const height = firstNumber(meta.height, meta.minHeight, rootContainer.minHeight, rootContainer.layoutStyle?.height) ?? 900
  return {
    id: String(source.layerId || meta.id || 'magic-dsl-root'),
    name: String(meta.name || source.pageName || 'Magic DSL'),
    type: normalizeType(meta.type || 'FRAME'),
    isVisible: true,
    x: 0,
    y: 0,
    width,
    height,
    absoluteBoundingBox: { x: 0, y: 0, width, height },
    absoluteRenderBounds: { x: 0, y: 0, width, height },
    relativeBounds: { x: 0, y: 0, width, height },
    bounds: { x: 0, y: 0, width, height },
    fills: fillsFromMagicNode(meta, rootContainer),
    magicDsl: compactObject({
      sourceKind: 'root',
      rootMetadata: pickFidelityFields(meta, ROOT_METADATA_FIELDS),
      rootContainer: pickFidelityFields(rootContainer, ROOT_CONTAINER_FIELDS),
      allTexts: Array.isArray(meta.allTexts) ? meta.allTexts : undefined,
    }),
    children: [],
  }
}

function attachSections(root, packageData, assetContext) {
  if (packageData.sections.length === 0 && packageData.fullDslRoot) {
    attachFullDslRoot(root, packageData.fullDslRoot, assetContext)
    return
  }
  const entryByIndex = packageData.sectionEntries
  packageData.sections.forEach((sectionResponse, index) => {
    const entry = entryByIndex[index] || {}
    const sectionDsl = extractSectionDsl(sectionResponse)
    const bbox = sectionBounds(entry, sectionResponse, sectionDsl)
    const sectionFrame = {
      id: String(entry.id || sectionResponse.id || sectionDsl?.id || `magic-section-${index}`),
      name: String(entry.name || sectionResponse.name || sectionDsl?.name || `section-${index}`),
      type: 'FRAME',
      isVisible: true,
      x: bbox.x,
      y: bbox.y,
      width: bbox.width,
      height: bbox.height,
      absoluteBoundingBox: { ...bbox },
      absoluteRenderBounds: { ...bbox },
      relativeBounds: { ...bbox },
      bounds: { ...bbox },
      magicDsl: compactObject({
        sourceKind: 'section',
        sectionIndex: index,
        section: pickFidelityFields(entry, SECTION_ENTRY_FIELDS),
        response: pickFidelityFields(sectionResponse, SECTION_RESPONSE_FIELDS),
        dsl: pickFidelityFields(sectionDsl, SECTION_DSL_FIELDS),
        rowTexts: collectRowTexts(sectionResponse, sectionDsl),
      }),
      children: [],
    }
    const nodes = Array.isArray(sectionDsl) ? sectionDsl : childrenOf(sectionDsl)
    if (sectionDsl && !Array.isArray(sectionDsl) && sameNodeId(sectionDsl, sectionFrame.id)) {
      const converted = convertMagicNode(sectionDsl, {
        parentAbsX: bbox.x,
        parentAbsY: bbox.y,
        fallbackIdPrefix: sectionFrame.id,
        assetContext,
        sectionBounds: bbox,
      })
      if (converted) root.children.push(mergeSectionMetadata(converted, sectionFrame))
      return
    }
    if (nodes.length > 0) {
      sectionFrame.children = nodes.map((node, childIndex) => convertMagicNode(node, {
        parentAbsX: bbox.x,
        parentAbsY: bbox.y,
        fallbackIdPrefix: `${sectionFrame.id}-${childIndex}`,
        assetContext,
      })).filter(Boolean)
    } else if (sectionDsl && typeof sectionDsl === 'object') {
      sectionFrame.children = childrenOf(sectionDsl).map((node, childIndex) => convertMagicNode(node, {
        parentAbsX: bbox.x,
        parentAbsY: bbox.y,
        fallbackIdPrefix: `${sectionFrame.id}-${childIndex}`,
        assetContext,
      })).filter(Boolean)
    }
    root.children.push(sectionFrame)
  })
}

function extractSectionDsl(response) {
  return response?.dsl || response?.section?.dsl || response?.data?.dsl || response?.root || response?.node || response?.tree || response
}

function attachFullDslRoot(root, fullDslRoot, assetContext) {
  const dslRoot = Array.isArray(fullDslRoot) ? null : fullDslRoot
  const nodes = Array.isArray(fullDslRoot) ? fullDslRoot : childrenOf(fullDslRoot)
  if (dslRoot && nodes.length === 0 && dslRoot.id !== root.id) {
    const converted = convertMagicNode(dslRoot, {
      parentAbsX: 0,
      parentAbsY: 0,
      fallbackIdPrefix: 'magic-dsl-full-root',
      assetContext,
    })
    if (converted) root.children.push(converted)
    return
  }
  root.children = nodes.map((node, index) => convertMagicNode(node, {
    parentAbsX: 0,
    parentAbsY: 0,
    fallbackIdPrefix: `magic-dsl-full-${index}`,
    assetContext,
  })).filter(Boolean)
}

function sectionBounds(entry, response, dsl) {
  const style = dsl?.layoutStyle || response?.layoutStyle || {}
  const x = firstNumber(entry.x, response?.x, style.x, style.left, style.relativeX) ?? 0
  const y = firstNumber(entry.y, response?.y, style.y, style.top, style.relativeY) ?? 0
  const width = firstNumber(entry.width, response?.width, style.width, dsl?.width) ?? 0
  const height = firstNumber(entry.height, response?.height, style.height, dsl?.height) ?? 0
  return { x, y, width, height }
}

function convertMagicNode(node, context) {
  if (!node || typeof node !== 'object') return null
  if (node.visible === false || node.isVisible === false) return null
  const type = normalizeType(node.type || node.nodeType || node.kind)
  const style = node.layoutStyle || node.style || {}
  const x = firstNumber(style.relativeX, style.x, node.relativeX, node.x) ?? 0
  const y = firstNumber(style.relativeY, style.y, node.relativeY, node.y) ?? 0
  const width = firstNumber(style.width, node.width, node.absoluteBoundingBox?.width) ?? 0
  const height = firstNumber(style.height, node.height, node.absoluteBoundingBox?.height) ?? 0
  const absoluteX = firstNumber(node.absoluteBoundingBox?.x, node.absoluteRenderBounds?.x, context.sectionBounds?.x) ?? context.parentAbsX + x
  const absoluteY = firstNumber(node.absoluteBoundingBox?.y, node.absoluteRenderBounds?.y, context.sectionBounds?.y) ?? context.parentAbsY + y
  const relativeX = absoluteX - context.parentAbsX
  const relativeY = absoluteY - context.parentAbsY
  const output = {
    id: String(node.id || node.nodeId || context.fallbackIdPrefix),
    name: String(node.name || node.svgName || type.toLowerCase()),
    type,
    isVisible: true,
    x: absoluteX,
    y: absoluteY,
    width,
    height,
    absoluteBoundingBox: { x: absoluteX, y: absoluteY, width, height },
    absoluteRenderBounds: { x: absoluteX, y: absoluteY, width, height },
    relativeBounds: { x: relativeX, y: relativeY, width, height },
    bounds: { x: absoluteX, y: absoluteY, width, height },
  }
  const fidelity = buildNodeFidelityHints(node, style)
  if (Object.keys(fidelity).length > 0) output.magicDsl = fidelity

  const text = readNodeText(node)
  if (TEXT_TYPES.has(type) && text) output.characters = text
  const fills = fillsFromMagicNode(node)
  if (fills.length > 0) output.fills = fills
  const strokes = strokesFromMagicNode(node)
  if (strokes.length > 0) output.strokes = strokes
  copyStyleFields(node, style, output)
  copyPluginRawLayoutFields(node, style, output)
  registerNodeAssets(node, output, context.assetContext)

  const children = childrenOf(node).map((child, index) => convertMagicNode(child, {
    parentAbsX: absoluteX,
    parentAbsY: absoluteY,
    fallbackIdPrefix: `${output.id}-${index}`,
    assetContext: context.assetContext,
  })).filter(Boolean)
  if (children.length > 0 || CONTAINER_TYPES.has(type)) output.children = children
  return output
}

function sameNodeId(node, id) {
  return String(node?.id || node?.nodeId || '') === String(id || '')
}

function mergeSectionMetadata(node, sectionFrame) {
  return {
    ...sectionFrame,
    ...node,
    magicDsl: compactObject({
      ...(sectionFrame.magicDsl || {}),
      ...(node.magicDsl || {}),
    }),
  }
}

function childrenOf(node) {
  if (!node || typeof node !== 'object') return []
  for (const key of ['children', 'nodes', 'childNodes']) {
    if (Array.isArray(node[key])) return node[key]
  }
  return []
}

function readNodeText(node) {
  const text = node.text ?? node.characters ?? node.value
  if (Array.isArray(text)) return text.join('')
  if (typeof text === 'string') return text
  return ''
}

function fillsFromMagicNode(node, fallback = {}) {
  const fills = []
  const color = node?._color || node?.color || fallback.background || fallback.backgroundColor
  if (typeof color === 'string' && looksLikeCssPaint(color) && color !== 'transparent') fills.push({ type: 'SOLID', color, isVisible: true })
  const fill = node?.fill || node?.background || node?.backgroundColor
  if (typeof fill === 'string' && looksLikeCssPaint(fill) && fill !== color && fill !== 'transparent') {
    fills.push(fill.startsWith('linear-gradient')
      ? { type: 'GRADIENT_LINEAR', css: fill, isVisible: true }
      : { type: 'SOLID', color: fill, isVisible: true })
  }
  if (Array.isArray(node?.fills)) return node.fills
  return fills
}

function strokesFromMagicNode(node) {
  if (Array.isArray(node?.strokes)) return node.strokes
  const stroke = node?.stroke || node?.borderColor
  return typeof stroke === 'string' && looksLikeCssPaint(stroke) ? [{ type: 'SOLID', color: stroke, isVisible: true }] : []
}

function effectsFromMagicNode(node) {
  if (Array.isArray(node?.effects)) return node.effects
  const shadow = node?.boxShadow || node?.shadow
  if (!shadow) return []
  return [{ type: 'DROP_SHADOW', css: String(shadow), isVisible: true }]
}

function copyStyleFields(node, style, output) {
  const fieldMap = {
    opacity: firstNumber(node.opacity, style.opacity),
    cornerRadius: firstNumber(node.cornerRadius, style.borderRadius, style.radius),
    strokeWeight: firstNumber(node.strokeWeight, style.strokeWeight, style.borderWidth),
    fontSize: firstNumber(node.fontSize, style.fontSize),
    lineHeight: firstNumber(node.lineHeight, style.lineHeight),
    fontWeight: node.fontWeight || style.fontWeight,
    textAlignHorizontal: node.textAlignHorizontal || style.textAlign,
  }
  for (const [key, value] of Object.entries(fieldMap)) {
    if (value !== undefined && value !== '') output[key] = value
  }
  const family = node.fontFamily || style.fontFamily || node.fontName?.family
  if (family) output.fontName = { family: stripQuotes(String(family).split(',')[0]), style: node.fontName?.style || 'Regular' }
  if (TEXT_TYPES.has(output.type)) {
    const textRun = compactObject({
      characters: output.characters,
      fontName: output.fontName,
      fontSize: output.fontSize,
      fontWeight: output.fontWeight,
      lineHeight: output.lineHeight,
    })
    if (Object.keys(textRun).length > 0) output.textRuns = [textRun]
  }
}

function copyPluginRawLayoutFields(node, style, output) {
  const flex = node.flexContainerInfo || {}
  const fieldMap = {
    rotation: firstNumber(node.rotation, style.rotation),
    clipsContent: node.clipsContent ?? (node.overflow === 'hidden' || style.overflow === 'hidden'),
    overflowDirection: node.overflowDirection,
    flexMode: node.flexMode || flex.flexDirection || node.layoutMode || style.layoutMode,
    flexWrap: node.flexWrap || flex.flexWrap,
    itemSpacing: firstNumber(node.itemSpacing, node.gap, flex.gap, style.gap),
    mainAxisAlignItems: node.mainAxisAlignItems || flex.justifyContent || node.primaryAxisAlignItems,
    crossAxisAlignItems: node.crossAxisAlignItems || flex.alignItems || node.counterAxisAlignItems,
    mainAxisSizingMode: node.mainAxisSizingMode,
    crossAxisSizingMode: node.crossAxisSizingMode,
    paddingTop: firstNumber(node.paddingTop, flex.paddingTop, style.paddingTop, style.padding),
    paddingRight: firstNumber(node.paddingRight, flex.paddingRight, style.paddingRight, style.padding),
    paddingBottom: firstNumber(node.paddingBottom, flex.paddingBottom, style.paddingBottom, style.padding),
    paddingLeft: firstNumber(node.paddingLeft, flex.paddingLeft, style.paddingLeft, style.padding),
    textAlignVertical: node.textAlignVertical || style.textAlignVertical,
    paragraphSpacing: firstNumber(node.paragraphSpacing, style.paragraphSpacing),
  }
  for (const [key, value] of Object.entries(fieldMap)) {
    if (value !== undefined && value !== '') output[key] = value
  }
  const effects = effectsFromMagicNode(node)
  if (effects.length > 0) output.effects = effects
}

function registerNodeAssets(sourceNode, rawNode, context) {
  const imageRefs = collectImageRefs(sourceNode)
  imageRefs.forEach((imageRef) => {
    const asset = registerImageAsset(imageRef, rawNode, context)
    rawNode.fills = [{ type: 'IMAGE', imageRef, assetId: asset.assetId, scaleMode: 'FILL', isVisible: true }]
  })
  if (PATH_TYPES.has(rawNode.type) || sourceNode.svgShortKey || sourceNode.svgKey) {
    registerPathAsset(sourceNode, rawNode, context)
  }
}

function collectImageRefs(node) {
  const refs = []
  for (const key of ['imageRef', 'resourcePath', 'src', 'url', 'href']) {
    if (typeof node?.[key] === 'string' && looksLikeImageRef(node[key])) refs.push(node[key])
  }
  for (const paint of [...(Array.isArray(node?.fills) ? node.fills : []), ...(Array.isArray(node?.backgrounds) ? node.backgrounds : [])]) {
    const ref = paint?.imageRef || paint?.resourcePath || paint?.src || paint?.url || paint?.href
    if (typeof ref === 'string' && looksLikeImageRef(ref)) refs.push(ref)
  }
  return [...new Set(refs)]
}

function registerImageAsset(imageRef, rawNode, context) {
  const extension = guessImageExtension(imageRef)
  const format = normalizeAssetFormat(extension)
  const assetId = `img_${String(context.imageIndex).padStart(4, '0')}`
  context.imageIndex += 1
  const suggestedFile = `assets/img/${assetId}.${extension}`
  const copied = copyReferencedFile(imageRef, suggestedFile, context)
  const asset = {
    assetId,
    kind: 'image',
    imageRef,
    status: copied ? 'present' : 'reference-only',
    sourceNodes: [{
      nodeId: rawNode.id,
      nodeName: rawNode.name,
      paintPath: 'fills[0]',
      usageHint: inferUsageHint(rawNode),
      scaleMode: 'FILL',
    }],
    suggestedFile,
    copiedPath: copied ? suggestedFile : undefined,
    originalFileName: basename(String(imageRef).split('?')[0]) || `${assetId}.${extension}`,
    format,
    targetDir: 'assets/img',
    renderedAssets: [],
    error: copied ? undefined : 'Magic DSL 未提供可落盘的图片资源文件；保留 imageRef 供后续补导。',
  }
  context.assets.push(asset)
  return asset
}

function registerPathAsset(sourceNode, rawNode, context) {
  const svgKey = sourceNode.svgShortKey || sourceNode.svgKey || sourceNode.id || rawNode.id
  const assetId = `node_${String(context.nodeSliceIndex).padStart(4, '0')}`
  context.nodeSliceIndex += 1
  const suggestedFile = `assets/icon/${safeFilePart(svgKey)}.svg`
  const svgContent = readSvgContent(svgKey, context)
  if (svgContent) {
    context.files[suggestedFile] = {
      path: suggestedFile,
      mimeType: 'image/svg+xml',
      encoding: 'utf8',
      content: svgContent,
    }
  }
  context.assets.push({
    assetId,
    kind: 'node-slice',
    usageHint: inferUsageHint(rawNode),
    renderPolicy: 'required-final',
    mustUseRenderedSlice: true,
    format: 'svg',
    targetDir: 'assets/icon',
    imageRef: svgKey,
    status: svgContent ? 'present' : 'reference-only',
    sourceNodes: [{
      nodeId: rawNode.id,
      nodeName: rawNode.name,
      paintPath: 'node',
      usageHint: inferUsageHint(rawNode),
      exportFormat: 'svg',
      renderReason: 'Magic DSL PATH 节点转换为 SVG 资产。',
    }],
    suggestedFile,
    copiedPath: svgContent ? suggestedFile : undefined,
    renderedAssets: [{
      assetId: `slice_${String(context.assets.length + 1).padStart(4, '0')}`,
      kind: 'rendered-image',
      format: 'svg',
      nodeId: rawNode.id,
      status: svgContent ? 'present' : 'reference-only',
      suggestedFile,
      copiedPath: svgContent ? suggestedFile : undefined,
      exportScale: EXPORT_SCALE,
    }],
    error: svgContent ? undefined : 'Magic DSL 仅提供 svgShortKey，未提供实际 SVG；需要 extractSvg/applyDesign 补齐。',
  })
}

function readSvgContent(svgKey, context) {
  const direct = context.svgAssets[svgKey]
  if (typeof direct === 'string') return direct
  if (direct?.svg) return direct.svg
  if (direct?.content) return direct.content
  const localPath = join(context.sourceDir, 'assets', 'icon', `${safeFilePart(svgKey)}.svg`)
  if (existsSync(localPath)) return readFileSync(localPath, 'utf8')
  return ''
}

function readSvgAssetMap(packageData, sourcePath) {
  const sourceDir = statSync(sourcePath).isDirectory() ? sourcePath : dirname(sourcePath)
  const mapPath = join(sourceDir, 'svg-assets.json')
  if (existsSync(mapPath)) return JSON.parse(readFileSync(mapPath, 'utf8'))
  return packageData.svgAssets || {}
}

function copyReferencedFile(ref, suggestedFile, context) {
  const local = resolveLocalAssetPath(ref, context.sourceDir)
  if (!local || !existsSync(local) || !statSync(local).isFile()) return false
  context.files[suggestedFile] = {
    path: suggestedFile,
    mimeType: mimeTypeForPath(local),
    encoding: isUtf8Asset(local) ? 'utf8' : 'base64',
    content: isUtf8Asset(local) ? readFileSync(local, 'utf8') : readFileSync(local).toString('base64'),
  }
  return true
}

function resolveLocalAssetPath(ref, sourceDir) {
  const value = String(ref || '').replace(/^\.\/+/, '')
  if (!value || /^[a-z]+:\/\//i.test(value) || value.startsWith('data:')) return ''
  const candidates = [
    join(sourceDir, value),
    join(sourceDir, 'assets', value),
    join(sourceDir, 'assets', 'img', basename(value)),
    join(sourceDir, 'assets', 'icon', basename(value)),
  ]
  return candidates.find((candidate) => existsSync(candidate)) || ''
}

function buildManifestFiles(assets) {
  return assets.flatMap((asset) => {
    const original = asset.kind === 'image' ? {
      path: asset.suggestedFile,
      assetId: asset.assetId,
      kind: 'original-image',
      status: asset.status,
      sourceNodeIds: asset.sourceNodes.map((source) => source.nodeId),
    } : null
    const rendered = (asset.renderedAssets || []).map((item) => ({
      path: item.suggestedFile,
      assetId: item.assetId,
      kind: asset.kind === 'node-slice' ? 'node-slice' : 'rendered-image',
      status: item.status,
      sourceNodeIds: [item.nodeId],
    }))
    return [original, ...rendered].filter(Boolean)
  })
}

function writeInputDirectory(outputDir, files) {
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })
  for (const [path, file] of Object.entries(files)) {
    const target = join(outputDir, assertSafeRelativePath(path))
    mkdirSync(dirname(target), { recursive: true })
    if (typeof file === 'string') writeFileSync(target, Buffer.from(file, 'base64'))
    else if (file.encoding === 'utf8') writeFileSync(target, String(file.content || ''), 'utf8')
    else if (file.encoding === 'base64') writeFileSync(target, Buffer.from(String(file.content || ''), 'base64'))
    else writeFileSync(target, JSON.stringify(file, null, 2))
  }
  mkdirSync(join(outputDir, 'assets'), { recursive: true })
}

function readScreenshotBase64(options, sourcePath) {
  const sourceDir = statSync(sourcePath).isDirectory() ? sourcePath : dirname(sourcePath)
  const screenshot = options.screenshot
    ? resolve(options.screenshot)
    : ['frame-screenshot.png', 'screenshot.png'].map((name) => join(sourceDir, name)).find((candidate) => existsSync(candidate))
  if (screenshot && existsSync(screenshot)) return readFileSync(screenshot).toString('base64')
  return EMPTY_PNG_BASE64
}

function compareSectionFileNames(a, b) {
  return sectionNumber(a) - sectionNumber(b) || a.localeCompare(b)
}

function sectionNumber(name) {
  const match = String(name).match(/\d+/)
  return match ? Number(match[0]) : Number.MAX_SAFE_INTEGER
}

function normalizeType(type) {
  const upper = String(type || 'FRAME').toUpperCase()
  if (upper === 'RECT' || upper === 'RECTANGLE') return 'RECTANGLE'
  if (upper === 'TEXT') return 'TEXT'
  if (upper === 'PATH' || upper === 'VECTOR') return upper
  if (CONTAINER_TYPES.has(upper)) return upper
  return 'FRAME'
}

function firstNumber(...values) {
  for (const value of values) {
    const number = typeof value === 'number' ? value : Number.parseFloat(String(value ?? '').replace('px', ''))
    if (Number.isFinite(number)) return number
  }
  return undefined
}

function stripQuotes(value) {
  return value.replace(/^['"]|['"]$/g, '')
}

function looksLikeImageRef(value) {
  const lower = String(value || '').toLowerCase().split('?')[0]
  return [...IMAGE_EXTENSIONS, ...SVG_EXTENSIONS].some((extension) => lower.endsWith(extension)) || lower.startsWith('data:image/')
}

function looksLikeCssPaint(value) {
  const text = String(value || '').trim()
  return /^#([0-9a-f]{3,8})$/i.test(text)
    || /^rgba?\(/i.test(text)
    || /^hsla?\(/i.test(text)
    || /^linear-gradient\(/i.test(text)
    || /^[a-z]+$/i.test(text)
}

function guessImageExtension(imageRef) {
  const clean = String(imageRef || '').split('?')[0]
  const ext = extname(clean).slice(1).toLowerCase()
  if (['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext
  return 'png'
}

function normalizeAssetFormat(extension) {
  if (extension === 'svg') return 'svg'
  if (extension === 'jpg' || extension === 'jpeg') return 'jpg'
  if (extension === 'webp') return 'webp'
  if (extension === 'gif') return 'gif'
  if (extension === 'png') return 'png'
  return 'unknown'
}

function mimeTypeForPath(path) {
  const extension = extname(path).toLowerCase()
  if (extension === '.svg') return 'image/svg+xml'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.gif') return 'image/gif'
  return 'image/png'
}

function isUtf8Asset(path) {
  return extname(path).toLowerCase() === '.svg'
}

function safeFilePart(value) {
  return String(value || 'svg').replace(/[^a-zA-Z0-9_-]+/g, '_')
}

function inferUsageHint(node) {
  const name = String(node?.name || '')
  if (/logo|品牌|标志/i.test(name)) return 'logo'
  if (/icon|图标|svg|path/i.test(name)) return 'icon'
  if (/bg|background|背景/i.test(name)) return 'background'
  if (/decor|decoration|装饰|波点|点阵|网格/i.test(name)) return 'decorative'
  return 'content-image'
}

function countNodes(node) {
  return node ? 1 + (node.children || []).reduce((sum, child) => sum + countNodes(child), 0) : 0
}
