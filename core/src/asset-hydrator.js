import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { createSnapshotAssetIndex, snapshotAssetIndexInternals } from './snapshot-asset-index.js'
import { cropComplexNodesFromScreenshot, hasWholeNodePngNaming } from './frame-screenshot-crop.js'

const MIN_MATCH_SCORE = 70
const MIN_MATCH_MARGIN = 15

export function hydrateInputAssets(options = {}) {
  if (!options.inputDir) throw new Error('缺少 Asset Hydrator 输入：inputDir')
  const inputDir = resolve(options.inputDir)
  const rawPath = join(inputDir, 'raw.json')
  const manifestPath = join(inputDir, 'asset-manifest.json')
  const reportPath = join(inputDir, 'asset-hydration-report.json')
  const raw = readJson(rawPath)
  const manifest = readJson(manifestPath)
  const nodeById = indexNodes(raw.selection?.[0])
  const report = {
    version: 'mastergo2html.asset-hydration-report.v1',
    generatedAt: new Date().toISOString(),
    inputDir,
    provider: {
      kind: 'codex-mastergo-snapshot',
      status: 'not-requested',
    },
    rootValidation: null,
    matches: [],
    ambiguous: [],
    unresolved: [],
    crops: [],
    errors: [],
    counts: {
      matched: 0,
      cropped: 0,
      ambiguous: 0,
      missing: 0,
      skippedPresent: 0,
    },
  }

  let snapshotIndex = null
  let strictError = null
  try {
    const wantsSnapshot = Boolean(options.snapshotHtml || options.designRoot)
    if (wantsSnapshot) {
      try {
        snapshotIndex = createSnapshotAssetIndex({
          snapshotHtml: options.snapshotHtml,
          designRoot: options.designRoot,
          screenshot: options.screenshot,
          nodeId: options.nodeId,
          frameName: options.frameName,
        })
        report.provider = {
          kind: 'codex-mastergo-snapshot',
          status: 'ready',
          snapshotHtml: snapshotIndex.snapshot?.htmlPath,
          candidateCount: snapshotIndex.assets.length,
        }
        report.rootValidation = validateRoots(raw.selection?.[0], snapshotIndex.root)
        hydrateMissingAssets({ inputDir, manifest, nodeById, snapshotIndex, report })
      } catch (error) {
        recordError(report, 'snapshot-index', error)
        report.provider.status = 'error'
        if (!strictError) strictError = error
      }
    }

    const hasNamedWholeNodePng = hasWholeNodePngNaming(raw)
    if (hasNamedWholeNodePng || options.cropComplex || (options.cropNodeIds || []).length > 0) {
      const screenshot = selectScreenshot(options, inputDir, snapshotIndex, report.rootValidation)
      if (screenshot.error) {
        recordError(report, 'frame-screenshot-crop', new Error(screenshot.error))
        if (!strictError) strictError = new Error(screenshot.error)
      } else {
        try {
          const cropResult = cropComplexNodesFromScreenshot({
            inputDir,
            raw,
            manifest,
            screenshot: screenshot.path,
            cropNodeIds: options.cropNodeIds,
            auto: options.cropComplex,
          })
          report.crops.push(...cropResult.crops)
          report.screenshot = cropResult.screenshot
          report.counts.cropped = cropResult.crops.length
        } catch (error) {
          recordError(report, 'frame-screenshot-crop', error)
          if (!strictError) strictError = error
        }
      }
    }

    report.counts.missing = (manifest.assets || []).filter((asset) => !isTrulyPresent(asset, inputDir)).length
    manifest.files = buildManifestFiles(manifest.assets || [])
    manifest.hydration = {
      version: report.version,
      generatedAt: report.generatedAt,
      provider: report.provider,
      rootValidation: report.rootValidation,
      counts: report.counts,
      reportFile: 'asset-hydration-report.json',
    }
    writeJson(manifestPath, manifest)
    writeJson(reportPath, report)
  } finally {
    snapshotIndex?.dispose()
  }

  if (options.strict && (strictError || report.errors.length > 0)) {
    const error = strictError || new Error('Asset Hydrator 严格模式检测到错误。')
    error.reportPath = reportPath
    throw error
  }

  return {
    ok: report.errors.length === 0,
    inputDir,
    reportPath,
    ...report.counts,
    errors: report.errors,
  }
}

