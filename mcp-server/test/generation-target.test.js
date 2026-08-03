import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendGenerationTargetPrompt,
  appTargetContext,
  buildGenerationTargetPrompt,
  isAppGenerationTarget,
  resolveGenerationTarget,
} from '../src/workflow/generation-target.js'

test('web remains the backward-compatible default and does not alter prompts', () => {
  assert.equal(resolveGenerationTarget(undefined), 'web')
  assert.equal(resolveGenerationTarget({}), 'web')
  assert.equal(resolveGenerationTarget({ exportOptions: {} }), 'web')
  assert.equal(isAppGenerationTarget({ targetPlatform: 'web' }), false)
  assert.deepEqual(appTargetContext({}), {})
  assert.equal(buildGenerationTargetPrompt('html', {}), '')
  assert.equal(appendGenerationTargetPrompt('original web prompt', 'html', {}), 'original web prompt')
})

test('app target is explicit and injects mobile-only rules', () => {
  const nested = { exportOptions: { targetPlatform: 'app' } }
  assert.equal(resolveGenerationTarget(nested), 'app')
  assert.equal(isAppGenerationTarget(nested), true)
  assert.deepEqual(appTargetContext(nested), { targetPlatform: 'app' })

  const htmlPrompt = buildGenerationTargetPrompt('html', nested)
  assert.match(htmlPrompt, /移动 App 画布/)
  assert.match(htmlPrompt, /width=device-width/)
  assert.match(htmlPrompt, /100dvh/)
  assert.match(htmlPrompt, /44×44/)
  assert.match(htmlPrompt, /多个 interactionStates/)
  assert.match(htmlPrompt, /任何时刻只能展示一个状态/)

  const webPrompt = appendGenerationTargetPrompt('base', 'html', {})
  const appPrompt = appendGenerationTargetPrompt('base', 'html', nested)
  assert.equal(webPrompt, 'base')
  assert.match(appPrompt, /^base\n\nApp 页面模式规则/)
})
