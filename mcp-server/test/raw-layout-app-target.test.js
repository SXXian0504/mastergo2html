import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildPagePlanningContext } from '../src/workflow/page-planning-context.js'
import { runRawLayoutConversion } from '../src/workflow/raw-layout-conversion.js'

test('raw layout keeps the web baseline by default and switches only explicit app jobs', async () => {
  const webJobDir = createFixtureJob()
  await runRawLayoutConversion('job-web-target', webJobDir)
  const webLayout = readJson(join(webJobDir, '02-layout', 'page-layout.json'))
  assert.equal(webLayout.layoutStrategy.baseline, 'single-frame-desktop')
  assert.equal(webLayout.responsive.confidence, 'single-frame-low')

  const appJobDir = createFixtureJob('app')
  await runRawLayoutConversion('job-app-target', appJobDir)
  const appLayout = readJson(join(appJobDir, '02-layout', 'page-layout.json'))
  const appContext = readJson(join(appJobDir, '02-layout', 'ai-layout-context.json'))
  assert.equal(appLayout.layoutStrategy.baseline, 'single-frame-app')
  assert.equal(appLayout.responsive.confidence, 'explicit-app-target')
  assert.match(appLayout.responsive.hints.join('\n'), /App shell/)
  assert.equal(appContext.responsive.confidence, 'explicit-app-target')
  assert.match(appContext.responsive.rule, /App baseline/)
})

test('app multi-frame input becomes one page with explicit interaction states while web still keeps one root', async () => {
  const webJobDir = createFixtureJob(undefined, true)
  await runRawLayoutConversion('job-web-multi-root', webJobDir)
  const webNormalized = readJson(join(webJobDir, '01-normalized', 'raw.normalized.json'))
  assert.equal(webNormalized.nodes.length, 1)
  assert.equal(webNormalized.interactionStates, undefined)

  const appJobDir = createFixtureJob('app', true)
  await runRawLayoutConversion('job-app-multi-state', appJobDir)
  const normalized = readJson(join(appJobDir, '01-normalized', 'raw.normalized.json'))
  const pageLayout = readJson(join(appJobDir, '02-layout', 'page-layout.json'))
  const aiContext = readJson(join(appJobDir, '02-layout', 'ai-layout-context.json'))
  const planningContext = buildPagePlanningContext(appJobDir)

  assert.equal(normalized.rootId, 'root')
  assert.equal(normalized.nodes.length, 2)
  assert.equal(normalized.interactionStates.mode, 'single-page-multi-frame')
  assert.equal(normalized.interactionStates.primaryFrameId, 'root')
  assert.equal(normalized.interactionStates.stateCount, 2)
  assert.equal(normalized.interactionStates.states[1].screenshotPath, 'state-screenshots/02-confirm.png')
  assert.equal(pageLayout.page.rootFrameId, 'root')
  assert.equal(pageLayout.page.interactionStates.stateCount, 2)
  assert.equal(aiContext.interactionStates.stateCount, 2)
  assert.equal(planningContext.interactionStates.stateCount, 2)
  assert.equal(planningContext.nodes.some((node) => node.appStateFrameId === 'confirm' && node.appStateName === '确认弹层'), true)
})

test('rendered SVG keeps its real effects-bleed canvas instead of being squeezed into the input node bbox', async () => {
  const jobDir = createRenderedSliceFixtureJob({ bleed: true })
  await runRawLayoutConversion('job-app-rendered-input-bleed', jobDir)

  const normalized = readJson(join(jobDir, '01-normalized', 'raw.normalized.json'))
  const assetIndex = readJson(join(jobDir, '01-normalized', 'asset-index.json'))
  const planningContext = buildPagePlanningContext(jobDir)
  const inputBackground = normalized.nodes[0].children[0].children[0]
  const asset = assetIndex.assets[0]

  assert.deepEqual(inputBackground.relativeBounds, { x: 68, y: 552, width: 614, height: 108 })
  assert.deepEqual(inputBackground.relativeRenderBounds, { x: 53, y: 547, width: 644, height: 138 })
  assert.equal(asset.rendered[0].width, 654)
  assert.equal(asset.rendered[0].height, 148)
  assert.equal(asset.rendered[0].manifestWidth, 614)
  assert.equal(asset.rendered[0].manifestHeight, 108)
  assert.deepEqual(asset.sourceBounds, { x: 68, y: 552, width: 614, height: 108 })
  assert.deepEqual(asset.localBounds, { x: 0, y: 0, width: 614, height: 108 })
  assert.deepEqual(asset.renderedBounds, { x: 48, y: 542, width: 654, height: 148 })
  assert.deepEqual(asset.renderedLocalBounds, { x: -20, y: -10, width: 654, height: 148 })
  assert.deepEqual(planningContext.assets[0].renderedLocalBounds, asset.renderedLocalBounds)
})

test('rendered SVG without effects bleed keeps the original source geometry', async () => {
  const jobDir = createRenderedSliceFixtureJob({ bleed: false })
  await runRawLayoutConversion('job-app-rendered-input-no-bleed', jobDir)
  const asset = readJson(join(jobDir, '01-normalized', 'asset-index.json')).assets[0]

  assert.deepEqual(asset.renderedBounds, { x: 68, y: 552, width: 614, height: 108 })
  assert.deepEqual(asset.renderedLocalBounds, { x: 0, y: 0, width: 614, height: 108 })
  assert.equal(asset.rendered[0].manifestWidth, undefined)
  assert.equal(asset.rendered[0].manifestHeight, undefined)
})

