import { join } from 'node:path'
import { assertLlmConfig, getLlmConfig, withLlmJobContext } from '../../mcp-server/src/config.js'
import { runAiLayoutAnalysis } from '../../mcp-server/src/workflow/ai-layout-analysis.js'
import { runComponentStructureAnalysis } from '../../mcp-server/src/workflow/component-structure-analysis.js'
import { runInteractionAnalysis } from '../../mcp-server/src/workflow/interaction-analysis.js'
import { invalidateCodexSdkThread } from '../../mcp-server/src/llm/codex-sdk.js'
import { canonicalPhaseName, PROCESS_PHASES } from '../../mcp-server/src/workflow/job-retry.js'
import { runPlanAndGenerate } from '../../mcp-server/src/workflow/plan-and-generate.js'
import { runRawLayoutConversion } from '../../mcp-server/src/workflow/raw-layout-conversion.js'
import { runStaticAssetAnalysis } from '../../mcp-server/src/workflow/static-asset-analysis.js'

export const LEGACY_PHASE_CONTRACT = {
  'normalize-raw': { startPercent: 10, endPercent: 25, startMessage: '标准化输入数据' },
  'layout-analysis': { startPercent: 32, endPercent: 40, startMessage: '调用 AI 布局分析生成页面整体布局说明' },
  'component-structure-analysis': { startPercent: 50, endPercent: 58, startMessage: 'AI 分析整页组件结构与布局实现' },
  'static-asset-analysis': { startPercent: 60, endPercent: 68, startMessage: 'AI 分析整页静态资源使用方案' },
  'interaction-analysis': { startPercent: 70, endPercent: 78, startMessage: 'AI 分析整页动态交互与状态' },
  'plan-and-generate': { startPercent: 82, endPercent: 100, startMessage: '统一页面裁决并生成 HTML 产物' },
}

const PARALLEL_PAGE_PLAN_PHASES = [
  'component-structure-analysis',
  'static-asset-analysis',
  'interaction-analysis',
]

