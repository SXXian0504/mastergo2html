import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { getLlmConfig, validateLlmConfig } from './config.js'
import { canonicalPhaseName, PROCESS_PHASES, findFailedPhase, phaseStartPercent, resetPhaseDetailsForRetry } from './workflow/job-retry.js'
import { packageOutputDirectory } from './output-zip.js'
import { phaseArtifacts, runLegacyJobWorkflow } from '../../core/src/job-service.js'

const PORT = Number(process.env.MCP_PORT || 12322)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = join(ROOT, 'data')
const JOB_DIR = join(DATA_DIR, 'jobs')
const JOB_INDEX_FILE = join(DATA_DIR, 'jobs-index.json')
const MASTERGO_EXPORT_DIR = join(DATA_DIR, 'mastergo-exports')
const MASTERGO_EXPORT_INDEX_FILE = join(DATA_DIR, 'mastergo-exports-index.json')
const LISTENER_SCRIPT_PATH = resolve(ROOT, '..', process.platform === 'win32' ? 'start-mcp-dev.bat' : 'start-mcp-dev.command')

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(JOB_DIR, { recursive: true })
mkdirSync(MASTERGO_EXPORT_DIR, { recursive: true })

const jobs = loadJobs()
const mastergoExports = loadMasterGoExports()
const activeJobIds = new Set()

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)

  setCors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const llmConfig = getLlmConfig()
    const configErrors = validateLlmConfig(llmConfig)
    sendJson(res, 200, {
      ok: true,
      service: 'mastergo2html-mcp-server',
      features: ['mastergo-page-bundle-v1', 'mastergo-auto-frame-bundle-v1', 'llm-backend-openai-compatible', 'llm-backend-codex-sdk'],
      jobs: jobs.size,
      llmConfigured: configErrors.length === 0,
      configErrors,
      llm: {
        provider: llmConfig.provider,
        baseUrl: llmConfig.baseUrl || null,
        model: llmConfig.model || null,
        wireApi: llmConfig.wireApi,
        auth: llmConfig.provider === 'codex-sdk' ? 'codex-cli-login' : 'api-key',
      },
    })
    return
  }

  if (req.method === 'GET' && url.pathname === '/panel') {
    sendHtml(res, 200, getPanelHtml())
    return
  }

  if (req.method === 'POST' && url.pathname === '/tools/reveal-listener-script') {
    if (!existsSync(LISTENER_SCRIPT_PATH)) {
      sendJson(res, 404, {
        error: 'listener_script_not_found',
        message: `未找到启动脚本：${LISTENER_SCRIPT_PATH}`,
      })
      return
    }
    try {
      revealFile(LISTENER_SCRIPT_PATH)
      sendJson(res, 200, { ok: true, path: LISTENER_SCRIPT_PATH })
    } catch (error) {
      sendJson(res, 500, { error: 'reveal_listener_script_failed', message: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'GET' && url.pathname === '/jobs') {
    sendJson(res, 200, { jobs: [...jobs.values()].sort(byUpdatedAtDesc) })
    return
  }

  if (req.method === 'POST' && url.pathname === '/mastergo-exports') {
    const body = await readJson(req)
    const requestId = randomUUID()
    const now = new Date().toISOString()
    const mode = body.mode === 'page-bundle' || body.mode === 'auto' ? body.mode : 'single-page'
    const request = {
      requestId,
      mode,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      options: body.options || {
        includeOriginalImages: false,
        includeRenderedSlices: true,
        rawProfile: 'html',
      },
      pageName: typeof body.pageName === 'string' ? body.pageName : undefined,
      frameName: typeof body.frameName === 'string' ? body.frameName : undefined,
      nodeId: typeof body.nodeId === 'string' ? body.nodeId : undefined,
      inputPath: mode === 'page-bundle'
        ? getMasterGoExportPageBundleDir(requestId)
        : mode === 'single-page'
          ? getMasterGoExportInputDir(requestId)
          : getMasterGoExportDir(requestId),
    }
    mastergoExports.set(requestId, request)
    persistMasterGoExports()
    persistMasterGoExport(requestId, request)
    sendJson(res, 202, request)
    return
  }

  if (req.method === 'GET' && url.pathname === '/mastergo-exports/next') {
    const request = [...mastergoExports.values()]
      .filter((item) => item.status === 'pending')
      .sort(byCreatedAtAsc)[0]
    if (!request) {
      sendJson(res, 200, { request: null })
      return
    }
    updateMasterGoExport(request.requestId, { status: 'claimed' })
    sendJson(res, 200, { request: mastergoExports.get(request.requestId) })
    return
  }

  if (req.method === 'POST' && /^\/mastergo-exports\/[^/]+\/complete$/.test(url.pathname)) {
    const requestId = url.pathname.split('/').filter(Boolean)[1]
    const request = mastergoExports.get(requestId)
    if (!request) {
      sendJson(res, 404, { error: 'mastergo_export_not_found', requestId })
      return
    }
    const body = await readJson(req)
    const pageBundleResponse = request.mode === 'page-bundle'
      || (request.mode === 'auto' && body?.kind === 'page-bundle')
    if (pageBundleResponse) {
      const validationError = validatePageBundleInput(body)
      if (validationError) {
        sendJson(res, 400, { error: 'invalid_mastergo_page_bundle', message: validationError })
        return
      }
      const bundle = writeMasterGoExportPageBundle(requestId, body)
      updateMasterGoExport(requestId, {
        status: 'done',
        inputKind: 'page-bundle',
        source: bundle.source,
        pageCount: bundle.pageCount,
        inputPath: getMasterGoExportPageBundleDir(requestId),
      })
    } else {
      const validationError = validateJobInput(body)
      if (validationError) {
        sendJson(res, 400, { error: 'invalid_mastergo_export_input', message: validationError })
        return
      }
      writeMasterGoExportInput(requestId, body)
      updateMasterGoExport(requestId, {
        status: 'done',
        inputKind: 'single-page',
        source: body.source,
        inputPath: getMasterGoExportInputDir(requestId),
      })
    }
    sendJson(res, 200, mastergoExports.get(requestId))
    return
  }

  if (req.method === 'POST' && /^\/mastergo-exports\/[^/]+\/fail$/.test(url.pathname)) {
    const requestId = url.pathname.split('/').filter(Boolean)[1]
    const request = mastergoExports.get(requestId)
    if (!request) {
      sendJson(res, 404, { error: 'mastergo_export_not_found', requestId })
      return
    }
    const body = await readJson(req)
    updateMasterGoExport(requestId, {
      status: 'error',
      error: typeof body.message === 'string' ? body.message : 'MasterGo 插件导出失败。',
    })
    sendJson(res, 200, mastergoExports.get(requestId))
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/mastergo-exports/')) {
    const requestId = url.pathname.split('/').filter(Boolean)[1]
    const request = mastergoExports.get(requestId)
    if (!request) {
      sendJson(res, 404, { error: 'mastergo_export_not_found', requestId })
      return
    }
    sendJson(res, 200, request)
    return
  }

  if (req.method === 'POST' && url.pathname === '/jobs') {
    const body = await readJson(req)
    const validationError = validateJobInput(body)
    if (validationError) {
      sendJson(res, 400, { error: 'invalid_job_input', message: validationError })
      return
    }
    const jobId = randomUUID()
    const now = new Date().toISOString()
    const inputPath = getJobInputDir(jobId)
    const job = {
      jobId,
      status: 'queued',
      progress: {
        phase: 'collect-input',
        percent: 0,
        message: '任务已创建，等待处理',
      },
      source: body.source || {
        pageId: 'unknown',
        pageName: 'unknown',
        selectionIds: [],
        selectionCount: 0,
      },
      createdAt: now,
      updatedAt: now,
      inputPath,
    }
    jobs.set(jobId, job)
    persistJobs()
    persistJob(jobId, { ...job, input: body })
    writeJobInput(jobId, body)
    startJobProcessing(jobId, body, 'normalize-raw')
    sendJson(res, 200, {
      jobId,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      inputPath,
    })
    return
  }

  if (req.method === 'POST' && /^\/jobs\/[^/]+\/retry$/.test(url.pathname)) {
    const jobId = url.pathname.split('/').filter(Boolean)[1]
    const job = jobs.get(jobId)
    if (!job) {
      sendJson(res, 404, { error: 'job_not_found', jobId })
      return
    }
    if (activeJobIds.has(jobId) || job.status === 'running' || job.status === 'queued') {
      sendJson(res, 409, { error: 'job_already_running', message: '任务正在运行，请勿重复重试。', jobId })
      return
    }
    if (job.status !== 'error') {
      sendJson(res, 409, { error: 'job_not_failed', message: '只有失败任务可以从失败阶段重试。', jobId })
      return
    }

    const body = await readJson(req)
    const failedPhase = findFailedPhase(job)
    const retryPhase = canonicalPhaseName(body.phase || failedPhase)
    if (!failedPhase || retryPhase !== canonicalPhaseName(failedPhase) || !PROCESS_PHASES.includes(retryPhase)) {
      sendJson(res, 400, {
        error: 'invalid_retry_phase',
        message: '只能从当前失败阶段重试。',
        failedPhase,
      })
      return
    }

    let input
    try {
      input = readStoredJobInput(jobId)
    } catch (error) {
      sendJson(res, 409, {
        error: 'job_input_unavailable',
        message: error instanceof Error ? error.message : String(error),
        jobId,
      })
      return
    }

    updateJob(jobId, {
      status: 'queued',
      error: undefined,
      progress: {
        phase: retryPhase,
        percent: phaseStartPercent(retryPhase),
        message: `等待从失败阶段重试：${retryPhase}`,
      },
      retryCount: Number(job.retryCount || 0) + 1,
      lastRetryAt: new Date().toISOString(),
    })
    startJobProcessing(jobId, input, retryPhase)
    sendJson(res, 202, jobs.get(jobId))
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/jobs/') && url.pathname.endsWith('/download')) {
    const jobId = url.pathname.split('/').filter(Boolean)[1]
    const job = jobs.get(jobId)
    const zipPath = job?.resultSummary?.zipPath
    if (!zipPath || !existsSync(zipPath)) {
      sendJson(res, 404, { error: 'download_not_ready', jobId })
      return
    }
    streamFile(res, zipPath, 'application/zip', 'output.zip')
    return
  }

  if (req.method === 'POST' && url.pathname.startsWith('/jobs/') && url.pathname.endsWith('/open-output')) {
    const jobId = url.pathname.split('/').filter(Boolean)[1]
    const job = jobs.get(jobId)
    if (!job?.outputDir || !existsSync(job.outputDir)) {
      sendJson(res, 404, { error: 'output_not_ready', jobId })
      return
    }
    try {
      openDirectory(job.outputDir)
      sendJson(res, 200, { ok: true, outputDir: job.outputDir })
    } catch (error) {
      sendJson(res, 500, { error: 'open_output_failed', message: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'POST' && url.pathname.startsWith('/jobs/') && url.pathname.endsWith('/reveal-zip')) {
    const jobId = url.pathname.split('/').filter(Boolean)[1]
    const zipPath = jobs.get(jobId)?.resultSummary?.zipPath
    if (!zipPath || !existsSync(zipPath)) {
      sendJson(res, 404, { error: 'zip_not_ready', jobId })
      return
    }
    try {
      revealFile(zipPath)
      sendJson(res, 200, { ok: true, zipPath })
    } catch (error) {
      sendJson(res, 500, { error: 'reveal_zip_failed', message: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'GET' && url.pathname.startsWith('/jobs/')) {
    const jobId = url.pathname.split('/').filter(Boolean)[1]
    const job = jobs.get(jobId)
    if (!job) {
      sendJson(res, 404, { error: 'job_not_found', jobId })
      return
    }
    if (url.pathname.endsWith('/logs')) {
      const payload = readJobFile(jobId)
      sendJson(res, 200, { jobId, logs: payload?.logs || [] })
      return
    }

    sendJson(res, 200, job)
    return
  }

  if (req.method === 'GET' && url.pathname === '/jobs-index') {
    sendJson(res, 200, { jobs: [...jobs.values()] })
    return
  }

  sendJson(res, 404, { error: 'not_found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mastergo2html bridge listening on http://127.0.0.1:${PORT}`)
  console.log(`panel: http://127.0.0.1:${PORT}/panel`)
})

function startJobProcessing(jobId, input, startPhase) {
  if (activeJobIds.has(jobId)) return
  activeJobIds.add(jobId)
  const runner = startPhase === 'normalize-raw'
    ? processJob(jobId, input)
    : processJobFromPhase(jobId, input, startPhase)
  runner.catch((error) => handleJobFailure(jobId, error)).finally(() => activeJobIds.delete(jobId))
}

function handleJobFailure(jobId, error) {
  const current = jobs.get(jobId)
  const phaseDetails = (current?.phaseDetails || []).map((phase) => {
    if (phase.status !== 'running') return phase
    const endedAt = new Date().toISOString()
    return {
      ...phase,
      status: 'error',
      endedAt,
      durationMs: phase.startedAt
        ? new Date(endedAt).getTime() - new Date(phase.startedAt).getTime()
        : phase.durationMs,
      message: error instanceof Error ? error.message : String(error),
    }
  })
  const failedPhase = canonicalPhaseName([...phaseDetails].reverse().find((phase) => phase.status === 'error')?.phase
    || current?.progress?.phase
    || 'plan-and-generate')
  updateJob(jobId, {
    status: 'error',
    progress: {
      phase: failedPhase,
      percent: current?.progress?.percent || 100,
      message: '任务失败',
    },
    phaseDetails,
    error: error instanceof Error ? error.message : String(error),
  })
}

async function processJobFromPhase(jobId, input, startPhase) {
  return processLegacyJob(jobId, startPhase)
}

function completeRetryPhase(phaseDetails, phase, message, result = {}) {
  const current = findPhaseDetail(phaseDetails, phase)
  const endedAt = new Date().toISOString()
  upsertPhaseDetail(phaseDetails, phase, {
    status: 'done',
    endedAt,
    durationMs: result.durationMs ?? (current?.startedAt ? Date.now() - new Date(current.startedAt).getTime() : 0),
    message,
    tokenUsage: result.tokenUsage || emptyTokenUsage(),
    artifacts: result.artifacts || [result.outputPath, result.promptPath, result.responsePath].filter(Boolean),
    warnings: result.validationWarnings || [],
  })
}

function phaseResultKey(phase) {
  return ({
    'layout-analysis': 'aiLayoutAnalysisResult',
    'component-structure-analysis': 'componentStructureResult',
    'static-asset-analysis': 'staticAssetResult',
    'interaction-analysis': 'interactionResult',
    'plan-and-generate': 'htmlGenerationResult',
  })[phase]
}

function finishGeneratedJob(jobId, phaseDetails, result) {
  const current = jobs.get(jobId)
  const htmlPath = join(result.outputPath, 'index.html')
  const zipPath = join(getJobDir(jobId), 'final', 'output.zip')
  const packageResult = packageOutputDirectory(result.outputPath, zipPath)
  const finalMessage = htmlGenerationCompleteMessage(result)
  const nextRecord = {
    ...current,
    status: 'done',
    updatedAt: new Date().toISOString(),
    outputPath: result.outputPath,
    outputDir: result.outputPath,
    downloadUrl: `/jobs/${jobId}/download`,
    htmlGenerationResult: result,
    resultSummary: {
      htmlPath,
      zipPath,
      zipSizeBytes: packageResult.sizeBytes,
      packagedFileCount: packageResult.fileCount,
      note: htmlGenerationResultNote(result),
    },
    phaseDetails,
    progress: { phase: 'plan-and-generate', percent: 100, message: finalMessage },
    error: undefined,
  }
  jobs.set(jobId, nextRecord)
  persistJobs()
  persistJob(jobId, { ...nextRecord, logs: collectLogs(jobId) })
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

function openDirectory(directory) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  const child = spawn(command, [directory], { detached: true, stdio: 'ignore' })
  child.unref()
}

function revealFile(filePath) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  const args = process.platform === 'darwin'
    ? ['-R', filePath]
    : process.platform === 'win32'
      ? [`/select,${filePath}`]
      : [dirname(filePath)]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

async function processJob(jobId, input) {
  return processLegacyJob(jobId, 'normalize-raw')
}

async function processLegacyJob(jobId, startPhase) {
  const phaseDetails = startPhase === 'normalize-raw'
    ? []
    : resetPhaseDetailsForRetry(jobs.get(jobId)?.phaseDetails, startPhase)
  const { htmlGenerationResult } = await runLegacyJobWorkflow({
    jobId,
    jobDir: getJobDir(jobId),
    startPhase,
    onPhaseStart: ({ phase, startMessage, startPercent }) => {
      upsertPhaseDetail(phaseDetails, phase, {
        status: 'running',
        startedAt: new Date().toISOString(),
        message: startMessage,
        tokenUsage: emptyTokenUsage(),
        artifacts: [],
      })
      updateJob(jobId, {
        status: 'running',
        error: undefined,
        progress: { phase, percent: startPercent, message: startMessage },
        phaseDetails,
      })
    },
    onPhaseProgress: ({ phase, metrics, message, percent }) => {
      reportStreamProgress(jobId, phaseDetails, phase, percent, metrics, message)
    },
    onPhaseComplete: ({ phase, message, percent, result }) => {
      completeRetryPhase(phaseDetails, phase, message, {
        ...result,
        artifacts: phaseArtifacts(result),
      })
      const patch = {
        progress: { phase, percent, message },
        phaseDetails,
      }
      const resultKey = phaseResultKey(phase)
      if (resultKey) patch[resultKey] = result
      if (phase === 'normalize-raw') {
        patch.rawLayoutConversionSummary = result.summary
        patch.fontAvailability = readFontAvailabilitySummary(jobId)
        patch.normalizedPath = result.normalizedDir
        patch.layoutPath = result.layoutDir
      }
      updateJob(jobId, patch)
    },
    onPhaseError: ({ phase, error }) => {
      const current = findPhaseDetail(phaseDetails, phase)
      const endedAt = new Date().toISOString()
      const message = error instanceof Error ? error.message : String(error)
      upsertPhaseDetail(phaseDetails, phase, {
        status: 'error',
        endedAt,
        durationMs: current?.startedAt
          ? new Date(endedAt).getTime() - new Date(current.startedAt).getTime()
          : current?.durationMs || 0,
        message,
      })
      updateJob(jobId, {
        status: 'running',
        progress: { phase, percent: 100, message },
        phaseDetails,
      })
    },
  })
  finishGeneratedJob(jobId, phaseDetails, htmlGenerationResult)
}

function loadJobs() {
  if (!existsSync(JOB_INDEX_FILE)) return new Map()
  try {
    const payload = JSON.parse(readFileSync(JOB_INDEX_FILE, 'utf8'))
    return new Map((payload.jobs || []).map((job) => [job.jobId, job]))
  } catch {
    return new Map()
  }
}

function loadMasterGoExports() {
  if (!existsSync(MASTERGO_EXPORT_INDEX_FILE)) return new Map()
  try {
    const payload = JSON.parse(readFileSync(MASTERGO_EXPORT_INDEX_FILE, 'utf8'))
    return new Map((payload.requests || []).map((request) => [request.requestId, request]))
  } catch {
    return new Map()
  }
}

function persistJobs() {
  writeFileSync(JOB_INDEX_FILE, JSON.stringify({ jobs: [...jobs.values()] }, null, 2))
}

function persistMasterGoExports() {
  writeFileSync(MASTERGO_EXPORT_INDEX_FILE, JSON.stringify({ requests: [...mastergoExports.values()] }, null, 2))
}

function persistJob(jobId, payload) {
  const jobDir = getJobDir(jobId)
  mkdirSync(jobDir, { recursive: true })
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify(payload, null, 2))
}

function persistMasterGoExport(requestId, payload) {
  const dir = getMasterGoExportDir(requestId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'request.json'), JSON.stringify(payload, null, 2))
}

function writeJobInput(jobId, payload) {
  const inputDir = getJobInputDir(jobId)
  mkdirSync(inputDir, { recursive: true })
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify(payload.raw, null, 2))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify(payload.assetManifest, null, 2))
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({
    exportOptions: payload.exportOptions,
    source: payload.source,
    createdAt: new Date().toISOString(),
  }, null, 2))

  for (const attachment of payload.attachments || []) {
    writeInputAttachment(inputDir, attachment)
  }
}

function writeMasterGoExportInput(requestId, payload) {
  const inputDir = getMasterGoExportInputDir(requestId)
  mkdirSync(inputDir, { recursive: true })
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify(payload.raw, null, 2))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify(payload.assetManifest, null, 2))
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({
    exportOptions: payload.exportOptions,
    source: payload.source,
    createdAt: new Date().toISOString(),
  }, null, 2))

  for (const attachment of payload.attachments || []) {
    writeInputAttachment(inputDir, attachment)
  }
}

function writeMasterGoExportPageBundle(requestId, payload) {
  const bundleDir = getMasterGoExportPageBundleDir(requestId)
  rmSync(bundleDir, { recursive: true, force: true })
  mkdirSync(bundleDir, { recursive: true })
  for (const file of payload.files) writeInputAttachment(bundleDir, file)
  const manifest = JSON.parse(readFileSync(join(bundleDir, 'mastergo-pages.json'), 'utf8'))
  return {
    source: manifest.source || { pageId: 'unknown', pageName: 'unknown' },
    pageCount: Array.isArray(manifest.pages) ? manifest.pages.length : 0,
  }
}

function readJobFile(jobId) {
  const file = join(getJobDir(jobId), 'job.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8'))
}

