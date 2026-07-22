import assert from 'node:assert/strict'
import test from 'node:test'
import { generateWorkflowText } from '../src/workflow/generate-workflow-text.js'

test('workflow streaming forwards timeouts and offsets correction attempts', async () => {
  let receivedOptions
  const progress = []
  const result = await generateWorkflowText({
    streamingEnabled: true,
    generateStream: async (options) => {
      receivedOptions = options
      options.onProgress({ mode: 'stream', state: 'streaming', attempt: 1, eventCount: 1, receivedChars: 12 })
      return { text: 'ok', usage: {}, streamMode: 'stream' }
    },
    generateNonStream: async () => assert.fail('non-stream generator should not run'),
    request: { config: {}, system: 'system', prompt: 'prompt' },
    timeoutMs: 0,
    connectTimeoutMs: 11,
    firstEventTimeoutMs: 0,
    idleTimeoutMs: 22,
    reportProgress: (metrics) => progress.push(metrics),
    workflowAttempt: 2,
  })

  assert.equal(receivedOptions.totalTimeoutMs, 0)
  assert.equal(receivedOptions.connectTimeoutMs, 11)
  assert.equal(receivedOptions.firstEventTimeoutMs, 0)
  assert.equal(receivedOptions.idleTimeoutMs, 22)
  assert.equal(progress[0].attempt, 3)
  assert.equal(result.streamMode, 'stream')
})

test('workflow streaming can be disabled with compatibility progress', async () => {
  const progress = []
  const result = await generateWorkflowText({
    streamingEnabled: false,
    generateStream: async () => assert.fail('stream generator should not run'),
    generateNonStream: async (options) => {
      assert.equal(options.timeoutMs, 44)
      return { text: 'fallback', usage: {} }
    },
    request: { config: {}, system: 'system', prompt: 'prompt' },
    timeoutMs: 44,
    reportProgress: (metrics, force) => progress.push({ metrics, force }),
    workflowAttempt: 1,
  })

  assert.deepEqual(progress.map((item) => item.metrics.state), ['connecting', 'validating'])
  assert.equal(progress.every((item) => item.force), true)
  assert.equal(result.streamMode, 'non-stream-fallback')
})
