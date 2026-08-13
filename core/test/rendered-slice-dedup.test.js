import assert from 'node:assert/strict'
import test from 'node:test'
import { removeDescendantForcedSlices } from '../../lib/rendered-slice-dedup.ts'

test('review-only navigation slice and its required-final logo descendant are both retained', () => {
  const sources = [
    source('nav', 'masked-composite', 'review-only', 'png'),
    source('nav-logo', 'logo', 'required-final', 'svg'),
  ]
  const parentById = parents([
    ['nav', null],
    ['nav-logo', 'nav'],
  ])

  assert.deepEqual(
    removeDescendantForcedSlices(sources, parentById).map((item) => item.nodeId),
    ['nav', 'nav-logo'],
  )
})

test('required-final masked composite suppresses internal logo and image slices', () => {
  const sources = [
    source('card', 'masked-composite', 'required-final', 'png'),
    source('card-logo', 'logo', 'required-final', 'svg'),
    source('card-image', 'content-image', 'required-final', 'png'),
  ]
  const parentById = parents([
    ['card', null],
    ['card-logo', 'card'],
    ['card-image', 'card'],
  ])

  assert.deepEqual(
    removeDescendantForcedSlices(sources, parentById).map((item) => item.nodeId),
    ['card'],
  )
})

test('nested required-final masks retain only the innermost final composite', () => {
  const sources = [
    source('outer-mask', 'masked-composite', 'required-final', 'png'),
    source('inner-mask', 'masked-composite', 'required-final', 'png'),
    source('inner-logo', 'logo', 'required-final', 'svg'),
  ]
  const parentById = parents([
    ['outer-mask', null],
    ['inner-mask', 'outer-mask'],
    ['inner-logo', 'inner-mask'],
  ])

  assert.deepEqual(
    removeDescendantForcedSlices(sources, parentById).map((item) => item.nodeId),
    ['inner-mask'],
  )
})

test('review-only whole-node reference does not suppress a final logo descendant', () => {
  const reviewWhole = source('header-review', 'masked-composite', 'review-only', 'png')
  reviewWhole.wholeNodePng = true
  const sources = [reviewWhole, source('brand-logo', 'logo', 'required-final', 'svg')]
  const parentById = parents([
    ['header-review', null],
    ['brand-logo', 'header-review'],
  ])

  assert.deepEqual(
    removeDescendantForcedSlices(sources, parentById).map((item) => item.nodeId),
    ['header-review', 'brand-logo'],
  )
})

function source(nodeId, usageHint, renderPolicy, exportFormat) {
  return {
    nodeId,
    nodeName: nodeId,
    paintPath: 'node',
    usageHint,
    renderPolicy,
    exportFormat,
  }
}

function parents(entries) {
  const nodes = new Map(entries.map(([id]) => [id, { id }]))
  return new Map(entries.map(([id, parentId]) => [id, parentId ? nodes.get(parentId) || null : null]))
}
