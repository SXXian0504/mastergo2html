import assert from 'node:assert/strict'
import test from 'node:test'
import { renderHtmlPrototype } from '../src/html-prototype.js'
import { validateHtmlFirstPass } from '../src/html-validation.js'
import { buildNodeStyleFacts } from '../src/node-style-facts.js'

test('prototype renderer preserves local coordinates, draw order, text, clipping, and style facts', () => {
  const input = fixture()
  const first = renderHtmlPrototype(input)
  const second = renderHtmlPrototype(input)
  assert.deepEqual(first.files, second.files)
  assert.match(first.files.indexHtml, /data-source-node-id="group"[^>]*left:100px;top:80px;width:300px;height:200px/)
  assert.match(first.files.indexHtml, /data-source-node-id="text"[^>]*left:20px;top:30px;width:140px;height:24px/)
  assert.match(first.files.indexHtml, /data-text-source-node-id="text"/)
  const textTag = first.files.indexHtml.match(/<div[^>]*data-source-node-id="text"[^>]*>/)?.[0] || ''
  assert.doesNotMatch(textTag, /background:/)
  assert.match(textTag, /color:rgb\(0,0,0\)/)
  const shapeTag = first.files.indexHtml.match(/<div[^>]*data-source-node-id="shape"[^>]*>/)?.[0] || ''
  assert.match(shapeTag, /background:rgb\(255,0,0\)/)
  assert.match(first.files.indexHtml, /Hello &lt;&amp;&gt;\nWorld/)
  assert.match(first.files.indexHtml, /overflow:hidden/)
  assert.match(first.files.indexHtml, /transform:rotate\(12deg\)/)
  assert.match(first.files.indexHtml, /border-radius:8px/)
  assert.ok(first.files.indexHtml.indexOf('data-source-node-id="shape"') < first.files.indexHtml.indexOf('data-source-node-id="text"'))
  assert.equal(first.prototypeManifest.renderedNodeCount, 4)
})

test('paint alpha multiplies color alpha and background blur becomes backdrop-filter', () => {
  const input = fixture()
  const shape = input.normalizedRaw.nodes[0].children[0].children[0]
  shape.style.fills[0].alpha = 1
  shape.style.fills[0].color.a = 0.1
  shape.style.strokes[0].alpha = 0.5
  shape.style.strokes[0].color.a = 0.4
  shape.style.effects = [{ type: 'BACKGROUND_BLUR', radius: 80 }]
  const result = renderHtmlPrototype(input)
  const tag = result.files.indexHtml.match(/<div[^>]*data-source-node-id="shape"[^>]*>/)?.[0] || ''
  assert.match(tag, /background:rgba\(255,0,0,0\.1\)/)
  assert.match(tag, /border:2px solid rgba\(0,0,0,0\.2\)/)
  assert.match(tag, /backdrop-filter:blur\(80px\)/)
  assert.match(tag, /-webkit-backdrop-filter:blur\(80px\)/)
})

test('required composite uses the indexed slice once and preserves covered text as hidden DOM', () => {
  const input = fixture()
  input.assetIndex.assets.push({
    assetId: 'composite-asset',
    renderPolicy: 'required-final',
    renderingStrategy: 'use-rendered-node-slice',
    preferred: { copiedPath: 'assets/composite.png' },
    sourceNodes: [{ sourceNodeId: 'group' }],
  })
  const result = renderHtmlPrototype(input)
  assert.equal((result.files.indexHtml.match(/assets\/composite\.png/g) || []).length, 1)
  assert.match(result.files.indexHtml, /class="visually-hidden"[^>]*data-source-node-id="text"/)
  assert.match(result.files.indexHtml, /data-text-source-node-id="text"[^>]*data-style-source-node-id="text"/)
  assert.doesNotMatch(result.files.indexHtml, /data-source-node-id="shape"/)
  assert.equal(result.prototypeManifest.compositeReplacementCount, 1)
})

