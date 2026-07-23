import {
  AssetManifest,
  AssetManifestEntry,
  AssetSourceNode,
  ExportFile,
  ExportOptions,
  ExportPhase,
  PluginMessage,
  RenderedAsset,
  UIMessage,
  UIToPluginMessage,
  sendMsgToUI,
} from '@messages/sender'

type PlainObject = Record<string, unknown>

type NodeSnapshot = PlainObject & {
  id: string
  name: string
  type: string
  children?: NodeSnapshot[]
}

type ImagePaintRef = {
  imageRef: string
  node: SceneNode
  source: AssetSourceNode
}

type ScanResult = {
  roots: SceneNode[]
  nodes: SceneNode[]
  nodeById: Map<string, SceneNode>
  imageRefs: ImagePaintRef[]
  forcedRenderedNodes: AssetSourceNode[]
}

type PhaseTiming = {
  phase: ExportPhase | 'total'
  durationMs: number
}

type ExportRunOptions = {
  includeFrameScreenshot?: boolean
}

const EXPORT_SCALE = 1
const ORIGINAL_IMAGE_TIMEOUT_MS = 8000
const RENDERED_SLICE_TIMEOUT_MS = 12000
const FRAME_SCREENSHOT_TIMEOUT_MS = 15000
const LARGE_ASSET_WARNING_COUNT = 20
const LARGE_RENDERED_SLICE_WARNING_COUNT = 30
const BRIDGE_BASE_URL = 'http://127.0.0.1:8787'
const RECENT_JOB_STORAGE_KEY = 'mastergo2html.recentJob'
const FORCE_RENDERED_NAME_RE = /logo/i
const FORCE_RENDERED_NODE_TYPES = new Set(['GROUP', 'FRAME', 'COMPONENT', 'INSTANCE'])
const DEFAULT_OPTIONS: ExportOptions = {
  includeOriginalImages: false,
  includeRenderedSlices: false,
  rawProfile: 'html',
}

mg.showUI(__html__, { width: 480, height: 620 })

