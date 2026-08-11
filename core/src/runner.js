import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getLlmConfig, validateLlmConfig } from '../../mcp-server/src/config.js'
import { packageOutputDirectory } from '../../mcp-server/src/output-zip.js'
import { PROCESS_PHASES, findFailedPhase, phaseStartPercent, resetPhaseDetailsForRetry } from '../../mcp-server/src/workflow/job-retry.js'
import { DEFAULT_JOB_ROOT } from './constants.js'
import { prepareInput, readInputMetadata, validateInputPath } from './input.js'
import { phaseArtifacts, runLegacyJobWorkflow } from './job-service.js'
import { cancelJob, listJobs, markJobCanceled, readJob, readLatestJob, resolveJobId } from './jobs.js'
import { serveOutputDirectory } from './preview-server.js'

export async function runGenerateFromInput(inputPath, options = {}) {
  const jobId = options.jobId || randomUUID()
  const jobRoot = resolve(options.jobRoot || DEFAULT_JOB_ROOT)
  const jobDir = join(jobRoot, jobId)
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const onJobStart = typeof options.onJobStart === 'function' ? options.onJobStart : () => {}
  const startedAt = new Date().toISOString()
  const phaseDetails = []
  let source = {
    pageId: 'unknown',
    pageName: 'unknown',
    selectionIds: [],
    selectionCount: 0,
  }
  let currentRecord = {
    jobId,
    pid: process.pid,
    status: 'running',
    source,
    createdAt: startedAt,
    updatedAt: startedAt,
    progress: { phase: 'collect-input', percent: 0, message: '任务已创建' },
    phaseDetails,
  }

  const emitProgress = (progress) => {
    currentRecord = {
      ...currentRecord,
      status: 'running',
      progress,
      phaseDetails,
      updatedAt: new Date().toISOString(),
    }
    writeJobRecord(jobDir, currentRecord)
    onProgress(progress)
  }

  mkdirSync(jobDir, { recursive: true })
  writeJobRecord(jobDir, currentRecord)
  onJobStart({ jobId, jobDir, jobRoot })
  emitProgress({ phase: 'collect-input', percent: 5, message: '准备 00-input 输入包' })
  const inputDir = prepareInput(inputPath, jobDir)
  const metadata = readInputMetadata(inputDir)
  source = metadata.source
  currentRecord = {
    ...currentRecord,
    jobId,
    pid: process.pid,
    status: 'running',
    source,
    inputPath: inputDir,
    progress: { phase: 'collect-input', percent: 5, message: '准备 00-input 输入包' },
  }
  writeJobRecord(jobDir, currentRecord)

  try {
    const result = await runWorkflow({ jobId, jobDir, phaseDetails, onProgress: emitProgress })
    const zipPath = join(jobDir, 'final', 'output.zip')
    const packageResult = packageOutputDirectory(result.outputPath, zipPath)
    const completedAt = new Date().toISOString()
    const finalMessage = htmlGenerationCompleteMessage(result)
    const finalRecord = {
      jobId,
      pid: process.pid,
      status: 'done',
      source,
      inputPath: inputDir,
      outputDir: result.outputPath,
      outputPath: result.outputPath,
      createdAt: startedAt,
      updatedAt: completedAt,
      progress: { phase: 'html-generation', percent: 100, message: finalMessage },
      phaseDetails,
      htmlGenerationResult: result,
      resultSummary: {
        htmlPath: join(result.outputPath, 'index.html'),
        zipPath,
        zipSizeBytes: packageResult.sizeBytes,
        packagedFileCount: packageResult.fileCount,
        note: htmlGenerationResultNote(result),
      },
    }
    writeJobRecord(jobDir, finalRecord)
    onProgress(finalRecord.progress)
    return finalRecord
  } catch (error) {
    const failedAt = new Date().toISOString()
    const message = error instanceof Error ? error.message : String(error)
    const failedPhase = markCurrentPhaseError(phaseDetails, message, failedAt, currentRecord.progress?.phase)
    const failedRecord = {
      jobId,
      pid: process.pid,
      status: 'error',
      source,
      inputPath: inputDir,
      createdAt: startedAt,
      updatedAt: failedAt,
      progress: { phase: failedPhase, percent: 100, message: '任务失败' },
      phaseDetails,
      error: message,
    }
    writeJobRecord(jobDir, failedRecord)
    throw Object.assign(new Error(message), { job: failedRecord })
  }
}

export function doctor() {
  const config = getLlmConfig()
  const configErrors = validateLlmConfig(config)
  return {
    ok: configErrors.length === 0,
    node: process.version,
    llmConfigured: configErrors.length === 0,
    configErrors,
    llm: {
      provider: config.provider,
      baseUrl: config.baseUrl || null,
      model: config.model || null,
      wireApi: config.wireApi,
      auth: config.provider === 'codex-sdk' ? 'codex-cli-login' : 'api-key',
      reuseThread: config.provider === 'codex-sdk' ? config.codexReuseThread : undefined,
    },
    jobRoot: resolve(DEFAULT_JOB_ROOT),
  }
}

