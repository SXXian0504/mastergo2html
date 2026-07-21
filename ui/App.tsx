import React, { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  ExportOptions,
  ExportProgress,
  ExportResult,
  JobRecord,
  PluginMessage,
  PluginToUIMessage,
  UIMessage,
  sendMsgToPlugin,
} from '@messages/sender'
import { createZip } from './zip'

type ExportState = 'idle' | 'running' | 'done' | 'error'
type ExportMode = 'structure' | 'originals' | 'slices' | 'all'
type GenerateImageMode = 'slices' | 'originals'
const PANEL_URL = 'http://127.0.0.1:8787/panel'
const DEFAULT_PROGRESS: ExportProgress = {
  phase: 'scan-nodes',
  done: 0,
  total: 0,
  label: '等待开始',
  failed: 0,
}

const EXPORT_MODES: Array<{
  value: ExportMode
  label: string
  description: string
}> = [
  {
    value: 'structure',
    label: '仅结构',
    description: '最快；输出 JSON 和 imageRef 映射，适合先进入 AI 分析。',
  },
  {
    value: 'originals',
    label: '结构 + 原图',
    description: '读取 MasterGo 图片资源；大图可能较慢。',
  },
  {
    value: 'slices',
    label: '结构 + 图片节点切片',
    description: '实验能力；只切 imageRef 来源节点，可能不完整。',
  },
  {
    value: 'all',
    label: '全部导出',
    description: '同时导出原图和图片节点切片；最慢且仍可能遗漏。',
  },
]

const GENERATE_IMAGE_MODES: Array<{
  value: GenerateImageMode
  label: string
  description: string
}> = [
  {
    value: 'slices',
    label: '切片',
    description: '测试阶段推荐；导出节点渲染结果，便于 AI 对齐视觉稿。',
  },
  {
    value: 'originals',
    label: '原图',
    description: '最终生成推荐；使用设计稿引用的原始图片资源。',
  },
]

