import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPageBundleBridgeSupport,
  buildMasterGoPluginExportRequest,
} from '../src/mastergo-plugin-export.js'

test('page-bundle export request advertises page-bundle mode', () => {
  const request = buildMasterGoPluginExportRequest({
    mode: 'page-bundle',
    pageName: 'Website',
  })

  assert.deepEqual(request, {
    mode: 'page-bundle',
    pageName: 'Website',
    frameName: undefined,
    nodeId: undefined,
    options: {
      includeOriginalImages: false,
      includeRenderedSlices: true,
      rawProfile: 'html',
    },
  })
})

test('single-page remains the default export mode', () => {
  const request = buildMasterGoPluginExportRequest({ frameName: 'Home' })

  assert.equal(request.mode, 'single-page')
  assert.equal(request.frameName, 'Home')
})

test('page-bundle bridge capability accepts the current bridge feature', () => {
  assert.doesNotThrow(() => assertPageBundleBridgeSupport({
    ok: true,
    features: ['mastergo-page-bundle-v1'],
  }))
})

test('page-bundle bridge capability rejects an outdated bridge', () => {
  assert.throws(
    () => assertPageBundleBridgeSupport({ ok: true }),
    /不支持多页面导出/,
  )
})
