import { buildConstraintPrompt, CONSTRAINT_PACK_VERSION } from '../../../core/src/constraint-service.js'

export function isDesignToHtmlSkillEnabled(env = process.env) {
  return env.DESIGN_TO_HTML_SKILL_ENABLED !== 'false'
}

export function buildDesignToHtmlSkillPrompt(workflow, { env = process.env, target = 'web' } = {}) {
  if (!isDesignToHtmlSkillEnabled(env)) return ''
  return buildConstraintPrompt(workflow, { target })
}

export function appendDesignToHtmlSkillPrompt(lines, workflow, options = {}) {
  const constraintPrompt = buildDesignToHtmlSkillPrompt(workflow, options)
  if (!constraintPrompt) return lines
  return [
    ...lines,
    '',
    `共享约束版本：${CONSTRAINT_PACK_VERSION}；当前阶段：${workflow}`,
    constraintPrompt,
  ]
}
