import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { applySafeStaticFixes, buildHtmlGenerationContext, isLikelyTruncatedJsonError, parseGeneratedFiles, runHtmlGeneration, validateGeneratedFiles } from '../src/workflow/html-generation.js'

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

test('responsive contract applies only deterministic viewport repair and leaves structural issues as warnings', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout.responsiveContract = responsiveContractFixture()
  const fixed = applySafeStaticFixes(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.match(fixed.files.indexHtml, /name="viewport" content="width=device-width, initial-scale=1"/)
  assert.deepEqual(fixed.fixes.map((fix) => fix.code), ['add-responsive-viewport-meta'])

  const validation = validateGeneratedFiles(fixed.files, context)
  assert.equal(validation.ok, true)
  assert.match(validation.warnings.join('\n'), /缺少必检模块：header/)
  assert.match(validation.warnings.join('\n'), /缺少必检模块：nav/)
  assert.match(validation.warnings.join('\n'), /缺少必检模块：footer/)
})

test('responsive validation warns about nested vertical scrolling shells', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout.responsiveContract = responsiveContractFixture()
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} .page-shell { height: 100vh; overflow-y: auto; }`,
  }))

  const warnings = validateGeneratedFiles(files, context).warnings.join('\n')
  assert.match(warnings, /嵌套纵向滚动容器：\.page-shell/)
  assert.match(warnings, /只保留 html\/body 一个纵向滚动根/)
})


test('responsive validation warns when decorative horizontal clipping creates implicit vertical scrolling', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout.responsiveContract = responsiveContractFixture()
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} .page-decor { position: absolute; height: 500px; overflow-x: hidden; }`,
  }))

  const warnings = validateGeneratedFiles(files, context).warnings.join('\n')
  assert.match(warnings, /装饰裁切层可能产生隐式纵向滚动条：\.page-decor/)
  assert.match(warnings, /overflow-x:hidden/)
  assert.match(warnings, /overflow-y:hidden\/clip/)
})

test('responsive validation requires structural shell overrides and safe cascade order', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout.responsiveContract = {
    ...responsiveContractFixture(),
    baseViewport: { width: 1920, height: 1080 },
    layoutIntegrity: {
      narrowMaxWidth: 768,
      wideShell: { minViewportWidth: 1921 },
    },
  }
  const shellHtml = validFiles()['index.html']
    .replace('<body>', '<body><header class="site-header"><nav class="primary-nav"><a data-text-source-node-id="nav-text">校园招聘</a></nav></header>')
    .replace('</body>', '<footer class="site-footer"><div class="site-footer__inner">页尾</div></footer></body>')

  const broken = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': shellHtml,
    'styles.css': `${validFiles()['styles.css']} .site-header,.site-footer { width:1920px; } @media (max-width:768px) { main { width:100%; } } [data-text-source-node-id] { position:absolute; left:1420px; top:23px; width:64px; height:22px; }`,
  }))
  const warnings = validateGeneratedFiles(broken, context).warnings.join('\n')
  assert.match(warnings, /窄屏媒体查询未检测到 header/)
  assert.match(warnings, /窄屏媒体查询未检测到 nav/)
  assert.match(warnings, /窄屏媒体查询未检测到 footer/)
  assert.match(warnings, /反向覆盖 Header\/Nav\/Footer 响应式/)
  assert.match(warnings, /缺少 >=1921px 的超宽屏/)

  const mobileOnly = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': shellHtml,
    'styles.css': `${validFiles()['styles.css']} @media (max-width:600px) { .site-header { height:auto; } .primary-nav { position:static; width:100%; } .site-footer { display:grid; width:100%; } }`,
  }))
  const mobileOnlyWarnings = validateGeneratedFiles(mobileOnly, context).warnings.join('\n')
  assert.doesNotMatch(mobileOnlyWarnings, /390px 窄屏媒体查询未检测到 (?:header|nav|footer)/)
  assert.match(mobileOnlyWarnings, /未检测到覆盖 768px 的窄屏媒体查询/)

  const responsive = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': shellHtml,
    'styles.css': `${validFiles()['styles.css']} .site-header,.site-footer { width:1920px; } [data-text-source-node-id] { position:absolute; left:1420px; top:23px; width:64px; height:22px; } @media (max-width:768px) { .site-header { height:auto; min-height:0; } .primary-nav { position:static; width:100%; display:flex; flex-wrap:wrap; } .site-footer,.site-footer__inner { position:static; width:100%; display:grid; } [data-text-source-node-id] { position:static; width:auto; height:auto; } } @media (min-width:1921px) { .site-header,.site-footer { width:100%; } .site-footer__inner { width:min(1608px,calc(100% - 48px)); margin-inline:auto; } }`,
  }))
  const responsiveWarnings = validateGeneratedFiles(responsive, context).warnings.join('\n')
  assert.doesNotMatch(responsiveWarnings, /窄屏媒体查询未检测到 (?:header|nav|footer)/)
  assert.doesNotMatch(responsiveWarnings, /反向覆盖 Header\/Nav\/Footer 响应式/)
  assert.doesNotMatch(responsiveWarnings, /缺少 >=1921px 的超宽屏/)
})

test('missing file errors report the exact omitted file names', () => {
  assert.throws(() => parseGeneratedFiles(JSON.stringify({
    'index.html': '<!doctype html>',
    'script.js': 'console.log(1)',
  })), /缺少有效文件：styles\.css/)
})

test('static validation reports missing planned hover feedback and motion', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.assemblyPlan = '# 交互与共享数据\nhoverRequired: true\nhoverTargets: job-card\nmotionRequired: true\n'

  const warnings = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context).warnings.join('\n')

  assert.match(warnings, /交互反馈缺失/)
  assert.match(warnings, /交互动效缺失/)
})

