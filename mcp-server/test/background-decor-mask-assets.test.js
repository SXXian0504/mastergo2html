import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runRawLayoutConversion } from '../src/workflow/raw-layout-conversion.js'

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

test('background decor mask groups use rendered group slices instead of inner image assets', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-bg-decor-mask-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'rendered'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'rendered', 'inner-image.png'), '')
  writeFileSync(join(inputDir, 'assets', 'rendered', 'decor-mask.png'), '')

  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root',
      name: '页面',
      type: 'FRAME',
      isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
      children: [{
        id: 'decor-group',
        name: '背景装饰 蒙版 波点',
        type: 'GROUP',
        isVisible: true,
        absoluteBoundingBox: { x: 100, y: -80, width: 420, height: 360 },
        children: [{
          id: 'inner-image',
          name: 'image',
          type: 'RECTANGLE',
          isVisible: true,
          absoluteBoundingBox: { x: 120, y: -60, width: 360, height: 320 },
          fills: [{
            type: 'IMAGE',
            imageRef: 'image-ref-dots',
            assetId: 'img_0001',
            scaleMode: 'FILL',
            alpha: 1,
          }],
        }],
      }],
    }],
  }), 'utf8')

  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'img_0001',
      kind: 'image',
      imageRef: 'image-ref-dots',
      status: 'reference-only',
      suggestedFile: 'assets/original/img_0001.png',
      sourceNodes: [{ nodeId: 'inner-image', nodeName: 'image', paintPath: 'fills[0]', scaleMode: 'FILL', alpha: 1 }],
      renderedAssets: [{ assetId: 'slice_0001', nodeId: 'inner-image', status: 'present', copiedPath: 'assets/rendered/inner-image.png', suggestedFile: 'assets/rendered/inner-image.png', width: 360, height: 320 }],
    }, {
      assetId: 'node_0001',
      kind: 'node-slice',
      usageHint: 'background-decor-mask',
      status: 'reference-only',
      suggestedFile: 'assets/rendered/node_0001.png',
      sourceNodes: [{
        nodeId: 'decor-group',
        nodeName: '背景装饰 蒙版 波点',
        paintPath: 'node',
        usageHint: 'background-decor-mask',
        renderReason: '命中“背景装饰 + 蒙版”命名规则，将导出该节点整体切片。',
      }],
      renderedAssets: [{ assetId: 'slice_0002', nodeId: 'decor-group', status: 'present', copiedPath: 'assets/rendered/decor-mask.png', suggestedFile: 'assets/rendered/decor-mask.png', width: 420, height: 360 }],
    }],
  }), 'utf8')
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }), 'utf8')

  await runRawLayoutConversion('job-bg-decor-mask', jobDir)

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const innerImage = assetIndex.assets.find((asset) => asset.assetId === 'img_0001')
  const groupSlice = assetIndex.assets.find((asset) => asset.assetId === 'node_0001')

  assert.equal(innerImage.usage, 'background-decor-child')
  assert.equal(innerImage.sourceNodes[0].insideBackgroundDecorMask, true)
  assert.equal(groupSlice.usage, 'background-decor-mask')
  assert.equal(groupSlice.preferred.copiedPath, 'assets/rendered/decor-mask.png')
  assert.equal(groupSlice.renderingStrategy, 'use-rendered-node-slice')
  assert.equal(groupSlice.mustUseRenderedSlice, true)
  assert.equal(groupSlice.mustNotEnterDocumentFlow, true)
  assert.equal(groupSlice.zIndexGroup, 'background')

  const planningContext = JSON.parse(readFileSync(join(jobDir, '02-layout', 'ai-layout-context.json'), 'utf8'))
  const contextAsset = planningContext.assets.find((asset) => asset.assetId === 'node_0001')
  assert.equal(contextAsset.usage, 'background-decor-mask')
  assert.equal(contextAsset.mustUseRenderedSlice, true)
})

test('00-input asset manifests preserve svg and png split paths during normalization', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-asset-split-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'icon'), { recursive: true })
  mkdirSync(join(inputDir, 'assets', 'img'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'icon', 'logo.svg'), '<svg></svg>', 'utf8')
  writeFileSync(join(inputDir, 'assets', 'img', 'hero.png'), '')

  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root',
      name: '页面',
      type: 'FRAME',
      isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 },
      children: [{
        id: 'logo-node',
        name: 'Logo',
        type: 'RECTANGLE',
        isVisible: true,
        absoluteBoundingBox: { x: 40, y: 24, width: 80, height: 32 },
        fills: [{ type: 'IMAGE', imageRef: 'svg-ref-logo', assetId: 'svg_0001', scaleMode: 'FILL' }],
      }, {
        id: 'hero-node',
        name: 'Hero 蒙版',
        type: 'GROUP',
        isVisible: true,
        absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 480 },
        children: [],
      }],
    }],
  }), 'utf8')

  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'svg_0001',
      kind: 'image',
      imageRef: 'svg-ref-logo',
      status: 'present',
      format: 'svg',
      targetDir: 'assets/icon',
      suggestedFile: 'assets/icon/logo.svg',
      copiedPath: 'assets/icon/logo.svg',
      sourceNodes: [{ nodeId: 'logo-node', nodeName: 'Logo', paintPath: 'fills[0]', usageHint: 'logo' }],
      renderedAssets: [],
    }, {
      assetId: 'png_0001',
      kind: 'node-slice',
      usageHint: 'background-decor-mask',
      mustUseRenderedSlice: true,
      status: 'present',
      format: 'png',
      targetDir: 'assets/img',
      suggestedFile: 'assets/img/hero.png',
      copiedPath: 'assets/img/hero.png',
      sourceNodes: [{ nodeId: 'hero-node', nodeName: 'Hero 蒙版', paintPath: 'node', usageHint: 'background-decor-mask' }],
      renderedAssets: [],
    }],
  }), 'utf8')
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }), 'utf8')

  await runRawLayoutConversion('job-asset-split', jobDir)

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const svgAsset = assetIndex.assets.find((asset) => asset.assetId === 'svg_0001')
  const pngAsset = assetIndex.assets.find((asset) => asset.assetId === 'png_0001')

  assert.equal(svgAsset.format, 'svg')
  assert.equal(svgAsset.targetDir, 'assets/icon')
  assert.equal(svgAsset.preferred.copiedPath, 'assets/icon/logo.svg')
  assert.equal(pngAsset.format, 'png')
  assert.equal(pngAsset.targetDir, 'assets/img')
  assert.equal(pngAsset.preferred.copiedPath, 'assets/img/hero.png')
  assert.equal(pngAsset.mustUseRenderedSlice, true)
})

