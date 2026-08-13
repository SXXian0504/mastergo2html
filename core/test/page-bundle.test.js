import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { buildMergePrepareCommand, classifyGenerationError, preparePageBundle, resolvePageBatchScheduler, resumeGeneratePageBundle, runGeneratePageBundle, selectRepresentativePageIndexes } from '../src/page-bundle.js'
import { withGlobalModelSlot } from '../../mcp-server/src/llm/concurrency.js'

function writePage(root, id, route) {
  const inputDir = join(root, 'pages', id, '00-input')
  mkdirSync(inputDir, { recursive: true })
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({ page: { id, name: id }, selection: [{}] }))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({ assets: [] }))
  writeFileSync(join(inputDir, 'frame-screenshot.png'), Buffer.from([137, 80, 78, 71]))
  return { id, name: id, route, sourceNodeId: `node-${id}`, inputDir: `pages/${id}/00-input` }
}

test('preparePageBundle validates and resolves page inputs', (t) => {
  const root = join('/tmp', `mastergo-page-bundle-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  const pages = [writePage(root, 'home', '/'), writePage(root, 'about', '/about')]
  writeFileSync(join(root, 'mastergo-pages.json'), JSON.stringify({
    version: 'mastergo2html.page-bundle.v1',
    generatedAt: new Date().toISOString(),
    source: { pageId: 'page-1', pageName: 'Website' },
    pages,
  }))

  const prepared = preparePageBundle(root, join(root, '.workspace'))
  assert.equal(prepared.pages.length, 2)
  assert.equal(prepared.pages[0].route, '/')
  assert.equal(readFileSync(join(prepared.pages[1].inputPath, 'raw.json'), 'utf8').includes('about'), true)
})

test('preparePageBundle rejects duplicate routes', () => {
  const root = join('/tmp', `mastergo-page-bundle-invalid-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  const pages = [writePage(root, 'one', '/same'), writePage(root, 'two', '/same')]
  writeFileSync(join(root, 'mastergo-pages.json'), JSON.stringify({
    version: 'mastergo2html.page-bundle.v1',
    pages,
  }))
  assert.throws(() => preparePageBundle(root, join(root, '.workspace')), /route 重复/)
})

test('buildMergePrepareCommand includes successful routes only', () => {
  const command = buildMergePrepareCommand({
    batchDir: '/tmp/batch',
    pages: [
      { route: '/', status: 'done', outputDir: '/tmp/jobs/home/output', inputPath: '/tmp/pages/home/00-input' },
      { route: '/broken', status: 'error' },
    ],
  })
  assert.match(command, /--require-frame-screenshot/)
  assert.match(command, /--page '\/=\/tmp\/jobs\/home\/output'/)
  assert.match(command, /--frame-screenshot '\/=\/tmp\/pages\/home\/00-input\/frame-screenshot\.png'/)
  assert.doesNotMatch(command, /broken/)
})

test('buildMergePrepareCommand accepts a responsive page desktop screenshot path', () => {
  const command = buildMergePrepareCommand({
    batchDir: '/tmp/batch',
    pages: [{
      route: '/', status: 'done', outputDir: '/tmp/jobs/home/output', inputPath: '/tmp/pages/home/responsive-page',
      frameScreenshotPath: '/tmp/pages/home/responsive-page/variants/desktop/00-input/frame-screenshot.png',
    }],
  })
  assert.match(command, /variants\/desktop\/00-input\/frame-screenshot\.png/)
})


function writeBundle(root, count) {
  const pages = Array.from({ length: count }, (_, index) => writePage(root, `page-${index + 1}`, index === 0 ? '/' : `/page-${index + 1}`))
  writeFileSync(join(root, 'mastergo-pages.json'), JSON.stringify({
    version: 'mastergo2html.page-bundle.v1',
    source: { pageId: 'page-batch', pageName: 'Batch' },
    pages,
  }))
  return pages
}

function completedJob(jobId, pageInputPath) {
  const outputDir = join(pageInputPath, '..', `output-${jobId}`)
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'index.html'), `<!doctype html><title>${jobId}</title>`)
  return {
    jobId,
    status: 'done',
    outputDir,
    progress: { phase: 'html-generation', percent: 100, message: 'done' },
    resultSummary: {
      htmlPath: join(outputDir, 'index.html'),
      zipPath: `${pageInputPath}/output.zip`,
    },
    htmlGenerationResult: {
      staticValidation: { ok: true, errors: [] },
      validationWarnings: [],
    },
  }
}