function readStoredJobInput(jobId) {
  const inputDir = getJobInputDir(jobId)
  const exportPayload = JSON.parse(readFileSync(join(inputDir, 'export-options.json'), 'utf8'))
  return {
    raw: JSON.parse(readFileSync(join(inputDir, 'raw.json'), 'utf8')),
    assetManifest: JSON.parse(readFileSync(join(inputDir, 'asset-manifest.json'), 'utf8')),
    exportOptions: exportPayload.exportOptions,
    source: exportPayload.source,
  }
}

function readFontAvailabilitySummary(jobId) {
  const reportPath = join(getJobDir(jobId), '01-normalized', 'font-availability.json')
  if (!existsSync(reportPath)) return undefined
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'))
    const missingFonts = Array.isArray(report.missingFonts) ? report.missingFonts : []
    return {
      reportPath,
      missingFonts: missingFonts
        .map((font) => ({ family: typeof font?.family === 'string' ? font.family : '' }))
        .filter((font) => font.family),
    }
  } catch {
    return undefined
  }
}

function getJobDir(jobId) {
  return join(JOB_DIR, jobId)
}

function getJobInputDir(jobId) {
  return join(getJobDir(jobId), '00-input')
}

function getMasterGoExportDir(requestId) {
  return join(MASTERGO_EXPORT_DIR, requestId)
}

