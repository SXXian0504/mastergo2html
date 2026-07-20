export enum UIMessage {
  EXPORT_SELECTION = 'EXPORT_SELECTION',
}

export enum PluginMessage {
  EXPORT_STARTED = 'EXPORT_STARTED',
  EXPORT_PROGRESS = 'EXPORT_PROGRESS',
  EXPORT_COMPLETE = 'EXPORT_COMPLETE',
  EXPORT_ERROR = 'EXPORT_ERROR',
}

export type AssetStatus = 'present' | 'reference-only' | 'export-error'
export type ExportPhase =
  | 'scan-nodes'
  | 'serialize-json'
  | 'collect-assets'
  | 'export-originals'
  | 'export-rendered-slices'
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
  kind: 'image'
  imageRef: string
  status: AssetStatus
  sourceNodes: AssetSourceNode[]
  suggestedFile: string
  copiedPath?: string
  originalFileName: string
  scaleMode?: string
  ratio?: number
  alpha?: number
  renderedAssets: RenderedAsset[]
  error?: string
}

export type AssetManifest = {
  version: 'mastergo2json.asset-manifest.v1'
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
    kind: 'original-image' | 'rendered-image'
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
    kind: 'original-image' | 'rendered-image'
    path: string
    sourceNodeIds: string[]
    error: string
  }>
  files: ExportFile[]
}

export type PluginToUIMessage =
  | { type: PluginMessage.EXPORT_STARTED }
  | { type: PluginMessage.EXPORT_PROGRESS; data: ExportProgress }
  | { type: PluginMessage.EXPORT_COMPLETE; data: ExportResult }
  | { type: PluginMessage.EXPORT_ERROR; data: string }

export type UIToPluginMessage = {
  type: UIMessage.EXPORT_SELECTION
  data: ExportOptions
}

export const sendMsgToUI = (data: PluginToUIMessage) => {
  mg.ui.postMessage(data, '*')
}

export const sendMsgToPlugin = (data: UIToPluginMessage) => {
  parent.postMessage(data, '*')
}