test('inner image assets inside forced composite slices are not treated as final visuals', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-composite-icon-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'img'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'img', 'inner.png'), '')
  writeFileSync(join(inputDir, 'assets', 'img', 'composite.png'), '')

  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root',
      name: '页面',
      type: 'FRAME',
      isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
      children: [{
        id: 'wechat-group',
        name: '公众号',
        type: 'GROUP',
        isVisible: true,
        absoluteBoundingBox: { x: 100, y: 100, width: 50, height: 50 },
        children: [{
          id: 'mask-rect',
          name: '矩形 1208',
          type: 'RECTANGLE',
          isVisible: true,
          absoluteBoundingBox: { x: 100, y: 100, width: 50, height: 50 },
        }, {
          id: 'inner-image',
          name: 'image',
          type: 'RECTANGLE',
          isVisible: true,
          absoluteBoundingBox: { x: 100, y: 100, width: 50, height: 50 },
          fills: [{ type: 'IMAGE', imageRef: 'inner-image-ref', assetId: 'img_0001', scaleMode: 'FILL', alpha: 1 }],
        }],
      }],
    }],
  }), 'utf8')

  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'img_0001',
      kind: 'image',
      imageRef: 'inner-image-ref',
      status: 'present',
      format: 'png',
      targetDir: 'assets/img',
      suggestedFile: 'assets/img/inner.png',
      copiedPath: 'assets/img/inner.png',
      sourceNodes: [{ nodeId: 'inner-image', nodeName: 'image', paintPath: 'fills[0]', scaleMode: 'FILL', alpha: 1 }],
      renderedAssets: [],
    }, {
      assetId: 'node_0001',
      kind: 'node-slice',
      usageHint: 'complex-vector',
      mustUseRenderedSlice: true,
      status: 'reference-only',
      format: 'png',
      targetDir: 'assets/img',
      suggestedFile: 'assets/img/node_0001.png',
      sourceNodes: [{ nodeId: 'wechat-group', nodeName: '公众号', paintPath: 'node', usageHint: 'complex-vector' }],
      renderedAssets: [{ assetId: 'slice_0001', nodeId: 'wechat-group', status: 'present', copiedPath: 'assets/img/composite.png', suggestedFile: 'assets/img/composite.png', width: 50, height: 50 }],
    }],
  }), 'utf8')
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }), 'utf8')

  await runRawLayoutConversion('job-composite-icon', jobDir)

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const innerImage = assetIndex.assets.find((asset) => asset.assetId === 'img_0001')
  const composite = assetIndex.assets.find((asset) => asset.assetId === 'node_0001')

  assert.equal(innerImage.usage, 'rendered-slice-child')
  assert.equal(innerImage.sourceNodes[0].insideForcedRenderedSlice, true)
  assert.equal(composite.mustUseRenderedSlice, true)
  assert.equal(composite.preferred.copiedPath, 'assets/img/composite.png')
})