test('required rendered slice satisfies its own compact surface visual facts', () => {
  const input = fixture()
  const group = input.normalizedRaw.nodes[0].children[0]
  group.style = {
    cornerRadius: 12,
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 0.6 } }],
  }
  input.assetIndex.assets.push({
    assetId: 'composite-asset',
    renderPolicy: 'required-final',
    renderingStrategy: 'use-rendered-node-slice',
    preferred: { copiedPath: 'assets/composite.png' },
    sourceNodes: [{ sourceNodeId: 'group' }],
  })

  const facts = buildNodeStyleFacts(input.normalizedRaw, input.assetIndex)
  const groupFact = facts.facts.find((fact) => fact.sourceNodeId === 'group')
  assert.equal(groupFact.coveredByRenderedSlice, 'group')
  assert.equal(groupFact.compactSurfaceRequired, undefined)

  const result = renderHtmlPrototype({ ...input, nodeStyleFacts: facts })
  const validation = validateHtmlFirstPass(result.files, {
    sourceTexts: input.sourceTexts,
    assetIndex: input.assetIndex,
    fontAssets: input.fontAssets,
    nodeStyleFacts: facts,
  })
  assert.equal(validation.ok, true)
})

test('fallback container slice preserves descendant text and style bindings', () => {
  const input = fixture()
  input.assetIndex.assets.push({
    assetId: 'fallback-container',
    renderPolicy: 'fallback-only',
    preferred: { copiedPath: 'assets/fallback.png' },
    sourceNodes: [{ sourceNodeId: 'group' }],
  })
  const result = renderHtmlPrototype(input)
  const validation = validateHtmlFirstPass(result.files, {
    sourceTexts: input.sourceTexts,
    assetIndex: input.assetIndex,
    fontAssets: input.fontAssets,
    nodeStyleFacts: input.nodeStyleFacts,
  })
  assert.match(result.files.indexHtml, /assets\/fallback\.png/)
  assert.match(result.files.indexHtml, /class="visually-hidden"[^>]*data-text-source-node-id="text"[^>]*data-style-source-node-id="text"/)
  assert.equal(validation.ok, true)
})