export function validateInput(inputPath, options = {}) {
  const jobRoot = resolve(options.jobRoot || DEFAULT_JOB_ROOT)
  return validateInputPath(inputPath, { jobRoot })
}

export function getJobs(options = {}) {
  return listJobs(options)
}

export function getJobStatus(jobId, options = {}) {
  return readJob(resolveJobId(jobId, options), options)
}

export function getLatestJobStatus(options = {}) {
  return readLatestJob(options)
}

export function cancelRunningJob(jobId, options = {}) {
  return cancelJob(jobId, options)
}

export function markRunningJobCanceled(jobId, options = {}) {
  return markJobCanceled(jobId, options)
}

export async function serveJobOutput(jobId, options = {}) {
  const resolvedJobId = resolveJobId(jobId, options)
  const jobRoot = resolve(options.jobRoot || DEFAULT_JOB_ROOT)
  const job = readJob(resolvedJobId, { jobRoot })
  const outputDir = job.outputDir || job.outputPath || join(jobRoot, resolvedJobId, '05-output')
  const result = await serveOutputDirectory(outputDir, options)
  return {
    ...result,
    job,
    jobId: resolvedJobId,
  }
}

export async function retryJobFromFailedPhase(jobId, options = {}) {
  const resolvedJobId = resolveJobId(jobId, options)
  const jobRoot = resolve(options.jobRoot || DEFAULT_JOB_ROOT)
  const jobDir = join(jobRoot, resolvedJobId)
  const originalJob = readJob(resolvedJobId, { jobRoot })
  if (originalJob.status !== 'error' && !options.allowCompleted) {
    const hint = originalJob.status === 'canceled' ? '。取消任务不会自动重试，请重新 generate。' : ''
    throw new Error(`只有失败任务可以重试，当前状态是：${originalJob.status}${hint}`)
  }

  const failedPhase = options.startPhase || findFailedPhase(originalJob)
  if (!PROCESS_PHASES.includes(failedPhase)) {
    throw new Error(`无法识别失败阶段：${failedPhase || 'unknown'}`)
  }

  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
  const onJobStart = typeof options.onJobStart === 'function' ? options.onJobStart : () => {}
  const phaseDetails = resetPhaseDetailsForRetry(originalJob.phaseDetails || [], failedPhase)
  let currentRecord = {
    ...originalJob,
    pid: process.pid,
    status: 'running',
    error: undefined,
    retryCount: Number(originalJob.retryCount || 0) + 1,
    lastRetryAt: new Date().toISOString(),
    progress: {
      phase: failedPhase,
      percent: phaseStartPercent(failedPhase),
      message: options.startPhase ? `从指定阶段重新执行：${failedPhase}` : `从失败阶段继续：${failedPhase}`,
    },
    phaseDetails,
  }

  const emitProgress = (progress) => {
    currentRecord = {
      ...currentRecord,
      status: 'running',
      progress,
      phaseDetails,
      updatedAt: new Date().toISOString(),
    }
    writeJobRecord(jobDir, currentRecord)
    onProgress(progress)
  }

  writeJobRecord(jobDir, currentRecord)
  onJobStart({ jobId: resolvedJobId, jobDir, jobRoot, retry: true, retryPhase: failedPhase })
  emitProgress(currentRecord.progress)

  try {
    const result = await runWorkflow({
      jobId: resolvedJobId,
      jobDir,
      phaseDetails,
      onProgress: emitProgress,
      startPhase: failedPhase,
    })
    const zipPath = join(jobDir, 'final', 'output.zip')
    const packageResult = packageOutputDirectory(result.outputPath, zipPath)
    const finalMessage = htmlGenerationCompleteMessage(result)
    const finalRecord = {
      ...currentRecord,
      status: 'done',
      outputDir: result.outputPath,
      outputPath: result.outputPath,
      progress: { phase: 'html-generation', percent: 100, message: finalMessage },
      phaseDetails,
      htmlGenerationResult: result,
      resultSummary: {
        htmlPath: join(result.outputPath, 'index.html'),
        zipPath,
        zipSizeBytes: packageResult.sizeBytes,
        packagedFileCount: packageResult.fileCount,
        note: htmlGenerationResultNote(result),
      },
    }
    writeJobRecord(jobDir, finalRecord)
    onProgress(finalRecord.progress)
    return finalRecord
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failedPhaseName = markCurrentPhaseError(phaseDetails, message, new Date().toISOString(), currentRecord.progress?.phase)
    const failedRecord = {
      ...currentRecord,
      status: 'error',
      progress: { phase: failedPhaseName, percent: 100, message: '任务失败' },
      phaseDetails,
      error: message,
    }
    writeJobRecord(jobDir, failedRecord)
    throw Object.assign(new Error(message), { job: failedRecord })
  }
}

