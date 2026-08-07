import assert from 'node:assert/strict'
import test from 'node:test'
import { buildInteractionSystemPrompt } from '../src/workflow/interaction-analysis.js'

test('interaction planning requires a per-component hover and motion state matrix', () => {
  const prompt = buildInteractionSystemPrompt()

  assert.match(prompt, /交互状态矩阵/)
  assert.match(prompt, /default、hover、focus-visible、active\/pressed/)
  assert.match(prompt, /岗位、新闻、产品、课程等重复结果卡片/)
  assert.match(prompt, /不得仅因 URL 未提供就删除 hover、focus 或链接语义/)
  assert.match(prompt, /120–240ms/)
  assert.match(prompt, /prefers-reduced-motion/)
})