function getMasterGoExportInputDir(requestId) {
  return join(getMasterGoExportDir(requestId), '00-input')
}

function getMasterGoExportPageBundleDir(requestId) {
  return join(getMasterGoExportDir(requestId), 'page-bundle')
}

function validatePageBundleInput(payload) {
  if (!payload || typeof payload !== 'object') return '页面包输入不能为空。'
  if (payload.kind !== 'page-bundle') return '页面包输入 kind 必须是 page-bundle。'
  if (!Array.isArray(payload.files) || payload.files.length === 0) return '页面包输入缺少 files。'
  const manifest = payload.files.find((file) => file?.path === 'mastergo-pages.json')
  if (!manifest || manifest.encoding !== 'utf8') return '页面包输入缺少 UTF-8 mastergo-pages.json。'
  try {
    const parsed = JSON.parse(String(manifest.content || ''))
    if (parsed.version !== 'mastergo2html.page-bundle.v1') return 'mastergo-pages.json 版本无效。'
    if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) return 'mastergo-pages.json 没有页面。'
  } catch {
    return 'mastergo-pages.json 不是有效 JSON。'
  }
  return ''
}

function validateJobInput(payload) {
  if (!payload || typeof payload !== 'object') return '任务输入不能为空。'
  if (!payload.raw) return '任务输入缺少 raw。'
  if (!payload.assetManifest) return '任务输入缺少 assetManifest。'
  if (!payload.exportOptions) return '任务输入缺少 exportOptions。'
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : []
  const hasFrameScreenshot = attachments.some((file) => file?.path === 'frame-screenshot.png')
  if (!hasFrameScreenshot) return '任务输入缺少必需的 frame-screenshot.png。'
  return ''
}