test('hidden source nodes and their assets are dropped during normalization', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-hidden-assets-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'img'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'img', 'hidden.png'), '')
  writeFileSync(join(inputDir, 'assets', 'img', 'visible.png'), '')

  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root',
      name: '页面',
      type: 'FRAME',
      isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
      children: [{
        id: 'hidden-image',
        name: '隐藏图片',
        type: 'RECTANGLE',
        isVisible: false,
        absoluteBoundingBox: { x: 10, y: 10, width: 100, height: 100 },
        fills: [{ type: 'IMAGE', imageRef: 'hidden-ref', assetId: 'img_hidden', scaleMode: 'FILL' }],
      }, {
        id: 'visible-image',
        name: '可见图片',
        type: 'RECTANGLE',
        isVisible: true,
        absoluteBoundingBox: { x: 10, y: 120, width: 100, height: 100 },
        fills: [{ type: 'IMAGE', imageRef: 'visible-ref', assetId: 'img_visible', scaleMode: 'FILL' }],
      }],
    }],
  }), 'utf8')

  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'img_hidden',
      kind: 'image',
      imageRef: 'hidden-ref',
      status: 'present',
      format: 'png',
      targetDir: 'assets/img',
      suggestedFile: 'assets/img/hidden.png',
      copiedPath: 'assets/img/hidden.png',
      sourceNodes: [{ nodeId: 'hidden-image', nodeName: '隐藏图片', paintPath: 'fills[0]' }],
      renderedAssets: [],
    }, {
      assetId: 'img_visible',
      kind: 'image',
      imageRef: 'visible-ref',
      status: 'present',
      format: 'png',
      targetDir: 'assets/img',
      suggestedFile: 'assets/img/visible.png',
      copiedPath: 'assets/img/visible.png',
      sourceNodes: [{ nodeId: 'visible-image', nodeName: '可见图片', paintPath: 'fills[0]' }],
      renderedAssets: [],
    }],
  }), 'utf8')
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }), 'utf8')

  await runRawLayoutConversion('job-hidden-assets', jobDir)

  const normalized = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'raw.normalized.json'), 'utf8'))
  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))

  assert.equal(JSON.stringify(normalized).includes('hidden-image'), false)
  assert.equal(assetIndex.assets.some((asset) => asset.assetId === 'img_hidden'), false)
  assert.equal(assetIndex.assets.some((asset) => asset.assetId === 'img_visible'), true)
})

test('svg node slices from vector-only icon containers are preferred as icon assets', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-svg-node-slice-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'icon'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'icon', 'search.svg'), '<svg></svg>', 'utf8')

  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root',
      name: '页面',
      type: 'FRAME',
      isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
      children: [{
        id: 'icon-container',
        name: '容器',
        type: 'GROUP',
        isVisible: true,
        absoluteBoundingBox: { x: 24, y: 24, width: 32, height: 32 },
        children: [{
          id: 'path-1',
          name: '路径',
          type: 'VECTOR',
          isVisible: true,
          absoluteBoundingBox: { x: 26, y: 26, width: 12, height: 12 },
          strokes: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, alpha: 1 }],
        }, {
          id: 'path-2',
          name: '路径',
          type: 'VECTOR',
          isVisible: true,
          absoluteBoundingBox: { x: 36, y: 36, width: 8, height: 8 },
          strokes: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, alpha: 1 }],
        }],
      }],
    }],
  }), 'utf8')

  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'node_svg_0001',
      kind: 'node-slice',
      usageHint: 'icon',
      mustUseRenderedSlice: true,
      status: 'reference-only',
      format: 'svg',
      targetDir: 'assets/icon',
      suggestedFile: 'assets/icon/node_svg_0001.svg',
      sourceNodes: [{ nodeId: 'icon-container', nodeName: '容器', paintPath: 'node', usageHint: 'icon', exportFormat: 'svg' }],
      renderedAssets: [{
        assetId: 'slice_svg_0001',
        kind: 'rendered-image',
        format: 'svg',
        nodeId: 'icon-container',
        status: 'present',
        copiedPath: 'assets/icon/search.svg',
        suggestedFile: 'assets/icon/search.svg',
      }],
    }],
  }), 'utf8')
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }), 'utf8')

  await runRawLayoutConversion('job-svg-node-slice', jobDir)

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const svgAsset = assetIndex.assets.find((asset) => asset.assetId === 'node_svg_0001')

  assert.equal(svgAsset.usage, 'icon')
  assert.equal(svgAsset.format, 'svg')
  assert.equal(svgAsset.targetDir, 'assets/icon')
  assert.equal(svgAsset.preferred.copiedPath, 'assets/icon/search.svg')
  assert.equal(svgAsset.rendered[0].format, 'svg')
})

test('structural navigation group slices are review-only instead of required final assets', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-nav-review-policy-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'img'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'img', 'nav-full.png'), '')

  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root',
      name: '页面',
      type: 'FRAME',
      isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
      children: [{
        id: 'nav',
        name: '导航',
        type: 'GROUP',
        isVisible: true,
        absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 68 },
        children: [{
          id: 'nav-bg',
          name: '矩形 2',
          type: 'RECTANGLE',
          isVisible: true,
          absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 68 },
          fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 0.2 } }],
          effects: [{ type: 'BACKGROUND_BLUR', radius: 80 }],
        }, {
          id: 'nav-home',
          name: '校园招聘',
          type: 'TEXT',
          isVisible: true,
          characters: '校园招聘',
          absoluteBoundingBox: { x: 1000, y: 22, width: 64, height: 22 },
        }, {
          id: 'nav-social',
          name: '社会招聘',
          type: 'TEXT',
          isVisible: true,
          characters: '社会招聘',
          absoluteBoundingBox: { x: 1128, y: 22, width: 64, height: 22 },
        }],
      }],
    }],
  }), 'utf8')

  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'node_nav',
      kind: 'node-slice',
      usageHint: 'complex-vector',
      mustUseRenderedSlice: true,
      status: 'reference-only',
      format: 'png',
      targetDir: 'assets/img',
      suggestedFile: 'assets/img/node_nav.png',
      sourceNodes: [{ nodeId: 'nav', nodeName: '导航', paintPath: 'node', usageHint: 'complex-vector' }],
      renderedAssets: [{ assetId: 'slice_nav', nodeId: 'nav', status: 'present', copiedPath: 'assets/img/nav-full.png', suggestedFile: 'assets/img/nav-full.png', width: 1920, height: 68 }],
    }],
  }), 'utf8')
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }), 'utf8')

  await runRawLayoutConversion('job-nav-review-policy', jobDir)

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const navAsset = assetIndex.assets.find((asset) => asset.assetId === 'node_nav')
  assert.equal(navAsset.renderPolicy, 'review-only')
  assert.equal(navAsset.mustUseRenderedSlice, undefined)
  assert.equal(navAsset.renderingStrategy, undefined)
})