test('static validation accepts capability-scoped hover with reduced-motion fallback', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.assemblyPlan = '# 交互与共享数据\nhoverRequired: true\nhoverTargets: job-card\nmotionRequired: true\n'
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} button { transition: transform 180ms ease-out; } @media (hover: hover) and (pointer: fine) { button:hover { transform: translateY(-1px); } } @media (prefers-reduced-motion: reduce) { button { transition-duration: 0.01ms; } }`,
  }))

  const warnings = validateGeneratedFiles(files, context).warnings.join('\n')

  assert.doesNotMatch(warnings, /交互反馈缺失|交互动效缺失|hover 适配提示|减少动态效果缺失|Hover 视觉越界/)
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

test('static validation accepts dot-relative local css and script references', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html']
      .replace('href="styles.css"', 'href="./styles.css"')
      .replace('src="script.js"', 'src="./script.js"'),
  }))

  assert.equal(validateGeneratedFiles(files, context).ok, true)
})

test('static validation rejects omitted required rendered logo assets', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout = { modules: [{ moduleId: 'module_01_header', assetIds: ['node_logo'] }] }
  context.assetIndex.assets.push({
    assetId: 'node_logo',
    usage: 'logo',
    usageHint: 'logo',
    mustUseRenderedSlice: true,
    preferred: { copiedPath: 'assets/rendered/logo.svg' },
    rendered: [{ path: 'assets/rendered/logo.svg' }],
    sourceNodes: [{ sourceNodeId: 'nav-logo' }],
  })
  writeFileSync(join(context.assetsDir, 'rendered', 'logo.svg'), '<svg></svg>', 'utf8')

  const validation = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /必须使用整体切片资源：node_logo -> assets\/rendered\/logo\.svg/)
})

test('whole-node PNG naming is required even when page planning omits its asset id', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout = { modules: [] }
  context.assetIndex.assets.push({
    assetId: 'node_whole_home',
    usage: 'masked-composite',
    usageHint: 'masked-composite',
    renderPolicy: 'required-final',
    mustUseRenderedSlice: true,
    wholeNodePng: true,
    preferred: { copiedPath: 'assets/rendered/home-section.png' },
    rendered: [{ path: 'assets/rendered/home-section.png' }],
    sourceNodes: [{ sourceNodeId: 'home-section' }],
  })
  writeFileSync(join(context.assetsDir, 'rendered', 'home-section.png'), 'png', 'utf8')

  const missing = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join('\n'), /必须使用整体切片资源：node_whole_home/)

  const unbound = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} .hero { background-image: url(assets/rendered/home-section.png); }`,
  })), context)
  assert.equal(unbound.ok, false)
  assert.match(unbound.errors.join('\n'), /整体切片资源缺少 HTML 绑定：node_whole_home/)

  const valid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace(
      '<main>',
      '<img src="assets/rendered/home-section.png" data-source-node-id="home-section" data-asset-id="node_whole_home" alt=""><main>',
    ),
  })), context)
  assert.equal(valid.ok, true)
})

test('static validation accepts required rendered logo assets with source binding', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout = { modules: [{ moduleId: 'module_01_header', assetIds: ['node_logo'] }] }
  context.assetIndex.assets.push({
    assetId: 'node_logo',
    usage: 'logo',
    usageHint: 'logo',
    mustUseRenderedSlice: true,
    preferred: { copiedPath: 'assets/rendered/logo.svg' },
    rendered: [{ path: 'assets/rendered/logo.svg' }],
    sourceNodes: [{ sourceNodeId: 'nav-logo' }],
  })
  writeFileSync(join(context.assetsDir, 'rendered', 'logo.svg'), '<svg></svg>', 'utf8')
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace(
      '<main>',
      '<header><img src="assets/rendered/logo.svg" data-source-node-id="nav-logo" data-asset-id="node_logo" alt=""></header><main>',
    ),
  }))

  assert.equal(validateGeneratedFiles(files, context).ok, true)
})

test('static validation accepts source text bound to input placeholder attributes', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.sourceTexts = [{ sourceNodeId: 'search-placeholder', characters: '输入城市或岗位进行搜索' }]
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main><input type="search" data-text-source-node-id="search-placeholder" placeholder="输入城市或岗位进行搜索"></main><script src="script.js"></script></body></html>',
  }))

  assert.equal(validateGeneratedFiles(files, context).ok, true)
})

test('static validation rejects review-only rendered slices in final HTML', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.assetIndex.assets.push({
    assetId: 'node_nav_full',
    usage: 'rendered-visual',
    usageHint: 'complex-vector',
    renderPolicy: 'review-only',
    preferred: { copiedPath: 'assets/rendered/nav-full.png' },
    rendered: [{ path: 'assets/rendered/nav-full.png' }],
    sourceNodes: [{ sourceNodeId: 'nav' }],
  })
  writeFileSync(join(context.assetsDir, 'rendered', 'nav-full.png'), 'png')

  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<main>', '<header><img src="assets/rendered/nav-full.png" alt=""></header><main>'),
  }))
  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /资源仅供复核不得进入最终 HTML\/CSS：node_nav_full \(review-only\) -> assets\/rendered\/nav-full\.png/)
})

test('static validation allows injected local font assets', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  mkdirSync(join(context.assetsDir, 'fonts'), { recursive: true })
  writeFileSync(join(context.assetsDir, 'fonts', 'brand-sans-normal-400.woff2'), 'font')
  context.fontAssets = {
    fonts: [{
      family: 'Brand Sans',
      status: 'downloaded',
      assets: [{
        family: 'Brand Sans',
        path: 'assets/fonts/brand-sans-normal-400.woff2',
        format: 'woff2',
        fontWeight: '400',
        fontStyle: 'normal',
      }],
    }],
    files: ['assets/fonts/brand-sans-normal-400.woff2'],
  }
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `@font-face { font-family: "Brand Sans"; src: url("assets/fonts/brand-sans-normal-400.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; } ${validFiles()['styles.css']} body { font-family: "Brand Sans", Arial, sans-serif; }`,
  }))

  assert.equal(validateGeneratedFiles(files, context).ok, true)
})

test('static validation rejects downloaded font assets without font-face injection', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.fontAssets = {
    fonts: [{
      family: 'Brand Sans',
      status: 'downloaded',
      assets: [{
        family: 'Brand Sans',
        path: 'assets/fonts/brand-sans-normal-400.woff2',
        format: 'woff2',
        fontWeight: '400',
        fontStyle: 'normal',
      }],
    }],
    files: ['assets/fonts/brand-sans-normal-400.woff2'],
  }

  const validation = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /缺少字体 @font-face 注入/)
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

test('static validation allows style-bound background layer own dimensions', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout = {
    modules: [{
      moduleId: 'module_01_background',
      type: 'decorative',
      bounds: { x: 0, y: 0, width: 1920, height: 1613 },
      backgroundLayers: [{
        sourceNodeId: '114:68724',
        bounds: { x: 0, y: 0, width: 1919, height: 1613 },
        affectsFlow: false,
      }],
      contentFlow: { firstContentY: 0, items: [] },
    }],
  }
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<body>', '<body><div data-style-source-node-id="114:68724"></div>'),
    'styles.css': `${validFiles()['styles.css']} [data-style-source-node-id="114:68724"] { position:absolute; width:1919px; height:1613px; background-color:#ffffff; }`,
  }))

  assert.equal(validateGeneratedFiles(files, context).ok, true)
})

