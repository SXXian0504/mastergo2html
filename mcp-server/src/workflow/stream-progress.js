export function createStreamProgressReporter(onProgress) {
  let lastReportedAt = 0
  let lastState = ''
  let lastMode = ''
  return (metrics, force = false) => {
    const now = Date.now()
    const stateChanged = metrics.state !== lastState || metrics.mode !== lastMode
    const firstEvent = metrics.eventCount === 1
    if (!force && !stateChanged && !firstEvent && now - lastReportedAt < 1000) return
    lastReportedAt = now
    lastState = metrics.state
    lastMode = metrics.mode
    onProgress(metrics, streamProgressMessage(metrics))
  }
}

export function streamProgressMessage(metrics) {
  if (metrics.mode === 'non-stream-fallback') {
    return metrics.state === 'validating'
      ? '当前网关不支持流式，已回退兼容模式，正在校验输出'
      : '当前网关不支持流式，已回退兼容模式'
  }
  if (metrics.state === 'connecting') return `正在等待模型流式响应（第 ${metrics.attempt} 次尝试）`
  if (metrics.state === 'validating') return `流式生成完成，已接收 ${formatCount(metrics.receivedChars)} 字符，正在校验`
  return `已接收 ${formatCount(metrics.receivedChars)} 字符，流式事件 ${metrics.eventCount} 个`
}

export function createFallbackMetrics(state, attempt) {
  return { mode: 'non-stream-fallback', state, attempt, eventCount: 0, receivedChars: 0 }
}

function formatCount(value) {
  const count = Number(value || 0)
  return count >= 1000 ? `${(count / 1000).toFixed(1)}K` : String(count)
}