test('scheduler defaults to two page workers and five global model slots', () => {
  const resolution = resolvePageBatchScheduler({}, { environment: {} })
  assert.equal(resolution.scheduler.pageConcurrency, 2)
  assert.equal(resolution.scheduler.modelConcurrency, 5)
  assert.equal(resolution.sources.pageConcurrency.kind, 'default')
  assert.equal(resolution.sources.modelConcurrency.kind, 'default')
})

test('scheduler precedence is explicit option, inherited batch, environment, then default', () => {
  const inherited = resolvePageBatchScheduler({}, {
    inheritedScheduler: { pageConcurrency: 1, modelConcurrency: 1 },
    inheritedSources: {
      pageConcurrency: { kind: 'cli', detail: '--page-concurrency' },
      modelConcurrency: { kind: 'environment', detail: 'GLOBAL_MODEL_CONCURRENCY' },
    },
    environment: { PAGE_WORKER_CONCURRENCY: '4', GLOBAL_MODEL_CONCURRENCY: '4' },
  })
  assert.equal(inherited.scheduler.pageConcurrency, 1)
  assert.equal(inherited.scheduler.modelConcurrency, 1)
  assert.equal(inherited.sources.pageConcurrency.kind, 'batch')
  assert.equal(inherited.sources.pageConcurrency.inheritedSource.kind, 'cli')

  const explicit = resolvePageBatchScheduler({
    pageConcurrency: 2,
    modelConcurrency: 5,
    schedulerOptionSources: {
      pageConcurrency: { kind: 'cli', detail: '--page-concurrency' },
      modelConcurrency: { kind: 'cli', detail: '--model-concurrency' },
    },
  }, {
    inheritedScheduler: inherited.scheduler,
    inheritedSources: inherited.sources,
    environment: { PAGE_WORKER_CONCURRENCY: '4', GLOBAL_MODEL_CONCURRENCY: '4' },
  })
  assert.equal(explicit.scheduler.pageConcurrency, 2)
  assert.equal(explicit.scheduler.modelConcurrency, 5)
  assert.deepEqual(explicit.sources.pageConcurrency, { kind: 'cli', detail: '--page-concurrency' })
  assert.deepEqual(explicit.sources.modelConcurrency, { kind: 'cli', detail: '--model-concurrency' })

  const environment = resolvePageBatchScheduler({}, {
    environment: { PAGE_WORKER_CONCURRENCY: '3', GLOBAL_MODEL_CONCURRENCY: '4' },
  })
  assert.equal(environment.scheduler.pageConcurrency, 3)
  assert.equal(environment.scheduler.modelConcurrency, 4)
  assert.equal(environment.sources.pageConcurrency.kind, 'environment')
  assert.equal(environment.sources.modelConcurrency.kind, 'environment')
  assert.equal(environment.warnings.some((warning) => warning.field === 'modelConcurrency'), false)

  const invalidEnvironment = resolvePageBatchScheduler({}, {
    environment: { GLOBAL_MODEL_CONCURRENCY: '6' },
  })
  assert.equal(invalidEnvironment.scheduler.modelConcurrency, 5)
  assert.equal(invalidEnvironment.sources.modelConcurrency.kind, 'default')
  assert.equal(invalidEnvironment.warnings.some((warning) => warning.field === 'modelConcurrency'), true)
})

