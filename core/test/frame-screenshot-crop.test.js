import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PNG } from 'pngjs'
import {
  calculateScreenshotTransform,
  cropComplexNodesFromScreenshot,
  designBoundsToPixels,
  hasWholeNodePngNaming,
} from '../src/frame-screenshot-crop.js'

function makePng(path, width, height) {
  const png = new PNG({ width, height })
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4
      png.data[offset] = x % 256
      png.data[offset + 1] = y % 256
      png.data[offset + 2] = 0
      png.data[offset + 3] = 255
    }
  }
  writeFileSync(path, PNG.sync.write(png))
}

function root(children, bounds = { x: 0, y: 0, width: 100, height: 100 }) {
  return { selection: [{ id: 'root', name: 'Frame', type: 'FRAME', absoluteBoundingBox: bounds, children }] }
}

test('100x100 design maps to 200x200 screenshot and crops at 2x coordinates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-crop-'))
  const screenshot = join(dir, 'frame.png')
  makePng(screenshot, 200, 200)
  const raw = root([{
    id: 'logo', name: 'Logo', type: 'VECTOR',
    absoluteBoundingBox: { x: 10, y: 20, width: 30, height: 25 }, children: [],
  }])
  const manifest = { assets: [] }

  const result = cropComplexNodesFromScreenshot({ inputDir: dir, raw, manifest, screenshot })
  assert.equal(result.crops.length, 1)
  assert.deepEqual(result.crops[0].pixelBounds, { left: 20, top: 40, width: 60, height: 50 })
  const output = PNG.sync.read(readFileSync(join(dir, result.crops[0].copiedPath)))
  assert.equal(output.width, 60)
  assert.equal(output.height, 50)
  assert.equal(output.data[0], 20)
  assert.equal(output.data[1], 40)
})

test('nonzero frame origin converts design bounds relative to the frame', () => {
  const frame = { x: 100, y: 200, width: 100, height: 100 }
  const transform = calculateScreenshotTransform(frame, { width: 200, height: 200 })
  assert.deepEqual(designBoundsToPixels(
    { x: 110, y: 220, width: 30, height: 25 }, frame, transform,
  ), { left: 20, top: 40, width: 60, height: 50 })
})

test('placeholder and aspect-ratio-mismatched screenshots are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-crop-'))
  const placeholder = join(dir, 'placeholder.png')
  const mismatch = join(dir, 'mismatch.png')
  makePng(placeholder, 1, 1)
  makePng(mismatch, 200, 100)
  const raw = root([{ id: 'v', name: 'Icon', type: 'VECTOR', absoluteBoundingBox: { x: 10, y: 10, width: 20, height: 20 }, children: [] }])
  assert.throws(() => cropComplexNodesFromScreenshot({ inputDir: dir, raw, manifest: { assets: [] }, screenshot: placeholder }), /1x1/)
  assert.throws(() => cropComplexNodesFromScreenshot({ inputDir: dir, raw, manifest: { assets: [] }, screenshot: mismatch }), /长宽比不一致/)
})

test('automatic crop avoids text-containing composites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-crop-'))
  const screenshot = join(dir, 'frame.png')
  makePng(screenshot, 100, 100)
  const raw = root([{
    id: 'logo-with-text', name: 'Logo composite', type: 'GROUP',
    absoluteBoundingBox: { x: 10, y: 10, width: 30, height: 30 },
    children: [{
      id: 'text', name: 'Brand', type: 'TEXT', characters: 'Brand',
      absoluteBoundingBox: { x: 12, y: 12, width: 20, height: 10 }, children: [],
    }],
  }])
  const manifest = { assets: [] }
  const result = cropComplexNodesFromScreenshot({ inputDir: dir, raw, manifest, screenshot })
  assert.equal(result.crops.length, 0)
})

test('selected parent crop suppresses a complex child crop', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-crop-'))
  const screenshot = join(dir, 'frame.png')
  makePng(screenshot, 100, 100)
  const raw = root([{
    id: 'parent', name: 'Decor group', type: 'GROUP',
    absoluteBoundingBox: { x: 5, y: 5, width: 40, height: 40 },
    children: [{
      id: 'child', name: 'Icon', type: 'VECTOR',
      absoluteBoundingBox: { x: 10, y: 10, width: 15, height: 15 }, children: [],
    }],
  }])
  const manifest = { assets: [] }
  const result = cropComplexNodesFromScreenshot({ inputDir: dir, raw, manifest, screenshot })
  assert.deepEqual(result.crops.map((crop) => crop.nodeId), ['parent'])
  assert.equal(existsSync(join(dir, result.crops[0].copiedPath)), true)
})

test('automatic crop skips complex nodes already backed by a present asset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-crop-'))
  const screenshot = join(dir, 'frame.png')
  makePng(screenshot, 100, 100)
  const raw = root([{
    id: 'icon', name: 'Icon', type: 'VECTOR',
    absoluteBoundingBox: { x: 10, y: 10, width: 20, height: 20 }, children: [],
  }])
  const manifest = { assets: [{
    assetId: 'img_1', kind: 'image', status: 'present', copiedPath: 'assets/img/icon.png',
    suggestedFile: 'assets/img/icon.png', sourceNodes: [{ nodeId: 'icon' }], renderedAssets: [],
  }] }
  const result = cropComplexNodesFromScreenshot({ inputDir: dir, raw, manifest, screenshot })
  assert.equal(result.crops.length, 0)
})


test('整体导出/整体显示 naming forces a whole PNG even for large text composites', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-crop-'))
  const screenshot = join(dir, 'frame.png')
  makePng(screenshot, 100, 100)
  const raw = root([{
    id: 'broken-home-section', name: '首页异常区域-整体显示', type: 'FRAME',
    absoluteBoundingBox: { x: 5, y: 10, width: 90, height: 80 },
    children: [{
      id: 'headline', name: '标题', type: 'TEXT', characters: '首页标题',
      absoluteBoundingBox: { x: 10, y: 20, width: 40, height: 12 }, children: [],
    }],
  }])
  const manifest = { assets: [] }

  assert.equal(hasWholeNodePngNaming(raw), true)
  const result = cropComplexNodesFromScreenshot({ inputDir: dir, raw, manifest, screenshot, auto: false })
  assert.deepEqual(result.crops.map((crop) => crop.nodeId), ['broken-home-section'])
  assert.equal(manifest.assets[0].wholeNodePng, true)
  assert.equal(manifest.assets[0].renderPolicy, 'required-final')
  assert.equal(manifest.assets[0].usageHint, 'masked-composite')
  assert.equal(manifest.assets[0].format, 'png')
  assert.equal(manifest.assets[0].sourceNodes[0].wholeNodePng, true)
  assert.equal(existsSync(join(dir, manifest.assets[0].copiedPath)), true)
})

test('unmarked nodes do not trigger the whole PNG naming convention', () => {
  assert.equal(hasWholeNodePngNaming(root([{
    id: 'normal', name: '首页内容区', type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 50, height: 50 }, children: [],
  }])), false)
})
