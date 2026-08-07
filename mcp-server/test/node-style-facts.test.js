import assert from 'node:assert/strict'
import test from 'node:test'
import { buildNodeStyleFacts, requiredBackgroundFacts, requiredCompactSurfaceFacts, requiredRasterEffectFacts, requiredTypographyFacts } from '../src/workflow/node-style-facts.js'

test('node style facts preserve tiny translucent rounded badge surfaces', () => {
  const payload = buildNodeStyleFacts({
    nodes: [{
      id: 'root', sourceNodeId: 'root', visible: true, type: 'FRAME',
      relativeBounds: { x: 0, y: 0, width: 1920, height: 1080 }, style: { fills: [] },
      children: [{
        id: 'badge', sourceNodeId: 'badge', parentId: 'root', name: '校招动态底', visible: true, type: 'FRAME',
        relativeBounds: { x: 48, y: 220, width: 68, height: 24 },
        style: {
          opacity: 1,
          cornerRadius: 8,
          strokeWeight: 1,
          fills: [{ type: 'SOLID', color: { r: 12 / 255, g: 112 / 255, b: 219 / 255, a: 0.1 }, alpha: 1 }],
          strokes: [{ type: 'SOLID', color: { r: 12 / 255, g: 112 / 255, b: 219 / 255, a: 0.4 }, alpha: 1 }],
        },
        children: [{
          id: 'badge-text', sourceNodeId: 'badge-text', parentId: 'badge', visible: true, type: 'TEXT',
          relativeBounds: { x: 58, y: 224, width: 48, height: 17 },
          style: { fills: [], text: { characters: '校招动态', fontSize: 12, lineHeight: 17 } },
          children: [],
        }],
      }],
    }],
  })

  const fact = requiredCompactSurfaceFacts(payload).find((item) => item.sourceNodeId === 'badge')
  assert.equal(payload.rules.compactRoundedSurfaceRequired, true)
  assert.equal(fact.compactSurfaceRequired, true)
  assert.equal(fact.resolvedBackgroundColor, 'rgba(12, 112, 219, 0.1)')
  assert.equal(fact.cornerRadius, 8)
  assert.equal(fact.strokeWeight, 1)
  assert.equal(fact.strokes[0].color, 'rgba(12, 112, 219, 0.4)')
})

test('node style facts preserve exact large background fill provenance', () => {
  const payload = buildNodeStyleFacts({
    nodes: [{
      id: 'root',
      sourceNodeId: 'root',
      visible: true,
      type: 'FRAME',
      bounds: { x: 0, y: 0, width: 1920, height: 1925 },
      relativeBounds: { x: 0, y: 0, width: 1920, height: 1925 },
      style: { fills: [] },
      children: [{
        id: 'footer-bg',
        sourceNodeId: 'footer-bg',
        name: '矩形 242',
        visible: true,
        type: 'RECTANGLE',
        bounds: { x: 0, y: 1613, width: 1920, height: 312 },
        relativeBounds: { x: 0, y: 1613, width: 1920, height: 312 },
        style: {
          opacity: 1,
          fills: [{ type: 'SOLID', color: { r: 0.9294117689, g: 0.9568627477, b: 1, a: 1 }, alpha: 1 }],
        },
        children: [],
      }],
    }],
  })

  const fact = payload.facts.find((item) => item.sourceNodeId === 'footer-bg')
  assert.equal(fact.resolvedBackgroundColor, '#edf4ff')
  assert.equal(fact.bindingRequired, true)
  assert.deepEqual(requiredBackgroundFacts(payload).map((item) => item.sourceNodeId), ['footer-bg'])
})

test('node style facts preserve display-critical typography and local text bounds', () => {
  const payload = buildNodeStyleFacts({
    nodes: [{
      id: 'root', sourceNodeId: 'root', visible: true, type: 'FRAME',
      relativeBounds: { x: 0, y: 0, width: 1920, height: 1080 }, style: { fills: [] },
      children: [{
        id: 'hero-copy', sourceNodeId: 'hero-copy', parentId: 'root', visible: true, type: 'GROUP',
        relativeBounds: { x: 260, y: 203, width: 433, height: 188 }, style: { fills: [] },
        children: [{
          id: 'hero-title', sourceNodeId: 'hero-title', parentId: 'hero-copy', visible: true, type: 'TEXT',
          relativeBounds: { x: 434, y: 274, width: 245, height: 77 },
          style: {
            fills: [{ type: 'SOLID', color: { r: 0.047, g: 0.439, b: 0.859, a: 1 }, alpha: 1 }],
            text: { fontFamily: 'DingTalk JinBuTi', fontSize: 64, fontWeight: 400, lineHeight: 90, textAlignHorizontal: 'LEFT' },
          },
          children: [],
        }],
      }],
    }],
  })

  const fact = requiredTypographyFacts(payload).find((item) => item.sourceNodeId === 'hero-title')
  assert.equal(fact.typography.fontSize, 64)
  assert.equal(fact.typography.lineHeight, 90)
  assert.deepEqual(fact.localBounds, { x: 174, y: 71, width: 245, height: 77 })
})

