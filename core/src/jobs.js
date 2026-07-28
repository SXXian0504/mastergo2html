import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_JOB_ROOT } from './constants.js'

export function resolveJobRoot(jobRoot) {
  return resolve(jobRoot || DEFAULT_JOB_ROOT)
}

export function getJobDir(jobId, options = {}) {
  return join(resolveJobRoot(options.jobRoot), jobId)
}

export function readJob(jobId, options = {}) {
  const jobPath = join(getJobDir(jobId, options), 'job.json')
  if (!existsSync(jobPath)) throw new Error(`找不到任务：${jobId}`)
  return JSON.parse(readFileSync(jobPath, 'utf8'))
}

export function writeJob(jobId, record, options = {}) {
  const jobDir = getJobDir(jobId, options)
  mkdirSync(jobDir, { recursive: true })
  writeFileSync(join(jobDir, 'job.json'), JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2))
}

export function listJobs(options = {}) {
  const jobRoot = resolveJobRoot(options.jobRoot)
  if (!existsSync(jobRoot)) return []
  return readdirSync(jobRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => {
      try {
        return readJob(entry.name, { jobRoot })
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

export function readLatestJob(options = {}) {
  const latest = listJobs(options)[0]
  if (!latest) throw new Error('暂无任务记录。')
  return latest
}

export function resolveJobId(jobId, options = {}) {
  if (jobId && jobId !== '--latest') return jobId
  return readLatestJob(options).jobId
}

export function cancelJob(jobId, options = {}) {
  const resolvedJobId = resolveJobId(jobId, options)
  const job = readJob(resolvedJobId, options)
  if (job.status !== 'running') {
    return { ok: true, canceled: false, reason: `任务当前状态是 ${job.status}，无需取消。`, job }
  }

  let signalSent = false
  let processMissing = false
  if (job.pid) {
    try {
      process.kill(job.pid, 'SIGTERM')
      signalSent = true
    } catch (error) {
      if (error?.code === 'ESRCH') processMissing = true
      else throw error
    }
  }

  const canceledJob = toCanceledJob(job, processMissing ? '任务进程不存在，已标记为取消' : '任务已取消')
  writeJob(resolvedJobId, canceledJob, options)
  return { ok: true, canceled: true, signalSent, processMissing, job: canceledJob }
}

export function markJobCanceled(jobId, options = {}) {
  const resolvedJobId = resolveJobId(jobId, options)
  const job = readJob(resolvedJobId, options)
  const canceledJob = toCanceledJob(job, '任务已取消')
  writeJob(resolvedJobId, canceledJob, options)
  return canceledJob
}

function toCanceledJob(job, message) {
  const canceledAt = new Date().toISOString()
  return {
    ...job,
    status: 'canceled',
    canceledAt,
    progress: {
      ...(job.progress || {}),
      message,
    },
    phaseDetails: markPhaseDetailsCanceled(job.phaseDetails || [], job.progress?.phase, message, canceledAt),
  }
}

function markPhaseDetailsCanceled(phaseDetails, progressPhase, message, endedAt) {
  const phases = phaseDetails.map((phase) => ({ ...phase }))
  const target = [...phases].reverse().find((phase) => phase.status === 'running')
    || phases.find((phase) => phase.phase === progressPhase)
  if (!target) return phases
  target.status = 'canceled'
  target.endedAt = endedAt
  target.message = message
  target.durationMs = target.startedAt ? new Date(endedAt).getTime() - new Date(target.startedAt).getTime() : target.durationMs
  return phases
}
