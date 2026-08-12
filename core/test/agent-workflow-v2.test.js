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
  assert.equal(readJson(prepared.layoutSketchPath).version, 'mastergo2html.layout-sketch.v1')
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
  const fontAssets = readJson(join(prepared.jobDir, '01-normalized', 'font-assets.json'))
  assert.equal(fontAssets.strategy, 'existing-assets-then-fallback')
})

test('Agent v2 begin is idempotent and accept-plan is a deprecated no-op', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mastergo-agent-v2-begin-'))
  const jobRoot = join(root, 'jobs')
  const prepared = await prepareAgentJob(createInput(root), { jobRoot, captureFn: skippedVisual })
  const first = beginAgentJob(prepared.jobId, { jobRoot })
  const second = beginAgentJob(prepared.jobId, { jobRoot })
  assert.equal(first.idempotent, false)
  assert.equal(second.idempotent, true)
  assert.equal(second.agentStartedAt, first.agentStartedAt)
  const accepted = await acceptAgentPlan(prepared.jobId, { jobRoot })
  assert.equal(accepted.deprecated, true)
  assert.equal(accepted.noOp, true)
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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
