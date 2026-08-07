import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInspectionExpression } from '../src/workflow/responsive-runtime-validation.js'

test('responsive runtime inspection checks hidden overflow, header whitespace, and wide shell coverage', () => {
  const expression = buildInspectionExpression({
    viewport: { name: 'wide-desktop', width: 2560, height: 1440 },
    requiredModules: [
      { role: 'header', selectors: ['header'], required: true },
      { role: 'footer', selectors: ['footer'], required: true },
    ],
    tolerancePx: 2,
    layoutIntegrity: {
      narrowMaxWidth: 768,
      header: { maxEmptyBandPx: 72, maxEmptyBandRatio: 0.28 },
      wideShell: { minViewportWidth: 1921, fullBleedRoles: ['header', 'footer'], minViewportCoverageRatio: 0.98 },
      footer: { maxDisconnectedGapRatio: 0.34 },
      segmentedControls: {
        enabled: true,
        centerTolerancePx: 2,
        boundaryTolerancePx: 2,
        minActiveWidthToSlotRatio: 0.9,
        maxActiveWidthToSlotRatio: 1.1,
        minClickWidthToSlotRatio: 0.9,
        minClickHeightToControlRatio: 0.9,
        minActiveHeightToControlRatioForDetection: 0.35,
        exerciseAllTabs: true,
      },
    },
  })

  assert.match(expression, /contentOverflowX/)
  assert.match(expression, /map\(inspectOverflowElement\)/)
  assert.doesNotMatch(expression, /querySelectorAll\('\*'\)[\s\S]*?map\(inspectElement\)/)
  assert.match(expression, /module\.role !== 'nav'/)
  assert.match(expression, /Header 出现结构性空白带/)
  assert.match(expression, /外层未全宽覆盖视口/)
  assert.match(expression, /Footer 内容出现横向断裂孤岛/)
  assert.match(expression, /inspectSegmentedControls/)
  assert.match(expression, /data-segmented-active-surface/)
  assert.match(expression, /minActiveHeightToControlRatioForDetection/)
  assert.match(expression, /radius < 4/)
  assert.match(expression, /centerErrorPx/)
  assert.match(expression, /activeWidthToSlotRatio/)
  assert.match(expression, /insideControl/)
  assert.match(expression, /分段按钮点击区未覆盖完整槽位/)
  assert.match(expression, /分段活动胶囊未与第/)
  assert.match(expression, /分段活动胶囊越出整体外框/)
  assert.match(expression, /分段活动胶囊宽度未继承单槽位比例/)
  assert.match(expression, /tab\.click\(\)/)
  assert.match(expression, /await waitForGeometry/)
})
