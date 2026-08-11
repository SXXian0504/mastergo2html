import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalPhaseName, findFailedPhase, resetPhaseDetailsForRetry } from '../src/workflow/job-retry.js'

test('retry starts from the recorded failed phase', () => {
  const job = {
    progress: { phase: 'assembly-planning' },
    phaseDetails: [
      { phase: 'interaction-analysis', status: 'done' },
      { phase: 'assembly-planning', status: 'error' },
    ],
  }
  assert.equal(findFailedPhase(job), 'plan-and-generate')
  assert.equal(canonicalPhaseName('html-generation'), 'plan-and-generate')
})

test('retry preserves legacy phase history and resets the combined phase', () => {
  const details = [
    { phase: 'interaction-analysis', status: 'done', durationMs: 451500, tokenUsage: { totalTokens: 11800 } },
    { phase: 'assembly-planning', status: 'error', durationMs: 600800, startedAt: 'start', endedAt: 'end' },
    { phase: 'html-generation', status: 'error', durationMs: 10 },
    { phase: 'plan-and-generate', status: 'error', durationMs: 20, startedAt: 'new-start', endedAt: 'new-end' },
  ]
  const reset = resetPhaseDetailsForRetry(details, 'assembly-planning')

  assert.deepEqual(reset[0], details[0])
  assert.deepEqual(reset[1], details[1])
  assert.deepEqual(reset[2], details[2])
  assert.equal(reset[3].status, 'pending')
  assert.equal(reset[3].durationMs, 0)
  assert.equal(reset[3].startedAt, undefined)
})
