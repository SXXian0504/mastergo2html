import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveFontAssets } from '../src/workflow/font-assets.js'
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

test('font asset resolver downloads known font files into assets/fonts', async () => {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo-font-assets-'))
  const inputDir = join(jobDir, '00-input')
  const fontAvailability = {
    missingFonts: [{
      family: 'Brand Sans',
      usageCount: 1,
      styles: ['Regular'],
      weights: ['400'],
      sourceNodes: [{ sourceNodeId: 'title' }],
    }],
  }
  const fetchFn = async (url) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    arrayBuffer: async () => Buffer.from(`font:${url}`).buffer,
  })

  const report = await resolveFontAssets({
    fontAvailability,
    inputDir,
    fetchFn,
    env: {
      FONT_PACKAGE_REGISTRY_JSON: JSON.stringify({
        'brand sans': [{ url: 'https://fonts.example.com/brand-sans.woff2', weight: 400, style: 'normal' }],
      }),
      FONT_DOWNLOAD_ALLOWED_HOSTS: 'fonts.example.com',
    },
  })

  assert.equal(report.fonts[0].status, 'downloaded')
  assert.equal(report.files[0], 'assets/fonts/brand-sans-normal-400.woff2')
  assert.equal(existsSync(join(inputDir, 'assets', 'fonts', 'brand-sans-normal-400.woff2')), true)
  assert.match(report.fonts[0].css, /@font-face/)
  assert.match(readFileSync(join(inputDir, 'assets', 'fonts', 'brand-sans-normal-400.woff2'), 'utf8'), /font:https:\/\/fonts\.example\.com/)
})

test('font asset resolver falls back when downloads are disabled', async () => {
  const report = await resolveFontAssets({
    fontAvailability: { missingFonts: [{ family: 'Brand Sans', weights: ['400'] }] },
    inputDir: mkdtempSync(join(tmpdir(), 'mastergo-font-fallback-')),
    env: { FONT_DOWNLOAD_ENABLED: 'false' },
  })

  assert.equal(report.fonts[0].status, 'fallback-required')
  assert.deepEqual(report.files, [])
  assert.match(report.fonts[0].fallbackStack.join(','), /Brand Sans/)
})