test('top-left vector brand logo slices remain required final assets', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-header-logo-policy-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'icon'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'icon', 'campus-logo.svg'), '<svg></svg>', 'utf8')

  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root',
      name: '页面',
      type: 'FRAME',
      isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
      children: [{
        id: 'header-logo',
        name: '校园招聘',
        type: 'GROUP',
        isVisible: true,
        absoluteBoundingBox: { x: 156, y: 20, width: 179, height: 28 },
        children: [{
          id: 'brand-mark',
          name: '路径',
          type: 'PEN',
          isVisible: true,
          absoluteBoundingBox: { x: 156, y: 20, width: 97, height: 28 },
          fills: [{ type: 'SOLID', color: { r: 0.87, g: 0.03, b: 0.11, a: 1 } }],
        }],
      }],
    }],
  }), 'utf8')

  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'node_logo',
      kind: 'node-slice',
      usageHint: 'logo',
      mustUseRenderedSlice: true,
      status: 'reference-only',
      format: 'svg',
      targetDir: 'assets/icon',
      suggestedFile: 'assets/icon/node_logo.svg',
      sourceNodes: [{
        nodeId: 'header-logo',
        nodeName: '校园招聘',
        paintPath: 'node',
        usageHint: 'logo',
        exportFormat: 'svg',
        renderReason: '检测到仅由路径/形状组成的品牌标识容器，将导出为 SVG 以保持清晰度。',
        semanticHints: [{ usage: 'logo', confidence: 'medium', reason: '节点位于页面顶部左侧且尺寸接近导航栏品牌标识。' }],
      }],
      renderedAssets: [{
        assetId: 'slice_logo',
        kind: 'rendered-image',
        format: 'svg',
        nodeId: 'header-logo',
        status: 'present',
        copiedPath: 'assets/icon/campus-logo.svg',
        suggestedFile: 'assets/icon/campus-logo.svg',
        width: 179,
        height: 28,
      }],
    }],
  }), 'utf8')
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }), 'utf8')

  await runRawLayoutConversion('job-header-logo-policy', jobDir)

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const logoAsset = assetIndex.assets.find((asset) => asset.assetId === 'node_logo')

  assert.equal(logoAsset.usage, 'logo')
  assert.equal(logoAsset.renderPolicy, 'required-final')
  assert.equal(logoAsset.renderingStrategy, 'use-rendered-node-slice')
  assert.equal(logoAsset.mustUseRenderedSlice, true)
  assert.equal(logoAsset.preferred.copiedPath, 'assets/icon/campus-logo.svg')
})

