import assert from 'node:assert/strict'
import test from 'node:test'
import { findFailedPhase, resetPhaseDetailsForRetry } from '../src/workflow/job-retry.js'

test('retry starts from the recorded failed phase', () => {
  const job = {
    progress: { phase: 'assembly-planning' },
    phaseDetails: [
      { phase: 'interaction-analysis', status: 'done' },
      { phase: 'assembly-planning', status: 'error' },
    ],
  }
  assert.equal(findFailedPhase(job), 'assembly-planning')
})

test('retry preserves completed predecessors and resets failed and later phases', () => {
  const details = [
    { phase: 'interaction-analysis', status: 'done', durationMs: 451500, tokenUsage: { totalTokens: 11800 } },
    { phase: 'assembly-planning', status: 'error', durationMs: 600800, startedAt: 'start', endedAt: 'end' },
    { phase: 'html-generation', status: 'error', durationMs: 10 },
  ]
  const reset = resetPhaseDetailsForRetry(details, 'assembly-planning')

  assert.deepEqual(reset[0], details[0])
  assert.equal(reset[1].status, 'pending')
  assert.equal(reset[1].durationMs, 0)
  assert.equal(reset[1].startedAt, undefined)
  assert.equal(reset[2].status, 'pending')
})
