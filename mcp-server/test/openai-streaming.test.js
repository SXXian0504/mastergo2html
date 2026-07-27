import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  LlmHttpError,
  LlmStreamError,
  createResponsesSseParser,
  generateTextStreamDetailed,
  isStreamRetryableError,
  isStreamUnsupportedError,
  postResponsesStream,
} from '../src/llm/openai-compatible.js'

test('SSE parser handles fragmented UTF-8, comments, event names and DONE', () => {
  const events = []
  const parser = createResponsesSseParser((event) => events.push(event))
  const payload = [
    ': keep-alive\n\n',
    'event: response.output_text.delta\n',
    'data: {"type":"response.output_text.delta","delta":"你好"}\n\n',
    'data: [DONE]\n\n',
  ].join('')
  const bytes = Buffer.from(payload, 'utf8')
  parser.push(bytes.subarray(0, 53))
  parser.push(bytes.subarray(53, 79))
  parser.push(bytes.subarray(79))
  parser.end()

  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'response.output_text.delta')
  assert.equal(events[0].data.delta, '你好')
})

test('SSE parser joins multiple data lines and rejects invalid JSON', () => {
  const events = []
  const parser = createResponsesSseParser((event) => events.push(event))
  parser.push(Buffer.from('data: {"type":"response.created",\ndata: "sequence_number":1}\n\n'))
  assert.equal(events[0].data.type, 'response.created')

  const invalid = createResponsesSseParser(() => {})
  assert.throws(() => invalid.push(Buffer.from('data: {bad}\n\n')), /无效 SSE JSON/)
})

test('stream error classification separates fallback, retry and partial output', () => {
  assert.equal(isStreamUnsupportedError(new LlmHttpError('unsupported', { statusCode: 400 })), true)
  assert.equal(isStreamUnsupportedError(new LlmHttpError('busy', { statusCode: 503 })), false)
  assert.equal(isStreamRetryableError(new LlmHttpError('busy', { statusCode: 503 })), true)
  assert.equal(isStreamRetryableError(new LlmStreamError('closed', { code: 'STREAM_CONNECTION_ERROR' })), true)
  assert.equal(isStreamRetryableError(new LlmStreamError('closed', { code: 'STREAM_CONNECTION_ERROR', partialText: 'partial' })), false)
})

test('unsupported streaming falls back once to non-streaming', async () => {
  let streamCalls = 0
  let fallbackCalls = 0
  const progress = []
  const result = await generateTextStreamDetailed({
    config: { wireApi: 'responses' },
    system: 'system',
    prompt: 'prompt',
    retries: 1,
    onProgress: (metrics) => progress.push(metrics),
    streamRequest: async () => {
      streamCalls += 1
      throw new LlmHttpError('unsupported', { statusCode: 400 })
    },
    fallbackRequest: async () => {
      fallbackCalls += 1
      return { text: 'fallback', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    },
  })

  assert.equal(streamCalls, 1)
  assert.equal(fallbackCalls, 1)
  assert.equal(result.streamMode, 'non-stream-fallback')
  assert.equal(progress.at(-1).mode, 'non-stream-fallback')
})

test('503 retries streaming without protocol fallback', async () => {
  let streamCalls = 0
  let fallbackCalls = 0
  const result = await generateTextStreamDetailed({
    config: { wireApi: 'responses' },
    system: 'system',
    prompt: 'prompt',
    retries: 1,
    streamRequest: async () => {
      streamCalls += 1
      if (streamCalls === 1) throw new LlmHttpError('busy', { statusCode: 503 })
      return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, streamMode: 'stream' }
    },
    fallbackRequest: async () => {
      fallbackCalls += 1
      return { text: 'fallback', usage: {} }
    },
  })

  assert.equal(streamCalls, 2)
  assert.equal(fallbackCalls, 0)
  assert.equal(result.text, 'ok')
})

test('partial streaming output is never retried', async () => {
  let streamCalls = 0
  await assert.rejects(generateTextStreamDetailed({
    config: { wireApi: 'responses' },
    system: 'system',
    prompt: 'prompt',
    retries: 1,
    streamRequest: async () => {
      streamCalls += 1
      throw new LlmStreamError('interrupted', { code: 'STREAM_CONNECTION_ERROR', partialText: 'partial' })
    },
  }), /interrupted/)
  assert.equal(streamCalls, 1)
})

test('stream transport rejects incomplete responses with partial text', async () => {
  await assert.rejects(runFakeStream({
    respond(response) {
      response.write('data: {"type":"response.output_text.delta","delta":"{\\"index.html\\":\\"half"}\n\n')
      response.write('data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}\n\n')
      response.end()
    },
  }), (error) => {
    assert.equal(error.code, 'STREAM_RESPONSE_INCOMPLETE')
    assert.equal(error.partialText, '{"index.html":"half')
    assert.match(error.message, /max_output_tokens/)
    return true
  })
})

test('stream transport distinguishes connect and total timeouts', async () => {
  await assert.rejects(runFakeStream({ connectTimeoutMs: 5, totalTimeoutMs: 50 }), (error) => error.code === 'STREAM_CONNECT_TIMEOUT')
  await assert.rejects(runFakeStream({ connectTimeoutMs: 50, totalTimeoutMs: 5 }), (error) => error.code === 'STREAM_TOTAL_TIMEOUT')
})

test('stream transport distinguishes first-event and idle timeouts', async () => {
  await assert.rejects(runFakeStream({
    connectTimeoutMs: 50,
    firstEventTimeoutMs: 5,
    totalTimeoutMs: 50,
    respond(response) {},
  }), (error) => error.code === 'STREAM_FIRST_EVENT_TIMEOUT')

  await assert.rejects(runFakeStream({
    connectTimeoutMs: 50,
    firstEventTimeoutMs: 50,
    idleTimeoutMs: 5,
    totalTimeoutMs: 100,
    respond(response) {
      response.write('data: {"type":"response.created"}\n\n')
    },
  }), (error) => error.code === 'STREAM_IDLE_TIMEOUT')
})

test('stream transport treats zero timeouts as disabled', async () => {
  const result = await runFakeStream({
    connectTimeoutMs: 0,
    firstEventTimeoutMs: 0,
    idleTimeoutMs: 0,
    totalTimeoutMs: 0,
    respond(response) {
      setTimeout(() => {
        response.write('data: {"type":"response.completed","response":{"output_text":"ok"}}\n\n')
        response.end()
      }, 10)
    },
  })

  assert.equal(result.mode, 'stream')
  assert.equal(result.eventCount, 1)
})

function runFakeStream({
  connectTimeoutMs = 50,
  firstEventTimeoutMs = 50,
  idleTimeoutMs = 50,
  totalTimeoutMs = 100,
  respond,
}) {
  const requestClient = {
    request(options, onResponse) {
      const request = new EventEmitter()
      request.write = () => {}
      request.end = () => {
        if (!respond) return
        const response = new PassThrough()
        response.statusCode = 200
        response.headers = { 'content-type': 'text/event-stream' }
        onResponse(response)
        respond(response)
      }
      request.destroy = (error) => queueMicrotask(() => request.emit('error', error))
      return request
    },
  }
  return postResponsesStream('https://example.test/responses', { stream: true }, {}, {
    connectTimeoutMs,
    firstEventTimeoutMs,
    idleTimeoutMs,
    totalTimeoutMs,
    onEvent: () => {},
    requestClient,
  })
}
