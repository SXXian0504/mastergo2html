import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DEFAULT_JOB_ROOT } from './constants.js'
import { prepareAgentPageBundleInput } from './agent-page-bundle.js'
import { prepareAgentJobV2, prepareResponsiveAgentJobV2, resetAgentAttemptV2 } from './agent-workflow-v2.js'
import { buildMergePrepareCommand } from './page-bundle.js'

export const AGENT_BATCH_V2_VERSION = 'mastergo2html.codex-agent-batch.v2'

const DEFAULT_AGENT_CONCURRENCY = 2
const LEGACY_AGENT_CONCURRENCY = 1
const DEFAULT_AGENT_RETRY_LIMIT = 1
const MAX_PREPARE_CONCURRENCY = 2
const TERMINAL_STATUSES = new Set(['done', 'first-pass-invalid', 'error'])
const ACTIVE_STATUSES = new Set(['agent-running', 'validating'])

export async function prepareAgentPageBundleV2(inputPath, options = {}) {
  const batchId = options.batchId || randomUUID()
  const batchRoot = resolve(options.batchRoot || '.mastergo2html/agent-batches')
  const batchDir = join(batchRoot, batchId)
  const jobRoot = resolve(options.jobRoot || DEFAULT_JOB_ROOT)
  mkdirSync(batchDir, { recursive: true })
  const prepared = prepareAgentPageBundleInput(inputPath, batchDir)
  const now = new Date().toISOString()
  const batch = {
    version: AGENT_BATCH_V2_VERSION,
    batchId,
    mode: 'codex-agent',
    agentVersion: 'v2',
    status: 'preparing',
    inputPath: prepared.inputPath,
    inputVersion: prepared.manifest.version,
    source: prepared.manifest.source,
    frameCount: prepared.manifest.frameCount || prepared.pages.length,
    batchDir,
    jobRoot,
    createdAt: now,
    updatedAt: now,
    contextPolicy: 'Each Agent worker receives exactly one logical page. Never combine complete Agent contexts across pages.',
    scheduler: {
      agentConcurrency: readBoundedInteger(options.agentConcurrency, DEFAULT_AGENT_CONCURRENCY, 1, 3, '--agent-concurrency'),
      agentRetryLimit: readBoundedInteger(options.agentRetryLimit ?? options.agentRetries, DEFAULT_AGENT_RETRY_LIMIT, 0, 2, '--agent-retries'),
      prepareConcurrency: MAX_PREPARE_CONCURRENCY,
      peakAgentConcurrency: 0,
    },
    pages: prepared.pages.map((page) => ({
      id: page.id,
      name: page.name,
      route: page.route,
      inputKind: page.inputKind,
      sourceNodeId: page.sourceNodeId,
      sourceNodeIds: page.sourceNodeIds,
      index: page.index,
      inputPath: page.inputPath,
      frameScreenshotPath: page.frameScreenshotPath,
      status: 'pending',
      retryCount: 0,
      attemptHistory: [],
    })),
  }
  writeBatch(batch)
  return withBatchLock(batchId, { ...options, batchRoot }, () => preparePendingPages(batch, options))
}

export async function resumeAgentPageBundleV2(batchId, options = {}) {
  return withBatchLock(batchId, options, async () => {
    const batch = readBatchV2(batchId, options)
    normalizeScheduler(batch, options, { legacy: !batch.scheduler })
    refreshAgentPageBatchV2(batch, { write: false })
    let interrupted = false
    for (const page of batch.pages) {
      if (page.jobId && page.status === 'preparing') {
        interrupted = true
        page.status = 'error'
        page.error = '上一次进程在 Agent v2 deterministic prepare 完成前中断；保留原 jobId，不自动重建。'
        const jobPath = join(batch.jobRoot, page.jobId, 'job.json')
        if (existsSync(jobPath)) {
          const job = readJson(jobPath)
          writeJsonAtomic(jobPath, { ...job, status: 'error', agentStage: 'preparing', error: page.error, updatedAt: new Date().toISOString() })
        }
      }
    }
    if (interrupted) refreshAgentPageBatchV2(batch, { write: false })
    if (!batch.pages.some((page) => ['pending', 'preparing'].includes(page.status))) return refreshAgentPageBatchV2(batch)
    batch.status = 'preparing'
    batch.updatedAt = new Date().toISOString()
    writeBatch(batch)
    return preparePendingPages(batch, options)
  })
}