export async function runLegacyJobWorkflow({
  jobId,
  jobDir,
  startPhase = 'normalize-raw',
  onPhaseStart = () => {},
  onPhaseProgress = () => {},
  onPhaseComplete = () => {},
  onPhaseError = () => {},
  dependencies = {},
}) {
  const canonicalStartPhase = canonicalPhaseName(startPhase)
  if (!PROCESS_PHASES.includes(canonicalStartPhase)) throw new Error(`无法识别开始阶段：${startPhase}`)
  const config = dependencies.config || withLlmJobContext(getLlmConfig(), { jobId, jobDir })
  if (!dependencies.config) assertLlmConfig(config)
  const runners = {
    'normalize-raw': runRawLayoutConversion,
    'layout-analysis': runAiLayoutAnalysis,
    'component-structure-analysis': runComponentStructureAnalysis,
    'static-asset-analysis': runStaticAssetAnalysis,
    'interaction-analysis': runInteractionAnalysis,
    'plan-and-generate': runPlanAndGenerate,
    ...dependencies.runners,
  }

  let layoutConversion = {
    aiLayoutContextPath: join(jobDir, '02-layout', 'ai-layout-context.json'),
    summary: { warningCount: 0 },
  }
  let htmlGenerationResult
  const selectedPhases = PROCESS_PHASES.slice(PROCESS_PHASES.indexOf(canonicalStartPhase))

  if (config.provider === 'codex-sdk' && canonicalStartPhase === 'plan-and-generate') {
    invalidateCodexSdkThread(createCodexPhaseConfig(config, jobId, 'plan-and-generate'))
  }

  const runPhase = async (phase, phaseConfig = config) => {
    const contract = LEGACY_PHASE_CONTRACT[phase]
    await onPhaseStart({ phase, ...contract })
    const startedAt = Date.now()
    const progress = (metrics, message) => onPhaseProgress({
      phase,
      percent: contract.startPercent,
      metrics,
      message,
    })

    let result
    if (phase === 'normalize-raw') {
      layoutConversion = await runners[phase](jobId, jobDir)
      result = {
        ...layoutConversion,
        durationMs: Date.now() - startedAt,
        artifacts: [layoutConversion.normalizedDir, layoutConversion.aiLayoutContextPath],
      }
    } else if (phase === 'layout-analysis') {
      result = await runners[phase]({
        config: phaseConfig,
        jobId,
        jobDir,
        contextPath: layoutConversion.aiLayoutContextPath,
        onProgress: progress,
      })
    } else if (phase === 'component-structure-analysis') {
      result = await runners[phase]({ config: phaseConfig, jobId, jobDir, onProgress: progress })
    } else if (phase === 'static-asset-analysis') {
      result = await runners[phase]({ config: phaseConfig, jobId, jobDir, onProgress: progress })
    } else if (phase === 'interaction-analysis') {
      result = await runners[phase]({ config: phaseConfig, jobId, jobDir, onProgress: progress })
    } else if (phase === 'plan-and-generate') {
      result = await runners[phase]({ config: phaseConfig, jobId, jobDir, onProgress: progress })
      htmlGenerationResult = result
    }

    const message = phaseCompleteMessage(phase, result, layoutConversion)
    await onPhaseComplete({ phase, percent: contract.endPercent, message, result })
    return result
  }

  const runPhaseWithErrorReporting = async (phase, phaseConfig = config) => {
    try {
      return await runPhase(phase, phaseConfig)
    } catch (error) {
      await onPhaseError({ phase, error })
      throw error
    }
  }

  for (let index = 0; index < selectedPhases.length;) {
    const phase = selectedPhases[index]
    if (config.provider === 'codex-sdk' && PARALLEL_PAGE_PLAN_PHASES.includes(phase)) {
      const parallelPhases = PARALLEL_PAGE_PLAN_PHASES.filter((candidate) => selectedPhases.includes(candidate))
      const settled = await Promise.allSettled(parallelPhases.map((candidate) => runPhaseWithErrorReporting(
        candidate,
        createCodexPhaseConfig(config, jobId, candidate),
      )))
      const failures = settled
        .map((result, resultIndex) => ({ result, phase: parallelPhases[resultIndex] }))
        .filter(({ result }) => result.status === 'rejected')
      if (failures.length > 0) {
        const failedPhases = failures.map(({ phase: failedPhase }) => failedPhase)
        const firstError = failures[0].result.reason
        const detail = firstError instanceof Error ? firstError.message : String(firstError)
        throw Object.assign(new Error(`并行页面分析失败（${failedPhases.join('、')}）：${detail}`), {
          phase: failedPhases[0],
          failures,
        })
      }
      index += parallelPhases.length
      continue
    }

    const phaseConfig = config.provider === 'codex-sdk' && phase === 'plan-and-generate'
      ? createCodexPhaseConfig(config, jobId, phase)
      : config
    await runPhaseWithErrorReporting(phase, phaseConfig)
    index += 1
  }

  return {
    htmlGenerationResult,
    layoutConversion,
  }
}

function createCodexPhaseConfig(config, jobId, phase) {
  const threadKey = config.codexThreadKey || jobId
  return {
    ...config,
    codexThreadKey: `${threadKey}:${phase}`,
    codexThreadStatePath: phaseThreadStatePath(config.codexThreadStatePath, phase),
  }
}

function phaseThreadStatePath(path, phase) {
  if (!path) return path
  return path.endsWith('.json')
    ? `${path.slice(0, -5)}.${phase}.json`
    : `${path}.${phase}`
}

export function phaseCompleteMessage(phase, result = {}, layoutConversion = {}) {
  if (phase === 'normalize-raw') {
    return `已生成标准化输入：${result.summary?.nodeCount || 0} 个节点，${result.summary?.assetCount || 0} 个资源`
  }
  if (phase === 'layout-analysis') {
    return `AI 布局分析已生成 page-layout.md：${layoutConversion.summary?.warningCount || 0} 个 warning 待后续修复`
  }
  if (phase === 'component-structure-analysis') return '整页组件结构开发计划已生成'
  if (phase === 'static-asset-analysis') return '整页静态资源开发计划已生成'
  if (phase === 'interaction-analysis') return '整页动态交互开发计划已生成'
  if (phase === 'plan-and-generate') return htmlGenerationCompleteMessage(result)
  return `${phase} 已完成`
}

export function htmlGenerationCompleteMessage(result = {}) {
  return result.staticValidation?.ok === false
    ? 'HTML/CSS/JS 已生成，静态校验存在警告'
    : 'HTML/CSS/JS 已生成并通过静态校验'
}

export function phaseArtifacts(result = {}) {
  return result.artifacts || [result.outputPath, result.promptPath, result.responsePath].filter(Boolean)
}

export function externalTokenUsage() {
  return { source: 'external', available: false }
}
