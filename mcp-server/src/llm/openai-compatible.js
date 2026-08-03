import http from 'node:http'
import https from 'node:https'
import { StringDecoder } from 'node:string_decoder'
import { resolveEffectiveConfig } from '../config.js'
import { DEFAULT_LONG_LLM_TIMEOUT_MS } from '../timeouts.js'

const STREAM_UNSUPPORTED_STATUSES = new Set([400, 404, 415, 422])
const STREAM_RETRYABLE_STATUSES = new Set([408, 429, 499, 500, 502, 503, 504])

export class LlmHttpError extends Error {
  constructor(message, { statusCode, requestId, responseSummary } = {}) {
    super(message)
    this.name = 'LlmHttpError'
    this.statusCode = statusCode
    this.requestId = requestId
    this.responseSummary = responseSummary
  }
}

export class LlmStreamError extends Error {
  constructor(message, { code, partialText = '', eventCount = 0, cause } = {}) {
    super(message)
    this.name = 'LlmStreamError'
    this.code = code
    this.partialText = partialText
    this.eventCount = eventCount
    if (cause) this.cause = cause
  }
}

export async function generateText({ config, system, prompt, temperature = 0.2, maxTokens, timeoutMs, retries = 1 }) {
  const result = await generateTextDetailed({ config, system, prompt, temperature, maxTokens, timeoutMs, retries })
  return result.text
}

export async function generateTextDetailed({ config: rawConfig, system, prompt, temperature = 0.2, maxTokens, timeoutMs, retries = 1 }) {
  const config = resolveEffectiveConfig(rawConfig)
  if (config.provider === 'anthropic') {
    return withRetry(() => generateAnthropicText({ config, system, prompt, temperature, maxTokens, timeoutMs }), retries)
  }

  if (config.wireApi === 'responses') {
    return withRetry(() => generateOpenAiResponsesText({ config, system, prompt, temperature, maxTokens, timeoutMs }), retries)
  }

  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature,
  }
  if (maxTokens) payload.max_tokens = maxTokens

  const response = await withRetry(() => postJson(`${config.baseUrl}/chat/completions`, payload, {
    Authorization: `Bearer ${config.apiKey}`,
  }, timeoutMs), retries)

  const content = response?.choices?.[0]?.message?.content
  if (!content || typeof content !== 'string') {
    throw new Error('模型响应中没有可显示的文本内容。')
  }
  return {
    text: content.trim(),
    usage: normalizeUsage(response?.usage, system, prompt, content),
  }
}

export async function generateTextStreamDetailed({
  config: rawConfig,
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
  streamRequest = generateOpenAiResponsesStream,
  fallbackRequest = generateOpenAiResponsesText,
}) {
  const config = resolveEffectiveConfig(rawConfig)
  const startedAt = Date.now()
  const hasTotalTimeout = totalTimeoutMs > 0
  const remainingTotalMs = () => hasTotalTimeout ? Math.max(0, totalTimeoutMs - (Date.now() - startedAt)) : 0
  if (config.wireApi !== 'responses') {
    onProgress(createStreamProgress('non-stream-fallback', 'connecting', 1))
    const result = await generateTextDetailed({
      config,
      system,
      prompt,
      temperature,
      maxTokens,
      timeoutMs: remainingTotalMs(),
      retries,
    })
    onProgress(createStreamProgress('non-stream-fallback', 'validating', 1))
    return { ...result, streamMode: 'non-stream-fallback' }
  }

  let lastError
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    if (hasTotalTimeout && remainingTotalMs() <= 0) throw new LlmStreamError('模型流式调用总时长超时。', { code: 'STREAM_TOTAL_TIMEOUT' })
    onProgress(createStreamProgress('stream', 'connecting', attempt))
    try {
      return await streamRequest({
        config,
        system,
        prompt,
        temperature,
        maxTokens,
        connectTimeoutMs,
        firstEventTimeoutMs,
        idleTimeoutMs,
        totalTimeoutMs: remainingTotalMs(),
        attempt,
        onProgress,
      })
    } catch (error) {
      lastError = error
      if (isStreamUnsupportedError(error) && !error.partialText) {
        if (hasTotalTimeout && remainingTotalMs() <= 0) throw new LlmStreamError('模型流式调用总时长超时。', { code: 'STREAM_TOTAL_TIMEOUT' })
        onProgress(createStreamProgress('non-stream-fallback', 'connecting', attempt))
        const result = await withRetry(() => fallbackRequest({
          config,
          system,
          prompt,
          temperature,
          maxTokens,
          timeoutMs: remainingTotalMs(),
        }), retries)
        onProgress(createStreamProgress('non-stream-fallback', 'validating', attempt))
        return { ...result, streamMode: 'non-stream-fallback' }
      }
      if (error.partialText || attempt > retries || !isStreamRetryableError(error)) break
      await sleep(800 * attempt + Math.floor(Math.random() * 250))
    }
  }
  throw lastError
}

