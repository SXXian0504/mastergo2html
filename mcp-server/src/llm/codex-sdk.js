import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Codex } from '@openai/codex-sdk'
import { DEFAULT_LONG_LLM_TIMEOUT_MS } from '../timeouts.js'

const threadStatePromises = new Map()

export class CodexSdkError extends Error {
  constructor(message, { code, partialText = '', cause } = {}) {
    super(message)
    this.name = 'CodexSdkError'
    this.code = code
    this.partialText = partialText
    if (cause) this.cause = cause
  }
}

export async function generateCodexText({ config, system, prompt, temperature = 0.2, maxTokens, timeoutMs, retries = 1, codexFactory }) {
  const result = await generateCodexTextDetailed({
    config,
    system,
    prompt,
    temperature,
    maxTokens,
    timeoutMs,
    retries,
    codexFactory,
  })
  return result.text
}

export async function generateCodexTextDetailed({
  config,
  system,
  prompt,
  temperature = 0.2,
  maxTokens,
  timeoutMs = DEFAULT_LONG_LLM_TIMEOUT_MS,
  retries = 1,
  codexFactory,
}) {
  return runWithRetry({
    config,
    system,
    prompt,
    temperature,
    maxTokens,
    retries,
    totalTimeoutMs: timeoutMs,
    onProgress: () => {},
    codexFactory,
    streamMode: 'non-stream-fallback',
  })
}

export async function generateCodexTextStreamDetailed({
  config,
  system,
  prompt,
  temperature = 0.2,
  maxTokens,
  retries = 1,
  connectTimeoutMs = 30000,
  firstEventTimeoutMs = 0,
  idleTimeoutMs = 120000,
  totalTimeoutMs = DEFAULT_LONG_LLM_TIMEOUT_MS,
  onProgress = () => {},
  codexFactory,
}) {
  return runWithRetry({
    config,
    system,
    prompt,
    temperature,
    maxTokens,
    retries,
    connectTimeoutMs,
    firstEventTimeoutMs,
    idleTimeoutMs,
    totalTimeoutMs,
    onProgress,
    codexFactory,
    streamMode: 'codex-sdk',
  })
}

async function runWithRetry({
  config,
  system,
  prompt,
  temperature,
  maxTokens,
  retries,
  connectTimeoutMs = 0,
  firstEventTimeoutMs = 0,
  idleTimeoutMs = 0,
  totalTimeoutMs,
  onProgress,
  codexFactory,
  streamMode,
}) {
  const startedAt = Date.now()
  const hasTotalTimeout = Number(totalTimeoutMs) > 0
  const remainingTotalMs = () => hasTotalTimeout
    ? Math.max(0, Number(totalTimeoutMs) - (Date.now() - startedAt))
    : 0

  let lastError
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    if (hasTotalTimeout && remainingTotalMs() <= 0) {
      throw new CodexSdkError('Codex SDK 调用总时长超时。', { code: 'CODEX_TOTAL_TIMEOUT' })
    }
    onProgress(createCodexProgress('connecting', attempt))
    try {
      const state = await getThreadState(config, codexFactory)
      return await enqueueThreadTurn(state, () => runThreadTurn({
        state,
        config,
        input: buildCodexPrompt({ system, prompt, temperature, maxTokens }),
        attempt,
        connectTimeoutMs,
        firstEventTimeoutMs,
        idleTimeoutMs,
        totalTimeoutMs: remainingTotalMs(),
        onProgress,
        streamMode,
      }))
    } catch (error) {
      lastError = normalizeCodexError(error)
      if (lastError.partialText || attempt > retries || !isRetryableCodexError(lastError)) break
      await sleep(800 * attempt + Math.floor(Math.random() * 250))
    }
  }
  throw lastError
}