test('node style facts do not leak rendered composite internals into outer backgrounds', () => {
  const payload = buildNodeStyleFacts({
    nodes: [{
      id: 'root', sourceNodeId: 'root', visible: true, type: 'FRAME',
      relativeBounds: { x: 0, y: 0, width: 1920, height: 1080 }, style: { fills: [] },
      children: [{
        id: 'hero-slice', sourceNodeId: 'hero-slice', parentId: 'root', visible: true, type: 'GROUP',
        relativeBounds: { x: 0, y: 0, width: 1920, height: 1080 }, style: { fills: [] },
        children: [{
          id: 'masked-bg', sourceNodeId: 'masked-bg', parentId: 'hero-slice', visible: true, type: 'RECTANGLE',
          relativeBounds: { x: 0, y: 0, width: 1920, height: 1080 },
          style: { opacity: 1, fills: [{ type: 'SOLID', color: { r: 0.847, g: 0.847, b: 0.847, a: 1 }, alpha: 1 }] },
          children: [],
        }],
      }],
    }],
  }, {
    assets: [{
      renderPolicy: 'required-final', renderingStrategy: 'use-rendered-node-slice',
      sourceNodes: [{ sourceNodeId: 'hero-slice' }],
    }],
  })

  const fact = payload.facts.find((item) => item.sourceNodeId === 'masked-bg')
  assert.equal(fact.coveredByRenderedSlice, 'hero-slice')
  assert.equal(fact.bindingRequired, false)
  assert.deepEqual(requiredBackgroundFacts(payload), [])
})

test('fixed-layout text keeps module-local bounds and normalizes zero font weights', () => {
  const payload = buildNodeStyleFacts({
    nodes: [{
      id: 'root', sourceNodeId: 'root', visible: true, type: 'FRAME',
      relativeBounds: { x: 0, y: 0, width: 1920, height: 1200 }, style: { fills: [] },
      children: [{
        id: 'timeline', sourceNodeId: 'timeline', parentId: 'root', visible: true, type: 'GROUP',
        relativeBounds: { x: -193, y: 300, width: 2312, height: 813 }, layout: { sourceFlexMode: 'NONE' }, style: { fills: [] },
        children: [{
          id: 'year-group', sourceNodeId: 'year-group', parentId: 'timeline', visible: true, type: 'GROUP',
          relativeBounds: { x: 1496, y: 801, width: 55, height: 36 }, layout: { sourceFlexMode: 'NONE' }, style: { fills: [] },
          children: [{
            id: 'year', sourceNodeId: 'year', parentId: 'year-group', visible: true, type: 'TEXT',
            relativeBounds: { x: 1496, y: 801, width: 55, height: 36 },
            style: {
              fills: [{ type: 'SOLID', color: { r: 0.047, g: 0.439, b: 0.859, a: 1 }, alpha: 1 }],
              text: { fontFamily: 'HarmonyOS Sans TC', fontStyle: 'Regular', fontSize: 24, fontWeight: 0, lineHeight: 36 },
            },
            children: [],
          }],
        }],
      }],
    }],
  })

  const fact = requiredTypographyFacts(payload).find((item) => item.sourceNodeId === 'year')
  assert.equal(fact.anchorNodeId, 'timeline')
  assert.deepEqual(fact.localBounds, { x: 1689, y: 501, width: 55, height: 36 })
  assert.equal(fact.typography.fontWeight, 400)
})