mg.ui.onmessage = async (msg: UIToPluginMessage) => {
  if (msg.type === UIMessage.REFRESH_RECENT_JOB) {
    await sendRecentJobStatus()
    return
  }

  if (msg.type === UIMessage.GENERATE_HTML) {
    await submitHtmlGenerationJob({ ...DEFAULT_OPTIONS, ...msg.data })
    return
  }

  if (msg.type === UIMessage.COMPLETE_JOB_SUBMISSION) {
    const recentJob = {
      jobId: msg.data.job.jobId,
      panelUrl: msg.data.panelUrl,
      submittedAt: new Date().toISOString(),
      source: msg.data.job.source,
      record: msg.data.job,
    }
    await mg.clientStorage.setAsync(RECENT_JOB_STORAGE_KEY, recentJob)
    sendMsgToUI({ type: PluginMessage.JOB_SUBMITTED, data: { jobId: msg.data.job.jobId, panelUrl: msg.data.panelUrl } })
    mg.notify(`HTML 生成任务已提交：${msg.data.job.jobId}`, { type: 'success' })
    sendMsgToUI({ type: PluginMessage.JOB_STATUS, data: msg.data.job })
    return
  }

  if (msg.type === UIMessage.NOTIFY_JOB_STATUS) {
    const recent = await mg.clientStorage.getAsync(RECENT_JOB_STORAGE_KEY)
    await mg.clientStorage.setAsync(RECENT_JOB_STORAGE_KEY, {
      ...(recent ?? {}),
      jobId: msg.data.jobId,
      record: msg.data,
      updatedAt: new Date().toISOString(),
    })
    const isDone = msg.data.status === 'done'
    const isError = msg.data.status === 'error'
    if (isDone || isError) {
      mg.notify(isDone ? `HTML 生成完成：${msg.data.jobId}` : `HTML 生成失败：${msg.data.error ?? msg.data.jobId}`, {
        type: isDone ? 'success' : 'error',
      })
    }
    return
  }

  if (msg.type === UIMessage.EXPORT_SELECTION) {
    sendMsgToUI({ type: PluginMessage.EXPORT_STARTED })

    try {
      const result = await exportSelectedFrames({ ...DEFAULT_OPTIONS, ...msg.data })
      sendMsgToUI({ type: PluginMessage.EXPORT_COMPLETE, data: result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendMsgToUI({ type: PluginMessage.EXPORT_ERROR, data: message })
      mg.notify(message, { type: 'error' })
    }
  }
}

async function submitHtmlGenerationJob(options: ExportOptions) {
  sendMsgToUI({ type: PluginMessage.EXPORT_STARTED })

  try {
    const result = await exportSelectedFrames(options, { includeFrameScreenshot: true })
    const jobInput = createJobInput(result, options)
    sendMsgToUI({ type: PluginMessage.JOB_INPUT_READY, data: jobInput })
  } catch (error) {
    const message = errorMessage(error)
    sendMsgToUI({ type: PluginMessage.EXPORT_ERROR, data: message })
    mg.notify(message, { type: 'error' })
  }
}

function createJobInput(result: Awaited<ReturnType<typeof exportSelectedFrames>>, options: ExportOptions) {
  const rawFile = result.files.find((file) => file.path === 'raw.json')
  const manifestFile = result.files.find((file) => file.path === 'asset-manifest.json')
  const frameScreenshotFile = result.files.find((file) => file.path === 'frame-screenshot.png')
  if (!rawFile || !manifestFile) throw new Error('导出结果缺少 raw.json 或 asset-manifest.json。')
  if (!frameScreenshotFile) throw new Error('导出结果缺少必需的 frame-screenshot.png。')

  const raw = JSON.parse(rawFile.content)
  const assetManifest = JSON.parse(manifestFile.content)
  const page = raw.page ?? { id: 'unknown', name: 'unknown' }
  const selectionIds = Array.isArray(assetManifest.source?.selectionIds) ? assetManifest.source.selectionIds : []

  return {
    raw,
    assetManifest,
    exportOptions: options,
    source: {
      pageId: typeof page.id === 'string' ? page.id : 'unknown',
      pageName: typeof page.name === 'string' ? page.name : 'unknown',
      selectionIds,
      selectionCount: result.selectionCount,
    },
    attachments: result.files.filter((file) => file.path.startsWith('assets/') || file.path === 'frame-screenshot.png'),
  }
}

async function sendRecentJobStatus() {
  const recent = await mg.clientStorage.getAsync(RECENT_JOB_STORAGE_KEY)
  if (!recent?.jobId) {
    sendMsgToUI({ type: PluginMessage.JOB_STATUS, data: null })
    return
  }

  sendMsgToUI({ type: PluginMessage.JOB_STATUS, data: recent.record ?? null })
}

async function exportSelectedFrames(options: ExportOptions, runOptions: ExportRunOptions = {}) {
  const exportStartedAt = Date.now()
  const phaseTimings: PhaseTiming[] = []
  let phaseStartedAt = exportStartedAt
  let activePhase: ExportPhase | 'total' = 'scan-nodes'
  const markPhase = (nextPhase: ExportPhase) => {
    const now = Date.now()
    phaseTimings.push({ phase: activePhase, durationMs: now - phaseStartedAt })
    activePhase = nextPhase
    phaseStartedAt = now
  }

  const currentPage = mg.document.currentPage
  const selection = currentPage.selection
  if (selection.length === 0) {
    throw new Error('请先选中至少一个 Frame 或图层。')
  }
  if (runOptions.includeFrameScreenshot && selection.length !== 1) {
    throw new Error('一键生成 HTML 需要选中一个完整页面 Frame，用于导出唯一的 frame-screenshot.png。')
  }

  const createdAt = new Date().toISOString()
  const selectedNodes = [...selection]
  const exportName = makeSafeFileName(
    selectedNodes.length === 1 ? selectedNodes[0].name : `${currentPage.name}-selection`
  )

  const scan = await scanSelection(selectedNodes)
  markPhase('collect-assets')
  const assetIndex = createAssetIndex(scan.imageRefs, scan.forcedRenderedNodes)
  const warnings = createExportWarnings(assetIndex.assets.length, options)
  reportProgress(
    'collect-assets',
    assetIndex.assets.length,
    assetIndex.assets.length,
    '图片引用已去重',
    0,
    warnings[0]
  )
  await yieldToUI()

  markPhase('serialize-json')
  const snapshots = await serializeRoots(scan.roots, assetIndex.imageRefToAssetId, scan.nodes.length)

  markPhase('export-originals')
  const files: ExportFile[] = []
  const manifestAssets = await exportAssets(assetIndex.assets, options, files, scan.nodeById, () =>
    markPhase('export-rendered-slices')
  )
  if (runOptions.includeFrameScreenshot) {
    markPhase('export-frame-screenshot')
    reportProgress('export-frame-screenshot', 0, 1, `导出 Frame 截图：${selectedNodes[0].name}`)
    files.push(await exportFrameScreenshot(selectedNodes[0]))
    reportProgress('export-frame-screenshot', 1, 1, 'Frame 截图已写入 frame-screenshot.png')
  }
  markPhase('package-files')
  const manifest = buildManifest(createdAt, selectedNodes, manifestAssets)
  const rawJson = {
    version: 'mastergo2html.raw.v1',
    generatedAt: createdAt,
    page: {
      id: currentPage.id,
      name: currentPage.name,
    },
    selection: snapshots,
    assetManifestFile: 'asset-manifest.json',
  }
  const packageTotal = runOptions.includeFrameScreenshot ? 4 : 3

  reportProgress('package-files', 0, packageTotal, '写入 raw.json')
  files.unshift({
    path: 'raw.json',
    mimeType: 'application/json',
    encoding: 'utf8',
    content: JSON.stringify(rawJson, null, 2),
  })
  reportProgress('package-files', 1, packageTotal, '写入 asset-manifest.json')
  files.splice(1, 0, {
    path: 'asset-manifest.json',
    mimeType: 'application/json',
    encoding: 'utf8',
    content: JSON.stringify(manifest, null, 2),
  })
  const metrics = summarizeExport(manifestAssets, files)
  const durationMs = Date.now() - exportStartedAt
  phaseTimings.push({ phase: activePhase, durationMs: Date.now() - phaseStartedAt })
  phaseTimings.push({ phase: 'total', durationMs })

  const report = {
    version: 'mastergo2html.export-report.v1',
    generatedAt: createdAt,
    options,
    summary: {
      selectionCount: selectedNodes.length,
      nodeCount: scan.nodes.length,
      imageAssetCount: manifestAssets.length,
      originalAssetCount: metrics.originalAssetCount,
      originalExportedCount: metrics.originalExportedCount,
      originalSkippedCount: metrics.originalSkippedCount,
      originalFailedCount: metrics.originalFailedCount,
      renderedAssetCount: metrics.renderedAssetCount,
      renderedFailedCount: metrics.renderedFailedCount,
      missingAssetCount: metrics.missingAssetCount,
      fileCount: files.length + 1,
      zipSizeEstimateBytes: estimateExportBytes(files),
      durationMs,
    },
    phaseTimings,
    warnings,
    failures: metrics.failures,
    nextSteps: [
      '如果原图或切片被跳过，可重新选择包含图片的导出模式补导。',
      '当前切片只覆盖 imageRef 来源节点，可能遗漏矢量、组合、遮罩和无图片填充节点；后续建议使用 asset-export-plan.json 做计划型补导。',
      '如果单个资源超时，可优先使用 asset-manifest.json 中的 imageRef 和 sourceNodeIds 定位问题节点。',
    ],
  }

  files.splice(2, 0, {
    path: 'export-report.json',
    mimeType: 'application/json',
    encoding: 'utf8',
    content: JSON.stringify(report, null, 2),
  })

  const zipSizeEstimateBytes = estimateExportBytes(files)
  report.summary.fileCount = files.length
  report.summary.zipSizeEstimateBytes = zipSizeEstimateBytes
  files[2].content = JSON.stringify(report, null, 2)
  reportProgress('package-files', packageTotal, packageTotal, '文件清单已生成', metrics.failures.length)

  mg.notify(`导出完成：${snapshots.length} 个根节点，${manifestAssets.length} 个图片资源，${metrics.failures.length} 个失败。`, {
    type: 'success',
  })

  return {
    name: exportName,
    createdAt,
    selectionCount: selectedNodes.length,
    nodeCount: scan.nodes.length,
    imageAssetCount: manifestAssets.length,
    originalAssetCount: metrics.originalAssetCount,
    originalExportedCount: metrics.originalExportedCount,
    originalSkippedCount: metrics.originalSkippedCount,
    originalFailedCount: metrics.originalFailedCount,
    renderedAssetCount: metrics.renderedAssetCount,
    renderedFailedCount: metrics.renderedFailedCount,
    missingAssetCount: metrics.missingAssetCount,
    fileCount: files.length,
    zipSizeEstimateBytes,
    durationMs,
    phaseTimings,
    warnings,
    failures: metrics.failures,
    files,
  }
}

async function scanSelection(roots: SceneNode[]): Promise<ScanResult> {
  const nodes: SceneNode[] = []
  const nodeById = new Map<string, SceneNode>()
  const imageRefs: ImagePaintRef[] = []
  const forcedRenderedNodes: AssetSourceNode[] = []
  const stack = [...roots].reverse()

  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) continue

    nodes.push(node)
    nodeById.set(node.id, node)
    collectImageRefsFromNode(node, imageRefs)
    if (shouldForceRenderedSlice(node)) {
      forcedRenderedNodes.push({
        nodeId: node.id,
        nodeName: node.name,
        paintPath: 'node',
      })
    }

    if ('children' in node) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        stack.push(node.children[index])
      }
    }

    if (nodes.length % 50 === 0) {
      reportProgress('scan-nodes', nodes.length, nodes.length + stack.length, `扫描节点：${node.name}`)
      await yieldToUI()
    }
  }

  reportProgress('scan-nodes', nodes.length, nodes.length, '节点扫描完成')
  return { roots, nodes, nodeById, imageRefs, forcedRenderedNodes: removeDescendantForcedSlices(forcedRenderedNodes, nodeById) }
}