async function generateOpenAiResponsesStream({
  config,
  system,
  prompt,
  temperature,
  maxTokens,
  connectTimeoutMs,
  firstEventTimeoutMs,
  idleTimeoutMs,
  totalTimeoutMs,
  attempt,
  onProgress,
}) {
  const payload = {
    model: config.model,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature,
    stream: true,
  }
  if (maxTokens) payload.max_output_tokens = maxTokens

  const result = await postResponsesStream(`${config.baseUrl}/responses`, payload, {
    Authorization: `Bearer ${config.apiKey}`,
  }, {
    connectTimeoutMs,
    firstEventTimeoutMs,
    idleTimeoutMs,
    totalTimeoutMs,
    onWaiting: ({ elapsedMs, responseReceivedAt }) => {
      onProgress({
        mode: 'stream',
        state: 'connecting',
        attempt,
        eventCount: 0,
        receivedChars: 0,
        elapsedMs,
        responseReceivedAt,
      })
    },
    onEvent: ({ eventCount, text, firstEventAt, lastEventAt }) => {
      onProgress({
        mode: 'stream',
        state: 'streaming',
        attempt,
        eventCount,
        receivedChars: text.length,
        firstEventAt,
        lastEventAt,
      })
    },
  })

  const content = result.text || extractResponsesText(result.response)
  if (!content) throw new Error('模型流式响应中没有可显示的文本内容。')
  onProgress({
    mode: result.mode,
    state: 'validating',
    attempt,
    eventCount: result.eventCount,
    receivedChars: content.length,
    firstEventAt: result.firstEventAt,
    lastEventAt: result.lastEventAt,
  })
  return {
    text: content.trim(),
    usage: normalizeUsage(result.usage || result.response?.usage, system, prompt, content),
    streamMode: result.mode,
  }
}

async function generateOpenAiResponsesText({ config, system, prompt, temperature, maxTokens, timeoutMs }) {
  const payload = {
    model: config.model,
    input: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    temperature,
  }
  if (maxTokens) payload.max_output_tokens = maxTokens

  const response = await postJson(`${config.baseUrl}/responses`, payload, {
    Authorization: `Bearer ${config.apiKey}`,
  }, timeoutMs)

  const content = extractResponsesText(response)
  if (!content) {
    throw new Error('模型响应中没有可显示的文本内容。')
  }
  return {
    text: content,
    usage: normalizeUsage(response?.usage, system, prompt, content),
  }
}

async function generateAnthropicText({ config, system, prompt, temperature, maxTokens, timeoutMs }) {
  const payload = {
    model: config.model,
    max_tokens: maxTokens || 4096,
    system,
    messages: [
      { role: 'user', content: prompt },
    ],
    temperature,
  }

  const authHeaders = config.authTokenType === 'bearer'
    ? { Authorization: `Bearer ${config.apiKey}` }
    : { 'x-api-key': config.apiKey }

  const response = await postJson(`${config.baseUrl}/v1/messages`, payload, {
    ...authHeaders,
    'anthropic-version': '2023-06-01',
  }, timeoutMs)

  const textParts = Array.isArray(response?.content)
    ? response.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text)
    : []
  const content = textParts.join('\n').trim()
  if (!content) {
    throw new Error('模型响应中没有可显示的文本内容。')
  }
  return {
    text: content,
    usage: normalizeUsage(response?.usage, system, prompt, content),
  }
}