test('static validation allows absolute decorative class dimensions even when binding is omitted', () => {
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
      contentFlow: { firstContentY: 128, items: [] },
    }],
  }
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} .decor-blur-circle-2 { position:absolute; left:723px; top:-1111px; width:1383px; height:1383px; }`,
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

test('static validation allows structural container sizing from layout bounds', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout = {
    modules: [{
      moduleId: 'module_01_header',
      type: 'header',
      bounds: { x: 0, y: 0, width: 1920, height: 68 },
      backgroundLayers: [{
        sourceNodeId: '114:68740',
        bounds: { x: 0, y: 0, width: 1920, height: 68 },
        affectsFlow: false,
      }],
      contentFlow: {
        firstContentY: 23,
        items: [{ sourceNodeId: 'title', bounds: { x: 1420, y: 23, width: 64, height: 22 } }],
      },
    }],
  }
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<body>', '<body><header class="page-header" data-source-node-id="114:68740" data-style-source-node-id="114:68740"></header><a class="page-header__link">导航</a>'),
    'styles.css': `${validFiles()['styles.css']} .page-header { height: 68px; } .page-header__link { padding-top: 23px; } [data-style-source-node-id="114:68740"] { background-color: rgba(255,255,255,0.2); }`,
  }))

  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, true)
})

test('static validation rejects gradient pollution on pure color backgrounds', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.nodeStyleFacts = {
    facts: [{ sourceNodeId: '114:68724', resolvedBackgroundColor: '#ffffff', bindingRequired: true }],
  }
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} [data-style-source-node-id="114:68724"] { background: linear-gradient(180deg, rgba(12,112,219,0.03) 0%, rgba(12,112,219,0) 100%), #ffffff; }`,
    'index.html': validFiles()['index.html'].replace('<body>', '<body><div data-style-source-node-id="114:68724"></div>'),
  }))

  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /114:68724 应为 #ffffff/)
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

test('static validation rejects fluid cover sizing for decorative background assets', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  writeFileSync(join(context.assetsDir, 'rendered', 'math-decor.png'), 'png')
  context.assetIndex.assets.push({
    assetId: 'node_decor',
    usage: 'background-decor',
    usageHint: 'background-decor',
    preferred: { copiedPath: 'assets/rendered/math-decor.png' },
    rendered: [{ path: 'assets/rendered/math-decor.png' }],
    sourceNodes: [{ sourceNodeId: 'math-decor', usageHint: 'background-decor' }],
  })

  const invalid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<main>', '<main><img class="hero__math-decor" src="assets/rendered/math-decor.png" data-asset-id="node_decor" data-source-node-id="math-decor" alt="">'),
    'styles.css': `${validFiles()['styles.css']} .hero__math-decor { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }`,
  })), context)

  assert.equal(invalid.ok, false)
  assert.match(invalid.errors.join('\n'), /背景装饰资源不得流体铺满或 cover 缩放/)

  const valid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<main>', '<main><img class="hero__math-decor" src="assets/rendered/math-decor.png" data-asset-id="node_decor" data-source-node-id="math-decor" alt="">'),
    'styles.css': `${validFiles()['styles.css']} .hero__math-decor { position:absolute; left:760px; top:0; width:992px; height:246px; }`,
  })), context)

  assert.equal(valid.ok, true)
})

test('static validation enforces source bounds for hero foreground slices', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  writeFileSync(join(context.assetsDir, 'rendered', 'hero-arrow.png'), 'png')
  context.pageLayout = { modules: [{ moduleId: 'hero', assetIds: ['hero_arrow'] }] }
  context.assetIndex.assets.push({
    assetId: 'hero_arrow', usage: 'masked-composite', renderPolicy: 'required-final',
    preferred: { copiedPath: 'assets/rendered/hero-arrow.png' }, rendered: [{ path: 'assets/rendered/hero-arrow.png' }],
    sourceNodes: [{ sourceNodeId: 'hero-arrow' }], sizingPolicy: 'source-size', positioningPolicy: 'source-bounds',
    localBounds: { x: 1612, y: 254, width: 174, height: 116 },
  })
  const html = validFiles()['index.html'].replace('<main>', '<main><img class="hero-arrow" src="assets/rendered/hero-arrow.png" data-asset-id="hero_arrow" data-source-node-id="hero-arrow" alt="">')
  const invalid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .hero-arrow { position:absolute; right:7%; top:42.3%; width:120px; height:80px; }`,
  })), context)
  assert.match(invalid.errors.join('\n'), /宽度必须使用源值 174px/)
  assert.match(invalid.errors.join('\n'), /不得使用 right 定位/)

  const valid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .hero-arrow { position:absolute; left:1612px; top:254px; width:174px; height:116px; }`,
  })), context)
  assert.equal(valid.ok, true)
})

test('static validation preserves pre-cropped hero slices and their coordinate anchor', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  writeFileSync(join(context.assetsDir, 'rendered', 'hero-crop.png'), 'png')
  context.pageLayout = { modules: [{ moduleId: 'hero', assetIds: ['hero_crop'] }] }
  context.assetIndex.assets.push({
    assetId: 'hero_crop', usage: 'masked-composite', renderPolicy: 'required-final',
    preferred: { copiedPath: 'assets/rendered/hero-crop.png' }, rendered: [{ path: 'assets/rendered/hero-crop.png' }],
    sourceNodes: [{ sourceNodeId: 'hero-visual' }], anchorNodeId: 'hero',
    sizingPolicy: 'source-size', positioningPolicy: 'source-bounds', croppingPolicy: 'preserve-rendered-slice',
    localBounds: { x: 0, y: 0, width: 1920, height: 1080 },
  })
  const html = validFiles()['index.html'].replace(
    '<main>',
    '<main><section class="hero" data-source-node-id="hero"><img class="hero-crop" src="assets/rendered/hero-crop.png" data-asset-id="hero_crop" data-source-node-id="hero-visual" alt=""></section>',
  )
  const invalid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .hero { position:relative; } .hero-crop { position:absolute; left:0; top:0; width:1920px; height:1080px; object-fit:cover; }`,
  })), context)
  assert.match(invalid.errors.join('\n'), /预裁切资源不得再次 cover/)

  const valid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .hero { position:relative; } .hero-crop { position:absolute; left:0; top:0; width:1920px; height:1080px; }`,
  })), context)
  assert.equal(valid.ok, true)
})