async function serializeRoots(
  roots: SceneNode[],
  imageRefToAssetId: Map<string, string>,
  totalNodes: number
) {
  let done = 0

  const serializeWithProgress = async (node: SceneNode): Promise<NodeSnapshot> => {
    const snapshot = serializeNode(node, imageRefToAssetId)
    done += 1

    if (done % 50 === 0 || done === totalNodes) {
      reportProgress('serialize-json', done, totalNodes, `精简节点：${node.name}`)
      await yieldToUI()
    }

    if ('children' in node) {
      snapshot.children = []
      for (const child of node.children) {
        snapshot.children.push(await serializeWithProgress(child))
      }
    }

    return snapshot
  }

  const snapshots: NodeSnapshot[] = []
  for (const root of roots) {
    snapshots.push(await serializeWithProgress(root))
  }
  return snapshots
}

function createAssetIndex(imageRefs: ImagePaintRef[], forcedRenderedNodes: AssetSourceNode[]) {
  const grouped = new Map<string, ImagePaintRef[]>()
  for (const ref of imageRefs) {
    const values = grouped.get(ref.imageRef) ?? []
    values.push(ref)
    grouped.set(ref.imageRef, values)
  }

  const imageRefToAssetId = new Map<string, string>()
  const assets: AssetManifestEntry[] = []
  let imageIndex = 1
  let nodeSliceIndex = 1

  for (const [imageRef, refs] of grouped) {
    const assetId = `img_${String(imageIndex).padStart(4, '0')}`
    imageIndex += 1
    imageRefToAssetId.set(imageRef, assetId)

    const first = refs[0].source
    const extension = guessImageExtension(imageRef)
    assets.push({
      assetId,
      kind: 'image',
      imageRef,
      status: 'reference-only',
      sourceNodes: mergeSourceNodes(refs.map((ref) => ref.source)),
      suggestedFile: `assets/original/${assetId}.${extension}`,
      originalFileName: getOriginalFileName(imageRef, extension),
      scaleMode: first.scaleMode,
      ratio: first.ratio,
      alpha: first.alpha,
      renderedAssets: [],
    })
  }

  for (const source of forcedRenderedNodes) {
    const assetId = `node_${String(nodeSliceIndex).padStart(4, '0')}`
    nodeSliceIndex += 1
    assets.push({
      assetId,
      kind: 'node-slice',
      status: 'reference-only',
      sourceNodes: [source],
      suggestedFile: `assets/rendered/${assetId}.png`,
      renderedAssets: [],
      error: '命中 logo 命名规则，将作为节点渲染切片导出。',
    })
  }

  return { assets, imageRefToAssetId }
}