function App() {
  const [state, setState] = useState<ExportState>('idle')
  const [result, setResult] = useState<ExportResult | null>(null)
  const [progress, setProgress] = useState<ExportProgress>(DEFAULT_PROGRESS)
  const [exportMode, setExportMode] = useState<ExportMode>('structure')
  const [generateImageMode, setGenerateImageMode] = useState<GenerateImageMode>('slices')
  const [recentJob, setRecentJob] = useState<JobRecord | null>(null)
  const [submittedJobId, setSubmittedJobId] = useState('')
  const [copiedKey, setCopiedKey] = useState('')
  const [error, setError] = useState('')
  const [expandedPhaseKeys, setExpandedPhaseKeys] = useState<Set<string>>(new Set())
  const notifiedJobIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = getPluginMessage(event.data)
      if (!message) return

      if (message.type === PluginMessage.EXPORT_STARTED) {
        setState('running')
        setError('')
        setProgress({ ...DEFAULT_PROGRESS, label: '准备导出' })
      }

      if (message.type === PluginMessage.EXPORT_PROGRESS) {
        setProgress(message.data)
      }

      if (message.type === PluginMessage.EXPORT_COMPLETE) {
        setState('done')
        setResult(message.data)
      }

      if (message.type === PluginMessage.EXPORT_ERROR) {
        setState('error')
        setError(message.data)
      }

      if (message.type === PluginMessage.JOB_INPUT_READY) {
        submitJobInput(message.data)
      }

      if (message.type === PluginMessage.JOB_SUBMITTED) {
        setState('done')
        setSubmittedJobId(message.data.jobId)
      }

      if (message.type === PluginMessage.JOB_STATUS) {
        setRecentJob(message.data)
        if (message.data?.jobId && message.data.status !== 'done' && message.data.status !== 'error' && message.data.status !== 'canceled') {
          refreshJobFromBridge(message.data.jobId)
        }
      }
    }

    window.addEventListener('message', onMessage)
    sendMsgToPlugin({ type: UIMessage.REFRESH_RECENT_JOB })
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    if (!recentJob?.jobId || recentJob.status === 'done' || recentJob.status === 'error' || recentJob.status === 'canceled') return

    const intervalId = window.setInterval(() => {
      refreshJobFromBridge(recentJob.jobId)
    }, 1000)
    return () => window.clearInterval(intervalId)
  }, [recentJob?.jobId, recentJob?.status])

  const summary = useMemo(() => {
    if (!result) return []
    return [
      ['根节点', result.selectionCount],
      ['总节点', result.nodeCount],
      ['原图资源', result.imageAssetCount],
      ['图片节点切片', result.renderedAssetCount],
      ['失败资源', result.failures.length],
      ['预估大小', formatBytes(result.zipSizeEstimateBytes)],
      ['总耗时', formatDuration(result.durationMs)],
    ]
  }, [result])

  const exportSelection = () => {
    const includeOriginalImages = exportMode === 'originals' || exportMode === 'all'
    const includeRenderedSlices = exportMode === 'slices' || exportMode === 'all'
    const options: ExportOptions = {
      includeOriginalImages,
      includeRenderedSlices,
      rawProfile: 'html',
    }
    setResult(null)
    setError('')
    setState('running')
    setProgress({ ...DEFAULT_PROGRESS, label: '准备导出' })
    sendMsgToPlugin({ type: UIMessage.EXPORT_SELECTION, data: options })
  }

  const generateHtml = () => {
    const options: ExportOptions = {
      includeOriginalImages: generateImageMode === 'originals',
      includeRenderedSlices: generateImageMode === 'slices',
      rawProfile: 'html',
    }
    setResult(null)
    setError('')
    setSubmittedJobId('')
    setState('running')
    setProgress({ ...DEFAULT_PROGRESS, label: '检查本地 MCP 服务' })
    sendMsgToPlugin({ type: UIMessage.GENERATE_HTML, data: options })
  }

  const refreshRecentJob = () => {
    if (recentJob?.jobId) {
      refreshJobFromBridge(recentJob.jobId)
    } else {
      sendMsgToPlugin({ type: UIMessage.REFRESH_RECENT_JOB })
    }
  }

  const downloadZip = () => {
    if (!result) return
    const blob = createZip(result.files)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${result.name || 'mastergo-html-export'}.zip`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const submitJobInput = async (input: Parameters<typeof createBridgeJob>[0]) => {
    try {
      setProgress({ ...DEFAULT_PROGRESS, label: '提交到本地 MCP 服务' })
      const job = await createBridgeJob(input)
      setRecentJob(job)
      sendMsgToPlugin({ type: UIMessage.COMPLETE_JOB_SUBMISSION, data: { panelUrl: PANEL_URL, job } })
    } catch (submitError) {
      setState('error')
      setError(`MCP 本地服务不可用或创建任务失败：${errorMessage(submitError)}。请先运行 npm run mcp:dev。`)
    }
  }

  const refreshJobFromBridge = async (jobId: string) => {
    try {
      const response = await fetch(`http://127.0.0.1:8787/jobs/${jobId}`)
      if (!response.ok) return
      const job = (await response.json()) as JobRecord
      setRecentJob(job)
      if ((job.status === 'done' || job.status === 'error') && !notifiedJobIds.current.has(job.jobId)) {
        notifiedJobIds.current.add(job.jobId)
        sendMsgToPlugin({ type: UIMessage.NOTIFY_JOB_STATUS, data: job })
      }
    } catch {
      // Keep the stored snapshot when the local service is not running.
    }
  }

  const copyPath = async (key: string, value: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value)
      } else {
        fallbackCopyText(value)
      }
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((current) => (current === key ? '' : current)), 1200)
    } catch {
      fallbackCopyText(value)
      setCopiedKey(key)
      window.setTimeout(() => setCopiedKey((current) => (current === key ? '' : current)), 1200)
    }
  }

  return (
    <main className="app">
      <header className={`header ${state === 'running' ? 'headerCompact' : ''}`}>
        <div>
          <h1>MasterGo HTML Generator</h1>
          <p>{state === 'running' ? '正在采集并提交任务。' : '导出结构，或提交给本地 MCP 服务生成 HTML。'}</p>
        </div>
      </header>

      <section className="panel">
        {state !== 'running' && (
          <>
            <fieldset className="modeGroup generateModeGroup" disabled={state === 'running'}>
              <legend>一键生成图片策略</legend>
              <div className="segmentedOptions">
                {GENERATE_IMAGE_MODES.map((mode) => (
                  <label
                    className={`segmentedOption ${generateImageMode === mode.value ? 'segmentedOptionActive' : ''}`}
                    key={mode.value}
                  >
                    <input
                      type="radio"
                      name="generate-image-mode"
                      value={mode.value}
                      checked={generateImageMode === mode.value}
                      onChange={() => setGenerateImageMode(mode.value)}
                    />
                    <span>
                      <strong>{mode.label}</strong>
                      <small>{mode.description}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <button className="primaryButton" type="button" onClick={generateHtml}>
              一键生成 HTML
            </button>

            <div className="serviceHint">
              本地服务：
              <PathRow
                label="服务"
                value="http://127.0.0.1:8787"
                copyKey="service-url"
                copiedKey={copiedKey}
                onCopy={copyPath}
              />
              <a href={PANEL_URL} target="_blank" rel="noreferrer">外部面板</a>
            </div>

            {recentJob && (
              <div className="jobPanel">
                <div className="progressMeta">
                  <span>最近任务：{jobStatusLabel(recentJob.status)}</span>
                  <strong>{recentJob.progress.percent}%</strong>
                </div>
                <div className="progressTrack">
                  <div className="progressBar" style={{ width: `${recentJob.progress.percent}%` }} />
                </div>
                <p>{jobPhaseLabel(recentJob.progress.phase)}：{recentJob.progress.message}</p>
                <JobPhaseDetails
                  job={recentJob}
                  expandedPhaseKeys={expandedPhaseKeys}
                  onToggle={(phaseKey) => {
                    setExpandedPhaseKeys((current) => {
                      const next = new Set(current)
                      if (next.has(phaseKey)) next.delete(phaseKey)
                      else next.add(phaseKey)
                      return next
                    })
                  }}
                />
                {recentJob.downloadUrl && (
                  <PathRow
                    label="下载地址"
                    value={`http://127.0.0.1:8787${recentJob.downloadUrl}`}
                    copyKey={`${recentJob.jobId}:download`}
                    copiedKey={copiedKey}
                    onCopy={copyPath}
                  />
                )}
                {recentJob.outputDir && (
                  <PathRow
                    label="输出目录"
                    value={recentJob.outputDir}
                    copyKey={`${recentJob.jobId}:output-dir`}
                    copiedKey={copiedKey}
                    onCopy={copyPath}
                  />
                )}
                {recentJob.inputPath && (
                  <PathRow
                    label="输入包"
                    value={recentJob.inputPath}
                    copyKey={`${recentJob.jobId}:input-path`}
                    copiedKey={copiedKey}
                    onCopy={copyPath}
                  />
                )}
                {recentJob.resultSummary?.zipPath && (
                  <PathRow
                    label="ZIP"
                    value={recentJob.resultSummary.zipPath}
                    copyKey={`${recentJob.jobId}:zip`}
                    copiedKey={copiedKey}
                    onCopy={copyPath}
                  />
                )}
                {recentJob.resultSummary?.htmlPath && (
                  <PathRow
                    label="HTML"
                    value={recentJob.resultSummary.htmlPath}
                    copyKey={`${recentJob.jobId}:html`}
                    copiedKey={copiedKey}
                    onCopy={copyPath}
                  />
                )}
                {recentJob.error && <p className="error">{recentJob.error}</p>}
              </div>
            )}

            <button className="secondaryButton" type="button" onClick={refreshRecentJob}>
              刷新最近任务
            </button>

            <fieldset className="modeGroup" disabled={state === 'running'}>
              <legend>导出模式</legend>
              {EXPORT_MODES.map((mode) => (
                <label className={`modeOption ${exportMode === mode.value ? 'modeOptionActive' : ''}`} key={mode.value}>
                  <input
                    type="radio"
                    name="export-mode"
                    value={mode.value}
                    checked={exportMode === mode.value}
                    onChange={() => setExportMode(mode.value)}
                  />
                  <span>
                    <strong>{mode.label}</strong>
                    <small>{mode.description}</small>
                  </span>
                </label>
              ))}
            </fieldset>

            {exportMode !== 'structure' && (
              <p className="modeWarning">
                图片资源较大时会逐个处理并写入失败报告；切片当前只覆盖 imageRef 来源节点，可能不准或遗漏。建议首轮用“仅结构”，后续按资源计划补导。
              </p>
            )}

            <button className="primaryButton" type="button" onClick={exportSelection} disabled={state === 'running'}>
              导出选中内容
            </button>
          </>
        )}

        {state === 'running' && (
          <div className="progressPanel progressPanelRunning">
            <div className="progressMeta">
              <span>{phaseLabel(progress.phase)}</span>
              <strong>{progress.total > 0 ? `${progress.done}/${progress.total}` : '处理中'}</strong>
            </div>
            <div className="progressTrack">
              <div className="progressBar" style={{ width: `${progressPercent(progress)}%` }} />
            </div>
            <p>{progress.label}</p>
            <div className="progressFacts">
              <span>失败 {progress.failed}</span>
              {progress.warning && <span>{progress.warning}</span>}
            </div>
          </div>
        )}

        {state === 'idle' && <p className="hint">请在画布中选中一个或多个 Frame，也可以选中任意图层树作为导出根节点。</p>}

        {state === 'error' && <p className="error">{error}</p>}

        {submittedJobId && (
          <div className="jobPanel">
            <strong>任务已提交</strong>
            <PathRow
              label="Job ID"
              value={submittedJobId}
              copyKey="submitted-job-id"
              copiedKey={copiedKey}
              onCopy={copyPath}
            />
            <p>插件窗口会保持打开，任务状态会自动刷新。</p>
          </div>
        )}

        {result && (
          <div className="result">
            <div className="stats">
              {summary.map(([label, value]) => (
                <div className="stat" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>

            <button className="downloadButton" type="button" onClick={downloadZip}>
              下载 ZIP
            </button>

            {(result.warnings.length > 0 || result.failures.length > 0) && (
              <div className="report">
                {result.warnings.length > 0 && (
                  <>
                    <h2>提示</h2>
                    {result.warnings.map((warning) => (
                      <p key={warning}>{warning}</p>
                    ))}
                  </>
                )}
                {result.failures.length > 0 && (
                  <>
                    <h2>失败资源</h2>
                    {result.failures.slice(0, 4).map((failure) => (
                      <code key={`${failure.kind}-${failure.assetId}`}>{failure.assetId}：{failure.error}</code>
                    ))}
                    {result.failures.length > 4 && <p>其余失败详情已写入 export-report.json。</p>}
                  </>
                )}
              </div>
            )}

            <div className="files">
              <h2>输出结构</h2>
              <code>raw.json</code>
              <code>asset-manifest.json</code>
              <code>export-report.json</code>
              {result.files.some((file) => file.path === 'frame-screenshot.png') && <code>frame-screenshot.png</code>}
              {result.files.some((file) => file.path.startsWith('assets/original/')) && <code>assets/original/*.png</code>}
              {result.renderedAssetCount > 0 && <code>assets/rendered/*.png</code>}
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

function PathRow({
  label,
  value,
  copyKey,
  copiedKey,
  onCopy,
}: {
  label: string
  value: string
  copyKey: string
  copiedKey: string
  onCopy: (key: string, value: string) => void
}) {
  const copied = copiedKey === copyKey

  return (
    <div className="pathRow">
      <code>
        <span className="pathLabel">{label}：</span>
        <span className="pathText">{value}</span>
      </code>
      <button
        className={`copyButton ${copied ? 'copyButtonCopied' : ''}`}
        type="button"
        title={copied ? '已复制' : '复制'}
        aria-label={copied ? '已复制' : `复制${label}`}
        onClick={() => onCopy(copyKey, value)}
      >
        {copied ? '✓' : '⧉'}
      </button>
    </div>
  )
}

function JobPhaseDetails({
  job,
  expandedPhaseKeys,
  onToggle,
}: {
  job: JobRecord
  expandedPhaseKeys: Set<string>
  onToggle: (phaseKey: string) => void
}) {
  const details = job.phaseDetails || []
  if (details.length === 0) {
    return <p className="phaseEmpty">阶段明细等待 MCP workflow 写入。</p>
  }

  return (
    <div className="phaseDetails">
      <div className="phaseDetailsHeader">
        <strong>阶段明细</strong>
        <span>Token / 耗时</span>
      </div>
      {details.map((detail) => {
        const phaseKey = `${job.jobId}:${detail.phase}`
        const expanded = detail.status === 'running' || expandedPhaseKeys.has(phaseKey)
        return (
          <section className={`phaseCard ${expanded ? 'phaseCardExpanded' : ''}`} key={phaseKey}>
            <button className="phaseToggle" type="button" onClick={() => onToggle(phaseKey)}>
              <span>{jobPhaseLabel(detail.phase)}</span>
              <span className={`phaseStatus phaseStatus-${detail.status}`}>{phaseStatusLabel(detail.status)}</span>
            </button>
            {expanded && (
              <div className="phaseBody">
                {detail.message && <p>{detail.message}</p>}
                <div className="phaseStats">
                  <span>耗时 <strong>{formatDuration(detail.durationMs || 0)}</strong></span>
                  <span>输入 <strong>{formatTokenCount(detail.tokenUsage?.inputTokens)}</strong></span>
                  <span>输出 <strong>{formatTokenCount(detail.tokenUsage?.outputTokens)}</strong></span>
                  <span>总计 <strong>{formatTokenCount(detail.tokenUsage?.totalTokens)}</strong>{detail.tokenUsage?.estimated ? ' 估算' : ''}</span>
                </div>
                {detail.artifacts && detail.artifacts.length > 0 && (
                  <div className="phaseArtifacts">
                    {detail.artifacts.slice(0, 3).map((artifact) => (
                      <code key={artifact}>{artifact}</code>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}

function fallbackCopyText(value: string) {
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

function formatTokenCount(value?: number) {
  const count = value || 0
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}

function progressPercent(progress: ExportProgress) {
  if (progress.total <= 0) return progress.label === '等待开始' ? 12 : 40
  return Math.max(4, Math.min(100, Math.round((progress.done / progress.total) * 100)))
}

function phaseLabel(phase: ExportProgress['phase']) {
  const labels: Record<ExportProgress['phase'], string> = {
    'scan-nodes': '扫描节点',
    'serialize-json': '精简 JSON',
    'collect-assets': '整理资源',
    'export-originals': '导出原图',
    'export-rendered-slices': '导出图片节点切片',
    'export-frame-screenshot': '导出 Frame 截图',
    'package-files': '打包文件',
  }
  return labels[phase]
}

function jobStatusLabel(status: JobRecord['status']) {
  const labels: Record<JobRecord['status'], string> = {
    queued: '排队中',
    running: '运行中',
    done: '已完成',
    error: '失败',
    canceled: '已取消',
  }
  return labels[status]
}

function jobPhaseLabel(phase: JobRecord['progress']['phase']) {
  const labels: Record<JobRecord['progress']['phase'], string> = {
    'collect-input': '收集输入',
    'normalize-raw': '标准化',
    'layout-analysis': '布局分析',
    'component-structure-analysis': '组件结构分析',
    'static-asset-analysis': '静态资源分析',
    'interaction-analysis': '动态交互分析',
    'assembly-planning': '页面组装计划',
    'html-generation': 'HTML 生成',
    'visual-qa': '视觉 QA',
    'package-files': '打包文件',
  }
  return labels[phase]
}

function phaseStatusLabel(status: NonNullable<JobRecord['phaseDetails']>[number]['status']) {
  const labels: Record<NonNullable<JobRecord['phaseDetails']>[number]['status'], string> = {
    pending: '等待',
    running: '进行中',
    done: '完成',
    error: '失败',
  }
  return labels[status]
}

function getPluginMessage(data: unknown): PluginToUIMessage | null {
  if (!data || typeof data !== 'object') return null

  const maybeWrapped = data as { pluginMessage?: PluginToUIMessage }
  if (maybeWrapped.pluginMessage) return maybeWrapped.pluginMessage

  const maybeMessage = data as Partial<PluginToUIMessage>
  return typeof maybeMessage.type === 'string' ? (maybeMessage as PluginToUIMessage) : null
}

async function createBridgeJob(input: unknown): Promise<JobRecord> {
  const response = await fetch('http://127.0.0.1:8787/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const created = await response.json()
  return {
    jobId: created.jobId,
    status: created.status,
    progress: created.progress,
    source: (input as { source: JobRecord['source'] }).source,
    createdAt: created.createdAt,
    updatedAt: created.createdAt,
    inputPath: created.inputPath,
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export default App