test('campus hero facts promote missing-font title slices and preserve overlay coordinates and stacking', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-campus-fidelity-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'img'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'img', 'hero-copy.png'), '')
  writeFileSync(join(inputDir, 'assets', 'img', 'hero-arrow.png'), '')
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root', name: '页面', type: 'FRAME', isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1200 },
      children: [{
        id: 'hero', name: '首页banner', type: 'GROUP', isVisible: true,
        absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 600 },
        children: [{
          id: 'hero-arrow', name: '右侧箭头 蒙版', type: 'GROUP', isVisible: true,
          absoluteBoundingBox: { x: 1612, y: 254, width: 174, height: 116 }, children: [],
        }, {
          id: 'hero-copy', name: 'Banner 标题组合', type: 'GROUP', isVisible: true,
          absoluteBoundingBox: { x: 260, y: 203, width: 433, height: 188 },
          children: [{
            id: 'hero-title', name: '校园招聘', type: 'TEXT', isVisible: true, characters: '校园招聘',
            absoluteBoundingBox: { x: 434, y: 274, width: 245, height: 77 },
            textRuns: [{ fontName: { family: 'DingTalk JinBuTi', style: 'Regular' }, fontSize: 64, fontWeight: 400, lineHeightByPx: 90 }],
          }, {
            id: 'hero-subtitle', name: '招聘口号', type: 'TEXT', isVisible: true, characters: '让我们一起改变未来',
            absoluteBoundingBox: { x: 340, y: 365, width: 260, height: 24 },
            textRuns: [{ fontName: { family: 'PingFang SC', style: 'Regular' }, fontSize: 18, fontWeight: 400, lineHeightByPx: 24 }],
          }, {
            id: 'hero-mark', name: '标题装饰', type: 'VECTOR', isVisible: true,
            absoluteBoundingBox: { x: 420, y: 350, width: 267, height: 11 },
            fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
          }],
        }],
      }, {
        id: 'jobs-panel', name: '岗位列表白色面板', type: 'GROUP', isVisible: true,
        absoluteBoundingBox: { x: 212, y: 509, width: 1496, height: 600 },
        children: [{
          id: 'jobs-bg', name: '矩形 白色背景', type: 'RECTANGLE', isVisible: true,
          absoluteBoundingBox: { x: 212, y: 509, width: 1496, height: 600 },
          fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 0.8 } }],
        }],
      }],
    }],
  }))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'hero_copy_slice', kind: 'node-slice', usageHint: 'complex-vector', status: 'reference-only',
      sourceNodes: [{ nodeId: 'hero-copy', nodeName: 'Banner 标题组合', paintPath: 'node', usageHint: 'complex-vector' }],
      renderedAssets: [{ assetId: 'hero_copy_rendered', nodeId: 'hero-copy', status: 'present', copiedPath: 'assets/img/hero-copy.png', width: 433, height: 188 }],
    }, {
      assetId: 'hero_arrow_slice', kind: 'node-slice', usageHint: 'masked-composite', status: 'reference-only',
      sourceNodes: [{ nodeId: 'hero-arrow', nodeName: '右侧箭头 蒙版', paintPath: 'node', usageHint: 'masked-composite' }],
      renderedAssets: [{ assetId: 'hero_arrow_rendered', nodeId: 'hero-arrow', status: 'present', copiedPath: 'assets/img/hero-arrow.png', width: 174, height: 116 }],
    }],
  }))
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }))

  await runRawLayoutConversion('job-campus-fidelity', jobDir, { env: { FONT_DOWNLOAD_ENABLED: 'false' } })

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const pageLayout = JSON.parse(readFileSync(join(jobDir, '02-layout', 'page-layout.json'), 'utf8'))
  const copy = assetIndex.assets.find((asset) => asset.assetId === 'hero_copy_slice')
  const arrow = assetIndex.assets.find((asset) => asset.assetId === 'hero_arrow_slice')
  assert.equal(copy.renderPolicy, 'fallback-only')
  assert.equal(copy.fontFallbackRequired, true)
  assert.deepEqual(copy.fallbackForTextNodeIds, ['hero-title', 'hero-subtitle'])
  assert.equal(copy.renderingStrategy, 'use-rendered-text-fallback')
  assert.equal(copy.positioningPolicy, 'source-bounds')
  assert.equal(copy.croppingPolicy, 'preserve-rendered-slice')
  assert.deepEqual(copy.localBounds, { x: 260, y: 203, width: 433, height: 188 })
  assert.equal(arrow.positioningPolicy, 'source-bounds')
  assert.equal(arrow.croppingPolicy, 'preserve-rendered-slice')
  assert.deepEqual(arrow.localBounds, { x: 1612, y: 254, width: 174, height: 116 })
  assert.equal(pageLayout.stackingFacts.some((fact) => fact.lowerSourceNodeId === 'hero' && fact.upperSourceNodeId === 'jobs-panel'), true)
})

test('direct display-critical missing-font text slices are promoted from review-only to fallback-only', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-direct-title-fallback-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'img'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'img', 'title.png'), '')
  writeFileSync(join(inputDir, 'assets', 'img', 'body.png'), '')
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root', name: '页面', type: 'FRAME', isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
      children: [{
        id: 'title', name: '2026届春季校园招聘Q&A', type: 'TEXT', isVisible: true,
        characters: '2026届春季校园招聘Q&A',
        absoluteBoundingBox: { x: 420, y: 320, width: 720, height: 72 },
        textRuns: [{ fontName: { family: 'DingTalk JinBuTi', style: 'Regular' }, fontSize: 56, fontWeight: 400, lineHeightByPx: 72 }],
      }, {
        id: 'body-copy', name: '正文', type: 'TEXT', isVisible: true,
        characters: '这是多行正文，即使文本框高度超过 48px，也应使用 fallback 字体而不是图片。',
        absoluteBoundingBox: { x: 420, y: 430, width: 720, height: 96 },
        textRuns: [{ fontName: { family: 'DingTalk JinBuTi', style: 'Regular' }, fontSize: 16, fontWeight: 400, lineHeightByPx: 24 }],
      }],
    }],
  }))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'title_slice', kind: 'node-slice', usageHint: 'complex-vector', renderPolicy: 'review-only', status: 'reference-only',
      sourceNodes: [{
        nodeId: 'title', nodeName: '2026届春季校园招聘Q&A', paintPath: 'node', usageHint: 'complex-vector',
        renderPolicy: 'review-only', exportFormat: 'png',
        renderReason: '检测到 display-critical 大标题文本，预导出透明 PNG。',
      }],
      renderedAssets: [{ assetId: 'title_rendered', nodeId: 'title', status: 'present', copiedPath: 'assets/img/title.png', width: 720, height: 72 }],
    }, {
      assetId: 'body_slice', kind: 'node-slice', usageHint: 'complex-vector', renderPolicy: 'review-only', status: 'reference-only',
      sourceNodes: [{ nodeId: 'body-copy', nodeName: '正文', paintPath: 'node', usageHint: 'complex-vector', renderPolicy: 'review-only', exportFormat: 'png' }],
      renderedAssets: [{ assetId: 'body_rendered', nodeId: 'body-copy', status: 'present', copiedPath: 'assets/img/body.png', width: 720, height: 96 }],
    }],
  }))
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }))

  await runRawLayoutConversion('job-direct-title-fallback', jobDir, { env: { FONT_DOWNLOAD_ENABLED: 'false' } })

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const title = assetIndex.assets.find((asset) => asset.assetId === 'title_slice')
  const body = assetIndex.assets.find((asset) => asset.assetId === 'body_slice')
  assert.equal(title.renderPolicy, 'fallback-only')
  assert.equal(title.fontFallbackRequired, true)
  assert.deepEqual(title.fallbackForTextNodeIds, ['title'])
  assert.equal(title.renderingStrategy, 'use-rendered-text-fallback')
  assert.equal(title.mustUseRenderedSlice, true)
  assert.equal(body.renderPolicy, 'review-only')
  assert.equal(body.fontFallbackRequired, undefined)
})