test('page batch limits page workers to two concurrent jobs', async () => {
  const root = join('/tmp', `mastergo-page-concurrency-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 5)
  let active = 0
  let maxActive = 0
  let sequence = 0
  const result = await runGeneratePageBundle(root, {
    batchRoot: join(root, '.batches'),
    qualityGateEnabled: false,
    pageConcurrency: 2,
    runGeneratePage: async (inputPath, options) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const jobId = `job-${++sequence}`
      options.onJobStart?.({ jobId })
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
      active -= 1
      return completedJob(jobId, inputPath)
    },
  })
  assert.equal(result.status, 'done')
  assert.equal(result.pages.length, 5)
  assert.equal(maxActive, 2)
})


test('serial multi-page configuration emits a persisted warning', async () => {
  const root = join('/tmp', `mastergo-page-serial-warning-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 3)
  const diagnostics = []
  let sequence = 0
  const result = await runGeneratePageBundle(root, {
    batchRoot: join(root, '.batches'),
    entryPoint: 'generate-pages',
    qualityGateEnabled: false,
    pageConcurrency: 1,
    modelConcurrency: 1,
    onSchedulerResolved: (value) => diagnostics.push(value),
    runGeneratePage: async (inputPath, options) => {
      const job = completedJob(`job-${++sequence}`, inputPath)
      options.onJobStart?.({ jobId: job.jobId })
      return job
    },
  })
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].warnings.some((warning) => warning.code === 'serial-multi-page-scheduler'), true)
  assert.equal(result.schedulerDiagnostics.warnings.some((warning) => warning.code === 'serial-multi-page-scheduler'), true)
  const persisted = JSON.parse(readFileSync(join(result.batchDir, 'batch.json'), 'utf8'))
  assert.equal(persisted.schedulerDiagnostics.warnings.some((warning) => warning.code === 'serial-multi-page-scheduler'), true)
  assert.equal(persisted.invocation.entryPoint, 'generate-pages')
})

test('scheduler runtime records actual overlapping page and model concurrency', async () => {
  const root = join('/tmp', `mastergo-page-runtime-concurrency-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 4)
  let sequence = 0
  const result = await runGeneratePageBundle(root, {
    batchRoot: join(root, '.batches'),
    qualityGateEnabled: false,
    pageConcurrency: 2,
    modelConcurrency: 2,
    runGeneratePage: async (inputPath, options) => {
      const jobId = `job-${++sequence}`
      options.onJobStart?.({ jobId })
      await withGlobalModelSlot(() => new Promise((resolvePromise) => setTimeout(resolvePromise, 10)))
      return completedJob(jobId, inputPath)
    },
  })
  assert.equal(result.schedulerRuntime.actual.pageConcurrency, 2)
  assert.equal(result.schedulerRuntime.actual.modelConcurrency, 2)
  assert.equal(result.schedulerRuntime.actual.modelConcurrencyObserved, true)
  assert.equal(result.schedulerRuntime.modelLimiter.totalAcquisitionCount, 4)
  assert.equal(result.schedulerRuntime.pagePool.runs[0].peakActivePageCount, 2)
})

test('manual quality gate generates representative pages before the rest and resumes after approval', async () => {
  const root = join('/tmp', `mastergo-page-quality-gate-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 4)
  const calls = []
  const runGeneratePage = async (inputPath, options) => {
    calls.push(inputPath)
    const jobId = `job-${calls.length}`
    options.onJobStart?.({ jobId })
    return completedJob(jobId, inputPath)
  }
  const first = await runGeneratePageBundle(root, {
    batchRoot: join(root, '.batches'),
    qualityGatePageCount: 2,
    pageConcurrency: 2,
    runGeneratePage,
  })
  assert.equal(first.status, 'quality-gate')
  assert.equal(first.qualityGate.status, 'awaiting-approval')
  assert.equal(first.pages.filter((page) => page.status === 'done').length, 2)
  assert.equal(first.pages.filter((page) => page.status === 'pending').length, 2)

  const resumed = await resumeGeneratePageBundle(first.batchId, {
    batchRoot: join(root, '.batches'),
    approveQuality: true,
    runGeneratePage,
  })
  assert.equal(resumed.status, 'done')
  assert.equal(resumed.pages.every((page) => page.status === 'done'), true)
  assert.equal(calls.length, 4)
})


