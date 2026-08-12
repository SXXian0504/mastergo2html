import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  acceptAgentPlan,
  finalizeAgentJob,
  getAgentBatchStatus,
  getAgentJobStatus,
  prepareAgentPageBundle,
  prepareAgentJob,
} from '../src/agent-workflow-v1.js'

test('codex-agent workflow prepares facts, accepts one plan, and finalizes direct files without a JSON envelope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-workflow-'))
  const inputDir = createInput(root)
  const prepared = await prepareAgentJob(inputDir, { jobRoot: join(root, 'jobs') })

  assert.equal(prepared.status, 'awaiting-codex')
  assert.equal(prepared.agentStage, 'planning')
  assert.equal(getAgentJobStatus(prepared.jobId, { jobRoot: join(root, 'jobs') }).manifest.stage, 'planning')
  assert.match(readFileSync(prepared.constraintPackPath, 'utf8'), /layout\.source-fidelity/)
  assert.equal(readJson(prepared.contextIndexPath).files.some((file) => file.path === 'agent/constraint-pack.md' && file.priority === 'always'), true)

  const template = readJson(prepared.planTemplatePath)
  completeAgentPlan(template)
  writeFileSync(prepared.planPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8')

  const accepted = acceptAgentPlan(prepared.jobId, { jobRoot: join(root, 'jobs') })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.manifest.stage, 'generation')

  writeFileSync(join(prepared.draftDir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main></main><script src="script.js"></script></body></html>', 'utf8')
  writeFileSync(join(prepared.draftDir, 'styles.css'), 'html,body{margin:0}main{min-height:100vh}', 'utf8')
  writeFileSync(join(prepared.draftDir, 'script.js'), 'document.documentElement.dataset.ready="true";', 'utf8')

  const finalized = await finalizeAgentJob(prepared.jobId, {
    jobRoot: join(root, 'jobs'),
    smokeTestFn: async () => {},
    responsiveRuntimeTestFn: async () => ({ status: 'skipped', ok: true, warnings: [] }),
  })

  assert.equal(finalized.ok, true)
  assert.equal(finalized.validation.transport.mode, 'direct-files')
  assert.equal(finalized.validation.transport.jsonEnvelopeParsed, false)
  assert.equal(finalized.validation.constraintCoverage.status, 'passed')
  assert.equal(finalized.validation.constraintCoverage.uncoveredIds.length, 0)
  assert.equal(readJson(join(finalized.outputDir, 'static-validation.json')).transport.jsonEnvelopeParsed, false)
})

test('agent plan validation rejects placeholder modules before generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-plan-invalid-'))
  const prepared = await prepareAgentJob(createInput(root), { jobRoot: join(root, 'jobs') })
  const template = readFileSync(prepared.planTemplatePath, 'utf8')
  writeFileSync(prepared.planPath, template, 'utf8')

  assert.throws(
    () => acceptAgentPlan(prepared.jobId, { jobRoot: join(root, 'jobs') }),
    /implementationNotes 不能为空|responsiveDecisions 必须包含非空决策/,
  )
  assert.equal(getAgentJobStatus(prepared.jobId, { jobRoot: join(root, 'jobs') }).job.status, 'needs-repair')
})

test('agent finalization persists missing draft files as a repair state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-missing-draft-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createInput(root), { jobRoot })
  const template = readJson(prepared.planTemplatePath)
  completeAgentPlan(template)
  writeFileSync(prepared.planPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8')
  acceptAgentPlan(prepared.jobId, { jobRoot })

  const result = await finalizeAgentJob(prepared.jobId, { jobRoot })
  assert.equal(result.status, 'needs-repair')
  assert.match(result.validation.errors[0], /缺少有效文件/)
  assert.equal(getAgentJobStatus(prepared.jobId, { jobRoot }).job.agentStage, 'repair')
})

test('agent rejects constraint pack drift before accepting a plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-constraint-drift-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createInput(root), { jobRoot })
  const template = readJson(prepared.planTemplatePath)
  completeAgentPlan(template)
  writeFileSync(prepared.planPath, `${JSON.stringify(template, null, 2)}\n`, 'utf8')
  writeFileSync(prepared.constraintPackPath, `${readFileSync(prepared.constraintPackPath, 'utf8')}\nchanged\n`, 'utf8')
  assert.throws(() => acceptAgentPlan(prepared.jobId, { jobRoot }), /约束包.*发生变化/)
})