function normalizeUsage(usage, system, prompt, output) {
  const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens ?? usage?.inputTokens ?? estimateTokens(`${system}\n${prompt}`)
  const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? usage?.outputTokens ?? estimateTokens(output)
  const totalTokens = usage?.total_tokens ?? usage?.totalTokens ?? inputTokens + outputTokens
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    estimated: !usage,
  }
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value || '').length / 3))
}

function postJson(url, body, headers = {}, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const client = target.protocol === 'http:' ? http : https
    const requestBody = JSON.stringify(body)

    const req = client.request(
      {
        method: 'POST',
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
          ...headers,
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            reject(new LlmHttpError(`模型接口返回了非 JSON 内容：HTTP ${res.statusCode}`, {
              statusCode: res.statusCode,
              requestId: getRequestId(res.headers),
              responseSummary: truncateResponse(text),
            }))
            return
          }

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const message = parsed?.error?.message || parsed?.message || `HTTP ${res.statusCode}`
            reject(new LlmHttpError(`模型调用失败：${message}`, {
              statusCode: res.statusCode,
              requestId: getRequestId(res.headers),
              responseSummary: truncateResponse(text),
            }))
            return
          }

          resolve(parsed)
        })
      },
    )

    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('模型调用超时。'))
      })
    }
    req.on('error', reject)
    req.write(requestBody)
    req.end()
  })
}