async function exportAssets(
  entries: AssetManifestEntry[],
  options: ExportOptions,
  files: ExportFile[],
  nodeById: Map<string, SceneNode>,
  onRenderedSlicesStart: () => void
) {
  if (!options.includeOriginalImages) {
    entries.forEach((entry) => {
      entry.status = 'reference-only'
      entry.error = entry.kind === 'node-slice'
        ? '节点切片资产不包含原图 imageRef，将在渲染切片阶段导出。'
        : '已跳过原图文件导出，仅保留 imageRef 和资源映射。'
    })
    reportProgress('export-originals', entries.length, entries.length, '已跳过原图文件导出')
    await yieldToUI()

    if (options.includeRenderedSlices) {
      onRenderedSlicesStart()
      await exportRenderedSlices(entries, files, nodeById)
    } else {
      reportProgress('export-rendered-slices', 0, 0, '已跳过渲染切片')
    }

    return entries
  }

  let done = 0
  for (const entry of entries) {
    done += 1
    if (entry.kind === 'node-slice') {
      entry.status = 'reference-only'
      entry.error = '节点切片资产不包含原图 imageRef，仅在渲染切片阶段导出。'
      reportProgress('export-originals', done, entries.length, `跳过节点切片原图：${entry.sourceNodes[0]?.nodeName ?? entry.assetId}`, countOriginalFailures(entries))
      await yieldToUI()
      continue
    }

    reportProgress(
      'export-originals',
      done - 1,
      entries.length,
      `读取原图：${entry.originalFileName ?? entry.assetId}，最多等待 ${ORIGINAL_IMAGE_TIMEOUT_MS / 1000} 秒`,
      countOriginalFailures(entries)
    )

    try {
      const extension = guessImageExtension(entry.imageRef ?? '')
      const image = mg.getImageByHref(entry.imageRef ?? '')
      const bytes = await withTimeout(
        image.getBytesAsync(),
        ORIGINAL_IMAGE_TIMEOUT_MS,
        `读取原图超时：${entry.originalFileName}`
      )
      entry.status = 'present'
      entry.copiedPath = entry.suggestedFile
      files.push({
        path: entry.suggestedFile,
        mimeType: imageMimeType(extension),
        encoding: 'base64',
        content: bytesToBase64(bytes),
      })
    } catch (error) {
      entry.status = error instanceof TimeoutError ? 'export-error' : 'reference-only'
      entry.error = errorMessage(error)
    }

    reportProgress('export-originals', done, entries.length, `原图处理完成：${entry.originalFileName}`, countOriginalFailures(entries))
    await yieldToUI()
  }

  if (options.includeRenderedSlices) {
    onRenderedSlicesStart()
    await exportRenderedSlices(entries, files, nodeById)
  } else {
    reportProgress('export-rendered-slices', 0, 0, '已跳过渲染切片')
  }

  return entries
}

