import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { PNG } from 'pngjs'
import { hydrateInputAssets } from '../src/asset-hydrator.js'

function makeInput(dir, assets, children = []) {
  const inputDir = join(dir, '00-input')
  mkdirSync(inputDir, { recursive: true })
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'mastergo2html.raw.v1',
    sourceKind: 'magic-dsl',
    selection: [{
      id: 'root', name: 'Frame', type: 'FRAME',
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
      children,
    }],
  }))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets,
    files: [],
  }))
  writePng(join(inputDir, 'frame-screenshot.png'), 1, 1)
  return inputDir
}

function missingImage(overrides = {}) {
  return {
    assetId: 'img_0001', kind: 'image', imageRef: 'missing.png', status: 'reference-only',
    sourceNodes: [{ nodeId: 'node-1', nodeName: 'Image', paintPath: 'fills[0]', usageHint: 'content-image' }],
    suggestedFile: 'assets/img/img_0001.png', format: 'png', targetDir: 'assets/img', renderedAssets: [],
    error: 'missing', ...overrides,
  }
}

function makeSnapshot(dir, images, rootId = 'root') {
  const snapshotDir = join(dir, '.mastergo', 'design', 'doc', 'page')
  mkdirSync(join(snapshotDir, 'asset', 'images'), { recursive: true })
  const tags = images.map((image, index) => {
    writeFileSync(join(snapshotDir, 'asset', 'images', image.file), image.content || `content-${index}`)
    return `<img data-node-id="${image.nodeId}" data-name="${image.name || 'Image'}" src="./asset/images/${image.file}" style="left:${image.x || 0}px;top:${image.y || 0}px;width:${image.width || 20}px;height:${image.height || 20}px">`
  })
  const htmlPath = join(snapshotDir, 'Frame.html')
  writeFileSync(htmlPath, `<div data-node-id="${rootId}" data-name="Frame" style="left:0;top:0;width:100px;height:100px">${tags.join('')}</div>`)
  return htmlPath
}

function writePng(path, width, height) {
  const png = new PNG({ width, height })
  png.data.fill(255)
  writeFileSync(path, PNG.sync.write(png))
}

test('exact node id match hydrates a missing asset and updates manifest files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-hydrator-'))
  const inputDir = makeInput(dir, [missingImage()])
  const htmlPath = makeSnapshot(dir, [{ file: 'snapshot.png', nodeId: 'node-1', content: 'node-resource' }])

  const result = hydrateInputAssets({ inputDir, snapshotHtml: htmlPath })
  const manifest = JSON.parse(readFileSync(join(inputDir, 'asset-manifest.json'), 'utf8'))
  const asset = manifest.assets[0]
  assert.equal(result.matched, 1)
  assert.equal(asset.status, 'present')
  assert.equal(asset.copiedPath, 'assets/img/img_0001.png')
  assert.equal(readFileSync(join(inputDir, asset.copiedPath), 'utf8'), 'node-resource')
  assert.equal(asset.hydration.reasons.includes('exact-node-id'), true)
  assert.equal(manifest.files[0].status, 'present')
})

test('imageRef basename or hash match hydrates when node ids differ', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-hydrator-'))
  const inputDir = makeInput(dir, [missingImage({
    imageRef: 'https://cdn.example/assets/hash123.png?token=x',
    sourceNodes: [{ nodeId: 'magic-node', usageHint: 'content-image' }],
  })])
  const htmlPath = makeSnapshot(dir, [{ file: 'hash123.png', nodeId: 'snapshot-node', content: 'hash-resource' }])

  const result = hydrateInputAssets({ inputDir, snapshotHtml: htmlPath })
  assert.equal(result.matched, 1)
  assert.equal(readFileSync(join(inputDir, 'assets/img/img_0001.png'), 'utf8'), 'hash-resource')
})

test('valid present asset is never overwritten and hydration is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-hydrator-'))
  const asset = missingImage({ status: 'present', copiedPath: 'assets/img/img_0001.png', error: undefined })
  const inputDir = makeInput(dir, [asset])
  mkdirSync(join(inputDir, 'assets', 'img'), { recursive: true })
  writeFileSync(join(inputDir, 'assets', 'img', 'img_0001.png'), 'keep-me')
  const htmlPath = makeSnapshot(dir, [{ file: 'snapshot.png', nodeId: 'node-1', content: 'replace-me-not' }])

  const first = hydrateInputAssets({ inputDir, snapshotHtml: htmlPath })
  const second = hydrateInputAssets({ inputDir, snapshotHtml: htmlPath })
  const manifest = JSON.parse(readFileSync(join(inputDir, 'asset-manifest.json'), 'utf8'))
  assert.equal(first.skippedPresent, 1)
  assert.equal(second.skippedPresent, 1)
  assert.equal(readFileSync(join(inputDir, asset.copiedPath), 'utf8'), 'keep-me')
  assert.equal(manifest.assets.length, 1)
  assert.equal(manifest.files.length, 1)
})