export function postResponsesStream(url, body, headers, timeouts) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const client = timeouts.requestClient || (target.protocol === 'http:' ? http : https)
    const requestBody = JSON.stringify(body)
    let settled = false
    let responseReceived = false
    let responseReceivedAt
    let text = ''
    let eventCount = 0
    let firstEventAt
    let lastEventAt
    let completedResponse
    let completedEvent = false
    let usage
    let connectTimer
    let firstEventTimer
    let idleTimer
    let totalTimer
    let waitingTimer
    const startedAt = Date.now()

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(firstEventTimer)
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      clearInterval(waitingTimer)
      fn(value)
    }

    const streamError = (message, code, cause) => new LlmStreamError(message, {
      code,
      partialText: text,
      eventCount,
      cause,
    })

    const resetIdleTimer = () => {
      clearTimeout(idleTimer)
      if (timeouts.idleTimeoutMs <= 0) return
      idleTimer = setTimeout(() => {
        req.destroy(streamError('模型流空闲超时。', 'STREAM_IDLE_TIMEOUT'))
      }, timeouts.idleTimeoutMs)
    }

    const reportWaiting = () => {
      if (settled || firstEventAt) return
      timeouts.onWaiting?.({
        elapsedMs: Date.now() - startedAt,
        responseReceivedAt,
      })
    }

    const req = client.request({
      method: 'POST',
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'Content-Length': Buffer.byteLength(requestBody),
        ...headers,
      },
    }, (res) => {
      responseReceived = true
      responseReceivedAt = new Date().toISOString()
      clearTimeout(connectTimer)
      reportWaiting()

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        collectResponseBody(res).then(({ text: responseText, parsed }) => {
          const message = parsed?.error?.message || parsed?.message || `HTTP ${res.statusCode}`
          finish(reject, new LlmHttpError(`模型流式调用失败：${message}`, {
            statusCode: res.statusCode,
            requestId: getRequestId(res.headers),
            responseSummary: truncateResponse(responseText),
          }))
        }, (error) => finish(reject, error))
        return
      }

      const contentType = String(res.headers['content-type'] || '')
      if (!contentType.includes('text/event-stream')) {
        collectResponseBody(res).then(({ text: responseText, parsed }) => {
          if (!parsed) {
            finish(reject, new LlmHttpError('模型流式接口返回了不支持的响应格式。', {
              statusCode: res.statusCode,
              requestId: getRequestId(res.headers),
              responseSummary: truncateResponse(responseText),
            }))
            return
          }
          const content = extractResponsesText(parsed)
          finish(resolve, {
            mode: 'non-stream-fallback',
            text: content,
            response: parsed,
            usage: parsed.usage,
            eventCount: 0,
          })
        }, (error) => finish(reject, error))
        return
      }

      if (timeouts.firstEventTimeoutMs > 0) {
        firstEventTimer = setTimeout(() => {
          req.destroy(streamError('模型首个流事件超时。', 'STREAM_FIRST_EVENT_TIMEOUT'))
        }, timeouts.firstEventTimeoutMs)
      }

      const parser = createResponsesSseParser((event) => {
        if (settled) return
        const now = new Date().toISOString()
        eventCount += 1
        if (!firstEventAt) {
          firstEventAt = now
          clearTimeout(firstEventTimer)
          clearInterval(waitingTimer)
        }
        lastEventAt = now
        resetIdleTimer()

        const type = event.data?.type || event.event
        if (type === 'response.output_text.delta' && typeof event.data?.delta === 'string') {
          text += event.data.delta
        } else if (type === 'response.output_text.done' && !text && typeof event.data?.text === 'string') {
          text = event.data.text
        } else if (type === 'response.completed') {
          completedEvent = true
          completedResponse = event.data?.response
          usage = completedResponse?.usage
          if (completedResponse?.status && completedResponse.status !== 'completed') {
            const detail = describeIncompleteResponse(completedResponse)
            req.destroy(streamError(`模型流式响应未完整完成：${detail}`, 'STREAM_RESPONSE_INCOMPLETE'))
            return
          }
        } else if (type === 'response.incomplete') {
          const detail = describeIncompleteResponse(event.data?.response || event.data)
          req.destroy(streamError(`模型流式响应未完整完成：${detail}`, 'STREAM_RESPONSE_INCOMPLETE'))
          return
        } else if (type === 'response.failed' || type === 'error') {
          const detail = event.data?.response?.error?.message || event.data?.error?.message || event.data?.message || type
          req.destroy(streamError(`模型流式响应失败：${detail}`, 'STREAM_RESPONSE_FAILED'))
          return
        }

        timeouts.onEvent({ eventCount, text, firstEventAt, lastEventAt, type })
        if (type === 'response.completed') {
          finish(resolve, {
            mode: 'stream',
            text,
            response: completedResponse,
            usage,
            eventCount,
            firstEventAt,
            lastEventAt,
          })
        }
      })

      res.on('data', (chunk) => {
        try {
          parser.push(chunk)
        } catch (error) {
          req.destroy(streamError(`模型 SSE 解析失败：${error.message}`, 'STREAM_PARSE_ERROR', error))
        }
      })
      res.on('end', () => {
        if (settled) return
        try {
          parser.end()
        } catch (error) {
          finish(reject, streamError(`模型 SSE 解析失败：${error.message}`, 'STREAM_PARSE_ERROR', error))
          return
        }
        if (completedEvent) {
          finish(resolve, { mode: 'stream', text, response: completedResponse, usage, eventCount, firstEventAt, lastEventAt })
        } else if (text) {
          finish(reject, streamError('模型流式连接在完成事件前中断。', 'STREAM_ENDED_BEFORE_COMPLETION'))
        } else {
          finish(reject, streamError('模型流式连接已结束，但没有返回正文。', 'STREAM_ENDED_WITHOUT_OUTPUT'))
        }
      })
      res.on('error', (error) => finish(reject, streamError(`模型流式连接错误：${error.message}`, 'STREAM_CONNECTION_ERROR', error)))
    })

    const waitingProgressIntervalMs = Number(timeouts.waitingProgressIntervalMs ?? 5000)
    if (waitingProgressIntervalMs > 0 && typeof timeouts.onWaiting === 'function') {
      waitingTimer = setInterval(reportWaiting, waitingProgressIntervalMs)
    }
    if (timeouts.connectTimeoutMs > 0) {
      connectTimer = setTimeout(() => {
        if (!responseReceived) req.destroy(streamError('模型连接超时。', 'STREAM_CONNECT_TIMEOUT'))
      }, timeouts.connectTimeoutMs)
    }
    if (timeouts.totalTimeoutMs > 0) {
      totalTimer = setTimeout(() => {
        req.destroy(streamError('模型流式调用总时长超时。', 'STREAM_TOTAL_TIMEOUT'))
      }, timeouts.totalTimeoutMs)
    }
    req.on('error', (error) => {
      const normalized = error instanceof LlmStreamError
        ? error
        : streamError(`模型流式请求失败：${error.message}`, error.code || 'STREAM_REQUEST_ERROR', error)
      finish(reject, normalized)
    })
    req.write(requestBody)
    req.end()
  })
}

