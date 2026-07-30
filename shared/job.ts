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

export type JobSourceSummary = {
  pageId: string
  pageName: string
  selectionIds: string[]
  selectionCount: number
}

export type JobInput = {
  raw: unknown
  assetManifest: unknown
  exportOptions: {
    includeOriginalImages: boolean
    includeRenderedSlices: boolean
    rawProfile: 'html'
  }
  source: JobSourceSummary
  attachments?: Array<{
    path: string
    mimeType: string
    encoding: 'utf8' | 'base64'
    content: string
  }>
}

export type JobProgress = {
  phase: JobPhase
  percent: number
  message: string
}

export type JobRecord = {
  jobId: string
  status: JobStatus
  progress: JobProgress
  source: JobSourceSummary
  createdAt: string
  updatedAt: string
  outputPath?: string
  inputPath?: string
  downloadUrl?: string
  error?: string
  fontAvailability?: FontAvailabilitySummary
  phaseDetails?: JobPhaseDetail[]
  resultSummary?: {
    htmlPath: string
    zipPath?: string
    zipSizeBytes?: number
    packagedFileCount?: number
    note: string
  }
}

export type FontAvailabilitySummary = {
  reportPath: string
  missingFonts: Array<{
    family: string
  }>
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
  warnings?: string[]
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

export type CreateJobResponse = {
  jobId: string
  status: JobStatus
  progress: JobProgress
  createdAt: string
  inputPath?: string
}

export type JobListResponse = {
  jobs: JobRecord[]
}
