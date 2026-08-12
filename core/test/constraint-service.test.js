import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildAgentConstraintPack,
  buildConstraintCoverage,
  buildLegacyConstraintCoverage,
  buildConstraintManifest,
  buildConstraintPrompt,
  getConstraintRegistry,
  selectConstraints,
  validateConstraintRegistry,
} from '../src/constraint-service.js'

test('shared constraint registry is valid, unique, and scoped by workflow', () => {
  const validation = validateConstraintRegistry()
  assert.equal(validation.ok, true)
  assert.equal(validation.constraintCount >= 20, true)

  const layout = selectConstraints({ workflow: 'layout', target: 'web' })
  const assets = selectConstraints({ workflow: 'assets', target: 'web' })
  assert.equal(layout.some((item) => item.id === 'layout.source-fidelity'), true)
  assert.equal(layout.some((item) => item.id === 'assets.render-policy'), false)
  assert.equal(assets.some((item) => item.id === 'assets.render-policy'), true)
})

test('agent constraint pack is compact, versioned, and hash-addressed', () => {
  const pack = buildAgentConstraintPack({ target: 'web' })
  const manifest = buildConstraintManifest({ target: 'web' })
  assert.match(pack, /layout\.source-fidelity/)
  assert.match(pack, /output\.agent-direct-files/)
  assert.match(pack, /Logo 固定为逻辑首项/)
  assert.match(pack, /只能有一个不嵌套在任一按钮内/)
  assert.match(pack, /文字不得进入图标画布或品牌 Logo bbox/)
  assert.match(pack, /中间 wrapper\/兄弟组必须一起退出桌面 absolute/)
  assert.equal(pack.length < 6000, true)
  assert.equal(manifest.constraintPackHash.length, 64)
  assert.equal(manifest.decisionRequiredIds.every((id) => manifest.applicableConstraintIds.includes(id)), true)
})

test('agent pack and manifest preserve the supplied registry version', () => {
  const registry = { ...getConstraintRegistry(), version: 'mastergo2html.constraints.test' }
  const pack = buildAgentConstraintPack({ target: 'web', registry })
  const manifest = buildConstraintManifest({ target: 'web', registry })
  assert.match(pack, /version: mastergo2html\.constraints\.test/)
  assert.equal(manifest.version, registry.version)
})

test('legacy prompt compiler uses the same constraint ids as the agent pack', () => {
  const prompt = buildConstraintPrompt('html', { target: 'web' })
  assert.match(prompt, /\[responsive\.viewport-contract\]\[hard\]/)
  assert.match(prompt, /\[assets\.canvas-integrity\]\[hard\]/)
  assert.match(prompt, /\[output\.local-artifacts\]\[hard\]/)
  assert.doesNotMatch(prompt, /output\.agent-direct-files/)
})

test('plan-and-generate receives the deduplicated union of assembly and html constraints', () => {
  const combined = selectConstraints({ workflow: 'plan-and-generate', target: 'web' }).map((item) => item.id).sort()
  const expected = [...new Set([
    ...selectConstraints({ workflow: 'assembly', target: 'web' }).map((item) => item.id),
    ...selectConstraints({ workflow: 'html', target: 'web' }).map((item) => item.id),
  ])].sort()
  assert.deepEqual(combined, expected)
})

test('constraint coverage distinguishes decisions, machine checks, and review items', () => {
  const manifest = buildConstraintManifest({ target: 'web' })
  const plan = {
    constraintDecisions: manifest.decisionRequiredIds.map((constraintId) => ({ constraintId, decision: 'apply' })),
  }
  const coverage = buildConstraintCoverage({ manifest, plan, validationOk: true })
  assert.equal(coverage.status, 'passed')
  assert.equal(coverage.acknowledged, manifest.decisionRequiredIds.length)
  assert.equal(coverage.machineEnforced > 0, true)
  assert.equal(coverage.reviewRequired > 0, true)
})

test('legacy coverage reports the phase prompt projection without Agent-only transport rules', () => {
  const coverage = buildLegacyConstraintCoverage({ target: 'web', validationOk: true })
  assert.equal(coverage.delivery, 'legacy-phase-prompt')
  assert.equal(coverage.promptDelivered, coverage.applicable)
  assert.equal(coverage.constraintIds.includes('output.local-artifacts'), true)
  assert.equal(coverage.constraintIds.includes('output.agent-direct-files'), false)
})

test('registry validation reports duplicate ids and duplicate normalized instructions', () => {
  const registry = getConstraintRegistry()
  const duplicate = { ...registry.constraints[0] }
  const validation = validateConstraintRegistry({ ...registry, constraints: [...registry.constraints, duplicate] })
  assert.equal(validation.ok, false)
  assert.match(validation.errors.join('\n'), /重复 constraint id/)
  assert.match(validation.errors.join('\n'), /重复约束语义文本/)
})
