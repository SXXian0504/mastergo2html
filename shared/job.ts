export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

export type JobPhase =
  | 'collect-input'
  | 'normalize-raw'
  | 'layout-analysis'
  | 'module-slicing'
  | 'ai-planning'
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
  resultSummary?: {
    htmlPath: string
    zipPath: string
    note: string
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
