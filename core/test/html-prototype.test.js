import assert from 'node:assert/strict'
import test from 'node:test'
import { renderHtmlPrototype } from '../src/html-prototype.js'
import { validateHtmlFirstPass } from '../src/html-validation.js'

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
