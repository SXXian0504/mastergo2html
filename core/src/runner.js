import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertLlmConfig, getLlmConfig, validateLlmConfig, withLlmJobContext } from '../../mcp-server/src/config.js'
import { packageOutputDirectory } from '../../mcp-server/src/output-zip.js'
import { runAssemblyPlanning } from '../../mcp-server/src/workflow/assembly-planning.js'
import { runAiLayoutAnalysis } from '../../mcp-server/src/workflow/ai-layout-analysis.js'
import { runComponentStructureAnalysis } from '../../mcp-server/src/workflow/component-structure-analysis.js'
import { runHtmlGeneration } from '../../mcp-server/src/workflow/html-generation.js'
import { runInteractionAnalysis } from '../../mcp-server/src/workflow/interaction-analysis.js'
import { runRawLayoutConversion } from '../../mcp-server/src/workflow/raw-layout-conversion.js'
import { runStaticAssetAnalysis } from '../../mcp-server/src/workflow/static-asset-analysis.js'
import { PROCESS_PHASES, findFailedPhase, phaseStartPercent, resetPhaseDetailsForRetry } from '../../mcp-server/src/workflow/job-retry.js'
import { DEFAULT_JOB_ROOT } from './constants.js'
import { prepareInput, readInputMetadata, validateInputPath } from './input.js'
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
  const config = withLlmJobContext(getLlmConfig(), { jobId, jobDir })
  assertLlmConfig(config)

  let layoutConversion
  if (shouldRunPhase(startPhase, 'normalize-raw')) {
    beginPhase(phaseDetails, 'normalize-raw', '标准化输入数据', onProgress, 10)
    const normalizeStartedAt = Date.now()
    layoutConversion = await runRawLayoutConversion(jobId, jobDir)
    completePhase(phaseDetails, 'normalize-raw', `已生成标准化输入：${layoutConversion.summary.nodeCount} 个节点，${layoutConversion.summary.assetCount} 个资源`, {
      durationMs: Date.now() - normalizeStartedAt,
      artifacts: [layoutConversion.normalizedDir, layoutConversion.aiLayoutContextPath],
    }, onProgress, 25)
  } else {
    layoutConversion = {
      aiLayoutContextPath: join(jobDir, '02-layout', 'ai-layout-context.json'),
      summary: { warningCount: 0 },
    }
  }

  if (shouldRunPhase(startPhase, 'layout-analysis')) {
    beginPhase(phaseDetails, 'layout-analysis', '调用 AI 布局分析生成页面整体布局说明', onProgress, 32)
    const aiLayoutAnalysisResult = await runAiLayoutAnalysis({
      config,
      jobId,
      jobDir,
      contextPath: layoutConversion.aiLayoutContextPath,
      onProgress: (metrics, message) => streamProgress(phaseDetails, 'layout-analysis', metrics, message, onProgress, 32),
    })
    completePhase(phaseDetails, 'layout-analysis', `AI 布局分析已生成 page-layout.md：${layoutConversion.summary.warningCount} 个 warning 待后续修复`, {
      durationMs: aiLayoutAnalysisResult.durationMs,
      tokenUsage: aiLayoutAnalysisResult.tokenUsage,
      artifacts: [aiLayoutAnalysisResult.outputPath, aiLayoutAnalysisResult.promptPath, aiLayoutAnalysisResult.responsePath],
    }, onProgress, 40)
  }

  if (shouldRunPhase(startPhase, 'component-structure-analysis')) {
    beginPhase(phaseDetails, 'component-structure-analysis', 'AI 分析整页组件结构与布局实现', onProgress, 50)
    const componentStructureResult = await runComponentStructureAnalysis({
      config,
      jobId,
      jobDir,
      onProgress: (metrics, message) => streamProgress(phaseDetails, 'component-structure-analysis', metrics, message, onProgress, 50),
    })
    completePhase(phaseDetails, 'component-structure-analysis', '整页组件结构开发计划已生成', {
      durationMs: componentStructureResult.durationMs,
      tokenUsage: componentStructureResult.tokenUsage,
      artifacts: [componentStructureResult.outputPath, componentStructureResult.promptPath],
    }, onProgress, 58)
  }

  if (shouldRunPhase(startPhase, 'static-asset-analysis')) {
    beginPhase(phaseDetails, 'static-asset-analysis', 'AI 分析整页静态资源使用方案', onProgress, 60)
    const staticAssetResult = await runStaticAssetAnalysis({
      config,
      jobId,
      jobDir,
      onProgress: (metrics, message) => streamProgress(phaseDetails, 'static-asset-analysis', metrics, message, onProgress, 60),
    })
    completePhase(phaseDetails, 'static-asset-analysis', '整页静态资源开发计划已生成', {
      durationMs: staticAssetResult.durationMs,
      tokenUsage: staticAssetResult.tokenUsage,
      artifacts: [staticAssetResult.outputPath, staticAssetResult.promptPath],
    }, onProgress, 68)
  }

  if (shouldRunPhase(startPhase, 'interaction-analysis')) {
    beginPhase(phaseDetails, 'interaction-analysis', 'AI 分析整页动态交互与状态', onProgress, 70)
    const interactionResult = await runInteractionAnalysis({
      config,
      jobId,
      jobDir,
      onProgress: (metrics, message) => streamProgress(phaseDetails, 'interaction-analysis', metrics, message, onProgress, 70),
    })
    completePhase(phaseDetails, 'interaction-analysis', '整页动态交互开发计划已生成', {
      durationMs: interactionResult.durationMs,
      tokenUsage: interactionResult.tokenUsage,
      artifacts: [interactionResult.outputPath, interactionResult.promptPath],
    }, onProgress, 78)
  }

  if (shouldRunPhase(startPhase, 'assembly-planning')) {
    beginPhase(phaseDetails, 'assembly-planning', 'AI 汇总三份页面计划并裁决组装方案', onProgress, 82)
    const assemblyResult = await runAssemblyPlanning({
      config,
      jobId,
      jobDir,
      onProgress: (metrics, message) => streamProgress(phaseDetails, 'assembly-planning', metrics, message, onProgress, 82),
    })
    completePhase(phaseDetails, 'assembly-planning', '单页面组装计划已生成', {
      durationMs: assemblyResult.durationMs,
      tokenUsage: assemblyResult.tokenUsage,
      artifacts: [assemblyResult.outputPath, assemblyResult.promptPath],
    }, onProgress, 88)
  }

  let htmlGenerationResult
  if (shouldRunPhase(startPhase, 'html-generation')) {
    beginPhase(phaseDetails, 'html-generation', '生成 HTML 产物', onProgress, 90)
    htmlGenerationResult = await runHtmlGeneration({
      config,
      jobId,
      jobDir,
      onProgress: (metrics, message) => streamProgress(phaseDetails, 'html-generation', metrics, message, onProgress, 90),
    })
    completePhase(phaseDetails, 'html-generation', htmlGenerationCompleteMessage(htmlGenerationResult), {
      durationMs: htmlGenerationResult.durationMs,
      tokenUsage: htmlGenerationResult.tokenUsage,
      artifacts: htmlGenerationResult.artifacts,
      warnings: htmlGenerationResult.validationWarnings,
    }, onProgress, 100)
  }

  return htmlGenerationResult
}

function shouldRunPhase(startPhase, phase) {
  return PROCESS_PHASES.indexOf(phase) >= PROCESS_PHASES.indexOf(startPhase)
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
