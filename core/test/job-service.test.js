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
      ...(phase === 'plan-and-generate' ? { staticValidation: { ok: true } } : {}),
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
  assert.equal(result.htmlGenerationResult.outputPath, '/tmp/plan-and-generate')
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
  assert.deepEqual(phases, ['interaction-analysis', 'plan-and-generate'])
})

test('legacy assembly and html retry aliases both run only the combined phase', async () => {
  for (const legacyPhase of ['assembly-planning', 'html-generation']) {
    const phases = []
    await runLegacyJobWorkflow({
      jobId: `legacy-${legacyPhase}`,
      jobDir: `/tmp/legacy-${legacyPhase}`,
      startPhase: legacyPhase,
      dependencies: {
        config: { provider: 'test' },
        runners: {
          'plan-and-generate': async () => {
            phases.push('plan-and-generate')
            return { outputPath: '/tmp/combined', staticValidation: { ok: true } }
          },
        },
      },
    })
    assert.deepEqual(phases, ['plan-and-generate'])
  }
})

test('codex-sdk runs the three page-plan analyses concurrently on isolated threads', async () => {
  const branchPhases = [
    'component-structure-analysis',
    'static-asset-analysis',
    'interaction-analysis',
  ]
  const started = []
  const completed = []
  const releases = new Map()
  const configs = new Map()
  let active = 0
  let peakActive = 0
  let generationStarted = false
  let generationConfig
  const runners = Object.fromEntries(PROCESS_PHASES.map((phase) => [phase, async (options) => {
    if (phase === 'normalize-raw') {
      return {
        normalizedDir: '/tmp/normalized',
        aiLayoutContextPath: '/tmp/layout-context.json',
        summary: { nodeCount: 3, assetCount: 2, warningCount: 1 },
      }
    }
    if (branchPhases.includes(phase)) {
      started.push(phase)
      configs.set(phase, options.config)
      active += 1
      peakActive = Math.max(peakActive, active)
      await new Promise((resolvePromise) => releases.set(phase, resolvePromise))
      active -= 1
      completed.push(phase)
    }
    if (phase === 'plan-and-generate') {
      generationStarted = true
      generationConfig = options.config
      assert.equal(completed.length, 3)
    }
    return {
      outputPath: `/tmp/${phase}`,
      durationMs: 1,
      tokenUsage: { totalTokens: 1 },
      ...(phase === 'plan-and-generate' ? { staticValidation: { ok: true } } : {}),
    }
  }]))

  const workflow = runLegacyJobWorkflow({
    jobId: 'job-parallel',
    jobDir: '/tmp/job-parallel',
    dependencies: {
      config: {
        provider: 'codex-sdk',
        codexReuseThread: true,
        codexThreadKey: 'job-parallel',
        codexThreadStatePath: '/tmp/job-parallel/.codex-sdk-threads.json',
      },
      runners,
    },
  })

  await waitFor(() => started.length === 3)
  assert.equal(generationStarted, false)
  assert.equal(peakActive, 3)
  assert.deepEqual(new Set([...configs.values()].map((config) => config.codexThreadKey)), new Set([
    'job-parallel:component-structure-analysis',
    'job-parallel:static-asset-analysis',
    'job-parallel:interaction-analysis',
  ]))
  assert.deepEqual(new Set([...configs.values()].map((config) => config.codexThreadStatePath)), new Set([
    '/tmp/job-parallel/.codex-sdk-threads.component-structure-analysis.json',
    '/tmp/job-parallel/.codex-sdk-threads.static-asset-analysis.json',
    '/tmp/job-parallel/.codex-sdk-threads.interaction-analysis.json',
  ]))

  for (const phase of branchPhases) releases.get(phase)()
  await workflow
  assert.equal(generationStarted, true)
  assert.equal(generationConfig.codexThreadKey, 'job-parallel:plan-and-generate')
  assert.equal(generationConfig.codexThreadStatePath, '/tmp/job-parallel/.codex-sdk-threads.plan-and-generate.json')
})

test('codex-sdk waits for every parallel page-plan branch before reporting failure', async () => {
  const releases = []
  const errors = []
  let siblingCompleted = false
  const runners = Object.fromEntries(PROCESS_PHASES.map((phase) => [phase, async () => {
    if (phase === 'normalize-raw') {
      return {
        normalizedDir: '/tmp/normalized',
        aiLayoutContextPath: '/tmp/layout-context.json',
        summary: { nodeCount: 3, assetCount: 2, warningCount: 1 },
      }
    }
    if (phase === 'component-structure-analysis') throw new Error('component failed')
    if (phase === 'static-asset-analysis') {
      await new Promise((resolvePromise) => releases.push(resolvePromise))
      siblingCompleted = true
    }
    return { outputPath: `/tmp/${phase}`, durationMs: 1, staticValidation: { ok: true } }
  }]))

  const workflow = runLegacyJobWorkflow({
    jobId: 'job-parallel-failure',
    jobDir: '/tmp/job-parallel-failure',
    dependencies: { config: { provider: 'codex-sdk' }, runners },
    onPhaseError: ({ phase }) => errors.push(phase),
  })

  await waitFor(() => releases.length === 1)
  let rejected = false
  workflow.catch(() => { rejected = true })
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
  assert.equal(rejected, false)
  releases[0]()
  await assert.rejects(workflow, /component-structure-analysis/)
  assert.equal(siblingCompleted, true)
  assert.deepEqual(errors, ['component-structure-analysis'])
})

async function waitFor(predicate, timeoutMs = 1000) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
  }
}