test('resume preserves inherited 1/1 scheduler settings and their source', async () => {
  const root = join('/tmp', `mastergo-page-resume-inherit-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 3)
  let sequence = 0
  const runGeneratePage = async (inputPath, options) => {
    const job = completedJob(`job-${++sequence}`, inputPath)
    options.onJobStart?.({ jobId: job.jobId })
    return job
  }
  const first = await runGeneratePageBundle(root, {
    batchRoot: join(root, '.batches'),
    qualityGatePageCount: 1,
    pageConcurrency: 1,
    modelConcurrency: 1,
    schedulerOptionSources: {
      pageConcurrency: { kind: 'cli', detail: '--page-concurrency' },
      modelConcurrency: { kind: 'cli', detail: '--model-concurrency' },
    },
    runGeneratePage,
  })
  const resumed = await resumeGeneratePageBundle(first.batchId, {
    batchRoot: join(root, '.batches'),
    approveQuality: true,
    runGeneratePage,
  })
  assert.equal(resumed.scheduler.pageConcurrency, 1)
  assert.equal(resumed.scheduler.modelConcurrency, 1)
  assert.equal(resumed.schedulerDiagnostics.sources.pageConcurrency.kind, 'batch')
  assert.equal(resumed.schedulerDiagnostics.sources.pageConcurrency.inheritedSource.kind, 'cli')
  assert.equal(resumed.schedulerDiagnostics.warnings.some((warning) => warning.code === 'serial-multi-page-scheduler'), true)
  assert.equal(resumed.schedulerRuns.length, 2)
  assert.deepEqual(resumed.schedulerRuns.map((run) => run.requested), [
    { pageConcurrency: 1, modelConcurrency: 1 },
    { pageConcurrency: 1, modelConcurrency: 1 },
  ])
  assert.equal(resumed.invocations.length, 2)
})

test('resume explicitly overrides inherited serial scheduler settings', async () => {
  const root = join('/tmp', `mastergo-page-resume-override-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 3)
  let sequence = 0
  const runGeneratePage = async (inputPath, options) => {
    const job = completedJob(`job-${++sequence}`, inputPath)
    options.onJobStart?.({ jobId: job.jobId })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    return job
  }
  const first = await runGeneratePageBundle(root, {
    batchRoot: join(root, '.batches'),
    qualityGatePageCount: 1,
    pageConcurrency: 1,
    modelConcurrency: 1,
    runGeneratePage,
  })
  const resumed = await resumeGeneratePageBundle(first.batchId, {
    batchRoot: join(root, '.batches'),
    approveQuality: true,
    pageConcurrency: 2,
    modelConcurrency: 2,
    schedulerOptionSources: {
      pageConcurrency: { kind: 'cli', detail: '--page-concurrency' },
      modelConcurrency: { kind: 'cli', detail: '--model-concurrency' },
    },
    runGeneratePage,
  })
  assert.equal(resumed.scheduler.pageConcurrency, 2)
  assert.equal(resumed.scheduler.modelConcurrency, 2)
  assert.deepEqual(resumed.schedulerDiagnostics.sources.pageConcurrency, { kind: 'cli', detail: '--page-concurrency' })
  assert.deepEqual(resumed.schedulerDiagnostics.sources.modelConcurrency, { kind: 'cli', detail: '--model-concurrency' })
  assert.equal(resumed.schedulerDiagnostics.warnings.some((warning) => warning.code === 'serial-multi-page-scheduler'), false)
  assert.equal(resumed.schedulerRuntime.actual.pageConcurrency, 2)
  assert.equal(resumed.schedulerRuns.length, 2)
  assert.deepEqual(resumed.schedulerRuns.map((run) => run.requested), [
    { pageConcurrency: 1, modelConcurrency: 1 },
    { pageConcurrency: 2, modelConcurrency: 2 },
  ])
})

test('transient page failure retries the existing job from its failed phase', async () => {
  const root = join('/tmp', `mastergo-page-retry-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 1)
  let retryCalls = 0
  const delays = []
  const error = Object.assign(new Error('model connection timeout'), {
    job: { jobId: 'job-timeout', progress: { phase: 'html-generation' } },
  })
  const result = await runGeneratePageBundle(root, {
    batchRoot: join(root, '.batches'),
    qualityGateEnabled: false,
    pageRetryLimit: 2,
    pageRetryBaseDelayMs: 1,
    sleep: async (ms) => delays.push(ms),
    runGeneratePage: async () => { throw error },
    retryPageJob: async (jobId) => {
      retryCalls += 1
      assert.equal(jobId, 'job-timeout')
      return completedJob(jobId, join(root, 'pages', 'page-1', '00-input'))
    },
  })
  assert.equal(result.status, 'done')
  assert.equal(result.pages[0].retryCount, 1)
  assert.equal(retryCalls, 1)
  assert.equal(delays.length, 1)
})

test('global authentication failures pause unscheduled pages', async () => {
  const root = join('/tmp', `mastergo-page-global-pause-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 4)
  const result = await runGeneratePageBundle(root, {
    batchRoot: join(root, '.batches'),
    qualityGateEnabled: false,
    pageConcurrency: 2,
    pageRetryLimit: 0,
    runGeneratePage: async () => { throw new Error('Unauthorized: invalid API key') },
  })
  assert.equal(result.status, 'paused')
  assert.equal(result.pause.category, 'authentication-or-configuration')
  assert.equal(result.pages.some((page) => page.status === 'paused'), true)
})

