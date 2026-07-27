import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDesignToHtmlSkillPrompt, isDesignToHtmlSkillEnabled } from '../src/workflow/design-to-html-skill.js'

test('design-to-html skill injects workflow-specific compact rules', () => {
  const layoutPrompt = buildDesignToHtmlSkillPrompt('layout', { env: {} })
  assert.match(layoutPrompt, /布局关系/)
  assert.match(layoutPrompt, /响应式与溢出/)
  assert.doesNotMatch(layoutPrompt, /素材交付/)

  const assetPrompt = buildDesignToHtmlSkillPrompt('assets', { env: {} })
  assert.match(assetPrompt, /素材交付/)
  assert.match(assetPrompt, /布局关系/)
  assert.doesNotMatch(assetPrompt, /状态稳定/)

  const htmlPrompt = buildDesignToHtmlSkillPrompt('html', { env: {} })
  assert.match(htmlPrompt, /布局关系/)
  assert.match(htmlPrompt, /响应式与溢出/)
  assert.match(htmlPrompt, /状态稳定/)
  assert.match(htmlPrompt, /素材交付/)
  assert.equal(htmlPrompt.length < 2200, true)
})

test('design-to-html skill can be disabled by env for token comparisons', () => {
  const env = { DESIGN_TO_HTML_SKILL_ENABLED: 'false' }
  assert.equal(isDesignToHtmlSkillEnabled(env), false)
  assert.equal(buildDesignToHtmlSkillPrompt('html', { env }), '')
})