export function createResponsesSseParser(onEvent) {
  const decoder = new StringDecoder('utf8')
  let buffer = ''

  const consume = (final = false) => {
    let match
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index)
      buffer = buffer.slice(match.index + match[0].length)
      parseSseBlock(block, onEvent)
    }
    if (final && buffer.trim()) {
      parseSseBlock(buffer, onEvent)
      buffer = ''
    }
  }

  return {
    push(chunk) {
      buffer += decoder.write(chunk)
      consume(false)
    },
    end() {
      buffer += decoder.end()
      consume(true)
    },
  }
}

function parseSseBlock(block, onEvent) {
  if (!block || block.split(/\r?\n/).every((line) => !line || line.startsWith(':'))) return
  let event = ''
  const dataLines = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator === -1 ? line : line.slice(0, separator)
    const value = separator === -1 ? '' : line.slice(separator + 1).replace(/^ /, '')
    if (field === 'event') event = value
    if (field === 'data') dataLines.push(value)
  }
  const rawData = dataLines.join('\n')
  if (!rawData || rawData === '[DONE]') return
  let data
  try {
    data = JSON.parse(rawData)
  } catch {
    throw new Error(`无效 SSE JSON：${truncateResponse(rawData)}`)
  }
  onEvent({ event, data })
}

function collectResponseBody(res) {
  return new Promise((resolve, reject) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let parsed
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = null
      }
      resolve({ text, parsed })
    })
    res.on('error', reject)
  })
}

async function withRetry(fn, retries) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (attempt >= retries || !isRetryableError(error)) break
      await sleep(800 * (attempt + 1))
    }
  }
  throw lastError
}

function isRetryableError(error) {
  const code = error?.code || ''
  const message = error instanceof Error ? error.message : String(error)
  return STREAM_RETRYABLE_STATUSES.has(error?.statusCode) || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED' || message.includes('模型调用超时')
}

export function isStreamUnsupportedError(error) {
  return STREAM_UNSUPPORTED_STATUSES.has(error?.statusCode)
}

export function isStreamRetryableError(error) {
  if (error?.partialText) return false
  return isRetryableError(error) || [
    'STREAM_CONNECT_TIMEOUT',
    'STREAM_FIRST_EVENT_TIMEOUT',
    'STREAM_IDLE_TIMEOUT',
    'STREAM_TOTAL_TIMEOUT',
    'STREAM_CONNECTION_ERROR',
    'STREAM_REQUEST_ERROR',
    'STREAM_ENDED_WITHOUT_OUTPUT',
    'STREAM_ENDED_BEFORE_COMPLETION',
  ].includes(error?.code)
}

function describeIncompleteResponse(response = {}) {
  const reason = response?.incomplete_details?.reason || response?.incompleteDetails?.reason || response?.reason
  const message = response?.error?.message || response?.message
  return [reason, message].filter(Boolean).join('：') || '输出被截断或服务端提前结束'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractResponsesText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim()
  }

  const chunks = []
  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if ((content?.type === 'output_text' || content?.type === 'text') && typeof content.text === 'string') {
        chunks.push(content.text)
      }
    }
  }
  return chunks.join('\n').trim()
}

function createStreamProgress(mode, state, attempt) {
  return {
    mode,
    state,
    attempt,
    eventCount: 0,
    receivedChars: 0,
  }
}

function getRequestId(headers = {}) {
  return headers['x-request-id'] || headers['request-id'] || headers['x-cch-request-id']
}

function truncateResponse(value, maxLength = 500) {
  const text = String(value || '').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text
}