test('error classification and representative selection are deterministic', () => {
  assert.deepEqual(classifyGenerationError(new Error('HTTP 429 rate limit')).category, 'rate-limit')
  assert.deepEqual(classifyGenerationError(new Error('JSON parse failed')).category, 'page-generation')
  const pages = [
    { inputPath: '/missing/a' },
    { inputPath: '/missing/b', representative: true },
    { inputPath: '/missing/c' },
  ]
  assert.deepEqual(selectRepresentativePageIndexes(pages, 2), [0, 1])
})

test('quality failure preserves completed pages and retry-quality does not regenerate them', async () => {
  const root = join('/tmp', `mastergo-page-quality-preserve-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 3)
  let initialCalls = 0
  const first = await runGeneratePageBundle(root, {
    batchRoot: join(root, '.batches'),
    qualityGatePageCount: 2,
    runGeneratePage: async (inputPath, options) => {
      initialCalls += 1
      const job = completedJob(`job-${initialCalls}`, inputPath)
      options.onJobStart?.({ jobId: job.jobId })
      if (initialCalls === 1) job.htmlGenerationResult.staticValidation = { ok: false, errors: ['invalid html'] }
      return job
    },
  })

  assert.equal(first.status, 'quality-failed')
  assert.equal(initialCalls, 3)
  assert.equal(first.pages.every((page) => page.status === 'done'), true)
  assert.equal(first.pages[0].qualityGateFailure, true)
  assert.equal(first.pages[0].qualityGateFailureReason, 'static-validation')

  let retryCalls = 0
  const second = await resumeGeneratePageBundle(first.batchId, {
    batchRoot: join(root, '.batches'),
    retryQuality: true,
    retryPageFromPhase: async () => {
      retryCalls += 1
      throw new Error('completed pages must not be regenerated')
    },
  })

  assert.equal(second.status, 'quality-failed')
  assert.equal(retryCalls, 0)
  assert.equal(second.pages.every((page) => page.status === 'done'), true)
})

test('force-quality-retry explicitly reruns representative plan-and-generate phases only', async () => {
  const root = join('/tmp', `mastergo-page-force-quality-retry-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 4)
  let sequence = 0
  const first = await runGeneratePageBundle(root, {
    batchRoot: join(root, '.batches'),
    qualityGateMode: 'auto',
    qualityGatePageCount: 2,
    runGeneratePage: async (inputPath, options) => {
      const job = completedJob(`job-${++sequence}`, inputPath)
      options.onJobStart?.({ jobId: job.jobId })
      return job
    },
  })
  assert.equal(first.status, 'done')

  const retries = []
  const second = await resumeGeneratePageBundle(first.batchId, {
    batchRoot: join(root, '.batches'),
    forceQualityRetry: true,
    retryPageFromPhase: async (jobId, phase) => {
      retries.push({ jobId, phase })
      const page = first.pages.find((candidate) => candidate.jobId === jobId)
      return completedJob(jobId, page.inputPath)
    },
  })

  assert.equal(second.status, 'done')
  assert.equal(retries.length, 2)
  assert.equal(retries.every((item) => item.phase === 'plan-and-generate'), true)
  assert.equal(second.pages.every((page) => page.status === 'done'), true)
})