function createFixtureJob(targetPlatform, multiState = false) {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-app-target-'))
  const inputDir = join(jobDir, '00-input')
  mkdirSync(join(inputDir, 'assets'), { recursive: true })
  writeFileSync(join(inputDir, 'frame-screenshot.png'), '')
  if (multiState) {
    mkdirSync(join(inputDir, 'state-screenshots'), { recursive: true })
    writeFileSync(join(inputDir, 'state-screenshots', '02-confirm.png'), '')
  }
  const primaryFrame = {
    id: 'root',
    name: '移动页面',
    type: 'FRAME',
    isVisible: true,
    absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
    children: [{
      id: 'content',
      name: '内容区',
      type: 'RECTANGLE',
      isVisible: true,
      absoluteBoundingBox: { x: 16, y: 88, width: 358, height: 680 },
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, alpha: 1 }],
    }],
  }
  const confirmFrame = {
    id: 'confirm',
    name: '确认弹层',
    type: 'FRAME',
    isVisible: true,
    absoluteBoundingBox: { x: 430, y: 0, width: 390, height: 844 },
    children: [{
      id: 'confirm-dialog',
      name: '确认按钮',
      type: 'RECTANGLE',
      isVisible: true,
      absoluteBoundingBox: { x: 470, y: 300, width: 310, height: 220 },
      fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, alpha: 1 }],
    }],
  }
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify({
    version: 'fixture',
    page: { id: 'page-1', name: 'App page' },
    selection: multiState ? [primaryFrame, confirmFrame] : [primaryFrame],
    ...(multiState && targetPlatform === 'app' ? {
      interactionStates: {
        version: 'mastergo2html.app-interaction-states.v1',
        mode: 'single-page-multi-frame',
        primaryFrameId: 'root',
        states: [
          { frameId: 'root', name: '移动页面', order: 0, isPrimary: true, screenshotPath: 'frame-screenshot.png' },
          { frameId: 'confirm', name: '确认弹层', order: 1, isPrimary: false, screenshotPath: 'state-screenshots/02-confirm.png' },
        ],
      },
    } : {}),
  }))
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [],
    files: [],
  }))
  writeFileSync(join(inputDir, 'export-options.json'), JSON.stringify({
    exportOptions: {
      includeOriginalImages: false,
      includeRenderedSlices: true,
      rawProfile: 'html',
      ...(targetPlatform === 'app' ? { targetPlatform: 'app' } : {}),
    },
  }))
  return jobDir
}

function createRenderedSliceFixtureJob({ bleed }) {
  const jobDir = createFixtureJob('app')
  const inputDir = join(jobDir, '00-input')
  const raw = readJson(join(inputDir, 'raw.json'))
  raw.selection[0].children = [{
    id: 'input-container',
    name: '邮箱输入框',
    type: 'GROUP',
    isVisible: true,
    absoluteBoundingBox: { x: 68, y: 552, width: 614, height: 108 },
    children: [{
      id: 'input-background',
      name: '输入框背景',
      type: 'RECTANGLE',
      isVisible: true,
      absoluteBoundingBox: { x: 68, y: 552, width: 614, height: 108 },
      absoluteRenderBounds: bleed
        ? { x: 53, y: 547, width: 644, height: 138 }
        : { x: 68, y: 552, width: 614, height: 108 },
      effects: bleed ? [{ type: 'DROP_SHADOW', isVisible: true, radius: 10 }] : [],
    }],
  }]
  writeFileSync(join(inputDir, 'raw.json'), JSON.stringify(raw))

  mkdirSync(join(inputDir, 'assets', 'icon'), { recursive: true })
  const width = bleed ? 654 : 614
  const height = bleed ? 148 : 108
  writeFileSync(
    join(inputDir, 'assets', 'icon', 'input-background.svg'),
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg"><rect width="614" height="108" fill="white"/></svg>`,
  )
  writeFileSync(join(inputDir, 'asset-manifest.json'), JSON.stringify({
    version: 'mastergo2html.asset-manifest.v1',
    assets: [{
      assetId: 'node_input_background',
      kind: 'node-slice',
      status: 'reference-only',
      format: 'svg',
      targetDir: 'assets/icon',
      usageHint: 'complex-vector',
      renderPolicy: 'required-final',
      mustUseRenderedSlice: true,
      sourceNodes: [{
        nodeId: 'input-background',
        nodeName: '输入框背景',
        paintPath: 'node',
        usageHint: 'complex-vector',
        exportFormat: 'svg',
      }],
      suggestedFile: 'assets/icon/node_input_background.svg',
      renderedAssets: [{
        assetId: 'slice_input_background',
        kind: 'rendered-image',
        format: 'svg',
        nodeId: 'input-background',
        status: 'present',
        suggestedFile: 'assets/icon/input-background.svg',
        copiedPath: 'assets/icon/input-background.svg',
        exportScale: 1,
        width: 614,
        height: 108,
      }],
    }],
    files: [],
  }))
  return jobDir
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}
