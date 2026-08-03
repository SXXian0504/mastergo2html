import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { createInputFromCodexMasterGo } from './codex-mastergo-input.js'

export function createSnapshotAssetIndex(options = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'mastergo2html-snapshot-index-'))
  const inputDir = join(tempRoot, '00-input')

  try {
    const result = createInputFromCodexMasterGo({
      ...options,
      output: inputDir,
    })
    const raw = readJson(join(inputDir, 'raw.json'))
    const manifest = readJson(join(inputDir, 'asset-manifest.json'))
    const root = raw.selection?.[0] || null
    const nodeById = indexNodes(root)
    const assets = (manifest.assets || []).map((asset) => buildCandidate(asset, inputDir, nodeById))
    const index = buildIndexMaps(assets)

    return {
      snapshot: result.snapshot,
      inputDir,
      root,
      assets,
      ...index,
      screenshotPath: join(inputDir, 'frame-screenshot.png'),
      dispose() {
        rmSync(tempRoot, { recursive: true, force: true })
      },
    }
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true })
    throw error
  }
}

function buildCandidate(asset, inputDir, nodeById) {
  const copiedPath = asset.copiedPath
    || asset.renderedAssets?.find((item) => item.status === 'present' && item.copiedPath)?.copiedPath
    || ''
  const sourcePath = copiedPath ? join(inputDir, copiedPath) : ''
  const sourceNodes = (asset.sourceNodes || []).map((source) => ({
    ...source,
    bounds: nodeById.get(String(source.nodeId || ''))?.absoluteBoundingBox,
  }))
  const keys = unique([
    asset.imageRef,
    asset.originalFileName,
    asset.suggestedFile,
    asset.copiedPath,
    copiedPath,
    ...sourceNodes.map((source) => source.nodeId),
  ].flatMap(resourceKeys))

  const manifestFormat = normalizeFormat(asset.format)
  return {
    assetId: asset.assetId,
    kind: asset.kind,
    format: manifestFormat === 'unknown' ? normalizeFormat(extname(copiedPath)) : manifestFormat,
    imageRef: asset.imageRef,
    originalFileName: asset.originalFileName || basename(copiedPath),
    copiedPath,
    sourcePath,
    sourceNodes,
    usageHint: asset.usageHint,
    keys,
  }
}

function buildIndexMaps(assets) {
  const byNodeId = new Map()
  const byKey = new Map()

  for (const asset of assets) {
    for (const source of asset.sourceNodes) pushMapArray(byNodeId, String(source.nodeId || ''), asset)
    for (const key of asset.keys) pushMapArray(byKey, key, asset)
  }

  return { byNodeId, byKey }
}

function indexNodes(root) {
  const nodes = new Map()
  walkNode(root, (node) => {
    if (node?.id) nodes.set(String(node.id), node)
  })
  return nodes
}

function walkNode(node, visitor) {
  if (!node) return
  visitor(node)
  for (const child of node.children || []) walkNode(child, visitor)
}

function resourceKeys(value) {
  const text = String(value || '').trim()
  if (!text) return []
  const clean = text
    .replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '')
    .split('?')[0]
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .toLowerCase()
  const file = basename(clean)
  const extension = extname(file)
  const stem = extension ? file.slice(0, -extension.length) : file
  return unique([clean, file, stem].filter(Boolean))
}

function normalizeFormat(value) {
  const clean = String(value || '').toLowerCase().replace(/^\./, '')
  if (clean === 'jpeg') return 'jpg'
  return ['svg', 'png', 'jpg', 'webp', 'gif'].includes(clean) ? clean : 'unknown'
}

function pushMapArray(map, key, value) {
  if (!key) return
  const values = map.get(key) || []
  if (!values.includes(value)) values.push(value)
  map.set(key, values)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function unique(values) {
  return [...new Set(values)]
}

export const snapshotAssetIndexInternals = {
  resourceKeys,
}