test('preserve-rendered-slice uses exported canvas geometry without source rotation', () => {
  const input = fixture()
  input.normalizedRaw.nodes[0].children[0].rotation = 90
  input.assetIndex.assets.push({
    assetId: 'rendered-composite',
    renderPolicy: 'required-final',
    croppingPolicy: 'preserve-rendered-slice',
    preferred: { copiedPath: 'assets/rendered.png', width: 77, height: 154 },
    renderedBounds: { x: 80, y: 40, width: 77, height: 154 },
    sourceNodes: [{ sourceNodeId: 'group' }],
  })
  const result = renderHtmlPrototype(input)
  const tag = result.files.indexHtml.match(/<div[^>]*data-source-node-id="group"[^>]*>/)?.[0] || ''
  assert.match(tag, /left:80px;top:40px;width:77px;height:154px/)
  assert.doesNotMatch(tag, /rotate\(/)
  assert.deepEqual(result.prototypeManifest.renderedSliceGeometry, {
    required: 1, applied: 1, missingAssetIds: [], errors: [],
  })
})

test('root siblings are grouped by layout module without promoting a background child', () => {
  const input = fixture()
  input.layoutSketch.modules = [{
    moduleId: 'content', type: 'content-section', sourceDrawOrder: 3,
    bounds: { x: 80, y: 60, width: 500, height: 400 },
    sourceNodeIds: ['group', 'sibling'],
  }]
  input.normalizedRaw.nodes[0].children.push({
    id: 'sibling', sourceNodeId: 'sibling', type: 'TEXT', sourceOrder: 2, visible: true,
    relativeBounds: { x: 430, y: 100, width: 100, height: 24 }, text: 'Sibling', style: {}, children: [],
  })
  input.sourceTexts.push({ sourceNodeId: 'sibling', characters: 'Sibling' })
  const result = renderHtmlPrototype(input)
  assert.match(result.files.indexHtml, /<main class="mg-module" data-module-id="content"[^>]*z-index:3/)
  const section = result.files.indexHtml.match(/<main class="mg-module"[\s\S]*?<\/main>/)?.[0] || ''
  assert.match(section, /data-source-node-id="group"/)
  assert.match(section, /data-source-node-id="sibling"/)
  assert.deepEqual(result.prototypeManifest.moduleCoverage, { required: 1, rendered: 1, missingModuleIds: [] })
})

test('layout-declared global decoration stays at root and preserves a safe gradient paint stack', () => {
  const input = fixture()
  input.normalizedRaw.nodes[0].children.push({
    id: 'page-background', sourceNodeId: 'page-background', name: 'Page background', type: 'RECTANGLE',
    parentId: 'root', visible: true, sourceOrder: 0,
    relativeBounds: { x: 0, y: 0, width: 800, height: 520 },
    style: { fills: [{
      type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, blendMode: 'PASS_THROUGH',
    }, {
      type: 'GRADIENT_LINEAR', blendMode: 'PASS_THROUGH',
      gradientHandlePositions: [{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }],
      gradientStops: [{ position: 0, color: { r: 0.05, g: 0.44, b: 0.86, a: 0.06 } }, { position: 1, color: { r: 0.05, g: 0.44, b: 0.86, a: 0.02 } }],
    }] },
    children: [],
  })
  input.layoutSketch.modules = [{
    moduleId: 'content', type: 'content-section', positionStrategy: 'flow', riskLevel: 'low', sourceDrawOrder: 1,
    bounds: { x: 80, y: 60, width: 640, height: 400 }, sourceNodeIds: ['group'],
  }]
  input.layoutSketch.globalDecorations = [{ sourceNodeId: 'page-background', positionStrategy: 'absolute' }]

  const result = renderHtmlPrototype(input)
  const rootPrefix = result.files.indexHtml.slice(0, result.files.indexHtml.indexOf('<main class="mg-module"'))
  const backgroundTag = result.files.indexHtml.match(/<div[^>]*data-source-node-id="page-background"[^>]*>/)?.[0] || ''
  const content = result.files.indexHtml.match(/<main class="mg-module"[\s\S]*?<\/main>/)?.[0] || ''
  assert.match(rootPrefix, /data-source-node-id="page-background"/)
  assert.doesNotMatch(content, /data-source-node-id="page-background"/)
  assert.match(backgroundTag, /data-global-decoration="true"/)
  assert.match(backgroundTag, /background:linear-gradient\(180deg,rgba\(13,112,219,0\.06\) 0%,rgba\(13,112,219,0\.02\) 100%\),rgb\(255,255,255\)/)
})

test('validator rejects a layout-declared global decoration nested inside a module', () => {
  const files = {
    indexHtml: '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><main data-module-id="content"><div data-source-node-id="page-background"></div></main><script src="script.js"></script></body></html>',
    stylesCss: '',
    scriptJs: '',
  }
  const validation = validateHtmlFirstPass(files, {
    agentQuality: { globalDecorationIds: ['page-background'], moduleIds: ['content'] },
  })
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /Global decoration entered module content: page-background/)
})

test('root wrapper containing a layout-declared global decoration stays outside flow modules', () => {
  const input = fixture()
  input.normalizedRaw.nodes[0].children.push({
    id: 'decoration-wrapper', sourceNodeId: 'decoration-wrapper', type: 'GROUP', visible: true, sourceOrder: 0,
    relativeBounds: { x: 100, y: 80, width: 300, height: 200 }, style: {}, children: [{
      id: 'decoration-child', sourceNodeId: 'decoration-child', type: 'ELLIPSE', visible: true, sourceOrder: 0,
      relativeBounds: { x: 120, y: 100, width: 100, height: 100 },
      style: { fills: [{ type: 'SOLID', color: { r: 0, g: 0.4, b: 1, a: 0.1 } }] }, children: [],
    }],
  })
  input.layoutSketch.modules = [{
    moduleId: 'content', type: 'content-section', positionStrategy: 'flow', riskLevel: 'low', sourceDrawOrder: 1,
    bounds: { x: 80, y: 60, width: 500, height: 400 }, sourceNodeIds: ['group'],
  }]
  input.layoutSketch.globalDecorations = [{ sourceNodeId: 'decoration-child', positionStrategy: 'absolute' }]

  const result = renderHtmlPrototype(input)
  const content = result.files.indexHtml.match(/<main class="mg-module"[\s\S]*?<\/main>/)?.[0] || ''
  assert.match(result.files.indexHtml, /data-source-node-id="decoration-wrapper"/)
  assert.doesNotMatch(content, /data-source-node-id="decoration-wrapper"/)
  assert.doesNotMatch(content, /data-source-node-id="decoration-child"/)
})