test('static validation requires the real rendered canvas bounds for effects-bleed input slices', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  writeFileSync(join(context.assetsDir, 'rendered', 'input-background.svg'), '<svg width="654" height="148" viewBox="0 0 654 148"></svg>')
  context.pageLayout = { modules: [{ moduleId: 'login-form', assetIds: ['input_background'] }] }
  context.assetIndex.assets.push({
    assetId: 'input_background', usage: 'complex-vector', renderPolicy: 'required-final',
    preferred: { kind: 'rendered-image', copiedPath: 'assets/rendered/input-background.svg' },
    rendered: [{ path: 'assets/rendered/input-background.svg' }],
    sourceNodes: [{ sourceNodeId: 'input-background' }], anchorNodeId: 'input-field',
    sizingPolicy: 'source-size', positioningPolicy: 'source-bounds', croppingPolicy: 'preserve-rendered-slice',
    sourceBounds: { x: 68, y: 552, width: 614, height: 108 },
    localBounds: { x: 0, y: 0, width: 614, height: 108 },
    renderedLocalBounds: { x: -20, y: -10, width: 654, height: 148 },
  })
  const html = validFiles()['index.html'].replace(
    '<main>',
    '<main><div class="input-field" data-source-node-id="input-field"><img class="input-background" src="assets/rendered/input-background.svg" data-asset-id="input_background" data-source-node-id="input-background" alt=""></div>',
  )
  const squeezed = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .input-field { position:relative; } .input-background { position:absolute; left:0; top:0; width:614px; height:108px; }`,
  })), context)
  assert.match(squeezed.errors.join('\n'), /宽度必须使用源值 654px/)
  assert.match(squeezed.errors.join('\n'), /横坐标必须使用源值 -20px/)

  const preserved = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .input-field { position:relative; } .input-background { position:absolute; left:-20px; top:-10px; width:654px; height:148px; }`,
  })), context)
  assert.equal(preserved.ok, true)
})

test('static validation protects filter-bleed glow SVGs from global image compression', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  writeFileSync(join(context.assetsDir, 'rendered', 'red-glow.svg'), '<svg width="192" height="192" viewBox="0 0 1212 1212"><filter id="b"><feGaussianBlur stdDeviation="127.5"/></filter></svg>')
  context.pageLayout = { modules: [{ moduleId: 'hero', assetIds: ['red_glow'] }] }
  context.assetIndex.assets.push({
    assetId: 'red_glow', usage: 'background-decor', usageHint: 'decorative', renderPolicy: 'required-final', format: 'svg',
    preferred: { kind: 'rendered-image', copiedPath: 'assets/rendered/red-glow.svg', format: 'svg' },
    rendered: [{ path: 'assets/rendered/red-glow.svg', format: 'svg' }],
    sourceNodes: [{ sourceNodeId: 'red-glow', renderReason: 'LAYER_BLUR 独立光晕，保留完整 viewBox 与 filter bleed。' }],
    anchorNodeId: 'hero', sizingPolicy: 'source-size', positioningPolicy: 'source-bounds', croppingPolicy: 'preserve-rendered-slice',
    localBounds: { x: 1791, y: 231, width: 192, height: 192 },
    renderedLocalBounds: { x: 1281, y: -279, width: 1212, height: 1212 },
  })
  const html = validFiles()['index.html'].replace(
    '<main>',
    '<main><section class="hero" data-source-node-id="hero"><img class="red-glow" src="assets/rendered/red-glow.svg" data-asset-id="red_glow" data-source-node-id="red-glow" alt=""></section>',
  )
  const compressed = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} img { max-width:100%; } .hero { position:relative; } .red-glow { position:absolute; left:1281px; top:-279px; width:1212px; height:1212px; }`,
  })), context)
  assert.match(compressed.errors.join('\n'), /flex:none/)
  assert.match(compressed.errors.join('\n'), /max-width:none/)

  const preserved = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} img { max-width:100%; } .hero { position:relative; } .red-glow { position:absolute; left:1281px; top:-279px; width:1212px; height:1212px; flex:none; max-width:none; }`,
  })), context)
  assert.equal(preserved.ok, true)
})

test('static validation rejects positioned wrappers that change a source coordinate system', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  writeFileSync(join(context.assetsDir, 'rendered', 'card-halo.svg'), '<svg></svg>')
  context.pageLayout = { modules: [{ moduleId: 'card', assetIds: ['card_halo'] }] }
  context.assetIndex.assets.push({
    assetId: 'card_halo', usage: 'icon', renderPolicy: 'required-final',
    preferred: { copiedPath: 'assets/rendered/card-halo.svg' }, rendered: [{ path: 'assets/rendered/card-halo.svg' }],
    sourceNodes: [{ sourceNodeId: 'card-halo' }], anchorNodeId: 'card',
    sizingPolicy: 'source-size', positioningPolicy: 'source-bounds',
    localBounds: { x: 192, y: 145, width: 304, height: 304 },
  })
  const html = validFiles()['index.html'].replace(
    '<main>',
    '<main><article class="card" data-source-node-id="card"><div class="card-inner"><img class="card-halo" src="assets/rendered/card-halo.svg" data-asset-id="card_halo" data-source-node-id="card-halo" alt=""></div></article>',
  )
  const validation = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .card { position:relative; } .card-inner { position:relative; } .card-halo { position:absolute; left:192px; top:145px; width:304px; height:304px; }`,
  })), context)
  assert.match(validation.errors.join('\n'), /中间容器改变了源坐标系/)
})

test('static validation rejects fabricated inline svg artwork', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  const files = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<main>', '<main><svg viewBox="0 0 100 20"><path d="M0 10 C30 0 70 20 100 10"></path></svg>'),
  }))
  const validation = validateGeneratedFiles(files, context)
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /禁止在 HTML 中手绘 inline SVG/)
})

test('static validation requires rendered fallback for display-critical missing fonts', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  writeFileSync(join(context.assetsDir, 'rendered', 'hero-copy.png'), 'png')
  context.assetIndex.assets.push({
    assetId: 'hero_copy', usage: 'rendered-visual', renderPolicy: 'fallback-only', fontFallbackRequired: true,
    fallbackForTextNodeIds: ['title'], preferred: { copiedPath: 'assets/rendered/hero-copy.png' }, rendered: [{ path: 'assets/rendered/hero-copy.png' }],
    sourceNodes: [{ sourceNodeId: 'hero-copy' }], sizingPolicy: 'source-size', positioningPolicy: 'source-bounds',
    localBounds: { x: 260, y: 203, width: 433, height: 188 },
  })
  const missing = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.match(missing.errors.join('\n'), /缺字大标题必须使用渲染切片/)

  const html = validFiles()['index.html']
    .replace('data-text-source-node-id="title"', 'data-text-source-node-id="title" data-font-fallback-accessible="true"')
    .replace('<main>', '<main><img class="hero-copy" src="assets/rendered/hero-copy.png" data-asset-id="hero_copy" data-source-node-id="hero-copy" data-font-fallback-for="title" alt="">')
  const valid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .hero-copy { position:absolute; left:260px; top:203px; width:433px; height:188px; } [data-font-fallback-accessible="true"] { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }`,
  })), context)
  assert.equal(valid.ok, true)
})

