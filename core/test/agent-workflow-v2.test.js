import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  acceptAgentPlan,
  beginAgentJob,
  finalizeAgentJob,
  getAgentJobStatus,
  prepareAgentJob,
  prepareAgentJobV1,
} from '../src/agent-workflow.js'
import { resetAgentAttemptV2 } from '../src/agent-workflow-v2.js'

const skippedVisual = async ({ reportDir, label }) => {
  mkdirSync(reportDir, { recursive: true })
  const reportPath = join(reportDir, `${label}-visual-report.json`)
  writeFileSync(reportPath, JSON.stringify({ status: 'skipped', blocking: false }), 'utf8')
  return { status: 'skipped', blocking: false, warnings: [], reportPath }
}
const skippedRuntime = async () => ({ status: 'skipped', ok: true, blocking: false, warnings: [] })

test('Agent v2 prepares an openable deterministic HTML draft without model or network configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-prepare-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createInput(root), { jobRoot, captureFn: skippedVisual })
  assert.equal(prepared.version, 'mastergo2html.codex-agent.v2')
  assert.equal(prepared.status, 'awaiting-agent')
  assert.equal(prepared.agentStage, 'generation')
  assert.equal(existsSync(join(prepared.draftDir, 'index.html')), true)
  assert.equal(existsSync(join(prepared.prototypeSourceDir, 'index.html')), true)
  assert.match(readFileSync(join(prepared.draftDir, 'index.html'), 'utf8'), /data-source-node-id="root"/)
  assert.match(readFileSync(join(prepared.draftDir, 'index.html'), 'utf8'), /Exact source text/)
  const layoutSketch = readJson(prepared.layoutSketchPath)
  assert.equal(layoutSketch.version, 'mastergo2html.layout-sketch.v2')
  assert.equal(layoutSketch.strategy, 'confidence-gated-hybrid-flow-draft')
  assert.match(layoutSketch.flowSkeleton.agentOwnership, /fixed canvas or root scaling/)
  assert.equal(existsSync(join(prepared.draftDir, 'assets', 'hero.png')), false)
  assert.equal(readJson(prepared.contextIndexPath).files.some((file) => file.path === 'agent/generation-brief.md'), true)
  const contextFiles = readJson(prepared.contextIndexPath).files
  assert.equal(contextFiles.some((file) => file.path === 'agent/agent-generation-playbook.md' && file.purpose === 'generation-method' && file.priority === 'always'), true)
  assert.equal(contextFiles.some((file) => file.path === 'agent/prototype-validation.json' && file.priority === 'always'), true)
  assert.equal(readJson(prepared.prototypeValidationPath).ok, true)
  const manifest = readJson(prepared.manifestPath)
  assert.equal(manifest.playbookVersion, 'mastergo2html.role-guidance.v2')
  assert.equal(manifest.playbookHash.length, 64)
  assert.equal(manifest.playbookPath, 'agent/agent-generation-playbook.md')
  const brief = readFileSync(prepared.generationBriefPath, 'utf8')
  assert.match(brief, /agent-generation-playbook\.md/)
  assert.match(brief, /prototype-validation\.json/)
  assert.match(brief, /frame-screenshot\.png/)
  assert.match(brief, /source-texts\.json/)
  assert.match(brief, /confidence-gated flow skeleton/)
  assert.match(brief, /Do not regress the complete page to a fixed canvas or root `transform: scale/)
  const fontAssets = readJson(join(prepared.jobDir, '01-normalized', 'font-assets.json'))
  assert.equal(fontAssets.strategy, 'existing-assets-then-fallback')
})

test('Agent v2 prepares paired desktop and mobile Frames as one responsive page job', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-responsive-prepare-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createResponsiveInput(root), { jobRoot, captureFn: skippedVisual })
  assert.equal(prepared.inputKind, 'responsive-page')
  assert.equal(prepared.status, 'awaiting-agent')
  assert.equal(existsSync(join(prepared.draftDir, 'index.html')), true)
  assert.equal(existsSync(join(prepared.jobDir, 'agent', 'reference-prototypes', 'mobile', 'index.html')), true)
  assert.equal(existsSync(join(prepared.jobDir, 'variants', 'desktop', '01-normalized', 'raw.normalized.json')), true)
  assert.equal(existsSync(join(prepared.jobDir, 'variants', 'mobile', '01-normalized', 'raw.normalized.json')), true)
  const responsiveContext = readJson(prepared.responsiveContextPath)
  assert.equal(responsiveContext.matchedNodes.some((item) => item.canonicalSourceNodeId === 'desktop-root' && item.mobileAliasSourceNodeId === 'mobile-root'), true)
  assert.equal(responsiveContext.mobileOnly.some((item) => item.sourceNodeId === 'mobile-root'), false)
  assert.equal(responsiveContext.matchedNodes.some((item) => item.canonicalSourceNodeId === 'desktop-title' && item.mobileAliasSourceNodeId === 'mobile-title'), true)
  assert.equal(responsiveContext.mobileOnly.some((item) => item.sourceNodeId === 'mobile-menu'), true)
  assert.equal(readJson(prepared.canonicalSourceTextsPath).some((item) => item.sourceNodeId === 'mobile-menu'), true)
  assert.equal(readJson(prepared.contextIndexPath).files.some((file) => file.path === 'agent/responsive-context.json' && file.priority === 'always'), true)
  assert.match(readFileSync(prepared.generationBriefPath, 'utf8'), /one semantic DOM/)
})

test('Agent v2 responsive finalize requires mobile-only content and publishes one output with two visual reports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-responsive-finalize-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createResponsiveInput(root), { jobRoot, captureFn: skippedVisual })
  beginAgentJob(prepared.jobId, { jobRoot })
  const htmlPath = join(prepared.draftDir, 'index.html')
  const cssPath = join(prepared.draftDir, 'styles.css')
  const html = readFileSync(htmlPath, 'utf8').replace('</body>', '  <button class="mobile-menu" data-source-node-id="mobile-menu" data-text-source-node-id="mobile-menu" data-style-source-node-id="mobile-menu">菜单</button>\n</body>')
  writeFileSync(htmlPath, html, 'utf8')
  writeFileSync(cssPath, `${readFileSync(cssPath, 'utf8')}\n.mobile-menu{display:none}\n@media(max-width:767px){.mg-prototype-root{width:100%;min-width:0;max-width:100%;height:auto;min-height:100vh}.mobile-menu{display:block}}\n@media(prefers-reduced-motion:reduce){*{transition:none!important}}\n`, 'utf8')
  const result = await finalizeAgentJob(prepared.jobId, {
    jobRoot,
    captureFn: skippedVisual,
    smokeTestFn: async () => {},
    responsiveRuntimeTestFn: skippedRuntime,
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'done')
  assert.equal(existsSync(join(result.outputDir, 'index.html')), true)
  assert.deepEqual(Object.keys(result.validation.variantVisuals), ['desktop', 'mobile'])
  assert.deepEqual(Object.keys(result.job.resultSummary.variantVisualReportPaths), ['desktop', 'mobile'])
})

test('Agent v2 responsive finalize blocks publication when mobile-only content is omitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-responsive-invalid-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createResponsiveInput(root), { jobRoot, captureFn: skippedVisual })
  const cssPath = join(prepared.draftDir, 'styles.css')
  writeFileSync(cssPath, `${readFileSync(cssPath, 'utf8')}\n@media(max-width:767px){.mg-prototype-root{width:100%;min-width:0;max-width:100%}}\n`, 'utf8')
  const result = await finalizeAgentJob(prepared.jobId, {
    jobRoot,
    captureFn: skippedVisual,
    smokeTestFn: async () => {},
    responsiveRuntimeTestFn: skippedRuntime,
  })
  assert.equal(result.ok, false)
  assert.equal(result.outputDir, null)
  assert.match(result.validation.errors.join('\n'), /mobile-menu|Mobile-only/)
})

test('Agent v2 responsive finalize promotes runtime layout failures to blocking errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-responsive-runtime-invalid-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createResponsiveInput(root), { jobRoot, captureFn: skippedVisual })
  const htmlPath = join(prepared.draftDir, 'index.html')
  const cssPath = join(prepared.draftDir, 'styles.css')
  writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8').replace('</body>', '<span data-text-source-node-id="mobile-menu" data-style-source-node-id="mobile-menu">菜单</span></body>'), 'utf8')
  writeFileSync(cssPath, `${readFileSync(cssPath, 'utf8')}\n@media(max-width:767px){.mg-prototype-root{width:100%;min-width:0;max-width:100%}}\n`, 'utf8')
  let receivedWidths = []
  const result = await finalizeAgentJob(prepared.jobId, {
    jobRoot,
    captureFn: skippedVisual,
    smokeTestFn: async () => {},
    responsiveRuntimeTestFn: async ({ contract }) => {
      receivedWidths = contract.viewports.map((viewport) => viewport.width)
      return { status: 'warning', ok: false, blocking: false, warnings: ['horizontal overflow at 375px'] }
    },
  })
  assert.deepEqual(receivedWidths, [375, 768, 1280, 1920, 2560])
  assert.equal(result.ok, false)
  assert.match(result.validation.errors.join('\n'), /Responsive runtime: horizontal overflow/)
})

test('Agent v2 begin is idempotent and accept-plan is a deprecated no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-begin-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createInput(root), { jobRoot, captureFn: skippedVisual })
  const first = beginAgentJob(prepared.jobId, { jobRoot })
  const second = beginAgentJob(prepared.jobId, { jobRoot })
  assert.equal(first.idempotent, false)
  assert.equal(first.job.status, 'agent-running')
  assert.equal(second.idempotent, true)
  assert.equal(second.agentStartedAt, first.agentStartedAt)
  const accepted = await acceptAgentPlan(prepared.jobId, { jobRoot })
  assert.equal(accepted.deprecated, true)
  assert.equal(accepted.noOp, true)
})

test('Agent v2 claimed batch jobs require the matching claim ID for begin and finalize', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-claim-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createInput(root), { jobRoot, captureFn: skippedVisual })
  updateJob(prepared.jobDir, {
    batch: { batchId: 'batch-1', batchDir: join(root, 'batches', 'batch-1') },
    claim: { claimId: 'claim-1', claimedAt: new Date().toISOString() },
  })

  assert.throws(() => beginAgentJob(prepared.jobId, { jobRoot }), /Claim ID is required/)
  assert.throws(() => beginAgentJob(prepared.jobId, { jobRoot, claimId: 'claim-wrong' }), /does not match/)
  const begun = beginAgentJob(prepared.jobId, { jobRoot, claimId: 'claim-1' })
  assert.equal(begun.job.status, 'agent-running')
  assert.equal(begun.job.claim.claimId, 'claim-1')
  assert.match(readJson(prepared.manifestPath).nextCommand, /--claim-id claim-1/)
  await assert.rejects(() => finalizeAgentJob(prepared.jobId, { jobRoot }), /Claim ID is required/)

  const stylesPath = join(prepared.draftDir, 'styles.css')
  writeFileSync(stylesPath, `${readFileSync(stylesPath, 'utf8')}\n@media(max-width:600px){.mg-prototype-root{max-width:100%}}\n`, 'utf8')
  const result = await finalizeAgentJob(prepared.jobId, {
    jobRoot,
    claimId: 'claim-1',
    captureFn: skippedVisual,
    smokeTestFn: async () => {},
    responsiveRuntimeTestFn: skippedRuntime,
  })
  assert.equal(result.status, 'done')
  assert.equal(result.job.claim.claimId, 'claim-1')
})

test('Agent v2 batch jobs cannot begin before the scheduler assigns a claim', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-unclaimed-batch-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createInput(root), { jobRoot, captureFn: skippedVisual })
  updateJob(prepared.jobDir, {
    batch: { batchId: 'batch-unclaimed', batchDir: join(root, 'batches', 'batch-unclaimed') },
  })
  assert.throws(() => beginAgentJob(prepared.jobId, { jobRoot }), /must be claimed/)
  await assert.rejects(() => finalizeAgentJob(prepared.jobId, { jobRoot }), /must be claimed/)
})

test('Agent v2 finalize resumes idempotently from validating without restarting Agent editing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-validating-resume-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createInput(root), { jobRoot, captureFn: skippedVisual })
  const begun = beginAgentJob(prepared.jobId, { jobRoot })
  const htmlPath = join(prepared.draftDir, 'index.html')
  const stylesPath = join(prepared.draftDir, 'styles.css')
  writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8').replace('</body>', '<!-- Agent edit preserved --></body>'), 'utf8')
  writeFileSync(stylesPath, `${readFileSync(stylesPath, 'utf8')}\n@media(max-width:600px){.mg-prototype-root{max-width:100%}}\n`, 'utf8')
  const agentFinishedAt = new Date(Date.parse(begun.agentStartedAt) + 10).toISOString()
  updateJob(prepared.jobDir, { status: 'validating', agentStage: 'validating', agentFinishedAt })

  const result = await finalizeAgentJob(prepared.jobId, {
    jobRoot,
    captureFn: skippedVisual,
    smokeTestFn: async () => {},
    responsiveRuntimeTestFn: skippedRuntime,
  })
  assert.equal(result.status, 'done')
  assert.equal(result.job.agentStartedAt, begun.agentStartedAt)
  assert.equal(result.job.agentFinishedAt, agentFinishedAt)
  assert.equal(result.job.timings.agentMs, 10)
  assert.match(readFileSync(join(result.outputDir, 'index.html'), 'utf8'), /Agent edit preserved/)
})

test('Agent v2 reset restores only draft code and clears failed attempt state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-reset-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createInput(root), { jobRoot, captureFn: skippedVisual })
  updateJob(prepared.jobDir, {
    batch: { batchId: 'batch-reset', batchDir: join(root, 'batches', 'batch-reset') },
    claim: { claimId: 'claim-reset', claimedAt: new Date().toISOString() },
  })
  beginAgentJob(prepared.jobId, { jobRoot, claimId: 'claim-reset' })
  const assetPath = join(prepared.draftDir, 'assets', 'worker-note.txt')
  mkdirSync(join(prepared.draftDir, 'assets'), { recursive: true })
  writeFileSync(assetPath, 'preserve asset', 'utf8')
  const factPath = join(prepared.jobDir, '01-normalized', 'source-texts.json')
  const factBefore = readFileSync(factPath, 'utf8')
  for (const file of ['index.html', 'styles.css', 'script.js']) writeFileSync(join(prepared.draftDir, file), `worker changed ${file}`, 'utf8')

  assert.throws(
    () => resetAgentAttemptV2(prepared.jobId, { jobRoot, claimId: 'wrong', reason: 'worker exited' }),
    /does not match/,
  )
  const reset = resetAgentAttemptV2(prepared.jobId, { jobRoot, claimId: 'claim-reset', reason: 'worker exited' })
  assert.equal(reset.status, 'awaiting-agent')
  assert.equal(reset.job.claim, undefined)
  assert.equal(reset.job.agentStartedAt, undefined)
  assert.equal(reset.job.agentFinishedAt, undefined)
  assert.equal(reset.job.lastAttemptFailure.claimId, 'claim-reset')
  assert.equal(reset.job.lastAttemptFailure.reason, 'worker exited')
  for (const file of ['index.html', 'styles.css', 'script.js']) {
    assert.equal(
      readFileSync(join(prepared.draftDir, file), 'utf8'),
      readFileSync(join(prepared.prototypeSourceDir, file), 'utf8'),
    )
  }
  assert.equal(readFileSync(assetPath, 'utf8'), 'preserve asset')
  assert.equal(readFileSync(factPath, 'utf8'), factBefore)
  assert.equal(existsSync(join(prepared.jobDir, 'job.json.tmp')), false)
})

test('Agent v2 successful finalize preserves first pass and publishes output once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-success-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createInput(root), { jobRoot, captureFn: skippedVisual })
  beginAgentJob(prepared.jobId, { jobRoot })
  const stylesPath = join(prepared.draftDir, 'styles.css')
  writeFileSync(stylesPath, `${readFileSync(stylesPath, 'utf8')}\n@media(max-width:600px){.mg-prototype-root{max-width:100%}}\n@media(prefers-reduced-motion:reduce){*{transition:none!important}}\n`, 'utf8')
  const result = await finalizeAgentJob(prepared.jobId, {
    jobRoot,
    captureFn: skippedVisual,
    smokeTestFn: async () => {},
    responsiveRuntimeTestFn: skippedRuntime,
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'done')
  assert.equal(existsSync(join(result.firstPassDir, 'index.html')), true)
  assert.equal(existsSync(result.firstPassZipPath), true)
  assert.equal(existsSync(join(result.outputDir, 'index.html')), true)
  assert.equal(existsSync(result.zipPath), true)
  assert.deepEqual(Object.keys(result.job.timings), ['prepareMs', 'handoffWaitMs', 'agentMs', 'finalizeMs', 'activeTotalMs', 'jobWallMs'])
  assert.equal(result.job.timings.activeTotalMs, result.job.timings.prepareMs + result.job.timings.agentMs + result.job.timings.finalizeMs)
})

test('Agent v2 invalid finalize keeps preview and ZIP without publishing output or requesting repair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-invalid-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createInput(root), { jobRoot, captureFn: skippedVisual })
  const previousOutput = join(prepared.jobDir, '05-output')
  mkdirSync(previousOutput, { recursive: true })
  writeFileSync(join(previousOutput, 'previous.txt'), 'keep', 'utf8')
  writeFileSync(join(prepared.draftDir, 'styles.css'), '.broken {', 'utf8')
  const result = await finalizeAgentJob(prepared.jobId, {
    jobRoot,
    captureFn: skippedVisual,
    smokeTestFn: async () => {},
    responsiveRuntimeTestFn: skippedRuntime,
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'first-pass-invalid')
  assert.equal(existsSync(join(result.firstPassDir, 'index.html')), true)
  assert.equal(existsSync(result.firstPassZipPath), true)
  assert.equal(result.outputDir, null)
  assert.equal(readFileSync(join(previousOutput, 'previous.txt'), 'utf8'), 'keep')
  assert.equal(getAgentJobStatus(prepared.jobId, { jobRoot }) instanceof Promise, true)
  assert.equal((await getAgentJobStatus(prepared.jobId, { jobRoot })).job.agentStage, 'first-pass-invalid')
})

test('Agent v2 still packages a first pass when a required draft file was deleted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-missing-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createInput(root), { jobRoot, captureFn: skippedVisual })
  const { rmSync } = await import('node:fs')
  rmSync(join(prepared.draftDir, 'index.html'))
  const result = await finalizeAgentJob(prepared.jobId, {
    jobRoot,
    captureFn: skippedVisual,
    responsiveRuntimeTestFn: skippedRuntime,
  })
  assert.equal(result.status, 'first-pass-invalid')
  assert.equal(existsSync(result.firstPassZipPath), true)
  assert.match(result.validation.errors.join('\n'), /missing a valid index\.html/)
})

test('v1 remains explicitly available for page batches and legacy Agent compatibility', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v1-compat-'))
  const prepared = await prepareAgentJobV1(createInput(root), { jobRoot: join(root, 'jobs') })
  assert.equal(prepared.status, 'awaiting-codex')
  assert.equal(readJson(prepared.manifestPath).version, 'mastergo2html.codex-agent.v1')
})

test('Agent v2 static dependency graph excludes LLM and Codex SDK modules', () => {
  const root = join(import.meta.dirname, '..', 'src')
  const visited = new Set()
  const visit = (path) => {
    if (visited.has(path)) return
    visited.add(path)
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /@openai\/codex-sdk|mcp-server\/src\/llm|\/llm\//)
    for (const match of source.matchAll(/from\s+["'](\.\.?\/[^"']+)["']/g)) {
      if (match[1].includes('agent-workflow-v1')) continue
      const target = join(import.meta.dirname, '..', 'src', match[1].replace(/^\.\//, ''))
      if (target.endsWith('.js') && existsSync(target)) visit(target)
    }
  }
  visit(join(root, 'agent-workflow-v2.js'))
})

function createInput(root) {
  const inputDir = join(root, `input-${Date.now()}-${Math.random()}`)
  mkdirSync(join(inputDir, 'assets'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), Buffer.from([137, 80, 78, 71]))
  writeFileSync(join(inputDir, 'assets', 'hero.png'), Buffer.from([137, 80, 78, 71]))
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    page: { id: 'page-1', name: 'Agent v2 fixture' },
    selection: [{
      id: 'root', name: 'Page', type: 'FRAME', isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 600 },
      children: [{
        id: 'text', name: 'Title', type: 'TEXT', role: 'text', isVisible: true, characters: 'Exact source text',
        absoluteBoundingBox: { x: 40, y: 30, width: 200, height: 30 },
        fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
        fontFamily: 'Fixture Sans', fontSize: 20, fontWeight: 600,
      }],
    }],
  }), 'utf8')
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({ version: 'mastergo2html.asset-manifest.v1', assets: [], files: ['assets/hero.png'] }), 'utf8')
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({
    exportOptions: { rawProfile: 'html', targetPlatform: 'web' },
    source: { pageId: 'page-1', pageName: 'Agent v2 fixture', selectionIds: ['root'], selectionCount: 1 },
  }), 'utf8')
  return inputDir
}

function updateJob(jobDir, patch) {
  const path = join(jobDir, 'job.json')
  writeFileSync(path, `${JSON.stringify({ ...readJson(path), ...patch }, null, 2)}\n`, 'utf8')
}

function createResponsiveInput(root) {
  const bundleDir = join(root, `responsive-${Date.now()}-${Math.random()}`)
  const desktop = createVariantInput(bundleDir, 'desktop', {
    frameId: 'desktop-root',
    frameName: '校招资讯-应届生Q&A',
    width: 1920,
    height: 1000,
    texts: [
      { id: 'desktop-title', name: 'Title', text: '应届生 Q&A', x: 80, y: 60, width: 320, height: 48 },
    ],
  })
  const mobile = createVariantInput(bundleDir, 'mobile', {
    frameId: 'mobile-root',
    frameName: '校招资讯-应届生Q&A-移动端',
    width: 375,
    height: 900,
    texts: [
      { id: 'mobile-title', name: 'Title', text: '应届生 Q&A', x: 20, y: 24, width: 220, height: 36 },
      { id: 'mobile-menu', name: 'Mobile menu', text: '菜单', x: 320, y: 20, width: 40, height: 32 },
    ],
  })
  writeFileSync(join(bundleDir, 'mastergo-responsive-page.json'), JSON.stringify({
    version: 'mastergo2html.responsive-page.v1',
    source: { pageId: 'page-1', pageName: 'Recruitment' },
    page: { name: '校招资讯-应届生Q&A', baseName: '校招资讯-应届生Q&A' },
    breakpoints: { mobileMax: 767 },
    variants: {
      desktop: { name: '校招资讯-应届生Q&A', sourceNodeId: 'desktop-root', inputDir: desktop, viewport: { width: 1920, height: 1000 } },
      mobile: { name: '校招资讯-应届生Q&A-移动端', sourceNodeId: 'mobile-root', inputDir: mobile, viewport: { width: 375, height: 900 } },
    },
  }), 'utf8')
  return bundleDir
}

function createVariantInput(bundleDir, kind, fixture) {
  const relativeInputDir = `variants/${kind}/00-input`
  const inputDir = join(bundleDir, relativeInputDir)
  mkdirSync(join(inputDir, 'assets'), { recursive: true })
  const children = fixture.texts.map((item) => ({
    id: item.id,
    name: item.name,
    type: 'TEXT',
    role: 'text',
    isVisible: true,
    characters: item.text,
    absoluteBoundingBox: { x: item.x, y: item.y, width: item.width, height: item.height },
    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }],
    fontFamily: 'Arial',
    fontSize: 20,
    fontWeight: 600,
  }))
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    page: { id: 'page-1', name: 'Recruitment' },
    selection: [{
      id: fixture.frameId,
      name: fixture.frameName,
      type: 'FRAME',
      isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: fixture.width, height: fixture.height },
      children,
    }],
  }), 'utf8')
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({ version: 'mastergo2html.asset-manifest.v1', assets: [], files: [] }), 'utf8')
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({
    exportOptions: { rawProfile: 'html', targetPlatform: 'web' },
    source: { pageId: 'page-1', pageName: 'Recruitment', selectionIds: [fixture.frameId], selectionCount: 1 },
  }), 'utf8')
  writeFileSync(join(inputDir, 'frame-screenshot.png'), Buffer.from([137, 80, 78, 71]))
  return relativeInputDir
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
