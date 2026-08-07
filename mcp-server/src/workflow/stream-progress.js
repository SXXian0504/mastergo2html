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
  if (metrics.state === 'queued') {
    return `等待全局模型并发槽位（运行中 ${metrics.activeCount || 0}/${metrics.limit || 2}，排队 ${metrics.queuedCount || 1}）`
  }
  if (metrics.mode === 'codex-sdk') {
    if (metrics.state === 'connecting') {
      const elapsed = formatElapsed(metrics.elapsedMs)
      return `正在启动 Codex SDK（第 ${metrics.attempt} 次尝试${elapsed ? `，已等待 ${elapsed}` : ''}）`
    }
    if (metrics.state === 'validating') return `Codex SDK 生成完成，已接收 ${formatCount(metrics.receivedChars)} 字符，正在校验`
    return `Codex SDK 正在生成，已接收 ${formatCount(metrics.receivedChars)} 字符，事件 ${metrics.eventCount} 个`
  }
  if (metrics.mode === 'non-stream-fallback') {
    return metrics.state === 'validating'
      ? '当前网关不支持流式，已回退兼容模式，正在校验输出'
      : '当前网关不支持流式，已回退兼容模式'
  }
  if (metrics.state === 'connecting') {
    const elapsed = formatElapsed(metrics.elapsedMs)
    const stage = metrics.responseReceivedAt ? '模型网关已连接，正在等待首个流事件' : '正在连接模型网关'
    return `${stage}（第 ${metrics.attempt} 次尝试${elapsed ? `，已等待 ${elapsed}` : ''}）`
  }
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

function formatElapsed(value) {
  const elapsedMs = Number(value || 0)
  if (elapsedMs < 1000) return ''
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`
}