async function exportRenderedSlices(
  entries: AssetManifestEntry[],
  files: ExportFile[],
  nodeById: Map<string, SceneNode>
) {
  const jobs = entries.flatMap((entry) => uniqueSourceNodeIds(entry).map((nodeId) => ({ entry, nodeId })))
  let done = 0
  let sliceIndex = 1

  for (const job of jobs) {
    const source = job.entry.sourceNodes.find((item) => item.nodeId === job.nodeId)
    const node = nodeById.get(job.nodeId)
    if (!node) {
      const sliceId = `slice_${String(sliceIndex).padStart(4, '0')}`
      job.entry.renderedAssets.push({
        assetId: sliceId,
        kind: 'rendered-image',
        nodeId: job.nodeId,
        status: 'export-error',
        suggestedFile: `assets/rendered/${sliceId}.png`,
        exportScale: EXPORT_SCALE,
        error: '未找到对应节点，无法导出渲染切片。',
      })
      sliceIndex += 1
      done += 1
      reportProgress('export-rendered-slices', done, jobs.length, `切片失败：${job.nodeId}`, countRenderedFailures(entries))
      await yieldToUI()
      continue
    }

    const sliceId = `slice_${String(sliceIndex).padStart(4, '0')}`
    sliceIndex += 1
    reportProgress('export-rendered-slices', done, jobs.length, `导出切片：${source?.nodeName ?? node.name}`, countRenderedFailures(entries))
    job.entry.renderedAssets.push(await exportRenderedAsset(node, sliceId, files))
    done += 1
    reportProgress('export-rendered-slices', done, jobs.length, `切片完成：${source?.nodeName ?? node.name}`, countRenderedFailures(entries))
    await yieldToUI()
  }
}

async function exportRenderedAsset(node: SceneNode, assetId: string, files: ExportFile[]): Promise<RenderedAsset> {
  const suggestedFile = `assets/rendered/${assetId}.png`
  const base = {
    assetId,
    kind: 'rendered-image' as const,
    nodeId: node.id,
    suggestedFile,
    exportScale: EXPORT_SCALE,
    width: readNumber(node, 'width'),
    height: readNumber(node, 'height'),
  }

  try {
    const bytes = await withTimeout(
      node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: EXPORT_SCALE },
        useAbsoluteBounds: false,
        useRenderBounds: true,
      }),
      RENDERED_SLICE_TIMEOUT_MS,
      `导出渲染切片超时：${node.name}`
    )

    if (typeof bytes === 'string') {
      return {
        ...base,
        status: 'export-error',
        error: '节点 PNG 导出返回了字符串，未得到二进制图片。',
      }
    }

    files.push({
      path: suggestedFile,
      mimeType: 'image/png',
      encoding: 'base64',
      content: bytesToBase64(bytes),
    })

    return {
      ...base,
      status: 'present',
      copiedPath: suggestedFile,
    }
  } catch (error) {
    return {
      ...base,
      status: 'export-error',
      error: errorMessage(error),
    }
  }
}

async function exportFrameScreenshot(node: SceneNode): Promise<ExportFile> {
  try {
    const bytes = await withTimeout(
      node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: EXPORT_SCALE },
        useAbsoluteBounds: false,
        useRenderBounds: true,
      }),
      FRAME_SCREENSHOT_TIMEOUT_MS,
      `导出 Frame 整体截图超时：${node.name}`
    )

    if (typeof bytes === 'string') {
      throw new Error('Frame 截图导出返回了字符串，未得到二进制图片。')
    }

    return {
      path: 'frame-screenshot.png',
      mimeType: 'image/png',
      encoding: 'base64',
      content: bytesToBase64(bytes),
    }
  } catch (error) {
    throw new Error(`导出必需的 frame-screenshot.png 失败：${errorMessage(error)}`)
  }
}

