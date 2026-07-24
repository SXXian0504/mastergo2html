import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runRawLayoutConversion } from '../src/workflow/raw-layout-conversion.js'

test('background decor mask groups use rendered group slices instead of inner image assets', () => {
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

  runRawLayoutConversion('job-bg-decor-mask', jobDir)

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
