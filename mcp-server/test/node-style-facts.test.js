import assert from 'node:assert/strict'
import test from 'node:test'
import { buildNodeStyleFacts, requiredBackgroundFacts } from '../src/workflow/node-style-facts.js'

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