export function getAgentPageBatchStatusV2(batchId, options = {}) {
  return withBatchLockSync(batchId, options, () => {
    const batch = readBatchV2(batchId, options)
    normalizeScheduler(batch, {}, { legacy: !batch.scheduler })
    return refreshAgentPageBatchV2(batch)
  })
}

export async function claimAgentPagesV2(batchId, options = {}) {
  return withBatchLock(batchId, options, async () => {
    const batch = readBatchV2(batchId, options)
    normalizeScheduler(batch, {}, { legacy: !batch.scheduler })
    refreshAgentPageBatchV2(batch, { write: false })
    const activeCount = activePages(batch).length
    const available = Math.max(0, batch.scheduler.agentConcurrency - activeCount)
    const requested = readNonNegativeInteger(options.limit, available, '--limit')
    const count = Math.min(available, requested)
    const now = new Date().toISOString()
    const claimed = readyPages(batch).slice(0, count)

    for (const page of claimed) {
      const claim = { claimId: randomUUID(), claimedAt: now }
      page.claim = claim
      page.attemptHistory ||= []
      page.attemptHistory.push({
        attempt: page.attemptHistory.length + 1,
        claimId: claim.claimId,
        claimedAt: now,
        status: 'claimed',
      })
      const jobPath = join(batch.jobRoot, page.jobId, 'job.json')
      const job = readJson(jobPath)
      writeJsonAtomic(jobPath, {
        ...job,
        batch: { batchId: batch.batchId, batchDir: batch.batchDir },
        claim,
        updatedAt: now,
      })
    }

    refreshAgentPageBatchV2(batch, { write: false })
    writeBatch(batch)
    return {
      ok: true,
      batchId: batch.batchId,
      claimedPages: claimed.map((page) => pageHandoff(page, batch)),
      readyPages: batch.readyPages,
      activePages: batch.activePages,
      summary: batch.summary,
    }
  })
}

export async function requeueAgentPageV2(batchId, options = {}) {
  const { jobId, claimId } = options
  if (!jobId) throw new Error('--job-id is required')
  if (!claimId) throw new Error('--claim-id is required')
  return withBatchLock(batchId, options, async () => {
    const batch = readBatchV2(batchId, options)
    normalizeScheduler(batch, {}, { legacy: !batch.scheduler })
    refreshAgentPageBatchV2(batch, { write: false })
    const page = batch.pages.find((candidate) => candidate.jobId === jobId)
    if (!page) throw new Error(`Batch ${batchId} does not contain job ${jobId}`)
    if (page.claim?.claimId !== claimId) throw new Error(`Claim does not match job ${jobId}`)
    const jobPath = join(batch.jobRoot, jobId, 'job.json')
    const job = readJson(jobPath)
    if (job.claim?.claimId !== claimId) throw new Error(`Job claim does not match ${claimId}`)
    const now = new Date().toISOString()
    const attempt = currentAttempt(page, claimId)
    const reason = String(options.reason || 'Agent worker exited before finalize')
    const begun = Boolean(job.agentStartedAt) || ACTIVE_STATUSES.has(job.status)

    if (!begun) {
      if (attempt) Object.assign(attempt, { status: 'released', reason, finishedAt: now, runtimeMs: 0 })
      page.claim = null
      writeJsonAtomic(jobPath, { ...job, claim: null, updatedAt: now })
    } else if (Number(page.retryCount || 0) < batch.scheduler.agentRetryLimit) {
      const restoreFn = options.restoreDraftFn || resetAgentAttemptV2
      const result = await restoreFn(jobId, { jobRoot: batch.jobRoot, claimId, reason })
      page.retryCount = Number(page.retryCount || 0) + 1
      page.claim = null
      page.status = result?.job?.status || 'awaiting-agent'
      page.agentStage = result?.job?.agentStage || 'generation'
      if (attempt) Object.assign(attempt, {
        status: 'requeued', reason, finishedAt: now,
        runtimeMs: workerRuntimeMs(job, now),
      })
    } else {
      page.claim = null
      page.status = 'error'
      page.agentStage = 'error'
      page.error = `Agent worker failed after ${page.retryCount || 0} retries: ${reason}`
      if (attempt) Object.assign(attempt, {
        status: 'error', reason, finishedAt: now,
        runtimeMs: workerRuntimeMs(job, now),
      })
      writeJsonAtomic(jobPath, {
        ...job,
        status: 'error',
        agentStage: 'error',
        claim: null,
        error: page.error,
        updatedAt: now,
      })
    }

    refreshAgentPageBatchV2(batch, { write: false })
    writeBatch(batch)
    return { ok: true, batchId, page: pageHandoff(page, batch), batch }
  })
}

