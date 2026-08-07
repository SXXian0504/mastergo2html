import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const VERSION = 'mastergo2html.node-style-facts.v1'
const MAX_FACTS = 120
const REQUIRED_AREA_RATIO = 0.04
const RASTER_EFFECT_TYPES = new Set(['LAYER_BLUR', 'BACKGROUND_BLUR', 'DROP_SHADOW', 'INNER_SHADOW'])

export function readOrCreateNodeStyleFacts(path, normalizedRawPath, assetIndex) {
  const normalizedRaw = readJson(normalizedRawPath)
  if (existsSync(path)) {
    const existing = readJson(path)
    if (!needsStyleFactsRefresh(existing, normalizedRaw, assetIndex)) return existing
  }
  const payload = buildNodeStyleFacts(normalizedRaw, assetIndex)
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

function needsStyleFactsRefresh(existing, normalizedRaw, assetIndex = {}) {
  if (existing?.rules?.compactRoundedSurfaceRequired !== true) return true
  const nodes = []
  for (const root of Array.isArray(normalizedRaw?.nodes) ? normalizedRaw.nodes : []) flatten(root, nodes)
  const nodeById = new Map(nodes.map((node) => [String(node.sourceNodeId || node.id), node]))

  const expectedRasterIds = new Set(nodes
    .filter((node) => node?.visible && summarizeRasterEffects(node?.style?.effects).length > 0)
    .map((node) => String(node.sourceNodeId || node.id)))
  const actualRasterIds = new Set((existing?.facts || [])
    .filter((fact) => fact?.rasterEffect)
    .map((fact) => String(fact.sourceNodeId || '')))
  if ([...expectedRasterIds].some((sourceNodeId) => !actualRasterIds.has(sourceNodeId))) return true
  const requiredEffectAssetByNodeId = indexRequiredEffectAssets(assetIndex)
  for (const fact of existing?.facts || []) {
    if (!fact?.rasterEffect) continue
    const asset = requiredEffectAssetByNodeId.get(String(fact.sourceNodeId || ''))
    const expectedMode = asset?.preferred?.copiedPath
      ? (String(asset.format || asset.preferred?.format || '').toLowerCase() === 'svg' ? 'required-final-svg' : 'required-final-png')
      : 'css-fallback'
    if (fact.rasterEffect.assetMode !== expectedMode) return true
  }

  // Old jobs may already have typography facts but lack the no-wrap contract. Refresh only facts
  // that are already part of the capped payload so jobs with more than MAX_FACTS do not rebuild
  // forever merely because a low-priority text node was intentionally omitted.
  for (const fact of existing?.facts || []) {
    if (!fact?.typography || fact.singleLineRequired === true) continue
    const node = nodeById.get(String(fact.sourceNodeId || ''))
    const bounds = node?.relativeBounds || node?.bounds
    const typography = node?.type === 'TEXT' ? summarizeTypography(node?.style?.text) : undefined
    if (node && inferSingleLineRequired(node, typography, bounds)) return true
  }
  return false
}


export function buildNodeStyleFacts(normalizedRaw, assetIndex = {}) {
  const roots = Array.isArray(normalizedRaw?.nodes) ? normalizedRaw.nodes : []
  const nodes = []
  for (const root of roots) flatten(root, nodes)
  const nodeById = new Map(nodes.map((node) => [String(node.sourceNodeId || node.id), node]))
  const rootIds = new Set(roots.map((node) => String(node.sourceNodeId || node.id)))
  const renderedCompositeNodeIds = new Set((assetIndex?.assets || [])
    .filter((asset) => asset.renderPolicy === 'required-final' && asset.renderingStrategy === 'use-rendered-node-slice')
    .flatMap((asset) => asset.sourceNodes || [])
    .map((source) => String(source.sourceNodeId || ''))
    .filter(Boolean))
  const rasterAssetByNodeId = indexRequiredEffectAssets(assetIndex)
  const rootArea = Math.max(1, ...roots.map((node) => area(node?.relativeBounds || node?.bounds)))

  const candidates = nodes
    .map((node) => toStyleFact(node, rootArea, nodeById, rootIds, renderedCompositeNodeIds, rasterAssetByNodeId))
    .filter(Boolean)
    .sort((a, b) => Number(Boolean(b.rasterEffect)) - Number(Boolean(a.rasterEffect))
      || Number(b.compactSurfaceRequired) - Number(a.compactSurfaceRequired)
      || Number(b.bindingRequired) - Number(a.bindingRequired)
      || Number(b.singleLineRequired) - Number(a.singleLineRequired)
      || Number(b.textBindingRequired) - Number(a.textBindingRequired)
      || area(b.bounds) - area(a.bounds))
    .slice(0, MAX_FACTS)

  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    source: '01-normalized/raw.normalized.json',
    rules: {
      priority: 'node-style-facts > assembly-plan > role-plans > page-layout > design-token-inference',
      bindingAttribute: 'data-style-source-node-id',
      requiredBindingAreaRatio: REQUIRED_AREA_RATIO,
      compactRoundedSurfaceRequired: true,
    },
    facts: candidates,
  }
}

