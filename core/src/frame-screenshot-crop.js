import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PNG } from 'pngjs'

const COMPLEX_NAME_RE = /(logo|品牌|标志|icon|图标|mask|蒙版|decor|decoration|背景装饰|复杂|波点|点阵|网格|pattern)/i
const WHOLE_NODE_PNG_NAME_RE = /整体导出|整体显示/
const STRUCTURAL_TYPES = new Set(['FRAME', 'SECTION', 'COMPONENT', 'INSTANCE'])
const VECTOR_TYPES = new Set(['PATH', 'VECTOR', 'BOOLEAN_OPERATION', 'BOOLEAN'])

export function cropComplexNodesFromScreenshot(options = {}) {
  const { inputDir, raw, manifest } = options
  const screenshotPath = options.screenshot || join(inputDir, 'frame-screenshot.png')
  if (!existsSync(screenshotPath)) throw new Error(`Frame 截图不存在：${screenshotPath}`)

  const sourcePng = PNG.sync.read(readFileSync(screenshotPath))
  if (sourcePng.width <= 1 || sourcePng.height <= 1) {
    throw new Error('frame-screenshot.png 是 1x1 占位图，无法执行复杂节点裁切。')
  }

  const root = raw.selection?.[0]
  const frameBounds = readBounds(root)
  if (!frameBounds?.width || !frameBounds?.height) throw new Error('Magic DSL 根 Frame 缺少有效 BoundingBox。')

  const transform = calculateScreenshotTransform(frameBounds, {
    width: sourcePng.width,
    height: sourcePng.height,
  })
  const existingNodeIds = collectPresentRenderedNodeIds(manifest)
  const manualNodeIds = new Set((options.cropNodeIds || []).map(String))
  const candidates = collectCropCandidates(root, {
    frameBounds,
    existingNodeIds,
    manualNodeIds,
    auto: options.auto !== false,
  })
  const selected = selectNonOverlappingCandidates(candidates)
  const crops = []

  for (const candidate of selected) {
    const pixelBounds = designBoundsToPixels(candidate.bounds, frameBounds, transform)
    if (pixelBounds.width <= 0 || pixelBounds.height <= 0) continue
    const safeNodeId = safeFilePart(candidate.node.id)
    const copiedPath = `assets/rendered/node_${safeNodeId}.png`
    const outputPath = join(inputDir, copiedPath)
    cropPng({ sourcePng, outputPath, crop: pixelBounds })
    const asset = buildRenderedAsset(candidate, copiedPath, pixelBounds, transform)
    manifest.assets.push(asset)
    crops.push({
      assetId: asset.assetId,
      nodeId: candidate.node.id,
      nodeName: candidate.node.name,
      strategy: 'frame-screenshot-crop',
      reasons: candidate.reasons,
      designBounds: candidate.bounds,
      pixelBounds,
      copiedPath,
      renderPolicy: asset.renderPolicy,
    })
  }

  return {
    crops,
    screenshot: {
      path: screenshotPath,
      pixelWidth: sourcePng.width,
      pixelHeight: sourcePng.height,
      designBounds: frameBounds,
      scaleX: transform.scaleX,
      scaleY: transform.scaleY,
    },
  }
}

export function hasWholeNodePngNaming(raw) {
  let matched = false
  for (const root of raw?.selection || []) {
    walkNode(root, [], (node) => {
      if (isWholeNodePngName(node?.name)) matched = true
    })
    if (matched) break
  }
  return matched
}

function isWholeNodePngName(name) {
  return WHOLE_NODE_PNG_NAME_RE.test(String(name || ''))
}

export function calculateScreenshotTransform(frameBounds, screenshotSize) {
  const scaleX = screenshotSize.width / frameBounds.width
  const scaleY = screenshotSize.height / frameBounds.height
  const difference = Math.abs(scaleX - scaleY) / Math.max(scaleX, scaleY)
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY <= 0) {
    throw new Error('无法计算截图与设计坐标的缩放比例。')
  }
  if (difference > 0.02) {
    throw new Error(`截图和 Frame 长宽比不一致：scaleX=${round(scaleX)}，scaleY=${round(scaleY)}`)
  }
  return { ...screenshotSize, scaleX, scaleY }
}

