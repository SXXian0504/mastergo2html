export const PROCESS_PHASES = [
  'normalize-raw',
  'layout-analysis',
  'component-structure-analysis',
  'static-asset-analysis',
  'interaction-analysis',
  'assembly-planning',
  'html-generation',
]

export function findFailedPhase(job) {
  return job.phaseDetails?.find((phase) => phase.status === 'error')?.phase || job.progress?.phase
}

export function phaseStartPercent(phase) {
  return ({
    'normalize-raw': 10,
    'layout-analysis': 32,
    'component-structure-analysis': 50,
    'static-asset-analysis': 60,
    'interaction-analysis': 70,
    'assembly-planning': 82,
    'html-generation': 90,
    'package-files': 100,
  })[phase] || 0
}

export function resetPhaseDetailsForRetry(phaseDetails, startPhase) {
  const startIndex = PROCESS_PHASES.indexOf(startPhase)
  return (phaseDetails || []).map((phase) => {
    const phaseIndex = PROCESS_PHASES.indexOf(phase.phase)
    if (phaseIndex < startIndex || phaseIndex === -1) return { ...phase }
    return {
      ...phase,
      status: 'pending',
      startedAt: undefined,
      endedAt: undefined,
      durationMs: 0,
    }
  })
}