test('static validation rejects banner stacking above an overlapping content panel', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout = {
    stackingFacts: [{ lowerSourceNodeId: 'hero', upperSourceNodeId: 'jobs-panel' }],
  }
  const html = validFiles()['index.html'].replace('<main>', '<main><section class="hero" data-source-node-id="hero"></section><section class="jobs-panel" data-source-node-id="jobs-panel"></section>')
  const invalid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .hero { position:relative; isolation:isolate; z-index:4; } .jobs-panel { position:relative; isolation:isolate; z-index:2; }`,
  })), context)
  assert.match(invalid.errors.join('\n'), /重叠模块层级错误/)

  const valid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .hero { position:relative; isolation:isolate; z-index:0; } .jobs-panel { position:relative; isolation:isolate; z-index:1; }`,
  })), context)
  assert.equal(valid.ok, true)
})

test('static validation enforces display-critical text metrics and source text box', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.nodeStyleFacts = {
    facts: [{
      sourceNodeId: 'title', textBindingRequired: true,
      typography: { fontSize: 64, fontWeight: 400, lineHeight: 90, textAlignHorizontal: 'LEFT' },
      localBounds: { x: 174, y: 71, width: 245, height: 77 },
    }],
  }
  const invalid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.match(invalid.errors.join('\n'), /大标题 title 字号必须使用源值 64px/)
  assert.match(invalid.errors.join('\n'), /必须按源文本框 absolute 定位/)

  const valid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} [data-text-source-node-id="title"] { position:absolute; left:174px; top:71px; width:245px; height:77px; font-size:64px; font-weight:400; line-height:90px; text-align:left; }`,
  })), context)
  assert.equal(valid.ok, true)
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

test('static validation preserves compact rounded surface fill radius and source stroke', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.nodeStyleFacts = {
    facts: [{
      sourceNodeId: 'badge',
      compactSurfaceRequired: true,
      resolvedBackgroundColor: 'rgba(12, 112, 219, 0.1)',
      cornerRadius: 8,
      strokeWeight: 1,
      strokes: [{ type: 'SOLID', color: 'rgba(12, 112, 219, 0.4)' }],
    }],
  }
  const boundHtml = validFiles()['index.html'].replace('<body>', '<body><span class="badge" data-style-source-node-id="badge">校招动态</span>')

  const missingBinding = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.match(missingBinding.errors.join('\n'), /紧凑圆角视觉面缺少 HTML 样式绑定：badge/)

  const transparent = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': boundHtml,
    'styles.css': `${validFiles()['styles.css']} .badge { background: transparent; border: 1px solid rgba(12, 112, 219, 0.4); border-radius: 8px; }`,
  })), context)
  assert.match(transparent.errors.join('\n'), /紧凑圆角视觉面背景色不一致：badge/)

  const missingRadius = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': boundHtml,
    'styles.css': `${validFiles()['styles.css']} .badge { background-color: rgba(12, 112, 219, 0.1); border: 1px solid rgba(12, 112, 219, 0.4); }`,
  })), context)
  assert.match(missingRadius.errors.join('\n'), /紧凑圆角视觉面圆角不一致：badge/)

  const correct = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': boundHtml,
    'styles.css': `${validFiles()['styles.css']} .badge { background-color: rgba(12, 112, 219, 0.1); border: 1px solid rgba(12, 112, 219, 0.4); border-radius: 8px; }`,
  })), context)
  assert.equal(correct.ok, true)
})

test('static validation warns when hover invents a border without design-state evidence', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  const borderHover = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} button:hover { border: 1px solid #0c70db; }`,
  }))
  assert.match(validateGeneratedFiles(borderHover, context).warnings.join('\n'), /Hover 视觉越界/)

  const surfaceHover = parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'styles.css': `${validFiles()['styles.css']} button:hover { transform: translateY(-1px); box-shadow: 0 8px 24px rgba(0,14,38,.12); }`,
  }))
  assert.doesNotMatch(validateGeneratedFiles(surfaceHover, context).warnings.join('\n'), /Hover 视觉越界/)
})

test('full generation copies all assets and publishes a directly openable page', async () => {
  const jobDir = createFixtureJob()
  let calls = 0
  const result = await runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-1',
    jobDir,
    smokeTestFn: async () => {},
    generateTextFn: async (options) => {
      calls += 1
      assert.doesNotMatch(options.system, /App 页面模式规则/)
      return { text: JSON.stringify(validFiles()), usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } }
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.tokenUsage.totalTokens, 30)
  assert.equal(existsSync(join(jobDir, '05-output', 'index.html')), true)
  assert.equal(existsSync(join(jobDir, '05-output', 'assets', 'rendered', 'hero.png')), true)
  assert.match(readFileSync(join(jobDir, '05-output', 'index.html'), 'utf8'), /<!doctype html>/i)
  assert.match(readFileSync(join(jobDir, '05-output', 'html-generation.prompt.md'), 'utf8'), /透明背景约束适用于所有元素/)
  const generatedPrompt = readFileSync(join(jobDir, '05-output', 'html-generation.prompt.md'), 'utf8')
  assert.match(generatedPrompt, /node-style-facts\.json 是节点视觉样式的最高优先级事实源/)
  assert.match(generatedPrompt, /栅格敏感效果硬约束/)
  assert.match(generatedPrompt, /分隔线真实性硬约束/)
  assert.match(generatedPrompt, /交互状态实现硬约束/)
  assert.match(generatedPrompt, /data-route-pending 安全占位/)
  assert.match(generatedPrompt, /prefers-reduced-motion: reduce/)
  assert.match(generatedPrompt, /data-segmented-control/)
  assert.match(generatedPrompt, /data-segmented-active-surface/)
  assert.match(generatedPrompt, /中心误差、外框边界、单槽位宽度比例和点击区覆盖/)
  assert.equal(JSON.parse(readFileSync(join(jobDir, '05-output', 'static-validation.json'), 'utf8')).ok, true)
})