test('normalized source facts downgrade legacy required-final hairline SVGs to css-preferred', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-hairline-policy-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'icon'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'icon', 'divider.svg'), '<svg></svg>', 'utf8')
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root', name: '页面', type: 'FRAME', isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
      children: [{
        id: 'divider', name: '直线 11', type: 'PEN', isVisible: true,
        absoluteBoundingBox: { x: 416, y: 457, width: 1088, height: 0 },
        renderBounds: { x: 416, y: 456.8, width: 1088, height: 0.4 },
        strokes: [{ type: 'SOLID', color: { r: 0.8157, g: 0.8471, b: 0.898, a: 1 } }],
        strokeWeight: 0.4,
      }],
    }],
  }))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'divider_slice', kind: 'node-slice', usageHint: 'decorative', renderPolicy: 'required-final', format: 'svg', status: 'reference-only',
      sourceNodes: [{ nodeId: 'divider', nodeName: '直线 11', paintPath: 'node', usageHint: 'decorative', renderPolicy: 'required-final', exportFormat: 'svg' }],
      renderedAssets: [{ assetId: 'divider_rendered', nodeId: 'divider', status: 'present', copiedPath: 'assets/icon/divider.svg', width: 1088, height: 0.4 }],
    }],
  }))
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }))

  await runRawLayoutConversion('job-hairline-policy', jobDir)

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const divider = assetIndex.assets.find((asset) => asset.assetId === 'divider_slice')
  assert.equal(divider.renderPolicy, 'css-preferred')
  assert.equal(divider.renderingStrategy, undefined)
  assert.equal(divider.mustUseRenderedSlice, undefined)
  assert.deepEqual(divider.sourceNodes[0].hairlineStyle, {
    orientation: 'horizontal',
    sourceThickness: 0.4,
    cssThickness: 1,
    color: '#d0d8e5',
    cssOpacity: 0.4,
  })
})

test('yellow blurred ellipse uses a required-final background-decor PNG with full render bleed', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-yellow-glow-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'decorative'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'decorative', 'yellow-glow.png'), '')
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root', name: '页面', type: 'FRAME', isVisible: true,
      absoluteBoundingBox: { x: 12020, y: -3745, width: 1920, height: 1080 },
      children: [{
        id: '114:71600', name: 'bg', type: 'GROUP', isVisible: true,
        absoluteBoundingBox: { x: 12020, y: -3745, width: 2376.0083, height: 777.9874 },
        absoluteRenderBounds: { x: 11750, y: -4246, width: 2990, height: 1649 },
        children: [{
          id: '114:71609', name: '圆形 59', type: 'ELLIPSE', isVisible: true,
          absoluteBoundingBox: { x: 12251, y: -3745, width: 647, height: 647 },
          absoluteRenderBounds: { x: 11750, y: -4246, width: 1649, height: 1649 },
          fills: [{
            type: 'SOLID',
            color: { r: 1, g: 0.8235294222831726, b: 0.12941177189350128, a: 0.4 },
            alpha: 1,
          }],
          effects: [{ type: 'LAYER_BLUR', radius: 333.5106201171875 }],
        }],
      }],
    }],
  }))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'yellow_glow', kind: 'node-slice', usageHint: 'decorative', renderPolicy: 'required-final',
      mustUseRenderedSlice: true, format: 'png', targetDir: 'assets/decorative', status: 'reference-only',
      sourceNodes: [{
        nodeId: '114:71609', nodeName: '圆形 59', paintPath: 'node', usageHint: 'decorative',
        exportFormat: 'png', renderPolicy: 'required-final',
        renderReason: '检测到浏览器无法与 MasterGo 等价合成的栅格敏感效果（LAYER_BLUR），将按 render bounds 导出带透明 bleed 的 PNG。',
        semanticHints: [{ usage: 'decorative', confidence: 'high', reason: '圆形光晕背景装饰。' }],
      }],
      renderedAssets: [{
        assetId: 'yellow_glow_rendered', nodeId: '114:71609', status: 'present', format: 'png',
        copiedPath: 'assets/decorative/yellow-glow.png', suggestedFile: 'assets/decorative/yellow-glow.png',
        width: 1649, height: 1649, exportScale: 1,
      }],
    }],
  }))
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }))

  await runRawLayoutConversion('job-yellow-glow', jobDir)

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const glow = assetIndex.assets.find((asset) => asset.assetId === 'yellow_glow')
  assert.equal(glow.renderPolicy, 'required-final')
  assert.equal(glow.format, 'png')
  assert.equal(glow.usage, 'background-decor')
  assert.equal(glow.layer, 'background')
  assert.equal(glow.renderingStrategy, 'use-rendered-node-slice')
  assert.equal(glow.mustUseRenderedSlice, true)
  assert.equal(glow.mustNotEnterDocumentFlow, true)
  assert.equal(glow.zIndexGroup, 'background')
  assert.equal(glow.croppingPolicy, 'preserve-rendered-slice')
  assert.deepEqual(glow.sourceBounds, { x: 231, y: 0, width: 647, height: 647 })
  assert.deepEqual(glow.localBounds, { x: 231, y: 0, width: 647, height: 647 })
  assert.deepEqual(glow.renderedBounds, { x: -270, y: -501, width: 1649, height: 1649 })
  assert.deepEqual(glow.renderedLocalBounds, { x: -270, y: -501, width: 1649, height: 1649 })
})