test('node style facts preserve yellow layer blur and mark missing PNG as CSS fallback', () => {
  const payload = buildNodeStyleFacts({
    nodes: [{
      id: 'root', sourceNodeId: 'root', visible: true, type: 'FRAME',
      relativeBounds: { x: 0, y: 0, width: 1920, height: 1080 }, style: { fills: [] },
      children: [{
        id: '114:71600', sourceNodeId: '114:71600', parentId: 'root', visible: true, type: 'GROUP',
        relativeBounds: { x: -354, y: -296, width: 2376.0083, height: 777.9874 }, style: { fills: [] },
        children: [{
          id: '114:71609', sourceNodeId: '114:71609', parentId: '114:71600', name: '圆形 59', visible: true, type: 'ELLIPSE',
          relativeBounds: { x: -123, y: -296, width: 647, height: 647 },
          relativeRenderBounds: { x: -624, y: -797, width: 1649, height: 1649 },
          style: {
            opacity: 1,
            fills: [{ type: 'SOLID', color: { r: 1, g: 0.8235294222831726, b: 0.12941177189350128, a: 0.4 }, alpha: 1 }],
            effects: [{ type: 'LAYER_BLUR', radius: 333.5106201171875 }],
          },
          children: [],
        }],
      }],
    }],
  })

  const fact = requiredRasterEffectFacts(payload).find((item) => item.sourceNodeId === '114:71609')
  assert.equal(fact.resolvedBackgroundColor, 'rgba(255, 210, 33, 0.4)')
  assert.deepEqual(fact.localBounds, { x: 231, y: 0, width: 647, height: 647 })
  assert.deepEqual(fact.renderLocalBounds, { x: -270, y: -501, width: 1649, height: 1649 })
  assert.deepEqual(fact.rasterEffect.effectTypes, ['LAYER_BLUR'])
  assert.equal(fact.rasterEffect.effects[0].radius, 333.5106)
  assert.equal(fact.rasterEffect.assetMode, 'css-fallback')
  assert.equal(fact.rasterEffect.assetAvailable, false)
})

test('node style facts link yellow layer blur to its required-final PNG', () => {
  const payload = buildNodeStyleFacts({
    nodes: [{
      id: 'root', sourceNodeId: 'root', visible: true, type: 'FRAME',
      relativeBounds: { x: 0, y: 0, width: 1920, height: 1080 }, style: { fills: [] },
      children: [{
        id: 'yellow-glow', sourceNodeId: 'yellow-glow', parentId: 'root', name: '圆形 59', visible: true, type: 'ELLIPSE',
        relativeBounds: { x: 231, y: 0, width: 647, height: 647 },
        style: {
          fills: [{ type: 'SOLID', color: { r: 1, g: 0.8235294222831726, b: 0.12941177189350128, a: 0.4 }, alpha: 1 }],
          effects: [{ type: 'LAYER_BLUR', radius: 333.5106201171875 }],
        },
        children: [],
      }],
    }],
  }, {
    assets: [{
      assetId: 'node_yellow_glow', renderPolicy: 'required-final', format: 'png',
      preferred: { copiedPath: 'assets/decorative/yellow-glow.png' },
      sourceNodes: [{ sourceNodeId: 'yellow-glow' }],
    }],
  })

  const fact = requiredRasterEffectFacts(payload).find((item) => item.sourceNodeId === 'yellow-glow')
  assert.equal(fact.rasterEffect.assetMode, 'required-final-png')
  assert.equal(fact.rasterEffect.assetAvailable, true)
  assert.equal(fact.rasterEffect.assetId, 'node_yellow_glow')
  assert.equal(fact.rasterEffect.assetPath, 'assets/decorative/yellow-glow.png')
})

test('node style facts link standalone layer blur to its required-final SVG', () => {
  const payload = buildNodeStyleFacts({
    nodes: [{
      id: 'root', sourceNodeId: 'root', visible: true, type: 'FRAME',
      relativeBounds: { x: 0, y: 0, width: 1920, height: 1080 }, style: { fills: [] },
      children: [{
        id: 'red-glow', sourceNodeId: 'red-glow', parentId: 'root', name: '圆形 61', visible: true, type: 'ELLIPSE',
        relativeBounds: { x: 1791, y: 231, width: 192, height: 192 },
        style: {
          fills: [{ type: 'SOLID', color: { r: 0.87, g: 0.03, b: 0.11, a: 0.4 }, alpha: 1 }],
          effects: [{ type: 'LAYER_BLUR', radius: 255 }],
        },
        children: [],
      }],
    }],
  }, {
    assets: [{
      assetId: 'node_red_glow', renderPolicy: 'required-final', format: 'svg',
      preferred: { copiedPath: 'assets/decorative/red-glow.svg', format: 'svg' },
      sourceNodes: [{ sourceNodeId: 'red-glow' }],
    }],
  })

  const fact = requiredRasterEffectFacts(payload).find((item) => item.sourceNodeId === 'red-glow')
  assert.equal(fact.rasterEffect.assetMode, 'required-final-svg')
  assert.equal(fact.rasterEffect.assetFormat, 'svg')
  assert.equal(fact.rasterEffect.assetAvailable, true)
  assert.equal(fact.rasterEffect.assetPath, 'assets/decorative/red-glow.svg')
})

