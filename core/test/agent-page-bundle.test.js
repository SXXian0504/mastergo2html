import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { prepareAgentPageBundleInput, validateAgentPageBundleManifest } from '../src/agent-page-bundle.js'

test('parses a mixed page-bundle v2 and resolves desktop reference screenshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-page-bundle-v2-'))
  writeSingleInput(join(root, 'pages', 'about', '00-input'), 'about')
  writeResponsiveInput(join(root, 'pages', 'home', 'responsive-page'))
  writeFileSync(join(root, 'mastergo-pages.json'), JSON.stringify({
    version: 'mastergo2html.page-bundle.v2',
    frameCount: 3,
    pages: [
      { id: 'home', name: '首页', route: '/', inputKind: 'responsive-page', inputDir: 'pages/home/responsive-page', sourceNodeId: 'home-desktop', sourceNodeIds: ['home-desktop', 'home-mobile'] },
      { id: 'about', name: '关于', route: '/about', inputKind: 'single-page', inputDir: 'pages/about/00-input', sourceNodeId: 'about', sourceNodeIds: ['about'] },
    ],
  }))
  const prepared = prepareAgentPageBundleInput(root, join(root, '.workspace'))
  assert.deepEqual(prepared.pages.map((page) => page.inputKind), ['responsive-page', 'single-page'])
  assert.match(prepared.pages[0].frameScreenshotPath, /variants\/desktop\/00-input\/frame-screenshot\.png$/)
})

test('maps page-bundle v1 pages to single-page inputs', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-page-bundle-v1-'))
  writeSingleInput(join(root, 'pages', 'home', '00-input'), 'home')
  writeFileSync(join(root, 'mastergo-pages.json'), JSON.stringify({
    version: 'mastergo2html.page-bundle.v1',
    pages: [{ id: 'home', name: 'Home', route: '/', inputDir: 'pages/home/00-input', sourceNodeId: 'home' }],
  }))
  assert.equal(prepareAgentPageBundleInput(root, join(root, '.workspace')).pages[0].inputKind, 'single-page')
})

test('rejects invalid page-bundle v2 contracts and unsafe paths', () => {
  const base = { version: 'mastergo2html.page-bundle.v2', frameCount: 1 }
  assert.throws(() => validateAgentPageBundleManifest({
    ...base,
    pages: [{ id: 'home', name: 'Home', route: '/', inputKind: 'other', inputDir: 'pages/home', sourceNodeId: 'home', sourceNodeIds: ['home'] }],
  }), /inputKind 无效/)
  assert.throws(() => validateAgentPageBundleManifest({
    ...base,
    pages: [{ id: 'home', name: 'Home', route: '/', inputKind: 'single-page', inputDir: '../outside', sourceNodeId: 'home', sourceNodeIds: ['home'] }],
  }), /非法页面 inputDir/)
  assert.throws(() => validateAgentPageBundleManifest({
    version: 'mastergo2html.page-bundle.v2', frameCount: 2,
    pages: [
      { id: 'one', name: 'One', route: '/', inputKind: 'single-page', inputDir: 'one', sourceNodeId: 'one', sourceNodeIds: ['one'] },
      { id: 'two', name: 'Two', route: '/', inputKind: 'single-page', inputDir: 'two', sourceNodeId: 'two', sourceNodeIds: ['two'] },
    ],
  }), /route 重复/)
  assert.throws(() => validateAgentPageBundleManifest({
    version: 'mastergo2html.page-bundle.v2', frameCount: 2,
    pages: [{ id: 'one', name: 'One', route: '/', inputKind: 'single-page', inputDir: 'one', sourceNodeId: 'one', sourceNodeIds: ['one'] }],
  }), /sourceNodeIds 总数/)
  assert.throws(() => validateAgentPageBundleManifest({
    version: 'mastergo2html.page-bundle.v2', frameCount: 2,
    pages: [
      { id: 'one', name: 'One', route: '/', inputKind: 'single-page', inputDir: 'one', sourceNodeId: 'same', sourceNodeIds: ['same'] },
      { id: 'two', name: 'Two', route: '/two', inputKind: 'single-page', inputDir: 'two', sourceNodeId: 'same', sourceNodeIds: ['same'] },
    ],
  }), /重复引用/)
})

function writeResponsiveInput(root) {
  writeSingleInput(join(root, 'variants', 'desktop', '00-input'), 'home-desktop', '首页', 1440)
  writeSingleInput(join(root, 'variants', 'mobile', '00-input'), 'home-mobile', '首页-移动端', 375)
  writeFileSync(join(root, 'mastergo-responsive-page.json'), JSON.stringify({
    version: 'mastergo2html.responsive-page.v1',
    page: { name: '首页', baseName: '首页' },
    variants: {
      desktop: { name: '首页', sourceNodeId: 'home-desktop', inputDir: 'variants/desktop/00-input', viewport: { width: 1440, height: 900 } },
      mobile: { name: '首页-移动端', sourceNodeId: 'home-mobile', inputDir: 'variants/mobile/00-input', viewport: { width: 375, height: 900 } },
    },
  }))
}

function writeSingleInput(root, id, name = id, width = 1440) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'raw.json'), JSON.stringify({ page: { id: 'page', name }, selection: [{ id, name, type: 'FRAME', absoluteBoundingBox: { x: 0, y: 0, width, height: 900 } }] }))
  writeFileSync(join(root, 'asset-manifest.json'), JSON.stringify({ assets: [] }))
  writeFileSync(join(root, 'export-options.json'), JSON.stringify({ exportOptions: { rawProfile: 'html' } }))
  writeFileSync(join(root, 'frame-screenshot.png'), Buffer.from([137, 80, 78, 71]))
}