test('blurred ellipse SVG uses its filter viewBox as the rendered canvas instead of nominal dimensions', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-glow-svg-canvas-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'decorative'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'decorative', 'red-glow.svg'), `
    <svg width="192" height="192" viewBox="0 0 1212 1212" xmlns="http://www.w3.org/2000/svg">
      <defs><filter id="blur"><feGaussianBlur stdDeviation="127.5"/></filter></defs>
      <ellipse cx="606" cy="606" rx="96" ry="96" fill="#DE071B" fill-opacity="0.4" filter="url(#blur)"/>
    </svg>
  `)
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root', name: '页面', type: 'FRAME', isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
      children: [{
        id: 'red-glow', name: '圆形 61', type: 'ELLIPSE', isVisible: true,
        absoluteBoundingBox: { x: 1791, y: 231, width: 192, height: 192 },
        absoluteRenderBounds: { x: 1408, y: -152, width: 958, height: 958 },
        fills: [{ type: 'SOLID', color: { r: 0.87, g: 0.03, b: 0.11, a: 0.4 } }],
        effects: [{ type: 'LAYER_BLUR', radius: 255 }],
      }],
    }],
  }))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'red_glow', kind: 'node-slice', usageHint: 'decorative', renderPolicy: 'required-final',
      format: 'svg', targetDir: 'assets/decorative', status: 'reference-only',
      sourceNodes: [{
        nodeId: 'red-glow', nodeName: '圆形 61', paintPath: 'node', usageHint: 'decorative',
        renderPolicy: 'required-final', exportFormat: 'svg',
        renderReason: 'LAYER_BLUR 独立光晕，保留完整 viewBox 与 filter bleed。',
      }],
      renderedAssets: [{
        assetId: 'red_glow_rendered', nodeId: 'red-glow', status: 'present', format: 'svg',
        copiedPath: 'assets/decorative/red-glow.svg', suggestedFile: 'assets/decorative/red-glow.svg',
        width: 192, height: 192,
      }],
    }],
  }))
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }))

  await runRawLayoutConversion('job-glow-svg-canvas', jobDir)

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const glow = assetIndex.assets.find((asset) => asset.assetId === 'red_glow')
  assert.equal(glow.format, 'svg')
  assert.equal(glow.renderPolicy, 'required-final')
  assert.equal(glow.preferred.width, 1212)
  assert.equal(glow.preferred.height, 1212)
  assert.deepEqual(glow.renderedLocalBounds, { x: 1281, y: -279, width: 1212, height: 1212 })
})

test('pre-clipped background decoration PNG anchors to the clipping Frame intersection', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-preclipped-glow-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'decorative'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'decorative', 'yellow-glow.png'), pngHeader(917, 806))
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root', name: '页面', type: 'FRAME', isVisible: true, clipsContent: true,
      absoluteBoundingBox: { x: 13813, y: -3449, width: 1920, height: 3741 },
      children: [{
        id: 'background', name: 'bg', type: 'GROUP', isVisible: true,
        absoluteBoundingBox: { x: 13609, y: -3811, width: 2223, height: 834 },
        children: [{
          id: 'yellow-glow', name: '圆形 59', type: 'ELLIPSE', isVisible: true,
          absoluteBoundingBox: { x: 15317, y: -3659, width: 515, height: 515 },
          absoluteRenderBounds: { x: 14816, y: -4160, width: 1517, height: 1517 },
          fills: [{ type: 'SOLID', color: { r: 1, g: 0.82, b: 0.13, a: 0.4 }, alpha: 1 }],
          effects: [{ type: 'LAYER_BLUR', radius: 334 }],
        }],
      }],
    }],
  }))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'yellow_glow', kind: 'node-slice', usageHint: 'decorative', renderPolicy: 'required-final',
      mustUseRenderedSlice: true, format: 'png', targetDir: 'assets/decorative', status: 'reference-only',
      sourceNodes: [{
        nodeId: 'yellow-glow', nodeName: '圆形 59', paintPath: 'node', usageHint: 'decorative',
        exportFormat: 'png', renderPolicy: 'required-final',
      }],
      renderedAssets: [{
        assetId: 'yellow_glow_rendered', nodeId: 'yellow-glow', status: 'present', format: 'png',
        copiedPath: 'assets/decorative/yellow-glow.png', suggestedFile: 'assets/decorative/yellow-glow.png',
        width: 515, height: 515, exportScale: 1,
      }],
    }],
  }))
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }))

  await runRawLayoutConversion('job-preclipped-glow', jobDir)

  const normalized = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'raw.normalized.json'), 'utf8'))
  assert.equal(normalized.nodes[0].clipsContent, true)

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const glow = assetIndex.assets.find((asset) => asset.assetId === 'yellow_glow')
  assert.equal(glow.preferred.canvasMeasuredFromFile, true)
  assert.deepEqual(glow.sourceNodes[0].renderBounds, { x: 1003, y: -711, width: 1517, height: 1517 })
  assert.deepEqual(glow.sourceNodes[0].clippedRenderBounds, { x: 1003, y: 0, width: 917, height: 806 })
  assert.deepEqual(glow.renderedBounds, { x: 1003, y: 0, width: 917, height: 806 })
  assert.deepEqual(glow.renderedLocalBounds, { x: 1207, y: 362, width: 917, height: 806 })
})

