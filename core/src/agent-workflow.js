import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_JOB_ROOT } from './constants.js'
import {
  AGENT_V2_PROTOCOL_VERSION,
  beginAgentJobV2,
  finalizeAgentJobV2,
  getAgentJobStatusV2,
  inspectAgentJobV2,
  prepareAgentJobV2,
} from './agent-workflow-v2.js'

export const prepareAgentJob = prepareAgentJobV2
export const beginAgentJob = beginAgentJobV2

export async function prepareAgentPageBundle(inputPath, options = {}) {
  const v1 = await import('./agent-workflow-v1.js')
  return v1.prepareAgentPageBundle(inputPath, options)
}

export async function getAgentBatchStatus(batchId, options = {}) {
  const v1 = await import('./agent-workflow-v1.js')
  return v1.getAgentBatchStatus(batchId, options)
}

export async function acceptAgentPlan(jobId, options = {}) {
  if (readJobVersion(jobId, options) === AGENT_V2_PROTOCOL_VERSION) {
    const status = getAgentJobStatusV2(jobId, options)
    return {
      ok: true,
      deprecated: true,
      noOp: true,
      message: 'Agent v2 starts from an HTML prototype and does not use implementation-plan acceptance.',
      job: status.job,
      manifest: status.manifest,
    }
  }
  const v1 = await import('./agent-workflow-v1.js')
  return v1.acceptAgentPlan(jobId, options)
}

export async function finalizeAgentJob(jobId, options = {}) {
  if (readJobVersion(jobId, options) === AGENT_V2_PROTOCOL_VERSION) return finalizeAgentJobV2(jobId, options)
  const v1 = await import('./agent-workflow-v1.js')
  return v1.finalizeAgentJob(jobId, options)
}

export async function getAgentJobStatus(jobId, options = {}) {
  if (readJobVersion(jobId, options) === AGENT_V2_PROTOCOL_VERSION) return getAgentJobStatusV2(jobId, options)
  const v1 = await import('./agent-workflow-v1.js')
  return v1.getAgentJobStatus(jobId, options)
}

export async function inspectAgentJob(jobId, query = {}, options = {}) {
  if (readJobVersion(jobId, options) === AGENT_V2_PROTOCOL_VERSION) return inspectAgentJobV2(jobId, query, options)
  const v1 = await import('./agent-workflow-v1.js')
  return v1.inspectAgentJob(jobId, query, options)
}

export async function prepareAgentJobV1(inputPath, options = {}) {
  const v1 = await import('./agent-workflow-v1.js')
  return v1.prepareAgentJob(inputPath, options)
}

function readJobVersion(jobId, options = {}) {
  const jobRoot = resolve(options.jobRoot || DEFAULT_JOB_ROOT)
  const path = join(jobRoot, jobId, 'job.json')
  if (!existsSync(path)) throw new Error(`Cannot find Agent job: ${jobId}`)
  return JSON.parse(readFileSync(path, 'utf8')).version || 'mastergo2html.codex-agent.v1'
}