test('app generation injects isolated mobile rules and validates the viewport meta', async () => {
  const jobDir = createFixtureJob()
  writeFileSync(join(jobDir, '00-input', 'export-options.json'), JSON.stringify({
    exportOptions: { includeRenderedSlices: true, rawProfile: 'html', targetPlatform: 'app' },
  }))
  const context = buildHtmlGenerationContext(jobDir)
  assert.equal(context.targetPlatform, 'app')

  const missingViewport = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.equal(missingViewport.ok, false)
  assert.match(missingViewport.errors.join('\n'), /App 页面缺少 width=device-width/)

  const zoomDisabledFiles = {
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">'),
  }
  const zoomDisabled = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(zoomDisabledFiles)), context)
  assert.equal(zoomDisabled.ok, false)
  assert.match(zoomDisabled.errors.join('\n'), /App 页面不得禁止用户缩放/)

  const appFiles = {
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1">'),
    'styles.css': `${validFiles()['styles.css']} .app-shell { min-height: 100vh; min-height: 100dvh; }`,
  }
  let receivedOptions
  const result = await runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-app-target',
    jobDir,
    smokeTestFn: async () => {},
    generateTextFn: async (options) => {
      receivedOptions = options
      return { text: JSON.stringify(appFiles), usage: {} }
    },
  })

  assert.match(receivedOptions.system, /App 页面模式规则/)
  assert.match(receivedOptions.system, /100dvh/)
  assert.match(receivedOptions.prompt, /generationTarget: app/)
  assert.equal(result.staticValidation.ok, true)
})

test('format errors fail after the first response without another model request', async () => {
  const jobDir = createFixtureJob()
  let calls = 0
  await assert.rejects(() => runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-format-warning',
    jobDir,
    smokeTestFn: async () => {},
    generateTextFn: async () => {
      calls += 1
      return { text: 'not json', usage: {} }
    },
  }), /未重新请求模型/)
  assert.equal(calls, 1)
  assert.equal(existsSync(join(jobDir, '.05-output-tmp', 'html-generation.response.attempt-1.md')), true)
  assert.equal(existsSync(join(jobDir, '.05-output-tmp', 'html-generation.response.attempt-2.md')), false)
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

test('static validation failure keeps the first generated files and reports warnings', async () => {
  const jobDir = createFixtureJob()
  let calls = 0
  const result = await runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-validation-failure',
    jobDir,
    smokeTestFn: async () => {},
    generateTextFn: async () => {
      calls += 1
      return { text: JSON.stringify({ ...validFiles(), 'styles.css': 'body {' }), usage: {} }
    },
  })
  assert.equal(calls, 1)
  assert.equal(result.staticValidation.ok, false)
  assert.match(result.validationWarnings.join('\n'), /不再重新请求模型/)
  assert.match(result.validationWarnings.join('\n'), /CSS 花括号不平衡/)
  assert.equal(existsSync(join(jobDir, '05-output', 'static-validation.json')), true)
})

test('html generation runs all configured responsive viewports, reports warnings, and still publishes output', async () => {
  const jobDir = createFixtureJob()
  const pageLayoutPath = join(jobDir, '02-layout', 'page-layout.json')
  const pageLayout = JSON.parse(readFileSync(pageLayoutPath, 'utf8'))
  pageLayout.responsiveContract = responsiveContractFixture()
  writeFileSync(pageLayoutPath, JSON.stringify(pageLayout))
  let receivedContract
  const result = await runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-responsive-runtime-warning',
    jobDir,
    smokeTestFn: async () => {},
    responsiveRuntimeTestFn: async ({ contract }) => {
      receivedContract = contract
      return {
        version: 'mastergo2html.responsive-runtime-validation.v1',
        status: 'warning',
        ok: false,
        blocking: false,
        viewports: contract.viewports.map((viewport) => ({ viewport, ok: viewport.width === 1920 })),
        warnings: ['390px 页面整体横向溢出'],
      }
    },
    generateTextFn: async () => ({ text: JSON.stringify(validFiles()), usage: {} }),
  })

  assert.deepEqual(receivedContract.viewports.map((viewport) => viewport.width), [390, 768, 1280, 1920, 2560])
  assert.equal(result.responsiveRuntime.ok, false)
  assert.match(result.validationWarnings.join('\n'), /390px 页面整体横向溢出/)
  assert.equal(existsSync(join(jobDir, '05-output', 'index.html')), true)
  assert.match(readFileSync(join(jobDir, '05-output', 'index.html'), 'utf8'), /width=device-width/)
  const report = JSON.parse(readFileSync(join(jobDir, '05-output', 'static-validation.json'), 'utf8'))
  assert.equal(report.responsiveRuntime.status, 'warning')
  assert.deepEqual(report.autoFixes.map((fix) => fix.code), ['add-responsive-viewport-meta'])
})

test('targeted static validation errors are exposed as warnings without retrying', async () => {
  const jobDir = createFixtureJob()
  writeFileSync(join(jobDir, '01-normalized', 'source-texts.json'), JSON.stringify([
    { sourceNodeId: 'body', name: '正文', characters: '第一行\n第二行' },
    { sourceNodeId: '114:68747', name: '导航', characters: '校园招聘' },
  ]))
  writeFileSync(join(jobDir, '01-normalized', 'node-style-facts.json'), JSON.stringify({
    version: 'mastergo2html.node-style-facts.v1',
    rules: { compactRoundedSurfaceRequired: true },
    facts: [{ sourceNodeId: '114:68724', resolvedBackgroundColor: '#ffffff', bindingRequired: true }],
  }))
  let calls = 0
  const result = await runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-targeted-validation-retry',
    jobDir,
    smokeTestFn: async () => {},
    generateTextFn: async () => {
      calls += 1
      return { text: JSON.stringify(invalidFilesForTargetedRetry()), usage: {} }
    },
  })

  assert.equal(calls, 1)
  assert.match(result.validationWarnings.join('\n'), /body/)
  assert.match(result.validationWarnings.join('\n'), /114:68747/)
  assert.match(result.validationWarnings.join('\n'), /114:68724/)
})

test('missing source text is reported as a warning without retrying', async () => {
  const jobDir = createFixtureJob()
  writeFileSync(join(jobDir, '01-normalized', 'source-texts.json'), JSON.stringify([
    { sourceNodeId: 'missing-copy', name: '缺失文案', characters: '必须补齐的原文' },
  ]))
  let calls = 0
  const result = await runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-missing-text-retry',
    jobDir,
    smokeTestFn: async () => {},
    generateTextFn: async () => {
      calls += 1
      return { text: JSON.stringify({ ...validFiles(), 'index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main></main><script src="script.js"></script></body></html>' }), usage: {} }
    },
  })

  assert.equal(calls, 1)
  assert.match(result.validationWarnings.join('\n'), /missing-copy/)
})

test('missing local file links are reported as warnings without retrying', async () => {
  const jobDir = createFixtureJob()
  let calls = 0
  const result = await runHtmlGeneration({
    config: { provider: 'openai-compatible', model: 'test-model' },
    jobId: 'job-missing-local-file-links',
    jobDir,
    smokeTestFn: async () => {},
    generateTextFn: async () => {
      calls += 1
      return {
        text: JSON.stringify({ ...validFiles(), 'index.html': validFiles()['index.html'].replace('<link rel="stylesheet" href="styles.css">', '').replace('<script src="script.js"></script>', '') }),
        usage: {},
      }
    },
  })

  assert.equal(calls, 1)
  assert.match(result.validationWarnings.join('\n'), /index\.html 未引用 styles\.css/)
  assert.match(result.validationWarnings.join('\n'), /index\.html 未引用 script\.js/)
})

