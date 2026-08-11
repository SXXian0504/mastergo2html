import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const REGISTRY_PATH = join(ROOT, '..', 'constraints', 'registry.json')
const DEFAULT_REGISTRY = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
const KNOWN_LEVELS = new Set(['hard', 'advisory', 'review'])

export const CONSTRAINT_PACK_VERSION = DEFAULT_REGISTRY.version

export function validateConstraintRegistry(registry = DEFAULT_REGISTRY) {
  const errors = []
  if (!registry?.version) errors.push('约束注册表缺少 version')
  if (!Array.isArray(registry?.constraints) || registry.constraints.length === 0) errors.push('约束注册表 constraints 不能为空')
  const ids = new Set()
  const normalizedInstructions = new Map()
  for (const [index, constraint] of (registry?.constraints || []).entries()) {
    const label = `constraints[${index}]`
    if (!constraint?.id || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(constraint.id)) errors.push(`${label}.id 无效`)
    if (ids.has(constraint?.id)) errors.push(`重复 constraint id：${constraint.id}`)
    ids.add(constraint?.id)
    if (!KNOWN_LEVELS.has(constraint?.level)) errors.push(`${constraint?.id || label}.level 无效`)
    for (const field of ['domains', 'workflows', 'targets', 'enforcement', 'sourceRefs']) {
      if (!Array.isArray(constraint?.[field]) || constraint[field].length === 0) errors.push(`${constraint?.id || label}.${field} 不能为空`)
    }
    if (!String(constraint?.instruction || '').trim()) errors.push(`${constraint?.id || label}.instruction 不能为空`)
    const normalized = normalizeInstruction(constraint?.instruction)
    if (normalized && normalizedInstructions.has(normalized)) {
      errors.push(`重复约束语义文本：${normalizedInstructions.get(normalized)} / ${constraint.id}`)
    }
    if (normalized) normalizedInstructions.set(normalized, constraint.id)
  }
  return { ok: errors.length === 0, errors, version: registry?.version, constraintCount: registry?.constraints?.length || 0 }
}

export function getConstraintRegistry() {
  const validation = validateConstraintRegistry(DEFAULT_REGISTRY)
  if (!validation.ok) throw new Error(`共享约束注册表无效：${validation.errors.join('；')}`)
  return DEFAULT_REGISTRY
}

export function selectConstraints({ workflow, target = 'web', domains, registry = getConstraintRegistry() } = {}) {
  const domainSet = domains?.length ? new Set(domains) : null
  const selected = registry.constraints.filter((constraint) => {
    if (workflow && !constraint.workflows.includes(workflow)) return false
    if (target && !constraint.targets.includes(target)) return false
    if (domainSet && !constraint.domains.some((domain) => domainSet.has(domain))) return false
    return true
  })
  return [...new Map(selected.map((constraint) => [constraint.id, constraint])).values()]
}

export function buildConstraintPrompt(workflow, { target = 'web', domains, registry } = {}) {
  return selectConstraints({ workflow, target, domains, registry })
    .map((constraint) => `[${constraint.id}][${constraint.level}] ${constraint.instruction}`)
    .join('\n')
}

export function buildAgentConstraintPack({ target = 'web', registry } = {}) {
  const resolvedRegistry = registry || getConstraintRegistry()
  const constraints = selectConstraints({ workflow: 'agent', target, registry: resolvedRegistry })
  const byDomain = new Map()
  for (const constraint of constraints) {
    const domain = constraint.domains[0]
    if (!byDomain.has(domain)) byDomain.set(domain, [])
    byDomain.get(domain).push(constraint)
  }
  const lines = [
    '# MasterGo2HTML Shared Constraint Pack',
    '',
    `version: ${resolvedRegistry.version}`,
    `target: ${target}`,
    '',
    'Apply every hard constraint. Record decisions only for IDs listed by the plan template. Use agent-inspect for evidence; do not reload the complete normalized tree.',
  ]
  for (const [domain, items] of byDomain) {
    lines.push('', `## ${domain}`)
    for (const item of items) lines.push(`- [${item.id}][${item.level}] ${item.instruction}`)
  }
  return `${lines.join('\n')}\n`
}

export function buildConstraintManifest({ target = 'web', registry } = {}) {
  const resolvedRegistry = registry || getConstraintRegistry()
  const constraints = selectConstraints({ workflow: 'agent', target, registry: resolvedRegistry })
  const pack = buildAgentConstraintPack({ target, registry: resolvedRegistry })
  return {
    version: resolvedRegistry.version,
    target,
    constraintPackHash: createHash('sha256').update(pack).digest('hex'),
    applicableConstraintIds: constraints.map((constraint) => constraint.id),
    hardConstraintIds: constraints.filter((constraint) => constraint.level === 'hard').map((constraint) => constraint.id),
    decisionRequiredIds: constraints.filter((constraint) => constraint.decisionRequired).map((constraint) => constraint.id),
    machineEnforcedIds: constraints.filter((constraint) => constraint.enforcement.some((item) => item !== 'visual-review' && item !== 'plan-validator')).map((constraint) => constraint.id),
    reviewRequiredIds: constraints.filter((constraint) => constraint.enforcement.includes('visual-review')).map((constraint) => constraint.id),
  }
}

export function buildConstraintCoverage({ manifest, plan, validationOk }) {
  const decisions = new Map((plan?.constraintDecisions || []).map((item) => [item.constraintId, item]))
  const acknowledgedIds = manifest.decisionRequiredIds.filter((id) => String(decisions.get(id)?.decision || '').trim())
  const uncoveredIds = manifest.decisionRequiredIds.filter((id) => !acknowledgedIds.includes(id))
  return {
    version: manifest.version,
    constraintPackHash: manifest.constraintPackHash,
    applicable: manifest.applicableConstraintIds.length,
    acknowledged: acknowledgedIds.length,
    machineEnforced: manifest.machineEnforcedIds.length,
    reviewRequired: manifest.reviewRequiredIds.length,
    uncoveredIds,
    status: uncoveredIds.length > 0 ? 'incomplete' : validationOk ? 'passed' : 'failed',
  }
}

export function buildLegacyConstraintCoverage({ workflow = 'html', target = 'web', validationOk, registry } = {}) {
  const constraints = selectConstraints({ workflow, target, registry })
  return {
    version: registry?.version || CONSTRAINT_PACK_VERSION,
    delivery: 'legacy-phase-prompt',
    applicable: constraints.length,
    promptDelivered: constraints.length,
    machineEnforced: constraints.filter((constraint) => constraint.enforcement.some((item) => ['static-validator', 'runtime-validator', 'finalizer'].includes(item))).length,
    reviewRequired: constraints.filter((constraint) => constraint.enforcement.includes('visual-review')).length,
    constraintIds: constraints.map((constraint) => constraint.id),
    status: validationOk ? 'passed-with-review' : 'failed',
  }
}

function normalizeInstruction(value) {
  return String(value || '').toLowerCase().replace(/[\s，。；：、“”‘’（）()]/g, '')
}