export function designBoundsToPixels(nodeBounds, frameBounds, transform) {
  const left = Math.floor((nodeBounds.x - frameBounds.x) * transform.scaleX)
  const top = Math.floor((nodeBounds.y - frameBounds.y) * transform.scaleY)
  const right = Math.ceil((nodeBounds.x + nodeBounds.width - frameBounds.x) * transform.scaleX)
  const bottom = Math.ceil((nodeBounds.y + nodeBounds.height - frameBounds.y) * transform.scaleY)
  return clampPixelBounds({
    left,
    top,
    width: right - left,
    height: bottom - top,
  }, transform)
}

function collectCropCandidates(root, context) {
  const candidates = []
  walkNode(root, [], (node, ancestors) => {
    const wholeNodePng = isWholeNodePngName(node?.name)
    if (!node?.id || (node === root && !wholeNodePng) || context.existingNodeIds.has(String(node.id))) return
    const manual = context.manualNodeIds.has(String(node.id))
    if (!manual && !context.auto && !wholeNodePng) return
    const classified = classifyCropCandidate(node, context.frameBounds, { manual, wholeNodePng })
    if (!classified) return
    candidates.push({
      node,
      ancestors: ancestors.map((ancestor) => String(ancestor.id || '')).filter(Boolean),
      depth: ancestors.length,
      ...classified,
    })
  })
  return candidates
}

function classifyCropCandidate(node, frameBounds, options = {}) {
  const bounds = readBounds(node, true)
  if (!bounds || bounds.width < 8 || bounds.height < 8) return null
  if (!intersects(bounds, frameBounds)) return null
  const areaRatio = area(bounds) / area(frameBounds)
  const hasText = hasTextDescendant(node)
  const wholeNodePng = options.wholeNodePng || isWholeNodePngName(node.name)
  const reasons = wholeNodePng
    ? ['mastergo-name:整体导出/整体显示', ...collectComplexSignals(node)]
    : collectComplexSignals(node)

  if (!options.manual && !wholeNodePng && reasons.length === 0) return null
  if (!options.manual && !wholeNodePng && STRUCTURAL_TYPES.has(String(node.type || '').toUpperCase()) && areaRatio > 0.25) return null
  if (!options.manual && !wholeNodePng && hasText) return null
  if (!options.manual && !wholeNodePng && areaRatio > 0.45 && !/背景装饰|mask|蒙版/i.test(String(node.name || ''))) return null

  return {
    bounds,
    reasons: options.manual ? ['manual-node-selection', ...reasons] : reasons,
    usageHint: wholeNodePng ? 'masked-composite' : inferUsageHint(node, reasons),
    renderPolicy: wholeNodePng || !hasText ? 'required-final' : 'review-only',
    wholeNodePng,
  }
}

function collectComplexSignals(node) {
  const signals = []
  const type = String(node.type || '').toUpperCase()
  const fidelity = node.magicDsl || {}
  if (VECTOR_TYPES.has(type)) signals.push('complex-vector')
  if (COMPLEX_NAME_RE.test(String(node.name || ''))) signals.push('semantic-complex-name')
  if (fidelity.blendMode && String(fidelity.blendMode).toUpperCase() !== 'NORMAL') signals.push('blend-mode')
  if (Array.isArray(fidelity.effects) && fidelity.effects.length > 0) signals.push('effects')
  if (fidelity.svgKey || fidelity.svgShortKey) signals.push('svg-reference')
  if ((node.children || []).length >= 3 && ['GROUP', 'FRAME'].includes(type) && COMPLEX_NAME_RE.test(String(node.name || ''))) {
    signals.push('composite-group')
  }
  return unique(signals)
}

function selectNonOverlappingCandidates(candidates) {
  const selected = []
  const selectedIds = new Set()
  for (const candidate of candidates.sort((a, b) => a.depth - b.depth || area(a.bounds) - area(b.bounds))) {
    if (candidate.ancestors.some((id) => selectedIds.has(id))) continue
    selected.push(candidate)
    selectedIds.add(String(candidate.node.id))
  }
  return selected
}

function collectPresentRenderedNodeIds(manifest) {
  const ids = new Set()
  for (const asset of manifest.assets || []) {
    const present = (asset.status === 'present' && (asset.copiedPath || asset.suggestedFile))
      || (asset.renderedAssets || []).some((item) => item.status === 'present' && item.copiedPath)
    if (!present) continue
    for (const source of asset.sourceNodes || []) if (source.nodeId) ids.add(String(source.nodeId))
  }
  return ids
}

