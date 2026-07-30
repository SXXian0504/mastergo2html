import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const VERSION = 'mastergo2html.node-style-facts.v1'
const MAX_FACTS = 120
const REQUIRED_AREA_RATIO = 0.04

export function readOrCreateNodeStyleFacts(path, normalizedRawPath, assetIndex) {
  if (existsSync(path)) return readJson(path)
  const payload = buildNodeStyleFacts(readJson(normalizedRawPath), assetIndex)
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
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
  const rootArea = Math.max(1, ...roots.map((node) => area(node?.relativeBounds || node?.bounds)))

  const candidates = nodes
    .map((node) => toStyleFact(node, rootArea, nodeById, rootIds, renderedCompositeNodeIds))
    .filter(Boolean)
    .sort((a, b) => Number(b.bindingRequired) - Number(a.bindingRequired)
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
    },
    facts: candidates,
  }
}

export function requiredBackgroundFacts(nodeStyleFacts) {
  return (nodeStyleFacts?.facts || []).filter((fact) => fact.bindingRequired && fact.resolvedBackgroundColor)
}

export function requiredTypographyFacts(nodeStyleFacts) {
  return (nodeStyleFacts?.facts || []).filter((fact) => fact.textBindingRequired && fact.typography)
}

function toStyleFact(node, rootArea, nodeById, rootIds, renderedCompositeNodeIds) {
  if (!node?.visible || !node?.style) return null
  const bounds = node.relativeBounds || node.bounds
  const fills = summarizePaints(node.style.fills)
  const strokes = summarizePaints(node.style.strokes)
  const solidFill = fills.find((paint) => paint.type === 'SOLID')
  const textColor = node.type === 'TEXT' ? solidFill?.color : undefined
  const typography = node.type === 'TEXT' ? summarizeTypography(node.style.text) : undefined
  const resolvedBackgroundColor = node.type !== 'TEXT' && solidFill ? solidFill.color : undefined
  const hasUsefulStyle = resolvedBackgroundColor || textColor || typography || strokes.length > 0 || node.style.cornerRadius || node.style.strokeWeight
  if (!hasUsefulStyle || !bounds) return null

  const areaRatio = area(bounds) / rootArea
  const anchor = findPositionAnchor(node, nodeById, rootIds)
  const anchorBounds = anchor?.relativeBounds || anchor?.bounds
  const coveredByRenderedSlice = findAncestorId(node, nodeById, renderedCompositeNodeIds)
  const anchorUsesFixedCoordinates = String(anchor?.layout?.sourceFlexMode || '').toUpperCase() === 'NONE'
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
    anchorNodeId: anchor ? String(anchor.sourceNodeId || anchor.id) : undefined,
    anchorBounds: anchorBounds ? roundBounds(anchorBounds) : undefined,
    localBounds: anchorBounds ? roundBounds({
      x: Number(bounds.x) - Number(anchorBounds.x),
      y: Number(bounds.y) - Number(anchorBounds.y),
      width: bounds.width,
      height: bounds.height,
    }) : undefined,
    areaRatio: round(areaRatio),
    opacity: node.style.opacity,
    fills,
    strokes,
    resolvedBackgroundColor,
    textColor,
    typography,
    textBindingRequired: Boolean(typography && (anchorUsesFixedCoordinates || Number(typography.fontSize) >= 32 || Number(bounds.height) >= 48)),
    coveredByRenderedSlice,
    cornerRadius: node.style.cornerRadius,
    strokeWeight: node.style.strokeWeight,
    bindingRequired,
  })
}

function summarizeTypography(text) {
  if (!text || typeof text !== 'object') return undefined
  const typography = compact({
    fontFamily: text.fontFamily,
    fontStyle: text.fontStyle,
    fontSize: numberOrUndefined(text.fontSize),
    fontWeight: normalizeFontWeight(text.fontWeight, text.fontStyle),
    lineHeight: numberOrUndefined(text.lineHeight),
    textAlignHorizontal: text.textAlignHorizontal,
    textAlignVertical: text.textAlignVertical,
  })
  return Object.keys(typography).length > 0 ? typography : undefined
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