async function runThreadTurn({
  state,
  config,
  input,
  attempt,
  connectTimeoutMs,
  firstEventTimeoutMs,
  idleTimeoutMs,
  totalTimeoutMs,
  onProgress,
  streamMode,
}) {
  const controller = new AbortController()
  let timeoutCode = ''
  let timeoutMessage = ''
  let connectTimer
  let firstEventTimer
  let idleTimer
  let totalTimer
  let eventCount = 0
  let receivedChars = 0
  let responseReceivedAt
  let finalText = ''
  let usage = null

  const abortAfter = (ms, code, message, assign) => {
    if (!(Number(ms) > 0)) return undefined
    return setTimeout(() => {
      timeoutCode = code
      timeoutMessage = message
      controller.abort(new Error(message))
    }, Number(ms))
  }
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = abortAfter(idleTimeoutMs, 'CODEX_IDLE_TIMEOUT', 'Codex SDK 长时间没有返回新事件。')
  }

  connectTimer = abortAfter(connectTimeoutMs, 'CODEX_CONNECT_TIMEOUT', 'Codex SDK 启动或连接超时。')
  firstEventTimer = abortAfter(firstEventTimeoutMs, 'CODEX_FIRST_EVENT_TIMEOUT', 'Codex SDK 等待首个事件超时。')
  totalTimer = abortAfter(totalTimeoutMs, 'CODEX_TOTAL_TIMEOUT', 'Codex SDK 调用总时长超时。')

  try {
    const { events } = await state.thread.runStreamed(input, { signal: controller.signal })
    resetIdleTimer()
    for await (const event of events) {
      eventCount += 1
      if (!responseReceivedAt) {
        responseReceivedAt = new Date().toISOString()
        if (connectTimer) clearTimeout(connectTimer)
        if (firstEventTimer) clearTimeout(firstEventTimer)
      }
      resetIdleTimer()

      if (event.type === 'thread.started') {
        persistThreadId(config, state.modelKey, event.thread_id)
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        finalText = String(event.item.text || '')
        receivedChars = finalText.length
      } else if (event.type === 'turn.completed') {
        usage = event.usage || null
      } else if (event.type === 'turn.failed') {
        throw new CodexSdkError(`Codex SDK turn 失败：${event.error?.message || 'unknown error'}`, {
          code: 'CODEX_TURN_FAILED',
          partialText: finalText,
        })
      } else if (event.type === 'error') {
        throw new CodexSdkError(`Codex SDK 事件流失败：${event.message || 'unknown error'}`, {
          code: 'CODEX_STREAM_ERROR',
          partialText: finalText,
        })
      }

      onProgress({
        ...createCodexProgress(finalText ? 'streaming' : 'connecting', attempt),
        eventCount,
        receivedChars,
        responseReceivedAt,
      })
    }

    const threadId = state.thread.id
    if (threadId) persistThreadId(config, state.modelKey, threadId)
    if (!finalText.trim()) {
      throw new CodexSdkError('Codex SDK 响应中没有可显示的文本内容。', {
        code: 'CODEX_EMPTY_RESPONSE',
      })
    }
    onProgress({
      ...createCodexProgress('validating', attempt),
      eventCount,
      receivedChars,
      responseReceivedAt,
    })
    return {
      text: finalText.trim(),
      usage: normalizeCodexUsage(usage, input, finalText),
      streamMode,
      codexThreadId: state.thread.id || readPersistedThreadId(config, state.modelKey) || null,
    }
  } catch (error) {
    if (timeoutCode) {
      throw new CodexSdkError(timeoutMessage, {
        code: timeoutCode,
        partialText: finalText,
        cause: error,
      })
    }
    if (error instanceof CodexSdkError) throw error
    throw new CodexSdkError(`Codex SDK 调用失败：${error instanceof Error ? error.message : String(error)}`, {
      code: error?.code || 'CODEX_SDK_ERROR',
      partialText: finalText,
      cause: error,
    })
  } finally {
    if (connectTimer) clearTimeout(connectTimer)
    if (firstEventTimer) clearTimeout(firstEventTimer)
    if (idleTimer) clearTimeout(idleTimer)
    if (totalTimer) clearTimeout(totalTimer)
  }
}

async function getThreadState(config, codexFactory) {
  const modelKey = sanitizeKey(config.model || 'default')
  if (!config.codexReuseThread) return createThreadState(config, modelKey, codexFactory, false)

  const cacheKey = [
    config.codexThreadKey || config.codexWorkingDirectory || process.cwd(),
    modelKey,
    config.codexThreadStatePath || '',
  ].join('::')
  if (!threadStatePromises.has(cacheKey)) {
    const promise = createThreadState(config, modelKey, codexFactory, true)
      .catch((error) => {
        threadStatePromises.delete(cacheKey)
        throw error
      })
    threadStatePromises.set(cacheKey, promise)
  }
  return threadStatePromises.get(cacheKey)
}

