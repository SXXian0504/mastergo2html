import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  claimAgentPagesV2,
  getAgentPageBatchStatusV2,
  prepareAgentPageBundleV2,
  requeueAgentPageV2,
  resumeAgentPageBundleV2,
} from '../src/agent-page-batch-v2.js'
import { claimAgentPages, getAgentBatchStatus, prepareAgentPageBundle, requeueAgentPage } from '../src/agent-workflow.js'

test('prepares mixed logical pages with isolated v2 jobs and aggregates terminal states', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-batch-v2-'))
  const bundle = createBundle(root)
  const jobRoot = join(root, 'jobs')
  const calls = []
  const prepare = (kind) => async (_input, options) => {
    calls.push(kind)
    const jobId = `${kind}-${calls.length}`
    const jobDir = join(jobRoot, jobId)
    mkdirSync(jobDir, { recursive: true })
    options.onJobStart?.({ jobId, jobDir, jobRoot, version: 'mastergo2html.codex-agent.v2' })
    const job = { jobId, jobDir, status: 'awaiting-agent', agentStage: 'generation', manifestPath: join(jobDir, 'agent', 'manifest.json'), contextIndexPath: join(jobDir, 'agent', 'context-index.json') }
    writeFileSync(join(jobDir, 'job.json'), JSON.stringify(job))
    return job
  }
  const batch = await prepareAgentPageBundleV2(bundle, {
    batchRoot: join(root, 'batches'), jobRoot,
    prepareSingleFn: prepare('single'), prepareResponsiveFn: prepare('responsive'),
  })
  assert.deepEqual(calls, ['responsive', 'single'])
  assert.equal(batch.status, 'awaiting-agent')
  assert.equal(batch.scheduler.agentConcurrency, 2)
  assert.equal(batch.scheduler.agentRetryLimit, 1)
  assert.equal(batch.nextPage.inputKind, 'responsive-page')
  assert.equal(batch.readyPages.length, 2)
  assert.equal(batch.activePages.length, 0)
  assert.equal(new Set(batch.pages.map((page) => page.jobId)).size, 2)

  updateJob(jobRoot, batch.pages[0].jobId, { status: 'first-pass-invalid', resultSummary: { validationPath: '/tmp/invalid.json' } })
  updateJob(jobRoot, batch.pages[1].jobId, { status: 'done', outputDir: '/tmp/about-output', resultSummary: { outputZipPath: '/tmp/about.zip', validationPath: '/tmp/about-validation.json' } })
  const completed = getAgentPageBatchStatusV2(batch.batchId, { batchRoot: join(root, 'batches') })
  assert.equal(completed.status, 'partial-failure')
  assert.equal(completed.summary.done, 1)
  assert.equal(completed.summary.firstPassInvalid, 1)
  assert.equal(completed.nextPage, null)
  assert.match(completed.mergePrepareCommand, /about-output/)
})

test('prepares pages concurrently with a deterministic work queue capped at two', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-batch-v2-concurrent-'))
  const bundle = createFourPageBundle(root)
  const jobRoot = join(root, 'jobs')
  const starts = []
  const releases = []
  let active = 0
  let peak = 0
  const prepare = async (input, options) => {
    const pageId = input.split('/').at(-2)
    starts.push(pageId)
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => releases.push(() => { active -= 1; resolve() }))
    const jobId = `job-${pageId}`
    const jobDir = join(jobRoot, jobId)
    mkdirSync(jobDir, { recursive: true })
    options.onJobStart?.({ jobId, jobDir, jobRoot })
    const job = { jobId, jobDir, status: 'awaiting-agent', agentStage: 'generation' }
    writeFileSync(join(jobDir, 'job.json'), JSON.stringify(job))
    return job
  }

  const preparing = prepareAgentPageBundleV2(bundle, {
    batchRoot: join(root, 'batches'), jobRoot, prepareSingleFn: prepare,
  })
  await waitUntil(() => starts.length === 2)
  assert.deepEqual(starts, ['one', 'two'])
  assert.equal(peak, 2)
  releases.shift()()
  await waitUntil(() => starts.length === 3)
  assert.equal(starts[2], 'three')
  releases.shift()()
  await waitUntil(() => starts.length === 4)
  assert.equal(starts[3], 'four')
  while (releases.length) releases.shift()()
  const batch = await preparing
  assert.equal(batch.pages.length, 4)
  assert.equal(peak, 2)
})

