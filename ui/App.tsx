import React, { useEffect, useMemo, useState } from 'react'
import './App.css'
import {
  ExportOptions,
  ExportProgress,
  ExportResult,
  PluginMessage,
  PluginToUIMessage,
  UIMessage,
  sendMsgToPlugin,
} from '@messages/sender'
import { createZip } from './zip'

type ExportState = 'idle' | 'running' | 'done' | 'error'
type ExportMode = 'structure' | 'originals' | 'slices' | 'all'
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

function App() {
  const [state, setState] = useState<ExportState>('idle')
  const [result, setResult] = useState<ExportResult | null>(null)
  const [progress, setProgress] = useState<ExportProgress>(DEFAULT_PROGRESS)
  const [exportMode, setExportMode] = useState<ExportMode>('structure')
  const [error, setError] = useState('')

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
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

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

  const downloadZip = () => {
    if (!result) return
    const blob = createZip(result.files)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${result.name || 'mastergo-export'}.zip`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main className="app">
      <header className="header">
        <div>
          <h1>MasterGo JSON Export</h1>
          <p>导出选中 Frame 的原始节点 JSON、图片资源和资源映射表。</p>
        </div>
      </header>

      <section className="panel">
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
          {state === 'running' ? '正在导出...' : '导出选中内容'}
        </button>

        {state === 'running' && (
          <div className="progressPanel">
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

        {state === 'idle' && (
          <p className="hint">请在画布中选中一个或多个 Frame，也可以选中任意图层树作为导出根节点。</p>
        )}

        {state === 'error' && <p className="error">{error}</p>}

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
              {result.files.some((file) => file.path.startsWith('assets/original/')) && <code>assets/original/*.png</code>}
              {result.renderedAssetCount > 0 && <code>assets/rendered/*.png</code>}
            </div>
          </div>
        )}
      </section>
    </main>
  )
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

function progressPercent(progress: ExportProgress) {
  if (progress.total <= 0) return 12
  return Math.max(4, Math.min(100, Math.round((progress.done / progress.total) * 100)))
}

function phaseLabel(phase: ExportProgress['phase']) {
  const labels: Record<ExportProgress['phase'], string> = {
    'scan-nodes': '扫描节点',
    'serialize-json': '精简 JSON',
    'collect-assets': '整理资源',
    'export-originals': '导出原图',
    'export-rendered-slices': '导出图片节点切片',
    'package-files': '打包文件',
  }
  return labels[phase]
}

function getPluginMessage(data: unknown): PluginToUIMessage | null {
  if (!data || typeof data !== 'object') return null

  const maybeWrapped = data as { pluginMessage?: PluginToUIMessage }
  if (maybeWrapped.pluginMessage) return maybeWrapped.pluginMessage

  const maybeMessage = data as Partial<PluginToUIMessage>
  return typeof maybeMessage.type === 'string' ? (maybeMessage as PluginToUIMessage) : null
}

export default App
