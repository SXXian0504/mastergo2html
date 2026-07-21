import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildAssemblyPlanningContext,
} from '../src/workflow/assembly-planning-context.js'
import { getMissingAssemblyHeadings } from '../src/workflow/assembly-planning.js'

const requiredHeadings = [
  '组装结论',
  '冲突裁决',
  '文件与命名约定',
  '全局样式与设计 Token',
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
  return jobDir
}