function writeInputAttachment(inputDir, attachment) {
  if (!attachment || typeof attachment.path !== 'string') return
  const safePath = normalize(attachment.path)
  if (isAbsolute(safePath) || safePath.startsWith('..')) {
    throw new Error(`拒绝写入非法附件路径：${attachment.path}`)
  }
  if (attachment.encoding !== 'utf8' && attachment.encoding !== 'base64') {
    throw new Error(`不支持的附件编码：${attachment.encoding}`)
  }

  const targetPath = join(inputDir, safePath)
  mkdirSync(dirname(targetPath), { recursive: true })
  if (attachment.encoding === 'base64') {
    writeFileSync(targetPath, Buffer.from(String(attachment.content || ''), 'base64'))
  } else {
    writeFileSync(targetPath, String(attachment.content || ''), 'utf8')
  }
}

function updateJob(jobId, patch) {
  const current = jobs.get(jobId)
  if (!current) return
  const next = {
    ...current,
    ...patch,
    progress: patch.progress || current.progress,
    updatedAt: new Date().toISOString(),
  }
  jobs.set(jobId, next)
  persistJobs()
  persistJob(jobId, { ...next, logs: collectLogs(jobId) })
}

function updateMasterGoExport(requestId, patch) {
  const current = mastergoExports.get(requestId)
  if (!current) return
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  mastergoExports.set(requestId, next)
  persistMasterGoExports()
  persistMasterGoExport(requestId, next)
}

