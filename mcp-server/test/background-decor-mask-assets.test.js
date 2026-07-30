import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runRawLayoutConversion } from '../src/workflow/raw-layout-conversion.js'

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
