import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  IMPLEMENTATION_MANIFEST_VERSION,
  PLAN_AND_GENERATE_OUTPUT_SCHEMA,
  buildPlanAndGenerateContext,
  parsePlanAndGenerateResponse,
  runPlanAndGenerate,
  validateImplementationManifest,
} from '../src/workflow/plan-and-generate.js'

test('combined response parser enforces the compact manifest contract', () => {
  const parsed = parsePlanAndGenerateResponse(JSON.stringify(validResponse()))
  assert.equal(parsed.implementationManifest.version, IMPLEMENTATION_MANIFEST_VERSION)
  assert.match(parsed.files.indexHtml, /styles\.css/)
  assert.throws(() => parsePlanAndGenerateResponse(JSON.stringify({ ...validResponse(), extra: true })), /不允许的字段/)
  assert.throws(() => validateImplementationManifest({
    ...validManifest(),
    hoverTargets: Array.from({ length: 33 }, (_, index) => `target-${index}`),
  }), /最多 32 项/)
  assert.throws(() => validateImplementationManifest({
    ...validManifest(),
    conflictDecisions: [{ kind: 'layout', refs: [], decision: 'x'.repeat(241) }],
  }), /1-240 字符/)
})

test('plan-and-generate uses one structured model turn and publishes manifest plus files', async () => {
  const jobDir = createFixtureJob()
  let calls = 0
  let received
  const result = await runPlanAndGenerate({
    config: { provider: 'codex-sdk', model: 'test-model' },
    jobId: 'combined-job',
    jobDir,
    smokeTestFn: async () => {},
    responsiveRuntimeTestFn: async () => ({ ok: true, status: 'passed', warnings: [] }),
    generateTextFn: async (options) => {
      calls += 1
      received = options
      return { text: JSON.stringify(validResponse()), usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }
    },
  })

  assert.equal(calls, 1)
  assert.deepEqual(received.outputSchema, PLAN_AND_GENERATE_OUTPUT_SCHEMA)
  assert.match(received.system, /当前阶段同时负责页面级裁决和最终实现/)
  assert.doesNotMatch(received.prompt, /page-layout\.md|assembly\.plan\.md/)
  assert.equal(result.tokenUsage.totalTokens, 30)
  assert.equal(existsSync(join(jobDir, '04-assembly')), false)
  assert.equal(existsSync(join(jobDir, '05-output', 'implementation-manifest.json')), true)
  assert.equal(existsSync(join(jobDir, '05-output', 'index.html')), true)
  assert.equal(existsSync(join(jobDir, '05-output', 'assets', 'rendered', 'hero.png')), true)
  assert.equal(JSON.parse(readFileSync(join(jobDir, '05-output', 'implementation-manifest.json'), 'utf8')).hoverRequired, false)
  assert.equal(JSON.parse(readFileSync(join(jobDir, '05-output', 'static-validation.json'), 'utf8')).constraintCoverage.delivery, 'legacy-phase-prompt')
})

test('plan-and-generate preserves an existing published output when response parsing fails', async () => {
  const jobDir = createFixtureJob()
  mkdirSync(join(jobDir, '05-output'), { recursive: true })
  writeFileSync(join(jobDir, '05-output', 'index.html'), 'previous output')

  await assert.rejects(runPlanAndGenerate({
    config: { provider: 'codex-sdk', model: 'test-model' },
    jobId: 'broken-job',
    jobDir,
    generateTextFn: async () => ({ text: '{"implementationManifest":', usage: {} }),
  }), /模型输出疑似被截断/)

  assert.equal(readFileSync(join(jobDir, '05-output', 'index.html'), 'utf8'), 'previous output')
  assert.equal(existsSync(join(jobDir, '.05-output-tmp', 'plan-and-generate.response.md')), true)
})

test('combined context reads authoritative JSON and never requires assembly output', () => {
  const jobDir = createFixtureJob()
  const context = buildPlanAndGenerateContext(jobDir)
  assert.equal(context.pageLayout.page.baseViewport.width, 1920)
  assert.equal('pageLayoutDescription' in context, false)
  assert.equal('assemblyPlan' in context, false)
})

function createFixtureJob() {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo2html-combined-'))
  for (const directory of ['00-input/assets/rendered', '01-normalized', '02-layout', '03-page-plans']) {
    mkdirSync(join(jobDir, directory), { recursive: true })
  }
  writeFileSync(join(jobDir, '00-input', 'assets', 'rendered', 'hero.png'), 'png')
  writeFileSync(join(jobDir, '01-normalized', 'raw.normalized.json'), JSON.stringify({
    nodes: [{
      id: 'root',
      role: 'container',
      children: [
        { id: 'title', role: 'text', type: 'TEXT', name: '算法工程师', text: '算法工程师' },
        { id: 'section-title', role: 'text', type: 'TEXT', name: '岗位职责', text: '岗位职责' },
        { id: 'body', role: 'text', type: 'TEXT', name: '负责原文执行。', text: '负责原文执行。' },
        { id: 'button', role: 'text', type: 'TEXT', name: '立即投递', text: '立即投递' },
      ],
    }],
  }))
  writeFileSync(join(jobDir, '01-normalized', 'source-texts.json'), JSON.stringify([
    { sourceNodeId: 'title', name: '算法工程师', characters: '算法工程师' },
    { sourceNodeId: 'section-title', name: '岗位职责', characters: '岗位职责' },
    { sourceNodeId: 'body', name: '负责原文执行。', characters: '负责原文执行。' },
    { sourceNodeId: 'button', name: '立即投递', characters: '立即投递' },
  ]))
  writeFileSync(join(jobDir, '01-normalized', 'asset-index.json'), JSON.stringify({
    assets: [{ assetId: 'img_1', usage: 'content-image', preferred: { copiedPath: 'assets/rendered/hero.png' }, rendered: [{ path: 'assets/rendered/hero.png' }] }],
  }))
  writeFileSync(join(jobDir, '01-normalized', 'design-tokens.json'), JSON.stringify({ tokens: {} }))
  writeFileSync(join(jobDir, '02-layout', 'page-layout.json'), JSON.stringify({ page: { baseViewport: { width: 1920, height: 1080 } } }))
  writeFileSync(join(jobDir, '03-page-plans', 'component-structure.plan.md'), '# components\n')
  writeFileSync(join(jobDir, '03-page-plans', 'static-assets.plan.md'), '# assets\n')
  writeFileSync(join(jobDir, '03-page-plans', 'interaction.plan.md'), '# interaction\n')
  return jobDir
}

function validManifest() {
  return {
    version: IMPLEMENTATION_MANIFEST_VERSION,
    hoverRequired: false,
    hoverTargets: [],
    motionRequired: false,
    preserveSourceBounds: true,
    conflictDecisions: [],
    unresolvedRisks: [],
  }
}

function validResponse() {
  return {
    implementationManifest: validManifest(),
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main><h1 data-text-source-node-id="title">算法工程师</h1><section><h2 data-text-source-node-id="section-title">岗位职责</h2><p data-text-source-node-id="body">负责原文执行。</p></section><button type="button" data-text-source-node-id="button">立即投递</button><span class="image-frame"><img src="assets/rendered/hero.png" data-asset-id="img_1"></span></main><script src="script.js"></script></body></html>',
    'styles.css': ':root { --color: #000; } body { margin: 0; } .image-frame { background: transparent; } .image-frame.is-missing { background: #000; } .image-frame.is-missing img { display: none; }',
    'script.js': 'document.addEventListener("error", event => { const frame = event.target.closest(".image-frame"); if (frame) frame.classList.add("is-missing"); }, true);',
  }
}
