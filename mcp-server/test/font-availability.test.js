import assert from 'node:assert/strict'
import test from 'node:test'
import { buildFontAvailabilityReport } from '../src/workflow/raw-layout-conversion.js'

test('font availability report lists non-system font packages', () => {
  const report = buildFontAvailabilityReport([
    {
      id: 'title',
      sourceNodeId: 'title',
      name: '标题',
      style: { text: { fontFamily: 'Brand Sans', fontStyle: 'Bold', fontWeight: 700 } },
    },
    {
      id: 'body',
      sourceNodeId: 'body',
      name: '正文',
      style: { text: { fontFamily: 'PingFang SC', fontWeight: 400 } },
    },
    {
      id: 'cta',
      sourceNodeId: 'cta',
      name: '按钮',
      style: { text: { fontFamily: 'Brand Sans', fontWeight: 500 } },
    },
  ])

  assert.equal(report.missingFonts.length, 1)
  assert.equal(report.missingFonts[0].family, 'Brand Sans')
  assert.equal(report.missingFonts[0].usageCount, 2)
  assert.deepEqual(report.missingFonts[0].weights, ['500', '700'])
  assert.deepEqual(report.missingFonts[0].sourceNodes.map((node) => node.sourceNodeId), ['title', 'cta'])
  assert.equal(report.fonts.find((font) => font.family === 'PingFang SC').status, 'system-or-common')
})
