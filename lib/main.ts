import {
  AssetManifest,
  AssetManifestEntry,
  AssetSourceNode,
  AssetUsageCandidate,
  AssetUsageHint,
  AssetRenderPolicy,
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

type Bounds = {
  x: number
  y: number
  width: number
  height: number
}

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
const FORCE_RENDERED_LOGO_NAME_RE = /logo/i
const MASK_NAME_RE = /蒙版|mask/i
const ICON_NAME_RE = /icon|图标/i
const IMAGE_NAME_RE = /image|img|图片|照片|photo|avatar|头像|banner/i
const BACKGROUND_NAME_RE = /bg|background|背景|banner/i
const DECORATIVE_NAME_RE = /decor|decoration|装饰|波点|点阵|网格|dots?|grid|pattern/i
const STRUCTURAL_CONTAINER_NAME_RE = /导航|nav|菜单|menu|表单|form|筛选|filter|分页|pagination|列表|list|卡片|card|岗位|job|按钮|button|搜索|search|输入|input|tab|tabs/i
const FORCE_RENDERED_NODE_TYPES = new Set(['GROUP', 'FRAME', 'COMPONENT', 'INSTANCE'])
const VECTOR_NODE_TYPES = new Set([
  'PEN',
  'VECTOR',
  'LINE',
  'BOOLEAN_OPERATION',
  'BOOLEANOPERATION',
  'RECTANGLE',
  'ELLIPSE',
  'POLYGON',
  'STAR',
])
const MAX_FORCED_COMPLEX_SLICE_AREA = 2400 * 2400
const MAX_FORCED_SMALL_COMPOSITE_AREA = 320 * 320
const MAX_FORCED_VECTOR_ICON_AREA = 320 * 320
const MAX_FORCED_VECTOR_LOGO_AREA = 900 * 240
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

  if (msg.type === UIMessage.RUN_CODEX_EXPORT_REQUEST) {
    await completeCodexExportRequest(msg.data)
    return
  }

  if (msg.type === UIMessage.EXPORT_STATIC_ASSETS) {
    await exportStaticAssetsOnly({ ...DEFAULT_OPTIONS, ...msg.data })
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

async function completeCodexExportRequest(request: { requestId: string, options: ExportOptions, pageName?: string, frameName?: string, nodeId?: string }) {
  sendMsgToUI({ type: PluginMessage.EXPORT_STARTED })
  const previousSelection = [...mg.document.currentPage.selection]

  try {
    const requestedNode = findRequestedNode(request)
    if (requestedNode) {
      mg.document.currentPage.selection = [requestedNode]
      mg.viewport.scrollAndZoomIntoView([requestedNode])
    }
    const result = await exportSelectedFrames({ ...DEFAULT_OPTIONS, ...request.options }, { includeFrameScreenshot: true })
    const input = createJobInput(result, { ...DEFAULT_OPTIONS, ...request.options })
    sendMsgToUI({ type: PluginMessage.CODEX_EXPORT_INPUT_READY, data: { requestId: request.requestId, input } })
    mg.notify(`Codex 导出请求已完成：${request.requestId}`, { type: 'success' })
  } catch (error) {
    const message = errorMessage(error)
    sendMsgToUI({ type: PluginMessage.EXPORT_ERROR, data: message })
    mg.notify(message, { type: 'error' })
  } finally {
    mg.document.currentPage.selection = previousSelection
  }
}

function findRequestedNode(request: { pageName?: string, frameName?: string, nodeId?: string }) {
  if (request.nodeId) {
    const node = mg.getNodeById<SceneNode>(request.nodeId)
    if (!node) throw new Error(`未找到 nodeId 对应的节点：${request.nodeId}`)
    return node
  }

  if (!request.frameName) return null
  const page = mg.document.currentPage
  if (request.pageName && page.name !== request.pageName) {
    throw new Error(`当前页面是 ${page.name}，不是请求的页面：${request.pageName}`)
  }

  const frameName = request.frameName.trim().toLowerCase()
  const exact = page.findOne((node) => String(node.name || '').trim().toLowerCase() === frameName)
  if (exact) return exact
  const fuzzy = page.findAll((node) => String(node.name || '').toLowerCase().includes(frameName))
  if (fuzzy.length === 1) return fuzzy[0]
  if (fuzzy.length > 1) {
    throw new Error(`找到多个名称包含 ${request.frameName} 的节点，请改用 nodeId：${fuzzy.map((node) => `${node.name}(${node.id})`).join('、')}`)
  }
  throw new Error(`当前页面未找到 Frame：${request.frameName}`)
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

async function exportStaticAssetsOnly(options: ExportOptions) {
  sendMsgToUI({ type: PluginMessage.EXPORT_STARTED })

  try {
    const result = await exportSelectedFrames(options, { includeFrameScreenshot: true })
    sendMsgToUI({ type: PluginMessage.EXPORT_COMPLETE, data: result })
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
  const selectedNodes = [...selection].filter(isNodeVisible)
  if (selectedNodes.length === 0) {
    throw new Error('当前选区没有可见图层，请选择至少一个可见 Frame 或图层。')
  }
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
  const forcedRenderedNodeIds = new Set<string>()
  const parentById = new Map<string, SceneNode | null>()
  const rootBounds = readBounds(roots[0])
  const stack = [...roots].reverse().map((node) => ({ node, parent: null as SceneNode | null }))

  while (stack.length > 0) {
    const item = stack.pop()
    if (!item) continue
    const { node, parent } = item
    parentById.set(node.id, parent)
    if (!isNodeVisible(node)) continue

    nodes.push(node)
    nodeById.set(node.id, node)
    collectImageRefsFromNode(node, imageRefs, rootBounds)

    const groupOrContainerMaskSlice = getGroupOrContainerMaskRenderedSlice(node)
    if (groupOrContainerMaskSlice) {
      addForcedRenderedNode(forcedRenderedNodes, forcedRenderedNodeIds, node, {
        usageHint: 'masked-composite',
        exportFormat: 'png',
        reason: `检测到组/容器 ${node.name || node.id} 的可见后代图层 ${groupOrContainerMaskSlice.maskNode.name || groupOrContainerMaskSlice.maskNode.id} 满足 isVisible 且 isMask=true，将导出该组/容器整体 PNG。`,
      }, rootBounds)
    }

    const maskParentSlice = getMaskParentRenderedSlice(node, parent)
    if (maskParentSlice) {
      addForcedRenderedNode(forcedRenderedNodes, forcedRenderedNodeIds, maskParentSlice.node, {
        usageHint: 'masked-composite',
        exportFormat: 'png',
        reason: `检测到子图层 ${node.name || node.id} 的 isMask=true，将导出其上一层级 ${maskParentSlice.node.name || maskParentSlice.node.id} 的整体 PNG。`,
      }, rootBounds)
    }

    const vectorContainerSlice = getVectorContainerRenderedSlice(node, parentById)
    if (vectorContainerSlice) {
      addForcedRenderedNode(forcedRenderedNodes, forcedRenderedNodeIds, vectorContainerSlice.node, {
        usageHint: getVectorContainerUsageHint(vectorContainerSlice.node, rootBounds),
        exportFormat: 'svg',
        reason: `检测到子图层 ${node.name || node.id} 为路径/矢量类型 ${node.type}，将导出其所在组或容器 ${vectorContainerSlice.node.name || vectorContainerSlice.node.id} 的整体 SVG。`,
      }, rootBounds)
    }

    const forceRenderedSlice = getForcedRenderedSlice(node, rootBounds)
    if (forceRenderedSlice) {
      addForcedRenderedNode(forcedRenderedNodes, forcedRenderedNodeIds, node, forceRenderedSlice, rootBounds)
    }

    if ('children' in node) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        if (isNodeVisible(node.children[index])) stack.push({ node: node.children[index], parent: node })
      }
    }

    if (nodes.length % 50 === 0) {
      reportProgress('scan-nodes', nodes.length, nodes.length + stack.length, `扫描节点：${node.name}`)
      await yieldToUI()
    }
  }

  reportProgress('scan-nodes', nodes.length, nodes.length, '节点扫描完成')
  return { roots, nodes, nodeById, imageRefs, forcedRenderedNodes: removeDescendantForcedSlices(forcedRenderedNodes, parentById) }
}

async function serializeRoots(
  roots: SceneNode[],
  imageRefToAssetId: Map<string, string>,
  totalNodes: number
) {
  let done = 0
  const rootBounds = readBounds(roots[0])

  const serializeWithProgress = async (node: SceneNode): Promise<NodeSnapshot> => {
    const snapshot = serializeNode(node, imageRefToAssetId, rootBounds)
    done += 1

    if (done % 50 === 0 || done === totalNodes) {
      reportProgress('serialize-json', done, totalNodes, `精简节点：${node.name}`)
      await yieldToUI()
    }

    if ('children' in node) {
      snapshot.children = []
      for (const child of node.children) {
        if (isNodeVisible(child)) snapshot.children.push(await serializeWithProgress(child))
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

function isNodeVisible(node: SceneNode) {
  return readValue(node, 'isVisible') !== false
}

function addForcedRenderedNode(
  sources: AssetSourceNode[],
  sourceIds: Set<string>,
  node: SceneNode,
  decision: { usageHint: AssetUsageHint, exportFormat: 'svg' | 'png', reason: string },
  rootBounds?: Bounds | null
) {
  if (!isNodeVisible(node)) return
  if (sourceIds.has(node.id)) {
    const existing = sources.find((source) => source.nodeId === node.id)
    if (
      existing
      && decision.exportFormat === 'png'
      && decision.usageHint === 'masked-composite'
      && existing.exportFormat !== 'png'
    ) {
      existing.usageHint = decision.usageHint
      existing.renderPolicy = inferRenderPolicyForForcedNode(node, decision.usageHint)
      existing.exportFormat = decision.exportFormat
      existing.renderReason = decision.reason
      existing.semanticHints = inferNodeSemanticHints(node, rootBounds)
    }
    return
  }

  sourceIds.add(node.id)
  sources.push({
    nodeId: node.id,
    nodeName: node.name,
    paintPath: 'node',
    usageHint: decision.usageHint,
    renderPolicy: inferRenderPolicyForForcedNode(node, decision.usageHint),
    exportFormat: decision.exportFormat,
    renderReason: decision.reason,
    semanticHints: inferNodeSemanticHints(node, rootBounds),
  })
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
    const format = normalizeAssetFormat(extension)
    const targetDir = assetTargetDir(format)
    const usageCandidates = mergeUsageCandidates(refs.flatMap((ref) => ref.source.semanticHints ?? []))
    assets.push({
      assetId,
      kind: 'image',
      imageRef,
      status: 'reference-only',
      sourceNodes: mergeSourceNodes(refs.map((ref) => ref.source)),
      suggestedFile: `${targetDir}/${assetId}.${extension}`,
      originalFileName: getOriginalFileName(imageRef, extension),
      format,
      targetDir,
      usageCandidates,
      scaleMode: first.scaleMode,
      ratio: first.ratio,
      alpha: first.alpha,
      renderedAssets: [],
    })
  }

  for (const source of forcedRenderedNodes) {
    const assetId = `node_${String(nodeSliceIndex).padStart(4, '0')}`
    nodeSliceIndex += 1
    const usageHint = source.usageHint ?? 'logo'
    const format = source.exportFormat ?? 'png'
    const targetDir = assetTargetDir(format)
    const usageCandidates = mergeUsageCandidates([
      { usage: usageHint, confidence: 'high', reason: source.renderReason ?? '节点被标记为整体渲染切片。' },
      ...(source.semanticHints ?? []),
    ])
    assets.push({
      assetId,
      kind: 'node-slice',
      usageHint,
      renderPolicy: source.renderPolicy,
      usageCandidates,
      mustUseRenderedSlice: true,
      format,
      targetDir,
      status: 'reference-only',
      sourceNodes: [source],
      suggestedFile: `${targetDir}/${assetId}.${format}`,
      renderedAssets: [],
      error: source.renderReason ?? (usageHint === 'background-decor-mask'
        ? '命中背景装饰蒙版命名规则，将作为装饰组合整体渲染切片导出。'
        : '命中 logo 命名规则，将作为节点渲染切片导出。'),
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

    const forcedNodeSliceEntries = entries.filter((entry) => entry.kind === 'node-slice')
    if (options.includeRenderedSlices) {
      onRenderedSlicesStart()
      await exportRenderedSlices(entries, files, nodeById)
    } else if (forcedNodeSliceEntries.length > 0) {
      onRenderedSlicesStart()
      await exportRenderedSlices(forcedNodeSliceEntries, files, nodeById)
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

  const forcedNodeSliceEntries = entries.filter((entry) => entry.kind === 'node-slice')
  if (options.includeRenderedSlices) {
    onRenderedSlicesStart()
    await exportRenderedSlices(entries, files, nodeById)
  } else if (forcedNodeSliceEntries.length > 0) {
    onRenderedSlicesStart()
    await exportRenderedSlices(forcedNodeSliceEntries, files, nodeById)
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
        format: job.entry.format === 'svg' ? 'svg' : 'png',
        nodeId: job.nodeId,
        status: 'export-error',
        suggestedFile: getNodeExportFile(sliceId, job.entry),
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
    job.entry.renderedAssets.push(await exportRenderedAsset(node, sliceId, job.entry, files))
    done += 1
    reportProgress('export-rendered-slices', done, jobs.length, `切片完成：${source?.nodeName ?? node.name}`, countRenderedFailures(entries))
    await yieldToUI()
  }
}

async function exportRenderedAsset(node: SceneNode, assetId: string, entry: AssetManifestEntry, files: ExportFile[]): Promise<RenderedAsset> {
  const format: 'svg' | 'png' = entry.format === 'svg' ? 'svg' : 'png'
  const suggestedFile = getNodeExportFile(assetId, entry)
  const base = {
    assetId,
    kind: 'rendered-image' as const,
    format,
    nodeId: node.id,
    suggestedFile,
    exportScale: EXPORT_SCALE,
    width: readNumber(node, 'width'),
    height: readNumber(node, 'height'),
  }

  try {
    const bytes = await withTimeout(
      format === 'svg'
        ? node.exportAsync({ format: 'SVG' })
        : node.exportAsync({
          format: 'PNG',
          constraint: { type: 'SCALE', value: EXPORT_SCALE },
          useAbsoluteBounds: false,
          useRenderBounds: true,
        }),
      RENDERED_SLICE_TIMEOUT_MS,
      `导出${format === 'svg' ? 'SVG' : '渲染切片'}超时：${node.name}`
    )

    if (typeof bytes === 'string') {
      if (format !== 'svg') {
        return {
          ...base,
          status: 'export-error',
          error: '节点 PNG 导出返回了字符串，未得到二进制图片。',
        }
      }
      files.push({
        path: suggestedFile,
        mimeType: 'image/svg+xml',
        encoding: 'utf8',
        content: bytes,
      })

      return {
        ...base,
        status: 'present',
        copiedPath: suggestedFile,
      }
    }

    files.push({
      path: suggestedFile,
      mimeType: format === 'svg' ? 'image/svg+xml' : 'image/png',
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

function getNodeExportFile(assetId: string, entry: AssetManifestEntry) {
  const format = entry.format === 'svg' ? 'svg' : 'png'
  return `${assetTargetDir(format)}/${assetId}.${format}`
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

function serializeNode(node: SceneNode, imageRefToAssetId: Map<string, string>, rootBounds?: Bounds | null): NodeSnapshot {
  const snapshot: NodeSnapshot = {
    id: node.id,
    name: node.name,
    type: node.type,
  }

  const semanticHints = inferNodeSemanticHints(node, rootBounds)
  if (semanticHints.length > 0) snapshot.semanticHints = semanticHints

  setIfPresent(snapshot, 'isVisible', readValue(node, 'isVisible'))
  setIfPresent(snapshot, 'opacity', readValue(node, 'opacity'))
  setIfPresent(snapshot, 'blendMode', readValue(node, 'blendMode'))
  setIfPresent(snapshot, 'isMask', readValue(node, 'isMask'))
  setIfPresent(snapshot, 'isMaskOutline', readValue(node, 'isMaskOutline'))
  setIfPresent(snapshot, 'isMaskVisible', readValue(node, 'isMaskVisible'))

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

function collectImageRefsFromNode(node: SceneNode, refs: ImagePaintRef[], rootBounds?: Bounds | null) {
  const fills = readRawValue(node, 'fills')
  if (!Array.isArray(fills)) return
  const semanticHints = inferNodeSemanticHints(node, rootBounds)

  fills.forEach((paint, index) => {
    if (!isImagePaint(paint) || paint.isVisible === false || !paint.imageRef) return
    refs.push({
      imageRef: paint.imageRef,
      node,
      source: {
        nodeId: node.id,
        nodeName: node.name,
        paintPath: `fills[${index}]`,
        semanticHints,
        scaleMode: paint.scaleMode,
        ratio: paint.ratio,
        alpha: paint.alpha,
      },
    })
  })
}

function inferNodeSemanticHints(node: SceneNode, rootBounds?: Bounds | null): AssetUsageCandidate[] {
  const hints: AssetUsageCandidate[] = []
  const name = node.name || ''
  const bounds = readBounds(node)
  const width = readNumber(node, 'width') ?? bounds?.width ?? 0
  const height = readNumber(node, 'height') ?? bounds?.height ?? 0
  const area = width * height
  const rootWidth = rootBounds?.width ?? 0
  const rootHeight = rootBounds?.height ?? 0
  const relativeY = bounds && rootBounds ? bounds.y - rootBounds.y : undefined
  const relativeX = bounds && rootBounds ? bounds.x - rootBounds.x : undefined

  if (FORCE_RENDERED_LOGO_NAME_RE.test(name)) {
    hints.push({ usage: 'logo', confidence: 'high', reason: '节点名称包含 logo。' })
  }
  if (ICON_NAME_RE.test(name)) {
    hints.push({ usage: 'icon', confidence: 'high', reason: '节点名称包含 icon 或图标。' })
  }
  if (BACKGROUND_NAME_RE.test(name)) {
    hints.push({ usage: 'background', confidence: 'medium', reason: '节点名称包含背景或 background 语义。' })
  }
  if (DECORATIVE_NAME_RE.test(name)) {
    hints.push({ usage: 'decorative', confidence: 'medium', reason: '节点名称包含装饰、波点、网格等语义。' })
  }
  if (IMAGE_NAME_RE.test(name)) {
    hints.push({ usage: 'content-image', confidence: 'low', reason: '节点名称包含图片、照片、avatar 或 banner 语义。' })
  }

  if (rootWidth > 0 && rootHeight > 0 && relativeY !== undefined && relativeX !== undefined) {
    const inHeader = relativeY >= -rootHeight * 0.03 && relativeY <= rootHeight * 0.15
    const inFooter = relativeY >= rootHeight * 0.72
    const smallBrandLike = width > 0 && height > 0 && width <= Math.min(420, rootWidth * 0.28) && height <= 140 && area <= 60000
    if (smallBrandLike && relativeX <= rootWidth * 0.35 && inHeader) {
      hints.push({ usage: 'logo', confidence: 'medium', reason: '节点位于页面顶部左侧且尺寸接近导航栏品牌标识。' })
    }
    if (smallBrandLike && inFooter) {
      hints.push({ usage: 'logo', confidence: 'low', reason: '节点位于页面页尾区域且尺寸接近品牌标识。' })
    }
    if (area >= rootWidth * rootHeight * 0.12) {
      hints.push({ usage: 'background', confidence: 'low', reason: '节点面积较大，可能是背景或主要内容图片。' })
    }
  }

  if (width > 0 && height > 0 && width <= 96 && height <= 96 && area <= 9216) {
    hints.push({ usage: 'icon', confidence: 'medium', reason: '节点尺寸较小，符合图标资源特征。' })
  }

  if (hasComplexVisualSignals(node)) {
    hints.push({ usage: MASK_NAME_RE.test(name) ? 'masked-composite' : 'complex-vector', confidence: 'medium', reason: '节点包含蒙版、裁切、混合模式、阴影或透明叠加等复杂视觉信号。' })
  }

  return mergeUsageCandidates(hints)
}

function getComplexRenderedSliceReason(node: SceneNode, width: number, height: number) {
  if (width * height > MAX_FORCED_COMPLEX_SLICE_AREA) return null
  if (hasMaskSignal(node)) return '检测到节点或子节点包含蒙版语义，将导出该节点整体切片，避免内部资源破坏蒙版视觉。'
  if (hasClipSignal(node) && hasComplexDescendantVisual(node)) return '检测到节点存在裁切且内部包含复杂视觉，将导出该节点整体切片以保留最终可见效果。'
  if (isSmallImageCompositeGroup(node, width, height)) return '检测到小尺寸复合图标组同时包含 image 与形状/矢量视觉层，将导出上一级组整体切片，避免只导出内部 image 导致蒙版或裁切效果丢失。'
  if (hasComplexDescendantVisual(node) && hasMultipleVisibleChildren(node)) return '检测到多子节点透明叠加、混合模式、阴影或复杂矢量组合，将导出该节点整体切片。'
  return null
}

function hasMaskSignal(node: SceneNode): boolean {
  if (readRawValue(node, 'isMask') === true) return true
  return getChildren(node).some(hasMaskSignal)
}

function hasClipSignal(node: SceneNode): boolean {
  return readRawValue(node, 'clipsContent') === true
    || Boolean(readRawValue(node, 'clipPath'))
    || Boolean(readRawValue(node, 'isClippingMask'))
}

function hasComplexVisualSignals(node: SceneNode): boolean {
  const opacity = readNumber(node, 'opacity')
  const blendMode = readRawValue(node, 'blendMode')
  const effects = readRawValue(node, 'effects')
  const fills = readRawValue(node, 'fills')
  return hasMaskSignal(node)
    || hasClipSignal(node)
    || (typeof opacity === 'number' && opacity > 0 && opacity < 1)
    || (typeof blendMode === 'string' && blendMode !== 'NORMAL' && blendMode !== 'PASS_THROUGH')
    || (Array.isArray(effects) && effects.some((effect) => effect && typeof effect === 'object' && (effect as { isVisible?: boolean }).isVisible !== false))
    || (Array.isArray(fills) && fills.filter((paint) => paint && typeof paint === 'object' && (paint as { isVisible?: boolean }).isVisible !== false).length > 1)
}

function hasComplexDescendantVisual(node: SceneNode): boolean {
  return hasComplexVisualSignals(node) || getChildren(node).some(hasComplexDescendantVisual)
}

function hasMultipleVisibleChildren(node: SceneNode) {
  return getChildren(node).filter((child) => readValue(child, 'isVisible') !== false).length >= 2
}

function isSmallImageCompositeGroup(node: SceneNode, width: number, height: number) {
  return width > 0
    && height > 0
    && width * height <= MAX_FORCED_SMALL_COMPOSITE_AREA
    && hasMultipleVisibleChildren(node)
    && hasImageDescendant(node)
    && hasNonImageVisualDescendant(node)
}

function hasImageDescendant(node: SceneNode): boolean {
  return hasImagePaint(node) || getChildren(node).some(hasImageDescendant)
}

function hasNonImageVisualDescendant(node: SceneNode): boolean {
  return getChildren(node).some((child) => {
    if (readValue(child, 'isVisible') === false) return false
    return (!hasImagePaint(child) && (hasVisibleVisualPaintOrEffect(child) || isGeometryMaskCandidate(child))) || hasNonImageVisualDescendant(child)
  })
}

function isGeometryMaskCandidate(node: SceneNode) {
  return VECTOR_NODE_TYPES.has(node.type)
}

function hasImagePaint(node: SceneNode) {
  const fills = readRawValue(node, 'fills')
  return Array.isArray(fills) && fills.some((paint) => isImagePaint(paint) && paint.isVisible !== false && Boolean(paint.imageRef))
}

function hasVisibleVisualPaintOrEffect(node: SceneNode) {
  const fills = readRawValue(node, 'fills')
  const strokes = readRawValue(node, 'strokes')
  const effects = readRawValue(node, 'effects')
  return (Array.isArray(fills) && fills.some((paint) => paint && typeof paint === 'object' && (paint as { isVisible?: boolean }).isVisible !== false))
    || (Array.isArray(strokes) && strokes.some((paint) => paint && typeof paint === 'object' && (paint as { isVisible?: boolean }).isVisible !== false))
    || (Array.isArray(effects) && effects.some((effect) => effect && typeof effect === 'object' && (effect as { isVisible?: boolean }).isVisible !== false))
}

function getChildren(node: SceneNode): SceneNode[] {
  return 'children' in node ? [...node.children] : []
}

function getGroupOrContainerMaskRenderedSlice(node: SceneNode): { maskNode: SceneNode } | null {
  if (!FORCE_RENDERED_NODE_TYPES.has(node.type) || !isNodeVisible(node)) return null
  const maskNode = findActiveVisibleMaskDescendant(node)
  return maskNode ? { maskNode } : null
}

function findActiveVisibleMaskDescendant(node: SceneNode): SceneNode | null {
  for (const child of getChildren(node)) {
    if (!isNodeVisible(child)) continue
    if (isActiveVisibleMaskNode(child)) return child
    const descendant = findActiveVisibleMaskDescendant(child)
    if (descendant) return descendant
  }
  return null
}

function isActiveVisibleMaskNode(node: SceneNode) {
  return readRawValue(node, 'isVisible') === true
    && readRawValue(node, 'isMask') === true
}

function getMaskParentRenderedSlice(node: SceneNode, parent?: SceneNode | null): { node: SceneNode } | null {
  if (!isActiveVisibleMaskNode(node)) return null
  if (!parent || !isNodeVisible(parent)) return null
  return { node: parent }
}

function getVectorContainerRenderedSlice(node: SceneNode, parentById: Map<string, SceneNode | null>): { node: SceneNode } | null {
  if (!isVectorNode(node)) return null
  const container = getNearestTextFreeVectorExportContainer(node, parentById)
  if (container) return { node: container }
  const width = readNumber(node, 'width') ?? 0
  const height = readNumber(node, 'height') ?? 0
  if (width <= 0 || height <= 0 || width * height > MAX_FORCED_VECTOR_ICON_AREA) return null
  return { node }
}

function getNearestTextFreeVectorExportContainer(node: SceneNode, parentById: Map<string, SceneNode | null>): SceneNode | null {
  let parent = parentById.get(node.id) ?? null
  while (parent) {
    if (
      FORCE_RENDERED_NODE_TYPES.has(parent.type)
      && isNodeVisible(parent)
      && isTextFreeVectorExportContainer(parent)
    ) return parent
    parent = parentById.get(parent.id) ?? null
  }
  return null
}

function isTextFreeVectorExportContainer(node: SceneNode): boolean {
  const width = readNumber(node, 'width') ?? 0
  const height = readNumber(node, 'height') ?? 0
  if (width <= 0 || height <= 0 || width * height > MAX_FORCED_VECTOR_LOGO_AREA) return false
  if (hasTextDescendant(node)) return false
  return isVectorOnlyVisualGroup(node)
}

function getForcedRenderedSlice(node: SceneNode, rootBounds?: Bounds | null): { usageHint: AssetUsageHint, exportFormat: 'svg' | 'png', reason: string } | null {
  const visible = readValue(node, 'isVisible')
  if (visible === false) return null
  if (!FORCE_RENDERED_NODE_TYPES.has(node.type)) return null

  const width = readNumber(node, 'width') ?? 0
  const height = readNumber(node, 'height') ?? 0
  if (width <= 0 || height <= 0) return null

  const svgUsage = getVectorSvgUsage(node, width, height, rootBounds)
  if (svgUsage) {
    return {
      usageHint: svgUsage,
      exportFormat: 'svg',
      reason: svgUsage === 'logo'
        ? '检测到仅由路径/形状组成的品牌标识容器，将导出为 SVG 以保持清晰度。'
        : '检测到仅由路径/形状组成的小尺寸图标容器，将导出为 SVG 以保持清晰度。',
    }
  }

  const complexReason = getComplexRenderedSliceReason(node, width, height)
  if (complexReason) {
    return {
      usageHint: hasMaskSignal(node) ? 'masked-composite' : 'complex-vector',
      exportFormat: 'png',
      reason: complexReason,
    }
  }

  return null
}

function inferRenderPolicyForForcedNode(node: SceneNode, usageHint: AssetUsageHint): AssetRenderPolicy {
  if (usageHint === 'logo') return 'required-final'
  if (isStructuralCompositeContainer(node)) return 'review-only'
  if (hasTextDescendant(node)) return hasDisplayCriticalTextDescendant(node) ? 'fallback-only' : 'review-only'
  if (usageHint === 'icon' || usageHint === 'background-decor-mask') return 'required-final'
  if (isCssReproducibleSurface(node)) return 'css-preferred'
  if (usageHint === 'masked-composite') return 'required-final'
  if (usageHint === 'complex-vector' && isAtomicDecorativeComposite(node)) return 'required-final'
  return 'review-only'
}

function isStructuralCompositeContainer(node: SceneNode): boolean {
  const name = node.name || ''
  if (STRUCTURAL_CONTAINER_NAME_RE.test(name)) return true
  const children = getChildren(node).filter(isNodeVisible)
  if (children.length < 2) return false
  const textCount = countDescendants(node, (child) => child.type === 'TEXT')
  if (textCount >= 2 && (hasVectorDescendant(node) || hasVisibleVisualPaintOrEffectDeep(node))) return true
  return false
}

function isCssReproducibleSurface(node: SceneNode): boolean {
  if (hasTextDescendant(node) || hasImageDescendant(node) || hasVectorDescendant(node)) return false
  const children = getChildren(node).filter(isNodeVisible)
  return children.length <= 1 && hasVisibleVisualPaintOrEffectDeep(node)
}

function isAtomicDecorativeComposite(node: SceneNode): boolean {
  const width = readNumber(node, 'width') ?? 0
  const height = readNumber(node, 'height') ?? 0
  const name = node.name || ''
  if (ICON_NAME_RE.test(name) || FORCE_RENDERED_LOGO_NAME_RE.test(name) || DECORATIVE_NAME_RE.test(name)) return true
  return width > 0 && height > 0 && width * height <= MAX_FORCED_SMALL_COMPOSITE_AREA
}

function hasDisplayCriticalTextDescendant(node: SceneNode): boolean {
  return someDescendant(node, (child) => {
    if (child.type !== 'TEXT') return false
    const fontSize = readNumber(child, 'fontSize')
    const height = readNumber(child, 'height') ?? readBounds(child)?.height ?? 0
    return (typeof fontSize === 'number' && fontSize >= 32) || height >= 48
  })
}

function getVectorSvgUsage(node: SceneNode, width: number, height: number, rootBounds?: Bounds | null): 'icon' | 'logo' | null {
  if (!isVectorOnlyVisualGroup(node)) return null
  const area = width * height
  const bounds = readBounds(node)
  const rootHeight = rootBounds?.height ?? 0
  const relativeY = bounds && rootBounds ? bounds.y - rootBounds.y : undefined
  const name = node.name || ''
  const logoSemanticHint = inferNodeSemanticHints(node, rootBounds)
    .some((hint) => hint.usage === 'logo' && hint.confidence !== 'low')
  const logoNameOrFooter = FORCE_RENDERED_LOGO_NAME_RE.test(name)
    || /品牌|标志|页尾|footer/i.test(name)
    || (rootHeight > 0 && relativeY !== undefined && relativeY >= rootHeight * 0.65)
  if ((logoSemanticHint || logoNameOrFooter) && width > 0 && height > 0 && area <= MAX_FORCED_VECTOR_LOGO_AREA) return 'logo'
  if (width > 0 && height > 0 && area <= MAX_FORCED_VECTOR_ICON_AREA && width <= 320 && height <= 320) return 'icon'
  return null
}

function getVectorContainerUsageHint(node: SceneNode, rootBounds?: Bounds | null): AssetUsageHint {
  const width = readNumber(node, 'width') ?? 0
  const height = readNumber(node, 'height') ?? 0
  return getVectorSvgUsage(node, width, height, rootBounds) ?? 'icon'
}

function isVectorOnlyVisualGroup(node: SceneNode) {
  const children = getChildren(node).filter(isNodeVisible)
  if (children.length === 0) return false
  if (hasImageDescendant(node) || hasTextDescendant(node)) return false
  return children.every(isVectorVisualTree) && children.some(hasVisibleVisualPaintOrEffectDeep)
}

function isVectorVisualTree(node: SceneNode): boolean {
  if (!isVectorNode(node) && !FORCE_RENDERED_NODE_TYPES.has(node.type)) return false
  return getChildren(node).filter(isNodeVisible).every(isVectorVisualTree)
}

function isVectorNode(node: SceneNode) {
  return VECTOR_NODE_TYPES.has(node.type)
}

function hasTextDescendant(node: SceneNode): boolean {
  return node.type === 'TEXT' || getChildren(node).some(hasTextDescendant)
}

function hasVectorDescendant(node: SceneNode): boolean {
  return isVectorNode(node) || getChildren(node).some(hasVectorDescendant)
}

function someDescendant(node: SceneNode, predicate: (node: SceneNode) => boolean): boolean {
  if (predicate(node)) return true
  return getChildren(node).some((child) => someDescendant(child, predicate))
}

function countDescendants(node: SceneNode, predicate: (node: SceneNode) => boolean): number {
  return (predicate(node) ? 1 : 0) + getChildren(node).reduce((sum, child) => sum + countDescendants(child, predicate), 0)
}

function hasVisibleVisualPaintOrEffectDeep(node: SceneNode): boolean {
  return hasVisibleVisualPaintOrEffect(node) || getChildren(node).some(hasVisibleVisualPaintOrEffectDeep)
}

function removeDescendantForcedSlices(sources: AssetSourceNode[], parentById: Map<string, SceneNode | null>) {
  const maskedSourceIds = new Set(sources
    .filter((source) => source.usageHint === 'masked-composite' && source.renderPolicy === 'required-final')
    .map((source) => source.nodeId))
  const retainedMaskedSourceIds = new Set(
    sources
      .filter((source) => source.usageHint === 'masked-composite' && source.renderPolicy === 'required-final')
      .filter((source) => !hasMaskedCompositeDescendant(source.nodeId, maskedSourceIds, parentById))
      .map((source) => source.nodeId)
  )

  const retainedSourceIds = new Set<string>(retainedMaskedSourceIds)
  for (const source of sources) {
    if (source.usageHint !== 'masked-composite' && source.renderPolicy === 'required-final') {
      retainedSourceIds.add(source.nodeId)
    }
  }

  return sources.filter((source) => {
    if (source.usageHint === 'masked-composite') {
      return retainedMaskedSourceIds.has(source.nodeId)
    }
    let parent = parentById.get(source.nodeId) ?? null
    while (parent) {
      if (retainedSourceIds.has(parent.id)) return false
      parent = parentById.get(parent.id) ?? null
    }
    return true
  })
}

function hasMaskedCompositeDescendant(
  sourceId: string,
  maskedSourceIds: Set<string>,
  parentById: Map<string, SceneNode | null>
) {
  for (const maskedSourceId of maskedSourceIds) {
    if (maskedSourceId === sourceId) continue
    let parent = parentById.get(maskedSourceId) ?? null
    while (parent) {
      if (parent.id === sourceId) return true
      parent = parentById.get(parent.id) ?? null
    }
  }
  return false
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

function readBounds(target: unknown): Bounds | null {
  const absolute = readValue(target, 'absoluteBoundingBox') as PlainObject | undefined
  const x = typeof absolute?.x === 'number' ? absolute.x : readNumber(target, 'x')
  const y = typeof absolute?.y === 'number' ? absolute.y : readNumber(target, 'y')
  const width = typeof absolute?.width === 'number' ? absolute.width : readNumber(target, 'width')
  const height = typeof absolute?.height === 'number' ? absolute.height : readNumber(target, 'height')
  if ([x, y, width, height].every((value) => typeof value === 'number')) {
    return { x: x as number, y: y as number, width: width as number, height: height as number }
  }
  return null
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

function mergeUsageCandidates(candidates: AssetUsageCandidate[]) {
  const rank = { high: 3, medium: 2, low: 1 }
  const merged = new Map<AssetUsageHint, AssetUsageCandidate>()
  for (const candidate of candidates) {
    const current = merged.get(candidate.usage)
    if (!current || rank[candidate.confidence] > rank[current.confidence]) {
      merged.set(candidate.usage, candidate)
    }
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

function normalizeAssetFormat(extension: string): AssetManifestEntry['format'] {
  if (extension === 'svg') return 'svg'
  if (extension === 'png') return 'png'
  if (extension === 'jpg' || extension === 'jpeg') return 'jpg'
  if (extension === 'webp') return 'webp'
  if (extension === 'gif') return 'gif'
  return 'unknown'
}

function assetTargetDir(format: AssetManifestEntry['format']): NonNullable<AssetManifestEntry['targetDir']> {
  return format === 'svg' ? 'assets/icon' : 'assets/img'
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
