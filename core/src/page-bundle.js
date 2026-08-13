import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { retryJobFromFailedPhase, retryJobFromPhase, runGenerateFromInput } from './runner.js'
import { canonicalPhaseName } from '../../mcp-server/src/workflow/job-retry.js'
import {
  MAX_GLOBAL_MODEL_CONCURRENCY,
  getGlobalModelConcurrencyMetrics,
  resetGlobalModelConcurrencyMetrics,
  setGlobalModelConcurrency,
} from '../../mcp-server/src/llm/concurrency.js'
import { extractStoredZip } from './zip.js'

const PAGE_BUNDLE_VERSION = 'mastergo2html.page-bundle.v1'

export function preparePageBundle(inputPath, workspaceDir) {
  const resolvedInput = resolve(inputPath)
  if (!existsSync(resolvedInput)) throw new Error(`页面包不存在：${resolvedInput}`)

  const workspace = resolve(workspaceDir)
  const sourceDir = join(workspace, 'source')
  rmSync(sourceDir, { recursive: true, force: true })
  mkdirSync(sourceDir, { recursive: true })

  const stat = statSync(resolvedInput)
  let bundleRoot
  if (stat.isDirectory()) {
    bundleRoot = findBundleRoot(resolvedInput)
  } else if (extname(resolvedInput).toLowerCase() === '.zip') {
    extractStoredZip(resolvedInput, sourceDir)
    bundleRoot = findBundleRoot(sourceDir)
  } else {
    throw new Error('页面包必须是 ZIP 文件或包含 mastergo-pages.json 的目录。')
  }

  const manifestPath = join(bundleRoot, 'mastergo-pages.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  validatePageBundleManifest(manifest)

  const pages = manifest.pages.map((page, index) => {
    const safeInputDir = assertSafeBundlePath(page.inputDir)
    const pageInputPath = resolve(bundleRoot, safeInputDir)
    if (!isInside(bundleRoot, pageInputPath)) throw new Error(`页面 ${page.name} 的 inputDir 越出页面包：${page.inputDir}`)
    validatePageInput(pageInputPath, page.name)
    return {
      ...page,
      index,
      inputPath: pageInputPath,
    }
  })

  return {
    inputPath: resolvedInput,
    workspace,
    bundleRoot,
    manifestPath,
    manifest,
    pages,
  }
}

export async function runGeneratePageBundle(inputPath, options = {}) {
  const batchId = options.batchId || randomUUID()
  const batchRoot = resolve(options.batchRoot || '.mastergo2html/page-batches')
  const batchDir = join(batchRoot, batchId)
  const jobsRoot = join(batchDir, 'jobs')
  mkdirSync(jobsRoot, { recursive: true })

  const prepared = preparePageBundle(inputPath, batchDir)
  const startedAt = new Date().toISOString()
  const schedulerResolution = resolvePageBatchScheduler(options)
  const scheduler = schedulerResolution.scheduler
  const invocation = createInvocationRecord(options)
  const representativeIndexes = scheduler.qualityGateEnabled
    ? selectRepresentativePageIndexes(prepared.pages, scheduler.qualityGatePageCount)
    : []
  const reusablePages = options.forceRegenerate
    ? new Map()
    : findReusablePageResults(prepared.pages, batchRoot)
  const batch = {
    version: 'mastergo2html.page-batch-result.v2',
    batchId,
    status: 'running',
    inputPath: prepared.inputPath,
    manifestPath: prepared.manifestPath,
    batchDir,
    jobsRoot,
    createdAt: startedAt,
    updatedAt: startedAt,
    source: prepared.manifest.source,
    scheduler,
    schedulerDiagnostics: createSchedulerDiagnostics({
      ...schedulerResolution,
      scheduler,
      pageCount: prepared.pages.length,
      entryPoint: options.entryPoint,
      mode: 'generate',
    }),
    invocation,
    invocations: [invocation],
    qualityGate: {
      enabled: scheduler.qualityGateEnabled,
      mode: scheduler.qualityGateMode,
      status: scheduler.qualityGateEnabled ? 'pending' : 'disabled',
      pageCount: representativeIndexes.length,
      pageIds: representativeIndexes.map((index) => prepared.pages[index].id),
    },
    pages: prepared.pages.map((page) => ({
      id: page.id,
      name: page.name,
      route: page.route,
      sourceNodeId: page.sourceNodeId,
      inputPath: page.inputPath,
      index: page.index,
      representative: representativeIndexes.includes(page.index),
      status: 'pending',
      retryCount: 0,
      inputFingerprint: fingerprintPageInput(page.inputPath),
      ...(reusablePages.get(pageReuseKey(page)) ? reusablePageState(reusablePages.get(pageReuseKey(page)), page) : {}),
    })),
  }
  writeBatchRecord(batchDir, batch)
  return executePageBatch(batch, options, schedulerResolution)
}

export async function resumeGeneratePageBundle(batchId, options = {}) {
  const batchRoot = resolve(options.batchRoot || '.mastergo2html/page-batches')
  const batchDir = join(batchRoot, batchId)
  const recordPath = join(batchDir, 'batch.json')
  if (!existsSync(recordPath)) throw new Error(`多页面批次不存在：${batchId}`)
  const batch = JSON.parse(readFileSync(recordPath, 'utf8'))
  batch.batchDir = batch.batchDir || batchDir
  batch.jobsRoot = batch.jobsRoot || join(batchDir, 'jobs')
  batch.pages = (batch.pages || []).map((page, index) => ({ ...page, index: page.index ?? index }))
  const schedulerResolution = resolvePageBatchScheduler(options, {
    inheritedScheduler: batch.scheduler,
    inheritedSources: batch.schedulerDiagnostics?.sources,
  })
  batch.scheduler = schedulerResolution.scheduler
  batch.schedulerDiagnostics = createSchedulerDiagnostics({
    ...schedulerResolution,
    pageCount: batch.pages.length,
    entryPoint: options.entryPoint,
    mode: 'resume',
  })
  const previousInvocations = batch.invocations || (batch.invocation ? [batch.invocation] : [])
  batch.invocation = createInvocationRecord(options)
  batch.invocations = [...previousInvocations, batch.invocation]
  options.onSchedulerResolved?.(batch.schedulerDiagnostics)

  const retryQuality = Boolean(options.retryQuality || options.forceQualityRetry)
  if (batch.status === 'done' && !options.forceQualityRetry) return batch
  if (batch.qualityGate?.status === 'awaiting-approval' && !options.approveQuality && !retryQuality) {
    throw new Error(`批次 ${batchId} 正在等待代表页面质量确认。检查代表页面后使用 resume-pages ${batchId} --approve-quality。`)
  }
  if (options.approveQuality && batch.qualityGate) {
    const gatePages = batch.pages.filter((page) => page.representative)
    if (evaluateQualityGate(gatePages).passed) {
      batch.qualityGate.status = 'approved'
      batch.qualityGate.approvedAt = new Date().toISOString()
      batch.updatedAt = batch.qualityGate.approvedAt
    } else {
      batch.qualityGate.status = 'pending'
    }
  }

  recoverCompletedQualityRetries(batch)
  if (retryQuality && batch.qualityGate) {
    batch.qualityGate.retryRequestedAt = new Date().toISOString()
    const retryCandidates = batch.pages.filter((candidate) => {
      if (candidate.status === 'error' || candidate.status === 'quality-retry') return Boolean(candidate.jobId)
      return Boolean(options.forceQualityRetry && candidate.representative && candidate.jobId)
    })
    if (retryCandidates.length > 0) {
      batch.qualityGate.status = 'pending'
      batch.qualityGate.approvedAt = undefined
      for (const page of retryCandidates) {
        page.forceRetryPhase = 'plan-and-generate'
        page.status = 'quality-retry'
        page.error = '显式请求质量重试，重新执行 HTML 生成阶段。'
      }
    }
  }

  for (const page of batch.pages) {
    if (page.status === 'running' || page.status === 'retrying' || page.status === 'paused') {
      page.status = page.jobId ? 'error' : 'pending'
      page.error ||= '上一次批处理在页面运行中退出，等待恢复。'
    }
  }
  batch.status = 'running'
  batch.pause = undefined
  batch.updatedAt = new Date().toISOString()
  writeBatchRecord(batchDir, batch)
  return executePageBatch(batch, options, schedulerResolution, { schedulerAlreadyReported: true })
}

async function executePageBatch(batch, options, schedulerResolution, { schedulerAlreadyReported = false } = {}) {
  const scheduler = schedulerResolution.scheduler
  batch.scheduler = scheduler
  batch.schedulerDiagnostics = createSchedulerDiagnostics({
    ...schedulerResolution,
    pageCount: batch.pages.length,
    entryPoint: options.entryPoint,
    mode: batch.schedulerDiagnostics?.mode || 'generate',
  })
  if (!schedulerAlreadyReported) options.onSchedulerResolved?.(batch.schedulerDiagnostics)
  setGlobalModelConcurrency(scheduler.modelConcurrency)
  resetGlobalModelConcurrencyMetrics()
  const runtime = createBatchRuntime(batch, options, scheduler)
  beginSchedulerRuntime(batch, runtime)
  const gatePages = batch.pages.filter((page) => page.representative)

  if (scheduler.qualityGateEnabled && batch.qualityGate?.status !== 'approved') {
    batch.qualityGate.status = 'running'
    batch.updatedAt = new Date().toISOString()
    writeBatchRecord(batch.batchDir, batch)
    await runPagePool(gatePages.filter((page) => page.status !== 'done'), runtime)
    if (runtime.pause) {
      updateSchedulerRuntime(batch, runtime, { completed: true })
      return finalizePausedBatch(batch, runtime.pause)
    }

    const quality = evaluateQualityGate(gatePages)
    batch.qualityGate = {
      ...batch.qualityGate,
      ...quality,
      evaluatedAt: new Date().toISOString(),
    }
    if (!quality.passed) {
      batch.qualityGate.status = 'failed'
      batch.qualityGate.resumeHint = `npm run --silent cli -- resume-pages ${batch.batchId} --json`
      for (const page of gatePages.filter((candidate) => candidate.status === 'done' && candidate.quality?.staticValidationOk === false)) {
        page.qualityGateFailure = true
        page.qualityGateFailureReason = 'static-validation'
      }
      // A generated page remains reusable even when a quality report fails. Do not
      // downgrade it to quality-retry; continue with non-generated pages instead.
      batch.updatedAt = new Date().toISOString()
      writeBatchRecord(batch.batchDir, batch)
    }
    if (quality.passed) {
      for (const page of gatePages) {
        page.qualityGateFailure = undefined
        page.qualityGateFailureReason = undefined
      }
      if (scheduler.qualityGateMode === 'manual' && !options.approveQuality) {
        batch.status = 'quality-gate'
        batch.qualityGate.status = 'awaiting-approval'
        batch.qualityGate.resumeHint = `npm run --silent cli -- resume-pages ${batch.batchId} --approve-quality --json`
        batch.updatedAt = new Date().toISOString()
        updateSchedulerRuntime(batch, runtime, { completed: true })
        writeBatchRecord(batch.batchDir, batch)
        return batch
      }
      batch.qualityGate.status = 'approved'
      batch.qualityGate.approvedAt = new Date().toISOString()
      batch.updatedAt = batch.qualityGate.approvedAt
      updateSchedulerRuntime(batch, runtime)
      writeBatchRecord(batch.batchDir, batch)
    }
  }

  const remainingPages = batch.pages.filter((page) => (
    page.status !== 'done'
    && !(batch.qualityGate?.status === 'failed' && page.representative)
  ))
  await runPagePool(remainingPages, runtime)
  if (runtime.pause) {
    updateSchedulerRuntime(batch, runtime, { completed: true })
    return finalizePausedBatch(batch, runtime.pause)
  }

  batch.status = batch.pages.some((page) => page.status === 'error')
    ? 'partial'
    : batch.qualityGate?.status === 'failed'
      ? 'quality-failed'
      : 'done'
  batch.updatedAt = new Date().toISOString()
  updateSchedulerRuntime(batch, runtime, { completed: true })
  writeBatchRecord(batch.batchDir, batch)
  return batch
}

function beginSchedulerRuntime(batch, runtime) {
  const schedulerRun = {
    startedAt: new Date().toISOString(),
    requested: {
      pageConcurrency: runtime.scheduler.pageConcurrency,
      modelConcurrency: runtime.scheduler.modelConcurrency,
    },
    pagePool: {
      peakActiveCount: 0,
      runs: [],
    },
    modelLimiter: {
      peakActiveCount: 0,
      totalAcquisitionCount: 0,
      queuedAcquisitionCount: 0,
    },
  }
  runtime.schedulerRun = schedulerRun
  batch.schedulerRuntime = schedulerRun
  batch.schedulerRuns = [...(batch.schedulerRuns || []), schedulerRun]
}

function updateSchedulerRuntime(batch, runtime, { completed = false } = {}) {
  const modelMetrics = getGlobalModelConcurrencyMetrics()
  runtime.schedulerRun.pagePool = {
    peakActiveCount: runtime.peakActivePageCount,
    runs: runtime.pagePoolRuns.map((run) => ({ ...run })),
  }
  runtime.schedulerRun.modelLimiter = { ...modelMetrics }
  runtime.schedulerRun.actual = {
    pageConcurrency: runtime.peakActivePageCount,
    modelConcurrency: modelMetrics.peakActiveCount,
    modelConcurrencyObserved: modelMetrics.totalAcquisitionCount > 0,
  }
  runtime.schedulerRun.updatedAt = new Date().toISOString()
  if (completed) runtime.schedulerRun.endedAt = runtime.schedulerRun.updatedAt
  batch.schedulerRuntime = runtime.schedulerRun
}

function createBatchRuntime(batch, options, scheduler) {
  return {
    batch,
    options,
    scheduler,
    pause: null,
    stopScheduling: false,
    globalErrorCounts: new Map(),
    activePageCount: 0,
    peakActivePageCount: 0,
    pagePoolRuns: [],
    runGeneratePage: options.runGeneratePage || runGenerateFromInput,
    retryPageJob: options.retryPageJob || retryJobFromFailedPhase,
    retryPageFromPhase: options.retryPageFromPhase || retryJobFromPhase,
    sleep: options.sleep || sleep,
  }
}

async function runPagePool(pages, runtime) {
  if (pages.length === 0) return
  let cursor = 0
  const workerCount = Math.max(1, Math.min(runtime.scheduler.pageConcurrency, pages.length))
  const poolRun = {
    startedAt: new Date().toISOString(),
    requestedPageConcurrency: runtime.scheduler.pageConcurrency,
    workerCount,
    pageIds: pages.map((page) => page.id),
    peakActivePageCount: 0,
  }
  runtime.pagePoolRuns.push(poolRun)
  const workers = Array.from({ length: workerCount }, async () => {
    while (!runtime.stopScheduling && !runtime.pause) {
      const position = cursor
      cursor += 1
      if (position >= pages.length) return
      runtime.activePageCount += 1
      runtime.peakActivePageCount = Math.max(runtime.peakActivePageCount, runtime.activePageCount)
      poolRun.peakActivePageCount = Math.max(poolRun.peakActivePageCount, runtime.activePageCount)
      try {
        await runPage(pages[position], runtime)
      } finally {
        runtime.activePageCount = Math.max(0, runtime.activePageCount - 1)
      }
    }
  })
  await Promise.all(workers)
  poolRun.endedAt = new Date().toISOString()
}

async function runPage(page, runtime) {
  const { batch, options, scheduler } = runtime
  const pageBase = pickPageBase(page)
  const forcedRetryPhase = canonicalPhaseName(page.forceRetryPhase)
  page.status = 'running'
  page.startedAt ||= new Date().toISOString()
  page.updatedAt = new Date().toISOString()
  page.error = undefined
  writeBatchRecord(batch.batchDir, batch)
  options.onPageStart?.({ ...pageBase, index: page.index, total: batch.pages.length, representative: page.representative })

  let shouldResume = Boolean(page.jobId)
  let transientRetryCount = 0
  while (true) {
    try {
      const callbacks = {
        jobRoot: batch.jobsRoot,
        onJobStart: (jobInfo) => {
          page.jobId = jobInfo.jobId
          page.retryPhase = jobInfo.retryPhase
          page.updatedAt = new Date().toISOString()
          writeBatchRecord(batch.batchDir, batch)
          options.onJobStart?.({ page: pageBase, ...jobInfo })
        },
        onProgress: (progress) => {
          page.progress = progress
          page.updatedAt = new Date().toISOString()
          writeBatchRecord(batch.batchDir, batch)
          options.onProgress?.({ page: pageBase, progress })
        },
      }
      const job = forcedRetryPhase
        ? await runtime.retryPageFromPhase(page.jobId, forcedRetryPhase, callbacks)
        : shouldResume
          ? await runtime.retryPageJob(page.jobId, callbacks)
          : await runtime.runGeneratePage(page.inputPath, callbacks)
      applyCompletedJob(page, job)
      runtime.globalErrorCounts.clear()
      writeBatchRecord(batch.batchDir, batch)
      options.onPageComplete?.(page)
      return
    } catch (error) {
      const jobId = error?.job?.jobId || page.jobId
      if (jobId) page.jobId = jobId
      const classification = classifyGenerationError(error)
      const canRetry = classification.transient && page.jobId && transientRetryCount < scheduler.pageRetryLimit
      if (canRetry) {
        transientRetryCount += 1
        page.retryCount = Number(page.retryCount || 0) + 1
        page.status = 'retrying'
        page.error = error instanceof Error ? error.message : String(error)
        page.retryPhase = error?.job?.progress?.phase || page.retryPhase
        page.nextRetryDelayMs = retryDelayMs(scheduler.pageRetryBaseDelayMs, transientRetryCount)
        page.updatedAt = new Date().toISOString()
        writeBatchRecord(batch.batchDir, batch)
        options.onPageRetry?.({ ...pageBase, jobId: page.jobId, retryCount: page.retryCount, delayMs: page.nextRetryDelayMs, error: page.error })
        await runtime.sleep(page.nextRetryDelayMs)
        shouldResume = true
        continue
      }

      page.status = 'error'
      page.error = error instanceof Error ? error.message : String(error)
      page.errorCategory = classification.category
      page.transient = classification.transient
      page.endedAt = new Date().toISOString()
      page.updatedAt = page.endedAt
      writeBatchRecord(batch.batchDir, batch)
      options.onPageError?.(page)

      const pause = registerGlobalFailure(runtime, page, classification)
      if (pause) runtime.pause = pause
      if (!scheduler.continueOnError) runtime.stopScheduling = true
      return
    }
  }
}


function fingerprintPageInput(inputPath) {
  const root = resolve(inputPath)
  const hash = createHash('sha256')
  const files = []
  collectFiles(root, root, files)
  for (const file of files.sort()) {
    hash.update(relative(root, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function collectFiles(root, current, files) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name)
    if (entry.isDirectory()) collectFiles(root, fullPath, files)
    else if (entry.isFile()) files.push(fullPath)
  }
}

function hasReusableOutput(page) {
  return Boolean(page.outputDir && page.htmlPath && existsSync(page.outputDir) && existsSync(page.htmlPath))
}

function findReusablePageResults(pages, batchRoot) {
  const matches = new Map()
  if (!existsSync(batchRoot)) return matches
  const currentFingerprints = new Map(pages.map((page) => [pageReuseKey(page), fingerprintPageInput(page.inputPath)]))
  for (const entry of readdirSync(batchRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const recordPath = join(batchRoot, entry.name, 'batch.json')
    if (!existsSync(recordPath)) continue
    let candidateBatch
    try { candidateBatch = JSON.parse(readFileSync(recordPath, 'utf8')) } catch { continue }
    for (const page of candidateBatch.pages || []) {
      if (page.status !== 'done' || !hasReusableOutput(page)) continue
      const current = pages.find((item) => item.id === page.id && item.route === page.route)
      if (!current) continue
      const fingerprint = page.inputFingerprint || inferLegacyPageFingerprint(page)
      const key = pageReuseKey(current)
      if (!fingerprint || fingerprint !== currentFingerprints.get(key)) continue
      const previous = matches.get(key)
      if (!previous || String(candidateBatch.updatedAt || '') > String(previous.batchUpdatedAt || '')) {
        matches.set(key, {
          ...page,
          batchId: candidateBatch.batchId || entry.name,
          batchUpdatedAt: candidateBatch.updatedAt,
          legacyFingerprintInferred: !page.inputFingerprint,
        })
      }
    }
  }
  return matches
}

function pageReuseKey(page) {
  return `${page.id}\0${page.route}`
}

function inferLegacyPageFingerprint(page) {
  if (!page.inputPath || !existsSync(page.inputPath)) return null
  try {
    return fingerprintPageInput(page.inputPath)
  } catch {
    return null
  }
}

function reusablePageState(previous, page) {
  return {
    status: 'done',
    generationMode: 'reused',
    reusedFromBatchId: previous.batchId,
    reusedFromJobId: previous.jobId,
    reuseReason: previous.legacyFingerprintInferred
      ? 'matching-inferred-legacy-input-fingerprint-and-existing-output'
      : 'matching-input-fingerprint-and-existing-output',
    legacyFingerprintInferred: previous.legacyFingerprintInferred || undefined,
    jobId: previous.jobId,
    outputDir: previous.outputDir,
    htmlPath: previous.htmlPath,
    zipPath: previous.zipPath,
    progress: previous.progress,
    quality: previous.quality,
    reusedAt: new Date().toISOString(),
  }
}

function recoverCompletedQualityRetries(batch) {
  for (const page of batch.pages) {
    if (page.status === 'quality-retry' && hasReusableOutput(page)) {
      page.status = 'done'
      page.generationMode = page.generationMode || 'recovered'
      page.reuseReason = page.reuseReason || 'existing-completed-output-preserved'
      page.forceRetryPhase = undefined
      page.error = undefined
      page.recoveredAt = new Date().toISOString()
    }
  }
}

function applyCompletedJob(page, job) {
  const validation = job.htmlGenerationResult?.staticValidation
  const responsiveRuntime = job.htmlGenerationResult?.responsiveRuntime || validation?.responsiveRuntime
  const warnings = job.htmlGenerationResult?.validationWarnings || []
  page.status = 'done'
  page.generationMode = 'generated'
  page.jobId = job.jobId
  page.outputDir = job.outputDir
  page.htmlPath = job.resultSummary?.htmlPath
  page.zipPath = job.resultSummary?.zipPath
  page.progress = job.progress
  page.error = undefined
  page.nextRetryDelayMs = undefined
  page.forceRetryPhase = undefined
  page.qualityGateFailure = undefined
  page.qualityGateFailureReason = undefined
  page.endedAt = new Date().toISOString()
  page.updatedAt = page.endedAt
  page.quality = {
    staticValidationOk: validation?.ok !== false,
    staticValidationErrorCount: validation?.errors?.length || 0,
    responsiveRuntimeStatus: responsiveRuntime?.status || 'not-run',
    responsiveRuntimeOk: responsiveRuntime?.ok !== false,
    responsiveRuntimeWarningCount: responsiveRuntime?.warnings?.length || 0,
    warningCount: warnings.length,
    warnings,
  }
}

function evaluateQualityGate(pages) {
  const failedPages = pages.filter((page) => page.status !== 'done' || page.quality?.staticValidationOk === false)
  return {
    passed: failedPages.length === 0,
    failedPageIds: failedPages.map((page) => page.id),
    reviewPages: pages.map((page) => ({
      id: page.id,
      name: page.name,
      route: page.route,
      status: page.status,
      htmlPath: page.htmlPath,
      frameScreenshotPath: join(page.inputPath, 'frame-screenshot.png'),
      quality: page.quality,
      error: page.error,
    })),
  }
}

function registerGlobalFailure(runtime, page, classification) {
  if (classification.scope === 'global' && !classification.transient) {
    return createPause('global-fatal-error', page, classification, 1)
  }
  if (!classification.globalCandidate) return null
  const count = Number(runtime.globalErrorCounts.get(classification.category) || 0) + 1
  runtime.globalErrorCounts.set(classification.category, count)
  if (count < runtime.scheduler.globalErrorThreshold) return null
  return createPause('global-transient-error-threshold', page, classification, count)
}

function createPause(reason, page, classification, count) {
  return {
    reason,
    category: classification.category,
    message: classification.message,
    triggerPageId: page.id,
    matchingErrorCount: count,
    pausedAt: new Date().toISOString(),
  }
}

function finalizePausedBatch(batch, pause) {
  for (const page of batch.pages) {
    if (page.status === 'pending') page.status = 'paused'
  }
  batch.status = 'paused'
  batch.pause = {
    ...pause,
    resumeHint: `npm run --silent cli -- resume-pages ${batch.batchId} --json`,
  }
  batch.updatedAt = new Date().toISOString()
  writeBatchRecord(batch.batchDir, batch)
  return batch
}

export function classifyGenerationError(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  const normalized = message.toLowerCase()
  if (/unauthorized|forbidden|invalid[_ -]?api[_ -]?key|api key.*invalid|authentication|credential|codex.*login|not logged in|billing|insufficient[_ -]?quota|quota exceeded|model .*not found|unknown model/.test(normalized)) {
    return { scope: 'global', transient: false, globalCandidate: true, category: 'authentication-or-configuration', message }
  }
  if (/429|rate limit|too many requests|overloaded/.test(normalized)) {
    return { scope: 'global', transient: true, globalCandidate: true, category: 'rate-limit', message }
  }
  if (/timeout|timed out|econn|socket|network|connection|dns|502|503|504|unavailable|temporar|stream.*(closed|failed|timeout)/.test(normalized)) {
    return { scope: 'global', transient: true, globalCandidate: true, category: 'network-or-timeout', message }
  }
  return { scope: 'page', transient: false, globalCandidate: false, category: 'page-generation', message }
}

export function selectRepresentativePageIndexes(pages, requestedCount = 2) {
  const count = Math.max(0, Math.min(Number(requestedCount) || 0, pages.length))
  if (count === 0) return []
  const selected = []
  const add = (index) => {
    if (index >= 0 && index < pages.length && !selected.includes(index)) selected.push(index)
  }
  pages.forEach((page, index) => {
    if (page.representative === true || page.qualityGate === true) add(index)
  })
  add(0)
  const rankedByComplexity = pages
    .map((page, index) => ({ index, complexity: estimatePageComplexity(page.inputPath) }))
    .sort((a, b) => b.complexity - a.complexity || a.index - b.index)
  for (const item of rankedByComplexity) add(item.index)
  add(pages.length - 1)
  return selected.slice(0, count).sort((a, b) => a - b)
}

function estimatePageComplexity(inputPath) {
  try {
    const rawSize = statSync(join(inputPath, 'raw.json')).size
    const manifestSize = statSync(join(inputPath, 'asset-manifest.json')).size
    return rawSize + manifestSize * 2
  } catch {
    return 0
  }
}

const SCHEDULER_SCHEMA = {
  pageConcurrency: { env: 'PAGE_WORKER_CONCURRENCY', defaultValue: 2, normalize: positiveIntegerValue },
  modelConcurrency: { env: 'GLOBAL_MODEL_CONCURRENCY', defaultValue: MAX_GLOBAL_MODEL_CONCURRENCY, normalize: modelConcurrencyValue },
  pageRetryLimit: { env: 'PAGE_TRANSIENT_RETRY_LIMIT', defaultValue: 2, normalize: nonNegativeIntegerValue },
  pageRetryBaseDelayMs: { env: 'PAGE_RETRY_BASE_DELAY_MS', defaultValue: 5000, normalize: nonNegativeIntegerValue },
  globalErrorThreshold: { env: 'GLOBAL_ERROR_PAUSE_THRESHOLD', defaultValue: 2, normalize: positiveIntegerValue },
  continueOnError: { defaultValue: true, normalize: booleanValue },
  qualityGateEnabled: { defaultValue: true, normalize: booleanValue },
  qualityGateMode: { defaultValue: 'manual', normalize: qualityGateModeValue },
  qualityGatePageCount: { env: 'QUALITY_GATE_PAGE_COUNT', defaultValue: 2, normalize: positiveIntegerValue },
}

export function resolvePageBatchScheduler(options = {}, context = {}) {
  const environment = context.environment || process.env
  const inheritedScheduler = context.inheritedScheduler || null
  const inheritedSources = context.inheritedSources || null
  const scheduler = {}
  const sources = {}
  const warnings = []

  for (const [key, schema] of Object.entries(SCHEDULER_SCHEMA)) {
    let rawValue
    let source
    if (options[key] !== undefined) {
      rawValue = options[key]
      source = options.schedulerOptionSources?.[key] || { kind: 'option', detail: 'programmatic option' }
    } else if (inheritedScheduler?.[key] !== undefined) {
      rawValue = inheritedScheduler[key]
      source = {
        kind: 'batch',
        detail: 'batch.json',
        inheritedSource: unwrapInheritedSchedulerSource(inheritedSources?.[key]),
      }
    } else if (schema.env && environment[schema.env] !== undefined && environment[schema.env] !== '') {
      rawValue = environment[schema.env]
      source = { kind: 'environment', detail: schema.env }
    } else {
      rawValue = schema.defaultValue
      source = { kind: 'default', detail: `built-in default (${schema.defaultValue})` }
    }

    const normalized = schema.normalize(rawValue)
    if (normalized === undefined) {
      scheduler[key] = schema.defaultValue
      sources[key] = { kind: 'default', detail: `built-in default (${schema.defaultValue})` }
      warnings.push({
        code: 'invalid-scheduler-value',
        field: key,
        message: `调度配置 ${key}=${JSON.stringify(rawValue)} 无效，已回退为 ${schema.defaultValue}。`,
        rejectedSource: source,
      })
    } else {
      scheduler[key] = normalized
      sources[key] = source
    }
  }

  return { scheduler, sources, warnings }
}

function unwrapInheritedSchedulerSource(source) {
  let current = source
  while (current?.kind === 'batch' && current.inheritedSource) current = current.inheritedSource
  return current
}

function createSchedulerDiagnostics({ scheduler, sources, warnings = [], pageCount, entryPoint, mode }) {
  const diagnosticWarnings = [...warnings]
  if (pageCount > 1 && scheduler.pageConcurrency === 1 && scheduler.modelConcurrency === 1) {
    diagnosticWarnings.push({
      code: 'serial-multi-page-scheduler',
      field: 'concurrency',
      message: `检测到 ${pageCount} 个页面，但 pageConcurrency=1 且 modelConcurrency=1；本次批次会完全串行执行。建议显式使用 --page-concurrency 2 --model-concurrency 5。`,
    })
  }
  return {
    resolvedAt: new Date().toISOString(),
    mode,
    entryPoint: entryPoint || 'programmatic-api',
    pageCount,
    effectiveConcurrency: {
      pageConcurrency: scheduler.pageConcurrency,
      modelConcurrency: scheduler.modelConcurrency,
    },
    sources,
    warnings: diagnosticWarnings,
  }
}

function createInvocationRecord(options) {
  const schedulerArguments = {}
  for (const key of Object.keys(SCHEDULER_SCHEMA)) {
    if (options[key] !== undefined) schedulerArguments[key] = options[key]
  }
  return {
    invokedAt: new Date().toISOString(),
    entryPoint: options.entryPoint || 'programmatic-api',
    pid: process.pid,
    cwd: process.cwd(),
    schedulerArguments,
  }
}

function positiveIntegerValue(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function modelConcurrencyValue(value) {
  const parsed = positiveIntegerValue(value)
  return parsed && parsed <= MAX_GLOBAL_MODEL_CONCURRENCY ? parsed : undefined
}

function nonNegativeIntegerValue(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function booleanValue(value) {
  return typeof value === 'boolean' ? value : undefined
}

function qualityGateModeValue(value) {
  return value === 'auto' || value === 'manual' ? value : undefined
}

function retryDelayMs(baseDelayMs, attempt) {
  const base = Math.min(60000, Number(baseDelayMs || 0) * (2 ** Math.max(0, attempt - 1)))
  return base + Math.floor(Math.random() * Math.min(1000, Math.max(1, base * 0.2)))
}

function pickPageBase(page) {
  return {
    id: page.id,
    name: page.name,
    route: page.route,
    sourceNodeId: page.sourceNodeId,
    inputPath: page.inputPath,
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export function buildMergePrepareCommand(result, options = {}) {
  const script = options.script || 'skills/html2react/scripts/prepare_inputs.py'
  const workspace = options.workspace || join(result.batchDir, 'react-merge')
  const pageArgs = result.pages
    .filter((page) => page.status === 'done' && page.outputDir && page.inputPath)
    .flatMap((page) => [
      `--page ${shellQuote(`${page.route}=${page.outputDir}`)}`,
      `--frame-screenshot ${shellQuote(`${page.route}=${page.frameScreenshotPath || join(page.inputPath, 'frame-screenshot.png')}`)}`,
    ])
  if (pageArgs.length === 0) return null
  return `python3 ${shellQuote(script)} --workspace ${shellQuote(workspace)} --require-frame-screenshot ${pageArgs.join(' ')}`
}

function validatePageBundleManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('mastergo-pages.json 必须是 JSON 对象。')
  if (manifest.version !== PAGE_BUNDLE_VERSION) {
    throw new Error(`不支持的页面包版本：${manifest.version || 'missing'}。`)
  }
  if (!Array.isArray(manifest.pages) || manifest.pages.length === 0) {
    throw new Error('mastergo-pages.json 至少需要包含一个页面。')
  }

  const ids = new Set()
  const routes = new Set()
  for (const [index, page] of manifest.pages.entries()) {
    if (!page || typeof page !== 'object') throw new Error(`pages[${index}] 必须是对象。`)
    for (const key of ['id', 'name', 'route', 'inputDir']) {
      if (typeof page[key] !== 'string' || !page[key].trim()) throw new Error(`pages[${index}].${key} 不能为空。`)
    }
    if (!page.route.startsWith('/')) throw new Error(`页面路由必须以 / 开头：${page.route}`)
    if (ids.has(page.id)) throw new Error(`页面 id 重复：${page.id}`)
    if (routes.has(page.route)) throw new Error(`页面 route 重复：${page.route}`)
    ids.add(page.id)
    routes.add(page.route)
  }
}

function validatePageInput(inputDir, pageName) {
  if (!existsSync(inputDir) || !statSync(inputDir).isDirectory()) {
    throw new Error(`页面 ${pageName} 的 00-input 目录不存在：${inputDir}`)
  }
  for (const file of ['raw.json', 'asset-manifest.json', 'frame-screenshot.png']) {
    if (!existsSync(join(inputDir, file))) throw new Error(`页面 ${pageName} 缺少 ${file}。`)
  }
}

function findBundleRoot(root) {
  if (existsSync(join(root, 'mastergo-pages.json'))) return root
  const matches = []
  walk(root, 3, (path) => {
    if (basename(path) === 'mastergo-pages.json') matches.push(dirname(path))
  })
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) throw new Error('页面包中缺少 mastergo-pages.json。')
  throw new Error('页面包中存在多个 mastergo-pages.json，无法确定入口。')
}

function walk(root, depth, visit) {
  if (depth < 0 || !existsSync(root) || !statSync(root).isDirectory()) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isFile()) visit(path)
    else if (entry.isDirectory()) walk(path, depth - 1, visit)
  }
}

function assertSafeBundlePath(path) {
  const safe = normalize(path)
  if (isAbsolute(safe) || safe.startsWith('..')) throw new Error(`非法页面 inputDir：${path}`)
  return safe
}

function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function writeBatchRecord(batchDir, payload) {
  mkdirSync(batchDir, { recursive: true })
  writeFileSync(join(batchDir, 'batch.json'), JSON.stringify(payload, null, 2))
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}