test('ambiguous candidates remain unresolved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-hydrator-'))
  const inputDir = makeInput(dir, [missingImage({
    imageRef: 'shared',
    sourceNodes: [{ nodeId: 'magic-node', usageHint: 'content-image' }],
  })])
  const htmlPath = makeSnapshot(dir, [
    { file: 'shared.png', nodeId: 'snapshot-a' },
    { file: 'shared.jpg', nodeId: 'snapshot-b' },
  ])

  const result = hydrateInputAssets({ inputDir, snapshotHtml: htmlPath })
  const manifest = JSON.parse(readFileSync(join(inputDir, 'asset-manifest.json'), 'utf8'))
  assert.equal(result.matched, 0)
  assert.equal(result.ambiguous, 1)
  assert.equal(manifest.assets[0].status, 'reference-only')
})

test('placeholder screenshot crop failure is fail-open and writes a report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-hydrator-'))
  const inputDir = makeInput(dir, [], [{
    id: 'vector', name: 'Logo', type: 'VECTOR',
    absoluteBoundingBox: { x: 10, y: 10, width: 20, height: 20 }, children: [],
  }])

  const result = hydrateInputAssets({ inputDir, cropComplex: true })
  const report = JSON.parse(readFileSync(result.reportPath, 'utf8'))
  assert.equal(result.ok, false)
  assert.equal(result.cropped, 0)
  assert.equal(report.errors[0].stage, 'frame-screenshot-crop')
  assert.equal(existsSync(result.reportPath), true)
})

test('missing node-slice hydration updates its rendered asset using the actual format', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-hydrator-'))
  const inputDir = makeInput(dir, [{
    assetId: 'node_0001', kind: 'node-slice', imageRef: 'logo-key', status: 'reference-only',
    renderPolicy: 'required-final', mustUseRenderedSlice: true,
    sourceNodes: [{ nodeId: 'logo-node', nodeName: 'Logo', paintPath: 'node', usageHint: 'logo' }],
    suggestedFile: 'assets/icon/logo-key.svg', format: 'svg', targetDir: 'assets/icon',
    renderedAssets: [{
      assetId: 'slice_0001', kind: 'rendered-image', format: 'svg', nodeId: 'logo-node',
      status: 'reference-only', suggestedFile: 'assets/icon/logo-key.svg',
    }],
    error: 'missing svg',
  }])
  const htmlPath = makeSnapshot(dir, [{ file: 'logo.svg', nodeId: 'logo-node', content: '<svg><path/></svg>' }])

  const result = hydrateInputAssets({ inputDir, snapshotHtml: htmlPath })
  const manifest = JSON.parse(readFileSync(join(inputDir, 'asset-manifest.json'), 'utf8'))
  const asset = manifest.assets[0]
  assert.equal(result.matched, 1)
  assert.equal(asset.status, 'present')
  assert.equal(asset.copiedPath, 'assets/icon/node_0001.svg')
  assert.equal(asset.renderedAssets[0].status, 'present')
  assert.equal(asset.renderedAssets[0].copiedPath, asset.copiedPath)
  assert.equal(manifest.files[0].kind, 'node-slice')
})

test('root mismatch disables screenshot crop while keeping hydration fail-open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mastergo2html-hydrator-'))
  const inputDir = makeInput(dir, [], [{
    id: 'vector', name: 'Logo', type: 'VECTOR',
    absoluteBoundingBox: { x: 10, y: 10, width: 20, height: 20 }, children: [],
  }])
  const htmlPath = makeSnapshot(dir, [], 'different-root')
  const screenshot = join(dir, 'full-frame.png')
  writePng(screenshot, 100, 100)

  const result = hydrateInputAssets({ inputDir, snapshotHtml: htmlPath, screenshot, cropComplex: true })
  const report = JSON.parse(readFileSync(result.reportPath, 'utf8'))
  assert.equal(result.cropped, 0)
  assert.equal(report.rootValidation.compatible, false)
  assert.match(report.errors[0].message, /根 Frame.*不匹配/)
})