function buildManifest(
  generatedAt: string,
  selection: SceneNode[],
  assets: AssetManifestEntry[]
): AssetManifest {
  const currentPage = mg.document.currentPage

  return {
    version: 'mastergo2html.asset-manifest.v1',
    generatedAt,
    source: {
      pageId: currentPage.id,
      pageName: currentPage.name,
      selectionIds: selection.map((node) => node.id),
    },
    assets,
    files: assets.flatMap((asset) => {
      const original = asset.kind === 'image' ? {
        path: asset.suggestedFile,
        assetId: asset.assetId,
        kind: 'original-image' as const,
        status: asset.status,
        sourceNodeIds: asset.sourceNodes.map((source) => source.nodeId),
      } : null
      const rendered = asset.renderedAssets.map((item) => ({
        path: item.suggestedFile,
        assetId: item.assetId,
        kind: asset.kind === 'node-slice' ? 'node-slice' as const : 'rendered-image' as const,
        status: item.status,
        sourceNodeIds: [item.nodeId],
      }))
      return original ? [original, ...rendered] : rendered
    }),
  }
}

function serializeNode(node: SceneNode, imageRefToAssetId: Map<string, string>): NodeSnapshot {
  const snapshot: NodeSnapshot = {
    id: node.id,
    name: node.name,
    type: node.type,
  }

  setIfPresent(snapshot, 'isVisible', readValue(node, 'isVisible'))
  setIfPresent(snapshot, 'opacity', readValue(node, 'opacity'))
  setIfPresent(snapshot, 'blendMode', readValue(node, 'blendMode'))

  for (const field of [
    'x',
    'y',
    'width',
    'height',
    'rotation',
    'absoluteBoundingBox',
    'absoluteRenderBounds',
    'relativeTransform',
    'clipsContent',
    'overflowDirection',
    'flexMode',
    'flexWrap',
    'itemSpacing',
    'mainAxisAlignItems',
    'crossAxisAlignItems',
    'mainAxisSizingMode',
    'crossAxisSizingMode',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'strokeWeight',
    'strokeAlign',
    'strokeCap',
    'strokeJoin',
    'strokeDashes',
    'cornerRadius',
    'cornerSmooth',
    'topLeftRadius',
    'topRightRadius',
    'bottomLeftRadius',
    'bottomRightRadius',
    'characters',
    'textAlignHorizontal',
    'textAlignVertical',
    'textAutoResize',
    'paragraphSpacing',
    'hyperlinks',
  ]) {
    setIfPresent(snapshot, field, readValue(node, field))
  }

  const fills = sanitizePaints(readRawValue(node, 'fills'), imageRefToAssetId)
  if (fills.length > 0) snapshot.fills = fills

  const strokes = sanitizePaints(readRawValue(node, 'strokes'), imageRefToAssetId)
  if (strokes.length > 0) snapshot.strokes = strokes

  const effects = sanitizeEffects(readRawValue(node, 'effects'))
  if (effects.length > 0) snapshot.effects = effects

  const textRuns = sanitizeTextRuns(readRawValue(node, 'textStyles'))
  if (textRuns.length > 0) snapshot.textRuns = textRuns

  return snapshot
}

function collectImageRefsFromNode(node: SceneNode, refs: ImagePaintRef[]) {
  const fills = readRawValue(node, 'fills')
  if (!Array.isArray(fills)) return

  fills.forEach((paint, index) => {
    if (!isImagePaint(paint) || paint.isVisible === false || !paint.imageRef) return
    refs.push({
      imageRef: paint.imageRef,
      node,
      source: {
        nodeId: node.id,
        nodeName: node.name,
        paintPath: `fills[${index}]`,
        scaleMode: paint.scaleMode,
        ratio: paint.ratio,
        alpha: paint.alpha,
      },
    })
  })
}

function shouldForceRenderedSlice(node: SceneNode) {
  const visible = readValue(node, 'isVisible')
  if (visible === false) return false
  if (!FORCE_RENDERED_NODE_TYPES.has(node.type)) return false
  if (!FORCE_RENDERED_NAME_RE.test(node.name || '')) return false

  const width = readNumber(node, 'width') ?? 0
  const height = readNumber(node, 'height') ?? 0
  if (width <= 0 || height <= 0) return false
  if (width > 400 || height > 120 || width * height > 48000) return false
  return true
}

function removeDescendantForcedSlices(sources: AssetSourceNode[], nodeById: Map<string, SceneNode>) {
  const sourceIds = new Set(sources.map((source) => source.nodeId))
  return sources.filter((source) => {
    let parent = readRawValue(nodeById.get(source.nodeId), 'parent') as SceneNode | undefined
    while (parent) {
      if (sourceIds.has(parent.id)) return false
      parent = readRawValue(parent, 'parent') as SceneNode | undefined
    }
    return true
  })
}

function sanitizePaints(value: unknown, imageRefToAssetId: Map<string, string>) {
  if (!Array.isArray(value)) return []

  return value
    .filter((paint) => paint && typeof paint === 'object' && (paint as { isVisible?: boolean }).isVisible !== false)
    .map((paint) => sanitizePaint(paint, imageRefToAssetId))
    .filter((paint): paint is PlainObject => Boolean(paint))
}