test('claims pages atomically up to available concurrency and records attempts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-batch-v2-claim-'))
  const { batch, batchRoot, jobRoot } = await createPreparedBatch(root, 4)
  const [first, second] = await Promise.all([
    claimAgentPagesV2(batch.batchId, { batchRoot, limit: 2 }),
    claimAgentPagesV2(batch.batchId, { batchRoot, limit: 2 }),
  ])
  const claimed = [...first.claimedPages, ...second.claimedPages]
  assert.equal(claimed.length, 2)
  assert.equal(new Set(claimed.map((page) => page.jobId)).size, 2)
  assert.ok(claimed.every((page) => page.claimId && page.beginCommand.includes(`--claim-id ${page.claimId}`)))

  const status = getAgentPageBatchStatusV2(batch.batchId, { batchRoot })
  assert.equal(status.readyPages.length, 2)
  assert.equal(status.activePages.length, 2)
  assert.equal(status.summary.claimed, 2)
  assert.equal(status.scheduler.peakAgentConcurrency, 0)
  for (const page of status.pages.filter((candidate) => candidate.claim)) {
    assert.equal(page.attemptHistory.length, 1)
    assert.equal(page.attemptHistory[0].status, 'claimed')
    const job = JSON.parse(readFileSync(join(jobRoot, page.jobId, 'job.json'), 'utf8'))
    assert.equal(job.batch.batchId, batch.batchId)
    assert.equal(job.claim.claimId, page.claim.claimId)
  }

  for (const page of status.pages.filter((candidate) => candidate.claim)) {
    updateJob(jobRoot, page.jobId, { status: 'agent-running', agentStage: 'generation', agentStartedAt: new Date().toISOString() })
  }
  assert.equal(getAgentPageBatchStatusV2(batch.batchId, { batchRoot }).scheduler.peakAgentConcurrency, 2)

  const completedPage = status.pages.find((page) => page.claim)
  updateJob(jobRoot, completedPage.jobId, {
    status: 'done', agentStage: 'done', completedAt: new Date().toISOString(),
  })
  const completed = getAgentPageBatchStatusV2(batch.batchId, { batchRoot })
  const attempt = completed.pages.find((page) => page.jobId === completedPage.jobId).attemptHistory[0]
  assert.equal(attempt.status, 'done')
  assert.ok(Number.isInteger(attempt.runtimeMs))
})

test('claim recovers a scheduler lock whose owning process no longer exists', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-batch-v2-stale-lock-'))
  const { batch, batchRoot } = await createPreparedBatch(root, 1)
  const lockDir = join(batch.batchDir, '.scheduler.lock')
  mkdirSync(lockDir)
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({ pid: 2147483647 }))
  const result = await claimAgentPagesV2(batch.batchId, { batchRoot })
  assert.equal(result.claimedPages.length, 1)
})

test('requeue releases an unstarted claim without consuming retry budget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-batch-v2-release-'))
  const { batch, batchRoot } = await createPreparedBatch(root, 1)
  const claim = (await claimAgentPagesV2(batch.batchId, { batchRoot })).claimedPages[0]
  await assert.rejects(() => requeueAgentPageV2(batch.batchId, {
    batchRoot, jobId: claim.jobId, claimId: 'wrong-claim', reason: 'wrong worker',
  }), /Claim does not match/)
  await requeueAgentPageV2(batch.batchId, {
    batchRoot, jobId: claim.jobId, claimId: claim.claimId, reason: 'worker did not start',
  })
  const status = getAgentPageBatchStatusV2(batch.batchId, { batchRoot })
  assert.equal(status.pages[0].retryCount, 0)
  assert.equal(status.pages[0].attemptHistory[0].status, 'released')
  assert.equal(status.readyPages.length, 1)
  assert.equal(status.activePages.length, 0)
})

test('status clears a stale batch claim after the job-side reset was persisted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-batch-v2-reset-recovery-'))
  const { batch, batchRoot, jobRoot } = await createPreparedBatch(root, 1)
  const claim = (await claimAgentPagesV2(batch.batchId, { batchRoot })).claimedPages[0]
  updateJob(jobRoot, claim.jobId, { claim: null, status: 'awaiting-agent', agentStage: 'generation' })
  const status = getAgentPageBatchStatusV2(batch.batchId, { batchRoot })
  assert.equal(status.readyPages.length, 1)
  assert.equal(status.activePages.length, 0)
  assert.equal(status.pages[0].claim, null)
})

