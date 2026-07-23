import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildAssemblyPlanningContext,
} from '../src/workflow/assembly-planning-context.js'
import { getMissingAssemblyHeadings, runAssemblyPlanning } from '../src/workflow/assembly-planning.js'

const requiredHeadings = [
  '组装结论',
  '冲突裁决',
  '文件与命名约定',
  '全局样式与设计 Token',
  '节点样式裁决',
  '页面渲染顺序与区域衔接',
  '共享组件',
  '资源复制与引用',
  '交互与共享数据',
  '布局约束与定位规则',
  '代码开发顺序',
  '风险与视觉复核',
  '给代码生成步骤的指令',
]

test('assembly context reads all stage seven inputs', () => {
  const jobDir = createFixtureJob()
  const context = buildAssemblyPlanningContext(jobDir)

  assert.equal(context.pageLayout.rootId, 'frame-1')
  assert.equal(context.pageLayoutDescription, '# 页面布局\n')
  assert.equal(context.componentStructurePlan, '# 组件\n')
  assert.equal(context.staticAssetsPlan, '# 资源\n')
  assert.equal(context.interactionPlan, '# 交互\n')
  assert.deepEqual(context.assetIndex.assets, [])
  assert.deepEqual(context.designTokens.tokens, {})
  assert.equal(context.nodeStyleFacts.version, 'mastergo2html.node-style-facts.v1')
  assert.deepEqual(context.immutableTextContract, {
    path: '01-normalized/source-texts.json',
    count: 1,
    sourceNodeIds: ['text-1'],
  })
})

test('assembly context reports the first missing input', () => {
  const jobDir = createFixtureJob()
  unlinkSync(join(jobDir, '03-page-plans', 'interaction.plan.md'))

  assert.throws(
    () => buildAssemblyPlanningContext(jobDir),
    /阶段七缺少必要输入：03-page-plans\/interaction\.plan\.md/,
  )
})

test('assembly plan heading validation is strict and complete', () => {
  const complete = requiredHeadings.map((heading) => `# ${heading}`).join('\n')
  assert.deepEqual(getMissingAssemblyHeadings(complete), [])
  assert.deepEqual(getMissingAssemblyHeadings('# 组装结论\n'), requiredHeadings.slice(1))
})

test('assembly streaming writes the final plan and reports progress', async () => {
  const jobDir = createFixtureJob()
  const progress = []
  let receivedOptions
  const markdown = requiredHeadings.map((heading) => `# ${heading}\n内容`).join('\n')

  const result = await runAssemblyPlanning({
    config: { wireApi: 'responses' },
    jobId: 'job-stream',
    jobDir,
    connectTimeoutMs: 11,
    firstEventTimeoutMs: 22,
    idleTimeoutMs: 33,
    timeoutMs: 44,
    onProgress: (metrics) => progress.push(metrics),
    generateStream: async (options) => {
      receivedOptions = options
      options.onProgress({ mode: 'stream', state: 'connecting', attempt: 1, eventCount: 0, receivedChars: 0 })
      options.onProgress({ mode: 'stream', state: 'streaming', attempt: 1, eventCount: 1, receivedChars: 10 })
      options.onProgress({ mode: 'stream', state: 'validating', attempt: 1, eventCount: 2, receivedChars: markdown.length })
      return { text: markdown, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, streamMode: 'stream' }
    },
  })

  assert.equal(receivedOptions.connectTimeoutMs, 11)
  assert.equal(receivedOptions.firstEventTimeoutMs, 22)
  assert.equal(receivedOptions.idleTimeoutMs, 33)
  assert.ok(receivedOptions.totalTimeoutMs > 0 && receivedOptions.totalTimeoutMs <= 44)
  assert.equal(progress.length, 3)
  assert.equal(result.streamMode, 'stream')
  assert.equal(readFileSync(result.outputPath, 'utf8'), `${markdown}\n`)
})

test('assembly streaming disables the first-event timeout by default', async () => {
  const jobDir = createFixtureJob()
  const markdown = requiredHeadings.map((heading) => `# ${heading}\n内容`).join('\n')
  let receivedOptions

  await runAssemblyPlanning({
    config: { wireApi: 'responses' },
    jobId: 'job-no-first-event-timeout',
    jobDir,
    generateStream: async (options) => {
      receivedOptions = options
      return { text: markdown, usage: {}, streamMode: 'stream' }
    },
  })

  assert.equal(receivedOptions.firstEventTimeoutMs, 0)
})

test('assembly streaming preserves partial output on failure', async () => {
  const jobDir = createFixtureJob()
  await assert.rejects(
    runAssemblyPlanning({
      config: { wireApi: 'responses' },
      jobId: 'job-partial',
      jobDir,
      generateStream: async () => {
        throw Object.assign(new Error('stream interrupted'), { partialText: '# 组装结论\n半截内容' })
      },
    }),
    /stream interrupted/,
  )
  const partialPath = join(jobDir, '04-assembly', 'assembly.plan.partial.md')
  assert.equal(existsSync(partialPath), true)
  assert.equal(readFileSync(partialPath, 'utf8'), '# 组装结论\n半截内容\n')
})

function createFixtureJob() {
  const jobDir = mkdtempSync(join(tmpdir(), 'mastergo2html-assembly-'))
  for (const directory of ['01-normalized', '02-layout', '03-page-plans']) {
    mkdirSync(join(jobDir, directory), { recursive: true })
  }
  writeFileSync(join(jobDir, '02-layout', 'page-layout.json'), JSON.stringify({ rootId: 'frame-1' }), 'utf8')
  writeFileSync(join(jobDir, '02-layout', 'page-layout.md'), '# 页面布局\n', 'utf8')
  writeFileSync(join(jobDir, '03-page-plans', 'component-structure.plan.md'), '# 组件\n', 'utf8')
  writeFileSync(join(jobDir, '03-page-plans', 'static-assets.plan.md'), '# 资源\n', 'utf8')
  writeFileSync(join(jobDir, '03-page-plans', 'interaction.plan.md'), '# 交互\n', 'utf8')
  writeFileSync(join(jobDir, '01-normalized', 'asset-index.json'), JSON.stringify({ assets: [] }), 'utf8')
  writeFileSync(join(jobDir, '01-normalized', 'design-tokens.json'), JSON.stringify({ tokens: {} }), 'utf8')
  writeFileSync(join(jobDir, '01-normalized', 'raw.normalized.json'), JSON.stringify({
    nodes: [{ id: 'text-1', role: 'text', name: '标题', text: '不可修改的标题' }],
  }), 'utf8')
  writeFileSync(join(jobDir, '01-normalized', 'source-texts.json'), JSON.stringify([
    { sourceNodeId: 'text-1', name: '标题', characters: '不可修改的标题' },
  ]), 'utf8')
  return jobDir
}
