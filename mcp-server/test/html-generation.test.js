import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildHtmlGenerationContext, parseGeneratedFiles, runHtmlGeneration, validateGeneratedFiles } from '../src/workflow/html-generation.js'

test('html generation context reads stage two through stage seven inputs without normalized raw', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  assert.equal(context.pageLayout.page.baseViewport.width, 1920)
  assert.equal(context.assemblyPlan, '# assembly\n')
  assert.equal('normalizedRaw' in context, false)
})

test('generated files parser accepts strict JSON and rejects missing files', () => {
  const files = parseGeneratedFiles(JSON.stringify(validFiles()))
  assert.match(files.indexHtml, /styles\.css/)
  assert.throws(() => parseGeneratedFiles('{"index.html":"x"}'), /styles\.css/)
})

test('static validation rejects network and traversal paths', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': '<html><body><img src="../secret.png"><img src="https://example.com/image.png"><script src="script.js"></script><link href="styles.css" rel="stylesheet"></body></html>',
  }))
  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /网络资源/)
  assert.match(validation.errors.join('\n'), /输出目录之外/)
})

test('full generation copies all assets and publishes a directly openable page', async () => {
  const jobDir = createFixtureJob()
  let calls = 0
  const result = await runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-1',
    jobDir,
    smokeTestFn: async () => {},
    generateTextFn: async () => {
      calls += 1
      return { text: JSON.stringify(validFiles()), usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.tokenUsage.totalTokens, 30)
  assert.equal(existsSync(join(jobDir, '05-output', 'index.html')), true)
  assert.equal(existsSync(join(jobDir, '05-output', 'assets', 'rendered', 'hero.png')), true)
  assert.match(readFileSync(join(jobDir, '05-output', 'index.html'), 'utf8'), /<!doctype html>/i)
  assert.equal(JSON.parse(readFileSync(join(jobDir, '05-output', 'static-validation.json'), 'utf8')).ok, true)
})

test('format errors receive one correction attempt and preserve both raw responses', async () => {
  const jobDir = createFixtureJob()
  let calls = 0
  await runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-format-retry',
    jobDir,
    smokeTestFn: async () => {},
    generateTextFn: async () => {
      calls += 1
      return { text: calls === 1 ? 'not json' : JSON.stringify(validFiles()), usage: {} }
    },
  })
  assert.equal(calls, 2)
  assert.equal(existsSync(join(jobDir, '05-output', 'html-generation.response.attempt-1.md')), true)
  assert.equal(existsSync(join(jobDir, '05-output', 'html-generation.response.attempt-2.md')), true)
})

test('static validation failure does not call the model again', async () => {
  const jobDir = createFixtureJob()
  let calls = 0
  await assert.rejects(() => runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-validation-failure',
    jobDir,
    smokeTestFn: async () => {},
    generateTextFn: async () => {
      calls += 1
      return { text: JSON.stringify({ ...validFiles(), 'styles.css': 'body {' }), usage: {} }
    },
  }), /静态校验失败/)
  assert.equal(calls, 1)
  assert.equal(existsSync(join(jobDir, '.05-output-tmp', 'static-validation.json')), true)
})

function createFixtureJob() {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo2html-generation-'))
  for (const directory of ['00-input/assets/rendered', '01-normalized', '02-layout', '03-page-plans', '04-assembly']) mkdirSync(join(jobDir, directory), { recursive: true })
  writeFileSync(join(jobDir, '00-input', 'assets', 'rendered', 'hero.png'), 'png')
  writeFileSync(join(jobDir, '01-normalized', 'asset-index.json'), JSON.stringify({ assets: [{ assetId: 'img_1', usage: 'content-image', preferred: { copiedPath: 'assets/rendered/hero.png' }, rendered: [{ path: 'assets/rendered/hero.png' }] }] }))
  writeFileSync(join(jobDir, '01-normalized', 'design-tokens.json'), JSON.stringify({ tokens: {} }))
  writeFileSync(join(jobDir, '02-layout', 'page-layout.json'), JSON.stringify({ page: { baseViewport: { width: 1920, height: 1080 } } }))
  writeFileSync(join(jobDir, '02-layout', 'page-layout.md'), '# layout\n')
  writeFileSync(join(jobDir, '03-page-plans', 'component-structure.plan.md'), '# components\n')
  writeFileSync(join(jobDir, '03-page-plans', 'static-assets.plan.md'), '# assets\n')
  writeFileSync(join(jobDir, '03-page-plans', 'interaction.plan.md'), '# interaction\n')
  writeFileSync(join(jobDir, '04-assembly', 'assembly.plan.md'), '# assembly\n')
  return jobDir
}

function validFiles() {
  return {
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main><img src="assets/rendered/hero.png" data-asset-id="img_1"></main><script src="script.js"></script></body></html>',
    'styles.css': ':root { --color: #000; } body { margin: 0; }',
    'script.js': 'document.documentElement.dataset.ready = "true";',
  }
}