function sanitizePaint(paint: unknown, imageRefToAssetId: Map<string, string>): PlainObject | null {
  const input = paint as PlainObject
  const type = input.type
  if (type === 'IMAGE') {
    const imageRef = typeof input.imageRef === 'string' ? input.imageRef : ''
    return compactObject({
      type,
      imageRef,
      assetId: imageRefToAssetId.get(imageRef),
      scaleMode: input.scaleMode,
      ratio: input.ratio,
      alpha: input.alpha,
      filters: toJsonSafe(input.filters),
      blendMode: input.blendMode,
    })
  }

  if (type === 'SOLID') {
    return compactObject({
      type,
      color: toJsonSafe(input.color),
      alpha: input.alpha,
      blendMode: input.blendMode,
    })
  }

  if (typeof type === 'string' && type.includes('GRADIENT')) {
    return compactObject({
      type,
      gradientStops: toJsonSafe(input.gradientStops),
      gradientHandlePositions: toJsonSafe(input.gradientHandlePositions),
      alpha: input.alpha,
      blendMode: input.blendMode,
    })
  }

  return typeof type === 'string' ? compactObject({ type }) : null
}

function sanitizeEffects(value: unknown) {
  if (!Array.isArray(value)) return []

  return value
    .filter((effect) => effect && typeof effect === 'object' && (effect as { isVisible?: boolean }).isVisible !== false)
    .map((effect) => {
      const input = effect as PlainObject
      return compactObject({
        type: input.type,
        color: toJsonSafe(input.color),
        offset: toJsonSafe(input.offset),
        radius: input.radius,
        spread: input.spread,
        blendMode: input.blendMode,
        showShadowBehindNode: input.showShadowBehindNode,
        angle: input.angle,
      })
    })
}

function sanitizeTextRuns(value: unknown) {
  if (!Array.isArray(value)) return []

  return value.map((run) => {
    const input = run as PlainObject
    const textStyle = (input.textStyle ?? {}) as PlainObject
    return compactObject({
      start: input.start,
      end: input.end,
      fontName: toJsonSafe(textStyle.fontName),
      fontSize: textStyle.fontSize,
      fontWeight: textStyle.fontWeight,
      lineHeight: toJsonSafe(textStyle.lineHeight),
      lineHeightByPx: textStyle.lineHeightByPx,
      letterSpacing: toJsonSafe(textStyle.letterSpacing),
      textDecoration: textStyle.textDecoration,
      textCase: textStyle.textCase,
      fills: sanitizePaints(input.fills, new Map()),
    })
  })
}

function setIfPresent(target: PlainObject, key: string, value: unknown) {
  if (value !== undefined) target[key] = value
}

function readRawValue(target: unknown, key: string) {
  try {
    return (target as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function readValue(target: unknown, key: string) {
  return toJsonSafe(readRawValue(target, key))
}

function readNumber(target: unknown, key: string) {
  const value = readValue(target, key)
  return typeof value === 'number' ? value : undefined
}

function toJsonSafe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'function' || typeof value === 'symbol') return undefined
  if (depth > 8) return undefined
  if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, depth + 1)).filter((item) => item !== undefined)
  if (typeof value === 'object') {
    const output: PlainObject = {}
    for (const key in value as PlainObject) {
      if (key === 'parent' || key === 'children') continue
      const child = toJsonSafe((value as PlainObject)[key], depth + 1)
      if (child !== undefined) output[key] = child
    }
    return output
  }
  return undefined
}

function compactObject(input: PlainObject) {
  const output: PlainObject = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

function isImagePaint(value: unknown): value is ImagePaint {
  return Boolean(value && typeof value === 'object' && (value as ImagePaint).type === 'IMAGE')
}

function mergeSourceNodes(sources: AssetSourceNode[]) {
  const merged = new Map<string, AssetSourceNode>()
  for (const source of sources) {
    const key = `${source.nodeId}:${source.paintPath}`
    if (!merged.has(key)) merged.set(key, source)
  }
  return [...merged.values()]
}

function uniqueSourceNodeIds(entry: AssetManifestEntry) {
  return [...new Set(entry.sourceNodes.map((source) => source.nodeId))]
}

function reportProgress(phase: ExportPhase, done: number, total: number, label: string, failed = 0, warning?: string) {
  sendMsgToUI({
    type: PluginMessage.EXPORT_PROGRESS,
    data: { phase, done, total, label, failed, warning },
  })
}

function yieldToUI() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new TimeoutError(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timeoutId)
        resolve(value)
      },
      (error) => {
        clearTimeout(timeoutId)
        reject(error)
      }
    )
  })
}