export function refreshAgentPageBatchV2(batch, options = {}) {
  for (const page of batch.pages || []) {
    page.retryCount = Number(page.retryCount || 0)
    page.attemptHistory ||= []
    if (!page.jobId) continue
    const path = join(batch.jobRoot, page.jobId, 'job.json')
    if (!existsSync(path)) {
      page.status = 'error'
      page.error = `找不到页面任务：${page.jobId}`
      continue
    }
    const job = readJson(path)
    page.status = job.status
    page.agentStage = job.agentStage
    page.claim = job.claim || null
    page.outputDir = job.outputDir || null
    page.htmlPath = job.outputDir ? join(job.outputDir, 'index.html') : null
    page.zipPath = job.resultSummary?.outputZipPath || null
    page.validationPath = job.resultSummary?.validationPath || null
    page.visualReportPath = job.resultSummary?.visualReportPath || null
    page.variantVisualReportPaths = job.resultSummary?.variantVisualReportPaths || null
    page.error = job.error
    syncAttemptFromJob(page, job)
  }
  const failed = batch.pages.filter((page) => ['first-pass-invalid', 'error'].includes(page.status))
  const ready = readyPages(batch)
  const active = activePages(batch)
  batch.scheduler.peakAgentConcurrency = Math.max(
    Number(batch.scheduler.peakAgentConcurrency || 0),
    peakAttemptConcurrency(batch.pages),
  )
  const preparing = batch.pages.some((page) => ['pending', 'preparing'].includes(page.status))
  const allTerminal = batch.pages.every((page) => TERMINAL_STATUSES.has(page.status))
  batch.status = allTerminal
    ? failed.length > 0 ? 'partial-failure' : 'done'
    : preparing ? 'preparing'
      : active.length > 0 ? 'running'
        : ready.length > 0 ? 'awaiting-agent'
          : 'running'
  batch.summary = {
    total: batch.pages.length,
    done: batch.pages.filter((page) => page.status === 'done').length,
    awaitingAgent: batch.pages.filter((page) => page.status === 'awaiting-agent').length,
    claimed: batch.pages.filter((page) => page.status === 'awaiting-agent' && page.claim).length,
    agentRunning: batch.pages.filter((page) => page.status === 'agent-running').length,
    validating: batch.pages.filter((page) => page.status === 'validating').length,
    firstPassInvalid: batch.pages.filter((page) => page.status === 'first-pass-invalid').length,
    error: batch.pages.filter((page) => page.status === 'error').length,
  }
  batch.readyPages = ready.map((page) => pageHandoff(page, batch))
  batch.activePages = active.map((page) => pageHandoff(page, batch))
  batch.nextPage = batch.readyPages[0] || null
  batch.mergePrepareCommand = allTerminal ? buildMergePrepareCommand(batch) : null
  batch.updatedAt = new Date().toISOString()
  if (options.write !== false) writeBatch(batch)
  return batch
}

