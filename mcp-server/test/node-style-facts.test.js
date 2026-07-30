import assert from 'node:assert/strict'
import test from 'node:test'
import { buildNodeStyleFacts, requiredBackgroundFacts, requiredTypographyFacts } from '../src/workflow/node-style-facts.js'

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