test('agent plan template preserves the App generation target', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-app-target-'))
  const inputDir = createInput(root)
  const optionsPath = join(inputDir, 'export-options.json')
  const options = readJson(optionsPath)
  options.exportOptions.targetPlatform = 'app'
  writeFileSync(optionsPath, `${JSON.stringify(options, null, 2)}\n`, 'utf8')

  const prepared = await prepareAgentJob(inputDir, { jobRoot: join(root, 'jobs') })
  const template = readJson(prepared.planTemplatePath)
  assert.equal(template.page.generationTarget, 'app')
  assert.equal(readJson(prepared.constraintManifestPath).target, 'app')
})

test('codex-agent page batches keep page contexts isolated and aggregate persisted job state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-batch-'))
  const bundleDir = join(root, 'bundle')
  const pages = [
    createBundlePage(bundleDir, 'home', '/'),
    createBundlePage(bundleDir, 'about', '/about'),
  ]
  writeFileSync(join(bundleDir, 'mastergo-pages.json'), JSON.stringify({
    version: 'mastergo2html.page-bundle.v1',
    source: { pageId: 'website', pageName: 'Website' },
    pages,
  }), 'utf8')

  const batchRoot = join(root, 'batches')
  const jobRoot = join(root, 'jobs')
  const batch = await prepareAgentPageBundle(bundleDir, { batchRoot, jobRoot })
  assert.equal(batch.status, 'awaiting-codex')
  assert.equal(batch.summary.total, 2)
  assert.equal(new Set(batch.pages.map((page) => page.jobId)).size, 2)
  assert.equal(batch.nextPage.jobId, batch.pages[0].jobId)
  assert.equal(Object.hasOwn(batch.pages[0], 'contextIndex'), false)
  assert.match(batch.pages[0].contextIndexPath, /context-index\.json$/)

  const firstJobPath = join(jobRoot, batch.pages[0].jobId, 'job.json')
  const firstJob = readJson(firstJobPath)
  writeFileSync(firstJobPath, `${JSON.stringify({ ...firstJob, status: 'done', agentStage: 'done', outputDir: join(root, 'home-output') }, null, 2)}\n`, 'utf8')
  const refreshed = getAgentBatchStatus(batch.batchId, { batchRoot })
  assert.equal(refreshed.summary.done, 1)
  assert.equal(refreshed.nextPage.jobId, batch.pages[1].jobId)

  for (const page of batch.pages) {
    const jobPath = join(jobRoot, page.jobId, 'job.json')
    const job = readJson(jobPath)
    writeFileSync(jobPath, `${JSON.stringify({ ...job, status: 'done', agentStage: 'done', outputDir: join(root, `${page.id}-output`) }, null, 2)}\n`, 'utf8')
  }
  const completed = getAgentBatchStatus(batch.batchId, { batchRoot })
  assert.equal(completed.status, 'done')
  assert.match(completed.mergePrepareCommand, /prepare_inputs\.py/)
  assert.match(completed.mergePrepareCommand, /--page/)
})

function createInput(root) {
  const inputDir = join(root, `input-${Date.now()}-${Math.random()}`)
  mkdirSync(join(inputDir, 'assets'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), Buffer.from([137, 80, 78, 71]))
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    page: { id: 'page-1', name: 'Agent fixture' },
    selection: [{
      id: 'root',
      name: '页面',
      type: 'FRAME',
      isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
      children: [],
    }],
  }), 'utf8')
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [],
    files: [],
  }), 'utf8')
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({
    exportOptions: { rawProfile: 'html' },
    source: { pageId: 'page-1', pageName: 'Agent fixture', selectionIds: ['root'], selectionCount: 1 },
  }), 'utf8')
  return inputDir
}

function createBundlePage(bundleDir, id, route) {
  const inputDir = join(bundleDir, 'pages', id, '00-input')
  createInputAt(inputDir, id)
  return { id, name: id, route, sourceNodeId: `${id}-root`, inputDir: `pages/${id}/00-input` }
}

function createInputAt(inputDir, name) {
  mkdirSync(join(inputDir, 'assets'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), Buffer.from([137, 80, 78, 71]))
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    page: { id: `${name}-page`, name },
    selection: [{
      id: `${name}-root`,
      name,
      type: 'FRAME',
      isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
      children: [],
    }],
  }), 'utf8')
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [],
    files: [],
  }), 'utf8')
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({
    exportOptions: { rawProfile: 'html' },
    source: { pageId: `${name}-page`, pageName: name, selectionIds: [`${name}-root`], selectionCount: 1 },
  }), 'utf8')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function completeAgentPlan(template) {
  template.responsiveDecisions = ['390/768 使用流式宽度，桌面保持基准坐标。']
  for (const module of template.modules) module.implementationNotes = '按 page-layout.json、共享约束和节点事实实现。'
  for (const decision of template.constraintDecisions || []) decision.decision = '按 constraint-pack.md 执行并在对应模块中验证。'
  return template
}