async function preparePendingPages(batch, options) {
  const prepareSingleFn = options.prepareSingleFn || prepareAgentJobV2
  const prepareResponsiveFn = options.prepareResponsiveFn || prepareResponsiveAgentJobV2
  const pending = batch.pages.filter((page) => !page.jobId && ['pending', 'preparing'].includes(page.status))
  let cursor = 0
  const worker = async () => {
    while (cursor < pending.length) {
      const page = pending[cursor]
      cursor += 1
      page.status = 'preparing'
      page.updatedAt = new Date().toISOString()
      writeBatch(batch)
      try {
        const prepareFn = page.inputKind === 'responsive-page' ? prepareResponsiveFn : prepareSingleFn
        const job = await prepareFn(page.inputPath, {
          jobRoot: batch.jobRoot,
          onJobStart: (startedJob) => {
            page.jobId = startedJob.jobId
            page.jobDir = startedJob.jobDir
            page.updatedAt = new Date().toISOString()
            writeBatch(batch)
            options.onJobStart?.(startedJob)
          },
          onProgress: (progress) => options.onProgress?.({ ...progress, pageId: page.id, route: page.route }),
        })
        Object.assign(page, {
          jobId: job.jobId,
          jobDir: job.jobDir,
          status: job.status,
          agentStage: job.agentStage,
          manifestPath: job.manifestPath,
          contextIndexPath: job.contextIndexPath,
          error: undefined,
        })
        attachBatchMetadata(batch, page)
      } catch (error) {
        page.status = 'error'
        page.error = error.message
      }
      page.updatedAt = new Date().toISOString()
      batch.updatedAt = page.updatedAt
      writeBatch(batch)
    }
  }
  const concurrency = Math.min(MAX_PREPARE_CONCURRENCY, pending.length)
  await Promise.all(Array.from({ length: concurrency }, worker))
  return refreshAgentPageBatchV2(batch)
}

function pageHandoff(page, batch) {
  const claimArg = page.claim?.claimId ? ` --claim-id ${page.claim.claimId}` : ''
  return {
    id: page.id,
    name: page.name,
    route: page.route,
    inputKind: page.inputKind,
    jobId: page.jobId,
    jobDir: page.jobDir || join(batch.jobRoot, page.jobId),
    status: page.status,
    agentStage: page.agentStage || null,
    claimId: page.claim?.claimId || null,
    beginCommand: `npm run --silent cli -- agent-begin ${page.jobId} --job-root ${batch.jobRoot}${claimArg} --json`,
    statusCommand: `npm run --silent cli -- agent-status ${page.jobId} --job-root ${batch.jobRoot} --json`,
    finalizeCommand: `npm run --silent cli -- agent-finalize ${page.jobId} --job-root ${batch.jobRoot}${claimArg} --json`,
  }
}

function normalizeScheduler(batch, options = {}, { legacy = false } = {}) {
  const scheduler = batch.scheduler || {}
  const fallbackConcurrency = legacy ? LEGACY_AGENT_CONCURRENCY : DEFAULT_AGENT_CONCURRENCY
  batch.scheduler = {
    ...scheduler,
    agentConcurrency: readBoundedInteger(
      options.agentConcurrency ?? scheduler.agentConcurrency,
      fallbackConcurrency, 1, 3, '--agent-concurrency',
    ),
    agentRetryLimit: readBoundedInteger(
      options.agentRetryLimit ?? options.agentRetries ?? scheduler.agentRetryLimit,
      DEFAULT_AGENT_RETRY_LIMIT, 0, 2, '--agent-retries',
    ),
    prepareConcurrency: MAX_PREPARE_CONCURRENCY,
    peakAgentConcurrency: Number(scheduler.peakAgentConcurrency || 0),
  }
}

function readyPages(batch) {
  return batch.pages.filter((page) => page.status === 'awaiting-agent' && !page.claim)
}

function activePages(batch) {
  return batch.pages.filter((page) => Boolean(page.claim) || ACTIVE_STATUSES.has(page.status))
}

function currentAttempt(page, claimId) {
  return [...(page.attemptHistory || [])].reverse().find((attempt) => attempt.claimId === claimId)
}

function syncAttemptFromJob(page, job) {
  if (!job.claim?.claimId) return
  let attempt = currentAttempt(page, job.claim.claimId)
  if (!attempt) {
    attempt = {
      attempt: page.attemptHistory.length + 1,
      claimId: job.claim.claimId,
      claimedAt: job.claim.claimedAt || job.updatedAt,
      status: 'claimed',
      recoveredFromJob: true,
    }
    page.attemptHistory.push(attempt)
  }
  if (job.agentStartedAt) {
    attempt.agentStartedAt = job.agentStartedAt
    attempt.status = job.status === 'validating' ? 'validating' : 'agent-running'
  }
  if (job.agentFinishedAt) attempt.agentFinishedAt = job.agentFinishedAt
  if (TERMINAL_STATUSES.has(job.status)) {
    attempt.status = job.status
    attempt.finishedAt = job.completedAt || job.updatedAt
    attempt.runtimeMs = workerRuntimeMs(job, attempt.finishedAt)
    page.claim = null
  }
}