function buildRenderedAsset(candidate, copiedPath, pixelBounds, transform) {
  const safeNodeId = safeFilePart(candidate.node.id)
  const assetId = `hydrated_node_${safeNodeId}`
  const sliceId = `hydrated_slice_${safeNodeId}`
  return {
    assetId,
    kind: 'node-slice',
    usageHint: candidate.usageHint,
    renderPolicy: candidate.renderPolicy,
    mustUseRenderedSlice: candidate.renderPolicy === 'required-final',
    wholeNodePng: candidate.wholeNodePng || undefined,
    format: 'png',
    targetDir: 'assets/rendered',
    status: 'present',
    sourceNodes: [{
      nodeId: String(candidate.node.id),
      nodeName: candidate.node.name,
      paintPath: 'node',
      usageHint: candidate.usageHint,
      exportFormat: 'png',
      renderReason: `Frame screenshot crop: ${candidate.reasons.join(', ')}`,
      wholeNodePng: candidate.wholeNodePng || undefined,
    }],
    suggestedFile: copiedPath,
    copiedPath,
    renderedAssets: [{
      assetId: sliceId,
      kind: 'rendered-image',
      format: 'png',
      nodeId: String(candidate.node.id),
      status: 'present',
      suggestedFile: copiedPath,
      copiedPath,
      width: pixelBounds.width,
      height: pixelBounds.height,
      exportScale: round((transform.scaleX + transform.scaleY) / 2),
      cropSource: 'frame-screenshot',
    }],
    hydration: {
      provider: 'frame-screenshot-crop',
      reasons: candidate.reasons,
      designBounds: candidate.bounds,
      pixelBounds,
      scaleX: round(transform.scaleX),
      scaleY: round(transform.scaleY),
    },
  }
}

function cropPng({ sourcePng, outputPath, crop }) {
  const target = new PNG({ width: crop.width, height: crop.height })
  PNG.bitblt(sourcePng, target, crop.left, crop.top, crop.width, crop.height, 0, 0)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, PNG.sync.write(target))
}

function readBounds(node, preferRenderBounds = false) {
  const bounds = preferRenderBounds
    ? node?.absoluteRenderBounds || node?.absoluteBoundingBox || node?.bounds
    : node?.absoluteBoundingBox || node?.bounds
  if (!bounds) return null
  const output = {
    x: Number(bounds.x),
    y: Number(bounds.y),
    width: Number(bounds.width),
    height: Number(bounds.height),
  }
  return Object.values(output).every(Number.isFinite) ? output : null
}

function clampPixelBounds(bounds, screenshotSize) {
  const left = Math.max(0, Math.min(screenshotSize.width, bounds.left))
  const top = Math.max(0, Math.min(screenshotSize.height, bounds.top))
  const right = Math.max(left, Math.min(screenshotSize.width, bounds.left + bounds.width))
  const bottom = Math.max(top, Math.min(screenshotSize.height, bounds.top + bounds.height))
  return { left, top, width: right - left, height: bottom - top }
}

function hasTextDescendant(node) {
  let found = false
  walkNode(node, [], (child) => {
    if (child !== node && (child.type === 'TEXT' || child.characters)) found = true
  })
  return found
}

function inferUsageHint(node, reasons) {
  const name = String(node.name || '')
  if (/logo|品牌|标志/i.test(name)) return 'logo'
  if (/icon|图标/i.test(name)) return 'icon'
  if (/mask|蒙版/i.test(name)) return 'masked-composite'
  if (/背景装饰|decor|decoration|波点|点阵|网格|pattern/i.test(name)) return 'background-decor-mask'
  if (reasons.includes('complex-vector')) return 'complex-vector'
  return 'rendered-visual'
}

function walkNode(node, ancestors, visitor) {
  if (!node) return
  visitor(node, ancestors)
  for (const child of node.children || []) walkNode(child, [...ancestors, node], visitor)
}

function intersects(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

function area(bounds) {
  return Math.max(0, bounds?.width || 0) * Math.max(0, bounds?.height || 0)
}

function safeFilePart(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

function round(value) {
  return Math.round(Number(value) * 1000) / 1000
}

function unique(values) {
  return [...new Set(values)]
}

export const frameScreenshotCropInternals = {
  classifyCropCandidate,
  collectComplexSignals,
  selectNonOverlappingCandidates,
}