function guessImageExtension(imageRef: string) {
  const fileName = imageRef.split('?')[0].split('/').pop() ?? ''
  const match = fileName.match(/\.([a-zA-Z0-9]+)$/)
  const ext = match?.[1]?.toLowerCase()
  if (ext && ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext
  return 'png'
}

function getOriginalFileName(imageRef: string, extension: string) {
  const fileName = imageRef.split('?')[0].split('/').pop()
  return fileName && fileName.includes('.') ? fileName : `${imageRefToHash(imageRef)}.${extension}`
}

function imageMimeType(extension: string) {
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'webp') return 'image/webp'
  if (extension === 'gif') return 'image/gif'
  if (extension === 'svg') return 'image/svg+xml'
  return 'image/png'
}

function imageRefToHash(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash >>> 0).toString(16)
}

function makeSafeFileName(value: string) {
  const normalized = value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-')
  return normalized || 'mastergo-html-export'
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function createExportWarnings(assetCount: number, options: ExportOptions) {
  const warnings: string[] = []
  if (options.includeOriginalImages && assetCount >= LARGE_ASSET_WARNING_COUNT) {
    warnings.push(`当前有 ${assetCount} 个原图资源，导出可能较慢；失败资源会写入 export-report.json。`)
  }
  if (options.includeRenderedSlices && assetCount >= LARGE_RENDERED_SLICE_WARNING_COUNT) {
    warnings.push(`当前可能生成较多渲染切片，建议只在需要复杂视觉还原时开启。`)
  }
  if (options.includeRenderedSlices) {
    warnings.push('当前切片基于 imageRef 来源节点生成，无法保证覆盖所有矢量、组合、遮罩或复杂视觉节点。')
  }
  if (!options.includeOriginalImages) {
    warnings.push('本次跳过原图文件，仅保留 imageRef、assetId 和资源映射，后续可按需补导。')
  }
  return warnings
}

function summarizeExport(assets: AssetManifestEntry[], files: ExportFile[]) {
  const renderedAssets = assets.flatMap((asset) => asset.renderedAssets)
  const failures = [
    ...assets
      .filter((asset) => asset.status === 'export-error')
      .map((asset) => ({
        assetId: asset.assetId,
        kind: 'original-image' as const,
        path: asset.suggestedFile,
        sourceNodeIds: asset.sourceNodes.map((source) => source.nodeId),
        error: asset.error ?? '原图导出失败',
      })),
    ...renderedAssets
      .filter((asset) => asset.status === 'export-error')
      .map((asset) => ({
        assetId: asset.assetId,
        kind: 'rendered-image' as const,
        path: asset.suggestedFile,
        sourceNodeIds: [asset.nodeId],
        error: asset.error ?? '渲染切片导出失败',
      })),
  ]

  return {
    originalAssetCount: assets.length,
    originalExportedCount: assets.filter((asset) => asset.status === 'present').length,
    originalSkippedCount: assets.filter((asset) => asset.status === 'reference-only').length,
    originalFailedCount: assets.filter((asset) => asset.status === 'export-error').length,
    renderedAssetCount: renderedAssets.filter((asset) => asset.status === 'present').length,
    renderedFailedCount: renderedAssets.filter((asset) => asset.status === 'export-error').length,
    missingAssetCount: assets.filter((asset) => asset.status !== 'present').length,
    files,
    failures,
  }
}

function countOriginalFailures(entries: AssetManifestEntry[]) {
  return entries.filter((entry) => entry.status === 'export-error').length
}

function countRenderedFailures(entries: AssetManifestEntry[]) {
  return entries.reduce(
    (count, entry) => count + entry.renderedAssets.filter((asset) => asset.status === 'export-error').length,
    0
  )
}

function estimateExportBytes(files: ExportFile[]) {
  const contentBytes = files.reduce((sum, file) => {
    return sum + (file.encoding === 'base64' ? base64ByteLength(file.content) : utf8ByteLength(file.content))
  }, 0)
  const zipOverhead = files.reduce((sum, file) => sum + utf8ByteLength(file.path) * 2 + 76, 22)
  return contentBytes + zipOverhead
}

function base64ByteLength(value: string) {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

function utf8ByteLength(value: string) {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4
      index += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}

function bytesToBase64(bytes: Uint8Array) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let output = ''
  let index = 0

  for (; index + 2 < bytes.length; index += 3) {
    const value = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2]
    output += chars[(value >> 18) & 63] + chars[(value >> 12) & 63] + chars[(value >> 6) & 63] + chars[value & 63]
  }

  if (index < bytes.length) {
    const value = bytes[index] << 16
    const next = index + 1 < bytes.length ? bytes[index + 1] << 8 : 0
    const combined = value | next
    output += chars[(combined >> 18) & 63] + chars[(combined >> 12) & 63]
    output += index + 1 < bytes.length ? chars[(combined >> 6) & 63] + '=' : '=='
  }

  return output
}