function attachBatchMetadata(batch, page) {
  const jobPath = join(batch.jobRoot, page.jobId, 'job.json')
  const job = readJson(jobPath)
  writeJsonAtomic(jobPath, {
    ...job,
    batch: { batchId: batch.batchId, batchDir: batch.batchDir },
    updatedAt: new Date().toISOString(),
  })
}

function workerRuntimeMs(job, finishedAt) {
  const start = Date.parse(job.agentStartedAt || job.claim?.claimedAt || finishedAt)
  const end = Date.parse(finishedAt)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0
}

function peakAttemptConcurrency(pages) {
  const events = []
  for (const page of pages) {
    for (const attempt of page.attemptHistory || []) {
      if (!attempt.agentStartedAt) continue
      const start = Date.parse(attempt.agentStartedAt)
      const end = Date.parse(attempt.agentFinishedAt || attempt.finishedAt || new Date().toISOString())
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue
      events.push({ at: start, delta: 1 })
      events.push({ at: Math.max(start, end), delta: -1 })
    }
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta)
  let active = 0
  let peak = 0
  for (const event of events) {
    active += event.delta
    peak = Math.max(peak, active)
  }
  return peak
}

function readBatchV2(batchId, options) {
  const batchRoot = resolve(options.batchRoot || '.mastergo2html/agent-batches')
  const path = join(batchRoot, batchId, 'batch.json')
  if (!existsSync(path)) throw new Error(`找不到 Agent 批次：${batchId}`)
  const batch = readJson(path)
  if (batch.version !== AGENT_BATCH_V2_VERSION) throw new Error(`批次 ${batchId} 不是 Agent v2 批次。`)
  batch.batchDir ||= dirname(path)
  batch.jobRoot = resolve(options.jobRoot || batch.jobRoot || DEFAULT_JOB_ROOT)
  return batch
}

async function withBatchLock(batchId, options, callback) {
  const batchRoot = resolve(options.batchRoot || '.mastergo2html/agent-batches')
  const batchDir = join(batchRoot, batchId)
  const lockDir = join(batchDir, '.scheduler.lock')
  const deadline = Date.now() + Number(options.lockTimeoutMs || 10_000)
  while (true) {
    try {
      mkdirSync(lockDir)
      writeLockOwner(lockDir)
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (recoverAbandonedLock(lockDir)) continue
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Agent batch lock: ${batchId}`)
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
    }
  }
  try {
    return await callback()
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}

function withBatchLockSync(batchId, options, callback) {
  const batchRoot = resolve(options.batchRoot || '.mastergo2html/agent-batches')
  const lockDir = join(batchRoot, batchId, '.scheduler.lock')
  while (true) {
    try {
      mkdirSync(lockDir)
      writeLockOwner(lockDir)
      break
    } catch (error) {
      if (error.code === 'EEXIST') {
        if (recoverAbandonedLock(lockDir)) continue
        const batch = readBatchV2(batchId, options)
        normalizeScheduler(batch, {}, { legacy: !batch.scheduler })
        return refreshAgentPageBatchV2(batch, { write: false })
      }
      throw error
    }
  }
  try {
    return callback()
  } finally {
    rmSync(lockDir, { recursive: true, force: true })
  }
}

function writeLockOwner(lockDir) {
  writeJsonAtomic(join(lockDir, 'owner.json'), { pid: process.pid, createdAt: new Date().toISOString() })
}

function recoverAbandonedLock(lockDir) {
  try {
    const ownerPath = join(lockDir, 'owner.json')
    if (!existsSync(ownerPath)) {
      if (Date.now() - statSync(lockDir).mtimeMs < 30_000) return false
    } else {
      const pid = Number(readJson(ownerPath).pid)
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) return false
    }
    rmSync(lockDir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function readBoundedInteger(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return parsed
}

function readNonNegativeInteger(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`)
  return parsed
}

function writeBatch(batch) {
  const path = join(batch.batchDir, 'batch.json')
  writeJsonAtomic(path, batch)
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