test('root-level foreground inside hero bounds is promoted from a broad content module', () => {
  const input = fixture()
  input.normalizedRaw.nodes[0].children = [{
    id: 'hero-bg', sourceNodeId: 'hero-bg', name: 'Banner', type: 'GROUP', visible: true, sourceOrder: 2,
    relativeBounds: { x: 0, y: 0, width: 800, height: 300 }, style: {}, children: [],
  }, {
    id: 'hero-search', sourceNodeId: 'hero-search', name: 'Search', type: 'GROUP', visible: true, sourceOrder: 4,
    relativeBounds: { x: 80, y: 160, width: 300, height: 48 }, style: {}, children: [],
  }, {
    id: 'below', sourceNodeId: 'below', name: 'Below', type: 'GROUP', visible: true, sourceOrder: 5,
    relativeBounds: { x: 0, y: 360, width: 800, height: 200 }, style: {}, children: [],
  }]
  input.layoutSketch.modules = [{
    moduleId: 'hero', type: 'hero', sourceDrawOrder: 2,
    bounds: { x: 0, y: 0, width: 800, height: 300 }, sourceNodeIds: ['hero-bg'],
  }, {
    moduleId: 'content', type: 'content-section', sourceDrawOrder: 4,
    bounds: { x: 0, y: 0, width: 800, height: 560 }, sourceNodeIds: ['hero-search', 'below'],
  }]
  const result = renderHtmlPrototype(input)
  const hero = result.files.indexHtml.match(/<section class="mg-module" data-module-id="hero"[\s\S]*?<\/section>/)?.[0] || ''
  const content = result.files.indexHtml.match(/<main class="mg-module" data-module-id="content"[\s\S]*?<\/main>/)?.[0] || ''
  assert.match(hero, /data-source-node-id="hero-bg"/)
  assert.match(hero, /data-source-node-id="hero-search"/)
  assert.doesNotMatch(content, /data-source-node-id="hero-search"/)
  assert.match(content, /data-source-node-id="below"/)
})

test('high-confidence page modules form a flow skeleton while complex modules stay absolute', () => {
  const input = fixture()
  input.normalizedRaw.nodes[0].children = [{
    id: 'hero', sourceNodeId: 'hero', name: 'Hero', type: 'GROUP', visible: true, sourceOrder: 0,
    relativeBounds: { x: 0, y: 0, width: 800, height: 240 }, style: {}, children: [],
  }, {
    id: 'content', sourceNodeId: 'content', name: 'Content', type: 'GROUP', visible: true, sourceOrder: 1,
    relativeBounds: { x: 80, y: 180, width: 640, height: 400 }, style: {}, children: [],
  }, {
    id: 'footer', sourceNodeId: 'footer', name: 'Footer', type: 'GROUP', visible: true, sourceOrder: 2,
    relativeBounds: { x: 0, y: 620, width: 800, height: 120 }, style: {}, children: [],
  }]
  input.layoutSketch.modules = [{
    moduleId: 'hero', type: 'hero', positionStrategy: 'absolute', riskLevel: 'medium', sourceDrawOrder: 0,
    bounds: { x: 0, y: 0, width: 800, height: 240 }, sourceNodeIds: ['hero'],
  }, {
    moduleId: 'content', type: 'content-section', positionStrategy: 'flow', riskLevel: 'low', sourceDrawOrder: 1,
    bounds: { x: 80, y: 180, width: 640, height: 400 }, sourceNodeIds: ['content'],
  }, {
    moduleId: 'footer', type: 'footer', positionStrategy: 'grid', riskLevel: 'low', sourceDrawOrder: 2,
    bounds: { x: 0, y: 620, width: 800, height: 120 }, sourceNodeIds: ['footer'],
  }]
  const result = renderHtmlPrototype(input)
  assert.match(result.files.indexHtml, /class="mg-prototype-root mg-flow-skeleton"/)
  assert.match(result.files.indexHtml, /data-module-id="hero"[^>]*data-layout-mode="absolute"[^>]*left:0px;top:0px/)
  assert.match(result.files.indexHtml, /data-module-id="content"[^>]*data-layout-mode="flow"[^>]*margin-top:180px/)
  assert.match(result.files.indexHtml, /data-module-id="footer"[^>]*data-layout-mode="flow"[^>]*margin-top:40px/)
  assert.deepEqual(result.prototypeManifest.flowSkeleton.flowModuleIds, ['content', 'footer'])
  assert.deepEqual(result.prototypeManifest.flowSkeleton.absoluteFallbackModuleIds, ['hero'])
})