test('requeue resets a begun attempt once then marks a repeated failure as error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-batch-v2-retry-'))
  const { batch, batchRoot, jobRoot } = await createPreparedBatch(root, 1, { agentRetryLimit: 1, fullJob: true })
  const first = (await claimAgentPagesV2(batch.batchId, { batchRoot })).claimedPages[0]
  updateJob(jobRoot, first.jobId, { status: 'agent-running', agentStage: 'generation', agentStartedAt: new Date().toISOString() })
  await requeueAgentPageV2(batch.batchId, {
    batchRoot, jobId: first.jobId, claimId: first.claimId, reason: 'worker crashed',
  })
  let status = getAgentPageBatchStatusV2(batch.batchId, { batchRoot })
  assert.equal(status.pages[0].retryCount, 1)
  assert.equal(status.pages[0].attemptHistory[0].status, 'requeued')
  assert.equal(readFileSync(join(jobRoot, first.jobId, 'agent', 'draft', 'index.html'), 'utf8'), 'original-index.html')

  const second = (await claimAgentPagesV2(batch.batchId, { batchRoot })).claimedPages[0]
  updateJob(jobRoot, second.jobId, { status: 'agent-running', agentStage: 'generation', agentStartedAt: new Date().toISOString() })
  await requeueAgentPageV2(batch.batchId, {
    batchRoot, jobId: second.jobId, claimId: second.claimId, reason: 'worker crashed again',
  })
  status = getAgentPageBatchStatusV2(batch.batchId, { batchRoot })
  assert.equal(status.pages[0].status, 'error')
  assert.equal(status.pages[0].attemptHistory[1].status, 'error')
  assert.equal(status.summary.error, 1)
})

test('legacy v2 batch without scheduler resumes at concurrency one unless explicitly overridden', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-batch-v2-legacy-'))
  const { batch, batchRoot } = await createPreparedBatch(root, 2)
  const path = join(batch.batchDir, 'batch.json')
  const value = JSON.parse(readFileSync(path, 'utf8'))
  delete value.scheduler
  writeFileSync(path, JSON.stringify(value))
  assert.equal(getAgentPageBatchStatusV2(batch.batchId, { batchRoot }).scheduler.agentConcurrency, 1)
  assert.equal((await claimAgentPagesV2(batch.batchId, { batchRoot, limit: 3 })).claimedPages.length, 1)
})

test('resume skips pages that already recorded a job id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-batch-v2-resume-'))
  const jobRoot = join(root, 'jobs')
  let calls = 0
  const prepare = async (_input, options) => {
    calls += 1
    const jobId = `job-${calls}`
    const jobDir = join(jobRoot, jobId)
    mkdirSync(jobDir, { recursive: true })
    options.onJobStart?.({ jobId, jobDir, jobRoot })
    const job = { jobId, jobDir, status: 'awaiting-agent', agentStage: 'generation' }
    writeFileSync(join(jobDir, 'job.json'), JSON.stringify(job))
    return job
  }
  const batch = await prepareAgentPageBundleV2(createV1Bundle(root), {
    batchRoot: join(root, 'batches'), jobRoot, prepareSingleFn: prepare,
  })
  await resumeAgentPageBundleV2(batch.batchId, { batchRoot: join(root, 'batches'), prepareSingleFn: prepare })
  assert.equal(calls, 1)
})

test('public Agent workflow defaults page bundles to v2 and auto-routes batch status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-batch-v2-public-'))
  const jobRoot = join(root, 'jobs')
  const prepareSingleFn = async (_input, options) => {
    const jobId = 'public-v2-job'
    const jobDir = join(jobRoot, jobId)
    mkdirSync(jobDir, { recursive: true })
    options.onJobStart?.({ jobId, jobDir, jobRoot })
    const job = { jobId, jobDir, status: 'awaiting-agent', agentStage: 'generation' }
    writeFileSync(join(jobDir, 'job.json'), JSON.stringify(job))
    return job
  }
  const batchRoot = join(root, 'batches')
  const batch = await prepareAgentPageBundle(createV1Bundle(root), { batchRoot, jobRoot, prepareSingleFn })
  assert.equal(batch.version, 'mastergo2html.codex-agent-batch.v2')
  assert.equal((await getAgentBatchStatus(batch.batchId, { batchRoot })).nextPage.jobId, 'public-v2-job')
  const claim = (await claimAgentPages(batch.batchId, { batchRoot })).claimedPages[0]
  assert.equal(claim.jobId, 'public-v2-job')
  const released = await requeueAgentPage(batch.batchId, {
    jobId: claim.jobId, claimId: claim.claimId, reason: 'facade release test',
  }, { batchRoot })
  assert.equal(released.batch.readyPages.length, 1)
})

function createBundle(root) {
  const bundle = join(root, 'bundle')
  writeResponsiveInput(join(bundle, 'pages', 'home', 'responsive-page'))
  writeSingleInput(join(bundle, 'pages', 'about', '00-input'), 'about', '关于', 1440)
  writeFileSync(join(bundle, 'mastergo-pages.json'), JSON.stringify({
    version: 'mastergo2html.page-bundle.v2', frameCount: 3,
    pages: [
      { id: 'home', name: '首页', route: '/', inputKind: 'responsive-page', inputDir: 'pages/home/responsive-page', sourceNodeId: 'home-desktop', sourceNodeIds: ['home-desktop', 'home-mobile'] },
      { id: 'about', name: '关于', route: '/about', inputKind: 'single-page', inputDir: 'pages/about/00-input', sourceNodeId: 'about', sourceNodeIds: ['about'] },
    ],
  }))
  return bundle
}