function hydrateMissingAssets({ inputDir, manifest, nodeById, snapshotIndex, report }) {
  for (const asset of manifest.assets || []) {
    if (isTrulyPresent(asset, inputDir)) {
      report.counts.skippedPresent += 1
      continue
    }

    const ranked = snapshotIndex.assets
      .filter((candidate) => candidate.sourcePath && existsSync(candidate.sourcePath))
      .map((candidate) => scoreCandidate(asset, candidate, nodeById))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || a.candidate.assetId.localeCompare(b.candidate.assetId))
    const best = ranked[0]
    const second = ranked[1]
    if (!best || best.score < MIN_MATCH_SCORE) {
      report.unresolved.push({
        assetId: asset.assetId,
        imageRef: asset.imageRef,
        bestScore: best?.score || 0,
        reason: 'no-confident-match',
      })
      continue
    }
    if (second && best.score - second.score < MIN_MATCH_MARGIN) {
      report.ambiguous.push({
        assetId: asset.assetId,
        imageRef: asset.imageRef,
        candidates: ranked.slice(0, 5).map(summarizeMatch),
      })
      report.counts.ambiguous += 1
      continue
    }

    const copiedPath = copyHydratedAsset(inputDir, asset, best.candidate)
    applyHydratedAsset(asset, best.candidate, copiedPath, best)
    report.matches.push({
      assetId: asset.assetId,
      candidateAssetId: best.candidate.assetId,
      sourcePath: best.candidate.sourcePath,
      copiedPath,
      score: best.score,
      reasons: best.reasons,
    })
    report.counts.matched += 1
  }
}

function scoreCandidate(asset, candidate, nodeById) {
  let score = 0
  const reasons = []
  const assetNodeIds = new Set((asset.sourceNodes || []).map((source) => String(source.nodeId || '')).filter(Boolean))
  const candidateNodeIds = new Set((candidate.sourceNodes || []).map((source) => String(source.nodeId || '')).filter(Boolean))
  if ([...assetNodeIds].some((nodeId) => candidateNodeIds.has(nodeId))) {
    score += 100
    reasons.push('exact-node-id')
  }

  const assetReferences = [asset.imageRef, asset.originalFileName, asset.suggestedFile, asset.copiedPath].filter(Boolean)
  const candidateReferences = [
    candidate.imageRef,
    candidate.originalFileName,
    candidate.copiedPath,
    ...candidate.keys,
  ].filter(Boolean)
  const exactReferences = intersect(
    assetReferences.map(normalizeResourceReference),
    candidateReferences.map(normalizeResourceReference),
  )
  const exactHashes = intersect(resourceHashes(assetReferences), resourceHashes(candidateReferences))
  if (exactReferences.length > 0) {
    score += 80
    reasons.push(`exact-resource-key:${exactReferences[0]}`)
  } else if (exactHashes.length > 0) {
    score += 80
    reasons.push(`exact-resource-hash:${exactHashes[0]}`)
  } else if (sameBasenameOrStem(
    assetReferences.flatMap(snapshotAssetIndexInternals.resourceKeys),
    candidateReferences.flatMap(snapshotAssetIndexInternals.resourceKeys),
  )) {
    score += 60
    reasons.push('same-basename-or-stem')
  }

  const targetFormat = normalizeFormat(asset.format || extname(asset.suggestedFile || ''))
  if (targetFormat !== 'unknown' && candidate.format === targetFormat) {
    score += 10
    reasons.push('same-format')
  } else if (asset.kind === 'node-slice' && candidate.format === 'svg') {
    score += 5
    reasons.push('vector-compatible')
  }

  if (asset.usageHint && candidate.usageHint && asset.usageHint === candidate.usageHint) {
    score += 5
    reasons.push('same-usage')
  }

  const boundsScore = scoreBounds(asset, candidate, nodeById)
  if (boundsScore > 0) {
    score += boundsScore
    reasons.push('matching-bounds')
  }

  return { candidate, score, reasons }
}

function scoreBounds(asset, candidate, nodeById) {
  const sourceBounds = (asset.sourceNodes || [])
    .map((source) => nodeById.get(String(source.nodeId || '')))
    .map(readBounds)
    .find(Boolean)
  const candidateBounds = (candidate.sourceNodes || []).map((source) => source.bounds).find(Boolean)
  if (!sourceBounds || !candidateBounds) return 0
  const widthDelta = relativeDelta(sourceBounds.width, candidateBounds.width)
  const heightDelta = relativeDelta(sourceBounds.height, candidateBounds.height)
  return widthDelta <= 0.02 && heightDelta <= 0.02 ? 10 : 0
}