export function requiredBackgroundFacts(nodeStyleFacts) {
  return (nodeStyleFacts?.facts || []).filter((fact) => fact.bindingRequired && fact.resolvedBackgroundColor)
}

export function requiredCompactSurfaceFacts(nodeStyleFacts) {
  return (nodeStyleFacts?.facts || []).filter((fact) => fact.compactSurfaceRequired && fact.resolvedBackgroundColor)
}

export function requiredTypographyFacts(nodeStyleFacts) {
  return (nodeStyleFacts?.facts || []).filter((fact) => fact.textBindingRequired && fact.typography)
}

export function requiredRasterEffectFacts(nodeStyleFacts) {
  return (nodeStyleFacts?.facts || []).filter((fact) => fact.rasterEffect)
}

function toStyleFact(node, rootArea, nodeById, rootIds, renderedCompositeNodeIds, rasterAssetByNodeId) {
  if (!node?.visible || !node?.style) return null
  const bounds = node.relativeBounds || node.bounds
  const fills = summarizePaints(node.style.fills)
  const strokes = summarizePaints(node.style.strokes)
  const solidFill = fills.find((paint) => paint.type === 'SOLID')
  const textColor = node.type === 'TEXT' ? solidFill?.color : undefined
  const typography = node.type === 'TEXT' ? summarizeTypography(node.style.text) : undefined
  const singleLineRequired = node.type === 'TEXT' ? inferSingleLineRequired(node, typography, bounds) : false
  const resolvedBackgroundColor = node.type !== 'TEXT' && solidFill ? solidFill.color : undefined
  const rasterEffects = summarizeRasterEffects(node.style.effects)
  const rasterAsset = rasterAssetByNodeId.get(String(node.sourceNodeId || node.id))
  const assetAvailable = Boolean(rasterAsset?.preferred?.copiedPath)
  const assetFormat = String(rasterAsset?.format || rasterAsset?.preferred?.format || '').toLowerCase() || undefined
  const rasterEffect = rasterEffects.length > 0 ? compact({
    effectTypes: [...new Set(rasterEffects.map((effect) => effect.type))],
    effects: rasterEffects,
    assetMode: assetAvailable ? (assetFormat === 'svg' ? 'required-final-svg' : 'required-final-png') : 'css-fallback',
    assetFormat,
    assetId: rasterAsset?.assetId,
    assetPath: rasterAsset?.preferred?.copiedPath,
    assetAvailable,
  }) : undefined
  const hasUsefulStyle = resolvedBackgroundColor || textColor || typography || strokes.length > 0 || node.style.cornerRadius || node.style.strokeWeight || rasterEffect
  if (!hasUsefulStyle || !bounds) return null

  const areaRatio = area(bounds) / rootArea
  const anchor = findPositionAnchor(node, nodeById, rootIds)
  const anchorBounds = anchor?.relativeBounds || anchor?.bounds
  const coveredByRenderedSlice = findAncestorId(node, nodeById, renderedCompositeNodeIds)
  const anchorUsesFixedCoordinates = String(anchor?.layout?.sourceFlexMode || '').toUpperCase() === 'NONE'
  const compactSurfaceRequired = isCompactRoundedSurface(node, bounds, resolvedBackgroundColor, coveredByRenderedSlice)
  const bindingRequired = Boolean(
    resolvedBackgroundColor
    && !coveredByRenderedSlice
    && isOpaqueColor(resolvedBackgroundColor)
    && Number(node.style.opacity ?? 1) === 1
    && node.type === 'RECTANGLE'
    && (!node.children || node.children.length === 0)
    && areaRatio >= REQUIRED_AREA_RATIO,
  )

  return compact({
    sourceNodeId: node.sourceNodeId || node.id,
    name: node.name,
    type: node.type,
    role: node.role,
    bounds: roundBounds(bounds),
    renderBounds: node.relativeRenderBounds ? roundBounds(node.relativeRenderBounds) : undefined,
    anchorNodeId: anchor ? String(anchor.sourceNodeId || anchor.id) : undefined,
    anchorBounds: anchorBounds ? roundBounds(anchorBounds) : undefined,
    localBounds: anchorBounds ? roundBounds({
      x: Number(bounds.x) - Number(anchorBounds.x),
      y: Number(bounds.y) - Number(anchorBounds.y),
      width: bounds.width,
      height: bounds.height,
    }) : undefined,
    renderLocalBounds: anchorBounds && node.relativeRenderBounds ? roundBounds({
      x: Number(node.relativeRenderBounds.x) - Number(anchorBounds.x),
      y: Number(node.relativeRenderBounds.y) - Number(anchorBounds.y),
      width: node.relativeRenderBounds.width,
      height: node.relativeRenderBounds.height,
    }) : undefined,
    areaRatio: round(areaRatio),
    opacity: node.style.opacity,
    fills,
    strokes,
    resolvedBackgroundColor,
    textColor,
    typography,
    singleLineRequired: singleLineRequired || undefined,
    rasterEffect,
    textBindingRequired: Boolean(typography && (singleLineRequired || anchorUsesFixedCoordinates || Number(typography.fontSize) >= 32 || Number(bounds.height) >= 48)),
    coveredByRenderedSlice,
    cornerRadius: node.style.cornerRadius,
    strokeWeight: node.style.strokeWeight,
    compactSurfaceRequired: compactSurfaceRequired || undefined,
    bindingRequired,
  })
}

