import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildHtmlGenerationContext, isLikelyTruncatedJsonError, parseGeneratedFiles, runHtmlGeneration, validateGeneratedFiles } from '../src/workflow/html-generation.js'

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

test('static validation allows runtime backdrop filters and blur effects', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} .job-card { backdrop-filter: blur(31px); -webkit-backdrop-filter: blur(31px); } .decor-glow { filter: blur(80px); } .page-background { filter: blur(12px); }`,
  }))
  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, true)
})

test('static validation warns about non-blur CSS filter costs', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  const validation = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} .logo { filter: drop-shadow(0 2px 8px rgba(0,0,0,.2)); }`,
  })), context)
  assert.equal(validation.ok, true)
  assert.match(validation.warnings.join('\n'), /CSS filter 可能增加绘制成本/)
})

test('static validation rejects decorative background layers used as layout spacing', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout = {
    modules: [{
      moduleId: 'module_03_content-section',
      type: 'content-section',
      bounds: { x: 212, y: 509, width: 1496, height: 2472 },
      backgroundLayers: [{
        sourceNodeId: '114:69036',
        bounds: { x: 212, y: 509, width: 1496, height: 2400 },
        affectsFlow: false,
      }],
      contentFlow: {
        firstContentY: 837,
        items: [{ sourceNodeId: '114:68789', bounds: { x: 588, y: 837, width: 190, height: 33 } }],
      },
      spacing: { outer: { top: 83 } },
    }],
  }
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} .jobs-workspace { padding-top: 328px; } .jobs-workspace::before { height: 2400px; }`,
  }))

  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /背景层不得制造内容流空间/)
})

test('static validation allows bound decorative layer own dimensions', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout = {
    modules: [{
      moduleId: 'module_01_hero',
      type: 'hero',
      bounds: { x: 0, y: 0, width: 1920, height: 420 },
      backgroundLayers: [{
        sourceNodeId: '114:68771',
        bounds: { x: 723, y: -1111, width: 1383, height: 1383 },
        affectsFlow: false,
      }],
      contentFlow: {
        firstContentY: 128,
        items: [{ sourceNodeId: 'title', bounds: { x: 416, y: 128, width: 200, height: 67 } }],
      },
    }],
  }
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<main>', '<main><div class="page-decorations__blur-circle--57" data-source-node-id="114:68771"></div>'),
    'styles.css': `${validFiles()['styles.css']} .page-decorations__blur-circle--57 { position:absolute; left:723px; top:-1111px; width:1383px; height:1383px; }`,
  }))

  assert.equal(validateGeneratedFiles(files, context).ok, true)
})

test('static validation still rejects unbound content spacing derived from background layer', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout = {
    modules: [{
      moduleId: 'module_03_footer',
      type: 'footer',
      bounds: { x: 0, y: 1613, width: 1920, height: 312 },
      backgroundLayers: [{
        sourceNodeId: '114:73525',
        bounds: { x: 0, y: 1613, width: 1920, height: 312 },
        affectsFlow: false,
      }],
      contentFlow: {
        firstContentY: 1698,
        items: [{ sourceNodeId: 'footer-title', bounds: { x: 1299, y: 1698, width: 64, height: 21 } }],
      },
    }],
  }
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} .job-apply { margin-top: 85px; }`,
  }))

  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /114:73525 的 85px 被用于 margin-top（\.job-apply）/)
})

test('static validation rejects hero background source bounds mechanically converted to CSS', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout = {
    modules: [{
      moduleId: 'module_01_hero',
      type: 'hero',
      bounds: { x: 0, y: 0, width: 1920, height: 600 },
      internalRegions: [{
        regionId: 'media',
        kind: 'media',
        bounds: { x: -786, y: -569, width: 2971, height: 1431 },
      }],
    }],
  }
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} .hero__photo { width: 154.74%; height: 238.5%; left: -40.94%; top: -94.83%; }`,
  }))

  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /Hero 背景图疑似机械套用源负坐标/)
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

test('static validation rejects flattened explicit line breaks', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.sourceTexts = [{ sourceNodeId: 'body', characters: '第一行\n第二行' }]
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><p data-text-source-node-id="body">第一行 第二行</p><script src="script.js"></script></body></html>',
  }))

  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /字符或空白不一致：body/)
})

test('static validation requires pre-wrap for explicitly multiline text', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.sourceTexts = [{ sourceNodeId: 'body', characters: '第一行\n第二行' }]
  const multilineHtml = '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><p data-text-source-node-id="body" data-text-preserve-whitespace="true">第一行\n第二行</p><script src="script.js"></script></body></html>'
  const missingRule = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': multilineHtml,
  })), context)
  assert.equal(missingRule.ok, false)
  assert.match(missingRule.errors.join('\n'), /缺少 white-space: pre-wrap/)

  const valid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': multilineHtml,
    'styles.css': `${validFiles()['styles.css']} [data-text-preserve-whitespace="true"] { white-space: pre-wrap; }`,
  })), context)
  assert.equal(valid.ok, true)
})

test('static validation requires pre-wrap for repeated spaces and tabs', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.sourceTexts = [{ sourceNodeId: 'body', characters: '姓名：张三  职位：算法\t工程师' }]
  const whitespaceHtml = '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><p data-text-source-node-id="body">姓名：张三  职位：算法\t工程师</p><script src="script.js"></script></body></html>'

  const validation = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': whitespaceHtml,
  })), context)

  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /缺少空白保真绑定：body/)
})

test('static validation rejects missing and duplicate text node bindings', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  const missing = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace(' data-text-source-node-id="title"', ''),
  })), context)
  assert.match(missing.errors.join('\n'), /缺少文本节点绑定：title/)

  const duplicate = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('</h1>', '</h1><span data-text-source-node-id="title">算法工程师</span>'),
  })), context)
  assert.match(duplicate.errors.join('\n'), /重复文本节点绑定：title/)
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

test('truncated JSON parse errors fail without a correction retry', async () => {
  const jobDir = createFixtureJob()
  let calls = 0
  await assert.rejects(() => runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-truncated-json',
    jobDir,
    smokeTestFn: async () => {},
    generateTextFn: async () => {
      calls += 1
      return { text: '{"index.html":"<!doctype html>', usage: {} }
    },
  }), /疑似被截断/)

  assert.equal(calls, 1)
  assert.equal(existsSync(join(jobDir, '.05-output-tmp', 'html-generation.response.attempt-1.md')), true)
  assert.equal(existsSync(join(jobDir, '.05-output-tmp', 'html-generation.response.attempt-2.md')), false)
})

test('truncated JSON parse detection recognizes unterminated strings', () => {
  let parseError
  try {
    parseGeneratedFiles('{"index.html":"<!doctype html>')
  } catch (error) {
    parseError = error
  }

  assert.equal(isLikelyTruncatedJsonError(parseError, '{"index.html":"<!doctype html>'), true)
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
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main><h1 data-text-source-node-id="title">算法工程师</h1><section><h2 data-text-source-node-id="section-title">岗位职责</h2><p data-text-source-node-id="body">1.负责原文执行。</p></section><button type="button" data-text-source-node-id="button">立即投递</button><span class="image-frame"><img src="assets/rendered/hero.png" data-asset-id="img_1"></span></main><script src="script.js"></script></body></html>',
    'styles.css': ':root { --color: #000; } body { margin: 0; } .image-frame { background: transparent; } .image-frame.is-missing { background: #000; } .image-frame.is-missing img { display: none; }',
    'script.js': 'document.addEventListener("error", event => { const frame = event.target.closest(".image-frame"); if (frame) frame.classList.add("is-missing"); }, true);',
  }
}