function copyHydratedAsset(inputDir, asset, candidate) {
  const format = candidate.format !== 'unknown'
    ? candidate.format
    : normalizeFormat(extname(candidate.sourcePath))
  if (format === 'unknown') throw new Error(`无法识别补水资源格式：${candidate.sourcePath}`)
  const targetDir = format === 'svg' ? 'assets/icon' : 'assets/img'
  const copiedPath = `${targetDir}/${safeFilePart(asset.assetId)}.${format}`
  const targetPath = join(inputDir, copiedPath)
  mkdirSync(dirname(targetPath), { recursive: true })
  copyFileSync(candidate.sourcePath, targetPath)
  return copiedPath
}

function applyHydratedAsset(asset, candidate, copiedPath, match) {
  const format = normalizeFormat(extname(copiedPath))
  asset.status = 'present'
  asset.copiedPath = copiedPath
  asset.suggestedFile = copiedPath
  asset.format = format
  asset.targetDir = dirname(copiedPath).replace(/\\/g, '/')
  delete asset.error
  asset.hydration = {
    provider: 'codex-mastergo-snapshot',
    candidateAssetId: candidate.assetId,
    sourcePath: candidate.copiedPath,
    score: match.score,
    reasons: match.reasons,
  }

  if (asset.kind === 'node-slice') {
    if (!Array.isArray(asset.renderedAssets)) asset.renderedAssets = []
    if (asset.renderedAssets.length === 0) {
      asset.renderedAssets.push({
        assetId: `slice_${safeFilePart(asset.assetId)}`,
        kind: 'rendered-image',
        nodeId: asset.sourceNodes?.[0]?.nodeId,
      })
    }
    for (const rendered of asset.renderedAssets) {
      rendered.status = 'present'
      rendered.format = format
      rendered.suggestedFile = copiedPath
      rendered.copiedPath = copiedPath
      delete rendered.error
      rendered.hydration = {
        provider: 'codex-mastergo-snapshot',
        candidateAssetId: candidate.assetId,
      }
    }
  }
}

function selectScreenshot(options, inputDir, snapshotIndex, rootValidation) {
  if (snapshotIndex && rootValidation?.compatible === false) {
    return { error: `Snapshot 根 Frame 与 Magic DSL 根 Frame 不匹配，已跳过截图裁切：${rootValidation.reason}` }
  }
  if (options.screenshot) return { path: resolve(options.screenshot), source: 'explicit' }
  const inputScreenshot = join(inputDir, 'frame-screenshot.png')
  if (existsSync(inputScreenshot) && !isPlaceholderPng(inputScreenshot)) {
    return { path: inputScreenshot, source: 'magic-input' }
  }
  if (snapshotIndex?.screenshotPath && existsSync(snapshotIndex.screenshotPath)) {
    if (rootValidation?.compatible === false) {
      return { error: `Snapshot 根 Frame 与 Magic DSL 根 Frame 不匹配，已跳过截图裁切：${rootValidation.reason}` }
    }
    return { path: snapshotIndex.screenshotPath, source: 'snapshot' }
  }
  return { error: '没有可用于复杂节点裁切的完整 Frame 截图。' }
}

function validateRoots(inputRoot, snapshotRoot) {
  if (!inputRoot || !snapshotRoot) return { compatible: null, reason: 'missing-root' }
  const inputId = String(inputRoot.id || '')
  const snapshotId = String(snapshotRoot.id || '')
  const inputBounds = readBounds(inputRoot)
  const snapshotBounds = readBounds(snapshotRoot)
  if (inputId && snapshotId) {
    if (inputId === snapshotId) return { compatible: true, reason: 'exact-root-node-id', inputId, snapshotId }
    return { compatible: false, reason: 'root-node-id-mismatch', inputId, snapshotId, inputBounds, snapshotBounds }
  }
  if (inputBounds && snapshotBounds) {
    const compatible = relativeDelta(inputBounds.width, snapshotBounds.width) <= 0.02
      && relativeDelta(inputBounds.height, snapshotBounds.height) <= 0.02
    return {
      compatible,
      reason: compatible ? 'matching-root-dimensions' : 'root-dimensions-mismatch',
      inputId,
      snapshotId,
      inputBounds,
      snapshotBounds,
    }
  }
  return { compatible: null, reason: 'insufficient-root-identity', inputId, snapshotId }
}

