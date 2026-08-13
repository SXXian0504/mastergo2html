import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertAutoFrameBridgeSupport,
  assertPageBundleBridgeSupport,
  assertResponsivePageBridgeSupport,
  assertPageBundleV2BridgeSupport,
  buildMasterGoPluginExportRequest,
  isBridgePermissionError,
  normalizeMasterGoPluginExportMode,
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
    responsivePairing: false,
    options: {
      includeOriginalImages: false,
      includeRenderedSlices: true,
      rawProfile: 'html',
    },
  })
})


test('auto export request lets the plugin choose single page or page bundle from the current selection', () => {
  const request = buildMasterGoPluginExportRequest({ mode: 'auto' })

  assert.equal(request.mode, 'auto')
  assert.equal(request.frameName, undefined)
  assert.equal(request.nodeId, undefined)
})

test('responsive Agent auto request advertises pairing intent and requires the responsive bridge feature', () => {
  const request = buildMasterGoPluginExportRequest({ mode: 'auto', responsivePairing: true })
  assert.equal(request.responsivePairing, true)
  assert.doesNotThrow(() => assertResponsivePageBridgeSupport({
    features: ['mastergo-page-bundle-v1', 'mastergo-auto-frame-bundle-v1', 'mastergo-responsive-page-v1'],
  }))
  assert.throws(() => assertResponsivePageBridgeSupport({
    features: ['mastergo-page-bundle-v1', 'mastergo-auto-frame-bundle-v1'],
  }), /不支持响应式 Frame 配对/)
})

test('export mode normalization keeps supported modes and falls back to single page', () => {
  assert.equal(normalizeMasterGoPluginExportMode('auto'), 'auto')
  assert.equal(normalizeMasterGoPluginExportMode('page-bundle'), 'page-bundle')
  assert.equal(normalizeMasterGoPluginExportMode('unknown'), 'single-page')
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

test('responsive page batches require the page-bundle v2 bridge capability', () => {
  assert.doesNotThrow(() => assertPageBundleV2BridgeSupport({
    features: ['mastergo-page-bundle-v1', 'mastergo-page-bundle-v2'],
  }))
  assert.throws(() => assertPageBundleV2BridgeSupport({
    features: ['mastergo-page-bundle-v1'],
  }), /不支持逻辑页面与响应式页面混合批次/)
})

test('auto frame mode requires the upgraded bridge feature', () => {
  assert.doesNotThrow(() => assertAutoFrameBridgeSupport({
    ok: true,
    features: ['mastergo-page-bundle-v1', 'mastergo-auto-frame-bundle-v1'],
  }))
  assert.throws(
    () => assertAutoFrameBridgeSupport({ ok: true, features: ['mastergo-page-bundle-v1'] }),
    /不支持自动识别单个\/多个 Frame/,
  )
})

test('bridge permission errors are distinguished from unavailable bridge errors', () => {
  assert.equal(isBridgePermissionError({ code: 'EPERM' }), true)
  assert.equal(isBridgePermissionError({ cause: { code: 'EACCES' } }), true)
  assert.equal(isBridgePermissionError({ code: 'ECONNREFUSED' }), false)
})
