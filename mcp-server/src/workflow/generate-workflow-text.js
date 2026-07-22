import { createFallbackMetrics } from './stream-progress.js'

export async function generateWorkflowText({
  streamingEnabled,
  generateStream,
  generateNonStream,
  request,
  timeoutMs,
  connectTimeoutMs,
  firstEventTimeoutMs,
  idleTimeoutMs,
  reportProgress,
  workflowAttempt = 1,
}) {
  if (streamingEnabled) {
    return generateStream({
      ...request,
      connectTimeoutMs,
      firstEventTimeoutMs,
      idleTimeoutMs,
      totalTimeoutMs: timeoutMs,
      onProgress: (metrics) => reportProgress({
        ...metrics,
        attempt: (workflowAttempt - 1) * 2 + metrics.attempt,
      }),
    })
  }

  reportProgress(createFallbackMetrics('connecting', workflowAttempt), true)
  const result = await generateNonStream({ ...request, timeoutMs })
  reportProgress(createFallbackMetrics('validating', workflowAttempt), true)
  return { ...result, streamMode: 'non-stream-fallback' }
}