test('fresh generation reuses matching successful pages unless force-regenerate is set', async () => {
  const root = join('/tmp', `mastergo-page-reuse-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 3)
  const batchRoot = join(root, '.batches')
  let calls = 0
  const generate = async (inputPath, options) => {
    const job = completedJob(`job-${++calls}`, inputPath)
    options.onJobStart?.({ jobId: job.jobId })
    return job
  }

  const first = await runGeneratePageBundle(root, {
    batchRoot,
    qualityGateEnabled: false,
    runGeneratePage: generate,
  })
  assert.equal(first.status, 'done')
  assert.equal(calls, 3)

  const second = await runGeneratePageBundle(root, {
    batchRoot,
    qualityGateEnabled: false,
    runGeneratePage: async () => { throw new Error('matching pages must be reused') },
  })
  assert.equal(second.status, 'done')
  assert.equal(second.pages.every((page) => page.generationMode === 'reused'), true)
  assert.equal(second.pages.every((page) => page.reusedFromBatchId === first.batchId), true)
  assert.equal(calls, 3)

  const third = await runGeneratePageBundle(root, {
    batchRoot,
    qualityGateEnabled: false,
    forceRegenerate: true,
    runGeneratePage: generate,
  })
  assert.equal(third.status, 'done')
  assert.equal(calls, 6)
  assert.equal(third.pages.every((page) => page.generationMode === 'generated'), true)
})

test('changed page input invalidates reuse for that page only', async () => {
  const root = join('/tmp', `mastergo-page-reuse-invalidation-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 2)
  const batchRoot = join(root, '.batches')
  let calls = 0
  const generate = async (inputPath, options) => {
    const job = completedJob(`job-${++calls}`, inputPath)
    options.onJobStart?.({ jobId: job.jobId })
    return job
  }

  await runGeneratePageBundle(root, {
    batchRoot,
    qualityGateEnabled: false,
    runGeneratePage: generate,
  })
  writeFileSync(join(root, 'pages', 'page-1', '00-input', 'raw.json'), JSON.stringify({ changed: true }))

  const second = await runGeneratePageBundle(root, {
    batchRoot,
    qualityGateEnabled: false,
    runGeneratePage: generate,
  })
  assert.equal(calls, 3)
  assert.equal(second.pages[0].generationMode, 'generated')
  assert.equal(second.pages[1].generationMode, 'reused')
})

test('legacy quality-retry state with an existing output is recovered without regeneration', async () => {
  const root = join('/tmp', `mastergo-page-legacy-quality-retry-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 1)
  const batchRoot = join(root, '.batches')
  const first = await runGeneratePageBundle(root, {
    batchRoot,
    qualityGatePageCount: 1,
    runGeneratePage: async (inputPath, options) => {
      const job = completedJob('job-legacy', inputPath)
      options.onJobStart?.({ jobId: job.jobId })
      return job
    },
  })
  const recordPath = join(first.batchDir, 'batch.json')
  const legacy = JSON.parse(readFileSync(recordPath, 'utf8'))
  legacy.status = 'quality-failed'
  legacy.qualityGate.status = 'failed'
  legacy.pages[0].status = 'quality-retry'
  legacy.pages[0].forceRetryPhase = 'html-generation'
  writeFileSync(recordPath, JSON.stringify(legacy, null, 2))

  let retryCalls = 0
  const resumed = await resumeGeneratePageBundle(first.batchId, {
    batchRoot,
    retryQuality: true,
    retryPageFromPhase: async () => {
      retryCalls += 1
      throw new Error('legacy completed output must be recovered')
    },
  })

  assert.equal(retryCalls, 0)
  assert.equal(resumed.pages[0].status, 'done')
  assert.equal(resumed.pages[0].generationMode, 'generated')
  assert.equal(Boolean(resumed.pages[0].recoveredAt), true)
})

test('disabling the quality gate does not mark representative pages', async () => {
  const root = join('/tmp', `mastergo-page-no-quality-gate-${Date.now()}-${Math.random()}`)
  mkdirSync(root, { recursive: true })
  writeBundle(root, 2)
  let sequence = 0
  const result = await runGeneratePageBundle(root, {
    batchRoot: join(root, '.batches'),
    qualityGateEnabled: false,
    runGeneratePage: async (inputPath, options) => {
      const job = completedJob(`job-${++sequence}`, inputPath)
      options.onJobStart?.({ jobId: job.jobId })
      return job
    },
  })
  assert.equal(result.status, 'done')
  assert.equal(result.pages.some((page) => page.representative), false)
})