test('equal repeated containers become one flow-based card collection', () => {
  const input = fixture()
  input.normalizedRaw.nodes[0].children = Array.from({ length: 4 }, (_, index) => ({
    id: `card-${index}`, sourceNodeId: `card-${index}`, name: 'Job Card', type: 'GROUP', visible: true, sourceOrder: index,
    relativeBounds: { x: 100, y: 80 + index * 124, width: 600, height: 100 }, style: {}, children: [{
      id: `title-${index}`, sourceNodeId: `title-${index}`, type: 'TEXT', visible: true, sourceOrder: 0,
      relativeBounds: { x: 124, y: 100 + index * 124, width: 180, height: 24 }, style: {}, text: `Role ${index}`,
      children: [],
    }],
  }))
  input.sourceTexts = Array.from({ length: 4 }, (_, index) => ({ sourceNodeId: `title-${index}`, characters: `Role ${index}` }))
  input.layoutSketch.modules = [{
    moduleId: 'jobs', type: 'card-list', positionStrategy: 'grid', riskLevel: 'low', sourceDrawOrder: 0,
    bounds: { x: 100, y: 80, width: 600, height: 472 },
    sourceNodeIds: input.normalizedRaw.nodes[0].children.map((node) => node.id),
  }]
  const result = renderHtmlPrototype(input)
  assert.match(result.files.indexHtml, /class="mg-flow-collection" data-layout-skeleton="repeated-list" data-layout-axis="vertical"/)
  assert.equal((result.files.indexHtml.match(/class="mg-node mg-flow-item"/g) || []).length, 4)
  assert.match(result.files.indexHtml, /grid-template-columns:minmax\(0,1fr\);gap:24px/)
  assert.deepEqual(result.prototypeManifest.flowSkeleton.repeatedCollections[0].sourceNodeIds, ['card-0', 'card-1', 'card-2', 'card-3'])
})

test('validator rejects mobile scaling that makes horizontal process icons smaller than 48px', () => {
  const iconIds = ['icon-1', 'icon-2', 'icon-3']
  const items = iconIds.map((id) => `<div class="mg-flow-item"><img data-source-node-id="${id}"></div>`).join('')
  const files = {
    indexHtml: `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><div data-source-node-id="process"><div class="mg-flow-collection" data-layout-skeleton="repeated-list" data-layout-axis="horizontal">${items}</div></div><script src="script.js"></script></body></html>`,
    stylesCss: '@media(max-width:768px){[data-source-node-id="process"]{transform:scale(.3)}}',
    scriptJs: '',
  }
  const assetIndex = { assets: iconIds.map((id) => ({
    sourceNodes: [{ sourceNodeId: id, usageHint: 'icon', bounds: { x: 0, y: 0, width: 88, height: 88 } }],
  })) }
  const validation = validateHtmlFirstPass(files, {
    assetIndex,
    agentQuality: { responsiveRequired: true },
  })
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /scales meaningful icons below 48px/)
})

