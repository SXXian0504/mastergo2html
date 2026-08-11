import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  getMissingPagePlanHeadings,
  normalizePagePlanMarkdown,
  runPagePlanAnalysis,
} from '../src/workflow/page-plan-analysis.js'

const requiredHeadings = [
  '角色结论',
  '资源清单与映射',
  '页面资源使用方案',
  '背景与装饰层',
  '缺失与降级策略',
  '开发顺序',
  '风险与视觉复核',
  '给代码生成步骤的指令',
]

test('page plan heading validation accepts common model heading variants', () => {
  const markdown = [
    '## 角色结论',
    '# 1. 资源清单与映射',
    '### 页面资源使用方案：',
    '**背景与装饰层**',
    '5、缺失与降级策略',
    '六、开发顺序',
    '- **风险与视觉复核**',
    '# 给代码生成步骤的指令',
  ].join('\n\n')

  assert.deepEqual(getMissingPagePlanHeadings(markdown, requiredHeadings), [])
})

test('page plan markdown normalizes recognized required headings to level one', () => {
  const markdown = normalizePagePlanMarkdown('## 背景与装饰层：\n内容', requiredHeadings)

  assert.equal(markdown, '# 背景与装饰层\n内容\n')
})

test('page plan heading validation ignores headings inside fenced code blocks', () => {
  const markdown = [
    '# 角色结论',
    '```md',
    '# 背景与装饰层',
    '```',
  ].join('\n')

  assert.deepEqual(
    getMissingPagePlanHeadings(markdown, ['角色结论', '背景与装饰层']),
    ['背景与装饰层'],
  )
})

test('page plan keeps the first generation and reports heading validation warnings', async () => {
  const jobDir = createFixtureJob()
  const firstMarkdown = '# 角色结论\n保留第一轮结果'
  let calls = 0

  const result = await runPagePlanAnalysis({
    config: { wireApi: 'responses' },
    jobId: 'job-single-pass-page-plan',
    jobDir,
    analysisName: 'test-page-plan',
    outputName: 'test.plan.md',
    system: '只输出 Markdown。',
    focus: '测试单轮生成。',
    contextProfile: 'interaction',
    requiredHeadings: ['角色结论', '缺失章节'],
    generateStream: async () => {
      calls += 1
      return { text: firstMarkdown, usage: { totalTokens: 10 }, streamMode: 'stream' }
    },
  })

  assert.equal(calls, 1)
  assert.equal(readFileSync(result.outputPath, 'utf8'), `${firstMarkdown}\n`)
  const promptLog = readFileSync(result.promptPath, 'utf8')
  assert.match(promptLog, /共享约束版本：mastergo2html\.constraints\.v1/)
  assert.match(promptLog, /\[interaction\.state-matrix\]\[hard\]/)
  assert.match(result.validationWarnings.join('\n'), /缺失章节/)
  assert.match(result.validationWarnings.join('\n'), /不再重新请求模型/)
})

function createFixtureJob() {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo2html-page-plan-'))
  for (const directory of ['00-input', '01-normalized', '02-layout']) mkdirSync(join(jobDir, directory), { recursive: true })
  writeFileSync(join(jobDir, '00-input', 'frame-screenshot.png'), '')
  writeFileSync(join(jobDir, '01-normalized', 'raw.normalized.json'), JSON.stringify({
    source: { pageName: '测试页面' },
    rootId: 'frame-1',
    nodes: [{ id: 'frame-1', name: '测试页面', role: 'container', children: [] }],
  }))
  writeFileSync(join(jobDir, '01-normalized', 'asset-index.json'), JSON.stringify({ assets: [] }))
  writeFileSync(join(jobDir, '01-normalized', 'design-tokens.json'), JSON.stringify({ tokens: {} }))
  writeFileSync(join(jobDir, '02-layout', 'page-layout.md'), '# 页面布局\n')
  return jobDir
}
