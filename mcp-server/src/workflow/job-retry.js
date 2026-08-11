export const PROCESS_PHASES = [
  'normalize-raw',
  'layout-analysis',
  'component-structure-analysis',
  'static-asset-analysis',
  'interaction-analysis',
  'plan-and-generate',
]

const LEGACY_PHASE_ALIASES = new Map([
  ['assembly-planning', 'plan-and-generate'],
  ['html-generation', 'plan-and-generate'],
])

export function canonicalPhaseName(phase) {
  return LEGACY_PHASE_ALIASES.get(phase) || phase
}

export function findFailedPhase(job) {
  const failed = [...(job.phaseDetails || [])].reverse().find((phase) => phase.status === 'error')?.phase
    || job.progress?.phase
  return canonicalPhaseName(failed)
}

export function phaseStartPercent(phase) {
  const canonicalPhase = canonicalPhaseName(phase)
  return ({
    'normalize-raw': 10,
    'layout-analysis': 32,
    'component-structure-analysis': 50,
    'static-asset-analysis': 60,
    'interaction-analysis': 70,
    'plan-and-generate': 82,
    'package-files': 100,
  })[canonicalPhase] || 0
}

export function resetPhaseDetailsForRetry(phaseDetails, startPhase) {
  const canonicalStartPhase = canonicalPhaseName(startPhase)
  const startIndex = PROCESS_PHASES.indexOf(canonicalStartPhase)
  return (phaseDetails || []).map((phase) => {
    if (LEGACY_PHASE_ALIASES.has(phase.phase)) return { ...phase }
    const phaseIndex = PROCESS_PHASES.indexOf(canonicalPhaseName(phase.phase))
    if (phaseIndex < startIndex || phaseIndex === -1) return { ...phase }
    return {
      ...phase,
      status: 'pending',
      startedAt: undefined,
      endedAt: undefined,
      durationMs: 0,
      streamMetrics: undefined,
    }
  })
}