function isCompactRoundedSurface(node, bounds, resolvedBackgroundColor, coveredByRenderedSlice) {
  if (!resolvedBackgroundColor || coveredByRenderedSlice || node.type === 'TEXT') return false
  if (Number(node.style?.opacity ?? 1) !== 1 || !(Number(node.style?.cornerRadius) > 0)) return false
  const width = Number(bounds?.width)
  const height = Number(bounds?.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
  // Preserve badges, chips, selected-tab capsules, buttons, and compact rounded controls as
  // real CSS surfaces. These nodes are visually important despite their tiny page-area ratio.
  return height <= 120 && width <= 800 && width >= 16 && height >= 12
}


function indexRequiredEffectAssets(assetIndex) {
  const result = new Map()
  for (const asset of assetIndex?.assets || []) {
    if (asset?.renderPolicy !== 'required-final' || !['png', 'svg'].includes(String(asset?.format || '').toLowerCase())) continue
    for (const source of asset.sourceNodes || []) {
      const sourceNodeId = String(source?.sourceNodeId || source?.nodeId || '')
      if (sourceNodeId && !result.has(sourceNodeId)) result.set(sourceNodeId, asset)
    }
  }
  return result
}

function summarizeRasterEffects(effects) {
  if (!Array.isArray(effects)) return []
  return effects
    .filter((effect) => effect && effect.isVisible !== false && RASTER_EFFECT_TYPES.has(String(effect.type || '').toUpperCase()))
    .map((effect) => compact({
      type: String(effect.type || '').toUpperCase(),
      radius: finiteNumber(effect.radius),
      spread: finiteNumber(effect.spread),
      offset: effect.offset && typeof effect.offset === 'object' ? compact({
        x: finiteNumber(effect.offset.x),
        y: finiteNumber(effect.offset.y),
      }) : undefined,
      color: effect.color ? colorToCss(effect.color, effect.color?.a ?? 1) : undefined,
      blendMode: effect.blendMode,
    }))
}

function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? round(number) : undefined
}

function summarizeTypography(text) {
  if (!text || typeof text !== 'object') return undefined
  const typography = compact({
    fontFamily: text.fontFamily,
    fontStyle: text.fontStyle,
    textAutoResize: text.textAutoResize,
    fontSize: numberOrUndefined(text.fontSize),
    fontWeight: normalizeFontWeight(text.fontWeight, text.fontStyle),
    lineHeight: numberOrUndefined(text.lineHeight),
    textAlignHorizontal: text.textAlignHorizontal,
    textAlignVertical: text.textAlignVertical,
  })
  return Object.keys(typography).length > 0 ? typography : undefined
}