test('validator also checks process icon scaling in narrow breakpoints below the primary mobile max', () => {
  const iconIds = ['icon-1', 'icon-2', 'icon-3']
  const items = iconIds.map((id) => `<div class="mg-flow-item"><img data-source-node-id="${id}"></div>`).join('')
  const validation = validateHtmlFirstPass({
    indexHtml: `<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><div data-source-node-id="process"><div class="mg-flow-collection" data-layout-skeleton="repeated-list" data-layout-axis="horizontal">${items}</div></div><script src="script.js"></script></body></html>`,
    stylesCss: '@media(max-width:420px){[data-source-node-id="process"]{transform:scale(.27)}}',
    scriptJs: '',
  }, {
    assetIndex: { assets: iconIds.map((id) => ({
      sourceNodes: [{ sourceNodeId: id, usageHint: 'icon', bounds: { x: 0, y: 0, width: 88, height: 88 } }],
    })) },
    agentQuality: { responsiveRequired: true },
  })
  assert.match(validation.errors.join('\n'), /scales meaningful icons below 48px/)
})

test('explicit MasterGo auto layout becomes flex without flattening descendants', () => {
  const input = fixture()
  const group = input.normalizedRaw.nodes[0].children[0]
  group.layout = {
    sourceFlexMode: 'HORIZONTAL', sourceFlexWrap: 'NO_WRAP', itemSpacing: 12,
    padding: { top: 8, right: 16, bottom: 8, left: 16 },
  }
  const result = renderHtmlPrototype(input)
  const tag = result.files.indexHtml.match(/<div[^>]*data-source-node-id="group"[^>]*>/)?.[0] || ''
  assert.match(tag, /class="mg-node mg-auto-layout"/)
  assert.match(tag, /flex-direction:row;gap:12px;padding:8px 16px 8px 16px/)
  const child = result.files.indexHtml.match(/<div[^>]*data-source-node-id="shape"[^>]*>/)?.[0] || ''
  assert.match(child, /class="mg-node mg-flow-item"/)
  assert.doesNotMatch(child, /left:|top:/)
  assert.deepEqual(result.prototypeManifest.flowSkeleton.autoLayoutNodeIds, ['group'])
})

test('card container clips a layer-blur descendant to its matching rounded surface', () => {
  const input = fixture()
  input.normalizedRaw.nodes[0].children = [{
    id: 'card', sourceNodeId: 'card', name: 'Card', type: 'GROUP', visible: true, sourceOrder: 0,
    relativeBounds: { x: 100, y: 80, width: 300, height: 200 }, style: {}, children: [{
      id: 'surface', sourceNodeId: 'surface', type: 'RECTANGLE', visible: true, sourceOrder: 0,
      relativeBounds: { x: 100, y: 80, width: 300, height: 200 },
      style: { cornerRadius: 24, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }] }, children: [],
    }, {
      id: 'glow', sourceNodeId: 'glow', type: 'ELLIPSE', visible: true, sourceOrder: 1,
      relativeBounds: { x: 180, y: 120, width: 100, height: 100 },
      style: { effects: [{ type: 'LAYER_BLUR', radius: 40 }], fills: [{ type: 'SOLID', color: { r: 1, g: 0.8, b: 0, a: 0.2 } }] }, children: [],
    }],
  }]
  const result = renderHtmlPrototype(input)
  const card = result.files.indexHtml.match(/<div[^>]*data-source-node-id="card"[^>]*>/)?.[0] || ''
  assert.match(card, /overflow:hidden/)
  assert.match(card, /border-radius:24px/)
})

test('validator rejects alpha, background blur, logo, and hero foreground regressions', () => {
  const files = {
    indexHtml: '<!doctype html><html><body><section data-module-id="hero" data-module-type="hero"></section><div data-source-node-id="glass" data-style-source-node-id="glass"></div></body></html>',
    stylesCss: '',
    scriptJs: '',
  }
  const validation = validateHtmlFirstPass(files, {
    nodeStyleFacts: { facts: [{
      sourceNodeId: 'glass', rasterEffect: { effects: [{ type: 'BACKGROUND_BLUR', radius: 24 }] },
      resolvedBackgroundColor: 'rgba(1, 2, 3, 0.2)',
      compactSurfaceRequired: true,
    }] },
    assetIndex: { assets: [{
      assetId: 'brand', usageHint: 'logo', renderPolicy: 'required-final', preferred: { copiedPath: 'assets/logo.svg' },
    }] },
    agentQuality: { heroForegroundPromotions: [{ sourceNodeId: 'search', heroModuleId: 'hero' }] },
  })
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /Translucent background color is missing/)
  assert.match(validation.errors.join('\n'), /Background blur is missing/)
  assert.match(validation.errors.join('\n'), /Required logo asset is missing/)
  assert.match(validation.errors.join('\n'), /Hero foreground is outside its hero module/)
})