test('node style facts require source auto-width CTA text to remain on one line', () => {
  const payload = buildNodeStyleFacts({
    nodes: [{
      id: 'root', sourceNodeId: 'root', visible: true, type: 'FRAME',
      relativeBounds: { x: 0, y: 0, width: 1920, height: 1080 }, style: { fills: [] },
      children: [{
        id: '200:03623', sourceNodeId: '200:03623', parentId: 'root', name: '查看全部岗位', visible: true, type: 'TEXT',
        text: '查看全部岗位',
        relativeBounds: { x: 1316, y: 922, width: 132, height: 29 },
        style: {
          fills: [{ type: 'SOLID', color: { r: 0.043, g: 0.345, b: 0.745, a: 1 }, alpha: 1 }],
          text: {
            characters: '查看全部岗位',
            textAutoResize: 'WIDTH_AND_HEIGHT',
            fontFamily: 'MiSans',
            fontSize: 22,
            fontWeight: 400,
            lineHeight: 29,
            textAlignHorizontal: 'LEFT',
          },
        },
        children: [],
      }],
    }],
  })

  const fact = requiredTypographyFacts(payload).find((item) => item.sourceNodeId === '200:03623')
  assert.equal(fact.singleLineRequired, true)
  assert.equal(fact.typography.textAutoResize, 'WIDTH_AND_HEIGHT')
  assert.equal(fact.typography.fontSize, 22)
  assert.equal(fact.typography.lineHeight, 29)
})

test('legacy normalized one-line text infers no-wrap from its one-line height', () => {
  const payload = buildNodeStyleFacts({
    nodes: [{
      id: 'root', sourceNodeId: 'root', visible: true, type: 'FRAME',
      relativeBounds: { x: 0, y: 0, width: 1920, height: 1080 }, style: { fills: [] },
      children: [{
        id: 'legacy-cta', sourceNodeId: 'legacy-cta', parentId: 'root', name: '查看全部岗位', visible: true, type: 'TEXT',
        text: '查看全部岗位',
        relativeBounds: { x: 1316, y: 922, width: 132, height: 29 },
        style: {
          fills: [{ type: 'SOLID', color: { r: 0.043, g: 0.345, b: 0.745, a: 1 }, alpha: 1 }],
          text: { characters: '查看全部岗位', fontFamily: 'MiSans', fontSize: 22, fontWeight: 400, lineHeight: 29 },
        },
        children: [],
      }],
    }],
  })

  const fact = requiredTypographyFacts(payload).find((item) => item.sourceNodeId === 'legacy-cta')
  assert.equal(fact.singleLineRequired, true)
  assert.equal(fact.typography.textAutoResize, undefined)
})

test('blue recruitment-card blur preserves its exact source color and is not a yellow-only special case', () => {
  const payload = buildNodeStyleFacts({
    nodes: [{
      id: 'root', sourceNodeId: 'root', visible: true, type: 'FRAME',
      relativeBounds: { x: 0, y: 0, width: 1920, height: 1080 }, style: { fills: [] },
      children: [{
        id: '200:03606', sourceNodeId: '200:03606', parentId: 'root', name: '圆形 56', visible: true, type: 'ELLIPSE',
        relativeBounds: { x: 958, y: 461, width: 304, height: 304 },
        relativeRenderBounds: { x: 698, y: 201, width: 824, height: 824 },
        style: {
          opacity: 1,
          fills: [{ type: 'SOLID', color: { r: 12 / 255, g: 112 / 255, b: 219 / 255, a: 0.2 }, alpha: 1 }],
          effects: [{ type: 'LAYER_BLUR', radius: 173 }],
        },
        children: [],
      }],
    }],
  })

  const fact = requiredRasterEffectFacts(payload).find((item) => item.sourceNodeId === '200:03606')
  assert.equal(fact.resolvedBackgroundColor, 'rgba(12, 112, 219, 0.2)')
  assert.deepEqual(fact.renderBounds, { x: 698, y: 201, width: 824, height: 824 })
  assert.equal(fact.rasterEffect.effects[0].radius, 173)
  assert.equal(fact.rasterEffect.assetMode, 'css-fallback')
})