function invalidFilesForTargetedRetry() {
  return {
    ...validFiles(),
    'index.html': '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><div data-style-source-node-id="114:68724"></div><p data-text-source-node-id="body" data-text-preserve-whitespace="true">第一行 第二行</p><a data-text-source-node-id="114:68747">校园招聘</a><span data-text-source-node-id="114:68747">校园招聘</span><script src="script.js"></script></body></html>',
    'styles.css': `${validFiles()['styles.css']} .page-bg { background-color: #ffffff; }`,
  }
}

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

function responsiveContractFixture() {
  return {
    version: 'mastergo2html.responsive-contract.v1',
    enabled: true,
    viewports: [
      { name: 'mobile', width: 390, height: 844 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'laptop', width: 1280, height: 900 },
      { name: 'desktop', width: 1920, height: 1080 },
      { name: 'wide-desktop', width: 2560, height: 1440 },
    ],
    requiredModules: [
      { role: 'header', selectors: ['header'], required: true },
      { role: 'nav', selectors: ['nav'], required: true },
      { role: 'main', selectors: ['main'], required: true },
      { role: 'footer', selectors: ['footer'], required: true },
    ],
    horizontalScrolling: { pageAllowed: false, componentAllowed: false, tolerancePx: 2 },
  }
}

test('static validation preserves source-bound css hairlines with the source color and effective opacity', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  writeFileSync(join(context.assetsDir, 'rendered', 'divider.svg'), '<svg></svg>', 'utf8')
  context.assetIndex.assets.push({
    assetId: 'divider_hairline', usage: 'background-decor', usageHint: 'decorative', renderPolicy: 'css-preferred', format: 'svg',
    preferred: { copiedPath: 'assets/rendered/divider.svg' }, rendered: [{ path: 'assets/rendered/divider.svg' }],
    sourceNodes: [{
      sourceNodeId: 'divider-line', sourceNodeName: '直线', nodeType: 'PEN',
      bounds: { x: 0, y: 0, width: 1088, height: 0.4 },
      localBounds: { x: 0, y: 0, width: 1088, height: 0 },
      hairlineStyle: {
        orientation: 'horizontal', sourceThickness: 0.4, cssThickness: 1, color: '#d0d8e5', cssOpacity: 0.4,
      },
      renderReason: '检测到 1px 及以下的超细分隔线。',
    }],
  })

  const missing = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.match(missing.errors.join('\n'), /设计稿真实分隔线不得省略/)

  const imageDivider = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<main>', '<main><img class="qa-divider" src="assets/rendered/divider.svg" data-asset-id="divider_hairline" data-source-node-id="divider-line">'),
  })), context)
  assert.match(imageDivider.errors.join('\n'), /超细分隔线不得通过 SVG\/图片渲染/)

  const fabricated = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<main>', '<main><div class="qa-divider"></div>'),
    'styles.css': `${validFiles()['styles.css']} .qa-divider { border-top: 1px solid #000; }`,
  })), context)
  assert.match(fabricated.errors.join('\n'), /缺少真实线节点绑定/)

  const darkSourceBoundLine = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<main>', '<main><div class="qa-divider" data-source-node-id="divider-line"></div>'),
    'styles.css': `${validFiles()['styles.css']} .qa-divider { position:absolute; left:0; top:0; width:1088px; height:1px; background-color:#000; opacity:1; }`,
  })), context)
  assert.match(darkSourceBoundLine.errors.join('\n'), /颜色错误/)
  assert.match(darkSourceBoundLine.errors.join('\n'), /透明度错误/)

  const thickSourceBoundLine = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<main>', '<main><div class="qa-divider" data-source-node-id="divider-line"></div>'),
    'styles.css': `${validFiles()['styles.css']} .qa-divider { position:absolute; left:0; top:0; width:1088px; height:2px; background-color:#d0d8e5; opacity:.4; }`,
  })), context)
  assert.match(thickSourceBoundLine.errors.join('\n'), /视觉厚度必须为 1px/)

  const sourceBoundCssLine = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<main>', '<main><div class="qa-divider" data-source-node-id="divider-line"></div>'),
    'styles.css': `${validFiles()['styles.css']} .qa-divider { position:absolute; left:0; top:0; width:1088px; height:1px; background-color:#d0d8e5; opacity:.4; }`,
  })), context)
  assert.equal(sourceBoundCssLine.ok, true)

  const rgbaCssLine = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': validFiles()['index.html'].replace('<main>', '<main><div class="qa-divider" data-source-node-id="divider-line"></div>'),
    'styles.css': `${validFiles()['styles.css']} .qa-divider { position:absolute; left:0; top:0; width:1088px; height:1px; background-color:rgba(208,216,229,.4); }`,
  })), context)
  assert.equal(rgbaCssLine.ok, true)
})