test('validator accepts background blur already represented by an ancestor rendered slice', () => {
  const files = {
    indexHtml: '<!doctype html><html><head><link rel="stylesheet" href="styles.css"></head><body><div data-source-node-id="composite"><img src="assets/composite.png"><span data-style-source-node-id="glass"></span></div><script src="script.js"></script></body></html>',
    stylesCss: '',
    scriptJs: '',
  }
  const validation = validateHtmlFirstPass(files, {
    nodeStyleFacts: { facts: [{
      sourceNodeId: 'glass',
      rasterEffect: { assetMode: 'css-fallback', effects: [{ type: 'BACKGROUND_BLUR', radius: 24 }] },
      coveredByRenderedSlice: 'composite',
    }] },
    assetIndex: { assets: [{
      assetId: 'composite', renderPolicy: 'required-final', preferred: { copiedPath: 'assets/composite.png' },
    }] },
  })
  assert.equal(validation.ok, true)
})

test('rotated zero-height PEN is normalized to a bound vertical divider', () => {
  const input = fixture()
  input.normalizedRaw.nodes[0].children.push({
    id: 'divider', sourceNodeId: 'divider', type: 'PEN', sourceOrder: 2, visible: true, rotation: 90,
    relativeBounds: { x: 400, y: 90, width: 240, height: 0 },
    style: { strokeWeight: 0.4, strokes: [{ type: 'SOLID', color: { r: 0.8, g: 0.84, b: 0.9 } }] }, children: [],
  })
  const result = renderHtmlPrototype(input)
  const tag = result.files.indexHtml.match(/<div[^>]*data-source-node-id="divider"[^>]*>/)?.[0] || ''
  assert.match(tag, /left:400px;top:90px;width:1px;height:240px/)
  assert.match(tag, /border-left:0.4px solid rgb\(204,214,230\)/)
  assert.doesNotMatch(tag, /rotate\(/)
})

test('review-only asset references are excluded while their source nodes remain renderable', () => {
  const input = fixture()
  input.normalizedRaw.nodes[0].children.push({
    id: 'image', sourceNodeId: 'image', type: 'RECTANGLE', sourceOrder: 3, visible: true,
    relativeBounds: { x: 420, y: 100, width: 100, height: 80 },
    images: [{ assetId: 'review' }], style: {}, children: [],
  })
  input.assetIndex.assets.push({
    assetId: 'review', renderPolicy: 'review-only', preferred: { copiedPath: 'assets/review.png' },
    sourceNodes: [{ sourceNodeId: 'image' }],
  })
  input.normalizedRaw.nodes[0].children.push({
    id: 'missing-image', sourceNodeId: 'missing-image', type: 'RECTANGLE', sourceOrder: 4, visible: true,
    relativeBounds: { x: 540, y: 100, width: 100, height: 80 },
    images: [{ assetId: 'missing' }], style: {}, children: [],
  })
  const result = renderHtmlPrototype(input)
  assert.doesNotMatch(result.files.indexHtml, /review\.png/)
  assert.match(result.files.indexHtml, /data-source-node-id="image"/)
  assert.equal(result.prototypeManifest.degradations.some((item) => item.sourceNodeId === 'image' && item.reason === 'review-only-asset-suppressed'), true)
  assert.equal(result.prototypeManifest.missingAssets.length, 1)
})

test('semantic navigation cannot be layered over a visible navigation composite', () => {
  const input = fixture()
  const files = {
    indexHtml: '<!doctype html><html><body><header data-module-id="header"><img src="assets/nav.png"><nav><a data-text-source-node-id="nav-label">首页</a></nav></header></body></html>',
    stylesCss: 'a:hover{opacity:.9} a:focus-visible{outline:2px solid #05e}',
    scriptJs: '',
  }
  input.assetIndex.assets.push({
    assetId: 'nav-composite', renderPolicy: 'required-final', preferred: { copiedPath: 'assets/nav.png' },
    sourceNodes: [{ sourceNodeId: 'nav', sourceNodeName: '导航' }],
  })
  const validation = validateHtmlFirstPass(files, { assetIndex: input.assetIndex })
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /Navigation composite asset must not be visible/)
})