test('masked location cards with text are promoted to required-final PNGs and keep child images hidden', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-location-mask-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets', 'rendered'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  writeFileSync(join(inputDir, 'assets', 'rendered', 'location-card.png'), '')
  writeFileSync(join(inputDir, 'assets', 'rendered', 'location-photo.png'), '')

  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    selection: [{
      id: 'root', name: '页面', type: 'FRAME', isVisible: true,
      absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
      children: [{
        id: '200:03678', name: '西安地点卡片', type: 'GROUP', isVisible: true,
        absoluteBoundingBox: { x: 1200, y: 720, width: 240, height: 240 },
        children: [{
          id: '200:03683', name: '蒙版', type: 'RECTANGLE', isVisible: true, isMask: true,
          cornerRadius: 32,
          absoluteBoundingBox: { x: 1200, y: 720, width: 240, height: 240 },
          fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 }, alpha: 1 }],
        }, {
          id: '200:03684', name: 'image', type: 'RECTANGLE', isVisible: true,
          absoluteBoundingBox: { x: 1200, y: 720, width: 240, height: 240 },
          fills: [{ type: 'IMAGE', imageRef: 'location-ref', assetId: 'location_photo', scaleMode: 'FILL', alpha: 1 }],
        }, {
          id: '200:03679', name: '西安', type: 'TEXT', isVisible: true,
          characters: '西安', textAutoResize: 'WIDTH_AND_HEIGHT',
          absoluteBoundingBox: { x: 1288, y: 894, width: 44, height: 29 },
          textRuns: [{ fontName: { family: 'MiSans', style: 'Regular' }, fontSize: 22, fontWeight: 400, lineHeightByPx: 29 }],
        }],
      }],
    }],
  }))

  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'location_photo', kind: 'image', imageRef: 'location-ref', status: 'reference-only',
      sourceNodes: [{ nodeId: '200:03684', nodeName: 'image', paintPath: 'fills[0]', scaleMode: 'FILL', alpha: 1 }],
      renderedAssets: [{ assetId: 'location_photo_rendered', nodeId: '200:03684', status: 'present', format: 'png', copiedPath: 'assets/rendered/location-photo.png', width: 240, height: 240 }],
    }, {
      assetId: 'location_card_slice', kind: 'node-slice', usageHint: 'masked-composite',
      renderPolicy: 'review-only', format: 'png', status: 'reference-only',
      sourceNodes: [{
        nodeId: '200:03678', nodeName: '西安地点卡片', paintPath: 'node', usageHint: 'masked-composite',
        renderPolicy: 'review-only', exportFormat: 'png',
        renderReason: '蒙版组应整体导出，但旧 manifest 错误降级为 review-only。',
      }],
      renderedAssets: [{ assetId: 'location_card_rendered', nodeId: '200:03678', status: 'present', format: 'png', copiedPath: 'assets/rendered/location-card.png', width: 240, height: 240 }],
    }],
  }))
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({ exportOptions: { includeRenderedSlices: true } }))

  await runRawLayoutConversion('job-location-mask', jobDir)

  const assetIndex = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'asset-index.json'), 'utf8'))
  const composite = assetIndex.assets.find((asset) => asset.assetId === 'location_card_slice')
  const innerImage = assetIndex.assets.find((asset) => asset.assetId === 'location_photo')
  assert.equal(composite.usage, 'masked-composite')
  assert.equal(composite.renderPolicy, 'required-final')
  assert.equal(composite.renderingStrategy, 'use-rendered-node-slice')
  assert.equal(composite.mustUseRenderedSlice, true)
  assert.equal(composite.preferred.copiedPath, 'assets/rendered/location-card.png')
  assert.equal(innerImage.usage, 'rendered-slice-child')
  assert.equal(innerImage.sourceNodes[0].insideForcedRenderedSlice, true)
  assert.deepEqual(innerImage.sourceNodes[0].ancestorNodeIds, ['200:03678', 'root'])

  const normalized = JSON.parse(readFileSync(join(jobDir, '01-normalized', 'raw.normalized.json'), 'utf8'))
  const locationGroup = normalized.nodes[0].children.find((node) => node.sourceNodeId === '200:03678')
  const locationLabel = locationGroup.children.find((node) => node.sourceNodeId === '200:03679')
  assert.equal(locationLabel.style.text.textAutoResize, 'WIDTH_AND_HEIGHT')
  assert.equal(locationLabel.style.text.characters, '西安')
})