function createV1Bundle(root) {
  const bundle = join(root, 'bundle-v1')
  writeSingleInput(join(bundle, 'pages', 'home', '00-input'), 'home', 'Home', 1440)
  writeFileSync(join(bundle, 'mastergo-pages.json'), JSON.stringify({ version: 'mastergo2html.page-bundle.v1', pages: [{ id: 'home', name: 'Home', route: '/', inputDir: 'pages/home/00-input', sourceNodeId: 'home' }] }))
  return bundle
}

function createFourPageBundle(root) {
  const bundle = join(root, 'bundle-four')
  const pages = ['one', 'two', 'three', 'four'].map((id, index) => {
    writeSingleInput(join(bundle, 'pages', id, '00-input'), id, id, 1440)
    return { id, name: id, route: index === 0 ? '/' : `/${id}`, inputDir: `pages/${id}/00-input`, sourceNodeId: id }
  })
  writeFileSync(join(bundle, 'mastergo-pages.json'), JSON.stringify({ version: 'mastergo2html.page-bundle.v1', pages }))
  return bundle
}

async function createPreparedBatch(root, count, options = {}) {
  const bundle = join(root, 'prepared-bundle')
  const pages = Array.from({ length: count }, (_, index) => {
    const id = `page-${index + 1}`
    writeSingleInput(join(bundle, 'pages', id, '00-input'), id, id, 1440)
    return { id, name: id, route: index === 0 ? '/' : `/${id}`, inputDir: `pages/${id}/00-input`, sourceNodeId: id }
  })
  writeFileSync(join(bundle, 'mastergo-pages.json'), JSON.stringify({ version: 'mastergo2html.page-bundle.v1', pages }))
  const jobRoot = join(root, 'jobs')
  const batchRoot = join(root, 'batches')
  let number = 0
  const prepare = async (_input, prepareOptions) => {
    number += 1
    const jobId = `prepared-${number}`
    const jobDir = join(jobRoot, jobId)
    mkdirSync(join(jobDir, 'agent', 'draft'), { recursive: true })
    mkdirSync(join(jobDir, 'agent', 'prototype-source'), { recursive: true })
    prepareOptions.onJobStart?.({ jobId, jobDir, jobRoot })
    const job = {
      version: options.fullJob ? 'mastergo2html.codex-agent.v2' : undefined,
      jobId, jobDir, status: 'awaiting-agent', agentStage: 'generation',
      awaitingAgentAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    for (const file of ['index.html', 'styles.css', 'script.js']) {
      writeFileSync(join(jobDir, 'agent', 'prototype-source', file), `original-${file}`)
      writeFileSync(join(jobDir, 'agent', 'draft', file), `edited-${file}`)
    }
    writeFileSync(join(jobDir, 'job.json'), JSON.stringify(job))
    return job
  }
  const batch = await prepareAgentPageBundleV2(bundle, {
    batchRoot, jobRoot, prepareSingleFn: prepare,
    agentRetryLimit: options.agentRetryLimit,
  })
  return { batch, batchRoot, jobRoot }
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for test condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function writeResponsiveInput(root) {
  writeSingleInput(join(root, 'variants', 'desktop', '00-input'), 'home-desktop', '首页', 1440)
  writeSingleInput(join(root, 'variants', 'mobile', '00-input'), 'home-mobile', '首页-移动端', 375)
  writeFileSync(join(root, 'mastergo-responsive-page.json'), JSON.stringify({ version: 'mastergo2html.responsive-page.v1', page: { name: '首页', baseName: '首页' }, variants: {
    desktop: { name: '首页', sourceNodeId: 'home-desktop', inputDir: 'variants/desktop/00-input', viewport: { width: 1440, height: 900 } },
    mobile: { name: '首页-移动端', sourceNodeId: 'home-mobile', inputDir: 'variants/mobile/00-input', viewport: { width: 375, height: 900 } },
  } }))
}

function writeSingleInput(root, id, name, width) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'raw.json'), JSON.stringify({ page: { id: 'page', name }, selection: [{ id, name, type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width, height: 900 } }] }))
  writeFileSync(join(root, 'asset-manifest.json'), JSON.stringify({ assets: [] }))
  writeFileSync(join(root, 'export-options.json'), JSON.stringify({ exportOptions: { rawProfile: 'html' } }))
  writeFileSync(join(root, 'frame-screenshot.png'), Buffer.from([137, 80, 78, 71]))
}

function updateJob(jobRoot, jobId, patch) {
  const path = join(jobRoot, jobId, 'job.json')
  const job = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...job, ...patch }))
}