function findPhaseDetail(phaseDetails, phase) {
  return phaseDetails.find((item) => item.phase === phase)
}

function upsertPhaseDetail(phaseDetails, phase, patch) {
  const current = findPhaseDetail(phaseDetails, phase)
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

function reportStreamProgress(jobId, phaseDetails, phaseName, percent, streamMetrics, message) {
  const phase = findPhaseDetail(phaseDetails, phaseName)
  const durationMs = phase?.startedAt ? Date.now() - new Date(phase.startedAt).getTime() : 0
  upsertPhaseDetail(phaseDetails, phaseName, {
    status: 'running',
    message,
    durationMs,
    streamMetrics,
  })
  updateJob(jobId, {
    status: 'running',
    progress: { phase: phaseName, percent, message },
    phaseDetails,
  })
}

function collectLogs(jobId) {
  const job = jobs.get(jobId)
  if (!job) return []
  return [
    `${job.createdAt} job created`,
    `${job.updatedAt} ${job.progress.phase} ${job.progress.message}`,
  ]
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

function getPanelHtml() {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>MasterGo2HTML Jobs</title>
      <style>
        body { font-family: Inter, system-ui, sans-serif; margin: 0; background: #f6f7f9; color: #18212f; }
        header { padding: 16px 20px; border-bottom: 1px solid #dce1e8; background: #fff; }
        main { padding: 16px 20px; display: grid; gap: 12px; }
        .job { border: 1px solid #dce1e8; border-radius: 8px; background: #fff; padding: 12px 14px; }
        .row { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
        .meta { color: #6a7380; font-size: 12px; }
        .bar { height: 8px; background: #e7edf6; border-radius: 999px; overflow: hidden; margin: 8px 0; }
        .bar > span { display: block; height: 100%; background: #176bff; }
        code { display: block; white-space: pre-wrap; background: #f7f9fc; padding: 8px; border-radius: 6px; border: 1px solid #e4e8ee; margin-top: 8px; }
        details { border: 1px solid #e4e8ee; border-radius: 6px; margin-top: 8px; background: #fbfcff; }
        summary { cursor: pointer; padding: 8px 10px; font-weight: 700; }
        details[open] summary { border-bottom: 1px solid #e4e8ee; }
        .phase-body { padding: 8px 10px; display: grid; gap: 6px; }
        .phase-facts { display: flex; gap: 8px; flex-wrap: wrap; }
        .phase-facts span { background: #eef3fa; border-radius: 6px; padding: 3px 6px; }
      </style>
    </head>
    <body>
      <header>
        <h1>MasterGo2HTML Jobs</h1>
        <p class="meta">Local bridge status: ${PORT}</p>
      </header>
      <main id="jobs"></main>
      <script>
        async function loadJobs() {
          const response = await fetch('/jobs');
          const payload = await response.json();
          renderJobs(payload.jobs || []);
        }
        function renderJobs(jobs) {
          document.getElementById('jobs').innerHTML = jobs.length ? jobs.map(function(job) {
          const percent = job.progress && typeof job.progress.percent === 'number' ? job.progress.percent : 0;
          const phases = (job.phaseDetails || []).map(function(phase) {
            const usage = phase.tokenUsage || {};
            const stream = phase.streamMetrics;
            const open = phase.status === 'running' ? ' open' : '';
            return '<details' + open + '>' +
              '<summary>' + escapeHtml(phaseLabel(phase.phase)) + ' · ' + escapeHtml(phase.status || '') + '</summary>' +
              '<div class="phase-body">' +
                '<div class="meta">' + escapeHtml(phase.message || '') + '</div>' +
                '<div class="phase-facts meta">' +
                  '<span>耗时 ' + escapeHtml(formatDuration(phase.durationMs || 0)) + '</span>' +
                  '<span>输入 ' + escapeHtml(formatTokens(usage.inputTokens)) + '</span>' +
                  '<span>输出 ' + escapeHtml(formatTokens(usage.outputTokens)) + '</span>' +
                  '<span>总计 ' + escapeHtml(formatTokens(usage.totalTokens)) + (usage.estimated ? ' 估算' : '') + '</span>' +
                '</div>' +
                (stream ? '<div class="phase-facts meta">' +
                  '<span>' + escapeHtml(streamStateLabel(stream.state)) + '</span>' +
                  '<span>' + escapeHtml(stream.mode === 'stream' ? '流式' : '兼容模式') + '</span>' +
                  '<span>尝试 ' + escapeHtml(stream.attempt || 0) + '</span>' +
                  '<span>字符 ' + escapeHtml(formatTokens(stream.receivedChars)) + '</span>' +
                  '<span>事件 ' + escapeHtml(stream.eventCount || 0) + '</span>' +
                '</div>' : '') +
              '</div>' +
            '</details>';
          }).join('');
          return '<section class="job">' +
            '<div class="row"><strong>' + escapeHtml(job.jobId) + '</strong><span class="meta">' + escapeHtml(job.status) + '</span></div>' +
            '<div class="bar"><span style="width:' + percent + '%"></span></div>' +
            '<div class="row meta"><span>' + escapeHtml(job.progress?.phase || '') + '</span><span>' + percent + '%</span></div>' +
            '<div class="meta">' + escapeHtml(job.progress?.message || '') + '</div>' +
            phases +
            '<div class="meta">' + escapeHtml(job.inputPath || '') + '</div>' +
            '<div class="meta">' + escapeHtml(job.resultSummary?.zipPath || job.outputPath || '') + '</div>' +
          '</section>'
          }).join('') : '<section class="job meta">No jobs yet.</section>';
        }
        function phaseLabel(phase) {
          return ({
            'collect-input': '收集输入',
            'normalize-raw': '标准化',
            'layout-analysis': '布局分析',
            'component-structure-analysis': '组件结构分析',
            'static-asset-analysis': '静态资源分析',
            'interaction-analysis': '动态交互分析',
            'plan-and-generate': '页面裁决与 HTML 生成',
            'visual-qa': '视觉 QA',
            'package-files': '打包文件'
          })[phase] || phase || '';
        }
        function formatDuration(ms) {
          return ms < 1000 ? ms + ' ms' : (ms / 1000).toFixed(1) + ' s';
        }
        function formatTokens(value) {
          const count = Number(value || 0);
          return count >= 1000 ? (count / 1000).toFixed(1) + 'k' : String(count);
        }
        function streamStateLabel(state) {
          return ({ connecting: '等待响应', streaming: '正在生成', validating: '正在校验' })[state] || state || '';
        }
        function escapeHtml(value) {
          return String(value).replace(/[&<>"']/g, function(char) {
            return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
          });
        }
        loadJobs();
        setInterval(loadJobs, 1000);
      </script>
    </body>
  </html>`
}

function byUpdatedAtDesc(a, b) {
  return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
}

function byCreatedAtAsc(a, b) {
  return String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data, null, 2))
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(html)
}

function streamFile(res, filePath, contentType, downloadName) {
  const body = readFileSync(filePath)
  const headers = { 'Content-Type': contentType, 'Content-Length': body.length }
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="${downloadName}"`
  res.writeHead(200, headers)
  res.end(body)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}