export function retryJobFromPhase(jobId, startPhase, options = {}) {
  return retryJobFromFailedPhase(jobId, {
    ...options,
    startPhase,
    allowCompleted: true,
  })
}

async function runWorkflow({ jobId, jobDir, phaseDetails, onProgress, startPhase = 'normalize-raw' }) {
  const result = await runLegacyJobWorkflow({
    jobId,
    jobDir,
    startPhase,
    onPhaseStart: ({ phase, startMessage, startPercent }) => {
      beginPhase(phaseDetails, phase, startMessage, onProgress, startPercent)
    },
    onPhaseProgress: ({ phase, metrics, message, percent }) => {
      streamProgress(phaseDetails, phase, metrics, message, onProgress, percent)
    },
    onPhaseComplete: ({ phase, message, percent, result: phaseResult }) => {
      completePhase(phaseDetails, phase, message, {
        durationMs: phaseResult.durationMs,
        tokenUsage: phaseResult.tokenUsage,
        artifacts: phaseArtifacts(phaseResult),
        warnings: phaseResult.validationWarnings,
      }, onProgress, percent)
    },
  })
  return result.htmlGenerationResult
}

function beginPhase(phaseDetails, phase, message, onProgress, percent) {
  upsertPhase(phaseDetails, phase, {
    status: 'running',
    startedAt: new Date().toISOString(),
    message,
    tokenUsage: emptyTokenUsage(),
    artifacts: [],
  })
  onProgress({ phase, percent, message })
}

function completePhase(phaseDetails, phase, message, patch, onProgress, percent) {
  const current = phaseDetails.find((item) => item.phase === phase)
  const endedAt = new Date().toISOString()
  upsertPhase(phaseDetails, phase, {
    status: 'done',
    endedAt,
    durationMs: patch.durationMs ?? (current?.startedAt ? Date.now() - new Date(current.startedAt).getTime() : 0),
    message,
    tokenUsage: patch.tokenUsage || emptyTokenUsage(),
    artifacts: patch.artifacts || [],
    warnings: patch.warnings || [],
  })
  onProgress({ phase, percent, message })
}

function htmlGenerationCompleteMessage(result = {}) {
  return result.staticValidation?.ok === false
    ? 'HTML/CSS/JS 已生成，静态校验存在警告'
    : 'HTML/CSS/JS 已生成并通过静态校验'
}

function htmlGenerationResultNote(result = {}) {
  const count = result.validationWarnings?.length || result.staticValidation?.errors?.length || 0
  return result.staticValidation?.ok === false
    ? `HTML/CSS/JS 与页面资源已打包完成；静态校验存在 ${count} 个警告，请查看 static-validation.json。`
    : 'HTML/CSS/JS 与页面资源已打包完成。'
}

function streamProgress(phaseDetails, phase, metrics, message, onProgress, percent) {
  const current = phaseDetails.find((item) => item.phase === phase)
  upsertPhase(phaseDetails, phase, {
    status: 'running',
    message,
    durationMs: current?.startedAt ? Date.now() - new Date(current.startedAt).getTime() : 0,
    streamMetrics: metrics,
  })
  onProgress({ phase, percent, message, streamMetrics: metrics })
}

function upsertPhase(phaseDetails, phase, patch) {
  const current = phaseDetails.find((item) => item.phase === phase)
  if (current) {
    Object.assign(current, patch)
    return current
  }
  const next = {
    phase,
    status: 'pending',
    message: '',
    durationMs: 0,
    tokenUsage: emptyTokenUsage(),
    artifacts: [],
    ...patch,
  }
  phaseDetails.push(next)
  return next
}

function emptyTokenUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimated: false,
  }
}

function currentPhase(phaseDetails, fallbackPhase = 'collect-input') {
  const errored = [...phaseDetails].reverse().find((phase) => phase.status === 'error')
  const running = [...phaseDetails].reverse().find((phase) => phase.status === 'running')
  const last = phaseDetails[phaseDetails.length - 1]
  return errored?.phase || running?.phase || last?.phase || fallbackPhase
}

function markCurrentPhaseError(phaseDetails, message, endedAt, fallbackPhase) {
  const phase = [...phaseDetails].reverse().find((item) => item.status === 'running')
    || phaseDetails.find((item) => item.phase === fallbackPhase)
    || phaseDetails[phaseDetails.length - 1]
  if (!phase) return fallbackPhase || 'collect-input'
  phase.status = 'error'
  phase.endedAt = endedAt
  phase.message = message
  phase.durationMs = phase.startedAt ? new Date(endedAt).getTime() - new Date(phase.startedAt).getTime() : phase.durationMs
  return phase.phase
}

function writeJobRecord(jobDir, record) {
  mkdirSync(jobDir, { recursive: true })
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify(record, null, 2))
}
