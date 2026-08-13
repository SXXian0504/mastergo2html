import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveNodeGeometryBounds } from '../src/raw-layout-conversion.js'

test('180-degree nodes use their equally sized visual bounds instead of the shifted transform origin', () => {
  const bounds = resolveNodeGeometryBounds({
    rotation: 180,
    absoluteBoundingBox: { x: 1088, y: 200, width: 88, height: 88 },
    absoluteRenderBounds: { x: 1000, y: 200, width: 88, height: 88 },
  })
  assert.deepEqual(bounds, { x: 1000, y: 200, width: 88, height: 88 })
})

test('ordinary render bleed does not replace source geometry', () => {
  const bounds = resolveNodeGeometryBounds({
    rotation: 0,
    absoluteBoundingBox: { x: 1000, y: 200, width: 88, height: 88 },
    absoluteRenderBounds: { x: 990, y: 190, width: 108, height: 108 },
  })
  assert.deepEqual(bounds, { x: 1000, y: 200, width: 88, height: 88 })
})
