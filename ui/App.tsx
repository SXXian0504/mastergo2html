import React, { useEffect, useRef, useState } from 'react'
import './App.css'
import {
  ExportOptions,
  ExportFile,
  ExportResult,
  ExportProgress,
  JobRecord,
  CodexExportRequest,
  PluginMessage,
  PluginToUIMessage,
  UIMessage,
  sendMsgToPlugin,
} from '@messages/sender'
import { createZip } from './zip'

type ExportState = 'idle' | 'running' | 'done' | 'error'
const PANEL_URL = 'http://127.0.0.1:8787/panel'
const DEFAULT_PROGRESS: ExportProgress = {
  phase: 'scan-nodes',
  done: 0,
  total: 0,
  label: '等待开始',
  failed: 0,
}
const STATIC_EXPORT_OPTIONS: ExportOptions = {
  includeOriginalImages: false,
  includeRenderedSlices: true,
  rawProfile: 'html',
}

function App() {
  const [state, setState] = useState<ExportState>('idle')
  const [progress, setProgress] = useState<ExportProgress>(DEFAULT_PROGRESS)
  const [recentJob, setRecentJob] = useState<JobRecord | null>(null)
  const [staticExportResult, setStaticExportResult] = useState<ExportResult | null>(null)
  const [submittedJobId, setSubmittedJobId] = useState('')
  const [copiedKey, setCopiedKey] = useState('')
  const [error, setError] = useState('')
  const [jobActionError, setJobActionError] = useState('')
  const [jobAction, setJobAction] = useState<'saving' | 'opening' | 'revealing' | null>(null)
  const [runningHint, setRunningHint] = useState('正在采集并提交任务。')
  const [retryingPhase, setRetryingPhase] = useState<JobRecord['progress']['phase'] | null>(null)
  const [expandedPhaseKeys, setExpandedPhaseKeys] = useState<Set<string>>(new Set())
  const notifiedJobIds = useRef<Set<string>>(new Set())
  const activeCodexExportRequestId = useRef('')
  const stateRef = useRef<ExportState>('idle')

  useEffect(() => {
    stateRef.current = state
  }, [state])

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
        setStaticExportResult(message.data)
      }

      if (message.type === PluginMessage.EXPORT_ERROR) {
        setState('error')
        setError(message.data)
        if (activeCodexExportRequestId.current) {
          failCodexExportRequest(activeCodexExportRequestId.current, message.data)
          activeCodexExportRequestId.current = ''
        }
      }

      if (message.type === PluginMessage.JOB_INPUT_READY) {
        submitJobInput(message.data)
      }

      if (message.type === PluginMessage.CODEX_EXPORT_INPUT_READY) {
        completeCodexExportRequest(message.data.requestId, message.data.input)
      }

      if (message.type === PluginMessage.JOB_SUBMITTED) {
        setState('done')
        setStaticExportResult(null)
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
    const intervalId = window.setInterval(pollCodexExportRequest, 1000)
    pollCodexExportRequest()
    return () => window.clearInterval(intervalId)
  }, [])

  useEffect(() => {
    if (!recentJob?.jobId || recentJob.status === 'done' || recentJob.status === 'error' || recentJob.status === 'canceled') return

    const intervalId = window.setInterval(() => {
      refreshJobFromBridge(recentJob.jobId)
    }, 1000)
    return () => window.clearInterval(intervalId)
  }, [recentJob?.jobId, recentJob?.status])

  const generateHtml = () => {
    setError('')
    setSubmittedJobId('')
    setStaticExportResult(null)
    setRunningHint('正在采集并提交任务。')
    setState('running')
    setProgress({ ...DEFAULT_PROGRESS, label: '检查本地 MCP 服务' })
    sendMsgToPlugin({ type: UIMessage.GENERATE_HTML, data: STATIC_EXPORT_OPTIONS })
  }

  const exportStaticAssets = () => {
    setError('')
    setSubmittedJobId('')
    setStaticExportResult(null)
    setRunningHint('正在导出 00-input 静态资源。')
    setState('running')
    setProgress({ ...DEFAULT_PROGRESS, label: '准备导出 00-input' })
    sendMsgToPlugin({ type: UIMessage.EXPORT_STATIC_ASSETS, data: STATIC_EXPORT_OPTIONS })
  }

  const downloadStaticInputZip = (result: ExportResult) => {
    const files = createStaticInputFiles(result).map((file) => ({
      ...file,
      path: `00-input/${file.path}`,
    }))
    const blob = createZip(files)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${result.name || 'mastergo'}-00-input.zip`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const refreshRecentJob = () => {
    if (recentJob?.jobId) {
      refreshJobFromBridge(recentJob.jobId)
    } else {
      sendMsgToPlugin({ type: UIMessage.REFRESH_RECENT_JOB })
    }
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

  const pollCodexExportRequest = async () => {
    if (activeCodexExportRequestId.current || stateRef.current === 'running') return
    try {
      const response = await fetch('http://127.0.0.1:8787/mastergo-exports/next')
      if (!response.ok) return
      const payload = (await response.json()) as { request?: CodexExportRequest | null }
      if (!payload.request) return
      activeCodexExportRequestId.current = payload.request.requestId
      setError('')
      setSubmittedJobId('')
      setStaticExportResult(null)
      setRunningHint(`Codex 正在请求导出 ${payload.request.frameName || payload.request.nodeId || '当前选中 Frame'}。`)
      setState('running')
      setProgress({ ...DEFAULT_PROGRESS, label: '响应 Codex 导出请求' })
      sendMsgToPlugin({ type: UIMessage.RUN_CODEX_EXPORT_REQUEST, data: payload.request })
    } catch {
      // The local bridge may be stopped; keep the plugin usable for manual export.
    }
  }

  const completeCodexExportRequest = async (requestId: string, input: Parameters<typeof createBridgeJob>[0]) => {
    try {
      const response = await fetch(`http://127.0.0.1:8787/mastergo-exports/${requestId}/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`)
      setState('done')
      setStaticExportResult(null)
      setRunningHint('Codex 导出请求已完成。')
    } catch (completeError) {
      setState('error')
      setError(`Codex 导出请求回传失败：${errorMessage(completeError)}`)
    } finally {
      activeCodexExportRequestId.current = ''
    }
  }

  const failCodexExportRequest = async (requestId: string, message: string) => {
    try {
      await fetch(`http://127.0.0.1:8787/mastergo-exports/${requestId}/fail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      })
    } catch {
      // Best-effort failure reporting; the visible plugin error remains the source of truth.
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

  const retryFailedPhase = async (jobId: string, phase: JobRecord['progress']['phase']) => {
    try {
      setJobActionError('')
      setRetryingPhase(phase)
      const response = await fetch(`http://127.0.0.1:8787/jobs/${jobId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`)
      notifiedJobIds.current.delete(jobId)
      setRecentJob(payload as JobRecord)
    } catch (retryError) {
      setJobActionError(`重试失败：${errorMessage(retryError)}`)
    } finally {
      setRetryingPhase(null)
    }
  }

  const saveJobZip = async (job: JobRecord) => {
    if (!job.downloadUrl) return
    try {
      setJobActionError('')
      setJobAction('saving')
      const response = await fetch(`http://127.0.0.1:8787${job.downloadUrl}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      const savePicker = (window as Window & {
        showSaveFilePicker?: (options: unknown) => Promise<{ createWritable: () => Promise<{ write: (data: Blob) => Promise<void>; close: () => Promise<void> }> }>
      }).showSaveFilePicker

      if (savePicker) {
        const handle = await savePicker.call(window, {
          suggestedName: 'output.zip',
          types: [{ description: 'ZIP 压缩包', accept: { 'application/zip': ['.zip'] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(blob)
        await writable.close()
      } else {
        const url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = 'output.zip'
        anchor.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch (actionError) {
      if ((actionError as { name?: string })?.name !== 'AbortError') {
        setJobActionError(`另存 ZIP 失败：${errorMessage(actionError)}`)
      }
    } finally {
      setJobAction(null)
    }
  }

  const openOutputDirectory = async (job: JobRecord) => {
    try {
      setJobActionError('')
      setJobAction('opening')
      const response = await fetch(`http://127.0.0.1:8787/jobs/${job.jobId}/open-output`, { method: 'POST' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`)
    } catch (actionError) {
      setJobActionError(`打开输出文件夹失败：${errorMessage(actionError)}`)
    } finally {
      setJobAction(null)
    }
  }

  const revealJobZip = async (job: JobRecord) => {
    try {
      setJobActionError('')
      setJobAction('revealing')
      const response = await fetch(`http://127.0.0.1:8787/jobs/${job.jobId}/reveal-zip`, { method: 'POST' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`)
    } catch (actionError) {
      setJobActionError(`定位 ZIP 失败：${errorMessage(actionError)}`)
    } finally {
      setJobAction(null)
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
          <p>{state === 'running' ? runningHint : '提交设计稿并生成可直接查看的 HTML。'}</p>
        </div>
      </header>

      <section className="panel">
        {state !== 'running' && (
          <>
            <div className="actionStack">
              <button className="primaryButton" type="button" onClick={generateHtml}>
                一键生成 HTML
              </button>
              <button className="secondaryButton staticAssetButton" type="button" onClick={exportStaticAssets}>
                导出静态资源
              </button>
            </div>

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
                <MissingFontsPanel job={recentJob} />
                <JobPhaseDetails
                  job={recentJob}
                  copiedKey={copiedKey}
                  expandedPhaseKeys={expandedPhaseKeys}
                  retryingPhase={retryingPhase}
                  onRetry={(phase) => retryFailedPhase(recentJob.jobId, phase)}
                  onCopy={copyPath}
                  onToggle={(phaseKey) => {
                    setExpandedPhaseKeys((current) => {
                      const next = new Set(current)
                      if (next.has(phaseKey)) next.delete(phaseKey)
                      else next.add(phaseKey)
                      return next
                    })
                  }}
                />
                {jobActionError && <p className="error">{jobActionError}</p>}
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
                {recentJob.status === 'done' && recentJob.downloadUrl && recentJob.outputDir && (
                  <div className="deliveryPanel">
                    <div>
                      <strong>生成结果</strong>
                      <p>ZIP 已生成。你可以查看网页源文件，或将 ZIP 另存到指定位置。</p>
                    </div>
                    <div className="deliveryActions">
                      <button
                        className="secondaryButton"
                        type="button"
                        disabled={jobAction !== null}
                        onClick={() => openOutputDirectory(recentJob)}
                      >
                        {jobAction === 'opening' ? '正在打开…' : '打开输出文件夹'}
                      </button>
                      <button
                        className="primaryButton"
                        type="button"
                        disabled={jobAction !== null}
                        onClick={() => saveJobZip(recentJob)}
                      >
                        {jobAction === 'saving' ? '正在另存…' : '另存为 ZIP'}
                      </button>
                    </div>
                    {recentJob.resultSummary?.zipPath && (
                      <button
                        className="deliveryLinkButton"
                        type="button"
                        disabled={jobAction !== null}
                        onClick={() => revealJobZip(recentJob)}
                      >
                        {jobAction === 'revealing' ? '正在定位…' : '在文件夹中显示 ZIP'}
                      </button>
                    )}
                  </div>
                )}
                {recentJob.error && <p className="error">{recentJob.error}</p>}
              </div>
            )}

            <button className="secondaryButton" type="button" onClick={refreshRecentJob}>
              刷新最近任务
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

        {state === 'idle' && <p className="hint">请在画布中选中一个或多个 Frame，也可以选中任意图层树作为生成根节点。</p>}

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

        {staticExportResult && (
          <div className="jobPanel staticExportPanel">
            <strong>00-input 已导出</strong>
            <p>
              已生成 {createStaticInputFiles(staticExportResult).length} 个文件，包含 raw.json、asset-manifest.json、export-options.json、frame-screenshot.png 和静态资源。
            </p>
            <div className="staticExportStats">
              <span>根节点 <strong>{staticExportResult.selectionCount}</strong></span>
              <span>图片资源 <strong>{staticExportResult.imageAssetCount}</strong></span>
              <span>失败 <strong>{staticExportResult.failures.length}</strong></span>
              <span>估算 <strong>{formatBytes(staticExportResult.zipSizeEstimateBytes)}</strong></span>
            </div>
            <button className="primaryButton" type="button" onClick={() => downloadStaticInputZip(staticExportResult)}>
              下载 00-input ZIP
            </button>
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

function MissingFontsPanel({ job }: { job: JobRecord }) {
  const missingFonts = job.fontAvailability?.missingFonts || []
  if (missingFonts.length === 0) return null

  return (
    <div className="missingFontsPanel">
      <div className="missingFontsHeader">
        <strong>缺失字体</strong>
        <span>{missingFonts.length}</span>
      </div>
      <div className="missingFontsList">
        {missingFonts.map((font) => (
          <code key={font.family}>{font.family}</code>
        ))}
      </div>
    </div>
  )
}

function JobPhaseDetails({
  job,
  expandedPhaseKeys,
  onToggle,
  onRetry,
  retryingPhase,
  copiedKey,
  onCopy,
}: {
  job: JobRecord
  expandedPhaseKeys: Set<string>
  onToggle: (phaseKey: string) => void
  onRetry: (phase: JobRecord['progress']['phase']) => void
  retryingPhase: JobRecord['progress']['phase'] | null
  copiedKey: string
  onCopy: (key: string, value: string) => void
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
        const expanded = detail.status === 'running' || detail.status === 'error' || expandedPhaseKeys.has(phaseKey)
        return (
          <section className={`phaseCard ${expanded ? 'phaseCardExpanded' : ''}`} key={phaseKey}>
            <button className="phaseToggle" type="button" onClick={() => onToggle(phaseKey)}>
              <span>{jobPhaseLabel(detail.phase)}</span>
              <span className={`phaseStatus phaseStatus-${detail.status}`}>{phaseStatusLabel(detail.status)}</span>
            </button>
            {expanded && (
              <div className="phaseBody">
                {detail.message && <p>{detail.message}</p>}
                {detail.streamMetrics && (
                  <div className={`streamMetrics ${detail.streamMetrics.mode === 'non-stream-fallback' ? 'streamMetricsFallback' : ''}`}>
                    <strong>{streamStateLabel(detail.streamMetrics.state)}</strong>
                    <span>{detail.streamMetrics.mode === 'stream' ? '流式' : '兼容模式'}</span>
                    <span>尝试 {detail.streamMetrics.attempt}</span>
                    <span>字符 {formatCompactCount(detail.streamMetrics.receivedChars)}</span>
                    <span>事件 {detail.streamMetrics.eventCount}</span>
                  </div>
                )}
                <div className="phaseStats">
                  <span>耗时 <strong>{formatDuration(detail.durationMs || 0)}</strong></span>
                  <span>输入 <strong>{formatTokenCount(detail.tokenUsage?.inputTokens)}</strong></span>
                  <span>输出 <strong>{formatTokenCount(detail.tokenUsage?.outputTokens)}</strong></span>
                  <span>总计 <strong>{formatTokenCount(detail.tokenUsage?.totalTokens)}</strong>{detail.tokenUsage?.estimated ? ' 估算' : ''}</span>
                </div>
                {detail.artifacts && detail.artifacts.length > 0 && (
                  <div className="phaseArtifacts">
                    {detail.artifacts.slice(0, 3).map((artifact, index) => (
                      <PathRow
                        key={artifact}
                        label={`产物 ${index + 1}`}
                        value={artifact}
                        copyKey={`${phaseKey}:artifact:${index}`}
                        copiedKey={copiedKey}
                        onCopy={onCopy}
                      />
                    ))}
                  </div>
                )}
                {detail.status === 'error' && job.status === 'error' && (
                  <div className="phaseActions">
                    <button
                      className="phaseRetryButton"
                      type="button"
                      disabled={retryingPhase !== null}
                      onClick={() => onRetry(detail.phase)}
                    >
                      {retryingPhase === detail.phase ? '正在重试…' : '从此阶段重试'}
                    </button>
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

function createStaticInputFiles(result: ExportResult): ExportFile[] {
  const rawFile = result.files.find((file) => file.path === 'raw.json')
  const manifestFile = result.files.find((file) => file.path === 'asset-manifest.json')
  if (!rawFile || !manifestFile) return result.files.filter(isStaticInputAttachment)

  const raw = safeParseJson(rawFile.content)
  const manifest = safeParseJson(manifestFile.content)
  const page = raw?.page ?? { id: 'unknown', name: 'unknown' }
  const manifestSource = manifest && typeof manifest === 'object' && 'source' in manifest ? manifest.source as { selectionIds?: unknown } : null
  const selectionIds = manifestSource && Array.isArray(manifestSource.selectionIds) ? manifestSource.selectionIds : []
  const exportOptions = {
    exportOptions: STATIC_EXPORT_OPTIONS,
    source: {
      pageId: typeof page.id === 'string' ? page.id : 'unknown',
      pageName: typeof page.name === 'string' ? page.name : 'unknown',
      selectionIds,
      selectionCount: result.selectionCount,
    },
    createdAt: result.createdAt,
  }

  return [
    rawFile,
    manifestFile,
    {
      path: 'export-options.json',
      mimeType: 'application/json',
      encoding: 'utf8',
      content: JSON.stringify(exportOptions, null, 2),
    },
    ...result.files.filter(isStaticInputAttachment),
  ]
}

function isStaticInputAttachment(file: ExportFile) {
  return file.path === 'frame-screenshot.png' || file.path.startsWith('assets/')
}

function safeParseJson(value: string): Record<string, any> | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
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

function formatCompactCount(value?: number) {
  const count = Number(value || 0)
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function streamStateLabel(state: NonNullable<NonNullable<JobRecord['phaseDetails']>[number]['streamMetrics']>['state']) {
  return ({ connecting: '等待响应', streaming: '正在生成', validating: '正在校验' })[state]
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
