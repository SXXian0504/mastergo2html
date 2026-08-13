import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  RESPONSIVE_PAGE_VERSION,
  pairResponsiveFrames,
  prepareResponsivePage,
  validateResponsivePageManifest,
} from '../src/responsive-page.js'

test('pairs the exact base name and -移动端 Frame in either selection order', () => {
  const desktop = { id: 'desktop', name: '校招资讯-应届生Q&A', type: 'FRAME', width: 1920, height: 4000 }
  const mobile = { id: 'mobile', name: '校招资讯-应届生Q&A-移动端', type: 'FRAME', width: 375, height: 5000 }
  assert.equal(pairResponsiveFrames([desktop, mobile]).baseName, desktop.name)
  assert.equal(pairResponsiveFrames([mobile, desktop]).desktop.id, 'desktop')
})

test('does not pair ambiguous names, invalid sizes, extra Frames, or non-Frames', () => {
  const desktop = { name: 'Q&A', type: 'FRAME', width: 1920, height: 1000 }
  const mobile = { name: 'Q&A-移动端', type: 'FRAME', width: 375, height: 1000 }
  assert.equal(pairResponsiveFrames([desktop, { ...mobile, name: 'Other-移动端' }]), null)
  assert.equal(pairResponsiveFrames([{ ...desktop, width: 800 }, mobile]), null)
  assert.equal(pairResponsiveFrames([desktop, { ...mobile, width: 900 }]), null)
  assert.equal(pairResponsiveFrames([desktop, mobile, { ...desktop, name: 'Third' }]), null)
  assert.equal(pairResponsiveFrames([desktop, { ...mobile, type: 'GROUP' }]), null)
})

test('validates and resolves a responsive page bundle with two complete variants', () => {
  const root = join('/tmp', `mastergo-responsive-page-${Date.now()}-${Math.random()}`)
  writeVariant(root, 'desktop')
  writeVariant(root, 'mobile')
  const manifest = createManifest()
  writeFileSync(join(root, 'mastergo-responsive-page.json'), JSON.stringify(manifest))
  assert.equal(validateResponsivePageManifest(manifest).ok, true)
  const prepared = prepareResponsivePage(root, join(root, '.workspace'))
  assert.equal(prepared.manifest.version, RESPONSIVE_PAGE_VERSION)
  assert.match(prepared.variants.desktop.inputPath, /variants\/desktop\/00-input$/)
  assert.match(prepared.variants.mobile.inputPath, /variants\/mobile\/00-input$/)
})

test('rejects a responsive page bundle when either variant is incomplete', () => {
  const root = join('/tmp', `mastergo-responsive-page-invalid-${Date.now()}-${Math.random()}`)
  writeVariant(root, 'desktop')
  const mobileDir = writeVariant(root, 'mobile')
  rmSync(join(mobileDir, 'frame-screenshot.png'))
  writeFileSync(join(root, 'mastergo-responsive-page.json'), JSON.stringify(createManifest()))
  assert.throws(() => prepareResponsivePage(root, join(root, '.workspace')), /mobile 00-input 缺少 frame-screenshot\.png/)
})

function createManifest() {
  return {
    version: RESPONSIVE_PAGE_VERSION,
    source: { pageId: 'page', pageName: 'Page' },
    page: { name: '校招资讯-应届生Q&A', baseName: '校招资讯-应届生Q&A' },
    breakpoints: { mobileMax: 767 },
    variants: {
      desktop: { name: '校招资讯-应届生Q&A', sourceNodeId: 'desktop', inputDir: 'variants/desktop/00-input', viewport: { width: 1920, height: 4000 } },
      mobile: { name: '校招资讯-应届生Q&A-移动端', sourceNodeId: 'mobile', inputDir: 'variants/mobile/00-input', viewport: { width: 375, height: 5000 } },
    },
  }
}

function writeVariant(root, kind) {
  const inputDir = join(root, 'variants', kind, '00-input')
  mkdirSync(inputDir, { recursive: true })
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({ selection: [] }))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({ assets: [] }))
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { targetPlatform: 'web' } }))
  writeFileSync(join(inputDir, 'frame-screenshot.png'), Buffer.from([137, 80, 78, 71]))
  return inputDir
}