function inferSingleLineRequired(node, typography, bounds) {
  const characters = typeof node?.text === 'string'
    ? node.text
    : typeof node?.style?.text?.characters === 'string' ? node.style.text.characters : ''
  if (!characters || /[\r\n]/.test(characters)) return false

  const resizeMode = String(typography?.textAutoResize || node?.style?.text?.textAutoResize || '').toUpperCase()
  if (resizeMode === 'WIDTH_AND_HEIGHT') return true

  const height = Number(bounds?.height)
  const lineHeight = Number(typography?.lineHeight)
  const fontSize = Number(typography?.fontSize)
  const oneLineHeight = Number.isFinite(lineHeight) && lineHeight > 0
    ? lineHeight
    : Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.5 : Number.NaN
  return Number.isFinite(height) && Number.isFinite(oneLineHeight) && height <= oneLineHeight * 1.25
}

function normalizeFontWeight(value, fontStyle) {
  const number = Number(value)
  if (Number.isFinite(number) && number > 0) return round(number)
  if (/bold|semibold|demibold|heavy|black/i.test(String(fontStyle || ''))) return /semi|demi/i.test(String(fontStyle || '')) ? 600 : 700
  if (/medium/i.test(String(fontStyle || ''))) return 500
  return 400
}

function numberOrUndefined(value) {
  const number = Number(value)
  return Number.isFinite(number) ? round(number) : undefined
}

function summarizePaints(paints) {
  if (!Array.isArray(paints)) return []
  return paints.map((paint) => compact({
    type: paint?.type,
    color: paint?.type === 'SOLID' ? colorToCss(paint.color, paint.alpha) : undefined,
    alpha: paint?.alpha,
    blendMode: paint?.blendMode,
  })).filter((paint) => paint.type)
}

function colorToCss(color, paintAlpha) {
  if (!color || typeof color !== 'object') return undefined
  const r = channel(color.r)
  const g = channel(color.g)
  const b = channel(color.b)
  const alpha = clampAlpha((color.a ?? 1) * (paintAlpha ?? 1))
  if (alpha < 1) return `rgba(${r}, ${g}, ${b}, ${round(alpha)})`
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function channel(value) {
  const number = Number(value || 0)
  return Math.round(Math.max(0, Math.min(1, number)) * 255)
}

function clampAlpha(value) {
  return Math.max(0, Math.min(1, Number(value ?? 1)))
}

function isOpaqueColor(value) {
  return !String(value).startsWith('rgba(') || /,\s*1(?:\.0+)?\s*\)$/.test(String(value))
}

function flatten(node, output) {
  if (!node) return
  output.push(node)
  for (const child of node.children || []) flatten(child, output)
}

function findPositionAnchor(node, nodeById, rootIds) {
  if (!node?.parentId) return null
  let current = node
  const seen = new Set()
  while (current?.parentId && !rootIds.has(String(current.parentId)) && !seen.has(String(current.parentId))) {
    seen.add(String(current.parentId))
    current = nodeById.get(String(current.parentId))
  }
  if (current?.parentId && rootIds.has(String(current.parentId))) return current
  return current?.parentId ? nodeById.get(String(current.parentId)) : null
}

function findAncestorId(node, nodeById, targetIds) {
  let current = node
  const seen = new Set()
  while (current?.parentId && !seen.has(String(current.parentId))) {
    seen.add(String(current.parentId))
    const parentId = String(current.parentId)
    if (targetIds.has(parentId)) return parentId
    current = nodeById.get(parentId)
  }
  return undefined
}

function area(bounds) {
  return Math.max(0, Number(bounds?.width || 0)) * Math.max(0, Number(bounds?.height || 0))
}

function roundBounds(bounds) {
  return {
    x: round(bounds.x),
    y: round(bounds.y),
    width: round(bounds.width),
    height: round(bounds.height),
  }
}

function round(value) {
  return Math.round(Number(value || 0) * 10000) / 10000
}

function toHex(value) {
  return Math.max(0, Math.min(255, Number(value || 0))).toString(16).padStart(2, '0')
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null))
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
