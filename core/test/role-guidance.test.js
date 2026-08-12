import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FACT_PRECEDENCE,
  ROLE_GUIDANCE_VERSION,
  buildAgentGenerationPlaybook,
  buildLegacyRolePromptLines,
  buildRoleGuidanceManifest,
} from '../src/role-guidance.js'

test('Agent playbook contains all legacy role perspectives and the shared evidence order', () => {
  const playbook = buildAgentGenerationPlaybook({ target: 'web' })
  assert.match(playbook, /组件结构审阅/)
  assert.match(playbook, /静态资源审阅/)
  assert.match(playbook, /动态交互审阅/)
  assert.match(playbook, /页面级组装审阅/)
  assert.match(playbook, new RegExp(escapeRegExp(FACT_PRECEDENCE)))
  assert.match(playbook, /直接落实到 `agent\/draft\/index\.html`/)
  assert.match(playbook, /不生成角色计划、Assembly Markdown、JSON 代码信封或推理过程/)
  assert.doesNotMatch(playbook, /只输出中文 Markdown/)
  assert.doesNotMatch(playbook, /交给下一阶段/)
  assert.match(playbook, /透明热区/)
  assert.match(playbook, /data-module-id/)
  assert.match(playbook, /renderedLocalBounds/)
  assert.match(playbook, /多视口真实渲染复核/)
})

test('legacy role prompt projection keeps role identity and output-neutral analysis guidance', () => {
  for (const profile of ['component', 'assets', 'interaction', 'assembly']) {
    const prompt = buildLegacyRolePromptLines(profile).join('\n')
    assert.match(prompt, /角色：你是 MasterGo 转 HTML workflow/)
    assert.match(prompt, /分析方法/)
    assert.doesNotMatch(prompt, /agent\/draft/)
  }
  assert.match(buildLegacyRolePromptLines('assembly').join('\n'), new RegExp(escapeRegExp(FACT_PRECEDENCE)))
})

test('role guidance manifest is versioned and hash-addressed', () => {
  const manifest = buildRoleGuidanceManifest({ target: 'web' })
  assert.equal(manifest.version, ROLE_GUIDANCE_VERSION)
  assert.equal(manifest.target, 'web')
  assert.equal(manifest.sha256.length, 64)
  assert.equal(manifest.sha256, buildRoleGuidanceManifest({ target: 'web' }).sha256)
})

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
