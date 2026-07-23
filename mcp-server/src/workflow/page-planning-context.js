import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildImmutableTextContract, readOrCreateImmutableSourceTexts } from './immutable-source-texts.js'

export function buildPagePlanningContext(jobDir) {
  const normalizedDir = join(jobDir, '01-normalized')
  const layoutDir = join(jobDir, '02-layout')
  const screenshotPath = join(jobDir, '00-input', 'frame-screenshot.png')

  if (!existsSync(screenshotPath)) {
    throw new Error('阶段六缺少必要输入：00-input/frame-screenshot.png')
  }

  const normalized = readJson(join(normalizedDir, 'raw.normalized.json'))
  const sourceTextsPath = join(normalizedDir, 'source-texts.json')
  const sourceTexts = readOrCreateImmutableSourceTexts(sourceTextsPath, join(normalizedDir, 'raw.normalized.json'))
  const assetIndex = readJson(join(normalizedDir, 'asset-index.json'))
  const designTokens = readJson(join(normalizedDir, 'design-tokens.json'))
  const pageLayout = readFileSync(join(layoutDir, 'page-layout.md'), 'utf8')
  const nodes = flattenNodes(normalized.nodes || [])

  return {
    source: normalized.source,
    rootId: normalized.rootId,
    frameScreenshotPath: screenshotPath,
    pageLayout,
    immutableTextContract: buildImmutableTextContract(sourceTexts),
    nodes: nodes
      .filter((node) => node.visible !== false && node.role !== 'ignored')
      .map(compactNode),
    assets: (assetIndex.assets || []).map((asset) => ({
      assetId: asset.assetId,
      imageRef: asset.imageRef,
      usage: asset.usage,
      status: asset.status,
      uncertainty: asset.uncertainty,
      copiedPath: asset.preferred?.copiedPath,
      preferredKind: asset.preferred?.kind,
      preferredExists: asset.preferred?.exists,
      originalPath: asset.original?.suggestedFile,
      originalExists: asset.original?.exists,
      renderedPaths: (asset.rendered || []).map((item) => item.path),
      sourceNodes: (asset.sourceNodes || []).map((node) => ({
        sourceNodeId: node.sourceNodeId,
        sourceNodeName: node.sourceNodeName,
        nodeType: node.nodeType,
        scaleMode: node.scaleMode,
      })),
      error: asset.error,
    })),
    designTokens: designTokens.tokens,
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function flattenNodes(nodes) {
  const result = []
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    result.push(node)
    for (const child of node.children || []) visit(child)
  }
  for (const node of nodes) visit(node)
  return result
}

export function compactNode(node) {
  return {
    sourceNodeId: node.sourceNodeId || node.id,
    parentId: node.parentId,
    depth: node.depth,
    name: truncate(node.name, 120),
    type: node.type,
    role: node.role,
    bounds: node.relativeBounds || node.bounds,
    layout: node.layout,
    text: node.text ? {
      preview: truncate(compactWhitespace(node.text), 120),
      characterCount: String(node.text).length,
      explicitLineCount: String(node.text).split('\n').length,
      fontFamily: node.style?.text?.fontFamily,
      fontSize: node.style?.text?.fontSize,
      fontWeight: node.style?.text?.fontWeight,
      lineHeight: node.style?.text?.lineHeight,
      textAlignHorizontal: node.style?.text?.textAlignHorizontal,
    } : undefined,
    style: node.style ? {
      opacity: node.style.opacity,
      fills: summarizePaints(node.style.fills),
      strokes: summarizePaints(node.style.strokes),
      effects: (node.style.effects || []).map((effect) => ({
        type: effect.type,
        visible: effect.visible,
        radius: effect.radius,
        offset: effect.offset,
      })),
      cornerRadius: node.style.cornerRadius,
      strokeWeight: node.style.strokeWeight,
    } : undefined,
    images: node.images,
  }
}

function summarizePaints(paints) {
  return (paints || []).map((paint) => ({
    type: paint.type,
    color: paint.color,
    alpha: paint.alpha,
    opacity: paint.opacity,
    imageRef: paint.imageRef,
    scaleMode: paint.scaleMode,
  }))
}

function truncate(value, maxLength) {
  if (value === undefined || value === null) return value
  const text = String(value)
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}
