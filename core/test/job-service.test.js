import assert from 'node:assert/strict'
import test from 'node:test'
import { PROCESS_PHASES } from '../../mcp-server/src/workflow/job-retry.js'
import { runLegacyJobWorkflow } from '../src/job-service.js'

test('shared legacy job service owns phase ordering and event delivery', async () => {
  const events = []
  const runners = Object.fromEntries(PROCESS_PHASES.map((phase) => [phase, async (...args) => {
    const options = args[0]
    if (phase !== 'normalize-raw') options.onProgress?.({ outputTokens: 1 }, `${phase} streaming`)
    if (phase === 'normalize-raw') {
      return {
        normalizedDir: '/tmp/normalized',
        aiLayoutContextPath: '/tmp/layout-context.json',
        summary: { nodeCount: 3, assetCount: 2, warningCount: 1 },
      }
    }
    return {
      outputPath: `/tmp/${phase}`,
      durationMs: 1,
      tokenUsage: { totalTokens: 1 },
      ...(phase === 'html-generation' ? { staticValidation: { ok: true } } : {}),
    }
  }]))

  const result = await runLegacyJobWorkflow({
    jobId: 'job-1',
    jobDir: '/tmp/job-1',
    dependencies: { config: { provider: 'test' }, runners },
    onPhaseStart: ({ phase }) => events.push(`start:${phase}`),
    onPhaseProgress: ({ phase }) => events.push(`progress:${phase}`),
    onPhaseComplete: ({ phase }) => events.push(`complete:${phase}`),
  })

  assert.deepEqual(events.filter((event) => event.startsWith('start:')), PROCESS_PHASES.map((phase) => `start:${phase}`))
  assert.deepEqual(events.filter((event) => event.startsWith('complete:')), PROCESS_PHASES.map((phase) => `complete:${phase}`))
  assert.deepEqual(events.filter((event) => event.startsWith('progress:')), PROCESS_PHASES.slice(1).map((phase) => `progress:${phase}`))
  assert.equal(result.htmlGenerationResult.outputPath, '/tmp/html-generation')
})

test('shared legacy job service resumes from exactly the requested phase', async () => {
  const phases = []
  const runners = Object.fromEntries(PROCESS_PHASES.map((phase) => [phase, async () => {
    phases.push(phase)
    return { outputPath: `/tmp/${phase}`, durationMs: 1, staticValidation: { ok: true } }
  }]))
  await runLegacyJobWorkflow({
    jobId: 'job-2',
    jobDir: '/tmp/job-2',
    startPhase: 'interaction-analysis',
    dependencies: { config: { provider: 'test' }, runners },
  })
  assert.deepEqual(phases, ['interaction-analysis', 'assembly-planning', 'html-generation'])
})