async function createThreadState(config, modelKey, codexFactory, resumePersisted) {
  const codex = codexFactory
    ? await codexFactory(config)
    : new Codex(config.codexPath ? { codexPathOverride: config.codexPath } : undefined)
  const options = compactObject({
    model: config.model || undefined,
    sandboxMode: config.codexSandboxMode || 'read-only',
    workingDirectory: resolve(config.codexWorkingDirectory || process.cwd()),
    skipGitRepoCheck: true,
    modelReasoningEffort: config.reasoningEffort || 'high',
    networkAccessEnabled: false,
    webSearchMode: 'disabled',
    approvalPolicy: 'never',
  })
  const persistedId = resumePersisted ? readPersistedThreadId(config, modelKey) : ''
  const thread = persistedId
    ? codex.resumeThread(persistedId, options)
    : codex.startThread(options)
  return { thread, modelKey, tail: Promise.resolve() }
}

function enqueueThreadTurn(state, operation) {
  const result = state.tail.then(operation, operation)
  state.tail = result.catch(() => {})
  return result
}

function buildCodexPrompt({ system, prompt, temperature, maxTokens }) {
  return [
    'You are the text-generation backend of an automated design-to-HTML pipeline.',
    'Use only the supplied instructions and content. Do not run commands, inspect files, call tools, browse, or modify the workspace.',
    'Treat SYSTEM_INSTRUCTIONS as higher priority than USER_PROMPT.',
    'Return only the requested final artifact; do not add commentary before or after it.',
    maxTokens ? `The requested output budget is approximately ${maxTokens} tokens; do not intentionally truncate required output.` : '',
    Number.isFinite(Number(temperature)) ? `The caller requested a generation temperature of ${temperature}; prioritize deterministic compliance.` : '',
    '',
    '<SYSTEM_INSTRUCTIONS>',
    String(system || ''),
    '</SYSTEM_INSTRUCTIONS>',
    '',
    '<USER_PROMPT>',
    String(prompt || ''),
    '</USER_PROMPT>',
  ].filter(Boolean).join('\n')
}

function persistThreadId(config, modelKey, threadId) {
  if (!config.codexReuseThread || !config.codexThreadStatePath || !threadId) return
  const path = config.codexThreadStatePath
  const state = readThreadStateFile(path)
  state.threads = state.threads || {}
  if (state.threads[modelKey] === threadId) return
  state.threads[modelKey] = threadId
  state.updatedAt = new Date().toISOString()
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.tmp`
  writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tempPath, path)
}

function readPersistedThreadId(config, modelKey) {
  if (!config.codexReuseThread || !config.codexThreadStatePath) return ''
  return readThreadStateFile(config.codexThreadStatePath)?.threads?.[modelKey] || ''
}

function readThreadStateFile(path) {
  if (!path || !existsSync(path)) return { version: 1, threads: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : { version: 1, threads: {} }
  } catch {
    return { version: 1, threads: {} }
  }
}

function normalizeCodexUsage(usage, input, output) {
  const inputTokens = usage?.input_tokens ?? estimateTokens(input)
  const outputTokens = usage?.output_tokens ?? estimateTokens(output)
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cachedInputTokens: usage?.cached_input_tokens || 0,
    reasoningOutputTokens: usage?.reasoning_output_tokens || 0,
    estimated: !usage,
  }
}

function normalizeCodexError(error) {
  if (error instanceof CodexSdkError) return error
  return new CodexSdkError(`Codex SDK 调用失败：${error instanceof Error ? error.message : String(error)}`, {
    code: error?.code || 'CODEX_SDK_ERROR',
    partialText: error?.partialText || '',
    cause: error,
  })
}

function isRetryableCodexError(error) {
  if (['CODEX_TOTAL_TIMEOUT', 'CODEX_CONNECT_TIMEOUT', 'CODEX_FIRST_EVENT_TIMEOUT', 'CODEX_IDLE_TIMEOUT', 'CODEX_STREAM_ERROR'].includes(error.code)) {
    return true
  }
  const message = String(error.message || '').toLowerCase()
  if (/auth|login|credential|unauthorized|forbidden|api key|permission/.test(message)) return false
  return /timeout|timed out|rate limit|429|connection|network|socket|reset|temporar|unavailable|502|503|504|spawn/.test(message)
}

function createCodexProgress(state, attempt) {
  return {
    mode: 'codex-sdk',
    state,
    attempt,
    eventCount: 0,
    receivedChars: 0,
  }
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''))
}

function sanitizeKey(value) {
  return String(value || 'default').replace(/[^a-zA-Z0-9._-]/g, '_')
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value || '').length / 3))
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

export function resetCodexSdkStateForTests() {
  threadStatePromises.clear()
}
