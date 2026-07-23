import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildHtmlGenerationContext, parseGeneratedFiles, runHtmlGeneration, validateGeneratedFiles } from '../src/workflow/html-generation.js'

test('html generation context reads compact node style facts without exposing normalized raw', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  assert.equal(context.pageLayout.page.baseViewport.width, 1920)
  assert.equal(context.assemblyPlan, '# assembly\n')
  assert.equal('normalizedRaw' in context, false)
  assert.equal(context.nodeStyleFacts.version, 'mastergo2html.node-style-facts.v1')
  assert.deepEqual(context.sourceTexts.map((item) => item.characters), ['算法工程师', '岗位职责', '1.负责原文执行。', '立即投递'])
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

test('static validation rejects black image-frame default background', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': '.image-frame { background: #000; } .image-frame.is-missing { background: #000; }',
  }))
  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /默认态不得使用黑色背景/)
})

test('static validation rejects vertical scroll locks on the body root class', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<body>', '<body class="page">'),
    'styles.css': `${validFiles()['styles.css']} .page { min-height: 100vh; overflow: hidden; }`,
  }))
  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /不得禁用纵向滚动/)
})

test('static validation allows horizontal-only clipping on the body root class', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<body>', '<body class="page">'),
    'styles.css': `${validFiles()['styles.css']} .page { min-height: 100vh; overflow-x: hidden; }`,
  }))
  assert.equal(validateGeneratedFiles(files, context).ok, true)
})

test('static validation rejects rewritten source text', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main><h1>算法岗位</h1><p>负责执行。</p><button>立即投递</button><img class="image-frame" src="assets/rendered/hero.png" data-asset-id="img_1"></main><script src="script.js"></script></body></html>',
  }))
  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /缺少或改写设计稿原文/)
})

test('static validation enforces required node background bindings and exact colors', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.nodeStyleFacts = {
    facts: [{ sourceNodeId: 'footer-bg', resolvedBackgroundColor: '#edf4ff', bindingRequired: true }],
  }
  const boundHtml = validFiles()['index.html'].replace('<body>', '<body><footer data-style-source-node-id="footer-bg"></footer>')
  const correct = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': boundHtml,
    'styles.css': `${validFiles()['styles.css']} [data-style-source-node-id="footer-bg"] { background-color: var(--footer-bg); } :root { --footer-bg: #edf4ff; }`,
  }))
  assert.equal(validateGeneratedFiles(correct, context).ok, true)

  const wrong = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': boundHtml,
    'styles.css': `${validFiles()['styles.css']} [data-style-source-node-id="footer-bg"] { background-color: #000e26; }`,
  }))
  const wrongValidation = validateGeneratedFiles(wrong, context)
  assert.equal(wrongValidation.ok, false)
  assert.match(wrongValidation.errors.join('\n'), /footer-bg 应为 #edf4ff，实际为 #000e26/)

  const missingBinding = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.equal(missingBinding.ok, false)
  assert.match(missingBinding.errors.join('\n'), /缺少 HTML 绑定：footer-bg/)
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
  assert.match(readFileSync(join(jobDir, '05-output', 'html-generation.prompt.md'), 'utf8'), /透明背景约束适用于所有元素/)
  assert.match(readFileSync(join(jobDir, '05-output', 'html-generation.prompt.md'), 'utf8'), /node-style-facts\.json 是节点视觉样式的最高优先级事实源/)
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

test('static validation failure receives one correction attempt', async () => {
  const jobDir = createFixtureJob()
  let calls = 0
  await runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-validation-failure',
    jobDir,
    smokeTestFn: async () => {},
    generateTextFn: async () => {
      calls += 1
      return { text: JSON.stringify(calls === 1 ? { ...validFiles(), 'styles.css': 'body {' } : validFiles()), usage: {} }
    },
  })
  assert.equal(calls, 2)
  assert.equal(existsSync(join(jobDir, '05-output', 'static-validation.json')), true)
})

test('repeated static validation failure preserves the failed validation report', async () => {
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
  assert.equal(calls, 2)
  assert.equal(existsSync(join(jobDir, '.05-output-tmp', 'static-validation.json')), true)
})

function createFixtureJob() {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo2html-generation-'))
  for (const directory of ['00-input/assets/rendered', '01-normalized', '02-layout', '03-page-plans', '04-assembly']) mkdirSync(join(jobDir, directory), { recursive: true })
  writeFileSync(join(jobDir, '00-input', 'assets', 'rendered', 'hero.png'), 'png')
  writeFileSync(join(jobDir, '01-normalized', 'raw.normalized.json'), JSON.stringify({
    nodes: [{
      id: 'root',
      role: 'container',
      children: [
        { id: 'title', role: 'text', type: 'TEXT', name: '算法工程师', text: '算法工程师' },
        { id: 'section-title', role: 'text', type: 'TEXT', name: '岗位职责', text: '岗位职责' },
        { id: 'body', role: 'text', type: 'TEXT', name: '1.负责原文执行。', text: '1.负责原文执行。' },
        { id: 'button', role: 'text', type: 'TEXT', name: '立即投递', text: '立即投递' },
        { id: 'ignored', role: 'ignored', type: 'TEXT', name: '不应校验', text: '不应校验' },
      ],
    }],
  }))
  writeFileSync(join(jobDir, '01-normalized', 'source-texts.json'), JSON.stringify([
    { sourceNodeId: 'title', name: '算法工程师', characters: '算法工程师' },
    { sourceNodeId: 'section-title', name: '岗位职责', characters: '岗位职责' },
    { sourceNodeId: 'body', name: '1.负责原文执行。', characters: '1.负责原文执行。' },
    { sourceNodeId: 'button', name: '立即投递', characters: '立即投递' },
  ]))
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
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main><h1>算法工程师</h1><section><h2>岗位职责</h2><p>1.负责原文执行。</p></section><button type="button">立即投递</button><span class="image-frame"><img src="assets/rendered/hero.png" data-asset-id="img_1"></span></main><script src="script.js"></script></body></html>',
    'styles.css': ':root { --color: #000; } body { margin: 0; } .image-frame { background: transparent; } .image-frame.is-missing { background: #000; } .image-frame.is-missing img { display: none; }',
    'script.js': 'document.addEventListener("error", event => { const frame = event.target.closest(".image-frame"); if (frame) frame.classList.add("is-missing"); }, true);',
  }
}