test('static validation requires raster-effect PNG as the sole visual for its source node', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  writeFileSync(join(context.assetsDir, 'rendered', 'yellow-glow.png'), 'png', 'utf8')
  context.assetIndex.assets.push({
    assetId: 'yellow_glow', usage: 'rendered-visual', usageHint: 'complex-vector', renderPolicy: 'required-final', format: 'png',
    preferred: { copiedPath: 'assets/rendered/yellow-glow.png' }, rendered: [{ path: 'assets/rendered/yellow-glow.png' }],
    sourceNodes: [{ sourceNodeId: 'yellow-glow', nodeType: 'ELLIPSE', renderReason: '检测到浏览器无法与 MasterGo 等价合成的栅格敏感效果（LAYER_BLUR）。' }],
  })

  const missing = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.match(missing.errors.join('\n'), /栅格敏感效果必须使用 MasterGo PNG 切片/)

  const html = validFiles()['index.html'].replace(
    '<main>',
    '<main><img class="yellow-glow" src="assets/rendered/yellow-glow.png" data-asset-id="yellow_glow" data-source-node-id="yellow-glow" alt="">',
  )
  const doubleRendered = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .yellow-glow { filter: blur(333px); }`,
  })), context)
  assert.match(doubleRendered.errors.join('\n'), /不得对同一源节点再次用 CSS 模糊\/阴影\/渐变重画/)

  const pngOnly = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
  })), context)
  assert.equal(pngOnly.ok, true)
})

test('static validation preserves a visible yellow glow when legacy input lacks the PNG slice', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.nodeStyleFacts = {
    facts: [{
      sourceNodeId: '114:71609', name: '圆形 59', type: 'ELLIPSE', role: 'decorative',
      bounds: { x: -123, y: -296, width: 647, height: 647 },
      anchorNodeId: '114:71600',
      localBounds: { x: 231, y: 0, width: 647, height: 647 },
      opacity: 1,
      resolvedBackgroundColor: 'rgba(255, 210, 33, 0.4)',
      rasterEffect: {
        effectTypes: ['LAYER_BLUR'],
        effects: [{ type: 'LAYER_BLUR', radius: 333.5106 }],
        assetMode: 'css-fallback',
        assetAvailable: false,
      },
    }],
  }

  const missing = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.match(missing.errors.join('\n'), /栅格敏感效果 CSS 降级节点 114:71609 不得省略/)

  const boundHtml = validFiles()['index.html'].replace(
    '<main>',
    '<main><div class="glow-anchor" data-source-node-id="114:71600"><div class="yellow-glow" data-style-source-node-id="114:71609"></div></div>',
  )
  const baseGlowCss = '.glow-anchor { position:relative; } .yellow-glow { position:absolute; left:231px; top:0; width:647px; height:647px; border-radius:50%; background-color:rgba(255, 210, 33, 0.4); filter:blur(333.5106px); }'

  const hidden = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': boundHtml,
    'styles.css': `${validFiles()['styles.css']} ${baseGlowCss} .yellow-glow { opacity:0; }`,
  })), context)
  assert.match(hidden.errors.join('\n'), /不得隐藏或设置 opacity:0/)

  const wrongVisual = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': boundHtml,
    'styles.css': `${validFiles()['styles.css']} .glow-anchor { position:relative; } .yellow-glow { position:absolute; left:231px; top:0; width:647px; height:647px; border-radius:50%; background-color:rgba(0, 128, 255, 0.4); filter:blur(120px); }`,
  })), context)
  assert.match(wrongVisual.errors.join('\n'), /背景色错误/)
  assert.match(wrongVisual.errors.join('\n'), /模糊半径错误/)

  const clipped = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': boundHtml,
    'styles.css': `${validFiles()['styles.css']} ${baseGlowCss} .glow-anchor { overflow:hidden; }`,
  })), context)
  assert.match(clipped.errors.join('\n'), /不得裁切 blur bleed/)

  const valid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': boundHtml,
    'styles.css': `${validFiles()['styles.css']} ${baseGlowCss}`,
  })), context)
  assert.equal(valid.ok, true)
})

test('static validation prevents fallback fonts from wrapping source single-line CTA text', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.sourceTexts = context.sourceTexts.map((item) => item.sourceNodeId === 'button' ? { ...item, name: '查看全部岗位', characters: '查看全部岗位' } : item)
  context.nodeStyleFacts = {
    facts: [{
      sourceNodeId: 'button', name: '查看全部岗位', type: 'TEXT',
      typography: {
        fontFamily: 'MiSans', textAutoResize: 'WIDTH_AND_HEIGHT',
        fontSize: 22, fontWeight: 400, lineHeight: 29,
      },
      singleLineRequired: true,
      textBindingRequired: true,
    }],
  }

  const html = validFiles()['index.html']
    .replace('data-text-source-node-id="button"', 'class="view-all-jobs" data-text-source-node-id="button"')
    .replace('立即投递', '查看全部岗位')
  const metricsCss = '.view-all-jobs { font-size:22px; line-height:29px; font-weight:400; }'

  const missingNoWrap = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} ${metricsCss}`,
  })), context)
  assert.match(missingNoWrap.errors.join('\n'), /white-space:nowrap/)
  assert.match(missingNoWrap.errors.join('\n'), /word-break:keep-all/)
  assert.match(missingNoWrap.errors.join('\n'), /overflow-wrap:normal/)

  const shrunkToFit = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .view-all-jobs { font-size:20px; line-height:26px; font-weight:400; white-space:nowrap; word-break:keep-all; overflow-wrap:normal; }`,
  })), context)
  assert.match(shrunkToFit.errors.join('\n'), /字号必须使用源值/)
  assert.match(shrunkToFit.errors.join('\n'), /行高必须使用源值/)

  const valid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': html,
    'styles.css': `${validFiles()['styles.css']} .view-all-jobs { font-size:22px; line-height:29px; font-weight:400; white-space:nowrap; word-break:keep-all; overflow-wrap:normal; }`,
  })), context)
  assert.equal(valid.ok, true)
})

test('static validation requires a masked composite PNG and rejects all covered child assets', () => {
  const context = buildHtmlGenerationContext(createFixtureJob())
  context.pageLayout = { modules: [] }
  writeFileSync(join(context.assetsDir, 'rendered', 'location-card.png'), 'png', 'utf8')
  writeFileSync(join(context.assetsDir, 'rendered', 'location-photo.png'), 'png', 'utf8')
  context.assetIndex.assets.push({
    assetId: 'location_card_slice', usage: 'masked-composite', usageHint: 'masked-composite',
    renderPolicy: 'required-final', format: 'png', mustUseRenderedSlice: true,
    preferred: { copiedPath: 'assets/rendered/location-card.png' },
    rendered: [{ path: 'assets/rendered/location-card.png' }],
    sourceNodes: [{ sourceNodeId: 'location-card' }],
  }, {
    assetId: 'location_photo', usage: 'rendered-slice-child',
    preferred: { copiedPath: 'assets/rendered/location-photo.png' },
    rendered: [{ path: 'assets/rendered/location-photo.png' }],
    sourceNodes: [{
      sourceNodeId: 'location-photo', insideForcedRenderedSlice: true,
      ancestorNodeIds: ['location-card'],
    }],
  })

  const missing = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify(validFiles())), context)
  assert.match(missing.errors.join('\n'), /必须使用整体切片资源：location_card_slice/)

  const compositeHtml = validFiles()['index.html'].replace(
    '<main>',
    '<main><img src="assets/rendered/location-card.png" data-asset-id="location_card_slice" data-source-node-id="location-card" alt="西安">',
  )
  const childByBinding = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': compositeHtml.replace('</main>', '<span data-asset-id="location_photo"></span></main>'),
  })), context)
  assert.match(childByBinding.errors.join('\n'), /蒙版整体切片的内部子资源不得单独显示：location_photo/)

  const childByPath = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(),
    'index.html': compositeHtml.replace('</main>', '<img src="assets/rendered/location-photo.png" alt=""></main>'),
  })), context)
  assert.match(childByPath.errors.join('\n'), /蒙版整体切片的内部子资源不得单独显示：location_photo/)

  const valid = validateGeneratedFiles(parseGeneratedFiles(JSON.stringify({
    ...validFiles(), 'index.html': compositeHtml,
  })), context)
  assert.equal(valid.ok, true)
})
