import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getMissingPagePlanHeadings,
  normalizePagePlanMarkdown,
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
