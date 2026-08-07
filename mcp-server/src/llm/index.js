import {
  generateText as generateApiText,
  generateTextDetailed as generateApiTextDetailed,
  generateTextStreamDetailed as generateApiTextStreamDetailed,
} from './openai-compatible.js'
import {
  generateCodexText,
  generateCodexTextDetailed,
  generateCodexTextStreamDetailed,
} from './codex-sdk.js'
import { withGlobalModelSlot } from './concurrency.js'

export async function generateText(options) {
  return withModelSlot(options, () => options?.config?.provider === 'codex-sdk'
    ? generateCodexText(options)
    : generateApiText(options))
}

export async function generateTextDetailed(options) {
  return withModelSlot(options, () => options?.config?.provider === 'codex-sdk'
    ? generateCodexTextDetailed(options)
    : generateApiTextDetailed(options))
}

export async function generateTextStreamDetailed(options) {
  return withModelSlot(options, () => options?.config?.provider === 'codex-sdk'
    ? generateCodexTextStreamDetailed(options)
    : generateApiTextStreamDetailed(options))
}

function withModelSlot(options, operation) {
  return withGlobalModelSlot(operation, {
    onQueued: ({ activeCount, limit, queuedCount }) => options?.onProgress?.({
      mode: options?.config?.provider === 'codex-sdk' ? 'codex-sdk' : 'stream',
      state: 'queued',
      attempt: 1,
      eventCount: 0,
      receivedChars: 0,
      activeCount,
      limit,
      queuedCount,
    }),
  })
}
