export enum UIMessage {
  EXPORT_SELECTION = 'EXPORT_SELECTION',
  GENERATE_HTML = 'GENERATE_HTML',
  COMPLETE_JOB_SUBMISSION = 'COMPLETE_JOB_SUBMISSION',
  NOTIFY_JOB_STATUS = 'NOTIFY_JOB_STATUS',
  REFRESH_RECENT_JOB = 'REFRESH_RECENT_JOB',
}

export enum PluginMessage {
  EXPORT_STARTED = 'EXPORT_STARTED',
  EXPORT_PROGRESS = 'EXPORT_PROGRESS',
  EXPORT_COMPLETE = 'EXPORT_COMPLETE',
  EXPORT_ERROR = 'EXPORT_ERROR',
  JOB_SUBMITTED = 'JOB_SUBMITTED',
  JOB_INPUT_READY = 'JOB_INPUT_READY',
  JOB_STATUS = 'JOB_STATUS',
}

export type AssetStatus = 'present' | 'reference-only' | 'export-error'
export type ExportPhase =
  | 'scan-nodes'
  | 'serialize-json'
  | 'collect-assets'
  | 'export-originals'
  | 'export-rendered-slices'
  | 'export-frame-screenshot'
  | 'package-files'

export type ExportOptions = {
  includeOriginalImages: boolean
  includeRenderedSlices: boolean
  rawProfile: 'html'
}

export type ExportProgress = {
  phase: ExportPhase
  done: number
  total: number
  label: string
  failed: number
  warning?: string
}

export type ExportFile = {
  path: string
  mimeType: string
  encoding: 'utf8' | 'base64'
  content: string
}

export type AssetSourceNode = {
  nodeId: string
  nodeName: string
  paintPath: string
  scaleMode?: string
  ratio?: number
  alpha?: number
}

export type RenderedAsset = {
  assetId: string
  kind: 'rendered-image'
  nodeId: string
  status: AssetStatus
  suggestedFile: string
  copiedPath?: string
  exportScale: number
  width?: number
  height?: number
  error?: string
}

export type AssetManifestEntry = {
  assetId: string
  kind: 'image' | 'node-slice'
  imageRef?: string
  status: AssetStatus
  sourceNodes: AssetSourceNode[]
  suggestedFile: string
  copiedPath?: string
  originalFileName?: string
  scaleMode?: string
  ratio?: number
  alpha?: number
  renderedAssets: RenderedAsset[]
  error?: string
}

export type AssetManifest = {
  version: 'mastergo2html.asset-manifest.v1'
  generatedAt: string
  source: {
    pageId: string
    pageName: string
    selectionIds: string[]
  }
  assets: AssetManifestEntry[]
  files: Array<{
    path: string
    assetId: string
    kind: 'original-image' | 'rendered-image' | 'node-slice'
    status: AssetStatus
    sourceNodeIds: string[]
  }>
}

export type ExportResult = {
  name: string
  createdAt: string
  selectionCount: number
  nodeCount: number
  imageAssetCount: number
  originalAssetCount: number
  originalExportedCount: number
  originalSkippedCount: number
  originalFailedCount: number
  renderedAssetCount: number
  renderedFailedCount: number
  missingAssetCount: number
  fileCount: number
  zipSizeEstimateBytes: number
  durationMs: number
  phaseTimings: Array<{
    phase: ExportPhase | 'total'
    durationMs: number
  }>
  warnings: string[]
  failures: Array<{
    assetId: string
    kind: 'original-image' | 'rendered-image' | 'node-slice'
    path: string
    sourceNodeIds: string[]
    error: string
  }>
  files: ExportFile[]
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

export type JobPhase =
  | 'collect-input'
  | 'normalize-raw'
  | 'layout-analysis'
  | 'component-structure-analysis'
  | 'static-asset-analysis'
  | 'interaction-analysis'
  | 'assembly-planning'
  | 'html-generation'
  | 'visual-qa'
  | 'package-files'

export type JobRecord = {
  jobId: string
  status: JobStatus
  progress: {
    phase: JobPhase
    percent: number
    message: string
  }
  source: {
    pageId: string
    pageName: string
    selectionIds: string[]
    selectionCount: number
  }
  createdAt: string
  updatedAt: string
  outputPath?: string
  inputPath?: string
  downloadUrl?: string
  outputDir?: string
  error?: string
  phaseDetails?: JobPhaseDetail[]
  resultSummary?: {
    htmlPath: string
    zipPath: string
    zipSizeBytes?: number
    packagedFileCount?: number
    note: string
  }
}

export type JobPhaseDetail = {
  phase: JobPhase
  status: 'pending' | 'running' | 'done' | 'error'
  startedAt?: string
  endedAt?: string
  durationMs: number
  message: string
  tokenUsage: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    estimated?: boolean
  }
  artifacts?: string[]
  streamMetrics?: {
    mode: 'stream' | 'non-stream-fallback'
    state: 'connecting' | 'streaming' | 'validating'
    attempt: number
    eventCount: number
    receivedChars: number
    firstEventAt?: string
    lastEventAt?: string
  }
}

export type JobSubmitted = {
  jobId: string
  panelUrl: string
}

export type JobInput = {
  raw: unknown
  assetManifest: unknown
  exportOptions: ExportOptions
  source: JobRecord['source']
  attachments: ExportFile[]
}

export type PluginToUIMessage =
  | { type: PluginMessage.EXPORT_STARTED }
  | { type: PluginMessage.EXPORT_PROGRESS; data: ExportProgress }
  | { type: PluginMessage.EXPORT_COMPLETE; data: ExportResult }
  | { type: PluginMessage.EXPORT_ERROR; data: string }
  | { type: PluginMessage.JOB_SUBMITTED; data: JobSubmitted }
  | { type: PluginMessage.JOB_INPUT_READY; data: JobInput }
  | { type: PluginMessage.JOB_STATUS; data: JobRecord | null }

export type UIToPluginMessage =
  | {
      type: UIMessage.EXPORT_SELECTION
      data: ExportOptions
    }
  | {
      type: UIMessage.GENERATE_HTML
      data: ExportOptions
    }
  | {
      type: UIMessage.COMPLETE_JOB_SUBMISSION
      data: {
        panelUrl: string
        job: JobRecord
      }
    }
  | {
      type: UIMessage.NOTIFY_JOB_STATUS
      data: JobRecord
    }
  | {
      type: UIMessage.REFRESH_RECENT_JOB
    }

export const sendMsgToUI = (data: PluginToUIMessage) => {
  mg.ui.postMessage(data, '*')
}

export const sendMsgToPlugin = (data: UIToPluginMessage) => {
  parent.postMessage(data, '*')
}