function buildManifestFiles(assets) {
  const files = []
  const seen = new Set()
  for (const asset of assets) {
    if (asset.kind === 'image') {
      pushManifestFile(files, seen, {
        path: asset.suggestedFile,
        assetId: asset.assetId,
        kind: 'original-image',
        status: asset.status,
        sourceNodeIds: (asset.sourceNodes || []).map((source) => source.nodeId),
      })
    }
    for (const rendered of asset.renderedAssets || []) {
      pushManifestFile(files, seen, {
        path: rendered.suggestedFile,
        assetId: rendered.assetId,
        kind: asset.kind === 'node-slice' ? 'node-slice' : 'rendered-image',
        status: rendered.status,
        sourceNodeIds: [rendered.nodeId].filter(Boolean),
      })
    }
  }
  return files
}

function pushManifestFile(files, seen, file) {
  const key = `${file.assetId || ''}|${file.kind || ''}|${file.path || ''}`
  if (!file.path || seen.has(key)) return
  seen.add(key)
  files.push(file)
}

function isTrulyPresent(asset, inputDir) {
  if (asset.status === 'present' && asset.copiedPath && existsSync(join(inputDir, asset.copiedPath))) return true
  return (asset.renderedAssets || []).some((item) => (
    item.status === 'present' && item.copiedPath && existsSync(join(inputDir, item.copiedPath))
  ))
}


function normalizeResourceReference(value) {
  return String(value || '').trim()
    .split('?')[0]
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .toLowerCase()
}

function resourceHashes(values) {
  return unique(values.flatMap(snapshotAssetIndexInternals.resourceKeys).filter((key) => {
    const stem = basename(key, extname(key))
    return /^[a-f0-9]{12,}$/i.test(stem) || /^[a-z0-9_-]{20,}$/i.test(stem)
  }))
}

function intersect(left, right) {
  const rightSet = new Set(right.filter(Boolean))
  return unique(left.filter((value) => value && rightSet.has(value)))
}

function sameBasenameOrStem(leftKeys, rightKeys) {
  const left = new Set(leftKeys.flatMap((value) => {
    const file = basename(value)
    const extension = extname(file)
    return [file, extension ? file.slice(0, -extension.length) : file]
  }))
  return rightKeys.some((value) => left.has(value))
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

function readBounds(node) {
  const bounds = node?.absoluteBoundingBox || node?.bounds
  if (!bounds) return null
  const output = {
    x: Number(bounds.x),
    y: Number(bounds.y),
    width: Number(bounds.width),
    height: Number(bounds.height),
  }
  return Object.values(output).every(Number.isFinite) ? output : null
}

function relativeDelta(a, b) {
  return Math.abs(Number(a) - Number(b)) / Math.max(Math.abs(Number(a)), Math.abs(Number(b)), 1)
}

function normalizeFormat(value) {
  const clean = String(value || '').toLowerCase().replace(/^\./, '')
  if (clean === 'jpeg') return 'jpg'
  return ['svg', 'png', 'jpg', 'webp', 'gif'].includes(clean) ? clean : 'unknown'
}

function isPlaceholderPng(path) {
  try {
    const bytes = readFileSync(path)
    if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') return false
    return bytes.readUInt32BE(16) <= 1 && bytes.readUInt32BE(20) <= 1
  } catch {
    return false
  }
}

function safeFilePart(value) {
  return String(value || 'asset').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'asset'
}

function summarizeMatch(match) {
  return {
    candidateAssetId: match.candidate.assetId,
    sourcePath: match.candidate.sourcePath,
    score: match.score,
    reasons: match.reasons,
  }
}

function recordError(report, stage, error) {
  report.errors.push({
    stage,
    message: error instanceof Error ? error.message : String(error),
  })
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function unique(values) {
  return [...new Set(values.filter(Boolean))]
}

export const assetHydratorInternals = {
  buildManifestFiles,
  isTrulyPresent,
  scoreCandidate,
  selectScreenshot,
  validateRoots,
}