test('missing-bounds source text is preserved only in the hidden source contract', () => {
  const input = fixture()
  input.normalizedRaw.nodes[0].children.push({
    id: 'unpositioned-text', sourceNodeId: 'unpositioned-text', type: 'TEXT', visible: true,
    text: 'stale', style: {}, children: [],
  })
  input.sourceTexts.push({ sourceNodeId: 'unpositioned-text', characters: 'Contract-only text' })
  const result = renderHtmlPrototype(input)
  assert.match(result.files.indexHtml, /class="mg-source-contract"/)
  assert.match(result.files.indexHtml, /data-text-source-node-id="unpositioned-text"[^>]*>Contract-only text</)
  assert.equal(result.prototypeManifest.textCoverage.contract, 1)
  assert.equal(result.prototypeManifest.degradations.some((item) => item.sourceNodeId === 'unpositioned-text'), true)
})

test('prototype manifest reports required style facts that cannot be mapped to rendered nodes', () => {
  const input = fixture()
  input.nodeStyleFacts.facts.push({ sourceNodeId: 'unknown-style-node', bindingRequired: true })
  const result = renderHtmlPrototype(input)
  assert.deepEqual(result.prototypeManifest.styleBindingCoverage.missingSourceNodeIds, ['unknown-style-node'])
  const validation = validateHtmlFirstPass(result.files, {
    sourceTexts: input.sourceTexts,
    assetIndex: input.assetIndex,
    fontAssets: input.fontAssets,
    nodeStyleFacts: input.nodeStyleFacts,
  })
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /Style binding is missing: unknown-style-node/)
})

function fixture() {
  return {
    inputHash: 'stable-input',
    layoutSketch: { version: 'mastergo2html.layout-sketch.v1', page: { name: 'Fixture' } },
    normalizedRaw: {
      nodes: [{
        id: 'root', sourceNodeId: 'root', name: 'Root', type: 'FRAME', visible: true, sourceOrder: 0,
        relativeBounds: { x: 0, y: 0, width: 800, height: 600 }, style: {}, children: [{
          id: 'group', sourceNodeId: 'group', name: 'Group', type: 'GROUP', visible: true, clipsContent: true, sourceOrder: 0,
          relativeBounds: { x: 100, y: 80, width: 300, height: 200 }, style: {}, children: [{
            id: 'shape', sourceNodeId: 'shape', type: 'RECTANGLE', visible: true, sourceOrder: 0,
            relativeBounds: { x: 110, y: 90, width: 180, height: 100 },
            style: { opacity: 0.8, cornerRadius: 8, strokeWeight: 2, fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }], strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] }, children: [],
          }, {
            id: 'text', sourceNodeId: 'text', type: 'TEXT', visible: true, sourceOrder: 1, text: 'stale', rotation: 12,
            relativeBounds: { x: 120, y: 110, width: 140, height: 24 },
            style: { fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }], text: { fontFamily: 'Inter', fontSize: 16, fontWeight: 600, lineHeightPx: 20 } }, children: [],
          }],
        }],
      }],
    },
    sourceTexts: [{ sourceNodeId: 'text', characters: 'Hello <&>\nWorld' }],
    nodeStyleFacts: { facts: [{ sourceNodeId: 'text', singleLineRequired: false }] },
    assetIndex: { assets: [] },
    fontAssets: { fonts: [] },
  }
}
